#!/usr/bin/env node
/**
 * PLAN-002 / W0.2 — deterministic, repository-only completion measurement.
 *
 * Reuses check-plan-coverage rather than reimplementing its facts. The twelve rows deliberately
 * measure only repository-derived values; they do not turn code or a workflow result into evidence
 * for B1, B2, CMAT, active skills, F5, or production health. Those gates still require their own
 * dated or live evidence. The F4 score discrepancy is surfaced as a warning, never arbitrated here.
 *
 * Usage:
 *   npm run measure          # stable Markdown table
 *   npm run measure -- --json
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkPlan } from './check-plan-coverage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FREE_POWER_PLAN = 'docs/plan-free-full-power.md';
const EXPECTED_METRIC_COUNT = 12;

export function buildMetrics(facts, planOk) {
  const waveCounts = Object.entries(facts.waves).map(([wave, count]) => `${wave}:${count}`).join(' · ');
  return [
    { id: 'plan_integrity', label: 'اتساق الخطة والسجل', value: planOk ? 'PASS · 0 انحراف' : 'FAIL · انحرافات مسماة', source: 'npm run plan:check' },
    { id: 'open_tasks', label: 'المهام المفتوحة', value: `${facts.open} (P0 ${facts.byPriority.P0} · P1 ${facts.byPriority.P1} · P2 ${facts.byPriority.P2})`, source: 'docs/continuity/BACKLOG.md' },
    { id: 'waves', label: 'توزيع الموجات', value: `${Object.keys(facts.waves).length} (${waveCounts})`, source: 'docs/plan-system-completion.md §3' },
    { id: 'grants', label: 'الصلاحيات المسجّلة', value: String(facts.grants), source: 'src/agent/access-policy.js' },
    { id: 'agent_tools', label: 'أدوات الوكيل (تتطلب موافقة)', value: `${facts.agentTools} (${facts.agentToolsWithApproval})`, source: 'createDefaultTools() · src/agent/tools.js' },
    { id: 'mcp_tools', label: 'أدوات MCP المعلنة', value: String(facts.mcpTools), source: 'MCP_TOOLS · src/celia-mcp.js' },
    { id: 'version', label: 'إصدار المصدر', value: facts.version, source: 'src/version.js' },
    { id: 'dependencies', label: 'الاعتماديات', value: `${facts.deps.prod} prod · ${facts.deps.dev} dev`, source: 'package.json' },
    { id: 'coverage_floor', label: 'أرضية التغطية في CI (أسطر/فروع/دوال)', value: `${facts.floor.lines}/${facts.floor.branches}/${facts.floor.functions}`, source: 'package.json → test:coverage' },
    { id: 'syntax_files', label: 'ملفات فحص الصياغة', value: String(facts.syntaxFiles), source: 'نطاق scripts/check.mjs' },
    { id: 'continuity', label: 'الاستمرارية (مستندات/روابط/مهام)', value: `${facts.continuity.documents}/${facts.continuity.links}/${facts.continuity.tasks}`, source: 'npm run check:continuity' },
    { id: 'runtime_defaults', label: 'افتراضات العزل/الخروج', value: `sandbox=${facts.sandbox} · egress=${facts.egress}`, source: 'src/agent/index.js' }
  ];
}

/** Read the PLAN-003 total and sum its six explicit layer rows without choosing between them. */
export function measureF4(markdown) {
  const start = markdown.indexOf('## 3 · جدول القدرات');
  const end = start < 0 ? -1 : markdown.indexOf('\n## 4 ·', start);
  if (start < 0 || end < 0) return { status: 'unavailable', declared: null, tableSum: null, layers: 0 };

  const section = markdown.slice(start, end);
  const declaredMatch = /\*\*المجموع: `F4 = ([0-9]+(?:\.[0-9]+)?) \/ 6`\.\*\*/.exec(section);
  const rows = [];
  for (const line of section.split('\n')) {
    if (!/^\|\s*L[1-6]\s*\|/.test(line)) continue;
    const cells = line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    const layer = Number((/^L([1-6])$/.exec(cells[0] || '') || [])[1]);
    const score = Number(cells[4]);
    if (Number.isInteger(layer) && Number.isFinite(score)) rows.push({ layer, score });
  }

  const declared = declaredMatch ? Number(declaredMatch[1]) : null;
  const tableSum = rows.reduce((sum, row) => sum + row.score, 0);
  const completeLayerSet = rows.length === 6 && new Set(rows.map((row) => row.layer)).size === 6;
  const status = declared === null || !completeLayerSet ? 'unavailable' : Math.abs(declared - tableSum) < Number.EPSILON ? 'consistent' : 'conflict';
  return { status, declared, tableSum, layers: rows.length };
}

