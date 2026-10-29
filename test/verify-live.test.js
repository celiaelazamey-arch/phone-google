import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createAgentHost } from '../src/agent/index.js';
import { verifyLive, runCli, MANUAL_CHECKS, describeTarget } from '../scripts/verify-live.mjs';

/**
 * The live acceptance script is only worth having if it cannot be fooled: a memory
 * demo must fail it, an ideal durable service must pass it, and the owner token must
 * never appear in what it writes.
 */

const TOKEN = 'owner-token-with-at-least-32-characters-xyz';
const config = {
  nodeEnv: 'test',
  apiToken: TOKEN,
  encryptionKey: Buffer.alloc(32, 7).toString('base64'),
  userId: 'owner',
  google: { clientId: '', clientSecret: '', redirectUri: 'http://localhost:3000/auth/google/callback' },
  whatsapp: { verifyToken: '', appSecret: '', accessToken: '', phoneNumberId: '', apiVersion: '', autoReplyEnabled: false }
};

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('verify:live — the real app on an explicit memory demo with the agent off never passes', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-verify-live-'));
  const pool = { isMemory: true, query: async () => [[{ 1: 1 }]], execute: async () => [[]] };
  const agentHost = createAgentHost({
    config,
    env: { CELIA_AGENT_SQLITE_PATH: path.join(directory, 'agent.sqlite3') },
    statusProvider: () => ({ version: '0.2.1' }),
    logger: { error() {} }
  });
  const server = createApp({ pool, config, agentHost }).listen(0, '127.0.0.1');
  const baseUrl = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });

  const report = await verifyLive({ url: baseUrl, token: TOKEN, allowHttp: true, samples: 2, expectVersion: '0.2.1' });
  const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
  assert.equal(report.verdict, 'fail');
  assert.equal(byId.reachable.status, 'pass');
  assert.equal(byId.version.status, 'pass', 'version parity holds even when storage does not');
  assert.equal(byId.ready_durable.status, 'fail');
  assert.equal(byId.ready_durable.detail.storage.mode, 'memory');
  assert.equal(byId.agent_auth_gate.status, 'pass', 'the 401 gate is checked without any token');
  assert.equal(byId.agent_status.status, 'fail');
  assert.equal(byId.agent_status.detail.enabled, false);
  assert.equal(JSON.stringify(report).includes(TOKEN), false, 'the owner token never enters the report');
  assert.equal(report.target.origin, baseUrl);
  assert.equal(report.manual.length, MANUAL_CHECKS.length);
});

test('verify:live — an ideal durable service passes, and the report says what stays manual', async (t) => {
  let tokenSeen = null;
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/healthz') return send(200, { status: 'ok' });
    if (req.url === '/version') return send(200, { version: '0.2.1', commit: 'a'.repeat(40), database: { schema: 1 } });
    if (req.url === '/readyz') return send(200, { ready: true, storage: { mode: 'mysql', durable: true, available: true, explicitDemo: false } });
    if (req.url === '/api/agent/status') {
      tokenSeen = req.headers.authorization || null;
      if (tokenSeen !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
      return send(200, {
        enabled: true,
        mode: 'mysql',
        dialect: 'mysql',
        durable: true,
        planner: 'demo-deterministic',
        connectors: [],
        bootRecovery: { policy: 'resume', last: { performed: true, at: '2026-10-27T18:00:00.000Z' } }
      });
    }
    return send(404, { error: 'not_found' });
  });
  const baseUrl = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const report = await verifyLive({
    url: `${baseUrl}/ignored/path?x=1`,
    token: TOKEN,
    allowHttp: true,
    expectVersion: '0.2.1',
    expectCommit: 'A'.repeat(40),
    samples: 3
  });
  assert.equal(report.verdict, 'pass', JSON.stringify(report.checks.filter((check) => check.status !== 'pass')));
  const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
  assert.equal(byId.wake_latency.detail.samples, 3);
  assert.equal(byId.agent_status.detail.bootRecovery.policy, 'resume');
  assert.equal(byId.agent_status.detail.dialect, 'mysql');
  assert.equal(tokenSeen, `Bearer ${TOKEN}`, 'the token is used for the request itself');
  assert.equal(JSON.stringify(report).includes(TOKEN), false);
  assert.deepEqual(report.target, describeTarget(baseUrl), 'only the origin is recorded — no path or query');
  assert.ok(report.manual.some((item) => item.id === 'restart_persistence'));
  assert.ok(report.manual.some((item) => item.id === 'monthly_quota'));
  assert.doesNotMatch(report.note, /24\/7/);

  // Without a token the owner check is skipped, not faked.
  const anonymous = await verifyLive({ url: baseUrl, allowHttp: true, expectVersion: '0.2.1' });
  assert.equal(anonymous.verdict, 'pass');
  assert.equal(anonymous.checks.find((check) => check.id === 'agent_status').status, 'skipped');

  // A commit mismatch is a failure: the deployed thing is not the reviewed thing.
  const wrongCommit = await verifyLive({ url: baseUrl, allowHttp: true, expectVersion: '0.2.1', expectCommit: 'b'.repeat(40) });
  assert.equal(wrongCommit.checks.find((check) => check.id === 'version').status, 'fail');

  // A slow first byte is reported as a sleeping service, not hidden. The clock is
  // injected so the verdict does not depend on how fast the loopback happens to be.
  let fakeNow = 0;
  const slow = await verifyLive({
    url: baseUrl,
    allowHttp: true,
    expectVersion: '0.2.1',
    maxFirstMs: 10,
    now: () => (fakeNow += 50)
  });
  const wake = slow.checks.find((check) => check.id === 'wake_latency');
  assert.equal(wake.status, 'fail');
  assert.equal(wake.detail.firstMs, 50);
});

