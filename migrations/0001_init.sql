-- high phone leaderboard schema (D1 / SQLite).
-- Mirrors the old Supabase `scores` table (id/duration_ms were bigint -> INTEGER,
-- has_case boolean -> 0/1). The `leaderboard` and `daily_leaderboard` Postgres
-- views are reproduced as queries in worker/index.ts rather than as DB views.
--
-- created_at is ISO-8601 millis with Z so lexical order == chronological order
-- (see worker/index.ts). Original bigint ids are preserved on import;
-- AUTOINCREMENT continues past the largest imported id for new throws.

CREATE TABLE IF NOT EXISTS scores (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  local_id     TEXT,
  player_id    TEXT NOT NULL,
  player_name  TEXT NOT NULL,
  duration_ms  INTEGER NOT NULL,
  has_case     INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_scores_player ON scores (player_id);
CREATE INDEX IF NOT EXISTS idx_scores_leaderboard ON scores (has_case, duration_ms DESC);
CREATE INDEX IF NOT EXISTS idx_scores_created_at ON scores (created_at);
