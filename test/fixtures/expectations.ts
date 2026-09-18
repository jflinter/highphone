// What we WANT the throw detector to do with each recorded capture, and
// whether today's frozen detector already does it.
//
// Every row was labelled by replaying the capture through the real game loop
// (test/replayCapture.ts) and comparing the result against the field note the
// thrower wrote at capture time. See test/fixtures/README.md for the full
// story, including the two bugs this data exposed.
//
//   'correct'   — today's detector gets this right. The test asserts `want`
//                 and MUST STAY GREEN. A change that breaks one of these is a
//                 regression, full stop.
//   'bug'       — today's detector gets this wrong. The test asserts `want`
//                 and is registered with `it.fails`, so it is green *because*
//                 it fails. When a fix lands it turns RED — that is the signal
//                 to delete the `.fails` and promote the row to 'correct'.
//   'ambiguous' — we genuinely cannot tell. Suspicious, but the field note
//                 isn't precise enough to call it. Skipped, not gating.
//
// Heights in field notes are eyeball estimates, so `heightFt` bands are
// deliberately generous (roughly the stated value ±60%) and are only asserted
// where the note gives an estimate INDEPENDENT of what the app displayed. Notes
// carrying suspiciously exact decimals ("3.9ft", "1.6ft") were almost certainly
// read back off the game's own screen; for those we assert only that the throw
// got recorded at all, never its magnitude. Capture 55 is the exception and the
// most valuable row here: its hang time was measured on video.

export type Want = {
  /** Should the game post a score to the leaderboard for this gesture? */
  record: boolean;
  /**
   * How many times should the detector fire across the whole gesture? One
   * gesture should produce at most one detection: every extra fire wipes the
   * game's 3.5s buffers, which is how a wind-up destroys the throw after it.
   */
  detections?: number;
  /** Plausible height range in feet, from an independent field estimate. */
  heightFt?: [number, number];
  /** Airborne range in ms, only where externally measured. */
  durationMs?: [number, number];
};

export type Expectation = {
  id: number;
  status: 'correct' | 'bug' | 'ambiguous';
  want: Want;
  why: string;
};

const realThrow = (id: number, why: string, extra: Partial<Want> = {}): Expectation => ({
  id,
  status: 'correct',
  want: { record: true, detections: 1, ...extra },
  why,
});

const notAThrow = (id: number, why: string): Expectation => ({
  id,
  status: 'correct',
  want: { record: false, detections: 0 },
  why,
});

