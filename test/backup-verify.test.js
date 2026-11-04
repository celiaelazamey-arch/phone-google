/**
 * BV-01..BV-09 — `backup:verify`: نسخة مشتقة، استعادة معزولة، وقياس RPO/RTO.
 *
 * القاعدة المحروسة هنا: **لا يُقال «مستعاد» عن شيء لم يُستعد**. لذلك كل اختبار يعمل على بنية
 * حقيقية (SQLite؟ لا — هذه بصمات MySQL وCHECKSUM TABLE من الخادم)، ويُقاس المنطق القابل للقياس
 * بلا خادم، ويُقاس السلوك الحارس بلا شبكة. الاتصال بـMySQL نفسه يبقى في `test:mysql` على CI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import {
  BACKUP_VERIFY_VERSION,
  compareFingerprints,
  deriveDump,
  guardTargets,
  keyProof,
  measureRpoRto,
  scrub
} from '../scripts/backup-verify.mjs';

const KEY = Buffer.alloc(32, 3).toString('base64');

/** نفس صيغة `encryptJson` (`v1.<nonce>.<tag>.<data>`) لإنتاج عمود مشفّر واقعي. */
function encryptV1(value, keyBase64) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), nonce);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `v1.${nonce.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${data.toString('base64')}`;
}

test('BV-01 guard refuses a production-looking target even when --allow-remote is set', () => {
  const local = guardTargets({ host: '127.0.0.1', sourceSchema: 'phone_google_src', restoreSchema: 'celia_restore_ab' });
  assert.equal(local.ok, true, 'أسماء اختبار معزولة تمر على loopback');

  // غير loopback بلا إذن صريح: يُرفض.
  const implicit = guardTargets({ host: 'db.example.net', sourceSchema: 's', restoreSchema: 'r' });
  assert.equal(implicit.ok, false);
  assert.match(implicit.problems.join(' '), /--allow-remote/);

  // الإذن الصريح لا يفتح الباب للإنتاج: الأسماء المعلَّمة تُرفض دائمًا.
  const production = guardTargets({ host: 'prod-db.aivencloud.com', allowRemote: true, sourceSchema: 's', restoreSchema: 'r' });
  assert.equal(production.ok, false);
  assert.match(production.problems.join(' '), /نمط إنتاج/);

  // اسم مخطط إنتاج على مضيف محلي: مرفوض أيضًا.
  const nameOnly = guardTargets({ host: '127.0.0.1', sourceSchema: 'phone_google', restoreSchema: 'r' });
  assert.equal(nameOnly.ok, false);
});

test('BV-02 the restore target must differ from the source, or the evidence destroys itself', () => {
  const same = guardTargets({ host: '127.0.0.1', sourceSchema: 'celia_src', restoreSchema: 'celia_src' });
  assert.equal(same.ok, false);
  assert.match(same.problems.join(' '), /مخطط مختلف/);

  // حقن في الاسم لا يمر:Identifiers are restricted, not escaped after the fact.
  const injected = guardTargets({ host: '127.0.0.1', sourceSchema: 'celia_src', restoreSchema: 'x`; DROP DATABASE y; --' });
  assert.equal(injected.ok, false);
  assert.match(injected.problems.join(' '), /غير صالح/);
});

test('BV-03 a derived dump is byte-stable and self-identifying', () => {
  const args = {
    schema: 'celia_src',
    tables: { app_users: [{ id: 'u1', email: 'owner@example.test' }] },
    capturedAt: '2026-11-04T10:00:00.000Z',
    commit: 'a'.repeat(40)
  };
  const first = deriveDump(args);
  const again = deriveDump(args);
  assert.equal(first.sha256, again.sha256, 'نفس المدخل ⇒ نفس البصمة (قابل للمقارنة عبر الزمن)');
  assert.equal(first.payload.format, 'celia-derived-backup/v1');
  assert.equal(first.payload.capturedAt, '2026-11-04T10:00:00.000Z');

  // الوقت ليس في البصمة صدفةً: تغييره يجب أن يغيّرها.
  const later = deriveDump({ ...args, capturedAt: '2026-11-04T11:00:00.000Z' });
  assert.notEqual(first.sha256, later.sha256);
  // ولا كلمة مرور في أي بايت من النسخة.
  assert.equal(first.bytes.toString('utf8').includes('password'), false);
});

test('BV-04 fingerprint comparison names every difference instead of saying "differs"', () => {
  const source = [
    { table: 'app_users', rows: 2, checksum: '111' },
    { table: 'whatsapp_messages', rows: 5, checksum: '222' }
  ];
  const identical = compareFingerprints(source, structuredClone(source));
  assert.equal(identical.ok, true);
  assert.deepEqual(identical.diffs, []);

  const broken = compareFingerprints(source, [
    { table: 'app_users', rows: 2, checksum: '999' },   // بصمة مختلفة، نفس العدد
    { table: 'whatsapp_contacts', rows: 1, checksum: '333' } // جدول زائد، وثانيه مفقود
  ]);
  assert.equal(broken.ok, false);
  const kinds = broken.diffs.map((d) => `${d.table}:${d.kind}`).sort();
  assert.deepEqual(kinds, [
    'app_users:checksum',
    'whatsapp_contacts:unexpected',
    'whatsapp_messages:missing'
  ]);
});

