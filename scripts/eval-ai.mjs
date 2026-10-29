#!/usr/bin/env node
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadAiEvalCases, runAiEvaluation } from '../src/agent/ai-eval.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'reports', 'ai-001.json');

async function main() {
  const dataset = await loadAiEvalCases(path.join(root, 'data', 'eval', 'ai-001'));
  const report = await runAiEvaluation(dataset);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const { metrics } = report;
  console.log([
    `AI-001: ${report.pass ? 'PASS' : 'FAIL'} — ${metrics.passedCases}/${metrics.totalCases} cases`,
    `appointments=${(metrics.appointmentSuccessRate * 100).toFixed(2)}%`,
    `p50=${metrics.p50Ms}ms`,
    `p95=${metrics.p95Ms}ms`,
    `additionalIntervention=${(metrics.additionalInterventionRate * 100).toFixed(2)}%`,
    `duplicates=${metrics.duplicateEvents}`,
    `unauthorized=${metrics.unauthorizedWrites}`,
    `unknownReconciled=${metrics.reconciledUnknowns}/${metrics.unknownOutcomes}`,
    `blindResends=${metrics.blindResends}`,
    `report=${path.relative(root, output)}`
  ].join(' · '));
  if (!report.pass) {
    for (const gate of report.gates.filter((item) => !item.pass)) {
      console.error(`gate ${gate.id}: ${gate.actual} ${gate.comparator} ${gate.threshold}`);
    }
    for (const item of report.cases.filter((entry) => !entry.pass)) {
      console.error(`${item.id}: ${item.failures.join('; ')}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`AI-001 runner failed: ${error?.message || error}`);
  process.exitCode = 1;
});
