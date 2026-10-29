import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createAgentHost } from '../src/agent/index.js';

const TOKEN = 'memory-route-test-token-with-32-characters';
const config = {
  nodeEnv: 'test',
  apiToken: TOKEN,
  encryptionKey: Buffer.alloc(32, 9).toString('base64'),
  userId: 'owner',
  google: { clientId: '', clientSecret: '', redirectUri: 'http://localhost:3000/auth/google/callback' },
  whatsapp: { verifyToken: '', appSecret: '', accessToken: '', phoneNumberId: '', apiVersion: '', autoReplyEnabled: false }
};
const auth = { authorization: `Bearer ${TOKEN}` };
const jsonAuth = { ...auth, 'content-type': 'application/json' };

async function startApp() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-agent-memory-routes-'));
  const agentHost = createAgentHost({
    config,
    env: { CELIA_AGENT_RUNTIME: 'sqlite', CELIA_AGENT_SQLITE_PATH: path.join(directory, 'agent.sqlite3') },
    statusProvider: () => ({ version: '0.2.1', storage: 'test' }),
    logger: { error() {} }
  });
  const server = createApp({ pool: { execute: async () => [[]] }, config, agentHost }).listen(0);
  const baseUrl = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  return {
    baseUrl,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      const runtime = await agentHost.get().catch(() => null);
      await runtime?.shutdown?.().catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('MEM-05: GET/DELETE /api/agent/memory expose only durable owner memory and record deletion', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const threadResponse = await fetch(`${app.baseUrl}/api/agent/threads`, {
    method: 'POST', headers: jsonAuth, body: JSON.stringify({ title: 'HTTP memory' })
  });
  assert.equal(threadResponse.status, 201);
  const { thread } = await threadResponse.json();
  const runResponse = await fetch(`${app.baseUrl}/api/agent/threads/${thread.id}/runs`, {
    method: 'POST', headers: jsonAuth,
    body: JSON.stringify({ message: 'جهّز خطة أسبوعية وراجع حالة النظام', clientMessageId: 'memory-http-0001' })
  });
  assert.equal(runResponse.status, 202);
  const { runId } = await runResponse.json();
  let detail;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    detail = await (await fetch(`${app.baseUrl}/api/agent/runs/${runId}`, { headers: auth })).json();
    if (detail.run?.status === 'succeeded') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(detail.run.status, 'succeeded');

  const memoryResponse = await fetch(`${app.baseUrl}/api/agent/memory`, { headers: auth });
  assert.equal(memoryResponse.status, 200);
  const memory = await memoryResponse.json();
  assert.equal(memory.summaries.length, 1);
  assert.ok(memory.facts.length >= 2);
  const summary = memory.summaries[0];
  const itemResponse = await fetch(`${app.baseUrl}/api/agent/memory?kind=summary&id=${summary.id}`, { headers: auth });
  assert.equal(itemResponse.status, 200);
  assert.equal((await itemResponse.json()).id, summary.id);

  const deletedResponse = await fetch(`${app.baseUrl}/api/agent/memory`, {
    method: 'DELETE', headers: jsonAuth, body: JSON.stringify({ kind: 'summary', id: summary.id })
  });
  assert.equal(deletedResponse.status, 200);
  assert.equal((await deletedResponse.json()).deleted, true);
  assert.equal((await fetch(`${app.baseUrl}/api/agent/memory?kind=summary&id=${summary.id}`, { headers: auth })).status, 404);
  const after = await (await fetch(`${app.baseUrl}/api/agent/memory`, { headers: auth })).json();
  assert.equal(after.summaries.length, 0);
  const finalDetail = await (await fetch(`${app.baseUrl}/api/agent/runs/${runId}`, { headers: auth })).json();
  assert.ok(finalDetail.evidence.some((entry) => entry.kind === 'memory_deleted'));
  assert.equal(finalDetail.evidenceChain.ok, true);
  assert.equal((await fetch(`${app.baseUrl}/api/agent/memory`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
});
