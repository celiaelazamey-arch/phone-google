/**
 * Visual-First Engineering — the rule as data (VFE-001 / DEC-085).
 *
 * The owner's instruction is a working rule, not a preference: every engineering result must be
 * *shown*, not only described, and every shape on the page must carry an honest state. This module
 * holds the vocabulary, the pipeline, the delivery order and the registry of the eleven master
 * diagrams — with the status each one actually deserves today, and the file that proves it.
 *
 * Two habits this file forbids:
 *   1. Drawing a component nobody can point to. Every entry cites evidence that must exist on disk;
 *      `test/visual-first.test.js` refuses an entry whose evidence is missing.
 *   2. Calling a file a feature. `implemented` is reserved for a shape that was verified against the
 *      code, and the registry's own summary currently reports how many master diagrams are missing —
 *      the honest number, not the flattering one.
 */

export const VFE_VERSION = 'celiaos-vfe-2026-v1';

/** The five states from the owner's rule. A shape without one of these is not allowed on a page. */
export const STATUS = Object.freeze({
  implemented: 'implemented',
  partial: 'partial',
  proposed: 'proposed',
  missing: 'missing',
  disabled: 'disabled'
});

export const STATUS_MARK = Object.freeze({
  [STATUS.implemented]: '🟢',
  [STATUS.partial]: '🟡',
  [STATUS.proposed]: '🔵',
  [STATUS.missing]: '🔴',
  [STATUS.disabled]: '⚪'
});

export const STATUS_LABEL = Object.freeze({
  [STATUS.implemented]: 'موجود ومتحقق',
  [STATUS.partial]: 'جزئي أو بقيود',
  [STATUS.proposed]: 'مقترح',
  [STATUS.missing]: 'غير موجود',
  [STATUS.disabled]: 'موجود وغير مفعّل'
});

export const STATUS_RULE = Object.freeze({
  [STATUS.implemented]: 'الشكل مطابق للكود، وله اختبار أو قياس حقيقي',
  [STATUS.partial]: 'موجود ومثبت، وبعض أجزائه ناقصة أو مقيّدة',
  [STATUS.proposed]: 'مصمَّم ولم يُنفَّذ؛ لا يُعرض كأنه يعمل',
  [STATUS.missing]: 'لا وجود له؛ يُذكر كفجوة لا كصندوق',
  [STATUS.disabled]: 'الكود موجود ولا يعمل افتراضيًا؛ يُعرض بعلامة إيقاف'
});

/** The owner's closing line, kept as the pipeline the work actually follows. */
export const PIPELINE = Object.freeze(['BUILD', 'VISUALIZE', 'EXECUTE', 'VERIFY', 'PRESENT EVIDENCE']);

/** §1 — the ten shapes. A task picks the ones that explain the change; not all ten for a typo. */
export const DIAGRAM_KINDS = Object.freeze([
  Object.freeze({ id: 'architecture', ar: 'المخطط المعماري', en: 'Architecture Diagram' }),
  Object.freeze({ id: 'component', ar: 'مكونات النظام وعلاقاتها', en: 'Component Diagram' }),
  Object.freeze({ id: 'data_flow', ar: 'تدفق البيانات', en: 'Data Flow Diagram' }),
  Object.freeze({ id: 'sequence', ar: 'تسلسل العمليات والأحداث', en: 'Sequence Diagram' }),
  Object.freeze({ id: 'workflow', ar: 'مراحل التنفيذ', en: 'Workflow Diagram' }),
  Object.freeze({ id: 'state_machine', ar: 'حالات النظام وانتقالاتها', en: 'State Machine' }),
  Object.freeze({ id: 'dependency', ar: 'اعتماد المكونات', en: 'Dependency Graph' }),
  Object.freeze({ id: 'before_after', ar: 'قبل وبعد', en: 'Before / After' }),
  Object.freeze({ id: 'evidence', ar: 'عرض نتائج الاختبار والتحقق', en: 'Evidence Visualization' }),
  Object.freeze({ id: 'dashboard', ar: 'لوحة المتابعة التشغيلية', en: 'Dashboard' })
]);

