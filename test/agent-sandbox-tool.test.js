/**
 * M-B/B1 — اختبارات محوّل `sandbox.exec` داخل سجل الأدوات.
 *
 * كلها بلا شبكة وبلا namespaces: منفّذ وهمي يطبّق عقد `createSandboxExecutor.run()`
 * حرفيًا (succeeded/failed/blocked/timeout/resource_limit). عزل Linux الفعلي له
 * اختباراته التكاملية القائمة في `test/agent-sandbox.test.js` (CELIA_SANDBOX_INTEGRATION=1).
 *
 * معيار قبول B1: مهمة «حلّل CSV واحسب» تمر عبر الحلقة كاملة (خطة ← تنفيذ معزول ←
 * تحقق ← تسليم)، وفشل العزل يوقف التشغيل بلا أي host fallback.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempStore } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createToolRegistry, defaultToolDefinitions, RISK } from '../src/agent/tools.js';
import { createSandboxPolicy } from '../src/agent/sandbox-policy.js';
import { RUN_STATUS } from '../src/agent/store.js';

const CSV_CODE = 'const rows = `a,2\\nb,3`.split("\\n").map((r) => r.split(","));\n'
  + 'const total = rows.reduce((s, [, n]) => s + Number(n), 0);\n'
  + 'require("fs").writeFileSync("/workspace/artifacts/result.json", JSON.stringify({ total }));';

/** منفّذ وهمي يسجل كل استدعاء ويعيد النتائج بالترتيب — صفر تنفيذ على المضيف. */
function fakeExecutor(outcomes) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async run({ runId, code }) {
      calls.push({ runId, code });
      const next = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      return { runId, sandboxId: `sb-${index}`, policyHash: 'hash-1', network: { mode: 'deny', probe: null }, artifacts: [], ...next };
    }
  };
}

const SUCCEEDED = Object.freeze({
  status: 'succeeded',
  verdict: 'PASS',
  exitCode: 0,
  reason: null,
  artifacts: [{ id: 'art-1', name: 'result.json', bytes: 13, sha256: 'c'.repeat(64), uri: 'artifact://art-1', expiresAt: null }]
});

function decisionPlanner(decisions) {
  let index = 0;
  return {
    name: 'scripted-decisions',
    async plan() {
      const decision = decisions[Math.min(index, decisions.length - 1)];
      index += 1;
      return decision;
    }
  };
}

function registryWith(sandbox, extraDefinitions = []) {
  return createToolRegistry([
    ...defaultToolDefinitions({ statusProvider: () => ({ ok: true }), sandbox }),
    ...extraDefinitions
  ]);
}

async function setupRuntime(t, { tools, decisions }) {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools,
    planner: decisionPlanner(decisions),
    limits: { maxSteps: 16, maxCostMicros: 100_000 },
    workerId: 'sandbox-tool-test-worker',
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'B1 sandbox.exec' });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'حلّل CSV واحسب' });
  return { fixture, runtime, run };
}

// ─── العقد: بلا منفّذ لا شيء يتغير حرفيًا ────────────────────────────────────

test('SBX-01: without an executor the refusing definition is intact — irreversible, approval-gated, not executable', () => {
  const registry = registryWith(null);
  const tool = registry.get('sandbox.exec');
  assert.equal(tool.risk, RISK.irreversible);
  assert.equal(tool.requiresApproval, true);
  assert.equal(tool.execute, null, 'declared but unimplemented — the refusal carries its reason');
  assert.equal(registry.executable('sandbox.exec'), false);
  const listed = registry.list().find((item) => item.name === 'sandbox.exec');
  assert.equal(listed.requiresApproval, true);
});

test('SBX-02: with an executor the tool is an executable internal write with settled failures and a strict input contract', () => {
  const registry = registryWith(fakeExecutor([SUCCEEDED]));
  const tool = registry.get('sandbox.exec');
  assert.equal(tool.risk, RISK.internalWrite);
  assert.equal(tool.settledFailures, true);
  assert.equal(registry.executable('sandbox.exec'), true);
  assert.equal(registry.validateInput('sandbox.exec', { code: 'x' }).ok, true);
  assert.equal(registry.validateInput('sandbox.exec', { code: 7 }).code, 'policy_violation_argument_type');
  assert.equal(registry.validateInput('sandbox.exec', { code: 'x', apiKey: 's' }).code, 'policy_violation_secret_in_args');
});

