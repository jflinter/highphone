# AGENTS.md

## What this is

**high phone** is a web game, playable **only on iPhones**, where you throw your
phone into the air. It uses the phone's accelerometer + gyroscope
(`devicemotion` / `deviceorientation` events) to detect the throw, measure how
long the phone was airborne, and from that compute how high it flew (via
projectile physics) and how fast it was going. There's a global leaderboard,
optional selfie-cam video of "your phone's journey", and daily/all-time +
case/no-case rankings.

It lives in production at **https://highphone.app** and **https://highph.one**.

Built ~2023, untouched for years. Codebase is deliberately simple.

## ⚠️ Changing throw detection requires evidence ⚠️

Detection used to be frozen because it was untestable: the constants were
hand-tuned by throwing a real iPhone over and over, and nothing in a dev
environment could tell you whether a change helped. That is no longer true.
`test/fixtures/captures/` holds 72 real gestures with per-capture verdicts, and
`test/replayCapture.ts` runs them through the game's exact listener.

**The rule now: no change to detection without running the fixtures.** Not "it
looks wrong so I fixed it" — the last person to trust that instinct would have
made things worse in four different ways. Run `pnpm test`, read what moved, and
say why every moved line is an improvement. `test/fixtures/README.md` is the
required reading.

### What the game runs

`pages/index.tsx` uses **`lib/freefallDetect.ts`**. It asks three questions per
motion event:

1. Is the phone weightless right now? `|accelerationIncludingGravity| <
   3 + 0.05 * w^2`, where the `w^2` term allows for the centrifugal force a
   spinning phone feels even in free fall.
2. How long did the weightless run last? From event timestamps — no 60Hz
   assumption.
3. Was it *thrown*, or merely dropped? There must be an upward push of
   >= 15 m/s^2 in the ~0.33s before the run began. Free fall alone cannot tell a
   throw from a drop, and `heightFromSeconds` would credit a drop's fall time as
   height it never climbed.

Steps 1-2 answer *how long*; step 3 answers *whether it counts*. Keeping those
separate is the fix — the retired detector used one signal for both, which is
why a wind-up that resembled a release corrupted the duration.

Scored against the 72 captures: **66 of 72 verdicts met, 6 outstanding** (see
below). The one externally verified throw (capture 55, hang time measured on
video at 2.03s) reads 1.983s.

### `lib/detectThrow.ts` is retired, not deleted

It still backs `/capture`, which runs both detectors side by side so a throw can
be judged against old and new in the field, and
`test/frozenDetector.characterization.test.ts` snapshots its behaviour. It is no
longer in the game's path. Do not revive it without reading why it was replaced.

### The 6 outstanding captures

- **3, 6, 7, 8** — version 1 fixtures, recorded before the capture tool stored
  `rotationRate`. They replay as if the phone were not spinning, and all four
  were spinning hard, so they get no centrifugal allowance and their flights
  never register. **Not reproducible on a live phone**, which always reports
  `rotationRate`. Capture 2 is the control: also version 1, barely spinning,
  still detected. 7 and 8 are confirmed 30+ footers and are the reason the
  detector is unvalidated above ~2s of hang time — re-capture a few high throws
  with the current tool to close that gap.
- **21** — reads 9.7ft against a stated 6ft, missing its band by 0.1ft.
- **61** — reads 10.1ft against a "short" note (its siblings put "short" at
  4-6ft).

### Exactly which code is detection-critical

- **`lib/freefallDetect.ts`** — what the game runs. Its constants
  (`FREEFALL_BASE`, `FREEFALL_SPIN_COEFF`, the launch gate, the confirm window)
  are fitted against the captures; changing one without re-running them is how
  you get a regression nobody notices for a year.
- **`lib/detectThrow.ts`** (retired from the game; still used by `/capture` and
  pinned by a characterization snapshot)
  - `verticalAcceleration()` — the phone's vertical acceleration, positive up:
    the component of raw acceleration along the gravity vector, so "up" is
    consistent regardless of phone orientation. Replaced
    `handleMotionRosettaCode()`, which computed the same number the long way
    round (a Rodrigues rotation taking gravity to `(0,0,-1)`, then negating z)
    and returned `NaN` whenever gravity happened to be parallel to `(0,0,-1)`.
    Proven identical on all 72 captured throws before the swap — see the
    comment on the function and the math audit in `test/fixtures/README.md`.
  - `detectThrow()` — the state machine (`waiting → accelerating → in_flight →
    complete`) that recognizes a throw and computes its airborne duration. Every
    constant here matters: `threshold = 8`, the `< -3` and `< -5` checks, the
    `22`- and `30`-frame windows, the `10`-frame trims, `/ 60` (60 Hz sampling),
    the rotation-diff math.
