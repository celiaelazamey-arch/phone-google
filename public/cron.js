/*
 * سيليا — متحكّم لوحة المهام المجدولة.
 * كل المنطق الصافي في cron-lib.js؛ هذا الملف ربط DOM فقط، بلا منطق أعمال.
 * ثابت أمني: الرمز لا يظهر في DOM كنص مرئي ولا في أي رابط، ويُمسح من الجلسة عند القطع.
 */
import {
  CRON_TOOLS,
  REQUEST_METHODS,
  STORAGE_KEYS,
  buildSchedule,
  describeSchedule,
  validateBridgeUrl,
  validateJobInput,
  formatDateTime,
  createDemoStore,
  createBridgeClient
} from './cron-lib.js';

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const state = {
  mode: 'demo',
  client: createDemoStore(),
  jobs: [],
  editingId: null,
  pendingDeleteId: null,
  toastTimer: null
};

/* ───────────────────────── العرض ───────────────────────── */

function setMode(mode, detail = '') {
  state.mode = mode;
  const dot = $('cr-mode-dot');
  const label = $('cr-mode-label');
  const banner = $('cr-banner');
  banner.classList.remove('is-live', 'is-error');
  if (mode === 'live') {
    dot.classList.add('is-live');
    dot.classList.remove('is-error');
    label.textContent = 'متصل بالجسر';
    banner.classList.add('is-live');
    $('cr-banner-title').textContent = 'وضع حي — الطلبات تصل إلى cron-job.org عبر الجسر.';
    $('cr-banner-text').textContent = detail || 'كل عملية كتابة تمر بمصادقة الرمز الإداري وتأكيدك الصريح. الرمز محفوظ في هذه الجلسة فقط.';
  } else {
    dot.classList.remove('is-live', 'is-error');
    label.textContent = 'وضع المحاكاة';
    $('cr-banner-title').textContent = 'وضع المحاكاة — بلا اتصال حقيقي.';
    $('cr-banner-text').textContent = detail || 'البيانات تجريبية داخل ذاكرة المتصفح ولا تُرسل أي طلب. اربط جسر Cloudflare Worker لتعمل الأدوات على حساب cron-job.org الحقيقي.';
  }
}

function showToast(message, kind = 'ok') {
  const toast = $('cr-toast');
  toast.textContent = message;
  toast.className = `cr-toast is-${kind}`;
  toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { toast.hidden = true; }, 3800);
}

function renderStats() {
  const jobs = state.jobs;
  $('cr-stat-total').textContent = jobs.length;
  $('cr-stat-enabled').textContent = jobs.filter((job) => job.enabled).length;
  $('cr-stat-disabled').textContent = jobs.filter((job) => !job.enabled).length;
  if (state.mode === 'demo') {
    const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
    let failed = 0;
    for (const job of jobs) {
      const history = state.client.recordHistory(job.id);
      failed += history.items.filter((item) => !item.ok && item.date >= cutoff).length;
    }
    $('cr-stat-failed').textContent = failed;
  } else {
    $('cr-stat-failed').textContent = '—';
    $('cr-stat-failed').title = 'في الوضع الحي يُقرأ الفشل من سجل كل وظيفة على حدة';
  }
}

