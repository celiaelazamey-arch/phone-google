/*
 * celia-cron-bridge — جسر CeliaOS نحو cron-job.org على Cloudflare Workers.
 *
 * حدود الأمان المعمارية:
 *  - السرّان CRONJOB_API_KEY و CELIA_ADMIN_TOKEN يُضبطان عبر `wrangler secret`
 *    ولا يوجدان في الكود ولا في GitHub Pages إطلاقًا.
 *  - المتصفح يتكلم مع الجسر بـ CELIA_ADMIN_TOKEN في ترويسة Authorization فقط.
 *  - الجسر يترجم إلى cron-job.org بمفتاحه الخاص، ويعقّم أخطاء المزوّد فلا تتسرب
 *    الترويسات أو المفاتيح إلى العميل.
 *
 * الملف ESM قياسي يعمل على Workers وفي اختبارات Node عبر createFetchHandler.
 */

export const UPSTREAM_DEFAULT = 'https://api.cron-job.org';
const MAX_BODY_BYTES = 8 * 1024;
const JOB_ID_RE = /^\d{1,12}$/;
const ALLOWED_JOB_FIELDS = ['url', 'title', 'enabled', 'saveResponses', 'requestMethod', 'schedule'];
const ALLOWED_SCHEDULE_FIELDS = ['timezone', 'expiresAt', 'hours', 'mdays', 'minutes', 'months', 'wdays'];
const SCHEDULE_ARRAYS = ['hours', 'mdays', 'minutes', 'months', 'wdays'];

export const BRIDGE_ENDPOINTS = Object.freeze([
  'GET /api/cron/health',
  'GET /api/cron/jobs',
  'POST /api/cron/jobs',
  'PATCH /api/cron/jobs/:jobId',
  'DELETE /api/cron/jobs/:jobId',
  'GET /api/cron/jobs/:jobId/history'
]);

function jsonResponse(body, status = 200, extraHeaders = {}) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-site',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'cache-control': 'no-store',
    ...extraHeaders
  };
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(code, message, status, extraHeaders = {}) {
  return jsonResponse({ error: { code, message } }, status, extraHeaders);
}

/* مقارنة بزمن ثابت قدر الإمكان دون الاعتماد على Node API غير المتاح في Workers. */
export function tokensMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  let diff = provided.length ^ expected.length;
  const length = Math.max(provided.length, expected.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (provided.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function extractBearer(request) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function corsHeaders(request, env) {
  const allowed = String(env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const origin = request.headers.get('origin');
  if (origin && allowed.includes(origin)) {
    return {
      'access-control-allow-origin': origin,
      vary: 'Origin',
      'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-max-age': '86400'
    };
  }
  return {};
}

function isIntegerArray(value, min, max) {
  return Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= min && item <= max) && value.length <= 64;
}

/* يبني حمولة آمنة بقائمة سماح فقط؛ يرفض الحقول المغلوطة بدل تمريرها صامتًا. */
export function sanitizeJobPayload(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'الحمولة يجب أن تكون كائن job واحدًا.' };
  }
  const out = {};
  for (const field of ALLOWED_JOB_FIELDS) {
    if (!(field in input)) continue;
    const value = input[field];
    if (field === 'url') {
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        return { error: 'حقل url غير صالح.' };
      }
      if (!['https:', 'http:'].includes(parsed.protocol)) return { error: 'يُقبل HTTP(S) فقط في url.' };
      out.url = parsed.href;
    } else if (field === 'title') {
      if (typeof value !== 'string' || value.length > 120) return { error: 'title نص حتى 120 حرفًا.' };
      out.title = value;
    } else if (field === 'enabled' || field === 'saveResponses') {
      if (typeof value !== 'boolean') return { error: `${field} يجب أن يكون boolean.` };
      out[field] = value;
    } else if (field === 'requestMethod') {
      if (!Number.isInteger(value) || value < 0 || value > 8) return { error: 'requestMethod رقم صحيح بين 0 و8.' };
      out.requestMethod = value;
    } else if (field === 'schedule') {
      if (!value || typeof value !== 'object') return { error: 'schedule كائن.' };
      const schedule = {};
      for (const sub of ALLOWED_SCHEDULE_FIELDS) {
        if (!(sub in value)) continue;
        if (sub === 'timezone') {
          if (typeof value[sub] !== 'string' || value[sub].length > 64) return { error: 'timezone نص حتى 64 حرفًا.' };
          schedule.timezone = value[sub];
        } else if (sub === 'expiresAt') {
          if (!Number.isInteger(value[sub]) || value[sub] < 0) return { error: 'expiresAt رقم صحيح غير سالب.' };
          schedule.expiresAt = value[sub];
        } else if (SCHEDULE_ARRAYS.includes(sub)) {
          const bound = sub === 'minutes' ? 59 : sub === 'hours' ? 23 : sub === 'mdays' ? 31 : sub === 'months' ? 12 : 6;
          if (!isIntegerArray(value[sub], -1, bound)) return { error: `${sub} مصفوفة أرقام في المدى الصحيح.` };
          schedule[sub] = value[sub];
        }
      }
      out.schedule = schedule;
    }
  }
  if (!partial && !out.url) return { error: 'حقل url إلزامي عند الإنشاء.' };
  if (partial && Object.keys(out).length === 0) return { error: 'لا يوجد حقل صالح للتعديل.' };
  return { value: out };
}

