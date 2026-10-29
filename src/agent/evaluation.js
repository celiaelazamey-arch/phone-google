/**
 * CeliaOS 6-Step AI Application & Evaluation Engine (DEC-023).
 *
 * Implements the practical 6-step engineering methodology:
 *   1. Define the task before choosing a model (Input → Required Output → Testable Success Criterion).
 *   2. Choose the right technique/model tier (deterministic code vs fast LLM vs reasoning vs multimodal).
 *   3. Control cost and stability (token cost formula, quota/timeout bounds, free-tier PII/secret guard).
 *   4. Combine techniques in one governed loop (Goal → Plan → Execute → Verify → Approval/Delivery).
 *   5. Turn integration into structured production (Product Catalog Audit & 6-Stage Creative Workflow).
 *   6. Measure outcomes and separate truth into 3 explicit buckets:
 *      - `executed`   (ما نُفّذ فعلًا: تؤكده سجلات التنفيذ)
 *      - `verified`   (ما تحقّق منه النظام: تؤكده اختبارات وقواعد مستقلة)
 *      - `unverified` (ما لم يثبت بعد: يبقى غير متحقق حتى لو بدا الناتج مقنعًا)
 */

import { SETTLED_TOOL_STATUSES, summarizeDurations, toolRunDurationMs } from './timing.js';

export const CELIA_SEVEN_STAGE_LOOP = Object.freeze([
  'Goal',
  'Plan',
  'Execute',
  'Observe',
  'Verify',
  'Evidence',
  'Improve'
]);

export const TASK_CATEGORIES = Object.freeze({
  pricingAndInvoices: 'pricing_and_invoices',
  documentExtraction: 'document_extraction',
  textSummarization: 'text_summarization_classification',
  complexTechnicalAnalysis: 'complex_technical_analysis',
  creativeDesignAndAds: 'creative_design_and_ads',
  externalToolAction: 'external_site_or_tool_actions'
});

const STRATEGY_TABLE = Object.freeze({
  [TASK_CATEGORIES.pricingAndInvoices]: Object.freeze({
    category: TASK_CATEGORIES.pricingAndInvoices,
    labelAr: 'حساب أسعار وفواتير',
    technique: 'deterministic_code',
    modelTier: 'none',
    requiresCodeValidation: true,
    requiresHumanApprovalForWrite: true,
    rationaleAr: 'كود حتمي، لا اعتماد على تخمين النموذج في العمليات الحسابية والمالية.'
  }),
  [TASK_CATEGORIES.documentExtraction]: Object.freeze({
    category: TASK_CATEGORIES.documentExtraction,
    labelAr: 'استخراج بيانات من مستندات',
    technique: 'structured_extraction_with_code_validation',
    modelTier: 'fast_structured',
    requiresCodeValidation: true,
    requiresHumanApprovalForWrite: true,
    rationaleAr: 'استخراج منظم وفق مخطط ثابت مع قواعد تحقق برمجية مستقلة وبصمة SHA-256.'
  }),
  [TASK_CATEGORIES.textSummarization]: Object.freeze({
    category: TASK_CATEGORIES.textSummarization,
    labelAr: 'تلخيص النصوص وتصنيفها',
    technique: 'fast_low_cost_llm',
    modelTier: 'fast_low_cost',
    requiresCodeValidation: false,
    requiresHumanApprovalForWrite: false,
    rationaleAr: 'نموذج لغوي سريع ومنخفض التكلفة للتصنيف وإعادة الصياغة والمهام المتكررة ذات المعايير الواضحة.'
  }),
  [TASK_CATEGORIES.complexTechnicalAnalysis]: Object.freeze({
    category: TASK_CATEGORIES.complexTechnicalAnalysis,
    labelAr: 'تحليل مشكلة تقنية معقدة',
    technique: 'reasoning_llm',
    modelTier: 'strong_reasoning',
    requiresCodeValidation: true,
    requiresHumanApprovalForWrite: false,
    rationaleAr: 'نموذج قوي في الاستدلال والبرمجة لتصميم المعماريات وتحليل الأعطال وتخطيط المهام متعددة الخطوات.'
  }),
  [TASK_CATEGORIES.creativeDesignAndAds]: Object.freeze({
    category: TASK_CATEGORIES.creativeDesignAndAds,
    labelAr: 'تصميم صور وإعلانات',
    technique: 'staged_creative_workflow',
    modelTier: 'multimodal_plus_fast_llm',
    requiresCodeValidation: true,
    requiresHumanApprovalForWrite: true,
    rationaleAr: 'سير عمل إبداعي من 6 مراحل يجمع نموذجًا لغويًا لصياغة الملخص الإبداعي مع أداة وسائط وفحص القيود.'
  }),
  [TASK_CATEGORIES.externalToolAction]: Object.freeze({
    category: TASK_CATEGORIES.externalToolAction,
    labelAr: 'تنفيذ خطوات على موقع أو خدمة خارجية',
    technique: 'governed_agent_with_outbox',
    modelTier: 'tool_calling_with_approval',
    requiresCodeValidation: true,
    requiresHumanApprovalForWrite: true,
    rationaleAr: 'وكيل يستخدم أدوات بصلاحيات محددة وبوابة موافقة المالك وصندوق أثر خارجي (outbox).'
  })
});

