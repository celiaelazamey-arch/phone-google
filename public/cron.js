/* المهام المجدولة — لوحة قراءة مباشرة وكتابة محكومة عبر صندوق الصادر على الحافة (OPS-007 / DEC-042).
   الرمز وعنوان الحافة يبقيان في sessionStorage لهذا التبويب فقط. لا يوجد وضع تجريبي: إن غاب المفتاح أو D1 تُعرض الحالة كما هي. */
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'celia.cron.token';
const EDGE_KEY = 'celia.cron.edge';
const DEFAULT_EDGE = 'https://celia-phone-google.celiaelazamey.workers.dev';

const state = {
  edge: sessionStorage.getItem(EDGE_KEY) || DEFAULT_EDGE,
  token: sessionStorage.getItem(TOKEN_KEY) || '',
  configured: false,
  durable: false,
  jobs: []
};

const STATUS_LABEL = {
  pending_approval: 'بانتظار الموافقة',
  dispatching: 'جارٍ الإرسال',
  applied: 'مُطبَّقة',
  failed: 'رفضها المزوّد',
  unknown: 'مجهولة المصير — تحتاج تسوية',
  rejected: 'رفضها المالك',
  not_applied: 'لم تُطبَّق (تسوية)'
};
const ACTION_LABEL = { create: 'إنشاء', update: 'تعديل', delete: 'حذف' };

function setStatus(text, kind = '') {
  const el = $('auth-status');
  el.textContent = text;
  el.className = `status ${kind}`.trim();
}