- **`pages/index.tsx`**
  - The `motionListener` and its setup inside the big `useEffect` — including
    `windowSizeSeconds = 3.5` and the `totalHeight > 1.5` minimum-throw gate.
    Note `windowSizeSeconds` cannot simply be raised for the retired detector
    (it doubled as a recency filter, and enlarging it broke real throws); the
    shipped detector scores identically from 3.5s to 8s, so raising it there is
    safe and would lift the ~36ft ceiling.
- **`lib/heightFromSeconds.ts`** — projectile physics: airborne time → peak
  height (feet).
- **`lib/speedFromSeconds.ts`** — projectile physics: airborne time → speed
  (mph).

Everything else (UI, leaderboard rendering, copy, styling, data layer, name
entry, video capture/upload) is **fair game** to change.

## Architecture

- **Framework:** Next.js 13.3.1, **pages router**, TypeScript, React 18, built
  as a **static export** (`output: 'export'` → `out/`). The app is 100%
  client-rendered; there is no SSR.
- **Styling:** Tailwind CSS.
- **Backend / hosting:** a single **Cloudflare Worker** (`worker/index.ts`)
  serves the static site (via the `ASSETS` binding) and a small JSON API under
  `/api/*`. Data is in **D1** (SQLite); journey videos are in **R2**.
  Everything runs on Cloudflare's free tier with git-push deploys.

  > Migrated off Supabase + Vercel (both since deleted). Any lingering
  > references to Supabase are stale.

### Data model (D1)

- Table **`scores`** — one row per throw: `id` (was Postgres bigint → SQLite
  INTEGER), `local_id` (client throw UUID), `player_id`, `player_name`,
  `duration_ms`, `has_case` (0/1), `created_at` (ISO-8601 millis + `Z`, stored so
  lexical order == chronological order). See `migrations/0001_init.sql`.
- The old Postgres `leaderboard` / `daily_leaderboard` **views** are reproduced
  as the `leaderboardQuery()` SQL in `worker/index.ts`: best throw per
  `(player_id, has_case)`, tie-broken by latest `created_at`, ordered by
  duration desc, top 100. "Daily" = a rolling **24-hour** window (not calendar
  day) — matching the original view.
- **R2 bucket** (`VIDEOS` binding) — uploaded `.mp4` "journey" videos, keyed by
  `<throwId>.mp4`. Not read back by the app currently, only written.
- Table **`capture_sessions`** — one row per recorded gesture from the `/capture`
  tool: `id`, `notes` (free-text annotation), `data` (JSON string: raw
  `devicemotion`/`deviceorientation` streams), `detected` (0/1, did the real
  detector fire — client-computed), `duration_ms`, `sample_count`, `created_at`.
  See `migrations/0002_capture_sessions.sql`. This is the fixture store for the
  frozen detector — real traces to eventually build golden tests from.

Note: height/speed shown on the leaderboard are computed **client-side** from
the stored `duration_ms` via `heightFromSeconds`; the DB only stores durations.

### Profanity shadowban

Bad usernames are handled **display-side only** (`lib/profanity.ts` via the
`obscenity` package). `components/Fame.tsx` hides profane-named leaderboard
entries from everyone *except* the entry's own owner (matched by `playerId`) —
a shadowban. Nothing is blocked at name entry and no data is scrubbed.

### Key files

