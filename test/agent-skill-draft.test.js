/**
 * ASSUR-003 — مسوّدة مهارة من السجل الدائم.
 *
 * ما تُثبته هذه الاختبارات:
 * - المسار محروس: `.agents/skills/` مرفوض بكل صيغة (نسبية، `..`، فواصل ويندوز).
 * - الاشتقاق من سجل تشغيل حقيقي في SQLite، لا من كائن مصنوع.
 * - سرّ مزروع في أي نص ⇒ **رفض بكود**، ولا مسوّدة ولا كتابة.
 * - الحتمية: نفس السجل يعيد نفس البصمة.
 * - المسوّدة تعلن أنها مسوّدة غير مثبّتة، ولا تدّعي صلاحية معمّمة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTempStore, createRecordingTools, threeReadsThenFinish } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createScriptedPlanner } from '../src/agent/planner.js';
import {
  buildSkillDraft,
  skillDraftPath,
  assertSafeDraftPath,
  SKILL_DRAFT_DIR,
  SKILL_DRAFT_VERSION
} from '../src/agent/skill-draft.js';
import { RUN_STATUS } from '../src/agent/store.js';

/** يشغّل مهمة حقيقية ويعيد سجلها الدائم كما قرأه المخزن. */
async function realLedger(t, { failTools = {} } = {}) {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const recorder = createRecordingTools({ failTools });
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: recorder.tools,
    planner: createScriptedPlanner(threeReadsThenFinish()),
    workerId: 'skill-draft-worker',
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'مهمة للاشتقاق' });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'لخّص حالة النظام' });
  const finished = await runtime.runToCompletion(run.id);
  return {
    run: finished,
    steps: await fixture.store.listSteps(run.id),
    toolRuns: await fixture.store.listToolRuns(run.id),
    objective: 'لخّص حالة النظام'
  };
}

test('SD-01: مسار المهارات الإجرائية مرفوض بكل صيغة تحايلية', () => {
  const refused = [
    '.agents/skills',
    '.agents/skills/new-skill/SKILL.md',
    './.agents/skills/x/SKILL.md',
    'data/../.agents/skills/x/SKILL.md',
    '.agents\\skills\\x\\SKILL.md',
    '/repo/.agents/skills/x/SKILL.md'
  ];
  for (const target of refused) {
    assert.throws(() => assertSafeDraftPath(target), /governed_skills_path_refused/, target);
  }
  assert.throws(() => assertSafeDraftPath(''), /draft_path_required/);
  // ومسار المسوّدات المشروع يمرّ.
  assert.equal(assertSafeDraftPath(`${SKILL_DRAFT_DIR}/run-1.md`), `${SKILL_DRAFT_DIR}/run-1.md`);
});

test('SD-11: المسار المطلق يبقى مطلقًا — لا كتابة خفية داخل المستودع', () => {
  // عيب حقيقي كشفه تشغيل الـCLI: إسقاط الشرطة الأولى حوّل /tmp/x إلى tmp/x
  // فكتب داخل المستودع. الحارس يطبّع ولا يغيّر جذر المسار.
  assert.equal(assertSafeDraftPath('/tmp/celia-drafts/run-1.md'), '/tmp/celia-drafts/run-1.md');
  assert.equal(assertSafeDraftPath('/tmp/a/../celia-drafts/run-1.md'), '/tmp/celia-drafts/run-1.md');
  assert.equal(assertSafeDraftPath('data/skill-drafts/./run-1.md'), 'data/skill-drafts/run-1.md');
  // والجذر لا يفتح ثغرة في الحراسة: المسار المحكوم مرفوض مطلقًا كان أو نسبيًا.
  assert.throws(() => assertSafeDraftPath('/tmp/.agents/skills/x/SKILL.md'), /governed_skills_path_refused/);
  assert.throws(() => assertSafeDraftPath('/tmp/../.agents/skills/x'), /governed_skills_path_refused/);
});

test('SD-02: مسار المسوّدة داخل دليل المسوّدات، ومعرّف التشغيل يُتحقّق منه', () => {
  const id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  assert.equal(skillDraftPath(id), `${SKILL_DRAFT_DIR}/${id}.md`);
  for (const bad of ['', 'short', '../escape', 'a/b', 'x'.repeat(65), null]) {
    assert.throws(() => skillDraftPath(bad), /invalid_run_id/);
  }
});

