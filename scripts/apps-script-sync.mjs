#!/usr/bin/env node
/**
 * `apps-script:sync` — مزامنة آمنة بين مصدر Apps Script في المستودع ونسخة clasp العاملة.
 *
 * القاعدة التي بُني عليها الأمر: **لا تُقال «متزامن» عن شيء لم يُقَس فرقه**.
 *
 *   - الافتراضي (بلا أعلام) فحص جاف فقط: يقرأ الشجرتين، يسمّي الفرق ملفًا ملفًا،
 *     لا يكتب بايتًا واحدًا ولا يستدعي clasp ولا شبكة.
 *   - `--pull` وحده: يسحب بنسخة العمل (`clasp pull` داخل `--work-dir`) ثم يعرض الفرق
 *     ضد مصدر المستودع — مصدر المستودع **لا يُلمَس**.
 *   - `--pull --accept` وحده يطبّق: بعد عرض الفرق نفسه، تُنسخ النسخة المسحوبة فوق
 *     `deploy/apps-script/` مع نسخة احتياطية خارج Git في `.validation-artifacts/`.
 *   - `--push` مرفوض صراحةً: الرفع إلى Google تعديل خارجي يحتاج قرار مالك مستقلًا،
 *     ولا يُعاد إرساله تلقائيًا بعد أي انقطاع (قاعدة عدم إعادة الإرسال الأعمى).
 *
 * المتطلبات الحقيقية لأي سحب فعلي (كلها عند المالك، لا تُختلَق هنا):
 *   1. `npx @google/clasp login` مرة واحدة بحساب المالك ⇒ ينشئ `~/.clasprc.json`.
 *   2. `SCRIPT_ID` من رابط المشروع (الجزء بعد `/projects/`) عبر `--script-id`
 *      أو `CELIA_APPS_SCRIPT_ID` أو `.clasp.json` داخل نسخة العمل.
 *
 * الاستخدام:
 *   npm run apps-script:sync                                  # فحص جاف
 *   npm run apps-script:sync -- --json                        # فحص جاف JSON
 *   npm run apps-script:sync -- --clone --script-id <ID>      # clasp clone في نسخة العمل
 *   npm run apps-script:sync -- --pull                        # سحب + عرض الفرق (بلا تطبيق)
 *   npm run apps-script:sync -- --pull --accept               # سحب + تطبيق بعد الفرق
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APPS_SCRIPT_SYNC_VERSION = '1';

/** ملفات آلة محلية لا تدخل المقارنة أبدًا: تحمل معرّفات/حالة جهاز المالك لا مصدرًا. */
const IGNORED_NAMES = new Set(['.clasp.json', '.git', 'node_modules', '.celia-pull-staging']);

/** أنماط لا يجب أن تصل إلى المستودع أبدًا؛ وجودها في النسخة المسحوبة يوقف القبول. */
const SECRET_PATTERNS = [/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, /\bAIza[0-9A-Za-z_-]{20,}\b/, /\b(?:ghp|gho)_[0-9A-Za-z]{20,}\b/];

export function parseArgs(argv = []) {
  const args = { mode: 'dry-run', accept: false, json: false, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const [flag, inline] = token.startsWith('--') ? token.split(/=(.*)/s).filter((_, idx) => idx < 2) : [null, null];
    const value = () => inline ?? argv[++i];
    if (flag === '--pull') args.mode = 'pull';
    else if (flag === '--clone') args.mode = 'clone';
    else if (flag === '--push') args.mode = 'push';
    else if (flag === '--dry-run') args.mode = 'dry-run';
    else if (flag === '--accept') args.accept = true;
    else if (flag === '--json') args.json = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else if (flag === '--script-id') args.scriptId = value();
    else if (flag === '--work-dir') args.workDir = value();
    else if (flag === '--local-dir') args.localDir = value();
    else args.unknown.push(token);
  }
  return args;
}