/** §6 — the order every delivery follows, in the owner's own sequence. */
export const DELIVERY_ORDER = Object.freeze([
  Object.freeze({ n: 1, ar: 'الهدف والتغيير', en: 'Goal and change' }),
  Object.freeze({ n: 2, ar: 'المخطط البصري قبل التغيير وبعده', en: 'Before / after visual' }),
  Object.freeze({ n: 3, ar: 'المكونات والملفات التي تغيّرت', en: 'Changed components and files' }),
  Object.freeze({ n: 4, ar: 'مخطط تدفق التنفيذ', en: 'Execution flow' }),
  Object.freeze({ n: 5, ar: 'نتائج الاختبارات الفعلية', en: 'Actual test results' }),
  Object.freeze({ n: 6, ar: 'الأدلة وروابط الملفات', en: 'Evidence and file links' }),
  Object.freeze({ n: 7, ar: 'القيود والفجوات', en: 'Limits and gaps' }),
  Object.freeze({ n: 8, ar: 'الخطوة التالية', en: 'Next step' })
]);

/** §8 — what no diagram may buy its way around. */
export const SAFETY_KEPT = Object.freeze([
  'NETWORK = DENY افتراضيًا',
  'الموافقة البشرية للعمليات الحساسة',
  'Evidence وTrace ID',
  'التحقق المستقل من النتائج',
  'عدم كشف الأسرار'
]);

/**
 * §4 — the eleven master diagrams the system must keep. `status` is the state *today*; `artifact` is
 * the page that shows it (null when nothing shows it yet); `evidence` are files that must exist for
 * the claim to stand; `gap` names what is still missing in plain words.
 */
export const MASTER_VISUALS = Object.freeze([
  Object.freeze({
    id: 'kernel.architecture',
    ar: 'Kernel Architecture',
    status: STATUS.partial,
    artifact: 'docs/celiaos-architecture-map.html',
    evidence: ['docs/celiaos-architecture-map.html', 'src/agent/harness.js'],
    gap: 'الخريطة ما زالت تصنّف model_router «مقترحًا» وهو منفّذ (DEC-081)؛ لم تُحدَّث.'
  }),
  Object.freeze({
    id: 'agent.harness',
    ar: 'Agent Harness',
    status: STATUS.implemented,
    artifact: 'docs/design/runtime-verified-architecture.html',
    evidence: ['docs/design/runtime-verified-architecture.html', 'src/agent/harness.js', 'test/agent-harness.test.js'],
    gap: 'لا شيء في هذا الرسم؛ أسماؤه مأخوذة من HARNESS_LIFECYCLE_STAGES حرفيًا.'
  }),
  Object.freeze({
    id: 'planner.router.tools',
    ar: 'Planner → Model Router → Tool Selector',
    status: STATUS.partial,
    artifact: 'docs/celiaos-architecture-map.html',
    evidence: ['docs/celiaos-architecture-map.html', 'src/agent/planner.js', 'src/agent/model-router.js'],
    gap: 'لا مخطط تسلسل يبيّن قرار التوجيه وسبب اختيار الأداة.'
  }),
  Object.freeze({
    id: 'policy.approval.sandbox',
    ar: 'Policy → Approval → Sandbox',
    status: STATUS.partial,
    artifact: 'docs/design/runtime-verified-architecture.html',
    evidence: ['src/agent/harness.js', 'src/agent/sandbox-policy.js', 'test/agent-egress-proxy.test.js'],
    gap: 'المراحل معروضة، وربط البصمة بالرفض يحتاج مخطط تدفق مستقلًا.'
  }),
  Object.freeze({
    id: 'executor.verifier.evidence',
    ar: 'Executor → Verifier → Evidence',
    status: STATUS.missing,
    artifact: null,
    evidence: ['src/agent/verifier.js', 'src/agent/evidence.js', 'test/agent-verifier.test.js'],
    gap: 'لا رسم يبيّن سلسلة SHA-256 والأحكام الثلاثة PASS/BLOCK/UNKNOWN.'
  }),
  Object.freeze({
    id: 'memory.knowledge.learning',
    ar: 'Memory → Knowledge → Learning',
    status: STATUS.partial,
    artifact: 'docs/celiaos-architecture-map.html',
    evidence: ['src/agent/memory.js', 'src/knowledge/manifest.js', 'test/agent-memory.test.js'],
    gap: 'التعلم غير منفّذ: التقييم يقيس ولا يغيّر السياسة (DEC-081).'
  }),
  Object.freeze({
    id: 'browser.computer.mcp',
    ar: 'Browser / Computer Use / MCP',
    status: STATUS.partial,
    artifact: 'docs/computer-permissions/README.md',
    evidence: ['src/agent/computer-policy.js', 'docs/computer-permissions/README.md', 'src/mcp-contract.js'],
    gap: 'المصفوفة سياسة لا معمار: لا يظهر فيها أن MCP اتجاهه معكوس وأن المتصفح غير موصول.'
  }),
  Object.freeze({
    id: 'eventbus.toolregistry',
    ar: 'Event Bus & Tool Registry',
    status: STATUS.missing,
    artifact: null,
    evidence: ['src/agent/runtime.js', 'src/knowledge/tool-policy.js'],
    gap: 'لا رسم يبيّن من يستهلك الحدث ومن يملك تسجيل الأداة.'
  }),
  Object.freeze({
    id: 'database.persistence',
    ar: 'Database & Persistence',
    status: STATUS.missing,
    artifact: null,
    evidence: ['src/db.js', 'src/mysql-config.js', 'src/schema-migrations.js'],
    gap: 'لا رسم يبيّن MySQL وD1 والهجرات وما يُفقد عند الفشل.'
  }),
  Object.freeze({
    id: 'security.governance',
    ar: 'Security & Governance',
    status: STATUS.partial,
    artifact: 'docs/access-policy/README.md',
    evidence: ['docs/access-policy/README.md', 'src/agent/access-policy.js', 'docs/agent-risk-matrix.md'],
    gap: 'مصفوفة صلاحيات نعم، وخريطة حواجز متصلة لا.'
  }),
  Object.freeze({
    id: 'deployment.infrastructure',
    ar: 'Deployment & Infrastructure',
    status: STATUS.missing,
    artifact: null,
    evidence: ['.github/workflows/pages.yml', '.github/workflows/cloudflare-deploy.yml', 'render.yaml'],
    gap: 'لا رسم يبيّن مسار main إلى Cloudflare وPages وRender وأين تنكسر الحلقة.'
  })
]);

