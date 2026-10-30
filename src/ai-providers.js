import { DEFAULT_POLICY } from './gemini.js';
import { buildContext } from './context-policy.js';
import { UpstreamError } from './resilience.js';

const PLACEHOLDER_RE = /^replace-with-/i;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{2,128}$/;

function cleanSecret(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed || PLACEHOLDER_RE.test(trimmed)) return '';
  return trimmed;
}

function isDisallowedIpv4(octets) {
  if (!Array.isArray(octets) || octets.length !== 4) return true;
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function parseIpv6Words(input) {
  let addr = input;
  let tailWords = [];
  const lastColon = addr.lastIndexOf(':');
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes('.')) {
    const v4Part = addr.slice(lastColon + 1);
    const v4Match = v4Part.match(/^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/);
    if (!v4Match) return null;
    const octets = v4Match.slice(1).map(Number);
    if (octets.some((n) => n < 0 || n > 255)) return null;
    tailWords = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    addr = addr.slice(0, lastColon);
    if (addr.endsWith(':')) addr += '0';
  }

  const dblParts = addr.split('::');
  if (dblParts.length > 2) return null;
  const parseSide = (side) => {
    if (!side) return [];
    const groups = side.split(':');
    const out = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };

  const targetGroups = 8 - tailWords.length;
  if (dblParts.length === 2) {
    const left = parseSide(dblParts[0]);
    const right = parseSide(dblParts[1]);
    if (!left || !right || left.length + right.length >= targetGroups) return null;
    const zeros = new Array(targetGroups - left.length - right.length).fill(0);
    return [...left, ...zeros, ...right, ...tailWords];
  }

  const full = parseSide(addr);
  if (!full || full.length !== targetGroups) return null;
  return [...full, ...tailWords];
}

function isDisallowedIpv6(rawIpv6, { allowPrivateLan = false } = {}) {
  if (rawIpv6.includes('%')) return true;
  const words = parseIpv6Words(rawIpv6);
  if (!words || words.length !== 8) return true;
  const [w0, w1, w2, w3, w4, w5, w6, w7] = words;

  // ::/128, ::1/128, and deprecated IPv4-compatible ::/96
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) return true;
  // IPv4-mapped ::ffff:0:0/96
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
    const octets = [(w6 >> 8) & 0xff, w6 & 0xff, (w7 >> 8) & 0xff, w7 & 0xff];
    if (allowPrivateLan) {
      const [a, b] = octets;
      return a === 0 || (a === 169 && b === 254) || a >= 224;
    }
    return isDisallowedIpv4(octets);
  }
  // SIIT IPv4-translated ::ffff:0:0:0/96
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0xffff && w5 === 0) return true;
  // NAT64 well-known 64:ff9b::/96 and local-use 64:ff9b:1::/48
  if (w0 === 0x0064 && w1 === 0xff9b && ((w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) || w2 === 0x0001)) {
    return true;
  }
  // Discard-only 100::/64
  if (w0 === 0x0100 && w1 === 0 && w2 === 0 && w3 === 0) return true;
  // Special IETF 2001:: ranges (Teredo, Benchmarking, ORCHID/v2, Docs)
  if (w0 === 0x2001) {
    if (w1 === 0x0000 || w1 === 0x0db8) return true;
    if (w1 === 0x0002 && w2 === 0x0000) return true;
    if ((w1 & 0xfff0) === 0x0010 || (w1 & 0xfff0) === 0x0020) return true;
  }
  // 6to4 transitional 2002::/16
  if (w0 === 0x2002) return true;
  // ISATAP interface identifier
  if ((w4 === 0x0000 || w4 === 0x0200) && w5 === 0x5efe) return true;
  // Unique-local fc00::/7 (allowed only when allowPrivateLan === true)
  if (!allowPrivateLan && (w0 & 0xfe00) === 0xfc00) return true;
  // Link-local fe80::/10, deprecated site-local fec0::/10, multicast ff00::/8
  if ((w0 & 0xffc0) === 0xfe80 || (w0 & 0xffc0) === 0xfec0) return true;
  if ((w0 & 0xff00) === 0xff00) return true;

  return false;
}

