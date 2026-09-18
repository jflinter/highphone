// Unit-level behaviour of the shipped detector (lib/freefallDetect.ts).
//
// Per-capture verdicts live in test/detection.expectations.test.ts; this file
// covers the things a capture cannot show — chiefly that a DROPPED phone is
// not a throw, which no recorded gesture in the set exercises.

import { describe, expect, it } from 'vitest';
import { allCaptureIds, loadCapture } from './captures';
import type { Capture } from './replayCapture';
import { expectations, type Want } from './fixtures/expectations';
import { detectThrowFreefall, type FreefallSample } from '../lib/freefallDetect';

// The game loop from pages/index.tsx, with the prototype swapped in.
const runGame = (capture: Capture) => {
  let buffer: FreefallSample[] = [];
  let fires = 0;
  let recorded: { durationMs: number; totalHeight: number } | null = null;
  for (const m of capture.motion) {
    buffer.push({
      t: m.t,
      ax: m.gx ?? 0,
      ay: m.gy ?? 0,
      az: m.gz ?? 0,
      lx: m.ax ?? 0,
      ly: m.ay ?? 0,
      lz: m.az ?? 0,
      // version 1 captures (ids 1-8) predate rotationRate, so they get no spin
      // allowance. Live devices always report it; this only limits what those
      // eight fixtures can prove.
      wx: m.ra ?? 0,
      wy: m.rb ?? 0,
      wz: m.rg ?? 0,
    });
    if (buffer.length > 210) buffer.shift();
    if (recorded) continue;
    const detected = detectThrowFreefall(buffer);
    if (!detected) continue;
    fires += 1;
    buffer = [];
    if (detected.totalHeight > 1.5) recorded = detected;
  }
  return { fires, recorded };
};

const satisfies = (want: Want, r: ReturnType<typeof runGame>) => {
  if ((r.recorded !== null) !== want.record) return false;
  if (want.detections !== undefined && r.fires !== want.detections) return false;
  if (want.heightFt && r.recorded) {
    if (r.recorded.totalHeight < want.heightFt[0]) return false;
    if (r.recorded.totalHeight > want.heightFt[1]) return false;
  }
  if (want.durationMs && r.recorded) {
    if (r.recorded.durationMs < want.durationMs[0]) return false;
    if (r.recorded.durationMs > want.durationMs[1]) return false;
  }
  return true;
};

// Synthetic traces for the one case no capture covers: a phone that is simply
// DROPPED. Free fall alone cannot tell it from a throw — both feel weightless —
// so the detector has to see the upward push that preceded the flight.
//
// Signs follow the real conventions measured off the captures: at rest
// accelerationIncludingGravity is one g and `acceleration` is zero; in free
// fall accelerationIncludingGravity is zero and `acceleration` is -1g, which
// makes verticalAcceleration read -9.81; an upward push adds to both.
const G = 9.81;
const held = { ax: 0, ay: 0, az: G, lx: 0, ly: 0, lz: 0, wx: 0, wy: 0, wz: 0 };
const pushed = { ax: 0, ay: 0, az: G + 30, lx: 0, ly: 0, lz: 30, wx: 0, wy: 0, wz: 0 };
const falling = { ax: 0, ay: 0, az: 0, lx: 0, ly: 0, lz: -G, wx: 0, wy: 0, wz: 0 };

const trace = (...runs: [typeof held, number][]): FreefallSample[] => {
  const out: FreefallSample[] = [];
  for (const [sample, count] of runs)
    for (let i = 0; i < count; i++) out.push({ ...sample, t: Math.round(out.length * (1000 / 60)) });
  return out;
};

describe('freefall detector: throw vs drop', () => {
  // 90 samples of free fall is 1.48s, which would be credited as ~8.7ft.
  const dropped = trace([held, 60], [falling, 90], [held, 60]);
  const thrown = trace([held, 60], [pushed, 10], [falling, 90], [held, 60]);

  it('ignores a phone that was dropped, not thrown', () => {
    expect(detectThrowFreefall(dropped)).toBeNull();
  });

  it('accepts the same flight when it was preceded by an upward push', () => {
    const d = detectThrowFreefall(thrown);
    expect(d).not.toBeNull();
    expect(d!.durationMs).toBeGreaterThan(1400);
    expect(d!.durationMs).toBeLessThan(1550);
  });

  it('refuses to guess when there is no history before the flight', () => {
    // A flight starting at the very front of the buffer cannot be verified, so
    // it is rejected rather than assumed good.
    expect(detectThrowFreefall(trace([falling, 90], [held, 60]))).toBeNull();
  });
});

describe('freefall detector', () => {
  const results = new Map<number, ReturnType<typeof runGame>>();
  for (const id of allCaptureIds()) results.set(id, runGame(loadCapture(id)));

  it('is silent through every gesture that is not a throw', () => {
    const noise = expectations
      .filter((e) => e.want.record === false)
      .filter((e) => results.get(e.id)!.recorded !== null)
      .map((e) => e.id);
    expect(noise).toEqual([]);
  });

  it('lands within 5% of the only video-measured throw (#55, 2.03s)', () => {
    const { recorded } = results.get(55)!;
    expect(recorded).not.toBeNull();
    expect(Math.abs(recorded!.durationMs - 2030) / 2030).toBeLessThan(0.05);
  });

  it('moves the overhand throws from outside their band to inside it', () => {
    // The clearest bug in the frozen detector: 65 was noted "~4 ft" and read
    // 20.3ft, 66 was noted "(6ft)" and read 23.2ft, 68 was noted 6ft and read
    // 1.7ft — wrong in both directions. Bands come from expectations.ts rather
    // than a second tolerance invented here.
    for (const id of [65, 66, 68]) {
      const want = expectations.find((e) => e.id === id)!.want;
      const [min, max] = want.heightFt!;
      const frozen = { 65: 20.3, 66: 23.2, 68: 1.7 }[id]!;
      expect(frozen < min || frozen > max, `#${id} frozen ${frozen}ft is out of band`).toBe(true);
      const { recorded } = results.get(id)!;
      expect(recorded, `#${id} should be recorded`).not.toBeNull();
      expect(recorded!.totalHeight, `#${id}`).toBeGreaterThanOrEqual(min);
      expect(recorded!.totalHeight, `#${id}`).toBeLessThanOrEqual(max);
    }
  });

});
