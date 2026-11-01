import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DELEGATION_VERSION,
  MAX_DEPTH,
  MAX_FANOUT,
  REFUSAL,
  checkDelegation,
  delegationDigest,
  describeDelegation,
  parentDigest,
  planDelegation
} from '../src/agent/delegation.js';

const roster = [
  { id: 'researcher', tools: ['kb.search', 'web.fetch'], maxRisk: 'read' },
  { id: 'writer', tools: ['kb.search', 'kb.write'], maxRisk: 'internal_write' },
  { id: 'sender', tools: ['gmail.send'], maxRisk: 'external_effect' }
];

const parent = (extra = {}) => ({
  runId: 'run-parent-1',
  status: 'running',
  depth: 0,
  remainingSteps: 8,
  remainingCostMicros: 50_000,
  maxRisk: 'internal_write',
  tools: ['kb.search', 'web.fetch', 'kb.write'],
  evidenceIds: ['ev-1', 'ev-2'],
  ...extra
});

const task = (extra = {}) => ({
  taskId: 't1',
  agent: 'researcher',
  objective: 'اجمع ثلاث مصادر عن موعد الإطلاق',
  steps: 3,
  costMicros: 9_000,
  ...extra
});

const codes = (plan) => plan.refused.map((problem) => problem.code).sort();

test('a bounded request produces a plan whose children never exceed the parent', () => {
  const plan = planDelegation({ parent: parent(), roster, tasks: [task()] });
  assert.equal(plan.version, DELEGATION_VERSION);
  assert.equal(plan.executes, false, 'the contract decides; it does not pretend to run');
  assert.equal(plan.accepted.length, 1);
  assert.equal(plan.refused.length, 0);
  const child = plan.accepted[0];
  assert.equal(child.parentRunId, 'run-parent-1');
  assert.equal(child.depth, 1);
  assert.equal(child.steps, 3);
  assert.ok(child.steps <= plan.parent.remainingSteps);
  assert.match(child.parentDigest, /^[0-9a-f]{12}$/);
  assert.match(child.delegationId, /^dlg:[0-9a-f]{12}$/);
  assert.equal(plan.allocated.steps, 3);
  assert.equal(plan.unallocated.steps, 5);
});

test('a budget that does not fit is refused with the remainder named, never quietly trimmed', () => {
  const plan = planDelegation({
    parent: parent({ remainingSteps: 2, remainingCostMicros: 5_000 }),
    roster,
    tasks: [task({ steps: 5, costMicros: 1_000 })]
  });
  assert.equal(plan.accepted.length, 0);
  assert.deepEqual(codes(plan), ['budget_exhausted']);
  assert.match(plan.refused[0].detail, /المتبقي 2\/5000/);
  assert.equal(plan.allocated.steps, 0);
});

test('children split the remaining budget in a deterministic order, and the sum never exceeds it', () => {
  const tasks = [
    task({ taskId: 'b', steps: 4, costMicros: 10_000 }),
    task({ taskId: 'a', steps: 3, costMicros: 8_000 }),
    task({ taskId: 'c', steps: 4, costMicros: 9_000 })
  ];
  const plan = planDelegation({ parent: parent({ remainingSteps: 8, remainingCostMicros: 20_000 }), roster, tasks });
  const acceptedSteps = plan.accepted.reduce((sum, child) => sum + child.steps, 0);
  assert.ok(acceptedSteps <= 8, 'the sum of children cannot exceed what the parent has left');
  assert.deepEqual(plan.accepted.map((child) => child.taskId), ['a', 'b'], 'sorted by taskId, not by arrival');
  assert.deepEqual(codes(plan), ['budget_exhausted']);
  const reversed = planDelegation({ parent: parent({ remainingSteps: 8, remainingCostMicros: 20_000 }), roster, tasks: [...tasks].reverse() });
  assert.equal(reversed.digest, plan.digest, 'input order must not change the decision');
});

test('a child may not be handed risk the parent does not hold', () => {
  const plan = planDelegation({
    parent: parent({ maxRisk: 'read' }),
    roster,
    tasks: [task({ agent: 'sender', tools: ['gmail.send'], risk: 'external_effect' })]
  });
  assert.deepEqual(codes(plan), ['risk_widening']);
  assert.match(plan.refused[0].detail, /external_effect > read/);
});

test('a tool outside the parent scope is refused, even when the agent declares it', () => {
  const plan = planDelegation({
    parent: parent({ maxRisk: 'external_effect' }),
    roster,
    tasks: [task({ agent: 'sender', tools: ['gmail.send'], risk: 'external_effect' })]
  });
  assert.deepEqual(codes(plan), ['tool_not_granted']);
  assert.match(plan.refused[0].detail, /gmail\.send/);
});

