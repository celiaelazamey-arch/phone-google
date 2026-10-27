import test from 'node:test';
import assert from 'node:assert/strict';
import { createFetchHandler, tokensMatch, sanitizeJobPayload, BRIDGE_ENDPOINTS } from '../workers/celia-cron-bridge/worker.js';

const ADMIN_TOKEN = 'a'.repeat(32);
const UPSTREAM_KEY = 'upstream-cronjob-secret';
const ORIGIN = 'https://celiaelazamey-arch.github.io';

function makeEnv(overrides = {}) {
  return {
    CELIA_ADMIN_TOKEN: ADMIN_TOKEN,
    CRONJOB_API_KEY: UPSTREAM_KEY,
    ALLOWED_ORIGIN: ORIGIN,
    ...overrides
  };
}

function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return handler({ url, options });
  };
  return { fetchImpl, calls };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function callWorker(handle, path, options = {}, env = makeEnv()) {
  const request = new Request(`https://bridge.example${path}`, {
    method: options.method || 'GET',
    headers: {
      ...(options.token === undefined ? { authorization: `Bearer ${ADMIN_TOKEN}` } : options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.origin !== undefined ? { origin: options.origin } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    },
    body: options.body
  });
  const response = await handle(request, env);
  return { response, body: await response.json().catch(() => null) };
}

test('الهوية الجذرية بلا مصادقة لا تكشف أي سر وتعلن المسارات', async () => {
  const handle = createFetchHandler();
  const { response, body } = await callWorker(handle, '/', { token: null });
  assert.equal(response.status, 200);
  assert.equal(body.service, 'celia-cron-bridge');
  assert.deepEqual(body.endpoints, BRIDGE_ENDPOINTS);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(UPSTREAM_KEY));
  assert.doesNotMatch(JSON.stringify(body), new RegExp(ADMIN_TOKEN));
});

test('فحص CORS: الأصل المسموح يُعكس والغريب لا يحصل على ACAO و OPTIONS بلا رمز', async () => {
  const handle = createFetchHandler();
  const preflight = await handle(
    new Request('https://bridge.example/api/cron/jobs', { method: 'OPTIONS', headers: { origin: ORIGIN } }),
    makeEnv()
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(preflight.headers.get('access-control-allow-methods'), /PATCH/);

  const foreign = await handle(
    new Request('https://bridge.example/api/cron/jobs', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }),
    makeEnv()
  );
  assert.equal(foreign.headers.get('access-control-allow-origin'), null);

  const noCorsEnv = makeEnv({ ALLOWED_ORIGIN: '' });
  const sameOriginOnly = await handle(
    new Request('https://bridge.example/api/cron/jobs', { method: 'OPTIONS', headers: { origin: ORIGIN } }),
    noCorsEnv
  );
  assert.equal(sameOriginOnly.headers.get('access-control-allow-origin'), null);
});

test('المصادقة: غياب الرمز أو خطؤه 401، والمقارنة بزمن ثابت', async () => {
  const handle = createFetchHandler();
  const missing = await callWorker(handle, '/api/cron/jobs', { token: null });
  assert.equal(missing.response.status, 401);
  assert.equal(missing.body.error.code, 'unauthorized');
  assert.equal(missing.response.headers.get('www-authenticate'), 'Bearer');

  const wrong = await callWorker(handle, '/api/cron/jobs', { token: 'b'.repeat(32) });
  assert.equal(wrong.response.status, 401);

  assert.equal(tokensMatch(ADMIN_TOKEN, ADMIN_TOKEN), true);
  assert.equal(tokensMatch(`${ADMIN_TOKEN}x`, ADMIN_TOKEN), false);
  assert.equal(tokensMatch('short', ADMIN_TOKEN), false);
  assert.equal(tokensMatch(null, ADMIN_TOKEN), false);
});

test('غياب مفتاح المزوّد على الجسر = 503 صادق بلا ادعاء نجاح', async () => {
  const handle = createFetchHandler();
  const { response, body } = await callWorker(handle, '/api/cron/jobs', {}, makeEnv({ CRONJOB_API_KEY: '' }));
  assert.equal(response.status, 503);
  assert.equal(body.error.code, 'upstream_not_configured');
});

