import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createAgentHost } from '../src/agent/index.js';
import { createKnowledgeHost } from '../src/knowledge/index.js';
import { ingestDirectory } from '../src/knowledge/ingest.js';

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
const registryDir = path.resolve(import.meta.dirname, '..', 'data', 'kb');

async function startApp(env, { seed = true } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-kb-routes-'));
  const kbPath = path.join(directory, 'knowledge.sqlite3');
  const fullEnv = { ...env, CELIA_KB_SQLITE_PATH: undefined, CELIA_KB_PATH: kbPath };
  const kbHost = createKnowledgeHost({ env: fullEnv, nodeEnv: 'test' });
  if (seed) {
    const store = await kbHost.store();
    await ingestDirectory({ store, directory: registryDir, dryRun: false, full: true });
  }
  const agentHost = createAgentHost({
    config,
    env: { CELIA_AGENT_RUNTIME: 'sqlite', CELIA_AGENT_SQLITE_PATH: path.join(directory, 'agent.sqlite3'), ...env },
    statusProvider: async () => ({ version: '0.2.1', storage: 'test' }),
    kbHost,
    logger: { error() {} }
  });
  const server = createApp({ pool, config, agentHost, kbHost }).listen(0);
  const baseUrl = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  return {
    baseUrl,
    kbHost,
    agentHost,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      const runtime = await agentHost.get().catch(() => null);
      await runtime?.shutdown?.().catch(() => {});
      try {
        (await kbHost.store()).close();
      } catch {
        /* not opened */
      }
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('kb routes: disabled by default, owner-guarded, and explicit about what is missing', async (t) => {
  const app = await startApp({ CELIA_KB: 'off' }, { seed: false });
  t.after(() => app.close());
  assert.equal((await fetch(`${app.baseUrl}/api/kb/status`)).status, 401);
  const status = await (await fetch(`${app.baseUrl}/api/kb/status`, { headers: auth })).json();
  assert.equal(status.enabled, false);
  assert.equal(status.reason, 'knowledge_disabled');
  const search = await fetch(`${app.baseUrl}/api/kb/search`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'جوجل' })
  });
  assert.equal(search.status, 503);
  assert.equal((await search.json()).error, 'knowledge_disabled');
});

test('kb routes: search returns evidence with licence and validates input strictly', async (t) => {
  const app = await startApp({ CELIA_KB: 'sqlite' });
  t.after(() => app.close());
  const status = await (await fetch(`${app.baseUrl}/api/kb/status`, { headers: auth })).json();
  assert.equal(status.enabled, true);
  assert.ok(status.stats.items >= 50);
  assert.equal(status.durability.persistent, false, 'a bare file store is not claimed to be persistent in production');

  const ok = await fetch(`${app.baseUrl}/api/kb/search`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'كيف أربط جوجل', limit: 3 })
  });
  const body = await ok.json();
  assert.equal(ok.status, 200);
  assert.ok(body.items.length > 0);
  assert.ok(body.items.every((item) => item.licence && item.uri));
  assert.equal(ok.headers.get('cache-control'), 'no-store');

  for (const payload of [{}, { query: '' }, { query: 'x'.repeat(501) }, { query: 'جوجل', limit: 99 }, { query: 'جوجل', maxChars: 10 }]) {
    const response = await fetch(`${app.baseUrl}/api/kb/search`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    assert.ok([400, 413].includes(response.status), `payload ${JSON.stringify(payload)} → ${response.status}`);
  }
});