/**
 * Step 1 & Step 2: Classify a task or goal and return the lowest-complexity,
 * lowest-cost governed strategy that satisfies the testable success criterion.
 */
export function recommendTaskStrategy({ taskType = null, goal = '' } = {}) {
  if (taskType && STRATEGY_TABLE[taskType]) {
    return STRATEGY_TABLE[taskType];
  }
  const text = String(goal || '').trim();
  if (/(احسب|حساب|سعر|أسعار|ضريبة|مجموع|إجمالي\s*الفاتورة|price|subtotal|tax\s*calculation)/i.test(text) &&
      !/(استخرج|ملف|مستند|csv|txt|json)/i.test(text)) {
    return STRATEGY_TABLE[TASK_CATEGORIES.pricingAndInvoices];
  }
  if (/(فاتورة|مستند|استخرج|بيانات\s*من\s*ملف|كتالوج|منتجات|invoice|extract|catalog)/i.test(text)) {
    return STRATEGY_TABLE[TASK_CATEGORIES.documentExtraction];
  }
  if (/(أرسل|تقويم|موعد|واتساب|درايف|انشر|احجز|calendar|whatsapp|drive|publish)/i.test(text)) {
    return STRATEGY_TABLE[TASK_CATEGORIES.externalToolAction];
  }
  if (/(معمارية|عطل|تحليل\s*معقد|تصحيح\s*برمجي|أداء|تزامن|architecture|root\s*cause|debug)/i.test(text)) {
    return STRATEGY_TABLE[TASK_CATEGORIES.complexTechnicalAnalysis];
  }
  if (/(إعلان|تصميم|شعار|حملة|ملابس|صورة|بوستر|creative|ad\s*campaign|design)/i.test(text)) {
    return STRATEGY_TABLE[TASK_CATEGORIES.creativeDesignAndAds];
  }
  return STRATEGY_TABLE[TASK_CATEGORIES.textSummarization];
}

/**
 * Step 3: Token cost formula:
 *   Cost ≈ (inputTokens / 10^6) * inputPricePerMillion + (outputTokens / 10^6) * outputPricePerMillion
 *
 * Returns USD and integer micro-dollars (`costMicros`) plus budget compliance.
 */
