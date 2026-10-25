import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { decryptJson, encryptJson, hashOAuthState, isValidE164, isWithinCustomerWindow, safeEqual, verifyWhatsAppSignature } from '../src/security.js';

const key = crypto.randomBytes(32).toString('base64');

test('encrypts OAuth tokens with authenticated encryption and restores them', () => {
  const tokens = { access_token: 'example', refresh_token: 'do-not-log' };
  const encrypted = encryptJson(tokens, key);
  assert.notEqual(encrypted, JSON.stringify(tokens));
  assert.deepEqual(decryptJson(encrypted, key), tokens);
  assert.throws(() => decryptJson(`${encrypted.slice(0, -2)}aa`, key));
});

test('compares secrets without accepting mismatched values', () => {
  assert.equal(safeEqual('same', 'same'), true);
  assert.equal(safeEqual('same', 'diff'), false);
  assert.equal(safeEqual('short', 'longer'), false);
});

test('hashes OAuth state before persistence', () => {
  assert.match(hashOAuthState('random-state'), /^[a-f0-9]{64}$/);
  assert.notEqual(hashOAuthState('random-state'), 'random-state');
});

test('verifies WhatsApp HMAC signatures against exact raw bytes', () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}');
  const secret = 'test-app-secret';
  const sig = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyWhatsAppSignature(body, sig, secret), true);
  assert.equal(verifyWhatsAppSignature(Buffer.from('tampered'), sig, secret), false);
  assert.equal(verifyWhatsAppSignature(body, 'sha256=bad', secret), false);
});

test('enforces E.164 shape and WhatsApp 24-hour customer window', () => {
  assert.equal(isValidE164('+14155552671'), true);
  assert.equal(isValidE164('14155552671'), false);
  const now = new Date('2026-10-25T12:00:00.000Z');
  assert.equal(isWithinCustomerWindow(new Date('2026-10-25T11:00:00.000Z'), now), true);
  assert.equal(isWithinCustomerWindow(new Date('2026-10-24T11:00:00.000Z'), now), false);
  assert.equal(isWithinCustomerWindow(null, now), false);
});
