#!/usr/bin/env node
/**
 * ASSUR-003 — اشتقاق مسوّدة مهارة من سجل تشغيل دائم.
 *
 *   node scripts/derive-skill-draft.mjs <run-id> --sqlite <path>          # يكتب المسوّدة
 *   node scripts/derive-skill-draft.mjs <run-id> --sqlite <path> --check # يتحقق فقط (خروج 1 عند انحراف)
 *   node scripts/derive-skill-draft.mjs <run-id> --mysql                 # من MySQL عبر تهيئة البيئة
 *
 * **لا شبكة ولا تصوير شاشة ولا حافظة.** المصدر هو `agent_steps` و
 * `agent_tool_runs` و`goal_contract` في مخزننا. الكتابة تحدث فقط بعد بوابة
 * الأسرار في `buildSkillDraft`، والمسار محروس ضد `.agents/skills/`.
 *
 * المسوّدات تبقى خارج Git (انظر .gitignore): قد تحمل نص هدف المالك.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createAgentStore } from '../src/agent/store.js';
import { createMysqlDriver, createSqliteDriver } from '../src/agent/drivers.js';
import { buildSkillDraft, assertSafeDraftPath } from '../src/agent/skill-draft.js';

function fail(code, message) {
  process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = 1;
}

export function parseArgs(argv) {
  const args = { runId: null, sqlite: null, mysql: false, check: false, outDir: null };
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--check') args.check = true;
    else if (token === '--mysql') args.mysql = true;
    else if (token === '--sqlite') args.sqlite = argv[++index] ?? null;
    else if (token === '--out-dir') args.outDir = argv[++index] ?? null;
    else rest.push(token);
  }
  args.runId = rest[0] ?? null;
  return args;
}

async function openStore(args, env) {
  if (args.mysql) {
    const { createPool } = await import('../src/db.js');
    const { loadMysqlConfig } = await import('../src/mysql-config.js');
    const pool = createPool(
      { mysql: loadMysqlConfig(env), nodeEnv: env.NODE_ENV || 'development', userId: env.CELIA_USER_ID || 'owner' },
      { prepareOwner: false }
    );
    const driver = createMysqlDriver(pool);
    const schema = await driver.verifySchema();
    if (!schema.ok) {
      await pool.end?.();
      throw Object.assign(new Error(`agent tables missing: ${schema.missing.join(', ')}`), { code: 'agent_schema_missing' });
    }
    return { store: createAgentStore({ driver }), close: () => pool.end?.() };
  }
  if (!args.sqlite) {
    throw Object.assign(new Error('pass --sqlite <path> or --mysql'), { code: 'store_required' });
  }
  const driver = await createSqliteDriver({ path: args.sqlite, nodeEnv: env.NODE_ENV || 'development' });
  return { store: createAgentStore({ driver }), close: () => driver.close() };
}

/** يكتب المسوّدة بعد الحراسة، أو يتحقق من بصمتها في وضع --check. */
export async function writeDraft(draft, { check = false, outDir = null } = {}) {
  const target = assertSafeDraftPath(outDir ? path.posix.join(outDir.replace(/\\/g, '/'), path.basename(draft.path)) : draft.path);
  if (check) {
    const existing = await readFile(target, 'utf8').catch(() => null);
    if (existing === null) return { wrote: false, code: 'draft_missing', target };
    const { hashOf } = await import('../src/agent/evidence.js');
    if (hashOf(existing) !== draft.digest) return { wrote: false, code: 'draft_drift', target };
    return { wrote: false, code: null, target, digest: draft.digest };
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, draft.markdown, 'utf8');
  return { wrote: true, code: null, target, digest: draft.digest };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.runId) {
    fail('usage', 'node scripts/derive-skill-draft.mjs <run-id> --sqlite <path> [--check]');
    return;
  }
  let handle;
  try {
    handle = await openStore(args, process.env);
    const run = await handle.store.getRun(args.runId);
    if (!run) {
      fail('run_not_found', args.runId);
      return;
    }
    const [steps, toolRuns, contract] = await Promise.all([
      handle.store.listSteps(run.id),
      handle.store.listToolRuns(run.id),
      handle.store.getGoalContract(run.id)
    ]);
    const draft = buildSkillDraft({ run, steps, toolRuns, objective: contract?.objective ?? null });
    if (!draft.ok) {
      fail(draft.code, (draft.details || []).join(' ') || 'لم تُكتب أي مسوّدة');
      return;
    }
    const result = await writeDraft(draft, { check: args.check, outDir: args.outDir });
    if (result.code) {
      fail(result.code, result.target);
      return;
    }
    process.stdout.write(`${result.wrote ? 'written' : 'verified'} ${result.target}\nsha256:${result.digest}\n`);
    process.stdout.write('مسوّدة للمراجعة البشرية فقط: لم تُثبَّت ولم تُفعَّل.\n');
  } catch (error) {
    fail(error?.code || 'derive_failed', error?.message || String(error));
  } finally {
    await handle?.close?.();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
