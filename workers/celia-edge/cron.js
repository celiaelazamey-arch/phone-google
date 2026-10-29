/**
 * Governed cron-job.org surface for the edge worker (OPS-007, DEC-042).
 *
 * Reads go straight to cron-job.org with the owner's existing `CELIAOS_CRONJOB_ORG_API_KEY` and come back
 * sanitised (no auth blocks, no header values, no query strings, no stored response bodies). Writes never go
 * straight anywhere: create / update / delete become an **intent** row in D1 (`edge_cron_outbox`) that waits
 * for an explicit owner approval bound to the payload hash the owner saw, is dispatched at most once through a
 * conditional claim, and records the outcome honestly — `applied`, `failed` (upstream said no), or `unknown`
 * (timeout / 5xx: the effect may or may not exist, so a human reconciles; nothing is retried blindly).
 *
 * That is the same contract the Node runtime enforces (DEC-015 outbox, DEC-016 human-only exit from unknown,
 * DEC-019 post-approval tamper check), applied to the one external effect the edge already had the key for.
 * Every transition is appended to the `edge_audit` hash chain (DEC-035) as a hash — never the payload itself.
 */
import { appendAudit, isD1Bound, sha256Hex } from './state.js';

export const CRONJOB_ORIGIN = 'https://api.cron-job.org';
export const UPSTREAM_TIMEOUT_MS = 15_000;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const INTENT_ACTIONS = Object.freeze(['create', 'update', 'delete']);
export const INTENT_STATUS = Object.freeze({
  pending: 'pending_approval',
  dispatching: 'dispatching',
  applied: 'applied',
  failed: 'failed',
  unknown: 'unknown',
  rejected: 'rejected',
  notApplied: 'not_applied'
});
export const TERMINAL_STATUSES = Object.freeze([INTENT_STATUS.applied, INTENT_STATUS.failed, INTENT_STATUS.rejected, INTENT_STATUS.notApplied]);
export const MAX_INTENT_LIST = 100;

export const ALLOWED_JOB_FIELDS = new Set(['url', 'title', 'enabled', 'saveResponses', 'requestMethod', 'schedule']);

// ---------------------------------------------------------------------------------------------------------
// Payload validation (SSRF guard). Unchanged behaviour from the former direct proxy, now shared by intents.
// ---------------------------------------------------------------------------------------------------------

function isDisallowedIpv4(host) {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

export function isDisallowedTargetHost(rawHostname) {
  const raw = String(rawHostname || '').trim().toLowerCase();
  if (!raw) return true;
  const host = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal' ||
    host === 'metadata'
  ) {
    return true;
  }
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    return true;
  }
  if (isDisallowedIpv4(host)) return true;

  if (host.includes(':')) {
    const normalized = host.split('%')[0];
    if (normalized === '::' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1' || normalized === '0:0:0:0:0:0:0:0') {
      return true;
    }
    if (/^f[cd][0-9a-f]{2}:/i.test(normalized) || /^f[cd][0-9a-f]{0,2}$/i.test(normalized.split(':')[0])) {
      return true;
    }
    if (/^fe[89ab][0-9a-f]:/i.test(normalized)) {
      return true;
    }
    if (/^ff[0-9a-f]{2}:/i.test(normalized)) {
      return true;
    }
    const v4MappedDotted = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (v4MappedDotted) {
      return isDisallowedIpv4(v4MappedDotted[1]);
    }
    const v4MappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (v4MappedHex) {
      const hi = parseInt(v4MappedHex[1], 16);
      const lo = parseInt(v4MappedHex[2], 16);
      const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isDisallowedIpv4(dotted);
    }
  }
  return false;
}

