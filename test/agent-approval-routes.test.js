import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createAgentHost } from '../src/agent/index.js';
import { createFakeCalendar } from './support/agent-fixtures.js';

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

async function startApp(env, { connectors = null } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-approval-routes-'));
  const agentHost = createAgentHost({
    config,
    env: { ...env, CELIA_AGENT_SQLITE_PATH: path.join(directory, 'agent.sqlite3') },
    statusProvider: () => ({ version: '0.2.1', storage: 'test' }),
    connectors,
    logger: { error() {} }
  });
  const server = createApp({ pool, config, agentHost }).listen(0);
  const baseUrl = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  return {
    baseUrl,
    agentHost,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      const runtime = await agentHost.get().catch(() => null);
      await runtime?.shutdown?.().catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

async function waitForStatus(app, runId, statuses) {
  let detail;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    detail = await (await fetch(`${app.baseUrl}/api/agent/runs/${runId}`, { headers: auth })).json();
    if (statuses.includes(detail.run.status)) return detail;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return detail;
}

async function parkedCalendarRun(app) {
  const { thread } = await (
    await fetch(`${app.baseUrl}/api/agent/threads`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'موافقات HTTP' })
    })
  ).json();
  const started = await (
    await fetch(`${app.baseUrl}/api/agent/threads/${thread.id}/runs`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'أنشئ موعد اجتماع الأسبوع القادم', clientMessageId: `http-approval-${Date.now()}` })
    })
  ).json();
  const detail = await waitForStatus(app, started.runId, ['waiting_approval']);
  assert.equal(detail.run.status, 'waiting_approval');
  return { runId: started.runId, detail };
}

test('approval routes: full approve flow resumes the run and exposes contract, approvals, outbox, evidence and verdict', async (t) => {
  const calendar = createFakeCalendar();
  const app = await startApp({ CELIA_AGENT_RUNTIME: 'sqlite' }, { connectors: calendar.connectors });
  t.after(() => app.close());

  const { runId, detail } = await parkedCalendarRun(app);
  assert.ok(detail.goalContract, 'the run detail carries the goal contract');
  assert.equal(detail.goalContract.objective, 'أنشئ موعد اجتماع الأسبوع القادم');
  assert.equal(detail.approvals[0].decision, 'pending');
  assert.ok(detail.evidence.some((entry) => entry.kind === 'goal_contract'));
  assert.equal(detail.evidenceChain.ok, true);

  const approvalsResponse = await fetch(`${app.baseUrl}/api/agent/runs/${runId}/approvals`, { headers: auth });
  assert.equal(approvalsResponse.status, 200);
  assert.equal((await approvalsResponse.json()).approvals[0].decision, 'pending');

  const parkedOutbox = await (await fetch(`${app.baseUrl}/api/agent/runs/${runId}/outbox`, { headers: auth })).json();
  assert.equal(parkedOutbox.outbox.length, 1);
  assert.equal(parkedOutbox.outbox[0].status, 'pending');
  assert.equal(calendar.sends.length, 0, 'nothing is sent while the approval is pending');

  const first = await fetch(`${app.baseUrl}/api/agent/runs/${runId}/approval`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'approval-decision-001' },
    body: JSON.stringify({ decision: 'approved', note: 'موافقة عبر HTTP' })
  });
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.resumed, true);
  assert.equal(body.approvals[0].decision, 'approved');

  // Idempotent retry with the same key returns the same decision instead of conflicting.
  const retry = await fetch(`${app.baseUrl}/api/agent/runs/${runId}/approval`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'approval-decision-001' },
    body: JSON.stringify({ decision: 'approved', note: 'موافقة عبر HTTP' })
  });
  assert.equal(retry.status, 200);

  const completed = await waitForStatus(app, runId, ['succeeded', 'failed', 'cancelled']);
  assert.equal(completed.run.status, 'succeeded');
  assert.equal(completed.verification.verdict, 'PASS');
  assert.ok(completed.evidence.some((entry) => entry.kind === 'verification'));
  assert.ok(completed.evidence.some((entry) => entry.kind === 'approval' && entry.verdict === 'PASS'));
  assert.equal(completed.evidenceChain.ok, true);

  const sentOutbox = await (await fetch(`${app.baseUrl}/api/agent/runs/${runId}/outbox`, { headers: auth })).json();
  assert.equal(sentOutbox.outbox.length, 1, 'one intent, never duplicated by the retry');
  assert.equal(sentOutbox.outbox[0].status, 'sent');
  assert.equal(sentOutbox.outbox[0].attempts, 1);
  assert.equal(calendar.sends.length, 1, 'an idempotent HTTP retry must not send twice');
});

