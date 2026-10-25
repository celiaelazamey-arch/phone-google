import crypto from 'node:crypto';

export function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function encryptionKey(keyBase64) {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('Encryption key must decode to exactly 32 bytes');
  return key;
}

export function encryptJson(value, keyBase64) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(keyBase64), nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', nonce.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptJson(payload, keyBase64) {
  const [version, nonce64, tag64, ciphertext64, extra] = String(payload).split('.');
  if (version !== 'v1' || !nonce64 || !tag64 || !ciphertext64 || extra !== undefined) throw new Error('Invalid encrypted token payload');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(keyBase64), Buffer.from(nonce64, 'base64'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64'));
  const cleartext = Buffer.concat([decipher.update(Buffer.from(ciphertext64, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(cleartext);
}

export function hashOAuthState(state) {
  return crypto.createHash('sha256').update(state).digest('hex');
}

export function verifyWhatsAppSignature(rawBody, signatureHeader, appSecret) {
  if (!Buffer.isBuffer(rawBody) || !signatureHeader || !appSecret) return false;
  const match = /^sha256=([a-f0-9]{64})$/i.exec(signatureHeader);
  if (!match) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  const supplied = Buffer.from(match[1], 'hex');
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

export function isWithinCustomerWindow(lastInboundAt, now = new Date()) {
  if (!lastInboundAt) return false;
  const last = new Date(lastInboundAt).getTime();
  return Number.isFinite(last) && last <= now.getTime() && now.getTime() - last < 24 * 60 * 60 * 1000;
}

export function isValidE164(phone) {
  return typeof phone === 'string' && /^\+[1-9]\d{7,14}$/.test(phone);
}