export function isDisallowedHost(hostname) {
  const raw = String(hostname || '').trim().toLowerCase();
  if (!raw) return true;
  const unwrapped = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (!unwrapped || unwrapped.includes('[') || unwrapped.includes(']')) return true;

  if (unwrapped.includes(':')) {
    return isDisallowedIpv6(unwrapped);
  }

  const hadTrailingDot = unwrapped.endsWith('.');
  if (unwrapped.startsWith('.') || unwrapped.includes('..')) return true;
  const host = unwrapped.replace(/\.+$/, '');
  if (!host) return true;

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal' ||
    host === 'metadata'
  ) {
    return true;
  }

  const labels = host.split('.');
  if (labels.every((label) => /^(?:\d+|0x[0-9a-f]+)$/i.test(label))) {
    if (hadTrailingDot) return true;
    if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(host)) {
      return true;
    }
    return isDisallowedIpv4(host.split('.').map((n) => Number.parseInt(n, 10)));
  }

  return false;
}

export function isMetadataOrLinkLocalHost(hostname) {
  const raw = String(hostname || '').trim().toLowerCase();
  if (!raw) return true;
  const unwrapped = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (!unwrapped || unwrapped.includes('[') || unwrapped.includes(']')) return true;
  if (unwrapped.includes(':')) {
    return isDisallowedIpv6(unwrapped, { allowPrivateLan: true });
  }
  const hadTrailingDot = unwrapped.endsWith('.');
  if (unwrapped.startsWith('.') || unwrapped.includes('..')) return true;
  const host = unwrapped.replace(/\.+$/, '');
  if (!host) return true;
  if (host === 'metadata.google.internal' || host === 'metadata' || host.endsWith('.metadata.google.internal')) {
    return true;
  }
  const labels = host.split('.');
  if (labels.every((label) => /^(?:\d+|0x[0-9a-f]+)$/i.test(label))) {
    if (hadTrailingDot || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(host)) return true;
    const [a, b] = host.split('.').map((n) => Number.parseInt(n, 10));
    if (a === 0 || (a === 169 && b === 254) || a >= 224) return true;
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
      model: (env.DEEPSEEK_MODEL || 'deepseek-flash').trim() || 'deepseek-flash'
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
  knowledge = [],
  history = [],
  budgets,
  timeoutMs = 20_000,
  signal
}) {
  if (!apiKey) throw new Error(`${serviceName} API is not configured`);
  if (typeof customerMessage !== 'string' || !customerMessage.trim()) {
    throw new Error('customerMessage is required');
  }
  const cleanBase = normalizeHttpsApiUrl(baseUrl, baseUrl, `${serviceName.toUpperCase()}_BASE_URL`);
  const endpoint = `${cleanBase}/chat/completions`;
  // WP-2.1 (DEC-051): one context policy for every provider — no per-adapter slicing.
  const context = buildContext({ instructions: DEFAULT_POLICY, business: businessContext, message: customerMessage, knowledge, history }, budgets);

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
        { role: 'system', content: context.system },
        { role: 'user', content: context.user }
      ]
    })
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new UpstreamError(serviceName, response.status);
    // Provider error text (never the key, never the prompt) so operators learn *why*: balance, scope, model.
    const upstreamMessage = result?.error?.message || result?.error?.code || result?.message || result?.detail?.status || result?.detail;
    if (upstreamMessage) error.upstreamDetail = String(typeof upstreamMessage === 'string' ? upstreamMessage : JSON.stringify(upstreamMessage)).slice(0, 160);
    throw error;
  }
  const choice = result?.choices?.[0];
  const content = choice?.message?.content;
  const text = (Array.isArray(content)
    ? content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('')
    : String(content || '')
  ).trim();
  if (!text) {
    // Say *why* nothing usable came back (never echoes the key or the model output itself).
    const reasons = [];
    if (result?.error) reasons.push(`provider error: ${String(result.error.message || result.error.code || result.error).slice(0, 120)}`);
    if (choice?.finish_reason) reasons.push(`finish_reason=${choice.finish_reason}`);
    if (choice?.message?.reasoning_content || choice?.message?.reasoning) reasons.push('reasoning-only output — raise max_tokens or pick a non-reasoning model');
    if (!choice) {
      const message = result?.message || result?.msg || result?.detail;
      reasons.push(`no choices in response (keys: ${Object.keys(result || {}).slice(0, 6).join(',') || 'none'}${message ? `; message: ${String(typeof message === 'string' ? message : JSON.stringify(message)).slice(0, 120)}` : ''})`);
    }
    throw new Error(`${serviceName} returned no usable reply${reasons.length ? ` (${reasons.join('; ')})` : ''}`);
  }
  return text.slice(0, 1000);
}