test('approval routes: rejection cancels the run without any tool invocation', async (t) => {
  const app = await startApp({ CELIA_AGENT_RUNTIME: 'sqlite' });
  t.after(() => app.close());
  const { runId } = await parkedCalendarRun(app);

  const response = await fetch(`${app.baseUrl}/api/agent/runs/${runId}/approval`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'rejected', note: 'ليس الآن' })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.run.status, 'cancelled');
  assert.equal(body.resumed, false);

  const detail = await (await fetch(`${app.baseUrl}/api/agent/runs/${runId}`, { headers: auth })).json();
  assert.equal(detail.run.status, 'cancelled');
  assert.equal(detail.approvals[0].decision, 'rejected');
  // Internal reads may have run; no external-effect invocation may exist after rejection.
  assert.equal(detail.toolRuns.some((toolRun) => toolRun.risk !== 'read'), false);
  assert.equal(detail.toolRuns.some((toolRun) => toolRun.toolName === 'google.calendar_create_event'), false);
  assert.ok(detail.evidence.some((entry) => entry.kind === 'approval' && entry.verdict === 'BLOCK'));
});

test('approval routes: validation, ownership and state guards return explicit errors', async (t) => {
  const app = await startApp({ CELIA_AGENT_RUNTIME: 'sqlite' });
  t.after(() => app.close());
  const { runId } = await parkedCalendarRun(app);

  const badDecision = await fetch(`${app.baseUrl}/api/agent/runs/${runId}/approval`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'maybe' })
  });
  assert.equal(badDecision.status, 400);
  assert.equal((await badDecision.json()).error, 'invalid_approval_decision');

  const badKey = await fetch(`${app.baseUrl}/api/agent/runs/${runId}/approval`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approved', idempotencyKey: 'x' })
  });
  assert.equal(badKey.status, 400);

  const missing = await fetch(`${app.baseUrl}/api/agent/runs/nonexistent-run/approval`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approved' })
  });
  assert.equal(missing.status, 404);

  const intruder = await fetch(`${app.baseUrl}/api/agent/runs/${runId}/approval`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-token-which-is-not-valid', 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approved' })
  });
  assert.equal(intruder.status, 401);

  // After rejection the run is terminal: a second decision conflicts.
  await fetch(`${app.baseUrl}/api/agent/runs/${runId}/approval`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'rejected' })
  });
  const conflict = await fetch(`${app.baseUrl}/api/agent/runs/${runId}/approval`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approved' })
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'run_not_waiting_approval');
});

test('approval routes: the SSE snapshot includes the contract, approvals, evidence chain and verification', async (t) => {
  const app = await startApp({ CELIA_AGENT_RUNTIME: 'sqlite' });
  t.after(() => app.close());
  const { runId } = await parkedCalendarRun(app);

  const stream = await fetch(`${app.baseUrl}/api/agent/runs/${runId}/events`, { headers: auth });
  assert.equal(stream.status, 200);
  const text = await stream.text();
  assert.match(text, /event: snapshot/);
  assert.match(text, /goalContract/);
  assert.match(text, /approvals/);
  assert.match(text, /evidenceChain/);
  assert.match(text, /waiting_approval/);
});