/** المعرّف ليس سرًّا لكنه معرّف مشروع خاص؛ يُعرض مقنّعًا في كل تقرير. */
export function maskScriptId(scriptId) {
  const id = String(scriptId || '');
  if (id.length <= 10) return id ? '***' : null;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

export function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

const toPosix = (p) => p.split(path.sep).join('/');

/** لقطة شجرة كاملة بالبصمات والمحتوى، مرتبة باسم الملف. غياب المجلد ⇒ `null` لا خطأ. */
export async function snapshotTree(dir) {
  if (!dir || !existsSync(dir)) return null;
  const files = new Map();
  async function walk(current, prefix = '') {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) {
        const content = await readFile(full);
        files.set(toPosix(rel), { sha256: hashContent(content), bytes: content.length, content });
      }
    }
  }
  await walk(dir);
  return files;
}

/**
 * الفرق مسمّى ملفًا ملفًا من منظور السحب (remote = النسخة المسحوبة/العاملة):
 * `added` = عند البعيد فقط، `removed` = عند المحلي فقط، `changed` = بصمتان مختلفتان.
 */
export function diffSnapshots(local, remote) {
  const added = [], removed = [], changed = [], unchanged = [];
  for (const [name, file] of remote ?? []) {
    const other = local?.get(name);
    if (!other) added.push(name);
    else if (other.sha256 !== file.sha256) changed.push(name);
    else unchanged.push(name);
  }
  for (const name of local?.keys() ?? []) {
    if (!remote?.has(name)) removed.push(name);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort(), unchanged: unchanged.sort(),
    identical: added.length === 0 && removed.length === 0 && changed.length === 0 };
}

/** أسرار ظاهرة في أي ملف مسحوب تمنع القبول بالأسماء فقط — لا تُطبع القيمة أبدًا. */
export function scanForSecrets(snapshot) {
  const hits = [];
  for (const [name, file] of snapshot ?? []) {
    const text = file.content.toString('utf8');
    if (SECRET_PATTERNS.some((re) => re.test(text))) hits.push(name);
  }
  return hits.sort();
}

/**
 * فحص المتطلبات. يفشل مغلقًا ويسمّي كل ناقص بفعله عند المالك.
 * `mode: dry-run` لا يحتاج clasp ولا تسجيل دخول — النقص يُبلَّغ ولا يمنع قياس الفرق المحلي.
 */
export function assessPrerequisites({ mode, localExists, workExists, loginExists, scriptId }) {
  const missing = [];
  if (!localExists) missing.push({ code: 'local_source_missing', ownerAction: 'مصدر deploy/apps-script مفقود من المستودع' });
  if (mode !== 'dry-run' && !loginExists) {
    missing.push({ code: 'clasp_login_missing', ownerAction: 'شغّل مرة واحدة بحسابك: npx @google/clasp login (ينشئ ~/.clasprc.json)' });
  }
  if ((mode === 'clone') && !scriptId) {
    missing.push({ code: 'script_id_missing', ownerAction: 'مرّر --script-id <ID> (الجزء بعد /projects/ في رابط المشروع) أو CELIA_APPS_SCRIPT_ID' });
  }
  if (mode === 'pull' && !workExists) {
    missing.push({ code: 'work_dir_missing', ownerAction: 'انسخ أولًا: cp -r deploy/apps-script ~/celia-apps ثم clasp clone داخلها، أو مرّر --clone' });
  }
  if (mode === 'pull' && workExists && !scriptId) {
    missing.push({ code: 'script_id_missing', ownerAction: 'لا .clasp.json في نسخة العمل ولا --script-id: شغّل clasp clone <SCRIPT_ID> داخل نسخة العمل أولًا' });
  }
  // في الفحص الجاف، غياب نسخة العمل معلومة لا فشل بنيوي: يُقاس المحلي ويُسمّى الناقص.
  return { ok: missing.length === 0, missing };
}

async function readScriptId(workDir, explicit) {
  if (explicit) return explicit;
  if (process.env.CELIA_APPS_SCRIPT_ID) return process.env.CELIA_APPS_SCRIPT_ID;
  try {
    const parsed = JSON.parse(await readFile(path.join(workDir, '.clasp.json'), 'utf8'));
    return parsed.scriptId || null;
  } catch { return null; }
}

