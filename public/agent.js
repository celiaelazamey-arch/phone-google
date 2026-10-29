/* مساحة الوكيل — M1. الرمز يبقى في sessionStorage لهذه التبويبة فقط. */
import {
  STEP_NODE_LABELS,
  STAGE_NODE_LABELS,
  budgetRatios,
  formatMs,
  nowLabel,
  stageNodes,
  stepNodeStatus,
  summarizeStepNodes
} from './agent-trace.js';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'celia.agent.token';
let state = {
  token: sessionStorage.getItem(TOKEN_KEY) || '',
  threadId: null,
  runId: null,
  lastClientMessageId: null,
  streaming: null,
  // WP-1.2 — أثر التنفيذ: الخطوات بأزمنتها كما وصلت، وحالة التشغيل، و«الآن» كما أرسله الخادم.
  runStatus: null,
  steps: [],
  limits: null,
  plan: null,
  approvals: [],
  verification: null,
  now: null,
  nowTimer: null
};
let memoryEpoch = 0;

const RUN_LABELS = {
  queued: ['في الانتظار', 'running'],
  running: ['يعمل', 'running'],
  waiting_approval: ['بانتظار موافقة', 'warn'],
  needs_reconciliation: ['يحتاج مصالحة', 'warn'],
  succeeded: ['نُفذ', 'ok'],
  failed: ['فشل', 'bad'],
  cancelled: ['أُلغي', 'warn'],
  budget_exhausted: ['توقف بالميزانية', 'warn']
};

