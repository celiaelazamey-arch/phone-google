import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createAgentHost } from '../src/agent/index.js';

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

async function startApp(env) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-agent-routes-'));
  const agentHost = createAgentHost({
    config,
    env: { ...env, CELIA_AGENT_SQLITE_PATH: path.join(directory, 'agent.sqlite3') },
    statusProvider: () => ({ version: '0.2.1', storage: 'test' }),
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
      runtime?.store.close?.();
      await runtime?.shutdown?.().catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('agent routes: disabled by default and never silently enabled', async (t) => {
  const app = await startApp({});
  t.after(() => app.close());
  const status = await fetch(`${app.baseUrl}/api/agent/status`, { headers: auth });
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.enabled, false);
  assert.equal(body.mode, 'off');
  const run = await fetch(`${app.baseUrl}/api/agent/threads`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'x' })
  });
  assert.equal(run.status, 503);
  assert.equal((await run.json()).error, 'agent_runtime_disabled');
  assert.equal((await fetch(`${app.baseUrl}/api/agent/status`)).status, 401);
});

test('agent routes: owner can create a thread, submit once, follow steps and read the delivery', async (t) => {
  const app = await startApp({ CELIA_AGENT_RUNTIME: 'sqlite' });
  t.after(() => app.close());

  const status = await (await fetch(`${app.baseUrl}/api/agent/status`, { headers: auth })).json();
  assert.equal(status.enabled, true);
  assert.equal(status.dialect, 'sqlite');
  assert.equal(status.planner, 'demo-deterministic');

  const threadResponse = await fetch(`${app.baseUrl}/api/agent/threads`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'مهمة عبر HTTP' })
  });
  assert.equal(threadResponse.status, 201);
  const { thread } = await threadResponse.json();

  const runResponse = await fetch(`${app.baseUrl}/api/agent/threads/${thread.id}/runs`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'جهّز خطة أسبوعية وراجع حالة النظام', clientMessageId: 'http-client-001' })
  });
  assert.equal(runResponse.status, 202);
  const started = await runResponse.json();
  assert.equal(started.duplicate, false);

  const duplicate = await fetch(`${app.baseUrl}/api/agent/threads/${thread.id}/runs`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'جهّز خطة أسبوعية وراجع حالة النظام', clientMessageId: 'http-client-001' })
  });
  assert.equal(duplicate.status, 200);
  const duplicateBody = await duplicate.json();
  assert.equal(duplicateBody.runId, started.runId);
  assert.equal(duplicateBody.duplicate, true);

  let detail;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    detail = await (await fetch(`${app.baseUrl}/api/agent/runs/${started.runId}`, { headers: auth })).json();
    if (['succeeded', 'failed', 'cancelled', 'waiting_approval', 'needs_reconciliation'].includes(detail.run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(detail.run.status, 'succeeded');
  assert.ok(detail.steps.length >= 6);
  assert.match(detail.steps.at(-1).summary, /مسودة مخطط/);

  const threadDetail = await (await fetch(`${app.baseUrl}/api/agent/threads/${thread.id}`, { headers: auth })).json();
  assert.equal(threadDetail.messages.length, 1);
  assert.equal(threadDetail.runs.length, 1);

  const stream = await fetch(`${app.baseUrl}/api/agent/runs/${started.runId}/events`, { headers: auth });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const text = await stream.text();
  assert.match(text, /event: snapshot/);
  assert.match(text, /"type":"snapshot"/);
});

test('agent routes: validation and cancellation are owner-guarded and explicit', async (t) => {
  const app = await startApp({ CELIA_AGENT_RUNTIME: 'sqlite' });
  t.after(() => app.close());
  const { thread } = await (
    await fetch(`${app.baseUrl}/api/agent/threads`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'تحقق' })
    })
  ).json();

  const badKey = await fetch(`${app.baseUrl}/api/agent/threads/${thread.id}/runs`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'مرحبا', clientMessageId: 'x' })
  });
  assert.equal(badKey.status, 400);

  const empty = await fetch(`${app.baseUrl}/api/agent/threads/${thread.id}/runs`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ message: '   ' })
  });
  assert.equal(empty.status, 400);

  const missing = await fetch(`${app.baseUrl}/api/agent/runs/00000000-0000-0000-0000-000000000000`, { headers: auth });
  assert.equal(missing.status, 404);

  const started = await (
    await fetch(`${app.baseUrl}/api/agent/threads/${thread.id}/runs`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'مهمة قابلة للإلغاء', clientMessageId: 'http-cancel-001' })
    })
  ).json();
  const cancelled = await fetch(`${app.baseUrl}/api/agent/runs/${started.runId}/cancel`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(cancelled.status, 200);
  const body = await cancelled.json();
  assert.ok(['queued', 'running', 'cancelled', 'succeeded'].includes(body.run.status));
});
