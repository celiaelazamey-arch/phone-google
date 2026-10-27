import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTempStore, createRecordingTools, threeReadsThenFinish } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createScriptedPlanner } from '../src/agent/planner.js';
import { RUN_STATUS, TOOL_RUN_STATUS } from '../src/agent/store.js';
import { OUTBOX_STATUS } from '../src/agent/outbox.js';
import { createAgentHost, readAgentBootRecovery, scheduleBootRecovery } from '../src/agent/index.js';

/**
 * Boot recovery is what makes a free tier that kills the process on every idle sleep
 * survivable: a waking process must settle what the dead one abandoned — without
 * re-sending anything — and resume what it left parked. These tests prove both halves
 * and that the policy is explicit (off by default, never a silent change of behaviour).
 */

async function setup(t, { clock } = {}) {
  const fixture = await createTempStore(clock ? { clock } : {});
  t.after(() => fixture.cleanup());
  const recorder = createRecordingTools();
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: recorder.tools,
    planner: createScriptedPlanner(threeReadsThenFinish()),
    limits: { maxSteps: 12, maxCostMicros: 100_000 },
    workerId: 'waking-worker',
    logger: { error() {} },
    ...(clock ? { clock } : {})
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'إقلاع' });
  const submit = (message) => runtime.submit({ threadId: thread.id, message });
  return { fixture, recorder, runtime, submit };
}

test('boot recovery: a waking process settles an abandoned dispatch as unknown and resumes a queued run — nothing is re-sent', async (t) => {
  let now = Date.parse('2026-11-02T06:00:00.000Z');
  const { fixture, recorder, runtime, submit } = await setup(t, { clock: () => now });
  const queued = await submit('مهمة بقيت في الطابور');
  const abandoned = await submit('مهمة كان مرسلها يعمل ثم مات');
  // The dead process: claimed the second run, recorded an intent, claimed it for
  // dispatch, then vanished before (or after — nobody knows) calling the provider.
  assert.equal(await fixture.store.claimRun(abandoned.run.id, { leaseMs: 1000, workerId: 'dead-worker' }), true);
  const step = await fixture.store.appendStep({ runId: abandoned.run.id, kind: 'act', title: 'calendar.create' });
  const inFlight = await fixture.store.startToolRun({
    runId: abandoned.run.id,
    stepId: step.id,
    toolName: 'calendar.create',
    risk: 'external_effect',
    idempotencyKey: `${abandoned.run.id}:${step.index}:calendar.create`
  });
  const { entry } = await fixture.store.enqueueOutbox({
    runId: abandoned.run.id,
    stepId: step.id,
    toolName: 'calendar.create',
    connector: 'google.calendar',
    idempotencyKey: `outbox:${abandoned.run.id}:calendar.create`,
    payload: { summary: 'موعد' }
  });
  assert.equal(await fixture.store.claimOutbox(entry.id, { leaseMs: 1000, workerId: 'dead-worker' }), true);
  assert.equal((await fixture.store.getOutbox(entry.id)).status, OUTBOX_STATUS.dispatching);

  now += 10_000; // both leases expired: the process that held them is gone
  const report = await runtime.recoverOnBoot({ limit: 5 });

  assert.equal(report.staleOutbox.length, 1);
  assert.deepEqual(report.staleOutbox[0], { id: entry.id, runId: abandoned.run.id, status: OUTBOX_STATUS.unknown });
  assert.equal(JSON.stringify(report).includes('موعد'), false, 'the report carries ids and statuses, never payload content');
  assert.equal(report.runs.attempted, 2);

  const byId = Object.fromEntries(report.runs.resumed.map((item) => [item.runId, item.status]));
  assert.equal(byId[queued.run.id], RUN_STATUS.succeeded, 'a run merely left queued finishes normally');
  assert.equal(byId[abandoned.run.id], RUN_STATUS.needsReconciliation, 'an unresolved call parks for a human, never a retry');
  assert.equal((await fixture.store.getOutbox(entry.id)).status, OUTBOX_STATUS.unknown);
  const toolRuns = await fixture.store.listToolRuns(abandoned.run.id);
  assert.equal(toolRuns.find((toolRun) => toolRun.id === inFlight.toolRun.id).status, TOOL_RUN_STATUS.unknown);
  assert.deepEqual(
    recorder.calls.map((call) => call.name),
    ['read.alpha', 'read.beta', 'read.gamma'],
    'only the queued run executed tools; the abandoned external effect was never invoked'
  );

  // Running recovery again (a second wake-up) finds nothing and changes nothing.
  const second = await runtime.recoverOnBoot({ limit: 5 });
  assert.equal(second.staleOutbox.length, 0);
  assert.equal(second.runs.attempted, 0);
  assert.equal(recorder.calls.length, 3);
});