// ─── معيار قبول B1: الحلقة الكاملة ───────────────────────────────────────────

test('SBX-03 (acceptance): "analyse CSV and compute" passes the full loop — plan, isolated execution, verify, deliver', async (t) => {
  const executor = fakeExecutor([SUCCEEDED]);
  const { runtime, run } = await setupRuntime(t, {
    tools: registryWith(executor),
    decisions: [
      { action: 'call', tool: 'sandbox.exec', args: { code: CSV_CODE }, reason: 'تنفيذ معزول للتحليل' },
      { action: 'finish', summary: 'المجموع محسوب في result.json المبصوم.' }
    ]
  });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded);
  assert.equal(executor.calls.length, 1);
  assert.equal(executor.calls[0].runId, run.id, 'the sandbox claim is keyed to the agent run id');
  assert.equal(executor.calls[0].code, CSV_CODE);

  const detail = await runtime.detail(run.id);
  const toolRun = detail.toolRuns.find((entry) => entry.toolName === 'sandbox.exec');
  assert.equal(toolRun.status, 'succeeded');
  assert.equal(toolRun.outcome.policyHash, 'hash-1');
  assert.equal(toolRun.outcome.artifacts[0].sha256, 'c'.repeat(64), 'the artifact digest is part of the recorded outcome');
  assert.ok(detail.steps.some((step) => step.kind === 'verify'), 'no delivery without independent verification');
  assert.ok(detail.steps.some((step) => step.kind === 'deliver'));
  assert.equal(detail.evidenceChain.ok, true);
});

// ─── لا host fallback: فشل العزل يوقف التشغيل بصدق ──────────────────────────

test('SBX-04 (negative mutation): a blocked isolation backend settles as failed — no host execution, no reconciliation theater', async (t) => {
  const executor = fakeExecutor([
    { status: 'blocked', verdict: 'BLOCK', reason: 'sandbox_linux_namespaces_required', exitCode: null }
  ]);
  const { runtime, run } = await setupRuntime(t, {
    tools: registryWith(executor),
    decisions: [
      { action: 'call', tool: 'sandbox.exec', args: { code: CSV_CODE } },
      { action: 'finish', failed: true, summary: 'تعذر العزل؛ لا تنفيذ على المضيف.' }
    ]
  });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, 'verification_blocked', 'the unredeemed isolation failure blocks delivery via the independent verifier');
  assert.notEqual(finished.status, RUN_STATUS.needsReconciliation, 'a settled local failure never opens human reconciliation');
  const detail = await runtime.detail(run.id);
  const toolRun = detail.toolRuns.find((entry) => entry.toolName === 'sandbox.exec');
  assert.equal(toolRun.status, 'failed', 'settled failed — not unknown: nothing external is unresolved');
  assert.ok(
    detail.steps.some((step) => step.title === 'sandbox.exec ✗' && /sandbox_linux_namespaces_required/.test(step.summary)),
    'the isolation refusal code is a visible observe step'
  );
  assert.equal(executor.calls.length, 1, 'exactly one isolation attempt; zero host fallback executions');
});

test('SBX-05 (invariant guard): a failing internal-write tool WITHOUT settledFailures still records unknown and demands reconciliation', async (t) => {
  const tools = registryWith(null, [
    {
      name: 'write.unsettled',
      description: 'كتابة داخلية بلا تسوية معلنة',
      risk: RISK.internalWrite,
      async execute() {
        throw Object.assign(new Error('boom'), { code: 'boom' });
      }
    }
  ]);
  const { runtime, run } = await setupRuntime(t, {
    tools,
    decisions: [{ action: 'call', tool: 'write.unsettled', args: {} }]
  });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.needsReconciliation, 'the pre-B1 contract is byte-intact for undeclared tools');
  assert.equal(finished.lastError, 'outcome_unknown');
  const detail = await runtime.detail(run.id);
  assert.equal(detail.toolRuns[0].status, 'unknown');
});

test('SBX-06: a sandbox wall timeout surfaces its explicit code and settles as failed', async (t) => {
  const executor = fakeExecutor([
    { status: 'timeout', verdict: 'TIMEOUT', reason: 'sandbox_wall_timeout', exitCode: null }
  ]);
  const { runtime, run } = await setupRuntime(t, {
    tools: registryWith(executor),
    decisions: [
      { action: 'call', tool: 'sandbox.exec', args: { code: 'while(true){}' } },
      { action: 'finish', failed: true, summary: 'انتهت المهلة داخل العزل.' }
    ]
  });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  const detail = await runtime.detail(run.id);
  assert.equal(detail.toolRuns[0].status, 'failed');
  assert.ok(detail.steps.some((step) => /sandbox_wall_timeout/.test(step.summary ?? '')));
});

