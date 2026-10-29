/*
 * أثر التنفيذ (WP-1.2، AGENT-008، DEC-047) — دوال نقية بلا DOM تُستورد من agent.js وتُختبر في Node.
 *
 * كل ما هنا يُشتق من بيانات موجودة في GET /api/agent/runs/:id (الخطوات بأزمنتها المُثبَتة، `now`، `plan.stages`،
 * `run.usage` و`run.limits`). لا تقدير ولا توقّع: المدة غير المعروفة تُعرض «—»، والحالة غير المحسومة تُسمّى كذلك.
 */

export const STEP_NODE = Object.freeze({
  running: 'running',
  done: 'done',
  failed: 'failed',
  unknown: 'unknown',
  waiting: 'waiting',
  recorded: 'recorded'
});

export const STEP_NODE_LABELS = Object.freeze({
  running: 'قيد التنفيذ',
  done: 'تم',
  failed: 'فشل',
  unknown: 'غير محسوم',
  waiting: 'بانتظار',
  recorded: 'مسجّل'
});

export const STAGE_NODE_LABELS = Object.freeze({
  done: 'تم',
  current: 'الآن',
  pending: 'لاحقًا',
  skipped: 'لم يلزم',
  stopped: 'توقف'
});

const RUN_STATUS_LABELS = Object.freeze({
  queued: 'في الانتظار',
  running: 'يعمل',
  waiting_approval: 'بانتظار موافقة',
  needs_reconciliation: 'يحتاج مصالحة',
  succeeded: 'نُفذ',
  failed: 'فشل',
  cancelled: 'أُلغي',
  budget_exhausted: 'توقف بالميزانية'
});

const ACTIVE_RUN_STATUSES = Object.freeze(['queued', 'running']);
const TERMINAL_RUN_STATUSES = Object.freeze(['succeeded', 'failed', 'cancelled', 'budget_exhausted']);

/** مدة بالمللي ثانية إلى نص عربي قصير؛ «—» عندما لا يوجد قياس. */
export function formatMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} ث`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} د ${seconds} ث`;
}

/**
 * حالة عقدة الخطوة من بياناتها المخزّنة فقط:
 * - `act`: من حالة استدعاء الأداة المرتبط بها (started → قيد التنفيذ، succeeded → تم، failed → فشل، unknown → غير محسوم؛
 *   بلا استدعاء بعد → قيد التنفيذ إن كانت آخر خطوة والتشغيل نشط، وإلا غير محسوم).
 * - آخر خطوة بينما التشغيل `waiting_approval`/`needs_reconciliation` → بانتظار.
 * - `deliver` → تم. غير ذلك (`decide`/`observe`/`verify`) → مسجّل: السجل يثبت الكتابة لا المدة.
 */
export function stepNodeStatus(step, { runStatus = null, isLast = false } = {}) {
  if (!step || typeof step !== 'object') return STEP_NODE.recorded;
  if (isLast && (runStatus === 'waiting_approval' || runStatus === 'needs_reconciliation')) return STEP_NODE.waiting;
  if (step.kind === 'act') {
    switch (step.toolRunStatus) {
      case 'succeeded':
        return STEP_NODE.done;
      case 'failed':
        return STEP_NODE.failed;
      case 'unknown':
        return STEP_NODE.unknown;
      case 'started':
        return STEP_NODE.running;
      default:
        return isLast && ACTIVE_RUN_STATUSES.includes(runStatus) ? STEP_NODE.running : STEP_NODE.unknown;
    }
  }
  if (step.kind === 'deliver') return STEP_NODE.done;
  return STEP_NODE.recorded;
}

/** المدة المنقضية الآن من `since` بساعة العميل، أو `elapsedMs` كما أرسله الخادم إن تعذّر. */
export function elapsedSince(now, atMs = Date.now()) {
  if (!now || typeof now !== 'object') return null;
  const sinceMs = Date.parse(String(now.since ?? ''));
  if (Number.isFinite(sinceMs) && Number.isFinite(atMs) && atMs >= sinceMs) return atMs - sinceMs;
  return typeof now.elapsedMs === 'number' && Number.isFinite(now.elapsedMs) ? now.elapsedMs : null;
}

