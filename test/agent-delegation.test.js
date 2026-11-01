import test from 'node:test';
import assert from 'node:assert/strict';

import { createTempStore, createRecordingTools, threeReadsThenFinish } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createScriptedPlanner } from '../src/agent/planner.js';
import { RUN_STATUS } from '../src/agent/store.js';
import { MAX_DEPTH } from '../src/agent/delegation.js';

/**
 * The durable half of DEC-099: `planDelegation` decides, `runtime.delegate` creates the children.
 * These tests use the real store and the real loop — a delegated child is executed by the same
 * harness that runs a person's task, not by a mock that pretends to.
 */

const roster = [
  { id: 'researcher', tools: ['read.alpha', 'read.beta'], maxRisk: 'read' },
  { id: 'writer', tools: ['read.gamma'], maxRisk: 'read' }
];

const task = (extra = {}) => ({
  taskId: 't1',
  agent: 'researcher',
  objective: 'اقرأ المصدرين وحدّثني',
  steps: 3,
  costMicros: 5_000,
  ...extra
});

async function setup(t, { limits } = {}) {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const recorder = createRecordingTools();
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: recorder.tools,
    planner: createScriptedPlanner(threeReadsThenFinish()),
    limits: { maxSteps: 12, maxCostMicros: 100_000, ...limits },
    workerId: 'test-worker',
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'تفويض' });
  const submit = (message = 'مهمة الأب') => runtime.submit({ threadId: thread.id, message });
  return { fixture, recorder, runtime, thread, submit };
}

test('a parent hands two bounded tasks to child runs that really exist in the store', async (t) => {
  const { fixture, runtime, submit, thread } = await setup(t);
  const { run: parent } = await submit();

  const { plan, children } = await runtime.delegate({
    parentRunId: parent.id,
    roster,
    tasks: [task({ taskId: 'a', steps: 3, costMicros: 5_000 }), task({ taskId: 'b', agent: 'writer', steps: 2, costMicros: 4_000 })]
  });

  assert.equal(plan.executes, false, 'the contract never claims to have run anything');
  assert.equal(plan.accepted.length, 2);
  assert.equal(children.length, 2);

  for (const child of children) {
    assert.equal(child.run.threadId, thread.id, 'the child lives in the same thread as its parent');
    assert.equal(child.run.status, RUN_STATUS.queued);
    assert.equal(child.delegation.parentRunId, parent.id);
    assert.equal(child.delegation.planDigest, plan.digest);
    const link = await fixture.store.getDelegationForChild(child.run.id);
    assert.equal(link.taskId, child.delegation.taskId, 'the link is durable, not held in memory');
  }

  const accepted = plan.accepted.reduce((sum, child) => sum + child.steps, 0);
  assert.ok(accepted <= plan.parent.remainingSteps, 'the sum of children fits the parent remainder');
  assert.equal(children[0].run.limits.maxSteps, plan.accepted[0].steps, 'the child ceiling is the contract ceiling');
  assert.equal(children[0].run.limits.maxCostMicros, plan.accepted[0].costMicros);

  const steps = await fixture.store.listSteps(parent.id);
  const delegateStep = steps.find((step) => step.kind === 'delegate');
  assert.ok(delegateStep, 'the parent records that it delegated, in its own durable history');
  assert.match(delegateStep.summary, new RegExp(plan.digest));
});

test('a delegated child is executed by the same loop, and its finishing status is its own', async (t) => {
  const { fixture, runtime, submit } = await setup(t);
  const { run: parent } = await submit();
  const { children } = await runtime.delegate({ parentRunId: parent.id, roster, tasks: [task({ steps: 8, costMicros: 10_000 })] });

  const finished = await runtime.runToCompletion(children[0].run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded);
  const detail = await runtime.detail(children[0].run.id);
  assert.ok(detail.steps.length >= 6, 'the child ran a real plan/act/observe loop');
  assert.equal((await fixture.store.getDelegationForChild(children[0].run.id)).parentRunId, parent.id);

  const parentAfter = await fixture.store.getRun(parent.id);
  assert.equal(parentAfter.status, RUN_STATUS.queued, 'a child finishing does not finish the parent');
  assert.equal(await fixture.store.delegationDepth(children[0].run.id), 1);
});

