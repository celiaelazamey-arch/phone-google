/**
 * Computer-agent permissions for CeliaOS — the policy, as code.
 *
 * The infographic is generated from this file, so the picture cannot drift from what the system would actually
 * decide. Two ideas are load-bearing:
 *
 *   1. Default deny. A capability that is not named here is refused, and an action whose target is outside the
 *      task scope is refused even when the capability itself is allowed.
 *   2. Policy is not capability. Every entry carries `wired`, and today every value is `false`: the computer-use
 *      engine is not wired to Computer Use; the local AGENT-003 sandbox backend does not change that boundary,
 *      so `decideAction` returns the policy verdict *and* `executable: false`.
 *      Adding click and type to a diagram proves nothing about them working, and this module refuses to pretend
 *      otherwise.
 *
 * The three system facts below come from the project's own state, not from a live scan. `NOT_PROVEN` identity
 * means no action may be performed in the user's name; a closed external gate means an approved external action
 * still cannot leave the machine.
 */

export const COMPUTER_POLICY_VERSION = 'computer-agent-policy-v1';

export const SYSTEM_STATE = Object.freeze({
  network: 'DENY',
  externalGates: 'CLOSED',
  identity: 'NOT_PROVEN'
});

export const STATUS = Object.freeze({
  allowed: 'allowed',
  approval: 'approval_required',
  restricted: 'restricted',
  denied: 'denied'
});

export const STATUS_LABELS = Object.freeze({
  allowed: 'مسموح',
  approval_required: 'يتطلب موافقة',
  restricted: 'مقيّد',
  denied: 'محظور'
});

export const GROUPS = Object.freeze({
  perception: 'الإدراك',
  input: 'الإدخال',
  navigation: 'التنقل',
  files: 'الملفات',
  external: 'الأثر الخارجي',
  system: 'النظام',
  secrets: 'الأسرار',
  governance: 'الحوكمة'
});

/**
 * status      the policy verdict when everything else is in order
 * scope       the boundary the action must stay inside
 * gate        the control that has to pass
 * external    the action leaves the machine (needs an open external gate)
 * identity    the action acts in the user's name (needs a proven identity)
 * wired       false until Computer Use is explicitly wired to a reviewed executor; the local AGENT-003 backend alone does not enable it
 * tested      whether the control has an automated test in this repository
 */