test('an agent that is not in the roster is refused by name, never invented', () => {
  const plan = planDelegation({ parent: parent(), roster, tasks: [task({ agent: 'ghost' })] });
  assert.deepEqual(codes(plan), ['unknown_agent']);
  assert.match(plan.refused[0].detail, /ghost/);
  assert.equal(plan.accepted.length, 0);
});

test('delegation cannot recurse past the cap', () => {
  const deep = planDelegation({ parent: parent({ depth: MAX_DEPTH }), roster, tasks: [task()] });
  assert.deepEqual(codes(deep), ['depth_exceeded']);
  assert.match(deep.refused[0].detail, new RegExp(`العمق ${MAX_DEPTH + 1} > ${MAX_DEPTH}`));
  const atLimit = planDelegation({ parent: parent({ depth: MAX_DEPTH - 1 }), roster, tasks: [task()] });
  assert.equal(atLimit.accepted.length, 1, 'the last permitted hop is still permitted');
});

test('fan-out is capped, and the task past the cap is named', () => {
  const tasks = Array.from({ length: MAX_FANOUT + 2 }, (_, index) =>
    task({ taskId: `t${index + 1}`, steps: 1, costMicros: 1_000 })
  );
  const plan = planDelegation({ parent: parent({ remainingSteps: 50, remainingCostMicros: 50_000 }), roster, tasks });
  assert.equal(plan.accepted.length, MAX_FANOUT);
  assert.deepEqual(codes(plan), ['fanout_exceeded', 'fanout_exceeded']);
});

test('a closed or missing parent cannot delegate at all', () => {
  const closed = planDelegation({ parent: parent({ status: 'succeeded' }), roster, tasks: [task()] });
  assert.deepEqual(codes(closed), ['parent_closed']);
  const orphan = planDelegation({ parent: {}, roster, tasks: [task()] });
  assert.ok(codes(orphan).includes('no_parent'));
});

test('an objective that looks like a credential is refused rather than copied', () => {
  const plan = planDelegation({
    parent: parent(),
    roster,
    tasks: [task({ objective: 'استخدم المفتاح sk-9f2b7c41d8e35a60b1c2 للتشغيل' })]
  });
  assert.deepEqual(codes(plan), ['objective_carries_secret']);
  assert.equal(JSON.stringify(plan.accepted), '[]');
  assert.ok(!JSON.stringify(plan).includes('sk-9f2b7c41d8e35a60b1c2'), 'the secret must not survive in the plan');
});

test('an empty objective, a duplicate id, or a bad amount is refused with its own reason', () => {
  const plan = planDelegation({
    parent: parent(),
    roster,
    tasks: [
      task({ taskId: 'e1', objective: '   ' }),
      task({ taskId: 'd1' }),
      task({ taskId: 'd1' }),
      task({ taskId: 'z0', steps: 0 }),
      task({ taskId: 'n1', steps: 'كثير' })
    ]
  });
  assert.deepEqual(codes(plan), ['duplicate_task', 'empty_objective', 'invalid_amount', 'invalid_amount']);
  assert.equal(plan.accepted.length, 1, 'the valid duplicate still passes once');
});

test('the same sources always yield the same digest, and any edit changes it', () => {
  const first = planDelegation({ parent: parent(), roster, tasks: [task()] });
  const second = planDelegation({ parent: parent(), roster, tasks: [task()] });
  assert.equal(first.digest, second.digest);
  const inflated = { ...first, accepted: [{ ...first.accepted[0], steps: 99 }] };
  assert.notEqual(delegationDigest(inflated), first.digest, 'a raised budget cannot keep the old fingerprint');
});

test('checkDelegation names every edit: dropped, invented, raised, swapped', () => {
  const sources = { parent: parent(), roster, tasks: [task({ taskId: 'a' }), task({ taskId: 'b', steps: 2, costMicros: 4_000 })] };
  const plan = planDelegation(sources);

  const dropped = { ...plan, accepted: plan.accepted.filter((child) => child.taskId !== 'b') };
  dropped.digest = delegationDigest(dropped);
  assert.deepEqual(checkDelegation(dropped, sources).problems.map((p) => p.code).sort(), ['child_dropped']);

  const invented = {
    ...plan,
    accepted: [...plan.accepted, { ...plan.accepted[0], taskId: 'ghost-task', delegationId: 'dlg:000000000000' }]
  };
  assert.deepEqual(checkDelegation(invented, sources).problems.map((p) => p.code).sort(), ['child_invented', 'digest_forged']);

  const raised = {
    ...plan,
    accepted: plan.accepted.map((child) => (child.taskId === 'a' ? { ...child, steps: 7, costMicros: 45_000 } : child))
  };
  raised.digest = delegationDigest(raised);
  assert.deepEqual(checkDelegation(raised, sources).problems.map((p) => p.code).sort(), ['budget_raised']);

  const swapped = {
    ...plan,
    accepted: plan.accepted.map((child) => (child.taskId === 'a' ? { ...child, agent: 'sender', risk: 'external_effect' } : child))
  };
  swapped.digest = delegationDigest(swapped);
  assert.deepEqual(checkDelegation(swapped, sources).problems.map((p) => p.code).sort(), ['agent_swapped', 'risk_raised']);
});

