import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CELIA_SEVEN_STAGE_LOOP,
  TASK_CATEGORIES,
  recommendTaskStrategy,
  estimateTokenCost,
  evaluateProviderSafety,
  auditProductCatalog,
  buildCreativeWorkflowPlan,
  buildTruthPartition,
  computeAgentMetrics
} from '../src/agent/index.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createDefaultTools } from '../src/agent/tools.js';
import { createDemoPlanner } from '../src/agent/planner.js';
import { createFakeCalendar, createTempStore } from './support/agent-fixtures.js';

test('STEP-01 & STEP-02: recommendTaskStrategy maps each task class to the lowest-cost governed technique', () => {
  const pricing = recommendTaskStrategy({ goal: 'احسب سعر وضريبة وإجمالي الفاتورة' });
  assert.equal(pricing.category, TASK_CATEGORIES.pricingAndInvoices);
  assert.equal(pricing.technique, 'deterministic_code');
  assert.equal(pricing.modelTier, 'none');

  const doc = recommendTaskStrategy({ goal: 'استخرج بيانات الفاتورة invoice-valid-1042.csv' });
  assert.equal(doc.category, TASK_CATEGORIES.documentExtraction);
  assert.equal(doc.technique, 'structured_extraction_with_code_validation');

  const summary = recommendTaskStrategy({ goal: 'لخّص هذه الملاحظات وصنّفها' });
  assert.equal(summary.category, TASK_CATEGORIES.textSummarization);
  assert.equal(summary.technique, 'fast_low_cost_llm');

  const complex = recommendTaskStrategy({ goal: 'تحليل معقد لأسباب عطل التزامن وتصميم معمارية الحل' });
  assert.equal(complex.category, TASK_CATEGORIES.complexTechnicalAnalysis);
  assert.equal(complex.technique, 'reasoning_llm');

  const creative = recommendTaskStrategy({ goal: 'تصميم إعلان لحملة ملابس صيفية' });
  assert.equal(creative.category, TASK_CATEGORIES.creativeDesignAndAds);
  assert.equal(creative.technique, 'staged_creative_workflow');

  const external = recommendTaskStrategy({ goal: 'أرسل رسالة واتساب واحجز موعد تقويم' });
  assert.equal(external.category, TASK_CATEGORIES.externalToolAction);
  assert.equal(external.technique, 'governed_agent_with_outbox');
});

test('STEP-03: estimateTokenCost applies the token pricing formula and evaluateProviderSafety blocks PII/secrets on free tier', () => {
  const cost = estimateTokenCost({
    inputTokens: 250_000,
    outputTokens: 50_000,
    inputPricePerMillion: 0.4,
    outputPricePerMillion: 1.2,
    maxCostMicros: 200_000
  });
  // (0.25 * 0.4) + (0.05 * 1.2) = 0.10 + 0.06 = 0.16 USD = 160,000 micros
  assert.equal(cost.totalCostUsd, 0.16);
  assert.equal(cost.costMicros, 160_000);
  assert.equal(cost.withinBudget, true);

  const overBudget = estimateTokenCost({
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    inputPricePerMillion: 1.0,
    outputPricePerMillion: 2.0,
    maxCostMicros: 500_000
  });
  assert.equal(overBudget.withinBudget, false);

  const unsafeFree = evaluateProviderSafety({
    tier: 'free',
    containsCustomerPii: true,
    containsSecrets: false,
    timeoutMs: 8000,
    hasQuotaFallback: true
  });
  assert.equal(unsafeFree.allowed, false);
  assert.ok(unsafeFree.reasons.includes('customer_pii_blocked_on_free_tier'));

  const unsafeSecret = evaluateProviderSafety({
    tier: 'paid',
    containsCustomerPii: false,
    containsSecrets: true,
    timeoutMs: 0,
    hasQuotaFallback: false
  });
  assert.equal(unsafeSecret.allowed, false);
  assert.ok(unsafeSecret.reasons.includes('secrets_never_allowed_in_provider_payload'));
  assert.ok(unsafeSecret.reasons.includes('explicit_request_timeout_required'));
  assert.ok(unsafeSecret.reasons.includes('quota_exhaustion_fallback_required'));

  const safePaid = evaluateProviderSafety({
    tier: 'paid',
    containsCustomerPii: true,
    containsSecrets: false,
    timeoutMs: 8000,
    hasQuotaFallback: true
  });
  assert.equal(safePaid.allowed, true);
});