export const CAPABILITIES = Object.freeze([
  {
    id: 'plan_task',
    ar: 'فهم المهمة ووضع خطة',
    en: 'Understand the task and plan',
    group: 'governance',
    status: STATUS.allowed,
    scope: 'عقد المهمة المعتمد',
    gate: 'Goal contract',
    external: false,
    identity: false,
    wired: false,
    tested: true
  },
  {
    id: 'capture_screen',
    ar: 'مشاهدة الشاشة والتقاط الصور',
    en: 'View the screen and capture frames',
    group: 'perception',
    status: STATUS.allowed,
    scope: 'الجلسة المصرح بها فقط',
    gate: 'Session scope',
    external: false,
    identity: false,
    wired: false,
    tested: true
  },
  {
    id: 'read_elements',
    ar: 'قراءة عناصر الصفحة والنوافذ',
    en: 'Read page and window elements',
    group: 'perception',
    status: STATUS.allowed,
    scope: 'نطاق المهمة الحالية',
    gate: 'Task scope',
    external: false,
    identity: false,
    wired: false,
    tested: true
  },
  {
    id: 'click',
    ar: 'النقر بالماوس',
    en: 'Click',
    group: 'input',
    status: STATUS.allowed,
    scope: 'عناصر مرتبطة بالخطة المعتمدة',
    gate: 'Plan-linked target',
    external: false,
    identity: false,
    wired: false,
    tested: true
  },
  {
    id: 'type_text',
    ar: 'الكتابة واستخدام لوحة المفاتيح',
    en: 'Type and use the keyboard',
    group: 'input',
    status: STATUS.allowed,
    scope: 'حقول وتطبيقات مصرح بها',
    gate: 'Field allowlist',
    external: false,
    identity: false,
    wired: false,
    tested: true
  },
  {
    id: 'scroll',
    ar: 'التمرير والتنقل داخل الصفحة',
    en: 'Scroll and navigate within the page',
    group: 'input',
    status: STATUS.allowed,
    scope: 'النطاق المسموح',
    gate: 'Task scope',
    external: false,
    identity: false,
    wired: false,
    tested: true
  },
  {
    id: 'open_url',
    ar: 'فتح موقع خارجي أو الاتصال بالإنترنت',
    en: 'Open an external site or reach the network',
    group: 'navigation',
    status: STATUS.denied,
    scope: 'بوابة الشبكة مغلقة',
    gate: 'NETWORK = DENY',
    external: true,
    identity: false,
    wired: false,
    tested: true
  },
  {
    id: 'submit_form',
    ar: 'إرسال رسالة أو تقديم نموذج',
    en: 'Send a message or submit a form',
    group: 'external',
    status: STATUS.approval,
    scope: 'موافقة بشرية قبل الإرسال',
    gate: 'Approval gate',
    external: true,
    identity: true,
    wired: false,
    tested: true
  },
  {
    id: 'transfer_file',
    ar: 'تنزيل الملفات أو رفعها',
    en: 'Download or upload a file',
    group: 'external',
    status: STATUS.restricted,
    scope: 'إذن صريح + تحقق من المصدر والوجهة',
    gate: 'Source/destination check',
    external: true,
    identity: false,
    wired: false,
    tested: true
  },
  {
    id: 'edit_file',
    ar: 'إنشاء الملفات وتعديلها',
    en: 'Create and edit files',
    group: 'files',
    status: STATUS.restricted,
    scope: 'مسارات مسموح بها + استرجاع',
    gate: 'Path allowlist + rollback',
    external: false,
    identity: false,
    wired: false,
    tested: true
  },
  {
    id: 'delete_file',
    ar: 'حذف الملفات أو تغيير إعدادات حساسة',
    en: 'Delete files or change sensitive settings',
    group: 'files',
    status: STATUS.approval,
    scope: 'موافقة حسب خطورة التغيير',
    gate: 'Risk-scaled approval',
    external: false,
    identity: false,
    wired: false,
    tested: true
  },
  {
    id: 'run_system_command',
    ar: 'تثبيت البرامج أو تنفيذ أوامر النظام',
    en: 'Install software or run system commands',
    group: 'system',
    status: STATUS.denied,
    scope: 'لا صلاحيات مسؤول نظام',
    gate: 'Admin boundary',
    external: false,
    identity: false,
    wired: false,
    tested: true
  },
  {
    id: 'read_secrets',
    ar: 'الوصول إلى كلمات المرور ومفاتيح API',
    en: 'Read passwords, API keys or OTP codes',
    group: 'secrets',
    status: STATUS.denied,
    scope: 'الأسرار لا تُعرض ولا تُسجَّل',
    gate: 'Secret boundary',
    external: false,
    identity: false,
    wired: false,
    tested: true
  },
  {
    id: 'payment_or_privilege',
    ar: 'المدفوعات وتغيير الصلاحيات',
    en: 'Payments or privilege changes',
    group: 'external',
    status: STATUS.approval,
    scope: 'موافقة بشرية إلزامية، لا تنفيذ تلقائي',
    gate: 'Human-in-the-loop',
    external: true,
    identity: true,
    wired: false,
    tested: true
  },
  {
    id: 'act_as_user',
    ar: 'تنفيذ إجراءات خارجية باسم المستخدم',
    en: 'Act externally in the user’s name',
    group: 'external',
    status: STATUS.denied,
    scope: 'حتى إثبات الهوية وفتح البوابات',
    gate: 'IDENTITY = NOT_PROVEN',
    external: true,
    identity: true,
    wired: false,
    tested: true
  },
  {
    id: 'stop_execution',
    ar: 'إيقاف التنفيذ فورًا وإلغاء ما بعده',
    en: 'Stop execution and cancel what follows',
    group: 'governance',
    status: STATUS.allowed,
    scope: 'متاح دائمًا للمشغّل',
    gate: 'Operator kill switch',
    external: false,
    identity: false,
    wired: false,
    tested: true
  }
]);

export const CAPABILITY_IDS = Object.freeze(CAPABILITIES.map((capability) => capability.id));