export const MASTER_IDS = Object.freeze(MASTER_VISUALS.map((entry) => entry.id));

/** §5 — the verification rules, as readable sentences the page prints. */
export const VERIFICATION_RULES = Object.freeze([
  'كل عنصر بصري يحمل واحدة من الحالات الخمس؛ ولا شكل بلا حالة.',
  'كل صندوق يشير إلى ملف أو وحدة قائمة، واختبار يرفض الدليل الغائب.',
  'الاتصالات غير المنفذة تظهر منقطعة، لا مخفية.',
  'نقاط الفشل والقيود مكتوبة على الرسم لا في حاشية.',
  'المختبَر وغير المختبَر يفترقان بعلامة، لا بتقدير.',
  'لا نسب نجاح تقديرية: الأرقام من تشغيل فعلي أو لا تُذكر.',
  'المقترح يبقى مقترحًا حتى يوجد له كود واختبار.'
]);

/** §9 — a task is not done because a report exists. */
export const ACCEPTANCE = Object.freeze([
  'نتيجة برمجية قابلة للتحقق',
  'مخطط بصري مطابق للتنفيذ',
  'اختبارات أو أدلة مناسبة',
  'قائمة بالفجوات المتبقية'
]);

export function visualSummary() {
  const counts = Object.fromEntries(Object.values(STATUS).map((status) => [status, 0]));
  for (const entry of MASTER_VISUALS) counts[entry.status] += 1;
  return {
    version: VFE_VERSION,
    total: MASTER_VISUALS.length,
    counts,
    implemented: counts[STATUS.implemented],
    partial: counts[STATUS.partial],
    missing: counts[STATUS.missing],
    proposed: counts[STATUS.proposed],
    disabled: counts[STATUS.disabled],
    withArtifact: MASTER_VISUALS.filter((entry) => entry.artifact).length,
    diagrams: DIAGRAM_KINDS.length,
    deliverySteps: DELIVERY_ORDER.length
  };
}