export const expectations: Expectation[] = [
  // ---------------------------------------------------------------- correct
  // Ordinary throws the detector already handles. These are the regression
  // net: any future detector still has to recognise all of them, exactly once.
  realThrow(1, 'Couch throw noted as 5 feet; reads 5.0ft.', { heightFt: [3, 8] }),
  realThrow(2, 'Gentle toss onto a bed. Recorded once; the "3.9ft" note is the app\'s own readout, so only recording is asserted.'),
  realThrow(3, 'Small spinny throw, recorded at 1.6ft — just over the 1.5ft gate. Spin alone does not break detection.'),
  realThrow(6, 'Big throw, caught. Recorded once.'),
  realThrow(10, 'Explicitly "no wind up" — the clean case. Recorded once.'),
  realThrow(11, 'Small wind up, still a single clean detection.'),
  realThrow(12, 'Small wind up, single clean detection.'),
  realThrow(15, '"3-4 foot throw, medium spin"; reads 2.2ft, low but inside estimate error.', { heightFt: [2.1, 5.6] }),
  realThrow(16, 'Minimal spin, single clean detection.'),
  realThrow(17, 'Caught throw, recorded once.'),
  realThrow(18, 'Caught throw with some spin, recorded once.'),
  realThrow(19, 'Caught throw with some spin, recorded once.'),
  realThrow(20, 'Caught throw, recorded once.'),
  realThrow(22, 'Caught throw with medium spin, recorded once.'),
  realThrow(24, 'Short caught throw, recorded once.'),
  realThrow(25, 'Short caught throw, recorded once.'),
  realThrow(26, 'Short caught throw, recorded once.'),
  realThrow(27, 'Short caught throw, recorded once.'),
  realThrow(40, 'Underhand throw into grass, single clean detection.'),
  realThrow(41, 'Underhand throw onto a cushion, single clean detection.'),
  realThrow(42, 'Underhand throw onto grass, single clean detection.'),
  realThrow(43, 'High throw onto grass, single clean detection.'),
  realThrow(45, 'Has a wind up but a strong release (maxAcceleration 84), so it latched on the release, not the wind up.'),
  realThrow(47, 'Has a wind up but a strong release (maxAcceleration 103); latched correctly.'),
  realThrow(48, 'Lots of spin, still a single clean detection.'),
  realThrow(49, 'Lots of spin, still a single clean detection.'),
  realThrow(50, 'Underhand throw onto grass, single clean detection.'),
  realThrow(51, 'High throw onto a cushion, single clean detection.'),
  realThrow(52, 'Flight cut short by a tree — a shorter reading is physically honest here.'),
  realThrow(53, 'High throw onto grass, single clean detection.'),
  realThrow(54, 'High throw onto grass, single clean detection.'),
  realThrow(
    55,
    'THE CALIBRATION ROW: hang time independently measured on video at 2.03s, and the detector reports 2.000s. This is the only externally verified timing in the set — any future detector must still land on it.',
    { durationMs: [1930, 2130] }
  ),
  realThrow(58, 'High throw onto grass, single clean detection.'),
  realThrow(59, 'Hit a tree on the way down; still one clean detection.'),
  realThrow(60, 'Underhand throw onto grass, single clean detection.'),
  realThrow(69, 'Highest throw in the set (2.73s / 30ft), single clean detection.'),
  realThrow(70, 'Underhand throw onto grass, single clean detection.'),

  // True negatives. The detector is already quiet through all of these, and a
  // future detector that gets stricter about wind-ups must not overshoot into
  // firing on ordinary handling.
  notAThrow(28, 'Walking around the yard holding the phone. Silent, correctly.'),
  notAThrow(29, 'Walking around the yard holding the phone. Silent, correctly.'),
  notAThrow(30, 'Walking around the yard holding the phone. Silent, correctly.'),
  notAThrow(31, 'Setting the phone down on a table. Silent, correctly.'),
  notAThrow(38, 'Fake throw kept in hand and moved down — the one fake the detector already ignores completely.'),
  notAThrow(56, 'Picking the phone up off the ground. Silent, correctly.'),
  notAThrow(57, 'Picking the phone up off the ground. Silent, correctly.'),
  notAThrow(67, 'Phone just held in hand. Silent, correctly.'),

  // -------------------------------------------------------------------- bugs
  // BUG 1 — the wind-up false latch.
  //
  // A wind-up produces accel > 8 (arm goes up) then accel < -3 (arm comes
  // down), which is exactly the `waiting -> accelerating -> in_flight`
  // signature of a release. The detector starts the flight clock on the wind
  // up, and the REAL release spike 23+ frames later reads as the landing. That
  // is where every 383ms reading comes from: 23 frames is the smallest window
  // the `i - inFlightIndex > 22` anti-cheat allows, i.e. the detector bailing
  // at the first legal opportunity.
  //
  // The tell is `maxAcceleration`, the peak between the start of the window and
  // `inFlightIndex`: a genuine release reads 50-105, every false latch below
  // reads 9-49. The detector is latching onto an arm swing, not a throw.
  //
  // It is worse than a bad number. pages/index.tsx clears `accelerations` and
  // `orientations` on ANY detection, before it applies the 1.5ft gate — so a
  // 0.6ft phantom silently destroys the 3.5s of history the real throw needs.
  // Captures 7, 8, 71 and 72 are exactly that: huge throws that never scored.
  {
    id: 7,
    status: 'bug',
    want: { record: true, detections: 1, heightFt: [20, 60] },
    why: 'An "extremely high" throw that scores NOTHING. A wind-up phantom fires at sample 488 (0.6ft), wipes the buffer, and the real throw never recovers — it fires a second 0.6ft phantom and stops. This is the headline user-visible bug. Ground truth for the band: the thrower confirms these were the highest throws ever put through the capture tool, legitimately 30+ feet, and the trace agrees — it reaches a minimum |accelerationIncludingGravity| of 0.08 (near-perfect free fall) across a ~2.9s stretch, which is 33.8ft.',
  },
  {
    id: 8,
    status: 'bug',
    want: { record: true, detections: 1, heightFt: [20, 60] },
    why: 'A "very very high" throw that scores NOTHING. Same two-phantom pattern as 7 (0.6ft then 1.0ft, both under the gate). Also confirmed by the thrower as a genuine 30+ footer; its trace bottoms out at |a| = 0.19 across ~3.1s, which is 39.5ft.',
  },
  {
    id: 9,
    status: 'bug',
    want: { record: true, detections: 1, heightFt: [3.6, 9.6] },
    why: 'Stated 6ft with a "brief wind up". The wind-up phantom fires first (0.6ft, maxAcceleration 9.3), and only because the throw was still ahead of the wiped buffer does a second detection catch it at 8.1ft. The right answer by luck: a correct detector fires once.',
  },
  {
    id: 14,
    status: 'bug',
    want: { record: true, detections: 1, heightFt: [3.3, 8.8] },
    why: 'A "5-6 foot, very spinny" throw that scores NOTHING — it completes after the minimum 23 frames (1.4ft, under the gate). Unlike 7/8/71/72 the release WAS caught (maxAcceleration 79), so this is a different failure: spin during flight fakes the landing spike and ends the throw early.',
  },
  {
    id: 21,
    status: 'bug',
    want: { record: true, heightFt: [3.6, 9.6] },
    why: 'Stated 6ft with lots of spin, reported as 13.3ft — more than double. maxAcceleration 28.3 puts it in the wind-up-latch family: the clock started before the release.',
  },
  {
    id: 23,
    status: 'bug',
    want: { record: false, detections: 0 },
    why: 'Thrower explicitly did not throw — just waved an arm — and the detector still fired (383ms/0.6ft). The 1.5ft gate is the only thing that saved it, and the fire still wipes the buffer.',
  },
  {
    id: 32,
    status: 'bug',
    want: { record: false, detections: 0 },
    why: 'Wind-up with the phone never leaving the hand; detector fires the 383ms phantom.',
  },
  {
    id: 33,
    status: 'bug',
    want: { record: false, detections: 0 },
    why: 'Wind-up with the phone never leaving the hand; detector fires the 383ms phantom.',
  },
  {
    id: 34,
    status: 'bug',
    want: { record: false, detections: 0 },
    why: 'Wind-up with the phone never leaving the hand; detector fires the 383ms phantom.',
  },
  {
    id: 35,
    status: 'bug',
    want: { record: false, detections: 0 },
    why: 'WORST CASE: the phone never left the hand and the detector posted a 1.683s / 11.4ft score. A fake throw that clears the gate and lands on the leaderboard.',
  },
  {
    id: 36,
    status: 'bug',
    want: { record: false, detections: 0 },
    why: 'Wind-up with the phone never leaving the hand; detector fires the 383ms phantom.',
  },
  {
    id: 37,
    status: 'bug',
    want: { record: false, detections: 0 },
    why: 'Wind-up with the phone never leaving the hand; detector fires the 383ms phantom.',
  },
  {
    id: 39,
    status: 'bug',
    want: { record: false, detections: 0 },
    why: 'The phone never left the hand and the detector posted a 1.0s / 4.0ft score. Same class as 35.',
  },
  {
    id: 71,
    status: 'bug',
    want: { record: true, detections: 1 },
    why: '"Medium high throw w big windup" that scores NOTHING — 0.6ft phantom, buffer wiped, then a 1.2ft phantom. The bigger the wind up, the more reliably the throw is lost.',
  },
  {
    id: 72,
    status: 'bug',
    want: { record: true, detections: 1 },
    why: '"Medium high throw w big windup" that scores NOTHING — 0.6ft then 0.7ft, both under the gate.',
  },

  // BUG 2 — overhand throws read far too high.
  //
  // Same root cause as bug 1, different outcome. An overhand throw's arm arc
  // trips `accelerating -> in_flight` early, but instead of completing at the
  // minimum window the detector rides through the whole arc AND the flight and
  // completes at the real landing. The clock therefore includes the throwing
  // motion. maxAcceleration for the whole overhand series is 9-32, versus
  // 50-105 for underhand throws that latch on the release.
  {
    id: 61,
    status: 'bug',
    want: { record: true, heightFt: [3, 8] },
    why: 'A "short" overhand throw (siblings 65/66 put "short" at 4-6ft) reported as 13.0ft. maxAcceleration 12.3 — latched on the arm swing.',
  },
  {
    id: 63,
    status: 'bug',
    want: { record: true, heightFt: [3, 8] },
    why: 'A "short" overhand throw reported as 18.9ft. maxAcceleration 9.6, barely over the threshold of 8 — latched on the arm swing.',
  },
  {
    id: 64,
    status: 'bug',
    want: { record: true, heightFt: [3, 8] },
    why: 'A "short" overhand throw reported as 12.1ft. maxAcceleration 19.2 — latched on the arm swing.',
  },
  {
    id: 65,
    status: 'bug',
    want: { record: true, heightFt: [2.4, 6.4] },
    why: 'Explicitly noted "~4 ft" and reported as 20.3ft — a 5x over-read, and the clearest proof of the bug since the note cannot be an app readout. maxAcceleration 10.5.',
  },
  {
    id: 66,
    status: 'bug',
    want: { record: true, heightFt: [3.6, 9.6] },
    why: 'Explicitly noted "(6ft)" and reported as 23.2ft — a ~4x over-read. maxAcceleration 9.3, the lowest in the set.',
  },
  {
    id: 68,
    status: 'bug',
    want: { record: true, heightFt: [3.6, 9.6] },
    why: 'Overhand, but onto couch cushions rather than grass, and it reads 1.7ft against a stated 6ft — under by 3.5x rather than over. Whatever fix lands has to handle overhand in both directions, not just cap the high side.',
  },

  // -------------------------------------------------------------- ambiguous
  // Suspicious, but the field notes cannot settle them. Documented and skipped
  // so they are not silently forgotten; the characterization snapshot still
  // tracks whatever a future detector does to them.
  {
    id: 4,
    status: 'ambiguous',
    want: { record: true, detections: 1 },
    why: 'Noted as "dropped at the end", so the measured flight legitimately includes a drop. No independent height to check 3.8ft against.',
  },
  {
    id: 5,
    status: 'ambiguous',
    want: { record: true },
    why: 'NOT A DETECTOR VERDICT — a data artifact. The screen locked mid-throw and truncated the trace, so the detector never saw the landing. This capture is why the wake lock was added; keep it as a record of the truncation, do not tune against it.',
  },
  {
    id: 13,
    status: 'ambiguous',
    want: { record: true, detections: 1, heightFt: [3.6, 9.6] },
    why: 'Stated 6ft, reads 8.8ft — 47% high, and maxAcceleration 23.5 puts it in the wind-up-latch family. But 47% is inside eyeball-estimate error, so we cannot call it a bug.',
  },
  {
    id: 44,
    status: 'ambiguous',
    want: { record: true, detections: 1 },
    why: 'Suspected mild wind-up inflation: 21.6ft, against 14.8ft for capture 42 which the thrower described identically but without a wind up. maxAcceleration 22.5 (vs 87.5 for 42) supports it. No independent height, so not called.',
  },
  {
    id: 46,
    status: 'ambiguous',
    want: { record: true, detections: 1 },
    why: 'Same suspicion as 44: 20.0ft with a wind up vs 16.9ft for capture 51 without, maxAcceleration 31.5 vs 93.7. No independent height.',
  },
  {
    id: 62,
    status: 'ambiguous',
    want: { record: true, heightFt: [3, 8] },
    why: 'Same overhand series and same low maxAcceleration (31.6) as 61/63-66, but its 6.1ft reading is plausible for a "short" throw. It may simply be a less badly latched instance of the same bug.',
  },
];
