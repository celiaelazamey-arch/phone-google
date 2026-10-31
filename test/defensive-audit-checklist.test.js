/**
 * ASSUR-004 — حارس صدق قائمة التدقيق الدفاعي.
 *
 * القائمة وثيقة تستشهد بملفات وأسماء اختبارات وأوامر npm. الاستشهاد يتعفّن
 * صامتًا حين يُعاد تسمية اختبار أو يُحذف أمر. فهذا الاختبار يقيس أن كل
 * استشهاد **قابل للحل** اليوم، وأن الوثيقة لا تدّعي استيراد مكتبة هجوم.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(path.join(root, 'docs/defensive-audit-checklist.md'), 'utf8');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

test('DA-01: كل ملف مستشهَد به موجود فعلًا', () => {
  const cited = [...new Set([...doc.matchAll(/`((?:src|test|scripts|workers|docs)\/[A-Za-z0-9_./-]+)`/g)].map((m) => m[1]))];
  assert.ok(cited.length >= 15, `الوثيقة تستشهد بملفات كافية؛ وُجد ${cited.length}`);
  for (const rel of cited) {
    assert.ok(existsSync(path.join(root, rel)), `استشهاد معطوب: ${rel}`);
  }
});

test('DA-02: كل أمر npm مستشهَد به معرّف في package.json', () => {
  const commands = [...new Set([...doc.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)].map((m) => m[1]))];
  assert.ok(commands.length >= 4);
  for (const name of commands) {
    assert.ok(Object.hasOwn(pkg.scripts, name), `أمر غير معرّف: npm run ${name}`);
  }
});

test('DA-03: كل معرّف اختبار مستشهَد به موجود في ملف اختبار', () => {
  const ids = [...new Set([...doc.matchAll(/\b(SP|EP|PR|FZ|NP|SD|CLI)-(\d{2})\b/g)].map((m) => `${m[1]}-${m[2]}`))];
  assert.ok(ids.length >= 10, `معرّفات كافية؛ وُجد ${ids.length}`);
  const corpus = readdirSync(path.join(root, 'test'))
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => readFileSync(path.join(root, 'test', name), 'utf8'))
    .join('\n');
  for (const id of ids) {
    assert.ok(corpus.includes(id), `معرّف اختبار غير موجود: ${id}`);
  }
});

test('DA-04: كل مهمة مستشهَد بها مسجّلة في BACKLOG', () => {
  const backlog = readFileSync(path.join(root, 'docs/continuity/BACKLOG.md'), 'utf8');
  const tasks = [...new Set([...doc.matchAll(/\b(SEC|MAN|ASSUR)-(\d{3})\b/g)].map((m) => `${m[1]}-${m[2]}`))];
  assert.ok(tasks.length >= 6);
  for (const id of tasks) {
    assert.ok(backlog.includes(`| ${id} |`), `مهمة غير مسجّلة: ${id}`);
  }
});

test('DA-05: الفجوة المقاسة مسجّلة مخططة ولا تُدّعى مُصلَحة', () => {
  const backlog = readFileSync(path.join(root, 'docs/continuity/BACKLOG.md'), 'utf8');
  const row = backlog.split('\n').find((line) => line.startsWith('| SEC-007 |'));
  assert.ok(row, 'SEC-007 مسجّلة');
  assert.match(row, /\| P1 \| مخطط/);
  // والوثيقة تنسب الحماية للحافة حيث توجد فعلًا — لا تعميم كاذب.
  assert.match(doc, /workers\/celia-edge\/accounts\.js/);
  assert.match(doc, /سطح Express/);
});

test('DA-06: صفر استيراد لمكتبة الهجوم — إسناد فقط', () => {
  // لا دليل بائع للمصدر، ولا مهارة جديدة في المسار المحكوم.
  assert.equal(existsSync(path.join(root, 'vendor/claude-red')), false);
  const skills = readdirSync(path.join(root, '.agents/skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(skills, ['continuity-handoff', 'governed-pr-merge', 'quality-gates', 'session-orient']);
  // والإسناد معلن بالاسم والترخيص.
  assert.match(doc, /SnailSploit\/Claude-Red/);
  assert.match(doc, /MIT/);
  for (const skill of ['offensive-api-security', 'offensive-fuzzing', 'offensive-ai-security', 'offensive-cicd-secrets', 'offensive-reporting']) {
    assert.ok(doc.includes(skill), `الإسناد يسمّي ${skill}`);
  }
  // والنطاق الدفاعي صريح.
  assert.match(doc, /لا فحص لهدف خارجي/);
});
