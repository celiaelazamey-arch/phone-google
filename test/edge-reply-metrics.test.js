/**
 * WP-1.4 — measured reply truncation (DEC-050).
 *
 * RM-01  The classifier is the same function in `src/` and `workers/celia-edge/` (fixture parity), and it only reports
 *        the two observable facts: `finishReason: MAX_TOKENS` and the character cap.
 * RM-02  `generateEdgeAiReply` carries the facts with every reply (Gemini stop reason, cap, local fallback = not truncated).
 * RM-03  The webhook stores one metric row per outbound reply, keyed by the Meta message id — counts only, no text, no
 *        phone — and `GET /api/whatsapp/reply-metrics` turns them into the ratio (owner-only, window, by reason/provider).
 * RM-04  `/api/ai/reply` is measured under its own `source: api`; without D1 the reply still succeeds and says so.
 * RM-05  Metrics never break the reply path: broken DB → `{ ok: false }`, duplicate id → ignored.
 * RM-06  The Worker upload includes `reply-metrics.js` (import graph, DEC-044) and the migration count moved to 16.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker from '../workers/celia-edge/worker.js';
import { EDGE_MAX_OUTPUT_TOKENS, generateEdgeAiReply } from '../workers/celia-edge/runtime.js';
import * as edgeMetrics from '../workers/celia-edge/reply-metrics.js';
import * as expressMetrics from '../src/reply-metrics.js';
import { generateWhatsAppReplyDetailed, GEMINI_MAX_OUTPUT_TOKENS } from '../src/gemini.js';
import { collectWorkerModules, loadAllMigrationsSql, splitSqlStatements } from '../scripts/deploy-cloudflare-edge.mjs';

const OWNER_TOKEN = 'edge-owner-token-'.padEnd(48, 'm');
const WA_SECRET = 'meta-webhook-secret-metrics';

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

const signMetaBody = (raw) => `sha256=${crypto.createHmac('sha256', WA_SECRET).update(raw, 'utf8').digest('hex')}`;
const geminiBody = (text, finishReason) => JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason }] });

test('RM-01 classifier parity between src/ and workers/ on the same fixtures; only MAX_TOKENS and the cap count as truncation', () => {
  const fixtures = [
    { finishReason: 'STOP', candidateText: 'رد قصير.' },
    { finishReason: 'MAX_TOKENS', candidateText: 'رد توقف عند حد الرموز' },
    { finishReason: 'STOP', candidateText: 'ك'.repeat(1200) },
    { finishReason: 'MAX_TOKENS', candidateText: 'ك'.repeat(1500) },
    { finishReason: null, candidateText: '' },
    { finishReason: 'max_tokens', candidateText: 'lower-case stop reason' },
    { finishReason: 'SAFETY', candidateText: 'blocked but not truncated' },
    { finishReason: 'STOP', candidateText: 'x'.repeat(50), charCap: 20 },
    { finishReason: 'STOP', candidateText: 'x'.repeat(1000) },
    { candidateText: undefined }
  ];
  const edge = fixtures.map((f) => edgeMetrics.classifyReplyTruncation(f));
  const express = fixtures.map((f) => expressMetrics.classifyReplyTruncation(f));
  assert.deepEqual(edge, express, 'both copies agree');
  assert.equal(edgeMetrics.REPLY_CHAR_CAP, expressMetrics.REPLY_CHAR_CAP);
  assert.deepEqual(edgeMetrics.TRUNCATION_REASON, expressMetrics.TRUNCATION_REASON);

  assert.deepEqual(edge[0], { truncated: false, reason: null, finishReason: 'STOP', candidateChars: 8, sentChars: 8 });
  assert.deepEqual(edge[1], { truncated: true, reason: 'max_tokens', finishReason: 'MAX_TOKENS', candidateChars: 21, sentChars: 21 });
  assert.deepEqual(edge[2], { truncated: true, reason: 'char_cap', finishReason: 'STOP', candidateChars: 1200, sentChars: 1000 });
  assert.deepEqual(edge[3], { truncated: true, reason: 'max_tokens+char_cap', finishReason: 'MAX_TOKENS', candidateChars: 1500, sentChars: 1000 });
  assert.deepEqual(edge[4], { truncated: false, reason: null, finishReason: null, candidateChars: 0, sentChars: 0 });
  assert.equal(edge[5].reason, 'max_tokens', 'stop reason is normalised');
  assert.equal(edge[6].truncated, false, 'SAFETY is not truncation');
  assert.deepEqual(edge[7], { truncated: true, reason: 'char_cap', finishReason: 'STOP', candidateChars: 50, sentChars: 20 });
  assert.equal(edge[8].truncated, false, 'exactly the cap is whole');
  assert.equal(edge[9].candidateChars, 0);
});

test('RM-02 generateEdgeAiReply reports the facts with every reply: Gemini stop reason, the character cap, and local fallback = not truncated', async () => {
  const replyFor = async (text, finishReason, env = { GEMINI_API_KEY: 'AIzaSyTest' }) =>
    generateEdgeAiReply({
      env,
      customerMessage: 'ما مواعيد العمل؟',
      provider: 'auto',
      fetchImpl: async () => new Response(geminiBody(text, finishReason), { status: 200 })
    });

  const whole = await replyFor('نعمل من 9 إلى 5.', 'STOP');
  assert.equal(whole.provider, 'gemini');
  assert.equal(whole.truncated, false);
  assert.equal(whole.truncationReason, null);
  assert.equal(whole.finishReason, 'STOP');
  assert.equal(whole.maxOutputTokens, EDGE_MAX_OUTPUT_TOKENS);
  assert.equal(EDGE_MAX_OUTPUT_TOKENS, 220, 'the budget WP-1.4 measures is the one in generationConfig');

  const cutByTokens = await replyFor('نعمل من 9 إلى', 'MAX_TOKENS');
  assert.equal(cutByTokens.truncated, true);
  assert.equal(cutByTokens.truncationReason, 'max_tokens');
  assert.equal(cutByTokens.candidateChars, 'نعمل من 9 إلى'.length);

  const cutByCap = await replyFor('ن'.repeat(1300), 'STOP');
  assert.equal(cutByCap.truncated, true);
  assert.equal(cutByCap.truncationReason, 'char_cap');
  assert.equal(cutByCap.reply.length, 1000);
  assert.equal(cutByCap.candidateChars, 1300);
  assert.equal(cutByCap.sentChars, 1000);

  const local = await replyFor('ignored', 'STOP', {});
  assert.equal(local.provider, 'local');
  assert.equal(local.truncated, false);
  assert.equal(local.finishReason, null);
  assert.equal(local.maxOutputTokens, null, 'no model budget applies to the policy reply');
  assert.equal(typeof local.candidateChars, 'number');

  // Express engine: the detailed Gemini call reports the same facts (same classifier).
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(geminiBody('رد مقصوص', 'MAX_TOKENS'), { status: 200 });
  try {
    const { context, ...detailed } = await generateWhatsAppReplyDetailed({ config: { gemini: { apiKey: 'k', model: 'gemini-test', businessContext: '' } }, customerMessage: 'مرحبا' });
    assert.deepEqual(detailed, {
      text: 'رد مقصوص',
      finishReason: 'MAX_TOKENS',
      truncated: true,
      truncationReason: 'max_tokens',
      candidateChars: 8,
      sentChars: 8,
      maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS
    });
    // WP-2.1: the context policy's report rides along with the truncation facts (nothing dropped for a 5-char message).
    assert.deepEqual(context.dropped, []);
    assert.equal(context.chars.message, 5);
    assert.equal(context.chars.total, context.chars.instructions + 5);
    assert.equal(GEMINI_MAX_OUTPUT_TOKENS, 180);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function makeEnv({ withDb = true, geminiScript } = {}) {
  const outbound = [];
  const geminiCalls = [];
  const env = {
    CELIA_MCP_API_TOKEN: OWNER_TOKEN,
    GEMINI_API_KEY: 'AIzaSyTest',
    WHATSAPP_VERIFY_TOKEN: 'verify',
    WHATSAPP_APP_SECRET: WA_SECRET,
    WHATSAPP_ACCESS_TOKEN: 'meta-tok',
    WHATSAPP_PHONE_NUMBER_ID: '99887766',
    WHATSAPP_AUTO_REPLY_ENABLED: 'true',
    __FETCH_IMPL: async (url, init = {}) => {
      const target = String(url);
      if (target.includes('graph.facebook.com')) {
        outbound.push(JSON.parse(init.body).text.body);
        return new Response(JSON.stringify({ messages: [{ id: `wamid.out.${outbound.length}` }] }), { status: 200 });
      }
      if (target.includes('generativelanguage.googleapis.com')) {
        geminiCalls.push(JSON.parse(init.body));
        const script = geminiScript[Math.min(geminiCalls.length - 1, geminiScript.length - 1)];
        return new Response(geminiBody(script.text, script.finishReason), { status: 200 });
      }
      throw new Error(`unexpected url: ${target}`);
    }
  };
  if (withDb) env.DB = await createSqliteD1();
  return { env, outbound, geminiCalls };
}

const authHeaders = { authorization: `Bearer ${OWNER_TOKEN}`, 'content-type': 'application/json' };

async function sendWebhook(env, id, from, bodyText) {
  const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id, from, type: 'text', text: { body: bodyText } }] } }] }] });
  const res = await worker.fetch(
    new Request('https://celia.workers.dev/webhooks/whatsapp', { method: 'POST', headers: { 'x-hub-signature-256': signMetaBody(raw) }, body: raw }),
    env
  );
  assert.equal(res.status, 200);
}

test('RM-03 the webhook stores one metric row per outbound reply (keyed by the Meta id, no text, no phone) and the owner reads the ratio', async () => {
  const { env, outbound } = await makeEnv({
    geminiScript: [
      { text: 'نعمل يوميًا من 9 إلى', finishReason: 'MAX_TOKENS' },
      { text: 'نعمل يوميًا من 9 صباحًا إلى 5 مساءً.', finishReason: 'STOP' },
      { text: 'ت'.repeat(1100), finishReason: 'STOP' }
    ]
  });
  const consent = await worker.fetch(
    new Request('https://celia.workers.dev/api/whatsapp/consent', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ phone: '+201012345678', optedIn: true, aiOptedIn: true, source: 'test' })
    }),
    env
  );
  assert.equal(consent.status, 200, await consent.text());

  await sendWebhook(env, 'wamid.in.1', '201012345678', 'مواعيد العمل؟');
  await sendWebhook(env, 'wamid.in.2', '201012345678', 'ومواعيد الجمعة؟');
  await sendWebhook(env, 'wamid.in.3', '201012345678', 'اشرح كل الخدمات بالتفصيل');
  assert.equal(outbound.length, 3, 'three replies went out');
  assert.equal(outbound[2].length, 1000, 'the third reply was cut at the cap before sending');

  const rows = env.DB.sqlite.prepare('SELECT * FROM whatsapp_reply_metrics ORDER BY id').all();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.provider_message_id), ['wamid.out.1', 'wamid.out.2', 'wamid.out.3']);
  assert.deepEqual(rows.map((r) => r.truncated), [1, 0, 1]);
  assert.deepEqual(rows.map((r) => r.truncation_reason), ['max_tokens', null, 'char_cap']);
  assert.deepEqual(rows.map((r) => r.finish_reason), ['MAX_TOKENS', 'STOP', 'STOP']);
  assert.deepEqual(rows.map((r) => [r.candidate_chars, r.sent_chars]), [[20, 20], [36, 36], [1100, 1000]]);
  assert.ok(rows.every((r) => r.source === 'webhook' && r.provider === 'gemini' && r.max_output_tokens === 220));
  assert.deepEqual(
    Object.keys(rows[0]).sort(),
    ['candidate_chars', 'created_at', 'finish_reason', 'id', 'max_output_tokens', 'model', 'provider', 'provider_message_id', 'sent_chars', 'source', 'truncated', 'truncation_reason'],
    'no body and no phone column in the metrics table'
  );
  // The metric joins the stored outbound message by id — "stored with the message".
  const joined = env.DB.sqlite
    .prepare('SELECT m.direction, m.status, r.truncated FROM whatsapp_reply_metrics r JOIN whatsapp_messages m ON m.provider_message_id = r.provider_message_id ORDER BY r.id')
    .all()
    .map((row) => ({ ...row })); // node:sqlite rows are null-prototype objects
  assert.deepEqual(joined, [
    { direction: 'outbound', status: 'sent', truncated: 1 },
    { direction: 'outbound', status: 'sent', truncated: 0 },
    { direction: 'outbound', status: 'sent', truncated: 1 }
  ]);

  const anonymous = await worker.fetch(new Request('https://celia.workers.dev/api/whatsapp/reply-metrics'), env);
  assert.equal(anonymous.status, 401, 'owner-only');

  const summaryRes = await worker.fetch(new Request('https://celia.workers.dev/api/whatsapp/reply-metrics?days=30', { headers: authHeaders }), env);
  assert.equal(summaryRes.status, 200);
  const summary = await summaryRes.json();
  assert.equal(summary.ok, true);
  assert.equal(summary.replies, 3);
  assert.equal(summary.truncated, 2);
  assert.equal(summary.truncatedRatio, 0.6667);
  assert.deepEqual(summary.byReason, { max_tokens: 1, char_cap: 1 });
  assert.deepEqual(summary.byProvider, [{ provider: 'gemini', source: 'webhook', replies: 3, truncated: 2, truncatedRatio: 0.6667 }]);
  assert.equal(summary.maxCandidateChars, 1100);
  assert.equal(summary.maxOutputTokens, 220);
  assert.equal(summary.charCap, 1000);
  assert.equal(summary.decision, 'DEC-050');
  assert.equal(summary.windowDays, 30);
  assert.ok(summary.lastAt);
  assert.equal(JSON.stringify(summary).includes('2010123'), false, 'no phone number leaves the summary');
  assert.equal(JSON.stringify(summary).includes('نعمل'), false, 'no reply text leaves the summary');

  // Garbage/oversized windows fall back to sane bounds; an empty window is a measurement, not a failure.
  const bounded = await (await worker.fetch(new Request('https://celia.workers.dev/api/whatsapp/reply-metrics?days=9999', { headers: authHeaders }), env)).json();
  assert.equal(bounded.windowDays, 365);
  const garbage = await (await worker.fetch(new Request('https://celia.workers.dev/api/whatsapp/reply-metrics?days=abc', { headers: authHeaders }), env)).json();
  assert.equal(garbage.windowDays, 30);
  const empty = await edgeMetrics.summarizeReplyMetrics(env, { sinceDays: 30, now: () => new Date('2030-01-01T00:00:00Z') });
  assert.equal(empty.replies, 0);
  assert.equal(empty.truncatedRatio, null, 'null means not measured, never 0');
  assert.equal(empty.lastAt, null);
});

test('RM-04 /api/ai/reply is measured under source=api; without D1 the reply still succeeds and the summary says d1_not_bound', async () => {
  const { env } = await makeEnv({ geminiScript: [{ text: 'رد تجريبي', finishReason: 'MAX_TOKENS' }] });
  const res = await worker.fetch(
    new Request('https://celia.workers.dev/api/ai/reply', { method: 'POST', headers: authHeaders, body: JSON.stringify({ customerMessage: 'تجربة', provider: 'gemini' }) }),
    env
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.truncated, true);
  assert.equal(body.truncationReason, 'max_tokens');
  assert.equal(body.metricRecorded, true);
  const row = env.DB.sqlite.prepare('SELECT source, provider, truncated, provider_message_id FROM whatsapp_reply_metrics').get();
  assert.equal(row.source, 'api');
  assert.equal(row.provider, 'gemini');
  assert.equal(row.truncated, 1);
  assert.match(row.provider_message_id, /^api:[0-9a-f-]{36}$/);
  const summary = await (await worker.fetch(new Request('https://celia.workers.dev/api/whatsapp/reply-metrics', { headers: authHeaders }), env)).json();
  assert.deepEqual(summary.byProvider, [{ provider: 'gemini', source: 'api', replies: 1, truncated: 1, truncatedRatio: 1 }]);

  const { env: noDb } = await makeEnv({ withDb: false, geminiScript: [{ text: 'رد', finishReason: 'STOP' }] });
  const unbound = await worker.fetch(
    new Request('https://celia.workers.dev/api/ai/reply', { method: 'POST', headers: authHeaders, body: JSON.stringify({ customerMessage: 'تجربة', provider: 'gemini' }) }),
    noDb
  );
  assert.equal(unbound.status, 200, 'the reply path never depends on metrics');
  assert.equal((await unbound.json()).metricRecorded, false);
  const unboundSummary = await worker.fetch(new Request('https://celia.workers.dev/api/whatsapp/reply-metrics', { headers: authHeaders }), noDb);
  assert.equal(unboundSummary.status, 503);
  assert.equal((await unboundSummary.json()).reason, 'd1_not_bound');
});

test('RM-05 metrics never break the reply path: broken DB → ok:false, duplicate id → ignored, missing fields → refused', async () => {
  const broken = { DB: { prepare() { throw new Error('D1_ERROR: no such table'); } } };
  const failed = await edgeMetrics.recordReplyMetric(broken, { providerMessageId: 'x', source: 'webhook', provider: 'gemini', candidateChars: 1, sentChars: 1, truncated: false });
  assert.deepEqual({ ok: failed.ok, reason: failed.reason }, { ok: false, reason: 'metrics_write_failed' });
  const summaryBroken = await edgeMetrics.summarizeReplyMetrics(broken);
  assert.equal(summaryBroken.ok, false);
  assert.equal(summaryBroken.reason, 'metrics_unavailable');

  const env = { DB: await createSqliteD1() };
  const base = { providerMessageId: 'wamid.dup', source: 'webhook', provider: 'gemini', candidateChars: 10, sentChars: 10, truncated: true, truncationReason: 'max_tokens', maxOutputTokens: 220 };
  assert.deepEqual(await edgeMetrics.recordReplyMetric(env, base), { ok: true, inserted: true });
  assert.deepEqual(await edgeMetrics.recordReplyMetric(env, base), { ok: true, inserted: false }, 'idempotent on the message id');
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM whatsapp_reply_metrics').get().n, 1);
  assert.deepEqual(await edgeMetrics.recordReplyMetric(env, { ...base, providerMessageId: '' }), { ok: false, reason: 'missing_fields' });
  assert.deepEqual(await edgeMetrics.recordReplyMetric(env, { ...base, providerMessageId: 'y', candidateChars: '10' }), { ok: false, reason: 'missing_counts' });
  assert.deepEqual(await edgeMetrics.recordReplyMetric({}, base), { ok: false, reason: 'd1_not_bound' });
});

test('RM-06 the Worker upload carries reply-metrics.js (import graph) and the migrations now total 16 idempotent statements', async () => {
  const modules = await collectWorkerModules();
  const names = modules.map((m) => m.name ?? m.fileName ?? m.path ?? m).map(String);
  assert.ok(names.some((n) => n.endsWith('reply-metrics.js')), `reply-metrics.js is in the bundle: ${names.join(', ')}`);
  const statements = splitSqlStatements(await loadAllMigrationsSql());
  assert.equal(statements.length, 16);
  assert.ok(statements.some((s) => /CREATE TABLE IF NOT EXISTS whatsapp_reply_metrics/.test(s)));
  assert.ok(statements.every((s) => !/^ALTER TABLE/i.test(s.trim())), 'no non-idempotent ALTER in a migration that is re-applied on every deploy');
  // Re-applying everything twice must be a no-op (the deploy does exactly that).
  const sqlite = new DatabaseSync(':memory:');
  for (const statement of statements) sqlite.exec(statement);
  for (const statement of statements) sqlite.exec(statement);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'whatsapp_reply_metrics'").get().n, 1);
});
