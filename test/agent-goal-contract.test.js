import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempStore } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createScriptedPlanner } from '../src/agent/planner.js';
import { createRecordingTools, threeReadsThenFinish } from './support/agent-fixtures.js';
import {
  buildGoalContract,
  validateGoalContract,
  GOAL_CONTRACT_VERSION
} from '../src/agent/goal-contract.js';

const LIMITS = { maxSteps: 9, maxCostMicros: 50_000, maxDurationMs: 60_000 };

test('goal contract: deterministic builder exposes objective, criteria, constraints, stops, deadline, budget', () => {
  const createdAt = Date.UTC(2026, 9, 27, 10, 0, 0);
  const contract = buildGoalContract({ objective: '  جهّز خطة أسبوعية  ', limits: LIMITS, createdAt });
  assert.equal(contract.version, GOAL_CONTRACT_VERSION);
  assert.equal(contract.objective, 'جهّز خطة أسبوعية');
  assert.ok(contract.success_criteria.length >= 3);
  assert.ok(contract.success_criteria.every((entry) => typeof entry === 'string' && entry.trim()));
  assert.ok(contract.constraints.some((entry) => entry.includes('9')));
  assert.ok(contract.constraints.some((entry) => entry.includes('50000')));
  assert.deepEqual(contract.budget, { maxSteps: 9, maxCostMicros: 50_000, maxDurationMs: 60_000 });
  assert.equal(contract.deadline, new Date(createdAt + 60_000).toISOString());
  assert.ok(contract.stop_conditions.includes('verification_blocked'));

  const again = buildGoalContract({ objective: 'جهّز خطة أسبوعية', limits: LIMITS, createdAt });
  assert.deepEqual(again, contract, 'same inputs produce the same frozen contract');
});

test('goal contract: validation accepts a well-formed contract and names structural defects', () => {
  const contract = buildGoalContract({ objective: 'مهمة', limits: LIMITS, createdAt: Date.now() });
  assert.equal(validateGoalContract(contract).ok, true);

  const broken = validateGoalContract({ ...contract, success_criteria: [] });
  assert.equal(broken.ok, false);
  assert.ok(broken.errors.includes('success_criteria_required'));

  const noBudget = validateGoalContract({ ...contract, budget: { maxSteps: 0, maxCostMicros: 1, maxDurationMs: 1 } });
  assert.equal(noBudget.ok, false);
  assert.ok(noBudget.errors.includes('budget_max_steps_invalid'));

  assert.equal(validateGoalContract(null).ok, false);
  assert.equal(validateGoalContract({ ...contract, deadline: 'not-a-date' }).errors.includes('deadline_not_parseable'), true);
});

test('goal contract: every submitted run persists an inspectable contract and anchors it in the evidence chain', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: createRecordingTools().tools,
    planner: createScriptedPlanner(threeReadsThenFinish()),
    limits: LIMITS,
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'عقد' });
  const submitted = await runtime.submit({
    threadId: thread.id,
    message: 'حقق هذا الهدف القابل للفحص',
    clientMessageId: 'contract-key-001'
  });

  const stored = await fixture.store.getGoalContract(submitted.run.id);
  assert.ok(stored, 'the run carries a persisted goal contract');
  assert.equal(stored.objective, 'حقق هذا الهدف القابل للفحص');
  assert.equal(validateGoalContract(stored).ok, true);

  const evidence = await fixture.store.listEvidence(submitted.run.id);
  assert.equal(evidence[0].kind, 'goal_contract');
  assert.equal(evidence[0].seq, 1, 'the contract is the genesis entry of the chain');
  assert.ok(evidence[0].inputHash.length === 64);

  const detail = await runtime.detail(submitted.run.id);
  assert.equal(detail.goalContract.objective, stored.objective);
  assert.equal(detail.evidenceChain.ok, true);
});

test('goal contract: a duplicate submission does not create a second contract', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: createRecordingTools().tools,
    planner: createScriptedPlanner(threeReadsThenFinish()),
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'تكرار' });
  const first = await runtime.submit({ threadId: thread.id, message: 'مهمة', clientMessageId: 'dup-contract-01' });
  const second = await runtime.submit({ threadId: thread.id, message: 'مهمة', clientMessageId: 'dup-contract-01' });
  assert.equal(second.created, false);
  const evidence = await fixture.store.listEvidence(first.run.id);
  assert.equal(evidence.filter((entry) => entry.kind === 'goal_contract').length, 1);
});
