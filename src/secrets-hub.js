import express from 'express';
import { createIdempotencyStore, isValidIdempotencyKey } from './idempotency.js';
import { generateCeliaReply } from './ollama.js';
import { createServiceRegistry, safeError, ServiceUnavailableError, UpstreamError } from './resilience.js';

const FIGMA_FILE_KEY_RE = /^[A-Za-z0-9_-]{5,128}$/;
const MAX_VOICE_TEXT_LENGTH = 1000;
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

const UNWIRED_KNOWN_ENV_KEYS = Object.freeze([
  'CELIAOS_CRONJOB_ORG_API_KEY',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_R2_ACCESS_KEY_ID',
  'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_R2_S3_ENDPOINT'
]);

export function inspectUnwiredEnvironmentVariables(env = process.env) {
  const presentUnwired = UNWIRED_KNOWN_ENV_KEYS.filter(
    (name) => typeof env?.[name] === 'string' && env[name].trim().length > 0
  );
  const phoneAliasUsed =
    !String(env?.APP_OWNER_PHONE_E164 || '').trim() &&
    Boolean(String(env?.PHONE_NUMBER || '').trim());
  return {
    presentUnwiredNames: presentUnwired,
    phoneAliasUsed,
    noteAr:
      presentUnwired.length > 0
        ? `المتغيرات (${presentUnwired.join(', ')}) موجودة في البيئة لكن لا يوجد لها موصل مفعّل في الكود الحالي؛ لا تُقرأ ولا تُسرب.`
        : 'لا توجد متغيرات إضافية غير موصولة في البيئة الحالية.'
  };
}

