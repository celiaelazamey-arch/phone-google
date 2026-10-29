// OPS-007 / DEC-042 — the cron-job.org surface of the edge worker is read-through and write-governed.
//
// These tests run the real D1 migrations in an in-memory SQLite (so `0003_cron_outbox.sql` is exercised as
// deployed), drive the worker through plain `Request`s, and replace cron-job.org with a fake fetch that counts
// every call. The properties pinned here are the ones that make the dashboard trustworthy: no write reaches
// cron-job.org without an approval bound to the payload hash, an approval dispatches at most once, an
// ambiguous outcome stays `unknown` until a human reconciles it, every transition lands on the audit chain,
// and the owner's secrets never come back through the read proxy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../workers/celia-edge/worker.js';
import { canonicalJson, hashPayload, sanitizeJobDetails } from '../workers/celia-edge/cron.js';
import { createStateStore } from '../workers/celia-edge/state.js';
import { loadAllMigrationsSql, splitSqlStatements } from '../scripts/deploy-cloudflare-edge.mjs';

const OWNER_TOKEN = 'edge-owner-token-'.padEnd(48, 'z');
const CRON_KEY = 'cronjob-org-live-key-0123456789';
const BASE = 'https://celia-phone-google.workers.dev';

async function createSqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  for (const statement of splitSqlStatements(await loadAllMigrationsSql())) sqlite.exec(statement);
  return {
    sqlite,
    prepare(query) {
      let boundParams = [];
      return {
        bind(...args) {
          boundParams = args.map((v) => (v === undefined ? null : v));
          return this;
        },
        async run() {
          const info = sqlite.prepare(query).run(...boundParams);
          return { success: true, meta: { changes: info.changes } };
        },
        async first() {
          return sqlite.prepare(query).get(...boundParams) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(query).all(...boundParams) };
        }
      };
    }
  };
}

function upstreamDouble(script = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    const method = init.method || 'GET';
    calls.push({ url: target, method, authorization: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : undefined });
    const handler = script[`${method} ${new URL(target).pathname}`] || script.default;
    if (!handler) return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    const out = typeof handler === 'function' ? await handler({ url: target, init }) : handler;
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

async function makeEnv({ cronKey = CRON_KEY, withDb = true, script } = {}) {
  const upstream = upstreamDouble(script);
  const env = {
    CELIA_MCP_API_TOKEN: OWNER_TOKEN,
    __FETCH_IMPL: upstream.fetchImpl
  };
  if (cronKey) env.CELIAOS_CRONJOB_ORG_API_KEY = cronKey;
  if (withDb) env.DB = await createSqliteD1();
  return { env, upstream };
}

async function call(env, method, path, { body, headers = {}, token = OWNER_TOKEN } = {}) {
  const request = new Request(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
  });
  const response = await worker.fetch(request, env, {});
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json, headers: response.headers };
}

const validJob = { title: 'celia keep-alive', url: 'https://celia-phone-google.celiaelazamey.workers.dev/health', enabled: true, schedule: { timezone: 'Africa/Cairo', minutes: [-1], hours: [-1], mdays: [-1], months: [-1], wdays: [-1] } };