function setAuthStatus(text, kind = '') {
  const el = $('auth-status');
  el.textContent = text;
  el.className = `status ${kind}`.trim();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${state.token}`,
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function renderStatus(status) {
  const badge = $('mode-badge');
  if (!status.enabled) {
    badge.textContent = status.mode === 'off' ? 'الوكيل متوقف (off)' : 'غير متاح';
    badge.className = 'badge off';
    $('mode-note').textContent = status.message || `مطلوب: ${status.requiredEnv || 'CELIA_AGENT_RUNTIME=mysql|sqlite'}. الرحمة بالترتيب: mysql للإنتاج أو sqlite محليًا.`;
    $('fact-store').textContent = '—';
    $('fact-planner').textContent = '—';
    $('fact-steps').textContent = '—';
    $('fact-cost').textContent = '—';
    $('run').disabled = true;
    return;
  }
  badge.textContent = `يعمل · ${status.mode || status.dialect}`;
  badge.className = 'badge ok';
  $('fact-store').textContent = status.dialect === 'mysql' ? 'MySQL دائم' : 'SQLite محلي/تجريبي';
  $('fact-planner').textContent = status.planner;
  $('fact-verifier').textContent = status.verifier || '—';
  $('fact-steps').textContent = status.limits?.maxSteps ?? '—';
  $('fact-cost').textContent = status.limits?.maxCostMicros ?? '—';
  $('mode-note').textContent = status.note || '';
  $('run').disabled = false;
}

function setRunState(status) {
  const [label, kind] = RUN_LABELS[status] || [status || 'لا تشغيل', 'idle'];
  const pill = $('run-state');
  pill.textContent = label;
  pill.className = `pill ${kind}`;
  $('cancel').disabled = !['queued', 'running'].includes(status);
  if ($('export-audit')) $('export-audit').disabled = !state.runId;
  if (state.runStatus !== (status ?? null)) {
    state.runStatus = status ?? null;
    // حالة العقد تعتمد على حالة التشغيل (آخر خطوة «بانتظار» مثلًا)، فتُعاد رسمها عند كل انتقال.
    rerenderStepNodes();
  }
}

function setBar(id, ratio) {
  const track = $(id);
  if (!track) return;
  const percent = ratio.percent ?? 0;
  track.setAttribute('aria-valuenow', String(percent));
  track.setAttribute('aria-valuetext', ratio.max === null ? `${ratio.used} بلا سقف معلن` : `${ratio.used} من ${ratio.max} (${percent}٪)`);
  track.dataset.level = percent >= 90 ? 'bad' : percent >= 70 ? 'warn' : 'ok';
  const fill = track.querySelector('.bar-fill');
  if (fill) fill.style.width = `${percent}%`;
}

/* الميزانية من `usage`/`limits` الحقيقيين فقط؛ السقف يأتي مع التشغيل (run.limits) أو مع حدث step. */
function setUsage(usage = {}, limits = null) {
  const ratios = budgetRatios(usage || {}, limits || state.limits || {});
  if (limits) state.limits = limits;
  $('usage-steps').textContent = ratios.steps.used;
  $('usage-cost').textContent = ratios.cost.used;
  $('usage-tokens').textContent = ratios.tokens;
  $('limit-steps').textContent = ratios.steps.max ?? '—';
  $('limit-cost').textContent = ratios.cost.max ?? '—';
  setBar('bar-steps', ratios.steps);
  setBar('bar-cost', ratios.cost);
}

/* سطر «الآن» يُعرض كما أرسله الخادم (`detail.now` / `step.now`)؛ المنقضي يُحدَّث محليًا كل ثانية من `since`. */
function renderNow(now) {
  state.now = now || null;
  const line = $('now-line');
  if (!line) return;
  line.textContent = nowLabel(state.now, Date.now());
  line.dataset.state = state.now?.state || '';
  line.dataset.status = state.now?.status || '';
  const live = state.now && state.now.state !== 'finished';
  if (live && !state.nowTimer) {
    state.nowTimer = setInterval(() => {
      if (!state.now || state.now.state === 'finished') {
        clearInterval(state.nowTimer);
        state.nowTimer = null;
        return;
      }
      line.textContent = nowLabel(state.now, Date.now());
    }, 1000);
  } else if (!live && state.nowTimer) {
    clearInterval(state.nowTimer);
    state.nowTimer = null;
  }
}

function renderTree(plan, run, { approvals = [], verification = null } = {}) {
  const tree = $('plan-tree');
  if (!tree) return;
  const nodes = stageNodes(plan, run, { approvals, verification });
  if (!nodes.length) {
    tree.innerHTML = '<li class="empty">لا تظهر شجرة الخطة إلا بعد بدء تشغيل.</li>';
    return;
  }
  const MARKS = { done: '✓', current: '▶', pending: '○', skipped: '–', stopped: '✕' };
  tree.innerHTML = '';
  const summary = summarizeStepNodes(state.steps, run?.status ?? null);
  for (const node of nodes) {
    const item = document.createElement('li');
    item.dataset.stage = node.id;
    item.dataset.status = node.status;
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = MARKS[node.status] || '○';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = node.title;
    let note = node.note;
    if (node.id === 'execute_and_verify' && summary.total) {
      const parts = [`${summary.total} خطوة`, `${summary.act} استدعاء أداة`];
      if (summary.done) parts.push(`${summary.done} تم`);
      if (summary.running) parts.push(`${summary.running} قيد التنفيذ`);
      if (summary.failed) parts.push(`${summary.failed} فشل`);
      if (summary.unknown) parts.push(`${summary.unknown} غير محسوم`);
      if (summary.measuredMs) parts.push(`زمن الأدوات المُثبَت ${formatMs(summary.measuredMs)}`);
      note = [note, parts.join(' · ')].filter(Boolean).join(' — ');
    }
    if (note) {
      const small = document.createElement('small');
      small.className = 'note';
      small.textContent = note;
      label.append(small);
    }
    const pill = document.createElement('span');
    pill.className = `pill stage-${node.status}`;
    pill.textContent = STAGE_NODE_LABELS[node.status] || node.status;
    item.append(mark, label, pill);
    tree.append(item);
  }
  if (plan?.transitions?.length) {
    const item = document.createElement('li');
    item.className = 'transitions';
    item.dataset.status = 'info';
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '↦';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = `انتقالات الخطة: ${plan.transitions.join(' → ')}`;
    const pill = document.createElement('span');
    pill.className = 'pill idle';
    pill.textContent = plan.state || '—';
    item.append(mark, label, pill);
    tree.append(item);
  }
}

function rememberStep(step) {
  if (!step || typeof step.index !== 'number') return;
  const position = state.steps.findIndex((item) => item.index === step.index);
  if (position === -1) {
    state.steps.push(step);
    state.steps.sort((a, b) => a.index - b.index);
  } else {
    state.steps[position] = { ...state.steps[position], ...step };
  }
}

function buildStepItem(step, position) {
  const item = document.createElement('li');
  item.dataset.index = String(step.index);
  const node = stepNodeStatus(step, { runStatus: state.runStatus, isLast: position === state.steps.length - 1 });
  item.dataset.node = node;
  const head = document.createElement('div');
  head.className = 'head';
  const title = document.createElement('b');
  title.textContent = `${step.index}. ${step.title}`;
  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = step.kind;
  head.append(title, kind);
  item.append(head);
  if (step.summary) {
    const summary = document.createElement('p');
    summary.className = 'summary';
    summary.textContent = step.summary;
    item.append(summary);
  }
  const meta = document.createElement('div');
  meta.className = 'meta';
  const pill = document.createElement('span');
  pill.className = `pill node-${node}`;
  pill.textContent = STEP_NODE_LABELS[node] || node;
  const time = document.createElement('span');
  time.className = 'time';
  const measured = typeof step.durationMs === 'number';
  time.textContent = `الزمن: ${formatMs(step.durationMs)}`;
  time.title = measured
    ? `مُثبَت من استدعاء الأداة ${step.toolRunId || ''}`.trim()
    : step.kind === 'act'
      ? `لا مدة مُثبَتة بعد (حالة الاستدعاء: ${step.toolRunStatus || 'لم يبدأ'})`
      : 'المخزن يسجّل وقت كتابة هذه الخطوة لا مدتها';
  meta.append(pill, time);
  if (step.toolName && step.kind !== 'act') {
    const tool = document.createElement('span');
    tool.textContent = `الأداة: ${step.toolName}`;
    meta.append(tool);
  }
  item.append(meta);
  return item;
}

function rerenderStepNodes() {
  const list = $('steps');
  if (!list || !state.steps.length) return;
  list.innerHTML = '';
  state.steps.forEach((step, position) => list.append(buildStepItem(step, position)));
}

function renderStep(step) {
  const list = $('steps');
  list.querySelector('.empty')?.remove();
  rememberStep(step);
  // عقدة الخطوة السابقة قد تتغير حالتها (لم تعد الأخيرة)، فتُعاد رسمها كلها — عددها محدود بسقف الخطوات.
  rerenderStepNodes();
  const item = list.querySelector(`[data-index="${step.index}"]`);
  item?.scrollIntoView({ block: 'nearest' });
}

/* استدعاء أداة حُسم للتو: الخادم يرسل خطوة `act` السابقة بمدتها المُثبَتة؛ تُحدَّث عقدتها دون انتظار التفاصيل. */
function applySettledStep(settledStep) {
  if (!settledStep || typeof settledStep.index !== 'number') return;
  rememberStep(settledStep);
  rerenderStepNodes();
}

function emptySteps() {
  state.steps = [];
  $('steps').innerHTML = '<li class="empty">لم تبدأ أي خطوة بعد.</li>';
  renderTree(null, null);
  renderNow(null);
  setUsage({}, null);
}

const DECISION_LABELS = {
  pending: ['بانتظار قرار المالك', 'decision-pending'],
  approved: ['موافقة مسجلة', 'decision-approved'],
  edited: ['معدّلة (أُعيد الفحص)', 'decision-edited'],
  rejected: ['مرفوضة', 'decision-rejected']
};

const EVIDENCE_LABELS = {
  goal_contract: 'عقد الهدف',
  plan_ready: 'خطة جاهزة',
  plan_edited: 'تعديل خطة',
  tool_call: 'استدعاء أداة',
  tool_call_reconciled: 'استدعاء مُصالح',
  approval: 'قرار موافقة',
  external_effect_enqueued: 'نية أثر خارجي',
  external_effect_settled: 'تسوية أثر خارجي',
  verification: 'حكم تحقق',
  delivery: 'تسليم',
  memory_deleted: 'حذف ذاكرة نهائي'
};

const OUTBOX_LABELS = {
  pending: ['بانتظار قرار', 'decision-pending'],
  dispatching: ['قيد الإرسال', 'running'],
  sent: ['أُرسل', 'ok'],
  failed: ['فشل مؤكد (لم يُرسل)', 'bad'],
  unknown: ['غير محسوم', 'warn'],
  cancelled: ['ملغى', 'warn']
};

function shortHash(hash) {
  return hash ? String(hash).slice(0, 10) + '…' : '—';
}

function renderContract(contract) {
  const root = $('contract');
  if (!contract) {
    root.innerHTML = '<p class="empty">لا يظهر العقد إلا بعد بدء تشغيل.</p>';
    return;
  }
  const list = (items) => `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
  root.innerHTML = `
    <dl>
      <dt>الهدف</dt><dd>${escapeHtml(contract.objective)}</dd>
      <dt>معايير النجاح</dt><dd>${list(contract.success_criteria || [])}</dd>
      <dt>القيود</dt><dd>${list(contract.constraints || [])}</dd>
      <dt>شروط التوقف</dt><dd>${list(contract.stop_conditions || [])}</dd>
      <dt>الميزانية</dt><dd>خطوات ≤ ${contract.budget?.maxSteps ?? '—'} · تكلفة ≤ ${contract.budget?.maxCostMicros ?? '—'} مايكرو</dd>
      <dt>الموعد النهائي</dt><dd>${escapeHtml(contract.deadline || '—')}</dd>
    </dl>`;
}

