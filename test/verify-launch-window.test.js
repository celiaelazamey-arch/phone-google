/**
 * VLW-01..VLW-13 — نافذة `GA-F5` تُقاس بلا شبكة.
 *
 * القاعدة التي يحرسها هذا الملف: **صفر محاولات ليس نجاحًا**، وغياب اعتماد المالك
 * يجعل الـoutbox «غير مقيس» لا صفرًا، و`launch.ready` لا يصير true أبدًا.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyLaunchWindow, parseArgs } from '../scripts/verify-launch-window.mjs';

const ORIGIN = 'https://celia-phone-google.celiaelazamey.workers.dev';
const NOW = () => new Date('2026-11-04T09:00:00.000Z');

function json(body, status = 200) {
  return { ok: status < 400, status, async json() { return body; } };
}

/** fetch وهمي: يوجّه كل مسار إلى رد محدَّد لكل نداء. */
function fakeFetch({ version = () => json({ version: '0.3.0', commit: 'abc1234' }), readyz = () => json({ ok: true, ready: true }), intents = () => json({ intents: [], counts: {} }) } = {}) {
  const calls = [];
  const impl = async (target) => {
    const path = new URL(target).pathname;
    calls.push(path);
    if (path === '/version') return version(calls.filter((p) => p === '/version').length);
    if (path === '/readyz') return readyz(calls.filter((p) => p === '/readyz').length);
    if (path === '/api/cron/intents') return intents();
    return json({ error: 'not_found' }, 404);
  };
  return { impl, calls };
}

const noSleep = async () => {};

test('VLW-01: هدف غير HTTPS يُرفض قبل أي طلب', async () => {
  await assert.rejects(
    () => verifyLaunchWindow({ url: 'http://example.test', sleepImpl: noSleep, now: NOW }),
    /must be an https:\/\/ origin/
  );
});

test('VLW-02: نافذة نظيفة بحركة مطابقة تُعطي pass، وتبقى launch.ready=false', async () => {
  const { impl } = fakeFetch({
    intents: () => json({
      intents: [{ status: 'applied', attempts: 1, createdAt: '2026-11-04T09:00:01.000Z' }],
      counts: { applied: 1, failed: 0, unknown: 0 }
    })
  });
  const report = await verifyLaunchWindow({ url: ORIGIN, ticks: 3, intervalMs: 0, cookie: 'owner=abc', fetchImpl: impl, sleepImpl: noSleep, now: NOW });
  assert.equal(report.window.completedSamples, 3);
  assert.equal(report.readiness.failureCount, 0);
  assert.equal(report.outbox.attempts, 1);
  assert.equal(report.outbox.successful, 1);
  assert.equal(report.outbox.failed, 0);
  assert.equal(report.verdict, 'pass');
  assert.equal(report.launch.ready, false, 'النافذة لا تعلن جاهزية إطلاق');
  assert.ok(report.blockedPendingExternalGates.includes('GA-F5-consent'));
});

test('VLW-03: بلا اعتماد مالك يكون القياس unmeasured لا صفرًا', async () => {
  const { impl } = fakeFetch();
  const report = await verifyLaunchWindow({ url: ORIGIN, ticks: 1, intervalMs: 0, cookie: '', fetchImpl: impl, sleepImpl: noSleep, now: NOW });
  assert.equal(report.verdict, 'unmeasured');
  assert.equal(report.outbox.reason, 'owner_credential_missing');
  assert.deepEqual(report.verdictReasons.map((reason) => reason.code), ['owner_credential_missing_outbox_unmeasured']);
});

test('VLW-04: صفر محاولات صريح يعني fail لا 100%', async () => {
  const { impl } = fakeFetch({ intents: () => json({ intents: [], counts: { applied: 0 } }) });
  const report = await verifyLaunchWindow({ url: ORIGIN, ticks: 2, intervalMs: 0, cookie: 'owner=abc', fetchImpl: impl, sleepImpl: noSleep, now: NOW });
  assert.equal(report.verdict, 'fail');
  assert.ok(report.verdictReasons.some((reason) => reason.code === 'zero_attempts_is_not_success'));
});

test('VLW-05: إعادة محاولة ناجحة تُقرأ review لأن successful لا يساوي attempts', async () => {
  const { impl } = fakeFetch({
    intents: () => json({ intents: [{ status: 'applied', attempts: 2, createdAt: '2026-11-04T09:00:05.000Z' }], counts: {} })
  });
  const report = await verifyLaunchWindow({ url: ORIGIN, ticks: 1, intervalMs: 0, cookie: 'owner=abc', fetchImpl: impl, sleepImpl: noSleep, now: NOW });
  assert.equal(report.outbox.attempts, 2);
  assert.equal(report.outbox.successful, 1);
  assert.equal(report.outbox.maxAttempts, 2);
  assert.equal(report.verdict, 'review');
  assert.ok(report.verdictReasons.some((reason) => reason.code === 'successful_not_equal_attempts'));
});

test('VLW-06: intent فاشل أو unknown يفرض review ويُعدّ', async () => {
  const { impl } = fakeFetch({
    intents: () => json({
      intents: [
        { status: 'applied', attempts: 1, createdAt: '2026-11-04T09:00:02.000Z' },
        { status: 'unknown', attempts: 1, createdAt: '2026-11-04T09:00:03.000Z' }
      ],
      counts: {}
    })
  });
  const report = await verifyLaunchWindow({ url: ORIGIN, ticks: 1, intervalMs: 0, cookie: 'owner=abc', fetchImpl: impl, sleepImpl: noSleep, now: NOW });
  assert.equal(report.outbox.failed, 1);
  assert.equal(report.verdict, 'review');
  assert.ok(report.verdictReasons.some((reason) => reason.code === 'failed_or_unknown_intents' && reason.count === 1));
});

