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

## ⚠️ The most important thing: DO NOT CHANGE THE CORE GAME LOGIC ⚠️

The throw-detection code was tuned by hand against messy, noisy real-world
accelerometer data — throwing an actual iPhone into the air over and over. The
magic numbers in it (thresholds, frame counts, the 60 Hz assumption, the
gravity-rotation math) are **empirically calibrated and effectively
untestable in a dev environment**. There is no way to unit-test them or verify
a change without physically throwing a phone many times, and even then the
sensor data is noisy enough that regressions are extremely hard to spot.

**Treat the core game logic as frozen.** Do not "clean it up," refactor it,
rename its variables, adjust its constants, or "fix" things that look like bugs
(e.g. the `// TODO this makes no sense` comment, the `index > 0` check, the
`beta / 2`). If it looks wrong but ships in production, assume it was tuned that
way on purpose. If a task seems to *require* touching it, **stop and ask the
human first**, and never change observable behavior.

### Known detector bugs (documented, still frozen)

The 72 captured traces proved two real bugs. They are written up in full in
`test/fixtures/README.md`; this is the summary so nobody rediscovers them:

1. **The detector latches onto the wind-up, not the release.** An arm swing
   produces the same `accel > 8` then `accel < -3` signature as a throw, so the
   flight clock starts early. The tell is `Throw.maxAcceleration`: a genuine
   release reads 50-105, every misdetection in the set reads 9-49.
   - Ten captures report exactly **383ms / 0.6ft** — the 23-frame minimum the
     `i - inFlightIndex > 22` anti-cheat allows. Because `pages/index.tsx`
     clears its buffers on *any* detection before applying the `> 1.5` height
     gate, these phantoms also destroy the throw that follows. Captures 7, 8,
     71 and 72 are big throws that scored **nothing**.
   - Captures 35 and 39 are fakes where the phone never left the hand, and the
     game posted **11.4ft** and **4.0ft**.
2. **Overhand throws read far too high** — same early latch, but the detector
   rides through the arm arc and completes at the real landing, so the reading
   includes the throwing motion. Capture 65 ("~4 ft") reads 20.3ft; capture 66
   ("(6ft)") reads 23.2ft. Capture 68 is overhand onto cushions and reads 1.7ft
   against a stated 6ft, so a fix cannot just cap the high side.

`rotationRate` (`ra/rb/rg`, captured but never fed to the detector) is the
signal that could separate "spinning" from "accelerating".
`lib/freefallDetect.ts` is a **prototype** that does exactly that — it is scored
against the same captures in `test/freefallDetect.test.ts` and beats the best
possible tuning of the frozen constants. It is deliberately NOT wired into the
game; swapping it in is a separate, deliberate decision.

**This does not unfreeze the code.** The rule below still applies: ask first.
What has changed is that a fix can now be *verified* instead of guessed at.

### Exactly which code is "core game logic" (frozen)

- **`lib/detectThrow.ts`** (relocated verbatim from `pages/index.tsx` so both the
  game and the `/capture` tool can import it — the *logic is unchanged*)
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
  - The `motionListener` / `orientationListener` and their setup inside the big
    `useEffect` — including `windowSizeSeconds = 3.5`, `zAccel =
    rotatedAcceleration[2] * -1`, and the `totalHeight > 1.5` minimum-throw gate.
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
| `lib/detectThrow.ts` | Frozen detection logic: `detectThrow` + `verticalAcceleration` (+ `Orientation`/`Throw`/`Vec3` types). |
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
| `lib/freefallDetect.ts` | Prototype detector built on free fall + `rotationRate`. Not wired into the game. |
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
filter, and — as of the 72 captured traces — **`detectThrow` itself**.

`test/fixtures/captures/` holds 72 real gestures recorded with `/capture` and
pulled from the `capture_sessions` D1 table. `test/replayCapture.ts` feeds them
through the game's exact listener pipeline, and reproduces the live on-device
result for all 72. Detection is no longer untestable. **Read
`test/fixtures/README.md` before touching anything in `lib/detectThrow.ts`.**

Two test files, with different jobs:

- `test/detectThrow.expectations.test.ts` — what we *want*. Real throws the
  detector gets right and gestures it correctly ignores must stay green. Known
  bugs are registered with `it.fails`, so they are green *because* they fail
  today; fixing one turns it **red**, which is the success signal — drop the
  `.fails` and promote the row in `test/fixtures/expectations.ts`.
- `test/detectThrow.characterization.test.ts` — what *is*. A snapshot of all 72
  readings. Expected to go red on any deliberate detection change; read the
  diff, confirm each line moved as intended, then `pnpm exec vitest run -u`.

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
