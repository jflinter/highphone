// Core throw-detection logic. ⚠️ FROZEN — see AGENTS.md.
//
// This code was hand-tuned against noisy real-world accelerometer data. It was
// RELOCATED verbatim from pages/index.tsx so it can be imported by both the
// game (pages/index.tsx) and the data-capture tool (pages/capture.tsx). It is
// now covered by golden tests built from 72 captured real throws
// (test/detectThrow.expectations.test.ts). Do not "clean up", refactor, or
// adjust anything here.
//
// `detectThrow` and its constants are untouched since that relocation. The one
// change made since is `handleMotionRosettaCode` -> `verticalAcceleration`,
// which is the same computation written directly and is proven identical on
// every captured throw; see the comment on that function.

import { heightFromSeconds } from './heightFromSeconds';

export type Orientation = {
  alpha: number;
  beta: number;
  gamma: number;
};

export type Throw = {
  id: string;
  durationMs: number;
  totalHeight: number;
  accelerationData: number[];
  maxAcceleration: number;
  totalRotation: {
    alpha: number;
    beta: number;
  };
  acceleratingIndex: number;
  inFlightIndex: number;
  completeIndex: number;
};

export type Vec3 = readonly [number, number, number];

/**
 * The phone's vertical acceleration in m/s^2, positive up: the component of
 * user acceleration along the gravity vector.
 *
 * This replaces `handleMotionRosettaCode`, which built a Rodrigues rotation
 * matrix taking `gravityVector` to (0,0,-1), applied it to `acceleration`, and
 * left the caller to negate the z component. Rotations preserve dot products
 * and that one maps the gravity direction onto -z, so the whole construction
 * was algebraically this dot product. Verified across the 72 captured throws:
 * 35,053 samples agree to within 6.11e-13 m/s^2, and a full game replay is
 * identical on every capture (duration, height and detection count).
 *
 * The rotation also had a singularity the dot product does not: when gravity
 * ran parallel to (0,0,-1) the cross product vanished, normalizing it divided
 * by zero, and the result was NaN. Every comparison against NaN is false, so
 * such a sample could not advance the state machine, and one landing inside a
 * flight would poison `averageAcceleration` and stop the throw ever
 * completing. 89 of 35,142 captured samples hit it; none inside a flight.
 *
 * Reads ~0 at rest (measured -0.019 over 3,308 still samples), -9.81 in free
 * fall, and peaks near +97 (10g) at the release of a hard throw.
 */
export const verticalAcceleration = (
  acceleration: Vec3,
  gravityVector: Vec3
): number => {
  const gravity = Math.hypot(
    gravityVector[0],
    gravityVector[1],
    gravityVector[2]
  );
  if (gravity === 0) return 0;
  return (
    (acceleration[0] * gravityVector[0] +
      acceleration[1] * gravityVector[1] +
      acceleration[2] * gravityVector[2]) /
    gravity
  );
};

export const detectThrow = (
  accelerations: readonly number[],
  orientations: readonly Orientation[]
): Throw | null => {
  let status: 'waiting' | 'accelerating' | 'in_flight' | 'complete' = 'waiting';
  let startIndex = 0;
  let acceleratingIndex = 0;
  let inFlightIndex = 0;
  let completeIndex = 0;
  const threshold = 8;
  for (let i = 0; i < accelerations.length; i++) {
    const a = accelerations[i];
    // if we're not in flight and a substantial acceleration occurs
    if (a > threshold && status === 'waiting') {
      status = 'accelerating';
      acceleratingIndex = i;
      startIndex = Math.max(i - 30, 0); // capture an extra .5s
      // -3 to make sure there's no sensor error
    } else if (status === 'accelerating' && a < -3) {
      status = 'in_flight';
      inFlightIndex = i;
    }
    // if we are in flight and experience a substantial upward acceleration
    else if (status === 'in_flight' && a > threshold) {
      // anti cheat - we should be accelerating downwards the whole time. Not -9.8 because flips confuse the accelerometer.
      if (i - inFlightIndex > 22) {
        // slice off 10 frames on either side to account for outlier data
        const startIndex = inFlightIndex + 10;
        const endIndex = i - 10;
        const averageAcceleration =
          accelerations.slice(startIndex, endIndex).reduce((a, b) => a + b, 0) /
          (endIndex - startIndex);
        if (averageAcceleration < -5) {
          status = 'complete';
          completeIndex = i;
        }
      }
      // capture an extra .5s
    } else if (status === 'complete' && i - completeIndex > 30) {
      const correctionFactorSeconds = 0;
      const rawDurationSeconds = (completeIndex - inFlightIndex) / 60; // 60Hz TODO adjust for different intervals
      const durationInSeconds = Math.max(
        rawDurationSeconds - correctionFactorSeconds,
        0
      );
      const height = heightFromSeconds(durationInSeconds);
      const orientationsInWindow = orientations.slice(
        inFlightIndex,
        completeIndex
      );
      const differenceInAngles = (a: number, b: number) => {
        let diff = a - b;
        if (diff < 0) {
          diff += 360;
        }
        if (diff > 180) {
          diff = 360 - diff;
        }
        return diff;
      };
      const rotationDiffs = orientationsInWindow.map((orientation, i) => {
        if (i === 0) {
          return [0, 0];
        }
        const lastOrientation = orientationsInWindow[i - 1];
        return [
          differenceInAngles(
            Number(orientation.alpha.toFixed(0)),
            Number(lastOrientation.alpha.toFixed(0))
          ),
          differenceInAngles(
            Number(orientation.beta.toFixed(0)) + 180,
            Number(lastOrientation.beta.toFixed(0)) + 180
          ),
        ];
      });
      return {
        id: crypto.randomUUID(),
        durationMs: durationInSeconds * 1000,
        totalHeight: height,
        accelerationData: accelerations.slice(startIndex, i),
        maxAcceleration: Math.max(
          ...accelerations.slice(startIndex, inFlightIndex)
        ),
        acceleratingIndex: acceleratingIndex - startIndex,
        inFlightIndex: inFlightIndex - startIndex,
        completeIndex: completeIndex - startIndex,
        totalRotation: {
          alpha: rotationDiffs.reduce((acc, diff) => {
            return acc + diff[0];
          }, 0),
          beta:
            rotationDiffs.reduce((acc, diff) => {
              return acc + diff[1];
            }, 0) / 2, // TODO this makes no sense
        },
      };
    }
  }
  return null;
};
