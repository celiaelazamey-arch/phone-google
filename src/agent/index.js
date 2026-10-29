import { createAgentRuntime, PLAN_LIFECYCLE_STATE } from './runtime.js';
import { createAgentStore } from './store.js';
import { createMysqlDriver, createSqliteDriver } from './drivers.js';
import { createToolRegistry, defaultToolDefinitions } from './tools.js';
import { createDemoPlanner } from './planner.js';
import {
  createProviderPlanner,
  createGeminiPlannerProvider,
  createFallbackPlanner,
  PROVIDER_PLAN_SCHEMA,
  validateProviderPlan
} from './planner-provider.js';
import { RISK } from './tools.js';
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
  COMPREHENSION_GATE_STATUS,
  EXPLANATION_VERIFICATION_STATUS,
  NEXT_PERMITTED_ACTION,
  validateAutomationSchema,
  validateExplanationContract,
  readLocalDocument,
  extractStructuredDocument,
  explainExtractedFields,
  measureExtractionAccuracy,
  validateExtractedData,
  explainValidationOutcome,
  evaluateComprehensionGate,
  buildComprehensionExplanation,
  buildAutomationReport,
  createPurchaseLedgerStore,
  createPurchaseLedgerConnector,
  documentAutomationToolDefinitions
} from './automation/index.js';
import {
  CONNECTOR,
  ALLOWED_DRIVE_MIME_TYPES,
  createCalendarConnector,
  createConnectorRegistry,
  createEmptyConnectorRegistry,
  createGoogleCalendarTransport,
  createWhatsAppConnector,
  createWhatsAppCloudTransport,
  createDriveExportConnector,
  createGoogleDriveTransport
} from './connectors.js';
import { createGmailReadConnector, GMAIL_CONNECTOR, GMAIL_TOOL, GMAIL_MAX_RESULTS } from './gmail.js';
import {
  createDriveReadConnector,
  createCalendarReadConnector,
  createContactsReadConnector,
  DRIVE_READ_TOOL,
  CALENDAR_READ_TOOL,
  CONTACTS_READ_TOOL,
  DRIVE_READ_CONNECTOR,
  CALENDAR_READ_CONNECTOR,
  CONTACTS_READ_CONNECTOR
} from './google-read.js';
import {
  CELIA_SEVEN_STAGE_LOOP,
  TASK_CATEGORIES,
  recommendTaskStrategy,
  estimateTokenCost,
  evaluateProviderSafety,
  auditProductCatalog,
  buildCreativeWorkflowPlan,
  buildTruthPartition,
  computeAgentMetrics
} from './evaluation.js';

