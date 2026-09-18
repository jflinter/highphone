// Replays a recorded /capture session through the game's exact sensor
// pipeline (pages/index.tsx `motionListener` / `orientationListener`).
//
// This is the bridge that finally makes the frozen detector testable: the
// fixtures in ./fixtures/captures are raw `devicemotion` + `deviceorientation`
// streams recorded off a real iPhone, and this file feeds them to
// `handleMotionRosettaCode` + `detectThrow` the same way the live game does —
// same rounding, same two 210-sample ring buffers, same "first detection
// wins" rule, same `totalHeight > 1.5` recording gate.
//
// It mirrors the game; it must never diverge from it. If pages/index.tsx's
// listener changes, change this too.

import {
  detectThrow,
  handleMotionRosettaCode,
  type Orientation,
  type Throw,
  type Vec3,
} from '../lib/detectThrow';

export type MotionSample = {
  t: number;
  interval: number;
  ax: number | null;
  ay: number | null;
  az: number | null;
  gx: number | null;
  gy: number | null;
  gz: number | null;
  // version 2 only (ids 9+): rotationRate, recorded but not fed to the detector.
  ra?: number | null;
  rb?: number | null;
  rg?: number | null;
};

export type OrientationSample = {
  t: number;
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
};

export type Capture = {
  id: number;
  notes: string;
  createdAt: string;
  /** What the phone itself computed live, at capture time. */
  client: {
    detected: boolean;
    durationMs: number | null;
    sampleCount: number;
  };
  version: number;
  startedAt: string;
  endedAt: string;
  userAgent?: string;
  motion: MotionSample[];
  orientation: OrientationSample[];
};

export type Detection = {
  throw: Throw;
  /** Motion samples consumed when the detector fired. */
  atSample: number;
  /** Whether this detection cleared the game's `totalHeight > 1.5` gate. */
  passedGate: boolean;
};

export type ReplayResult = {
  /**
   * Every throw the detector reported, in order. The game keeps going after a
   * detection that fails the height gate — it just wipes its buffers — so a
   * gesture can produce several. Under-gate detections are the interesting
   * ones: each one silently destroys 3.5s of history.
   */
  detections: Detection[];
  /** What the /capture tool stored (it keeps only the first detection). */
  firstDetection: Throw | null;
  /** The detection the game would have posted to the leaderboard, if any. */
  recorded: Throw | null;
  /** Airborne ms the game would have posted, or null. */
  durationMs: number | null;
  /** Height in feet the game would have shown, or null. */
  heightFt: number | null;
  /** The derived zAccel scalar for every motion sample, for diagnostics. */
  zAccels: number[];
};

// The game's window: 60Hz * 3.5s.
const orientationEventsPerSecond = 60;
const windowSizeSeconds = 3.5;
const maxWindowSize = orientationEventsPerSecond * windowSizeSeconds;

// The game's minimum-throw gate (pages/index.tsx).
export const MIN_THROW_HEIGHT_FT = 1.5;

// The game's rounding, applied before the detector sees anything.
const round = (v: number | null | undefined) => Number((v ?? 0).toFixed(1));

/** The game's per-sample derivation: raw motion event -> the zAccel scalar. */
export const zAccelFor = (sample: MotionSample): number => {
  const acceleration: Vec3 = [round(sample.ax), round(sample.ay), round(sample.az)];
  const accelerationIncludingGravity: Vec3 = [
    round(sample.gx),
    round(sample.gy),
    round(sample.gz),
  ];
  const gravityVector: Vec3 = [
    accelerationIncludingGravity[0] - acceleration[0],
    accelerationIncludingGravity[1] - acceleration[1],
    accelerationIncludingGravity[2] - acceleration[2],
  ];
  const rotated = handleMotionRosettaCode(acceleration, gravityVector);
  return rotated[2] * -1;
};

export const replayCapture = (capture: Capture): ReplayResult => {
  // The two streams arrive interleaved in real time; `t` is event.timeStamp,
  // so replaying in timestamp order reproduces the live ordering. Orientation
  // sorts first on a tie, matching the listener registration order.
  const events: Array<{ t: number; kind: 0 | 1; index: number }> = [];
  capture.orientation.forEach((s, index) => events.push({ t: s.t, kind: 0, index }));
  capture.motion.forEach((s, index) => events.push({ t: s.t, kind: 1, index }));
  events.sort((a, b) => a.t - b.t || a.kind - b.kind);

  let accelerations: number[] = [];
  let orientations: Orientation[] = [];
  const zAccels: number[] = [];
  const detections: Detection[] = [];
  let recorded: Throw | null = null;
  let motionSeen = 0;

  for (const event of events) {
    if (event.kind === 0) {
      const s = capture.orientation[event.index];
      orientations.push({
        alpha: s.alpha ?? 0,
        beta: s.beta ?? 0,
        gamma: s.gamma ?? 0,
      });
      if (orientations.length > maxWindowSize) orientations.shift();
      continue;
    }

    const zAccel = zAccelFor(capture.motion[event.index]);
    zAccels.push(zAccel);
    motionSeen += 1;
    accelerations.push(zAccel);
    if (accelerations.length > maxWindowSize) accelerations.shift();

    // Once the game has a `lastThrow` it stops reacting to detections, so we
    // only keep scanning to finish building `zAccels` for diagnostics.
    if (recorded) continue;

    const detected = detectThrow(accelerations, orientations);
    if (!detected) continue;

    // The game's `if (detectedThrow && !lastThrow)` branch: it wipes both
    // buffers on ANY detection, then applies the height gate. A sub-gate
    // detection therefore throws away the window a real throw may be mid-way
    // through — this is how a wind-up can swallow the throw that follows it.
    const passedGate = detected.totalHeight > MIN_THROW_HEIGHT_FT;
    detections.push({ throw: detected, atSample: motionSeen, passedGate });
    accelerations = [];
    orientations = [];
    if (passedGate) recorded = detected;
  }

  return {
    detections,
    firstDetection: detections.length ? detections[0].throw : null,
    recorded,
    durationMs: recorded ? recorded.durationMs : null,
    heightFt: recorded ? recorded.totalHeight : null,
    zAccels,
  };
};
