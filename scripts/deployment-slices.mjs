// MAN-007 / DEC-075 — record deployment slices and promote only what live acceptance proved.
//
// The temporal-manifest idea ("jump back to a healthy slice") only works if the healthy slice
// was written down. Before this module nothing in the repo recorded a last-known-good version,
// so rollback had nothing to point at. This is the append-only record, modelled on edge_audit.
//
// Two rules keep it honest:
//   1. A successful upload is NOT health. `known_good` is granted only by markSliceAccepted()
//      after the live acceptance run passed for that exact commit.
//   2. A slice restores CODE only. D1 migrations never roll back, so `schema_version` travels
//      with the slice and the caller can see what schema it was proven against.

/** Latest migration filename is the schema version a slice was deployed against. */
export function schemaVersionFrom(migrations = []) {
  const versions = migrations.map((entry) => String(entry.version ?? entry)).sort();
  return versions.at(-1) ?? 'none';
}

/**
 * Build the row for a deploy. Pure: no clock, no network, so tests can pin it.
 * `acceptance` starts pending and `known_good` starts 0 — never optimistic.
 */
export function buildSliceRecord({
  commit,
  version,
  manifestDigest,
  bundleDigest,
  schemaVersion,
  workerVersionId = null,
  deployedAt,
  note = null
}) {
  if (!/^[a-f0-9]{7,40}$/i.test(String(commit || ''))) throw new Error('slice_commit_invalid');
  if (!manifestDigest || !bundleDigest) throw new Error('slice_digest_required');
  if (!deployedAt) throw new Error('slice_timestamp_required');
  return {
    commit_sha: String(commit),
    app_version: String(version || ''),
    manifest_digest: String(manifestDigest),
    bundle_digest: String(bundleDigest),
    schema_version: String(schemaVersion || 'none'),
    worker_version_id: workerVersionId ? String(workerVersionId) : null,
    deployed_at: String(deployedAt),
    acceptance: 'pending',
    known_good: 0,
    accepted_at: null,
    note: note ? String(note).slice(0, 200) : null
  };
}

export const INSERT_SLICE_SQL =
  'INSERT INTO edge_deployment_slices (commit_sha, app_version, manifest_digest, bundle_digest, schema_version, worker_version_id, deployed_at, acceptance, known_good, accepted_at, note) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(commit_sha, manifest_digest) DO NOTHING';

export function insertSliceParams(record) {
  return [
    record.commit_sha, record.app_version, record.manifest_digest, record.bundle_digest,
    record.schema_version, record.worker_version_id, record.deployed_at,
    record.acceptance, record.known_good, record.accepted_at, record.note
  ];
}

/** Append a slice. A retry of the same commit+manifest is a replay, not a second row. */
export async function recordSlice(execD1, record) {
  await execD1(INSERT_SLICE_SQL, insertSliceParams(record));
  return record;
}

export const MARK_ACCEPTED_SQL =
  "UPDATE edge_deployment_slices SET acceptance = 'passed', known_good = 1, accepted_at = ? " +
  'WHERE commit_sha = ? AND manifest_digest = ?';

/**
 * Grant known_good. Requires an explicit passing result for this exact commit+manifest:
 * a pending/failed/skipped acceptance can never promote a slice.
 */
export async function markSliceAccepted(execD1, { commit, manifestDigest, acceptedAt, acceptancePassed }) {
  if (acceptancePassed !== true) throw new Error('slice_acceptance_not_passed');
  if (!commit || !manifestDigest || !acceptedAt) throw new Error('slice_acceptance_fields_required');
  await execD1(MARK_ACCEPTED_SQL, [String(acceptedAt), String(commit), String(manifestDigest)]);
}

export const SELECT_ROLLBACK_TARGET_SQL =
  'SELECT commit_sha, app_version, manifest_digest, bundle_digest, schema_version, worker_version_id, accepted_at ' +
  'FROM edge_deployment_slices WHERE known_good = 1 AND commit_sha != ? ORDER BY seq DESC LIMIT 1';

/**
 * The slice to promote on rollback: the newest PROVEN one that is not the current commit.
 * Returns null when nothing was ever proven — callers must fail closed, not guess.
 */
export async function findRollbackTarget(execD1, { currentCommit }) {
  const { rows } = await execD1(SELECT_ROLLBACK_TARGET_SQL, [String(currentCommit || '')]);
  return rows?.[0] ?? null;
}
