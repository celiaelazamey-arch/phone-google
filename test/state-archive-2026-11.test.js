/**
 * SA-01..SA-03 — أرشيف نوفمبر (بلا حذف تاريخ) يبقى مطابقًا لبصمته.
 *
 * أكتوبر له حارسه `R0-02`. هذا الاختبار يعطي نوفمبر نفس المعيار: كل كتلة منقولة تُقاس
 * بالبايت والسطر والبصمة، والنافذة الحيّة تبقى تحت 20 KB، ولا يعود قسم منقول إلى `STATE.md`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archivePath = path.join(root, 'docs/continuity/STATE-ARCHIVE-2026-11.md');
const statePath = path.join(root, 'docs/continuity/STATE.md');
const archive = readFileSync(archivePath, 'utf8');
const state = readFileSync(statePath, 'utf8');

/** رؤوس الكتل بالشكل نفسه: source ثم baseline ثم sha256 ثم bytes ثم lines. */
const HEADER = (prefix) =>
  new RegExp(`^<!--\\s*${prefix}:\\s*source=(\\S+)\\s+baseline=(\\S+)\\s+sha256=([a-f0-9]{64})\\s+bytes=(\\d+)\\s+lines=(\\d+)\\s*-->`, 'm');

const BLOCKS = [
  { label: 'أ', begin: '<!-- BEGIN MOVED STATE SECTIONS -->', end: '<!-- END MOVED STATE SECTIONS -->', header: HEADER('state-archive') },
  { label: 'ب', begin: '<!-- BEGIN MOVED STATE SECTIONS B -->', end: '<!-- END MOVED STATE SECTIONS B -->', header: HEADER('state-archive-block') },
  { label: 'ج', begin: '<!-- BEGIN MOVED STATE SECTIONS C -->', end: '<!-- END MOVED STATE SECTIONS C -->', header: HEADER('state-archive-block') }
];

/** الأسطر بين وسمَي النقل، بلا الوسمين، موصولة بـ\n مع \n أخير — نفس صيغة الرأس. */
function readBlock({ begin, end }) {
  const lines = archive.split('\n');
  const start = lines.indexOf(begin);
  const stop = lines.indexOf(end);
  assert.ok(start !== -1 && stop > start, `وسما النقل موجودان: ${begin}`);
  return `${lines.slice(start + 1, stop).join('\n')}\n`;
}

/** رأس الكتلة = أقرب وسم قبل وسم بدايتها؛ فالبادئة state-archive-block مشتركة بين كتلتين فأكثر، وأول تطابق عام يكذب. */
function findHeader(block) {
  const beginIdx = archive.indexOf(block.begin);
  const before = [...archive.matchAll(new RegExp(block.header.source, 'gm'))]
    .filter((m) => m.index < beginIdx);
  return before[before.length - 1] ?? null;
}

test('SA-01: كل كتلة منقولة تطابق بصمتها وبايتاتها وأسطرها المعلنة', () => {
  for (const block of BLOCKS) {
    const header = findHeader(block);
    assert.ok(header, `رأس الكتلة ${block.label} موجود`);
    const [, source, baseline, sha256, bytes, lines] = header;
    assert.equal(source, 'docs/continuity/STATE.md');
    assert.match(baseline, /^[a-f0-9]{7,40}$/, `الكتلة ${block.label}: الأساس التزام فعلي`);

    const text = readBlock(block);
    assert.equal(createHash('sha256').update(text, 'utf8').digest('hex'), sha256, `الكتلة ${block.label}: البصمة`);
    assert.equal(Buffer.byteLength(text, 'utf8'), Number(bytes), `الكتلة ${block.label}: البايتات`);
    // الرأس يعلن عدد الأسطر كعدد أسطر النص المنقول (أي عدد فواصل الأسطر) لا عدد عناصر split.
    assert.equal((text.match(/\n/g) || []).length, Number(lines), `الكتلة ${block.label}: الأسطر`);
  }
});

test('SA-02: النافذة الحيّة تحت 20 KB وتشير إلى الأرشيفين وNOW', () => {
  const size = statSync(statePath).size;
  assert.ok(size < 20_000, `STATE.md حجمه ${size} بايت`);
  assert.match(state, /\[STATE-ARCHIVE-2026-10\.md\]\(STATE-ARCHIVE-2026-10\.md\)/);
  assert.match(state, /\[STATE-ARCHIVE-2026-11\.md\]\(STATE-ARCHIVE-2026-11\.md\)/);
  assert.match(state, /\[NOW\.md\]\(NOW\.md\)/);
});

test('SA-03: القسم المنقول مؤرشف لا مكرَّر، ولا نصّ بلا نسب', () => {
  for (const block of BLOCKS) {
    const headings = readBlock(block)
      .split('\n')
      .filter((line) => line.startsWith('## '))
      .map((line) => line.trim());
    assert.ok(headings.length >= 1, `الكتلة ${block.label} تحمل قسمًا واحدًا على الأقل`);
    for (const heading of headings) {
      assert.ok(!state.includes(heading), `«${heading}» في الأرشيف فقط، لا في STATE.md الحيّ`);
    }
  }
  assert.equal((archive.match(/BEGIN MOVED STATE SECTIONS/g) || []).length, 3, 'ثلاث كتل معلنة');
});
