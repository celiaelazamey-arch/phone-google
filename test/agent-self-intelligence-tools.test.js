/**
 * SIE-001 / SI-2/E4 — أدوات القراءة الذاتية: سطح قرار المشتقّات المحكومة.
 *
 * العقيدة (تدقيق `SI-0` · `DEC-120`): لفّ لاشتقاق موجود في `src/design` بلا مصدر حقيقة ثانٍ
 * ولا مسار تنفيذ موازٍ — لذلك كل اختبار يقارن مخرَج الأداة بالاشتقاق المباشر نفسه، ويؤكد أن
 * ما لم يُرسَم يُعلَن (unmapped) لا يُهمَّل، وأن الفيّر يعيد تنفيذ الاشتقاق ويطابق بصمته.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createDefaultTools, createToolRegistry, selfIntelligenceToolDefinitions, validateToolInput } from '../src/agent/tools.js';
import {
  ARCH_MAP_VERSION,
  buildArchitectureMap,
  impactOf,
  scanModules
} from '../src/design/architecture-map.js';
import { buildAtlas, factsOf, fingerprintOfFacts } from '../src/design/system-atlas.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createScriptedPlanner } from '../src/agent/planner.js';
import { RUN_STATUS } from '../src/agent/store.js';
import { createTempStore } from './support/agent-fixtures.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';

const root = path.resolve(import.meta.dirname, '..');

test('SI-2/E4: three read tools registered — read risk, deterministic, closed contracts', () => {
  const tools = createDefaultTools({ documentAutomation: false });
  for (const name of ['celia.system_map', 'celia.system_impact', 'celia.system_facts', 'celia.system_snapshot']) {
    const tool = tools.get(name);
    assert.ok(tool, `${name} registered`);
    assert.equal(tool.risk, 'read');
    assert.notEqual(tool.requiresApproval, true, 'read tools never require approval');
    assert.equal(tool.deterministic, true);
    assert.equal(typeof tool.replayArgs, 'function');
    assert.equal(tool.timeoutMs, 10_000);
  }
  assert.deepEqual(tools.get('celia.system_map').arguments, {});
  assert.deepEqual(tools.get('celia.system_facts').arguments, {});
  assert.deepEqual(tools.get('celia.system_snapshot').arguments, {});
  assert.deepEqual(tools.get('celia.system_impact').arguments, { files: 'object' });
});

test('SI-2/E4: impact arguments are closed, typed, secret-guarded and path-safe', () => {
  const tools = createDefaultTools({ documentAutomation: false });
  const impact = tools.get('celia.system_impact');
  assert.equal(validateToolInput(impact, { files: ['src/agent/harness.js'] }).ok, true);
  assert.equal(
    validateToolInput(impact, { files: ['x.js'], accessToken: 'no' }).code,
    'policy_violation_secret_in_args'
  );
  assert.equal(validateToolInput(impact, { files2: [] }).code, 'policy_violation_unknown_argument');
  assert.equal(validateToolInput(impact, { files: 'src' }).code, 'policy_violation_argument_type');
  assert.equal(validateToolInput(impact, { files: [] }).code, 'invalid_impact_files');
  assert.equal(
    validateToolInput(impact, { files: Array.from({ length: 13 }, (_, index) => `f${index}.js`) }).code,
    'invalid_impact_files'
  );
  assert.equal(validateToolInput(impact, { files: ['../escape.js'] }).code, 'invalid_impact_path');
  assert.equal(validateToolInput(impact, { files: ['/abs/path.js'] }).code, 'invalid_impact_path');
  assert.equal(validateToolInput(impact, { files: ['   '] }).code, 'invalid_impact_file');
});

test('SI-2/E4: no second source of truth — every tool output equals the direct derivation', async () => {
  const tools = createDefaultTools({ documentAutomation: false });
  const map = buildArchitectureMap({ root });
  const modules = scanModules(root);

  const viaImpact = await tools
    .get('celia.system_impact')
    .execute({ files: ['src/agent/harness.js', 'docs/nowhere.txt'] }, {});
  assert.deepEqual(viaImpact, impactOf(['src/agent/harness.js', 'docs/nowhere.txt'], map, modules));
  assert.deepEqual(viaImpact.components, ['agent_runtime', 'kernel']);
  assert.deepEqual(viaImpact.unmapped, ['docs/nowhere.txt'], 'unmapped is declared, never silently dropped');

  const viaMap = await tools.get('celia.system_map').execute({}, {});
  assert.deepEqual(viaMap, map);
  assert.equal(viaMap.version, ARCH_MAP_VERSION);
  assert.equal(viaMap.components.length, 16);

  const viaFacts = await tools.get('celia.system_facts').execute({}, {});
  const directFacts = factsOf(buildAtlas({ root }));
  assert.deepEqual(viaFacts, directFacts);
  assert.equal(viaFacts.fingerprint, fingerprintOfFacts(directFacts));
  assert.equal(viaFacts.totals.domains, 12);
});

test('SI-2/E4: the agent reaches the decision surface in a real run, and the verifier replays it', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: createDefaultTools({ documentAutomation: false }),
    planner: createScriptedPlanner([
      { action: 'call', tool: 'celia.system_impact', args: { files: ['src/agent/harness.js'] } }
    ]),
    workerId: 'si2e4-test-worker',
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'سطح القرار' });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'ما أثر تغيير harness.js؟' });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded);

  const detail = await runtime.detail(run.id);
  const toolRun = detail.toolRuns.find((entry) => entry.toolName === 'celia.system_impact');
  assert.equal(toolRun.status, 'succeeded');
  assert.deepEqual(toolRun.outcome.components, ['agent_runtime', 'kernel']);
  assert.deepEqual(toolRun.outcome.unmapped, []);
  assert.equal(detail.evidenceChain.ok, true);

  const summaries = detail.steps.map((step) => step.summary ?? '').join('\n');
  assert.match(
    summaries,
    /deterministic_reexecution:celia\.system_impact=PASS/i,
    'the verifier re-derives the impact from the recorded outcome and the hash matches'
  );
});

test('SI-1/A4: the snapshot composes the direct derivations — no second source, no silent omission', async () => {
  const statusStub = {
    enabled: true,
    dialect: 'sqlite',
    durable: true,
    planner: 'demo',
    verifier: 'default',
    approvalGate: true,
    evidenceLedger: 'evidence-v1',
    outbox: 'outbox-v1',
    limits: { keptOut: true },
    connectors: [{ name: 'x' }],
    ownerId: 'owner',
    note: '…',
    tools: [
      { name: 'celia.system_map', risk: 'read' },
      { name: 'google.calendar_create_event', risk: 'external_effect' }
    ]
  };
  const tools = createDefaultTools({ documentAutomation: false, statusProvider: () => statusStub });
  const snap = await tools.get('celia.system_snapshot').execute({}, {});

  assert.equal(snap.runtime.enabled, true);
  assert.equal(snap.runtime.durable, true);
  assert.equal(snap.runtime.approvalGate, true);
  assert.equal(snap.runtime.toolsCount, 2);
  assert.deepEqual(snap.runtime.tools, [{ name: 'celia.system_map', risk: 'read' }, { name: 'google.calendar_create_event', risk: 'external_effect' }]);
  for (const key of ['limits', 'connectors', 'ownerId', 'note']) {
    assert.equal(key in snap.runtime, false, `${key} stays out of the surface`);
    assert.ok(snap.runtime.omitted.includes(key), `${key} omission is declared`);
  }

  const map = buildArchitectureMap({ root });
  assert.deepEqual(snap.map, map, 'map slice equals the direct derivation');
  const directFacts = factsOf(buildAtlas({ root }));
  assert.deepEqual(snap.capabilities, directFacts, 'capabilities slice equals the direct derivation');
  assert.equal(snap.capabilities.fingerprint, fingerprintOfFacts(directFacts));

  const expectedPolicy = map.components
    .filter((component) => component.activation?.state && component.activation.state !== 'on')
    .map((component) => ({ id: component.id, state: component.activation.state, evidence: component.activation.evidence }));
  assert.deepEqual(snap.policy, expectedPolicy, 'policy is derived from the same map, never stored');
  assert.ok(expectedPolicy.some((entry) => entry.state === 'off_by_default'), 'the measured off-by-default posture is visible');

  assert.equal(snap.repo.available, true);
  assert.equal(snap.repo.head, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
  assert.equal(snap.repo.branch, execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
});

test('SI-1/A4: outside a repository with no status provider, unavailability is explicit — never invented', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-snapshot-noop-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const registry = createToolRegistry(selfIntelligenceToolDefinitions({ root: directory }));
  const snap = await registry.get('celia.system_snapshot').execute({}, {});
  assert.equal(snap.runtime.enabled, null, 'no status provider means unobserved, not true');
  assert.equal(snap.runtime.toolsCount, null);
  assert.equal(snap.repo.available, false);
  assert.match(snap.repo.reason, /^git_unavailable/);
  assert.equal(snap.map.version, 'celiaos-architecture-map-v1', 'the derivations still derive from the given tree');
});
