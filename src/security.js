import crypto from 'node:crypto';

const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function encryptionKey(keyBase64) {
  const key = Buffer.from(String(keyBase64 || ''), 'base64');
  if (key.length !== 32) throw new Error('Encryption key must decode to exactly 32 bytes');
  return key;
}

function validateKeyId(keyId) {
  const clean = String(keyId || '').trim();
  if (!KEY_ID_RE.test(clean)) {
    throw new Error('Encryption keyId must match /^[A-Za-z0-9_-]{1,32}$/');
  }
  return clean;
}

/**
 * SEC-005: Keyring parser supporting zero-downtime key rotation (`kid1:base64,kid2:base64`)
 * while preserving legacy `v1` envelope decryption.
 */
export function parseEncryptionKeyring(primaryKeyOrOptions, options = {}) {
  const isObjForm = Boolean(primaryKeyOrOptions && typeof primaryKeyOrOptions === 'object' && !Buffer.isBuffer(primaryKeyOrOptions));
  const primaryKeyBase64 = isObjForm
    ? primaryKeyOrOptions.primaryKey ?? primaryKeyOrOptions.primaryKeyBase64
    : primaryKeyOrOptions;
  const primaryKeyId = isObjForm
    ? primaryKeyOrOptions.primaryKeyId ?? primaryKeyOrOptions.activeKeyId ?? ''
    : options.primaryKeyId ?? options.activeKeyId ?? '';
  const keyringSpec = isObjForm
    ? primaryKeyOrOptions.keyringSpec ?? primaryKeyOrOptions.keyringRaw ?? ''
    : options.keyringSpec ?? options.keyringRaw ?? '';

  encryptionKey(primaryKeyBase64);
  const cleanPrimaryId = primaryKeyId ? validateKeyId(primaryKeyId) : 'primary';
  const entries = new Map([[cleanPrimaryId, primaryKeyBase64]]);

  const rawSpec = String(keyringSpec || '').trim();
  if (rawSpec) {
    for (const part of rawSpec.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const sepIndex = trimmed.indexOf(':');
      if (sepIndex <= 0) {
        throw new Error('TOKEN_ENCRYPTION_KEYRING entries must use <keyId>:<base64Key> format');
      }
      const kid = validateKeyId(trimmed.slice(0, sepIndex));
      const keyB64 = trimmed.slice(sepIndex + 1).trim();
      encryptionKey(keyB64);
      entries.set(kid, keyB64);
    }
    // Primary key always wins for activeKeyId if specified in both places.
    entries.set(cleanPrimaryId, primaryKeyBase64);
  }

  return Object.freeze({
    activeKeyId: cleanPrimaryId,
    primaryKey: primaryKeyBase64,
    useVersionedEnvelope: Boolean(String(primaryKeyId || '').trim() || rawSpec),
    keyIds: Object.freeze([...entries.keys()]),
    getKey(kid) {
      return entries.get(kid) || null;
    },
    allKeys() {
      return [...entries.values()];
    }
  });
}

export function encryptJson(value, keyOrKeyring, options = {}) {
  const isKeyring = Boolean(keyOrKeyring && typeof keyOrKeyring === 'object' && typeof keyOrKeyring.primaryKey === 'string');
  const keyBase64 = isKeyring ? keyOrKeyring.primaryKey : keyOrKeyring;
  const effectiveKeyId =
    options?.keyId || (isKeyring && keyOrKeyring.useVersionedEnvelope ? keyOrKeyring.activeKeyId : '');

  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(keyBase64), nonce);

  if (effectiveKeyId) {
    const cleanKeyId = validateKeyId(effectiveKeyId);
    cipher.setAAD(Buffer.from(`v2.${cleanKeyId}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v2', cleanKeyId, nonce.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
  }

  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', nonce.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

function decryptWithKey(nonce64, tag64, ciphertext64, keyBase64, aadString = '') {
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(keyBase64), Buffer.from(nonce64, 'base64'));
  if (aadString) {
    decipher.setAAD(Buffer.from(aadString, 'utf8'));
  }
  decipher.setAuthTag(Buffer.from(tag64, 'base64'));
  const cleartext = Buffer.concat([decipher.update(Buffer.from(ciphertext64, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(cleartext);
}

export function decryptJson(payload, keyOrKeyring) {
  const isKeyring = Boolean(keyOrKeyring && typeof keyOrKeyring === 'object' && typeof keyOrKeyring.getKey === 'function');
  const parts = String(payload).split('.');

  if (parts[0] === 'v2') {
    const [, keyId, nonce64, tag64, ciphertext64, extra] = parts;
    if (!keyId || !KEY_ID_RE.test(keyId) || !nonce64 || !tag64 || !ciphertext64 || extra !== undefined) {
      throw new Error('Invalid encrypted token payload');
    }
    const candidateKey = isKeyring ? keyOrKeyring.getKey(keyId) : keyOrKeyring;
    if (!candidateKey) {
      throw new Error(`Unknown encryption key id: ${keyId}`);
    }
    return decryptWithKey(nonce64, tag64, ciphertext64, candidateKey, `v2.${keyId}`);
  }

  const [version, nonce64, tag64, ciphertext64, extra] = parts;
  if (version !== 'v1' || !nonce64 || !tag64 || !ciphertext64 || extra !== undefined) {
    throw new Error('Invalid encrypted token payload');
  }

  const candidateKeys = isKeyring ? keyOrKeyring.allKeys() : [keyOrKeyring];
  let lastError = null;
  for (const candidateKey of candidateKeys) {
    try {
      return decryptWithKey(nonce64, tag64, ciphertext64, candidateKey);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Invalid encrypted token payload');
}

export function rotateEncryptedJson(payload, keyring) {
  if (!keyring || typeof keyring.getKey !== 'function') {
    throw new Error('rotateEncryptedJson requires a parsed encryption keyring');
  }
  const value = decryptJson(payload, keyring);
  const parts = String(payload).split('.');
  if (parts[0] === 'v2' && parts[1] === keyring.activeKeyId) {
    return {
      rotated: false,
      previousVersion: 'v2',
      keyId: keyring.activeKeyId,
      payload: String(payload)
    };
  }
  return {
    rotated: true,
    previousVersion: parts[0],
    keyId: keyring.activeKeyId,
    payload: encryptJson(value, keyring.primaryKey, { keyId: keyring.activeKeyId })
  };
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
