-- Agent outbox (AGENT-002). Additive only: no existing table is altered.
-- Applied by `npm run migrate -- --apply` through the schema_migrations ledger.
--
-- Every external effect leaves the process through exactly this table:
--   1. the approval gate enqueues one `pending` intent (owner sees the payload
--      before deciding);
--   2. rejection settles it `cancelled` — nothing was ever sent;
--   3. approval lets a single dispatcher claim it (`dispatching` with a lease)
--      and settle it `sent`, `failed` (definitive, nothing reached the provider)
--      or `unknown` (the request may have arrived — never retried blindly).
--
-- `idempotency_key` is unique: a re-entered loop or a crashed process can never
-- produce a second row for the same intent.

CREATE TABLE IF NOT EXISTS agent_outbox (
  id CHAR(36) NOT NULL PRIMARY KEY,
  run_id CHAR(36) NOT NULL,
  step_id CHAR(36) NULL,
  approval_id CHAR(36) NULL,
  tool_name VARCHAR(64) NOT NULL,
  connector VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(120) NOT NULL,
  payload TEXT NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  lease_until VARCHAR(32) NULL,
  lease_owner VARCHAR(64) NULL,
  external_ref VARCHAR(200) NULL,
  result TEXT NULL,
  last_error VARCHAR(120) NULL,
  enqueued_at VARCHAR(32) NOT NULL,
  dispatched_at VARCHAR(32) NULL,
  settled_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_agent_outbox_key (idempotency_key),
  KEY idx_agent_outbox_run (run_id, enqueued_at),
  KEY idx_agent_outbox_status (status, lease_until),
  CONSTRAINT fk_agent_outbox_run FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
