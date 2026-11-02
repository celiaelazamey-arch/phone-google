/**
 * DES-002 / المرحلة 1 — مخطط عقد المهارة (SKILL.md).
 *
 * العقد = ترويسة YAML في `SKILL.md`، لا «شخصية» ولا سيرة. الحقول:
 * name · version · department · status · allowed_tools · permissions ·
 * inputs · outputs · verification · evidence_required
 *
 * ضمان بنائي: هذه الوحدة **خالصة** — لا نظام ملفات ولا شبكة ولا ساعة.
 * كل فحص يرجع { ok, code } ولا يرمي استثناءات.
 */

export const SKILL_SCHEMA_VERSION = 'celia-skill-contract-v1';

export const SKILL_STATUSES = Object.freeze([
  'draft',
  'reviewed',
  'active',
  'deprecated',
  'retired'
]);

/** الحالات التي يقرأها المخطِّط فقط. draft وreviewed غير مرئيين له. */
export const PLANNER_VISIBLE_STATUS = Object.freeze(['active']);

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const NON_EMPTY = (value) => typeof value === 'string' && value.trim().length > 0;
const STRING_LIST = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim().length > 0);

/**
 * محلل YAML Fraser: كتلة `---` ترويسة `---` ثم جسم Markdown.
 * يدعم: `key: value`، و`key: [a, b]`، و`key:` تليها بنود `- item`.
 */
export function parseFrontmatter(text) {
  const raw = String(text ?? '');
  if (!raw.startsWith('---\n')) return { ok: false, code: 'frontmatter_missing' };
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return { ok: false, code: 'frontmatter_unclosed' };
  const head = raw.slice(4, end);
  const body = raw.slice(end + 4).replace(/^\n+/, '');
  const data = {};
  let currentKey = null;
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s+(.+)$/);
    if (item && currentKey) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      data[currentKey].push(item[1].trim());
      continue;
    }
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) return { ok: false, code: 'frontmatter_syntax', line };
    currentKey = kv[1];
    const value = kv[2].trim();
    if (!value) {
      data[currentKey] = [];
      continue;
    }
    const list = value.match(/^\[(.*)\]$/);
    if (list) {
      data[currentKey] = list[1].split(',').map((part) => part.trim()).filter(Boolean);
      continue;
    }
    data[currentKey] = value.replace(/^["']|["']$/g, '');
  }
  return { ok: true, data, body };
}

/** يتحقق من شكل العقد كاملًا. لا يفرض وجود الأدوات أو الصلاحيات — هذا عمل السجل. */
export function validateSkillContract(data, { body = '' } = {}) {
  if (!data || typeof data !== 'object') return { ok: false, code: 'contract_not_object' };

  if (!NON_EMPTY(data.name) || !SLUG.test(data.name)) return { ok: false, code: 'skill_name_invalid', value: data.name };
  if (!NON_EMPTY(data.version) || !VERSION.test(data.version)) return { ok: false, code: 'skill_version_invalid', value: data.version };
  if (!NON_EMPTY(data.department)) return { ok: false, code: 'skill_department_missing' };
  if (!SKILL_STATUSES.includes(data.status)) return { ok: false, code: 'skill_status_invalid', value: data.status };
  if (!STRING_LIST(data.allowed_tools)) return { ok: false, code: 'skill_allowed_tools_invalid' };
  if (new Set(data.allowed_tools).size !== data.allowed_tools.length) return { ok: false, code: 'skill_allowed_tools_duplicate' };
  if (!STRING_LIST(data.permissions)) return { ok: false, code: 'skill_permissions_invalid' };
  if (new Set(data.permissions).size !== data.permissions.length) return { ok: false, code: 'skill_permissions_duplicate' };
  if (!NON_EMPTY(data.inputs)) return { ok: false, code: 'skill_inputs_missing' };
  if (!NON_EMPTY(data.outputs)) return { ok: false, code: 'skill_outputs_missing' };
  if (!NON_EMPTY(data.verification)) return { ok: false, code: 'skill_verification_missing' };
  if (!NON_EMPTY(data.evidence_required)) return { ok: false, code: 'skill_evidence_missing_field' };
  if (!NON_EMPTY(body)) return { ok: false, code: 'skill_body_empty' };

  return {
    ok: true,
    contract: Object.freeze({
      schema: SKILL_SCHEMA_VERSION,
      name: data.name,
      version: data.version,
      department: data.department,
      status: data.status,
      allowedTools: Object.freeze([...data.allowed_tools]),
      permissions: Object.freeze([...data.permissions]),
      inputs: data.inputs,
      outputs: data.outputs,
      verification: data.verification,
      evidenceRequired: data.evidence_required
    })
  };
}

/** تجميع كامل: نص الملف → عقد متحقق منه. */
export function parseSkillMarkdown(text) {
  const parsed = parseFrontmatter(text);
  if (!parsed.ok) return parsed;
  const validated = validateSkillContract(parsed.data, { body: parsed.body });
  if (!validated.ok) return validated;
  return { ok: true, contract: validated.contract, body: parsed.body };
}