function normalizeEdge(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${state.edge}${path}`, {
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

function describeError(error) {
  if (error.status === 401) return 'رمز غير صحيح (401).';
  if (error.status === 503 && error.message === 'cronjob_not_configured') return 'مفتاح cron-job.org غير مضبوط على الحافة (503).';
  if (error.status === 503 && error.message === 'd1_not_bound') return 'D1 غير مربوط — لا صندوق صادر بلا تخزين دائم (503).';
  if (error.status === 409) return `تعارض: ${error.message}${error.payload?.status ? ` (الحالة الآن: ${STATUS_LABEL[error.payload.status] || error.payload.status})` : ''}`;
  if (error instanceof TypeError) return 'تعذّر الوصول إلى الحافة (شبكة أو CORS).';
  return `${error.message}${error.status ? ` (${error.status})` : ''}`;
}

function fmtTime(seconds) {
  if (!seconds) return '—';
  return new Date(Number(seconds) * 1000).toLocaleString('ar-EG', { hour12: false });
}

function renderStatus(status) {
  state.configured = Boolean(status.configured);
  state.durable = Boolean(status.durable);
  const badge = $('cron-badge');
  $('fact-key').textContent = status.configured ? `مضبوط (${status.sourceEnv})` : 'غائب';
  $('fact-durable').textContent = status.durable ? 'مربوط' : 'غير مربوط';
  $('fact-reads').textContent = status.reads || '—';
  $('fact-writes').textContent = status.writes || '—';
  $('fact-pending').textContent = status.outbox && !status.outbox.error ? status.outbox.pending_approval : '—';
  $('fact-unknown').textContent = status.outbox && !status.outbox.error ? status.outbox.unknown : '—';
  if (status.configured && status.durable) {
    badge.textContent = `يعمل · ${status.mode}`;
    badge.className = 'badge ok';
    $('cron-note').textContent = `كل كتابة تمر عبر صندوق الصادر (${status.decision || 'DEC-042'}).`;
  } else {
    badge.textContent = status.configured ? 'قراءة فقط — D1 غير مربوط' : 'غير مُهيأ — المفتاح غائب';
    badge.className = 'badge off';
    $('cron-note').textContent = status.configured
      ? 'بلا D1 لا تُقبل نيّات كتابة؛ القراءة متاحة.'
      : 'اضبط CELIAOS_CRONJOB_ORG_API_KEY على العامل؛ حتى ذلك الحين لا قراءة ولا كتابة.';
  }
  $('reload-jobs').disabled = !status.configured;
  $('reload-intents').disabled = !status.durable;
  $('create-intent').disabled = !(status.configured && status.durable);
}

function statusCell(job) {
  if (!job.enabled) return ['متوقفة', 'off'];
  if (job.lastStatus === 1) return ['ناجحة ✓', 'ok'];
  if (job.lastStatus === 0 || job.lastStatus === undefined) return ['لم تُنفَّذ بعد', 'off'];
  return [`فشلت (${job.lastStatus})`, 'bad'];
}

function renderJobs(jobs) {
  state.jobs = jobs;
  const body = $('jobs-body');
  body.replaceChildren();
  if (!jobs.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.className = 'empty';
    cell.textContent = 'لا مهام في هذا الحساب.';
    row.append(cell);
    body.append(row);
    return;
  }
  for (const job of jobs) {
    const row = document.createElement('tr');
    const cells = [
      ['', String(job.jobId)],
      ['', job.title || '—'],
      ['url', `${job.url || '—'}${job.hasQuery ? '?…' : ''}`],
      statusCell(job).reverse(),
      ['', fmtTime(job.lastExecution)],
      ['', fmtTime(job.nextExecution)]
    ];
    for (const [cls, text] of cells) {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = text;
      row.append(td);
    }
    const actions = document.createElement('td');
    const wrap = document.createElement('div');
    wrap.className = 'row-actions';
    wrap.append(
      button('السجل', 'ghost', () => showHistory(job.jobId)),
      button(job.enabled ? 'نيّة تعطيل' : 'نيّة تفعيل', 'ghost', () => submitIntent({ action: 'update', jobId: job.jobId, job: { enabled: !job.enabled } }, `update-${job.jobId}-${job.enabled ? 'off' : 'on'}`)),
      button('نيّة حذف', 'ghost', () => submitIntent({ action: 'delete', jobId: job.jobId }, `delete-${job.jobId}`))
    );
    actions.append(wrap);
    row.append(actions);
    body.append(row);
  }
}

function button(label, cls, onClick) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = cls;
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}

async function loadJobs() {
  if (!state.configured) return;
  $('reload-jobs').disabled = true;
  try {
    const data = await api('/api/cron/jobs');
    renderJobs(data.jobs || []);
    if (data.someFailed) setStatus('متصل — بعض المهام فشلت في آخر تنفيذ.', 'bad');
  } catch (error) {
    setStatus(`تعذّر تحميل المهام: ${describeError(error)}`, 'bad');
  } finally {
    $('reload-jobs').disabled = false;
  }
}

async function showHistory(jobId) {
  const box = $('history');
  box.hidden = false;
  box.textContent = `جارٍ تحميل سجل المهمة ${jobId}…`;
  try {
    const data = await api(`/api/cron/jobs/${encodeURIComponent(jobId)}/history`);
    box.replaceChildren();
    const title = document.createElement('h3');
    title.textContent = `سجل المهمة ${jobId} — ${data.history.length} تنفيذ`;
    box.append(title);
    if (!data.history.length) return;
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const h of ['الوقت', 'الحالة', 'HTTP', 'المدة']) {
      const th = document.createElement('th');
      th.textContent = h;
      hr.append(th);
    }
    thead.append(hr);
    const tbody = document.createElement('tbody');
    for (const item of data.history.slice(0, 25)) {
      const tr = document.createElement('tr');
      for (const text of [fmtTime(item.date), item.status === 1 ? 'ناجحة' : `فشلت (${item.statusText || item.status})`, String(item.httpStatus ?? '—'), item.duration ? `${item.duration} ms` : '—']) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(thead, tbody);
    box.append(table);
  } catch (error) {
    box.textContent = `تعذّر السجل: ${describeError(error)}`;
  }
}

function idempotencyKey(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}-${stamp}-${crypto.randomUUID().slice(0, 8)}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

async function submitIntent(body, prefix) {
  if (!state.durable) return setStatus('D1 غير مربوط — لا يمكن تسجيل نيّة.', 'bad');
  try {
    const result = await api('/api/cron/intents', { method: 'POST', body: JSON.stringify(body), headers: { 'idempotency-key': idempotencyKey(prefix) } });
    setStatus(`سُجِّلت نيّة ${ACTION_LABEL[result.intent.action]} (${result.intent.id.slice(0, 8)}) — تنتظر موافقتك.`, 'ok');
    $('intent-filter').value = 'pending_approval';
    await Promise.all([loadIntents(), refreshStatus()]);
  } catch (error) {
    setStatus(`لم تُسجَّل النيّة: ${describeError(error)}`, 'bad');
  }
}

function scheduleEvery(minutes) {
  const every = Number(minutes);
  const list = every >= 60 ? [0] : Array.from({ length: Math.floor(60 / every) }, (_, i) => i * every);
  return { timezone: 'Africa/Cairo', expiresAt: 0, hours: [-1], mdays: [-1], minutes: list, months: [-1], wdays: [-1] };
}

async function createIntentFromForm() {
  const title = $('new-title').value.trim();
  const url = $('new-url').value.trim();
  const note = $('new-note').value.trim();
  if (!title || !url) {
    $('create-status').textContent = 'العنوان والرابط مطلوبان.';
    return;
  }
  if (!/^https:\/\//i.test(url)) {
    $('create-status').textContent = 'الرابط يجب أن يبدأ بـ https:// — الحافة ترفض غير ذلك (422).';
    return;
  }
  $('create-status').textContent = 'جارٍ التسجيل…';
  await submitIntent({ action: 'create', job: { title, url, enabled: true, saveResponses: false, requestMethod: 0, schedule: scheduleEvery($('new-every').value) }, note: note || undefined }, 'create');
  $('create-status').textContent = '';
}

function renderIntents(intents) {
  const list = $('intents');
  list.replaceChildren();
  if (!intents.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'لا نيّات في هذه الحالة.';
    list.append(li);
    return;
  }
  for (const intent of intents) {
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'head';
    const title = document.createElement('strong');
    title.textContent = `${ACTION_LABEL[intent.action] || intent.action}${intent.jobId ? ` · المهمة ${intent.jobId}` : ''}${intent.externalRef && intent.action === 'create' ? ` → ${intent.externalRef}` : ''}`;
    const stateEl = document.createElement('span');
    stateEl.className = `state ${intent.status}`;
    stateEl.textContent = STATUS_LABEL[intent.status] || intent.status;
    head.append(title, stateEl);
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(intent.payload, null, 2);
    const hash = document.createElement('div');
    hash.className = 'hash';
    hash.textContent = `sha256 ${intent.payloadHash}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [
      `أُنشئت ${new Date(intent.createdAt).toLocaleString('ar-EG', { hour12: false })}`,
      intent.note ? `ملاحظة: ${intent.note}` : null,
      intent.attempts ? `محاولات الإرسال: ${intent.attempts}` : null,
      intent.errorCode ? `الرمز: ${intent.errorCode}` : null,
      `المفتاح: ${intent.idempotencyKey}`
    ].filter(Boolean).join(' · ');
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (intent.status === 'pending_approval') {
      actions.append(
        button('وافق وأرسل مرة واحدة', 'primary', () => decide(intent, 'approve')),
        button('ارفض', 'ghost', () => decide(intent, 'reject'))
      );
    } else if (intent.status === 'unknown') {
      actions.append(
        button('تحقّقت: طُبِّقت فعلًا', 'ghost', () => reconcile(intent, 'applied')),
        button('تحقّقت: لم تُطبَّق', 'ghost', () => reconcile(intent, 'not_applied'))
      );
    }
    li.append(head, pre, hash, meta);
    if (actions.childElementCount) li.append(actions);
    list.append(li);
  }
}

