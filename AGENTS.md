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

### Exactly which code is "core game logic" (frozen)

- **`pages/index.tsx`**
  - `handleMotionRosettaCode()` — rotates raw acceleration into a world frame
    using the gravity vector so "up" is consistent regardless of phone
    orientation.
  - `detectThrow()` — the state machine (`waiting → accelerating → in_flight →
    complete`) that recognizes a throw and computes its airborne duration. Every
    constant here matters: `threshold = 8`, the `< -3` and `< -5` checks, the
    `22`- and `30`-frame windows, the `10`-frame trims, `/ 60` (60 Hz sampling),
    the rotation-diff math.
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
| `pages/index.tsx` | Everything: name entry (`Welcome`), the game + sensor loop (`Game`), and the frozen detection logic. |
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
| `migrations/0001_init.sql` | D1 schema. |
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

`pnpm test` currently locks `heightFromSeconds`, `speedFromSeconds`, and the
profanity filter. **`detectThrow` is NOT yet covered** — it lives unexported in
`pages/index.tsx`. Covering it (extract to `lib/`, add golden tests from a
captured real acceleration trace) is the safest way to make future changes near
the core verifiable; do that before touching detection.

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
