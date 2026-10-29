import { loadExtendedIntegrationsConfig } from './ai-providers.js';
import { loadMysqlConfig } from './mysql-config.js';
import { normalizeOllamaBaseUrl } from './ollama.js';
import { loadFeatures, loadResilienceConfig } from './resilience.js';
import { parseEncryptionKeyring } from './security.js';
import { readWaContextMode } from './whatsapp-context.js';
export const DEFAULT_EDGE_ORIGIN = 'https://celia-phone-google.celiaelazamey.workers.dev';

/**
 * Origin of the card-free edge runtime (DEC-037). The cron dashboard (/cron) talks to it from the browser, so
 * the CSP connect-src must admit exactly this origin; `CELIA_EDGE_ORIGIN` overrides it only with an https URL.
 */
export function resolveEdgeOrigin(env = process.env) {
  const value = String(env?.CELIA_EDGE_ORIGIN || '').trim();
  if (!value) return DEFAULT_EDGE_ORIGIN;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : DEFAULT_EDGE_ORIGIN;
  } catch {
    return DEFAULT_EDGE_ORIGIN;
  }
}

export function loadConfig(env = process.env) {
  const required = (name) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };

  const rawAppToken = (env.APP_API_TOKEN || '').trim();
  const rawMcpToken = (env.CELIA_MCP_API_TOKEN || '').trim();
  const useFallbackMcpToken =
    (!rawAppToken || /^replace-with-/i.test(rawAppToken)) &&
    rawMcpToken &&
    !/^replace-with-/i.test(rawMcpToken);
  const apiToken = useFallbackMcpToken ? rawMcpToken : required('APP_API_TOKEN');
  if (/^replace-with-/i.test(apiToken)) throw new Error('APP_API_TOKEN must not be a placeholder');
  if (apiToken.length < 32) throw new Error('APP_API_TOKEN must be at least 32 characters');
  const encryptionKey = required('TOKEN_ENCRYPTION_KEY');
  const decodedKey = Buffer.from(encryptionKey, 'base64');
  if (decodedKey.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be base64 for exactly 32 bytes');
  const encryptionKeyring = parseEncryptionKeyring(encryptionKey, {
    primaryKeyId: env.TOKEN_ENCRYPTION_KEY_ID || '',
    keyringSpec: env.TOKEN_ENCRYPTION_KEYRING || ''
  });

  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');

  const extended = loadExtendedIntegrationsConfig(env);
  const mcpTokenClean = rawMcpToken && !/^replace-with-/i.test(rawMcpToken) ? rawMcpToken : '';

  return Object.freeze({
    nodeEnv: env.NODE_ENV || 'development',
    features: loadFeatures(env),
    resilience: loadResilienceConfig(env),
    ...extended,
    port,
    baseUrl: env.APP_BASE_URL || `http://localhost:${port}`,
    apiToken,
    celia: Object.freeze({
      apiToken: mcpTokenClean || apiToken,
      aiProvider: ((env.CELIA_AI_PROVIDER || 'auto').trim() || 'auto').toLowerCase()
    }),
    userId: env.APP_USER_ID || 'owner',
    ownerEmail: env.APP_OWNER_EMAIL || '',
    ownerPhone: (env.APP_OWNER_PHONE_E164 || env.PHONE_NUMBER || '').trim() || null,
    timezone: (env.CELIA_TIMEZONE || '').trim() || 'Africa/Cairo',
    edgeOrigin: resolveEdgeOrigin(env),
    encryptionKey,
    encryptionKeyring,
    mysql: loadMysqlConfig(env),
    google: {
      clientId: (env.GOOGLE_CLIENT_ID || '').trim(),
      clientSecret: (env.GOOGLE_CLIENT_SECRET || '').trim(),
      allowedEmail: (env.APP_OWNER_EMAIL || '').trim().toLowerCase(),
      redirectUri: env.GOOGLE_REDIRECT_URI || `${env.APP_BASE_URL || `http://localhost:${port}`}/auth/google/callback`
    },
    gemini: {
      apiKey: (env.GEMINI_API_KEY || '').trim(),
      model: env.GEMINI_MODEL || 'gemini-2.5-flash',
      businessContext: env.GEMINI_BUSINESS_CONTEXT || ''
    },
    ollama: Object.freeze({
      baseUrl: normalizeOllamaBaseUrl(env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434', env.OLLAMA_ALLOW_REMOTE === 'true'),
      model: (env.OLLAMA_MODEL || 'qwen2.5:7b').trim() || 'qwen2.5:7b',
      allowRemote: env.OLLAMA_ALLOW_REMOTE === 'true'
    }),
    whatsapp: {
      verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
      appSecret: env.WHATSAPP_APP_SECRET || '',
      accessToken: env.WHATSAPP_ACCESS_TOKEN || '',
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
      apiVersion: env.WHATSAPP_API_VERSION || 'v26.0',
      autoReplyEnabled: env.WHATSAPP_AUTO_REPLY_ENABLED === 'true',
      // WP-2.2 (DEC-058): the conversation window and the knowledge pack are off unless this is explicitly on.
      contextEnabled: readWaContextMode(env) === 'on'
    }
  });
}
