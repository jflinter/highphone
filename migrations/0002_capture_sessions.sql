-- Capture-session storage (D1 / SQLite).
--
-- Backs the /capture data-collection tool (pages/capture.tsx, /api/captures in
-- worker/index.ts). Each row is ONE recorded gesture: the raw devicemotion +
-- deviceorientation streams (as JSON in `data`), a free-text `notes`
-- annotation, and a few client-computed metadata columns so real-world traces
-- can be filtered without parsing every blob. These become fixtures for the
-- otherwise-untestable throw detector (see AGENTS.md).
--
-- created_at is ISO-8601 millis with Z so lexical order == chronological order,
-- matching the `scores` table convention in 0001_init.sql.

CREATE TABLE IF NOT EXISTS capture_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  notes         TEXT,
  data          TEXT NOT NULL,   -- JSON: { version, startedAt, endedAt, motion[], orientation[] }
  detected      INTEGER,         -- 0/1: did the real detector fire (client-computed)
  duration_ms   INTEGER,         -- detector's airborne ms, if detected
  sample_count  INTEGER,         -- # motion samples (sanity / size signal)
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_captures_created_at ON capture_sessions (created_at);
