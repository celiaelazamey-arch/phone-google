-- D1 relational schema for the card-free Celia runtime on Cloudflare Workers + D1 (DEC-037).
-- Mirrors sql/schema.sql (schema 1) in SQLite/D1 dialect plus an idempotency ledger.

CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  phone_e164 TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry ON oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS google_credentials (
  user_id TEXT PRIMARY KEY,
  encrypted_tokens TEXT NOT NULL,
  scopes TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS whatsapp_contacts (
  phone_e164 TEXT PRIMARY KEY,
  opted_in INTEGER NOT NULL DEFAULT 0,
  ai_opted_in INTEGER NOT NULL DEFAULT 0,
  consent_source TEXT,
  consented_at TEXT,
  last_inbound_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_message_id TEXT NOT NULL UNIQUE,
  phone_e164 TEXT NOT NULL,
  direction TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  body TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_phone_created ON whatsapp_messages (phone_e164, created_at);

CREATE TABLE IF NOT EXISTS edge_idempotency (
  scope_key TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
