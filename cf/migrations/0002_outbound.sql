PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS prompt_templates (
  template_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  instruction_block TEXT NOT NULL,
  voice_override TEXT,
  model_override TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_launches (
  launch_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  template_id TEXT NOT NULL,
  target_e164 TEXT NOT NULL,
  objective_note TEXT,
  instruction_block TEXT NOT NULL,
  voice_override TEXT,
  model_override TEXT,
  twilio_call_sid TEXT,
  openai_call_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  answered_at INTEGER,
  ended_at INTEGER,
  last_event_json TEXT,
  FOREIGN KEY (template_id) REFERENCES prompt_templates(template_id)
);

ALTER TABLE calls ADD COLUMN launch_id TEXT;
ALTER TABLE calls ADD COLUMN template_id TEXT;
ALTER TABLE calls ADD COLUMN direction TEXT;

CREATE INDEX IF NOT EXISTS outbound_launches_status_created
  ON outbound_launches(status, created_at DESC);

CREATE INDEX IF NOT EXISTS outbound_launches_twilio_call_sid
  ON outbound_launches(twilio_call_sid);

CREATE INDEX IF NOT EXISTS calls_launch_id
  ON calls(launch_id);