/** Mandatory rules, quoted verbatim in the generated infographic so the picture states its own constraints. */
export const MANDATORY_RULES = Object.freeze([
  'المنع الافتراضي: أي صلاحية غير محددة بوضوح تُرفض',
  'أقل صلاحية: لا يحصل الوكيل إلا على ما تحتاجه المهمة الحالية',
  'النية ليست نتيجة: النقر لا يعني نجاح العملية، والتحقق مستقل',
  'الإيقاف عند الغموض: إذا تغيرت الصفحة أو الهدف، يتوقف الوكيل ويعيد التقييم',
  'سجل قابل للمراجعة: الإجراء والسبب والقرار والنتيجة، بلا كلمات مرور أو أسرار',
  'إيقاف فوري: للمشغّل أن يوقف التنفيذ ويلغي الإجراءات اللاحقة'
]);

export const DECISION_STEPS = Object.freeze([
  { n: 1, ar: 'فهم الهدف', detail: 'ما المطلوب وما نطاقه؟' },
  { n: 2, ar: 'فحص السياسة والصلاحية', detail: 'هل يسمح النظام بهذا التطبيق والإجراء والهدف؟' },
  { n: 3, ar: 'طلب موافقة عند الحاجة', detail: 'الإجراءات الحساسة تتوقف حتى القرار البشري' },
  { n: 4, ar: 'النقر أو الكتابة', detail: 'داخل النطاق المسموح فقط' },
  { n: 5, ar: 'التحقق وتسجيل الدليل', detail: 'النتيجة الفعلية + سبب القرار + الموافقة' }
]);

/**
 * The competitive bet: autonomy that must carry evidence. Named as a *proposal* — the stages below are a roadmap,
 * not a scoreboard, and the infographic says so.
 */
export const COMPETITIVE_FEATURE = Object.freeze({
  id: 'evidence-carrying-autonomy',
  ar: 'الاستقلالية المصحوبة بأدلة',
  en: 'Evidence-Carrying Autonomy',
  thesis: 'لا يكفي أن يعلن الوكيل نجاحه؛ عليه أن يقدّم دليلًا يُتحقق منه مستقلًا عنه — وهذا ما لا تمنحه سهولة النقر والكتابة وحدها.',
  pillars: Object.freeze([
    { id: 'pre_execution_governance', ar: 'حوكمة قبل التنفيذ', detail: 'كل إجراء يمر بمحرك السياسة؛ الأداة لا تتجاوز الصلاحية حتى لو طلب النموذج ذلك.' },
    { id: 'evidence_per_step', ar: 'دليل لكل خطوة', detail: 'الهدف، قرار السياسة، نتيجة الأداة، والدليل الداعم — مسجّلة ومترابطة.' },
    { id: 'independent_verifier', ar: 'ناقد ومتحقق مستقلان', detail: 'يفحصان الناتج الفعلي ويكشفان النجاح الكاذب بدل تصديق تقرير الوكيل عن نفسه.' },
    { id: 'auditable_recovery', ar: 'استعادة قابلة للتدقيق', detail: 'سجل متين يعيد بناء الحالة؛ وإعادة التشغيل لا تكرر الأثر الخارجي تلقائيًا.' },
    { id: 'continuous_objective_test', ar: 'اختبار موضوعي مستمر', detail: 'مهام ثابتة تقيس الصحة والالتزام بالصلاحيات والتعافي والتكلفة.' }
  ]),
  stages: Object.freeze([
    { n: 1, ar: 'تثبيت الحوكمة', build: 'Capability Registry + Policy Engine + بوابات الموافقة', gate: 'صفر إجراءات غير مصرح بها في الاختبارات' },
    { n: 2, ar: 'إثبات التنفيذ', build: 'Evidence Ledger + متحقق مستقل + استعادة آمنة', gate: 'لا نجاح دون دليل كافٍ' },
    { n: 3, ar: 'تعميم الاختبارات', build: 'مهام متعددة وأخطاء متعمدة وإعادة محاولة', gate: 'قياس النجاح الكاذب والفشل الكاذب وإعادة البناء' },
    { n: 4, ar: 'المقارنة العادلة', build: 'تشغيل المهام نفسها على CeliaOS وClaude وManus', gate: 'نتائج قابلة للتكرار: دقة وتكلفة وزمن وأمان' }
  ]),
  notClaimed: 'هذه ميزة مستهدفة، وليست إثبات تفوّق حالي: لا مقارنة مهام موحّدة أُجريت بعد، ولا محرك تنفيذ كمبيوتر موصول في هذا المستودع.'
});

export function capabilityById(id) {
  return CAPABILITIES.find((capability) => capability.id === id) || null;
}

