import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CRON_TOOLS,
  STORAGE_KEYS,
  describeSchedule,
  buildSchedule,
  normalizeJob,
  normalizeHistory,
  validateBridgeUrl,
  validateJobInput,
  classifyBridgeError,
  formatDateTime,
  createDemoStore,
  createBridgeClient
} from '../public/cron-lib.js';

test('الأدوات السبع موثقة بلا تكرار والحسّاسة معلنة', () => {
  assert.equal(CRON_TOOLS.length, 7);
  assert.deepEqual(CRON_TOOLS.map((tool) => tool.id), [
    'cron.list', 'cron.create', 'cron.update', 'cron.enable',
    'cron.disable', 'cron.history', 'cron.delete'
  ]);
  const sensitive = CRON_TOOLS.filter((tool) => tool.sensitive).map((tool) => tool.id);
  assert.deepEqual(sensitive, ['cron.create', 'cron.update', 'cron.delete']);
  assert.equal(new Set(Object.values(STORAGE_KEYS)).size, 3);
});

test('وصف الجداول العربية يغطي كل الحالات', () => {
  assert.match(describeSchedule({ minutes: [-1], hours: [-1] }), /كل دقيقة/);
  assert.match(describeSchedule({ minutes: [15], hours: [-1] }), /كل ساعة/);
  const daily = describeSchedule({ timezone: 'Africa/Cairo', hours: [8], minutes: [0], mdays: [-1], months: [-1], wdays: [-1] });
  assert.match(daily, /يوميًا/);
  assert.match(daily, /08:00/);
  assert.match(daily, /Africa\/Cairo/);
  const weekly = describeSchedule({ hours: [23], minutes: [30], wdays: [5], mdays: [-1], months: [-1] });
  assert.match(weekly, /الجمعة/);
  assert.match(weekly, /23:30/);
  const monthly = describeSchedule({ hours: [9], minutes: [0], mdays: [1, 15], wdays: [-1], months: [-1] });
  assert.match(monthly, /1، 15/);
});

test('buildSchedule ينتج جداول cron-job.org الصحيحة ويرفض الأوقات المغلوطة', () => {
  assert.deepEqual(buildSchedule({ kind: 'every-minute' }).hours, [-1]);
  const hourly = buildSchedule({ kind: 'hourly', minute: 45 });
  assert.deepEqual(hourly.minutes, [45]);
  const daily = buildSchedule({ kind: 'daily', time: '08:30' });
  assert.deepEqual(daily.hours, [8]);
  assert.deepEqual(daily.minutes, [30]);
  const weekly = buildSchedule({ kind: 'weekly', time: '10:00', weekday: 1 });
  assert.deepEqual(weekly.wdays, [1]);
  const monthly = buildSchedule({ kind: 'monthly', time: '10:00', monthDay: 15 });
  assert.deepEqual(monthly.mdays, [15]);
  assert.throws(() => buildSchedule({ kind: 'daily', time: '25:00' }), /الوقت/);
  assert.throws(() => buildSchedule({ kind: 'weekly', time: '10:00', weekday: 9 }), /الأسبوع/);
});

test('normalizeJob و normalizeHistory يحولان النموذج الخام بأمان', () => {
  const job = normalizeJob({ jobId: 3, title: 'ت', url: 'https://x', enabled: false, requestMethod: 1, schedule: { hours: [9], minutes: [0] } });
  assert.equal(job.id, 3);
  assert.equal(job.enabled, false);
  assert.equal(job.method, 'POST');
  assert.match(job.scheduleText, /يوميًا/);
  const history = normalizeHistory({
    history: [
      { identifier: 'a', date: 1782000000, httpStatus: 200, duration: 120 },
      { identifier: 'b', date: 1782000100, httpStatus: 500, duration: 900 }
    ],
    predictions: [1782086400]
  });
  assert.equal(history.items[0].ok, true);
  assert.equal(history.items[1].ok, false);
  assert.equal(history.predictions[0], 1782086400);
  assert.equal(formatDateTime(0), '—');
  assert.match(formatDateTime(1782000000), /2026|٢٠٢٦/);
});

test('validateBridgeUrl يفرض HTTPS ويستثني localhost للتطوير', () => {
  assert.equal(validateBridgeUrl('https://celia-cron-bridge.x.workers.dev').ok, true);
  assert.equal(validateBridgeUrl('https://celia-cron-bridge.x.workers.dev/').value, 'https://celia-cron-bridge.x.workers.dev');
  assert.equal(validateBridgeUrl('http://127.0.0.1:8787').ok, true);
  assert.equal(validateBridgeUrl('http://insecure.example.com').ok, false);
  assert.equal(validateBridgeUrl('not-a-url').ok, false);
  assert.equal(validateBridgeUrl('https://x.test?token=secret').ok, false);
});

