/**
 * M-A/A2 — سياسة إعادة التخطيط المحكومة (`plan.revised`).
 *
 * قبل هذه الشريحة كان أي `call` بعد فشل أداة يُرفض بـ`automatic_replan_disabled`.
 * هذه السياسة تفتح نافذة واحدة صارمة Fail-Closed:
 *
 * - **حد لكل خطوة فاشلة:** `maxPerStep = 1` — محاولة مراجعة ثانية لنفس الفشل
 *   تُرفع فورًا بـ`max_replan_exceeded` (لا تهدئة، لا انتظار، لا تكرار).
 * - **حارس الحلقة (Loop Prevention Guard):** `maxPerRun = 1` — سقف إجمالي
 *   للمراجعات في التشغيل كله؛ فشل المراجعة نفسها لا يفتح سلسلة مراجعات
 *   (فشل أ ← مراجعة ب ← فشل ب ← مراجعة ج ← …) مهما تعددت الخطوات الفاشلة.
 * - **قراءة فقط:** أداة المراجعة يجب أن تكون `RISK.read` مسجلةً — دفاع إضافي
 *   تحت بوابة `allowedTools` (التي تحصر المزوّد أصلًا في أدوات قراءة)، فلا
 *   يمكن لأي أثر خارجي أو كتابة أن يمر تحت اسم «استعادة».
 * - **حتمية العدّ:** لا عدّاد في الذاكرة — المراجعات تُحصى من خطوات المخزن
 *   المعنونة `plan.revised` (المسجلة في سلسلة SHA-256)، فالاستئناف بعد انقطاع
 *   يرى نفس الحساب ولا يمنح نافذة جديدة.
 *
 * السياسة تُقيّم فقط؛ لا تستدعي مزوّدًا ولا تنفّذ أداة ولا تلمس المخزن.
 */

import { RISK } from './tools.js';

/** عنوان خطوة المراجعة في المخزن — هو نفسه مصدر العدّ الحتمي. */
export const REVISION_STEP_TITLE = 'plan.revised';

/** الحدود الافتراضية للشريحة A2 — تغييرها قرار معلن لا تهيئة صامتة. */
export const REPLAN_LIMITS = Object.freeze({ maxPerStep: 1, maxPerRun: 1 });

function codedError(code, details = []) {
  return Object.assign(new Error(code), { code, details });
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be an integer >= 1`);
  }
  return value;
}

export function createReplanPolicy({
  maxPerStep = REPLAN_LIMITS.maxPerStep,
  maxPerRun = REPLAN_LIMITS.maxPerRun
} = {}) {
  positiveInteger(maxPerStep, 'maxPerStep');
  positiveInteger(maxPerRun, 'maxPerRun');
  if (maxPerRun < maxPerStep) throw new Error('maxPerRun must be >= maxPerStep');

  return Object.freeze({
    name: 'governed-replan-v1',
    maxPerStep,
    maxPerRun,
    /**
     * يُستدعى حصرًا عندما يقترح المزوّد `call` ووُجد فشل أداة في السياق.
     * يعيد `{ revision }` عند السماح، ويرفع كودًا صريحًا عند أي تجاوز.
     */
    evaluate({ plan, context, tools }) {
      const toolRuns = context?.toolRuns || [];
      const failed = toolRuns.find((toolRun) => toolRun.status !== 'succeeded');
      if (!failed) return { revision: null };

      // قراءة فقط — Fail-Closed حتى لو تغيّرت قائمة السماح يومًا.
      const definition = tools?.get?.(plan.tool);
      if (!definition || definition.risk !== RISK.read) {
        throw codedError('replan_requires_read_tool', [`tool:${plan.tool}`, `risk:${definition?.risk ?? 'unregistered'}`]);
      }

      const steps = context?.steps || [];
      const revisionSteps = steps.filter((step) => step.title === REVISION_STEP_TITLE);

      // حارس الحلقة أولًا: سقف التشغيل كله.
      if (revisionSteps.length >= maxPerRun) {
        throw codedError('max_replan_exceeded', [
          `run_revisions:${revisionSteps.length}`,
          `max_per_run:${maxPerRun}`,
          `failed_tool:${failed.toolName}`
        ]);
      }

      // ثم حد الخطوة الفاشلة الواحدة: المراجعات المسجلة بعد خطوة الفشل.
      const failedStepIndex = steps.find((step) => step.id === failed.stepId)?.index ?? null;
      const revisionsForThisFailure = failedStepIndex === null
        ? revisionSteps
        : revisionSteps.filter((step) => step.index > failedStepIndex);
      if (revisionsForThisFailure.length >= maxPerStep) {
        throw codedError('max_replan_exceeded', [
          `step_revisions:${revisionsForThisFailure.length}`,
          `max_per_step:${maxPerStep}`,
          `failed_tool:${failed.toolName}`
        ]);
      }

      return {
        revision: Object.freeze({
          ofStepId: failed.stepId ?? null,
          ofToolRunId: failed.id,
          failedTool: failed.toolName,
          attempt: revisionsForThisFailure.length + 1,
          maxPerStep,
          maxPerRun
        })
      };
    }
  });
}
