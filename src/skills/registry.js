/**
 * DES-002 / المرحلة 1 — سجل المهارات.
 *
 * يقرأ مجلد مهارات (كل مجلد فرعي فيه `SKILL.md`)، يتحقق من كل عقد، ويرفض
 * أي مهارة تشير إلى أداة غير مسجّلة في سجل الأدوات أو صلاحية غير موجودة
 * في `GRANT_IDS` بالمعرّف — لا أوصاف حرة.
 *
 * ضمانات بنائية:
 * - السجل يعاد تجميده (Object.freeze) ولا يمكن تعديله بعد البناء.
 * - المهارات ذات الحالة غير `active` لا تظهر في `visibleToPlanner()`.
 * - أي عقد غير صالح يرفض السجل كله بكود محدد، لا يتجاهل المهارة.
 */

import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkillMarkdown, PLANNER_VISIBLE_STATUS, SKILL_SCHEMA_VERSION } from './schema.js';

/**
 * يبني سجل مهارات من مسار.
 * options: { dir, toolRegistry: { has(name) }, grantIds: string[] }
 */
export function createSkillRegistry({ dir, toolRegistry, grantIds }) {
  if (!dir) throw Object.assign(new Error('skills_dir_required'), { code: 'skills_dir_required' });
  if (!toolRegistry || typeof toolRegistry.has !== 'function') {
    throw Object.assign(new Error('tool_registry_required'), { code: 'tool_registry_required' });
  }
  if (!Array.isArray(grantIds) || grantIds.length === 0) {
    throw Object.assign(new Error('grant_ids_required'), { code: 'grant_ids_required' });
  }
  const grants = new Set(grantIds);

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    throw Object.assign(new Error('skills_dir_unreadable'), { code: 'skills_dir_unreadable', dir });
  }

  const skills = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, 'SKILL.md');
    let descriptor;
    let source;
    try {
      descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (!fstatSync(descriptor).isFile()) continue;
      source = readFileSync(descriptor, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue; // مجلد بلا SKILL.md ليس مهارة — يُتجاهل
      throw Object.assign(new Error('skill_file_unreadable'), {
        code: 'skill_file_unreadable',
        skill: entry.name
      });
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }

    const parsed = parseSkillMarkdown(source);
    if (!parsed.ok) {
      throw Object.assign(new Error('skill_contract_invalid'), {
        code: 'skill_contract_invalid',
        skill: entry.name,
        reason: parsed.code
      });
    }
    const contract = parsed.contract;

    if (contract.schema !== SKILL_SCHEMA_VERSION) {
      throw Object.assign(new Error('skill_schema_unknown'), { code: 'skill_schema_unknown', skill: entry.name });
    }
    for (const tool of contract.allowedTools) {
      if (!toolRegistry.has(tool)) {
        throw Object.assign(new Error('skill_tool_not_registered'), {
          code: 'skill_tool_not_registered',
          skill: contract.name,
          tool
        });
      }
    }
    for (const permission of contract.permissions) {
      if (!grants.has(permission)) {
        throw Object.assign(new Error('skill_permission_unknown'), {
          code: 'skill_permission_unknown',
          skill: contract.name,
          permission
        });
      }
    }
    if (skills.has(contract.name)) {
      throw Object.assign(new Error('skill_duplicate'), { code: 'skill_duplicate', skill: contract.name });
    }
    skills.set(contract.name, Object.freeze({ ...contract, dir: entry.name }));
  }

  const frozen = Object.freeze([...skills.values()]);
  return Object.freeze({
    schema: SKILL_SCHEMA_VERSION,
    list() {
      return frozen;
    },
    get(name) {
      return skills.get(name) || null;
    },
    has(name) {
      return skills.has(name);
    },
    /** المهارات المرئية للمخطِّط فقط (active). */
    visibleToPlanner() {
      return Object.freeze(frozen.filter((skill) => PLANNER_VISIBLE_STATUS.includes(skill.status)));
    },
    count() {
      return frozen.length;
    }
  });
}
