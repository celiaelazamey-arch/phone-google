/**
 * WP-1.2 (AGENT-008, DEC-047) — a trace the owner can feel in control of, built only from stored facts.
 *
 * TRC-01 deriveNow: one state per run status, `since`/`elapsedMs`/`totalMs` from timestamps, never predicted.
 * TRC-02 the enriched `step` event on a real SQLite run under a fake clock: usage, limits, now, settledStep with a
 *        duration that is a multiple of the clock tick.
 * TRC-03 detail()/GET /runs/:id expose `now` and `toolRunStatus`; the SSE snapshot carries the same `now`.
 * TRC-04 public/agent-trace.js (the page's pure logic): node status, now label, budget ratios, stage nodes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveNow, NOW_STATE, timeSteps } from '../src/agent/timing.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createDefaultTools } from '../src/agent/tools.js';
import { createDemoPlanner } from '../src/agent/planner.js';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { createAgentHost } from '../src/agent/index.js';
import { createCeliaMcpApp, loadCeliaMcpConfig } from '../src/celia-mcp.js';
import { createMemoryPool } from '../src/memory-pool.js';
import { createFakeCalendar, createTempStore } from './support/agent-fixtures.js';
import {
  budgetRatios,
  formatMs,
  nowLabel,
  stageNodes,
  stepNodeStatus,
  summarizeStepNodes,
  STEP_NODE
} from '../public/agent-trace.js';

const T0 = Date.parse('2026-10-29T10:00:00.000Z');
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

test('TRC-01 deriveNow names the current state from stored facts only', () => {
  const run = (status, extra = {}) => ({ id: 'r', status, createdAt: iso(0), updatedAt: iso(500), finishedAt: null, ...extra });
  assert.equal(deriveNow({ run: null }), null);

  const queued = deriveNow({ run: run('queued'), at: T0 + 300 });
  assert.equal(queued.state, NOW_STATE.queued);
  assert.equal(queued.since, iso(0));
  assert.equal(queued.elapsedMs, 300);
  assert.equal(queued.totalMs, 300);

  const actOpen = { id: 's2', index: 2, kind: 'act', title: 'kb.search', toolName: 'kb.search', createdAt: iso(400), toolRunStatus: 'started' };
  const executing = deriveNow({ run: run('running'), steps: [{ id: 's1', index: 1, kind: 'decide', createdAt: iso(100) }, actOpen], at: T0 + 1000 });
  assert.equal(executing.state, NOW_STATE.executingTool);
  assert.equal(executing.toolName, 'kb.search');
  assert.equal(executing.stepIndex, 2);
  assert.equal(executing.since, iso(400));
  assert.equal(executing.elapsedMs, 600);

  const actNotYetStarted = { ...actOpen, toolRunStatus: null };
  assert.equal(deriveNow({ run: run('running'), steps: [actNotYetStarted], at: T0 + 1000 }).state, NOW_STATE.executingTool, 'an act step whose tool run row is not written yet is still executing');

  const observed = { id: 's3', index: 3, kind: 'observe', title: 'kb.search ✓', createdAt: iso(700) };
  const planning = deriveNow({ run: run('running'), steps: [actOpen, observed], at: T0 + 1000 });
  assert.equal(planning.state, NOW_STATE.planning);
  assert.equal(planning.since, iso(700), 'planning started when the last step was recorded');
  assert.equal(planning.elapsedMs, 300);
  assert.equal(planning.toolName, null);

  const waiting = deriveNow({
    run: run('waiting_approval'),
    steps: [{ id: 's4', index: 4, kind: 'decide', title: 'موافقة مطلوبة', toolName: 'calendar.create', createdAt: iso(800) }],
    approvals: [{ id: 'a1', decision: 'pending', toolName: 'calendar.create', createdAt: iso(810) }],
    at: T0 + 2000
  });
  assert.equal(waiting.state, NOW_STATE.waitingApproval);
  assert.equal(waiting.toolName, 'calendar.create');
  assert.equal(waiting.since, iso(810));
  assert.equal(waiting.elapsedMs, 1190);

  const reconcile = deriveNow({ run: run('needs_reconciliation', { updatedAt: iso(900) }), steps: [{ id: 's5', index: 5, kind: 'observe', toolName: 'calendar.create', createdAt: iso(890) }], at: T0 + 1000 });
  assert.equal(reconcile.state, NOW_STATE.needsReconciliation);
  assert.equal(reconcile.toolName, 'calendar.create');
  assert.equal(reconcile.elapsedMs, 100);

  const finished = deriveNow({ run: run('succeeded', { finishedAt: iso(4200) }), steps: [observed], at: T0 + 99_999 });
  assert.equal(finished.state, NOW_STATE.finished);
  assert.equal(finished.terminal, true);
  assert.equal(finished.totalMs, 4200, 'a finished run reports its proven length, not the time since');
  assert.equal(finished.elapsedMs, null);
  assert.equal(finished.since, iso(4200));

  const broken = deriveNow({ run: run('running', { createdAt: 'not-a-date' }), steps: [{ ...actOpen, createdAt: 'garbage' }], at: T0 });
  assert.equal(broken.since, null);
  assert.equal(broken.elapsedMs, null);
  assert.equal(broken.totalMs, null, 'unparseable timestamps give null, never 0');
});

test('TRC-02 the step event carries usage, limits, now and the settled act step with a proven duration', async (t) => {
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

  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'أثر WP-1.2' });
  const submitted = await runtime.submit({ threadId: thread.id, message: 'استخرج بيانات الفاتورة invoice-valid-1042.csv', clientMessageId: 'trc-02-run-1' });
  const events = [];
  const unsubscribe = runtime.subscribe(submitted.run.id, (event) => events.push(event));
  t.after(unsubscribe);
  await runtime.runToCompletion(submitted.run.id);

  const stepEvents = events.filter((event) => event.type === 'step');
  assert.ok(stepEvents.length >= 6, 'the demo task records several steps');
  for (const event of stepEvents) {
    assert.equal(typeof event.usage.steps, 'number');
    assert.equal(event.usage.steps, event.step.index, 'usage.steps in the event equals the index the store just wrote');
    assert.equal(event.limits.maxSteps, 12);
    assert.equal(event.limits.maxCostMicros, 100_000);
    assert.equal(event.status, 'running');
    assert.ok(event.now && typeof event.now.state === 'string', 'every step event says what the loop is doing now');
    assert.equal(event.step.toolRunStatus, null, 'a step is emitted before its tool run exists; nothing is pretended');
    assert.equal(event.step.durationMs, null);
  }

  const actEvents = stepEvents.filter((event) => event.step.kind === 'act');
  assert.ok(actEvents.length >= 3);
  for (const actEvent of actEvents) {
    assert.equal(actEvent.now.state, NOW_STATE.executingTool);
    assert.equal(actEvent.now.toolName, actEvent.step.toolName);
    assert.equal(actEvent.now.stepIndex, actEvent.step.index);
    assert.equal(actEvent.settledStep, null, 'nothing has settled when the call is announced');
    const observe = stepEvents.find((event) => event.step.index === actEvent.step.index + 1);
    assert.ok(observe, 'each act step is followed by its observe step');
    assert.equal(observe.step.kind, 'observe');
    assert.equal(observe.now.state, NOW_STATE.planning, 'after the outcome is recorded the loop is back to planning');
    const settled = observe.settledStep;
    assert.ok(settled, 'the observe event carries the settled act step');
    assert.equal(settled.id, actEvent.step.id);
    assert.equal(settled.index, actEvent.step.index);
    assert.equal(settled.toolRunStatus, 'succeeded');
    assert.ok(Number.isInteger(settled.durationMs) && settled.durationMs > 0, 'the settled duration is a real positive number');
    assert.equal(settled.durationMs % 7, 0, 'measured by the fake clock tick — not estimated');
    assert.equal(settled.startedAt, actEvent.step.createdAt);
    assert.ok(settled.toolRunId);
  }

  const detail = await runtime.detail(submitted.run.id);
  assert.equal(detail.run.status, 'succeeded');
  assert.equal(detail.now.state, NOW_STATE.finished);
  assert.equal(detail.now.status, 'succeeded');
  assert.ok(Number.isInteger(detail.now.totalMs) && detail.now.totalMs > 0);
  assert.equal(detail.now.totalMs % 7, 0);
  assert.equal(detail.now.stepIndex, detail.steps.at(-1).index);
  const actSteps = detail.steps.filter((step) => step.kind === 'act');
  for (const step of actSteps) {
    assert.equal(step.toolRunStatus, 'succeeded');
    const settledEvent = stepEvents.find((event) => event.settledStep?.id === step.id);
    assert.equal(step.durationMs, settledEvent.settledStep.durationMs, 'the stream and the detail agree on the same proven duration');
  }
  for (const step of detail.steps.filter((entry) => entry.kind !== 'act')) {
    assert.equal(step.toolRunStatus, null);
  }
  const finishedEvent = events.find((event) => event.type === 'run.finished');
  assert.ok(finishedEvent, 'run.finished is still emitted unchanged');
});

test('TRC-03 GET /runs/:id and the SSE snapshot expose now and toolRunStatus to the owner only', async (t) => {
  const TOKEN = 'test-token-with-at-least-32-characters';
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-agent-trace-'));
  const agentHost = createAgentHost({
    config: {
      nodeEnv: 'test',
      apiToken: TOKEN,
      encryptionKey: Buffer.alloc(32, 7).toString('base64'),
      userId: 'owner',
      google: { clientId: '', clientSecret: '', redirectUri: 'http://localhost:3000/auth/google/callback' },
      whatsapp: { verifyToken: '', appSecret: '', accessToken: '', phoneNumberId: '', apiVersion: '', autoReplyEnabled: false }
    },
    env: { CELIA_AGENT_RUNTIME: 'sqlite', CELIA_AGENT_SQLITE_PATH: path.join(directory, 'agent.sqlite3') },
    statusProvider: () => ({ version: '0.2.1', storage: 'test' }),
    logger: { error() {} }
  });
  const server = createApp({ pool: { execute: async () => [[]] }, config: { nodeEnv: 'test', apiToken: TOKEN, encryptionKey: Buffer.alloc(32, 7).toString('base64'), userId: 'owner', google: { clientId: '', clientSecret: '', redirectUri: 'http://localhost:3000/auth/google/callback' }, whatsapp: { verifyToken: '', appSecret: '', accessToken: '', phoneNumberId: '', apiVersion: '', autoReplyEnabled: false } }, agentHost }).listen(0);
  const baseUrl = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    const runtime = await agentHost.get().catch(() => null);
    runtime?.store.close?.();
    await runtime?.shutdown?.().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  });
  const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

  const { thread } = await (await fetch(`${baseUrl}/api/agent/threads`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'trace' }) })).json();
  const created = await fetch(`${baseUrl}/api/agent/threads/${thread.id}/runs`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ message: 'استخرج بيانات الفاتورة invoice-valid-1042.csv', clientMessageId: 'trc-03-run-1' })
  });
  assert.equal(created.status, 202);
  const started = await created.json();
  const runtime = await agentHost.get();
  await runtime.runToCompletion(started.runId);

  const detail = await (await fetch(`${baseUrl}/api/agent/runs/${started.runId}`, { headers: auth })).json();
  assert.equal(detail.run.status, 'succeeded');
  assert.equal(detail.now.state, 'finished');
  assert.ok(detail.now.totalMs >= 0);
  assert.ok(detail.steps.some((step) => step.kind === 'act' && step.toolRunStatus === 'succeeded' && Number.isInteger(step.durationMs)));
  assert.ok(detail.run.limits.maxSteps > 0 && detail.run.limits.maxCostMicros > 0, 'the budget bar has real ceilings to draw from');

  const stream = await fetch(`${baseUrl}/api/agent/runs/${started.runId}/events`, { headers: auth });
  const text = await stream.text();
  const snapshotLine = text.split('\n').find((line) => line.startsWith('data:') && line.includes('"type":"snapshot"'));
  const snapshot = JSON.parse(snapshotLine.slice(5));
  assert.deepEqual(snapshot.now, detail.now, 'the stream opens with the same now the detail reports');
  assert.equal(snapshot.steps.at(-1).toolRunStatus, detail.steps.at(-1).toolRunStatus);

  const stranger = await fetch(`${baseUrl}/api/agent/runs/${started.runId}`);
  assert.equal(stranger.status, 401);
});

test('TRC-03b the live UI server serves agent-trace.js (explicit asset routes, no static fallback) and the trace markup', async (t) => {
  const pool = createMemoryPool();
  const config = loadCeliaMcpConfig({ CELIA_MCP_API_TOKEN: crypto.randomBytes(32).toString('hex') });
  const server = createCeliaMcpApp({ pool, config }).listen(0, '127.0.0.1');
  const baseUrl = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  // The page imports ./agent-trace.js as an ES module; public/ assets are served by explicit route, so a missing
  // route would be a 404 that only a browser notices.
  const moduleResponse = await fetch(`${baseUrl}/agent-trace.js`);
  assert.equal(moduleResponse.status, 200);
  assert.match(moduleResponse.headers.get('content-type'), /javascript/);
  assert.match(await moduleResponse.text(), /export function nowLabel/);
  const pageHtml = await (await fetch(`${baseUrl}/agent`)).text();
  for (const id of ['now-line', 'bar-steps', 'bar-cost', 'plan-tree', 'limit-steps', 'limit-cost', 'steps']) {
    assert.ok(pageHtml.includes(`id="${id}"`), `agent.html has #${id}`);
  }
  const pageJs = await (await fetch(`${baseUrl}/agent.js`)).text();
  assert.match(pageJs, /from '\.\/agent-trace\.js'/);
});

test('TRC-04 public/agent-trace.js derives node states, the now line and budget ratios without inventing anything', () => {
  // Step nodes
  const act = (toolRunStatus) => ({ kind: 'act', title: 'kb.search', toolName: 'kb.search', toolRunStatus, durationMs: toolRunStatus === 'succeeded' ? 14 : null });
  assert.equal(stepNodeStatus(act('started'), { runStatus: 'running', isLast: true }), STEP_NODE.running);
  assert.equal(stepNodeStatus(act(null), { runStatus: 'running', isLast: true }), STEP_NODE.running, 'announced, tool run row not yet written');
  assert.equal(stepNodeStatus(act(null), { runStatus: 'failed', isLast: false }), STEP_NODE.unknown, 'an act step that never got a tool run is not pretended done');
  assert.equal(stepNodeStatus(act('succeeded'), { runStatus: 'running', isLast: false }), STEP_NODE.done);
  assert.equal(stepNodeStatus(act('failed'), { runStatus: 'succeeded', isLast: false }), STEP_NODE.failed);
  assert.equal(stepNodeStatus(act('unknown'), { runStatus: 'needs_reconciliation', isLast: false }), STEP_NODE.unknown);
  assert.equal(stepNodeStatus({ kind: 'observe', title: 'مصالحة مطلوبة' }, { runStatus: 'needs_reconciliation', isLast: true }), STEP_NODE.waiting);
  assert.equal(stepNodeStatus({ kind: 'decide', title: 'موافقة مطلوبة' }, { runStatus: 'waiting_approval', isLast: true }), STEP_NODE.waiting);
  assert.equal(stepNodeStatus({ kind: 'decide', title: 'إلغاء' }, { runStatus: 'cancelled', isLast: true }), STEP_NODE.recorded);
  assert.equal(stepNodeStatus({ kind: 'verify', title: 'تحقق' }, { runStatus: 'succeeded', isLast: false }), STEP_NODE.recorded);
  assert.equal(stepNodeStatus({ kind: 'deliver', title: 'تسليم' }, { runStatus: 'succeeded', isLast: true }), STEP_NODE.done);
  assert.equal(stepNodeStatus(null, {}), STEP_NODE.recorded);

  const summary = summarizeStepNodes([act('succeeded'), { kind: 'observe', title: 'kb.search ✓' }, act('started')], 'running');
  assert.deepEqual(summary, { total: 3, act: 2, done: 1, running: 1, failed: 0, unknown: 0, waiting: 0, measuredMs: 14 });

  // Durations
  assert.equal(formatMs(null), '—');
  assert.equal(formatMs(-1), '—');
  assert.equal(formatMs(42), '42 ms');
  assert.equal(formatMs(1500), '1.5 ث');
  assert.equal(formatMs(125_000), '2 د 5 ث');

  // Now line: elapsed is recomputed from `since` with the caller's clock, so it keeps ticking between events.
  const at = T0 + 10_000;
  assert.equal(nowLabel(null), 'لا تشغيل');
  assert.equal(nowLabel({ state: 'executing_tool', toolName: 'kb.search', since: iso(9_000), elapsedMs: 1 }, at), 'الآن: ينفّذ kb.search منذ 1.0 ث');
  assert.equal(nowLabel({ state: 'planning', since: iso(9_950) }, at), 'الآن: يقرر الخطوة التالية (منذ 50 ms)');
  assert.equal(nowLabel({ state: 'queued', since: iso(0) }, at), 'في الانتظار منذ 10.0 ث');
  assert.equal(nowLabel({ state: 'waiting_approval', toolName: 'calendar.create', since: iso(0) }, at), 'الآن: بانتظار قرارك على calendar.create منذ 10.0 ث');
  assert.equal(nowLabel({ state: 'needs_reconciliation', toolName: 'calendar.create', since: iso(0) }, at), 'الآن: بانتظار مصالحتك (calendar.create) منذ 10.0 ث');
  assert.equal(nowLabel({ state: 'finished', status: 'succeeded', totalMs: 4200 }, at), 'انتهى (نُفذ) — الإجمالي 4.2 ث');
  assert.equal(nowLabel({ state: 'finished', status: 'budget_exhausted', totalMs: null }, at), 'انتهى (توقف بالميزانية) — الإجمالي —');
  assert.equal(nowLabel({ state: 'executing_tool', toolName: 'x', since: 'garbage', elapsedMs: 70 }, at), 'الآن: ينفّذ x منذ 70 ms', 'falls back to the server elapsed when since is unusable');

  // Budget
  assert.deepEqual(budgetRatios({ steps: 3, costMicros: 95_000, tokens: 12 }, { maxSteps: 12, maxCostMicros: 100_000 }), {
    steps: { used: 3, max: 12, percent: 25 },
    cost: { used: 95_000, max: 100_000, percent: 95 },
    tokens: 12
  });
  assert.deepEqual(budgetRatios({ steps: 40 }, { maxSteps: 12 }).steps, { used: 40, max: 12, percent: 100 }, 'capped at 100');
  assert.deepEqual(budgetRatios({}, {}).cost, { used: 0, max: null, percent: null }, 'no ceiling → no percentage, not 0%');

  // Stage nodes
  const stages = (flags) => ({
    stages: [
      { id: 'understand', title: '1', completed: flags[0] },
      { id: 'plan', title: '2', completed: flags[1] },
      { id: 'present_and_wait', title: '3', completed: flags[2] },
      { id: 'execute_and_verify', title: '4', completed: flags[3] }
    ]
  });
  assert.deepEqual(stageNodes(stages([true, true, false, false]), { status: 'running' }).map((node) => node.status), ['done', 'done', 'current', 'pending']);
  assert.deepEqual(stageNodes(stages([true, true, false, true]), { status: 'succeeded' }, { approvals: [] }).map((node) => node.status), ['done', 'done', 'skipped', 'done']);
  const failed = stageNodes(stages([true, true, false, false]), { status: 'budget_exhausted' }, { approvals: [] });
  assert.deepEqual(failed.map((node) => node.status), ['done', 'done', 'skipped', 'stopped']);
  assert.equal(failed[3].note, 'توقف بالميزانية');
  const waiting = stageNodes(stages([true, true, false, false]), { status: 'waiting_approval' }, { approvals: [{ decision: 'pending' }] });
  assert.equal(waiting[2].status, 'current');
  assert.equal(waiting[2].note, 'بانتظار قرارك');
  const unverified = stageNodes(stages([true, true, true, false]), { status: 'succeeded' }, { approvals: [{ decision: 'approved' }], verification: { verdict: 'UNKNOWN' } });
  assert.equal(unverified[3].status, 'done');
  assert.equal(unverified[3].note, 'الحكم: UNKNOWN', 'a non-PASS verdict stays visible on the node');
  assert.deepEqual(stageNodes(null, null), []);
});