test('validateJobInput يتحقق من العنوان والرابط والجدول', () => {
  const ok = validateJobInput({ title: 'مهمة', url: 'https://hook.test', kind: 'daily' });
  assert.equal(ok.ok, true);
  assert.equal(validateJobInput({ title: '', url: 'https://x', kind: 'daily' }).ok, false);
  assert.equal(validateJobInput({ title: 'x'.repeat(121), url: 'https://x', kind: 'daily' }).ok, false);
  assert.equal(validateJobInput({ title: 't', url: 'ftp://x', kind: 'daily' }).ok, false);
  assert.equal(validateJobInput({ title: 't', url: 'https://x', kind: 'weird' }).ok, false);
});

test('تصنيف الأخطاء عربي صادق بلا تسريب', () => {
  assert.match(classifyBridgeError(401), /الرمز الإداري/);
  assert.match(classifyBridgeError(429), /معدل/);
  assert.match(classifyBridgeError(502), /الجسر/);
  assert.match(classifyBridgeError(400, { error: { message: 'bad' } }), /bad/);
});

test('متجر المحاكاة يدعم الأدوات السبع داخل الذاكرة فقط', () => {
  const store = createDemoStore(new Date('2026-10-27T10:00:00Z').getTime());
  assert.equal(store.list().length, 4);
  assert.equal(store.mode, 'demo');
  const created = store.create({ title: 'جديدة', url: 'https://new.test', kind: 'daily', time: '07:00', enabled: true });
  assert.equal(store.list().length, 5);
  assert.equal(created.enabled, true);
  assert.match(created.scheduleText, /يوميًا/);

  const updated = store.update(created.id, { title: 'معدّلة' });
  assert.equal(updated.title, 'معدّلة');
  const disabled = store.setEnabled(created.id, false);
  assert.equal(disabled.enabled, false);
  const history = store.recordHistory(9001);
  assert.equal(history.items.length, 2);
  assert.equal(history.items[0].ok, true);
  store.remove(created.id);
  assert.equal(store.list().length, 4);
  assert.throws(() => store.remove(created.id), /غير موجودة/);
  assert.throws(() => store.create({ title: '', url: '', kind: 'daily' }), /غير صالحة/);
});

test('عميل الجسر الحي يرسل الرمز في الترويسة فقط ولا يضعه في الرابط', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/api/cron/jobs')) return new Response(JSON.stringify({ jobs: [{ jobId: 1, enabled: true, url: 'https://x', schedule: {} }] }), { status: 200 });
    if (url.endsWith('/history')) return new Response(JSON.stringify({ history: [], predictions: [] }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  const client = createBridgeClient({
    bridgeUrl: 'https://bridge.example/',
    adminToken: 'c'.repeat(32),
    fetchImpl
  });
  assert.equal(client.mode, 'live');
  const jobs = await client.list();
  assert.equal(jobs[0].id, 1);
  assert.match(requests[0].options.headers.authorization, /^Bearer /);
  assert.doesNotMatch(requests[0].url, /token|Bearer/);

  await client.create({ url: 'https://x.test' });
  assert.equal(requests[1].options.method, 'POST');
  await client.setEnabled(1, false);
  assert.equal(requests[2].options.method, 'PATCH');
  await client.remove(1);
  assert.equal(requests[3].options.method, 'DELETE');
  await client.recordHistory(1);
  assert.match(requests[4].url, /\/history$/);
});

test('عميل الجسر يرفض الإعداد الناقص ويفسر الأخطاء', async () => {
  assert.throws(() => createBridgeClient({ bridgeUrl: 'ftp://x', adminToken: 'c'.repeat(32) }), /HTTPS/);
  assert.throws(() => createBridgeClient({ bridgeUrl: 'https://x.test', adminToken: 'short' }), /16/);
  const failing = createBridgeClient({
    bridgeUrl: 'https://x.test',
    adminToken: 'c'.repeat(32),
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'no' } }), { status: 401 })
  });
  await assert.rejects(failing.list(), /الرمز الإداري/);
  const offline = createBridgeClient({
    bridgeUrl: 'https://x.test',
    adminToken: 'c'.repeat(32),
    fetchImpl: async () => { throw new Error('offline'); }
  });
  await assert.rejects(offline.list(), /تعذر الوصول/);
});
