#!/usr/bin/env node
/**
 * `apps-script:sync` — سحب مشاريع Apps Script من نسخة clasp المحلية إلى المستودع، خلف بوابة مراجعة.
 *
 * المالك يشغّل `clasp login` و`clasp clone` على جهازه (حسابه مطلوب)؛ هذه الأداة لا تتصل
 * بـ Google ولا تفتح أي اتصال شبكي. تقارن النسخة المحلية بنسخة المستودع فقط:
 *
 *   npm run apps-script:sync -- --pull            # معاينة: تعرض الفرق ولا تكتب شيئًا
 *   npm run apps-script:sync -- --pull --accept   # تطبيق بعد أن يراجع الإنسان الفرق
 *
 * القواعد الصلبة (DEC-142):
 *   - المعاينة هي الافتراض. لا يُكتب شيء بدون `--accept`.
 *   - ملفات الاعتماد (.clasprc.json، .env*، token.json، المفاتيح…) لا تُنسخ أبدًا،
 *     ووجودها في الوجهة لا يجعلها مرشحة للحذف.
 *   - أي ملف مصدري يلتقطه فاحص الأسرار المشترك يرفض المشروع كله، ويمنع التطبيق عن
 *     كل المشاريع (الكل أو لا شيء) — نصف مزامنة هي كيف يتسلل كود لم يُراجع.
 *   - الروابط الرمزية مرفوضة على الجانبين (رابط في الوجهة قد يعيد توجيه الكتابة خارج
 *     المشروع)، والملفات الثنائية مرفوضة — مشاريع Apps Script نصية.
 *   - سحب فقط. الدفع إلى Google يبقى قرار المالك يدويًا عبر `clasp push`.
 *   - المستودع عام: زامن فقط الكود الذي تقصد نشره.
 *
 * رموز الخروج: 0 متزامن/طُبّق · 1 فروق بانتظار المراجعة · 2 مدخل خاطئ أو رفض أمان.
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findSecret } from '../src/knowledge/validate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_SOURCE = path.join(os.homedir(), 'celia-apps');
export const DEFAULT_DEST = path.join(ROOT, 'apps-script');

/** ملفات لا تدخل المستودع أبدًا — تُستبعد وتُذكر بالاسم، لا تُحذف من الوجهة. */
export const EXCLUDED_FILE_PATTERNS = [
  /^\.clasprc(\..+)?\.json$/i,
  /^\.env($|\.)/i,
  /^credentials?\.json$/i,
  /^token\.json$/i,
  /^client_secret.*\.json$/i,
  /^service[-_]?account.*\.json$/i,
  /\.(pem|key|p12|pfx)$/i,
  /^\.DS_Store$/
];

export const IGNORED_DIRS = new Set(['node_modules', '.git']);
const PROTECTED_DEST_DIRS = ['.git', 'node_modules', 'src', 'scripts', 'test'];
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_DIFF_CELLS = 400_000;
const MAX_DIFF_SIDE = 1500;
const MAX_DIFF_BYTES = 256 * 1024;
const BINARY_SNIFF_BYTES = 8192;

