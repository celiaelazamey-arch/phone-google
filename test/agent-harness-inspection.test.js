import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempStore } from './support/agent-fixtures.js';
import { createDefaultTools } from '../src/agent/tools.js';
import { createDemoPlanner } from '../src/agent/planner.js';
import { createVerifier } from '../src/agent/verifier.js';
import { createEmptyConnectorRegistry } from '../src/agent/connectors.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { computeAgentMetrics, CELIA_SEVEN_STAGE_LOOP } from '../src/agent/evaluation.js';
import {
  HARNESS_COMPONENT_IDS,
  inspectAgentHarness
} from '../src/agent/harness.js';
import { EVIDENCE_LEDGER } from '../src/agent/evidence.js';
import { OUTBOX_SCHEME } from '../src/agent/outbox.js';

/**
 * DEC-117 — the audit surface must derive, not assert.
 *
 * `inspectAgentHarness` is served live at `GET /api/agent/harness`. Five of its ten
 * components used to return a literal `wired: true` under a docblock promising that
 * every claim is derived from live objects, so the surface reported capabilities it
 * never checked. These tests mirror the rule `access-policy`/`computer-policy` already
 * enforce: a component that is not observably wired says so and names what is absent.
 */

const APPROVAL_METHODS = [
  'requestApproval',
  'decideApproval',
  'listApprovals',
  'enqueueOutbox',
  'linkOutboxApproval'
];
const EVIDENCE_METHODS = ['appendEvidence', 'listEvidence', 'verifyEvidenceChain'];
const RECOVERY_METHODS = [
  'startToolRun',
  'findToolRunByKey',
  'reconcileToolRun',
  'findResumableRuns',
  'getOutboxByKey',
  'findStaleOutbox'
];

/** A stub store exposing only `methods`, so an absent capability is observable. */
function stubStore(methods, { dialect = 'sqlite' } = {}) {
  const store = { dialect };
  for (const method of methods) store[method] = async () => null;
  return store;
}

const fullStubStore = () =>
  stubStore([...APPROVAL_METHODS, ...EVIDENCE_METHODS, ...RECOVERY_METHODS]);

const component = (report, id) => report.components.find((item) => item.id === id);

async function wiredFixture(t) {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const tools = createDefaultTools({
    statusProvider: () => ({ version: '0.2.1', storage: 'sqlite' })
  });
  return {
    store: fixture.store,
    tools,
    planner: createDemoPlanner(),
    verifier: createVerifier({ tools }),
    connectors: createEmptyConnectorRegistry(),
    limits: { maxSteps: 12, maxCostMicros: 100_000 },
    evaluation: { computeAgentMetrics, CELIA_SEVEN_STAGE_LOOP }
  };
}

test('DEC-117: an unobserved harness wires nothing and claims nothing', () => {
  const report = inspectAgentHarness({});
  assert.equal(report.ok, false, 'an empty inspection must not report ok');
  assert.equal(report.components.length, HARNESS_COMPONENT_IDS.length);
  for (const item of report.components) {
    assert.equal(item.wired, false, `${item.id} claims to be wired with no live objects`);
  }
});

test('DEC-117: every component cites the basis it was derived from', async (t) => {
  const report = inspectAgentHarness(await wiredFixture(t));
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.components.map((item) => item.id),
    HARNESS_COMPONENT_IDS
  );
  for (const item of report.components) {
    assert.ok(Array.isArray(item.basis), `${item.id} carries no basis`);
    assert.ok(item.basis.length > 0, `${item.id} cites an empty basis`);
    assert.ok(Array.isArray(item.missing), `${item.id} carries no missing list`);
    assert.deepEqual(item.missing, [], `${item.id} is wired but reports missing probes`);
    assert.equal(item.wired, true, `${item.id} should be wired against a real store`);
  }
});

test('DEC-117: a store that cannot persist approvals unwires the gate and names the gap', () => {
  const store = stubStore([...EVIDENCE_METHODS, ...RECOVERY_METHODS]);
  const tools = createDefaultTools({
    statusProvider: () => ({ version: '0.2.1', storage: 'sqlite' })
  });
  const report = inspectAgentHarness({
    store,
    tools,
    planner: createDemoPlanner(),
    verifier: createVerifier({ tools }),
    connectors: createEmptyConnectorRegistry(),
    limits: {},
    evaluation: { computeAgentMetrics, CELIA_SEVEN_STAGE_LOOP }
  });

  const gate = component(report, 'policy_approval_gate');
  assert.equal(gate.wired, false, 'the gate claims to be wired without approval persistence');
  for (const method of ['requestApproval', 'decideApproval', 'enqueueOutbox']) {
    assert.ok(
      gate.missing.includes(`store.${method}`),
      `the gate does not name store.${method} as missing`
    );
  }
  // The rest of the surface stays honest and unaffected.
  assert.equal(component(report, 'evidence_observability').wired, true);
  assert.equal(component(report, 'recovery_idempotency').wired, true);
});