function renderTable() {
  const tbody = $('cr-tbody');
  const jobs = state.jobs;
  $('cr-empty').hidden = jobs.length !== 0;
  tbody.innerHTML = jobs.map((job) => `
    <tr data-job-id="${job.id}">
      <td>
        <span class="cr-job-title">${escapeHtml(job.title)}</span>
        <span class="cr-job-id">#${job.id}</span>
      </td>
      <td>
        <span class="cr-method" dir="ltr">${escapeHtml(job.method)}</span>
        <span class="cr-job-url" title="${escapeHtml(job.url)}">${escapeHtml(job.url)}</span>
      </td>
      <td><span class="cr-schedule-text">${escapeHtml(job.scheduleText)}</span></td>
      <td>
        <label class="cr-switch" title="${job.enabled ? 'تعطيل (cron.disable)' : 'تفعيل (cron.enable)'}">
          <input type="checkbox" class="cr-toggle" ${job.enabled ? 'checked' : ''} data-testid="toggle-${job.id}" aria-label="تبديل حالة الوظيفة ${escapeHtml(job.title)}" />
          <span class="cr-slider"></span>
        </label>
        <span class="cr-status-text ${job.enabled ? 'is-on' : ''}">${job.enabled ? 'مفعّلة' : 'معطّلة'}</span>
      </td>
      <td>
        <div class="cr-row-actions">
          <button type="button" class="cr-icon-btn" data-action="history" title="cron.history">◷ السجل</button>
          <button type="button" class="cr-icon-btn" data-action="edit" title="cron.update">✎ تعديل</button>
          <button type="button" class="cr-icon-btn cr-danger" data-action="delete" title="cron.delete">🗑 حذف<span class="cr-tag-sensitive">حسّاسة</span></button>
        </div>
      </td>
    </tr>`).join('');
}

async function refresh(message) {
  try {
    state.jobs = await state.client.list();
    renderStats();
    renderTable();
    $('cr-last-sync').textContent = `آخر مزامنة: ${new Date().toLocaleString('ar-EG')}`;
    if (message) showToast(message);
  } catch (error) {
    showToast(error.message || 'فشل تحديث القائمة', 'bad');
  }
}

/* ───────────────────────── ربط الجسر ───────────────────────── */

const connectDialog = $('cr-connect-dialog');

function openConnect() {
  $('cr-bridge-url').value = sessionStorage.getItem(STORAGE_KEYS.bridgeUrl) || '';
  $('cr-bridge-token').value = sessionStorage.getItem(STORAGE_KEYS.adminToken) || '';
  $('cr-bridge-url-error').textContent = '';
  $('cr-bridge-token-error').textContent = '';
  setConnectStatus('', '');
  connectDialog.showModal();
}

function setConnectStatus(text, kind) {
  const el = $('cr-connect-status');
  el.textContent = text;
  el.className = `cr-dialog-status ${kind ? `is-${kind}` : ''}`;
}

async function saveConnect() {
  const bridgeUrl = $('cr-bridge-url').value.trim();
  const adminToken = $('cr-bridge-token').value.trim();
  const urlCheck = validateBridgeUrl(bridgeUrl);
  $('cr-bridge-url-error').textContent = urlCheck.ok ? '' : urlCheck.reason;
  const tokenError = adminToken.length < 16 ? 'الرمز الإداري يجب أن يكون 16 حرفًا على الأقل.' : '';
  $('cr-bridge-token-error').textContent = tokenError;
  if (!urlCheck.ok || tokenError) return;

  setConnectStatus('جارٍ اختبار الجسر…', '');
  try {
    const client = createBridgeClient({ bridgeUrl: urlCheck.value, adminToken });
    await client.health();
    sessionStorage.setItem(STORAGE_KEYS.bridgeUrl, urlCheck.value);
    sessionStorage.setItem(STORAGE_KEYS.adminToken, adminToken);
    state.client = client;
    setMode('live');
    connectDialog.close();
    await refresh('تم الاتصال بالجسر بنجاح.');
  } catch (error) {
    setConnectStatus(error.message || 'فشل الاتصال', 'bad');
  }
}

function disconnect() {
  sessionStorage.removeItem(STORAGE_KEYS.bridgeUrl);
  sessionStorage.removeItem(STORAGE_KEYS.adminToken);
  $('cr-bridge-url').value = '';
  $('cr-bridge-token').value = '';
  state.client = createDemoStore();
  setMode('demo', 'تم مسح الرمز من هذه الجلسة والعودة إلى المحاكاة.');
  setConnectStatus('تم قطع الاتصال ومسح الرمز.', 'ok');
  refresh();
}