test('status is honest about every half of the surface: key, D1, outbox counts', async () => {
  const { env } = await makeEnv();
  const status = await call(env, 'GET', '/api/cron/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.configured, true);
  assert.equal(status.json.writes, 'outbox-approval-only');
  assert.equal(status.json.reads, 'sanitized-proxy');
  assert.equal(status.json.durable, true);
  assert.equal(status.json.outbox.pending_approval, 0);
  assert.equal(status.json.decision, 'DEC-042');

  const noKey = (await makeEnv({ cronKey: null })).env;
  const unconfigured = await call(noKey, 'GET', '/api/cron/status');
  assert.equal(unconfigured.json.configured, false);
  assert.equal(unconfigured.json.reads, 'unavailable:cronjob_not_configured');
  const jobs = await call(noKey, 'GET', '/api/cron/jobs');
  assert.equal(jobs.status, 503);
  assert.equal(jobs.json.error, 'cronjob_not_configured');

  const noDb = (await makeEnv({ withDb: false })).env;
  const ephemeral = await call(noDb, 'GET', '/api/cron/status');
  assert.equal(ephemeral.json.durable, false);
  assert.equal(ephemeral.json.writes, 'unavailable:d1_not_bound');
  assert.equal(ephemeral.json.outbox, null);
  const intents = await call(noDb, 'GET', '/api/cron/intents');
  assert.equal(intents.status, 503);
  assert.equal(intents.json.error, 'd1_not_bound');
  const write = await call(noDb, 'POST', '/api/cron/jobs', { body: { job: validJob }, headers: { 'idempotency-key': 'no-db-attempt-01' } });
  assert.equal(write.status, 503, 'an intent that can never be stored durably is refused, not pretended');
  assert.equal(write.json.error, 'd1_not_bound');
});

test('reads pass through sanitised: no auth block, no header values, no query strings, no stored bodies', async () => {
  const { env, upstream } = await makeEnv({
    script: {
      'GET /jobs': { body: { jobs: [{ jobId: 101, enabled: true, title: 'ping', url: 'https://example.org/hook?token=SECRET-QUERY', lastStatus: 1, schedule: { hours: [-1] } }], someFailed: false } },
      'GET /jobs/101': { body: { jobDetails: { jobId: 101, title: 'ping', url: 'https://example.org/hook?token=SECRET-QUERY', auth: { enable: true, user: 'celia', password: 'SECRET-PASS' }, extendedData: { headers: { 'X-Api-Key': 'SECRET-HEADER' }, body: 'payload-body' }, notification: { onFailure: true } } } },
      'GET /jobs/101/history': { body: { history: [{ jobLogId: 7, jobId: 101, date: 1761700000, status: 1, httpStatus: 200, url: 'https://example.org/hook?token=SECRET-QUERY', headers: 'x-secret: SECRET-RESP-HEADER', body: 'SECRET-RESPONSE-BODY' }], predictions: [1761703600] } }
    }
  });
  const list = await call(env, 'GET', '/api/cron/jobs');
  assert.equal(list.status, 200);
  assert.equal(list.json.jobs[0].url, 'https://example.org/hook');
  assert.equal(list.json.jobs[0].hasQuery, true);
  assert.equal(upstream.calls[0].authorization, `Bearer ${CRON_KEY}`);

  const detail = await call(env, 'GET', '/api/cron/jobs/101');
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.json.jobDetails.auth, { enable: true });
  assert.deepEqual(detail.json.jobDetails.extendedData, { headerNames: ['X-Api-Key'], bodyBytes: 12 });
  assert.deepEqual(detail.json.jobDetails.notification, { onFailure: true });

  const history = await call(env, 'GET', '/api/cron/jobs/101/history');
  assert.equal(history.status, 200);
  assert.equal(history.json.history[0].httpStatus, 200);
  assert.equal(history.json.history[0].url, 'https://example.org/hook');
  assert.deepEqual(history.json.predictions, [1761703600]);

  for (const payload of [list, detail, history]) assert.doesNotMatch(JSON.stringify(payload.json), /SECRET-/, 'a secret leaked through the read proxy');
  assert.equal(sanitizeJobDetails(null), null);
});

