-- migrate:up
-- Memory facts and per-call context budget (plan §5, §11). Rows are the
-- source of truth; profile.md is rendered from them. Forgotten and
-- unconfirmed facts are never selected into a prompt.

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('explicit', 'inferred')),
  status TEXT NOT NULL CHECK (status IN ('active', 'unconfirmed', 'forgotten')),
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_memories_user_id ON memories (user_id);
CREATE INDEX idx_memories_user_status ON memories (user_id, status);

CREATE TABLE context_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  est_tokens INTEGER NOT NULL,
  actual_tokens_in INTEGER,
  actual_tokens_out INTEGER,
  fact_ids_json TEXT NOT NULL,
  sections_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_context_log_user_run ON context_log (user_id, run_id);

-- migrate:down
DROP TABLE IF EXISTS context_log;
DROP TABLE IF EXISTS memories;