test('cron.list يترجم إلى GET /jobs بترويسة المزوّد ولا يسرّبها للعميل', async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse({ jobs: [{ jobId: 7, enabled: true, url: 'https://x.test', schedule: {} }], someFailed: false }));
  const handle = createFetchHandler({ fetch: fetchImpl });
  const { response, body } = await callWorker(handle, '/api/cron/jobs');
  assert.equal(response.status, 200);
  assert.equal(body.jobs[0].jobId, 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.cron-job.org/jobs');
  assert.equal(calls[0].options.method, undefined); // GET افتراضي
  assert.equal(calls[0].options.headers.authorization, `Bearer ${UPSTREAM_KEY}`);
  assert.equal(response.headers.get('authorization'), null);
});

test('cron.create يترجم إلى PUT /jobs ويعقّم الحقول الممنوعة ويتحقق من url', async () => {
  const { fetchImpl, calls } = stubFetch(({ options }) => {
    const sent = JSON.parse(options.body);
    assert.equal(sent.job.url, 'https://hook.test/in');
    assert.equal(sent.job.title, 'مهمة');
    assert.equal(options.method, 'PUT');
    assert.ok(!('extendedData' in sent.job), 'الحقول غير المدرجة في القائمة تُحذف');
    assert.ok(!('jobId' in sent.job));
    return jsonResponse({ jobId: 55 }, 200);
  });
  const handle = createFetchHandler({ fetch: fetchImpl });
  const body = JSON.stringify({
    job: {
      url: 'https://hook.test/in',
      title: 'مهمة',
      enabled: true,
      extendedData: { headers: { secret: 'leak' } },
      schedule: { timezone: 'Africa/Cairo', hours: [9], minutes: [0], mdays: [-1], months: [-1], wdays: [-1] }
    }
  });
  const ok = await callWorker(handle, '/api/cron/jobs', { method: 'POST', body });
  assert.equal(ok.response.status, 200);
  assert.equal(ok.body.jobId, 55);
  assert.equal(calls[0].url, 'https://api.cron-job.org/jobs');

  const badUrl = await callWorker(handle, '/api/cron/jobs', { method: 'POST', body: JSON.stringify({ job: { url: 'ftp://nope' } }) });
  assert.equal(badUrl.response.status, 422);
  assert.equal(badUrl.body.error.code, 'invalid_job');

  const missingUrl = await callWorker(handle, '/api/cron/jobs', { method: 'POST', body: JSON.stringify({ job: { title: 'بلا رابط' } }) });
  assert.equal(missingUrl.response.status, 422);
});

test('cron.update و enable/disable يترجم إلى PATCH /jobs/:id ويرفض التعديل الفارغ', async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse({}, 200));
  const handle = createFetchHandler({ fetch: fetchImpl });

  const patch = await callWorker(handle, '/api/cron/jobs/42', {
    method: 'PATCH',
    body: JSON.stringify({ job: { enabled: false } })
  });
  assert.equal(patch.response.status, 200);
  assert.equal(calls.at(-1).url, 'https://api.cron-job.org/jobs/42');
  assert.equal(calls.at(-1).options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { job: { enabled: false } });

  const empty = await callWorker(handle, '/api/cron/jobs/42', { method: 'PATCH', body: JSON.stringify({ job: {} }) });
  assert.equal(empty.response.status, 422);

  const badSchedule = await callWorker(handle, '/api/cron/jobs/42', {
    method: 'PATCH',
    body: JSON.stringify({ job: { schedule: { hours: [99] } } })
  });
  assert.equal(badSchedule.response.status, 422);
});

test('cron.delete يترجم إلى DELETE /jobs/:id', async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse({}, 200));
  const handle = createFetchHandler({ fetch: fetchImpl });
  const { response } = await callWorker(handle, '/api/cron/jobs/99', { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.equal(calls[0].options.method, 'DELETE');
  assert.equal(calls[0].url, 'https://api.cron-job.org/jobs/99');
});