export {
  PLAN_LIFECYCLE_STATE,
  createProviderPlanner,
  PROVIDER_PLAN_SCHEMA,
  validateProviderPlan,
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
  COMPREHENSION_GATE_STATUS,
  EXPLANATION_VERIFICATION_STATUS,
  NEXT_PERMITTED_ACTION,
  validateAutomationSchema,
  validateExplanationContract,
  readLocalDocument,
  extractStructuredDocument,
  explainExtractedFields,
  measureExtractionAccuracy,
  validateExtractedData,
  explainValidationOutcome,
  evaluateComprehensionGate,
  buildComprehensionExplanation,
  buildAutomationReport,
  createPurchaseLedgerStore,
  createPurchaseLedgerConnector,
  documentAutomationToolDefinitions,
  CONNECTOR,
  ALLOWED_DRIVE_MIME_TYPES,
  createCalendarConnector,
  createConnectorRegistry,
  createEmptyConnectorRegistry,
  createGoogleCalendarTransport,
  createWhatsAppConnector,
  createWhatsAppCloudTransport,
  createDriveExportConnector,
  createGoogleDriveTransport,
  createGmailReadConnector,
  GMAIL_CONNECTOR,
  GMAIL_TOOL,
  GMAIL_MAX_RESULTS,
  createDriveReadConnector,
  createCalendarReadConnector,
  createContactsReadConnector,
  DRIVE_READ_TOOL,
  CALENDAR_READ_TOOL,
  CONTACTS_READ_TOOL,
  DRIVE_READ_CONNECTOR,
  CALENDAR_READ_CONNECTOR,
  CONTACTS_READ_CONNECTOR,
  CELIA_SEVEN_STAGE_LOOP,
  TASK_CATEGORIES,
  recommendTaskStrategy,
  estimateTokenCost,
  evaluateProviderSafety,
  auditProductCatalog,
  buildCreativeWorkflowPlan,
  buildTruthPartition,
  computeAgentMetrics
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
 * External-effect connectors and read-only Google readers are opt-in and explicit:
 * `none` (default) keeps every external effect refused with
 * `external_connector_unavailable` and does not register Google readers. `calendar`
 * and `drive` retain their approval-gated write/export meaning; `gmail` enables only
 * Gmail reads, while `google_read` enables Gmail, Drive, Calendar, and Contacts reads
 * without registering an outbox connector. Missing configuration is an error, never
 * a silent downgrade.
 */
export function readAgentConnectors(env = process.env) {
  const raw = String(env.CELIA_AGENT_CONNECTORS || 'none').trim().toLowerCase();
  const names = raw === '' ? [] : raw.split(',').map((name) => name.trim()).filter(Boolean);
  const allowed = new Set(['none', 'calendar', 'whatsapp', 'drive', 'gmail', 'google_read']);
  for (const name of names) {
    if (!allowed.has(name)) {
      throw new Error('CELIA_AGENT_CONNECTORS must be one of: none, calendar, whatsapp, drive, gmail, google_read');
    }
  }
  return [...new Set(names.filter((name) => name !== 'none'))];
}

function buildConnectors({ env, pool, config, logger }) {
  let requested;
  try {
    requested = readAgentConnectors(env);
  } catch (error) {
    throw Object.assign(new Error(error.message), { code: 'invalid_agent_connectors' });
  }
  if (!requested.length) return createEmptyConnectorRegistry();

  const needsGoogle = requested.some((name) => ['calendar', 'drive', 'gmail', 'google_read'].includes(name));
  if (needsGoogle) {
    if (!config.google?.clientId || !config.google?.clientSecret) {
      throw Object.assign(new Error('CELIA_AGENT_CONNECTORS=calendar|drive|gmail|google_read requires Google OAuth configuration'), {
        code: 'agent_connector_unconfigured'
      });
    }
    if (!pool || pool.isMemory) {
      throw Object.assign(new Error('CELIA_AGENT_CONNECTORS=calendar|drive|gmail|google_read requires a durable pool for stored grants'), {
        code: 'agent_connector_unconfigured'
      });
    }
  }

  if (requested.includes('whatsapp')) {
    const wa = config.whatsapp || {};
    if (!wa.accessToken || !wa.phoneNumberId || !wa.apiVersion) {
      throw Object.assign(new Error('CELIA_AGENT_CONNECTORS=whatsapp requires WhatsApp Cloud API configuration'), {
        code: 'agent_connector_unconfigured'
      });
    }
    if (!pool || pool.isMemory) {
      throw Object.assign(new Error('CELIA_AGENT_CONNECTORS=whatsapp requires a durable pool for contact window and message idempotency'), {
        code: 'agent_connector_unconfigured'
      });
    }
  }

  const userId = config.userId || env.APP_USER_ID || 'owner';
  // Read tools are wired separately below; only effect connectors enter the outbox registry.
  const definitions = requested.filter((name) => !['gmail', 'google_read'].includes(name)).map((name) => {
    if (name === 'calendar') {
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
    }
    if (name === 'drive') {
      const transport = createGoogleDriveTransport({
        getDrive: async () => {
          const { createGoogleDriveClient } = await import('../google.js');
          return createGoogleDriveClient({ pool, config, userId });
        }
      });
      return createDriveExportConnector({
        transport,
        folderId: env.CELIA_AGENT_DRIVE_FOLDER_ID || null
      });
    }
    if (name === 'whatsapp') {
      const transport = createWhatsAppCloudTransport({
        pool,
        sendText: async ({ phone, text, signal }) => {
          const { sendWhatsAppText } = await import('../whatsapp.js');
          return sendWhatsAppText({ config, phone, text, signal });
        }
      });
      return createWhatsAppConnector({
        transport,
        ownerPhone: config.ownerPhone || env.APP_OWNER_PHONE_E164 || null,
        checkContactWindow: async ({ phone }) => {
          const { isWithinCustomerWindow } = await import('../security.js');
          const [rows] = await pool.execute(
            'SELECT opted_in, last_inbound_at FROM whatsapp_contacts WHERE phone_e164 = ? LIMIT 1',
            [phone]
          );
          const contact = rows?.[0];
          return {
            optedIn: Boolean(contact?.opted_in),
            withinWindow: Boolean(contact?.last_inbound_at && isWithinCustomerWindow(contact.last_inbound_at))
          };
        }
      });
    }
    throw new Error(`Unknown connector ${name}`);
  });
  logger.info?.(`Agent connectors enabled: ${definitions.map((entry) => entry.name).join(', ')}`);
  return createConnectorRegistry(definitions);
}

function buildGmailReader({ pool, config, env }) {
  const userId = config.userId || env.APP_USER_ID || 'owner';
  return createGmailReadConnector({
    transport: {
      async listMessages({ maxResults, unreadOnly, signal }) {
        // Reuse the existing encrypted OAuth grant and Gmail fetcher. No token,
        // credentials file, or additional scope is introduced by this connector.
        const { fetchInboxMessages } = await import('../google.js');
        return fetchInboxMessages({ pool, config, userId, maxResults, unreadOnly, signal });
      }
    }
  });
}

function buildGoogleReaders({ pool, config, env }) {
  const userId = config.userId || env.APP_USER_ID || 'owner';
  return {
    gmail: buildGmailReader({ pool, config, env }),
    drive: createDriveReadConnector({
      transport: {
        async listFiles({ maxResults, signal }) {
          const { fetchDriveFiles } = await import('../google.js');
          return fetchDriveFiles({ pool, config, userId, maxResults, signal });
        }
      }
    }),
    calendar: createCalendarReadConnector({
      transport: {
        async listEvents({ timeMin, timeMax, maxResults, signal }) {
          const { listAgendaEvents } = await import('../google.js');
          return listAgendaEvents({ pool, config, userId, timeMin, timeMax, maxResults, signal });
        }
      }
    }),
    contacts: createContactsReadConnector({
      transport: {
        async listContacts({ query, maxResults, signal }) {
          const { fetchGoogleContacts } = await import('../google.js');
          return fetchGoogleContacts({ pool, config, userId, query, maxResults, signal });
        }
      }
    })
  };
}

/**
 * A host keeps agent initialization out of the request path of unrelated routes.
 * `ready` resolves to the runtime, or to `null` when the mode is `off`.
 */
/** Planner modes the host accepts. Anything else fails closed instead of guessing (DEC-059). */
export const AGENT_PLANNER_MODES = Object.freeze(['demo', 'provider']);

/**
 * `CELIA_AGENT_PLANNER`: `demo` (default, deterministic) or `provider` (a model plans, the deterministic planner
 * absorbs a provider failure with a visible marker). `gemini` is accepted as an explicit alias of the provider
 * because a provider still has to be named before anything else can be one.
 */
export function readAgentPlanner(env = process.env) {
  const raw = String(env?.CELIA_AGENT_PLANNER || 'demo').trim().toLowerCase();
  if (!raw) return 'demo';
  if (raw === 'demo') return 'demo';
  if (raw === 'provider' || raw === 'gemini') return 'provider';
  throw Object.assign(new Error('CELIA_AGENT_PLANNER must be demo or provider'), { code: 'invalid_agent_planner' });
}

/** Default closed read set for a provider planner: at most four executable reads, `kb.search` only when KB is on. */
export const PROVIDER_PLANNER_TOOLS = Object.freeze(['celia.thread_context', 'product.catalog_audit', 'creative.workflow_plan']);

export function selectProviderTools({ tools, kb = false, requested = null } = {}) {
  const preferred = Array.isArray(requested) && requested.length ? requested : [...PROVIDER_PLANNER_TOOLS, ...(kb ? ['kb.search'] : [])];
  const selected = [];
  for (const name of preferred) {
    if (selected.includes(name)) continue;
    const definition = tools?.get?.(name);
    if (!definition) continue;
    if (definition.risk !== RISK.read || !tools.executable(name)) continue;
    if (name === 'kb.search' && definition.plannerSafe !== true) continue;
    selected.push(name);
    if (selected.length === 4) break;
  }
  return selected;
}

export function createAgentHost({
  config = {},
  pool = null,
  env = process.env,
  statusProvider,
  kbHost = null,
  logger = console,
  // Explicit injection seam: tests and embedders pass a registry; production builds
  // it from CELIA_AGENT_CONNECTORS. Never a silent fallback — `null` means "build it".
  connectors: injectedConnectors = null,
  // Read-only Google readers have their own injection seam; they are never outbox connectors.
  gmail: injectedGmail = null,
  googleReaders: injectedGoogleReaders = null
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
  // WP-3.1 (DEC-059): the planner is chosen explicitly and fails closed. `demo` stays the default and the only
  // mode that may run external effects through the deterministic planner.
  let plannerMode = 'demo';
  try {
    plannerMode = readAgentPlanner(env);
  } catch (error) {
    failure = failure || { code: error.code || 'invalid_agent_planner', message: error.message };
  }
  const providerApiKey = String(env.GEMINI_API_KEY || config.gemini?.apiKey || '').trim();
  const providerModel = String(env.GEMINI_MODEL || config.gemini?.model || 'gemini-2.5-flash').trim() || 'gemini-2.5-flash';
  const providerTools = String(env.CELIA_AGENT_PLANNER_TOOLS || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  const ready = (async () => {
    if (failure) throw Object.assign(new Error(failure.message), { code: failure.code });
    if (mode === 'off') return null;
    if (plannerMode === 'provider') {
      if (!providerApiKey) {
        throw Object.assign(new Error('Provider planner mode needs GEMINI_API_KEY'), {
          code: 'planner_provider_not_configured'
        });
      }
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
    const requestedConnectors = readAgentConnectors(env);
    const googleReaders = injectedGoogleReaders || (!injectedConnectors && requestedConnectors.includes('google_read')
      ? buildGoogleReaders({ pool, config, env })
      : {});
    const gmail = injectedGmail || googleReaders.gmail || (!injectedConnectors && requestedConnectors.includes('gmail')
      ? buildGmailReader({ pool, config, env })
      : null);
    const toolRegistry = createToolRegistry(defaultToolDefinitions({ statusProvider, kb, gmail, googleReaders }));
    const demoPlanner = createDemoPlanner({
      knowledge: Boolean(kb),
      gmail: Boolean(gmail),
      googleReaders: {
        drive: Boolean(googleReaders.drive),
        calendar: Boolean(googleReaders.calendar),
        contacts: Boolean(googleReaders.contacts)
      }
    });
    // WP-3.1 (DEC-059). Default stays the deterministic planner. In provider mode the model plans inside the same
    // closed read set, and any provider failure becomes a visible deterministic fallback instead of a silent retry.
    let planner = demoPlanner;
    if (plannerMode === 'provider') {
      const allowedTools = selectProviderTools({ tools: toolRegistry, kb: Boolean(kb), requested: providerTools });
      if (allowedTools.length < 2) {
        throw Object.assign(new Error('Provider planner needs between two and four executable read tools'), {
          code: 'planner_tools_unavailable'
        });
      }
      planner = createFallbackPlanner({
        primary: createProviderPlanner({
          provider: createGeminiPlannerProvider({
            apiKey: providerApiKey,
            model: providerModel,
            ...(env.CELIA_AGENT_PLANNER_TIMEOUT_MS ? { timeoutMs: Number(env.CELIA_AGENT_PLANNER_TIMEOUT_MS) } : {})
          }),
          tools: toolRegistry,
          allowedTools,
          name: 'gemini',
          ...(env.CELIA_AGENT_PLANNER_TIMEOUT_MS ? { timeoutMs: Number(env.CELIA_AGENT_PLANNER_TIMEOUT_MS) } : {})
        }),
        fallback: demoPlanner
      });
    }
    const runtime = createAgentRuntime({
      store,
      tools: toolRegistry,
      planner,
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