export function buildSecretsReadiness(config = {}, services = null) {
  const circuits = new Map((services?.snapshot?.() || []).map((c) => [c.name, c.state]));
  const stateOf = (boundary) => circuits.get(boundary) || (config.features?.[boundary] === false ? 'disabled' : 'closed');
  const ownerTokenConfigured = Boolean(config.celia?.apiToken || config.apiToken);

  const secrets = [
    {
      secretName: 'AGENETROUTERAPI_KEY',
      aliases: ['AGENTROUTER_API_KEY'],
      configured: Boolean(config.agentrouter?.apiKey),
      sourceEnv: config.agentrouter?.sourceEnv || null,
      role: 'ai-provider',
      boundary: 'agentrouter',
      enabled: config.features?.agentrouter !== false,
      circuitState: stateOf('agentrouter'),
      model: config.agentrouter?.model || 'deepseek-chat'
    },
    {
      secretName: 'AI_GATEWAY_API_KEY',
      aliases: [],
      configured: Boolean(config.aiGateway?.apiKey),
      sourceEnv: config.aiGateway?.apiKey ? 'AI_GATEWAY_API_KEY' : null,
      role: 'ai-provider',
      boundary: 'ai_gateway',
      enabled: config.features?.ai_gateway !== false,
      circuitState: stateOf('ai_gateway'),
      model: config.aiGateway?.model || 'google/gemini-2.5-flash'
    },
    {
      secretName: 'CELIAOS_CRONJOB_ORG_API_KEY',
      aliases: ['CRONJOB_API_KEY'],
      configured: Boolean(config.cronjob?.apiKey),
      sourceEnv: config.cronjob?.sourceEnv || null,
      role: 'scheduler-api',
      boundary: 'cronjob',
      enabled: config.features?.cronjob !== false,
      circuitState: stateOf('cronjob')
    },
    {
      secretName: 'CELIA_MCP_API_TOKEN',
      aliases: ['APP_API_TOKEN'],
      configured: ownerTokenConfigured,
      sourceEnv: config.celia?.apiToken ? 'CELIA_MCP_API_TOKEN' : config.apiToken ? 'APP_API_TOKEN' : null,
      role: 'owner-auth',
      boundary: 'core',
      enabled: true,
      circuitState: 'closed'
    },
    {
      secretName: 'CELIA_VOICE_ID',
      aliases: ['ELEVENLABS_VOICE_ID'],
      configured: Boolean(config.elevenlabs?.voiceId),
      formatValid: config.elevenlabs?.voiceIdFormatValid !== false,
      sourceEnv: config.elevenlabs?.voiceId ? (config.elevenlabs?.voiceSourceEnv || 'CELIA_VOICE_ID') : null,
      role: 'voice-identity',
      boundary: 'elevenlabs',
      enabled: config.features?.elevenlabs !== false,
      readyForSynthesis: Boolean(
        config.elevenlabs?.apiKey &&
        config.elevenlabs?.voiceId &&
        config.features?.elevenlabs !== false
      )
    },
    {
      secretName: 'CLOUDFLARE_ACCOUNT_ID',
      aliases: [],
      configured: Boolean(config.cloudflare?.accountId),
      sourceEnv: config.cloudflare?.accountId ? 'CLOUDFLARE_ACCOUNT_ID' : null,
      role: 'edge-account',
      boundary: 'cloudflare',
      enabled: config.features?.cloudflare !== false,
      circuitState: stateOf('cloudflare')
    },
    {
      secretName: 'CLOUDFLARE_API_TOKEN',
      aliases: [],
      configured: Boolean(config.cloudflare?.apiToken),
      sourceEnv: config.cloudflare?.apiToken ? 'CLOUDFLARE_API_TOKEN' : null,
      role: 'edge-deploy-token',
      boundary: 'cloudflare',
      enabled: config.features?.cloudflare !== false,
      circuitState: stateOf('cloudflare')
    },
    {
      secretName: 'CLOUDFLARE_R2_ACCESS_KEY_ID',
      aliases: [],
      configured: Boolean(config.cloudflareR2?.accessKeyId),
      sourceEnv: config.cloudflareR2?.accessKeyId ? 'CLOUDFLARE_R2_ACCESS_KEY_ID' : null,
      role: 'object-storage-key',
      boundary: 'cloudflare_r2',
      enabled: config.features?.cloudflare_r2 !== false,
      circuitState: stateOf('cloudflare_r2')
    },
    {
      secretName: 'CLOUDFLARE_R2_S3_ENDPOINT',
      aliases: [],
      configured: Boolean(config.cloudflareR2?.s3Endpoint || config.cloudflareR2?.rawEndpointConfigured),
      formatValid: config.cloudflareR2?.endpointFormatValid !== false,
      sourceEnv:
        config.cloudflareR2?.s3Endpoint || config.cloudflareR2?.rawEndpointConfigured
          ? 'CLOUDFLARE_R2_S3_ENDPOINT'
          : null,
      role: 'object-storage-endpoint',
      boundary: 'cloudflare_r2',
      enabled: config.features?.cloudflare_r2 !== false,
      circuitState: stateOf('cloudflare_r2')
    },
    {
      secretName: 'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
      aliases: [],
      configured: Boolean(config.cloudflareR2?.secretAccessKey),
      sourceEnv: config.cloudflareR2?.secretAccessKey ? 'CLOUDFLARE_R2_SECRET_ACCESS_KEY' : null,
      role: 'object-storage-secret',
      boundary: 'cloudflare_r2',
      enabled: config.features?.cloudflare_r2 !== false,
      circuitState: stateOf('cloudflare_r2')
    },
    {
      secretName: 'DEEPSEEK_API_KEY',
      aliases: [],
      configured: Boolean(config.deepseek?.apiKey),
      sourceEnv: config.deepseek?.apiKey ? 'DEEPSEEK_API_KEY' : null,
      role: 'ai-provider',
      boundary: 'deepseek',
      enabled: config.features?.deepseek !== false,
      circuitState: stateOf('deepseek'),
      model: config.deepseek?.model || 'deepseek-flash'
    },
    {
      secretName: 'ELEVENLABS_API_KEY',
      aliases: [],
      configured: Boolean(config.elevenlabs?.apiKey),
      sourceEnv: config.elevenlabs?.apiKey ? 'ELEVENLABS_API_KEY' : null,
      role: 'voice-tts',
      boundary: 'elevenlabs',
      enabled: config.features?.elevenlabs !== false,
      circuitState: stateOf('elevenlabs'),
      model: config.elevenlabs?.model || 'eleven_multilingual_v2',
      pairedWithVoiceId: Boolean(config.elevenlabs?.apiKey && config.elevenlabs?.voiceId)
    },
    {
      secretName: 'FIGMA_ACCESS_TOKEN',
      aliases: [],
      configured: Boolean(config.figma?.accessToken),
      sourceEnv: config.figma?.accessToken ? 'FIGMA_ACCESS_TOKEN' : null,
      role: 'design-readonly',
      boundary: 'figma',
      enabled: config.features?.figma !== false,
      circuitState: stateOf('figma')
    },
    {
      secretName: 'GEMINI_API_KEY',
      aliases: [],
      configured: Boolean(config.gemini?.apiKey),
      sourceEnv: config.gemini?.apiKey ? 'GEMINI_API_KEY' : null,
      role: 'ai-provider',
      boundary: 'gemini',
      enabled: config.features?.gemini !== false,
      circuitState: stateOf('gemini'),
      model: config.gemini?.model || 'gemini-2.5-flash'
    },
    {
      secretName: 'GOOGLE_CLIENT_ID',
      aliases: [],
      configured: Boolean(config.google?.clientId),
      sourceEnv: config.google?.clientId ? 'GOOGLE_CLIENT_ID' : null,
      role: 'oauth-client-id',
      boundary: 'google',
      enabled: config.features?.google !== false,
      circuitState: stateOf('google.oauth')
    },
    {
      secretName: 'GOOGLE_CLIENT_SECRET',
      aliases: [],
      configured: Boolean(config.google?.clientSecret),
      sourceEnv: config.google?.clientSecret ? 'GOOGLE_CLIENT_SECRET' : null,
      role: 'oauth-client-secret',
      boundary: 'google',
      enabled: config.features?.google !== false,
      circuitState: stateOf('google.oauth')
    },
    {
      secretName: 'PHONE_NUMBER',
      aliases: ['APP_OWNER_PHONE_E164'],
      configured: Boolean(config.ownerPhone),
      sourceEnv: config.ownerPhoneSourceEnv || (config.ownerPhone ? 'APP_OWNER_PHONE_E164' : null),
      role: 'owner-phone',
      boundary: 'whatsapp',
      enabled: config.features?.whatsapp !== false,
      circuitState: stateOf('whatsapp')
    },
    {
      secretName: 'YOUR_CODATA_API_KEY',
      aliases: ['CODATA_API_KEY'],
      configured: Boolean(config.codata?.apiKey),
      sourceEnv: config.codata?.sourceEnv || null,
      role: 'workspace-connector',
      boundary: 'codata',
      enabled: config.features?.codata !== false,
      circuitState: stateOf('codata'),
      liveProbeConfigured: Boolean(config.codata?.baseUrl),
      automaticMigrationAllowed: false
    }
  ];

  const configuredCount = secrets.filter((item) => item.configured).length;
  return {
    totalSecretsTracked: secrets.length,
    configuredCount,
    allConfigured: configuredCount === secrets.length,
    secrets,
    notice:
      'Sanitized readiness only: secret values are never exposed or logged, and configuration is not proof of live external connectivity.'
  };
}

