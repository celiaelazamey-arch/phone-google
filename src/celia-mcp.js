import 'dotenv/config';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { google } from 'googleapis';
import helmet from 'helmet';
import { createPool, ensureOwner } from './db.js';
import { resolveEdgeOrigin } from './config.js';
import { loadMysqlConfig } from './mysql-config.js';
import { loadHostingConfig, deploymentStatus } from './hosting.js';
import { bootstrapEmptySchema } from './bootstrap-schema.js';
import { createIntegratedApiRouter } from './integrated-api.js';
import { createServiceRegistry, isolatePool, loadFeatures, loadResilienceConfig, safeError } from './resilience.js';
import { createOperations, mountOperations } from './operations.js';
import { SERVER_INFO } from './version.js';
import { installShutdown } from './lifecycle.js';
import { DEFAULT_POLICY } from './gemini.js';
import { loadExtendedIntegrationsConfig } from './ai-providers.js';
import { createCeliaUiRouter } from './celia-ui.js';
import { createAgentHost, scheduleBootRecovery } from './agent/index.js';
import { createAgentRouter } from './agent-routes.js';
import { createKnowledgeHost } from './knowledge/index.js';
import { createKbRouter } from './kb-routes.js';
import { createMemoryPool } from './memory-pool.js';
import { checkOllamaHealth, generateCeliaReply, normalizeOllamaBaseUrl, resolveEffectiveAiProvider, SUPPORTED_AI_PROVIDERS } from './ollama.js';
import {
  buildSecretsReadiness,
  createSecretsHubRouter,
  fetchFigmaProfile,
  getCodataStatus,
  inspectFigmaFile,
  synthesizeCeliaSpeech
} from './secrets-hub.js';
import { decryptJson, encryptJson, isValidE164, isWithinCustomerWindow, parseEncryptionKeyring, safeEqual } from './security.js';
import { sendWhatsAppText } from './whatsapp.js';
import { createIdempotencyStore, extractIdempotencyKey, isValidIdempotencyKey } from './idempotency.js';

const MCP_PROTOCOL_VERSION = '2024-11-05';

function isPlaceholder(value) {
  return !value || /^replace-with-/i.test(value);
}