export function isExcludedFile(name) {
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

/** يوسّع `~` في البداية حتى تتصرف المسارات المقتبسة ومتغيرات البيئة مثل الصدفة. */
export function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function looksBinary(buf) {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/**
 * حارس الوجهة: يفشل مغلقًا. لا كتابة إلى جذر المستودع أو أصل من أصوله، ولا إلى
 * المجلدات المحمية. كل كتابة فعلية تنحصر داخل `<dest>/<project>/`.
 */
export function guardDest(destRoot) {
  const dest = path.resolve(destRoot);
  const ancestorPrefix = dest.endsWith(path.sep) ? dest : dest + path.sep;
  if (dest === ROOT || ROOT.startsWith(ancestorPrefix)) {
    throw new Error(`destination ${dest} is the repository root or an ancestor of it — refusing`);
  }
  for (const dir of PROTECTED_DEST_DIRS) {
    const protectedPath = path.join(ROOT, dir);
    if (dest === protectedPath || dest.startsWith(protectedPath + path.sep)) {
      throw new Error(`destination ${dest} is inside ${dir}/ — refusing`);
    }
  }
  return dest;
}

async function isDirectory(target) {
  try {
    return (await lstat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * يمشي شجرة مشروع. يعيد ملفات خامًا + استبعادات مسماة (ملفات اعتماد) + رفضًا
 * (روابط رمزية). مجلدات IGNORED_DIRS تُتخطى — ضجيج بناء لا محتوى مشروع.
 */
export async function walkTree(root) {
  const files = new Map();
  const excluded = [];
  const refusals = [];
  const walk = async (dir, rel) => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        refusals.push({ file: relPath, reason: 'symlink' });
        continue;
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(abs, relPath);
      } else if (entry.isFile()) {
        if (isExcludedFile(entry.name)) {
          excluded.push(relPath);
          continue;
        }
        files.set(relPath, await readFile(abs));
      }
    }
  };
  await walk(root, '');
  return { files, excluded: excluded.sort(), refusals };
}

/**
 * ملفات المصدر يجب أن تكون نص UTF-8 نظيفًا بلا محتوى يشبه الاعتماد. ملف واحد
 * سيئ يرفض المشروع كله: المزامنة الجزئية هي كيف يتسلل كود لم يُراجع نصفه.
 */
export function inspectSource(files) {
  const refusals = [];
  for (const [rel, buf] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (looksBinary(buf)) {
      refusals.push({ file: rel, reason: 'binary' });
      continue;
    }
    const text = buf.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(buf)) {
      refusals.push({ file: rel, reason: 'binary' });
      continue;
    }
    const secret = findSecret(text);
    if (secret) refusals.push({ file: rel, reason: `secret:${secret}` });
  }
  return refusals;
}

/** فرق شجري على مستوى البايتات (لا طوابع زمنية). الترتيب يبقي التقرير حتميًا. */
export function diffTrees(srcFiles, destFiles) {
  const added = [];
  const modified = [];
  const deleted = [];
  const unchanged = [];
  for (const [rel, buf] of [...srcFiles.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!destFiles.has(rel)) added.push(rel);
    else if (!destFiles.get(rel).equals(buf)) modified.push(rel);
    else unchanged.push(rel);
  }
  for (const rel of [...destFiles.keys()].sort()) {
    if (!srcFiles.has(rel)) deleted.push(rel);
  }
  return { added, modified, deleted, unchanged };
}

function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push(['=', a[i]]); i += 1; j += 1; }
    else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { ops.push(['-', a[i]]); i += 1; }
    else { ops.push(['+', b[j]]); j += 1; }
  }
  while (i < n) { ops.push(['-', a[i]]); i += 1; }
  while (j < m) { ops.push(['+', b[j]]); j += 1; }
  return ops;
}

/**
 * فرق موحّد مدمج للمراجعة. يقلم البادئة/اللاحقة المشتركة أولًا ثم يحصر LCS
 * بميزانية خلايا. يعيد null عندما يكون الفرق أكبر من أن يُعرض بأمان (يطبع
 * المستدعي ملخصًا بدلًا منه)، و'' عندما يتطابق النصان.
 */
