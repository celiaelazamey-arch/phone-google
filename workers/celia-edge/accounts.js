// WA-007 / DEC-065 — self-service accounts for ordinary business users.
// No owner token, no provider secret, and no cross-tenant data access in this module.
import { constantTimeEqualAsync, randomHex, sha256Hex } from './crypto.js';
import { appendAudit } from './state.js';
import { assertWhatsAppMutation, readWhatsAppCookie, whatsappSessionCookie } from './whatsapp-onboarding.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const PBKDF2_ITERATIONS = 100_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

function problem(message, status = 400) { return Object.assign(new Error(message), { status }); }
function db(env) { if (!env.DB) throw problem('d1_not_bound', 503); return env.DB; }
function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) throw problem('invalid_email');
  return email;
}
function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 10 || password.length > 128) throw problem('password_must_be_10_to_128_characters');
  return password;
}
function toBase64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
function fromBase64(value) { return Uint8Array.from(atob(value), (c) => c.charCodeAt(0)); }
async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(salt), iterations: PBKDF2_ITERATIONS }, key, 256);
  return toBase64(bits);
}
async function rateLimit(env, request, action, email) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const key = await sha256Hex(`${action}:${ip}:${email}`);
  const now = Date.now();
  const windowMs = 15 * 60_000;
  const row = await db(env).prepare('SELECT attempts, window_start FROM account_auth_attempts WHERE attempt_key = ?').bind(key).first();
  const fresh = !row || now - Number(row.window_start) > windowMs;
  const attempts = fresh ? 1 : Number(row.attempts) + 1;
  if (attempts > 8) throw problem('too_many_attempts_try_later', 429);
  await db(env).prepare('INSERT INTO account_auth_attempts (attempt_key, attempts, window_start) VALUES (?, ?, ?) ON CONFLICT(attempt_key) DO UPDATE SET attempts = excluded.attempts, window_start = excluded.window_start')
    .bind(key, attempts, fresh ? now : Number(row.window_start)).run();
}
async function createSession(env, userId) {
  const token = randomHex(32);
  const now = Date.now();
  await db(env).prepare('DELETE FROM account_sessions WHERE expires_at < ?').bind(now - 86_400_000).run();
  await db(env).prepare('INSERT INTO account_sessions (session_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, now + SESSION_TTL_MS, new Date(now).toISOString()).run();
  return whatsappSessionCookie(token, SESSION_TTL_MS / 1000);
}
export async function requireAccountSession(request, env) {
  const token = readWhatsAppCookie(request);
  if (!TOKEN.test(token)) throw problem('account_session_required', 401);
  const hash = await sha256Hex(token);
  const row = await db(env).prepare('SELECT a.id, a.email FROM account_sessions s JOIN app_accounts a ON a.id = s.user_id WHERE s.session_hash = ? AND s.expires_at > ? AND a.status = ?')
    .bind(hash, Date.now(), 'active').first();
  if (!row) throw problem('account_session_expired', 401);
  return { userId: row.id, email: row.email, sessionHash: hash };
}
export async function handleAccountRequest({ request, env, pathname }) {
  const method = request.method;
  if (pathname === '/api/account/me' && method === 'GET') {
    const session = await requireAccountSession(request, env);
    return { status: 200, body: { user: { id: session.userId, email: session.email } } };
  }
  if (method !== 'POST') throw problem('not_found', 404);
  assertWhatsAppMutation(request);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') throw problem('invalid_json');
  if (pathname === '/api/account/logout') {
    const session = await requireAccountSession(request, env);
    await db(env).prepare('DELETE FROM account_sessions WHERE session_hash = ?').bind(session.sessionHash).run();
    return { status: 200, body: { ok: true }, cookie: whatsappSessionCookie('', 0) };
  }
  const email = normalizeEmail(body.email);
  const password = validatePassword(body.password);
  await rateLimit(env, request, pathname, email);
  if (pathname === '/api/account/register') {
    const existing = await db(env).prepare('SELECT id FROM app_accounts WHERE email = ?').bind(email).first();
    if (existing) throw problem('email_already_registered', 409);
    const salt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await hashPassword(password, salt);
    const id = `user_${randomHex(16)}`;
    const now = new Date().toISOString();
    try {
      await db(env).prepare('INSERT INTO app_accounts (id, email, password_hash, password_salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, email, hash, salt, now, now).run();
    } catch { throw problem('email_already_registered', 409); }
    await appendAudit(env, { key: `account.${id}`, action: 'account_registered', valueHash: await sha256Hex(email), at: now });
    return { status: 201, body: { user: { id, email } }, cookie: await createSession(env, id) };
  }
  if (pathname === '/api/account/login') {
    const row = await db(env).prepare('SELECT id, password_hash, password_salt, status FROM app_accounts WHERE email = ?').bind(email).first();
    // Spend the same KDF work for unknown accounts; never reveal whether an email exists.
    const salt = row?.password_salt || toBase64(new Uint8Array(16));
    const candidate = await hashPassword(password, salt);
    if (!row || row.status !== 'active' || !(await constantTimeEqualAsync(candidate, row.password_hash))) throw problem('invalid_email_or_password', 401);
    await appendAudit(env, { key: `account.${row.id}`, action: 'account_login', valueHash: await sha256Hex(email), at: new Date().toISOString() });
    return { status: 200, body: { user: { id: row.id, email } }, cookie: await createSession(env, row.id) };
  }
  throw problem('not_found', 404);
}