export function estimateTokenCost({
  inputTokens = 0,
  outputTokens = 0,
  inputPricePerMillion = 0,
  outputPricePerMillion = 0,
  maxCostMicros = null
} = {}) {
  const inTok = Math.max(0, Number(inputTokens) || 0);
  const outTok = Math.max(0, Number(outputTokens) || 0);
  const inPrice = Math.max(0, Number(inputPricePerMillion) || 0);
  const outPrice = Math.max(0, Number(outputPricePerMillion) || 0);

  const inputCostUsd = (inTok / 1_000_000) * inPrice;
  const outputCostUsd = (outTok / 1_000_000) * outPrice;
  const totalCostUsd = Number((inputCostUsd + outputCostUsd).toFixed(8));
  const costMicros = Math.round(totalCostUsd * 1_000_000);
  const budgetLimit = Number.isFinite(Number(maxCostMicros)) && Number(maxCostMicros) > 0
    ? Number(maxCostMicros)
    : null;

  return {
    inputTokens: inTok,
    outputTokens: outTok,
    totalTokens: inTok + outTok,
    inputPricePerMillion: inPrice,
    outputPricePerMillion: outPrice,
    totalCostUsd,
    costMicros,
    maxCostMicros: budgetLimit,
    withinBudget: budgetLimit === null ? true : costMicros <= budgetLimit,
    formula: '(inputTokens / 1e6) * inputPricePerMillion + (outputTokens / 1e6) * outputPricePerMillion'
  };
}

/**
 * Step 3: Free-tier & external provider safety guard.
 * Blocks sending customer PII or secrets to free/training tiers and requires
 * explicit timeout and quota fallback policies.
 */
export function evaluateProviderSafety({
  tier = 'free',
  containsCustomerPii = false,
  containsSecrets = false,
  timeoutMs = 8000,
  hasQuotaFallback = true
} = {}) {
  const reasons = [];
  if (containsSecrets) {
    reasons.push('secrets_never_allowed_in_provider_payload');
  }
  if (tier === 'free' && containsCustomerPii) {
    reasons.push('customer_pii_blocked_on_free_tier');
  }
  if (!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) <= 0 || Number(timeoutMs) > 60_000) {
    reasons.push('explicit_request_timeout_required');
  }
  if (!hasQuotaFallback) {
    reasons.push('quota_exhaustion_fallback_required');
  }
  return {
    allowed: reasons.length === 0,
    tier,
    reasons
  };
}

/**
 * Step 1 Practical Example: Product Catalog Analyzer (`product_catalog_audit`).
 *
 * "حلّل ملف المنتجات، اكتشف الحقول الناقصة، أنشئ وصفًا لكل منتج، ثم اعرض النتائج للمراجعة قبل نشرها"
 * Prices and stock are validated deterministically by code; nothing is published without owner approval.
 */
const REQUIRED_PRODUCT_FIELDS = Object.freeze(['sku', 'name', 'price', 'currency', 'category']);

export function auditProductCatalog({ products = [] } = {}) {
  if (!Array.isArray(products)) {
    throw Object.assign(new Error('products must be an array'), { code: 'invalid_product_catalog' });
  }
  const items = products.map((raw, idx) => {
    const sku = typeof raw?.sku === 'string' ? raw.sku.trim() : '';
    const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
    const currency = typeof raw?.currency === 'string' ? raw.currency.trim().toUpperCase() : '';
    const category = typeof raw?.category === 'string' ? raw.category.trim() : '';
    const description = typeof raw?.description === 'string' ? raw.description.trim() : '';
    const numPrice = typeof raw?.price === 'number' ? raw.price : Number(raw?.price);
    const priceValid = Number.isFinite(numPrice) && numPrice > 0;

    const missingFields = [];
    for (const field of REQUIRED_PRODUCT_FIELDS) {
      if (field === 'price') {
        if (raw?.price === undefined || raw?.price === null || raw?.price === '') {
          missingFields.push('price');
        }
      } else if (!String(raw?.[field] ?? '').trim()) {
        missingFields.push(field);
      }
    }
    if (!description) {
      missingFields.push('description');
    }

    const validationErrors = [];
    if (!missingFields.includes('price') && !priceValid) {
      validationErrors.push('invalid_price_must_be_positive_number');
    }

    const proposedDescription =
      description ||
      (name
        ? `${name}${category ? ` ضمن فئة ${category}` : ''}${priceValid && currency ? ` — متاح بسعر ${numPrice} ${currency}` : ''} (مسودة آلية بانتظار مراجعة المالك قبل النشر).`
        : 'بيانات المنتج غير مكتملة لصياغة وصف؛ يلزم استكمال الاسم أولًا.');

    const readyForReview =
      missingFields.filter((f) => f !== 'description').length === 0 && validationErrors.length === 0;

    return {
      row_index: idx + 1,
      sku: sku || null,
      name: name || null,
      price: priceValid ? numPrice : null,
      currency: currency || null,
      category: category || null,
      missing_fields: missingFields,
      validation_errors: validationErrors,
      proposed_description: proposedDescription,
      ready_for_review: readyForReview,
      publish_status: 'waiting_for_owner_review'
    };
  });

  const completeCount = items.filter((i) => i.missing_fields.length === 0 && i.validation_errors.length === 0).length;
  const reviewReadyCount = items.filter((i) => i.ready_for_review).length;
  const invalidCount = items.filter((i) => !i.ready_for_review).length;

  return {
    capability: 'product_catalog_audit',
    total_products: items.length,
    complete_products: completeCount,
    review_ready_products: reviewReadyCount,
    incomplete_or_invalid_products: invalidCount,
    published_count: 0,
    next_permitted_action: invalidCount > 0 ? 'fix_missing_fields_then_review' : 'await_owner_approval_before_publish',
    items
  };
}

