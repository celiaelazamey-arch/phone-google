/**
 * ASSUR-002 — حارس «التقدّم الصفري» (No-Progress Guard).
 *
 * **الفجوة التي يسدّها (قياس لا انطباع):** مفتاح عدم التكرار في الحلقة هو
 * `${runId}:${step.index}:${tool.name}`، ولأنه يحوي **رقم الخطوة** فإن الأداة
 * نفسها بالمعطيات نفسها تُنفَّذ من جديد في خطوة تالية. `maxSteps` يوقف النزيف
 * عند الحد ولا يمنعه: محاولتان فاشلتان متطابقتان تكفيان لاستهلاك ميزانية بلا
 * أي معلومة جديدة.
 *
 * **لماذا بلا ترحيل:** العمود `agent_tool_runs.arguments_digest` موجود أصلًا في
 * `sql/migrations/0002_agent-runtime.sql` وفي سائقي SQLite/D1؛ كان فارغًا لأن
 * لا كاتب له. هذه الشريحة تملؤه وتقرأه، ولا تضيف عمودًا ولا جدولًا.
 *
 * **حتمية العدّ:** لا عدّاد في الذاكرة — المحاولات تُحصى من صفوف المخزن
 * المستقرة، فالاستئناف بعد انقطاع يرى الحساب نفسه ولا يمنح نافذة جديدة.
 * هذا هو نمط `replanner.js` نفسه، وهو مقصود.
 *
 * **ما لا يفعله هذا الحارس:**
 * - لا يحلّ محل حارس إعادة التخطيط (`REPLAN_LIMITS`) ولا يغيّر معناه: ذاك يحدّ
 *   *المراجعات*، وهذا يحدّ *تكرار الاستدعاء المتطابق*.
 * - لا يمس المحاولات غير المستقرة (`started`/`unknown`): تلك شأن المصالحة
 *   (`DEC-007`)، والحلقة تتوقف عندها أصلًا ولا تعيد تنفيذها عمياء.
 * - لا يقارن صفًا بلا بصمة (`arguments_digest = NULL`، صفوف سابقة لهذه الشريحة):
 *   غياب دليل التطابق ليس دليل تطابق، فالحارس لا يخمّن.
 *
 * الوحدة تقيّم فقط: لا مخزن، لا مزوّد، لا ساعة، لا عشوائية.
 */

import { TOOL_RUN_STATUS } from './store.js';

/** الحد الافتراضي المعلن — تغييره قرار لا تهيئة صامتة. */
export const NO_PROGRESS_LIMITS = Object.freeze({ maxIdenticalFailures: 2 });

/** كود الرفض surfaced في نتيجة التشغيل وسلسلة الأدلة. */
export const NO_PROGRESS_CODE = 'no_progress_repeated_attempt';

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be an integer >= 1`);
  }
  return value;
}

/**
 * يُبنى الحارس بحد معلن. `evaluate` يعيد قرارًا صريحًا ولا يرفع أبدًا عند
 * التكرار: الرفض حالة تشغيل متوقعة تُسجَّل في السجل، لا استثناء يبتلعه
 * معالج الأخطاء العام ويحوّله إلى `runtime_error` بلا سبب مقروء.
 */
export function createNoProgressPolicy({
  maxIdenticalFailures = NO_PROGRESS_LIMITS.maxIdenticalFailures
} = {}) {
  positiveInteger(maxIdenticalFailures, 'maxIdenticalFailures');

  return Object.freeze({
    name: 'no-progress-v1',
    maxIdenticalFailures,
    /**
     * @param {string} toolName الأداة المقترحة.
     * @param {string|null} argumentsDigest بصمة المعطيات القانونية (SHA-256).
     * @param {Array} toolRuns صفوف استدعاءات التشغيل من المخزن.
     * @returns {{blocked: boolean, priorFailures: number, code: string|null}}
     */
    evaluate({ toolName, argumentsDigest, toolRuns = [] }) {
      // بلا بصمة لا توجد مقارنة صادقة: لا حظر بالتخمين.
      if (!argumentsDigest || !toolName) {
        return { blocked: false, priorFailures: 0, code: null };
      }
      const priorFailures = toolRuns.filter(
        (toolRun) =>
          toolRun.toolName === toolName &&
          toolRun.argumentsDigest === argumentsDigest &&
          toolRun.status === TOOL_RUN_STATUS.failed
      ).length;
      const blocked = priorFailures >= maxIdenticalFailures;
      return {
        blocked,
        priorFailures,
        code: blocked ? NO_PROGRESS_CODE : null
      };
    }
  });
}