/**
 * Decide one action. Returns the policy verdict *and* whether it could actually run.
 *
 * `executable` is false whenever the capability is not wired, and it is deliberately independent of the verdict:
 * a diagram may say "click is allowed" while nothing on this machine can click.
 */
export function decideAction({ capability, target = {}, state = SYSTEM_STATE } = {}) {
  const entry = capabilityById(capability);
  const base = { capability: capability ?? null, verdict: null, reason: '', executable: false, gates: [], state: { ...state } };

  // 1. Default deny: an unnamed capability is not a capability.
  if (!entry) return { ...base, verdict: 'deny', reason: 'default_deny:unknown_capability', gates: ['default_deny'] };

  // 2. Nothing runs while the executor is parked, whatever the policy says.
  const notExecutable = entry.wired !== true;

  // 3. Hard denials first — network, secrets, admin, identity.
  if (entry.status === STATUS.denied) {
    return { ...base, verdict: 'deny', reason: `blocked_by_policy:${entry.id}`, gates: [entry.gate, 'default_deny'] };
  }
  if (entry.external && state.network === 'DENY') {
    return { ...base, verdict: 'deny', reason: 'network_denied:NETWORK=DENY', gates: ['NETWORK'] };
  }
  if (entry.identity && state.identity !== 'PROVEN') {
    return { ...base, verdict: 'deny', reason: 'identity_not_proven:IDENTITY=NOT_PROVEN', gates: ['IDENTITY'] };
  }

  // 4. Scope: an allowed capability is still refused on an out-of-scope target.
  if (target.inScope === false) {
    return { ...base, verdict: 'deny', reason: 'out_of_scope_target', gates: ['scope'] };
  }

  // 5. Approval-required capabilities: an external one stays closed until the gate opens.
  if (entry.status === STATUS.approval) {
    if (entry.external && state.externalGates !== 'OPEN') {
      return {
        ...base,
        verdict: 'deny',
        reason: 'external_gate_closed:EXTERNAL GATES=CLOSED',
        gates: ['EXTERNAL_GATES', 'approval'],
        executable: false
      };
    }
    if (target.approved === true) {
      return { ...base, verdict: 'allow', reason: 'approved_by_human', gates: ['approval'], executable: !notExecutable };
    }
    return { ...base, verdict: 'require_approval', reason: 'human_approval_required', gates: ['approval'], executable: false };
  }

  // 6. Restricted capabilities need an explicit, recorded permission for this target.
  if (entry.status === STATUS.restricted) {
    if (target.approved === true) {
      return { ...base, verdict: 'allow', reason: 'permitted_for_this_target', gates: [entry.gate], executable: !notExecutable };
    }
    return { ...base, verdict: 'require_approval', reason: 'restricted_needs_permission', gates: [entry.gate], executable: false };
  }

  // 7. Allowed within scope.
  return { ...base, verdict: 'allow', reason: `allowed_within_scope:${entry.scope}`, executable: !notExecutable };
}

/** Evaluate a planned sequence; one denial makes the plan non-executable, and approvals are surfaced, not assumed. */
export function evaluatePlan(actions = [], state = SYSTEM_STATE) {
  const results = actions.map((action) => ({ ...action, ...decideAction({ ...action, state }) }));
  const denied = results.filter((result) => result.verdict === 'deny');
  const approvals = results.filter((result) => result.verdict === 'require_approval');
  const allowed = results.filter((result) => result.verdict === 'allow');
  return {
    results,
    allowed: allowed.length,
    approvals: approvals.length,
    denied: denied.length,
    executable: results.length > 0 && denied.length === 0 && approvals.length === 0 && results.every((result) => result.executable),
    note: 'executable=false means the policy verdict cannot be carried out in this repository (executor not wired)'
  };
}

/** The public summary the infographic prints; every number is derived, never typed by hand. */
export function policySummary() {
  const byStatus = Object.fromEntries(Object.values(STATUS).map((status) => [status, 0]));
  for (const capability of CAPABILITIES) byStatus[capability.status] += 1;
  return {
    version: COMPUTER_POLICY_VERSION,
    state: { ...SYSTEM_STATE },
    total: CAPABILITIES.length,
    byStatus,
    wired: CAPABILITIES.filter((capability) => capability.wired).length,
    tested: CAPABILITIES.filter((capability) => capability.tested).length
  };
}