// ─── حدود السياسة والحوكمة ───────────────────────────────────────────────────

test('SBX-07: the policy ceiling is now 256MiB by explicit config, the default stays 8MiB, and above-ceiling fails closed', () => {
  assert.equal(createSandboxPolicy().resources.workspaceBytes, 8_388_608, 'the default did not move');
  const raised = createSandboxPolicy({ resources: { workspaceBytes: 268_435_456 } });
  assert.equal(raised.resources.workspaceBytes, 268_435_456);
  assert.throws(
    () => createSandboxPolicy({ resources: { workspaceBytes: 268_435_457 } }),
    /sandbox_workspace_bytes_outside_bounds/
  );
});

test('SBX-08 (governance): sandbox.exec can never enter the provider planner allowlist — the read-only gate stands', async () => {
  const { createProviderPlanner } = await import('../src/agent/planner-provider.js');
  const registry = registryWith(fakeExecutor([SUCCEEDED]));
  assert.throws(
    () => createProviderPlanner({
      provider: { async createPlan() { return {}; } },
      tools: registry,
      allowedTools: ['celia.system_status', 'sandbox.exec']
    }),
    /executable read tool/,
    'the live model cannot select the hands directly; only governed planners may'
  );
});

// ─── التكامل الحقيقي (نفس بوابة agent-sandbox.test.js): الحلقة + العزل الفعلي ──

const REAL = process.env.CELIA_SANDBOX_INTEGRATION === '1';

test(
  'SBX-09 (REAL acceptance): the actual AGENT-003 executor computes the CSV sum inside namespaces through the full loop',
  { skip: REAL ? false : 'set CELIA_SANDBOX_INTEGRATION=1 on Linux with user namespaces' },
  async (t) => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { createSandboxExecutor } = await import('../src/agent/sandbox.js');

    const fixture = await createTempStore();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'celia-sbx-b1-'));
    t.after(async () => {
      fixture.cleanup();
      await rm(directory, { recursive: true, force: true });
    });
    // أدلة العزل تدخل سلسلة التشغيل نفسها: evidenceStore = مخزن الوكيل.
    const executor = createSandboxExecutor({
      artifactRoot: path.join(directory, 'artifacts'),
      evidenceStore: fixture.store
    });
    const tools = registryWith(executor);
    const runtime = createAgentRuntime({
      store: fixture.store,
      tools,
      planner: decisionPlanner([
        { action: 'call', tool: 'sandbox.exec', args: { code: CSV_CODE }, reason: 'تنفيذ معزول حقيقي' },
        { action: 'finish', summary: 'المجموع محسوب داخل العزل وصدر artifact مبصوم.' }
      ]),
      limits: { maxSteps: 16, maxCostMicros: 100_000 },
      workerId: 'sandbox-real-worker',
      logger: { error() {} }
    });
    const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'B1 real' });
    const { run } = await runtime.submit({ threadId: thread.id, message: 'حلّل CSV واحسب' });
    const finished = await runtime.runToCompletion(run.id);
    assert.equal(finished.status, RUN_STATUS.succeeded);

    const detail = await runtime.detail(run.id);
    const toolRun = detail.toolRuns.find((entry) => entry.toolName === 'sandbox.exec');
    assert.equal(toolRun.status, 'succeeded');
    const artifact = toolRun.outcome.artifacts.find((item) => item.name === 'result.json');
    assert.ok(artifact, 'the isolated computation produced a real artifact');
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    // الدليل القاطع: نقرأ الـartifact الحقيقي ونتحقق من الحساب نفسه (2+3=5).
    const payload = await executor.readArtifact(artifact);
    assert.deepEqual(JSON.parse(payload.content.toString('utf8')), { total: 5 });
    // وأدلة العزل (sandbox.*) مبصومة داخل سلسلة التشغيل نفسها.
    assert.ok(detail.evidence.some((entry) => String(entry.kind).startsWith('sandbox')), 'sandbox lifecycle evidence is in the run chain');
    assert.equal(detail.evidenceChain.ok, true);
  }
);
