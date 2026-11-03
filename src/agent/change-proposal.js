/**
 * SI-6/E3 — كائن مقترح التغيير على النظام نفسه: بيانات بلا تنفيذ.
 *
 * تدقيق `SI-0` (صفّ E3): «Change Proposal كائن بيانات بـ`rollback_plan` و`required_approvals`
 * — لا كائن. المكافئ القائم بشري الشكل: صفّ BACKLOG + إدخال DECISIONS + سجل جلسة + خطة موجات».
 * هذا الكائن يحمل اقتراح تغييرٍ على النظام نفسه بالحقول التي تجعله قابلًا للمراجعة البشرية:
 * ماذا سيتغير، وكيف يُتراجع، ومَن يجب أن يعتمد. والقرار الحاكم (`DEC-124`): الحالة
 * `PROPOSED` **لا تتغير هنا أبدًا** — لا apply ولا `apply_self_change` ولا مسار اعتماد
 * يُستهلك في الكود؛ الاعتماد فعلُ بشري خارج الوحدة بالمسار البشري القائم نفسه.
 *
 * لا عمليات ولا شبكة ولا مخزن: بنية بيانات فشلة-مغلقة تجمد كل حقل وترفض الفراغ.
 */

export const CHANGE_PROPOSAL_VERSION = 'change-proposal-v1';
/** الحالة الوحيدة التي يُنتجها هذا الكائن — التأكيد ليس هنا. */
export const PROPOSED = 'PROPOSED';
export const CHANGE_PROPOSAL_LIMIT = 'اقتراح لا تنفيذ: الحالة PROPOSED لا تتغير في هذه الوحدة، والاعتماد فعل بشري بالمسار القائم (صف BACKLOG + إدخال DECISIONS + سجل جلسة + خطة موجات) — لا apply ولا apply_self_change';

const MAX_CHANGES = 20;
const MAX_ROLLBACK_STEPS = 20;
const MAX_APPROVALS = 5;

function requireText(value, field, max = 400) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`change_proposal_${field}_required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`change_proposal_${field}_too_long`);
  return trimmed;
}

function requireList(value, field, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`change_proposal_${field}_required`);
  }
  return value;
}

function requirePath(value) {
  const path = requireText(value, 'change_path', 200);
  if (path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error('change_proposal_path_invalid');
  }
  return path;
}

/**
 * يبني كائن المقترح مجمّدًا: كل حقل إلزامي ترفضه الوحدة غيابًا أو فراغًا، و`status` ثابت
 * `PROPOSED` بلا أي واجهة تقلبه — فالاقتراح الذي لا يحمل خطة تراجع واعتمادًا مطلوبًا يُرفض.
 */
export function createChangeProposal({
  title,
  motivation,
  changes,
  rollbackPlan,
  requiredApprovals,
  createdBy
} = {}) {
  const cleanTitle = requireText(title, 'title', 200);
  const cleanMotivation = requireText(motivation, 'motivation');
  const cleanChanges = requireList(changes, 'changes', 1, MAX_CHANGES).map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error('change_proposal_changes_required');
    return Object.freeze({
      path: requirePath(entry.path),
      summary: requireText(entry.summary, 'change_summary')
    });
  });
  const cleanRollback = requireList(rollbackPlan, 'rollback_plan', 1, MAX_ROLLBACK_STEPS)
    .map((step, index) => requireText(step, `rollback_step_${index + 1}`, 300));
  const cleanApprovals = requireList(requiredApprovals, 'required_approvals', 1, MAX_APPROVALS)
    .map((entry) => requireText(entry, 'required_approval', 100));
  if (new Set(cleanApprovals).size !== cleanApprovals.length) {
    throw new Error('change_proposal_approvals_distinct');
  }
  const cleanCreatedBy = requireText(createdBy, 'created_by', 100);

  return Object.freeze({
    version: CHANGE_PROPOSAL_VERSION,
    title: cleanTitle,
    motivation: cleanMotivation,
    changes: Object.freeze(cleanChanges),
    rollbackPlan: Object.freeze(cleanRollback),
    requiredApprovals: Object.freeze(cleanApprovals),
    createdBy: cleanCreatedBy,
    status: PROPOSED,
    executable: false,
    limit: CHANGE_PROPOSAL_LIMIT
  });
}
