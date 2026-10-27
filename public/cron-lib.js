/*
 * سيليا — منطق لوحة المهام المجدولة (CeliaOS × cron-job.org).
 *
 * ملف منطق صافٍ بلا DOM: يُستورد من cron.js في المتصفح ومن اختبارات Node.
 * الثابت المعماري: GitHub Pages ملفات ثابتة بلا أسرار. الرمز الإداري يُدخله
 * المالك في وقت التشغيل ويبقى في sessionStorage للتبويب فقط، ولا يُكتب في الكود.
 */

export const STORAGE_KEYS = Object.freeze({
  bridgeUrl: 'celia.cron.bridgeUrl',
  adminToken: 'celia.cron.adminToken',
  mode: 'celia.cron.mode'
});

export const BRIDGE_PATHS = Object.freeze({
  health: '/api/cron/health',
  jobs: '/api/cron/jobs'
});

/* الأدوات السبع الموثقة في معمارية CeliaOS × cron-job.org. */
export const CRON_TOOLS = Object.freeze([
  Object.freeze({ id: 'cron.list', label: 'عرض الوظائف الحالية', verb: 'GET', sensitive: false, mutating: false, icon: '▤' }),
  Object.freeze({ id: 'cron.create', label: 'إنشاء وظيفة جديدة', verb: 'POST', sensitive: true, mutating: true, icon: '＋' }),
  Object.freeze({ id: 'cron.update', label: 'تعديل رابط أو جدول', verb: 'PATCH', sensitive: true, mutating: true, icon: '✎' }),
  Object.freeze({ id: 'cron.enable', label: 'تفعيل الوظيفة', verb: 'PATCH', sensitive: false, mutating: true, icon: '▶' }),
  Object.freeze({ id: 'cron.disable', label: 'تعطيل الوظيفة', verb: 'PATCH', sensitive: false, mutating: true, icon: '⏸' }),
  Object.freeze({ id: 'cron.history', label: 'قراءة سجل التنفيذ', verb: 'GET', sensitive: false, mutating: false, icon: '◷' }),
  Object.freeze({ id: 'cron.delete', label: 'حذف الوظيفة', verb: 'DELETE', sensitive: true, mutating: true, icon: '🗑' })
]);

export const REQUEST_METHODS = Object.freeze([
  Object.freeze({ value: 0, label: 'GET' }),
  Object.freeze({ value: 1, label: 'POST' }),
  Object.freeze({ value: 2, label: 'PUT' }),
  Object.freeze({ value: 3, label: 'PATCH' }),
  Object.freeze({ value: 4, label: 'DELETE' })
]);

const WEEKDAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const EVERY = [-1];

function isEvery(values) {
  return !Array.isArray(values) || values.length === 0 || (values.length === 1 && values[0] === -1);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatClock(hour, minute) {
  return `${pad2(hour)}:${pad2(minute)}`;
}

/* وصف عربي مقروء لجداول cron-job.org: { timezone, hours, minutes, mdays, months, wdays }. */
export function describeSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return 'جدول غير معروف';
  const { hours, minutes, mdays, months, wdays } = schedule;
  const timeNote = schedule.timezone ? ` (${schedule.timezone})` : '';

  if (isEvery(minutes) && isEvery(hours)) return `كل دقيقة${timeNote}`;
  if (isEvery(hours) && !isEvery(minutes)) {
    return `كل ساعة عند الدقيقة ${minutes.map(pad2).join('، ')}${timeNote}`;
  }
  const times = (isEvery(hours) ? Array.from({ length: 24 }, (_, h) => h) : hours)
    .flatMap((hour) => (isEvery(minutes) ? [formatClock(hour, 0)] : minutes.map((minute) => formatClock(hour, minute))));

  if (!isEvery(wdays)) {
    const days = wdays.map((day) => WEEKDAYS_AR[day] ?? `يوم ${day}`).join('، ');
    return `أيام ${days} الساعة ${times.join('، ')}${timeNote}`;
  }
  if (!isEvery(mdays)) {
    return `أيام ${mdays.join('، ')} من كل شهر الساعة ${times.join('، ')}${timeNote}`;
  }
  let prefix = 'يوميًا';
  if (!isEvery(months)) prefix = 'خلال الأشهر المحددة، يوميًا';
  return `${prefix} الساعة ${times.join('، ')}${timeNote}`;
}