export async function synthesizeCeliaSpeech({
  config,
  text,
  modelId,
  stability = 0.5,
  similarityBoost = 0.75,
  timeoutMs = 15_000,
  signal
}) {
  const el = config?.elevenlabs;
  if (!el?.apiKey) throw Object.assign(new Error('elevenlabs_not_configured'), { status: 400 });
  if (!el?.voiceId) throw Object.assign(new Error('voice_id_not_configured'), { status: 400 });
  const cleanText = typeof text === 'string' ? text.trim() : '';
  if (!cleanText || cleanText.length > MAX_VOICE_TEXT_LENGTH) {
    throw Object.assign(new Error('voice_text_required'), { status: 400 });
  }
  const model = (typeof modelId === 'string' && modelId.trim() ? modelId.trim() : el.model || 'eleven_multilingual_v2').slice(0, 64);
  const clampedStability = Math.max(0, Math.min(1, Number.isFinite(Number(stability)) ? Number(stability) : 0.5));
  const clampedSimilarity = Math.max(0, Math.min(1, Number.isFinite(Number(similarityBoost)) ? Number(similarityBoost) : 0.75));
  const endpoint = `${el.baseUrl}/text-to-speech/${encodeURIComponent(el.voiceId)}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'audio/mpeg',
      'xi-api-key': el.apiKey
    },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      text: cleanText,
      model_id: model,
      voice_settings: {
        stability: clampedStability,
        similarity_boost: clampedSimilarity
      }
    })
  });

  if (!response.ok) throw new UpstreamError('elevenlabs', response.status);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > MAX_AUDIO_BYTES) {
    throw new Error('ElevenLabs returned invalid audio payload size');
  }
  return {
    status: 'synthesized',
    provider: 'elevenlabs',
    model,
    mimeType: 'audio/mpeg',
    bytesLength: bytes.byteLength,
    audioBase64: Buffer.from(bytes).toString('base64')
  };
}

export async function probeCeliaVoice({ config, timeoutMs = 8000, signal }) {
  const el = config?.elevenlabs;
  if (!el?.apiKey) throw Object.assign(new Error('elevenlabs_not_configured'), { status: 400 });
  if (!el?.voiceId) throw Object.assign(new Error('voice_id_not_configured'), { status: 400 });
  const endpoint = `${el.baseUrl}/voices/${encodeURIComponent(el.voiceId)}`;
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: { accept: 'application/json', 'xi-api-key': el.apiKey },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new UpstreamError('elevenlabs', response.status);
  const data = await response.json().catch(() => ({}));
  return {
    reachable: true,
    name: String(data.name || ''),
    category: String(data.category || ''),
    model: el.model || 'eleven_multilingual_v2'
  };
}

export async function fetchFigmaProfile({ config, timeoutMs = 8000, signal }) {
  const figma = config?.figma;
  if (!figma?.accessToken) throw Object.assign(new Error('figma_not_configured'), { status: 400 });
  const response = await fetch(`${figma.baseUrl}/me`, {
    method: 'GET',
    headers: { accept: 'application/json', 'X-Figma-Token': figma.accessToken },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new UpstreamError('figma', response.status);
  const data = await response.json().catch(() => ({}));
  return {
    id: String(data.id || ''),
    handle: String(data.handle || '')
  };
}

export async function inspectFigmaFile({ config, fileKey, depth = 1, timeoutMs = 10_000, signal }) {
  const figma = config?.figma;
  if (!figma?.accessToken) throw Object.assign(new Error('figma_not_configured'), { status: 400 });
  const cleanKey = String(fileKey || '').trim();
  if (!FIGMA_FILE_KEY_RE.test(cleanKey)) {
    throw Object.assign(new Error('invalid_figma_file_key'), { status: 400 });
  }
  const boundedDepth = Math.max(1, Math.min(3, Number.parseInt(String(depth), 10) || 1));
  const endpoint = `${figma.baseUrl}/files/${encodeURIComponent(cleanKey)}?depth=${boundedDepth}`;
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: { accept: 'application/json', 'X-Figma-Token': figma.accessToken },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new UpstreamError('figma', response.status);
  const data = await response.json().catch(() => ({}));
  const pages = Array.isArray(data.document?.children)
    ? data.document.children.slice(0, 50).map((page) => ({
        id: String(page.id || ''),
        name: String(page.name || ''),
        type: String(page.type || ''),
        childCount: Array.isArray(page.children) ? page.children.length : 0
      }))
    : [];
  return {
    fileKey: cleanKey,
    name: String(data.name || ''),
    lastModified: String(data.lastModified || ''),
    version: String(data.version || ''),
    role: String(data.role || ''),
    pages,
    componentsCount: data.components && typeof data.components === 'object' ? Object.keys(data.components).length : 0,
    stylesCount: data.styles && typeof data.styles === 'object' ? Object.keys(data.styles).length : 0
  };
}

export async function getCodataStatus({ config, probe = false, services, timeoutMs = 8000 }) {
  const codata = config?.codata;
  const baseReport = {
    configured: Boolean(codata?.apiKey),
    sourceEnv: codata?.sourceEnv || null,
    workspaceConfigured: Boolean(codata?.workspaceId),
    liveProbeConfigured: Boolean(codata?.baseUrl),
    mode: 'read-only',
    primaryTransactionalStore: false,
    automaticMigrationAllowed: false,
    policy: 'read-only-until-owner-migration-approval'
  };
  if (!probe) return baseReport;
  if (!codata?.apiKey) throw Object.assign(new Error('codata_not_configured'), { status: 400 });
  if (!codata?.baseUrl) throw Object.assign(new Error('codata_base_url_not_configured'), { status: 400 });

  const runProbe = async (signal) => {
    const endpoint = `${codata.baseUrl}/workspaces/${encodeURIComponent(codata.workspaceId || 'default')}`;
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${codata.apiKey}`
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new UpstreamError('codata', response.status);
    const data = await response.json().catch(() => ({}));
    return {
      ...baseReport,
      reachable: true,
      workspaceName: String(data.name || data.title || '')
    };
  };

  return services ? services.run('codata', runProbe) : runProbe();
}