export function loadCeliaMcpConfig(env = process.env, { requireToken = true } = {}) {
  const mcpToken = (env.CELIA_MCP_API_TOKEN || '').trim();
  if (requireToken) {
    if (!mcpToken || isPlaceholder(mcpToken)) {
      throw new Error('Missing required environment variable: CELIA_MCP_API_TOKEN (generate with `openssl rand -hex 32`)');
    }
    if (mcpToken.length < 32) {
      throw new Error('CELIA_MCP_API_TOKEN must be at least 32 characters');
    }
  }

  // Keep legacy .env PORT (REST) separate from CELIA_MCP_PORT unless full hosting is opted in.
  const rawPort = (env.CELIA_ENABLE_INTEGRATIONS === 'true' ? env.PORT ?? env.CELIA_MCP_PORT : env.CELIA_MCP_PORT) ?? '3010';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('CELIA_MCP_PORT must be a valid TCP port');
  }

  const rawEncryptionKey = (env.TOKEN_ENCRYPTION_KEY || '').trim();
  const hasValidEncryptionKey =
    Boolean(rawEncryptionKey) &&
    !isPlaceholder(rawEncryptionKey) &&
    Buffer.from(rawEncryptionKey, 'base64').length === 32;

  const extended = loadExtendedIntegrationsConfig(env);
  const requestedAiProvider = ((env.CELIA_AI_PROVIDER || 'auto').trim() || 'auto').toLowerCase();
  if (!SUPPORTED_AI_PROVIDERS.includes(requestedAiProvider)) {
    throw new Error('CELIA_AI_PROVIDER must be auto, gemini, ai_gateway, deepseek, agentrouter, ollama, or local');
  }

  return Object.freeze({
    nodeEnv: env.NODE_ENV || 'development',
    hosting: loadHostingConfig(env, mcpToken),
    deploymentRoot: env.CELIA_DEPLOYMENT_ROOT === 'true',
    edgeOrigin: resolveEdgeOrigin(env),
    features: loadFeatures(env),
    resilience: loadResilienceConfig(env),
    ...extended,
    host: (env.CELIA_MCP_HOST || '0.0.0.0').trim() || '0.0.0.0',
    port,
    userId: (env.APP_USER_ID || 'owner').trim() || 'owner',
    ownerEmail: (env.APP_OWNER_EMAIL || '').trim(),
    ownerPhone: (env.APP_OWNER_PHONE_E164 || env.PHONE_NUMBER || '').trim() || null,
    ownerPhoneSourceEnv: (env.APP_OWNER_PHONE_E164 || '').trim()
      ? 'APP_OWNER_PHONE_E164'
      : (env.PHONE_NUMBER || '').trim()
        ? 'PHONE_NUMBER'
        : null,
    encryptionKey: hasValidEncryptionKey ? rawEncryptionKey : '',
    encryptionKeyring: hasValidEncryptionKey
      ? parseEncryptionKeyring(rawEncryptionKey, {
          primaryKeyId: env.TOKEN_ENCRYPTION_KEY_ID || '',
          keyringSpec: env.TOKEN_ENCRYPTION_KEYRING || ''
        })
      : null,
    envDisableMysql: env.CELIA_MCP_DISABLE_MYSQL === 'true',
    landingRoot: env.CELIA_LANDING_ROOT === 'true',
    celia: Object.freeze({
      apiToken: mcpToken,
      aiProvider: requestedAiProvider
    }),
    mysql: loadMysqlConfig(env),
    google: Object.freeze({
      clientId: (env.GOOGLE_CLIENT_ID || '').trim(),
      clientSecret: (env.GOOGLE_CLIENT_SECRET || '').trim(),
      redirectUri: (env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback').trim()
    }),
    gemini: Object.freeze({
      apiKey: (env.GEMINI_API_KEY || '').trim(),
      model: (env.GEMINI_MODEL || 'gemini-2.5-flash').trim() || 'gemini-2.5-flash',
      businessContext: env.GEMINI_BUSINESS_CONTEXT || ''
    }),
    ollama: Object.freeze({
      baseUrl: normalizeOllamaBaseUrl(env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434', env.OLLAMA_ALLOW_REMOTE === 'true'),
      model: (env.OLLAMA_MODEL || 'qwen2.5:7b').trim() || 'qwen2.5:7b',
      allowRemote: env.OLLAMA_ALLOW_REMOTE === 'true'
    }),
    whatsapp: Object.freeze({
      verifyToken: isPlaceholder(env.WHATSAPP_VERIFY_TOKEN) ? '' : (env.WHATSAPP_VERIFY_TOKEN || '').trim(),
      appSecret: (env.WHATSAPP_APP_SECRET || '').trim(),
      accessToken: (env.WHATSAPP_ACCESS_TOKEN || '').trim(),
      phoneNumberId: (env.WHATSAPP_PHONE_NUMBER_ID || '').trim(),
      apiVersion: (env.WHATSAPP_API_VERSION || 'v23.0').trim() || 'v23.0',
      autoReplyEnabled: env.WHATSAPP_AUTO_REPLY_ENABLED === 'true'
    })
  });
}

export async function connectPoolWithFallback(config) {
  if (config.envDisableMysql) {
    const memoryPool = createMemoryPool();
    await memoryPool.execute(
      'INSERT INTO app_users (id, email, phone_e164) VALUES (?, ?, ?)',
      [config.userId, config.ownerEmail || null, config.ownerPhone]
    );
    return memoryPool;
  }
  // A failed durable store is never silently replaced with an empty in-memory database.
  // The core starts in degraded mode and the same pool can recover on a later request.
  if (config.hosting?.initializeDatabase === 'empty-only') {
    const installation = await bootstrapEmptySchema(config);
    console.log(`Database first-install check: ${installation.action} (schema=${installation.schema}).`);
  }
  const pool = createPool(config);
  try { await ensureOwner(pool, config); }
  catch { console.error('Storage unavailable at startup; durable operations are suspended until recovery.'); }
  return pool;
}

async function getGoogleClient(pool, config) {
  if (!config.google.clientId || !config.google.clientSecret) {
    throw Object.assign(new Error('google_not_configured'), { status: 400 });
  }
  if (!config.encryptionKey) {
    throw Object.assign(new Error('encryption_key_missing'), { status: 400 });
  }
  const [rows] = await pool.execute('SELECT encrypted_tokens FROM google_credentials WHERE user_id = ?', [config.userId]);
  if (!rows.length) {
    throw Object.assign(new Error('google_not_connected'), { status: 409 });
  }
  const client = new google.auth.OAuth2({ clientId: config.google.clientId, clientSecret: config.google.clientSecret, redirectUri: config.google.redirectUri, transporterOptions: { timeout: config.resilience?.timeoutMs || 8000, retry: false } });
  const keyTarget = config.encryptionKeyring || config.encryptionKey;
  const tokens = decryptJson(rows[0].encrypted_tokens, keyTarget);
  client.setCredentials(tokens);
  client.on('tokens', (fresh) => {
    const merged = { ...tokens, ...fresh, refresh_token: fresh.refresh_token || tokens.refresh_token };
    pool.execute(
      'UPDATE google_credentials SET encrypted_tokens = ? WHERE user_id = ?',
      [encryptJson(merged, keyTarget), config.userId]
    ).catch(() => {});
  });
  return client;
}

export const MCP_TOOLS = Object.freeze([
  {
    name: 'celia_status',
    description: 'فحص حالة خادم Celia MCP ومزودي الذكاء الاصطناعي (Gemini / Ollama qwen2.5:7b) وتكامل Google وWhatsApp دون كشف أي أسرار.',
    inputSchema: {
      type: 'object',
      properties: {
        probeOllama: { type: 'boolean', description: 'فحص اتصال خادم Ollama المحلي عند الطلب (افتراضي true).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'celia_ai_reply',
    description: 'توليد رد خدمة عملاء مهذب وآمن عبر مزودي السحابة (Gemini / AI Gateway / DeepSeek / AgentRouter) أو عبر Ollama المحلي (qwen2.5:7b) أو حارس القواعد المحلي.',
    inputSchema: {
      type: 'object',
      required: ['customerMessage'],
      properties: {
        customerMessage: { type: 'string', description: 'رسالة العميل المراد الرد عليها.' },
        provider: {
          type: 'string',
          enum: ['auto', 'gemini', 'ai_gateway', 'deepseek', 'agentrouter', 'ollama', 'local'],
          description: 'auto: يختار المزود المهيأ (Gemini / AI Gateway / DeepSeek / AgentRouter) ثم Ollama ثم قواعد محلية؛ أو تحديد المزود صراحة.'
        },
        businessContext: { type: 'string', description: 'سياق نشاط معتمد اختياري يُمرر للنموذج.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'google_gmail_search',
    description: 'بحث للقراءة فقط في رسائل Gmail (بيانات وصفية ومقتطفات بدون مرفقات).',
    inputSchema: {
      type: 'object',
      required: ['q'],
      properties: {
        q: { type: 'string', description: 'عبارة البحث بصيغة Gmail.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'google_drive_search',
    description: 'بحث للقراءة فقط عن الملفات في Google Drive حسب الاسم.',
    inputSchema: {
      type: 'object',
      required: ['q'],
      properties: {
        q: { type: 'string', description: 'جزء من اسم الملف.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'google_calendar_events_list',
    description: 'قراءة مواعيد Google Calendar القادمة خلال عدد محدد من الأيام (1–30).',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 30, description: 'عدد الأيام القادمة (افتراضي 7).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'google_calendar_events_create',
    description: 'إنشاء موعد جديد في Google Calendar الأساسي. يدعم Idempotency-Key لمنع التكرار بعد الاستئناف.',
    inputSchema: {
      type: 'object',
      required: ['summary', 'start', 'end'],
      properties: {
        summary: { type: 'string', description: 'عنوان الموعد.' },
        start: { type: 'string', description: 'وقت البداية بصيغة ISO 8601.' },
        end: { type: 'string', description: 'وقت النهاية بصيغة ISO 8601.' },
        timeZone: { type: 'string', description: 'المنطقة الزمنية الاختيارية (مثل Africa/Cairo أو UTC).' },
        idempotencyKey: { type: 'string', description: 'مفتاح تفرد اختياري (8-64 حرفًا a-zA-Z0-9_- ) لمنع تكرار إنشاء الموعد عند إعادة المحاولة.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'google_contacts_search',
    description: 'بحث للقراءة فقط في جهات اتصال Google.',
    inputSchema: {
      type: 'object',
      required: ['q'],
      properties: {
        q: { type: 'string', description: 'الاسم أو الرقم أو البريد المراد البحث عنه.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'whatsapp_consent_upsert',
    description: 'تسجيل أو تحديث موافقة عميل WhatsApp وموافقة الذكاء الاصطناعي المنفصلة بصيغة E.164.',
    inputSchema: {
      type: 'object',
      required: ['phone', 'optedIn'],
      properties: {
        phone: { type: 'string', description: 'رقم الهاتف بصيغة E.164 مثل +201000000000.' },
        optedIn: { type: 'boolean', description: 'موافقة استقبال رسائل WhatsApp.' },
        aiOptedIn: { type: 'boolean', description: 'موافقة منفصلة على معالجة الرسائل بالذكاء الاصطناعي.' },
        source: { type: 'string', description: 'مصدر الموافقة الموثق (مطلوب عند optedIn=true).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'whatsapp_contacts_list',
    description: 'عرض جهات اتصال WhatsApp المسجلة وحالة الموافقة ونافذة الـ 24 ساعة.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'find_skills',
    description: 'مهارة البحث الحي عن قدرات النظام (Find Skills) — تبحث في جميع أدوات Celia MCP بالعربية أو الإنجليزية وتُرجع المهارات المطابقة مع حالتها الحية وكيفية استدعائها.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'كلمة البحث: مثل gmail، drive، whatsapp، calendar، ai، تشفير، موافقة، إرسال، أو اتركه فارغًا لعرض كل المهارات.' },
        category: { type: 'string', enum: ['all', 'google', 'whatsapp', 'ai', 'security', 'system'], description: 'تصفية حسب الفئة.' },
        liveCheck: { type: 'boolean', description: 'إجراء فحص حي لحالة كل مهارة (افتراضي true).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'system_live_view',
    description: 'عرض النظام حيّ على أرض الواقع — تقرير لحظي يضم حالة الخادم، التخزين، مزودي الذكاء الاصطناعي، جاهزية Google/WhatsApp، عدد الأدوات، وروابط المعاينة والفحص المباشر.',
    inputSchema: {
      type: 'object',
      properties: {
        includeTelemetry: { type: 'boolean', description: 'تضمين القياسات الحية (افتراضي true)' },
        probeOllama: { type: 'boolean', description: 'فحص Ollama المحلي' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'whatsapp_send_text',
    description: 'إرسال رسالة WhatsApp فردية لعميل وافق مسبقًا وداخل نافذة خدمة العملاء (24 ساعة). يدعم Idempotency-Key لمنع الإرسال المكرر.',
    inputSchema: {
      type: 'object',
      required: ['phone', 'text'],
      properties: {
        phone: { type: 'string', description: 'رقم الهاتف بصيغة E.164.' },
        text: { type: 'string', description: 'نص الرسالة (1–4096 حرفًا).' },
        idempotencyKey: { type: 'string', description: 'مفتاح تفرد اختياري (8-64 حرفًا) لمنع تكرار الإرسال عند إعادة المحاولة أو استئناف التطبيق.' }
      },
      additionalProperties: false
    }
  }
]);

export const EXTENDED_MCP_TOOLS = Object.freeze([
  {
    name: 'celia_voice_speak',
    description: 'تحويل نص الرد العربي أو متعدد اللغات إلى صوت سيليا عبر ElevenLabs (ELEVENLABS_API_KEY + CELIA_VOICE_ID) مع دعم Idempotency-Key.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'النص المراد تحويله إلى صوت (1–1000 حرف).' },
        modelId: { type: 'string', description: 'معرف نموذج ElevenLabs الاختياري (الافتراضي eleven_multilingual_v2).' },
        stability: { type: 'number', minimum: 0, maximum: 1, description: 'درجة ثبات الصوت (0–1).' },
        similarityBoost: { type: 'number', minimum: 0, maximum: 1, description: 'درجة تطابق بصمة الصوت (0–1).' },
        idempotencyKey: { type: 'string', description: 'مفتاح تفرد اختياري (8-64 حرفًا) لمنع تكرار التوليد الصوتي.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'figma_file_inspect',
    description: 'قراءة آمنة لملف تصميم Figma أو هوية الحساب عبر FIGMA_ACCESS_TOKEN (للقراءة فقط دون تعديل).',
    inputSchema: {
      type: 'object',
      properties: {
        fileKey: { type: 'string', description: 'معرف ملف Figma (اتركه فارغًا لفحص هوية الحساب فقط عبر /v1/me).' },
        depth: { type: 'integer', minimum: 1, maximum: 3, description: 'عمق شجرة الصفحات (1–3، الافتراضي 1).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'codata_status',
    description: 'فحص جاهزية ربط مساحة Codata (YOUR_CODATA_API_KEY) للقراءة فقط دون ترحيل تلقائي للبيانات.',
    inputSchema: {
      type: 'object',
      properties: {
        probe: { type: 'boolean', description: 'إجراء فحص اتصال حي للقراءة فقط إذا ضُبط CODATA_BASE_URL (الافتراضي false).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'celia_secrets_status',
    description: 'تقرير منقّح لحالة جميع أسرار المستودع التسعة المهيأة وحالة القواطع دون كشف أي قيم سرية.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  }
]);

export function getActiveMcpTools(config) {
  return config?.extendedMcpTools ? [...MCP_TOOLS, ...EXTENDED_MCP_TOOLS] : MCP_TOOLS;
}

export async function buildStatusSummary(pool, config, { probeOllama = false, services } = {}) {
  const ollamaHealth = probeOllama && config.features?.ollama !== false
    ? await checkOllamaHealth({
        baseUrl: config.ollama.baseUrl,
        model: config.ollama.model,
        allowRemote: config.ollama.allowRemote
      })
    : { reachable: null, model: config.ollama.model, modelAvailable: null };

  const geminiConfigured = Boolean(config.gemini.apiKey);
  const activeDefaultProvider = resolveEffectiveAiProvider(config);
  const activeTools = getActiveMcpTools(config);
  const secretsReadiness = buildSecretsReadiness(config, services);

  return {
    status: 'ok',
    service: SERVER_INFO.name,
    version: SERVER_INFO.version,
    protocolVersion: MCP_PROTOCOL_VERSION,
    circuits: services?.snapshot() || [],
    toolsCount: activeTools.length,
    storage: pool.isMemory ? 'memory' : 'mysql',
    providers: {
      configuredMode: config.celia.aiProvider,
      effectiveDefault: activeDefaultProvider,
      gemini: {
        configured: geminiConfigured,
        model: config.gemini.model
      },
      aiGateway: {
        configured: Boolean(config.aiGateway?.apiKey),
        model: config.aiGateway?.model || 'google/gemini-2.5-flash'
      },
      deepseek: {
        configured: Boolean(config.deepseek?.apiKey),
        model: config.deepseek?.model || 'deepseek-flash'
      },
      agentrouter: {
        configured: Boolean(config.agentrouter?.apiKey),
        model: config.agentrouter?.model || 'deepseek-chat'
      },
      ollama: {
        baseUrl: config.ollama.baseUrl,
        model: config.ollama.model,
        ...ollamaHealth
      },
      elevenlabs: {
        configured: Boolean(config.elevenlabs?.apiKey && config.elevenlabs?.voiceId),
        apiKeyConfigured: Boolean(config.elevenlabs?.apiKey),
        voiceIdConfigured: Boolean(config.elevenlabs?.voiceId),
        model: config.elevenlabs?.model || 'eleven_multilingual_v2'
      },
      figma: {
        configured: Boolean(config.figma?.accessToken)
      },
      codata: {
        configured: Boolean(config.codata?.apiKey),
        liveProbeConfigured: Boolean(config.codata?.baseUrl)
      },
      google: {
        oauthConfigured: Boolean(config.google.clientId && config.google.clientSecret),
        encryptionReady: Boolean(config.encryptionKey)
      },
      whatsapp: {
        cloudApiConfigured: Boolean(config.whatsapp.accessToken && config.whatsapp.phoneNumberId),
        webhookConfigured: Boolean(config.whatsapp.verifyToken && config.whatsapp.appSecret),
        autoReplyEnabled: config.whatsapp.autoReplyEnabled
      },
      secretsConfiguredCount: secretsReadiness.configuredCount,
      totalSecretsTracked: secretsReadiness.totalSecretsTracked
    }
  };
}

export function createCeliaMcpHandler({ pool, config, services = createServiceRegistry(config), idempotencyStore = createIdempotencyStore() }) {
  pool = isolatePool(pool, services);
  async function runTool(name, args = {}, signal) {
    switch (name) {
      case 'celia_status': {
        const probeOllama = args?.probeOllama !== false;
        return buildStatusSummary(pool, config, { probeOllama, services });
      }
      case 'celia_ai_reply': {
        const customerMessage = String(args?.customerMessage || '').trim();
        if (!customerMessage) throw new Error('customerMessage is required');
        return generateCeliaReply({
          config,
          services,
          customerMessage,
          provider: args?.provider || config.celia.aiProvider,
          businessContext: typeof args?.businessContext === 'string' ? args.businessContext : undefined
        });
      }
      case 'google_gmail_search': {
        const q = String(args?.q || '').trim().slice(0, 500);
        if (!q) throw new Error('q is required');
        const client = await getGoogleClient(pool, config);
        const gmail = google.gmail({ version: 'v1', auth: client });
        const listed = await gmail.users.messages.list({ userId: 'me', q, maxResults: 10 }, { signal, retry: false, timeout: config.resilience?.timeoutMs || 8000 });
        const messages = await Promise.all((listed.data.messages || []).map(async ({ id }) => {
          const { data } = await gmail.users.messages.get({
            userId: 'me',
            id,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject', 'Date']
          }, { signal, retry: false, timeout: config.resilience?.timeoutMs || 8000 });
          const headers = Object.fromEntries((data.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
          return { id, snippet: data.snippet || '', from: headers.from || '', to: headers.to || '', subject: headers.subject || '', date: headers.date || '' };
        }));
        return { messages };
      }
      case 'google_drive_search': {
        const q = String(args?.q || '').trim().slice(0, 200);
        if (!q) throw new Error('q is required');
        const client = await getGoogleClient(pool, config);
        const drive = google.drive({ version: 'v3', auth: client });
        const escaped = q.replaceAll("'", "\\'");
        const { data } = await drive.files.list({
          q: `trashed = false and name contains '${escaped}'`,
          pageSize: 20,
          orderBy: 'modifiedTime desc',
          fields: 'files(id,name,mimeType,modifiedTime,webViewLink)'
        }, { signal, retry: false, timeout: config.resilience?.timeoutMs || 8000 });
        return { files: data.files || [] };
      }
      case 'google_calendar_events_list': {
        const days = Math.max(1, Math.min(30, Number(args?.days) || 7));
        const client = await getGoogleClient(pool, config);
        const calendar = google.calendar({ version: 'v3', auth: client });
        const now = new Date();
        const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
        const { data } = await calendar.events.list({
          calendarId: 'primary',
          timeMin: now.toISOString(),
          timeMax: until.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 50,
          fields: 'items(id,summary,start,end,htmlLink,status)'
        }, { signal, retry: false, timeout: config.resilience?.timeoutMs || 8000 });
        return { events: data.items || [] };
      }
      case 'google_calendar_events_create': {
        const { summary, start, end, timeZone } = args || {};
        if (typeof summary !== 'string' || !summary.trim() || typeof start !== 'string' || typeof end !== 'string') {
          throw new Error('summary, start, and end are required');
        }
        const startDate = new Date(start);
        const endDate = new Date(end);
        if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || endDate <= startDate) {
          throw new Error('invalid_event_time_range');
        }
        const idempotencyKey = extractIdempotencyKey({ args });
        if (idempotencyKey) {
          const cached = idempotencyStore.get(idempotencyKey);
          if (cached) {
            if (cached._idempotencyStatus === 'in_progress') throw Object.assign(new Error('idempotency_conflict_in_progress'), { status: 409 });
            return { ...cached, _idempotencyReplay: true };
          }
          if (!idempotencyStore.claim(idempotencyKey)) {
            const again = idempotencyStore.get(idempotencyKey);
            if (again?._idempotencyStatus === 'in_progress') throw Object.assign(new Error('idempotency_conflict_in_progress'), { status: 409 });
            if (again) return { ...again, _idempotencyReplay: true };
          }
        }
        try {
          const client = await getGoogleClient(pool, config);
          const calendar = google.calendar({ version: 'v3', auth: client });
          const tz = timeZone ? { timeZone: String(timeZone).slice(0, 100) } : {};
          const { data } = await calendar.events.insert({
            calendarId: 'primary',
            requestBody: {
              summary: summary.trim().slice(0, 200),
              start: { dateTime: startDate.toISOString(), ...tz },
              end: { dateTime: endDate.toISOString(), ...tz }
            },
            fields: 'id,summary,start,end,htmlLink,status'
          }, { signal, retry: false, timeout: config.resilience?.timeoutMs || 8000 });
          const result = { event: data };
          if (idempotencyKey) idempotencyStore.complete(idempotencyKey, result);
          return result;
        } catch (error) {
          if (idempotencyKey) idempotencyStore.fail(idempotencyKey);
          throw error;
        }
      }
      case 'google_contacts_search': {
        const q = String(args?.q || '').trim().toLocaleLowerCase().slice(0, 100);
        if (!q) throw new Error('q is required');
        const client = await getGoogleClient(pool, config);
        const people = google.people({ version: 'v1', auth: client });
        const { data } = await people.people.connections.list({
          resourceName: 'people/me',
          pageSize: 100,
          personFields: 'names,phoneNumbers,emailAddresses'
        }, { signal, retry: false, timeout: config.resilience?.timeoutMs || 8000 });
        const contacts = (data.connections || []).map((person) => ({
          name: person.names?.[0]?.displayName || '',
          phones: (person.phoneNumbers || []).map((item) => item.value),
          emails: (person.emailAddresses || []).map((item) => item.value)
        })).filter((person) => [person.name, ...person.phones, ...person.emails].some((v) => v.toLocaleLowerCase().includes(q)));
        return { contacts: contacts.slice(0, 20) };
      }
      case 'whatsapp_consent_upsert': {
        const rawPhone = String(args?.phone || '').trim();
        const phone = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;
        const optedIn = args?.optedIn;
        const aiOptedIn = args?.aiOptedIn === true;
        const source = typeof args?.source === 'string' ? args.source.trim().slice(0, 128) : '';
        if (!isValidE164(phone) || typeof optedIn !== 'boolean' || (optedIn && !source) || (aiOptedIn && !optedIn)) {
          throw new Error('valid_phone_optedIn_and_consent_source_required');
        }
        await pool.execute(
          `INSERT INTO whatsapp_contacts (phone_e164, opted_in, ai_opted_in, consent_source, consented_at)
           VALUES (?, ?, ?, ?, IF(?, UTC_TIMESTAMP(), NULL))
           ON DUPLICATE KEY UPDATE opted_in = VALUES(opted_in), ai_opted_in = VALUES(ai_opted_in), consent_source = VALUES(consent_source), consented_at = VALUES(consented_at)`,
          [phone, optedIn, optedIn && aiOptedIn, optedIn ? source : null, optedIn]
        );
        return { phone, optedIn, aiOptedIn: optedIn && aiOptedIn, source: optedIn ? source : null };
      }
      case 'whatsapp_contacts_list': {
        const [rows] = await pool.execute(
          'SELECT phone_e164, opted_in, ai_opted_in, consent_source, consented_at, last_inbound_at FROM whatsapp_contacts ORDER BY phone_e164 ASC LIMIT 100'
        );
        return {
          contacts: rows.map((row) => ({
            phone: row.phone_e164,
            optedIn: Boolean(row.opted_in),
            aiOptedIn: Boolean(row.ai_opted_in),
            consentSource: row.consent_source || null,
            withinCustomerWindow: isWithinCustomerWindow(row.last_inbound_at)
          }))
        };
      }
      case 'whatsapp_send_text': {
        const rawPhone = String(args?.phone || '').trim();
        const phone = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;
        const text = typeof args?.text === 'string' ? args.text : '';
        if (!isValidE164(phone) || !text.trim()) throw new Error('valid_phone_and_text_required');
        const idempotencyKey = extractIdempotencyKey({ args });
        if (idempotencyKey) {
          const cached = idempotencyStore.get(idempotencyKey);
          if (cached) {
            if (cached._idempotencyStatus === 'in_progress') throw Object.assign(new Error('idempotency_conflict_in_progress'), { status: 409 });
            return { ...cached, _idempotencyReplay: true };
          }
          if (!idempotencyStore.claim(idempotencyKey)) {
            const again = idempotencyStore.get(idempotencyKey);
            if (again?._idempotencyStatus === 'in_progress') throw Object.assign(new Error('idempotency_conflict_in_progress'), { status: 409 });
            if (again) return { ...again, _idempotencyReplay: true };
          }
        }
        const [rows] = await pool.execute('SELECT opted_in, last_inbound_at FROM whatsapp_contacts WHERE phone_e164 = ?', [phone]);
        const contact = rows[0];
        if (!contact?.opted_in) {
          if (idempotencyKey) idempotencyStore.fail(idempotencyKey);
          throw new Error('recipient_has_not_opted_in');
        }
        if (!isWithinCustomerWindow(contact.last_inbound_at)) {
          if (idempotencyKey) idempotencyStore.fail(idempotencyKey);
          throw new Error('outside_customer_service_window_use_approved_template');
        }
        try {
          const providerMessageId = await sendWhatsAppText({ config, phone, text, signal });
          if (providerMessageId) {
            await pool.execute(
              'INSERT IGNORE INTO whatsapp_messages (provider_message_id, phone_e164, direction, message_type, body, status) VALUES (?, ?, ?, ?, ?, ?)',
              [providerMessageId, phone, 'outbound', 'text', text.trim().slice(0, 4000), 'sent']
            );
          }
          const result = { status: 'accepted', phone, providerMessageId };
          if (idempotencyKey) idempotencyStore.complete(idempotencyKey, result);
          return result;
        } catch (error) {
          if (idempotencyKey) idempotencyStore.fail(idempotencyKey);
          throw error;
        }
      }
      case 'find_skills': {
        const query = String(args?.query || '').trim().toLowerCase();
        const category = String(args?.category || 'all').toLowerCase();
        const liveCheck = args?.liveCheck !== false;
        const categoryMap = {
          google: ['gmail', 'drive', 'calendar', 'contacts', 'google', 'بريد', 'ملفات', 'تقويم', 'مواعيد', 'جهات'],
          whatsapp: ['whatsapp', 'واتساب', 'إرسال'],
          ai: ['ai', 'reply', 'celia_ai', 'ذكاء', 'رد'],
          security: ['consent', 'crypto', 'celia_status', 'تشفير', 'موافقة', 'أمان'],
          system: ['status', 'celia_status', 'find_skills', 'system_live', 'live_view', 'نظام', 'حالة']
        };
        const synonymExpansions = {
          تقويم: ['calendar', 'مواعيد', 'موعد'],
          بريد: ['gmail', 'رسائل'],
          ملفات: ['drive', 'ملف'],
          جهات: ['contacts', 'اتصال'],
          تشفير: ['security', 'consent', 'celia_status', 'system_live_view'],
          أمان: ['security', 'consent', 'celia_status'],
          إرسال: ['send', 'whatsapp_send_text'],
          ذكاء: ['ai', 'celia_ai_reply'],
          حالة: ['status', 'celia_status', 'system_live_view']
        };
        const activeTools = getActiveMcpTools(config);
        const allToolsDetailed = activeTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          tags: Object.entries(categoryMap).filter(([, keys]) => keys.some((k) => t.name.toLowerCase().includes(k) || t.description.toLowerCase().includes(k))).map(([cat]) => cat),
          invocation: `tools/call → ${t.name}`,
          example: `{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"${t.name}\",\"arguments\":{}}}`
        }));
        let filtered = allToolsDetailed;
        if (category !== 'all' && categoryMap[category]) {
          filtered = filtered.filter((t) => t.tags.includes(category) || (category === 'system' && ['find_skills','system_live_view','celia_status','celia_secrets_status'].includes(t.name)));
        }
        if (query) {
          const terms = [query, ...(synonymExpansions[query] || [])];
          filtered = filtered.filter((t) => {
            const haystack = `${t.name.toLowerCase()} ${t.description.toLowerCase()} ${t.tags.join(' ')}`;
            return terms.some((term) => haystack.includes(term));
          });
        }
        let liveStatus = null;
        if (liveCheck) {
          liveStatus = await buildStatusSummary(pool, config, { probeOllama: Boolean(args?.probeOllama) }).catch(() => null);
        }
        return {
          query: args?.query || '',
          category,
          totalSkills: activeTools.length,
          matched: filtered.length,
          liveStatus,
          skills: filtered,
          hint: 'استخدم system_live_view لرؤية النظام حيّ على أرض الواقع، أو celia_status للفحص السريع.'
        };
      }
      case 'system_live_view': {
        const includeTelemetry = args?.includeTelemetry !== false;
        const probeOllama = args?.probeOllama !== false;
        const status = await buildStatusSummary(pool, config, { probeOllama, services });
        const now = new Date();
        const uptimeSec = Math.floor(process.uptime());
        const demoPhone = '+201000000000';
        const telemetry = includeTelemetry ? {
          timestamp: now.toISOString(),
          uptime: `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s`,
          nodeVersion: process.version,
          memoryUsage: process.memoryUsage(),
          storage: status.storage,
          ownerPhoneDemo: demoPhone,
          liveEndpoints: {
            ui: '/studio',
            landing: '/landing',
            live: '/live',
            skills: '/skills',
            apiLive: '/api/live',
            health: '/health',
            mcp: '/mcp',
            sandboxRpc: '/ui/workspace/rpc',
            cryptoLab: '/ui/workspace/crypto-lab'
          }
        } : null;
        return {
          live: true,
          message: 'نظامك حي على أرض الواقع — Celia MCP يعمل الآن ويستقبل الطلبات لحظيًا',
          status,
          telemetry,
          nextSteps: [
            'جرّب find_skills مع query=\"whatsapp\" لاستكشاف مهارات واتساب',
            'استدعِ whatsapp_consent_upsert لتسجيل موافقة +201065217834',
            'استخدم simulate_inbound_whatsapp عبر /ui/workspace/crypto-lab لمحاكاة رسالة حية',
            'استدعِ celia_ai_reply لاختبار الرد الذكي مع حارس السياسة'
          ],
          previewNote: 'هذا الرد مولّد لحظيًا من الخادم الحي — كل قيمة فيه مقاسة في زمن الطلب.'
        };
      }
      case 'celia_voice_speak': {
        const idempotencyKey = extractIdempotencyKey({ args });
        if (idempotencyKey) {
          const cached = idempotencyStore.get(idempotencyKey);
          if (cached) {
            if (cached._idempotencyStatus === 'in_progress') throw Object.assign(new Error('idempotency_conflict_in_progress'), { status: 409 });
            return { ...cached, _idempotencyReplay: true };
          }
          if (!idempotencyStore.claim(idempotencyKey)) {
            const again = idempotencyStore.get(idempotencyKey);
            if (again?._idempotencyStatus === 'in_progress') throw Object.assign(new Error('idempotency_conflict_in_progress'), { status: 409 });
            if (again) return { ...again, _idempotencyReplay: true };
          }
        }
        try {
          const synthesized = await synthesizeCeliaSpeech({
            config,
            text: args?.text,
            modelId: args?.modelId,
            stability: args?.stability,
            similarityBoost: args?.similarityBoost,
            signal
          });
          if (idempotencyKey) idempotencyStore.complete(idempotencyKey, synthesized);
          return synthesized;
        } catch (error) {
          if (idempotencyKey) idempotencyStore.fail(idempotencyKey);
          throw error;
        }
      }
      case 'figma_file_inspect': {
        const fileKey = String(args?.fileKey || '').trim();
        if (!fileKey) return fetchFigmaProfile({ config, signal });
        return inspectFigmaFile({ config, fileKey, depth: args?.depth, signal });
      }
      case 'codata_status': {
        return getCodataStatus({ config, probe: args?.probe === true });
      }
      case 'celia_secrets_status': {
        return buildSecretsReadiness(config, services);
      }
      default: {
        const error = new Error(`Unknown MCP tool: ${name}`);
        error.code = -32602;
        throw error;
      }
    }
  }

  async function callTool(name, args = {}) {
    const boundary = {
      google_gmail_search: 'google.gmail', google_drive_search: 'google.drive',
      google_calendar_events_list: 'google.calendar', google_calendar_events_create: 'google.calendar',
      google_contacts_search: 'google.contacts', whatsapp_send_text: 'whatsapp',
      celia_voice_speak: 'elevenlabs', figma_file_inspect: 'figma',
      ...(args?.probe === true ? { codata_status: 'codata' } : {})
    }[name];
    if (!boundary) return runTool(name, args);
    return services.run(boundary, (signal) => runTool(name, args, signal), {
      sideEffect: ['google_calendar_events_create', 'whatsapp_send_text', 'celia_voice_speak'].includes(name)
    });
  }

  async function handleRpcMessage(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return {
        jsonrpc: '2.0',
        id: message?.id ?? null,
        error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' }
      };
    }

    const isNotification = message.id === undefined;
    const { id, method, params } = message;

    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return null;
    }

    try {
      let result;
      switch (method) {
        case 'initialize': {
          const requestedVersion = typeof params?.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSION;
          const supported = ['2024-11-05', '2025-03-26'];
          result = {
            protocolVersion: supported.includes(requestedVersion) ? requestedVersion : MCP_PROTOCOL_VERSION,
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
              prompts: { listChanged: false }
            },
            serverInfo: SERVER_INFO
          };
          break;
        }
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools: getActiveMcpTools(config) };
          break;
        case 'tools/call': {
          const toolName = String(params?.name || '');
          if (!toolName) {
            return { jsonrpc: '2.0', id: id ?? null, error: { code: -32602, message: 'Tool name is required' } };
          }
          const activeTools = getActiveMcpTools(config);
          const exists = activeTools.some((tool) => tool.name === toolName);
          if (!exists) {
            return { jsonrpc: '2.0', id: id ?? null, error: { code: -32602, message: `Unknown tool: ${toolName}` } };
          }
          try {
            const output = await callTool(toolName, params?.arguments || {});
            result = {
              content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
              structuredContent: output,
              isError: false
            };
          } catch (toolError) {
            result = {
              content: [{ type: 'text', text: JSON.stringify({ error: safeError(toolError), outcomeUnknown: Boolean(toolError.outcomeUnknown) }) }],
              isError: true
            };
          }
          break;
        }
        case 'resources/list':
          result = {
            resources: [
              {
                uri: 'celia://status',
                name: 'حالة خادم Celia MCP',
                description: 'ملخص جاهزية مزودي الذكاء والصوت والتصميم وGoogle وWhatsApp',
                mimeType: 'application/json'
              },
              {
                uri: 'celia://secrets/readiness',
                name: 'جاهزية أسرار المستودع التسعة (منقحة)',
                description: 'حالة تهيئة الأسرار التسعة وقواطع العزل دون كشف أي قيم سرية',
                mimeType: 'application/json'
              },
              {
                uri: 'celia://policy/customer-reply',
                name: 'سياسة الرد الآمن على العملاء',
                description: 'القواعد الإلزامية لتوليد الردود عبر Gemini أو AI Gateway أو DeepSeek أو AgentRouter أو Ollama',
                mimeType: 'text/plain'
              }
            ]
          };
          break;
        case 'resources/read': {
          const uri = String(params?.uri || '');
          if (uri === 'celia://status') {
            const status = await buildStatusSummary(pool, config, { probeOllama: true, services });
            result = { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(status, null, 2) }] };
          } else if (uri === 'celia://secrets/readiness') {
            const readiness = buildSecretsReadiness(config, services);
            result = { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(readiness, null, 2) }] };
          } else if (uri === 'celia://policy/customer-reply') {
            result = { contents: [{ uri, mimeType: 'text/plain', text: DEFAULT_POLICY }] };
          } else {
            return { jsonrpc: '2.0', id: id ?? null, error: { code: -32602, message: `Unknown resource URI: ${uri}` } };
          }
          break;
        }
        case 'prompts/list':
          result = {
            prompts: [
              {
                name: 'whatsapp_customer_reply',
                description: 'قالب صياغة رد خدمة عملاء متوافق مع السياسة',
                arguments: [
                  { name: 'customerMessage', description: 'رسالة العميل', required: true },
                  { name: 'businessContext', description: 'سياق النشاط المعتمد', required: false }
                ]
              }
            ]
          };
          break;
        case 'prompts/get': {
          if (params?.name !== 'whatsapp_customer_reply') {
            return { jsonrpc: '2.0', id: id ?? null, error: { code: -32602, message: 'Unknown prompt' } };
          }
          const msg = String(params?.arguments?.customerMessage || '').slice(0, 4000);
          const ctx = String(params?.arguments?.businessContext || config.gemini.businessContext || '').slice(0, 4000);
          result = {
            description: 'رد خدمة عملاء آمن وموجز',
            messages: [
              {
                role: 'user',
                content: {
                  type: 'text',
                  text: `${DEFAULT_POLICY}${ctx ? `\nسياق النشاط المعتمد: ${ctx}` : ''}\nرسالة العميل: ${msg}`
                }
              }
            ]
          };
          break;
        }
        default:
          return {
            jsonrpc: '2.0',
            id: id ?? null,
            error: { code: -32601, message: `Method not found: ${method}` }
          };
      }
      if (isNotification) return null;
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      if (isNotification) return null;
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code: error.code || -32603, message: safeError(error) }
      };
    }
  }

  return { handleRpcMessage, callTool };
}

function requireMcpToken(config) {
  return (req, res, next) => {
    const authHeader = req.get('authorization') || '';
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
    const candidate = (bearerMatch?.[1] || req.get('x-celia-token') || '').trim();
    if (!candidate || !safeEqual(candidate, config.celia.apiToken)) {
      return res.status(401).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: 'Unauthorized: valid CELIA_MCP_API_TOKEN required' }
      });
    }
    return next();
  };
}

export function createCeliaMcpApp({ pool, config, services = createServiceRegistry(config), agentHost, kbHost }) {
  const app = express();
  const idempotencyStore = createIdempotencyStore();
  const activeTools = getActiveMcpTools(config);
  const { handleRpcMessage } = createCeliaMcpHandler({ pool, config, services, idempotencyStore });
  const operations = createOperations({ pool, config, services, toolsCount: activeTools.length });
  const authorize = requireMcpToken(config);
  app.locals.services = services;
  app.locals.operations = operations;

  app.disable('x-powered-by');
  app.set('trust proxy', config.nodeEnv === 'production' ? 1 : false);
  app.use(
    helmet({
      frameguard: false,
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'font-src': ["'self'", 'data:'],
          'img-src': ["'self'", 'data:'],
          'media-src': ["'self'", 'data:', 'blob:'],
          'connect-src': [
            "'self'",
            'https://generativelanguage.googleapis.com',
            'https://api.groq.com',
            ...(config.edgeOrigin ? [config.edgeOrigin] : [])
          ],
          'frame-ancestors': ['*'],
          'upgrade-insecure-requests': null
        }
      }
    })
  );

  mountOperations(app, { operations, authorize });
  app.get('/api/deployment', async (_req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store').json(deploymentStatus({ config, snapshot: await operations.snapshot() }));
    } catch (error) { next(error); }
  });
  app.use(createSecretsHubRouter({ config, services, idempotencyStore, authorize }));
  const knowledge = kbHost || createKnowledgeHost({ nodeEnv: config.nodeEnv });
  const agents =
    agentHost ||
    createAgentHost({ config, pool, statusProvider: () => operations.liveness(), kbHost: knowledge });
  app.locals.kbHost = knowledge;
  app.locals.agentHost = agents;
  app.use('/api/kb', createKbRouter({ kb: knowledge, authorize }));
  app.use('/api/agent', createAgentRouter({ agent: agents, authorize }));
  if (config.hosting?.integrationsEnabled) {
    app.use(createIntegratedApiRouter({ pool, config: config.hosting.integrationConfig, services }));
  }
  app.get('/api/skills/find', async (req, res) => {
    const q = String(req.query.q || req.query.query || '').trim();
    const category = String(req.query.category || 'all').trim();
    try {
      const out = await createCeliaMcpHandler({ pool, config }).callTool('find_skills', { query: q, category, liveCheck: true });
      res.json(out);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.use(
    createCeliaUiRouter({
      createMcpHandler: createCeliaMcpHandler,
      buildStatusSummary,
      operations,
      config
    })
  );

  app.get('/mcp', authorize, (_req, res) => {
    res.json({
      service: SERVER_INFO.name,
      version: SERVER_INFO.version,
      protocolVersion: MCP_PROTOCOL_VERSION,
      transport: 'streamable-http',
      toolsCount: activeTools.length
    });
  });

  app.post('/mcp', authorize, express.json({ limit: '256kb' }), async (req, res) => {
    if (Array.isArray(req.body)) {
      if (req.body.length > 20) return res.status(413).json({ error: 'batch_limit_exceeded' });
      if (!req.body.length) {
        return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Empty batch' } });
      }
      const responses = (await Promise.all(req.body.map((item) => handleRpcMessage(item)))).filter(Boolean);
      if (!responses.length) return res.status(202).end();
      return res.json(responses);
    }
    const response = await handleRpcMessage(req.body);
    if (!response) return res.status(202).end();
    return res.json(response);
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((error, _req, res, _next) => {
    console.error('Unhandled Celia MCP error:', error.code || 'request_failed');
    res.status(error.status || 500).json({ error: 'internal_error' });
  });

  return app;
}

async function runStdioServer({ pool, config }) {
  const { handleRpcMessage } = createCeliaMcpHandler({ pool, config });
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      return;
    }
    const response = await handleRpcMessage(parsed);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}

export async function runSelfTest({ env: baseEnv = process.env, log = console.log } = {}) {
  const fallbackToken = crypto.randomBytes(32).toString('hex');
  const env = {
    ...baseEnv,
    CELIA_MCP_API_TOKEN:
      baseEnv.CELIA_MCP_API_TOKEN && !isPlaceholder(baseEnv.CELIA_MCP_API_TOKEN) && baseEnv.CELIA_MCP_API_TOKEN.length >= 32
        ? baseEnv.CELIA_MCP_API_TOKEN
        : fallbackToken
  };
  const config = loadCeliaMcpConfig(env, { requireToken: true });
  const pool = await connectPoolWithFallback(config);
  const app = createCeliaMcpApp({ pool, config });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const healthRes = await fetch(`${baseUrl}/health`);
    if (healthRes.status !== 200) throw new Error(`/health returned ${healthRes.status}`);

    const unauthRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    });
    if (unauthRes.status !== 401) throw new Error(`Expected 401 without token, got ${unauthRes.status}`);

    const rpc = async (id, method, params = {}) => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.celia.apiToken}`
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
      });
      if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
      return res.json();
    };

    const unauthSecrets = await fetch(`${baseUrl}/api/secrets/status`);
    if (unauthSecrets.status !== 401) throw new Error(`Expected 401 on /api/secrets/status without token, got ${unauthSecrets.status}`);

    const secretsRes = await fetch(`${baseUrl}/api/secrets/status`, {
      headers: { authorization: `Bearer ${config.celia.apiToken}` }
    });
    if (secretsRes.status !== 200) throw new Error(`/api/secrets/status returned ${secretsRes.status}`);
    const secretsReport = await secretsRes.json();

    const init = await rpc(1, 'initialize', { protocolVersion: MCP_PROTOCOL_VERSION });
    const list = await rpc(2, 'tools/list');
    const statusCall = await rpc(3, 'tools/call', { name: 'celia_status', arguments: { probeOllama: true } });
    const statusData = statusCall.result?.structuredContent;

    const anyCloudConfigured = Boolean(
      config.gemini.apiKey ||
      config.aiGateway?.apiKey ||
      config.deepseek?.apiKey ||
      config.agentrouter?.apiKey
    );
    let aiVerification = { tested: false, provider: null, note: 'لا يوجد مزود سحابي مفعّل للفحص الحي أو خادم Ollama نشط في هذه البيئة' };
    if (env.CELIA_VERIFY_SKIP_CLOUD !== 'true' && (anyCloudConfigured || statusData?.providers?.ollama?.reachable)) {
      const replyCall = await rpc(4, 'tools/call', {
        name: 'celia_ai_reply',
        arguments: {
          customerMessage: 'مرحبًا، ما هي مواعيد العمل وكيف يمكنني المتابعة؟',
          provider: 'auto'
        }
      });
      if (replyCall.result?.isError) {
        throw new Error(`celia_ai_reply failed: ${replyCall.result?.content?.[0]?.text}`);
      }
      const replyData = replyCall.result?.structuredContent;
      aiVerification = {
        tested: true,
        provider: replyData.provider,
        model: replyData.model
      };
    }

    log(
      JSON.stringify(
        {
          selfTest: 'passed',
          serverInfo: init.result?.serverInfo,
          toolsCount: list.result?.tools?.length,
          storage: statusData?.storage,
          effectiveAiProvider: statusData?.providers?.effectiveDefault,
          secretsConfiguredCount: secretsReport?.configuredCount,
          totalSecretsTracked: secretsReport?.totalSecretsTracked,
          geminiConfigured: statusData?.providers?.gemini?.configured,
          ollamaReachable: statusData?.providers?.ollama?.reachable,
          aiVerification
        },
        null,
        2
      )
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = new Set(process.argv.slice(2));
  if (args.has('--self-test')) {
    await runSelfTest();
  } else if (args.has('--stdio')) {
    const config = loadCeliaMcpConfig(process.env, { requireToken: false });
    const pool = await connectPoolWithFallback(config);
    await runStdioServer({ pool, config });
  } else {
    const config = loadCeliaMcpConfig(process.env, { requireToken: true });
    const pool = await connectPoolWithFallback(config);
    const app = createCeliaMcpApp({ pool, config });
    const readiness = buildSecretsReadiness(config);
    const server = app.listen(config.port, config.host, () => {
      console.log(
        `Celia MCP server listening on http://${config.host}:${server.address().port} (storage=${pool.isMemory ? 'memory' : 'mysql'}, ai=${resolveEffectiveAiProvider(config)}, secrets=${readiness.configuredCount}/${readiness.totalSecretsTracked})`
      );
    });
    installShutdown({ server, pool, operations: app.locals.operations });
    // A waking or redeployed process settles abandoned dispatches and resumes parked
    // runs only when CELIA_AGENT_RESUME_ON_BOOT=true; readiness is never delayed by it.
    scheduleBootRecovery({ agentHost: app.locals.agentHost, logger: console });
  }
}