/**
 * Step 5 Practical Workflow: 6-Stage Creative Production Pipeline (`creative_brief_workflow`).
 *
 * Breaks creative work into 6 auditable stages instead of a single unverified prompt:
 *   1. صياغة الملخص الإبداعي (Creative Brief)
 *   2. توليد الأفكار (Multiple Distinct Directions)
 *   3. إنتاج المسودة (Draft Production)
 *   4. فحص المخرجات (Deterministic Output Inspection)
 *   5. التعديل والتحسين (Targeted Refinement)
 *   6. التسليم المنظم (Organized Delivery with Provenance)
 */
export function buildCreativeWorkflowPlan({
  brand = '',
  audience = '',
  message = '',
  style = 'حديث وبسيط',
  dimensions = '1080x1350',
  constraints = [],
  directionsCount = 3
} = {}) {
  const cleanBrand = String(brand || '').trim();
  const cleanAudience = String(audience || '').trim();
  const cleanMessage = String(message || '').trim();
  const missingBriefFields = [];
  if (!cleanBrand) missingBriefFields.push('brand');
  if (!cleanAudience) missingBriefFields.push('audience');
  if (!cleanMessage) missingBriefFields.push('message');

  const count = Math.min(Math.max(Number(directionsCount) || 3, 2), 5);
  const directions = Array.from({ length: count }, (_, idx) => ({
    direction_id: `DIR-0${idx + 1}`,
    angle:
      idx === 0
        ? 'التركيز المباشر على القيمة والمنتج'
        : idx === 1
          ? 'القصة اليومية وتجربة العميل'
          : `التباين البصري الجريء #${idx + 1}`,
    headline_draft: cleanBrand && cleanMessage ? `${cleanBrand}: ${cleanMessage}` : 'بانتظار استكمال الملخص الإبداعي',
    target_audience: cleanAudience || 'غير محدد'
  }));

  const normalizedConstraints = Array.isArray(constraints)
    ? constraints.map((c) => String(c).trim()).filter(Boolean)
    : [];

  const stages = [
    {
      stage: 1,
      id: 'creative_brief',
      titleAr: 'صياغة الملخص الإبداعي',
      status: missingBriefFields.length === 0 ? 'ready' : 'incomplete',
      output: {
        brand: cleanBrand || null,
        audience: cleanAudience || null,
        message: cleanMessage || null,
        style: String(style || '').trim(),
        dimensions: String(dimensions || '').trim(),
        constraints: normalizedConstraints,
        missing_fields: missingBriefFields
      }
    },
    {
      stage: 2,
      id: 'ideation_directions',
      titleAr: 'توليد الأفكار والاتجاهات',
      status: missingBriefFields.length === 0 ? 'ready' : 'blocked_by_brief',
      output: { directions }
    },
    {
      stage: 3,
      id: 'draft_production',
      titleAr: 'إنتاج المسودة بالأداة المناسبة',
      status: 'pending_execution',
      output: {
        selected_tools: ['fast_llm_copywriting', 'media_generator_or_template'],
        noteAr: 'لا تُستدعى أداة توليد خارجية قبل اعتماد الملخص والاتجاه.'
      }
    },
    {
      stage: 4,
      id: 'output_inspection',
      titleAr: 'فحص المخرجات والقيود الفنية',
      status: 'pending_inspection',
      checklist: [
        `مطابقة المقاس المطلوب (${dimensions})`,
        'وضوح النص العربي وسلامة اتجاه RTL',
        'عدم استخدام علامات أو أصول غير مرخصة',
        ...normalizedConstraints.map((c) => `قيد مخصص: ${c}`)
      ]
    },
    {
      stage: 5,
      id: 'targeted_refinement',
      titleAr: 'التعديل والتحسين بملاحظات محددة',
      status: 'awaiting_specific_feedback',
      ruleAr: 'استخدم ملاحظات محددة قابلة للقياس (مثل: تكبير العنوان 20% أو تعديل التباين) بدل طلب عام مثل «حسّن التصميم».'
    },
    {
      stage: 6,
      id: 'organized_delivery',
      titleAr: 'التسليم المنظم والموثّق',
      status: 'waiting_for_approval',
      requires: ['final_asset_ref', 'source_brief_hash', 'review_notes', 'verification_verdict']
    }
  ];

  return {
    capability: 'creative_brief_workflow',
    brief_complete: missingBriefFields.length === 0,
    missing_brief_fields: missingBriefFields,
    stages
  };
}