test('verify:live --mode edge — the governed-scheduler check cannot be satisfied by a missing outbox table, and is skipped without the owner token', async (t) => {
  let cronAuth = null;
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/healthz') return send(200, { status: 'ok' });
    if (req.url === '/version') return send(200, { version: '0.2.1', commit: 'b'.repeat(40), database: { schema: 1 } });
    if (req.url === '/readyz') {
      return send(200, { ready: true, storage: { mode: 'd1', durable: true }, capabilities: { mcp: true, googleOAuth: true, whatsappWebhook: true } });
    }
    if (req.url === '/mcp') return send(401, { error: 'unauthorized' });
    if (req.url === '/api/cron/status') {
      cronAuth = req.headers.authorization || null;
      if (cronAuth !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
      // Deployed code is right, but the 0003 migration never ran: the worker says so instead of pretending.
      return send(200, {
        ok: true,
        mode: 'governed-scheduler',
        writes: 'outbox-approval-only',
        durable: true,
        decision: 'DEC-042',
        outbox: { error: 'outbox_unavailable', detail: 'no such table: edge_cron_outbox' }
      });
    }
    return send(404, { error: 'not_found' });
  });
  const baseUrl = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const withToken = await verifyLive({ url: baseUrl, mode: 'edge', token: TOKEN, allowHttp: true, samples: 1 });
  const governed = withToken.checks.find((check) => check.id === 'edge_cron_governed');
  assert.equal(governed.status, 'fail');
  assert.equal(governed.detail.writes, 'outbox-approval-only');
  assert.equal(governed.detail.outbox.error, 'outbox_unavailable');
  assert.equal(withToken.verdict, 'fail');
  assert.equal(cronAuth, `Bearer ${TOKEN}`);
  assert.equal(JSON.stringify(withToken).includes(TOKEN), false, 'the owner token never appears in the report');

  const anonymous = await verifyLive({ url: baseUrl, mode: 'edge', allowHttp: true, samples: 1 });
  assert.equal(anonymous.checks.find((check) => check.id === 'edge_cron_governed').status, 'skipped');
});

test('verify:live — https is required unless explicitly relaxed, and credentials in the URL are refused', async () => {
  const insecure = await verifyLive({ url: 'http://example.invalid' });
  assert.equal(insecure.verdict, 'fail');
  assert.equal(insecure.checks[0].detail.reason, 'https_required');
  const leaky = await verifyLive({ url: 'https://user:pass@example.invalid', allowHttp: true });
  assert.equal(leaky.checks[0].detail.reason, 'credentials_in_url');
  const garbage = await verifyLive({ url: 'not a url' });
  assert.equal(garbage.checks[0].detail.reason, 'invalid_url');
  assert.equal(garbage.target, null);
});

test('verify:live — an unreachable host fails fast with a reason, never with a stack trace in the report', async () => {
  const unreachable = await verifyLive({ url: 'http://127.0.0.1:9', allowHttp: true, timeoutMs: 2000 });
  assert.equal(unreachable.verdict, 'fail');
  const reachable = unreachable.checks.find((check) => check.id === 'reachable');
  assert.equal(reachable.status, 'fail');
  assert.ok(['unreachable', 'timeout'].includes(reachable.detail.reason));
  assert.equal(JSON.stringify(unreachable).includes('    at '), false);
});

