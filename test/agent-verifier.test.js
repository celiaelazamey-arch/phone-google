import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempStore, createRecordingTools, threeReadsThenFinish } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createScriptedPlanner } from '../src/agent/planner.js';
import { createToolRegistry, RISK } from '../src/agent/tools.js';
import { createVerifier, VERDICT } from '../src/agent/verifier.js';
import { buildGoalContract } from '../src/agent/goal-contract.js';

async function bootstrap(t) {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const recorder = createRecordingTools();
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: recorder.tools,
    planner: createScriptedPlanner(threeReadsThenFinish()),
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'تحقق' });
  return { fixture, recorder, runtime, thread };
}

const UNIT_LIMITS = { maxSteps: 8, maxCostMicros: 1000, maxDurationMs: 60_000 };

async function runShape(store, thread) {
  const created = await store.createRun({
    threadId: thread.id,
    ownerId: 'owner',
    planner: 'unit',
    maxSteps: UNIT_LIMITS.maxSteps,
    maxCostMicros: UNIT_LIMITS.maxCostMicros
  });
  return store.getRun(created.run.id);
}

const unitContract = (run, objective = 'هدف') =>
  buildGoalContract({ objective, limits: UNIT_LIMITS, createdAt: Date.parse(run.createdAt) });

test('verifier: a clean all-read run ends with PASS and only three-value verdicts are used', async (t) => {
  const { fixture, recorder, runtime, thread } = await bootstrap(t);
  const submitted = await runtime.submit({ threadId: thread.id, message: 'مهمة نظيفة', clientMessageId: 'verify-pass-01' });
  const finished = await runtime.runToCompletion(submitted.run.id);
  assert.equal(finished.status, 'succeeded');

  const detail = await runtime.detail(submitted.run.id);
  assert.equal(detail.verification.verdict, VERDICT.pass);
  const entry = detail.evidence.find((item) => item.kind === 'verification');
  assert.ok(entry);
  assert.ok(['PASS', 'BLOCK', 'UNKNOWN'].includes(entry.verdict));
  assert.equal(detail.evidenceChain.ok, true);

  // Recompute independently from durable facts only: a fresh verifier reaches the same verdict.
  const fresh = createVerifier({ tools: recorder.tools });
  const recomputed = await fresh.verifyRun({
    run: detail.run,
    contract: detail.goalContract,
    steps: detail.steps,
    toolRuns: detail.toolRuns,
    evidence: detail.evidence,
    approvals: detail.approvals,
    messages: await fixture.store.listMessages(thread.id)
  });
  assert.equal(recomputed.verdict, VERDICT.pass);
  assert.ok(recomputed.checks.length >= 6);
});

test('verifier: a tool run without ledger evidence is BLOCK, not silently accepted', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const registry = createToolRegistry([
    { name: 'read.alpha', description: 'a', risk: RISK.read, async execute() { return { alpha: true }; } }
  ]);
  const { store } = fixture;
  const thread = await store.createThread({ ownerId: 'owner', title: 'v' });
  const run = await runShape(store, thread);
  const contract = unitContract(run, 'هدف');
  const toolRuns = [{ id: 'tr-1', toolName: 'read.alpha', status: 'succeeded', outcome: { alpha: true } }];

  const result = await createVerifier({ tools: registry }).verifyRun({
    run,
    contract,
    steps: [{ id: 's1', kind: 'act' }],
    toolRuns,
    evidence: [],
    approvals: [],
    messages: []
  });
  assert.equal(result.verdict, VERDICT.block);
  assert.ok(result.checks.find((check) => check.id === 'evidence_completeness' && check.status === 'BLOCK'));
});