async function restoreSession() {
  const bridgeUrl = sessionStorage.getItem(STORAGE_KEYS.bridgeUrl);
  const adminToken = sessionStorage.getItem(STORAGE_KEYS.adminToken);
  if (!bridgeUrl || !adminToken) return;
  try {
    const client = createBridgeClient({ bridgeUrl, adminToken });
    await client.health();
    state.client = client;
    setMode('live');
  } catch (error) {
    setMode('demo', `تعذر استعادة الاتصال بالجسر (${error.message}). البيانات المعروضة تجريبية؛ الرمز محفوظ في الجلسة حتى تقطعه.`);
    $('cr-mode-dot').classList.add('is-error');
  }
}

/* ───────────────────────── نموذج الوظيفة ───────────────────────── */

const jobDialog = $('cr-job-dialog');

function fillMethodOptions() {
  $('cr-job-method').innerHTML = REQUEST_METHODS
    .map((item) => `<option value="${item.value}">${item.label}</option>`)
    .join('');
}

function readForm() {
  return {
    title: $('cr-job-name').value,
    url: $('cr-job-url').value,
    requestMethod: Number($('cr-job-method').value),
    kind: $('cr-job-kind').value,
    time: $('cr-job-time').value,
    minute: Number($('cr-job-minute').value),
    weekday: Number($('cr-job-weekday').value),
    monthDay: Number($('cr-job-monthday').value),
    timezone: $('cr-job-tz').value,
    enabled: $('cr-job-enabled').checked,
    saveResponses: $('cr-job-save').checked
  };
}

function updateFormVisibility() {
  const kind = $('cr-job-kind').value;
  $('cr-field-time').classList.toggle('cr-field-hidden', kind === 'every-minute' || kind === 'hourly');
  $('cr-field-minute').classList.toggle('cr-field-hidden', kind !== 'hourly');
  $('cr-field-weekday').classList.toggle('cr-field-hidden', kind !== 'weekly');
  $('cr-field-monthday').classList.toggle('cr-field-hidden', kind !== 'monthly');
  updateSchedulePreview();
}

function updateSchedulePreview() {
  try {
    const schedule = buildSchedule(readForm());
    $('cr-schedule-preview').textContent = `المعاينة: ${describeSchedule(schedule)}`;
  } catch (error) {
    $('cr-schedule-preview').textContent = `المعاينة: ${error.message}`;
  }
}

function openCreate() {
  state.editingId = null;
  $('cr-job-title').textContent = 'وظيفة مجدولة جديدة';
  $('cr-job-name').value = '';
  $('cr-job-url').value = '';
  $('cr-job-method').value = '0';
  $('cr-job-kind').value = 'daily';
  $('cr-job-time').value = '09:00';
  $('cr-job-minute').value = '0';
  $('cr-job-weekday').value = '5';
  $('cr-job-monthday').value = '1';
  $('cr-job-tz').value = 'Africa/Cairo';
  $('cr-job-enabled').checked = true;
  $('cr-job-save').checked = true;
  $('cr-job-name-error').textContent = '';
  $('cr-job-url-error').textContent = '';
  updateFormVisibility();
  jobDialog.showModal();
}

function openEdit(job) {
  state.editingId = job.id;
  const raw = job.raw;
  $('cr-job-title').textContent = `تعديل وظيفة #${job.id}`;
  $('cr-job-name').value = raw.title || '';
  $('cr-job-url').value = raw.url || '';
  $('cr-job-method').value = String(raw.requestMethod ?? 0);
  const schedule = raw.schedule || {};
  const tz = schedule.timezone || 'Africa/Cairo';
  if (![...$('cr-job-tz').options].some((option) => option.value === tz)) {
    $('cr-job-tz').insertAdjacentHTML('beforeend', `<option value="${escapeHtml(tz)}">${escapeHtml(tz)}</option>`);
  }
  $('cr-job-tz').value = tz;
  const kind = inferKind(schedule);
  $('cr-job-kind').value = kind.kind;
  $('cr-job-time').value = kind.time;
  $('cr-job-minute').value = String(kind.minute);
  $('cr-job-weekday').value = String(kind.weekday);
  $('cr-job-monthday').value = String(kind.monthDay);
  $('cr-job-enabled').checked = Boolean(raw.enabled);
  $('cr-job-save').checked = Boolean(raw.saveResponses);
  $('cr-job-name-error').textContent = '';
  $('cr-job-url-error').textContent = '';
  updateFormVisibility();
  jobDialog.showModal();
}