test('verify:live CLI — writes a sanitized report, exits 1 on failure and refuses to run without a URL', async (t) => {
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/readyz') return send(200, { ready: true, storage: { mode: 'memory', durable: false, available: true } });
    if (req.url === '/version') return send(200, { version: '0.2.1', commit: null });
    if (req.url === '/api/agent/status') return send(401, { error: 'unauthorized' });
    return send(200, {});
  });
  const baseUrl = await listen(server);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-verify-live-cli-'));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const out = path.join(directory, 'report.json');
  const chunks = { stdout: '', stderr: '' };
  const streams = { stdout: { write: (text) => (chunks.stdout += text) }, stderr: { write: (text) => (chunks.stderr += text) } };

  const code = await runCli(['--url', baseUrl, '--allow-http', '--out', out, '--samples', '1'], { env: { CELIA_MCP_API_TOKEN: TOKEN }, ...streams });
  assert.equal(code, 1, 'a memory store fails the acceptance');
  const written = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(written.kind, 'celia-live-acceptance');
  assert.equal(written.verdict, 'fail');
  assert.equal(JSON.stringify(written).includes(TOKEN), false);
  assert.match(chunks.stderr, /FAIL — \d+ pass, \d+ fail/);
  assert.equal(chunks.stdout.includes('::error'), false, 'no workflow commands outside GitHub Actions');

  // On GitHub Actions each failed check is named on the run summary (WP-1.4): the red Edge runs had no such line.
  const gha = { stdout: '', stderr: '' };
  const ghaStreams = { stdout: { write: (text) => (gha.stdout += text) }, stderr: { write: (text) => (gha.stderr += text) } };
  const ghaCode = await runCli(['--url', baseUrl, '--allow-http', '--out', out, '--samples', '1'], { env: { CELIA_MCP_API_TOKEN: TOKEN, GITHUB_ACTIONS: 'true' }, ...ghaStreams });
  assert.equal(ghaCode, 1);
  assert.match(gha.stdout, /^::error title=verify-live ready_durable::ready_durable/m);
  assert.equal(gha.stdout.includes(TOKEN), false);

  const usage = await runCli([], { env: {}, ...streams });
  assert.equal(usage, 2);
  assert.match(chunks.stderr, /Usage: npm run verify:live/);
  const unknown = await runCli(['--bogus'], { env: {}, ...streams });
  assert.equal(unknown, 2);
});

