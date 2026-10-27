import { createAgentRuntime } from './runtime.js';
import { createAgentStore } from './store.js';
import { createMysqlDriver, createSqliteDriver } from './drivers.js';
import { createToolRegistry, defaultToolDefinitions } from './tools.js';
import { createDemoPlanner } from './planner.js';
import {
  createCalendarConnector,
  createConnectorRegistry,
  createEmptyConnectorRegistry,
  createGoogleCalendarTransport
} from './connectors.js';

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
 * External connectors are opt-in and explicit: `none` (default) keeps every external
 * effect refused with `external_connector_unavailable`, and `calendar` wires the
 * Google Calendar connector to the owner's existing Google grant. A requested
 * connector whose credentials are missing is an error, never a silent downgrade.
 */
export function readAgentConnectors(env = process.env) {
  const raw = String(env.CELIA_AGENT_CONNECTORS || 'none').trim().toLowerCase();
  const names = raw === '' ? [] : raw.split(',').map((name) => name.trim()).filter(Boolean);
  const allowed = new Set(['none', 'calendar']);
  for (const name of names) {
    if (!allowed.has(name)) throw new Error('CELIA_AGENT_CONNECTORS must be one of: none, calendar');
  }
  return names.filter((name) => name !== 'none');
}

function buildConnectors({ env, pool, config, logger }) {
  let requested;
  try {
    requested = readAgentConnectors(env);
  } catch (error) {
    throw Object.assign(new Error(error.message), { code: 'invalid_agent_connectors' });
  }
  if (!requested.length) return createEmptyConnectorRegistry();
  if (!config.google?.clientId || !config.google?.clientSecret) {
    throw Object.assign(new Error('CELIA_AGENT_CONNECTORS=calendar requires Google OAuth configuration'), {
      code: 'agent_connector_unconfigured'
    });
  }
  if (!pool || pool.isMemory) {
    throw Object.assign(new Error('CELIA_AGENT_CONNECTORS=calendar requires a durable pool for stored grants'), {
      code: 'agent_connector_unconfigured'
    });
  }
  const userId = config.userId || env.APP_USER_ID || 'owner';
  const definitions = requested.map((name) => {
    if (name !== 'calendar') throw new Error(`Unknown connector ${name}`);
    const transport = createGoogleCalendarTransport({
      getCalendar: async () => {
        const { createGoogleCalendarClient } = await import('../google.js');
        return createGoogleCalendarClient({ pool, config, userId });
      }
    });
    return createCalendarConnector({
      transport,
      timeZone: env.CELIA_AGENT_CALENDAR_TIMEZONE || null
    });
  });
  logger.info?.(`Agent connectors enabled: ${definitions.map((entry) => entry.name).join(', ')}`);
  return createConnectorRegistry(definitions);
}

/**
 * A host keeps agent initialization out of the request path of unrelated routes.
 * `ready` resolves to the runtime, or to `null` when the mode is `off`.
 */
export function createAgentHost({
  config = {},
  pool = null,
  env = process.env,
  statusProvider,
  kbHost = null,
  logger = console,
  // Explicit injection seam: tests and embedders pass a registry; production builds
  // it from CELIA_AGENT_CONNECTORS. Never a silent fallback — `null` means "build it".
  connectors: injectedConnectors = null
} = {}) {
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
    const kb = kbHost && kbHost.mode === 'sqlite' ? kbHost : null;
    const connectors = injectedConnectors || buildConnectors({ env, pool, config, logger });
    const runtime = createAgentRuntime({
      store,
      tools: createToolRegistry(defaultToolDefinitions({ statusProvider, kb })),
      planner: createDemoPlanner({ knowledge: Boolean(kb) }),
      connectors,
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
