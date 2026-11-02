/**
 * DES-002 / المرحلة 2 — اختبارات اختيار المهارة من السجل.
 *
 * ما تثبته:
 * - المخطط يIndekshemer 只有 المهارات active (draft غير مرئية).
 * - المطابقة حسب القسم، والصلاحيات الممنوحة voleva都必须.
 * - لا مطابقة ⇒ no_skill_matches ولا تُفرض مهارة.
 * - goalWithinContract يرفض goal يطلب أداة خارج عقد المهارة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSkill, goalWithinContract, DEPARTMENT_KEYWORDS } from '../src/skills/selector.js';

function mockRegistry(skills) {
  const active = skills.filter((s) => s.status === 'active');
  return { visibleToPlanner: () => Object.freeze(active) };
}

const SKILLS = [
  { name: 'product-strategist', department: 'product', status: 'active', permissions: ['security.audit.read'], allowedTools: ['kb.search'] },
  { name: 'operations-manager', department: 'operations', status: 'active', permissions: ['infra.monitoring.read', 'security.audit.read'], allowedTools: ['celia.system_status'] },
  { name: 'research-lead', department: 'research', status: 'draft', permissions: ['security.audit.read'], allowedTools: ['kb.search'] }
];

test('SEL-01: picks the active skill matching the goal department', () => {
  const result = selectSkill(mockRegistry(SKILLS), 'أريد استراتيجية منتج جديدة', { grantedPermissions: ['security.audit.read'] });
  assert.equal(result.ok, true);
  assert.equal(result.skill.name, 'product-strategist');
});

test('SEL-02: draft skills are never selected even if they match', () => {
  const result = selectSkill(mockRegistry(SKILLS), 'ابحث في المعرفة عن مصادر', { grantedPermissions: ['security.audit.read'] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no_skill_matches');
});

test('SEL-03: refuses when granted permissions do not cover the skill', () => {
  const result = selectSkill(mockRegistry(SKILLS), 'حالة تشغيل النظام', { grantedPermissions: ['security.audit.read'] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'skill_permissions_not_granted');
  assert.deepEqual(result.candidates, ['operations-manager']);
});

test('SEL-04: succeeds when all skill permissions are granted', () => {
  const result = selectSkill(mockRegistry(SKILLS), 'حالة تشغيل النظام', {
    grantedPermissions: ['security.audit.read', 'infra.monitoring.read']
  });
  assert.equal(result.ok, true);
  assert.equal(result.skill.name, 'operations-manager');
});

test('SEL-05: validates inputs', () => {
  assert.equal(selectSkill(null, 'x').code, 'registry_required');
  assert.equal(selectSkill(mockRegistry(SKILLS), '   ').code, 'goal_required');
});

test('SEL-06: goalWithinContract refuses tools outside the skill contract', () => {
  const skill = SKILLS[0];
  assert.equal(goalWithinContract(skill, 'answer the kb.search question').ok, true);
  const bad = goalWithinContract(skill, 'أرسل رسالة واتساب');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'goal_tool_not_allowed');
  assert.equal(bad.tool, 'whatsapp.send_text');
  assert.equal(goalWithinContract(null, 'x').code, 'skill_required');
});

test('SEL-07: department keyword map covers the five stage-1 departments', () => {
  assert.deepEqual(Object.keys(DEPARTMENT_KEYWORDS).sort(), ['creative', 'finance', 'operations', 'product', 'research']);
});
