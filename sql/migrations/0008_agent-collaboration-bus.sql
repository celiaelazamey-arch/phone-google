-- XAG-001 (DEC-106) — the collaboration bus between agents. Additive only: no existing table is
-- altered. Messages carry bodies because the evidence ledger stores only hashes; every row is
-- attested by an evidence entry whose input_hash covers (messageId, to, kind, seq, payload_hash),
-- so a row without its attestation, or with an edited payload, is detectable rather than trusted.
--
-- `(trace_id, seq)` is unique: the sequence is the per-trace order, and the unique key is what
-- turns two writers racing for the same slot into a retry instead of a silent duplicate.
--
-- `agent_bus_cursors` is consumer position, not a second ledger. It only moves forward, and the
-- runtime writes it with a compare-and-set so a stale acknowledgement cannot rewind it.

CREATE TABLE IF NOT EXISTS agent_bus_messages (
  id CHAR(39) NOT NULL PRIMARY KEY,
  trace_id VARCHAR(64) NOT NULL,
  from_run_id CHAR(36) NOT NULL,
  to_ref VARCHAR(80) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  seq INT NOT NULL,
  payload MEDIUMTEXT NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  caused_by VARCHAR(39) NULL,
  evidence_id CHAR(36) NULL,
  status VARCHAR(16) NOT NULL,
  quarantine_reason VARCHAR(200) NULL,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_agent_bus_trace_seq (trace_id, seq),
  KEY idx_agent_bus_to (to_ref, seq),
  KEY idx_agent_bus_status (status, created_at),
  CONSTRAINT fk_agent_bus_from FOREIGN KEY (from_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_bus_cursors (
  consumer VARCHAR(80) NOT NULL,
  trace_id VARCHAR(64) NOT NULL,
  last_seq INT NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (consumer, trace_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