export async function getCronjobStatus({ config, probe = false, services, timeoutMs = 8000 }) {
  const cronjob = config?.cronjob;
  const baseReport = {
    configured: Boolean(cronjob?.apiKey),
    sourceEnv: cronjob?.sourceEnv || null,
    baseUrl: cronjob?.baseUrl || 'https://api.cron-job.org',
    enabled: config?.features?.cronjob !== false,
    mode: 'governed-scheduler'
  };
  if (!probe) return baseReport;
  if (!cronjob?.apiKey) throw Object.assign(new Error('cronjob_not_configured'), { status: 400 });

  const runProbe = async (signal) => {
    const endpoint = `${cronjob.baseUrl}/jobs`;
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${cronjob.apiKey}`
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new UpstreamError('cronjob', response.status);
    const data = await response.json().catch(() => ({}));
    return {
      ...baseReport,
      reachable: true,
      jobsCount: Array.isArray(data.jobs) ? data.jobs.length : 0
    };
  };

  return services ? services.run('cronjob', runProbe) : runProbe();
}

export function getCloudflareR2Status({ config }) {
  const cf = config?.cloudflare;
  const r2 = config?.cloudflareR2;
  return {
    configured: Boolean(r2?.accessKeyId && r2?.secretAccessKey && r2?.s3Endpoint),
    accessKeyConfigured: Boolean(r2?.accessKeyId),
    secretKeyConfigured: Boolean(r2?.secretAccessKey),
    endpointConfigured: Boolean(r2?.s3Endpoint || r2?.rawEndpointConfigured),
    endpointFormatValid: r2?.endpointFormatValid !== false,
    cloudflareAccountConfigured: Boolean(cf?.accountId),
    cloudflareTokenConfigured: Boolean(cf?.apiToken),
    enabled: config?.features?.cloudflare_r2 !== false
  };
}

function sendHubError(res, error) {
  if (error instanceof ServiceUnavailableError) {
    return res.status(503).json({ error: safeError(error), outcomeUnknown: Boolean(error.outcomeUnknown) });
  }
  if (error instanceof UpstreamError) {
    return res.status(502).json({ error: safeError(error) });
  }
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 400;
  return res.status(status).json({ error: safeError(error) });
}

export function createSecretsHubRouter({
  config,
  services = createServiceRegistry(config),
  idempotencyStore = createIdempotencyStore(),
  authorize
}) {
  const router = express.Router();
  const jsonParser = express.json({ limit: '128kb' });
  const ensureJson = (req, res, next) => (req.body !== undefined ? next() : jsonParser(req, res, next));
  const hubPaths = ['/api/secrets', '/api/ai', '/api/voice', '/api/figma', '/api/codata', '/api/cron', '/api/storage'];

  router.use(hubPaths, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    return authorize(req, res, next);
  });

  router.get('/api/secrets/status', (_req, res) => {
    res.json(buildSecretsReadiness(config, services));
  });

  router.post('/api/ai/reply', ensureJson, async (req, res) => {
    try {
      const customerMessage = String(req.body?.customerMessage || '').trim();
      if (!customerMessage) return res.status(400).json({ error: 'customerMessage is required' });
      const replyResult = await generateCeliaReply({
        config,
        services,
        customerMessage,
        provider: req.body?.provider || config.celia?.aiProvider || 'auto',
        businessContext: typeof req.body?.businessContext === 'string' ? req.body.businessContext : undefined
      });

      if (req.body?.withVoice === true && config.elevenlabs?.apiKey && config.elevenlabs?.voiceId && config.features?.elevenlabs !== false) {
        try {
          const voice = await services.run('elevenlabs', (signal) =>
            synthesizeCeliaSpeech({ config, text: replyResult.reply, signal })
          );
          return res.json({ ...replyResult, voice });
        } catch (voiceError) {
          return res.json({ ...replyResult, voice: { status: 'degraded', error: safeError(voiceError) } });
        }
      }
      return res.json(replyResult);
    } catch (error) {
      return sendHubError(res, error);
    }
  });

  router.get('/api/voice/status', async (req, res) => {
    const base = {
      configured: Boolean(config.elevenlabs?.apiKey && config.elevenlabs?.voiceId),
      apiKeyConfigured: Boolean(config.elevenlabs?.apiKey),
      voiceIdConfigured: Boolean(config.elevenlabs?.voiceId),
      voiceIdFormatValid: config.elevenlabs?.voiceIdFormatValid !== false,
      enabled: config.features?.elevenlabs !== false,
      model: config.elevenlabs?.model || 'eleven_multilingual_v2'
    };
    if (req.query.probe !== 'true') return res.json(base);
    try {
      const probe = await services.run('elevenlabs', (signal) => probeCeliaVoice({ config, signal }));
      return res.json({ ...base, probe });
    } catch (error) {
      return sendHubError(res, error);
    }
  });

  router.post('/api/voice/speak', ensureJson, async (req, res) => {
    const headerKey = req.get('Idempotency-Key') || req.get('idempotency-key') || '';
    const bodyKey = typeof req.body?.idempotencyKey === 'string'
      ? req.body.idempotencyKey
      : typeof req.body?.idempotency_key === 'string'
        ? req.body.idempotency_key
        : '';
    const idempotencyKey = isValidIdempotencyKey(headerKey) ? headerKey : (isValidIdempotencyKey(bodyKey) ? bodyKey : null);

    if (idempotencyKey) {
      const cached = idempotencyStore.get(idempotencyKey);
      if (cached) {
        if (cached._idempotencyStatus === 'in_progress') return res.status(409).json({ error: 'idempotency_conflict_in_progress' });
        if (req.body?.format === 'mp3' || req.accepts(['json', 'audio/mpeg']) === 'audio/mpeg') {
          return res.type('audio/mpeg').send(Buffer.from(cached.audioBase64, 'base64'));
        }
        return res.status(200).json({ ...cached, _idempotencyReplay: true });
      }
      if (!idempotencyStore.claim(idempotencyKey)) {
        const again = idempotencyStore.get(idempotencyKey);
        if (again?._idempotencyStatus === 'in_progress') return res.status(409).json({ error: 'idempotency_conflict_in_progress' });
        if (again) return res.status(200).json({ ...again, _idempotencyReplay: true });
      }
    }

    try {
      const synthesized = await services.run(
        'elevenlabs',
        (signal) =>
          synthesizeCeliaSpeech({
            config,
            text: req.body?.text,
            modelId: req.body?.modelId,
            stability: req.body?.stability,
            similarityBoost: req.body?.similarityBoost,
            signal
          }),
        { sideEffect: true }
      );
      if (idempotencyKey) idempotencyStore.complete(idempotencyKey, synthesized);
      if (req.body?.format === 'mp3' || req.accepts(['json', 'audio/mpeg']) === 'audio/mpeg') {
        return res.type('audio/mpeg').send(Buffer.from(synthesized.audioBase64, 'base64'));
      }
      return res.json(synthesized);
    } catch (error) {
      if (idempotencyKey) idempotencyStore.fail(idempotencyKey);
      return sendHubError(res, error);
    }
  });

  router.get('/api/figma/status', (_req, res) => {
    res.json({
      configured: Boolean(config.figma?.accessToken),
      enabled: config.features?.figma !== false,
      mode: 'read-only'
    });
  });

  router.get('/api/figma/me', async (_req, res) => {
    try {
      const profile = await services.run('figma', (signal) => fetchFigmaProfile({ config, signal }));
      return res.json(profile);
    } catch (error) {
      return sendHubError(res, error);
    }
  });

  router.get(['/api/figma/files/:fileKey', '/api/figma/file/:fileKey'], async (req, res) => {
    try {
      const summary = await services.run('figma', (signal) =>
        inspectFigmaFile({
          config,
          fileKey: req.params.fileKey,
          depth: req.query.depth,
          signal
        })
      );
      return res.json(summary);
    } catch (error) {
      return sendHubError(res, error);
    }
  });

  router.get('/api/codata/status', async (req, res) => {
    try {
      const report = await getCodataStatus({
        config,
        probe: req.query.probe === 'true',
        services
      });
      return res.json(report);
    } catch (error) {
      return sendHubError(res, error);
    }
  });

  router.post('/api/codata/probe', ensureJson, async (_req, res) => {
    try {
      const report = await getCodataStatus({ config, probe: true, services });
      return res.json(report);
    } catch (error) {
      return sendHubError(res, error);
    }
  });

  router.get('/api/cron/status', async (req, res) => {
    try {
      const report = await getCronjobStatus({
        config,
        probe: req.query.probe === 'true',
        services
      });
      return res.json(report);
    } catch (error) {
      return sendHubError(res, error);
    }
  });

  router.post('/api/cron/probe', ensureJson, async (_req, res) => {
    try {
      const report = await getCronjobStatus({ config, probe: true, services });
      return res.json(report);
    } catch (error) {
      return sendHubError(res, error);
    }
  });

  router.get('/api/storage/r2/status', (_req, res) => {
    return res.json(getCloudflareR2Status({ config }));
  });

  return router;
}
