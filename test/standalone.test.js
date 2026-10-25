import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../docs/site/demo.html', import.meta.url), 'utf8');
const inlineScript = html.split('<script>')[1]?.split('</script>')[0] || '';
const helpers = inlineScript.split('/* ---------- demo state ---------- */')[0];
const build = new Function('crypto', 'TextEncoder', 'btoa', `${helpers}\nreturn { sha256, hex, hmac, enc };`);
const { sha256, hex, hmac, enc } = build(crypto.webcrypto, TextEncoder, (s) => Buffer.from(s, 'binary').toString('base64'));

test('the public browser demo is truly self-contained', () => {
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /AES-256-GCM/);
  assert.match(html, /HMAC-SHA256/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+href="https?:/i);
  assert.doesNotMatch(html, /fetch\(/);
  assert.match(html, /data-act="connect"/);
  assert.match(html, /data-act="inbound"/);
});

test('its pure-JS SHA-256 matches Node crypto on multiple vectors', () => {
  for (const value of ['', 'abc', 'hello world', 'مرحبًا بالعالم 2026', '{"object":"whatsapp_business_account"}']) {
    assert.equal(hex(sha256(enc.encode(value))), crypto.createHash('sha256').update(value, 'utf8').digest('hex'));
  }
});

test('its HMAC-SHA256 matches Node crypto, so signature verification is real', () => {
  const secret = 'demo-app-secret';
  for (const body of ['{"object":"whatsapp_business_account"}', 'رسالة عربية', 'x'.repeat(1000)]) {
    assert.equal(
      hex(hmac(enc.encode(secret), enc.encode(body))),
      crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')
    );
  }
});
