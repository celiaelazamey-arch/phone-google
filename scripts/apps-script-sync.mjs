#!/usr/bin/env node
/**
 * `apps-script:sync` — يجعل «متزامن» حالةً **يمكن إثباتها**، لا ادّعاءً.
 *
 * المشكلة التي يحلها: لصق الملفات في محرّر Apps Script يعني نسختين من الحقيقة — واحدة في Git
 * وأخرى في Drive. وبعد أول تعديل في المحرّر تصبح النسختان مختلفتين **بلا أن يعرف أحد**. هذا
 * الأمر يجعل الاختلاف مرئيًا قبل أن يكبر.
 *
 *   --check   يُثبت أن الملفات المحلية تطابق `apps-script.lock.json` (بصمة SHA-256 لكل ملف)،
 *             وأن كل ملف `.gs` مُعلن في القفل، وأن البيان `appsscript.json` يعلن أذونات محدودة.
 *             يُشغَّل في CI؛ يفشل عند أي انحراف.
 *   --push    يدفع الملفات إلى المشروع عبر `clasp` ثم يحدّث القفل.
 *   --pull    يسحب من المحرّر ويُظهر الفرق، **ولا يحدّث القفل** إلا مع `--accept`: تعديل جرى في
 *             Drive يجب أن يُراجَع لا أن يُعتمد صامتًا.
 *
 * **حدّ صريح:** `--push` و`--pull` يحتاجان `clasp login` بحسابك واتصالًا بـ`script.googleapis.com`.
 * لا يعملان في بيئة الوكيل، ولم يُختبرا هناك. المقيس والمختبَر هنا هو منطق القفل والانحراف.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const ROOT = 'deploy/apps-script';
export const LOCK = path.join(ROOT, 'apps-script.lock.json');
export const MANIFEST = path.join(ROOT, 'appsscript.json');
export const CLASP_VERSION = '3.4.1';

/** الأذونات التي يحتاجها الكود فعلًا — ولا شيء غيرها. */
export const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/script.external_request', // UrlFetchApp
  'https://www.googleapis.com/auth/script.send_mail', // MailApp
  'https://www.googleapis.com/auth/script.scriptapp' // ScriptApp triggers
];

/** أذونات واسعة تُرفض: لا حاجة لها، ومنحها يوسّع الأثر عند أي خطأ. */
const FORBIDDEN_SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/script.scriptapp.readonly.deprecated',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email.readonly.deprecated'
];

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** كل ملف يُدفع فعلًا: `.gs` والبيان. ملفات أخرى لا تُلمس. */
export function projectFiles(root = ROOT) {
  const entries = readdirSync(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith('.gs') || entry.name === 'appsscript.json'))
    .map((entry) => entry.name)
    .sort();
}

export function fingerprintTree(root = ROOT) {
  const files = projectFiles(root);
  const hashes = {};
  for (const name of files) hashes[name] = sha256(readFileSync(path.join(root, name)));
  return { files, hashes };
}

/**
 * الغرض: أن يكشف `--check` أي تغيير — في الملف، أو ملف جديد لم يُعلن، أو ملف محذوف.
 * الحذف هو الحالة التي تُنسى عادة: القفل يحوي اسمًا لم يبق له ملف.
 */
export function diffAgainstLock({ files, hashes }, lock) {
  const problems = [];
  const locked = lock?.files ?? {};
  for (const name of files) {
    if (!Object.hasOwn(locked, name)) problems.push({ kind: 'unlocked', file: name });
    else if (locked[name] !== hashes[name]) problems.push({ kind: 'changed', file: name });
  }
  for (const name of Object.keys(locked)) {
    if (!files.includes(name)) problems.push({ kind: 'missing', file: name });
  }
  return problems;
}

/** البيان يجب أن يعلن الأذونات المطلوبة وحدها. منح أوسع = أثر أوسع عند أي ثغرة. */
export function auditManifest(manifest) {
  const problems = [];
  const scopes = manifest?.oauthScopes ?? [];
  for (const required of REQUIRED_SCOPES) {
    if (!scopes.includes(required)) problems.push({ kind: 'scope-missing', scope: required });
  }
  for (const scope of scopes) {
    if (FORBIDDEN_SCOPES.includes(scope)) problems.push({ kind: 'scope-too-broad', scope });
  }
  if (!manifest?.timeZone) problems.push({ kind: 'manifest', detail: 'timeZone مطلوب: المُشغّلات تعتمد عليه' });
  if (manifest?.runtimeVersion && manifest.runtimeVersion !== 'V8') {
    problems.push({ kind: 'manifest', detail: `runtimeVersion=${manifest.runtimeVersion}: الكود يستخدم let/const` });
  }
  return problems;
}