function renderApprovals(approvals = [], runStatus, plan = null, outbox = []) {
  const list = $('approvals');
  const planBadge = $('plan-state');
  if (planBadge) {
    if (!plan || !plan.state) {
      planBadge.textContent = 'بلا خطة';
      planBadge.className = 'pill idle';
    } else {
      const tone =
        plan.state === 'APPROVED' || plan.state === 'EXECUTING'
          ? 'ok'
          : plan.state === 'REJECTED'
            ? 'bad'
            : 'warn';
      planBadge.textContent = `${plan.state} · #${plan.revision || 1}`;
      planBadge.className = `pill ${tone}`;
    }
  }
  if (!approvals.length) {
    list.innerHTML = '<li class="empty">لا طلبات موافقة بعد.</li>';
  } else {
    list.innerHTML = '';
    for (const approval of approvals) {
      const [label, cls] = DECISION_LABELS[approval.decision] || [approval.decision, ''];
      const item = document.createElement('li');
      item.innerHTML = `
        <div class="head"><b>${escapeHtml(approval.toolName)}</b><span class="${cls}">${label}</span></div>
        <div class="meta">الخطر: ${escapeHtml(approval.risk)} · طُلب: ${escapeHtml(approval.requestedAt)}${approval.actor ? ` · القرار لـ: ${escapeHtml(approval.actor)}` : ''}${approval.note ? ` · ملاحظة: ${escapeHtml(approval.note)}` : ''}</div>`;
      list.append(item);
    }
  }
  const hasPending = approvals.some((approval) => approval.decision === 'pending');
  const canDecide = runStatus === 'waiting_approval' && hasPending;
  $('approval-actions').hidden = !canDecide;
  $('approval-note-field').hidden = !canDecide;
  const payloadField = $('approval-payload-field');
  const payloadInput = $('approval-payload');
  if (payloadField) payloadField.hidden = !canDecide;
  if (canDecide && payloadInput && document.activeElement !== payloadInput) {
    const pendingOutbox = (outbox || []).find((entry) => entry.status === 'pending') || null;
    const candidatePayload = plan?.proposedEffect?.payload ?? pendingOutbox?.payload ?? {};
    payloadInput.value = JSON.stringify(candidatePayload, null, 2);
  }
  $('approve').disabled = !canDecide;
  if ($('edit-plan')) $('edit-plan').disabled = !canDecide;
  $('reject').disabled = !canDecide;
}

