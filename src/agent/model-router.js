/**
 * M-A/A4 — موجّه النماذج (`model_router`).
 *
 * غلاف مزوّد متوافق مع `createProviderPlanner` (`createPlan(request) → envelope`)
 * يوجّه كل طلب تخطيط إلى إحدى طبقتين معلنتين:
 *
 * - **fast:** نموذج سريع رخيص للاستخراج/التلخيص فوق ملاحظات ناجحة.
 * - **planner:** النموذج الأقوى للتخطيط الابتدائي ولأي قرار بعد فشل ملحوظ
 *   (المراجعة المحكومة A2 تستحق أقوى تفكير متاح، لا أرخصه).
 *
 * القواعد غير القابلة للتفاوض:
 *
 * 1. **التوجيه حتمي ومسجل:** `defaultRoute` دالة خالصة من حالة الطلب — لا عشوائية
 *    ولا تعلم خفي؛ القرار (الطبقة + السبب) يُثبَّت في `usage.router` فيصل سلسلة الأدلة.
 * 2. **التكلفة رموز فعلية × تسعير معلن:** `costMicros` تُحسب من رموز المزوّد المقاسة
 *    (`usageMetadata`) مضروبة في تسعير معلن بالميكرو-دولار لكل 1000 رمز، بتقريب
 *    لأعلى دائمًا (لا نبخس التكلفة أبدًا). التسعير إعلان تهيئة لا قياس — موثق كذلك.
 * 3. **سقف التكلفة رفضٌ لا تجاوز:** كل طبقة تعلن أسوأ تكلفة لاستدعاء واحد
 *    (`maxCostMicrosPerCall`). قبل أي استدعاء: إن كان «المُنفق + أسوأ حالة» يتجاوز
 *    سقف التشغيل → `cost_budget_refused` **قبل** إرسال أي شيء — صفر إنفاق إضافي.
 *    غياب عقد الميزانية في الطلب → `cost_budget_unknown` (Fail-Closed، لا تخمين).
 * 4. **عقد التسعير محروس:** لو أبلغ المزوّد رموزًا تجعل التكلفة الفعلية تتجاوز أسوأ
 *    حالة معلنة → `model_cost_contract_violation` يوقف التشغيل علنًا (الإعلان كاذب
 *    ويجب تصحيحه؛ لا نواصل بعقد مكسور).
 *
 * الموجّه لا ينفّذ أداة ولا يلمس المخزن ولا يعيد المحاولة — مزوّد فوق مزوّدين فقط.
 */

export const MODEL_TIERS = Object.freeze({ fast: 'fast', planner: 'planner' });

export const ROUTE_REASONS = Object.freeze({
  initialPlan: 'initial_plan',
  observedFailure: 'observed_failure',
  extraction: 'extraction_after_observation'
});

/**
 * تسعير معلن (ميكرو-دولار لكل 1000 رمز) — **إعلان تهيئة بتاريخ 2026-10، لا قياس**:
 * المالك يملك تحديثه؛ أي نموذج خارج الجدول يتطلب تسعيرًا صريحًا وإلا رفض البناء.
 */
export const DECLARED_GEMINI_PRICING = Object.freeze({
  'gemini-2.5-flash': Object.freeze({ inputMicrosPer1K: 300, outputMicrosPer1K: 2500 }),
  'gemini-2.5-flash-lite': Object.freeze({ inputMicrosPer1K: 100, outputMicrosPer1K: 400 })
});

/** أسوأ تكلفة معلنة لاستدعاء واحد لكل طبقة (ميكرو-دولار) — قرار معلن قابل للضبط. */
export const DEFAULT_PER_CALL_CAPS = Object.freeze({ fast: 5_000, planner: 20_000 });

function codedError(code, details = []) {
  return Object.assign(new Error(code), { code, details });
}

function positiveInt(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be an integer >= 1`);
  return value;
}

function nonNegativeInt(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be an integer >= 0`);
  return value;
}

/** توجيه حتمي خالص من حالة الطلب — نفس المدخل يعطي نفس القرار دائمًا. */
export function defaultRoute(request) {
  const toolResults = request?.state?.toolResults || [];
  if (toolResults.some((result) => result.status !== 'succeeded')) {
    return { tier: MODEL_TIERS.planner, reason: ROUTE_REASONS.observedFailure };
  }
  if (toolResults.length === 0) {
    return { tier: MODEL_TIERS.planner, reason: ROUTE_REASONS.initialPlan };
  }
  return { tier: MODEL_TIERS.fast, reason: ROUTE_REASONS.extraction };
}

