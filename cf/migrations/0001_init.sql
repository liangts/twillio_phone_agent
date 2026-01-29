PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  from_uri TEXT,
  to_uri TEXT,
  provider TEXT,
  conference_name TEXT,
  call_token TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS calls_status_started
  ON calls(status, started_at DESC);

CREATE INDEX IF NOT EXISTS calls_updated
  ON calls(updated_at DESC);

CREATE TABLE IF NOT EXISTS transcript_segments (
  call_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  speaker TEXT NOT NULL,
  text TEXT NOT NULL,
  raw_json TEXT,
  PRIMARY KEY (call_id, seq)
);

CREATE INDEX IF NOT EXISTS seg_call_seq
  ON transcript_segments(call_id, seq);

CREATE INDEX IF NOT EXISTS seg_call_ts
  ON transcript_segments(call_id, ts);
