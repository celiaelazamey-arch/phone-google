-- HIGH-05: Atomic Edge D1 idempotency state (pending/completed + dispatched_at CAS).
-- Additive DDL only: legacy rows in edge_idempotency hold completed responses and receive
-- status = 'completed' plus dispatched_at backfilled in epoch ms from ISO-8601 created_at.

ALTER TABLE edge_idempotency ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';

ALTER TABLE edge_idempotency ADD COLUMN dispatched_at INTEGER;

UPDATE edge_idempotency
SET dispatched_at = CAST(unixepoch(created_at) * 1000 AS INTEGER)
WHERE dispatched_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_edge_idempotency_pending
  ON edge_idempotency (status, dispatched_at)
  WHERE status = 'pending';
