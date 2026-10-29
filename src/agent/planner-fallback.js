/**
 * M-A/A1 — التحويل الحتمي المرئي (`planner_fallback`).
 *
 * غلاف حول مخطط مزوّدي (`createProviderPlanner`): عند فشل المزوّد بفشل
 * قابل للتحويل، لا يسقط التشغيل بصمت ولا "يُصلح" القرار — بل:
 *
 * 1. قبل تنفيذ أي أداة (`toolRuns` فارغة): يُستدعى المخطط الحتمي الموثوق نفسه
 *    المستخدم في الوضع الافتراضي، ويُعلَّم القرار بـ`plannerFallback` فيسجله
 *    الـruntime خطوة ودليل BLOCK مرئيين قبل متابعة القرار الحتمي.
 * 2. بعد تنفيذ أدوات: لا إعادة تخطيط — إنهاء آمن فاشل يصف ما لوحظ، لأن اختيار
 *    أدوات بديلة بعد فشل النموذج هو فعليًا إعادة تخطيط آلية يحظرها
 *    `automatic_replan_disabled` (سياسة WP-3.2 القادمة تملك أي تغيير هنا).
 *
 * ما لا يُحوَّل أبدًا: الإلغاء (`planner_cancelled`) و`automatic_replan_disabled`
 * وأي كود خارج القائمة الصريحة أدناه — تُرفع كما هي فيسقط التشغيل علنًا.
 */

/** أكواد فشل المزوّد التي يجوز تحويلها حتميًا — قائمة صريحة لا نمط عام. */
export const PLANNER_FALLBACK_CODES = Object.freeze([
  'invalid_provider_plan',
  'invalid_provider_tool_arguments',
  'planner_provider_unavailable',
  'planner_provider_timeout',
  // A2: تجاوز نافذة المراجعة المحكومة — توقف فوري ثم تحويل مرئي (لا محاولة ثانية أبدًا).
  'max_replan_exceeded',
  'replan_requires_read_tool'
]);

const FALLBACK_CODE_SET = new Set(PLANNER_FALLBACK_CODES);

export function createGovernedFallbackPlanner({
  primary,
  fallback,
  extraAllowedTools = [],
  name = null
} = {}) {
  if (!primary?.plan || primary.providerDriven !== true) {
    throw new Error('Governed fallback requires a provider-driven primary planner');
  }
  if (!fallback?.plan || fallback.providerDriven === true) {
    throw new Error('Governed fallback requires a deterministic (non-provider) fallback planner');
  }
  if (!Array.isArray(extraAllowedTools) || extraAllowedTools.some((tool) => typeof tool !== 'string' || !tool)) {
    throw new Error('extraAllowedTools must be an array of tool names');
  }
  const allowedTools = Object.freeze([...new Set([...(primary.allowedTools || []), ...extraAllowedTools])]);
  const plannerName = name || `${primary.name}+fallback(${fallback.name || 'deterministic'})`;

  return {
    name: plannerName,
    providerDriven: true,
    allowedTools,
    async plan(context) {
      try {
        return await primary.plan(context);
      } catch (error) {
        const code = error?.code || 'planner_failed';
        if (context?.signal?.aborted || code === 'planner_cancelled') throw error;
        if (!FALLBACK_CODE_SET.has(code)) throw error;

        const marker = {
          code,
          details: Array.isArray(error?.details) ? error.details : [],
          provider: primary.name,
          providerTrace: error?.providerTrace || null
        };
        const executed = Array.isArray(context?.toolRuns) && context.toolRuns.length > 0;
        if (executed) {
          return {
            action: 'finish',
            failed: true,
            summary:
              'تعذّر الحصول على خطة صالحة من مزوّد التخطيط بعد تنفيذ أدوات؛ أُنهي التشغيل بأمان عبر المسار الحتمي دون أي أداة إضافية أو أثر خارجي. راجع دليل planner_fallback لتفاصيل الفشل.',
            reason: `planner_fallback:${code}`,
            plannerFallback: Object.freeze({ ...marker, stage: 'after_observation', mode: 'safe_finish' })
          };
        }
        const decision = await fallback.plan(context);
        return {
          ...decision,
          reason: decision.reason ? `planner_fallback:${code}; ${decision.reason}` : `planner_fallback:${code}`,
          plannerFallback: Object.freeze({ ...marker, stage: 'initial', mode: 'deterministic_plan' })
        };
      }
    }
  };
}