function renderOutbox(outbox = []) {
  const list = $('outbox');
  if (!outbox.length) {
    list.innerHTML = '<li class="empty">لا نوايا خارجية بعد.</li>';
  } else {
    list.innerHTML = '';
    for (const entry of outbox) {
      const [label, cls] = OUTBOX_LABELS[entry.status] || [entry.status, ''];
      const payload = entry.payload ? JSON.stringify(entry.payload).slice(0, 220) : '—';
      const item = document.createElement('li');
      item.innerHTML = `
        <div class="head"><b>${escapeHtml(entry.toolName)}</b><span class="${cls}">${label}</span></div>
        <div class="meta">الموصل: ${escapeHtml(entry.connector || '—')} · المحاولات: ${entry.attempts}${entry.externalRef ? ` · المرجع: ${escapeHtml(entry.externalRef)}` : ''}${entry.lastError ? ` · الخطأ: ${escapeHtml(entry.lastError)}` : ''}</div>
        <div class="meta hash">${escapeHtml(payload)} · key:${shortHash(entry.idempotencyKey)}</div>`;
      list.append(item);
    }
  }
  const badge = $('outbox-badge');
  const sent = outbox.filter((entry) => entry.status === 'sent').length;
  const unknown = outbox.filter((entry) => entry.status === 'unknown').length;
  if (unknown) {
    badge.textContent = `${unknown} غير محسوم`;
    badge.className = 'pill warn';
  } else if (sent) {
    badge.textContent = `أُرسل ${sent} مرة واحدة`;
    badge.className = 'pill ok';
  } else if (outbox.length) {
    badge.textContent = 'لا إرسال';
    badge.className = 'pill idle';
  } else {
    badge.textContent = '—';
    badge.className = 'pill idle';
  }
}

/**
 * لوحة المصالحة: تعرض فقط ما هو غير محسوم فعلًا (استدعاء unknown/started، أو نية
 * outbox غير محسومة/فاشلة). القرار يُرسل إلى المسار المالك-فقط ولا يرسل أي طلب خارجي.
 */
function renderReconcile(detail, runStatus) {
  const list = $('reconcile');
  const unresolvedToolRuns = (detail?.toolRuns || []).filter(
    (toolRun) => toolRun.status === 'unknown' || toolRun.status === 'started'
  );
  const unsettledOutbox = (detail?.outbox || []).filter(
    (entry) => entry.status === 'unknown' || entry.status === 'dispatching' || entry.status === 'failed'
  );
  const items = [
    ...unresolvedToolRuns.map((toolRun) => ({
      target: 'tool_run',
      id: toolRun.id,
      name: toolRun.toolName,
      state: toolRun.status,
      retry: false
    })),
    ...unsettledOutbox.map((entry) => ({
      target: 'outbox',
      id: entry.id,
      name: entry.toolName,
      state: entry.status,
      retry: entry.status === 'failed'
    }))
  ];

  if (!items.length) {
    list.innerHTML = '<li class="empty">لا شيء يحتاج مصالحة.</li>';
  } else {
    list.innerHTML = '';
    for (const item of items) {
      const node = document.createElement('li');
      const canReconcile = !item.retry;
      node.innerHTML = `
        <div class="head">
          <b>${escapeHtml(item.name)}</b>
          <span class="warn">${escapeHtml(item.state)}</span>
        </div>
        <div class="meta">${item.target === 'outbox' ? 'نية خارجية' : 'استدعاء أداة'} · ${escapeHtml(shortHash(item.id))}</div>
        <div class="row actions">
          ${
            canReconcile
              ? '<button type="button" data-outcome="applied">الأثر موجود</button>' +
                '<button type="button" class="danger" data-outcome="not_applied">لم يصل</button>'
              : '<button type="button" data-outcome="retry">إعادة محاولة بعد تأكيد عدم الوصول</button>'
          }
        </div>`;
      for (const button of node.querySelectorAll('button[data-outcome]')) {
        button.dataset.target = item.target;
        button.dataset.targetId = item.id;
        button.dataset.resume = item.retry ? '1' : '0';
      }
      list.append(node);
    }
  }

  const badge = $('reconcile-badge');
  const blocking = items.filter((item) => !item.retry).length;
  if (blocking) {
    badge.textContent = `${blocking} يحتاج قرارك`;
    badge.className = 'pill warn';
  } else if (items.length) {
    badge.textContent = 'إعادة محاولة متاحة';
    badge.className = 'pill idle';
  } else if (runStatus === 'needs_reconciliation') {
    badge.textContent = 'يحتاج مصالحة';
    badge.className = 'pill warn';
  } else {
    badge.textContent = '—';
    badge.className = 'pill idle';
  }
  const showFields = items.length > 0;
  $('reconcile-note-field').hidden = !showFields;
  $('reconcile-ref-field').hidden = !showFields;
}

