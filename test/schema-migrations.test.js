/**
 * SM-01..SM-10 — سجل الترحيلات (`src/schema-migrations.js`) بلا MySQL.
 *
 * القاعدة الحاكمة: MySQL يثبّت الـDDL ضمناً، فلا يجوز أن يدّعي المدقّق معاملة واحدة.
 * هذا الملف يثبت السلوك كله على اتصال وهمي — لا شبكة ولا قاعدة — بينما يبقى
 * التطبيق الحيّ على MySQL في `integration/mysql.integration.mjs` (وظيفة CI).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { listMigrations, runMigrations, statementsOf, LEDGER_DDL } from '../src/schema-migrations.js';

const LEDGER_COUNT = "SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations'";

/** اتصال mysql2 وهمي: يسجّل كل أمر ولا يتصل بأي شيء. */
function fakeConnection({ failOn = null } = {}) {
  const state = { hasLedger: false, rows: [], executed: [] };
  const connection = {
    async query({ sql }, parameters = []) {
      const text = String(sql).trim();
      state.executed.push(text);
      if (text === LEDGER_COUNT) return [[{ total: state.hasLedger ? 1 : 0 }], []];
      if (text.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) {
        state.hasLedger = true;
        return [{}, []];
      }
      if (text.startsWith('SELECT version, name, checksum, applied_at FROM schema_migrations')) {
        return [state.rows.map((row) => ({ ...row })), []];
      }
      if (text.startsWith('INSERT INTO schema_migrations')) {
        const [version, name, checksum, applied_at] = parameters;
        state.rows.push({ version, name, checksum, applied_at });
        return [{}, []];
      }
      const failure = failOn?.(text);
      if (failure) throw failure;
      return [{}, []];
    }
  };
  return { connection, state };
}

async function migrationsDir(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'celia-migrations-'));
  for (const [name, source] of Object.entries(files)) await writeFile(path.join(dir, name), source);
  return dir;
}

const FIRST = '0002_alpha.sql';
const SECOND = '0003_beta.sql';
const SIMPLE = {
  [FIRST]: '-- additive only\nCREATE TABLE IF NOT EXISTS a (id INT);\nCREATE INDEX IF NOT EXISTS a_idx ON a (id);\n',
  [SECOND]: 'CREATE TABLE IF NOT EXISTS b (id INT);\n'
};