test('legacy write routes no longer write: they store an intent (202) and call nothing upstream', async () => {
  const { env, upstream } = await makeEnv();

  const missingKey = await call(env, 'POST', '/api/cron/jobs', { body: { job: validJob } });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.json.error, 'idempotency_key_required');

  const created = await call(env, 'POST', '/api/cron/jobs', { body: { job: validJob, note: 'keep the edge warm' }, headers: { 'idempotency-key': 'create-keepalive-0001' } });
  assert.equal(created.status, 202, JSON.stringify(created.json));
  assert.equal(created.json.intent.status, 'pending_approval');
  assert.equal(created.json.intent.action, 'create');
  assert.equal(created.json.intent.note, 'keep the edge warm');
  assert.match(created.json.intent.payloadHash, /^[0-9a-f]{64}$/);
  assert.equal(created.json.approve, `/api/cron/intents/${created.json.intent.id}/approve`);
  assert.equal(upstream.calls.length, 0, 'no upstream call before approval');

  const replay = await call(env, 'POST', '/api/cron/jobs', { body: { job: validJob, note: 'keep the edge warm' }, headers: { 'idempotency-key': 'create-keepalive-0001' } });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.intent.id, created.json.intent.id);

  const smuggled = await call(env, 'POST', '/api/cron/jobs', { body: { job: { ...validJob, url: 'https://evil.example/hook' } }, headers: { 'idempotency-key': 'create-keepalive-0001' } });
  assert.equal(smuggled.status, 409);
  assert.equal(smuggled.json.error, 'idempotency_key_reused');

  const update = await call(env, 'PATCH', '/api/cron/jobs/101', { body: { job: { enabled: false } }, headers: { 'idempotency-key': 'disable-101-0001' } });
  assert.equal(update.status, 202);
  assert.equal(update.json.intent.action, 'update');
  assert.equal(update.json.intent.jobId, 101);

  const removal = await call(env, 'DELETE', '/api/cron/jobs/101', { headers: { 'idempotency-key': 'delete-101-0001' } });
  assert.equal(removal.status, 202);
  assert.equal(removal.json.intent.action, 'delete');
  assert.deepEqual(removal.json.intent.payload, {});

  const listed = await call(env, 'GET', '/api/cron/intents?status=pending_approval');
  assert.equal(listed.json.intents.length, 3);
  assert.equal(listed.json.counts.pending_approval, 3);
  assert.equal(upstream.calls.length, 0);

  const status = await call(env, 'GET', '/api/cron/status');
  assert.equal(status.json.outbox.pending_approval, 3);
});

test('intent creation keeps the SSRF guard, the field allowlist and the 8 KiB cap in front of the outbox', async () => {
  const { env, upstream } = await makeEnv();
  const blocked = await call(env, 'POST', '/api/cron/intents', { body: { action: 'create', job: { ...validJob, url: 'https://169.254.169.254/latest/meta-data' } }, headers: { 'idempotency-key': 'ssrf-attempt-0001' } });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.json.error, 'disallowed_job_url_host');

  const field = await call(env, 'POST', '/api/cron/intents', { body: { action: 'create', job: { ...validJob, folderId: 3 } }, headers: { 'idempotency-key': 'field-attempt-0001' } });
  assert.equal(field.status, 422);
  assert.equal(field.json.error, 'disallowed_job_field:folderId');

  const big = await call(env, 'POST', '/api/cron/intents', { body: { action: 'create', job: { ...validJob, title: 'x'.repeat(9000) } }, headers: { 'idempotency-key': 'big-attempt-0001' } });
  assert.equal(big.status, 413);

  const badAction = await call(env, 'POST', '/api/cron/intents', { body: { action: 'enable', jobId: 1 }, headers: { 'idempotency-key': 'bad-action-0001' } });
  assert.equal(badAction.status, 400);
  assert.equal(badAction.json.error, 'invalid_intent_action');

  const noTarget = await call(env, 'POST', '/api/cron/intents', { body: { action: 'delete' }, headers: { 'idempotency-key': 'no-target-0001' } });
  assert.equal(noTarget.status, 400);
  assert.equal(noTarget.json.error, 'job_id_required');

  const emptyUpdate = await call(env, 'POST', '/api/cron/intents', { body: { action: 'update', jobId: 5, job: {} }, headers: { 'idempotency-key': 'empty-update-0001' } });
  assert.equal(emptyUpdate.status, 422);
  assert.equal(emptyUpdate.json.error, 'empty_update');

  const unauth = await call(env, 'POST', '/api/cron/intents', { body: { action: 'create', job: validJob }, headers: { 'idempotency-key': 'unauth-0001' }, token: null });
  assert.equal(unauth.status, 401);

  const noKeyEnv = (await makeEnv({ cronKey: null })).env;
  const unconfigured = await call(noKeyEnv, 'POST', '/api/cron/intents', { body: { action: 'create', job: validJob }, headers: { 'idempotency-key': 'unconfigured-0001' } });
  assert.equal(unconfigured.status, 503, 'an intent that could never be dispatched is not accepted');
  assert.equal(unconfigured.json.error, 'cronjob_not_configured');

  assert.equal(upstream.calls.length, 0);
  assert.equal((await call(env, 'GET', '/api/cron/intents')).json.intents.length, 0, 'nothing invalid was stored');
});

