import { DEFAULT_POLICY } from './gemini.js';
import { UpstreamError } from './resilience.js';

const PLACEHOLDER_RE = /^replace-with-/i;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{2,128}$/;

function cleanSecret(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed || PLACEHOLDER_RE.test(trimmed)) return '';
  return trimmed;
}

function isDisallowedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
    return true;
  }
  const match172 = /^172\.(\d{1,3})\./.exec(host);
  if (match172) {
    const second = Number(match172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

export function normalizeHttpsApiUrl(rawUrl, defaultUrl, envName = 'API_BASE_URL') {
  const candidate = String(rawUrl || '').trim() || defaultUrl;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${envName} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${envName} must use https`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${envName} must not contain credentials, query parameters, or fragments`);
  }
  if (isDisallowedHost(parsed.hostname)) {
    throw new Error(`${envName} must point to a public HTTPS host`);
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${cleanPath}`;
}

export function loadExtendedIntegrationsConfig(env = process.env) {
  const aiGatewayKey = cleanSecret(env.AI_GATEWAY_API_KEY);
  const deepseekKey = cleanSecret(env.DEEPSEEK_API_KEY);

  const agentrouterExact = cleanSecret(env.AGENETROUTERAPI_KEY);
  const agentrouterCanonical = cleanSecret(env.AGENTROUTER_API_KEY);
  const agentrouterKey = agentrouterExact || agentrouterCanonical;
  const agentrouterSourceEnv = agentrouterExact
    ? 'AGENETROUTERAPI_KEY'
    : agentrouterCanonical
      ? 'AGENTROUTER_API_KEY'
      : null;

  const elevenlabsKey = cleanSecret(env.ELEVENLABS_API_KEY);
  const rawCeliaVoice = cleanSecret(env.CELIA_VOICE_ID);
  const rawElevenVoice = cleanSecret(env.ELEVENLABS_VOICE_ID);
  const chosenVoice = rawCeliaVoice || rawElevenVoice;
  const voiceIdValid = chosenVoice ? SAFE_ID_RE.test(chosenVoice) : true;
  const voiceId = chosenVoice && voiceIdValid ? chosenVoice : '';
  const voiceSourceEnv = rawCeliaVoice
    ? 'CELIA_VOICE_ID'
    : rawElevenVoice
      ? 'ELEVENLABS_VOICE_ID'
      : null;

  const figmaToken = cleanSecret(env.FIGMA_ACCESS_TOKEN);

  const codataExact = cleanSecret(env.YOUR_CODATA_API_KEY);
  const codataCanonical = cleanSecret(env.CODATA_API_KEY);
  const codataKey = codataExact || codataCanonical;
  const codataSourceEnv = codataExact
    ? 'YOUR_CODATA_API_KEY'
    : codataCanonical
      ? 'CODATA_API_KEY'
      : null;

  const rawWorkspace = String(env.CODATA_WORKSPACE_ID || '6ae05ac477ceef820d0c5831').trim();
  const codataWorkspaceId = SAFE_ID_RE.test(rawWorkspace) ? rawWorkspace : '';
  const rawCodataBase = String(env.CODATA_BASE_URL || '').trim();
  const codataBaseUrl = rawCodataBase
    ? normalizeHttpsApiUrl(rawCodataBase, 'https://api.codata.io/v1', 'CODATA_BASE_URL')
    : '';

  const cronjobExact = cleanSecret(env.CELIAOS_CRONJOB_ORG_API_KEY);
  const cronjobAlias = cleanSecret(env.CRONJOB_API_KEY);
  const cronjobApiKey = cronjobExact || cronjobAlias;
  const cronjobSourceEnv = cronjobExact
    ? 'CELIAOS_CRONJOB_ORG_API_KEY'
    : cronjobAlias
      ? 'CRONJOB_API_KEY'
      : null;

  const cloudflareAccountId = cleanSecret(env.CLOUDFLARE_ACCOUNT_ID);
  const cloudflareApiToken = cleanSecret(env.CLOUDFLARE_API_TOKEN);

  const r2AccessKeyId = cleanSecret(env.CLOUDFLARE_R2_ACCESS_KEY_ID);
  const r2SecretAccessKey = cleanSecret(env.CLOUDFLARE_R2_SECRET_ACCESS_KEY);
  const rawR2Endpoint = cleanSecret(env.CLOUDFLARE_R2_S3_ENDPOINT);
  let r2Endpoint = '';
  let r2EndpointFormatValid = true;
  if (rawR2Endpoint) {
    try {
      const candidate =
        rawR2Endpoint.startsWith('http://') || rawR2Endpoint.startsWith('https://')
          ? rawR2Endpoint
          : `https://${rawR2Endpoint}`;
      r2Endpoint = normalizeHttpsApiUrl(candidate, candidate, 'CLOUDFLARE_R2_S3_ENDPOINT');
    } catch {
      r2Endpoint = '';
      r2EndpointFormatValid = false;
    }
  }

  return Object.freeze({
    allowCloudFailover: env.CELIA_AI_ALLOW_CLOUD_FAILOVER === 'true',
    extendedMcpTools: env.CELIA_EXTENDED_MCP_TOOLS === 'true',
    aiGateway: Object.freeze({
      apiKey: aiGatewayKey,
      baseUrl: normalizeHttpsApiUrl(env.AI_GATEWAY_BASE_URL, 'https://ai-gateway.vercel.sh/v1', 'AI_GATEWAY_BASE_URL'),
      model: (env.AI_GATEWAY_MODEL || 'google/gemini-2.5-flash').trim() || 'google/gemini-2.5-flash'
    }),
    deepseek: Object.freeze({
      apiKey: deepseekKey,
      baseUrl: normalizeHttpsApiUrl(env.DEEPSEEK_BASE_URL, 'https://api.deepseek.com', 'DEEPSEEK_BASE_URL'),
      model: (env.DEEPSEEK_MODEL || 'deepseek-chat').trim() || 'deepseek-chat'
    }),
    agentrouter: Object.freeze({
      apiKey: agentrouterKey,
      sourceEnv: agentrouterSourceEnv,
      baseUrl: normalizeHttpsApiUrl(env.AGENTROUTER_BASE_URL, 'https://agentrouter.org/v1', 'AGENTROUTER_BASE_URL'),
      model: (env.AGENTROUTER_MODEL || 'deepseek-chat').trim() || 'deepseek-chat'
    }),
    elevenlabs: Object.freeze({
      apiKey: elevenlabsKey,
      voiceId,
      voiceIdFormatValid: voiceIdValid,
      voiceSourceEnv,
      baseUrl: normalizeHttpsApiUrl(env.ELEVENLABS_BASE_URL, 'https://api.elevenlabs.io/v1', 'ELEVENLABS_BASE_URL'),
      model: (env.ELEVENLABS_MODEL || 'eleven_multilingual_v2').trim() || 'eleven_multilingual_v2'
    }),
    figma: Object.freeze({
      accessToken: figmaToken,
      baseUrl: normalizeHttpsApiUrl(env.FIGMA_BASE_URL, 'https://api.figma.com/v1', 'FIGMA_BASE_URL')
    }),
    codata: Object.freeze({
      apiKey: codataKey,
      sourceEnv: codataSourceEnv,
      workspaceId: codataWorkspaceId,
      baseUrl: codataBaseUrl
    }),
    cronjob: Object.freeze({
      apiKey: cronjobApiKey,
      sourceEnv: cronjobSourceEnv,
      baseUrl: normalizeHttpsApiUrl(env.CRONJOB_BASE_URL, 'https://api.cron-job.org', 'CRONJOB_BASE_URL')
    }),
    cloudflare: Object.freeze({
      accountId: cloudflareAccountId,
      apiToken: cloudflareApiToken,
      baseUrl: normalizeHttpsApiUrl(env.CLOUDFLARE_API_BASE_URL, 'https://api.cloudflare.com/client/v4', 'CLOUDFLARE_API_BASE_URL')
    }),
    cloudflareR2: Object.freeze({
      accessKeyId: r2AccessKeyId,
      secretAccessKey: r2SecretAccessKey,
      s3Endpoint: r2Endpoint,
      rawEndpointConfigured: Boolean(rawR2Endpoint),
      endpointFormatValid: r2EndpointFormatValid
    })
  });
}

export async function generateOpenAiCompatibleReply({
  serviceName,
  baseUrl,
  apiKey,
  model,
  businessContext = '',
  customerMessage,
  timeoutMs = 20_000,
  signal
}) {
  if (!apiKey) throw new Error(`${serviceName} API is not configured`);
  if (typeof customerMessage !== 'string' || !customerMessage.trim()) {
    throw new Error('customerMessage is required');
  }
  const cleanBase = normalizeHttpsApiUrl(baseUrl, baseUrl, `${serviceName.toUpperCase()}_BASE_URL`);
  const endpoint = `${cleanBase}/chat/completions`;
  const systemText = `${DEFAULT_POLICY}${businessContext ? ` سياق النشاط المعتمد: ${String(businessContext).slice(0, 4000)}` : ''}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 180,
      stream: false,
      messages: [
        { role: 'system', content: systemText },
        { role: 'user', content: String(customerMessage).slice(0, 4000) }
      ]
    })
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new UpstreamError(serviceName, response.status);
  const content = result?.choices?.[0]?.message?.content;
  const text = (Array.isArray(content)
    ? content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('')
    : String(content || '')
  ).trim();
  if (!text) throw new Error(`${serviceName} returned no usable reply`);
  return text.slice(0, 1000);
}
