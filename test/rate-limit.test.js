/**
 * SEC-007 — حدّ الدخل على سطح Express: حتمية، حدود الذاكرة، ورفض بلا أثر.
 *
 * الاختبارات لا تنام ولا تقرأ ساعة الحائط: كل عدّاد يُبنى بساعة محقونة، فالنافذة تنتهي عندما
 * نقول لا عندما يمضي وقت حقيقي. والاختباران الأخيران يثبتان السلوك عبر التطبيق الفعلي (RL-08/09).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createApp } from '../src/app.js';
import {
  RATE_LIMIT_DEFAULTS,
  clientKey,
  createRateLimit,
  createRateLimiter,
  loadRateLimitConfig,
  mountRateLimits
} from '../src/rate-limit.js';

const clock = (start = 1_000_000) => {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; }, set: (value) => { at = value; } };
};

/** استجابة وهمية تحاكي ما يستخدمه الوسيط فقط: set/status/json وحدث finish. */
function fakeResponse() {
  const res = new EventEmitter();
  res.headers = {};
  res.statusCode = 200;
  res.body = null;
  res.set = (name, value) => { res.headers[String(name).toLowerCase()] = String(value); return res; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; res.emit('finish'); return res; };
  return res;
}

test('RL-01 عدّاد نوافذ ثابتة: يسمح حتى الحد ثم يرفض، ويُصفَّر عند انتهاء النافذة', () => {
  const c = clock();
  const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: c.now });

  assert.equal(limiter.take('k').allowed, true);
  assert.equal(limiter.take('k').allowed, true);
  const third = limiter.take('k');
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);

  const blocked = limiter.take('k');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 60_000, 'الرفض لا يمدّ النافذة: المهلة من بدايتها');

  c.advance(30_000);
  assert.equal(limiter.peek('k').count, 3, 'peek لا يستهلك');
  assert.equal(limiter.peek('k').retryAfterMs, 30_000);

  c.advance(30_000);
  assert.equal(limiter.peek('k').count, 0, 'انتهت النافذة بلا مؤقّت ولا ساعة حائط');
  assert.equal(limiter.take('k').allowed, true);
});

test('RL-02 المفاتيح معزولة، والنطاق (scope) يفصل العدّادات', () => {
  const c = clock();
  const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, now: c.now });
  assert.equal(limiter.take('a').allowed, true);
  assert.equal(limiter.take('a').allowed, false);
  assert.equal(limiter.take('b').allowed, true, 'المفتاح الآخر لا يُستهلك بسبب a');
});

test('RL-03 الوسيط يرفض 429 قبل المعالج: لا أثر، رأس Retry-After، وعدد الاستدعاءات = الحد', () => {
  const c = clock();
  const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: c.now });
  const middleware = createRateLimit({ limiter, scope: 'api' });
  let handled = 0;
  const req = { ip: '203.0.113.7' };

  const first = fakeResponse();
  middleware(req, first, () => { handled += 1; });
  const second = fakeResponse();
  middleware(req, second, () => { handled += 1; });
  assert.equal(handled, 2);
  assert.equal(second.headers['ratelimit-remaining'], '0');

  const rejected = fakeResponse();
  middleware(req, rejected, () => { handled += 1; });
  assert.equal(handled, 2, 'المعالج لم يُستدعَ بعد الرفض');
  assert.equal(rejected.statusCode, 429);
  assert.equal(rejected.body.error, 'rate_limited');
  assert.equal(rejected.headers['retry-after'], '60');
  assert.equal(rejected.headers['ratelimit-limit'], '2');
});

test('RL-04 وضع «الفشل فقط»: النجاح لا يستهلك، والرفض يسبق المعالج', () => {
  const c = clock();
  const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: c.now });
  const middleware = createRateLimit({ limiter, scope: 'api', countFailuresOnly: true, failureStatuses: [401] });
  let handled = 0;
  const req = { ip: '198.51.100.9' };

  for (let i = 0; i < 25; i += 1) {
    const res = fakeResponse();
    res.statusCode = 200;
    middleware(req, res, () => { handled += 1; });
    res.emit('finish');
  }
  assert.equal(handled, 25, 'الطلبات الناجحة لا تُحدّ');
  assert.equal(limiter.peek('api:' + clientKey(req)).count, 0, 'ولا تُحتسب');

  for (let i = 0; i < 2; i += 1) {
    const res = fakeResponse();
    middleware(req, res, () => { handled += 1; });
    res.status(401).json({ error: 'unauthorized' });
  }
  assert.equal(limiter.peek('api:' + clientKey(req)).count, 2, 'الردود 401 وحدها تُحتسب');

  const blocked = fakeResponse();
  middleware(req, blocked, () => { handled += 1; });
  assert.equal(blocked.statusCode, 429, 'الطلب التالي يُرفض قبل أن يصل إلى requireApiToken');
  assert.equal(handled, 27, 'لا معالج بعد الحد');
});

test('RL-05 الذاكرة محدودة: تحذف المنتهي أولًا ثم الأقدم، والحجم لا يتجاوز maxKeys', () => {
  const c = clock();
  const limiter = createRateLimiter({ limit: 5, windowMs: 1_000, now: c.now, maxKeys: 3 });
  limiter.take('a');
  limiter.take('b');
  limiter.take('c');
  assert.equal(limiter.size(), 3);

  limiter.take('d');
  assert.equal(limiter.size(), 3, 'لا نموّ فوق السقف');
  assert.equal(limiter.peek('a').count, 0, 'الأقدم أُخرج أولًا');

  c.advance(1_000);
  limiter.take('e');
  assert.equal(limiter.size(), 1, 'الدلاء المنتهية تُنظَّف قبل الإخراج القسري');
});

