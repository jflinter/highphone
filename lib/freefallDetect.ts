// PROTOTYPE — not wired into the game. See test/fixtures/README.md.
//
// An alternative to `detectThrow` built on a different input signal.
//
// `detectThrow` sees one scalar: gravity-rotated z-acceleration. A wind-up and
// a release produce the same shape in that scalar, which is why no choice of
// thresholds separates them (a 1,536-config sweep of its constants fixes at
// most 15 of the 21 known-bad captures, and introduces a new false positive).
//
// This detector uses a signal the phone already reports and the game currently
// throws away: a body in free fall reads ~0 specific force. So
// `accelerationIncludingGravity` collapses toward zero the moment the phone
// leaves the hand, and jumps back on landing. Nothing a hand is holding can
// fake it.
//
// The one complication is spin. A phone rotating at w rad/s about a point r
// metres from the accelerometer still reads a centrifugal w^2 * r even in
// perfect free fall, which is why a naive |a| ~ 0 test misses spinny throws.
// `rotationRate` — captured since version 2 of the capture format, never used
// by the game — gives us w, so we can raise the bar by exactly that much.

import { heightFromSeconds } from './heightFromSeconds';
import type { Throw } from './detectThrow';

export type FreefallSample = {
  /** event.timeStamp, ms. Used directly — no 60Hz assumption. */
  t: number;
  /** event.accelerationIncludingGravity, m/s^2. */
  ax: number;
  ay: number;
  az: number;
  /** event.rotationRate, deg/s. Zero if the device does not report it. */
  wx: number;
  wy: number;
  wz: number;
};

/**
 * Specific force below which we call a sample free fall, m/s^2. At rest this
 * reads ~9.8, so 3 is comfortably clear of hand-held noise while leaving room
 * for sensor error mid-flight.
 */
export const FREEFALL_BASE = 3;

/**
 * Lever arm in metres, the `r` in the centrifugal term `w^2 * r`. Fitted
 * against the capture set at 0.05 — 5cm, which is about the distance from an
 * iPhone's accelerometer to the middle of the handset. The value being
 * physically what it should be is the reason to trust it.
 */
export const FREEFALL_SPIN_COEFF = 0.05;

/** Consecutive free-fall samples before we believe the phone is airborne. */
const ENTER_SAMPLES = 2;

/** Non-free-fall samples after a run before we call it landed. */
const CONFIRM_SAMPLES = 30;

/** Shortest flight worth reporting. Below this it is a fumble, not a throw. */
const MIN_FLIGHT_MS = 250;

const DEG_TO_RAD = Math.PI / 180;

/** Is this sample physically in free fall, allowing for centrifugal spin? */
export const isFreefall = (s: FreefallSample): boolean => {
  const a = Math.sqrt(s.ax * s.ax + s.ay * s.ay + s.az * s.az);
  const w =
    Math.sqrt(s.wx * s.wx + s.wy * s.wy + s.wz * s.wz) * DEG_TO_RAD;
  return a < FREEFALL_BASE + FREEFALL_SPIN_COEFF * w * w;
};

/**
 * Finds the first completed flight in `samples`, or null. Same contract as
 * `detectThrow`: call it on every motion sample with a rolling buffer, and it
 * returns once the throw is over and confirmed landed.
 */
export const detectThrowFreefall = (
  samples: readonly FreefallSample[]
): Throw | null => {
  // The open run of free-fall samples, if we are in one.
  let runStart = -1;
  let runEnd = -1;
  // A run that has ended and is waiting out the confirm window.
  let landedStart = -1;
  let landedEnd = -1;
  let confirm = 0;

  for (let i = 0; i < samples.length; i++) {
    // Once a flight has ended, the window is only a delay before reporting.
    // Free fall during it (a bounce, a roll) must NOT extend the flight —
    // folding gaps back into a run merges separate episodes and inflates every
    // reading, which is the whole reason a run ends at the first sample that
    // breaks it.
    if (landedStart >= 0) {
      if (++confirm <= CONFIRM_SAMPLES) continue;
      const durationMs = samples[landedEnd].t - samples[landedStart].t;
      const seconds = durationMs / 1000;
      return {
        id: crypto.randomUUID(),
        durationMs,
        totalHeight: heightFromSeconds(seconds),
        // Diagnostics, kept so the shape matches `Throw`. The UI reads only
        // id, durationMs and totalHeight.
        accelerationData: [],
        maxAcceleration: 0,
        totalRotation: { alpha: 0, beta: 0 },
        acceleratingIndex: landedStart,
        inFlightIndex: landedStart,
        completeIndex: landedEnd,
      };
    }

    if (isFreefall(samples[i])) {
      if (runStart < 0) runStart = i;
      runEnd = i;
      continue;
    }

    // This sample breaks free fall, so the flight is over. Keep it only if it
    // was long enough to be a throw rather than a fumble or sensor noise.
    if (runStart < 0) continue;
    const durationMs = samples[runEnd].t - samples[runStart].t;
    if (runEnd - runStart + 1 >= ENTER_SAMPLES && durationMs >= MIN_FLIGHT_MS) {
      landedStart = runStart;
      landedEnd = runEnd;
      confirm = 0;
    }
    runStart = -1;
  }
  return null;
};
