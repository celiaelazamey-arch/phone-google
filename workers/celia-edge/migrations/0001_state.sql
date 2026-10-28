-- D1 schema for the durable edge state (DEC-035).
-- Applied by scripts/deploy-cloudflare-edge.mjs through the Cloudflare D1 query API; every statement is
-- idempotent so the deploy can run on every push to main without wiping data.

CREATE TABLE IF NOT EXISTS edge_heartbeat (
  key TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edge_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);

-- Append-only: no UPDATE or DELETE is ever issued against this table by the worker.
-- `value_hash` is a SHA-256 of the stored value, so the chain proves content without storing it twice.
CREATE TABLE IF NOT EXISTS edge_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  key TEXT NOT NULL,
  action TEXT NOT NULL,
  value_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS edge_audit_key_idx ON edge_audit (key);
