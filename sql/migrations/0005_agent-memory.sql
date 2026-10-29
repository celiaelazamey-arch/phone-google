-- WP-2.3 / AGENT-009 — deterministic long-term agent memory.
-- Additive only: no existing table is altered or removed. Applied explicitly by
-- `npm run migrate -- --apply`; every statement is safe to retry after MySQL DDL
-- has committed implicitly. No vectors, embeddings or model-generated content.

CREATE TABLE IF NOT EXISTS agent_thread_summaries (
  id CHAR(36) NOT NULL PRIMARY KEY,
  thread_id CHAR(36) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  source_run_id CHAR(36) NOT NULL,
  summary TEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  expires_at VARCHAR(32) NULL,
  UNIQUE KEY uq_agent_thread_summaries_thread (thread_id),
  KEY idx_agent_thread_summaries_owner (owner_id, updated_at),
  KEY idx_agent_thread_summaries_source (source_run_id),
  CONSTRAINT fk_agent_thread_summaries_thread FOREIGN KEY (thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE,
  CONSTRAINT fk_agent_thread_summaries_run FOREIGN KEY (source_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_owner_facts (
  id CHAR(36) NOT NULL PRIMARY KEY,
  owner_id VARCHAR(64) NOT NULL,
  source_run_id CHAR(36) NOT NULL,
  tag VARCHAR(96) NOT NULL,
  value TEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  expires_at VARCHAR(32) NULL,
  UNIQUE KEY uq_agent_owner_facts_tag (owner_id, tag),
  KEY idx_agent_owner_facts_source (source_run_id),
  KEY idx_agent_owner_facts_expiry (owner_id, expires_at),
  CONSTRAINT fk_agent_owner_facts_run FOREIGN KEY (source_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