function renderEvidence(evidence = [], chain, verification) {
  const list = $('evidence');
  if (!evidence.length) {
    list.innerHTML = '<li class="empty">لا أدلة مسجلة بعد.</li>';
  } else {
    list.innerHTML = '';
    for (const entry of evidence) {
      const item = document.createElement('li');
      const verdict = entry.verdict ? `<span class="pill verdict-${entry.verdict}">${entry.verdict}</span>` : '<span class="hash">—</span>';
      item.innerHTML = `
        <div class="head"><b>#${entry.seq} ${EVIDENCE_LABELS[entry.kind] || entry.kind}</b>${verdict}</div>
        <div class="meta hash">in:${shortHash(entry.inputHash)} · out:${shortHash(entry.outputHash)} · prev:${shortHash(entry.prevHash)}</div>`;
      list.append(item);
    }
  }
  const chainBadge = $('chain-badge');
  if (chain?.ok) {
    chainBadge.textContent = `سلسلة سليمة · ${chain.count} مدخل`;
    chainBadge.className = 'pill chain-ok';
  } else if (evidence.length) {
    chainBadge.textContent = chain?.reason ? `كسر: ${chain.reason}` : 'سلسلة غير سليمة';
    chainBadge.className = 'pill chain-bad';
  } else {
    chainBadge.textContent = '—';
    chainBadge.className = 'pill idle';
  }
  const badge = $('verification-badge');
  if (verification?.verdict) {
    badge.textContent = `تحقق: ${verification.verdict}`;
    badge.className = `pill verdict-${verification.verdict}`;
  } else {
    badge.textContent = 'بلا تحقق';
    badge.className = 'pill idle';
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function renderMemory(memory = { summaries: [], facts: [] }) {
  const summaries = Array.isArray(memory.summaries) ? memory.summaries : [];
  const facts = Array.isArray(memory.facts) ? memory.facts : [];
  const summaryList = $('memory-summaries');
  const factList = $('memory-facts');
  if (!summaryList || !factList) return;
  const deleteButton = (kind, id) =>
    `<button type="button" class="danger memory-delete" data-memory-kind="${kind}" data-memory-id="${escapeHtml(id)}" aria-label="حذف ${kind === 'summary' ? 'الملخص' : 'الحقيقة'}">حذف نهائي</button>`;
  summaryList.innerHTML = summaries.length
    ? summaries.map((item) => `<li data-memory-id="${escapeHtml(item.id)}">
        <p class="memory-text">${escapeHtml(item.summary)}</p>
        <div class="meta">المصدر: ${escapeHtml(String(item.sourceRunId || '—').slice(0, 12))} · ${escapeHtml(item.updatedAt || item.createdAt || '—')} ${deleteButton('summary', item.id)}</div>
      </li>`).join('')
    : '<li class="empty">لا ملخصات محفوظة.</li>';
  factList.innerHTML = facts.length
    ? facts.map((item) => `<li data-memory-id="${escapeHtml(item.id)}">
        <div class="head"><b>${escapeHtml(item.tag)}</b>${deleteButton('fact', item.id)}</div>
        <p class="memory-text">${escapeHtml(item.value)}</p>
        <div class="meta">المصدر: ${escapeHtml(String(item.sourceRunId || '—').slice(0, 12))} · ${escapeHtml(item.updatedAt || item.createdAt || '—')}</div>
      </li>`).join('')
    : '<li class="empty">لا حقائق محفوظة.</li>';
  if ($('memory-status')) $('memory-status').textContent = `${summaries.length} ملخص · ${facts.length} حقيقة`;
}

async function refreshMemory() {
  const epoch = ++memoryEpoch;
  if (!state.token) {
    renderMemory();
    return;
  }
  try {
    const result = await api('/api/agent/memory');
    if (epoch === memoryEpoch) renderMemory(result);
  } catch (error) {
    if (epoch !== memoryEpoch) return;
    if ([401, 403].includes(error.status)) renderMemory();
    if ($('memory-status')) $('memory-status').textContent = `تعذّر تحميل الذاكرة: ${error.message}`;
  }
}

async function deleteMemory(kind, id, button) {
  if (!kind || !id) return;
  button.disabled = true;
  try {
    await api('/api/agent/memory', { method: 'DELETE', body: JSON.stringify({ kind, id }) });
    setAuthStatus('حُذف العنصر نهائيًا وسُجل الحذف في الأدلة.', 'ok');
    await refreshMemory();
    await refreshDetail();
  } catch (error) {
    button.disabled = false;
    setAuthStatus(`تعذّر حذف الذاكرة: ${error.message}`, 'bad');
  }
}

function renderTruthPartition(truthPartition, toolRuns = []) {
  const root = $('truth-partition');
  const compBadge = $('comprehension-badge');
  if (!root) return;
  if (!truthPartition) {
    root.innerHTML = '<p class="empty">لا يظهر الفصل الثلاثي إلا بعد بدء تشغيل.</p>';
    if (compBadge) {
      compBadge.textContent = '—';
      compBadge.className = 'pill idle';
    }
    return;
  }
  const reportRun = [...(toolRuns || [])].reverse().find((tr) => tr.toolName === 'data.report' && tr.outcome);
  const explanation = reportRun?.outcome?.explanation || null;
  const gateStatus = explanation?.comprehension_gate?.status || truthPartition.verified?.comprehensionGateStatus || null;
  if (compBadge) {
    if (gateStatus === 'PASS') {
      compBadge.textContent = 'الفهم: PASS';
      compBadge.className = 'pill ok';
    } else if (gateStatus === 'BLOCK') {
      compBadge.textContent = 'الفهم: BLOCK';
      compBadge.className = 'pill bad';
    } else {
      compBadge.textContent = `المُتحقِّق: ${truthPartition.verified?.verdict || 'قيد الفحص'}`;
      compBadge.className = 'pill idle';
    }
  }
  const executedItems = [
    ...(truthPartition.executed?.toolRuns || []).map((t) => `أداة: ${escapeHtml(t.toolName)}`),
    ...(truthPartition.executed?.externalEffects || []).map(
      (e) => `أثر مرسل: ${escapeHtml(e.toolName)} (${escapeHtml(e.externalRef || '—')})`
    )
  ];
  const verifiedItems = (truthPartition.verified?.checks || []).map(
    (c) => `${escapeHtml(c.check)}: ${escapeHtml(c.detailAr)}`
  );
  const unverifiedItems = (truthPartition.unverified?.items || []).map((u) => escapeHtml(u.detailAr));
  const listHtml = (arr, emptyText) =>
    arr.length ? `<ul>${arr.map((i) => `<li>${i}</li>`).join('')}</ul>` : `<p class="hint">${escapeHtml(emptyText)}</p>`;

  root.innerHTML = `
    <dl>
      ${explanation?.simple_summary ? `<dt>الشرح المبسّط المدعوم بالأدلة</dt><dd>${escapeHtml(explanation.simple_summary)}</dd>` : ''}
      <dt>1. ما نُفّذ فعلًا (${truthPartition.executed?.toolRunsCount ?? 0} أداة / ${truthPartition.executed?.externalEffectsSentCount ?? 0} أثر خارجي)</dt>
      <dd>${listHtml(executedItems, 'لم يُنفَّذ أي استدعاء مؤكد بعد.')}</dd>
      <dt>2. ما تحقّق منه النظام (${verifiedItems.length} فحص مستقل)</dt>
      <dd>${listHtml(verifiedItems, 'لم تكتمل فحوص المُتحقِّق المستقل بعد.')}</dd>
      <dt>3. ما لم يثبت بعد (${unverifiedItems.length} بند غير متحقق)</dt>
      <dd>${listHtml(unverifiedItems, 'لا بنود معلقة أو غير محسومة.')}</dd>
    </dl>
  `;
}

function resetGovernancePanels() {
  renderContract(null);
  renderApprovals([], null);
  renderOutbox([]);
  renderReconcile(null, null);
  renderTruthPartition(null, []);
  renderEvidence([], null, null);
}

function handleEvent(event) {
  if (event.type === 'snapshot') {
    setRunState(event.run?.status);
    setUsage(event.run?.usage, event.run?.limits || null);
    renderContract(event.goalContract || null);
    renderApprovals(event.approvals || [], event.run?.status, event.plan || null, event.outbox || []);
    renderOutbox(event.outbox || []);
    renderReconcile(event, event.run?.status);
    renderTruthPartition(event.truthPartition || null, event.toolRuns || []);
    renderEvidence(event.evidence || [], event.evidenceChain || null, event.verification || null);
    state.steps = [];
    $('steps').innerHTML = '';
    (event.steps || []).forEach(rememberStep);
    if (state.steps.length) rerenderStepNodes();
    else $('steps').innerHTML = '<li class="empty">لم تبدأ أي خطوة بعد.</li>';
    state.plan = event.plan || null;
    state.approvals = event.approvals || [];
    state.verification = event.verification || null;
    renderTree(event.plan || null, event.run || null, { approvals: event.approvals || [], verification: event.verification || null });
    renderNow(event.now || null);
    return;
  }
  if (
    event.type === 'approval.requested' ||
    event.type === 'approval.decided' ||
    event.type === 'plan.edited' ||
    event.type === 'run.approved' ||
    event.type === 'verification' ||
    event.type === 'reconciliation.recorded' ||
    event.type === 'run.reconciled'
  ) {
    refreshDetail();
    return;
  }
  if (event.type === 'step') {
    if (event.status) setRunState(event.status);
    renderStep(event.step);
    applySettledStep(event.settledStep || null);
    if (event.usage) setUsage(event.usage, event.limits || null);
    if (event.now) renderNow(event.now);
    renderTree(state.plan || null, { status: state.runStatus }, { approvals: state.approvals || [], verification: state.verification || null });
    return;
  }
  if (event.type === 'run.started' || event.type === 'run.created' || event.type === 'run.cancel_requested') {
    setRunState(event.run?.status);
    setUsage(event.run?.usage, event.run?.limits || null);
    return;
  }
  if (event.type === 'run.finished') {
    setRunState(event.run?.status);
    setUsage(event.run?.usage, event.run?.limits || null);
    refreshMemory();
    if (event.run?.status === 'succeeded') {
      const delivery = $('delivery');
      const last = [...document.querySelectorAll('#steps .summary')].pop();
      delivery.hidden = false;
      delivery.textContent = last ? last.textContent : 'اكتملت المهمة.';
    }
    $('cancel').disabled = true;
    refreshDetail();
  }
}

async function streamRun(runId) {
  state.streaming?.abort();
  const controller = new AbortController();
  state.streaming = controller;
  try {
    const response = await fetch(`/api/agent/runs/${runId}/events`, {
      headers: { accept: 'text/event-stream', authorization: `Bearer ${state.token}` },
      signal: controller.signal
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (data) {
          try {
            handleEvent(JSON.parse(data));
          } catch {
            /* تجاهل إطارًا غير قابل للتحليل بدل تعطيل الواجهة */
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') setAuthStatus(`انقطع البث: ${error.message}`, 'bad');
  } finally {
    if (state.streaming === controller) state.streaming = null;
  }
}

async function refreshDetail() {
  if (!state.runId) return;
  try {
    const detail = await api(`/api/agent/runs/${state.runId}`);
    setRunState(detail.run?.status);
    setUsage(detail.run?.usage, detail.run?.limits || null);
    renderContract(detail.goalContract || null);
    renderApprovals(detail.approvals || [], detail.run?.status, detail.plan || null, detail.outbox || []);
    renderOutbox(detail.outbox || []);
    renderReconcile(detail, detail.run?.status);
    renderTruthPartition(detail.truthPartition || null, detail.toolRuns || []);
    renderEvidence(detail.evidence || [], detail.evidenceChain || null, detail.verification || null);
    // الخطوات في التفاصيل تحمل الأزمنة المُثبَتة (WP-1.1)؛ تحل محل ما وصل عبر البث.
    state.plan = detail.plan || null;
    state.approvals = detail.approvals || [];
    state.verification = detail.verification || null;
    if (Array.isArray(detail.steps) && detail.steps.length) {
      state.steps = [];
      detail.steps.forEach(rememberStep);
      rerenderStepNodes();
    }
    renderTree(detail.plan || null, detail.run || null, { approvals: detail.approvals || [], verification: detail.verification || null });
    renderNow(detail.now || null);
  } catch (error) {
    setAuthStatus(`تعذّر تحديث التفاصيل: ${error.message}`, 'bad');
  }
}

async function decide(decision) {
  if (!state.runId) return;
  const note = $('approval-note').value.trim() || null;
  let payload = undefined;
  if (decision === 'edited') {
    const rawPayload = $('approval-payload')?.value?.trim() || '{}';
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      setAuthStatus('حمولة JSON غير صالحة لتعديل الخطة.', 'bad');
      return;
    }
  }
  const buttons = [$('approve'), $('edit-plan'), $('reject')].filter(Boolean);
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await api(`/api/agent/runs/${state.runId}/approval`, {
      method: 'POST',
      body: JSON.stringify({ decision, note, ...(payload !== undefined ? { payload } : {}) })
    });
    setAuthStatus(
      decision === 'approved'
        ? 'سُجلت الموافقة واستؤنف التشغيل.'
        : decision === 'edited'
          ? 'حُفظ تعديل الخطة وأُعيد فحص السياسات؛ بانتظار الموافقة على النسخة المعدّلة.'
          : 'سُجل الرفض وأُوقف التشغيل دون أثر.',
      'ok'
    );
    await refreshDetail();
    if (result.resumed) {
      streamRun(state.runId);
    }
  } catch (error) {
    setAuthStatus(`تعذّر تسجيل القرار: ${error.message}${error.payload?.error ? ` (${error.payload.error})` : ''}`, 'bad');
    await refreshDetail();
  }
}

async function reconcile(target, targetId, outcome, resume) {
  if (!state.runId) return;
  const note = $('reconcile-note').value.trim() || null;
  const externalRef = $('reconcile-ref').value.trim() || null;
  const payload = {
    target,
    targetId,
    outcome: resume ? 'not_applied' : outcome,
    resume,
    ...(note ? { note } : {}),
    ...(externalRef ? { externalRef } : {})
  };
  try {
    const result = await api(`/api/agent/runs/${state.runId}/reconcile`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    $('reconcile-note').value = '';
    $('reconcile-ref').value = '';
    const remaining = (result.remaining?.toolRuns?.length || 0) + (result.remaining?.outbox?.length || 0);
    setAuthStatus(
      remaining
        ? `سُجل القرار؛ بقي ${remaining} بندًا غير محسوم قبل الاستئناف.`
        : result.reconciliation?.resumed
          ? 'سُجلت المصالحة واستؤنف التشغيل دون أي إرسال جديد.'
          : 'سُجلت المصالحة في سلسلة الأدلة.',
      'ok'
    );
    await refreshDetail();
    if (result.reconciliation?.resumed) streamRun(state.runId);
  } catch (error) {
    setAuthStatus(`تعذّر تسجيل المصالحة: ${error.message}${error.payload?.error ? ` (${error.payload.error})` : ''}`, 'bad');
    await refreshDetail();
  }
}

$('reconcile').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-outcome]');
  if (!button) return;
  const outcome = button.dataset.outcome;
  reconcile(button.dataset.target, button.dataset.targetId, outcome, button.dataset.resume === '1');
});

$('approve').addEventListener('click', () => decide('approved'));
if ($('edit-plan')) $('edit-plan').addEventListener('click', () => decide('edited'));
$('reject').addEventListener('click', () => decide('rejected'));
if ($('refresh-memory')) $('refresh-memory').addEventListener('click', refreshMemory);
if ($('memory-facts')) {
  $('memory-facts').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-memory-kind]');
    if (button) deleteMemory(button.dataset.memoryKind, button.dataset.memoryId, button);
  });
}
if ($('memory-summaries')) {
  $('memory-summaries').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-memory-kind]');
    if (button) deleteMemory(button.dataset.memoryKind, button.dataset.memoryId, button);
  });
}