test('SM-01: dry-run على قاعدة بلا ledger لا ينفّذ أي DDL ويعدّد المعلّق كلّه', async () => {
  const dir = await migrationsDir(SIMPLE);
  try {
    const { connection, state } = fakeConnection();
    const report = await runMigrations({ connection, directory: dir });
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.ledger, 'missing');
    assert.equal(report.wouldCreateLedger, true);
    assert.deepEqual(report.applied, []);
    assert.deepEqual(report.pending.map((row) => row.name), [FIRST, SECOND]);
    assert.equal(report.pending[0].statements, 2, 'التعليقات مستبعدة والملف فيه أمران');
    assert.equal(state.hasLedger, false, 'الفحص الجاف لا ينشئ الجدول');
    assert.equal(state.executed.filter((sql) => sql !== LEDGER_COUNT).length, 0, 'لا أمر تنفيذي واحد');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SM-02: status يقرأ ولا يكتب حتى لو كان ledger مفقوداً', async () => {
  const dir = await migrationsDir(SIMPLE);
  try {
    const { connection, state } = fakeConnection();
    const report = await runMigrations({ connection, directory: dir, statusOnly: true });
    assert.equal(report.mode, 'status');
    assert.equal(state.hasLedger, false);
    assert.equal(state.executed.filter((sql) => sql.startsWith('INSERT')).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SM-03: apply ينشئ السجل ويطبّق بالترتيب ويسجّل بصمة SHA-256 لكل ملف', async () => {
  const dir = await migrationsDir(SIMPLE);
  try {
    const { connection, state } = fakeConnection();
    const report = await runMigrations({
      connection,
      directory: dir,
      apply: true,
      now: () => '2026-11-04T00:00:00Z'
    });
    assert.equal(report.mode, 'apply');
    assert.equal(report.ledger, 'present');
    assert.deepEqual(report.appliedNow, [FIRST, SECOND]);
    assert.deepEqual(state.rows.map((row) => row.name), [FIRST, SECOND]);
    assert.equal(state.rows[0].applied_at, '2026-11-04T00:00:00Z');
    const expected = crypto.createHash('sha256').update(SIMPLE[FIRST], 'utf8').digest('hex');
    assert.equal(state.rows[0].checksum, expected);

    const ddl = state.executed.indexOf(LEDGER_DDL);
    const firstStatement = state.executed.findIndex((sql) => sql.includes('CREATE TABLE IF NOT EXISTS a'));
    assert.ok(ddl !== -1 && ddl < firstStatement, 'السجل يُنشأ قبل أول ترحيل');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SM-04: التشغيل الثاني متطابق النتيجة ولا يعيد أي ترحيل (idempotent)', async () => {
  const dir = await migrationsDir(SIMPLE);
  try {
    const { connection, state } = fakeConnection();
    await runMigrations({ connection, directory: dir, apply: true, now: () => 'T1' });
    const rowsAfterFirst = state.rows.length;
    const executedAfterFirst = state.executed.length;
    const second = await runMigrations({ connection, directory: dir, apply: true, now: () => 'T2' });
    assert.deepEqual(second.pending, []);
    assert.deepEqual(second.appliedNow, []);
    assert.equal(state.rows.length, rowsAfterFirst, 'لا صفوف سجل مكرَّرة');
    const replayed = state.executed.slice(executedAfterFirst).filter((sql) => sql.includes('CREATE TABLE'));
    assert.equal(replayed.length, 0, 'لا إعادة تنفيذ لأي أمر');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SM-05: تغيير ملف مُطبَّق يرفض بخطأ drift مسمّى ولا ينفّذ شيئاً', async () => {
  const dir = await migrationsDir(SIMPLE);
  try {
    const { connection, state } = fakeConnection();
    await runMigrations({ connection, directory: dir, apply: true, now: () => 'T1' });
    const executedBefore = state.executed.length;
    await writeFile(path.join(dir, FIRST), 'ALTER TABLE a ADD COLUMN extra INT;\n');
    await assert.rejects(
      () => runMigrations({ connection, directory: dir, apply: true }),
      (error) => {
        assert.match(error.message, /Applied migration changed on disk/);
        assert.match(error.message, new RegExp(FIRST));
        assert.match(error.message, /Add a new migration instead of editing history/);
        return true;
      }
    );
    assert.equal(state.rows.length, 2, 'السجل لم يتغيّر');
    assert.equal(
      state.executed.slice(executedBefore).filter((sql) => sql.includes('ALTER TABLE')).length,
      0,
      'لا تنفيذ للتعديل المرفوض'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SM-06: تغيير الاسم مع بقاء الرقم يُعدّ drift أيضاً', async () => {
  const dir = await migrationsDir(SIMPLE);
  try {
    const { connection } = fakeConnection();
    await runMigrations({ connection, directory: dir, apply: true, now: () => 'T1' });
    await rm(path.join(dir, SECOND));
    await writeFile(path.join(dir, '0003_renamed.sql'), SIMPLE[SECOND]);
    await assert.rejects(
      () => runMigrations({ connection, directory: dir, apply: true }),
      /Applied migration changed on disk/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SM-07: فشل في منتصف الملف لا يُسجَّل ترحيلاً ويسمّي الملف والسبب بلا ادعاء معاملة', async () => {
  const dir = await migrationsDir({
    [FIRST]: 'CREATE TABLE IF NOT EXISTS a (id INT);\nCREATE TABLE IF NOT EXISTS boom (id INT);\nCREATE TABLE IF NOT EXISTS c (id INT);\n'
  });
  try {
    const failure = Object.assign(new Error('syntax'), { code: 'ER_PARSE_ERROR' });
    const { connection, state } = fakeConnection({
      failOn: (sql) => (sql.includes('boom') ? failure : null)
    });
    await assert.rejects(
      () => runMigrations({ connection, directory: dir, apply: true }),
      (error) => {
        assert.match(error.message, new RegExp(`Migration ${FIRST} failed \\(ER_PARSE_ERROR\\)`));
        assert.match(error.message, /MySQL commits DDL implicitly/);
        assert.match(error.message, /Nothing was dropped/);
        return true;
      }
    );
    assert.equal(state.rows.length, 0, 'لا صف سجل لملف فشل في منتصفه');
    assert.ok(
      state.executed.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS a')),
      'الأوامر السابقة للفشل قد تكون نُفّذت فعلاً — والرسالة تقول ذلك صراحة'
    );
    assert.equal(
      state.executed.some((sql) => sql.includes('IF NOT EXISTS c')),
      false,
      'التوقف عند أول فشل لا يكمل بقية الملف'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SM-08: ملفان برقم إصدار واحد يرفضان قبل أي اتصال', async () => {
  const dir = await migrationsDir({
    '0004_one.sql': 'CREATE TABLE IF NOT EXISTS one (id INT);\n',
    '0004_two.sql': 'CREATE TABLE IF NOT EXISTS two (id INT);\n'
  });
  try {
    await assert.rejects(() => listMigrations(dir), /Duplicate migration version numbers/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SM-09: DELIMITER غير مدعوم ويُرفض صراحةً بدل تحليل خاطئ صامت', () => {
  assert.throws(() => statementsOf('DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\n'), /DELIMITER blocks are not supported/);
  assert.deepEqual(statementsOf('-- c\nSELECT 1;\n\nSELECT 2;\n'), ['SELECT 1', 'SELECT 2']);
});

test('SM-10: لا يُستدعى سجل الترحيلات عند إقلاع الخادم', () => {
  for (const file of ['src/server.js', 'src/bootstrap-schema.js']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.equal(/schema-migrations|runMigrations/.test(source), false, `${file} لا يستدعي الترحيل عند الإقلاع`);
  }
  const cli = readFileSync(new URL('../scripts/migrate.mjs', import.meta.url), 'utf8');
  assert.match(cli, /runMigrations/, 'المسار الوحيد هو CLI صريح');
});
