// Core throw-detection logic. ⚠️ FROZEN — see AGENTS.md.
//
// This code was hand-tuned against noisy real-world accelerometer data and is
// effectively untestable in a dev environment. It was RELOCATED verbatim from
// pages/index.tsx (no logic/constant/comment changes) so it can be imported by
// both the game (pages/index.tsx) and the data-capture tool (pages/capture.tsx),
// and eventually covered by golden tests built from captured real traces. Do
// not "clean up", refactor, or adjust anything here.

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

export const handleMotionRosettaCode = (
  acceleration: Vec3,
  gravityVector: Vec3
): Vec3 => {
  function norm(v: number[]) {
    return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  }
  function normalize(v: number[]) {
    var length = norm(v);
    return [v[0] / length, v[1] / length, v[2] / length];
  }
  function dotProduct(v1: number[], v2: number[]) {
    return v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
  }
  function crossProduct(v1: number[], v2: number[]) {
    return [
      v1[1] * v2[2] - v1[2] * v2[1],
      v1[2] * v2[0] - v1[0] * v2[2],
      v1[0] * v2[1] - v1[1] * v2[0],
    ];
  }
  function getAngle(v1: number[], v2: number[]) {
    return Math.acos(dotProduct(v1, v2) / (norm(v1) * norm(v2)));
  }
  function matrixMultiply(matrix: number[][], v: number[]) {
    return [
      dotProduct(matrix[0], v),
      dotProduct(matrix[1], v),
      dotProduct(matrix[2], v),
    ];
  }
  function getRotationMatrix(p: number[], v: number[], a: number) {
    var ca = Math.cos(a),
      sa = Math.sin(a),
      t = 1 - ca,
      x = v[0],
      y = v[1],
      z = v[2];
    return [
      [ca + x * x * t, x * y * t - z * sa, x * z * t + y * sa],
      [x * y * t + z * sa, ca + y * y * t, y * z * t - x * sa],
      [z * x * t - y * sa, z * y * t + x * sa, ca + z * z * t],
    ];
  }
  function calculateRotationMatrix(v1: number[], v2: number[]) {
    var a = getAngle(v1, v2);
    var cp = crossProduct(v1, v2);
    var ncp = normalize(cp);
    return getRotationMatrix(v1, ncp, a);
  }

  var v1 = [gravityVector[0], gravityVector[1], gravityVector[2]];
  var v2 = [0, 0, -1];
  const r = calculateRotationMatrix(v1, v2);
  const rotatedAcceleration = matrixMultiply(r, [
    acceleration[0],
    acceleration[1],
    acceleration[2],
  ]);
  return [
    rotatedAcceleration[0],
    rotatedAcceleration[1],
    rotatedAcceleration[2],
  ];
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