async function refreshThreadsList() {
  const select = $('thread-select');
  if (!select || !state.token) return;
  try {
    const res = await api('/api/agent/threads');
    const threads = res.threads || [];
    if (!threads.length) {
      select.innerHTML = '<option value="">— لا خيوط محفوظة —</option>';
      select.disabled = true;
      if ($('delete-thread')) $('delete-thread').disabled = true;
      return;
    }
    select.innerHTML = threads
      .map(
        (t) =>
          `<option value="${escapeHtml(t.id)}"${t.id === state.threadId ? ' selected' : ''}>${escapeHtml(
            t.title || 'مهمة'
          )} (${escapeHtml(String(t.id).slice(0, 8))})</option>`
      )
      .join('');
    select.disabled = false;
    if (!state.threadId) {
      state.threadId = threads[0].id;
    }
    if ($('delete-thread')) $('delete-thread').disabled = !state.threadId;
  } catch {
    /* ignore when agent runtime is disabled */
  }
}

async function ensureThread() {
  if (state.threadId) return state.threadId;
  const threads = await api('/api/agent/threads');
  if (threads.threads?.length) {
    state.threadId = threads.threads[0].id;
    await refreshThreadsList();
    return state.threadId;
  }
  const created = await api('/api/agent/threads', {
    method: 'POST',
    body: JSON.stringify({ title: $('thread-title-input').value || 'مهمة جديدة' })
  });
  state.threadId = created.thread.id;
  await refreshThreadsList();
  return state.threadId;
}

