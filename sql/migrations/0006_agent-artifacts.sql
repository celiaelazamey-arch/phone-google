-- M-B/B2 — owner-facing artifact registry for published sandbox outputs.
-- Additive only: no existing table is altered or removed. Applied explicitly by
-- `npm run migrate -- --apply`; every statement is safe to retry after MySQL DDL
-- has committed implicitly. Payload bytes live on disk under the artifact store
-- root; this table holds identity, SHA-256 and location so tampering after
-- delivery is detectable by digest, never trusted from memory.

CREATE TABLE IF NOT EXISTS agent_artifacts (
  id CHAR(36) NOT NULL PRIMARY KEY,
  run_id CHAR(36) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  sandbox_run_id VARCHAR(64) NOT NULL,
  source_artifact_id VARCHAR(64) NOT NULL,
  name VARCHAR(160) NOT NULL,
  bytes BIGINT NOT NULL,
  sha256 CHAR(64) NOT NULL,
  storage_path VARCHAR(512) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_agent_artifacts_source (run_id, source_artifact_id),
  KEY idx_agent_artifacts_run (run_id, created_at),
  CONSTRAINT fk_agent_artifacts_run FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