test('a request beyond the remainder is refused by name and creates no run', async (t) => {
  const { fixture, runtime, submit } = await setup(t, { limits: { maxSteps: 3, maxCostMicros: 6_000 } });
  const { run: parent } = await submit();

  const { plan, children } = await runtime.delegate({
    parentRunId: parent.id,
    roster,
    tasks: [task({ taskId: 'fits', steps: 2, costMicros: 3_000 }), task({ taskId: 'too-big', steps: 9, costMicros: 4_000 })]
  });

  assert.equal(children.length, 1);
  assert.deepEqual(plan.refused.map((problem) => problem.code), ['budget_exhausted']);
  assert.equal(plan.refused[0].taskId, 'too-big');
  const runs = await fixture.store.listRuns(parent.threadId, { limit: 20 });
  assert.equal(runs.length, 2, 'only the parent and the one accepted child exist');
});

test('delegation carves the parent budget instead of doubling it', async (t) => {
  const { runtime, submit, fixture } = await setup(t, { limits: { maxSteps: 4, maxCostMicros: 100_000 } });
  const { run: parent } = await submit();

  await runtime.delegate({ parentRunId: parent.id, roster, tasks: [task({ steps: 3, costMicros: 1_000 })] });
  assert.deepEqual(await fixture.store.delegatedBudget(parent.id), { steps: 3, costMicros: 1_000 });

  // The parent has 4 steps total and has promised 3 of them: only one step of its own remains.
  const finished = await runtime.runToCompletion(parent.id);
  assert.equal(finished.status, RUN_STATUS.budgetExhausted);
  assert.equal(finished.lastError, 'step_budget_exhausted');
  const detail = await runtime.detail(parent.id);
  assert.ok(detail.steps.length <= 1, `the parent could only keep 1 step, kept ${detail.steps.length}`);
});

test('a parent cannot raise its own ceiling by asking for a bigger one', async (t) => {
  const { runtime, submit } = await setup(t);
  const { run: parent } = await submit();
  const { plan } = await runtime.delegate({
    parentRunId: parent.id,
    maxRisk: 'irreversible',
    roster,
    tasks: [task({ agent: 'writer' })]
  });
  assert.equal(plan.parent.maxRisk, 'read', 'nothing ran yet, so the ceiling is the most restrictive one');
});

test('depth is capped in the store too: the chain stops at MAX_DEPTH', async (t) => {
  const { runtime, submit, fixture } = await setup(t);
  const { run: root } = await submit();
  const first = await runtime.delegate({ parentRunId: root.id, roster, tasks: [task({ taskId: 'a', steps: 2 })] });
  const child = first.children[0].run;
  assert.equal(await fixture.store.delegationDepth(child.id), 1);

  const second = await runtime.delegate({ parentRunId: child.id, roster, tasks: [task({ taskId: 'b', steps: 2 })] });
  assert.equal(second.plan.accepted.length, 1, `depth ${MAX_DEPTH} is still allowed`);
  const grandchild = second.children[0].run;
  assert.equal(await fixture.store.delegationDepth(grandchild.id), MAX_DEPTH);

  const third = await runtime.delegate({ parentRunId: grandchild.id, roster, tasks: [task({ taskId: 'c', steps: 2 })] });
  assert.deepEqual(third.plan.refused.map((problem) => problem.code), ['depth_exceeded']);
  assert.equal(third.children.length, 0);
});

test('delegating from a finished run is refused, and the refusal says why', async (t) => {
  const { runtime, submit } = await setup(t);
  const { run: parent } = await submit();
  await runtime.runToCompletion(parent.id);

  const { plan, children } = await runtime.delegate({ parentRunId: parent.id, roster, tasks: [task()] });
  assert.equal(children.length, 0);
  assert.deepEqual(plan.refused.map((problem) => problem.code), ['parent_closed']);
});

test('asking twice for the same task returns the first child instead of minting a second budget', async (t) => {
  const { runtime, submit, fixture } = await setup(t);
  const { run: parent } = await submit();
  const first = await runtime.delegate({ parentRunId: parent.id, roster, tasks: [task({ taskId: 'same', steps: 2 })] });
  const second = await runtime.delegate({ parentRunId: parent.id, roster, tasks: [task({ taskId: 'same', steps: 2 })] });

  assert.equal(second.children[0].reused, true);
  assert.equal(second.children[0].delegation.childRunId, first.children[0].run.id, 'the same child, not a twin');
  assert.equal((await fixture.store.listDelegations(parent.id)).length, 1);
});

test('a parent run that does not exist is a 404, not a silent no-op', async (t) => {
  const { runtime } = await setup(t);
  await assert.rejects(runtime.delegate({ parentRunId: 'missing', roster, tasks: [task()] }), (error) => {
    assert.equal(error.status, 404);
    assert.equal(error.code, 'run_not_found');
    return true;
  });
});