function defaultExec(command, argv, options) {
  const result = spawnSync(command, argv, { ...options, encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || result.error?.message || '' };
}

/**
 * النواة القابلة للاستدعاء. الـCLI غلاف حولها، والاختبارات تستدعيها بـ`exec` وهمي
 * فلا يوجد مسار «يُقاس في الاختبار لكن لا يعمل في الأمر» أو العكس.
 * لا شبكة ولا clasp إلا في وضعَي clone/pull صراحةً.
 */
export async function runAppsScriptSync({
  argv = [],
  env = process.env,
  homedir = os.homedir(),
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  exec = defaultExec,
  now = new Date(),
  log = () => {}
} = {}) {
  const args = parseArgs(argv);
  const localDir = path.resolve(args.localDir || path.join(repoRoot, 'deploy', 'apps-script'));
  const workDir = path.resolve(args.workDir || env.CELIA_APPS_DIR || path.join(homedir, 'celia-apps'));
  const report = {
    tool: 'apps-script-sync', version: APPS_SCRIPT_SYNC_VERSION,
    mode: args.mode, accept: args.accept, localDir, workDir,
    scriptId: null, steps: [], verdict: 'not-configured',
    remoteSynced: false, localModified: false
  };
  const finish = (verdict, exitCode) => { report.verdict = verdict; report.exitCode = exitCode; return report; };

  if (args.unknown.length) {
    report.problems = args.unknown.map((u) => `خيار غير معروف: ${u}`);
    return finish('failed', 1);
  }
  if (args.mode === 'push') {
    report.problems = ['--push مرفوض: الرفع إلى Google تعديل خارجي يحتاج قرار مالك مستقلًا ولا يُنفّذ من هذا الأمر'];
    return finish('refused', 2);
  }

  const localSnapshot = await snapshotTree(localDir);
  const loginExists = existsSync(path.join(homedir, '.clasprc.json'));
  const workExists = existsSync(workDir);
  const scriptId = await readScriptId(workDir, args.scriptId, env);
  report.scriptId = maskScriptId(scriptId);
  const prereq = assessPrerequisites({ mode: args.mode, localExists: Boolean(localSnapshot), workExists, loginExists, scriptId });
  report.prerequisites = prereq;
  report.steps.push({ step: 'snapshot-local', ok: Boolean(localSnapshot), files: localSnapshot?.size ?? 0 });

  if (args.mode === 'dry-run') {
    if (!localSnapshot) return finish('not-configured', 2);
    const workSnapshot = workExists ? await snapshotTree(workDir) : null;
    report.steps.push({ step: 'snapshot-work', ok: Boolean(workSnapshot), files: workSnapshot?.size ?? 0 });
    if (!workSnapshot) {
      report.nextOwnerActions = [
        'شغّل مرة واحدة بحسابك: npx @google/clasp login (ينشئ ~/.clasprc.json)',
        'انسخ مصدر المستودع إلى نسخة العمل: cp -r deploy/apps-script ~/celia-apps && cd ~/celia-apps',
        'داخل نسخة العمل: npx @google/clasp clone <SCRIPT_ID> (الجزء بعد /projects/ في رابط المشروع)',
        'ثم أعد: npm run apps-script:sync -- --pull لعرض الفرق قبل أي --accept'
      ];
      return finish('not-configured', 2);
    }
    report.diff = diffSnapshots(localSnapshot, workSnapshot);
    return report.diff.identical ? finish('identical', 0) : finish('differs', 1);
  }

  // clone / pull: من هنا فصاعدًا توجد شبكة وحساب مالك — أي نقص يوقف بلا ادّعاء.
  if (!prereq.ok) {
    report.nextOwnerActions = prereq.missing.map((m) => m.ownerAction);
    return finish('not-configured', 2);
  }

  if (args.mode === 'clone') {
    await mkdir(workDir, { recursive: true });
    const result = await exec('npx', ['-y', '@google/clasp', 'clone', scriptId], { cwd: workDir });
    report.steps.push({ step: 'clasp-clone', ok: result.status === 0 });
    if (result.status !== 0) { report.error = String(result.stderr).slice(0, 400); return finish('failed', 1); }
    report.remoteSynced = true;
    const cloned = await snapshotTree(workDir);
    report.diff = diffSnapshots(localSnapshot, cloned);
    return report.diff.identical ? finish('identical', 0) : finish('differs', 1);
  }

  // pull
  const result = await exec('npx', ['-y', '@google/clasp', 'pull'], { cwd: workDir });
  report.steps.push({ step: 'clasp-pull', ok: result.status === 0 });
  if (result.status !== 0) { report.error = String(result.stderr).slice(0, 400); return finish('failed', 1); }
  report.remoteSynced = true;

  const pulled = await snapshotTree(workDir);
  report.diff = diffSnapshots(localSnapshot, pulled);
  report.secretFiles = scanForSecrets(pulled);
  if (report.secretFiles.length) {
    report.problems = report.secretFiles.map((f) => `سرّ ظاهر في الملف المسحوب ${f}: القبول موقوف، راجع الملف يدويًا`);
    return finish('blocked-secret', 1);
  }
  if (report.diff.identical) return finish('identical', 0);
  if (!args.accept) return finish('diff-pending-review', 1);

  // --accept: نسخة احتياطية خارج Git أولًا، ثم تطبيق كامل (إضافة/تعديل/حذف) بأسماء معلنة.
  const stamp = now.toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const backupDir = path.join(repoRoot, '.validation-artifacts', `apps-script-backup-${stamp}`);
  await cp(localDir, backupDir, { recursive: true });
  report.backupDir = backupDir;
  for (const name of report.diff.removed) await rm(path.join(localDir, name), { force: true });
  for (const name of [...report.diff.added, ...report.diff.changed]) {
    const target = path.join(localDir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, pulled.get(name).content);
  }
  report.localModified = true;
  report.steps.push({ step: 'apply-accept', ok: true });
  const after = await snapshotTree(localDir);
  report.diffAfterAccept = diffSnapshots(after, pulled);
  return report.diffAfterAccept.identical ? finish('accepted', 0) : finish('failed', 1);
}

function formatReport(report) {
  const lines = [
    `apps-script:sync — الوضع ${report.mode}${report.accept ? ' --accept' : ''} · الحكم: ${report.verdict}`,
    `المحلي: ${report.localDir}`,
    `نسخة العمل: ${report.workDir}`,
    `SCRIPT_ID: ${report.scriptId ?? 'غير معروف'}`
  ];
  if (report.diff) {
    const d = report.diff;
    lines.push(`الفرق — مضاف: [${d.added.join(', ')}] · محذوف: [${d.removed.join(', ')}] · معدّل: [${d.changed.join(', ')}] · مطابق: ${d.unchanged.length} ملفًا`);
  }
  for (const action of report.nextOwnerActions ?? []) lines.push(`خطوة مالك: ${action}`);
  for (const problem of report.problems ?? []) lines.push(`مشكلة: ${problem}`);
  if (report.error) lines.push(`خطأ: ${report.error}`);
  if (report.backupDir) lines.push(`النسخة الاحتياطية قبل القبول: ${report.backupDir}`);
  lines.push(report.remoteSynced ? 'حالة البعيد: سُحب فعلًا في هذا التشغيل' : 'حالة البعيد: لم يُتّصل به في هذا التشغيل');
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('الاستخدام: npm run apps-script:sync -- [--pull [--accept] | --clone --script-id <ID> | --dry-run] [--json] [--work-dir DIR]');
    return;
  }
  const report = await runAppsScriptSync({ argv });
  console.log(parseArgs(argv).json ? JSON.stringify(report, (k, v) => (k === 'content' ? undefined : v), 2) : formatReport(report));
  process.exitCode = report.exitCode;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
