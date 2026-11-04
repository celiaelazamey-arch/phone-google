/**
 * AS-01..AS-08 — سكربتات Apps Script في `deploy/apps-script/`.
 *
 * لا يوجد مُشغّل Apps Script في CI، ولا يمكن محاكاة `UrlFetchApp`/`MailApp` بصدق. لذلك لا
 * ندّعي اختبار «تشغيل» هنا. نختبر ما يمكن اختباره فعلًا وبقيمة حقيقية:
 *
 *   - أن الملفات **صحيحة نحويًا** (خطأ مطبعي في ملف لا يُشغَّل إلا في Google = اكتشاف متأخر أسابيع).
 *   - أن كل دالة يستدعيها مُشغّل **موجودة** ومعرّفة تعريفًا صحيحًا.
 *   - أن **لا سرّ** مدموج في نصّ يُنسخ إلى Google Drive.
 *   - أن الوعود في الوثائق (10 دقائق) تطابق ما ينشئه الكود فعلًا.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'deploy/apps-script');
const files = readdirSync(dir).filter((name) => name.endsWith('.gs')).sort();
const source = (name) => readFileSync(path.join(dir, name), 'utf8');

test('AS-01 every Apps Script file parses as JavaScript', () => {
  assert.ok(files.length >= 3, `expected the three scripts, saw ${files.length}`);
  for (const name of files) {
    // Apps Script runs on V8 and accepts this syntax; a parse failure here is a real defect.
    assert.doesNotThrow(() => new Function(source(name)), `${name} must parse`);
  }
});

test('AS-02 the triggers the code creates all point at functions that exist', () => {
  for (const name of files) {
    const text = source(name);
    const created = [...text.matchAll(/newTrigger\(\s*'([A-Za-z_$][\w$]*)'\s*\)/g)].map((m) => m[1]);
    for (const handler of created) {
      const defined = new RegExp(`function\\s+${handler}\\s*\\(`).test(text);
      assert.ok(defined, `${name}: trigger handler ${handler} must be defined in the same file`);
    }
  }
  // And the documented frequency is what the code actually creates.
  const keepalive = source('keepalive.gs');
  assert.match(keepalive, /everyMinutes\(10\)/, 'الوثائق تَعِد بنداء كل 10 دقائق؛ الكود يجب أن يطابقها');
});

test('AS-03 no secret is committed: scripts read config, they do not embed it', () => {
  const forbidden = [
    /Bearer\s+[A-Za-z0-9._~+/-]{20,}/,          // رمز مدموج
    /AIza[0-9A-Za-z_-]{35}/,                     // مفتاح Google API
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /password\s*=\s*['"][^'"]{6,}['"]/i
  ];
  for (const name of files) {
    const text = source(name);
    for (const pattern of forbidden) {
      assert.equal(pattern.test(text), false, `${name} must not embed a credential (${pattern})`);
    }
    // كل ما هو حسّاس يُقرأ من Script properties.
    assert.match(text, /PropertiesService\.getScriptProperties\(\)/, `${name}: config comes from properties`);
  }
});

test('AS-04 the keep-alive answers a real question: readiness, not just reachability', () => {
  const text = source('keepalive.gs');
  assert.match(text, /payload\.ready === true/, 'must inspect ready, not only the status code');
  assert.match(text, /\/readyz/);
  // 503 is a named outcome, not lumped in with a network failure.
  assert.match(text, /503/);
  assert.match(text, /not_ready/);
  assert.match(text, /timeout/);
});

test('AS-05 alerts are edge-triggered, so 144 daily runs do not become 144 emails', () => {
  const text = source('keepalive.gs');
  assert.match(text, /ALERTS_ENABLED/, 'alerts can be disabled without deleting the trigger');

  // Existence is not behaviour. Load the file with stubs and call the rule itself: 144 identical
  // runs must produce at most one email, because the consumer quota is 100/day and a monitoring
  // script that exhausts it is worse than no monitoring.
  const scope = {};
  const properties = new Map();
  const globalStubs = {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (properties.has(k) ? properties.get(k) : null),
      setProperty: (k, v) => properties.set(k, v)
    }) },
    Logger: { log: () => {} },
    MailApp: { sendEmail: () => { globalStubs.__mails = (globalStubs.__mails || 0) + 1; } },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }) }),
      deleteTrigger: () => {}
    },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ ready: true, status: 'ok', storage: 'mysql', release: { version: '0.3.0' } }) }) },
    __mails: 0
  };
  const factory = new Function(...Object.keys(globalStubs), `${text}\nreturn { checkOnce, shouldAlert_, probe_, config_ };`);
  Object.assign(scope, globalStubs);
  properties.set('SERVICE_URL', 'https://example.test');
  properties.set('ALERT_EMAIL', 'owner@example.test');
  const api = factory(...Object.values(globalStubs));

  // A healthy, unchanging service: 144 runs, zero emails. This is the quota guard.
  for (let i = 0; i < 144; i += 1) api.checkOnce();
  assert.equal(globalStubs.__mails, 0, 'steady state must not send mail');

  // A change of state alerts exactly once, then goes quiet again.
  globalStubs.UrlFetchApp = null;
  properties.set('LAST_STATE', JSON.stringify({ ok: false, kind: 'network_error', code: null, status: null, storage: null }));
  api.checkOnce();
  assert.equal(globalStubs.__mails, 1, 'a transition alerts once');
  api.checkOnce();
  assert.equal(globalStubs.__mails, 1, 'and does not repeat while unchanged');
});

test('AS-06 the status relay reads the documented JSON endpoint, not scraped HTML', () => {
  const text = source('status-relay.gs');
  assert.match(text, /appsstatus\/dashboard\/incidents\.json/, 'the dashboard footer links this endpoint');
  assert.equal(/<div|<span/.test(text), false, 'no HTML scraping');
  // A failed read must not be reported as "all clear".
  assert.match(text, /measured: false/);
  assert.match(text, /لا حكم/);
});

test('AS-07 the relay only watches services the system actually depends on', () => {
  const text = source('status-relay.gs');
  const declared = text.match(/var DEFAULT_SERVICES = \[([\s\S]*?)\];/);
  assert.ok(declared, 'the watched list is declared explicitly');
  const names = [...declared[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 3, 'a single blanket "Google" watch would not be actionable');
  for (const service of ['Google Calendar', 'Google Drive']) {
    assert.ok(names.some((name) => name.includes(service)), `${service} is used by the agent connectors`);
  }
});

test('AS-08 the honest limits are written down where the owner will read them', () => {
  const readme = readFileSync(path.join(dir, 'README.md'), 'utf8');
  // Quotas are quoted with their consequence, not just as trivia.
  for (const fact of ['6 دقائق', '90 دقيقة', '100', '20']) {
    assert.ok(readme.includes(fact), `README must state the measured limit: ${fact}`);
  }
  // The claim boundary must be present as a sentence, not an implication: this is sleep
  // prevention, not an uptime guarantee. (Matched on exact phrases — Arabic diacritics make
  // loose patterns silently wrong, which is how this test first failed.)
  assert.ok(readme.includes('ليس ضمان توفّر'), 'README must deny that this guarantees availability');
  assert.ok(readme.includes('لا يعني «الخدمة متاحة»'), 'and must state what it does not mean');
  // And the honest failure mode: the watcher can stop watching.
  assert.ok(readme.includes('انقطع حساب Google'), 'README must name the failure of the watcher itself');
});