async function loadIntents() {
  if (!state.durable) return renderIntents([]);
  const status = $('intent-filter').value;
  try {
    const data = await api(`/api/cron/intents${status ? `?status=${encodeURIComponent(status)}` : ''}`);
    renderIntents(data.intents || []);
  } catch (error) {
    setStatus(`تعذّر تحميل الصندوق: ${describeError(error)}`, 'bad');
  }
}

async function decide(intent, verb) {
  const question = verb === 'approve'
    ? `الموافقة ترسل «${ACTION_LABEL[intent.action]}» إلى cron-job.org مرة واحدة فقط، مربوطة بالبصمة ${intent.payloadHash.slice(0, 12)}…\nهل تتابع؟`
    : 'رفض النيّة نهائي. هل تتابع؟';
  if (!window.confirm(question)) return;
  try {
    const result = await api(`/api/cron/intents/${encodeURIComponent(intent.id)}/${verb}`, {
      method: 'POST',
      body: JSON.stringify(verb === 'approve' ? { expectedHash: intent.payloadHash } : {})
    });
    const final = result.intent.status;
    setStatus(`النتيجة: ${STATUS_LABEL[final] || final}${result.intent.errorCode ? ` — ${result.intent.errorCode}` : ''}`, final === 'applied' || final === 'rejected' ? 'ok' : 'bad');
    await Promise.all([loadIntents(), refreshStatus(), final === 'applied' ? loadJobs() : null]);
  } catch (error) {
    setStatus(`لم يكتمل: ${describeError(error)}`, 'bad');
    await loadIntents();
  }
}

