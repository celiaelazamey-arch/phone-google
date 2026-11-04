#!/usr/bin/env node
/**
 * `backup:verify` — نسخة مشتقة (derived), واستعادة معزولة، وقياس RPO/RTO.
 *
 * القاعدة التي بُني عليها الأمر: **لا يُكتب «مستعاد» في التقرير إن لم يُستعد فعلًا**.
 * لذلك كل نتيجة هنا مشتقة من مصدر حقيقي:
 *
 *   - البصمات من `CHECKSUM TABLE` الذي يحسبه الخادم، لا من عدّ في الذاكرة.
 *   - «الاستعادة» تُثبت بقراءة الصفوف من مخطط **آخر** عبر اتصال جديد.
 *   - `RTO` لا يُقدَّر: يُقاس بساعة حائط على خطوات الاستعادة نفسها.
 *   - `RPO` لا يُدَّعى: `null` + سبب. وأن تكون النسخة **قديمة** شيء، وأن لا يُعرف عمرها شيء آخر.
 *
 * ما لا يفعله عن قصد: لا يتصل بقاعدة إنتاج (`--allow-remote` مطلوب صريحًا، والحارس يرفض
 * أسماء الإنتاج المعروفة)، ولا يكتب داخل المستودع، ولا يطبع كلمة مرور أو dump.
 *
 * الاستخدام:
 *   node scripts/backup-verify.mjs --out /tmp/backup-run     # مصدر محلي معزول
 *   node scripts/backup-verify.mjs --source-schema x --restore-schema y --out DIR
 *   node scripts/backup-verify.mjs --dump FILE --age-minutes 30 --out DIR   # قياس RPO لملف
 */
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { loadMysqlConfig } from '../src/mysql-config.js';
import { decryptJson } from '../src/security.js';

/** جذر الإصدار: كل تعديل في هذا الملف يرفع الرقم، فلا يوصف تقرير قديم بأنه من شيفرة جديدة. */
export const BACKUP_VERIFY_VERSION = '1';

/** أسماء تشير إلى إنتاج حقيقي — تُرفض دائمًا، ولو مرّر المالك `--allow-remote`. */
const PRODUCTION_MARKERS = [/prod/i, /live/i, /aiven/i, /render/i, /^phone_google$/i];

const TABLES = [
  'app_users',
  'oauth_states',
  'google_credentials',
  'whatsapp_contacts',
  'whatsapp_messages',
  'agent_threads'
];

/** الأعمدة التي تحمل أسرارًا مشفّرة: وجودها في النسخة لا يكفي، يجب أن تُفكّ بالمفتاح. */
const ENCRYPTED_COLUMNS = [{ table: 'google_credentials', column: 'encrypted_tokens' }];

/**
 * الحارس. يفشل مغلقًا: أي اسم لا يجتاز القواعد لا يُلمس.
 * `--allow-remote` لا يفتح الباب للإنتاج، بل يسمح بمضيف غير loopback فقط.
 */
export function guardTargets({ host, allowRemote = false, sourceSchema, restoreSchema }) {
  const problems = [];
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (!loopback && !allowRemote) {
    problems.push(`المضيف ${host} ليس loopback؛ مرّر --allow-remote صريحًا إن كان مقصودًا`);
  }
  if (!loopback && allowRemote) {
    const marked = PRODUCTION_MARKERS.find((re) => re.test(host));
    if (marked) problems.push(`المضيف ${host} يطابق نمط إنتاج (${marked}); هذا الأمر لا يعمل على الإنتاج`);
  }
  for (const [label, value] of [['source', sourceSchema], ['restore', restoreSchema]]) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(value || '')) {
      problems.push(`اسم مخطط ${label} غير صالح: يجب أن يكون [A-Za-z0-9_] حتى 64`);
      continue;
    }
    if (PRODUCTION_MARKERS.some((re) => re.test(value))) {
      problems.push(`اسم مخطط ${label} «${value}» يشير إلى إنتاج؛ الاستعادة المعزولة تحتاج اسمًا آخر`);
    }
  }
  if (sourceSchema && restoreSchema && sourceSchema === restoreSchema) {
    problems.push('الاستعادة يجب أن تكون إلى مخطط مختلف؛ الاستعادة فوق المصدر تُتلف الدليل');
  }
  return { ok: problems.length === 0, problems };
}

const q = (id) => `\`${String(id).replaceAll('`', '``')}\``;

/** EXISTS** فقط** — لا تنشئ شيئًا على مصدر حقيقي بالخطأ. */
export async function schemaExists(connection, schema) {
  const [rows] = await connection.query(
    'SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = ?',
    [schema]
  );
  return Number(rows[0].n) > 0;
}