/* يحوّل نموذج اللوحة إلى هيكل جدول cron-job.org (مصفوفات، -1 تعني «كل»). */
export function buildSchedule(input) {
  const timezone = input?.timezone || 'Africa/Cairo';
  const schedule = { timezone, expiresAt: 0, hours: EVERY, mdays: EVERY, minutes: EVERY, months: EVERY, wdays: EVERY };
  const kind = input?.kind || 'daily';
  const time = String(input?.time || '09:00');
  const [hourRaw, minuteRaw] = time.split(':');
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);

  if (kind === 'every-minute') {
    return schedule;
  }
  if (kind === 'hourly') {
    const everyMinute = Number.isInteger(input.minute) ? input.minute : 0;
    schedule.minutes = [everyMinute];
    return schedule;
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error('صيغة الوقت غير صالحة');
  }
  schedule.hours = [hour];
  schedule.minutes = [minute];
  if (kind === 'weekly') {
    const weekday = Number(input.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('اختر يوم الأسبوع');
    schedule.wdays = [weekday];
  } else if (kind === 'monthly') {
    const monthDay = Number(input.monthDay);
    if (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31) throw new Error('اختر يوم الشهر');
    schedule.mdays = [monthDay];
  }
  return schedule;
}

export function methodLabel(methodValue) {
  return REQUEST_METHODS.find((item) => item.value === methodValue)?.label || 'GET';
}

/* نموذج عرض موحّد من وظيفة cron-job.org الخام. */
export function normalizeJob(raw) {
  const schedule = raw?.schedule || {};
  return Object.freeze({
    id: raw.jobId,
    title: raw.title || `وظيفة ${raw.jobId}`,
    url: raw.url || '',
    enabled: Boolean(raw.enabled),
    saveResponses: Boolean(raw.saveResponses),
    method: methodLabel(raw.requestMethod),
    timezone: schedule.timezone || '—',
    scheduleText: describeSchedule(schedule),
    schedule,
    raw
  });
}

export function normalizeHistory(payload) {
  const history = Array.isArray(payload?.history) ? payload.history : [];
  const predictions = Array.isArray(payload?.predictions) ? payload.predictions : [];
  return Object.freeze({
    items: history.map((item) => Object.freeze({
      identifier: item.identifier,
      date: Number(item.date) || 0,
      planned: Number(item.datePlanned) || 0,
      httpStatus: item.httpStatus ?? null,
      statusText: item.statusText || (item.httpStatus >= 200 && item.httpStatus < 300 ? 'OK' : 'FAILED'),
      durationMs: Number(item.duration) || 0,
      ok: item.httpStatus >= 200 && item.httpStatus < 300
    })),
    predictions: predictions.map((value) => Number(value) || 0).filter(Boolean)
  });
}

/* رابط الجسر: HTTPS إلزامي، مع استثناء localhost لتطوير wrangler محليًا فقط. */
export function validateBridgeUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    return { ok: false, reason: 'رابط غير صالح. مثال: https://celia-cron-bridge.<حساب>.workers.dev' };
  }
  const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(isLocalhost && url.protocol === 'http:')) {
    return { ok: false, reason: 'يلزم HTTPS لرابط الجسر. استثناء localhost مسموح للتطوير المحلي فقط.' };
  }
  if (url.search || url.hash) {
    return { ok: false, reason: 'الرابط يجب أن يكون عنوان الجذر فقط، بلا استعلام أو جزء #.' };
  }
  if (!isLocalhost && !url.hostname.includes('.')) {
    return { ok: false, reason: 'اسم مضيف غير مكتمل.' };
  }
  return { ok: true, value: url.origin };
}

export function validateJobInput(input) {
  const errors = {};
  const title = String(input?.title ?? '').trim();
  const url = String(input?.url ?? '').trim();
  if (!title) errors.title = 'العنوان مطلوب.';
  else if (title.length > 120) errors.title = 'الحد الأقصى للعنوان 120 حرفًا.';
  if (!url) errors.url = 'رابط الويب هوك مطلوب.';
  else {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      errors.url = 'رابط غير صالح.';
    }
    if (parsed && parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      errors.url = 'يُقبل HTTP(S) فقط.';
    }
  }
  const allowedKinds = new Set(['every-minute', 'hourly', 'daily', 'weekly', 'monthly']);
  if (!allowedKinds.has(input?.kind)) errors.kind = 'نوع الجدول غير معروف.';
  return { ok: Object.keys(errors).length === 0, errors, value: { title, url, kind: input.kind } };
}