async function connect() {
  state.token = $('token').value.trim();
  if (!state.token) return setAuthStatus('أدخل رمز الوصول أولًا.', 'bad');
  sessionStorage.setItem(TOKEN_KEY, state.token);
  setAuthStatus('جارٍ التحقق…');
  memoryEpoch += 1;
  renderMemory();
  if ($('memory-status')) $('memory-status').textContent = 'جارٍ تحميل الذاكرة…';
  try {
    const status = await api('/api/agent/status');
    renderStatus(status);
    setAuthStatus(status.enabled ? 'متصل — الوكيل جاهز' : 'متصل، لكن الوكيل متوقف', status.enabled ? 'ok' : 'bad');
    emptySteps();
    resetGovernancePanels();
    if (status.enabled) {
      await refreshThreadsList();
      await refreshMemory();
    } else {
      renderMemory();
    }
  } catch (error) {
    setAuthStatus(error.status === 401 ? 'رمز غير صحيح (401).' : `تعذّر الاتصال: ${error.message}`, 'bad');
  }
}

$('connect').addEventListener('click', connect);
$('token').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') connect();
});

$('new-thread').addEventListener('click', async () => {
  try {
    const created = await api('/api/agent/threads', {
      method: 'POST',
      body: JSON.stringify({ title: $('thread-title-input').value || 'مهمة جديدة' })
    });
    state.threadId = created.thread.id;
    state.runId = null;
    state.lastClientMessageId = null;
    emptySteps();
    resetGovernancePanels();
    $('delivery').hidden = true;
    setRunState('idle');
    $('cancel').disabled = true;
    await refreshThreadsList();
    setAuthStatus('خيط جديد جاهز.', 'ok');
  } catch (error) {
    setAuthStatus(`تعذّر إنشاء الخيط: ${error.message}`, 'bad');
  }
});

