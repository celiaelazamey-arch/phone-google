// WA-005 / DEC-064 — Meta Embedded Signup v5, Tech Provider path.
// The browser only carries Meta's short-lived code and asset hints. Token exchange,
// webhook subscription, Cloud API registration and encrypted persistence happen here.
import { decryptEdgeJson as decryptJson, encryptEdgeJson as encryptJson, randomHex, sha256Hex } from './crypto.js';
import { appendAudit } from './state.js';
import {
  WHATSAPP_OWNER, WHATSAPP_SESSION_COOKIE, whatsappOnboardingConfig,
  findWhatsAppConnection, publicConnection, saveWhatsAppConnection
} from './whatsapp-store.js';

async function d1First(db, sql, params = []) {
  return db.prepare(sql).bind(...params).first();
}

const TICKET_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 60 * 60_000;
const STATE_TTL_MS = 15 * 60_000;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const ID = /^\d{3,40}$/;
const GRAPH = 'https://graph.facebook.com';

function problem(message, status = 400, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}
function requireD1(env) {
  if (!env.DB) throw problem('d1_not_bound', 503);
  return env.DB;
}
function requireConfigured(env) {
  const config = whatsappOnboardingConfig(env);
  if (!config.configured) throw problem('whatsapp_onboarding_not_configured', 503);
  return config;
}
export function readWhatsAppCookie(request) {
  for (const part of String(request.headers.get('cookie') || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === WHATSAPP_SESSION_COOKIE) return rest.join('=');
  }
  return '';
}
export function whatsappSessionCookie(token, maxAge = SESSION_TTL_MS / 1000) {
  return `${WHATSAPP_SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
export function assertWhatsAppMutation(request) {
  const origin = request.headers.get('origin');
  const expected = new URL(request.url).origin;
  if (origin !== expected || request.headers.get('x-celia-request') !== 'whatsapp') {
    throw problem('csrf_origin_or_header_mismatch', 403);
  }
}
export async function requireWhatsAppSession(request, env) {
  return sessionHash(request, env);
}

async function sessionHash(request, env) {
  const token = readWhatsAppCookie(request);
  if (!TOKEN.test(token)) throw problem('whatsapp_session_required', 401);
  const hash = await sha256Hex(token);
  let row = await d1First(requireD1(env),
    'SELECT user_id FROM whatsapp_browser_sessions WHERE session_hash = ? AND expires_at > ? LIMIT 1', [hash, Date.now()]);
  if (!row) {
    row = await d1First(requireD1(env),
      'SELECT s.user_id FROM account_sessions s JOIN app_accounts a ON a.id = s.user_id WHERE s.session_hash = ? AND s.expires_at > ? AND a.status = ? LIMIT 1', [hash, Date.now(), 'active']);
  }
  if (!row) throw problem('whatsapp_session_expired', 401);
  return { hash, userId: row.user_id };
}

/** Called only after the existing owner Bearer gate. The ticket is not a Meta credential. */
export async function createWhatsAppLink(env, origin, userId = WHATSAPP_OWNER) {
  requireConfigured(env);
  const db = requireD1(env);
  const ticket = randomHex(32);
  const now = Date.now();
  await db.prepare('DELETE FROM whatsapp_link_tickets WHERE expires_at < ?').bind(now - 86_400_000).run();
  await db.prepare('INSERT INTO whatsapp_link_tickets (ticket_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(ticket), userId, now + TICKET_TTL_MS, new Date(now).toISOString()).run();
  const url = new URL('/auth/whatsapp', origin);
  url.searchParams.set('ticket', ticket);
  return { url: url.toString(), expiresAt: now + TICKET_TTL_MS };
}

export async function consumeWhatsAppTicket({ request, env }) {
  const db = requireD1(env);
  const ticket = new URL(request.url).searchParams.get('ticket') || '';
  if (!TOKEN.test(ticket)) throw problem('invalid_or_expired_whatsapp_ticket', 400);
  const now = Date.now();
  const hash = await sha256Hex(ticket);
  const row = await d1First(db, 'SELECT user_id FROM whatsapp_link_tickets WHERE ticket_hash = ? AND consumed_at IS NULL AND expires_at > ?', [hash, now]);
  if (!row) throw problem('invalid_or_expired_whatsapp_ticket', 400);
  const consumed = await db.prepare('UPDATE whatsapp_link_tickets SET consumed_at = ? WHERE ticket_hash = ? AND consumed_at IS NULL AND expires_at > ?')
    .bind(now, hash, now).run();
  if ((consumed?.meta?.changes ?? 0) !== 1) throw problem('invalid_or_expired_whatsapp_ticket', 400);
  const token = randomHex(32);
  await db.prepare('DELETE FROM whatsapp_browser_sessions WHERE expires_at < ?').bind(now - 86_400_000).run();
  await db.prepare('INSERT INTO whatsapp_browser_sessions (session_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), row.user_id, now + SESSION_TTL_MS, new Date(now).toISOString()).run();
  return { cookie: whatsappSessionCookie(token), location: '/whatsapp' };
}

async function graph(env, config, path, { token, method = 'GET', body, query = {}, fetchImpl = fetch } = {}) {
  const url = new URL(`${GRAPH}/${config.apiVersion}/${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(12_000)
    });
  } catch {
    throw problem('meta_outcome_unknown', 502, { outcomeUnknown: method !== 'GET' });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status >= 500) throw problem('meta_outcome_unknown', 502, { outcomeUnknown: method !== 'GET' });
    // Never echo provider messages: they may contain identifiers or request material.
    throw problem(`meta_request_rejected_${response.status}`, 502, { providerCode: Number(data?.error?.code) || null });
  }
  return data;
}

