/**
 * DES-002 / المرحلة 1 — اختبارات سجل المهارات ومخطط العقد.
 *
 * ما تثبته:
 * - المخطط يقرأ ترويسة SKILL.md صحيحة ويرفض كلStation hallucination in the shape.
 * - السجل يحمّل 5 مهارات من `src/skills/` بعقود متحقق منها.
 * - refuses any skill referencing an unregistered tool or unknown permission id.
 * - draft skills are invisible to the planner (DEC-112).
 * - Registry is frozen and deterministic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { constants, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  parseSkillMarkdown,
  validateSkillContract,
  parseFrontmatter,
  SKILL_STATUSES,
  PLANNER_VISIBLE_STATUS
} from '../src/skills/schema.js';
import { createSkillRegistry } from '../src/skills/registry.js';
import { GRANT_IDS } from '../src/agent/access-policy.js';

const here = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(here, '..', 'src', 'skills');

const REAL_TOOLS = [
  'product.catalog_audit', 'kb.search', 'kb.project_context', 'kb.tool_profile',
  'spider.search_knowledge', 'spider.graph_stats', 'creative.workflow_plan',
  'celia.draft_outline', 'celia.system_status', 'celia.thread_context',
  'template.render', 'google.drive_export_report', 'google.calendar_create_event',
  'whatsapp.send_text', 'artifact.create', 'sandbox.exec'
];
const mockToolRegistry = { has: (name) => REAL_TOOLS.includes(name) };

function validContract(overrides = {}) {
  return {
    name: 'test-skill',
    version: '0.1.0',
    department: 'test',
    status: 'draft',
    allowed_tools: ['kb.search'],
    permissions: ['security.audit.read'],
    inputs: 'input',
    outputs: 'output',
    verification: 'check',
    evidence_required: 'run.id',
    ...overrides
  };
}

const BODY = '# Test\n\nBody text.';

test('SCHEMA-01: valid SKILL.md parses into a frozen contract', () => {
  const md = `---\nname: test-skill\nversion: 0.1.0\ndepartment: test\nstatus: draft\nallowed_tools: [kb.search, celia.system_status]\npermissions:\n  - security.audit.read\ninputs: "in"\noutputs: "out"\nverification: "v"\nevidence_required: "e"\n---\n\n${BODY}`;
  const result = parseSkillMarkdown(md);
  assert.equal(result.ok, true);
  assert.equal(result.contract.name, 'test-skill');
  assert.deepEqual(result.contract.allowedTools, ['kb.search', 'celia.system_status']);
  assert.deepEqual(result.contract.permissions, ['security.audit.read']);
  assert.throws(() => { result.contract.name = 'x'; }, TypeError);
});

test('SCHEMA-02: rejects each malformed field with a named code', () => {
  const cases = [
    [{ name: 'Bad Slug' }, 'skill_name_invalid'],
    [{ version: '1.0' }, 'skill_version_invalid'],
    [{ department: '' }, 'skill_department_missing'],
    [{ status: 'activee' }, 'skill_status_invalid'],
    [{ allowed_tools: [] }, 'skill_allowed_tools_invalid'],
    [{ allowed_tools: ['kb.search', 'kb.search'] }, 'skill_allowed_tools_duplicate'],
    [{ permissions: [] }, 'skill_permissions_invalid'],
    [{ inputs: '' }, 'skill_inputs_missing'],
    [{ outputs: '' }, 'skill_outputs_missing'],
    [{ verification: '' }, 'skill_verification_missing'],
    [{ evidence_required: '' }, 'skill_evidence_missing_field']
  ];
  for (const [overrides, code] of cases) {
    const result = validateSkillContract(validContract(overrides), { body: BODY });
    assert.equal(result.ok, false, JSON.stringify(overrides));
    assert.equal(result.code, code);
  }
});

test('SCHEMA-03: frontmatter must be closed and present', () => {
  assert.equal(parseFrontmatter('no frontmatter').code, 'frontmatter_missing');
  assert.equal(parseFrontmatter('---\nname: x\n').code, 'frontmatter_unclosed');
  assert.equal(parseSkillMarkdown('---\nname: x\n---\n').code, 'skill_version_invalid');
});

test('SCHEMA-04: all statuses are from the closed set; planner sees active only', () => {
  assert.deepEqual([...SKILL_STATUSES], ['draft', 'reviewed', 'active', 'deprecated', 'retired']);
  assert.deepEqual([...PLANNER_VISIBLE_STATUS], ['active']);
});

test('REG-01: loads the 5 stage-1 skills from src/skills with valid contracts', () => {
  const registry = createSkillRegistry({ dir: SKILLS_DIR, toolRegistry: mockToolRegistry, grantIds: GRANT_IDS });
  assert.equal(registry.count(), 5);
  const names = registry.list().map((s) => s.name).sort();
  assert.deepEqual(names, [
    'creative-director',
    'finance-manager',
    'operations-manager',
    'product-strategist',
    'research-lead'
  ]);
  for (const skill of registry.list()) {
    assert.equal(skill.status, 'draft');
    for (const tool of skill.allowedTools) assert.ok(REAL_TOOLS.includes(tool), tool);
    for (const permission of skill.permissions) assert.ok(GRANT_IDS.includes(permission), permission);
  }
});

test('REG-02: refuses a skill that names an unregistered tool', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'));
  mkdirSync(join(dir, 'bad-skill'));
  writeFileSync(join(dir, 'bad-skill', 'SKILL.md'),
    `---\nname: bad-skill\nversion: 0.1.0\ndepartment: test\nstatus: draft\nallowed_tools: [evil.exec]\npermissions: [security.audit.read]\ninputs: i\noutputs: o\nverification: v\nevidence_required: e\n---\n\n${BODY}`);
  assert.throws(
    () => createSkillRegistry({ dir, toolRegistry: mockToolRegistry, grantIds: GRANT_IDS }),
    (err) => err.code === 'skill_tool_not_registered' && err.tool === 'evil.exec'
  );
});

test('REG-03: refuses a skill with an unknown permission id (no free text)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'));
  mkdirSync(join(dir, 'bad-perm'));
  writeFileSync(join(dir, 'bad-perm', 'SKILL.md'),
    `---\nname: bad-perm\nversion: 0.1.0\ndepartment: test\nstatus: draft\nallowed_tools: [kb.search]\npermissions: [can publish]\ninputs: i\noutputs: o\nverification: v\nevidence_required: e\n---\n\n${BODY}`);
  assert.throws(
    () => createSkillRegistry({ dir, toolRegistry: mockToolRegistry, grantIds: GRANT_IDS }),
    (err) => err.code === 'skill_permission_unknown' && err.permission === 'can publish'
  );
});

test('REG-04: refuses an invalid contract instead of skipping the skill', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'));
  mkdirSync(join(dir, 'broken'));
  writeFileSync(join(dir, 'broken', 'SKILL.md'), '---\nname: broken\n---\n\nbody');
  assert.throws(
    () => createSkillRegistry({ dir, toolRegistry: mockToolRegistry, grantIds: GRANT_IDS }),
    (err) => err.code === 'skill_contract_invalid'
  );
});

test('REG-05: draft skills are invisible to the planner; registry is frozen', () => {
  const registry = createSkillRegistry({ dir: SKILLS_DIR, toolRegistry: mockToolRegistry, grantIds: GRANT_IDS });
  assert.equal(registry.visibleToPlanner().length, 0);
  assert.throws(() => { registry.list().push({}); }, TypeError);
  assert.throws(() => { registry.count = 99; }, TypeError);
  assert.equal(registry.get('product-strategist').department, 'product');
  assert.equal(registry.get('nope'), null);
});

test('REG-07: refuses a SKILL.md symlink outside the skills directory', (t) => {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    t.skip('O_NOFOLLOW is unavailable on this platform');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'skills-'));
  const outside = mkdtempSync(join(tmpdir(), 'outside-skill-'));
  const outsideFile = join(outside, 'SKILL.md');
  mkdirSync(join(dir, 'linked-skill'));
  writeFileSync(outsideFile,
    `---\nname: outside-skill\nversion: 0.1.0\ndepartment: test\nstatus: draft\nallowed_tools: [kb.search]\npermissions: [security.audit.read]\ninputs: i\noutputs: o\nverification: v\nevidence_required: e\n---\n\n${BODY}`);
  symlinkSync(outsideFile, join(dir, 'linked-skill', 'SKILL.md'));

  assert.throws(
    () => createSkillRegistry({ dir, toolRegistry: mockToolRegistry, grantIds: GRANT_IDS }),
    (err) => err.code === 'skill_file_unreadable'
  );
});

test('REG-06: requires dir, tool registry and grant ids', () => {
  assert.throws(() => createSkillRegistry({}), (err) => err.code === 'skills_dir_required');
  assert.throws(() => createSkillRegistry({ dir: SKILLS_DIR }), (err) => err.code === 'tool_registry_required');
  assert.throws(
    () => createSkillRegistry({ dir: SKILLS_DIR, toolRegistry: mockToolRegistry, grantIds: [] }),
    (err) => err.code === 'grant_ids_required'
  );
});
