import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createAgentHost } from '../src/agent/index.js';
import { RUN_STATUS, TOOL_RUN_STATUS } from '../src/agent/store.js';
import { OUTBOX_STATUS } from '../src/agent/outbox.js';
import { createFakeCalendar } from './support/agent-fixtures.js';

/**
 * DATA-003 — the HTTP surface of bulk reconciliation and the periodic report.
 *
 * The single `/reconcile` route keeps its own contract (one target, explicit errors, 409 on a
 * settled row). These tests are about the two routes added beside it, and about what they must
 * *not* become: a bulk endpoint that a mistaken array can turn into a table-wide write, or a report
 * that calls itself healthy because it found nothing to read.
 */

const TOKEN = 'test-token-with-at-least-32-characters';
const config = {
  nodeEnv: 'test',
  apiToken: TOKEN,
  encryptionKey: Buffer.alloc(32, 7).toString('base64'),
  userId: 'owner',
  google: { clientId: '', clientSecret: '', redirectUri: 'http://localhost:3000/auth/google/callback' },
  whatsapp: { verifyToken: '', appSecret: '', accessToken: '', phoneNumberId: '', apiVersion: '', autoReplyEnabled: false }
};
const pool = { execute: async () => [[]] };
const auth = { authorization: `Bearer ${TOKEN}` };

