import crypto from 'node:crypto';

/**
 * Single-use Google connection tickets.
 *
 * A ticket lets the owner start the OAuth flow from a chat message (WhatsApp, MCP client)
 * without ever putting the long-lived API bearer token in a URL. The ticket is:
 *   base64url(payload) "." base64url(HMAC-SHA256(key, prefix + payload))
 * and it is also used as the OAuth `state`, so it inherits the one-time, ten-minute,
 * cookie-bound consumption that `oauth_states` already enforces in the callback.
 *
 * The signing key is derived from TOKEN_ENCRYPTION_KEY with domain separation, so no new
 * secret has to be provisioned and a ticket cannot be replayed as another use of the key.
 */

const PREFIX = 'celia:google-consent:v1:';
const MAX_TICKET_LENGTH = 2048;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function signingKey(encryptionKeyBase64) {
  const root = Buffer.from(String(encryptionKeyBase64 || ''), 'base64');
  if (root.length !== 32) throw new Error('Consent tickets require a 32-byte encryption key');
  return crypto.createHmac('sha256', root).update('google-consent-ticket-key').digest();
}

function sign(payload, encryptionKeyBase64) {
  return crypto.createHmac('sha256', signingKey(encryptionKeyBase64)).update(PREFIX + payload).digest('base64url');
}

export function mintConsentTicket({ userId, encryptionKey, ttlMs = DEFAULT_TTL_MS, now = Date.now() }) {
  if (typeof userId !== 'string' || !userId.trim()) throw new Error('Consent ticket requires a user id');
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > DEFAULT_TTL_MS) throw new Error('Consent ticket lifetime must be positive and at most ten minutes');
  const expiresAt = now + ttlMs;
  const payload = Buffer.from(JSON.stringify({
    u: userId,
    e: Math.floor(expiresAt / 1000),
    n: crypto.randomBytes(16).toString('hex')
  }), 'utf8').toString('base64url');
  return { ticket: `${payload}.${sign(payload, encryptionKey)}`, expiresAt: new Date(expiresAt) };
}

export function verifyConsentTicket(ticket, { encryptionKey, userId, now = Date.now() }) {
  if (typeof ticket !== 'string' || !ticket || ticket.length > MAX_TICKET_LENGTH) return { ok: false, reason: 'malformed' };
  const parts = ticket.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payload, signature] = parts;
  const expected = Buffer.from(sign(payload, encryptionKey), 'base64url');
  const supplied = Buffer.from(signature, 'base64url');
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(expected, supplied)) return { ok: false, reason: 'signature' };

  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { return { ok: false, reason: 'payload' }; }
  if (!data || typeof data.u !== 'string' || !Number.isInteger(data.e)) return { ok: false, reason: 'payload' };
  if (data.u !== userId) return { ok: false, reason: 'user' };
  if (data.e * 1000 <= now) return { ok: false, reason: 'expired' };
  return { ok: true, userId: data.u, expiresAt: new Date(data.e * 1000) };
}

export const consentTicketDefaults = Object.freeze({ ttlMs: DEFAULT_TTL_MS });
