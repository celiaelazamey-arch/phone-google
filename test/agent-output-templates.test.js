/**
 * M-B/B3 — اختبارات قوالب المخرجات الحتمية والمهام الذهبية الثلاث.
 *
 * TPL-01..05 نقية بلا شبكة؛ TPL-06 يشغّل بوابة `eval:templates` الحقيقية
 * (الحلقة كاملة + البصمات الذهبية المثبتة في data/eval/b3-templates/golden.json).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TEMPLATE_KINDS,
  markdownToHtml,
  renderCsvTable,
  renderMarkdownReport,
  renderStaticPage,
  renderTemplate
} from '../src/agent/output-templates.js';
import { createToolRegistry, defaultToolDefinitions, RISK } from '../src/agent/tools.js';
import { goldenDigests, runTemplateGoldenTasks, TEMPLATE_GOLDEN_TASKS } from '../src/agent/template-eval.js';

test('TPL-01: rendering is byte-deterministic — same spec, same bytes, same digest, no clock anywhere', () => {
  const spec = { title: 'تقرير', sections: [{ heading: 'قسم', body: 'نص **مهم** مع `كود`.\n\n- بند أول\n- بند ثانٍ' }] };
  const first = renderTemplate('markdown_report', spec);
  const second = renderTemplate('markdown_report', spec);
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(first.content, second.content);
  assert.equal(first.bytes, first.content.length);
  assert.deepEqual(TEMPLATE_KINDS, ['markdown_report', 'csv_table', 'static_page']);
});

test('TPL-02: every injected payload is escaped — no raw HTML, no scripts, no external requests in any output', () => {
  const hostile = '<script>alert("x")</script> & <img src="https://evil.example/x.png"> "اقتباس"';
  const report = renderMarkdownReport({ title: hostile, sections: [{ heading: hostile, body: hostile }] });
  const page = renderStaticPage({ title: hostile, body: hostile });
  for (const html of [report, page]) {
    assert.ok(!html.includes('<script>alert'), 'script tags are neutralized');
    assert.ok(!html.includes('<img'), 'raw elements are neutralized');
    assert.ok(html.includes('&lt;script&gt;'), 'escaping is visible, not stripping');
    // الإهانة المهرَّبة نص خامل؛ الممنوع هو أي عنصر فعلي يحمل src/href أو تحميل CSS خارجي.
    assert.ok(!/<\w+[^>]*\s(src|href)\s*=/i.test(html), 'no real element carries src/href — zero external requests');
    assert.ok(!/url\(|@import/.test(html), 'the inline stylesheet loads nothing');
  }
  const csv = renderCsvTable({ columns: ['a'], rows: [['قيمة "مقتبسة", وفاصلة\nوسطر']] });
  assert.equal(csv, 'a\n"قيمة ""مقتبسة"", وفاصلة\nوسطر"\n', 'RFC 4180 quoting is exact');
});

test('TPL-03: malformed specs refuse with explicit codes — nothing renders partially', () => {
  assert.throws(() => renderTemplate('pdf', {}), (e) => e.code === 'template_kind_unknown');
  assert.throws(() => renderMarkdownReport({ title: '', sections: [] }), (e) => e.code === 'template_title_invalid');
  assert.throws(() => renderMarkdownReport({ title: 'ع', sections: [] }), (e) => e.code === 'template_sections_invalid');
  assert.throws(() => renderMarkdownReport({ title: 'ع', sections: [{ heading: 'ق', body: 7 }] }), (e) => e.code === 'template_section_body_invalid');
  assert.throws(() => renderCsvTable({ columns: [], rows: [] }), (e) => e.code === 'template_columns_invalid');
  assert.throws(() => renderCsvTable({ columns: ['a', 'b'], rows: [['x']] }), (e) => e.code === 'template_row_shape_invalid');
  assert.throws(() => renderStaticPage({ title: 'ع', body: '' }), (e) => e.code === 'template_body_invalid');
});

test('TPL-04: the markdown subset is closed — headings, lists, bold, code; raw HTML never passes through', () => {
  const html = markdownToHtml('# عنوان\nفقرة أولى **عريض**.\n\n- بند `كود`\n- بند آخر\n\n## فرعي\nفقرة ثانية');
  assert.ok(html.includes('<h2>عنوان</h2>'), 'top heading maps to h2 (h1 is reserved for the document title)');
  assert.ok(html.includes('<strong>عريض</strong>'));
  assert.ok(html.includes('<li>بند <code>كود</code></li>'));
  assert.ok(html.includes('<h3>فرعي</h3>'));
  const raw = markdownToHtml('<div onclick="x()">خام</div>');
  assert.ok(raw.includes('&lt;div'), 'raw HTML is escaped, not interpreted');
});

test('TPL-05: template.render exists only with an artifact store — and is a settled internal write', () => {
  const bare = createToolRegistry(defaultToolDefinitions({ statusProvider: () => ({}) }));
  assert.equal(bare.list().some((tool) => tool.name === 'template.render'), false);
  const registry = createToolRegistry(defaultToolDefinitions({
    statusProvider: () => ({}),
    artifacts: { publish() {}, list() {}, open() {} }
  }));
  const tool = registry.get('template.render');
  assert.equal(tool.risk, RISK.internalWrite);
  assert.equal(tool.settledFailures, true);
  assert.equal(registry.executable('template.render'), true);
  assert.equal(registry.validateInput('template.render', { kind: 'csv_table', spec: {}, name: 'x.csv' }).ok, true);
  assert.equal(registry.validateInput('template.render', { kind: 7, spec: {}, name: 'x' }).code, 'policy_violation_argument_type');
});

test('TPL-06 (acceptance): the three golden tasks pass the full loop against the pinned digests', async () => {
  const pinned = JSON.parse(readFileSync(new URL('../data/eval/b3-templates/golden.json', import.meta.url), 'utf8'));
  assert.equal(pinned.length, 3, 'exactly three golden tasks');
  assert.deepEqual(
    goldenDigests(),
    pinned,
    'the committed golden digests match the current templates byte for byte — any drift fails here first'
  );
  const report = await runTemplateGoldenTasks({ expected: pinned });
  assert.equal(report.pass, true);
  assert.equal(report.passedTasks, 3);
  const kinds = report.tasks.map((task) => task.kind).sort();
  assert.deepEqual(kinds, ['csv_table', 'markdown_report', 'static_page'], 'all three output types are produced');
  for (const task of report.tasks) {
    assert.equal(task.runStatus, 'succeeded');
    assert.equal(task.downloadedSha256, task.expectedSha256);
    assert.equal(task.checks.publishedInEvidence, true);
    assert.equal(task.checks.evidenceChainOk, true);
  }
  assert.equal(TEMPLATE_GOLDEN_TASKS.length, 3);
});