export function parseSignupAssets(data) {
  const info = typeof data === 'string' ? JSON.parse(data) : data;
  if (!info || typeof info !== 'object') throw problem('invalid_embedded_signup_session', 400);
  const accounts = Array.isArray(info.messaging_account_ids) ? info.messaging_account_ids : [info.waba_id];
  const wabaIds = [...new Set(accounts.map(String).filter((id) => ID.test(id)))].slice(0, 10);
  const phoneNumberId = info.phone_number_id == null ? null : String(info.phone_number_id);
  if (phoneNumberId && !ID.test(phoneNumberId)) throw problem('invalid_embedded_signup_session', 400);
  if (!wabaIds.length) throw problem('whatsapp_business_account_missing', 400);
  return { wabaIds, phoneNumberId, onBizApp: info.is_on_biz_app === true || info.is_on_biz_app === 'true' };
}

async function startSignup(env, session) {
  const config = requireConfigured(env);
  const db = requireD1(env);
  const state = randomHex(32);
  const now = Date.now();
  await db.prepare('DELETE FROM whatsapp_oauth_states WHERE expires_at < ? AND consumed_at IS NOT NULL').bind(now - 86_400_000).run();
  await db.prepare(`INSERT INTO whatsapp_oauth_states
    (state_hash, session_hash, user_id, expires_at, stage, created_at, updated_at) VALUES (?, ?, ?, ?, 'created', ?, ?)`)
    .bind(await sha256Hex(state), session.hash, session.userId, now + STATE_TTL_MS, new Date(now).toISOString(), new Date(now).toISOString()).run();
  return {
    state, appId: config.appId, configId: config.configId,
    apiVersion: config.apiVersion, signupVersion: config.signupVersion,
    // Cloud API only: do not silently migrate a number out of the WhatsApp Business app.
    features: [{ name: 'whatsapp_business_app_onboarding', enabled: false }],
    expiresAt: now + STATE_TTL_MS
  };
}

async function updateState(env, hash, fields) {
  const allowed = ['stage', 'error_code', 'credentials_ciphertext', 'pin_ciphertext', 'verify_token_hash', 'phone_number_id', 'waba_id'];
  const keys = Object.keys(fields).filter((key) => allowed.includes(key));
  if (!keys.length) return;
  await requireD1(env).prepare(`UPDATE whatsapp_oauth_states SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE state_hash = ?`)
    .bind(...keys.map((key) => fields[key]), new Date().toISOString(), hash).run();
}

async function exchangeAndPersist(env, config, stateHash, code, fetchImpl) {
  const url = new URL(`${GRAPH}/${config.apiVersion}/oauth/access_token`);
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('client_secret', config.appSecret);
  url.searchParams.set('code', code);
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(12_000) });
  } catch { throw problem('meta_code_exchange_outcome_unknown', 502); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw problem('meta_code_exchange_rejected', 502);
  const ciphertext = await encryptJson({ accessToken: String(data.access_token) }, env);
  await updateState(env, stateHash, { credentials_ciphertext: ciphertext, stage: 'token_exchanged', error_code: null });
  return String(data.access_token);
}