test('verify:live --mode edge — D1 latency is a measured series (min/median/max from N consecutive /readyz probes) and the truncated-reply ratio is read, not assumed (WP-1.4)', async (t) => {
  const latencies = [130, 1400, 150, 160, 140];
  let readyCalls = 0;
  let metricsAuth = null;
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/healthz') return send(200, { status: 'ok' });
    if (req.url === '/version') return send(200, { version: '0.2.1', commit: 'c'.repeat(40) });
    if (req.url === '/readyz') {
      readyCalls += 1;
      // The first probe belongs to ready_durable; the series starts after it.
      const latencyMs = readyCalls === 1 ? 999 : latencies[(readyCalls - 2) % latencies.length];
      return send(200, { ready: true, storage: { mode: 'd1', durable: true, latencyMs }, capabilities: { mcp: true, googleOAuth: true, whatsappWebhook: true } });
    }
    if (req.url === '/mcp') {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
      return send(200, { jsonrpc: '2.0', id: 1, result: { tools: Array.from({ length: 12 }, (_, i) => ({ name: `tool_${i}` })) } });
    }
    if (req.url === '/api/cron/status') {
      return send(200, { ok: true, mode: 'governed-scheduler', writes: 'outbox-approval-only', durable: true, decision: 'DEC-042', outbox: { pending: 0 } });
    }
    if (req.url.startsWith('/api/whatsapp/reply-metrics')) {
      metricsAuth = req.headers.authorization || null;
      if (metricsAuth !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
      return send(200, {
        ok: true, since: '2026-09-29T00:00:00.000Z', windowDays: 30, replies: 40, truncated: 6, truncatedRatio: 0.15,
        byReason: { max_tokens: 5, char_cap: 1 }, byProvider: [{ provider: 'gemini', source: 'webhook', replies: 40, truncated: 6, truncatedRatio: 0.15 }],
        maxCandidateChars: 1180, lastAt: '2026-10-29T07:00:00.000Z', maxOutputTokens: 220, charCap: 1000, decision: 'DEC-050'
      });
    }
    return send(404, { error: 'not_found' });
  });
  const baseUrl = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const report = await verifyLive({ url: baseUrl, mode: 'edge', token: TOKEN, allowHttp: true, samples: 1, d1Samples: 5, expectVersion: '0.2.1' });
  const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
  assert.equal(report.verdict, 'pass', JSON.stringify(report.checks.filter((c) => c.status === 'fail')));
  assert.equal(byId.d1_latency_series.status, 'pass');
  assert.deepEqual(byId.d1_latency_series.detail.latencyMs, latencies, 'the series is reported as measured, in order');
  assert.equal(byId.d1_latency_series.detail.samples, 5);
  assert.equal(byId.d1_latency_series.detail.minMs, 130);
  assert.equal(byId.d1_latency_series.detail.medianMs, 150);
  assert.equal(byId.d1_latency_series.detail.maxMs, 1400);
  assert.equal(byId.d1_latency_series.detail.spreadRatio, 9.33, 'max/median names the 130→1400 variance instead of hiding it in one number');
  assert.equal(typeof byId.d1_latency_series.detail.roundTrip.medianMs, 'number');
  assert.equal(readyCalls, 6, 'one ready_durable probe + five series probes');

  assert.equal(byId.edge_reply_metrics.status, 'pass');
  assert.equal(metricsAuth, `Bearer ${TOKEN}`);
  assert.equal(byId.edge_reply_metrics.detail.replies, 40);
  assert.equal(byId.edge_reply_metrics.detail.truncated, 6);
  assert.equal(byId.edge_reply_metrics.detail.truncatedRatio, 0.15);
  assert.deepEqual(byId.edge_reply_metrics.detail.byReason, { max_tokens: 5, char_cap: 1 });
  assert.equal(byId.edge_reply_metrics.detail.maxOutputTokens, 220);
  assert.equal(JSON.stringify(report).includes(TOKEN), false, 'the owner token never enters the report');

  // Without the token both owner-gated checks are skipped (never silently passed); the series still runs.
  const anonymous = await verifyLive({ url: baseUrl, mode: 'edge', allowHttp: true, samples: 1, d1Samples: 2, expectVersion: '0.2.1' });
  const anonById = Object.fromEntries(anonymous.checks.map((check) => [check.id, check]));
  assert.equal(anonById.edge_reply_metrics.status, 'skipped');
  assert.equal(anonById.edge_cron_governed.status, 'skipped');
  assert.equal(anonById.d1_latency_series.detail.samples, 2);
  assert.equal(anonymous.verdict, 'pass');
});

test('verify:live --mode edge — a worker that does not report latency, or old code without the metrics route, fails the WP-1.4 checks with a named reason', async (t) => {
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/healthz') return send(200, { status: 'ok' });
    if (req.url === '/version') return send(200, { version: '0.2.1', commit: 'd'.repeat(40) });
    if (req.url === '/readyz') return send(200, { ready: true, storage: { mode: 'd1', durable: true }, capabilities: { mcp: true, googleOAuth: true, whatsappWebhook: true } });
    if (req.url === '/mcp') return send(401, { error: 'unauthorized' });
    if (req.url === '/api/cron/status') {
      return send(200, { ok: true, mode: 'governed-scheduler', writes: 'outbox-approval-only', durable: true, decision: 'DEC-042', outbox: { pending: 0 } });
    }
    return send(404, { error: 'not_found' });
  });
  const baseUrl = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const report = await verifyLive({ url: baseUrl, mode: 'edge', token: TOKEN, allowHttp: true, samples: 1, d1Samples: 3, expectVersion: '0.2.1' });
  const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
  assert.equal(report.verdict, 'fail');
  assert.equal(byId.ready_durable.status, 'pass', 'durability itself is fine');
  assert.equal(byId.d1_latency_series.status, 'fail');
  assert.equal(byId.d1_latency_series.detail.reason, 'latency_not_reported');
  assert.deepEqual(byId.d1_latency_series.detail.latencyMs, [null, null, null]);
  assert.equal(byId.edge_reply_metrics.status, 'fail');
  assert.equal(byId.edge_reply_metrics.detail.httpStatus, 404);
  assert.equal(byId.edge_reply_metrics.detail.reason, 'not_found');
});
