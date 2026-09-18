// Golden tests for the SHIPPED throw detector, built from 72 real gestures
// recorded off an iPhone with the /capture tool.
//
// Read test/fixtures/README.md first. The short version:
//
//   * "behaviour to preserve" MUST STAY GREEN. Those are real throws the
//     detector already gets right, and gestures it already correctly ignores.
//   * "known bugs" are registered with `it.fails`, so they are green *because*
//     the assertion inside them fails today. Fix the detector and they turn
//     RED — that is success, not a regression. Drop the `.fails` and move the
//     row to `status: 'correct'` in test/fixtures/expectations.ts.
//   * "ambiguous" rows are skipped on purpose; see their `why`.

import { describe, expect, it } from 'vitest';
import { loadCapture } from './captures';
import { replayShipped } from './replayCapture';
import { expectations, type Want } from './fixtures/expectations';

const assertWant = (want: Want, result: ReturnType<typeof replayShipped>) => {
  // Assert the user-visible outcome first, so a failure names the headline
  // problem ("this fake throw posted a score") rather than a detail.
  expect(
    result.recorded !== null,
    want.record
      ? 'the game should have posted a score for this gesture'
      : 'the game should NOT have posted a score for this gesture'
  ).toBe(want.record);
  if (want.detections !== undefined) {
    expect(
      result.detections.length,
      `detector should fire ${want.detections}x for this gesture`
    ).toBe(want.detections);
  }
  if (want.heightFt) {
    const [min, max] = want.heightFt;
    expect(result.heightFt, 'recorded height (ft)').toBeGreaterThanOrEqual(min);
    expect(result.heightFt, 'recorded height (ft)').toBeLessThanOrEqual(max);
  }
  if (want.durationMs) {
    const [min, max] = want.durationMs;
    expect(result.durationMs, 'recorded airborne (ms)').toBeGreaterThanOrEqual(min);
    expect(result.durationMs, 'recorded airborne (ms)').toBeLessThanOrEqual(max);
  }
};

const byStatus = (status: 'correct' | 'bug' | 'ambiguous') =>
  expectations.filter((e) => e.status === status);

describe('detection: behaviour to preserve (must stay green)', () => {
  for (const expectation of byStatus('correct')) {
    const capture = loadCapture(expectation.id);
    it(`#${expectation.id} ${capture.notes}`, () => {
      assertWant(expectation.want, replayShipped(capture));
    });
  }
});

describe('detection: known bugs (green while broken — fixing one turns it RED)', () => {
  for (const expectation of byStatus('bug')) {
    const capture = loadCapture(expectation.id);
    it.fails(`#${expectation.id} ${capture.notes}`, () => {
      assertWant(expectation.want, replayShipped(capture));
    });
  }
});

describe('detection: ambiguous (documented, not gating)', () => {
  for (const expectation of byStatus('ambiguous')) {
    const capture = loadCapture(expectation.id);
    it.skip(`#${expectation.id} ${capture.notes}`, () => {
      assertWant(expectation.want, replayShipped(capture));
    });
  }
});

describe('the fixture set itself', () => {
  it('labels every capture exactly once', () => {
    const ids = expectations.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 72 }, (_, i) => i + 1)
    );
  });
});
