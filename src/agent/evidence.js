import crypto from 'node:crypto';

/**
 * Append-only evidence ledger primitives (roadmap unit 6).
 *
 * Every auditable fact of a run (goal contract, tool call, approval decision,
 * verification verdict, delivery) becomes one ledger entry. Entries are linked by
 * a SHA-256 hash chain: each `hash` covers the previous hash plus the entry's own
 * content, so deleting or rewriting an old entry breaks every link after it.
 *
 * This module is pure (no database, no clock injection beyond explicit arguments):
 * the durable store owns persistence, and the independent verifier can recompute
 * the same chain from the persisted rows without trusting the producer.
 */

export const EVIDENCE_KIND = Object.freeze({
  goalContract: 'goal_contract',
  planReady: 'plan_ready',
  planEdited: 'plan_edited',
  toolCall: 'tool_call',
  // Reconstructed after a crash that durably recorded the tool run but interrupted
  // the ledger write. It attests to the stored row; it never claims to have watched the call.
  toolCallReconciled: 'tool_call_reconciled',
  approval: 'approval',
  // An external effect is evidenced twice: the durable intent (before any request)
  // and the settlement (what the provider answered, or that it is unknown).
  externalEffectEnqueued: 'external_effect_enqueued',
  externalEffectSettled: 'external_effect_settled',
  // A human decision that closed an `unknown`/`started` outcome. It attests to the
  // owner's stated finding, never to an observation this process could not make.
  reconciliation: 'reconciliation',
  verification: 'verification',
  // Provider-planned runs separate model decisions from runtime execution.
  planCreated: 'plan_created',
  toolSelected: 'tool_selected',
  toolExecuted: 'tool_executed',
  verificationResult: 'verification_result',
  delivery: 'delivery',
  memoryDeleted: 'memory_deleted',
  // AGENT-003: local per-run isolation and artifact lifecycle. These events
  // describe the executor's observations; they are not a live-tool capability.
  sandboxCreated: 'sandbox_created',
  sandboxFinished: 'sandbox_finished',
  sandboxNetworkAttempt: 'sandbox_network_attempt',
  sandboxArtifact: 'sandbox_artifact',
  // M-C/C1: one row per egress decision, allowed or blocked, with bytes and status.
  // It attests to what the proxy enforced; it never carries headers or query strings.
  egressRequest: 'egress_request',
  // M-B/B2: publication of a sandbox artifact into the owner-facing store.
  // The SHA-256 recorded here is what later download verification attests against.
  artifactPublished: 'artifact_published'
});

export const EVIDENCE_VERSION = 'evidence-v1';

const HASH_RE = /^[a-f0-9]{64}$/;

/** Deterministic JSON: object keys sorted recursively; array order is preserved. */
export function canonicalize(value) {
  return JSON.stringify(stableClone(value));
}

function stableClone(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(stableClone);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableClone(value[key]);
    return out;
  }
  return value;
}

export function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** Content hash of any JSON-representable value (null included). */
export function hashOf(value) {
  return sha256Text(canonicalize(value));
}

/** Per-run genesis anchor: the first entry's `prev_hash`, reproducible from the run id. */
export function genesisHash(runId) {
  return sha256Text(`genesis:${runId}`);
}

/**
 * Fingerprint of one chain entry. The material is a delimiter-joined fixed-order
 * string of primitive fields, so any implementation can recompute it without this
 * module's object shapes.
 */
export function entryHash({
  prevHash,
  runId,
  seq,
  kind,
  inputHash,
  outputHash = '',
  sourceIds = [],
  verdict = '',
  version,
  at
}) {
  const material = [
    prevHash,
    runId,
    String(seq),
    kind,
    inputHash,
    outputHash || '',
    (sourceIds || []).map(String).join(','),
    verdict || '',
    version,
    at
  ].join('|');
  return sha256Text(material);
}

/** Accept both raw database rows (snake_case) and store-mapped entries (camelCase). */
function normalizeRecord(row) {
  return {
    runId: row.run_id ?? row.runId,
    seq: Number(row.seq),
    kind: row.kind,
    inputHash: row.input_hash ?? row.inputHash,
    outputHash: row.output_hash ?? row.outputHash,
    sourceIds: safeParseIds(row.source_ids ?? row.sourceIds),
    verdict: row.verdict,
    version: row.version,
    prevHash: row.prev_hash ?? row.prevHash,
    hash: row.hash,
    createdAt: row.created_at ?? row.createdAt
  };
}

/**
 * Recompute and validate a run's chain from persisted rows.
 * Returns the first break found, or `{ ok: true, count, head }`.
 */
export function verifyChain(records, { runId } = {}) {
  if (!Array.isArray(records)) return { ok: false, count: 0, brokenSeq: null, reason: 'records_not_array' };
  const normalized = records.map(normalizeRecord);
  const expectedRun = runId || normalized[0]?.runId;
  let prevHash = genesisHash(expectedRun);
  let expectedSeq = 1;
  for (const row of normalized) {
    if (row.runId !== expectedRun) {
      return { ok: false, count: normalized.length, brokenSeq: row.seq, reason: 'run_id_mismatch' };
    }
    if (row.seq !== expectedSeq) {
      return { ok: false, count: normalized.length, brokenSeq: row.seq, reason: 'seq_gap_or_reorder' };
    }
    if (!HASH_RE.test(row.prevHash || '') || !HASH_RE.test(row.hash || '')) {
      return { ok: false, count: normalized.length, brokenSeq: row.seq, reason: 'malformed_hash' };
    }
    if (row.prevHash !== prevHash) {
      return { ok: false, count: normalized.length, brokenSeq: row.seq, reason: 'prev_hash_mismatch' };
    }
    const recomputed = entryHash({
      prevHash: row.prevHash,
      runId: row.runId,
      seq: row.seq,
      kind: row.kind,
      inputHash: row.inputHash,
      outputHash: row.outputHash,
      sourceIds: row.sourceIds,
      verdict: row.verdict,
      version: row.version,
      at: row.createdAt
    });
    if (recomputed !== row.hash) {
      return { ok: false, count: normalized.length, brokenSeq: row.seq, reason: 'entry_hash_mismatch' };
    }
    prevHash = row.hash;
    expectedSeq += 1;
  }
  return { ok: true, count: normalized.length, head: prevHash };
}

function safeParseIds(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