export function unifiedDiff(oldText, newText, { context = 3, maxCells = MAX_DIFF_CELLS, maxSide = MAX_DIFF_SIDE } = {}) {
  // نص فارغ = صفر أسطر، حتى تظهر الملفات المضافة كإضافات صافية بلا حذف سطر وهمي.
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (!midA.length && !midB.length) return '';
  if (midA.length > maxSide || midB.length > maxSide || midA.length * midB.length > maxCells) return null;
  const ops = [
    ...a.slice(0, start).map((line) => ['=', line]),
    ...lcsOps(midA, midB),
    ...a.slice(endA).map((line) => ['=', line])
  ];
  let oldLine = 1;
  let newLine = 1;
  const numbered = ops.map(([kind, text]) => {
    const item = { kind, text, oldLine: kind !== '+' ? oldLine : null, newLine: kind !== '-' ? newLine : null };
    if (kind !== '+') oldLine += 1;
    if (kind !== '-') newLine += 1;
    return item;
  });
  const changes = numbered.map((op, idx) => (op.kind !== '=' ? idx : -1)).filter((idx) => idx >= 0);
  if (!changes.length) return '';
  const groups = [];
  let groupStart = changes[0];
  let groupEnd = changes[0];
  for (let k = 1; k < changes.length; k += 1) {
    const idx = changes[k];
    if (idx - groupEnd - 1 <= context * 2) groupEnd = idx;
    else { groups.push([groupStart, groupEnd]); groupStart = idx; groupEnd = idx; }
  }
  groups.push([groupStart, groupEnd]);
  const lines = [];
  for (const [s, e] of groups) {
    const from = Math.max(0, s - context);
    const to = Math.min(numbered.length - 1, e + context);
    const slice = numbered.slice(from, to + 1);
    const oldCount = slice.filter((op) => op.kind !== '+').length;
    const newCount = slice.filter((op) => op.kind !== '-').length;
    const oldStart = slice.find((op) => op.oldLine != null)?.oldLine ?? 0;
    const newStart = slice.find((op) => op.newLine != null)?.newLine ?? 0;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) lines.push(`${op.kind === '=' ? ' ' : op.kind}${op.text}`);
  }
  return lines.join('\n');
}

/** يفك ترميز بافر للعرض؛ يعيد null للمحتوى الثنائي. */
function asText(buf) {
  if (!buf || looksBinary(buf)) return null;
  const text = buf.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buf) ? text : null;
}

/**
 * يعرض تغيير ملف واحد لتقرير المراجعة. محتوى يشبه الأسرار على أي جانب يكتم
 * الرقعة (اسم الملف يُذكر) — التقرير لا يحمل قيمة سرية أبدًا.
 */
export function renderFileChange(rel, kind, oldBuf, newBuf) {
  const header = `${kind === 'added' ? '+' : kind === 'deleted' ? '-' : '~'} ${rel}`;
  if ((oldBuf && oldBuf.length > MAX_DIFF_BYTES) || (newBuf && newBuf.length > MAX_DIFF_BYTES)) {
    return [header, `  (large file: ${oldBuf?.length ?? 0} → ${newBuf?.length ?? 0} bytes — summary only)`];
  }
  const oldText = oldBuf == null ? '' : asText(oldBuf);
  const newText = newBuf == null ? '' : asText(newBuf);
  if (oldText == null || newText == null) return [header, '  (binary content — no patch shown)'];
  if (findSecret(oldText) || findSecret(newText)) {
    return [header, '  (secret-shaped content — patch suppressed)'];
  }
  const patch = unifiedDiff(oldText, newText);
  if (patch == null) {
    return [header, `  (${oldText.split('\n').length} → ${newText.split('\n').length} lines — too large to diff)`];
  }
  return [header, ...patch.split('\n').map((l) => `  ${l}`)];
}

/**
 * يكتشف مشاريع clasp تحت جذر المصدر. جذر فيه `.clasp.json` هو مشروع واحد باسم
 * المجلد؛ وإلا كل مجلد فرعي مباشر فيه `.clasp.json` مشروع. لا مشاريع = خطأ
 * يرشد إلى `clasp clone`.
 */
export async function discoverProjects(sourceDir) {
  let stat;
  try {
    stat = await lstat(sourceDir);
  } catch {
    throw new Error(`source directory not found: ${sourceDir} — run 'npx @google/clasp clone <SCRIPT_ID>' there first`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`source is not a real directory: ${sourceDir}`);
  }
  if (await exists(path.join(sourceDir, '.clasp.json'))) {
    return { projects: [{ name: path.basename(sourceDir), dir: sourceDir }], warnings: [] };
  }
  const projects = [];
  const warnings = [];
  const entries = (await readdir(sourceDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      if (await exists(path.join(sourceDir, entry.name, '.clasp.json'))) warnings.push({ project: entry.name, reason: 'symlink' });
      continue;
    }
    if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
    if (await exists(path.join(sourceDir, entry.name, '.clasp.json'))) {
      projects.push({ name: entry.name, dir: path.join(sourceDir, entry.name) });
    }
  }
  return { projects, warnings };
}

