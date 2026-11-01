-- M-C (DEC-099) — delegation between agents, additive only.
-- A delegated child is an ordinary run; this table is the link that makes it a child:
-- who asked, with what ceiling, and under which plan digest. No existing table is altered.
-- The runtime writes one row per accepted child inside the same request that creates the run;
-- `(parent_run_id, task_id)` is unique so a retried delegation returns the first child instead
-- of creating a second one with the same name and a fresh budget.

CREATE TABLE IF NOT EXISTS agent_delegations (
  id CHAR(36) NOT NULL PRIMARY KEY,
  parent_run_id CHAR(36) NOT NULL,
  child_run_id CHAR(36) NOT NULL,
  task_id VARCHAR(64) NOT NULL,
  agent VARCHAR(64) NOT NULL,
  objective VARCHAR(500) NOT NULL,
  steps INT NOT NULL,
  cost_micros BIGINT NOT NULL,
  risk VARCHAR(32) NOT NULL,
  depth INT NOT NULL,
  plan_digest CHAR(12) NOT NULL,
  parent_digest CHAR(12) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_agent_delegations_task (parent_run_id, task_id),
  KEY idx_agent_delegations_parent (parent_run_id, created_at),
  KEY idx_agent_delegations_child (child_run_id),
  CONSTRAINT fk_agent_delegations_parent FOREIGN KEY (parent_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_agent_delegations_child FOREIGN KEY (child_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