test('SD-03: الاشتقاق من سجل حقيقي — خطوات مرتبة وأدوات بترتيب أول ظهور', async (t) => {
  const ledger = await realLedger(t);
  assert.equal(ledger.run.status, RUN_STATUS.succeeded);
  const draft = buildSkillDraft(ledger);
  assert.equal(draft.ok, true, JSON.stringify(draft));
  assert.equal(draft.path, `${SKILL_DRAFT_DIR}/${ledger.run.id}.md`);
  assert.deepEqual(draft.tools, ['read.alpha', 'read.beta', 'read.gamma']);
  assert.deepEqual(draft.failures, []);
  assert.match(draft.markdown, /## النية/);
  assert.match(draft.markdown, /لخّص حالة النظام/);
  assert.match(draft.markdown, /## الخطوات المرتبة/);
  // الترتيب من فهرس الخطوة لا من ترتيب مصفوفة الإدخال.
  const shuffled = { ...ledger, steps: [...ledger.steps].reverse() };
  assert.equal(buildSkillDraft(shuffled).markdown, draft.markdown, 'ترتيب المخزن لا يغيّر المسوّدة');
});

test('SD-04: تشغيل غير منتهٍ لا تُشتق منه مهارة', async (t) => {
  const ledger = await realLedger(t);
  for (const status of [RUN_STATUS.queued, RUN_STATUS.running, undefined]) {
    const result = buildSkillDraft({ ...ledger, run: { ...ledger.run, status } });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'run_not_finished');
  }
  assert.equal(buildSkillDraft({}).code, 'run_required');
  assert.equal(buildSkillDraft({ run: ledger.run, steps: [] }).code, 'no_steps_to_derive');
});

test('SD-05: سرّ مزروع في ملخص خطوة ⇒ رفض بكود ولا مسوّدة', async (t) => {
  const ledger = await realLedger(t);
  const poisoned = ledger.steps.map((step, index) =>
    index === 1 ? { ...step, summary: 'نتيجة الأداة ghp_AAAAAAAAAAAAAAAAAAAAAAAA' } : step
  );
  const result = buildSkillDraft({ ...ledger, steps: poisoned });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'secret_detected');
  assert.equal(result.markdown, undefined, 'لا نص يُكتب عند الرفض');
  assert.equal(result.path, undefined);
  assert.deepEqual(result.details, ['kind:github_token']);
});

test('SD-06: سرّ في نص الهدف أو عنوان خطوة يُرفض أيضًا — البوابة على النص كله', async (t) => {
  const ledger = await realLedger(t);
  const inObjective = buildSkillDraft({ ...ledger, objective: 'استخدم api_key=supersecretvalue للمهمة' });
  assert.equal(inObjective.ok, false);
  assert.equal(inObjective.code, 'secret_detected');

  const inTitle = buildSkillDraft({
    ...ledger,
    steps: ledger.steps.map((step, index) => (index === 0 ? { ...step, title: 'AKIABBBBBBBBBBBBBBBB' } : step))
  });
  assert.equal(inTitle.ok, false);
  assert.equal(inTitle.code, 'secret_detected');
});

test('SD-07: تشغيل فاشل تُشتق مسوّدة تعلن فشلها ولا توصي بها', async (t) => {
  const ledger = await realLedger(t, { failTools: { alpha: true } });
  const draft = buildSkillDraft(ledger);
  assert.equal(draft.ok, true, JSON.stringify(draft));
  assert.ok(draft.failures.includes('read.alpha'), JSON.stringify(draft.failures));
  assert.match(draft.markdown, /## شروط الفشل المشاهدة/);
  assert.match(draft.markdown, /فشلت `read\.alpha`/);
  assert.match(draft.markdown, /لم ينجح، فالمسوّدة ليست إجراءً موصى به/);
});

test('SD-08: حتمية — نفس السجل يعيد نفس البصمة والنص', async (t) => {
  const ledger = await realLedger(t);
  const first = buildSkillDraft(ledger);
  const second = buildSkillDraft(ledger);
  assert.equal(first.digest, second.digest);
  assert.equal(first.markdown, second.markdown);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
});

test('SD-09: الترويسة تعلن مسوّدة غير مثبّتة وتحتاج مراجعة', async (t) => {
  const ledger = await realLedger(t);
  const { markdown } = buildSkillDraft(ledger);
  assert.match(markdown, /^---\n/);
  assert.match(markdown, /status: draft/);
  assert.match(markdown, /review: required/);
  assert.match(markdown, /installed: false/);
  assert.match(markdown, new RegExp(`version: ${SKILL_DRAFT_VERSION}`));
  assert.match(markdown, new RegExp(`source_run: ${ledger.run.id}`));
  assert.match(markdown, /R0-04/);
  assert.match(markdown, /لا تصوير شاشة، لا حافظة، لا رفع سحابي/);
  assert.match(markdown, /نجاح تشغيل واحد لا يثبت إجراءً قابلًا للتعميم/);
});

test('SD-10: الوحدة خالصة — لا شبكة ولا نظام ملفات ولا تثبيت', () => {
  const source = readFileSync(new URL('../src/agent/skill-draft.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .*from '(.+)';$/gm)].map((match) => match[1]);
  assert.deepEqual(imports.sort(), ['./evidence.js', './store.js', '../knowledge/validate.js'].sort());
  for (const forbidden of ['node:fs', 'node:net', 'node:https', 'node:child_process', 'fetch(', 'writeFile']) {
    assert.ok(!source.includes(forbidden), `الوحدة يجب ألا تستخدم ${forbidden}`);
  }
});