test('verifier: an unresolved tool outcome yields UNKNOWN rather than a guessed PASS', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const registry = createToolRegistry([
    { name: 'write.external', description: 'x', risk: RISK.externalEffect, requiresApproval: true }
  ]);
  const { store } = fixture;
  const thread = await store.createThread({ ownerId: 'owner', title: 'v' });
  const run = await runShape(store, thread);
  const contract = unitContract(run, 'هدف');
  const evidence = [
    await store.appendEvidence({ runId: run.id, kind: 'tool_call', input: { tool: 'write.external' }, output: null, sourceIds: ['tr-1'], verdict: 'UNKNOWN' })
  ];
  const result = await createVerifier({ tools: registry }).verifyRun({
    run,
    contract,
    steps: [{ id: 's1', kind: 'act' }],
    toolRuns: [{ id: 'tr-1', toolName: 'write.external', status: 'unknown', outcome: null }],
    evidence,
    approvals: [{ toolName: 'write.external', decision: 'approved' }],
    messages: []
  });
  assert.equal(result.verdict, VERDICT.unknown);
  assert.ok(result.checks.find((check) => check.id === 'outcome_resolved' && check.status === 'UNKNOWN'));
});

test('verifier: external effects without an approved decision BLOCK; a recorded approval clears the check', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const registry = createToolRegistry([
    { name: 'calendar.create', description: 'x', risk: RISK.externalEffect, requiresApproval: true }
  ]);
  const { store } = fixture;
  const thread = await store.createThread({ ownerId: 'owner', title: 'v' });
  const run = await runShape(store, thread);
  const contract = unitContract(run, 'موعد');
  const evidence = [
    await store.appendEvidence({ runId: run.id, kind: 'tool_call', input: { tool: 'calendar.create' }, output: { id: 'ev-1' }, sourceIds: ['tr-1'], verdict: 'PASS' })
  ];
  const toolRuns = [{ id: 'tr-1', toolName: 'calendar.create', status: 'succeeded', outcome: { id: 'ev-1' } }];

  const blocked = await createVerifier({ tools: registry }).verifyRun({
    run, contract, steps: [{ id: 's1' }], toolRuns, evidence, approvals: [], messages: []
  });
  assert.equal(blocked.checks.find((check) => check.id === 'external_effect_approval').status, 'BLOCK');

  const approved = await createVerifier({ tools: registry }).verifyRun({
    run,
    contract,
    steps: [{ id: 's1' }],
    toolRuns,
    evidence,
    approvals: [{ toolName: 'calendar.create', decision: 'approved' }],
    messages: []
  });
  assert.equal(approved.checks.find((check) => check.id === 'external_effect_approval').status, 'PASS');

  const rejected = await createVerifier({ tools: registry }).verifyRun({
    run,
    contract,
    steps: [{ id: 's1' }],
    toolRuns: [],
    evidence: [],
    approvals: [{ toolName: 'calendar.create', decision: 'rejected' }],
    messages: []
  });
  assert.equal(
    rejected.checks.find((check) => check.id === 'external_effect_approval').status,
    'PASS',
    'a recorded rejection is a decision, not an open approval'
  );
});

test('verifier: deterministic re-execution blocks when the output hash drifts', async (t) => {
  let counter = 0;
  const registry = createToolRegistry([
    {
      name: 'read.flaky',
      description: 'claims determinism but drifts',
      risk: RISK.read,
      deterministic: true,
      replayArgs: () => ({}),
      async execute() {
        counter += 1;
        return { n: counter };
      }
    }
  ]);
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const { store } = fixture;
  const thread = await store.createThread({ ownerId: 'owner', title: 'v' });
  const run = await runShape(store, thread);
  const contract = unitContract(run, 'هدف');
  const evidence = [
    await store.appendEvidence({ runId: run.id, kind: 'tool_call', input: {}, output: { n: 1 }, sourceIds: ['tr-1'], verdict: 'PASS' })
  ];
  // Advance the counter: the recorded outcome was n=1; a fresh read now returns n=2.
  await registry.get('read.flaky').execute({}, { context: {} });
  const result = await createVerifier({ tools: registry }).verifyRun({
    run,
    contract,
    steps: [{ id: 's1' }],
    toolRuns: [{ id: 'tr-1', toolName: 'read.flaky', status: 'succeeded', outcome: { n: 1 } }],
    evidence,
    approvals: [],
    messages: [{ role: 'user', content: 'هدف' }]
  });
  const check = result.checks.find((item) => item.id === 'deterministic_reexecution:read.flaky');
  assert.equal(check.status, 'BLOCK');
  assert.match(check.detail, /output_hash_mismatch/);
});

