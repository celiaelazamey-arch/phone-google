import crypto from 'node:crypto';
import { createAgentRuntime, PLAN_LIFECYCLE_STATE } from './runtime.js';
import { createAgentStore } from './store.js';
import { createMysqlDriver, createSqliteDriver } from './drivers.js';
import { createToolRegistry, defaultToolDefinitions } from './tools.js';
import { createSandboxExecutor } from './sandbox.js';
import { createArtifactStore } from './artifact-store.js';
import { createEgressAllowlist, createEgressProxy, createEvidenceEgressSink } from './egress-proxy.js';
import { createWebAccess } from './web-tools.js';
import { createSpiderReader, defaultSpiderDbPath } from './spider-reader.js';
import { createDemoPlanner, DEMO_PLANNER_TOOL_SURFACE } from './planner.js';
import { createProviderPlanner, PROVIDER_PLAN_SCHEMA, validateProviderPlan, CALL_MANY_LIMITS } from './planner-provider.js';
import { createGeminiPlannerProvider } from './gemini-planner-provider.js';
import { createGovernedFallbackPlanner, PLANNER_FALLBACK_CODES } from './planner-fallback.js';
import { createReplanPolicy, REPLAN_LIMITS, REVISION_STEP_TITLE } from './replanner.js';
import { createModelRouter, defaultRoute, MODEL_TIERS, ROUTE_REASONS, DECLARED_GEMINI_PRICING, DEFAULT_PER_CALL_CAPS, computeCostMicros } from './model-router.js';
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
  CALL_MANY_LIMITS,
  createGeminiPlannerProvider,
  createGovernedFallbackPlanner,
  PLANNER_FALLBACK_CODES,
  DEMO_PLANNER_TOOL_SURFACE,
  createReplanPolicy,
  REPLAN_LIMITS,
  REVISION_STEP_TITLE,
  createModelRouter,
  defaultRoute,
  MODEL_TIERS,
  ROUTE_REASONS,
  DECLARED_GEMINI_PRICING,
  DEFAULT_PER_CALL_CAPS,
  computeCostMicros,
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

/**
 * M-C/C1-b — بوابة الوصول إلى الويب.
 *
 * `off` (الافتراضي) لا يضيف أي أداة ويب ولا يفتح أي مقبس. `proxy` يبني وسيط الخروج
 * بقائمة مسموحة صريحة؛ وقائمة فارغة أو `*` تُفشل الإقلاع بدل أن تُقرأ كـ«كل شيء
 * مسموح». لا يُفتح `network.allowlist` في العزل في أي وضع — الشبكة تبقى هناك `deny`.
 */
const DEFAULT_EGRESS_PORT = Object.freeze({ http: '80', https: '443' });

/**
 * يقبل صيغتين لعنصر واحد: `host[:port]` (صيغة الوسيط الصارمة) أو
 * `scheme://host[:port]` (صيغة الإعداد في المخطط). الثانية تُترجم إلى الأولى بمنفذ
 * صريح — فتكون **أضيق** لا أوسع: `https://api.example.com` تعني 443 فقط.
 * المسارات وquery والأسرار مرفوضة في العنصر نفسه.
 */
export function normalizeEgressEntry(raw) {
  const text = String(raw ?? '').trim();
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(text);
  if (!match) return text;
  const scheme = match[1].toLowerCase();
  const rest = match[2];
  const port = DEFAULT_EGRESS_PORT[scheme];
  if (!port) {
    throw Object.assign(new Error(`allowlist entry scheme "${scheme}" is unsupported`), {
      code: 'agent_egress_allowlist_invalid'
    });
  }
  if (!rest || rest.includes('/') || rest.includes('?') || rest.includes('#')) {
    throw Object.assign(new Error('an allowlist entry must be a host, not a URL with a path'), {
      code: 'agent_egress_allowlist_invalid'
    });
  }
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close === -1) throw Object.assign(new Error('bracketed IPv6 entry is unterminated'), { code: 'agent_egress_allowlist_invalid' });
    return rest.slice(close + 1).startsWith(':') ? rest : `${rest}:${port}`;
  }
  const parts = rest.split(':');
  if (parts.length === 1) return `${rest}:${port}`;
  if (parts.length === 2 && /^\d+$/.test(parts[1])) return rest;
  throw Object.assign(new Error('an allowlist entry must be host[:port] or scheme://host[:port]'), {
    code: 'agent_egress_allowlist_invalid'
  });
}