/** سطر «الآن» من كائن `now` الذي يعيده الخادم؛ بلا تشغيل → «لا تشغيل». */
export function nowLabel(now, atMs = Date.now()) {
  if (!now || typeof now !== 'object' || !now.state) return 'لا تشغيل';
  const elapsed = formatMs(elapsedSince(now, atMs));
  const tool = now.toolName ? String(now.toolName) : 'أداة';
  switch (now.state) {
    case 'queued':
      return `في الانتظار منذ ${elapsed}`;
    case 'executing_tool':
      return `الآن: ينفّذ ${tool} منذ ${elapsed}`;
    case 'planning':
      return `الآن: يقرر الخطوة التالية (منذ ${elapsed})`;
    case 'waiting_approval':
      return `الآن: بانتظار قرارك على ${tool} منذ ${elapsed}`;
    case 'needs_reconciliation':
      return `الآن: بانتظار مصالحتك${now.toolName ? ` (${tool})` : ''} منذ ${elapsed}`;
    case 'finished': {
      const label = RUN_STATUS_LABELS[now.status] || now.status || 'انتهى';
      return `انتهى (${label}) — الإجمالي ${formatMs(now.totalMs)}`;
    }
    default:
      return `الآن: ${now.state}`;
  }
}

/** نِسَب الميزانية من `usage`/`limits` الحقيقيين؛ `percent: null` عندما لا سقف. */
export function budgetRatios(usage = {}, limits = {}) {
  const ratio = (used, max) => {
    const u = Number(used);
    const m = Number(max);
    const safeUsed = Number.isFinite(u) && u >= 0 ? u : 0;
    const safeMax = Number.isFinite(m) && m > 0 ? m : null;
    return {
      used: safeUsed,
      max: safeMax,
      percent: safeMax === null ? null : Math.min(100, Math.round((safeUsed / safeMax) * 100))
    };
  };
  return {
    steps: ratio(usage?.steps, limits?.maxSteps),
    cost: ratio(usage?.costMicros, limits?.maxCostMicros),
    tokens: Number.isFinite(Number(usage?.tokens)) ? Number(usage.tokens) : 0
  };
}

/**
 * عقد شجرة الخطة من `plan.stages` (أربع مراحل بـ`completed`) وحالة التشغيل:
 * المكتملة «تم»؛ أول غير مكتملة «الآن» إن كان التشغيل نشطًا أو ينتظر؛ عند الانتهاء: مرحلة العرض بلا موافقات «لم يلزم»،
 * التنفيذ «تم» إن نجح التشغيل (مع الحكم إن لم يكن PASS) و«توقف» إن فشل/أُلغي/نفدت ميزانيته.
 */
export function stageNodes(plan, run, { approvals = [], verification = null } = {}) {
  const stages = Array.isArray(plan?.stages) ? plan.stages : [];
  const status = run?.status ?? null;
  const terminal = TERMINAL_RUN_STATUSES.includes(status);
  let currentAssigned = false;
  return stages.map((stage) => {
    const node = { id: stage.id, title: stage.title, status: 'pending', note: '' };
    if (stage.completed) {
      node.status = 'done';
      return node;
    }
    if (!terminal) {
      if (!currentAssigned) {
        currentAssigned = true;
        node.status = 'current';
        if (status === 'waiting_approval') node.note = 'بانتظار قرارك';
        else if (status === 'needs_reconciliation') node.note = 'بانتظار المصالحة';
      }
      return node;
    }
    if (stage.id === 'present_and_wait' && !(Array.isArray(approvals) && approvals.length)) {
      node.status = 'skipped';
      node.note = 'أدوات قراءة فقط — لا أثر خارجي يحتاج موافقة';
      return node;
    }
    if (status === 'succeeded') {
      node.status = 'done';
      if (stage.id === 'execute_and_verify' && verification?.verdict && verification.verdict !== 'PASS') {
        node.note = `الحكم: ${verification.verdict}`;
      }
      return node;
    }
    node.status = 'stopped';
    node.note = RUN_STATUS_LABELS[status] || status || '';
    return node;
  });
}

/** ملخص عقد الخطوات تحت مرحلة التنفيذ: كم أداة، كم تمت، كم قيد التنفيذ/فشلت/غير محسومة. */
export function summarizeStepNodes(steps = [], runStatus = null) {
  const counts = { total: 0, act: 0, done: 0, running: 0, failed: 0, unknown: 0, waiting: 0, measuredMs: 0 };
  const list = Array.isArray(steps) ? steps : [];
  list.forEach((step, index) => {
    counts.total += 1;
    if (step?.kind === 'act') counts.act += 1;
    const node = stepNodeStatus(step, { runStatus, isLast: index === list.length - 1 });
    if (node === STEP_NODE.done && step?.kind === 'act') counts.done += 1;
    if (node === STEP_NODE.running) counts.running += 1;
    if (node === STEP_NODE.failed) counts.failed += 1;
    if (node === STEP_NODE.unknown) counts.unknown += 1;
    if (node === STEP_NODE.waiting) counts.waiting += 1;
    if (typeof step?.durationMs === 'number' && Number.isFinite(step.durationMs)) counts.measuredMs += step.durationMs;
  });
  return counts;
}