/** تكلفة بتقريب لأعلى دائمًا: لا نبخس التكلفة مهما صغر الكسر. */
export function computeCostMicros(usage, pricing) {
  const inputTokens = Math.max(0, Number(usage?.inputTokens) || 0);
  const outputTokens = Math.max(0, Number(usage?.outputTokens) || 0);
  return (
    Math.ceil((inputTokens * pricing.inputMicrosPer1K) / 1000)
    + Math.ceil((outputTokens * pricing.outputMicrosPer1K) / 1000)
  );
}

function normalizeTier(name, tier) {
  if (!tier || typeof tier.provider?.createPlan !== 'function') {
    throw new Error(`Model router tier "${name}" requires provider.createPlan(request)`);
  }
  const pricing = tier.pricing;
  if (!pricing) throw new Error(`Model router tier "${name}" requires declared pricing`);
  nonNegativeInt(pricing.inputMicrosPer1K, `${name}.pricing.inputMicrosPer1K`);
  nonNegativeInt(pricing.outputMicrosPer1K, `${name}.pricing.outputMicrosPer1K`);
  positiveInt(tier.maxCostMicrosPerCall, `${name}.maxCostMicrosPerCall`);
  return Object.freeze({
    provider: tier.provider,
    model: String(tier.model || tier.provider.model || name),
    pricing: Object.freeze({ inputMicrosPer1K: pricing.inputMicrosPer1K, outputMicrosPer1K: pricing.outputMicrosPer1K }),
    maxCostMicrosPerCall: tier.maxCostMicrosPerCall
  });
}

export function createModelRouter({ tiers = {}, route = defaultRoute, name = 'model-router-v1' } = {}) {
  if (typeof route !== 'function') throw new Error('Model router route must be a function');
  const fast = normalizeTier('fast', tiers.fast);
  const planner = normalizeTier('planner', tiers.planner);
  const byTier = Object.freeze({ fast, planner });

  return {
    name,
    model: `router(${fast.model}|${planner.model})`,
    tiers: Object.freeze({
      fast: { model: fast.model, maxCostMicrosPerCall: fast.maxCostMicrosPerCall },
      planner: { model: planner.model, maxCostMicrosPerCall: planner.maxCostMicrosPerCall }
    }),
    async createPlan(request) {
      const decision = route(request);
      const tierName = decision?.tier;
      const tier = byTier[tierName];
      if (!tier) throw codedError('model_router_invalid_tier', [`tier:${String(tierName)}`]);

      // سقف التكلفة: رفض قبل الإرسال، لا تجاوز بعده.
      const budget = request?.budget;
      const maxCostMicros = Number(budget?.maxCostMicros);
      const usedCostMicros = Number(budget?.usedCostMicros);
      if (!Number.isFinite(maxCostMicros) || maxCostMicros <= 0 || !Number.isFinite(usedCostMicros) || usedCostMicros < 0) {
        throw codedError('cost_budget_unknown', ['budget contract missing from planner request']);
      }
      if (usedCostMicros + tier.maxCostMicrosPerCall > maxCostMicros) {
        throw codedError('cost_budget_refused', [
          `tier:${tierName}`,
          `used_micros:${usedCostMicros}`,
          `worst_case_call_micros:${tier.maxCostMicrosPerCall}`,
          `max_micros:${maxCostMicros}`
        ]);
      }

      const envelope = await tier.provider.createPlan(request);
      const usage = envelope?.usage || {};
      const costMicros = computeCostMicros(usage, tier.pricing);
      if (costMicros > tier.maxCostMicrosPerCall) {
        throw codedError('model_cost_contract_violation', [
          `tier:${tierName}`,
          `cost_micros:${costMicros}`,
          `declared_max_micros:${tier.maxCostMicrosPerCall}`
        ]);
      }
      return {
        ...envelope,
        model: envelope?.model || tier.model,
        usage: {
          ...usage,
          costMicros,
          router: {
            tier: tierName,
            reason: decision.reason || null,
            model: envelope?.model || tier.model,
            maxCostMicrosPerCall: tier.maxCostMicrosPerCall,
            pricing: tier.pricing
          }
        }
      };
    }
  };
}