async function reconcile(intent, outcome) {
  const externalRef = outcome === 'applied' && intent.action === 'create' ? window.prompt('رقم المهمة كما يظهر في لوحة cron-job.org (اختياري):', '') : null;
  try {
    const result = await api(`/api/cron/intents/${encodeURIComponent(intent.id)}/reconcile`, {
      method: 'POST',
      body: JSON.stringify({ outcome, externalRef: externalRef || undefined, note: 'تسوية يدوية من لوحة المالك' })
    });
    setStatus(`سُوِّيت النيّة: ${STATUS_LABEL[result.intent.status] || result.intent.status}`, 'ok');
    await Promise.all([loadIntents(), refreshStatus()]);
  } catch (error) {
    setStatus(`لم تُسوَّ: ${describeError(error)}`, 'bad');
  }
}

async function refreshStatus() {
  const status = await api('/api/cron/status');
  renderStatus(status);
  return status;
}

async function connect() {
  const edge = normalizeEdge($('edge').value);
  if (!edge) return setStatus('عنوان الحافة يجب أن يكون https.', 'bad');
  state.edge = edge;
  state.token = $('token').value.trim();
  if (!state.token) return setStatus('أدخل رمز المالك أولًا.', 'bad');
  sessionStorage.setItem(EDGE_KEY, state.edge);
  sessionStorage.setItem(TOKEN_KEY, state.token);
  setStatus('جارٍ التحقق…');
  try {
    const status = await refreshStatus();
    setStatus(status.configured ? 'متصل — المفتاح مضبوط على الحافة' : 'متصل، لكن مفتاح cron-job.org غائب', status.configured ? 'ok' : 'bad');
    await Promise.all([loadJobs(), loadIntents()]);
  } catch (error) {
    setStatus(`تعذّر الاتصال: ${describeError(error)}`, 'bad');
  }
}

$('edge').value = state.edge;
$('connect').addEventListener('click', connect);
$('token').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') connect();
});
$('reload-jobs').addEventListener('click', loadJobs);
$('reload-intents').addEventListener('click', loadIntents);
$('intent-filter').addEventListener('change', loadIntents);
$('create-intent').addEventListener('click', createIntentFromForm);

if (state.token) {
  $('token').value = state.token;
  connect();
}