test('verifier: kb.search outputs without uri/licence/trust BLOCK; complete provenance passes', async (t) => {
  const registry = createToolRegistry([
    { name: 'kb.search', description: 'kb', risk: RISK.read, async execute() { return null; } }
  ]);
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const { store } = fixture;
  const thread = await store.createThread({ ownerId: 'owner', title: 'v' });
  const run = await runShape(store, thread);
  const contract = unitContract(run, 'بحث');
  const base = { run, contract, steps: [{ id: 's1' }], approvals: [], messages: [] };

  const incomplete = await createVerifier({ tools: registry }).verifyRun({
    ...base,
    toolRuns: [{ id: 'tr-1', toolName: 'kb.search', status: 'succeeded', outcome: { items: [{ title: 'بلا ترخيص' }] } }],
    evidence: [await store.appendEvidence({ runId: run.id, kind: 'tool_call', input: {}, output: {}, sourceIds: ['tr-1'], verdict: 'PASS' })]
  });
  assert.equal(incomplete.checks.find((check) => check.id === 'kb_source_licence_trust').status, 'BLOCK');

  const complete = await createVerifier({ tools: registry }).verifyRun({
    ...base,
    toolRuns: [
      {
        id: 'tr-2',
        toolName: 'kb.search',
        status: 'succeeded',
        outcome: { items: [{ uri: 'u', licence: 'MIT', trust: 'high' }] }
      }
    ],
    evidence: [await store.appendEvidence({ runId: run.id, kind: 'tool_call', input: {}, output: {}, sourceIds: ['tr-2'], verdict: 'PASS' })]
  });
  assert.equal(complete.checks.find((check) => check.id === 'kb_source_licence_trust').status, 'PASS');

  const governance = {
    profile: 'planner-safe-v1',
    kind: 'doc',
    claimTypes: ['operational_guidance'],
    trust: ['T1', 'T2'],
    reviewRequired: true,
    excluded: 0
  };
  const safeItem = {
    uri: 'https://example.test/safe',
    licence: 'MIT',
    trust: 'T1',
    kind: 'doc',
    claimType: 'operational_guidance',
    reviewDue: '2099-01-01',
    reviewStatus: 'current',
    plannerEligible: true
  };
  const governed = async (id, item, policy = governance) => createVerifier({ tools: registry }).verifyRun({
    ...base,
    toolRuns: [{ id, toolName: 'kb.search', status: 'succeeded', outcome: { governance: policy, items: [item] } }],
    evidence: [await store.appendEvidence({ runId: run.id, kind: 'tool_call', input: {}, output: {}, sourceIds: [id], verdict: 'PASS' })]
  });
  const safe = await governed('tr-safe', safeItem);
  assert.equal(safe.checks.find((check) => check.id === 'kb_planner_governance').status, 'PASS');
  const historical = await governed('tr-historical', { ...safeItem, claimType: 'historical_report' });
  assert.equal(historical.checks.find((check) => check.id === 'kb_planner_governance').status, 'BLOCK');
  const expired = await governed('tr-expired', { ...safeItem, reviewDue: '2020-01-01' });
  assert.equal(expired.checks.find((check) => check.id === 'kb_planner_governance').status, 'BLOCK');
  const wrongPolicy = await governed('tr-policy', safeItem, { ...governance, trust: ['T3'] });
  assert.equal(wrongPolicy.checks.find((check) => check.id === 'kb_planner_governance').status, 'BLOCK');
  const missingPolicy = await createVerifier({ tools: registry }).verifyRun({
    ...base,
    toolRuns: [{ id: 'tr-missing-policy', toolName: 'kb.search', status: 'succeeded', outcome: { items: [safeItem] } }],
    evidence: [await store.appendEvidence({ runId: run.id, kind: 'tool_executed', input: {}, output: {}, sourceIds: ['tr-missing-policy'], verdict: 'PASS' })]
  });
  assert.equal(missingPolicy.checks.find((check) => check.id === 'kb_planner_governance').status, 'BLOCK');
});