test('approve = hash-bound claim + single dispatch; replays and races cannot dispatch twice', async () => {
  const { env, upstream } = await makeEnv({ script: { 'PUT /jobs': { body: { jobId: 4242 } } } });
  const created = await call(env, 'POST', '/api/cron/intents', { body: { action: 'create', job: validJob }, headers: { 'idempotency-key': 'approve-flow-0001' } });
  const intent = created.json.intent;
  assert.equal(await hashPayload('create', null, { job: validJob }), intent.payloadHash, 'the hash is reproducible from what the owner sees');

  const blind = await call(env, 'POST', `/api/cron/intents/${intent.id}/approve`, { body: {} });
  assert.equal(blind.status, 409);
  assert.equal(blind.json.error, 'payload_hash_mismatch');
  const wrong = await call(env, 'POST', `/api/cron/intents/${intent.id}/approve`, { body: { expectedHash: 'deadbeefdeadbeef' } });
  assert.equal(wrong.status, 409);
  assert.equal(upstream.calls.length, 0, 'a mismatched approval never reaches upstream');

  const [first, second] = await Promise.all([
    call(env, 'POST', `/api/cron/intents/${intent.id}/approve`, { body: { expectedHash: intent.payloadHash.slice(0, 16) } }),
    call(env, 'POST', `/api/cron/intents/${intent.id}/approve`, { body: { expectedHash: intent.payloadHash } })
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 409], JSON.stringify([first.json, second.json]));
  const winner = first.status === 200 ? first : second;
  const loser = first.status === 200 ? second : first;
  // The loser's 409 names whichever race it lost: its first read still saw `pending` and its conditional claim
  // changed 0 rows (`intent_not_pending`), or the winner's claim had already committed before that read
  // (`dispatch_in_progress`). Both are the designed refusal; PR run 40829637283 hit the second interleaving.
  assert.ok(['intent_not_pending', 'dispatch_in_progress'].includes(loser.json.error), JSON.stringify(loser.json));
  assert.equal(winner.json.intent.status, 'applied');
  assert.equal(winner.json.intent.externalRef, '4242');
  assert.equal(winner.json.intent.attempts, 1);
  assert.equal(winner.json.intent.approvalKey, `approval:${intent.id}:${intent.payloadHash.slice(0, 12)}`);
  assert.equal(upstream.calls.length, 1, 'exactly one dispatch');
  assert.equal(upstream.calls[0].method, 'PUT');
  assert.equal(upstream.calls[0].url, 'https://api.cron-job.org/jobs');
  assert.equal(upstream.calls[0].authorization, `Bearer ${CRON_KEY}`);
  assert.deepEqual(upstream.calls[0].body, { job: validJob });

  const replay = await call(env, 'POST', `/api/cron/intents/${intent.id}/approve`, { body: { expectedHash: intent.payloadHash } });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.replayed, true);
  assert.equal(upstream.calls.length, 1, 'approving an applied intent again is a no-op');

  const audit = await createStateStore(env).audit({ limit: 50 });
  assert.equal(audit.chain.ok, true);
  const mine = audit.rows.filter((row) => row.key === `cron.outbox.${intent.id}`);
  assert.deepEqual(mine.map((row) => row.action), ['created', 'approved', 'applied']);
  for (const row of mine) assert.equal(row.value_hash, intent.payloadHash);
  assert.doesNotMatch(JSON.stringify(audit.rows), /workers\.dev\/health|keep-alive/, 'the audit chain stores hashes, never payloads');
});