test('cron.history يمرر السجل والتنبؤات', async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse({
    history: [{ identifier: '99-1', httpStatus: 200, date: 1782000000, duration: 210 }],
    predictions: [1782086400, 1782172800]
  }));
  const handle = createFetchHandler({ fetch: fetchImpl });
  const { response, body } = await callWorker(handle, '/api/cron/jobs/99/history');
  assert.equal(response.status, 200);
  assert.equal(body.history.length, 1);
  assert.equal(body.predictions.length, 2);
  assert.equal(calls[0].url, 'https://api.cron-job.org/jobs/99/history');
});

test('المسارات والطرق غير الصالحة: 404 و405 ومعرّف غير رقمي', async () => {
  const handle = createFetchHandler();
  assert.equal((await callWorker(handle, '/api/cron/nope')).response.status, 404);
  assert.equal((await callWorker(handle, '/api/cron/jobs/abc', { method: 'DELETE' })).response.status, 404);
  const method = await callWorker(handle, '/api/cron/jobs/12', { method: 'POST', body: JSON.stringify({ job: {} }) });
  assert.equal(method.response.status, 405);
  assert.equal(method.body.error.code, 'method_not_allowed');
});

test('أخطاء المزوّد تُعقّم: 429 ورسالة الشبكة 502 بلا ترويسات مسرّبة', async () => {
  const failing = createFetchHandler({
    fetch: async () => new Response('rate limited', { status: 429, headers: { 'x-secret-debug': UPSTREAM_KEY } })
  });
  const limited = await callWorker(failing, '/api/cron/jobs');
  assert.equal(limited.response.status, 429);
  assert.equal(limited.body.error.code, 'upstream_429');
  assert.equal(limited.response.headers.get('x-secret-debug'), null);
  assert.doesNotMatch(JSON.stringify(limited.body), new RegExp(UPSTREAM_KEY));

  const network = createFetchHandler({ fetch: async () => { throw new Error('socket hangup'); } });
  const down = await callWorker(network, '/api/cron/jobs');
  assert.equal(down.response.status, 502);
  assert.equal(down.body.error.code, 'upstream_unreachable');
});

test('دفاعات الحمولة: JSON تالف 400، وجسم أكبر من 8 كيلوبايت 413 بلا لمس المزوّد', async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse({}));
  const handle = createFetchHandler({ fetch: fetchImpl });
  const broken = await callWorker(handle, '/api/cron/jobs', { method: 'POST', body: '{not-json' });
  assert.equal(broken.response.status, 400);
  const huge = await callWorker(handle, '/api/cron/jobs', {
    method: 'POST',
    headers: { 'content-length': String(9 * 1024) },
    body: JSON.stringify({ job: { url: 'https://x.test', padding: 'z'.repeat(9 * 1024) } })
  });
  assert.equal(huge.response.status, 413);
  assert.equal(calls.length, 0);
});

test('sanitizeJobPayload يرفض الحقول المغلوطة ويحافظ على قائمة السماح', () => {
  const valid = sanitizeJobPayload({
    url: 'https://x.test',
    title: 't',
    enabled: true,
    requestMethod: 1,
    schedule: { timezone: 'Africa/Cairo', hours: [1], minutes: [0], mdays: [-1], months: [-1], wdays: [-1] }
  });
  assert.equal(valid.error, undefined);
  assert.deepEqual(Object.keys(valid.value).sort(), ['enabled', 'requestMethod', 'schedule', 'title', 'url']);

  assert.match(sanitizeJobPayload({ url: 'javascript:alert(1)' }).error, /url/);
  assert.match(sanitizeJobPayload(null).error, /كائن/);
  assert.match(sanitizeJobPayload({ title: 'only' }, { partial: false }).error, /إلزامي/);
  assert.match(sanitizeJobPayload({ schedule: { minutes: ['x'] } }, { partial: true }).error, /مصفوفة/);
});
