#!/usr/bin/env node
/**
 * Generate `docs/continuity/NOW.md` deterministically from the single-authority repository files.
 *
 * `NOW.md` is a derived read-only resume view, never a second source of truth (DEC-003, DEC-052):
 *   - No wall-clock timestamps, randomness, or network calls (DEC-045).
 *   - `--check` exits 1 when `docs/continuity/NOW.md` is missing or differs by even a single byte.
 *
 * Usage:
 *   node scripts/generate-now.mjs           # write docs/continuity/NOW.md
 *   node scripts/generate-now.mjs --check   # fail if docs/continuity/NOW.md is stale
 *   node scripts/generate-now.mjs --stdout  # print generated markdown without writing
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NOW_RELATIVE_PATH = 'docs/continuity/NOW.md';

const STATUS_PREFIXES = ['متحقق', 'منشور', 'جارٍ', 'مخطط', 'بانتظار', 'منجز توثيقيًا'];

export function parseSkillFrontmatter(markdown) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (!match) return { name: '', description: '' };
  const fields = { name: '', description: '' };
  for (const line of match[1].split('\n')) {
    const kv = /^([a-zA-Z0-9_-]+):\s*(.+)$/.exec(line.trim());
    if (kv && (kv[1] === 'name' || kv[1] === 'description')) {
      fields[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return fields;
}

function summarizeStatusCell(raw, maxLen = 110) {
  const plain = raw
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= maxLen) return plain;
  return `${plain.slice(0, maxLen - 1).trimEnd()}…`;
}

export function parseDecisions(markdown) {
  const entries = [];
  for (const line of markdown.split('\n')) {
    const match = /^## (DEC-(\d{3}))\s+—\s+(.+)$/.exec(line.trim());
    if (match) {
      entries.push({
        id: match[1],
        number: Number(match[2]),
        title: match[3].trim()
      });
    }
  }
  const byNumber = [...entries].sort((a, b) => a.number - b.number);
  const highest = byNumber.at(-1)?.number || 0;
  const nextId = `DEC-${String(highest + 1).padStart(3, '0')}`;
  return {
    total: entries.length,
    latest: byNumber.at(-1) || null,
    nextId,
    recent: byNumber.slice(-5).reverse()
  };
}

export function parseBacklog(markdown) {
  const counts = Object.fromEntries(STATUS_PREFIXES.map((key) => [key, 0]));
  const active = [];
  const blocked = [];
  let total = 0;

  for (const row of markdown.split('\n')) {
    if (!/^\| [A-Z]{2,8}-\d{3} /.test(row)) continue;
    const cells = row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.length !== 5) continue;
    const [id, priority, statusCell, dependsOn] = cells;
    total += 1;
    const matchedPrefix = STATUS_PREFIXES.find((prefix) => statusCell.startsWith(prefix));
    if (matchedPrefix) counts[matchedPrefix] += 1;
    if (statusCell.startsWith('جارٍ')) {
      active.push({ id, priority, dependsOn, summary: summarizeStatusCell(statusCell) });
    } else if (statusCell.startsWith('بانتظار')) {
      blocked.push({ id, priority, dependsOn, summary: summarizeStatusCell(statusCell) });
    }
  }

  return { total, counts, active, blocked };
}

export function parseExecutionPlan(markdown) {
  const completedHeadings = new Set();
  for (const line of markdown.split('\n')) {
    const heading = /^### (WP-\d+\.\d+)\b(.*)$/.exec(line.trim());
    if (heading && heading[2].includes('✅')) completedHeadings.add(heading[1]);
  }

  const packages = [];
  for (const row of markdown.split('\n')) {
    if (!/^\| WP-\d+\.\d+/.test(row.trim())) continue;
    const cells = row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.length < 7) continue;
    const idMatch = /^(WP-\d+\.\d+)/.exec(cells[0]);
    if (!idMatch) continue;
    const wpId = idMatch[1];
    const done = cells[0].includes('✅') || completedHeadings.has(wpId);
    packages.push({
      id: wpId,
      step: cells[1],
      done,
      dependsOn: cells[4],
      ownerDecision: cells[5],
      backlogId: cells[6]
    });
  }
  return packages;
}

export function parseStateSummary(markdown) {
  const reviewMatch = /\*\*آخر مراجعة:\*\*\s*([^·\n]+)/.exec(markdown);
  const focusMatch = /\*\*نوع الجلسة الحالية:\*\*\s*(.+?)(?:\s*·\s*$|\n)/.exec(markdown);
  const sessionMatch = /\[([^\]]+)\]\((sessions\/[^)\s]+\.md)\)/.exec(markdown);
  return {
    lastReviewed: reviewMatch ? reviewMatch[1].trim() : 'غير محدد',
    currentFocus: focusMatch ? focusMatch[1].replace(/\*\*/g, '').replace(/\s*·\s*$/, '').trim() : 'راجع STATE.md',
    latestSessionLabel: sessionMatch ? sessionMatch[1].trim() : null,
    latestSessionHref: sessionMatch ? sessionMatch[2].trim() : null,
    lines: markdown.split('\n').length,
    bytes: Buffer.byteLength(markdown, 'utf8')
  };
}

