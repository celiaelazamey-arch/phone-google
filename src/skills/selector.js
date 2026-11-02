/**
 * DES-002 / المرحلة 2 — اختيار المهارة من السجل وفق الهدف والصلاحيات.
 *
 * ضمان بنائي: وحدة **خالصة** — بدون نظام ملفات ولا شبكة.
 * - يقرأ المخطط المهارات `active` فقط (عبر `registry.visibleToPlanner()`).
 * - المهارة المختارة يجب أن تغطي الهدف (كلمة مفتاحية حسب القسم) وتكون
 *   صلاحياتها ضمن الصلاحيات الممنوحة (skill.permissions ⊆ granted).
 * - لا يوجد مطابقة ⇒ { ok: false, code: 'no_skill_matches' } والمخطط
 *   يسقط إلى مساره الافتراضي — لا مهارة تُفرض أبدًا.
 */

export const DEPARTMENT_KEYWORDS = Object.freeze({
  product: /(منتج|استراتيجية|product|strateg|أولوية|prioriti)/i,
  research: /(بحث|مصادر|search|research|knowledge)/i,
  finance: /(مالي|تكلفة|ميزانية|finance|cost|budget|مصروف)/i,
  creative: /(إبداعي|محتوى|creative|content|تصميم|design|brief)/i,
  operations: /(تشغيل|حالة النظام|monitor|operations|ops|صحة|status)/i
});

function departmentMatches(department, goal) {
  const pattern = DEPARTMENT_KEYWORDS[department];
  return pattern ? pattern.test(goal) : false;
}

function permissionsCovered(skill, granted) {
  const grantedSet = new Set(granted);
  return skill.permissions.every((permission) => grantedSet.has(permission));
}

/**
 * يختار مهارة active من السجل حسب الهدف والصلاحيات الممنوحة.
 * return: { ok: true, skill } أو { ok: false, code, ... }
 */
export function selectSkill(registry, goal, { grantedPermissions = [] } = {}) {
  if (!registry || typeof registry.visibleToPlanner !== 'function') {
    return { ok: false, code: 'registry_required' };
  }
  const text = String(goal ?? '').trim();
  if (!text) return { ok: false, code: 'goal_required' };

  const candidates = registry.visibleToPlanner().filter((skill) => departmentMatches(skill.department, text));
  if (candidates.length === 0) return { ok: false, code: 'no_skill_matches', goal: text.slice(0, 120) };

  const permitted = candidates.filter((skill) => permissionsCovered(skill, grantedPermissions));
  if (permitted.length === 0) {
    return { ok: false, code: 'skill_permissions_not_granted', candidates: candidates.map((s) => s.name) };
  }

  // First match wins — deterministic, no scoring claims.
  return { ok: true, skill: permitted[0] };
}

/**
 * يتحقق أن الهدف داخل عقد المهارة: أي كلمة مفتاحية تطلب أداة خارج
 * allowedTools ⇒ رفض بكود. heuristics نصية فقط، بلا نموذج.
 */
export function goalWithinContract(skill, goal) {
  if (!skill) return { ok: false, code: 'skill_required' };
  const text = String(goal ?? '');
  const TOOL_HINTS = [
    { pattern: /(whatsapp|واتساب|رسالة)/i, tool: 'whatsapp.send_text' },
    { pattern: /(sandbox|exec|shell|تنفيذ|script)/i, tool: 'sandbox.exec' }
  ];
  for (const hint of TOOL_HINTS) {
    if (hint.pattern.test(text) && !skill.allowedTools.includes(hint.tool)) {
      return { ok: false, code: 'goal_tool_not_allowed', tool: hint.tool };
    }
  }
  return { ok: true };
}