async function readJsonBody(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY_BYTES) return { error: { status: 413, code: 'payload_too_large', message: 'الحمولة أكبر من 8 كيلوبايت.' } };
  let raw;
  try {
    raw = await request.text();
  } catch {
    return { error: { status: 400, code: 'unreadable_body', message: 'تعذرت قراءة الحمولة.' } };
  }
  if (raw.length > MAX_BODY_BYTES) return { error: { status: 413, code: 'payload_too_large', message: 'الحمولة أكبر من 8 كيلوبايت.' } };
  if (!raw) return { error: { status: 400, code: 'empty_body', message: 'جسم الطلب فارغ.' } };
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { error: { status: 400, code: 'invalid_json', message: 'JSON غير صالح.' } };
  }
}

/* يصنع معالج الطلبات مع حقن fetch للاختبار، ولا يلمس أي حالة مشتركة. */
export function createFetchHandler(deps = {}) {
  const upstreamFetch = deps.fetch || globalThis.fetch.bind(globalThis);

  return async function handle(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/api/cron')) {
      return jsonResponse({ service: 'celia-cron-bridge', ok: true, endpoints: BRIDGE_ENDPOINTS }, 200, cors);
    }

    const match = /^\/api\/cron(?:\/(jobs)(?:\/(\d{1,12})(?:\/(history))?)?)?\/?$/.exec(url.pathname);
    if (!match) return errorResponse('not_found', 'لا يوجد مسار بهذا الاسم.', 404, cors);
    const [, jobsSegment, jobId, historySegment] = match;
    if (!jobsSegment) return errorResponse('not_found', 'لا يوجد مسار بهذا الاسم.', 404, cors);

    if (!tokensMatch(extractBearer(request), env.CELIA_ADMIN_TOKEN)) {
      return errorResponse('unauthorized', 'الرمز الإداري غائب أو غير صالح.', 401, { ...cors, 'www-authenticate': 'Bearer' });
    }
    if (!env.CRONJOB_API_KEY) {
      return errorResponse('upstream_not_configured', 'لم يُضبط CRONJOB_API_KEY على الجسر.', 503, cors);
    }

    const upstreamBase = (env.CRONJOB_API_BASE || UPSTREAM_DEFAULT).replace(/\/$/, '');
    const upstreamHeaders = {
      authorization: `Bearer ${env.CRONJOB_API_KEY}`,
      accept: 'application/json',
      'content-type': 'application/json'
    };

    const sendUpstream = async (path, options = {}) => {
      let upstream;
      try {
        upstream = await upstreamFetch(`${upstreamBase}${path}`, { ...options, headers: upstreamHeaders });
      } catch (error) {
        return errorResponse('upstream_unreachable', 'تعذر الوصول إلى cron-job.org. أعد المحاولة لاحقًا دون إرسال مكرر.', 502, cors);
      }
      const text = await upstream.text();
      let payload = {};
      if (text) {
        try { payload = JSON.parse(text); } catch { payload = {}; }
      }
      if (!upstream.ok) {
        return errorResponse(`upstream_${upstream.status}`, `رفض cron-job.org الطلب (${upstream.status}).`, upstream.status, cors);
      }
      return jsonResponse(payload, upstream.status, cors);
    };

    /* ─────────────── التوجيه: سبعة مسارات تعكس أدوات cron السبع ─────────────── */
    if (!jobId && request.method === 'GET') {
      return sendUpstream('/jobs');
    }
    if (!jobId && request.method === 'POST') {
      const body = await readJsonBody(request);
      if (body.error) return errorResponse(body.error.code, body.error.message, body.error.status, cors);
      const clean = sanitizeJobPayload(body.value?.job, { partial: false });
      if (clean.error) return errorResponse('invalid_job', clean.error, 422, cors);
      return sendUpstream('/jobs', { method: 'PUT', body: JSON.stringify({ job: clean.value }) });
    }
    if (jobId && !JOB_ID_RE.test(jobId)) {
      return errorResponse('invalid_job_id', 'معرّف الوظيفة أرقام فقط.', 400, cors);
    }
    if (jobId && historySegment && request.method === 'GET') {
      return sendUpstream(`/jobs/${jobId}/history`);
    }
    if (jobId && !historySegment && request.method === 'PATCH') {
      const body = await readJsonBody(request);
      if (body.error) return errorResponse(body.error.code, body.error.message, body.error.status, cors);
      const clean = sanitizeJobPayload(body.value?.job, { partial: true });
      if (clean.error) return errorResponse('invalid_job', clean.error, 422, cors);
      return sendUpstream(`/jobs/${jobId}`, { method: 'PATCH', body: JSON.stringify({ job: clean.value }) });
    }
    if (jobId && !historySegment && request.method === 'DELETE') {
      return sendUpstream(`/jobs/${jobId}`, { method: 'DELETE' });
    }
    return errorResponse('method_not_allowed', 'الطريقة غير مدعومة على هذا المسار.', 405, { ...cors, allow: 'GET,POST,PATCH,DELETE,OPTIONS' });
  };
}

export default {
  fetch(request, env) {
    const handler = createFetchHandler();
    return handler(request, env);
  }
};
