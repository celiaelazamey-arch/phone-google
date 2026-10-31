-- MAN-007 / DEC-075 — append-only ledger of deployment slices.
--
-- Why: "roll back to the last healthy slice" assumes the healthy slice was recorded. It was
-- not: nothing in scripts/, workers/ or src/ stored a last-known-good version, so the planned
-- rollback step (MAN-004) depended on a record that did not exist. This is that record.
--
-- Rules that make it trustworthy:
--   * Append-only, like edge_audit. No UPDATE of a slice's identity, no DELETE, ever.
--   * `known_good` is EARNED: it is set only after live acceptance passed for that exact
--     commit. A successful upload alone never marks a slice healthy (DEC-073 lesson: a green
--     deploy is not proof the product works).
--   * `schema_version` is stored because D1 migrations do NOT roll back. A slice restores
--     CODE only; promoting an older slice over a newer schema is safe only while migrations
--     stay additive (docs/compatibility-contract.md).
--
-- Idempotent: re-running a deploy for the same commit + version updates nothing; the
-- UNIQUE(commit_sha, manifest_digest) pair makes a retry a replay, not a second slice.

CREATE TABLE IF NOT EXISTS edge_deployment_slices (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  commit_sha TEXT NOT NULL,
  app_version TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  bundle_digest TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  worker_version_id TEXT,
  deployed_at TEXT NOT NULL,
  acceptance TEXT NOT NULL DEFAULT 'pending',
  known_good INTEGER NOT NULL DEFAULT 0,
  accepted_at TEXT,
  note TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS edge_deployment_slices_commit_manifest
  ON edge_deployment_slices (commit_sha, manifest_digest);

CREATE INDEX IF NOT EXISTS edge_deployment_slices_known_good
  ON edge_deployment_slices (known_good, seq);