async function startApp() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-reconcile-batch-routes-'));
  const calendar = createFakeCalendar();
  const agentHost = createAgentHost({
    config,
    env: { CELIA_AGENT_RUNTIME: 'sqlite', CELIA_AGENT_SQLITE_PATH: path.join(directory, 'agent.sqlite3') },
    statusProvider: () => ({ version: '0.3.0', storage: 'test' }),
    connectors: calendar.connectors,
    logger: { error() {} }
  });
  const server = createApp({ pool, config, agentHost }).listen(0);
  const baseUrl = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  return {
    baseUrl,
    calendar,
    agentHost,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      const runtime = await agentHost.get().catch(() => null);
      await runtime?.shutdown?.().catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

/** A parked run with `count` ambiguous tool calls — the state a crashed process leaves behind. */
async function seedParkedRun(agentHost, { count = 3, ownerId = 'owner' } = {}) {
  const runtime = await agentHost.get();
  const store = runtime.store;
  const thread = await store.createThread({ ownerId, title: 'مصالحة جماعية HTTP' });
  const { run } = await store.createRun({
    threadId: thread.id,
    ownerId,
    userMessageId: null,
    clientMessageId: `seed-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    planner: 'test',
    maxSteps: 10,
    maxCostMicros: 10_000
  });
  const toolRunIds = [];
  for (let index = 0; index < count; index += 1) {
    const { toolRun } = await store.startToolRun({
      runId: run.id,
      toolName: `read.${index}`,
      risk: 'read',
      idempotencyKey: `${run.id}:batch:${index}`
    });
    await store.finishToolRun(toolRun.id, TOOL_RUN_STATUS.unknown, JSON.stringify({ reason: 'process_interrupted' }));
    toolRunIds.push(toolRun.id);
  }
  await store.finishRun(run.id, RUN_STATUS.needsReconciliation, { error: 'outcome_unknown' });
  return { runId: run.id, toolRunIds, store };
}

const post = (app, url, body) =>
  fetch(`${app.baseUrl}${url}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

test('batch route: settles every requested call, releases the run and keeps one evidence chain', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { runId, toolRunIds } = await seedParkedRun(app.agentHost);

  const response = await post(app, `/api/agent/runs/${runId}/reconcile-batch`, {
    target: 'tool_run',
    targetIds: toolRunIds,
    outcome: 'applied',
    externalRef: 'ref-batch',
    note: 'تحققت من الثلاثة'
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.settled, 3);
  assert.equal(body.complete, true);
  assert.deepEqual(body.remaining, { toolRuns: [], outbox: [] });
  assert.equal(body.resumed, true, 'a fully reconciled run leaves needs_reconciliation');
  assert.equal(app.calendar.sends.length, 0, 'reconciliation never calls a connector');

  const detail = await (await fetch(`${app.baseUrl}/api/agent/runs/${runId}`, { headers: auth })).json();
  assert.equal(detail.evidenceChain.ok, true);
  assert.ok(detail.evidence.some((entry) => entry.kind === 'reconciliation'));
  for (const id of toolRunIds) {
    assert.equal(detail.toolRuns.find((row) => row.id === id).status, TOOL_RUN_STATUS.succeeded);
  }
});

test('batch route: every bad input is refused by name before anything is written', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { runId, toolRunIds, store } = await seedParkedRun(app.agentHost, { count: 2 });
  const url = `/api/agent/runs/${runId}/reconcile-batch`;

  const cases = [
    [{ target: 'database', targetIds: toolRunIds, outcome: 'applied' }, 'invalid_reconcile_target'],
    [{ target: 'tool_run', targetIds: toolRunIds, outcome: 'probably' }, 'invalid_reconcile_outcome'],
    [{ target: 'tool_run', targetIds: [], outcome: 'applied' }, 'nothing_to_reconcile'],
    [{ target: 'tool_run', outcome: 'applied' }, 'nothing_to_reconcile'],
    [{ target: 'tool_run', targetIds: Array.from({ length: 51 }, (_, i) => `id-${i}`), outcome: 'applied' }, 'batch_too_large']
  ];
  for (const [body, expected] of cases) {
    const response = await post(app, url, body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal((await response.json()).error, expected);
  }

  for (const row of await store.listToolRuns(runId)) assert.equal(row.status, TOOL_RUN_STATUS.unknown);

  const noAuth = await fetch(`${app.baseUrl}${url}`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-token-which-is-not-valid', 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'tool_run', targetIds: toolRunIds, outcome: 'applied' })
  });
  assert.equal(noAuth.status, 401);
});

test('batch route: a foreign run reads as not found and its rows stay untouched', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { runId, toolRunIds, store } = await seedParkedRun(app.agentHost, { count: 2, ownerId: 'someone-else' });

  const response = await post(app, `/api/agent/runs/${runId}/reconcile-batch`, {
    target: 'tool_run',
    targetIds: toolRunIds,
    outcome: 'applied'
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'run_not_found');
  for (const row of await store.listToolRuns(runId)) assert.equal(row.status, TOOL_RUN_STATUS.unknown);
});

test('batch route: a partial batch keeps the run parked and says which rows were skipped', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { runId, toolRunIds, store } = await seedParkedRun(app.agentHost, { count: 2 });

  // Settle one row through the single path first, then ask a batch for both.
  const single = await post(app, `/api/agent/runs/${runId}/reconcile`, {
    target: 'tool_run',
    targetId: toolRunIds[0],
    outcome: 'not_applied'
  });
  assert.equal(single.status, 200);

  const response = await post(app, `/api/agent/runs/${runId}/reconcile-batch`, {
    target: 'tool_run',
    targetIds: toolRunIds,
    outcome: 'applied'
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.settled, 1);
  assert.equal(body.complete, false);
  assert.equal(body.resumed, true, 'nothing is ambiguous any more, so the run may resume');
  assert.equal(body.skipped[0].targetId, toolRunIds[0]);
  assert.equal(body.skipped[0].reason, 'already_settled');

  // The earlier human decision stands; the batch did not overwrite it.
  const rows = await store.listToolRuns(runId);
  assert.equal(rows.find((row) => row.id === toolRunIds[0]).status, TOOL_RUN_STATUS.failed);
  assert.equal(rows.find((row) => row.id === toolRunIds[1]).status, TOOL_RUN_STATUS.succeeded);
});

test('report route: answers what is still unknown, and is explicit when nothing is', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const empty = await (await fetch(`${app.baseUrl}/api/agent/reconciliation-report`, { headers: auth })).json();
  assert.equal(empty.unresolvedTotal, 0);
  assert.equal(empty.schedules, false);
  assert.equal(empty.resends, false);

  const { runId, store } = await seedParkedRun(app.agentHost, { count: 2 });
  const { entry } = await store.enqueueOutbox({
    runId,
    toolName: 'calendar.create',
    connector: 'google.calendar',
    idempotencyKey: `outbox:${runId}:report`,
    payload: { summary: 'موعد' }
  });
  await store.claimOutbox(entry.id, { leaseMs: 60_000, workerId: 'w' });
  await store.settleOutbox(entry.id, { status: OUTBOX_STATUS.unknown, lastError: 'timeout' });

  const response = await fetch(`${app.baseUrl}/api/agent/reconciliation-report?thresholdHours=1`, { headers: auth });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store', 'an owed list is never cached');
  const report = await response.json();
  assert.equal(report.unresolvedTotal, 3, 'two unknown calls and one unknown intent');
  assert.equal(report.thresholdMs, 3_600_000);
  assert.ok(report.items.every((item) => item.targetId && item.runId), 'every counted row names its run');
  assert.equal(JSON.stringify(report).includes('موعد'), false, 'no payload text leaves through the report');
  assert.match(report.digest, /^[a-f0-9]{64}$/);

  // A bad threshold is ignored rather than silently applied as zero or infinity.
  const ignored = await (await fetch(`${app.baseUrl}/api/agent/reconciliation-report?thresholdHours=nonsense`, { headers: auth })).json();
  assert.equal(ignored.thresholdMs, 6 * 3_600_000, 'the declared default stands');

  const noAuth = await fetch(`${app.baseUrl}/api/agent/reconciliation-report`);
  assert.equal(noAuth.status, 401);
});

test('the attention queue and the reconciliation report read the same durable rows', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { runId, store } = await seedParkedRun(app.agentHost, { count: 2 });
  const { entry } = await store.enqueueOutbox({
    runId,
    toolName: 'calendar.create',
    connector: 'google.calendar',
    idempotencyKey: `outbox:${runId}:shared`,
    payload: { summary: 'موعد' }
  });
  await store.claimOutbox(entry.id, { leaseMs: 60_000, workerId: 'w' });
  await store.settleOutbox(entry.id, { status: OUTBOX_STATUS.unknown, lastError: 'timeout' });

  const [queue, report] = await Promise.all([
    (await fetch(`${app.baseUrl}/api/agent/attention`, { headers: auth })).json(),
    (await fetch(`${app.baseUrl}/api/agent/reconciliation-report`, { headers: auth })).json()
  ]);

  // Two views, one truth: every owed item in the queue has a row in the report, by id.
  const ambiguous = queue.items.filter((item) => item.next === 'reconcile');
  assert.equal(ambiguous.length, 3, 'two unknown tools and one unknown intent');
  assert.equal(report.unresolvedTotal, ambiguous.length);
  const reported = new Set(report.items.map((item) => item.targetId));
  for (const item of ambiguous) {
    const id = item.evidence.toolRunId ?? item.evidence.outboxId;
    assert.ok(reported.has(id), `the report names ${id}, which the queue also owes`);
  }
  assert.equal(queue.sends, false);
  assert.equal(queue.tracksRead, false);
  assert.equal(report.resends, false);

  // Settle everything with one batch; both views go quiet without anyone marking them "read".
  await post(app, `/api/agent/runs/${runId}/reconcile-batch`, {
    target: 'tool_run',
    targetIds: (await store.listToolRuns(runId)).map((row) => row.id),
    outcome: 'applied'
  });
  await post(app, `/api/agent/runs/${runId}/reconcile-batch`, {
    target: 'outbox',
    targetIds: [entry.id],
    outcome: 'not_applied'
  });
  const [afterQueue, afterReport] = await Promise.all([
    (await fetch(`${app.baseUrl}/api/agent/attention`, { headers: auth })).json(),
    (await fetch(`${app.baseUrl}/api/agent/reconciliation-report`, { headers: auth })).json()
  ]);
  assert.equal(afterQueue.items.filter((item) => item.next === 'reconcile').length, 0);
  assert.equal(afterReport.unresolvedTotal, 0);
});
