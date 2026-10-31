/**
 * ASSUR-003 — اختبارات أداة الاشتقاق (scripts/derive-skill-draft.mjs).
 *
 * سبب مباشر: تشغيل الأداة فعليًا كشف أن مسارًا مطلقًا كان يُكتب داخل
 * المستودع. فالاختبار هنا يقيس **الأثر على القرص** لا القيمة المعادة فقط.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, writeDraft } from '../scripts/derive-skill-draft.mjs';
import { buildSkillDraft } from '../src/agent/skill-draft.js';
import { RUN_STATUS } from '../src/agent/store.js';

const RUN_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function ledger() {
  return {
    run: { id: RUN_ID, status: RUN_STATUS.succeeded },
    steps: [
      { index: 1, kind: 'act', title: 'read.alpha', summary: 'قراءة أولى', toolName: 'read.alpha' },
      { index: 2, kind: 'observe', title: 'read.alpha ✓', summary: 'تم', toolName: 'read.alpha' }
    ],
    toolRuns: [{ toolName: 'read.alpha', status: 'succeeded' }],
    objective: 'لخّص حالة النظام'
  };
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'celia-draft-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('CLI-01: تحليل الوسائط — الأعلام والقيم ومعرّف التشغيل', () => {
  const args = parseArgs([RUN_ID, '--sqlite', '/tmp/x.sqlite3', '--check', '--out-dir', '/tmp/drafts']);
  assert.equal(args.runId, RUN_ID);
  assert.equal(args.sqlite, '/tmp/x.sqlite3');
  assert.equal(args.check, true);
  assert.equal(args.outDir, '/tmp/drafts');
  assert.equal(parseArgs([RUN_ID, '--mysql']).mysql, true);
  assert.equal(parseArgs([]).runId, null);
});

test('CLI-02: الكتابة تحدث في المسار المطلق المطلوب لا داخل المستودع', async (t) => {
  const dir = await tempDir(t);
  const draft = buildSkillDraft(ledger());
  assert.equal(draft.ok, true);
  const result = await writeDraft(draft, { outDir: dir });
  assert.equal(result.wrote, true);
  assert.equal(result.target, path.posix.join(dir, `${RUN_ID}.md`));
  assert.ok(result.target.startsWith('/'), 'المسار المطلق يبقى مطلقًا');
  const written = await readFile(result.target, 'utf8');
  assert.equal(written, draft.markdown);
  // ولا أثر داخل المستودع: لا دليل tmp ولا مسودة في جذر العمل.
  assert.equal(existsSync(path.join(process.cwd(), 'tmp', path.basename(dir))), false);
  assert.equal(existsSync(path.join(process.cwd(), 'data', 'skill-drafts', `${RUN_ID}.md`)), false);
});

test('CLI-03: --check يميّز المطابق والمنحرف والمفقود', async (t) => {
  const dir = await tempDir(t);
  const draft = buildSkillDraft(ledger());
  const missing = await writeDraft(draft, { check: true, outDir: dir });
  assert.equal(missing.code, 'draft_missing');
  assert.equal(missing.wrote, false);

  await writeDraft(draft, { outDir: dir });
  const verified = await writeDraft(draft, { check: true, outDir: dir });
  assert.equal(verified.code, null);
  assert.equal(verified.digest, draft.digest);

  await writeFile(path.join(dir, `${RUN_ID}.md`), `${draft.markdown}\nسطر مدسوس\n`, 'utf8');
  const drift = await writeDraft(draft, { check: true, outDir: dir });
  assert.equal(drift.code, 'draft_drift');
  assert.equal(drift.wrote, false, 'وضع التحقق لا يكتب فوق الانحراف');
});

test('CLI-04: مسار محكوم يُرفض قبل أي كتابة على القرص', async (t) => {
  const dir = await tempDir(t);
  const draft = buildSkillDraft(ledger());
  const governed = path.posix.join(dir, '.agents', 'skills', 'injected');
  await assert.rejects(() => writeDraft(draft, { outDir: governed }), /governed_skills_path_refused/);
  assert.equal(existsSync(path.join(governed, `${RUN_ID}.md`)), false, 'لم يُنشأ أي ملف');
});

test('CLI-05: مسوّدة مرفوضة لسرّ لا تصل إلى الأداة أصلًا', () => {
  const poisoned = ledger();
  poisoned.steps[0].summary = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAA';
  const draft = buildSkillDraft(poisoned);
  assert.equal(draft.ok, false);
  assert.equal(draft.code, 'secret_detected');
  assert.equal(draft.markdown, undefined, 'لا نص يمكن تمريره للكتابة');
});