/* ترجمة أخطاء الجسر إلى رسالة عربية صادقة بلا كشف أي رمز. */
export function classifyBridgeError(status, payload) {
  if (status === 401) return 'الرمز الإداري مرفوض أو غائب. تحقق من CELIA_ADMIN_TOKEN في الجسر.';
  if (status === 403) return 'الجسر رفض الطلب: السياسة أو صلاحيات الرمز لا تسمح بهذه العملية.';
  if (status === 404) return 'الوظيفة أو المسار غير موجود على الجسر.';
  if (status === 405) return 'الجسر لا يسمج بهذه الطريقة على هذا المسار.';
  if (status === 409) return 'تعارض في الحالة على الجسر. حدّث القائمة ثم أعد المحاولة.';
  if (status === 413) return 'الحمولة أكبر من حد الجسر.';
  if (status === 422) return 'بيانات الوظيفة غير صالحة حسب الجسر.';
  if (status === 429) return 'تجاوزت معدل الاستدعاءات (حد cron-job.org 5 طلبات/ثانية). انتظر قليلًا.';
  if (status >= 500 && status < 600) return 'خطأ من الجسر أو من cron-job.org. لا تُعد الإرسال تلقائيًا؛ راجع السجل.';
  const upstream = payload?.error?.message;
  return upstream ? `رفض الجسر الطلب: ${String(upstream).slice(0, 160)}` : `فشل الطلب برمز ${status || 'شبكة'}."`;
}

export function formatDateTime(unixSeconds) {
  if (!unixSeconds) return '—';
  try {
    return new Intl.DateTimeFormat('ar-EG', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Africa/Cairo'
    }).format(new Date(unixSeconds * 1000));
  } catch {
    return new Date(unixSeconds * 1000).toISOString();
  }
}

/* ───────────────────────── متجر المحاكاة ───────────────────────── */
/* بيانات حتمية داخل الذاكرة للوضع الثابت على Pages: لا شبكة ولا أسرار. */

function seedJobs(nowSec) {
  return [
    {
      jobId: 9001,
      title: 'فحص صحة الخادم اليومي',
      url: 'https://celia.example/health',
      enabled: true,
      saveResponses: true,
      requestMethod: 0,
      schedule: { timezone: 'Africa/Cairo', expiresAt: 0, hours: [8], mdays: [-1], minutes: [0], months: [-1], wdays: [-1] }
    },
    {
      jobId: 9002,
      title: 'تذكير تقرير العملاء',
      url: 'https://celia.example/webhooks/reminder',
      enabled: true,
      saveResponses: true,
      requestMethod: 1,
      schedule: { timezone: 'Africa/Cairo', expiresAt: 0, hours: [-1], mdays: [-1], minutes: [30], months: [-1], wdays: [-1] }
    },
    {
      jobId: 9003,
      title: 'نسخة Sheets الأسبوعية',
      url: 'https://celia.example/webhooks/backup-sheet',
      enabled: false,
      saveResponses: false,
      requestMethod: 1,
      schedule: { timezone: 'Africa/Cairo', expiresAt: 0, hours: [23], mdays: [-1], minutes: [0], months: [-1], wdays: [5] }
    },
    {
      jobId: 9004,
      title: 'مراقبة شهادة HTTPS',
      url: 'https://celia.example/webhooks/tls-watch',
      enabled: true,
      saveResponses: true,
      requestMethod: 0,
      schedule: { timezone: 'Africa/Cairo', expiresAt: 0, hours: [10, 16], mdays: [-1], minutes: [15], months: [-1], wdays: [-1] }
    }
  ].map((job, index) => ({ job, seed: index, nowSec }));
}

function seedHistory(nowSec) {
  const base = nowSec - 60 * 60;
  return new Map([
    [9001, [
      { identifier: '9001-a', date: base, datePlanned: base - 12, httpStatus: 200, statusText: 'OK', duration: 231 },
      { identifier: '9001-b', date: base - 86400, datePlanned: base - 86400 - 9, httpStatus: 200, statusText: 'OK', duration: 198 }
    ]],
    [9002, [
      { identifier: '9002-a', date: base - 3600, datePlanned: base - 3600, httpStatus: 200, statusText: 'OK', duration: 412 },
      { identifier: '9002-b', date: base - 7200, datePlanned: base - 7200, httpStatus: 500, statusText: 'FAILED', duration: 5021 }
    ]],
    [9003, [
      { identifier: '9003-a', date: base - 90000, datePlanned: base - 90000, httpStatus: 200, statusText: 'OK', duration: 305 }
    ]],
    [9004, [
      { identifier: '9004-a', date: base - 1800, datePlanned: base - 1800, httpStatus: 200, statusText: 'OK', duration: 277 }
    ]]
  ]);
}