test('boot recovery: the policy is explicit — off by default, true/false only', () => {
  assert.equal(readAgentBootRecovery({}), false);
  assert.equal(readAgentBootRecovery({ CELIA_AGENT_RESUME_ON_BOOT: 'true' }), true);
  assert.equal(readAgentBootRecovery({ CELIA_AGENT_RESUME_ON_BOOT: ' FALSE ' }), false);
  assert.throws(() => readAgentBootRecovery({ CELIA_AGENT_RESUME_ON_BOOT: 'yes' }), /true or false/);
});

function hostFixture(t, env) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-boot-recovery-'));
  const host = createAgentHost({
    config: { nodeEnv: 'test', userId: 'owner' },
    env: { ...env, CELIA_AGENT_SQLITE_PATH: path.join(directory, 'agent.sqlite3') },
    statusProvider: () => ({ version: 'test' }),
    logger: { error() {}, info() {} }
  });
  t.after(async () => {
    const runtime = await host.get().catch(() => null);
    await runtime?.shutdown?.().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  });
  return host;
}

test('boot recovery: the host performs it only under CELIA_AGENT_RESUME_ON_BOOT=true and reports the policy in status', async (t) => {
  const manual = hostFixture(t, { CELIA_AGENT_RUNTIME: 'sqlite' });
  const skipped = await manual.recoverOnBoot();
  assert.equal(skipped.performed, false);
  assert.equal(skipped.reason, 'boot_recovery_disabled');
  assert.equal(skipped.requiredEnv, 'CELIA_AGENT_RESUME_ON_BOOT=true');
  const manualStatus = await manual.status();
  assert.equal(manualStatus.enabled, true);
  assert.equal(manualStatus.bootRecovery.policy, 'manual');
  assert.equal(manualStatus.bootRecovery.last.performed, false);

  const resuming = hostFixture(t, { CELIA_AGENT_RUNTIME: 'sqlite', CELIA_AGENT_RESUME_ON_BOOT: 'true' });
  const performed = await resuming.recoverOnBoot();
  assert.equal(performed.performed, true);
  assert.deepEqual(performed.staleOutbox, []);
  assert.equal(performed.runs.attempted, 0);
  const resumingStatus = await resuming.status();
  assert.equal(resumingStatus.bootRecovery.policy, 'resume');
  assert.equal(resumingStatus.bootRecovery.last.performed, true);
  assert.match(resumingStatus.bootRecovery.last.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('boot recovery: an invalid policy value or a disabled runtime never throws out of the entry point', async (t) => {
  const off = hostFixture(t, {});
  const offReport = await off.recoverOnBoot();
  assert.equal(offReport.performed, false);
  assert.equal(offReport.reason, 'agent_runtime_disabled');

  const invalid = hostFixture(t, { CELIA_AGENT_RUNTIME: 'sqlite', CELIA_AGENT_RESUME_ON_BOOT: 'maybe' });
  const invalidReport = await invalid.recoverOnBoot();
  assert.equal(invalidReport.performed, false);
  assert.equal(invalidReport.reason, 'boot_recovery_disabled');
  const status = await invalid.status();
  assert.equal(status.enabled, false);
  assert.equal(status.reason, 'invalid_agent_boot_recovery', 'a typo is a configuration error, not a silent default');
});

test('boot recovery: scheduleBootRecovery runs in the background and logs by code only', async () => {
  const lines = [];
  // Each log line resolves a waiter, so the test never depends on a fixed sleep.
  let notify = () => {};
  const logged = () => new Promise((resolve) => { notify = resolve; });
  const push = (line) => {
    lines.push(line);
    notify();
  };
  const logger = { info: push, error: (...parts) => push(parts.join(' ')) };
  let calls = 0;
  const host = {
    async recoverOnBoot() {
      calls += 1;
      return { performed: true, staleOutbox: [{ id: 1 }], runs: { attempted: 2, resumed: [] }, durationMs: 7 };
    }
  };
  let waiter = logged();
  const timer = scheduleBootRecovery({ agentHost: host, logger, delayMs: 0 });
  assert.ok(timer, 'a timer is returned so embedders can cancel it');
  // The production timer is unref'd (it must never keep a draining server alive);
  // the test refs it so the event loop waits for the background recovery.
  timer.ref();
  await waiter;
  assert.equal(calls, 1);
  assert.match(lines[0], /1 abandoned outbox row\(s\) settled as unknown, 2 parked run\(s\) resumed in 7ms/);

  const failing = { async recoverOnBoot() { throw Object.assign(new Error('secret detail must not leak'), { code: 'boom' }); } };
  waiter = logged();
  scheduleBootRecovery({ agentHost: failing, logger, delayMs: 0 }).ref();
  await waiter;
  assert.match(lines[1], /Agent boot recovery failed: boom$/);
  assert.equal(lines[1].includes('secret detail'), false);
  assert.equal(scheduleBootRecovery({ agentHost: null, logger }), null);
});
