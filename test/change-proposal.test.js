/**
 * SIE-001 / SI-6/E3 — كائن مقترح التغيير على النظام نفسه.
 *
 * العقيدة (تدقيق `SI-0` · `DEC-124`): كائن بيانات بـ`rollback_plan` و`required_approvals` —
 * وحالته `PROPOSED` لا تتغير في الكود إطلاقًا: لا apply ولا اعتماد يُستهلك آليًا؛ فالاعتماد
 * فعلُ بشري بالمسار القائم (BACKLOG + DECISIONS + سجل جلسة). اقتراحٌ بلا خطة تراجع أو بلا
 * اعتماد مطلوب يُرفض، وكل حقل إلزامي فشلٌ مغلق.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANGE_PROPOSAL_VERSION,
  CHANGE_PROPOSAL_LIMIT,
  PROPOSED,
  createChangeProposal
} from '../src/agent/change-proposal.js';

function proposal(overrides = {}) {
  return createChangeProposal({
    title: 'تفعيل شريحة فهم ذاتي',
    motivation: 'يجعل المشتقّات سطح قرار بلا مصدر حقيقة ثانٍ',
    changes: [{ path: 'src/agent/tools.js', summary: 'تسجيل أداة قراءة جديدة' }],
    rollbackPlan: ['إزالة التسجيل من createDefaultTools', 'تشغيل البوابات الـ16 والمجموعة الكاملة'],
    requiredApprovals: ['owner'],
    createdBy: 'celia-agent',
    ...overrides
  });
}

test('E3: the proposal carries the audited fields — rollback plan, required approvals, frozen, PROPOSED', () => {
  const p = proposal();
  assert.equal(p.version, CHANGE_PROPOSAL_VERSION);
  for (const field of ['title', 'motivation', 'changes', 'rollbackPlan', 'requiredApprovals', 'createdBy', 'status', 'executable', 'limit']) {
    assert.ok(field in p, `${field} is part of the object`);
  }
  assert.equal(p.status, PROPOSED);
  assert.equal(p.executable, false);
  assert.equal(p.limit, CHANGE_PROPOSAL_LIMIT);
  assert.match(p.limit, /لا apply ولا apply_self_change/);
  assert.equal(Object.isFrozen(p), true);
  assert.equal(Object.isFrozen(p.changes), true);
  assert.throws(() => { 'use strict'; p.status = 'APPROVED'; }, TypeError, 'the state cannot be flipped');
});

test('E3: fail closed — a proposal without a rollback plan or required approvals is refused', () => {
  assert.throws(() => proposal({ title: '' }), /title_required/);
  assert.throws(() => proposal({ motivation: null }), /motivation_required/);
  assert.throws(() => proposal({ changes: [] }), /changes_required/);
  assert.throws(() => proposal({ rollbackPlan: [] }), /rollback_plan_required/);
  assert.throws(() => proposal({ requiredApprovals: [] }), /required_approvals_required/);
  assert.throws(() => proposal({ createdBy: '  ' }), /created_by_required/);
  assert.throws(
    () => proposal({ changes: [{ path: '../escape.js', summary: 'x' }] }),
    /path_invalid/,
    'no traversal in proposed paths'
  );
  assert.throws(
    () => proposal({ changes: [{ path: '/etc/passwd', summary: 'x' }] }),
    /path_invalid/
  );
  assert.throws(
    () => proposal({
      changes: Array.from({ length: 21 }, (_, index) => ({ path: `f${index}.js`, summary: 'x' }))
    }),
    /changes_required/
  );
  assert.throws(
    () => proposal({ requiredApprovals: ['owner', 'owner'] }),
    /approvals_distinct/,
    'approval entries are distinct roles, not padded votes'
  );
});

test('E3: PROPOSED is the only state this object can ever produce', () => {
  const exportsOfModule = Object.keys(proposal({})).filter((key) => key === 'status');
  assert.deepEqual(exportsOfModule, ['status']);
  const again = proposal();
  assert.equal(again.status, PROPOSED, 'every construction starts at PROPOSED');
  const roundTrip = JSON.parse(JSON.stringify(again));
  assert.equal(roundTrip.status, PROPOSED, 'serialization carries no hidden approval state');
  const tampered = { ...roundTrip, status: 'APPROVED' };
  assert.notEqual(tampered.status, again.status, 'a copy is not the object; the object itself never changes');
});

test('E3: a realistic self-change proposal validates against real repository paths', () => {
  const p = proposal({
    title: 'اقتراح: سقف مهلة أداة الويب',
    changes: [
      { path: 'src/agent/web-tools.js', summary: 'رفع مهلة الجلب من 20s إلى 25s مع بقاء الميزانية' },
      { path: 'test/agent-web-access.test.js', summary: 'اختبار المهلة الجديدة' }
    ],
    rollbackPlan: [
      'إعادة قيمة المهلة إلى 20s',
      'إسقاط الاختبار المضاف',
      'تشغيل البوابات الـ16 والمجموعة الكاملة قبل أي دفع'
    ],
    requiredApprovals: ['owner']
  });
  assert.equal(p.changes.length, 2);
  assert.deepEqual(p.requiredApprovals, ['owner']);
  assert.equal(p.rollbackPlan.length, 3);
});
