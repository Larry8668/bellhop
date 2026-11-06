-- migrate:up
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  service TEXT NOT NULL,
  area TEXT NOT NULL,
  price INTEGER NOT NULL,
  rating REAL NOT NULL,
  description TEXT NOT NULL,
  years_active INTEGER NOT NULL,
  attributes_json TEXT NOT NULL
);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  author TEXT NOT NULL,
  rating INTEGER NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE slots (
  provider_id TEXT NOT NULL REFERENCES providers(id),
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'held', 'booked')),
  PRIMARY KEY (provider_id, start)
);

CREATE TABLE holds (
  hold_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  user_id TEXT NOT NULL,
  slot_start TEXT NOT NULL,
  slot_end TEXT NOT NULL,
  price INTEGER NOT NULL,
  search_price INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'consumed', 'void'))
);

CREATE TABLE bookings (
  booking_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  slot_start TEXT NOT NULL,
  slot_end TEXT NOT NULL,
  price INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled', 'rescheduled')),
  hold_id TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE idempotency (
  tool TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  PRIMARY KEY (tool, key)
);

CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);

-- migrate:down
DROP TABLE events;
DROP TABLE counters;
DROP TABLE idempotency;
DROP TABLE bookings;
DROP TABLE holds;
DROP TABLE slots;
DROP TABLE reviews;
DROP TABLE providers;
DROP TABLE meta;