function inferKind(schedule) {
  const fallback = { kind: 'daily', time: '09:00', minute: 0, weekday: 5, monthDay: 1 };
  if (!schedule) return fallback;
  const every = (values) => !Array.isArray(values) || values.includes(-1);
  const hour = Array.isArray(schedule.hours) && schedule.hours[0] >= 0 ? schedule.hours[0] : 9;
  const minute = Array.isArray(schedule.minutes) && schedule.minutes[0] >= 0 ? schedule.minutes[0] : 0;
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (every(schedule.minutes) && every(schedule.hours)) return { ...fallback, kind: 'every-minute' };
  if (every(schedule.hours) && !every(schedule.minutes)) return { ...fallback, kind: 'hourly', minute };
  if (!every(schedule.wdays)) return { ...fallback, kind: 'weekly', time, weekday: schedule.wdays[0] };
  if (!every(schedule.mdays)) return { ...fallback, kind: 'monthly', time, monthDay: schedule.mdays[0] };
  return { ...fallback, kind: 'daily', time };
}

async function saveJob() {
  const form = readForm();
  const check = validateJobInput(form);
  $('cr-job-name-error').textContent = check.errors.title || '';
  $('cr-job-url-error').textContent = check.errors.url || '';
  if (!check.ok) { showToast('صحح الحقول المؤشر عليها أولًا.', 'bad'); return; }
  let schedule;
  try {
    schedule = buildSchedule(form);
  } catch (error) {
    showToast(error.message, 'bad');
    return;
  }
  const payload = {
    title: check.value.title,
    url: check.value.url,
    requestMethod: form.requestMethod,
    enabled: form.enabled,
    saveResponses: form.saveResponses,
    schedule
  };
  const saveButton = $('cr-btn-save-job');
  saveButton.disabled = true;
  try {
    if (state.editingId) {
      await state.client.update(state.editingId, payload);
      showToast(`تم حفظ التعديلات على الوظيفة #${state.editingId} (cron.update).`);
    } else {
      await state.client.create(payload);
      showToast('تم إنشاء الوظيفة الجديدة (cron.create).');
    }
    jobDialog.close();
    await refresh();
  } catch (error) {
    showToast(error.message || 'فشل الحفظ', 'bad');
  } finally {
    saveButton.disabled = false;
  }
}

/* ───────────────────────── السجل والحذف والتبديل ───────────────────────── */

const historyDialog = $('cr-history-dialog');
const deleteDialog = $('cr-delete-dialog');

async function openHistory(job) {
  $('cr-history-title').textContent = `سجل التنفيذ — ${job.title}`;
  $('cr-history-sub').textContent = `الوظيفة #${job.id} · آخر عمليات cron.history`;
  $('cr-history-body').innerHTML = '<tr><td colspan="4" class="cr-schedule-text">جارٍ التحميل…</td></tr>';
  historyDialog.showModal();
  try {
    const history = await state.client.recordHistory(job.id);
    $('cr-history-body').innerHTML = history.items.length ? history.items.map((item) => `
      <tr>
        <td>${escapeHtml(formatDateTime(item.planned || item.date))}</td>
        <td class="${item.ok ? 'cr-history-ok' : 'cr-history-bad'}">${escapeHtml(item.statusText)}</td>
        <td dir="ltr">${item.httpStatus ?? '—'}</td>
        <td dir="ltr">${item.durationMs} ms</td>
      </tr>`).join('') : '<tr><td colspan="4" class="cr-schedule-text">لا سجلات بعد.</td></tr>';
    $('cr-next-runs').textContent = history.predictions.length
      ? `التنبؤات القادمة: ${history.predictions.map((value) => formatDateTime(value)).join('، ')}`
      : 'لا توجد تنبؤات قادمة من المزوّد.';
  } catch (error) {
    $('cr-history-body').innerHTML = `<tr><td colspan="4" class="cr-history-bad">${escapeHtml(error.message)}</td></tr>`;
  }
}

