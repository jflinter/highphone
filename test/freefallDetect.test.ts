// Scores the PROTOTYPE detector (lib/freefallDetect.ts) against the same 72
// captures and the same verdicts the frozen detector is judged by.
//
// Nothing here is wired into the game. The point is to answer one question
// with numbers instead of opinion: does switching input signal beat tuning the
// frozen detector's constants? See test/fixtures/README.md.

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

describe('freefall detector prototype', () => {
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

  it('scores better on the labelled set than the frozen detector', () => {
    let kept = 0;
    let fixed = 0;
    const missed: string[] = [];
    for (const e of expectations) {
      if (e.status === 'ambiguous') continue;
      const ok = satisfies(e.want, results.get(e.id)!);
      if (e.status === 'correct' && ok) kept++;
      else if (e.status === 'bug' && ok) fixed++;
      else missed.push(`#${e.id} (${e.status})`);
    }
    // Frozen: 45 kept / 0 fixed. Best of 1,536 constant-tunings of the frozen
    // detector: 45 kept / 15 fixed, and that config posts a 6.3ft score for
    // capture 37, where the phone never left the hand.
    expect({ kept, fixed, missed }).toMatchInlineSnapshot(`
      {
        "fixed": 17,
        "kept": 43,
        "missed": [
          "#3 (correct)",
          "#6 (correct)",
          "#7 (bug)",
          "#8 (bug)",
          "#21 (bug)",
          "#61 (bug)",
        ],
      }
    `);
  });

  it('only fails on captures that lack rotationRate, plus two near misses', () => {
    // 3, 6, 7 and 8 are version 1 fixtures with no gyro, so spinny flights get
    // no centrifugal allowance and read as not-free-fall. Live devices always
    // report rotationRate; this is a limit of those eight fixtures, not of the
    // approach. 21 misses its band by 0.1ft and 61 reads 10.1ft against a
    // "short" note.
    for (const id of [3, 6, 7, 8]) {
      expect(loadCapture(id).version, `#${id}`).toBe(1);
    }
    expect(results.get(21)!.recorded!.totalHeight).toBeCloseTo(9.7, 0);
    expect(results.get(61)!.recorded!.totalHeight).toBeCloseTo(10.1, 0);
  });
});