test('verifier: budget breaches and failed tool runs BLOCK the goal contract check', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const registry = createToolRegistry([
    { name: 'read.alpha', description: 'a', risk: RISK.read, async execute() { return {}; } }
  ]);
  const { store } = fixture;
  const thread = await store.createThread({ ownerId: 'owner', title: 'v' });
  const run = await runShape(store, thread);
  const contract = unitContract(run, 'هدف');
  const evidence = [
    await store.appendEvidence({ runId: run.id, kind: 'tool_call', input: {}, output: {}, sourceIds: ['tr-1'], verdict: 'BLOCK' })
  ];
  const result = await createVerifier({ tools: registry }).verifyRun({
    run: { ...run, usage: { ...run.usage, steps: 99 } },
    contract,
    steps: [{ id: 's1' }],
    toolRuns: [{ id: 'tr-1', toolName: 'read.alpha', status: 'failed', outcome: { error: 'x' } }],
    evidence,
    approvals: [],
    messages: []
  });
  const check = result.checks.find((item) => item.id === 'goal_contract');
  assert.equal(check.status, 'BLOCK');
  assert.match(check.detail, /budget_breached/);
  assert.match(check.detail, /failed_tool_run/);
});

test('verifier: a tampered ledger is BLOCK at the chain check, and verification never writes', async (t) => {
  const { fixture, runtime, thread } = await bootstrap(t);
  const submitted = await runtime.submit({ threadId: thread.id, message: 'عبث', clientMessageId: 'verify-tamper-01' });
  await runtime.runToCompletion(submitted.run.id);
  const before = await fixture.store.listEvidence(submitted.run.id);

  const target = before[1];
  await fixture.driver.run('UPDATE agent_evidence SET input_hash = ? WHERE id = ?', ['0'.repeat(64), target.id]);

  const detail = await runtime.detail(submitted.run.id);
  assert.equal(detail.evidenceChain.ok, false);
  const verifier = createVerifier({ tools: createToolRegistry([]) });
  const result = await verifier.verifyRun({
    run: detail.run,
    contract: detail.goalContract,
    steps: detail.steps,
    toolRuns: detail.toolRuns,
    evidence: detail.evidence,
    approvals: detail.approvals,
    messages: await fixture.store.listMessages(thread.id)
  });
  assert.equal(result.checks[0].id, 'evidence_chain');
  assert.equal(result.checks[0].status, 'BLOCK');
  assert.equal(result.verdict, VERDICT.block);

  const after = await fixture.store.listEvidence(submitted.run.id);
  assert.equal(after.length, before.length, 'the verifier is read-only');
});

// ── Outbox checks (AGENT-002) ────────────────────────────────────────────────
async function verifierShape(t) {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const recorder = createRecordingTools();
  const verifier = createVerifier({ tools: recorder.tools });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'outbox-verify' });
  const run = await runShape(fixture.store, thread);
  return { fixture, verifier, run };
}

const step = [{ id: 's1', kind: 'plan', title: 'خطوة' }];

test('verifier: a sent effect backed by an approved decision and a successful tool run passes', async (t) => {
  const { fixture, verifier, run } = await verifierShape(t);
  const entry = await fixture.store.appendEvidence({
    runId: run.id,
    kind: 'external_effect_enqueued',
    input: { tool: 'calendar.create' },
    output: { outboxId: 'ob-1' },
    sourceIds: ['ob-1']
  });
  const evidence = await fixture.store.listEvidence(run.id);
  const result = await verifier.verifyRun({
    run,
    contract: unitContract(run),
    steps: step,
    toolRuns: [{ id: 'tr-1', toolName: 'calendar.create', status: 'succeeded', outcome: '{"outboxStatus":"sent"}' }],
    evidence,
    approvals: [{ id: 'ap-1', toolName: 'calendar.create', decision: 'approved' }],
    outbox: [{ id: 'ob-1', toolName: 'calendar.create', status: 'sent', approvalId: 'ap-1', externalRef: 'evt-1' }],
    messages: []
  });
  assert.equal(entry.seq, 1);
  assert.equal(result.checks.find((check) => check.id === 'outbox_approval').status, 'PASS');
  assert.equal(result.checks.find((check) => check.id === 'outbox_outcome').status, 'PASS');
  assert.equal(result.checks.find((check) => check.id === 'outbox_evidence').status, 'PASS');
  assert.equal(result.checks.find((check) => check.id === 'outbox_tool_run_parity').status, 'PASS');
});