test('BV-05 row counts alone never prove a restore: same count, different checksum fails', () => {
  const result = compareFingerprints(
    [{ table: 'whatsapp_messages', rows: 1, checksum: 'abc' }],
    [{ table: 'whatsapp_messages', rows: 1, checksum: 'def' }]
  );
  assert.equal(result.ok, false, 'العدد متساوٍ لكن المحتوى مختلف — هذا هو الفرق الذي يهم');
  assert.equal(result.diffs[0].kind, 'checksum');
});

test('BV-06 a backup that cannot be decrypted is reported as such, and never as verified', () => {
  const good = encryptV1({ refresh_token: 'synthetic-only' }, KEY);

  const decrypted = keyProof({ values: [good], keyBase64: KEY });
  assert.equal(decrypted.status, 'decrypted');
  assert.equal(decrypted.decrypted, 1);

  // بلا مفتاح: الملف موجود لكنه لا يفكّ شيئًا.
  assert.equal(keyProof({ values: [good], keyBase64: null }).status, 'undecryptable');
  // بمفتاح آخر: نفس الحكم، لا صمت.
  assert.equal(keyProof({ values: [good], keyBase64: Buffer.alloc(32, 9).toString('base64') }).status, 'undecryptable');
  // مفتاح بطول خاطئ.
  assert.equal(keyProof({ values: [good], keyBase64: 'c2hvcnQ=' }).status, 'undecryptable');
  // تالف جزئيًا: صف واحد يكفي لإسقاط الحكم، لأن نسخة نصفها مقروء ليست نسخة.
  const partial = keyProof({ values: [good, 'v1.broken'], keyBase64: KEY });
  assert.equal(partial.status, 'undecryptable');
  assert.equal(partial.decrypted, 1);
  assert.equal(partial.failed, 1);
  // لا عمود مشفّر: حالة صريحة ثالثة، لا «مستعاد» مضلّل.
  assert.equal(keyProof({ values: [], keyBase64: KEY }).status, 'no_encrypted_columns');
});

test('BV-07 RPO is measured or declared unmeasurable — never estimated, never zero by default', () => {
  // فارق معروف ⇒ رقم.
  const known = measureRpoRto({
    dumpTakenAt: '2026-11-04T10:00:00.000Z',
    dataThroughAt: '2026-11-04T09:45:00.000Z',
    startedAt: '2026-11-04T10:00:00.000Z',
    restoredAt: '2026-11-04T10:02:30.000Z'
  });
  assert.equal(known.rpoMinutes, 15);
  assert.equal(known.rtoSeconds, 150);
  assert.equal(known.rpoReason, null, 'الرقم المقيس لا يحمل سببًا');

  // بلا إعلان تغطية البيانات ⇒ null + سبب. لا صفر.
  const unknown = measureRpoRto({
    dumpTakenAt: '2026-11-04T10:00:00.000Z',
    startedAt: '2026-11-04T10:00:00.000Z',
    restoredAt: '2026-11-04T10:01:00.000Z'
  });
  assert.equal(unknown.rpoMinutes, null);
  assert.match(unknown.rpoReason, /غير مقيس/);

  // أساس غير متسق (نسخة أحدث من البيانات المعلنة) يُرفض بدل أن يعطي رقمًا سالبًا يبدو جيدًا.
  const contradictory = measureRpoRto({
    dumpTakenAt: '2026-11-04T10:00:00.000Z',
    dataThroughAt: '2026-11-04T10:05:00.000Z',
    startedAt: '2026-11-04T10:00:00.000Z',
    restoredAt: '2026-11-04T10:01:00.000Z'
  });
  assert.equal(contradictory.rpoMinutes, null);
  assert.match(contradictory.rpoReason, /غير متسق/);
  assert.equal(contradictory.rtoSeconds, 60, 'RTO مستقل عن اتساق RPO');
});

test('BV-08 the report never leaks the credential it used', () => {
  const password = 'synthetic-password-xyz';
  const error = new Error(`Access denied for user 'root' using password ${password} at 127.0.0.1`);
  const scrubbed = scrub(error.message, [password]);
  assert.equal(scrubbed.includes(password), false);
  assert.match(scrubbed, /\[redacted\]/);
  // نص عادي بلا أسرار لا يُشوَّه.
  assert.equal(scrub('الاستعادة نجحت', [password]), 'الاستعادة نجحت');
});

test('BV-09 the version is explicit, so an old report is never mistaken for new code', () => {
  assert.match(BACKUP_VERIFY_VERSION, /^\d+$/);
  assert.equal(Number(BACKUP_VERIFY_VERSION) >= 1, true);
});
