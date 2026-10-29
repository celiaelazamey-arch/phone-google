#!/usr/bin/env node
// M-B/B3 — بوابة المهام الذهبية الثلاث لقوالب المخرجات (تقرير HTML، جدول CSV،
// صفحة ثابتة). حتمية بلا شبكة: الحلقة الحقيقية + بصمات ذهبية مثبتة في
// data/eval/b3-templates/golden.json — أي انحراف بايت واحد يُفشل البوابة.
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runTemplateGoldenTasks } from '../src/agent/template-eval.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenFile = path.join(root, 'data', 'eval', 'b3-templates', 'golden.json');
const output = path.join(root, 'reports', 'b3-templates.json');

async function main() {
  const expected = JSON.parse(await readFile(goldenFile, 'utf8'));
  const report = await runTemplateGoldenTasks({ expected });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    `B3-TEMPLATES: ${report.pass ? 'PASS' : 'FAIL'} — ${report.passedTasks}/${report.totalTasks} golden tasks · report=${path.relative(root, output)}`
  );
  if (!report.pass) {
    for (const task of report.tasks.filter((item) => !item.pass)) {
      const failed = Object.entries(task.checks).filter(([, ok]) => !ok).map(([key]) => key);
      console.error(`${task.id} (${task.kind}): ${failed.join(', ')} · got=${task.downloadedSha256} want=${task.expectedSha256}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`B3 template runner failed: ${error?.message || error}`);
  process.exitCode = 1;
});
