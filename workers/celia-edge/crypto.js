/**
 * WebCrypto security primitives for the Cloudflare Edge + D1 runtime (DEC-037).
 *
 * Uses standard `crypto.subtle` APIs only so the exact same implementation executes on
 * Cloudflare Workers and in Node.js 22/24 tests without native dependencies.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 1) {
    binary += String.fromCharCode(view[i]);
  }
  return btoa(binary);
}

export function fromBase64(b64) {
  const clean = String(b64 || '').trim();
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function fromBase64Url(b64url) {
  const padded = String(b64url || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return fromBase64(padded + '='.repeat(padLen));
}

export function bytesToHex(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomHex(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function sha256Bytes(input) {
  const data = input instanceof Uint8Array ? input : encoder.encode(String(input ?? ''));
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

export async function sha256Hex(input) {
  return bytesToHex(await sha256Bytes(input));
}

/**
 * Length-hiding constant-time string comparison: hashes both inputs with SHA-256 so
 * neither content differences nor token length differences leak via timing.
 */
export async function constantTimeEqualAsync(a, b) {
  const strA = String(a ?? '');
  const strB = String(b ?? '');
  if (!strA || !strB) return false;
  const [hashA, hashB] = await Promise.all([sha256Bytes(strA), sha256Bytes(strB)]);
  let diff = strA.length === strB.length ? 0 : 1;
  for (let i = 0; i < hashA.length; i += 1) {
    diff |= hashA[i] ^ hashB[i];
  }
  return diff === 0;
}

function constantTimeBytesEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length || a.length === 0) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function deriveHkdfKey(secretText, { salt, info, usage = ['encrypt', 'decrypt'], algorithm = { name: 'AES-GCM', length: 256 } }) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secretText),
    'HKDF',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(salt),
      info: encoder.encode(info)
    },
    baseKey,
    algorithm,
    false,
    usage
  );
}

/**
 * Resolves the active AES-256-GCM key for sealing OAuth tokens in D1:
 * 1. If `TOKEN_ENCRYPTION_KEY` is configured (32 raw bytes in base64), uses it directly.
 * 2. Otherwise, derives a domain-separated 256-bit AES-GCM key via HKDF-SHA-256 from
 *    `CELIA_MCP_API_TOKEN` (>= 32 chars) so zero extra manual secrets are required on
 *    the card-free Cloudflare Edge path while keeping cryptographic domain separation.
 */
export async function resolveEdgeEncryptionKeys(env = {}) {
  const keyring = new Map();
  let activeKeyId = null;

  const explicitB64 = String(env.TOKEN_ENCRYPTION_KEY || '').trim();
  if (explicitB64) {
    let raw;
    try {
      raw = fromBase64(explicitB64);
    } catch {
      throw Object.assign(new Error('invalid_token_encryption_key'), { status: 503 });
    }
    if (raw.byteLength !== 32) {
      throw Object.assign(new Error('invalid_token_encryption_key_length'), { status: 503 });
    }
    const keyId = String(env.TOKEN_ENCRYPTION_KEY_ID || 'explicit').trim();
    const cryptoKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keyring.set(keyId, cryptoKey);
    keyring.set('v1-legacy', cryptoKey);
    activeKeyId = keyId;
  }

  const mcpToken = String(env.CELIA_MCP_API_TOKEN || '').trim();
  if (mcpToken.length >= 32) {
    const derived = await deriveHkdfKey(mcpToken, {
      salt: 'celia-edge-token-key:v1',
      info: 'google-oauth-aes-256-gcm'
    });
    keyring.set('hkdf-mcp', derived);
    if (!activeKeyId) activeKeyId = 'hkdf-mcp';
  }

  if (!activeKeyId || keyring.size === 0) {
    throw Object.assign(new Error('encryption_key_unavailable'), { status: 503 });
  }

  return { activeKeyId, keyring };
}

export async function encryptEdgeJson(value, env = {}) {
  const { activeKeyId, keyring } = await resolveEdgeEncryptionKeys(env);
  const key = keyring.get(activeKeyId);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const aad = encoder.encode(`celia-token-envelope:v2:${activeKeyId}`);
  const plaintext = encoder.encode(JSON.stringify(value));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
      key,
      plaintext
    )
  );
  const ciphertext = sealed.slice(0, sealed.length - 16);
  const tag = sealed.slice(sealed.length - 16);
  return ['v2', activeKeyId, toBase64(iv), toBase64(tag), toBase64(ciphertext)].join('.');
}