test('DEC-117: a store without a verifiable chain unwires evidence & observability', () => {
  const store = stubStore([...APPROVAL_METHODS, ...RECOVERY_METHODS]);
  const report = inspectAgentHarness({
    store,
    tools: null,
    planner: null,
    verifier: null,
    connectors: null,
    limits: {},
    evaluation: null
  });
  const evidence = component(report, 'evidence_observability');
  assert.equal(evidence.wired, false);
  assert.ok(evidence.missing.includes('store.verifyEvidenceChain'));
  assert.equal(evidence.ledger, EVIDENCE_LEDGER, 'the ledger id is single-sourced');
});

test('DEC-117: a store without idempotency lookups unwires recovery', () => {
  const store = stubStore([...APPROVAL_METHODS, ...EVIDENCE_METHODS]);
  const report = inspectAgentHarness({ store, limits: {} });
  const recovery = component(report, 'recovery_idempotency');
  assert.equal(recovery.wired, false);
  assert.ok(recovery.missing.includes('store.findToolRunByKey'));
  assert.ok(recovery.missing.includes('store.findStaleOutbox'));
});

test('DEC-117: evaluation_regression never claims the regression suite it cannot observe', async (t) => {
  const live = await wiredFixture(t);

  const unprobed = inspectAgentHarness({ ...live, evaluation: null });
  const unprobedComponent = component(unprobed, 'evaluation_regression');
  assert.equal(
    unprobedComponent.wired,
    false,
    'an absent evaluation probe must report false, never a literal true'
  );
  assert.ok(unprobedComponent.missing.includes('evaluation.computeAgentMetrics'));

  const probed = inspectAgentHarness(live);
  const probedComponent = component(probed, 'evaluation_regression');
  assert.equal(probedComponent.wired, true, 'the evaluation half is derivable from the module');
  // The regression half belongs to CI, not to this function — it is never claimed.
  assert.equal(probedComponent.regressionSuiteVerified, false);
  assert.ok(
    typeof probedComponent.notRuntimeVerifiable === 'string'
      && probedComponent.notRuntimeVerifiable.length > 0,
    'the component must state what it cannot verify'
  );
});

test('DEC-117: container isolation is derived from the probe, not asserted false', async (t) => {
  const live = await wiredFixture(t);
  const executor = component(inspectAgentHarness(live), 'sandbox_executor');
  assert.equal(executor.isolatedContainerAvailable, false, 'no probe means no isolation claimed');
  assert.ok(executor.executableToolCount > 0, 'the count is measured from the registry');

  const isolated = component(
    inspectAgentHarness({ ...live, sandbox: { isolatedContainerAvailable: true } }),
    'sandbox_executor'
  );
  assert.equal(isolated.isolatedContainerAvailable, true, 'the probe is what decides');
});

test('DEC-117: a registry with no executable tool unwires the sandbox executor', async (t) => {
  const live = await wiredFixture(t);
  const emptyTools = {
    get: () => null,
    has: () => false,
    list: () => [],
    executable: () => false,
    validateInput: () => ({ ok: true })
  };
  const executor = component(
    inspectAgentHarness({ ...live, tools: emptyTools }),
    'sandbox_executor'
  );
  assert.equal(executor.wired, false);
  assert.equal(executor.executableToolCount, 0);
  assert.ok(executor.missing.includes('no read/internal_write tool is registered'));
});

test('DEC-117: runtime.status() derives the gate and single-sources the scheme ids', async (t) => {
  const live = await wiredFixture(t);
  const runtime = createAgentRuntime({
    store: live.store,
    tools: live.tools,
    planner: live.planner,
    connectors: live.connectors,
    limits: live.limits,
    workerId: 'test-dec-117',
    logger: { error() {} }
  });
  t.after(() => runtime.shutdown().catch(() => {}));

  const status = runtime.status();
  assert.equal(status.approvalGate, true, 'a real store operates the gate');
  assert.equal(status.durable, true, 'sqlite is durable; an in-memory map is not');
  assert.equal(status.evidenceLedger, EVIDENCE_LEDGER);
  assert.equal(status.outbox, OUTBOX_SCHEME);

  // The runtime passes the live evaluation module, so the derived claim holds.
  const harness = runtime.harness();
  assert.equal(harness.components.length, HARNESS_COMPONENT_IDS.length);
  for (const item of harness.components) {
    assert.equal(item.wired, true, `${item.id} is not wired on a real runtime`);
    assert.deepEqual(item.missing, []);
  }
  assert.equal(component(harness, 'evaluation_regression').regressionSuiteVerified, false);
});