test('verifier: a sent effect without an approved decision is BLOCK', async (t) => {
  const { fixture, verifier, run } = await verifierShape(t);
  await fixture.store.appendEvidence({
    runId: run.id,
    kind: 'external_effect_settled',
    input: { tool: 'calendar.create' },
    output: { status: 'sent' },
    sourceIds: ['ob-1']
  });
  const evidence = await fixture.store.listEvidence(run.id);
  const result = await verifier.verifyRun({
    run,
    contract: unitContract(run),
    steps: step,
    toolRuns: [],
    evidence,
    approvals: [{ id: 'ap-1', toolName: 'calendar.create', decision: 'rejected' }],
    outbox: [{ id: 'ob-1', toolName: 'calendar.create', status: 'sent', approvalId: 'ap-1' }],
    messages: []
  });
  assert.equal(result.checks.find((check) => check.id === 'outbox_approval').status, 'BLOCK');
  assert.equal(result.verdict, VERDICT.block);
});

test('verifier: an unsettled intent is UNKNOWN — no delivery is claimed', async (t) => {
  const { fixture, verifier, run } = await verifierShape(t);
  await fixture.store.appendEvidence({
    runId: run.id,
    kind: 'external_effect_enqueued',
    input: { tool: 'calendar.create' },
    output: { status: 'pending' },
    sourceIds: ['ob-1']
  });
  const evidence = await fixture.store.listEvidence(run.id);
  const result = await verifier.verifyRun({
    run,
    contract: unitContract(run),
    steps: step,
    toolRuns: [],
    evidence,
    approvals: [],
    outbox: [{ id: 'ob-1', toolName: 'calendar.create', status: 'pending', approvalId: null }],
    messages: []
  });
  assert.equal(result.checks.find((check) => check.id === 'outbox_outcome').status, 'UNKNOWN');
  assert.equal(result.checks.find((check) => check.id === 'outbox_status_or')?.status, undefined);
  assert.equal(result.verdict, VERDICT.unknown);
});

test('verifier: an intent missing from the ledger is BLOCK', async (t) => {
  const { fixture, verifier, run } = await verifierShape(t);
  await fixture.store.appendEvidence({
    runId: run.id,
    kind: 'goal_contract',
    input: { objective: 'x' },
    output: null,
    sourceIds: ['message-1']
  });
  const evidence = await fixture.store.listEvidence(run.id);
  const result = await verifier.verifyRun({
    run,
    contract: unitContract(run),
    steps: step,
    toolRuns: [],
    evidence,
    approvals: [],
    outbox: [{ id: 'ob-ghost', toolName: 'calendar.create', status: 'failed', approvalId: null }],
    messages: []
  });
  const check = result.checks.find((item) => item.id === 'outbox_evidence');
  assert.equal(check.status, 'BLOCK');
  assert.match(check.detail, /calendar\.create/);
  assert.equal(result.verdict, VERDICT.block);
});

test('verifier: a sent intent with no matching successful tool run is BLOCK', async (t) => {
  const { fixture, verifier, run } = await verifierShape(t);
  await fixture.store.appendEvidence({
    runId: run.id,
    kind: 'external_effect_settled',
    input: { tool: 'calendar.create' },
    output: { status: 'sent' },
    sourceIds: ['ob-1', 'tr-1']
  });
  const evidence = await fixture.store.listEvidence(run.id);
  const result = await verifier.verifyRun({
    run,
    contract: unitContract(run),
    steps: step,
    toolRuns: [{ id: 'tr-1', toolName: 'read.alpha', status: 'succeeded', outcome: '{"alpha":true}' }],
    evidence,
    approvals: [{ id: 'ap-1', toolName: 'calendar.create', decision: 'approved' }],
    outbox: [{ id: 'ob-1', toolName: 'calendar.create', status: 'sent', approvalId: 'ap-1' }],
    messages: []
  });
  assert.equal(result.checks.find((check) => check.id === 'outbox_tool_run_parity').status, 'BLOCK');
  assert.equal(result.verdict, VERDICT.block);
});
