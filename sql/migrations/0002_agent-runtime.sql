-- Agent runtime tables (AGENT-001). Additive only: no core table is altered.
-- Applied by `npm run migrate -- --apply` through the schema_migrations ledger.
-- The five core tables in sql/schema.sql keep `database.schema = 1`.

CREATE TABLE IF NOT EXISTS agent_threads (
  id CHAR(36) NOT NULL PRIMARY KEY,
  owner_id VARCHAR(64) NOT NULL,
  title VARCHAR(200) NOT NULL,
  status VARCHAR(24) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  KEY idx_agent_threads_owner (owner_id, updated_at),
  CONSTRAINT fk_agent_threads_owner FOREIGN KEY (owner_id) REFERENCES app_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_messages (
  id CHAR(36) NOT NULL PRIMARY KEY,
  thread_id CHAR(36) NOT NULL,
  role VARCHAR(16) NOT NULL,
  content TEXT NOT NULL,
  client_message_id VARCHAR(64) NULL,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_agent_messages_client (thread_id, client_message_id),
  KEY idx_agent_messages_thread (thread_id, created_at),
  CONSTRAINT fk_agent_messages_thread FOREIGN KEY (thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_runs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  thread_id CHAR(36) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  user_message_id CHAR(36) NULL,
  client_message_id VARCHAR(64) NULL,
  status VARCHAR(24) NOT NULL,
  planner VARCHAR(64) NOT NULL,
  plan_summary VARCHAR(1000) NULL,
  max_steps INT NOT NULL,
  max_cost_micros INT NOT NULL,
  steps_used INT NOT NULL DEFAULT 0,
  cost_micros INT NOT NULL DEFAULT 0,
  tokens_used INT NOT NULL DEFAULT 0,
  cancel_requested TINYINT NOT NULL DEFAULT 0,
  lease_until VARCHAR(32) NULL,
  lease_owner VARCHAR(64) NULL,
  last_error VARCHAR(240) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  finished_at VARCHAR(32) NULL,
  UNIQUE KEY uq_agent_runs_client (thread_id, client_message_id),
  KEY idx_agent_runs_owner (owner_id, created_at),
  KEY idx_agent_runs_status (status, lease_until),
  CONSTRAINT fk_agent_runs_thread FOREIGN KEY (thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_steps (
  id CHAR(36) NOT NULL PRIMARY KEY,
  run_id CHAR(36) NOT NULL,
  step_index INT NOT NULL,
  kind VARCHAR(16) NOT NULL,
  title VARCHAR(200) NOT NULL,
  summary VARCHAR(1000) NULL,
  tool_name VARCHAR(64) NULL,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_agent_steps_index (run_id, step_index),
  CONSTRAINT fk_agent_steps_run FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_tool_runs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  run_id CHAR(36) NOT NULL,
  step_id CHAR(36) NULL,
  tool_name VARCHAR(64) NOT NULL,
  risk VARCHAR(24) NOT NULL,
  idempotency_key VARCHAR(120) NOT NULL,
  arguments_digest CHAR(64) NULL,
  status VARCHAR(16) NOT NULL,
  outcome VARCHAR(4000) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_agent_tool_runs_key (idempotency_key),
  KEY idx_agent_tool_runs_run (run_id),
  CONSTRAINT fk_agent_tool_runs_run FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
