/// <reference types="@cloudflare/workers-types" />

// Cloudflare Worker for high phone.
//
// Serves the static site (via the ASSETS binding) and handles the small JSON
// API the game needs. Replaces the old Supabase backend:
//   - Postgres `scores` table            -> D1 `scores` table
//   - `leaderboard`/`daily_leaderboard`  -> SQL in leaderboardQuery() below
//   - Storage bucket `journeys`          -> R2 bucket (VIDEOS binding)
//
// NOTE: none of the game's throw-detection logic lives here — this is purely
// the data layer.

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  VIDEOS: R2Bucket;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// ---------------------------------------------------------------------------
// Leaderboard query
//
// Faithful port of the old Supabase `leaderboard` / `daily_leaderboard` views:
// one row per player (dedup'd by player_id + has_case) showing their best throw
// by duration, tie-broken by the most recent throw at that duration, ordered
// best-first, capped at 100. `daily` restricts to a rolling 24h window (the
// views used `created_at > now() - interval '1 day'`).
//
// Because the app always filters by a single has_case value, filtering first
// then partitioning by player_id alone is equivalent to the view's
// (player_id, has_case) grouping.
//
// created_at is stored as ISO-8601 millis with Z (e.g. 2023-05-10T12:34:56.789Z)
// so lexical string comparison equals chronological order — the 24h threshold
// below is generated in the identical format, making the comparison exact
// without relying on SQLite date parsing.
// ---------------------------------------------------------------------------
const leaderboardQuery = (daily: boolean) => `
  SELECT id, player_name, max_duration, created_at, has_case, player_id
  FROM (
    SELECT
      id,
      player_name,
      duration_ms AS max_duration,
      created_at,
      has_case,
      player_id,
      ROW_NUMBER() OVER (
        PARTITION BY player_id ORDER BY duration_ms DESC, created_at DESC
      ) AS rn
    FROM scores
    WHERE has_case = ?1
      ${
        daily
          ? "AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')"
          : ''
      }
  )
  WHERE rn = 1
  ORDER BY max_duration DESC
  LIMIT 100
`;

const handleApi = async (
  request: Request,
  env: Env,
  url: URL
): Promise<Response> => {
  const { pathname } = url;

  // POST /api/scores — record a throw, return its rank on today's leaderboard.
  if (pathname === '/api/scores' && request.method === 'POST') {
    const body = (await request.json()) as {
      localId: string;
      playerId: string;
      playerName: string;
      durationMs: number;
      hasCase: boolean;
    };
    const createdAt = new Date().toISOString();
    const inserted = await env.DB.prepare(
      `INSERT INTO scores (local_id, player_id, player_name, duration_ms, has_case, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id`
    )
      .bind(
        body.localId,
        body.playerId,
        body.playerName,
        Math.round(body.durationMs),
        body.hasCase ? 1 : 0,
        createdAt
      )
      .first<{ id: number | string }>();

    if (!inserted) return json({ dailyIndex: null });

    // Match the old behavior: find this throw's position in today's
    // leaderboard by id; only meaningful if it's the player's best today.
    const daily = await env.DB.prepare(leaderboardQuery(true))
      .bind(body.hasCase ? 1 : 0)
      .all<{ id: number | string }>();
    const index = (daily.results ?? []).findIndex(
      (r) => String(r.id) === String(inserted.id)
    );
    return json({ dailyIndex: index > 0 ? index : null });
  }

  // GET /api/leaderboard?hasCase=&daily=
  if (pathname === '/api/leaderboard' && request.method === 'GET') {
    const hasCase = url.searchParams.get('hasCase') === 'true' ? 1 : 0;
    const daily = url.searchParams.get('daily') === 'true';
    const rows = await env.DB.prepare(leaderboardQuery(daily))
      .bind(hasCase)
      .all();
    return json(rows.results ?? []);
  }

  // GET /api/high-score?playerId= — the player's single best throw.
  if (pathname === '/api/high-score' && request.method === 'GET') {
    const playerId = url.searchParams.get('playerId') ?? '';
    const row = await env.DB.prepare(
      `SELECT id, player_name, duration_ms AS max_duration, created_at, has_case, player_id
       FROM scores WHERE player_id = ?1
       ORDER BY duration_ms DESC LIMIT 1`
    )
      .bind(playerId)
      .first();
    return json(row ?? null);
  }

  // POST /api/videos?throwId= — store the journey video in R2.
  if (pathname === '/api/videos' && request.method === 'POST') {
    const throwId = url.searchParams.get('throwId');
    if (!throwId || !request.body) return json({ error: 'bad request' }, 400);
    await env.VIDEOS.put(`${throwId}.mp4`, request.body, {
      httpMetadata: {
        contentType: request.headers.get('content-type') ?? 'video/mp4',
      },
    });
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }
    // Everything else is a static asset (the exported Next.js site).
    return env.ASSETS.fetch(request);
  },
};