function armDelete(job) {
  state.pendingDeleteId = job.id;
  $('cr-delete-target').textContent = `#${job.id} — ${job.title}`;
  const button = $('cr-btn-confirm-delete');
  button.classList.remove('is-armed');
  button.textContent = 'أفهم، احذف';
  deleteDialog.showModal();
}

async function confirmDelete() {
  const button = $('cr-btn-confirm-delete');
  if (!button.classList.contains('is-armed')) {
    button.classList.add('is-armed');
    button.textContent = 'اضغط مرة أخرى للتأكيد النهائي';
    return;
  }
  if (!state.pendingDeleteId) return;
  const id = state.pendingDeleteId;
  button.disabled = true;
  try {
    await state.client.remove(id);
    deleteDialog.close();
    showToast(`تم حذف الوظيفة #${id} (cron.delete).`, 'ok');
    await refresh();
  } catch (error) {
    showToast(error.message || 'فشل الحذف', 'bad');
  } finally {
    button.disabled = false;
    state.pendingDeleteId = null;
  }
}

async function onTableClick(event) {
  const actionButton = event.target.closest('button[data-action]');
  if (!actionButton) return;
  const row = event.target.closest('tr[data-job-id]');
  const job = state.jobs.find((item) => item.id === Number(row.dataset.jobId));
  if (!job) return;
  if (actionButton.dataset.action === 'history') return openHistory(job);
  if (actionButton.dataset.action === 'edit') return openEdit(job);
  if (actionButton.dataset.action === 'delete') return armDelete(job);
}

async function onToggle(event) {
  if (!event.target.classList.contains('cr-toggle')) return;
  const row = event.target.closest('tr[data-job-id]');
  const job = state.jobs.find((item) => item.id === Number(row.dataset.jobId));
  if (!job) return;
  const next = event.target.checked;
  try {
    await state.client.setEnabled(job.id, next);
    showToast(next ? `تم تفعيل «${job.title}» (cron.enable).` : `تم تعطيل «${job.title}» (cron.disable).`);
    await refresh();
  } catch (error) {
    event.target.checked = !next;
    showToast(error.message || 'فشل تبديل الحالة', 'bad');
  }
}

/* ───────────────────────── الربط والإقلاع ───────────────────────── */

function bindEvents() {
  $('cr-btn-connect').addEventListener('click', openConnect);
  $('cr-btn-disconnect').addEventListener('click', disconnect);
  $('cr-btn-save-connect').addEventListener('click', saveConnect);
  $('cr-btn-create').addEventListener('click', openCreate);
  $('cr-empty-create').addEventListener('click', openCreate);
  $('cr-btn-save-job').addEventListener('click', saveJob);
  $('cr-btn-confirm-delete').addEventListener('click', confirmDelete);
  $('cr-btn-refresh').addEventListener('click', () => refresh('تم تحديث القائمة.'));
  $('cr-tbody').addEventListener('click', onTableClick);
  $('cr-tbody').addEventListener('change', onToggle);

  for (const id of ['cr-job-kind', 'cr-job-time', 'cr-job-minute', 'cr-job-weekday', 'cr-job-monthday', 'cr-job-tz']) {
    $(id).addEventListener('input', updateSchedulePreview);
    $(id).addEventListener('change', updateFormVisibility);
  }
  document.querySelectorAll('dialog [data-close]').forEach((button) => {
    button.addEventListener('click', () => button.closest('dialog').close());
  });
  deleteDialog.addEventListener('close', () => {
    state.pendingDeleteId = null;
    const button = $('cr-btn-confirm-delete');
    button.classList.remove('is-armed');
    button.textContent = 'أفهم، احذف';
  });
}

fillMethodOptions();
bindEvents();
await restoreSession();
await refresh();

/* عدد الأدوات معرّف من المصدر الموثّق نفسه؛ لا نسخة ثابتة منفصلة. */
document.documentElement.dataset.cronTools = String(CRON_TOOLS.length);
/* علامة إقلاع للاختبارات: وجودها يثبت اكتمال تحميل الوحدة وتنفيذها. */
window.__CRON_BOOTED = true;
