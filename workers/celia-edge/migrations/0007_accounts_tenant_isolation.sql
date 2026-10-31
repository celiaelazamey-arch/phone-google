-- WA-007 / DEC-065: self-service accounts and tenant-scoped WhatsApp data.
-- Additive only. Legacy owner tables remain untouched for the existing owner runtime.
CREATE TABLE IF NOT EXISTS app_accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_sessions (
  session_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_sessions_expiry ON account_sessions(expires_at);
CREATE TABLE IF NOT EXISTS account_auth_attempts (
  attempt_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS whatsapp_user_contacts (
  user_id TEXT NOT NULL,
  phone_e164 TEXT NOT NULL,
  opted_in INTEGER NOT NULL DEFAULT 0,
  ai_opted_in INTEGER NOT NULL DEFAULT 0,
  consent_source TEXT,
  consented_at TEXT,
  last_inbound_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, phone_e164)
);
CREATE TABLE IF NOT EXISTS whatsapp_user_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  phone_e164 TEXT NOT NULL,
  direction TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  body TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  created_at TEXT NOT NULL,
  UNIQUE (user_id, provider_message_id)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_user_messages_inbox ON whatsapp_user_messages(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_user_contacts_window ON whatsapp_user_contacts(user_id, last_inbound_at);
