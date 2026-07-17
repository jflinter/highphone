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
    // Validate — reject garbage/spam, but with bounds far outside any real
    // throw (real airtime is < ~3.5s) so a legitimate score is never rejected.
    const durationMs = Math.round(Number(body.durationMs));
    if (
      typeof body.playerId !== 'string' ||
      body.playerId.length === 0 ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0 ||
      durationMs > 60000
    ) {
      return json({ error: 'invalid score' }, 400);
    }
    const playerName = String(body.playerName ?? '').slice(0, 200);
    const localId = String(body.localId ?? '').slice(0, 100);
    const createdAt = new Date().toISOString();
    const inserted = await env.DB.prepare(
      `INSERT INTO scores (local_id, player_id, player_name, duration_ms, has_case, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id`
    )
      .bind(
        localId,
        body.playerId,
        playerName,
        durationMs,
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

  // Capture sessions — the /capture data-collection tool (pages/capture.tsx).
  // Each POST is one recorded gesture: raw sensor streams + a text note, used
  // to build fixtures for the (otherwise untestable) throw detector.
  //
  // POST /api/captures — store a capture session.
  if (pathname === '/api/captures' && request.method === 'POST') {
    const body = (await request.json()) as {
      notes?: unknown;
      data?: unknown;
      detected?: unknown;
      durationMs?: unknown;
      sampleCount?: unknown;
    };
    // `data` is the raw sensor JSON, already stringified by the client.
    if (typeof body.data !== 'string' || body.data.length === 0) {
      return json({ error: 'missing data' }, 400);
    }
    // A per-throw trace is only tens–hundreds of KB; cap well above that but
    // low enough to block abuse of this unauthenticated endpoint.
    const MAX_DATA_BYTES = 8 * 1024 * 1024;
    if (body.data.length > MAX_DATA_BYTES) {
      return json({ error: 'payload too large' }, 413);
    }
    const notes = String(body.notes ?? '').slice(0, 2000);
    const toIntOrNull = (v: unknown): number | null => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? n : null;
    };
    const detected = body.detected ? 1 : 0;
    const durationMs = toIntOrNull(body.durationMs);
    const sampleCount = toIntOrNull(body.sampleCount);
    const createdAt = new Date().toISOString();
    const inserted = await env.DB.prepare(
      `INSERT INTO capture_sessions (notes, data, detected, duration_ms, sample_count, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id`
    )
      .bind(notes, body.data, detected, durationMs, sampleCount, createdAt)
      .first<{ id: number | string }>();
    return json({ id: inserted?.id ?? null });
  }

  // GET /api/captures — list session metadata (newest first). With ?id=<n>,
  // return that single row including the full raw `data` blob for replay.
  if (pathname === '/api/captures' && request.method === 'GET') {
    const idParam = url.searchParams.get('id');
    if (idParam !== null) {
      const id = Math.round(Number(idParam));
      if (!Number.isFinite(id)) return json({ error: 'bad id' }, 400);
      const row = await env.DB.prepare(
        `SELECT id, notes, data, detected, duration_ms, sample_count, created_at
         FROM capture_sessions WHERE id = ?1`
      )
        .bind(id)
        .first();
      return json(row ?? null);
    }
    const rows = await env.DB.prepare(
      `SELECT id, notes, detected, duration_ms, sample_count, created_at
       FROM capture_sessions ORDER BY created_at DESC LIMIT 200`
    ).all();
    return json(rows.results ?? []);
  }

  // POST /api/videos?throwId= — store the journey video in R2.
  if (pathname === '/api/videos' && request.method === 'POST') {
    const throwId = url.searchParams.get('throwId');
    const contentType = request.headers.get('content-type') ?? '';
    const contentLength = Number(request.headers.get('content-length') ?? '0');
    const MAX_BYTES = 30 * 1024 * 1024; // journeys are a few seconds of low-res video
    // throwId becomes the R2 key, so constrain it to UUID-ish characters.
    if (!throwId || !/^[a-zA-Z0-9-]{1,64}$/.test(throwId) || !request.body) {
      return json({ error: 'bad request' }, 400);
    }
    if (!contentType.startsWith('video/')) {
      return json({ error: 'unsupported media type' }, 415);
    }
    // Best-effort size cap via declared length (Cloudflare also enforces a
    // platform body limit); blocks casual oversized uploads.
    if (contentLength > MAX_BYTES) {
      return json({ error: 'payload too large' }, 413);
    }
    await env.VIDEOS.put(`${throwId}.mp4`, request.body, {
      httpMetadata: { contentType },
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
