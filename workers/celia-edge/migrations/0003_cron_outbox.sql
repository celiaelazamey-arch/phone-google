-- D1 schema for the governed cron-job.org outbox (OPS-007, DEC-042).
-- Applied by scripts/deploy-cloudflare-edge.mjs like 0001/0002; every statement is idempotent.
--
-- One row per external-write intent. Lifecycle:
--   pending_approval -> dispatching -> applied | failed | unknown
--   pending_approval -> rejected
--   unknown          -> applied | not_applied   (owner reconciliation only, never automatic)
-- `payload_hash` is what the owner approves; `idempotency_key` makes a retried submission a replay, not a
-- second intent. Status transitions are append-logged in edge_audit under key `cron.outbox.<id>`.

CREATE TABLE IF NOT EXISTS edge_cron_outbox (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL,
  job_id INTEGER,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  external_ref TEXT,
  error_code TEXT,
  approval_key TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  dispatched_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS edge_cron_outbox_status_idx ON edge_cron_outbox (status, created_at);
