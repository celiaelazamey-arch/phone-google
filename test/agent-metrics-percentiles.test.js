/**
 * WP-1.1 (AGENT-008, DEC-047) — durations the loop can prove, and percentiles over them.
 *
 * MET-01 toolRunDurationMs: settled rows measure; started/unknown/reconciled/invalid rows are null, never 0
 * MET-02 percentile is nearest-rank (every reported number is an observed sample); summarizeDurations shape
 * MET-03 computeAgentMetrics: per-tool and per-run distributions, unmeasured settled rows counted, mean unchanged
 * MET-04 end to end on the real SQLite store with a fake clock: tool runs and steps carry exact durations,
 *        `runtime.metrics()` reports them per tool, and nothing is estimated for steps without a tool run
 * MET-05 the owner-only HTTP surface exposes the distributions and a stranger still gets 401
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { percentile, summarizeDurations, timeSteps, toolRunDurationMs } from '../src/agent/timing.js';
import { computeAgentMetrics } from '../src/agent/evaluation.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createDefaultTools } from '../src/agent/tools.js';
import { createDemoPlanner } from '../src/agent/planner.js';
import { createApp } from '../src/app.js';
import { createAgentHost } from '../src/agent/index.js';
import { createFakeCalendar, createTempStore } from './support/agent-fixtures.js';

const T0 = Date.parse('2026-10-29T10:00:00.000Z');
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

test('MET-01 a tool run duration is proven from created_at → updated_at only for rows the runtime settled itself', () => {
  assert.equal(toolRunDurationMs({ status: 'succeeded', created_at: iso(0), updated_at: iso(1234) }), 1234, 'raw snake_case row');
  assert.equal(toolRunDurationMs({ status: 'failed', createdAt: iso(0), updatedAt: iso(80) }), 80, 'mapped camelCase row');
  assert.equal(toolRunDurationMs({ status: 'succeeded', createdAt: iso(0), updatedAt: iso(0) }), 0, 'an instant tool is 0, which is a measurement');
  assert.equal(toolRunDurationMs({ status: 'started', createdAt: iso(0), updatedAt: iso(0) }), null, 'still running → null');
  assert.equal(toolRunDurationMs({ status: 'unknown', createdAt: iso(0), updatedAt: iso(500) }), null, 'lost mid-flight → null');
  assert.equal(
    toolRunDurationMs({ status: 'succeeded', createdAt: iso(0), updatedAt: iso(3_600_000), outcome: JSON.stringify({ reconciled: true, at: iso(3_600_000) }) }),
    null,
    'a human reconciled it an hour later — that is decision latency, not tool duration'
  );
  assert.equal(toolRunDurationMs({ status: 'succeeded', createdAt: iso(0), updatedAt: iso(3_600_000), outcome: { reconciled: true } }), null, 'parsed outcome too');
  assert.equal(toolRunDurationMs({ status: 'succeeded', createdAt: iso(100), updatedAt: iso(0) }), null, 'clock went backwards → null, not negative');
  assert.equal(toolRunDurationMs({ status: 'succeeded', createdAt: 'garbage', updatedAt: iso(0) }), null);
  assert.equal(toolRunDurationMs(null), null);
});

test('MET-02 percentiles are nearest-rank samples and summaries are null when there is nothing to report', () => {
  const ten = [100, 10, 90, 20, 80, 30, 70, 40, 60, 50];
  assert.equal(percentile(ten, 50), 50);
  assert.equal(percentile(ten, 95), 100);
  assert.equal(percentile(ten, 0), 10);
  assert.equal(percentile(ten, 100), 100);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([1, Number.NaN, null, 3], 50), 1, 'non-finite entries are ignored');
  assert.deepEqual(summarizeDurations([]), { count: 0, p50Ms: null, p95Ms: null, maxMs: null });
  assert.deepEqual(summarizeDurations([30, 10, 20]), { count: 3, p50Ms: 20, p95Ms: 30, maxMs: 30 });
  assert.ok(ten.every((v) => ten.includes(percentile(ten, 50))), 'a percentile is always one of the observed values');
});

test('MET-03 computeAgentMetrics adds per-tool and per-run distributions without changing the existing mean', () => {
  const run = (id, start, end, status = 'succeeded') => ({ id, status, createdAt: iso(start), finishedAt: iso(end), usage: { costMicros: 0 } });
  const toolRun = (toolName, start, end, status = 'succeeded', outcome = null) => ({
    toolName,
    status,
    createdAt: iso(start),
    updatedAt: iso(end),
    outcome,
    durationMs: toolRunDurationMs({ status, createdAt: iso(start), updatedAt: iso(end), outcome })
  });
  const details = [
    { run: run('r1', 0, 1000), toolRuns: [toolRun('kb.search', 0, 40), toolRun('kb.search', 50, 60), toolRun('data.report', 100, 300)] },
    { run: run('r2', 0, 3000), toolRuns: [toolRun('kb.search', 0, 200), toolRun('calendar.create', 0, 900_000, 'succeeded', { reconciled: true }), toolRun('kb.search', 0, 0, 'unknown')] }
  ];
  const metrics = computeAgentMetrics(details);
  assert.equal(metrics.averageDurationMs, 2000, 'mean is unchanged');
  assert.deepEqual(metrics.durations.runs, { count: 2, p50Ms: 1000, p95Ms: 3000, maxMs: 3000 });
  assert.deepEqual(metrics.durations.tools['kb.search'], { count: 3, p50Ms: 40, p95Ms: 200, maxMs: 200 });
  assert.deepEqual(metrics.durations.tools['data.report'], { count: 1, p50Ms: 200, p95Ms: 200, maxMs: 200 });
  assert.equal(metrics.durations.tools['calendar.create'], undefined, 'a reconciled row contributes no duration');
  assert.equal(metrics.durations.unmeasuredToolRuns, 1, 'the reconciled (settled) row is counted as unmeasured; the unknown row is pending, not unmeasured');
  assert.deepEqual(Object.keys(metrics.durations.tools), ['data.report', 'kb.search'], 'tool names are sorted for stable output');
  assert.deepEqual(computeAgentMetrics([]).durations, { runs: { count: 0, p50Ms: null, p95Ms: null, maxMs: null }, tools: {}, unmeasuredToolRuns: 0 });

  const timed = timeSteps(
    [{ id: 's1', createdAt: iso(0) }, { id: 's2', createdAt: iso(10) }],
    [{ id: 't1', stepId: 's2', status: 'succeeded', createdAt: iso(10), updatedAt: iso(25) }]
  );
  assert.deepEqual(timed[0], {
    id: 's1', createdAt: iso(0), startedAt: iso(0), finishedAt: null, durationMs: null, toolRunId: null, toolRunStatus: null
  });
  assert.deepEqual(timed[1], {
    id: 's2', createdAt: iso(10), startedAt: iso(10), finishedAt: iso(25), durationMs: 15, toolRunId: 't1', toolRunStatus: 'succeeded'
  });
});

test('MET-04 end to end: a real run on SQLite under a fake clock yields exact tool durations in detail() and metrics()', async (t) => {
  // Every store/runtime clock read advances 7 ms, so a settled tool run measures a known, non-zero duration.
  let now = T0;
  const clock = () => {
    now += 7;
    return now;
  };
  const fixture = await createTempStore({ clock });
  t.after(() => fixture.cleanup());
  const calendar = createFakeCalendar();
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: createDefaultTools({ statusProvider: () => ({ version: '0.2.1', storage: 'sqlite' }) }),
    planner: createDemoPlanner(),
    connectors: calendar.connectors,
    ownerId: 'owner',
    clock,
    logger: { error() {} }
  });
  t.after(() => runtime.shutdown().catch(() => {}));

  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'قياس WP-1.1' });
  const submitted = await runtime.submit({ threadId: thread.id, message: 'استخرج بيانات الفاتورة invoice-valid-1042.csv', clientMessageId: 'met-04-run-1' });
  await runtime.runToCompletion(submitted.run.id);
  const detail = await runtime.detail(submitted.run.id);

  assert.equal(detail.run.status, 'succeeded');
  assert.ok(detail.toolRuns.length >= 3, 'the demo task runs several tools');
  for (const toolRun of detail.toolRuns) {
    assert.equal(toolRun.status, 'succeeded');
    assert.ok(Number.isInteger(toolRun.durationMs) && toolRun.durationMs > 0, `${toolRun.toolName} has a proven positive duration`);
    assert.equal(toolRun.durationMs % 7, 0, 'the duration is a multiple of the fake clock tick — measured, not invented');
  }
  const stepsWithTool = detail.steps.filter((step) => step.toolRunId);
  const stepsWithoutTool = detail.steps.filter((step) => !step.toolRunId);
  assert.ok(stepsWithTool.length >= 3 && stepsWithoutTool.length >= 1, 'both kinds of steps exist');
  for (const step of stepsWithTool) {
    const toolRun = detail.toolRuns.find((entry) => entry.id === step.toolRunId);
    assert.equal(step.durationMs, toolRun.durationMs);
    assert.equal(step.finishedAt, toolRun.updatedAt);
    assert.equal(step.startedAt, step.createdAt);
  }
  for (const step of stepsWithoutTool) {
    assert.equal(step.durationMs, null, 'a decide/deliver step is not timed: the store does not know how long it took');
    assert.equal(step.finishedAt, null);
  }

  const report = await runtime.metrics('owner');
  const { durations } = report.metrics;
  assert.equal(durations.runs.count, 1);
  assert.ok(durations.runs.p95Ms >= durations.runs.p50Ms && durations.runs.p50Ms > 0);
  const toolNames = detail.toolRuns.map((entry) => entry.toolName);
  for (const name of new Set(toolNames)) {
    const summary = durations.tools[name];
    assert.equal(summary.count, toolNames.filter((entry) => entry === name).length, `${name} sample count equals its tool runs`);
    assert.ok(summary.p50Ms > 0 && summary.p95Ms >= summary.p50Ms && summary.maxMs >= summary.p95Ms);
  }
  assert.equal(durations.unmeasuredToolRuns, 0);
});

test('MET-05 GET /api/agent/metrics exposes the distributions to the owner only', async (t) => {
  const TOKEN = 'test-token-with-at-least-32-characters';
  const config = {
    nodeEnv: 'test',
    apiToken: TOKEN,
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    userId: 'owner',
    google: { clientId: '', clientSecret: '', redirectUri: 'http://localhost:3000/auth/google/callback' },
    whatsapp: { verifyToken: '', appSecret: '', accessToken: '', phoneNumberId: '', apiVersion: '', autoReplyEnabled: false }
  };
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-agent-metrics-'));
  const agentHost = createAgentHost({
    config,
    env: { CELIA_AGENT_RUNTIME: 'sqlite', CELIA_AGENT_SQLITE_PATH: path.join(directory, 'agent.sqlite3') },
    statusProvider: () => ({ version: '0.2.1', storage: 'test' }),
    logger: { error() {} }
  });
  const server = createApp({ pool: { execute: async () => [[]] }, config, agentHost }).listen(0);
  const baseUrl = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    const runtime = await agentHost.get().catch(() => null);
    runtime?.store.close?.();
    await runtime?.shutdown?.().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  });

  const anonymous = await fetch(`${baseUrl}/api/agent/metrics`);
  assert.equal(anonymous.status, 401);

  const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const { thread } = await (await fetch(`${baseUrl}/api/agent/threads`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'metrics' }) })).json();
  const created = await fetch(`${baseUrl}/api/agent/threads/${thread.id}/runs`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ message: 'استخرج بيانات الفاتورة invoice-valid-1042.csv', clientMessageId: 'met-05-run-1' })
  });
  assert.equal(created.status, 202);
  const started = await created.json();
  const runId = started.run?.id || started.runId || started.id;
  assert.ok(runId, `the 202 body names the run: ${JSON.stringify(started).slice(0, 200)}`);
  const runtime = await agentHost.get();
  await runtime.runToCompletion(runId);

  const response = await fetch(`${baseUrl}/api/agent/metrics`, { headers: auth });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.metrics.averageDurationMs, 'number');
  assert.equal(body.metrics.durations.runs.count, 1);
  assert.ok(Object.keys(body.metrics.durations.tools).length >= 1);
  for (const summary of Object.values(body.metrics.durations.tools)) {
    assert.ok(Number.isInteger(summary.count) && summary.count >= 1);
    assert.ok(Number.isInteger(summary.p50Ms) && Number.isInteger(summary.p95Ms) && Number.isInteger(summary.maxMs));
  }
  assert.equal(body.metrics.durations.unmeasuredToolRuns, 0);
});
