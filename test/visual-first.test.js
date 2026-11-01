// VFE-001 / DEC-085 — Visual-First Engineering. The rule only means something if it can fail:
// a shape without a state, an evidence path that does not exist, a board that drifts from the
// registry, and a handoff that reports work without showing it. Those are the four tests below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ACCEPTANCE,
  DELIVERY_ORDER,
  DIAGRAM_KINDS,
  MASTER_IDS,
  MASTER_VISUALS,
  PIPELINE,
  SAFETY_KEPT,
  STATUS,
  STATUS_LABEL,
  STATUS_MARK,
  VFE_VERSION,
  VERIFICATION_RULES,
  visualSummary
} from '../src/design/visual-registry.js';
import { PAGE_PATH, buildHtml } from '../scripts/render-visual-first.mjs';
import { WAIVER, VISUAL_SECTION, auditSessionHandoffs, visualSection } from '../scripts/check-visual-first.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

test('registry: every master diagram carries exactly one state and real evidence', () => {
  assert.equal(MASTER_VISUALS.length, 11, 'the owner listed eleven master diagrams');
  assert.equal(new Set(MASTER_IDS).size, MASTER_IDS.length, 'ids are unique');
  const states = Object.values(STATUS);
  for (const entry of MASTER_VISUALS) {
    assert.match(entry.id, /^[a-z_]+(?:\.[a-z_]+)+$/);
    assert.ok(entry.ar && entry.ar.trim(), `${entry.id} needs a readable name`);
    assert.ok(states.includes(entry.status), `${entry.id} has an unknown state`);
    assert.ok(entry.gap && entry.gap.trim(), `${entry.id} must name its gap in words`);
    assert.ok(Array.isArray(entry.evidence) && entry.evidence.length > 0, `${entry.id} cites no evidence`);
    for (const file of entry.evidence) {
      assert.ok(existsSync(path.join(root, file)), `${entry.id} cites ${file}, which does not exist`);
    }
    if (entry.artifact) assert.ok(existsSync(path.join(root, entry.artifact)), `${entry.id} draws ${entry.artifact}, which is missing`);
    if (entry.status === STATUS.implemented) {
      assert.ok(entry.artifact, `${entry.id} claims verification without a page that shows it`);
      assert.ok(entry.evidence.length >= 2, `${entry.id} claims verification on a single file`);
    }
    if (entry.status === STATUS.missing) assert.equal(entry.artifact, null, `${entry.id} says missing and links a page`);
  }
});

test('registry: the five states are the owner\'s, with the owner\'s wording', () => {
  assert.deepEqual(Object.keys(STATUS_MARK), Object.values(STATUS));
  assert.deepEqual(Object.values(STATUS_MARK), ['🟢', '🟡', '🔵', '🔴', '⚪']);
  assert.deepEqual(Object.values(STATUS_LABEL), ['موجود ومتحقق', 'جزئي أو بقيود', 'مقترح', 'غير موجود', 'موجود وغير مفعّل']);
  assert.equal(Object.keys(STATUS).length, 5);
});

test('registry: the summary reports the honest number, not the flattering one', () => {
  const summary = visualSummary();
  assert.equal(summary.total, MASTER_VISUALS.length);
  assert.equal(
    summary.implemented + summary.partial + summary.proposed + summary.missing + summary.disabled,
    summary.total
  );
  assert.ok(summary.missing >= 1, 'a system with no missing diagram is a system that has not looked');
  assert.ok(summary.implemented < summary.total, 'not everything is verified, and the registry says so');
  assert.equal(VFE_VERSION, 'celiaos-vfe-2026-v1');
});