export function validateCronJobPayload(payload, { partial = false } = {}) {
  if (!payload || typeof payload !== 'object' || !payload.job || typeof payload.job !== 'object' || Array.isArray(payload.job)) {
    return { ok: false, error: 'invalid_job_payload' };
  }
  const job = payload.job;
  for (const key of Object.keys(job)) {
    if (!ALLOWED_JOB_FIELDS.has(key)) {
      return { ok: false, error: `disallowed_job_field:${key}` };
    }
  }
  if (!partial || job.url !== undefined) {
    try {
      const parsed = new URL(String(job.url || ''));
      if (parsed.protocol !== 'https:') {
        return { ok: false, error: 'invalid_job_url_protocol' };
      }
      if (parsed.username || parsed.password) {
        return { ok: false, error: 'disallowed_job_url_credentials' };
      }
      if (parsed.hash) {
        return { ok: false, error: 'disallowed_job_url_fragment' };
      }
      if (isDisallowedTargetHost(parsed.hostname)) {
        return { ok: false, error: 'disallowed_job_url_host' };
      }
    } catch {
      return { ok: false, error: 'invalid_job_url' };
    }
  }
  return { ok: true, job };
}

// ---------------------------------------------------------------------------------------------------------
// Sanitised reads
// ---------------------------------------------------------------------------------------------------------

/** `https://host/path?token=…` → `https://host/path` plus a flag; a job target is shown, its secrets are not. */
export function redactUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    return { url: `${url.origin}${url.pathname}`, hasQuery: url.search.length > 1 };
  } catch {
    return { url: null, hasQuery: false };
  }
}

const SUMMARY_FIELDS = ['jobId', 'enabled', 'title', 'saveResponses', 'lastStatus', 'lastDuration', 'lastExecution', 'nextExecution', 'type', 'requestTimeout', 'redirectSuccess', 'folderId', 'schedule', 'requestMethod'];

export function sanitizeJobSummary(job) {
  if (!job || typeof job !== 'object') return null;
  const out = {};
  for (const field of SUMMARY_FIELDS) if (job[field] !== undefined) out[field] = job[field];
  Object.assign(out, redactUrl(job.url));
  return out;
}

export function sanitizeJobDetails(details) {
  const base = sanitizeJobSummary(details);
  if (!base) return null;
  if (details.auth && typeof details.auth === 'object') base.auth = { enable: Boolean(details.auth.enable) }; // never user/password
  if (details.notification && typeof details.notification === 'object') base.notification = { ...details.notification };
  if (details.extendedData && typeof details.extendedData === 'object') {
    const headers = details.extendedData.headers && typeof details.extendedData.headers === 'object' ? Object.keys(details.extendedData.headers) : [];
    const body = details.extendedData.body;
    base.extendedData = { headerNames: headers, bodyBytes: body ? new TextEncoder().encode(String(body)).length : 0 }; // names and sizes only
  }
  return base;
}

const HISTORY_FIELDS = ['jobLogId', 'jobId', 'identifier', 'date', 'datePlanned', 'jitter', 'duration', 'status', 'statusText', 'httpStatus', 'stats'];

export function sanitizeHistoryItem(item) {
  if (!item || typeof item !== 'object') return null;
  const out = {};
  for (const field of HISTORY_FIELDS) if (item[field] !== undefined) out[field] = item[field];
  Object.assign(out, redactUrl(item.url));
  return out; // `headers` and `body` (the stored response) are dropped on purpose
}

export function sanitizeUpstreamRead(subPath, data) {
  if (!data || typeof data !== 'object') return {};
  if (subPath === '/jobs') {
    return { jobs: Array.isArray(data.jobs) ? data.jobs.map(sanitizeJobSummary).filter(Boolean) : [], someFailed: Boolean(data.someFailed) };
  }
  if (subPath.endsWith('/history')) {
    return { history: Array.isArray(data.history) ? data.history.map(sanitizeHistoryItem).filter(Boolean) : [], predictions: Array.isArray(data.predictions) ? data.predictions : [] };
  }
  return { jobDetails: sanitizeJobDetails(data.jobDetails || data) };
}