/**
 * Step 6: Three-Way Truth Partition (`buildTruthPartition`).
 *
 * Explicitly separates every run into:
 *   1. `executed`   — ما نُفّذ فعلًا (confirmed tool runs + sent outbox effects)
 *   2. `verified`   — ما تحقّق منه النظام (independent verifier checks + evidence chain + comprehension gate)
 *   3. `unverified` — ما لم يثبت بعد (pending approvals, unknown outcomes, or unverified claims)
 */
export function buildTruthPartition({
  run = null,
  toolRuns = [],
  approvals = [],
  outbox = [],
  verification = null,
  evidenceChain = null
} = {}) {
  const confirmedToolRuns = (toolRuns || [])
    .filter((tr) => tr.status === 'succeeded')
    .map((tr) => ({
      id: tr.id,
      toolName: tr.toolName,
      risk: tr.risk,
      finishedAt: tr.finishedAt || null
    }));

  const sentOutbox = (outbox || [])
    .filter((entry) => entry.status === 'sent')
    .map((entry) => ({
      id: entry.id,
      toolName: entry.toolName,
      connector: entry.connector,
      externalRef: entry.externalRef || null
    }));

  const reportTool = [...(toolRuns || [])]
    .reverse()
    .find((tr) => tr.toolName === 'data.report' && tr.status === 'succeeded');
  const reportOutcome = reportTool?.outcome && typeof reportTool.outcome === 'object' ? reportTool.outcome : null;

  const verifiedChecks = [];
  if (evidenceChain?.ok === true) {
    verifiedChecks.push({
      check: 'evidence_chain_sha256',
      status: 'PASS',
      detailAr: `سلسلة الأدلة المسلسلة سليمة (${evidenceChain.count ?? 0} مدخلات).`
    });
  }
  if (verification?.verdict === 'PASS') {
    verifiedChecks.push({
      check: 'independent_verifier',
      status: 'PASS',
      detailAr: 'اجتاز المُتحقِّق المستقل جميع فحوص التطابق والسياسات.'
    });
  }
  if (reportOutcome?.validation?.status === 'valid') {
    verifiedChecks.push({
      check: 'deterministic_data_validation',
      status: 'PASS',
      detailAr: `البيانات المستخرجة مطابقة للمخطط ${reportOutcome.schema_version || '1.0'} والحسابات صحيحة.`
    });
  }
  if (reportOutcome?.explanation?.comprehension_gate?.status === 'PASS') {
    verifiedChecks.push({
      check: 'comprehension_gate_grounding',
      status: 'PASS',
      detailAr: 'الشرح المبسّط مسند بالكامل إلى مواضع المستند وسلسلة الأدلة بلا تناقض.'
    });
  }

  const unverifiedItems = [];
  for (const approval of approvals || []) {
    if (approval.decision === 'pending') {
      unverifiedItems.push({
        kind: 'waiting_owner_approval',
        toolName: approval.toolName,
        detailAr: `الأثر الخارجي (${approval.toolName}) مقترح فقط ولم يُنفَّذ بعد؛ ينتظر موافقة المالك.`
      });
    }
  }
  for (const tr of toolRuns || []) {
    if (tr.status === 'unknown' || tr.status === 'started') {
      unverifiedItems.push({
        kind: 'tool_outcome_unknown',
        toolName: tr.toolName,
        detailAr: `نتيجة الأداة (${tr.toolName}) غير محسومة (${tr.status}) وتحتاج إلى مصالحة بشرية.`
      });
    }
  }
  for (const entry of outbox || []) {
    if (entry.status === 'unknown' || entry.status === 'dispatching') {
      unverifiedItems.push({
        kind: 'outbox_outcome_unknown',
        toolName: entry.toolName,
        detailAr: `النية الخارجية (${entry.toolName}) في حالة «${entry.status}»؛ لا يُفترض نجاحها ولا يُعاد إرسالها تلقائيًا.`
      });
    } else if (entry.status === 'pending') {
      unverifiedItems.push({
        kind: 'outbox_pending_dispatch',
        toolName: entry.toolName,
        detailAr: `النية الخارجية (${entry.toolName}) مسجلة في outbox لكنها لم تُرسل بعد.`
      });
    }
  }
  if (!verification?.verdict || verification.verdict !== 'PASS') {
    unverifiedItems.push({
      kind: 'final_delivery_unverified',
      toolName: null,
      detailAr: verification?.verdict
        ? `حكم المُتحقِّق النهائي هو «${verification.verdict}» وليس PASS.`
        : 'لم يصدر حكم تحقق نهائي (PASS) لهذا التشغيل بعد.'
    });
  }

  return {
    loopStages: CELIA_SEVEN_STAGE_LOOP,
    runStatus: run?.status || null,
    executed: {
      labelAr: 'ما نُفّذ فعلًا (تؤكده سجلات التنفيذ)',
      toolRunsCount: confirmedToolRuns.length,
      externalEffectsSentCount: sentOutbox.length,
      toolRuns: confirmedToolRuns,
      externalEffects: sentOutbox
    },
    verified: {
      labelAr: 'ما تحقّق منه النظام (تؤكده اختبارات وقواعد مستقلة)',
      verdict: verification?.verdict || null,
      evidenceChainOk: Boolean(evidenceChain?.ok),
      comprehensionGateStatus: reportOutcome?.explanation?.comprehension_gate?.status || null,
      checks: verifiedChecks
    },
    unverified: {
      labelAr: 'ما لم يثبت بعد (يبقى غير متحقق حتى لو بدا الناتج مقنعًا)',
      count: unverifiedItems.length,
      items: unverifiedItems
    }
  };
}

