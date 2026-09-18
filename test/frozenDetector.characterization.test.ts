// One snapshot of what the RETIRED `detectThrow` does to all 72 real captures.
//
// The game no longer runs this detector — pages/index.tsx uses
// lib/freefallDetect.ts. It is kept because /capture still runs it side by side
// for comparison in the field, and because this snapshot is the record of the
// behaviour the fixtures were originally labelled against.
//
// This file makes NO judgement about right or wrong — that is
// detectThrow.expectations.test.ts. Its job is to make the blast radius of any
// detector change visible in one diff: change a constant and you see, per
// throw, exactly which readings moved and by how much.
//
// It is EXPECTED to go red when detection is deliberately changed. Read the
// diff, confirm every line moved the way you intended, then re-baseline with
//   pnpm exec vitest run -u
//
// The `client` column is what the phone itself computed live at capture time,
// so the `replay matches` test below also proves this harness still reproduces
// production rather than drifting into its own dialect.

import { describe, expect, it } from 'vitest';
import { allCaptureIds, loadCapture } from './captures';
import { replayCapture } from './replayCapture';

const fixed = (n: number | null, digits: number) =>
  n === null ? null : Number(n.toFixed(digits));

describe('retired detectThrow characterization', () => {
  it('replay matches what the phone computed live, for every capture', () => {
    const drift = allCaptureIds().flatMap((id) => {
      const capture = loadCapture(id);
      const { firstDetection } = replayCapture(capture);
      const live = capture.client;
      const same =
        (firstDetection !== null) === live.detected &&
        Math.round(firstDetection?.durationMs ?? 0) === Math.round(live.durationMs ?? 0);
      return same ? [] : [`#${id}: live ${live.detected}/${live.durationMs}ms vs replay ${firstDetection !== null}/${firstDetection?.durationMs ?? null}ms`];
    });
    expect(drift).toEqual([]);
  });

  it('produces a stable reading for every recorded gesture', () => {
    const table = allCaptureIds().map((id) => {
      const capture = loadCapture(id);
      const result = replayCapture(capture);
      return {
        id,
        notes: capture.notes,
        fires: result.detections.length,
        recorded: result.recorded !== null,
        durationMs: fixed(result.durationMs, 0),
        heightFt: fixed(result.heightFt, 1),
        // Peak acceleration before the flight clock starts. Low values mean the
        // detector latched onto an arm swing rather than a release.
        maxAcceleration: fixed(result.detections[0]?.throw.maxAcceleration ?? null, 1),
      };
    });
    expect(table).toMatchSnapshot();
  });
});