test('STEP-01 & STEP-05: auditProductCatalog and buildCreativeWorkflowPlan execute deterministically via tool registry', async () => {
  const tools = createDefaultTools({ statusProvider: () => ({ version: '0.2.1', storage: 'sqlite' }) });
  const catalogTool = tools.get('product.catalog_audit');
  const creativeTool = tools.get('creative.workflow_plan');
  assert.ok(catalogTool);
  assert.ok(creativeTool);

  const catalogReport = await catalogTool.execute({
    products: [
      {
        sku: 'SKU-101',
        name: 'قميص قطني مصري',
        price: 750,
        currency: 'EGP',
        category: 'ملابس رجالية',
        description: ''
      },
      {
        sku: '',
        name: 'حقيبة جلدية',
        price: -50,
        currency: 'EGP',
        category: ''
      }
    ]
  });
  assert.equal(catalogReport.capability, 'product_catalog_audit');
  assert.equal(catalogReport.total_products, 2);
  assert.equal(catalogReport.review_ready_products, 1);
  assert.equal(catalogReport.incomplete_or_invalid_products, 1);
  assert.equal(catalogReport.published_count, 0, 'Nothing is auto-published before owner review');
  assert.ok(catalogReport.items[0].proposed_description.includes('قميص قطني مصري'));
  assert.ok(catalogReport.items[1].missing_fields.includes('sku'));
  assert.ok(catalogReport.items[1].validation_errors.includes('invalid_price_must_be_positive_number'));

  const incompleteCreative = buildCreativeWorkflowPlan({ brand: 'Celia Wear', audience: '', message: '' });
  assert.equal(incompleteCreative.brief_complete, false);
  assert.equal(incompleteCreative.stages[1].status, 'blocked_by_brief');

  const completeCreative = await creativeTool.execute({
    brand: 'Celia Wear',
    audience: 'الشباب الجامعي في مصر',
    message: 'جودة قطن طبيعي بسعر يومي عادل',
    style: 'بسيط وعصري',
    dimensions: '1080x1350'
  });
  assert.equal(completeCreative.brief_complete, true);
  assert.equal(completeCreative.stages.length, 6);
  assert.equal(completeCreative.stages[1].output.directions.length, 3);
  assert.equal(completeCreative.stages[5].status, 'waiting_for_approval');
});

test('STEP-06: buildTruthPartition and runtime.metrics separate executed / verified / unverified and compute the 6 metrics', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const calendar = createFakeCalendar();
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: createDefaultTools({ statusProvider: () => ({ version: '0.2.1', storage: 'sqlite' }) }),
    planner: createDemoPlanner(),
    connectors: calendar.connectors,
    ownerId: 'owner',
    logger: { error() {} }
  });
  t.after(() => runtime.shutdown().catch(() => {}));

  assert.deepEqual(CELIA_SEVEN_STAGE_LOOP, [
    'Goal',
    'Plan',
    'Execute',
    'Observe',
    'Verify',
    'Evidence',
    'Improve'
  ]);

  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'اختبار الفصل الثلاثي والمؤشرات' });

  // Run 1: Valid invoice without external commit -> succeeded & verified
  const r1 = await runtime.submit({
    threadId: thread.id,
    message: 'استخرج بيانات الفاتورة invoice-valid-1042.csv',
    clientMessageId: 'eval-run-1'
  });
  await runtime.runToCompletion(r1.run.id);
  const d1 = await runtime.detail(r1.run.id);
  assert.equal(d1.truthPartition.executed.toolRunsCount, 4);
  assert.equal(d1.truthPartition.verified.verdict, 'PASS');
  assert.equal(d1.truthPartition.verified.comprehensionGateStatus, 'PASS');
  assert.equal(d1.truthPartition.unverified.count, 0);

  // Run 2: Calendar event parked at WAITING_FOR_APPROVAL -> unverified items > 0
  const r2 = await runtime.submit({
    threadId: thread.id,
    message: 'أنشئ موعد مراجعة أداء النظام غدًا',
    clientMessageId: 'eval-run-2'
  });
  await runtime.runToCompletion(r2.run.id);
  const d2 = await runtime.detail(r2.run.id);
  assert.equal(d2.truthPartition.executed.externalEffectsSentCount, 0);
  assert.ok(d2.truthPartition.unverified.count >= 2);
  assert.ok(d2.truthPartition.unverified.items.some((u) => u.kind === 'waiting_owner_approval'));

  // Metrics report aggregates both runs accurately:
  const report = await runtime.metrics('owner');
  assert.equal(report.metrics.totalRuns, 2);
  assert.equal(report.metrics.succeededRuns, 1);
  assert.equal(report.metrics.successRate, 0.5);
  assert.equal(report.metrics.dataAccuracyRate, 1);
  assert.equal(report.metrics.humanReviewCount, 1);
  assert.equal(report.strategyExamples.length, 6);
});
