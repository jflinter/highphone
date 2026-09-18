# Capture fixtures

72 real gestures recorded off an iPhone with the `/capture` tool
(`pages/capture.tsx`), pulled from the `capture_sessions` D1 table in
production. Each `captures/NNN.json` is one gesture: the raw `devicemotion` and
`deviceorientation` streams, the thrower's field note, and what the phone itself
computed live at capture time.

These are the fixtures AGENTS.md has been waiting for. The throw detector was
"effectively untestable in a dev environment" because reproducing a throw meant
physically throwing a phone; these traces are those throws, frozen.

## What's in a fixture

```jsonc
{
  "id": 69,
  "notes": "High throw straight up onto grass",   // written at capture time
  "createdAt": "2026-09-17T21:13:00.123Z",
  "client": {            // what the PHONE computed live, the parity baseline
    "detected": true,
    "durationMs": 2733,
    "sampleCount": 418
  },
  "version": 2,          // v1 (ids 1-8) has no rotationRate and no userAgent
  "motion":      [{ "t", "interval", "ax","ay","az", "gx","gy","gz", "ra","rb","rg" }],
  "orientation": [{ "t", "alpha", "beta", "gamma" }]
}
```

Floats are rounded to 6 decimals to keep the set at ~8MB. The game rounds every
sensor value to 1 decimal before the detector sees it, so this is far below
anything detection can notice — and the parity test proves it: replaying all 72
reproduces the live on-device result exactly, 72 for 72.

`ra/rb/rg` is `rotationRate`. It is recorded but **not** fed to the detector; it
is the signal that would let a fix tell "the phone is spinning" apart from "the
phone is accelerating", which is the heart of both bugs below.

## The two test files

| File | Job |
| --- | --- |
| `../detectThrow.expectations.test.ts` | What we *want*. Correct behaviour must stay green; known bugs are `it.fails` and turn red when fixed. |
| `../detectThrow.characterization.test.ts` | What *is*. One snapshot of all 72 readings, so any detector change shows its full blast radius in a single diff. |

`expectations.ts` carries the per-capture verdict and the reasoning. Heights in
field notes are eyeball estimates, so height assertions are generous (about the
stated value ±60%) and are only made where the note is independent of what the
app displayed — notes with exact decimals ("3.9ft") were read off the game's own
screen and would be circular.

**Capture 55 is the anchor**: its hang time was measured on video at 2.03s and
the detector reports 2.000s. It is the only externally verified timing here.

## Replaying is not just calling `detectThrow`

`../replayCapture.ts` mirrors `pages/index.tsx`'s listener exactly: the same
1-decimal rounding, the same gravity-rotation step, two independent 210-sample
ring buffers fed by timestamp-interleaved events, `detectThrow` re-run from
scratch on every motion sample, and — critically — the game's behaviour of
**wiping both buffers on any detection, before applying the `totalHeight > 1.5`
gate**. If that listener changes, change the replay too.

## What this data revealed

Two bugs, one root cause.

### The 60 Hz assumption is fine

Worth stating because it was the obvious suspect. Median inter-sample gap is
17ms (58.8 Hz) in all 72 captures, and reported duration matches wall-clock
elapsed time at a ratio of 0.92-1.00. The `/ 60` in `detectThrow` is sound.

### Root cause: the detector latches onto the wind-up, not the release

A wind-up produces acceleration > 8 (arm goes up) then < -3 (arm comes down) —
exactly the `waiting -> accelerating -> in_flight` signature of a real release.
The flight clock starts on the arm swing.

The tell is `maxAcceleration`, the peak between the start of the window and
`inFlightIndex`. A genuine release reads **50-105**; every misdetection in this
set reads **9-49**. The detector cannot currently tell a throw from a swing,
and `rotationRate` — recorded, unused — is the signal that could.

This surfaces in two different ways.

**Bug 1 — big throws score nothing.** With the clock started early, the *real*
release spike arrives 23+ frames later and reads as the landing. 23 frames is
the minimum the `i - inFlightIndex > 22` anti-cheat allows, which is why ten
captures report exactly 383ms / 0.6ft. That is under the 1.5ft gate, so no
score — and because `pages/index.tsx` clears `accelerations` and `orientations`
on *any* detection before checking the gate, the phantom also destroys the 3.5s
of history the real throw needs. Captures **7, 8, 71, 72** are exactly this: an
"extremely high" throw, a "very very high" throw, and two "medium high throws w
big windup", none of which scored at all. Capture 9 shows the near miss — a
phantom fires, wipes the buffer, and the throw is only caught because it was
still ahead of the wipe.

The same phantom makes fakes scoreable. Captures **35** and **39** are gestures
where the phone never left the hand, and the detector posted **11.4ft** and
**4.0ft**.

**Bug 2 — overhand throws read far too high.** Same early latch, different
ending: instead of completing at the minimum window the detector rides through
the arm arc *and* the flight and completes at the real landing, so the reading
includes the throwing motion. The whole overhand series (61-66) has
`maxAcceleration` of 9-32. Capture **65**, noted "~4 ft", reads **20.3ft**;
capture **66**, noted "(6ft)", reads **23.2ft**.

Capture **68** is the warning against a cheap fix: it is overhand too, onto
cushions instead of grass, and reads **1.7ft** against a stated 6ft — under by
3.5x. Any fix has to handle overhand in both directions, not just cap the high
side.

### One separate failure

Capture **14** ("5-6 foot throw, very spinny") scores nothing, but its
`maxAcceleration` is 79 — the release *was* caught correctly. Here spin during
flight fakes the landing spike and ends the throw at the 23-frame minimum. It
needs a different fix from bugs 1 and 2.

## Adding more captures

Record with `/capture`, then:

```bash
curl -s "https://highphone.app/api/captures?id=<n>" | \
  python3 -c "import json,sys; ..."   # see git history for the normalizer
```

Write a real field note — an independent height estimate, or better, a
video-measured hang time. A capture whose note just repeats the app's readout
can prove the throw was *recorded*, but can never prove it was recorded
*correctly*.
