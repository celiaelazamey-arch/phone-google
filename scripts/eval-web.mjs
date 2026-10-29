#!/usr/bin/env node
// M-C/C2a — بوابة الوصول إلى الويب.
//
// كل المشاهد على شبكة محلية حقيقية (أصل وهمي + خادم «شرير» + وسيط C1 الفعلي)،
// بلا إنترنت وبلا مفتاح. التقرير حتمي (بلا طوابع زمنية) فيمكن مقارنته في CI.
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runWebEval } from '../src/agent/web-eval.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'reports', 'web-access.json');

async function main() {
  const report = await runWebEval();
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    `WEB-ACCESS: ${report.pass ? 'PASS' : 'FAIL'} — ${report.passed}/${report.total} scenarios · report=${path.relative(root, output)}`
  );
  if (!report.pass) {
    for (const scenario of report.scenarios.filter((item) => !item.pass)) {
      const failed = Object.entries(scenario.checks)
        .filter(([, ok]) => !ok)
        .map(([key]) => key);
      console.error(`${scenario.id} (${scenario.title}): ${failed.join(', ')} · detail=${scenario.detail}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`WEB-ACCESS runner failed: ${error?.message || error}`);
  process.exitCode = 1;
});
