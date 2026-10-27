-- Agent governance tables (AGENT-001/AGENT-002). Additive only: no existing
-- table is altered. Applied by `npm run migrate -- --apply` through the
-- schema_migrations ledger; statements stay idempotent (IF NOT EXISTS).
--
-- 1. agent_approvals     closes the approval gate: a parked waiting_approval run
--                         now has a durable decision path and can be resumed.
-- 2. agent_goal_contracts one inspectable data contract per run (objective,
--                         success criteria, constraints, stop conditions, budget).
-- 3. agent_evidence       append-only hash-chained ledger (prev_hash/entry hash).

CREATE TABLE IF NOT EXISTS agent_approvals (
  id CHAR(36) NOT NULL PRIMARY KEY,
  run_id CHAR(36) NOT NULL,
  step_id CHAR(36) NULL,
  tool_name VARCHAR(64) NOT NULL,
  risk VARCHAR(24) NOT NULL,
  idempotency_key VARCHAR(160) NOT NULL,
  decision VARCHAR(16) NOT NULL DEFAULT 'pending',
  decision_key VARCHAR(160) NULL,
  actor VARCHAR(64) NULL,
  note VARCHAR(500) NULL,
  requested_at VARCHAR(32) NOT NULL,
  decided_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_agent_approvals_key (idempotency_key),
  KEY idx_agent_approvals_decision_key (decision_key),
  KEY idx_agent_approvals_run (run_id, requested_at),
  CONSTRAINT fk_agent_approvals_run FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_goal_contracts (
  run_id CHAR(36) NOT NULL PRIMARY KEY,
  contract TEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_agent_goal_contracts_run FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_evidence (
  id CHAR(36) NOT NULL PRIMARY KEY,
  run_id CHAR(36) NOT NULL,
  step_id CHAR(36) NULL,
  seq INT NOT NULL,
  kind VARCHAR(32) NOT NULL,
  input_hash CHAR(64) NOT NULL,
  output_hash CHAR(64) NULL,
  source_ids TEXT NULL,
  verdict VARCHAR(16) NULL,
  version VARCHAR(24) NOT NULL,
  prev_hash CHAR(64) NOT NULL,
  hash CHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_agent_evidence_seq (run_id, seq),
  KEY idx_agent_evidence_run (run_id, seq),
  CONSTRAINT fk_agent_evidence_run FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