export function readAgentEgress(env = process.env) {
  const mode = String(env.CELIA_AGENT_EGRESS || 'off').trim().toLowerCase();
  if (mode !== 'off' && mode !== 'proxy') {
    throw Object.assign(
      new Error('CELIA_AGENT_EGRESS must be "off" (default) or "proxy" (governed web access through the egress proxy)'),
      { code: 'agent_egress_misconfigured' }
    );
  }
  if (mode === 'off') return { mode, hosts: [], allowlist: null, deny: ['*'] };
  let hosts;
  try {
    hosts = String(env.CELIA_AGENT_EGRESS_ALLOWLIST || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => normalizeEgressEntry(entry));
  } catch (error) {
    throw Object.assign(new Error(`CELIA_AGENT_EGRESS_ALLOWLIST is invalid: ${error?.code || error?.message}`), {
      code: 'agent_egress_allowlist_invalid'
    });
  }
  if (!hosts.length) {
    throw Object.assign(
      new Error('CELIA_AGENT_EGRESS=proxy requires CELIA_AGENT_EGRESS_ALLOWLIST (explicit hosts; "*" is refused)'),
      { code: 'agent_egress_allowlist_required' }
    );
  }
  let allowlist;
  try {
    allowlist = createEgressAllowlist({ hosts });
  } catch (error) {
    throw Object.assign(new Error(`CELIA_AGENT_EGRESS_ALLOWLIST is invalid: ${error?.code || error?.message}`), {
      code: 'agent_egress_allowlist_invalid'
    });
  }
  return { mode, hosts, allowlist, deny: ['*'] };
}