test('the presentation order, the shapes and the pipeline are the owner\'s, in his sequence', () => {
  assert.deepEqual(PIPELINE, ['BUILD', 'VISUALIZE', 'EXECUTE', 'VERIFY', 'PRESENT EVIDENCE']);
  assert.deepEqual(DELIVERY_ORDER.map((step) => step.n), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(DELIVERY_ORDER[0].ar, 'الهدف والتغيير');
  assert.equal(DELIVERY_ORDER[7].ar, 'الخطوة التالية');
  assert.equal(DIAGRAM_KINDS.length, 10);
  assert.equal(VERIFICATION_RULES.length, 7);
  assert.deepEqual(ACCEPTANCE, [
    'نتيجة برمجية قابلة للتحقق',
    'مخطط بصري مطابق للتنفيذ',
    'اختبارات أو أدلة مناسبة',
    'قائمة بالفجوات المتبقية'
  ]);
  assert.equal(SAFETY_KEPT.length, 5, 'the five safety rules survive every picture');
  assert.ok(SAFETY_KEPT[0].includes('NETWORK = DENY'));
});

test('the board is generated: it equals the render of the registry, byte for byte', () => {
  assert.ok(existsSync(PAGE_PATH), 'docs/design/visual-first.html must exist');
  const page = readFileSync(PAGE_PATH, 'utf8');
  assert.equal(page, buildHtml(), 'the board is stale — run `npm run visual:first`');
  assert.match(page, /<html lang="ar" dir="rtl">/, 'the board is Arabic and RTL');
  assert.match(page, /--bg:#080d24/, 'the board keeps the dark-navy identity');
  assert.match(page, /--gold:#fbbf24/, 'gold is present');
  assert.match(page, /name="celia-visual"/, 'the board carries its generated provenance');
  assert.match(page, /public\/fonts\//, 'fonts are local, never fetched');
  for (const entry of MASTER_VISUALS) {
    const escaped = entry.ar.replace(/&/g, '&amp;');
    assert.ok(page.includes(escaped), `the board omits ${entry.id}`);
  }
});

test('AGENTS.md carries the rule permanently, and the baseline commands include its gate', () => {
  const agents = read('AGENTS.md');
  assert.match(agents, /## Visual-First Engineering \(VFE-001 \/ DEC-085\)/);
  assert.match(agents, /Show the System, Don't Just Describe It/);
  assert.match(agents, /🟢 IMPLEMENTED & VERIFIED/);
  assert.match(agents, /## الدليل البصري/);
  assert.match(agents, /npm run visual:first:check/);
  const template = read('docs/continuity/SESSION_TEMPLATE.md');
  assert.match(template, /## الدليل البصري/, 'the handoff template asks for the visual evidence');
});

test('the handoff audit: a session without the section fails, a waiver or a live link passes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vfe-'));
  mkdirSync(path.join(dir, 'docs/design'), { recursive: true });
  writeFileSync(path.join(dir, 'docs/design/board.html'), '<!doctype html>');
  const file = (name, text) => ({ path: `docs/continuity/sessions/${name}`, text });

  const missing = auditSessionHandoffs({ root: dir, files: [file('a.md', '# جلسة\n\n## ما تغير فعليًا\n- شيء')] });
  assert.equal(missing.ok, false);
  assert.match(missing.failures[0].reason, /missing the "## الدليل البصري"/);

  const empty = auditSessionHandoffs({ root: dir, files: [file('b.md', `## ${VISUAL_SECTION}\n\n## الحفظ`) ] });
  assert.equal(empty.ok, false);
  assert.match(empty.failures[0].reason, /empty/);

  const silent = auditSessionHandoffs({ root: dir, files: [file('c.md', `## ${VISUAL_SECTION}\n- تم البناء.`)] });
  assert.equal(silent.ok, false);
  assert.match(silent.failures[0].reason, /no visual artifact link/);

  const waived = auditSessionHandoffs({ root: dir, files: [file('d.md', `## ${VISUAL_SECTION}\n- ${WAIVER}: سياسة لا بنية.`)] });
  assert.equal(waived.ok, true, 'a named waiver is honest and accepted');

  const linked = auditSessionHandoffs({ root: dir, files: [file('e.md', `## ${VISUAL_SECTION}\n- [اللوحة](../../design/board.html)`)] });
  assert.equal(linked.ok, true);

  const broken = auditSessionHandoffs({ root: dir, files: [file('f.md', `## ${VISUAL_SECTION}\n- [اللوحة](../../design/none.html)`)] });
  assert.equal(broken.ok, false);
  assert.match(broken.failures[0].reason, /does not exist/);
});

test('visualSection stops at the next heading, so evidence cannot leak from another section', () => {
  const body = visualSection('# x\n\n## الدليل البصري\n\n- [a](../../design/board.html)\n\n## القيود\n\n- [b](../../design/other.html)');
  assert.ok(body.includes('board.html'));
  assert.ok(!body.includes('other.html'));
  assert.equal(visualSection('## شيء آخر\n- [a](x.html)'), null);
});

test('every session handoff in this repository is either linked or explicitly waived', () => {
  // Historical records predate the rule; the gate audits the change range. This test only refuses a
  // section that exists and is malformed, so the rule never weakens what it already touched.
  const sessionsDir = path.join(root, 'docs/continuity/sessions');
  const files = readdirSync(sessionsDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({ path: `docs/continuity/sessions/${name}`, text: readFileSync(path.join(sessionsDir, name), 'utf8') }))
    .filter((file) => visualSection(file.text) !== null);
  assert.ok(files.length >= 1, 'at least the newest handoffs carry the section');
  const { ok, failures } = auditSessionHandoffs({ root, files });
  assert.equal(ok, true, failures.map((failure) => `${failure.path}: ${failure.reason}`).join('\n'));
});