async function discoverNumber(env, config, accessToken, assets, fetchImpl) {
  const candidates = [];
  for (const wabaId of assets.wabaIds) {
    const result = await graph(env, config, `${wabaId}/phone_numbers`, {
      token: accessToken, query: { fields: 'id,display_phone_number,verified_name,code_verification_status,status', limit: 100 }, fetchImpl
    });
    for (const phone of result.data || []) {
      if (ID.test(String(phone.id))) candidates.push({ ...phone, wabaId });
    }
  }
  // Browser hints select an asset; Graph's authorized list is the authority.
  const selected = assets.phoneNumberId
    ? candidates.find((phone) => String(phone.id) === assets.phoneNumberId)
    : candidates.length === 1 ? candidates[0] : null;
  if (!selected) throw problem(candidates.length > 1 ? 'select_business_number_in_meta' : 'whatsapp_number_not_authorized', 409);
  if (assets.onBizApp) throw problem('business_app_coexistence_not_enabled', 409);
  if (selected.status !== 'CONNECTED' && selected.code_verification_status !== 'VERIFIED') {
    throw problem('complete_number_ownership_verification_in_meta', 409);
  }
  return selected;
}

async function finishSignup(env, config, stateHash, session, body, fetchImpl) {
  const db = requireD1(env);
  const row = await d1First(db, 'SELECT * FROM whatsapp_oauth_states WHERE state_hash = ? AND session_hash = ?', [stateHash, session.hash]);
  if (!row) throw problem('invalid_or_expired_oauth_state', 400);
  let accessToken;
  let pin;
  let verifyToken;
  if (row.credentials_ciphertext) {
    const stored = await decryptJson(row.credentials_ciphertext, env);
    accessToken = stored.accessToken;
    pin = row.pin_ciphertext ? (await decryptJson(row.pin_ciphertext, env)).pin : null;
    verifyToken = stored.verifyToken || null;
  } else {
    const code = String(body.code || '');
    if (!code || code.length > 2048) throw problem('missing_meta_code', 400);
    const consumed = await db.prepare('UPDATE whatsapp_oauth_states SET consumed_at = ?, updated_at = ? WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?')
      .bind(Date.now(), new Date().toISOString(), stateHash, Date.now()).run();
    if ((consumed?.meta?.changes ?? 0) !== 1) throw problem('invalid_or_expired_oauth_state', 400);
    accessToken = await exchangeAndPersist(env, config, stateHash, code, fetchImpl);
  }
  const assets = row.waba_id
    ? { wabaIds: [row.waba_id], phoneNumberId: row.phone_number_id, onBizApp: false }
    : parseSignupAssets(body.sessionInfo);
  try {
    const phone = await discoverNumber(env, config, accessToken, assets, fetchImpl);
    const claimed = await d1First(db, 'SELECT user_id FROM whatsapp_connections WHERE phone_number_id = ? LIMIT 1', [String(phone.id)]);
    if (claimed && claimed.user_id !== session.userId) throw problem('whatsapp_number_already_linked', 409);
    const callbackUri = `${new URL(env.CELIA_PUBLIC_ORIGIN || 'https://celia-phone-google.celiaelazamey.workers.dev').origin}/webhooks/whatsapp`;
    if (!verifyToken) {
      verifyToken = randomHex(32);
      const encrypted = await encryptJson({ accessToken, verifyToken }, env);
      await updateState(env, stateHash, {
        credentials_ciphertext: encrypted, verify_token_hash: await sha256Hex(verifyToken),
        waba_id: phone.wabaId, phone_number_id: String(phone.id), stage: 'asset_verified'
      });
    }
    // Subscribe the WABA, then override the callback per phone number. A per-number override
    // keeps two businesses in the same WABA from overwriting each other's verify token.
    const subscriptions = await graph(env, config, `${phone.wabaId}/subscribed_apps`, { token: accessToken, fetchImpl });
    const subscribed = (subscriptions.data || []).some((app) => String(app.id) === config.appId || String(app.whatsapp_business_api_data?.id) === config.appId);
    if (!subscribed) {
      try {
        await graph(env, config, `${phone.wabaId}/subscribed_apps`, { token: accessToken, method: 'POST', fetchImpl });
      } catch (error) {
        await updateState(env, stateHash, { stage: error.outcomeUnknown ? 'subscription_unknown' : 'failed', error_code: error.message });
        throw error;
      }
    }
    const currentPhone = await graph(env, config, String(phone.id), { token: accessToken, query: { fields: 'webhook_configuration' }, fetchImpl });
    const override = currentPhone.webhook_configuration || {};
    if (override.override_callback_uri !== callbackUri || row.stage === 'subscription_unknown') {
      try {
        await graph(env, config, String(phone.id), {
          token: accessToken, method: 'POST', body: { webhook_configuration: { override_callback_uri: callbackUri, verify_token: verifyToken } }, fetchImpl
        });
      } catch (error) {
        await updateState(env, stateHash, { stage: error.outcomeUnknown ? 'subscription_unknown' : 'failed', error_code: error.message });
        throw error;
      }
    }
    await updateState(env, stateHash, { stage: 'webhook_subscribed' });
    if (phone.status !== 'CONNECTED') {
      if (row.stage === 'registration_unknown') throw problem('registration_outcome_unknown_reconcile_in_meta', 409);
      if (!pin) {
        const bytes = crypto.getRandomValues(new Uint8Array(4));
        pin = String(100000 + ((bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]) >>> 0) % 900000);
        await updateState(env, stateHash, { pin_ciphertext: await encryptJson({ pin }, env) });
      }
      try {
        await graph(env, config, `${phone.id}/register`, { token: accessToken, method: 'POST', body: { messaging_product: 'whatsapp', pin }, fetchImpl });
      } catch (error) {
        await updateState(env, stateHash, { stage: error.outcomeUnknown ? 'registration_unknown' : 'failed', error_code: error.message });
        throw error;
      }
    }
    const verified = await graph(env, config, String(phone.id), {
      token: accessToken, query: { fields: 'id,display_phone_number,verified_name,status,code_verification_status' }, fetchImpl
    });
    if (verified.status !== 'CONNECTED') throw problem('whatsapp_number_not_connected_yet', 409);
    const connection = await saveWhatsAppConnection(env, {
      userId: session.userId, phoneNumberId: String(phone.id), wabaId: phone.wabaId,
      displayPhoneNumber: verified.display_phone_number || phone.display_phone_number,
      verifiedName: verified.verified_name || phone.verified_name,
      accessToken, verifyToken, pin, apiVersion: config.apiVersion, callbackUri
    });
    await updateState(env, stateHash, { stage: 'connected', error_code: null });
    await appendAudit(env, { key: `whatsapp.${session.userId}`, action: 'embedded_signup_connected', valueHash: await sha256Hex(String(phone.id)), at: new Date().toISOString() });
    return { ok: true, connection: publicConnection(connection), liveVerified: true, testAvailable: true };
  } catch (error) {
    if (!['subscription_unknown', 'registration_unknown', 'failed'].includes(row.stage)) {
      await updateState(env, stateHash, { error_code: String(error.message).slice(0, 100) });
    }
    throw error;
  }
}