test('VLW-07: اهتزاز readiness داخل النافذة يُفشل التقرير ويسجّل العيّنة', async () => {
  const { impl } = fakeFetch({
    readyz: (n) => (n === 2 ? json({ ok: true, ready: false }) : json({ ok: true, ready: true })),
    intents: () => json({ intents: [{ status: 'applied', attempts: 1, createdAt: '2026-11-04T09:00:00.500Z' }], counts: {} })
  });
  const report = await verifyLaunchWindow({ url: ORIGIN, ticks: 3, intervalMs: 0, cookie: 'owner=abc', fetchImpl: impl, sleepImpl: noSleep, now: NOW });
  assert.equal(report.readiness.failureCount, 1);
  assert.deepEqual(report.readiness.failures[0].problems, ['readyz_not_ready']);
  assert.equal(report.verdict, 'fail');
});

test('VLW-08: استجابة غير JSON أو 5xx لا تُسقط الأداة بل تُسجَّل كعيب عيّنة', async () => {
  const { impl } = fakeFetch({
    version: () => ({ ok: false, status: 500, async json() { throw new Error('not json'); } })
  });
  const report = await verifyLaunchWindow({ url: ORIGIN, ticks: 1, intervalMs: 0, fetchImpl: impl, sleepImpl: noSleep, now: NOW });
  assert.equal(report.readiness.failureCount, 1);
  assert.ok(report.readiness.failures[0].problems.includes('version_status'));
  assert.ok(report.readiness.failures[0].problems.includes('version_body'));
  assert.equal(report.verdict, 'unmeasured');
});

test('VLW-09: commit مختلف عن المتوقع عيب مسمّى لا استنتاج', async () => {
  const { impl } = fakeFetch({ version: () => json({ version: '0.3.0', commit: 'deadbee' }) });
  const report = await verifyLaunchWindow({
    url: ORIGIN,
    ticks: 1,
    intervalMs: 0,
    expectedCommit: '50f21714e83e44e0869b053cf50d28a3727f5607',
    fetchImpl: impl,
    sleepImpl: noSleep,
    now: NOW
  });
  assert.ok(report.readiness.failures[0].problems.includes('version_commit_mismatch'));
});

test('VLW-10: التقرير لا يحمل الكوكي ولا أي ترويسة مصادقة', async () => {
  const { impl } = fakeFetch({
    intents: () => json({ intents: [{ status: 'applied', attempts: 1, createdAt: '2026-11-04T09:00:00.100Z' }], counts: {} })
  });
  const secret = 'owner=SUPER_SECRET_SESSION_VALUE';
  const report = await verifyLaunchWindow({ url: ORIGIN, ticks: 1, intervalMs: 0, cookie: secret, fetchImpl: impl, sleepImpl: noSleep, now: NOW });
  const text = JSON.stringify(report);
  assert.equal(text.includes('SUPER_SECRET_SESSION_VALUE'), false, 'قيمة الكوكي غير موجودة');
  assert.equal(/cookie/i.test(text), false, 'لا ذكر لكوكي في التقرير');
});

test('VLW-11: التباعد يُطبَّق بين العيّنات فقط، والمجموع مطابق للمخطط', async () => {
  const { impl } = fakeFetch();
  const waits = [];
  const report = await verifyLaunchWindow({
    url: ORIGIN,
    ticks: 4,
    intervalMs: 250,
    fetchImpl: impl,
    sleepImpl: async (ms) => { waits.push(ms); },
    now: NOW
  });
  assert.deepEqual(waits, [250, 250, 250], 'ثلاث فواصل لأربع عيّنات');
  assert.equal(report.window.plannedSamples, 4);
  assert.equal(report.window.completedSamples, 4);
  assert.equal(report.window.intervalMs, 250);
});

test('VLW-12: outbox غير مقروء (403) يوقف التقرير بفشل مسمّى', async () => {
  const { impl } = fakeFetch({ intents: () => json({ error: 'forbidden' }, 403) });
  const report = await verifyLaunchWindow({ url: ORIGIN, ticks: 1, intervalMs: 0, cookie: 'owner=abc', fetchImpl: impl, sleepImpl: noSleep, now: NOW });
  assert.equal(report.verdict, 'fail');
  assert.ok(report.verdictReasons.some((reason) => reason.code === 'outbox_unreadable' && reason.detail === 'http_403'));
});

test('VLW-13: صفوف خارج النافذة لا تُحسب حركةً', async () => {
  const { impl } = fakeFetch({
    intents: () => json({ intents: [{ status: 'applied', attempts: 3, createdAt: '2026-11-01T00:00:00.000Z' }], counts: { applied: 1 } })
  });
  const report = await verifyLaunchWindow({ url: ORIGIN, ticks: 1, intervalMs: 0, cookie: 'owner=abc', fetchImpl: impl, sleepImpl: noSleep, now: NOW });
  assert.equal(report.outbox.sampledIntents, 0, 'الصف قديم خارج بداية النافذة');
  assert.equal(report.outbox.attempts, 0);
  assert.equal(report.verdict, 'fail');
  assert.ok(report.verdictReasons.some((reason) => reason.code === 'zero_attempts_is_not_success'));
});

test('VLW-14: المعاملات تُرفض بالقيم غير المعقولة', () => {
  assert.equal(parseArgs([]).minutes, 60);
  assert.equal(parseArgs(['--minutes', '30']).minutes, 30);
  assert.throws(() => parseArgs(['--minutes', '0']), /--minutes must be between/);
  assert.throws(() => parseArgs(['--interval-ms', '-1']), /--interval-ms must be between/);
  assert.throws(() => parseArgs(['--ticks', '0']), /--ticks must be an integer/);
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
});