test('RL-06 الإعداد: افتراضيات معلنة، تجاوز بالبيئة، ورفض القيمة الفاسدة بدل ارتداد صامت', () => {
  const defaults = loadRateLimitConfig({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.windowMs, RATE_LIMIT_DEFAULTS.windowMs);
  assert.equal(defaults.apiFailures, RATE_LIMIT_DEFAULTS.apiFailures);
  assert.ok(Object.isFrozen(defaults));

  const custom = loadRateLimitConfig({
    CELIA_RATE_LIMIT: 'off',
    CELIA_RATE_LIMIT_WINDOW_MS: '30000',
    CELIA_RATE_LIMIT_API_FAILURES: '5',
    CELIA_RATE_LIMIT_AUTH: '7',
    CELIA_RATE_LIMIT_WEBHOOK: '900',
    CELIA_RATE_LIMIT_MCP_FAILURES: '9',
    CELIA_RATE_LIMIT_MAX_KEYS: '50'
  });
  assert.deepEqual(
    { ...custom },
    { enabled: false, windowMs: 30_000, apiFailures: 5, auth: 7, webhook: 900, mcpFailures: 9, maxKeys: 50 }
  );

  assert.throws(() => loadRateLimitConfig({ CELIA_RATE_LIMIT: 'maybe' }), /must be on or off/);
  assert.throws(() => loadRateLimitConfig({ CELIA_RATE_LIMIT_API_FAILURES: '0' }), /positive integer/);
  assert.throws(() => loadRateLimitConfig({ CELIA_RATE_LIMIT_AUTH: '2.5' }), /positive integer/);
  assert.throws(() => loadRateLimitConfig({ CELIA_RATE_LIMIT_WINDOW_MS: '999' }), /at least 1000/);
});

test('RL-07 المفتاح بصمة لا عنوانًا خامًا، والتركيب يحترم enabled', () => {
  const key = clientKey({ ip: '203.0.113.7' });
  assert.match(key, /^[a-f0-9]{16}$/);
  assert.ok(!key.includes('203.0.113.7'), 'لا يُحفظ العنوان الخام');

  const routes = [];
  const fakeApp = { use: (prefix) => routes.push(prefix), locals: {} };
  const off = mountRateLimits(fakeApp, { rateLimit: { ...RATE_LIMIT_DEFAULTS, enabled: false } });
  assert.equal(off.enabled, false);
  assert.deepEqual(routes, [], 'التعطيل لا يركّب أي وسيط');

  const on = mountRateLimits(fakeApp, { rateLimit: { ...RATE_LIMIT_DEFAULTS, enabled: true } });
  assert.equal(on.enabled, true);
  assert.deepEqual(routes, ['/api', '/auth', '/webhooks/whatsapp']);
});

const integrationConfig = (rateLimit) => ({
  nodeEnv: 'test',
  apiToken: 'test-token-with-at-least-32-characters',
  encryptionKey: Buffer.alloc(32, 7).toString('base64'),
  userId: 'owner',
  google: { clientId: '', clientSecret: '', redirectUri: 'http://localhost:3000/auth/google/callback' },
  whatsapp: { verifyToken: '', appSecret: '', accessToken: '', phoneNumberId: '', apiVersion: '', autoReplyEnabled: false, autoReplyText: '' },
  rateLimit
});

async function startApp(rateLimit) {
  const pool = { execute: async () => [[]] };
  const server = createApp({ pool, config: integrationConfig(rateLimit) }).listen(0);
  const baseUrl = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  return { baseUrl, close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))) };
}

test('RL-08 عبر التطبيق الفعلي: 429 بعد الحد على /api و/auth وwebhook، والحيوية لا تُحدّ', async () => {
  const limits = { enabled: true, windowMs: 60_000, apiFailures: 2, auth: 2, webhook: 2, mcpFailures: 2, maxKeys: 100 };
  const app = await startApp(limits);
  try {
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`${app.baseUrl}/api/whatsapp/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '+14155552671', text: 'hello' })
      });
      assert.equal(res.status, 401, 'المحاولة الفاشلة تُحتسب ثم تُرفض لاحقًا');
    }
    const blockedApi = await fetch(`${app.baseUrl}/api/whatsapp/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(blockedApi.status, 429);
    assert.equal((await blockedApi.json()).error, 'rate_limited');
    assert.ok(Number(blockedApi.headers.get('retry-after')) >= 1);

    const health = await fetch(`${app.baseUrl}/health`);
    assert.equal(health.status, 200, 'المراقب لا يُحجب بفشل عميل آخر');
    const version = await fetch(`${app.baseUrl}/version`);
    assert.equal(version.status, 200);

    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`${app.baseUrl}/auth/google`, { redirect: 'manual' });
      assert.equal(res.status, 401);
    }
    const blockedAuth = await fetch(`${app.baseUrl}/auth/google`, { redirect: 'manual' });
    assert.equal(blockedAuth.status, 429);

    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`${app.baseUrl}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=&hub.challenge=1`);
      assert.equal(res.status, 403);
    }
    const blockedHook = await fetch(`${app.baseUrl}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=&hub.challenge=1`);
    assert.equal(blockedHook.status, 429);
  } finally {
    await app.close();
  }
});

test('RL-09 التعطيل الصريح: لا 429 على السطح كله (سلوك ما قبل SEC-007)', async () => {
  const app = await startApp({ enabled: false, windowMs: 60_000, apiFailures: 1, auth: 1, webhook: 1, mcpFailures: 1, maxKeys: 10 });
  try {
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${app.baseUrl}/api/whatsapp/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(res.status, 401, `الطلب ${i + 1} يبقى 401 عند التعطيل`);
    }
  } finally {
    await app.close();
  }
});
