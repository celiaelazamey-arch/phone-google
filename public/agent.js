/* مساحة الوكيل — M1. الرمز يبقى في sessionStorage لهذه التبويبة فقط. */
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'celia.agent.token';
let state = {
  token: sessionStorage.getItem(TOKEN_KEY) || '',
  threadId: null,
  runId: null,
  lastClientMessageId: null,
  streaming: null
};

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
}

function setUsage(usage = {}) {
  $('usage-steps').textContent = usage.steps ?? 0;
  $('usage-cost').textContent = usage.costMicros ?? 0;
  $('usage-tokens').textContent = usage.tokens ?? 0;
}

function renderStep(step) {
  const list = $('steps');
  list.querySelector('.empty')?.remove();
  const item = document.createElement('li');
  item.dataset.index = String(step.index);
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
  const existing = list.querySelector(`[data-index="${step.index}"]`);
  if (existing) existing.replaceWith(item);
  else list.append(item);
  item.scrollIntoView({ block: 'nearest' });
}

function emptySteps() {
  $('steps').innerHTML = '<li class="empty">لم تبدأ أي خطوة بعد.</li>';
}

const DECISION_LABELS = {
  pending: ['بانتظار قرار المالك', 'decision-pending'],
  approved: ['موافقة مسجلة', 'decision-approved'],
  rejected: ['مرفوضة', 'decision-rejected']
};

const EVIDENCE_LABELS = {
  goal_contract: 'عقد الهدف',
  tool_call: 'استدعاء أداة',
  tool_call_reconciled: 'استدعاء مُصالح',
  approval: 'قرار موافقة',
  verification: 'حكم تحقق',
  delivery: 'تسليم'
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

function renderApprovals(approvals = [], runStatus) {
  const list = $('approvals');
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
  $('approve').disabled = !canDecide;
  $('reject').disabled = !canDecide;
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

function resetGovernancePanels() {
  renderContract(null);
  renderApprovals([], null);
  renderEvidence([], null, null);
}

function handleEvent(event) {
  if (event.type === 'snapshot') {
    setRunState(event.run?.status);
    setUsage(event.run?.usage);
    renderContract(event.goalContract || null);
    renderApprovals(event.approvals || [], event.run?.status);
    renderEvidence(event.evidence || [], event.evidenceChain || null, event.verification || null);
    $('steps').innerHTML = '';
    (event.steps || []).forEach(renderStep);
    if (!(event.steps || []).length) emptySteps();
    return;
  }
  if (event.type === 'approval.requested' || event.type === 'approval.decided' || event.type === 'verification') {
    refreshDetail();
    return;
  }
  if (event.type === 'step') {
    renderStep(event.step);
    return;
  }
  if (event.type === 'run.started' || event.type === 'run.created' || event.type === 'run.cancel_requested') {
    setRunState(event.run?.status);
    setUsage(event.run?.usage);
    return;
  }
  if (event.type === 'run.finished') {
    setRunState(event.run?.status);
    setUsage(event.run?.usage);
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
    setUsage(detail.run?.usage);
    renderContract(detail.goalContract || null);
    renderApprovals(detail.approvals || [], detail.run?.status);
    renderEvidence(detail.evidence || [], detail.evidenceChain || null, detail.verification || null);
  } catch (error) {
    setAuthStatus(`تعذّر تحديث التفاصيل: ${error.message}`, 'bad');
  }
}

async function decide(decision) {
  if (!state.runId) return;
  const note = $('approval-note').value.trim() || null;
  const buttons = [$('approve'), $('reject')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await api(`/api/agent/runs/${state.runId}/approval`, {
      method: 'POST',
      body: JSON.stringify({ decision, note })
    });
    setAuthStatus(decision === 'approved' ? 'سُجلت الموافقة واستؤنف التشغيل.' : 'سُجل الرفض وأُوقف التشغيل دون أثر.', 'ok');
    await refreshDetail();
    if (result.resumed) {
      streamRun(state.runId);
    }
  } catch (error) {
    setAuthStatus(`تعذّر تسجيل القرار: ${error.message}${error.payload?.error ? ` (${error.payload.error})` : ''}`, 'bad');
    await refreshDetail();
  }
}

$('approve').addEventListener('click', () => decide('approved'));
$('reject').addEventListener('click', () => decide('rejected'));

async function ensureThread() {
  if (state.threadId) return state.threadId;
  const threads = await api('/api/agent/threads');
  if (threads.threads?.length) {
    state.threadId = threads.threads[0].id;
    return state.threadId;
  }
  const created = await api('/api/agent/threads', {
    method: 'POST',
    body: JSON.stringify({ title: $('thread-title-input').value || 'مهمة جديدة' })
  });
  state.threadId = created.thread.id;
  return state.threadId;
}

async function connect() {
  state.token = $('token').value.trim();
  if (!state.token) return setAuthStatus('أدخل رمز الوصول أولًا.', 'bad');
  sessionStorage.setItem(TOKEN_KEY, state.token);
  setAuthStatus('جارٍ التحقق…');
  try {
    const status = await api('/api/agent/status');
    renderStatus(status);
    setAuthStatus(status.enabled ? 'متصل — الوكيل جاهز' : 'متصل، لكن الوكيل متوقف', status.enabled ? 'ok' : 'bad');
    emptySteps();
    resetGovernancePanels();
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
    setAuthStatus('خيط جديد جاهز.', 'ok');
  } catch (error) {
    setAuthStatus(`تعذّر إنشاء الخيط: ${error.message}`, 'bad');
  }
});

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
    $('steps').innerHTML = '';
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

const STATIC_HOST = /\.github\.io$/i.test(location.hostname);
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
  api('/api/agent/status')
    .then(renderStatus)
    .catch(() => {
      $('mode-badge').textContent = 'أدخل الرمز لعرض الحالة';
      $('mode-badge').className = 'badge off';
    });
}