/**
 * Step 6: Compute the 6 operational metrics across a set of runs:
 *   1. نسبة المهام الناجحة (`successRate`)
 *   2. عدد مرات إعادة المحاولة (`retryCount`)
 *   3. دقة البيانات (`dataAccuracyRate`)
 *   4. زمن الإنجاز (`averageDurationMs`)
 *   5. التكلفة لكل مهمة مكتملة (`costPerCompletedTaskMicros`)
 *   6. عدد الحالات التي احتاجت إلى مراجعة بشرية (`humanReviewCount`)
 */
export function computeAgentMetrics(runDetails = []) {
  const list = Array.isArray(runDetails) ? runDetails : [];
  if (list.length === 0) {
    return {
      totalRuns: 0,
      succeededRuns: 0,
      failedOrBlockedRuns: 0,
      successRate: 0,
      retryCount: 0,
      dataAccuracyRate: 1,
      averageDurationMs: 0,
      costPerCompletedTaskMicros: 0,
      humanReviewCount: 0,
      cost: { totalCostMicros: 0, totalTokens: 0, runsWithCost: 0 },
      durations: { runs: summarizeDurations([]), tools: {}, unmeasuredToolRuns: 0 }
    };
  }

  let succeededRuns = 0;
  let failedOrBlockedRuns = 0;
  let retryCount = 0;
  // A4: التكلفة الكلية من صفوف التشغيل الفعلية (recordCost) — لكل الحالات لا الناجح فقط.
  let totalCostMicros = 0;
  let totalTokens = 0;
  let runsWithCost = 0;
  let totalDurationMs = 0;
  let durationSamples = 0;
  let completedCostMicros = 0;
  let humanReviewCount = 0;
  let validatedDocsCount = 0;
  let validDocsCount = 0;
  // WP-1.1 (AGENT-008): distributions, not just a mean — every sample is an observed duration.
  const runDurations = [];
  const toolDurations = new Map();
  let unmeasuredToolRuns = 0;

  for (const item of list) {
    const run = item?.run || item;
    const toolRuns = item?.toolRuns || [];
    const approvals = item?.approvals || [];
    const outbox = item?.outbox || [];

    if (run?.status === 'succeeded') {
      succeededRuns += 1;
      completedCostMicros += Number(run?.usage?.costMicros ?? run?.costMicros ?? 0) || 0;
    } else if (['failed', 'cancelled', 'budget_exhausted'].includes(run?.status)) {
      failedOrBlockedRuns += 1;
    }
    const runCostMicros = Number(run?.usage?.costMicros ?? run?.costMicros ?? 0) || 0;
    const runTokens = Number(run?.usage?.tokens ?? run?.tokens ?? 0) || 0;
    if (runCostMicros > 0 || runTokens > 0) runsWithCost += 1;
    totalCostMicros += runCostMicros;
    totalTokens += runTokens;

    for (const entry of outbox) {
      const attempts = Number(entry?.attempts || 0);
      if (attempts > 1) retryCount += attempts - 1;
    }

    const startMs = Date.parse(String(run?.startedAt || run?.createdAt || ''));
    const endMs = Date.parse(String(run?.finishedAt || run?.updatedAt || ''));
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
      totalDurationMs += endMs - startMs;
      durationSamples += 1;
      runDurations.push(endMs - startMs);
    }

    for (const tr of toolRuns) {
      const durationMs = Number.isFinite(tr?.durationMs) ? tr.durationMs : toolRunDurationMs(tr);
      if (durationMs === null) {
        if (SETTLED_TOOL_STATUSES.includes(tr?.status)) unmeasuredToolRuns += 1;
        continue;
      }
      const name = String(tr?.toolName || 'unknown');
      if (!toolDurations.has(name)) toolDurations.set(name, []);
      toolDurations.get(name).push(durationMs);
    }

    let neededHumanReview =
      run?.status === 'waiting_approval' ||
      run?.status === 'needs_reconciliation' ||
      approvals.length > 0;

    for (const tr of toolRuns) {
      if (tr.toolName === 'data.report' && tr.outcome && typeof tr.outcome === 'object') {
        validatedDocsCount += 1;
        if (tr.outcome.validation?.status === 'valid') {
          validDocsCount += 1;
        } else {
          neededHumanReview = true;
        }
      }
    }
    if (neededHumanReview) humanReviewCount += 1;
  }

  return {
    totalRuns: list.length,
    succeededRuns,
    failedOrBlockedRuns,
    successRate: Number((succeededRuns / list.length).toFixed(4)),
    retryCount,
    dataAccuracyRate:
      validatedDocsCount > 0 ? Number((validDocsCount / validatedDocsCount).toFixed(4)) : 1,
    averageDurationMs: durationSamples > 0 ? Math.round(totalDurationMs / durationSamples) : 0,
    costPerCompletedTaskMicros:
      succeededRuns > 0 ? Math.round(completedCostMicros / succeededRuns) : 0,
    humanReviewCount,
    cost: { totalCostMicros, totalTokens, runsWithCost },
    durations: {
      runs: summarizeDurations(runDurations),
      tools: Object.fromEntries(
        [...toolDurations.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => [name, summarizeDurations(values)])
      ),
      unmeasuredToolRuns
    }
  };
}