export async function collectNowFacts(root = DEFAULT_ROOT) {
  const [pkgRaw, releaseRaw, stateRaw, backlogRaw, decisionsRaw, planRaw, continuityEntries] = await Promise.all([
    readFile(path.join(root, 'package.json'), 'utf8'),
    readFile(path.join(root, 'releases/current.json'), 'utf8'),
    readFile(path.join(root, 'docs/continuity/STATE.md'), 'utf8'),
    readFile(path.join(root, 'docs/continuity/BACKLOG.md'), 'utf8'),
    readFile(path.join(root, 'docs/continuity/DECISIONS.md'), 'utf8'),
    readFile(path.join(root, 'docs/agent-2026-execution-plan.md'), 'utf8'),
    readdir(path.join(root, 'docs/continuity'), { withFileTypes: true })
  ]);

  const pkg = JSON.parse(pkgRaw);
  const release = JSON.parse(releaseRaw);

  const archiveFiles = continuityEntries
    .filter((entry) => entry.isFile() && /^STATE-ARCHIVE-.*\.md$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const archives = await Promise.all(
    archiveFiles.map(async (name) => {
      const text = await readFile(path.join(root, 'docs/continuity', name), 'utf8');
      const meta = /^<!--\s*state-archive:\s*source=(\S+)\s+baseline=(\S+)\s+sha256=([a-f0-9]{64})\s+bytes=(\d+)\s+lines=(\d+)\s*-->/m.exec(
        text
      );
      return {
        name,
        baseline: meta ? meta[2] : 'unknown',
        sha256Prefix: meta ? meta[3].slice(0, 12) : 'untagged',
        lines: meta ? Number(meta[5]) : text.split('\n').length
      };
    })
  );

  const skillsDir = path.join(root, '.agents/skills');
  const skillEntries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  const skillFolders = skillEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const skills = await Promise.all(
    skillFolders.map(async (folder) => {
      const skillText = await readFile(path.join(skillsDir, folder, 'SKILL.md'), 'utf8');
      const fm = parseSkillFrontmatter(skillText);
      return {
        folder,
        name: fm.name || folder,
        description: fm.description || '—',
        href: `../../.agents/skills/${folder}/SKILL.md`
      };
    })
  );

  return {
    release: {
      version: release.version,
      previousVersion: release.previousVersion,
      schema: release.database.schema,
      destructiveMigration: release.database.destructiveMigration,
      nodeEngine: pkg.engines?.node || `>=${release.minimumNode}`
    },
    state: parseStateSummary(stateRaw),
    archives,
    decisions: parseDecisions(decisionsRaw),
    backlog: parseBacklog(backlogRaw),
    packages: parseExecutionPlan(planRaw),
    skills
  };
}

export function renderNowMarkdown(facts) {
  const { release, state, archives, decisions, backlog, packages, skills } = facts;
  const donePackages = packages.filter((wp) => wp.done).length;
  const sessionRef =
    state.latestSessionLabel && state.latestSessionHref
      ? `[${state.latestSessionLabel}](${state.latestSessionHref})`
      : 'راجع [STATE.md](STATE.md)';

  const archiveLines = archives.length
    ? archives
        .map(
          (item) =>
            `- [${item.name}](${item.name}) — الأساس \`${item.baseline}\` · **${item.lines} سطرًا** محفوظًا حرفيًا (بصمة \`${item.sha256Prefix}…\`)`
        )
        .join('\n')
    : '- لا ملفات أرشيف بعد.';

  const decisionRows = decisions.recent
    .map((item) => `| \`${item.id}\` | ${item.title} |`)
    .join('\n');

  const packageRows = packages
    .map(
      (wp) =>
        `| \`${wp.id}\` | ${wp.step} | ${wp.done ? 'منفَّذ ✅' : 'مخطط'} | ${wp.backlogId} | ${wp.dependsOn} | ${wp.ownerDecision} |`
    )
    .join('\n');

  const activeRows = backlog.active
    .map((task) => `| ${task.id} | ${task.priority} | ${task.summary} |`)
    .join('\n');

  const blockedRows = backlog.blocked
    .map((task) => `| ${task.id} | ${task.priority} | ${task.summary} |`)
    .join('\n');

  const skillRows = skills
    .map((skill) => `| [\`${skill.name}\`](${skill.href}) | ${skill.description} |`)
    .join('\n');

  return `# اللقطة الفورية المشتقة — ابدأ القراءة السريعة من هنا (\`NOW.md\`)

> **مُولَّد آليًا** بواسطة \`npm run now\` (\`scripts/generate-now.mjs\`) — **ليس مرجعًا ثانيًا** ([DEC-003](DECISIONS.md) · [DEC-052](DECISIONS.md)).
> لا تُحرّر هذا الملف يدويًا؛ شغّل \`npm run now\` بعد تحديث المصادر، وتحقّق بـ\`npm run now:check\` و\`npm run check:continuity\`.

## 1. هوية الإصدار والبيئة الحاكمة

- **الإصدار الحالي:** \`v${release.version}\` (السابق \`v${release.previousVersion}\`) · **مخطط القاعدة الأساسي:** \`schema=${release.schema}\` (\`destructiveMigration=${release.destructiveMigration}\`) · **محرك Node:** \`${release.nodeEngine}\`
- **بوابة اتفاقية العمل الوحيدة:** [AGENTS.md](../../AGENTS.md) (ومدخل التوجيه الرقيق [CLAUDE.md](../../CLAUDE.md)) · **عقد التوافق:** [compatibility-contract.md](../compatibility-contract.md)
- **نطاق R0 (2026) الفعّال:** أرشفة \`STATE\` بلا حذف + مولّد \`NOW.md\` الحتمي + بوابة \`CLAUDE.md\` + المهارات الأربع (CONT-004، [DEC-052](DECISIONS.md)) · **خارج النطاق حاليًا:** R1، وتعديلات بروتوكول MCP (MCP-001 / MCP-002)، وأتمتة \`gh-aw\`.

## 2. التركيز النشط وسجل الحالة ([STATE.md](STATE.md))

- **آخر مراجعة مسجّلة:** ${state.lastReviewed}
- **الجلسة النشطة:** ${state.currentFocus}
- **آخر سجل جلسة مؤرَّخ:** ${sessionRef}
- **حجم [STATE.md](STATE.md) النشط:** ${state.lines} سطرًا (${state.bytes} بايت)
- **الأرشيف التاريخي المحفوظ بلا حذف:**
${archiveLines}

## 3. سجل القرارات المعمارية ([DECISIONS.md](DECISIONS.md))

- **إجمالي القرارات المسجّلة:** ${decisions.total} · **آخر قرار معتمد في السجل:** \`${decisions.latest ? decisions.latest.id : '—'}\` · **المعرّف المتاح التالي (تحقّق قبل الحجز):** \`${decisions.nextId}\`

| المعرّف | العنوان المختصر |
|---|---|
${decisionRows}

## 4. تقدّم الخطة التنفيذية 2026 ([agent-2026-execution-plan.md](../agent-2026-execution-plan.md))

- **الحِزم المنفَّذة:** ${donePackages} من ${packages.length}

| الحزمة | الخطوة | الحالة | صف BACKLOG | يعتمد على | قرار مالك؟ |
|---|---|---|---|---|---|
${packageRows}

## 5. ملخص قائمة العمل المرجعية ([BACKLOG.md](BACKLOG.md))

- **إجمالي المهام الفريدة:** ${backlog.total} — متحقق: **${backlog.counts['متحقق']}** · جارٍ: **${backlog.counts['جارٍ']}** · مخطط: **${backlog.counts['مخطط']}** · بانتظار قرار/معلومة: **${backlog.counts['بانتظار']}** · منجز توثيقيًا: **${backlog.counts['منجز توثيقيًا']}** · منشور: **${backlog.counts['منشور']}**

### أ. المهام الجارية حاليًا (\`جارٍ\` — ${backlog.active.length})

| المعرّف | الأولوية | الملخص الحالي |
|---|---|---|
${activeRows}

### ب. المهام الموقوفة على قرار أو إجراء مالك (\`بانتظار\` — ${backlog.blocked.length})

| المعرّف | الأولوية | العائق المسجَّل |
|---|---|---|
${blockedRows}

## 6. المهارات الإجرائية الأربع المعتمدة (R0)

| المهارة | الغرض |
|---|---|
${skillRows}
`;
}

export async function syncNowFile({ root = DEFAULT_ROOT, check = false } = {}) {
  const facts = await collectNowFacts(root);
  const rendered = renderNowMarkdown(facts);
  const targetPath = path.join(root, NOW_RELATIVE_PATH);
  const existing = await readFile(targetPath, 'utf8').catch(() => null);

  if (check) {
    if (existing === null) {
      return {
        ok: false,
        reason: 'missing',
        targetPath,
        message: `${NOW_RELATIVE_PATH} is missing; run "npm run now" to generate it.`
      };
    }
    if (existing !== rendered) {
      return {
        ok: false,
        reason: 'stale',
        targetPath,
        message: `${NOW_RELATIVE_PATH} is out of date with its authoritative sources; run "npm run now".`
      };
    }
    return { ok: true, changed: false, targetPath, bytes: Buffer.byteLength(rendered, 'utf8') };
  }

  const changed = existing !== rendered;
  if (changed) {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, rendered, 'utf8');
  }
  return { ok: true, changed, targetPath, bytes: Buffer.byteLength(rendered, 'utf8') };
}

export async function runCli(argv = process.argv.slice(2), { root = DEFAULT_ROOT, stdout = process.stdout, stderr = process.stderr } = {}) {
  const flags = new Set(argv);
  if (flags.has('--stdout')) {
    const rendered = renderNowMarkdown(await collectNowFacts(root));
    stdout.write(rendered);
    return 0;
  }
  const check = flags.has('--check');
  const result = await syncNowFile({ root, check });
  if (!result.ok) {
    stderr.write(`${result.message}\n`);
    return 1;
  }
  if (check) {
    stdout.write(`NOW verified: ${NOW_RELATIVE_PATH} (${result.bytes} bytes) matches authoritative sources.\n`);
  } else {
    stdout.write(`NOW ${result.changed ? 'generated' : 'up-to-date'}: ${NOW_RELATIVE_PATH} (${result.bytes} bytes).\n`);
  }
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const code = await runCli();
  if (code !== 0) process.exitCode = code;
}
