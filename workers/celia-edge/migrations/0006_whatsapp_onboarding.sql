-- WA-005 / DEC-064: additive, secret-free WhatsApp onboarding state.
-- Raw browser tokens, Meta codes, access tokens and registration PINs never live here.
CREATE TABLE IF NOT EXISTS whatsapp_link_tickets (
  ticket_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_link_tickets_expiry ON whatsapp_link_tickets(expires_at);
CREATE TABLE IF NOT EXISTS whatsapp_browser_sessions (
  session_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_browser_sessions_expiry ON whatsapp_browser_sessions(expires_at);
CREATE TABLE IF NOT EXISTS whatsapp_oauth_states (
  state_hash TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  credentials_ciphertext TEXT,
  pin_ciphertext TEXT,
  verify_token_hash TEXT,
  phone_number_id TEXT,
  waba_id TEXT,
  stage TEXT NOT NULL DEFAULT 'created',
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_oauth_states_session ON whatsapp_oauth_states(session_hash, expires_at);
CREATE TABLE IF NOT EXISTS whatsapp_connections (
  user_id TEXT PRIMARY KEY,
  phone_number_id TEXT NOT NULL UNIQUE,
  waba_id TEXT NOT NULL,
  display_phone_number TEXT,
  verified_name TEXT,
  credentials_ciphertext TEXT NOT NULL,
  verify_token_hash TEXT NOT NULL,
  api_version TEXT NOT NULL,
  status TEXT NOT NULL,
  webhook_callback_uri TEXT NOT NULL,
  last_error_code TEXT,
  connected_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  last_inbound_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_phone ON whatsapp_connections(phone_number_id);