export async function createMeasurement({ root = ROOT } = {}) {
  const planResult = await checkPlan({ root });
  const powerPlan = await readFile(path.join(root, FREE_POWER_PLAN), 'utf8');
  const metrics = buildMetrics(planResult.facts, planResult.ok);
  if (metrics.length !== EXPECTED_METRIC_COUNT) throw new Error(`Expected ${EXPECTED_METRIC_COUNT} metrics, built ${metrics.length}`);

  return {
    scope: 'repository-derived-only',
    metricCount: metrics.length,
    planIntegrity: { ok: planResult.ok, errors: planResult.errors },
    metrics,
    diagnostics: {
      f4: measureF4(powerPlan),
      f4Note: 'لا يغيّر هذا التقرير درجة F4 ولا يختارها؛ سوِّ مصدر الخطة قبل استخدام F4 كقيمة قبول.'
    },
    notMeasured: [
      'معايير B1 وB2 وCMAT والمهارات active في L5 وF5 لا تُستنتج من وجود الشيفرة.',
      'لا يُستعلم GitHub أو مزوّدو الخدمات أو الروابط العامة أو إعداد Render أو بيانات الإنتاج.'
    ]
  };
}

export function renderMeasurement(report) {
  const lines = [
    'PLAN-002 W0.2 — قياس محلي مشتق من المستودع فقط (دون شبكة أو ساعة)',
    `اتساق الخطة: ${report.planIntegrity.ok ? 'PASS' : 'FAIL'}${report.planIntegrity.errors.length ? ` · ${report.planIntegrity.errors.length} انحراف` : ' · 0 انحراف'}`,
    '',
    '| # | المؤشر | القيمة | المصدر |',
    '|---:|---|---|---|'
  ];
  for (const [index, metric] of report.metrics.entries()) {
    lines.push(`| ${index + 1} | ${metric.label} | ${metric.value} | ${metric.source} |`);
  }

  const f4 = report.diagnostics.f4;
  lines.push('');
  if (f4.status === 'conflict') {
    lines.push(`⚠️ تضارب F4 غير محسوم: المجموع المعلن ${f4.declared}/6، ومجموع صفوف L1–L6 هو ${f4.tableSum}/6. لم يُختر وزن بديل.`);
  } else if (f4.status === 'consistent') {
    lines.push(`F4: المجموع المعلن ومجموع صفوف الجدول متطابقان (${f4.declared}/6).`);
  } else {
    lines.push('⚠️ تعذّر حساب F4 من جدول PLAN-003؛ لا يُستنتج منه قبول.');
  }
  lines.push('غير مقاس بهذا الأمر:');
  for (const item of report.notMeasured) lines.push(`- ${item}`);
  if (report.planIntegrity.errors.length) {
    lines.push('', 'انحرافات plan:check:');
    for (const error of report.planIntegrity.errors) lines.push(`- ${error}`);
  }
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  const args = argv.filter((arg) => arg !== '--json');
  if (args.length) {
    console.error('Usage: npm run measure [-- --json]');
    process.exitCode = 2;
    return;
  }
  const json = argv.includes('--json');
  return createMeasurement().then((report) => {
    console.log(json ? JSON.stringify(report, null, 2) : renderMeasurement(report));
    if (!report.planIntegrity.ok) process.exitCode = 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