if ($('thread-select')) {
  $('thread-select').addEventListener('change', async (event) => {
    const nextThreadId = event.target.value;
    if (!nextThreadId) return;
    state.threadId = nextThreadId;
    if ($('delete-thread')) $('delete-thread').disabled = false;
    try {
      const detail = await api(`/api/agent/threads/${nextThreadId}`);
      $('thread-title-input').value = detail.thread?.title || 'مهمة';
      const latestRun = detail.runs?.[0] || null;
      if (latestRun) {
        state.runId = latestRun.id;
        await refreshDetail();
        setAuthStatus('تم استرجاع آخر تشغيل في الخيط.', 'ok');
      } else {
        state.runId = null;
        emptySteps();
        resetGovernancePanels();
        setRunState('idle');
      }
    } catch (error) {
      setAuthStatus(`تعذّر تحميل الخيط: ${error.message}`, 'bad');
    }
  });
}

if ($('delete-thread')) {
  $('delete-thread').addEventListener('click', async () => {
    if (!state.threadId) return;
    try {
      await api(`/api/agent/threads/${state.threadId}`, { method: 'DELETE' });
      state.threadId = null;
      state.runId = null;
      emptySteps();
      resetGovernancePanels();
      $('delivery').hidden = true;
      setRunState('idle');
      await refreshThreadsList();
      setAuthStatus('حُذف الخيط وجميع سجلاته التابعة.', 'ok');
    } catch (error) {
      setAuthStatus(`تعذّر حذف الخيط: ${error.message}`, 'bad');
    }
  });
}

if ($('export-audit')) {
  $('export-audit').addEventListener('click', async () => {
    if (!state.runId) return;
    try {
      const bundle = await api(`/api/agent/runs/${state.runId}/audit-bundle`);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `celia-audit-${state.runId}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setAuthStatus(`تم تصدير حزمة التدقيق الموقّعة (SHA-256: ${String(bundle.bundle_sha256).slice(0, 12)}…).`, 'ok');
    } catch (error) {
      setAuthStatus(`تعذّر تصدير حزمة التدقيق: ${error.message}`, 'bad');
    }
  });
}

$('run').addEventListener('click', async () => {
  const message = $('message').value.trim();
  if (!message) return setAuthStatus('اكتب وصف المهمة أولًا.', 'bad');
  const button = $('run');
  button.disabled = true;
  try {
    const threadId = await ensureThread();
    const clientMessageId = crypto.randomUUID();
    const started = await api(`/api/agent/threads/${threadId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ message, clientMessageId })
    });
    state.runId = started.runId;
    state.lastClientMessageId = clientMessageId;
    $('delivery').hidden = true;
    state.steps = [];
    state.plan = null;
    state.approvals = [];
    state.verification = null;
    $('steps').innerHTML = '';
    renderTree(null, null);
    renderNow(null);
    resetGovernancePanels();
    setRunState(started.status);
    setAuthStatus(started.duplicate ? 'طلب مكرر: أُعيد نفس التشغيل دون تكرار.' : 'بدأ التشغيل.', 'ok');
    await streamRun(started.runId);
  } catch (error) {
    setAuthStatus(`تعذّر التشغيل: ${error.message}${error.payload?.mode ? ` (${error.payload.mode})` : ''}`, 'bad');
  } finally {
    button.disabled = false;
  }
});

$('cancel').addEventListener('click', async () => {
  if (!state.runId) return;
  try {
    await api(`/api/agent/runs/${state.runId}/cancel`, { method: 'POST', body: '{}' });
    setAuthStatus('طُلب الإلغاء؛ يتوقف عند أقرب حد خطوة.', 'ok');
  } catch (error) {
    setAuthStatus(`تعذّر الإلغاء: ${error.message}`, 'bad');
  }
});

const STATIC_HOST =
  document.documentElement.dataset.celiaStatic === 'true' || /\.github\.io$/i.test(location.hostname);
if (STATIC_HOST) {
  // The Pages build is a static snapshot: it must say so instead of pretending to run a server.
  $('mode-badge').textContent = 'نسخة ثابتة — لا حلقة هنا';
  $('mode-badge').className = 'badge off';
  $('mode-note').textContent =
    'هذه الصفحة مبنية على GitHub Pages بلا خادم؛ حلقة الوكيل تحتاج خدمة Node مع MySQL (أو SQLite محليًا). راجع صفحة النشر لمسار التشغيل.';
  $('run').disabled = true;
  emptySteps();
  resetGovernancePanels();
} else if (state.token) {
  $('token').value = state.token;
  connect();
} else {
  emptySteps();
  $('mode-badge').textContent = 'أدخل الرمز لعرض الحالة';
  $('mode-badge').className = 'badge off';
}