test('an intent already claimed (`dispatching`) refuses a second approval with dispatch_in_progress and never re-dispatches', async () => {
  // Deterministic twin of the race above: the row is put into `dispatching` directly, as the winner's claim does.
  const { env, upstream } = await makeEnv({ script: { 'PUT /jobs': { body: { jobId: 4343 } } } });
  const intent = (await call(env, 'POST', '/api/cron/intents', { body: { action: 'create', job: validJob }, headers: { 'idempotency-key': 'claimed-flow-0001' } })).json.intent;
  env.DB.sqlite.prepare('UPDATE edge_cron_outbox SET status = ?, dispatched_at = ?, attempts = 1 WHERE id = ?').run('dispatching', new Date().toISOString(), intent.id);
  const second = await call(env, 'POST', `/api/cron/intents/${intent.id}/approve`, { body: { expectedHash: intent.payloadHash } });
  assert.equal(second.status, 409);
  assert.equal(second.json.error, 'dispatch_in_progress');
  assert.equal(second.json.intentId, intent.id);
  assert.equal(upstream.calls.length, 0, 'a claimed intent is never dispatched again');
  assert.equal((await call(env, 'GET', `/api/cron/intents/${intent.id}`)).json.intent.status, 'dispatching', 'the claim is untouched');
});

test('update and delete intents dispatch PATCH and DELETE; a rejected intent can never be approved', async () => {
  const { env, upstream } = await makeEnv({ script: { 'PATCH /jobs/101': { body: {} }, 'DELETE /jobs/202': { body: {} } } });
  const update = (await call(env, 'PATCH', '/api/cron/jobs/101', { body: { job: { enabled: false } }, headers: { 'idempotency-key': 'disable-101-0002' } })).json.intent;
  const done = await call(env, 'POST', `/api/cron/intents/${update.id}/approve`, { body: { expectedHash: update.payloadHash } });
  assert.equal(done.json.intent.status, 'applied');
  assert.equal(done.json.intent.externalRef, '101');
  assert.equal(upstream.calls.at(-1).method, 'PATCH');
  assert.deepEqual(upstream.calls.at(-1).body, { job: { enabled: false } });

  const removal = (await call(env, 'DELETE', '/api/cron/jobs/202', { headers: { 'idempotency-key': 'delete-202-0002' } })).json.intent;
  const rejected = await call(env, 'POST', `/api/cron/intents/${removal.id}/reject`, { body: { note: 'still needed' } });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.json.intent.status, 'rejected');
  assert.equal(rejected.json.intent.note, 'still needed');
  const afterReject = await call(env, 'POST', `/api/cron/intents/${removal.id}/approve`, { body: { expectedHash: removal.payloadHash } });
  assert.equal(afterReject.status, 409);
  assert.equal(afterReject.json.error, 'intent_rejected');
  const rejectAgain = await call(env, 'POST', `/api/cron/intents/${removal.id}/reject`, { body: {} });
  assert.equal(rejectAgain.status, 409);
  assert.equal(rejectAgain.json.error, 'intent_not_pending');
  assert.equal(upstream.calls.filter((c) => c.method === 'DELETE').length, 0, 'a rejected delete never reaches upstream');

  const removal2 = (await call(env, 'DELETE', '/api/cron/jobs/202', { headers: { 'idempotency-key': 'delete-202-0003' } })).json.intent;
  const applied = await call(env, 'POST', `/api/cron/intents/${removal2.id}/approve`, { body: { expectedHash: removal2.payloadHash } });
  assert.equal(applied.json.intent.status, 'applied');
  assert.equal(upstream.calls.at(-1).method, 'DELETE');
  assert.equal(upstream.calls.at(-1).url, 'https://api.cron-job.org/jobs/202');

  const missing = await call(env, 'POST', '/api/cron/intents/00000000-0000-4000-8000-000000000000/approve', { body: { expectedHash: 'ffffffffffff' } });
  assert.equal(missing.status, 404);
  const badPath = await call(env, 'GET', '/api/cron/intents/not-a-uuid');
  assert.equal(badPath.status, 400);
  const wrongMethod = await call(env, 'PUT', `/api/cron/intents/${removal2.id}`);
  assert.equal(wrongMethod.status, 405);
});