export async function decryptEdgeJson(payload, env = {}) {
  const parts = String(payload || '').split('.');
  const { keyring } = await resolveEdgeEncryptionKeys(env);

  if (parts[0] === 'v2' && parts.length === 5) {
    const [, keyId, ivB64, tagB64, dataB64] = parts;
    const key = keyring.get(keyId);
    if (!key) {
      throw Object.assign(new Error(`unknown_encryption_key_id:${keyId}`), { status: 500 });
    }
    const iv = fromBase64(ivB64);
    const tag = fromBase64(tagB64);
    const ciphertext = fromBase64(dataB64);
    if (iv.length !== 12 || tag.length !== 16) {
      throw Object.assign(new Error('malformed_encrypted_envelope'), { status: 500 });
    }
    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext, 0);
    combined.set(tag, ciphertext.length);
    const aad = encoder.encode(`celia-token-envelope:v2:${keyId}`);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
      key,
      combined
    );
    return JSON.parse(decoder.decode(plain));
  }

  if (parts[0] === 'v1' && parts.length === 4) {
    const [, ivB64, tagB64, dataB64] = parts;
    const iv = fromBase64(ivB64);
    const tag = fromBase64(tagB64);
    const ciphertext = fromBase64(dataB64);
    if (iv.length !== 12 || tag.length !== 16) {
      throw Object.assign(new Error('malformed_encrypted_envelope'), { status: 500 });
    }
    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext, 0);
    combined.set(tag, ciphertext.length);
    for (const candidateKey of keyring.values()) {
      try {
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv, tagLength: 128 },
          candidateKey,
          combined
        );
        return JSON.parse(decoder.decode(plain));
      } catch {
        /* try next key */
      }
    }
    throw Object.assign(new Error('decryption_failed'), { status: 500 });
  }

  throw Object.assign(new Error('unsupported_encrypted_payload'), { status: 500 });
}

/**
 * Verifies Meta's `X-Hub-Signature-256: sha256=<hex>` header over the exact raw request bytes.
 */
export async function verifyWhatsAppSignatureWeb(rawBytes, signatureHeader, appSecret) {
  const secret = String(appSecret || '').trim();
  const header = String(signatureHeader || '').trim();
  if (!secret || !header.startsWith('sha256=')) return false;
  const hex = header.slice(7);
  if (!/^[a-f0-9]{64}$/i.test(hex)) return false;
  const expected = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    expected[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const bytes = rawBytes instanceof Uint8Array ? rawBytes : encoder.encode(String(rawBytes ?? ''));
  const actual = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, bytes));
  return constantTimeBytesEqual(actual, expected);
}

/**
 * Short-lived HMAC-signed browser ticket so «اربط جوجل» can open `/auth/google?ticket=...`
 * in the owner's mobile browser without ever putting `CELIA_MCP_API_TOKEN` in a URL.
 */
export async function mintEdgeConsentTicket(env = {}, { userId = 'owner', ttlSeconds = 600, nowMs = Date.now() } = {}) {
  const mcpToken = String(env.CELIA_MCP_API_TOKEN || '').trim();
  if (mcpToken.length < 32) {
    throw Object.assign(new Error('owner_token_not_configured'), { status: 503 });
  }
  const hmacKey = await deriveHkdfKey(mcpToken, {
    salt: 'celia-edge-consent-ticket:v1',
    info: 'google-oauth-browser-ticket',
    usage: ['sign'],
    algorithm: { name: 'HMAC', hash: 'SHA-256', length: 256 }
  });
  const payload = {
    sub: userId,
    exp: Math.floor(nowMs / 1000) + ttlSeconds,
    nonce: randomHex(12)
  };
  const bodyPart = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(bodyPart)));
  return `${bodyPart}.${toBase64Url(sigBytes)}`;
}

export async function verifyEdgeConsentTicket(env = {}, ticket = '', { nowMs = Date.now() } = {}) {
  const mcpToken = String(env.CELIA_MCP_API_TOKEN || '').trim();
  if (mcpToken.length < 32 || typeof ticket !== 'string') return { ok: false, reason: 'invalid_ticket' };
  const parts = ticket.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'invalid_ticket' };
  let expectedSig;
  let payload;
  try {
    expectedSig = fromBase64Url(parts[1]);
    payload = JSON.parse(decoder.decode(fromBase64Url(parts[0])));
  } catch {
    return { ok: false, reason: 'invalid_ticket' };
  }
  const hmacKey = await deriveHkdfKey(mcpToken, {
    salt: 'celia-edge-consent-ticket:v1',
    info: 'google-oauth-browser-ticket',
    usage: ['sign'],
    algorithm: { name: 'HMAC', hash: 'SHA-256', length: 256 }
  });
  const actualSig = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(parts[0])));
  if (!constantTimeBytesEqual(actualSig, expectedSig)) {
    return { ok: false, reason: 'invalid_ticket_signature' };
  }
  if (!payload?.exp || Math.floor(nowMs / 1000) > Number(payload.exp)) {
    return { ok: false, reason: 'expired_ticket' };
  }
  return { ok: true, userId: String(payload.sub || 'owner') };
}