async function readScriptId(projectDir) {
  const raw = await readFile(path.join(projectDir, '.clasp.json'), 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed.scriptId !== 'string' || !parsed.scriptId.trim()) {
    throw new Error('.clasp.json has no scriptId');
  }
  return parsed.scriptId.trim();
}

/** يزيل المجلدات الفارغة التي خلفتها الحذوفات، ولا يصعد أبدًا فوق جذر المشروع. */
async function pruneEmptyDirs(dir, stopAt) {
  let current = path.resolve(dir);
  const stop = path.resolve(stopAt);
  while (current.startsWith(stop + path.sep) && current !== stop) {
    let entries;
    try {
      entries = await readdir(current);
    } catch {
      break;
    }
    if (entries.length > 0) break;
    await rm(current, { recursive: true });
    current = path.dirname(current);
  }
}

/**
 * يطبق فرقًا مقبولًا: كتابة tmp+rename ذرية، ثم حذف. كل هدف يُفحص مقابل جذر
 * المشروع قبل الكتابة، وتُعاد لقطة تحقق بعد التطبيق.
 */
export async function applyProject({ projectDest, srcFiles, diff }) {
  const guard = (rel) => {
    const target = path.resolve(projectDest, rel);
    const rootResolved = path.resolve(projectDest);
    if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
      throw new Error(`path escapes the project directory: ${rel}`);
    }
    return target;
  };
  for (const rel of [...diff.added, ...diff.modified]) {
    const target = guard(rel);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.celia-tmp-${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(tmp, srcFiles.get(rel));
      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }
  for (const rel of diff.deleted) {
    const target = guard(rel);
    if (await exists(target)) await unlink(target);
    await pruneEmptyDirs(path.dirname(target), projectDest);
  }
}