function buildConnectors({ env, pool, config, logger, resolveArtifact = null }) {
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
        folderId: env.CELIA_AGENT_DRIVE_FOLDER_ID || null,
        // B4: الرفع من مخزن artifacts يُركَّب فقط حين يوجد المخزن فعلًا (يُربط
        // بعد بناء الموصلات في هذا الملف). الافتراض null يعني: مسار المحتوى
        // المضمَّن وحده، بلا أي تغيير في السلوك القائم.
        resolveArtifact
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
  googleReaders: injectedGoogleReaders = null,
  // A1 injection seam: tests pass a mock provider; production builds Gemini from config.
  plannerProvider: injectedPlannerProvider = null
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
  let egressInfo = { mode: 'off', hosts: [], stats: null };
  let egressProxy = null;
  let closed = false;
  let webAccess = null;
  let egressConfig = { mode: 'off', hosts: [], allowlist: null, deny: ['*'] };
  // البوابة تُقرأ عند إنشاء المضيف لا عند أول جلب: إعداد خاطئ يُفشل الإقلاع عبر `ready` دون إسقاط الخادم الرئيسي.
  try {
    egressConfig = readAgentEgress(env);
  } catch (error) {
    failure = failure || { code: error.code || 'agent_egress_misconfigured', message: error.message };
  }
  const nodeEnv = config.nodeEnv || env.NODE_ENV || 'development';

  const ready = (async () => {
    if (failure) throw Object.assign(new Error(failure.message), { code: failure.code });
    if (mode === 'off') return null;
    const plannerMode = String(env.CELIA_AGENT_PLANNER || 'demo').trim().toLowerCase();
    if (plannerMode !== 'demo' && plannerMode !== 'gemini' && plannerMode !== 'gemini-router') {
      throw Object.assign(
        new Error('CELIA_AGENT_PLANNER must be "demo" (default, deterministic), "gemini" (A1 provider planner with governed fallback) or "gemini-router" (A4 two-tier model router)'),
        { code: 'agent_planner_unavailable' }
      );
    }
    if ((plannerMode === 'gemini' || plannerMode === 'gemini-router') && !injectedPlannerProvider && !config?.gemini?.apiKey) {
      // لا ارتداد صامت إلى demo: طلب gemini بلا مفتاح خطأ تهيئة صريح.
      throw Object.assign(
        new Error(`CELIA_AGENT_PLANNER=${plannerMode} requires GEMINI_API_KEY (config.gemini.apiKey); the default planner stays "demo"`),
        { code: 'agent_planner_misconfigured' }
      );
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
    // B4: الموصلات تُبنى قبل مخزن artifacts (الذي يعتمد على العزل)، فالربط
    // يُحلّ عند الإرسال لا عند الإقلاع: لا دورة اعتماد ولا ترتيب هش.
    const artifactBridge = { store: null };
    const connectors = injectedConnectors || buildConnectors({
      env,
      pool,
      config,
      logger,
      resolveArtifact: (args) => {
        if (!artifactBridge.store) {
          // لا مخزن = لا مسار artifact أصلًا؛ الرفض صريح ومثبت لا `null` صامت.
          return Promise.reject(
            Object.assign(new Error('drive_artifact_export_unavailable'), {
              code: 'drive_artifact_export_unavailable'
            })
          );
        }
        return artifactBridge.store.readForUpload(args);
      }
    });
    const requestedConnectors = readAgentConnectors(env);
    const googleReaders = injectedGoogleReaders || (!injectedConnectors && requestedConnectors.includes('google_read')
      ? buildGoogleReaders({ pool, config, env })
      : {});
    const gmail = injectedGmail || googleReaders.gmail || (!injectedConnectors && requestedConnectors.includes('gmail')
      ? buildGmailReader({ pool, config, env })
      : null);
    // M-B/B1: تفعيل sandbox.exec قرار استضافة صريح (CELIA_AGENT_SANDBOX=exec).
    // الافتراض off يبقي تعريف الرفض القائم حرفيًا؛ قيمة أخرى = خطأ تهيئة لا تجاهل.
    const sandboxMode = String(env.CELIA_AGENT_SANDBOX || 'off').trim().toLowerCase();
    if (sandboxMode !== 'off' && sandboxMode !== 'exec') {
      throw Object.assign(
        new Error('CELIA_AGENT_SANDBOX must be "off" (default) or "exec" (B1: isolated sandbox.exec in the tool registry)'),
        { code: 'agent_sandbox_misconfigured' }
      );
    }
    const sandboxExecutor = sandboxMode === 'exec'
      ? createSandboxExecutor({
          evidenceStore: store,
          artifactRoot: env.CELIA_SANDBOX_ARTIFACT_ROOT || undefined,
          policy: {
            resources: {
              // B1: workspace حتى 256MiB وزمن CPU قابلان للضبط لكل نشر —
              // قيم خارج حدود السياسة تفشل التهيئة بصوت عالٍ (createSandboxPolicy).
              workspaceBytes: positiveInt(env.CELIA_SANDBOX_WORKSPACE_BYTES, 8_388_608),
              cpuSeconds: positiveInt(env.CELIA_SANDBOX_CPU_SECONDS, 2),
              wallTimeoutMs: positiveInt(env.CELIA_SANDBOX_WALL_MS, 2_000)
            }
          }
        })
      : null;
    // M-B/B2: مخزن artifacts يركب حصرًا فوق العزل المفعّل — المحتوى يأتي من
    // readArtifact المتحقق بالبصمة لا من أي مسار آخر. مفتاح التوقيع من البيئة؛
    // غيابه يولّد مفتاحًا عشوائيًا لهذا الإقلاع فقط (الروابط تموت مع إعادة التشغيل
    // عمدًا — فاشل-مغلقًا، لا مفتاح ثابت مضمّن في الشيفرة أبدًا).
    const artifactStore = sandboxExecutor
      ? createArtifactStore({
          store,
          rootDir: env.CELIA_ARTIFACT_STORE_ROOT || '.data/agent-artifact-store',
          signingKey: env.CELIA_ARTIFACT_SIGNING_KEY || crypto.randomBytes(32).toString('hex'),
          urlTtlMs: positiveInt(env.CELIA_ARTIFACT_URL_TTL_MS, 900_000)
        })
      : null;
    // B4: الجسر يُغذّى الآن — وقبله كان `resolveArtifact` يُعيد null فيرفض
    // الموصل مسار artifact رفضًا مثبتًا (`drive_artifact_export_unavailable`).
    artifactBridge.store = artifactStore;
    // تفعيل الخيوط العنكبوتية: CELIA_AGENT_SPIDER=read يفتح فهرس العنكبوت المحلي
    // قراءةً فقط (صفر شبكة). الافتراض off؛ قيمة أخرى أو فهرس غائب = خطأ تهيئة
    // صريح عند الإقلاع — لا أدوات تدّعي شبكة معرفة غير موجودة.
    const spiderMode = String(env.CELIA_AGENT_SPIDER || 'off').trim().toLowerCase();
    if (spiderMode !== 'off' && spiderMode !== 'read') {
      throw Object.assign(
        new Error('CELIA_AGENT_SPIDER must be "off" (default) or "read" (read-only local spider knowledge index)'),
        { code: 'agent_spider_misconfigured' }
      );
    }
    const spiderReader = spiderMode === 'read'
      ? createSpiderReader({ dbPath: env.CELIA_SPIDER_DB_PATH || defaultSpiderDbPath(env) })
      : null;
    // M-C/C1-b: الوصول إلى الويب قرار نشر صريح. الوسيط يستمع على 127.0.0.1 فقط،
    // وكل جلب يأخذ منحة معتمة تُسحب بعد الاستخدام؛ بلا هذا العلم لا أداة web.fetch.
    if (egressConfig.mode === 'proxy') {
      const createdProxy = createEgressProxy({
        limits: { maxConnections: positiveInt(env.CELIA_AGENT_EGRESS_MAX_CONNECTIONS, 16) },
        onEvent: createEvidenceEgressSink({ store })
      });
      const address = await createdProxy.listen({ port: 0 });
      if (closed) {
        await createdProxy.close().catch(() => {});
        await store.close?.().catch?.(() => {});
        return null;
      }
      egressProxy = createdProxy;
      webAccess = createWebAccess({
        proxy: egressProxy,
        proxyUrl: address.url,
        allowlist: egressConfig.allowlist,
        limits: {
          maxFetchesPerRun: positiveInt(env.CELIA_AGENT_WEB_MAX_FETCHES, 6),
          maxTotalCharsPerRun: positiveInt(env.CELIA_AGENT_WEB_MAX_CHARS, 80_000)
        },
        // صف `web_source` لكل محاولة: مصدر مجلوب أو منع صريح — بالبصمة لا بالنص.
        store
      });
      egressInfo = {
        mode: 'proxy',
        hosts: egressConfig.hosts,
        url: address.url,
        deny: egressConfig.deny,
        maxConnections: egressProxy.limits.maxConnections,
        stats: null
      };
      logger.info?.(`Agent egress proxy on ${address.url} (allowlist: ${egressConfig.hosts.join(', ')})`);
    }
    const toolRegistry = createToolRegistry(defaultToolDefinitions({
      statusProvider,
      kb,
      gmail,
      googleReaders,
      plannerSafe: plannerMode === 'gemini' || plannerMode === 'gemini-router',
      sandbox: sandboxExecutor,
      artifacts: artifactStore,
      spider: spiderReader,
      web: webAccess
    }));
    const demoPlanner = createDemoPlanner({
      knowledge: Boolean(kb),
      // C2-a(loop): نية الويب تُعلن للمخطط فقط عند وجود خدمة ويب فعلية؛ بلا تفعيل
      // يرفض الطلب صراحةً بدل أن يتخطاه.
      web: Boolean(webAccess),
      gmail: Boolean(gmail),
      googleReaders: {
        drive: Boolean(googleReaders.drive),
        calendar: Boolean(googleReaders.calendar),
        contacts: Boolean(googleReaders.contacts)
      }
    });
    let planner = demoPlanner;
    if (plannerMode === 'gemini' || plannerMode === 'gemini-router') {
      // A1: المزوّد يقترح فقط ضمن 2-4 أدوات قراءة؛ الحلقة تبقى المنفّذ والبوابات كما هي.
      const allowedTools = [
        'celia.thread_context',
        'celia.system_status',
        'celia.draft_outline',
        ...(kb ? ['kb.search'] : [])
      ];
      let provider = injectedPlannerProvider;
      if (!provider && plannerMode === 'gemini-router') {
        // A4: طبقتان معلنتان — تسعير DECLARED_GEMINI_PRICING (إعلان تهيئة لا قياس)
        // وأسوأ تكلفة لكل استدعاء DEFAULT_PER_CALL_CAPS؛ نموذج خارج الجدول = خطأ تهيئة صريح.
        const plannerModel = String(config.gemini.model || 'gemini-2.5-flash');
        const fastModel = String(env.CELIA_AGENT_FAST_MODEL || 'gemini-2.5-flash-lite').trim();
        for (const modelId of [plannerModel, fastModel]) {
          if (!DECLARED_GEMINI_PRICING[modelId]) {
            throw Object.assign(
              new Error(`gemini-router has no declared pricing for model "${modelId}"; extend DECLARED_GEMINI_PRICING deliberately`),
              { code: 'agent_planner_misconfigured' }
            );
          }
        }
        provider = createModelRouter({
          tiers: {
            fast: {
              provider: createGeminiPlannerProvider({ apiKey: config.gemini.apiKey, model: fastModel }),
              model: fastModel,
              pricing: DECLARED_GEMINI_PRICING[fastModel],
              maxCostMicrosPerCall: DEFAULT_PER_CALL_CAPS.fast
            },
            planner: {
              provider: createGeminiPlannerProvider({ apiKey: config.gemini.apiKey, model: plannerModel }),
              model: plannerModel,
              pricing: DECLARED_GEMINI_PRICING[plannerModel],
              maxCostMicrosPerCall: DEFAULT_PER_CALL_CAPS.planner
            }
          }
        });
      }
      if (!provider) {
        provider = createGeminiPlannerProvider({
          apiKey: config.gemini.apiKey,
          model: config.gemini.model
        });
      }
      planner = createGovernedFallbackPlanner({
        // A2: نافذة مراجعة واحدة محكومة (maxPerStep=1 + حارس حلقة maxPerRun=1، قراءة فقط).
        primary: createProviderPlanner({ provider, tools: toolRegistry, allowedTools, revisionPolicy: createReplanPolicy() }),
        fallback: demoPlanner,
        // `web.fetch` تُضاف إلى قائمة المنفذ فقط حين يكون الوصول إلى الويب مُفعَّلًا
        // بهذه النشرة؛ بلا تفعيل تبقى القائمة حرفيًا كما كانت.
        extraAllowedTools: [...DEMO_PLANNER_TOOL_SURFACE, ...(webAccess ? ['web.fetch'] : [])]
      });
    }
    const runtime = createAgentRuntime({
      store,
      tools: toolRegistry,
      planner,
      artifacts: artifactStore,
      connectors,
      ownerId: config.userId || env.APP_USER_ID || 'owner',
      limits: readAgentLimits(env),
      logger
    });
    if (closed) {
      await runtime.shutdown().catch(() => {});
      if (egressProxy) {
        const activeProxy = egressProxy;
        egressProxy = null;
        await activeProxy.close().catch(() => {});
      }
      return null;
    }
    return runtime;
  })();

  // Prevent V8 UnhandledPromiseRejection from crashing the process when nobody
  // awaits `host.ready` on tick 0; `ready` itself still rejects for callers
  // such as `await host.ready` (HOST-01/HOST-02) and `await host.status()`.
  ready.catch(async () => {
    if (egressProxy) {
      const activeProxy = egressProxy;
      egressProxy = null;
      await activeProxy.close().catch(() => {});
    }
  });

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
    /**
     * سياسة الوصول إلى الويب كما تُنفَّذ فعلًا: الوضع، قائمة السماح **بعد التطبيع**
     * (كل عنصر بمنفذ صريح)، والمنع الافتراضي، وسقف التزامن، وأعداد القرارات.
     * لا رمز منحة ولا ترويسة ولا نص مجلوب هنا.
     */
    egress() {
      return {
        ...egressInfo,
        policy: {
          mode: egressInfo.mode,
          allow: egressInfo.hosts ? [...egressInfo.hosts] : [],
          deny: ['*'],
          upstreamProxy: null,
          maxConnections: egressInfo.maxConnections ?? null,
          perRun: webAccess ? { ...webAccess.limits } : null
        },
        stats: webAccess ? webAccess.stats() : null
      };
    },
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
    },
    async close() {
      closed = true;
      const runtime = await ready.catch(() => null);
      if (runtime?.shutdown) {
        await runtime.shutdown().catch(() => {});
      }
      if (egressProxy) {
        const activeProxy = egressProxy;
        egressProxy = null;
        await activeProxy.close().catch(() => {});
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