/** لا سرّ يُدفع إلى Drive: نفس القاعدة المطبَّقة على المستودع. */
export function auditSecrets(text) {
  const patterns = [
    /Bearer\s+[A-Za-z0-9._~+/-]{20,}/,
    /AIza[0-9A-Za-z_-]{35}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /["'](?:SECRET_TOKEN|ALERT_EMAIL|SERVICE_URL)["']\s*:\s*["'][^"']+["']/
  ];
  return patterns.filter((pattern) => pattern.test(text)).map((pattern) => String(pattern));
}

function clasp(args, { dryRun }) {
  const command = ['--yes', `@google/clasp@${CLASP_VERSION}`, ...args];
  if (dryRun) return `(dry-run) npx ${command.join(' ')}`;
  return execFileSync('npx', command, { encoding: 'utf8', stdio: 'pipe' });
}

function main() {
  const argv = process.argv.slice(2);
  const mode = argv.find((arg) => ['--check', '--push', '--pull'].includes(arg)) ?? '--check';
  const accept = argv.includes('--accept');
  const dryRun = argv.includes('--dry-run');

  const tree = fingerprintTree();
  const lock = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')) : null;
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : null;

  if (mode === '--check') {
    const problems = [
      ...diffAgainstLock(tree, lock).map((p) => `${p.kind}: ${p.file}`),
      ...auditManifest(manifest).map((p) => (p.scope ? `${p.kind}: ${p.scope}` : `${p.kind}: ${p.detail}`))
    ];
    const allText = tree.files.map((name) => readFileSync(path.join(ROOT, name), 'utf8')).join('\n');
    for (const hit of auditSecrets(allText)) problems.push(`secret-pattern: ${hit}`);
    if (problems.length) {
      console.error('apps-script:sync — انحراف مقيس:');
      for (const problem of problems) console.error(`  - ${problem}`);
      console.error('\nإن كان التغيير مقصودًا: npm run apps-script:sync -- --push');
      process.exitCode = 1;
      return;
    }
    console.log(`apps-script:sync — مطابق (${tree.files.length} ملفًا · ${Object.keys(lock.files).length} في القفل)`);
    return;
  }

  if (mode === '--push') {
    // A push without a clean local state could ship an uncommitted edit; refuse first.
    const problems = diffAgainstLock(tree, lock).map((p) => `${p.kind}: ${p.file}`);
    if (problems.length) console.log(`ملاحظة: ${problems.length} انحرافًا قبل الدفع (يُحدَّث القفل بعده)`);
    console.log(clasp(['push', '--force'], { dryRun }));
    if (!dryRun) {
      writeFileSync(LOCK, `${JSON.stringify({
        note: 'بصمات تُقارَن في CI. أي تعديل في محرّر Apps Script يظهر انحرافًا حتى يُسحب ويُراجَع.',
        claspVersion: CLASP_VERSION,
        files: tree.hashes
      }, null, 2)}\n`);
      console.log(`حُدِّث ${LOCK}`);
    }
    return;
  }

  if (mode === '--pull') {
    console.log(clasp(['pull'], { dryRun }));
    if (dryRun) return;
    const after = fingerprintTree();
    const changes = diffAgainstLock(after, lock);
    if (!accept) {
      console.log('\nالفرق بعد السحب (لم يُحدَّث القفل):');
      for (const change of changes) console.log(`  - ${change.kind}: ${change.file}`);
      console.log('\nراجع الفرق ثم: --pull --accept لتثبيت القفل. تعديل جرى في Drive لا يُعتمد صامتًا.');
      if (changes.length) process.exitCode = 1;
      return;
    }
    writeFileSync(LOCK, `${JSON.stringify({
      note: 'بصمات تُقارَن في CI. أي تعديل في محرّر Apps Script يظهر انحرافًا حتى يُسحب ويُراجَع.',
      claspVersion: CLASP_VERSION,
      files: after.hashes
    }, null, 2)}\n`);
    console.log(`اعتُمد السحب وحُدِّث ${LOCK}`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