export function createDemoStore(nowMs = Date.now()) {
  const nowSec = Math.floor(nowMs / 1000);
  let jobs = seedJobs(nowSec).map((entry) => entry.job);
  const history = seedHistory(nowSec);
  let sequence = 9100;

  return Object.freeze({
    mode: 'demo',
    list() {
      return jobs.map(normalizeJob);
    },
    create(input) {
      const check = validateJobInput(input);
      if (!check.ok) {
        const error = new Error('بيانات غير صالحة');
        error.details = check.errors;
        throw error;
      }
      const jobId = sequence += 1;
      const job = {
        jobId,
        title: check.value.title,
        url: check.value.url,
        enabled: input.enabled !== false,
        saveResponses: Boolean(input.saveResponses),
        requestMethod: Number(input.requestMethod) || 0,
        schedule: buildSchedule(input)
      };
      jobs = [...jobs, job];
      history.set(jobId, []);
      return normalizeJob(job);
    },
    update(jobId, patch) {
      const index = jobs.findIndex((job) => job.jobId === Number(jobId));
      if (index === -1) throw new Error('الوظيفة غير موجودة');
      const current = jobs[index];
      const next = { ...current, ...patch, jobId: current.jobId };
      if (patch?.schedule) next.schedule = { ...current.schedule, ...patch.schedule };
      jobs = jobs.map((job, i) => (i === index ? next : job));
      return normalizeJob(next);
    },
    setEnabled(jobId, enabled) {
      return this.update(jobId, { enabled: Boolean(enabled) });
    },
    remove(jobId) {
      const id = Number(jobId);
      if (!jobs.some((job) => job.jobId === id)) throw new Error('الوظيفة غير موجودة');
      jobs = jobs.filter((job) => job.jobId !== id);
      history.delete(id);
    },
    recordHistory(jobId) {
      return normalizeHistory({ history: history.get(Number(jobId)) || [], predictions: [] });
    }
  });
}

/* عميل الجسر الحي: كل الاستدعاءات تحمل الرمز في الترويسة فقط، ولا يُوضع في رابط إطلاقًا. */
export function createBridgeClient({ bridgeUrl, adminToken, fetchImpl = fetch }) {
  const urlCheck = validateBridgeUrl(bridgeUrl);
  if (!urlCheck.ok) throw new Error(urlCheck.reason);
  if (!adminToken || typeof adminToken !== 'string' || adminToken.trim().length < 16) {
    throw new Error('الرمز الإداري غائب أو أقصر من 16 حرفًا.');
  }
  const base = urlCheck.value;

  async function call(path, options = {}) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        ...options,
        headers: {
          accept: 'application/json',
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          authorization: `Bearer ${adminToken.trim()}`,
          ...(options.headers || {})
        }
      });
    } catch (error) {
      const wrapped = new Error(`تعذر الوصول إلى الجسر: ${error?.message || 'خطأ شبكة'}`);
      wrapped.network = true;
      throw wrapped;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(classifyBridgeError(response.status, payload));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  return Object.freeze({
    mode: 'live',
    async health() {
      return call(BRIDGE_PATHS.health);
    },
    async list() {
      const payload = await call(BRIDGE_PATHS.jobs);
      return (payload.jobs || []).map(normalizeJob);
    },
    async create(job) {
      const payload = await call(BRIDGE_PATHS.jobs, { method: 'POST', body: JSON.stringify({ job }) });
      return payload.job ? normalizeJob(payload.job) : null;
    },
    async update(jobId, patch) {
      await call(`${BRIDGE_PATHS.jobs}/${encodeURIComponent(jobId)}`, { method: 'PATCH', body: JSON.stringify({ job: patch }) });
    },
    async setEnabled(jobId, enabled) {
      await call(`${BRIDGE_PATHS.jobs}/${encodeURIComponent(jobId)}`, { method: 'PATCH', body: JSON.stringify({ job: { enabled } }) });
    },
    async remove(jobId) {
      await call(`${BRIDGE_PATHS.jobs}/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
    },
    async recordHistory(jobId) {
      const payload = await call(`${BRIDGE_PATHS.jobs}/${encodeURIComponent(jobId)}/history`);
      return normalizeHistory(payload);
    }
  });
}