test('a refused write is failed; an ambiguous one is unknown and leaves only through owner reconciliation', async () => {
  let mode = 'refuse';
  const { env, upstream } = await makeEnv({
    script: {
      'PUT /jobs': () => {
        if (mode === 'refuse') return { status: 400, body: { error: 'invalid schedule' } };
        if (mode === 'crash') return { status: 503, body: {} };
        const error = new Error('aborted');
        error.name = 'TimeoutError';
        throw error;
      }
    }
  });
  const make = async (key) => (await call(env, 'POST', '/api/cron/intents', { body: { action: 'create', job: validJob }, headers: { 'idempotency-key': key } })).json.intent;
  const approve = (intent) => call(env, 'POST', `/api/cron/intents/${intent.id}/approve`, { body: { expectedHash: intent.payloadHash } });

  const refused = await approve(await make('outcome-refused-0001'));
  assert.equal(refused.json.intent.status, 'failed');
  assert.equal(refused.json.intent.errorCode, 'cronjob_upstream_error:400');

  mode = 'crash';
  const crashed = await approve(await make('outcome-crash-0001'));
  assert.equal(crashed.json.intent.status, 'unknown', 'a 5xx may or may not have applied the job');
  assert.equal(crashed.json.intent.errorCode, 'cronjob_upstream_5xx:503');

  mode = 'timeout';
  const timedOut = await approve(await make('outcome-timeout-0001'));
  assert.equal(timedOut.json.intent.status, 'unknown');
  assert.equal(timedOut.json.intent.errorCode, 'cronjob_upstream_timeout');
  assert.equal(upstream.calls.length, 3);

  const again = await approve(timedOut.json.intent);
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'reconciliation_required');
  assert.equal(upstream.calls.length, 3, 'unknown is never retried automatically');

  const badOutcome = await call(env, 'POST', `/api/cron/intents/${timedOut.json.intent.id}/reconcile`, { body: { outcome: 'retry' } });
  assert.equal(badOutcome.status, 400);
  const reconciled = await call(env, 'POST', `/api/cron/intents/${timedOut.json.intent.id}/reconcile`, { body: { outcome: 'applied', externalRef: '9001', note: 'found it in the cron-job.org console' } });
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.json.intent.status, 'applied');
  assert.equal(reconciled.json.intent.externalRef, '9001');
  assert.equal(reconciled.json.intent.errorCode, 'reconciled_by_owner:applied');
  const twice = await call(env, 'POST', `/api/cron/intents/${timedOut.json.intent.id}/reconcile`, { body: { outcome: 'not_applied' } });
  assert.equal(twice.status, 409);
  assert.equal(twice.json.error, 'intent_not_unknown');

  const notApplied = await call(env, 'POST', `/api/cron/intents/${crashed.json.intent.id}/reconcile`, { body: { outcome: 'not_applied' } });
  assert.equal(notApplied.json.intent.status, 'not_applied');
  const cannotReconcileFailed = await call(env, 'POST', `/api/cron/intents/${refused.json.intent.id}/reconcile`, { body: { outcome: 'applied' } });
  assert.equal(cannotReconcileFailed.status, 409);

  const counts = (await call(env, 'GET', '/api/cron/status')).json.outbox;
  assert.equal(counts.failed, 1);
  assert.equal(counts.applied, 1);
  assert.equal(counts.not_applied, 1);
  assert.equal(counts.unknown, 0);

  const audit = await createStateStore(env).audit({ limit: 100 });
  assert.equal(audit.chain.ok, true);
  const actions = audit.rows.filter((row) => row.key === `cron.outbox.${timedOut.json.intent.id}`).map((row) => row.action);
  assert.deepEqual(actions, ['created', 'approved', 'unknown', 'reconciled_applied']);
});

test('a row edited behind the owner\'s back is refused as tampered before any dispatch', async () => {
  const { env, upstream } = await makeEnv();
  const intent = (await call(env, 'POST', '/api/cron/intents', { body: { action: 'create', job: validJob }, headers: { 'idempotency-key': 'tamper-check-0001' } })).json.intent;
  env.DB.sqlite.prepare('UPDATE edge_cron_outbox SET payload = ? WHERE id = ?').run(JSON.stringify({ job: { ...validJob, url: 'https://evil.example/exfil' } }), intent.id);
  const approve = await call(env, 'POST', `/api/cron/intents/${intent.id}/approve`, { body: { expectedHash: intent.payloadHash } });
  assert.equal(approve.status, 409);
  assert.equal(approve.json.error, 'post_approval_payload_tampered');
  assert.equal(upstream.calls.length, 0);
  assert.equal(canonicalJson({ b: 1, a: [2, { d: null, c: 'x' }] }), '{"a":[2,{"c":"x","d":null}],"b":1}');
});