/** GET through to cron-job.org; the caller already checked the key exists. */
export async function readUpstream({ cronKey, fetchImpl = globalThis.fetch, subPath }) {
  let response;
  try {
    response = await fetchImpl(`${CRONJOB_ORIGIN}${subPath}`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${cronKey}` },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { status: timedOut ? 504 : 502, body: { error: timedOut ? 'cronjob_upstream_timeout' : 'cronjob_upstream_unreachable' } };
  }
  if (!response.ok) return { status: 502, body: { error: 'cronjob_upstream_error', upstreamStatus: response.status } };
  const data = await response.json().catch(() => ({}));
  return { status: 200, body: sanitizeUpstreamRead(subPath, data) };
}

// ---------------------------------------------------------------------------------------------------------
// Outbox (D1)
// ---------------------------------------------------------------------------------------------------------

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export async function hashPayload(action, jobId, payload) {
  return sha256Hex(canonicalJson({ action, jobId: jobId ?? null, payload }));
}

const COLUMNS = 'id, idempotency_key, action, job_id, payload, payload_hash, note, status, attempts, external_ref, error_code, approval_key, created_at, decided_at, dispatched_at, finished_at, updated_at';

function rowToIntent(row) {
  if (!row) return null;
  let payload = {};
  try { payload = JSON.parse(row.payload || '{}'); } catch { payload = {}; }
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    action: row.action,
    jobId: row.job_id ?? null,
    payload,
    payloadHash: row.payload_hash,
    note: row.note ?? null,
    status: row.status,
    attempts: row.attempts ?? 0,
    externalRef: row.external_ref ?? null,
    errorCode: row.error_code ?? null,
    approvalKey: row.approval_key ?? null,
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? null,
    dispatchedAt: row.dispatched_at ?? null,
    finishedAt: row.finished_at ?? null,
    updatedAt: row.updated_at
  };
}

async function audit(env, intentId, action, valueHash, at) {
  try {
    await appendAudit(env, { key: `cron.outbox.${intentId}`, action, valueHash, at });
  } catch (error) {
    // The audit chain is append-only evidence; a failure to append must be visible, not swallowed.
    throw Object.assign(new Error('audit_append_failed'), { status: 500, cause: error });
  }
}

export async function getIntent(env, id) {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM edge_cron_outbox WHERE id = ?`).bind(String(id)).first();
  return rowToIntent(row);
}

async function getByIdempotencyKey(env, key) {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM edge_cron_outbox WHERE idempotency_key = ?`).bind(key).first();
  return rowToIntent(row);
}

export async function listIntents(env, { status = null, limit = 50 } = {}) {
  const cap = Math.max(1, Math.min(MAX_INTENT_LIST, Number.parseInt(String(limit), 10) || 50));
  const query = status
    ? env.DB.prepare(`SELECT ${COLUMNS} FROM edge_cron_outbox WHERE status = ? ORDER BY created_at DESC LIMIT ?`).bind(String(status), cap)
    : env.DB.prepare(`SELECT ${COLUMNS} FROM edge_cron_outbox ORDER BY created_at DESC LIMIT ?`).bind(cap);
  const { results } = await query.all();
  return (results || []).map(rowToIntent);
}

export async function outboxCounts(env) {
  const { results } = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM edge_cron_outbox GROUP BY status').all();
  const counts = Object.fromEntries(Object.values(INTENT_STATUS).map((status) => [status, 0]));
  for (const row of results || []) counts[row.status] = Number(row.n) || 0;
  return counts;
}

function normaliseJobId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

/**
 * Validates and stores one intent. Replaying the same idempotency key with the same content returns the stored
 * intent (200); the same key with different content is refused (409) — a retry can never smuggle a new payload.
 */
export async function createIntent(env, { action, jobId, job, note, idempotencyKey, now = () => new Date() }) {
  if (!isD1Bound(env)) return { status: 503, body: { error: 'd1_not_bound' } };
  const key = String(idempotencyKey || '').trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) return { status: 400, body: { error: 'idempotency_key_required', pattern: IDEMPOTENCY_KEY_PATTERN.source } };
  if (!INTENT_ACTIONS.includes(action)) return { status: 400, body: { error: 'invalid_intent_action', allowed: INTENT_ACTIONS } };
  const target = normaliseJobId(jobId);
  if (Number.isNaN(target)) return { status: 400, body: { error: 'invalid_job_id' } };
  if (action !== 'create' && target === null) return { status: 400, body: { error: 'job_id_required' } };
  if (action === 'create' && target !== null) return { status: 400, body: { error: 'job_id_not_allowed_for_create' } };

  let payload = {};
  if (action !== 'delete') {
    const check = validateCronJobPayload({ job }, { partial: action === 'update' });
    if (!check.ok) return { status: 422, body: { error: check.error } };
    if (action === 'update' && Object.keys(check.job).length === 0) return { status: 422, body: { error: 'empty_update' } };
    payload = { job: check.job };
  } else if (job !== undefined) {
    return { status: 422, body: { error: 'delete_takes_no_job' } };
  }
  const noteText = note === undefined || note === null ? null : String(note).slice(0, 280);
  const payloadHash = await hashPayload(action, target, payload);

  const existing = await getByIdempotencyKey(env, key);
  if (existing) {
    if (existing.payloadHash === payloadHash) return { status: 200, body: { intent: existing, replayed: true } };
    return { status: 409, body: { error: 'idempotency_key_reused', intentId: existing.id } };
  }

  const id = crypto.randomUUID();
  const at = now().toISOString();
  await env.DB
    .prepare('INSERT INTO edge_cron_outbox (id, idempotency_key, action, job_id, payload, payload_hash, note, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)')
    .bind(id, key, action, target, JSON.stringify(payload), payloadHash, noteText, INTENT_STATUS.pending, at, at)
    .run();
  await audit(env, id, 'created', payloadHash, at);
  const intent = await getIntent(env, id);
  return { status: 202, body: { intent, approve: `/api/cron/intents/${id}/approve`, reject: `/api/cron/intents/${id}/reject` } };
}

function hashMatches(expected, actual) {
  const given = String(expected || '').trim().toLowerCase();
  if (!given) return false;
  return given.length >= 12 && actual.startsWith(given);
}

export async function rejectIntent(env, id, { note, now = () => new Date() } = {}) {
  if (!isD1Bound(env)) return { status: 503, body: { error: 'd1_not_bound' } };
  const intent = await getIntent(env, id);
  if (!intent) return { status: 404, body: { error: 'intent_not_found' } };
  const at = now().toISOString();
  const result = await env.DB
    .prepare('UPDATE edge_cron_outbox SET status = ?, decided_at = ?, finished_at = ?, updated_at = ?, note = COALESCE(?, note) WHERE id = ? AND status = ?')
    .bind(INTENT_STATUS.rejected, at, at, at, note ? String(note).slice(0, 280) : null, intent.id, INTENT_STATUS.pending)
    .run();
  if (!changed(result)) return { status: 409, body: { error: 'intent_not_pending', status: (await getIntent(env, id)).status } };
  await audit(env, intent.id, 'rejected', intent.payloadHash, at);
  return { status: 200, body: { intent: await getIntent(env, id) } };
}

function changed(result) {
  const n = result?.meta?.changes;
  return typeof n === 'number' ? n > 0 : true; // a D1 double without meta is trusted; real D1 always reports changes
}

/**
 * Approve = claim + dispatch exactly once. The approval is bound to the payload hash the owner saw
 * (`expectedHash`, ≥ 12 hex chars); a stored row that no longer matches its own hash is refused as tampered.
 */
export async function approveIntent(env, id, { expectedHash, cronKey, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  if (!isD1Bound(env)) return { status: 503, body: { error: 'd1_not_bound' } };
  const intent = await getIntent(env, id);
  if (!intent) return { status: 404, body: { error: 'intent_not_found' } };
  if (intent.status === INTENT_STATUS.rejected) return { status: 409, body: { error: 'intent_rejected', intentId: intent.id } };
  if (TERMINAL_STATUSES.includes(intent.status)) return { status: 200, body: { intent, replayed: true } };
  if (intent.status === INTENT_STATUS.dispatching) return { status: 409, body: { error: 'dispatch_in_progress', intentId: intent.id } };
  if (intent.status === INTENT_STATUS.unknown) return { status: 409, body: { error: 'reconciliation_required', reconcile: `/api/cron/intents/${intent.id}/reconcile` } };
  if (!hashMatches(expectedHash, intent.payloadHash)) return { status: 409, body: { error: 'payload_hash_mismatch', payloadHash: intent.payloadHash } };
  const recomputed = await hashPayload(intent.action, intent.jobId, intent.payload);
  if (recomputed !== intent.payloadHash) return { status: 409, body: { error: 'post_approval_payload_tampered' } };
  if (!cronKey) return { status: 503, body: { error: 'cronjob_not_configured' } };

  const at = now().toISOString();
  const approvalKey = `approval:${intent.id}:${intent.payloadHash.slice(0, 12)}`;
  const claim = await env.DB
    .prepare('UPDATE edge_cron_outbox SET status = ?, decided_at = ?, dispatched_at = ?, attempts = attempts + 1, approval_key = ?, updated_at = ? WHERE id = ? AND status = ?')
    .bind(INTENT_STATUS.dispatching, at, at, approvalKey, at, intent.id, INTENT_STATUS.pending)
    .run();
  if (!changed(claim)) return { status: 409, body: { error: 'intent_not_pending', status: (await getIntent(env, id)).status } };
  await audit(env, intent.id, 'approved', intent.payloadHash, at);

  const request = upstreamRequestFor(intent);
  let outcome;
  try {
    const response = await fetchImpl(`${CRONJOB_ORIGIN}${request.path}`, {
      method: request.method,
      headers: { accept: 'application/json', authorization: `Bearer ${cronKey}`, ...(request.body ? { 'content-type': 'application/json' } : {}) },
      body: request.body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      const externalRef = intent.action === 'create' ? (data?.jobId !== undefined ? String(data.jobId) : null) : String(intent.jobId);
      outcome = { status: INTENT_STATUS.applied, externalRef, errorCode: null };
    } else if (response.status >= 500) {
      outcome = { status: INTENT_STATUS.unknown, externalRef: null, errorCode: `cronjob_upstream_5xx:${response.status}` }; // the effect may exist
    } else {
      outcome = { status: INTENT_STATUS.failed, externalRef: null, errorCode: `cronjob_upstream_error:${response.status}` }; // upstream refused it
    }
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    outcome = { status: INTENT_STATUS.unknown, externalRef: null, errorCode: timedOut ? 'cronjob_upstream_timeout' : 'cronjob_upstream_unreachable' };
  }
  const finishedAt = now().toISOString();
  await env.DB
    .prepare('UPDATE edge_cron_outbox SET status = ?, external_ref = ?, error_code = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = ?')
    .bind(outcome.status, outcome.externalRef, outcome.errorCode, finishedAt, finishedAt, intent.id, INTENT_STATUS.dispatching)
    .run();
  await audit(env, intent.id, outcome.status, intent.payloadHash, finishedAt);
  return { status: 200, body: { intent: await getIntent(env, id) } };
}

export function upstreamRequestFor(intent) {
  if (intent.action === 'create') return { method: 'PUT', path: '/jobs', body: JSON.stringify({ job: intent.payload.job }) };
  if (intent.action === 'update') return { method: 'PATCH', path: `/jobs/${encodeURIComponent(intent.jobId)}`, body: JSON.stringify({ job: intent.payload.job }) };
  return { method: 'DELETE', path: `/jobs/${encodeURIComponent(intent.jobId)}`, body: undefined };
}

/** The only exit from `unknown` is a human saying what they found upstream (DEC-016). No connector is called. */
export async function reconcileIntent(env, id, { outcome, externalRef, note, now = () => new Date() } = {}) {
  if (!isD1Bound(env)) return { status: 503, body: { error: 'd1_not_bound' } };
  if (!['applied', 'not_applied'].includes(outcome)) return { status: 400, body: { error: 'invalid_reconcile_outcome', allowed: ['applied', 'not_applied'] } };
  const intent = await getIntent(env, id);
  if (!intent) return { status: 404, body: { error: 'intent_not_found' } };
  const at = now().toISOString();
  const status = outcome === 'applied' ? INTENT_STATUS.applied : INTENT_STATUS.notApplied;
  const result = await env.DB
    .prepare('UPDATE edge_cron_outbox SET status = ?, external_ref = COALESCE(?, external_ref), error_code = ?, finished_at = ?, updated_at = ?, note = COALESCE(?, note) WHERE id = ? AND status = ?')
    .bind(status, externalRef ? String(externalRef).slice(0, 64) : null, `reconciled_by_owner:${outcome}`, at, at, note ? String(note).slice(0, 280) : null, intent.id, INTENT_STATUS.unknown)
    .run();
  if (!changed(result)) return { status: 409, body: { error: 'intent_not_unknown', status: (await getIntent(env, id)).status } };
  await audit(env, intent.id, `reconciled_${outcome}`, intent.payloadHash, at);
  return { status: 200, body: { intent: await getIntent(env, id) } };
}
