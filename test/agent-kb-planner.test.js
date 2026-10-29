import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTempStore } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createProviderPlanner } from '../src/agent/planner-provider.js';
import { createVerifier } from '../src/agent/verifier.js';
import { createToolRegistry, defaultToolDefinitions } from '../src/agent/tools.js';
import { RUN_STATUS } from '../src/agent/store.js';
import { KnowledgeStore } from '../src/knowledge/store.js';
import { ingestDirectory } from '../src/knowledge/ingest.js';
import { PLANNER_KB_POLICY } from '../src/knowledge/governance.js';

const registryDir = path.resolve(import.meta.dirname, '..', 'data', 'kb');
const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const ALLOWED = ['kb.search', 'celia.system_status'];

function callKbPlan() {
  return {
    action: 'call',
    tool: 'kb.search',
    args: { query: 'ربط جوجل', limit: 4 },
    summary: null,
    rationale: 'أحتاج دليلًا تشغيليًا محليًا قبل صياغة الإجابة.',
    successCriteria: ['تُعاد نتيجة قراءة محلية موثقة وتُستهلك في القرار التالي.']
  };
}

function finishPlan(summary) {
  return {
    action: 'finish',
    tool: null,
    args: null,
    summary,
    rationale: 'النتيجة الموثقة كافية لهذه المهمة المحدودة.',
    successCriteria: ['يستشهد الملخص بالدليل المقبول وتاريخ مراجعته.']
  };
}

test('AI-002 + KB: Runtime executes governed kb.search and the next model decision consumes tool_result', async (t) => {
  const kbDirectory = mkdtempSync(path.join(os.tmpdir(), 'celia-kb-planner-'));
  const kb = await KnowledgeStore.open({ file: path.join(kbDirectory, 'kb.sqlite3'), clock: () => NOW });
  t.after(() => {
    kb.close();
    rmSync(kbDirectory, { recursive: true, force: true });
  });
  await ingestDirectory({ store: kb, directory: registryDir, dryRun: false, full: true, clock: () => NOW });

  // These rows match the same query but must never cross the planner boundary.
  kb.upsertSource({
    id: 'src-planner-unsafe-fixture',
    kind: 'csv',
    uri: 'repo://planner-unsafe-fixture.csv',
    license: 'internal-owner',
    trust: 'T1',
    staleAfterDays: 365
  });
  for (const [id, claimType, reviewDue] of [
    ['planner-historical-fixture', 'historical_report', '2027-01-27'],
    ['planner-expired-fixture', 'operational_guidance', '2026-10-28']
  ]) {
    kb.putItem({
      id,
      sourceId: 'src-planner-unsafe-fixture',
      kind: 'doc',
      title: `ربط جوجل ${id}`,
      body: 'ربط جوجل — مادة اختبار لا يجوز أن تصبح تعليمة للمخطط',
      contentHash: `hash-${id}`,
      trust: 'T1',
      uri: `https://example.test/${id}`,
      sourceUpdatedAt: '2026-10-29',
      claimType,
      reviewDue
    });
  }

  const tools = createToolRegistry(defaultToolDefinitions({ kb, plannerSafe: true }));
  const requests = [];
  let citedId = null;
  let citedReviewDue = null;
  const provider = {
    name: 'mock-kb-provider',
    model: 'deterministic-mock',
    async createPlan(request) {
      requests.push(request);
      const results = request.state.toolResults;
      if (results.length === 0) return { plan: callKbPlan(), model: 'deterministic-mock' };

      assert.equal(results.length, 1);
      assert.equal(results[0].name, 'kb.search');
      assert.equal(results[0].status, 'succeeded');
      const outcome = results[0].content;
      assert.equal(outcome.governance.profile, PLANNER_KB_POLICY.profile);
      assert.ok(outcome.governance.excluded >= 2, 'unsafe matching rows were excluded before the model saw them');
      assert.ok(outcome.items.length > 0, 'an eligible operational document remains available');
      assert.equal(outcome.items.some((item) => item.id.includes('fixture')), false);
      for (const item of outcome.items) {
        assert.equal(item.claimType, 'operational_guidance');
        assert.equal(item.reviewStatus, 'current');
        assert.equal(item.plannerEligible, true);
        assert.ok(['T1', 'T2'].includes(item.trust));
        assert.ok(item.uri && item.licence);
      }
      citedId = outcome.items[0].id;
      citedReviewDue = outcome.items[0].reviewDue;
      return {
        plan: finishPlan(`اعتمدت الإجابة على ${citedId}؛ المراجعة القادمة ${citedReviewDue}.`),
        model: 'deterministic-mock'
      };
    }
  };
  assert.throws(
    () => createProviderPlanner({
      provider,
      tools: createToolRegistry(defaultToolDefinitions({ kb })),
      allowedTools: ALLOWED
    }),
    /plannerSafe/,
    'Provider construction fails closed when KB was not built with plannerSafe:true'
  );
  const planner = createProviderPlanner({ provider, tools, allowedTools: ALLOWED });
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools,
    planner,
    plannerToolAllowlist: ALLOWED,
    limits: { maxSteps: 8, maxCostMicros: 1000 },
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'AI-002 KB vertical' });
  const { run } = await runtime.submit({
    threadId: thread.id,
    message: 'ابحث عن ربط جوجل ثم استخدم الدليل في الإجابة',
    clientMessageId: 'ai002-kb-vertical-01'
  });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded, JSON.stringify({ lastError: finished.lastError, status: finished.status }));
  assert.equal(requests.length, 2, 'the provider is called again after tool execution');
  assert.ok(citedId, 'the final decision used an actual returned citation');
  assert.match(finished.lastError || '', /^$/);

  const detail = await runtime.detail(run.id);
  assert.equal(detail.verification.verdict, 'PASS');
  assert.equal(detail.evidenceChain.ok, true);
  assert.equal(detail.toolRuns.length, 1);
  assert.equal(detail.toolRuns[0].toolName, 'kb.search');
  assert.equal(detail.outbox.length, 0);
  assert.equal(detail.approvals.length, 0);
  assert.ok(detail.steps.at(-1).summary.includes(citedId));
  assert.ok(detail.steps.at(-1).summary.includes(citedReviewDue));
  const independent = await createVerifier({ tools }).verifyRun({
    run: detail.run,
    contract: detail.goalContract,
    steps: detail.steps,
    toolRuns: detail.toolRuns,
    evidence: detail.evidence,
    approvals: detail.approvals,
    outbox: detail.outbox,
    messages: await fixture.store.listMessages(thread.id)
  });
  assert.equal(independent.verdict, 'PASS');
  assert.equal(independent.checks.find((check) => check.id === 'kb_planner_governance')?.status, 'PASS');
  const kinds = detail.evidence.map((entry) => entry.kind);
  assert.deepEqual(
    kinds.filter((kind) => ['plan_created', 'tool_selected', 'tool_executed', 'verification_result'].includes(kind)),
    ['plan_created', 'tool_selected', 'tool_executed', 'plan_created', 'verification_result']
  );
  for (const entry of detail.evidence.filter((item) => ['plan_created', 'tool_selected', 'tool_executed', 'verification_result'].includes(item.kind))) {
    assert.ok(entry.stepId);
    assert.match(entry.inputHash, /^[a-f0-9]{64}$/);
    assert.match(entry.outputHash, /^[a-f0-9]{64}$/);
  }
  const returnedToModel = requests[1].messages.find((message) => message.type === 'tool_result');
  assert.equal(returnedToModel.content.items[0].id, citedId);
  assert.equal(returnedToModel.content.governance.profile, PLANNER_KB_POLICY.profile);
});
