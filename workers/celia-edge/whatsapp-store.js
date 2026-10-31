import { constantTimeEqualAsync, decryptEdgeJson as decryptJson, encryptEdgeJson as encryptJson, sha256Hex } from './crypto.js';

async function d1First(env, sql, params = []) {
  return env.DB.prepare(sql).bind(...params).first();
}

export const WHATSAPP_OWNER = 'owner';
export const WHATSAPP_SESSION_COOKIE = '__Host-celia_wa';

export function whatsappOnboardingConfig(env = {}) {
  const appId = String(env.WHATSAPP_APP_ID || '').trim();
  const configId = String(env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID || '').trim();
  const appSecret = String(env.WHATSAPP_APP_SECRET || '').trim();
  const apiVersion = String(env.WHATSAPP_API_VERSION || 'v26.0').trim();
  const missing = [];
  if (!/^\d{6,32}$/.test(appId)) missing.push('Meta app');
  if (!/^\d{6,32}$/.test(configId)) missing.push('Embedded Signup configuration');
  if (appSecret.length < 16 || /^replace-with-/i.test(appSecret)) missing.push('Meta app secret');
  if (!/^v\d{2,}\.\d+$/.test(apiVersion)) missing.push('Graph API version');
  if (!env.DB) missing.push('D1');
  if (!String(env.TOKEN_ENCRYPTION_KEY || '').trim()) missing.push('encryption key');
  return {
    configured: missing.length === 0 && String(env.CELIA_DISABLE_WHATSAPP || '') !== 'true',
    appId, configId, appSecret, apiVersion, missing,
    signupVersion: 'v5'
  };
}

export async function findWhatsAppConnection(env, userId = WHATSAPP_OWNER) {
  if (!env.DB) return null;
  return d1First(env, 'SELECT * FROM whatsapp_connections WHERE user_id = ? LIMIT 1', [userId]);
}

/** D1 is authoritative once bound. A storage/decryption failure never silently selects another number. */
export async function resolveEdgeWhatsAppCredentials(env, userId = WHATSAPP_OWNER) {
  const legacy = {
    accessToken: String(env.WHATSAPP_ACCESS_TOKEN || '').trim(),
    phoneNumberId: String(env.WHATSAPP_PHONE_NUMBER_ID || '').trim(),
    apiVersion: String(env.WHATSAPP_API_VERSION || 'v26.0').trim(),
    source: 'environment', connection: null
  };
  const allowLegacy = userId === WHATSAPP_OWNER;
  if (!env.DB) return allowLegacy && legacy.accessToken && legacy.phoneNumberId ? legacy : null;
  const row = await findWhatsAppConnection(env, userId);
  if (!row) return allowLegacy && legacy.accessToken && legacy.phoneNumberId ? legacy : null;
  const credentials = await decryptJson(row.credentials_ciphertext, env);
  if (!credentials?.accessToken || row.status !== 'connected') {
    const error = new Error('whatsapp_reconnect_required');
    error.status = 409;
    throw error;
  }
  return {
    accessToken: credentials.accessToken,
    phoneNumberId: row.phone_number_id,
    apiVersion: row.api_version,
    source: 'embedded_signup',
    connection: row
  };
}

export function publicConnection(row) {
  if (!row) return { connected: false, status: 'not_linked', phoneNumber: null, businessName: null };
  return {
    connected: row.status === 'connected',
    status: row.status,
    phoneNumber: row.display_phone_number || null,
    businessName: row.verified_name || null,
    connectedAt: row.connected_at,
    lastVerifiedAt: row.last_verified_at,
    lastInboundAt: row.last_inbound_at || null,
    errorCode: row.last_error_code || null
  };
}

export async function saveWhatsAppConnection(env, {
  userId = WHATSAPP_OWNER, phoneNumberId, wabaId, displayPhoneNumber, verifiedName,
  accessToken, verifyToken, pin, apiVersion, callbackUri, status = 'connected', errorCode = null
}) {
  const now = new Date().toISOString();
  const ciphertext = await encryptJson({ accessToken, verifyToken, pin: pin || null }, env);
  const existing = await findWhatsAppConnection(env, userId);
  const claimed = await d1First(env, 'SELECT user_id FROM whatsapp_connections WHERE phone_number_id = ? LIMIT 1', [phoneNumberId]);
  if (claimed && claimed.user_id !== userId) {
    throw Object.assign(new Error('whatsapp_number_already_linked'), { status: 409 });
  }
  await env.DB.prepare(`INSERT INTO whatsapp_connections
    (user_id, phone_number_id, waba_id, display_phone_number, verified_name, credentials_ciphertext,
     verify_token_hash, api_version, status, webhook_callback_uri, last_error_code, connected_at, last_verified_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      phone_number_id=excluded.phone_number_id, waba_id=excluded.waba_id,
      display_phone_number=excluded.display_phone_number, verified_name=excluded.verified_name,
      credentials_ciphertext=excluded.credentials_ciphertext, verify_token_hash=excluded.verify_token_hash, api_version=excluded.api_version,
      status=excluded.status, webhook_callback_uri=excluded.webhook_callback_uri,
      last_error_code=excluded.last_error_code, last_verified_at=excluded.last_verified_at, updated_at=excluded.updated_at`)
    .bind(userId, phoneNumberId, wabaId, displayPhoneNumber || null, verifiedName || null, ciphertext,
      await sha256Hex(verifyToken), apiVersion, status, callbackUri, errorCode, existing?.connected_at || now, now, now).run().catch((error) => {
        if (/UNIQUE|constraint/i.test(String(error?.message || ''))) throw Object.assign(new Error('whatsapp_number_already_linked'), { status: 409 });
        throw error;
      });
  return findWhatsAppConnection(env, userId);
}

export async function findWhatsAppVerifyToken(env, token) {
  if (!token || !env.DB) return false;
  const expected = String(env.WHATSAPP_VERIFY_TOKEN || '').trim();
  // Compare in constant time: `===` leaks the shared verify token byte-by-byte to a
  // caller who can time the webhook handshake. Same primitive the signature path uses.
  if (expected && (await constantTimeEqualAsync(String(token), expected))) return true;
  const hash = await sha256Hex(token);
  const connection = await d1First(env, 'SELECT user_id FROM whatsapp_connections WHERE verify_token_hash = ? LIMIT 1', [hash]);
  if (connection) return true;
  const pending = await d1First(env, 'SELECT user_id FROM whatsapp_oauth_states WHERE verify_token_hash = ? AND expires_at > ? LIMIT 1', [hash, Date.now()]);
  return Boolean(pending);
}
