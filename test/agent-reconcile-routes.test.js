import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createAgentHost } from '../src/agent/index.js';
import { RUN_STATUS, TOOL_RUN_STATUS } from '../src/agent/store.js';
import { createFakeCalendar } from './support/agent-fixtures.js';

/**
 * HTTP surface for reconciliation (G1/G5): owner-only, explicit errors, no connector.
 * The route is the only door out of `needs_reconciliation`, so its guards matter as
 * much as the runtime's.
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
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-reconcile-routes-'));
  const calendar = createFakeCalendar();
  const agentHost = createAgentHost({
    config,
    env: { CELIA_AGENT_RUNTIME: 'sqlite', CELIA_AGENT_SQLITE_PATH: path.join(directory, 'agent.sqlite3') },
    statusProvider: () => ({ version: '0.2.1', storage: 'test' }),
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

/** Seed the durable state a crashed run leaves behind: one `unknown` call, parked run. */
async function seedUnknownRun(agentHost, { clients = 'owner' } = {}) {
  const runtime = await agentHost.get();
  const store = runtime.store;
  const thread = await store.createThread({ ownerId: clients, title: 'مصالحة HTTP' });
  const { run } = await store.createRun({
    threadId: thread.id,
    ownerId: clients,
    userMessageId: null,
    clientMessageId: `seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    planner: 'test',
    maxSteps: 5,
    maxCostMicros: 1000
  });
  const { toolRun } = await store.startToolRun({
    runId: run.id,
    toolName: 'read.alpha',
    risk: 'read',
    idempotencyKey: `${run.id}:1:read.alpha`
  });
  await store.finishToolRun(toolRun.id, TOOL_RUN_STATUS.unknown, JSON.stringify({ reason: 'process_interrupted' }));
  await store.finishRun(run.id, RUN_STATUS.needsReconciliation, { error: 'outcome_unknown' });
  return { runId: run.id, toolRunId: toolRun.id };
}

function post(app, url, body, headers = {}) {
  return fetch(`${app.baseUrl}${url}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

test('reconcile route: resolves an unknown call, appends evidence and returns the remaining list', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { runId, toolRunId } = await seedUnknownRun(app.agentHost);

  const response = await post(
    app,
    `/api/agent/runs/${runId}/reconcile`,
    { target: 'tool_run', targetId: toolRunId, outcome: 'applied', externalRef: 'ref-1', note: 'تحققت' },
    { 'idempotency-key': 'reconcile-http-0001' }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.reconciliation.outcome, 'applied');
  assert.deepEqual(body.remaining, { toolRuns: [], outbox: [] });
  assert.equal(app.calendar.sends.length, 0, 'reconciliation never calls a connector');

  const detail = await (await fetch(`${app.baseUrl}/api/agent/runs/${runId}`, { headers: auth })).json();
  assert.equal(detail.evidenceChain.ok, true);
  assert.ok(detail.evidence.some((entry) => entry.kind === 'reconciliation'));
  const settled = detail.toolRuns.find((item) => item.id === toolRunId);
  assert.equal(settled.status, TOOL_RUN_STATUS.succeeded);
  assert.equal(settled.outcome.reconciled, true);

  // Replaying the same decision is idempotent at the HTTP layer too.
  const replay = await post(
    app,
    `/api/agent/runs/${runId}/reconcile`,
    { target: 'tool_run', targetId: toolRunId, outcome: 'applied', externalRef: 'ref-1', note: 'تحققت' },
    { 'idempotency-key': 'reconcile-http-0001' }
  );
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).idempotentReplay, true);
});

test('reconcile route: explicit validation errors for every bad input', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { runId, toolRunId } = await seedUnknownRun(app.agentHost);
  const url = `/api/agent/runs/${runId}/reconcile`;

  const badTarget = await post(app, url, { target: 'database', targetId: toolRunId, outcome: 'applied' });
  assert.equal(badTarget.status, 400);
  assert.equal((await badTarget.json()).error, 'invalid_reconcile_target');

  const badOutcome = await post(app, url, { target: 'tool_run', targetId: toolRunId, outcome: 'probably' });
  assert.equal(badOutcome.status, 400);
  assert.equal((await badOutcome.json()).error, 'invalid_reconcile_outcome');

  const missingTarget = await post(app, url, { target: 'tool_run', outcome: 'applied' });
  assert.equal(missingTarget.status, 400);
  assert.equal((await missingTarget.json()).error, 'reconcile_target_required');

  const badKey = await post(app, url, { target: 'tool_run', targetId: toolRunId, outcome: 'applied', idempotencyKey: 'x' });
  assert.equal(badKey.status, 400);
  assert.equal((await badKey.json()).error, 'invalid_client_message_id');

  const foreignTarget = await post(app, url, { target: 'tool_run', targetId: 'not-a-real-row', outcome: 'applied' });
  assert.equal(foreignTarget.status, 400);
  assert.equal((await foreignTarget.json()).error, 'target_not_in_run');

  const missingRun = await post(app, '/api/agent/runs/nonexistent/reconcile', {
    target: 'tool_run',
    targetId: toolRunId,
    outcome: 'applied'
  });
  assert.equal(missingRun.status, 404);

  const noAuth = await fetch(`${app.baseUrl}${url}`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-token-which-is-not-valid', 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'tool_run', targetId: toolRunId, outcome: 'applied' })
  });
  assert.equal(noAuth.status, 401);
});

test('reconcile route: a settled call is refused and the row is left untouched', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { runId, toolRunId } = await seedUnknownRun(app.agentHost);
  const url = `/api/agent/runs/${runId}/reconcile`;

  assert.equal((await post(app, url, { target: 'tool_run', targetId: toolRunId, outcome: 'applied' })).status, 200);
  const again = await post(app, url, { target: 'tool_run', targetId: toolRunId, outcome: 'not_applied' });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, 'target_not_reconcilable');

  const detail = await (await fetch(`${app.baseUrl}/api/agent/runs/${runId}`, { headers: auth })).json();
  assert.equal(detail.toolRuns.find((item) => item.id === toolRunId).status, TOOL_RUN_STATUS.succeeded);
});

test('reconcile route: a run owned by someone else reads as not found', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { runId, toolRunId } = await seedUnknownRun(app.agentHost, { clients: 'someone-else' });

  const response = await post(app, `/api/agent/runs/${runId}/reconcile`, {
    target: 'tool_run',
    targetId: toolRunId,
    outcome: 'applied'
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'run_not_found');
});
