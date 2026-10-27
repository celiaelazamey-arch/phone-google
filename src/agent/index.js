import { createAgentRuntime } from './runtime.js';
import { createAgentStore } from './store.js';
import { createMysqlDriver, createSqliteDriver } from './drivers.js';
import { createDefaultTools } from './tools.js';
import { createDemoPlanner } from './planner.js';

/**
 * Explicit agent wiring. Three states only: `off` (default), `mysql` (production
 * durable store, schema applied by `npm run migrate -- --apply`) and `sqlite`
 * (durable local/demo file store, refused in production).
 *
 * There is no `memory` mode and no silent downgrade: if the configured store is
 * unavailable, agent routes report `agent_unavailable` and the rest of the system
 * keeps working.
 */

export const AGENT_MODES = Object.freeze(['off', 'mysql', 'sqlite']);

export function readAgentMode(env = process.env) {
  const raw = String(env.CELIA_AGENT_RUNTIME || 'off').trim().toLowerCase();
  if (!AGENT_MODES.includes(raw)) {
    throw new Error('CELIA_AGENT_RUNTIME must be one of: off, mysql, sqlite');
  }
  return raw;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readAgentLimits(env = process.env) {
  return {
    maxSteps: positiveInt(env.CELIA_AGENT_MAX_STEPS, 12),
    maxCostMicros: positiveInt(env.CELIA_AGENT_MAX_COST_MICROS, 100_000),
    maxDurationMs: positiveInt(env.CELIA_AGENT_MAX_DURATION_MS, 120_000)
  };
}

/**
 * A host keeps agent initialization out of the request path of unrelated routes.
 * `ready` resolves to the runtime, or to `null` when the mode is `off`.
 */
export function createAgentHost({ config = {}, pool = null, env = process.env, statusProvider, logger = console } = {}) {
  let mode = 'off';
  let failure = null;
  try {
    mode = readAgentMode(env);
  } catch (error) {
    failure = { code: 'invalid_agent_mode', message: error.message };
  }
  const nodeEnv = config.nodeEnv || env.NODE_ENV || 'development';

  const ready = (async () => {
    if (failure) throw Object.assign(new Error(failure.message), { code: failure.code });
    if (mode === 'off') return null;
    if (String(env.CELIA_AGENT_PLANNER || 'demo').trim().toLowerCase() !== 'demo') {
      throw Object.assign(new Error('Only the deterministic demo planner is implemented (AGENT-001)'), {
        code: 'agent_planner_unavailable'
      });
    }
    let driver;
    if (mode === 'mysql') {
      if (!pool || pool.isMemory) {
        throw Object.assign(new Error('Agent MySQL mode requires a durable MySQL pool'), { code: 'agent_storage_required' });
      }
      driver = createMysqlDriver(pool);
      const schema = await driver.verifySchema();
      if (!schema.ok) {
        throw Object.assign(
          new Error(`Agent tables are missing (${schema.missing.join(', ')}); run: npm run migrate -- --apply`),
          { code: 'agent_schema_missing' }
        );
      }
    } else {
      driver = await createSqliteDriver({
        path: env.CELIA_AGENT_SQLITE_PATH,
        nodeEnv
      });
    }
    const store = createAgentStore({ driver });
    const runtime = createAgentRuntime({
      store,
      tools: createDefaultTools({ statusProvider }),
      planner: createDemoPlanner(),
      ownerId: config.userId || env.APP_USER_ID || 'owner',
      limits: readAgentLimits(env),
      logger
    });
    return runtime;
  })();

  return {
    get mode() {
      return mode;
    },
    ready,
    async status() {
      if (mode === 'off') {
        return { enabled: false, mode, reason: 'agent_runtime_disabled', requiredEnv: 'CELIA_AGENT_RUNTIME=mysql|sqlite' };
      }
      try {
        const runtime = await ready;
        return runtime.status();
      } catch (error) {
        return { enabled: false, mode, reason: error.code || 'agent_unavailable', message: error.message };
      }
    },
    async get() {
      return ready;
    }
  };
}