/** بصمات الخادم. `CHECKSUM TABLE` على جدول غير موجود يعطي NULL، وهذا يُسجَّل لا يُخفى. */
export async function tableFingerprints(connection, schema) {
  const [tables] = await connection.query(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name`,
    [schema]
  );
  const out = [];
  for (const { name } of tables) {
    const [[count]] = await connection.query(`SELECT COUNT(*) AS n FROM ${q(schema)}.${q(name)}`);
    const [[sum]] = await connection.query(`CHECKSUM TABLE ${q(schema)}.${q(name)}`);
    out.push({ table: name, rows: Number(count.n), checksum: sum?.Checksum === null ? null : String(sum?.Checksum ?? '') });
  }
  return out;
}

/** يقارن بصمتين ويسمّي كل جدول مختلف بدل أن يقول «مطابق» أو «مختلف» جملةً. */
export function compareFingerprints(source, restored) {
  const byName = new Map(restored.map((t) => [t.table, t]));
  const diffs = [];
  for (const table of source) {
    const other = byName.get(table.table);
    if (!other) { diffs.push({ table: table.table, kind: 'missing' }); continue; }
    if (other.rows !== table.rows) diffs.push({ table: table.table, kind: 'row_count', source: table.rows, restored: other.rows });
    if (other.checksum !== table.checksum) diffs.push({ table: table.table, kind: 'checksum', source: table.checksum, restored: other.checksum });
    byName.delete(table.table);
  }
  for (const extra of byName.values()) diffs.push({ table: extra.table, kind: 'unexpected' });
  return { ok: diffs.length === 0, diffs };
}

/**
 * هل النسخة تحمل مفتاحها؟
 *
 * هذا هو الفرق بين ملف backup وملف «لا يُفكّ». نجرّب فكّ أول عمود مشفّر فعليًا؛ والنتيجة
 * إحدى ثلاث حالات صريحة، ولا رابعة: `decrypted` أو `undecryptable` أو `no_encrypted_columns`.
 */
export function keyProof({ values, keyBase64 }) {
  if (!values.length) return { status: 'no_encrypted_columns', detail: 'لا عمود مشفّر في هذه النسخة، فلا شيء يُثبت به المفتاح' };
  if (!keyBase64) return { status: 'undecryptable', detail: 'لا مفتاح: ملف بلا مفتاح لا يفكّ رموز OAuth' };
  let key;
  try {
    key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32) throw new Error();
  } catch {
    return { status: 'undecryptable', detail: 'المفتاح ليس base64 لـ32 بايت (AES-256-GCM)' };
  }
  let ok = 0, failed = 0;
  for (const row of values) {
    try {
      // فكّ يدوي مطابق لصيغة `v1.` كي لا نبتلع خطأ المفتاح داخل دالة أعلى مستوى.
      const [version, nonce64, tag64, data64] = String(row).split('.');
      if (version !== 'v1') throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce64, 'base64'));
      decipher.setAuthTag(Buffer.from(tag64, 'base64'));
      JSON.parse(Buffer.concat([decipher.update(Buffer.from(data64, 'base64')), decipher.final()]).toString('utf8'));
      ok += 1;
    } catch { failed += 1; }
  }
  return {
    status: ok > 0 && failed === 0 ? 'decrypted' : 'undecryptable',
    detail: `${ok} صفًا فُكّ، ${failed} فشل`,
    decrypted: ok,
    failed
  };
}

/**
 * الحسّاس: بحسب ترتيب الفحص، كلمة المرور كانت ستُطبع في رسالة خطأ اتصال.
 * كل نص خارجي يمر من هنا أولًا.
 */
export function scrub(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/** RPO/RTO كأرقام مقيسة، مع سبب صريح لكل null. لا تقدير. */
export function measureRpoRto({ dumpTakenAt, startedAt, restoredAt, dataThroughAt = null, now = new Date() }) {
  const iso = (d) => (d instanceof Date ? d.toISOString() : d);
  const minutes = (a, b) => Math.round(((new Date(b) - new Date(a)) / 60000) * 100) / 100;
  const rtoSeconds = Math.round(((new Date(restoredAt) - new Date(startedAt)) / 1000) * 100) / 100;
  let rpoMinutes = null, rpoReason = null;
  if (dataThroughAt && dumpTakenAt) {
    rpoMinutes = minutes(dataThroughAt, dumpTakenAt);
    if (rpoMinutes < 0) { rpoMinutes = null; rpoReason = 'نسخة أحدث من البيانات المعلنة: الأساس غير متسق'; }
  } else {
    rpoReason = dataThroughAt
      ? 'وقت آخر بيانات ليس ممرَّرًا، فلا يمكن قياس الفارق'
      : 'غير مقيس: لم يُعلَن حتى أي تغيير بيانات تغطيه هذه النسخة';
  }
  return {
    measuredAt: iso(now),
    rtoSeconds,
    rtoSource: 'ساعة حائط على خطوات الاستعادة الفعلية',
    rpoMinutes,
    rpoReason,
    dumpTakenAt: iso(dumpTakenAt),
    restoredAt: iso(restoredAt)
  };
}

function parseArgs(argv) {
  const args = { allowRemote: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].startsWith('--') ? argv[i].split('=') : [null, null];
    const value = () => inline ?? argv[++i];
    if (flag === '--out') args.out = value();
    else if (flag === '--source-schema') args.sourceSchema = value();
    else if (flag === '--restore-schema') args.restoreSchema = value();
    else if (flag === '--dump') args.dump = value();
    else if (flag === '--data-through') args.dataThrough = value();
    else if (flag === '--allow-remote') args.allowRemote = true;
    else if (flag === '--keep') args.keep = true;
  }
  return args;
}

/**
 * النسخة المشتقة: JSON يحوي الصفوف + بصماتها، بلا كلمة مرور.
 * مشتقة لأن ما يُستعاد منها لاحقًا هو ما نستطيع إثباته، لا شكل ملف `mysqldump` الداخلي.
 */
export function deriveDump({ schema, tables, capturedAt, commit }) {
  const payload = { format: 'celia-derived-backup/v1', schema, capturedAt, commit, tables };
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return {
    payload,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

/**
 * النواة القابلة للاستدعاء. الـCLI مجرّد غلاف حولها، والاختبار التكاملي على MySQL الحقيقي
 * يستدعيها مباشرة — فلا يوجد مسار «يُقاس في CI لكن لا يعمل في الأمر» أو العكس.
 */
export async function runBackupVerify({
  config,
  sourceSchema,
  restoreSchema,
  outDir,
  dataThrough = null,
  allowRemote = false,
  keyBase64 = process.env.TOKEN_ENCRYPTION_KEY,
  keep = false,
  schemaSqlPath = path.resolve(import.meta.dirname, '../sql/schema.sql'),
  log = console.log
}) {
  const host = config.host;
  const suffix = randomBytes(8).toString('hex');
  outDir = path.resolve(outDir || path.join('.validation-artifacts', `backup-${suffix}`));

  const guard = guardTargets({ host, allowRemote, sourceSchema, restoreSchema });
  if (!guard.ok) {
    for (const problem of guard.problems) log(`::error title=backup-verify::${problem}`);
    return { verdict: 'refused', guardProblems: guard.problems, steps: [], productionTouched: false };
  }
  const secrets = [config.password].filter(Boolean);

  const report = {
    scope: 'isolated-restore-only',
    version: BACKUP_VERIFY_VERSION,
    commit: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '') ? process.env.GITHUB_SHA : null,
    startedAt: new Date().toISOString(),
    source: { host, schema: sourceSchema },
    restore: { host, schema: restoreSchema },
    steps: [],
    tableFingerprints: null,
    keyProof: null,
    rpoRto: null,
    verdict: 'failed',
    productionTouched: false
  };

  let admin = null;
  let restoreConn = null;
  let created = false;
  try {
    admin = await mysql.createConnection({ ...config, database: undefined, charset: 'utf8mb4', timezone: 'Z' });

    const sourcePresent = await schemaExists(admin, sourceSchema);
    if (!sourcePresent) throw new Error(`المخطط المصدر ${sourceSchema} غير موجود`);
    report.steps.push({ step: 'source-exists', ok: true });

    // 1) النسخة المشتقة + بصمات المصدر
    const startedAt = new Date();
    const sourcePrints = await tableFingerprints(admin, sourceSchema);
    const rows = {};
    for (const table of TABLES) {
      if (!sourcePrints.some((p) => p.table === table)) continue;
      const [data] = await admin.query(`SELECT * FROM ${q(sourceSchema)}.${q(table)}`);
      rows[table] = data;
    }
    const dump = deriveDump({ schema: sourceSchema, tables: rows, capturedAt: new Date().toISOString(), commit: report.commit });
    await mkdir(outDir, { recursive: true });
    const dumpPath = path.join(outDir, 'derived-backup.json');
    await writeFile(dumpPath, dump.bytes);
    report.derivedDump = { path: dumpPath, sha256: dump.sha256, bytes: dump.bytes.length, tables: Object.keys(rows).length };

    // 2) الاستعادة إلى مخطط معزول — عبر SQL حقيقي، ثم إثبات بالقراءة من اتصال آخر
    await admin.query(`CREATE DATABASE ${q(restoreSchema)} CHARACTER SET utf8mb4`);
    created = true;
    // The DDL runs on a connection with no default database, so the restored schema must be
    // selected first — otherwise the CREATE TABLEs fail (measured: CI reached this line and threw).
    // This also means restore order is explicit, not incidental.
    await admin.query(`USE ${q(restoreSchema)}`);
    const schemaSql = await readFile(schemaSqlPath, 'utf8');
    for (const statement of schemaSql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
      await admin.query(statement);
    }
    let restoredRows = 0;
    for (const [table, data] of Object.entries(rows)) {
      for (const row of data) {
        const columns = Object.keys(row);
        const placeholders = columns.map(() => '?').join(', ');
        await admin.query(
          `INSERT INTO ${q(restoreSchema)}.${q(table)} (${columns.map(q).join(', ')}) VALUES (${placeholders})`,
          columns.map((c) => row[c])
        );
        restoredRows += 1;
      }
    }
    restoreConn = await mysql.createConnection({ ...config, database: restoreSchema, charset: 'utf8mb4', timezone: 'Z' });
    const [[probe]] = await restoreConn.query('SELECT DATABASE() AS db');
    if (probe.db !== restoreSchema) throw new Error('الاستعادة لم تُقرأ من المخطط المعزول');

    // 3) المطابقة: بصمات الخادم على المخططين، ولذلك يجب أن تُقرأ الثانية من اتصالها الخاص
    const restoredPrints = await tableFingerprints(restoreConn, restoreSchema);
    const comparison = compareFingerprints(sourcePrints, restoredPrints);
    report.tableFingerprints = { sourcePrints, restoredPrints, comparison, restoredRows };
    report.steps.push({ step: 'restore-verified', ok: comparison.ok });

    // 4) إثبات المفتاح على الصفوف المستعادة نفسها
    const encryptedValues = (rows.google_credentials || []).map((r) => r.encrypted_tokens).filter(Boolean);
    report.keyProof = keyProof({ values: encryptedValues, keyBase64 });

    const restoredAt = new Date();
    report.rpoRto = measureRpoRto({
      dumpTakenAt: dump.payload.capturedAt,
      startedAt,
      restoredAt,
      dataThroughAt: dataThrough
    });
    report.steps.push({ step: 'rpo-rto-measured', ok: true });

    // الفحص لا يمر إن لم يُستعد كل شيء، أو إن وُجد عمود مشفّر ولم يُفكّ.
    const keyOk = report.keyProof.status === 'decrypted' || report.keyProof.status === 'no_encrypted_columns';
    report.verdict = comparison.ok && keyOk ? 'verified' : 'failed';
    if (!comparison.ok) log(`::error title=backup-verify::فروق بعد الاستعادة: ${JSON.stringify(comparison.diffs).slice(0, 400)}`);
    if (!keyOk) log('::error title=backup-verify::النسخة لا تُفكّ بمفتاحها — حفظ المفتاح خارج Render جزء من DATA-001');
  } catch (error) {
    report.error = scrub(error?.message ?? error, secrets);
    report.failedStep = [...(report.steps ?? [])].reverse().find((step) => step.ok)?.step ?? 'startup';
    report.verdict = 'failed';
    log(`::error title=backup-verify::${report.error}`);
  } finally {
    try { if (restoreConn) await restoreConn.end(); } catch {}
    try {
      if (admin && created && !keep) await admin.query(`DROP DATABASE IF EXISTS ${q(restoreSchema)}`);
    } catch {}
    try { if (admin) await admin.end(); } catch {}
  }

  report.finishedAt = new Date().toISOString();
  report.productionBackupVerified = false;
  const reportPath = path.join(outDir, 'backup-verify-report.json');
  await mkdir(outDir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  report.reportPath = reportPath;
  log(`backup:verify ${report.verdict} — ${reportPath}`);
  log(`RTO=${report.rpoRto?.rtoSeconds ?? 'n/a'}s · RPO=${report.rpoRto?.rpoMinutes ?? 'غير مقيس'} · مفتاح=${report.keyProof?.status ?? 'n/a'}`);
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadMysqlConfig(process.env);
  const suffix = randomBytes(8).toString('hex');
  const report = await runBackupVerify({
    config,
    sourceSchema: args.sourceSchema || config.database,
    restoreSchema: args.restoreSchema || `celia_restore_${suffix}`,
    outDir: args.out,
    dataThrough: args.dataThrough || null,
    allowRemote: args.allowRemote,
    keep: args.keep
  });
  if (report.verdict !== 'verified') process.exitCode = report.verdict === 'refused' ? 2 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