test('a hidden refusal and a stale fingerprint are both caught', () => {
  const sources = { parent: parent({ remainingSteps: 1, remainingCostMicros: 1_000 }), roster, tasks: [task({ steps: 5, costMicros: 9_000 })] };
  const plan = planDelegation(sources);
  const silenced = { ...plan, refused: [] };
  silenced.digest = delegationDigest(silenced);
  assert.deepEqual(checkDelegation(silenced, sources).problems.map((p) => p.code).sort(), ['refusal_hidden']);

  const forged = { ...plan, refused: [], digest: plan.digest };
  const result = checkDelegation(forged, sources);
  assert.ok(result.problems.some((problem) => problem.code === 'digest_forged'));
  assert.equal(result.ok, false);
});

test('a valid plan verifies against its sources, and a missing plan is reported not thrown', () => {
  const sources = { parent: parent(), roster, tasks: [task()] };
  const plan = planDelegation(sources);
  assert.equal(checkDelegation(plan, sources).ok, true);
  const missing = checkDelegation(null, sources);
  assert.equal(missing.ok, false);
  assert.equal(missing.problems[0].code, 'plan_missing');
});

test('the parent digest changes with the ceiling and with the evidence it collected', () => {
  const base = parentDigest({ runId: 'r1', maxRisk: 'read', depth: 0, evidenceIds: ['a', 'b'] });
  assert.equal(base, parentDigest({ runId: 'r1', maxRisk: 'read', depth: 0, evidenceIds: ['b', 'a'] }), 'evidence order is not identity');
  assert.notEqual(base, parentDigest({ runId: 'r1', maxRisk: 'internal_write', depth: 0, evidenceIds: ['a', 'b'] }));
  assert.notEqual(base, parentDigest({ runId: 'r1', maxRisk: 'read', depth: 0, evidenceIds: ['a'] }));
});

test('the Arabic report names each child and each refusal, and says it does not execute', () => {
  const plan = planDelegation({
    parent: parent({ remainingSteps: 2, remainingCostMicros: 3_000 }),
    roster,
    tasks: [task({ taskId: 'ok', steps: 2, costMicros: 3_000 }), task({ taskId: 'no', steps: 6, costMicros: 9_000 })]
  });
  const text = describeDelegation(plan);
  assert.match(text, /فوّض 1 مهمة/);
  assert.match(text, /← ok: researcher/);
  assert.match(text, /✕ no: .*الميزانية/);
  assert.match(text, /العقد يقرر ولا ينفّذ/);
});

test('every refusal carries a written reason in Arabic, and the refusal codes are all reachable', () => {
  for (const [code, reason] of Object.entries(REFUSAL)) {
    assert.ok(reason && /[\u0600-\u06FF]/.test(reason), `${code} has no Arabic reason`);
  }
  const cases = [
    planDelegation({ parent: parent(), roster, tasks: [task({ agent: 'ghost' })] }),
    planDelegation({ parent: parent({ depth: MAX_DEPTH }), roster, tasks: [task()] }),
    planDelegation({ parent: parent(), roster, tasks: [task({ agent: 'sender', risk: 'external_effect' })] }),
    planDelegation({ parent: parent(), roster, tasks: [task({ steps: 99 })] })
  ];
  for (const plan of cases) {
    assert.ok(plan.refused.length > 0);
    for (const problem of plan.refused) assert.ok(problem.detail && /[\u0600-\u06FF]/.test(problem.detail), `${problem.code} refusal is not written in Arabic`);
  }
});

test('the CLI exits 0 when everything fits and 1 when something is refused', async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');

  const dir = mkdtempSync(path.join(tmpdir(), 'celia-delegation-'));
  const run = (snapshot) => {
    const file = path.join(dir, `snap-${Math.random().toString(16).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(snapshot));
    try {
      const stdout = execFileSync(process.execPath, ['scripts/delegation.mjs', file, '--json'], { encoding: 'utf8' });
      return { code: 0, stdout };
    } catch (error) {
      return { code: error.status, stdout: String(error.stdout || '') };
    }
  };

  const ok = run({ parent: parent(), roster, tasks: [task()] });
  assert.equal(ok.code, 0);
  assert.equal(JSON.parse(ok.stdout).accepted.length, 1);

  const refused = run({ parent: parent({ remainingSteps: 0 }), roster, tasks: [task()] });
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.stdout).refused[0].code, 'budget_exhausted');
});
