-- WA-008: additive Google identity map for ordinary self-service accounts.
-- Google's stable `sub` is the login key. No OAuth access/refresh token, password,
-- or Workspace scope is stored here; `app_accounts` is deliberately left untouched.
CREATE TABLE IF NOT EXISTS account_google_identities (
  google_sub TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL
);
