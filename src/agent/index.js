import { createAgentRuntime, PLAN_LIFECYCLE_STATE } from './runtime.js';
import { createAgentStore } from './store.js';
import { createMysqlDriver, createSqliteDriver } from './drivers.js';
import { createToolRegistry, defaultToolDefinitions } from './tools.js';
import { createDemoPlanner } from './planner.js';
import {
  HARNESS_LIFECYCLE_STAGES,
  HARNESS_COMPONENT_IDS,
  inspectAgentHarness,
  derivePlanView,
  validatePlanEditPolicy,
  verifyApprovedEffectIntegrity
} from './harness.js';
import {
  CAPABILITY_NAME,
  AUTOMATION_SCHEMA_VERSION,
  DOCUMENT_TYPES,
  VALIDATION_STATUS,
  ACTION_STATUS,
  readLocalDocument,
  extractStructuredDocument,
  measureExtractionAccuracy,
  validateExtractedData,
  buildAutomationReport,
  createPurchaseLedgerStore,
  createPurchaseLedgerConnector,
  documentAutomationToolDefinitions
} from './automation/index.js';
import {
  createCalendarConnector,
  createConnectorRegistry,
  createEmptyConnectorRegistry,
  createGoogleCalendarTransport
} from './connectors.js';

export {
  PLAN_LIFECYCLE_STATE,
  HARNESS_LIFECYCLE_STAGES,
  HARNESS_COMPONENT_IDS,
  inspectAgentHarness,
  derivePlanView,
  validatePlanEditPolicy,
  verifyApprovedEffectIntegrity,
  CAPABILITY_NAME,
  AUTOMATION_SCHEMA_VERSION,
  DOCUMENT_TYPES,
  VALIDATION_STATUS,
  ACTION_STATUS,
  readLocalDocument,
  extractStructuredDocument,
  measureExtractionAccuracy,
  validateExtractedData,
  buildAutomationReport,
  createPurchaseLedgerStore,
  createPurchaseLedgerConnector,
  documentAutomationToolDefinitions
};

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

/**
 * Boot recovery is an explicit policy, not a default. On a free tier the process is
 * killed on every idle sleep, so the owner decides whether a waking process settles
 * abandoned outbox rows as `unknown` and resumes parked runs — or leaves that to a
 * human (the pre-existing behaviour). Nothing in either policy re-sends an effect.
 */
export function readAgentBootRecovery(env = process.env) {
  const raw = String(env.CELIA_AGENT_RESUME_ON_BOOT ?? 'false').trim().toLowerCase();
  if (!['true', 'false'].includes(raw)) throw new Error('CELIA_AGENT_RESUME_ON_BOOT must be true or false');
  return raw === 'true';
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
  let resumeOnBoot = false;
  try {
    resumeOnBoot = readAgentBootRecovery(env);
  } catch (error) {
    failure = failure || { code: 'invalid_agent_boot_recovery', message: error.message };
  }
  let lastBootRecovery = null;
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

  const bootRecoveryPolicy = () => ({
    policy: resumeOnBoot ? 'resume' : 'manual',
    env: 'CELIA_AGENT_RESUME_ON_BOOT',
    last: lastBootRecovery
  });

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
        return { ...runtime.status(), bootRecovery: bootRecoveryPolicy() };
      } catch (error) {
        return { enabled: false, mode, reason: error.code || 'agent_unavailable', message: error.message };
      }
    },
    async get() {
      return ready;
    },
    /**
     * Runs the boot recovery once, if the policy allows it. Never throws: a failed
     * recovery is recorded in `status().bootRecovery.last` and the server stays up.
     */
    async recoverOnBoot() {
      const record = (report) => {
        lastBootRecovery = { ...report, at: report.at || new Date().toISOString() };
        return lastBootRecovery;
      };
      if (mode === 'off') return record({ performed: false, reason: 'agent_runtime_disabled' });
      if (!resumeOnBoot) {
        return record({ performed: false, reason: 'boot_recovery_disabled', requiredEnv: 'CELIA_AGENT_RESUME_ON_BOOT=true' });
      }
      try {
        const runtime = await ready;
        return record({ performed: true, ...(await runtime.recoverOnBoot()) });
      } catch (error) {
        return record({ performed: false, reason: error.code || 'boot_recovery_failed' });
      }
    }
  };
}

/**
 * Entry points call this right after `listen`: recovery runs in the background so
 * readiness is never delayed, and a failure is logged by code only.
 */
export function scheduleBootRecovery({ agentHost, logger = console, delayMs = 0 } = {}) {
  if (!agentHost?.recoverOnBoot) return null;
  const timer = setTimeout(() => {
    agentHost
      .recoverOnBoot()
      .then((report) => {
        if (!report.performed) {
          logger.info?.(`Agent boot recovery not performed: ${report.reason}`);
          return;
        }
        logger.info?.(
          `Agent boot recovery: ${report.staleOutbox.length} abandoned outbox row(s) settled as unknown, ` +
            `${report.runs.attempted} parked run(s) resumed in ${report.durationMs}ms.`
        );
      })
      .catch((error) => logger.error?.('Agent boot recovery failed:', error?.code || 'boot_recovery_failed'));
  }, Math.max(0, Number(delayMs) || 0));
  timer.unref?.();
  return timer;
}