test('kb routes: entities, detail, stale and export are all read-only', async (t) => {
  const app = await startApp({ CELIA_KB: 'sqlite' });
  t.after(() => app.close());
  const entities = await (await fetch(`${app.baseUrl}/api/kb/entities?type=tool&limit=5`, { headers: auth })).json();
  assert.ok(entities.entities.length > 0);
  assert.equal((await fetch(`${app.baseUrl}/api/kb/entities?type=banana`, { headers: auth })).status, 400);

  const detail = await (await fetch(`${app.baseUrl}/api/kb/entities/tool/google_calendar_events_create`, { headers: auth })).json();
  assert.equal(detail.entity.risk, 'external_effect');
  assert.equal(detail.entity.requiresApproval, true);
  assert.equal((await fetch(`${app.baseUrl}/api/kb/entities/tool/nope`, { headers: auth })).status, 404);

  const stale = await (await fetch(`${app.baseUrl}/api/kb/stale?days=1`, { headers: auth })).json();
  assert.ok(Array.isArray(stale.items));
  assert.equal((await fetch(`${app.baseUrl}/api/kb/stale?days=0`, { headers: auth })).status, 400);

  const exported = await fetch(`${app.baseUrl}/api/kb/export`, { headers: auth });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type'), /ndjson/);
  const lines = (await exported.text()).trim().split('\n');
  assert.ok(lines.length > 50);
  assert.equal(JSON.parse(lines[0]).recordType, 'manifest');
});

test('kb routes: remote import is refused unless explicitly enabled for a disposable host', async (t) => {
  const app = await startApp({ CELIA_KB: 'sqlite' }, { seed: false });
  t.after(() => app.close());
  const refused = await fetch(`${app.baseUrl}/api/kb/import`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ apply: false })
  });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error, 'remote_import_disabled');
});

test('agent + knowledge: an Arabic task is answered with cited evidence from the local index', async (t) => {
  const app = await startApp({ CELIA_KB: 'sqlite', CELIA_AGENT_RUNTIME: 'sqlite' });
  t.after(() => app.close());
  const { thread } = await (
    await fetch(`${app.baseUrl}/api/agent/threads`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'معرفة' })
    })
  ).json();
  const started = await (
    await fetch(`${app.baseUrl}/api/agent/threads/${thread.id}/runs`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'كيف أربط جوجل في النظام؟', clientMessageId: 'kb-agent-0001' })
    })
  ).json();
  let detail;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    detail = await (await fetch(`${app.baseUrl}/api/agent/runs/${started.runId}`, { headers: auth })).json();
    if (!['queued', 'running'].includes(detail.run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(detail.run.status, 'succeeded');
  const kbStep = detail.steps.find((step) => step.toolName === 'kb.search');
  assert.ok(kbStep, 'the loop consulted the knowledge index');
  const delivery = detail.steps.at(-1).summary;
  assert.match(delivery, /أدلة من شبكة المعرفة/);
  assert.match(delivery, /https:\/\//, 'citations are absolute URLs');
  const toolRuns = detail.toolRuns.map((toolRun) => toolRun.toolName);
  assert.ok(toolRuns.includes('kb.search'));
  assert.equal(detail.toolRuns.every((toolRun) => toolRun.risk === 'read' || toolRun.risk === 'internal_write'), true);
});

test('agent + knowledge: no knowledge means no kb tools and no invented citations', async (t) => {
  const app = await startApp({ CELIA_KB: 'off', CELIA_AGENT_RUNTIME: 'sqlite' }, { seed: false });
  t.after(() => app.close());
  const status = await (await fetch(`${app.baseUrl}/api/agent/status`, { headers: auth })).json();
  assert.equal(status.tools.some((tool) => tool.name.startsWith('kb.')), false);
  assert.equal(status.planner, 'demo-deterministic');
  const { thread } = await (
    await fetch(`${app.baseUrl}/api/agent/threads`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'بدون معرفة' })
    })
  ).json();
  const started = await (
    await fetch(`${app.baseUrl}/api/agent/threads/${thread.id}/runs`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'ما هي شبكة المعرفة؟', clientMessageId: 'kb-agent-0002' })
    })
  ).json();
  let detail;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    detail = await (await fetch(`${app.baseUrl}/api/agent/runs/${started.runId}`, { headers: auth })).json();
    if (!['queued', 'running'].includes(detail.run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(detail.run.status, 'succeeded');
  assert.equal(detail.toolRuns.some((toolRun) => toolRun.toolName === 'kb.search'), false);
  assert.doesNotMatch(detail.steps.at(-1).summary, /أدلة من شبكة المعرفة|https:\/\//);
});
