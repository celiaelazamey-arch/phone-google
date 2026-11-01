#!/usr/bin/env node
/**
 * Render the CeliaOS 2026 access matrix from `src/agent/access-policy.js`.
 *
 * The matrix is a build artifact of the policy, not a table kept beside it: `--check` fails when
 * the committed document no longer matches the constants, so a permission cannot be widened in
 * code while the published table still says otherwise. Output is deterministic — no timestamps —
 * so the drift gate is meaningful in CI.
 *
 * Usage:
 *   node scripts/render-access-policy.mjs           # write docs/access-policy/README.md
 *   node scripts/render-access-policy.mjs --check   # fail if it is stale
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACCESS_POLICY_VERSION,
  ACCOUNT_ACCESS,
  DOMAINS,
  GITHUB_GRANTS,
  GRANTS,
  LIMITS,
  MANAGEMENT_LOOP,
  NETWORK_DEFAULT,
  OWNER_ACTIONS,
  PILLAR_GRANTS,
  SERVICE_GRANTS,
  TIERS,
  policySummary,
  reachableTiers
} from '../src/agent/access-policy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const DOCS_PATH = path.join(ROOT, 'docs', 'access-policy', 'README.md');

const yes = (value) => (value ? 'نعم' : '—');
const approvalWord = (grant) => (grant.approval === 'always' ? 'مطلوبة' : 'غير مطلوبة');

function grantRows(grants) {
  return grants
    .map(
      (grant) =>
        `| \`${grant.id}\` | ${grant.ar} | ${grant.level} | \`${grant.tier}\` | ${approvalWord(grant)} | ${yes(grant.ownerOnly)} | ${yes(grant.selfGovernance)} | ${yes(grant.wired)} |`
    )
    .join('\n');
}

const GRANT_TABLE_HEAD = [
  '| المعرّف | الصلاحية | المستوى | الطبقة المطلوبة | الموافقة | للمالك وحده | حوكمة ذاتية | موصولة |',
  '|---|---|---|---|---|---|---|---|'
].join('\n');

export function buildMarkdown() {
  const summary = policySummary();
  const tierRows = TIERS.map(
    (tier) => `| \`${tier.id}\` | ${tier.ar} | ${tier.en} | ${tier.axis} | ${[...reachableTiers(tier.id)].join(' · ')} |`
  ).join('\n');
  const pillars = Object.keys(DOMAINS)
    .filter((domain) => !['github', 'service'].includes(domain))
    .map(
      (domain) => `### ${DOMAINS[domain]} — \`${domain}\`

${GRANT_TABLE_HEAD}
${grantRows(PILLAR_GRANTS.filter((grant) => grant.domain === domain))}`
    )
    .join('\n\n');
  const limits = LIMITS.map((limit) => `| \`${limit.id}\` | ${limit.ar} | ${limit.en} | \`${limit.evidence}\` |`).join('\n');
  const loop = MANAGEMENT_LOOP.map(
    (step) => `| ${step.n} | ${step.ar} | ${step.stage ? `\`${step.stage}\`` : 'خارج الحزام'} | ${step.note} |`
  ).join('\n');
  const ownerActions = OWNER_ACTIONS.map((action) => `- **${action.ar}** — \`${action.evidence}\``).join('\n');

  return `# صلاحيات CeliaOS 2026 — المصفوفة المنفَّذة

> **مُولَّد آليًا** من \`src/agent/access-policy.js\` (\`${ACCESS_POLICY_VERSION}\`). لا تُحرّره يدويًا:
> \`npm run access:policy\` يعيد توليده، و\`npm run access:policy:check\` يُفشل CI عند الانحراف.
> الشرح البشري والقائمة التي لا يملكها الوكيل في [الوثيقة المرافقة](../access-policy-2026.md).

**القراءة الأولى:** الصلاحيات **${summary.total}** موزّعة على ${Object.keys(DOMAINS).length} نطاقات · **${summary.ownerOnly}** منها للمالك وحده لا يبلغها أي مستوى ·
**${summary.approvalAlways}** تحتاج موافقة مسجّلة دائمًا · **${summary.selfGovernance}** تحكم الحوكمة نفسها · **${summary.wired}** موصولة تشغيليًا.
والشبكة \`NETWORK = ${NETWORK_DEFAULT}\` افتراضيًا، والوكيل لا يملك حساب المالك: \`githubOwner = ${ACCOUNT_ACCESS.githubOwner}\`.

## 1. مستويات الوصول الستة

المستويات ليست سلمًا واحدًا يُتصاعد عليه: \`admin\` لا يفتح البنية التحتية، و\`infra_admin\` لا يفتح كتابة المستودع،
و\`system_operator\` لا يفتح أيًّا منهما. العمود الأخير هو ما يبلغه المستوى فعلًا.

| المعرّف | المستوى | باللاتينية | المحور | يبلغ |
|---|---|---|---|---|
${tierRows}

## 2. GitHub — الصلاحيات الأساسية (19)

| المعرّف | الصلاحية | المستوى | الطبقة المطلوبة | الموافقة | للمالك وحده | حوكمة ذاتية | موصولة |
|---|---|---|---|---|---|---|---|
${grantRows(GITHUB_GRANTS)}

## 3. أركان CeliaOS الستة

${pillars}

## 4. الخدمات الخارجية (11)

GitHub Admin لا يمنح شيئًا هنا؛ كل صفٍّ يقف على اعتماده الخاص.

| المعرّف | الصلاحية | المستوى | الطبقة المطلوبة | الموافقة | للمالك وحده | حوكمة ذاتية | موصولة |
|---|---|---|---|---|---|---|---|
${grantRows(SERVICE_GRANTS)}

## 5. القيود التي لا تُرفع بأي صلاحية

| المعرّف | القيد | باللاتينية | الدليل في الكود |
|---|---|---|---|
${limits}

## 6. دورة الإدارة العشرية — والخريطة إلى مراحل الحزام

هذه **ليست** مراحل حزام جديدة. أسماء المراحل العشر تبقى كما هي في \`HARNESS_LIFECYCLE_STAGES\`،
والاختبار يرفض أي اسم لا يطابقها. الخطوة الثامنة خارج الحزام بقصد.

| # | الخطوة | مرحلة الحزام | القيد |
|---|---|---|---|
${loop}

## 7. ما يملكه المالك وحده

${ownerActions}
`;
}

export async function run({ check = false } = {}) {
  const wanted = buildMarkdown();
  if (check) {
    let current = null;
    try {
      current = await readFile(DOCS_PATH, 'utf8');
    } catch {
      console.error(`missing: ${path.relative(ROOT, DOCS_PATH)} — run \`npm run access:policy\``);
      return 1;
    }
    if (current !== wanted) {
      console.error(`stale: ${path.relative(ROOT, DOCS_PATH)} — run \`npm run access:policy\``);
      return 1;
    }
    const grants = GRANTS.length;
    console.log(`access policy verified: ${grants} grants match the published matrix`);
    return 0;
  }
  await mkdir(path.dirname(DOCS_PATH), { recursive: true });
  await writeFile(DOCS_PATH, wanted, 'utf8');
  console.log(`wrote ${path.relative(ROOT, DOCS_PATH)}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await run({ check: process.argv.includes('--check') });
}
