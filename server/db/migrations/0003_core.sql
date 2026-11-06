-- migrate:up
-- Core workflow tables (plan §5): chat history, the one-current-errand state
-- machine, proposals/approvals/intents (approval enforcement + idempotency),
-- the app-side bookings view, and provider-cancellation events. `memories`
-- and `context_log` are Phase 4 — not added here.

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_conversations_user_id ON conversations (user_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id),
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  text TEXT NOT NULL,
  proposal_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_conversation_id ON messages (conversation_id);
CREATE INDEX idx_messages_user_id ON messages (user_id);

-- One current errand per user (plan §6): PRIMARY KEY on user_id is itself
-- the lookup index, so no separate index is needed here.
CREATE TABLE task_state (
  user_id TEXT PRIMARY KEY,
  conversation_id TEXT,
  state TEXT NOT NULL CHECK (
    state IN (
      'GATHERING', 'SEARCHING', 'COMPARING', 'PROPOSED', 'APPROVED',
      'EXECUTING', 'VERIFYING', 'DONE', 'FAILED', 'LIMIT_EXCEEDED'
    )
  ),
  service TEXT,
  area TEXT,
  window_from TEXT,
  window_to TEXT,
  budget INTEGER,
  prefs_json TEXT NOT NULL DEFAULT '{}',
  run_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('book', 'cancel', 'reschedule')),
  provider_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  service TEXT NOT NULL,
  slot_start TEXT NOT NULL,
  slot_end TEXT NOT NULL,
  price INTEGER NOT NULL,
  currency TEXT NOT NULL,
  booking_id TEXT,
  hold_id TEXT,
  hold_expires_at TEXT,
  hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'superseded', 'declined', 'expired', 'approved')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_proposals_user_id ON proposals (user_id);
CREATE INDEX idx_proposals_status ON proposals (status);
-- supersedePending/listPending both filter user_id + status together.
CREATE INDEX idx_proposals_user_status ON proposals (user_id, status);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals (id),
  user_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('valid', 'consumed', 'void')),
  source TEXT NOT NULL CHECK (source IN ('button', 'typed', 'mcp_elicitation')),
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  void_reason TEXT
);
CREATE INDEX idx_approvals_user_id ON approvals (user_id);
CREATE INDEX idx_approvals_status ON approvals (status);
CREATE INDEX idx_approvals_proposal_id ON approvals (proposal_id);

CREATE TABLE intents (
  idempotency_key TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL REFERENCES approvals (id),
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'unknown')),
  result_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_intents_user_id ON intents (user_id);
-- Startup recovery (`listUnresolved`) scans pending/unknown across all users.
CREATE INDEX idx_intents_status ON intents (status);

-- App-side view synced from the provider, not the source of truth for the
-- provider's own booking state.
CREATE TABLE bookings (
  booking_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  service TEXT NOT NULL,
  slot_start TEXT NOT NULL,
  slot_end TEXT NOT NULL,
  price INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled', 'rescheduled')),
  synced_at TEXT NOT NULL
);
CREATE INDEX idx_bookings_user_id ON bookings (user_id);
CREATE INDEX idx_bookings_status ON bookings (status);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  booking_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  processed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_user_id ON events (user_id);
CREATE INDEX idx_events_processed ON events (processed);

-- migrate:down
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS bookings;
DROP TABLE IF EXISTS intents;
DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS proposals;
DROP TABLE IF EXISTS task_state;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS conversations;
