// Data layer. Talks to the Cloudflare Worker API (see worker/index.ts), which
// is served from the same origin as the static site. Replaces the old
// Supabase client — same exported names/types so callers are unchanged.

export type LeaderboardEntry = {
  id: string;
  name: string;
  durationMs: number;
  date: Date;
  playerId: string;
};

export type ScoreRequest = {
  throwId: string;
  playerId: string;
  playerName: string;
  durationMs: number;
  hasCase: boolean;
};

export type VideoRequest = {
  throwId: string;
  video: File;
};

type LeaderboardRow = {
  id: string;
  player_name: string;
  max_duration: number;
  created_at: string;
  has_case: boolean;
  player_id: string;
};

const rowToEntry = (row: LeaderboardRow): LeaderboardEntry => ({
  id: String(row.id),
  name: row.player_name,
  durationMs: row.max_duration,
  date: new Date(row.created_at),
  playerId: row.player_id,
});

export const uploadVideo = async ({
  throwId,
  video,
}: VideoRequest): Promise<void> => {
  try {
    await fetch(`/api/videos?throwId=${encodeURIComponent(throwId)}`, {
      method: 'POST',
      headers: { 'content-type': video.type || 'video/mp4' },
      body: video,
    });
  } catch (e) {
    console.error(e);
  }
};

export const createScore = async ({
  throwId,
  playerId,
  playerName,
  durationMs,
  hasCase,
}: ScoreRequest): Promise<number | null> => {
  try {
    const res = await fetch('/api/scores', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        localId: throwId,
        playerId,
        playerName,
        durationMs: Number(durationMs.toFixed(0)),
        hasCase,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { dailyIndex: number | null };
    return data.dailyIndex;
  } catch (e) {
    console.error(e);
    return null;
  }
};

export const fetchScores = async (
  hasCase: boolean,
  todayOnly: boolean
): Promise<LeaderboardEntry[]> => {
  try {
    const res = await fetch(
      `/api/leaderboard?hasCase=${hasCase}&daily=${todayOnly}`
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as LeaderboardRow[];
    return rows.map(rowToEntry);
  } catch (e) {
    console.error(e);
    return [];
  }
};

export const fetchHighScore = async (
  playerId: string
): Promise<LeaderboardEntry | null> => {
  try {
    const res = await fetch(
      `/api/high-score?playerId=${encodeURIComponent(playerId)}`
    );
    if (!res.ok) return null;
    const row = (await res.json()) as LeaderboardRow | null;
    return row ? rowToEntry(row) : null;
  } catch (e) {
    console.error(e);
    return null;
  }
};