/** مشاريع موجودة في الوجهة وغائبة عن المصدر: تُذكر ولا تُحذف أبدًا. */
async function missingFromSource(destRoot, sourceNames) {
  if (!(await isDirectory(destRoot))) return [];
  const names = new Set(sourceNames);
  const missing = [];
  for (const entry of (await readdir(destRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && !names.has(entry.name)) missing.push(entry.name);
  }
  return missing;
}

/**
 * الجوهر: يحسب (ويطبق اختياريًا) المزامنة، ويعيد تقريرًا ورمز خروج. الطباعة
 * متروكة لواجهة الأوامر حتى تختبر الاختبارات التقرير مباشرة.
 */
export async function runSync({ source, dest, project = null, accept = false }) {
  const sourceDir = path.resolve(expandHome(source));
  const destRoot = guardDest(expandHome(dest));
  // جذر وجهة رمزي قد يعيد توجيه كل الكتابات خارجه — يُرفض مغلقًا.
  if (await exists(destRoot)) {
    const destStat = await lstat(destRoot);
    if (!destStat.isDirectory()) throw new Error(`destination exists but is not a real directory: ${destRoot}`);
  }
  const { projects: found, warnings } = await discoverProjects(sourceDir);
  if (!found.length) {
    throw new Error(`no clasp projects found in ${sourceDir} (a project needs a .clasp.json) — run 'npx @google/clasp clone <SCRIPT_ID>' first`);
  }
  let projects = found;
  if (project != null) {
    projects = found.filter((p) => p.name === project);
    if (!projects.length) throw new Error(`project not found: ${project}`);
  }

  const results = [];
  for (const { name, dir } of projects) {
    const result = {
      name, scriptId: null, status: 'refused',
      added: [], modified: [], deleted: [], unchanged: [],
      excluded: [], destExcluded: [], refusals: [], patches: []
    };
    results.push(result);
    if (!PROJECT_NAME.test(name)) {
      result.refusals.push({ file: '(project)', reason: 'invalid-name' });
      continue;
    }
    try {
      result.scriptId = await readScriptId(dir);
    } catch {
      result.refusals.push({ file: '.clasp.json', reason: 'malformed' });
      continue;
    }
    const src = await walkTree(dir);
    result.excluded = src.excluded;
    result.refusals.push(...src.refusals, ...inspectSource(src.files));

    const projectDest = path.join(destRoot, name);
    // مجلد وجهة رمزي: حتى لو بدا مجلدًا، الكتابة عبره تخرج عن المشروع — يُرفض.
    if (await exists(projectDest)) {
      const projectStat = await lstat(projectDest);
      if (projectStat.isSymbolicLink()) {
        result.refusals.push({ file: '(destination)', reason: 'symlink' });
        result.status = 'refused';
        continue;
      }
      if (!projectStat.isDirectory()) {
        result.refusals.push({ file: '(destination)', reason: 'not-a-directory' });
        result.status = 'refused';
        continue;
      }
    }
    const destWalk = (await isDirectory(projectDest)) ? await walkTree(projectDest) : { files: new Map(), excluded: [], refusals: [] };
    result.destExcluded = destWalk.excluded;
    result.refusals.push(...destWalk.refusals.map((r) => ({ file: `(destination) ${r.file}`, reason: r.reason })));

    const diff = diffTrees(src.files, destWalk.files);
    Object.assign(result, { added: diff.added, modified: diff.modified, deleted: diff.deleted, unchanged: diff.unchanged });
    for (const rel of diff.added) result.patches.push(renderFileChange(rel, 'added', null, src.files.get(rel)));
    for (const rel of diff.modified) result.patches.push(renderFileChange(rel, 'modified', destWalk.files.get(rel), src.files.get(rel)));
    for (const rel of diff.deleted) result.patches.push(renderFileChange(rel, 'deleted', destWalk.files.get(rel), null));

    if (result.refusals.length) {
      result.status = 'refused';
      continue;
    }
    const hasChanges = result.added.length + result.modified.length + result.deleted.length > 0;
    result.status = hasChanges ? 'changes' : 'in-sync';
  }

  // بوابة الأسرار العالمية: إصابة واحدة في أي مشروع تمنع التطبيق عن الجميع.
  const secretBlocked = results.some((r) => r.refusals.some((x) => x.reason.startsWith('secret:')));
  if (accept && !secretBlocked) {
    for (const result of results) {
      if (result.status !== 'changes') continue;
      const { name, dir } = projects.find((p) => p.name === result.name);
      const src = await walkTree(dir);
      const projectDest = path.join(destRoot, name);
      await applyProject({
        projectDest,
        srcFiles: src.files,
        diff: { added: result.added, modified: result.modified, deleted: result.deleted }
      });
      // إعادة لقطة: لا يُكتب «طُبّق» إن لم تتطابق الوجهة فعلًا مع المصدر.
      const verify = diffTrees(src.files, (await walkTree(projectDest)).files);
      const clean = verify.added.length + verify.modified.length + verify.deleted.length === 0;
      result.status = clean ? 'applied' : 'verify-failed';
      if (!clean) result.refusals.push({ file: '(verify)', reason: `post-apply mismatch: +${verify.added.length} ~${verify.modified.length} -${verify.deleted.length}` });
    }
  } else if (accept && secretBlocked) {
    for (const result of results) {
      if (result.status === 'changes') result.status = 'blocked';
    }
  }

  const missing = await missingFromSource(destRoot, found.map((p) => p.name));
  const hardFail = results.some((r) => ['refused', 'blocked', 'verify-failed'].includes(r.status));
  const anyPending = results.some((r) => r.status === 'changes');
  const code = hardFail ? 2 : anyPending ? 1 : 0;
  const report = {
    tool: 'apps-script:sync',
    direction: 'pull',
    mode: accept ? 'accept' : 'preview',
    source: sourceDir,
    destination: destRoot,
    projects: results,
    missingFromSource: missing,
    warnings,
    totals: {
      projects: results.length,
      added: results.reduce((n, r) => n + r.added.length, 0),
      modified: results.reduce((n, r) => n + r.modified.length, 0),
      deleted: results.reduce((n, r) => n + r.deleted.length, 0),
      refused: results.filter((r) => ['refused', 'blocked', 'verify-failed'].includes(r.status)).length
    },
    exitCode: code
  };
  return { report, code };
}

export function describeReport(report) {
  const lines = [];
  lines.push(`apps-script:sync — pull (${report.mode})`);
  lines.push(`source: ${report.source}`);
  lines.push(`destination: ${report.destination}`);
  lines.push('note: this repository is public — sync only code you intend to publish');
  for (const w of report.warnings) lines.push(`! skipped ${w.project}: ${w.reason}`);
  for (const r of report.projects) {
    lines.push('');
    lines.push(`project ${r.name}${r.scriptId ? ` (scriptId ${r.scriptId})` : ''} — ${r.status}`);
    if (r.excluded.length) lines.push(`  excluded (never copied): ${r.excluded.join(', ')}`);
    if (r.destExcluded.length) lines.push(`  ! credential-shaped files already in destination: ${r.destExcluded.join(', ')} — remove them manually`);
    for (const refusal of r.refusals) lines.push(`  REFUSED ${refusal.file}: ${refusal.reason}`);
    for (const patch of r.patches) lines.push(...patch);
    if (r.status === 'in-sync') lines.push('  no changes');
    if (r.status === 'blocked') lines.push('  blocked: a secret was found in another project — nothing was applied');
  }
  if (report.missingFromSource.length) {
    lines.push('');
    lines.push(`destination-only projects (left untouched, never deleted): ${report.missingFromSource.join(', ')}`);
  }
  lines.push('');
  const t = report.totals;
  lines.push(`totals: ${t.projects} project(s) · +${t.added} ~${t.modified} -${t.deleted} · refused ${t.refused}`);
  if (report.mode === 'preview' && report.exitCode === 1) {
    lines.push('review the diff above, then apply with: npm run apps-script:sync -- --pull --accept');
  }
  if (report.exitCode === 2) lines.push('nothing was written for refused/blocked projects; fix the named cause and re-run');
  return lines;
}

export function parseArgs(argv) {
  const args = {
    source: process.env.CELIA_APPS_SCRIPTS_DIR || DEFAULT_SOURCE,
    dest: DEFAULT_DEST,
    project: null,
    accept: false,
    pull: false,
    json: false,
    help: false
  };
  const takeValue = (flag, next) => {
    if (next == null || next.startsWith('--')) throw new Error(`${flag} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pull') args.pull = true;
    else if (arg === '--accept') args.accept = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--source') args.source = takeValue(arg, argv[++i]);
    else if (arg === '--dest') args.dest = takeValue(arg, argv[++i]);
    else if (arg === '--project') args.project = takeValue(arg, argv[++i]);
    else if (arg === '--push') throw new Error('push is not implemented: pushing to Google is a manual `clasp push` owner decision (DEC-142)');
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.accept && !args.pull) throw new Error('--accept requires --pull');
  return args;
}

const USAGE = `usage: npm run apps-script:sync -- --pull [--accept] [--source <dir>] [--dest <dir>] [--project <name>] [--json]

  --pull            compare the local clasp clone with the repository copy (required)
  --accept          apply the reviewed changes (without it, nothing is written)
  --source <dir>    clasp clones root (default: ~/celia-apps or CELIA_APPS_SCRIPTS_DIR)
  --dest <dir>      repository destination (default: <repo>/apps-script)
  --project <name>  sync only one project
  --json            print the report as JSON

pull-only; this repository is public — sync only code you intend to publish.
exit codes: 0 in sync/applied · 1 differences pending review · 2 bad input or refusal`;

async function main() {
  const wantsJson = process.argv.includes('--json');
  const fail = (message) => {
    if (wantsJson) console.log(JSON.stringify({ tool: 'apps-script:sync', error: message, exitCode: 2 }, null, 2));
    else {
      console.error(`apps-script:sync: ${message}`);
      console.error(USAGE);
    }
    process.exitCode = 2;
  };
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.pull) {
    fail('choose a direction: --pull (the only implemented direction)');
    return;
  }
  let outcome;
  try {
    outcome = await runSync({ source: args.source, dest: args.dest, project: args.project, accept: args.accept });
  } catch (error) {
    fail(error.message);
    return;
  }
  if (args.json) console.log(JSON.stringify(outcome.report, null, 2));
  else for (const line of describeReport(outcome.report)) console.log(line);
  process.exitCode = outcome.code;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