export async function handleWhatsAppSession({ request, env, pathname, fetchImpl = fetch }) {
  const session = await sessionHash(request, env);
  const method = request.method;
  if (method !== 'GET') assertWhatsAppMutation(request);
  if (pathname === '/api/whatsapp/session/status' && method === 'GET') {
    const config = whatsappOnboardingConfig(env);
    return { status: 200, body: { configured: config.configured, connection: publicConnection(await findWhatsAppConnection(env, session.userId)) } };
  }
  if (pathname === '/api/whatsapp/session/start' && method === 'POST') return { status: 200, body: await startSignup(env, session) };
  if (pathname === '/api/whatsapp/session/complete' && method === 'POST') {
    const body = await request.json().catch(() => null);
    const state = String(body?.state || '');
    if (!TOKEN.test(state)) throw problem('invalid_or_expired_oauth_state', 400);
    return { status: 200, body: await finishSignup(env, requireConfigured(env), await sha256Hex(state), session, body || {}, fetchImpl) };
  }
  if (pathname === '/api/whatsapp/session/logout' && method === 'POST') {
    await requireD1(env).prepare('DELETE FROM whatsapp_browser_sessions WHERE session_hash = ?').bind(session.hash).run();
    await requireD1(env).prepare('DELETE FROM account_sessions WHERE session_hash = ?').bind(session.hash).run();
    return { status: 200, body: { ok: true }, cookie: whatsappSessionCookie('', 0) };
  }
  throw problem('not_found', 404);
}