| File | Role |
| --- | --- |
| `pages/index.tsx` | Name entry (`Welcome`) and the game + sensor loop (`Game`). Imports the frozen detector from `lib/detectThrow.ts`. |
| `lib/freefallDetect.ts` | **The game's detector.** Free fall + spin allowance + launch gate. |
| `lib/detectThrow.ts` | Retired detector, still used by `/capture` for comparison: `detectThrow` + `verticalAcceleration` (+ `Orientation`/`Throw`/`Vec3` types). |
| `pages/capture.tsx` | Private (`/capture`, noindex, unlinked) tool to record raw sensor traces + notes as detector fixtures. |
| `pages/fame.tsx`, `components/Fame.tsx` | Leaderboard UI. |
| `pages/hi.tsx`, `components/Info.tsx` | "About / contact" page (noindexed). |
| `lib/api.ts` | Data layer: `fetch`es the Worker's `/api/*`. Same-origin. |
| `lib/profanity.ts` | Leaderboard profanity shadowban helper. |
| `lib/usePlayerInfo.ts` | Player name / case / id in `localStorage` (keys: `airtimeName`, `airtimeHasCase`, `airtimePlayerId`). |
| `lib/heightFromSeconds.ts`, `lib/speedFromSeconds.ts` | Frozen physics. |
| `components/useMediaRecorder.js` | Vendored selfie-cam recording hook. |
| `components/IPhoneOnly.tsx` | Gates the whole app to iPhone user agents. |
| `worker/index.ts` | Cloudflare Worker: serves static assets + `/api/*` (D1 + R2). |
| `wrangler.toml` | Worker config (assets dir, D1, R2 bindings). |
| `migrations/*.sql` | D1 schema: `0001_init.sql` (scores), `0002_capture_sessions.sql` (capture fixtures). |
| `test/replayCapture.ts` | Replays a captured trace through the game's exact sensor pipeline. Mirrors `pages/index.tsx`'s listener — keep them in sync. |
| `test/fixtures/` | 72 real captured gestures, their per-capture verdicts (`expectations.ts`), and the bug write-up (`README.md`). |
| `next.config.js` | Enables static export. |

## Development

Package manager is **pnpm** (pinned via `packageManager` in package.json).

```bash
pnpm install
pnpm dev       # Next dev server (UI only — /api is not available here)
pnpm preview   # next build + `wrangler dev`: full app incl. the Worker/API
pnpm build     # static export to ./out
pnpm deploy    # next build + `wrangler deploy`
pnpm lint
pnpm test      # vitest: characterization tests for the pure functions
```

`pnpm test` locks `heightFromSeconds`, `speedFromSeconds`, the profanity
filter, and — via 72 captured real throws — **throw detection itself**.

`test/fixtures/captures/` holds those 72 gestures, pulled from the
`capture_sessions` D1 table. `test/replayCapture.ts` runs them through the
game's exact listener. **Read `test/fixtures/README.md` before touching
detection.**

| File | Job |
| --- | --- |
| `test/detection.expectations.test.ts` | What we *want*, per capture. Green must stay green. The 6 outstanding captures are registered with `it.fails`, so they are green *because* they fail; fixing one turns it **red**, which is the signal to promote it in `test/fixtures/expectations.ts`. |
| `test/freefallDetect.test.ts` | Unit-level behaviour the captures cannot show — chiefly that a *dropped* phone is not a throw, covered by synthetic traces. |
| `test/frozenDetector.characterization.test.ts` | Snapshot of the retired `detectThrow`, still run by `/capture`. |

For anything touching the API/leaderboard, use `pnpm preview` (real Worker +
local D1), not `pnpm dev`. D1 can be seeded locally with
`pnpm exec wrangler d1 execute highphone --local --file migrations/0001_init.sql`.

Note: pnpm blocks postinstall scripts by default; the build scripts wrangler
needs (`esbuild`, `workerd`) are allow-listed under `pnpm.onlyBuiltDependencies`
in package.json.

**You cannot actually play the game on a desktop dev machine** — it requires an
iPhone's motion sensors, and `IPhoneOnly` shows a fallback message elsewhere. UI
changes can be inspected in a browser (spoof an iPhone user agent), but any
change that depends on real throw data can only be validated on a physical
iPhone in the field.

## Gotchas

- The API is unauthenticated — anyone can POST a score. That was already true
  with the public Supabase anon key; the Worker preserves the behavior.
- The game reloads the page after name entry "to avoid the shake-to-undo bug" —
  intentional.
- 60 Hz sensor sampling is assumed throughout the detection math (see the
  `TODO adjust for different intervals`); this is part of the frozen logic.
</content>
</invoke>
