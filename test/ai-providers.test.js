import test from 'node:test';
import assert from 'node:assert/strict';
import { generateOpenAiCompatibleReply } from '../src/ai-providers.js';

const withFetch = async (impl, run) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await run(); } finally { globalThis.fetch = original; }
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const call = () => generateOpenAiCompatibleReply({ serviceName: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test-value', model: 'deepseek-chat', customerMessage: 'مرحبا' });

test('upstream rejections carry the provider reason (never the key) so operators learn balance/scope/model problems', async () => {
  await withFetch(async () => json(402, { error: { message: 'Insufficient Balance', type: 'unknown_error' } }), async () => {
    const error = await call().catch((caught) => caught);
    assert.equal(error.code, 'UPSTREAM_ERROR');
    assert.equal(error.upstreamStatus, 402);
    assert.equal(error.upstreamDetail, 'Insufficient Balance');
    assert.ok(!JSON.stringify({ ...error, message: error.message }).includes('sk-test-value'));
  });
});

test('an HTTP 200 without choices explains what came back instead of a bare "no usable reply"', async () => {
  await withFetch(async () => json(200, { success: false, message: 'quota exhausted for this key' }), async () => {
    const error = await call().catch((caught) => caught);
    assert.match(error.message, /no usable reply \(no choices in response \(keys: success,message; message: quota exhausted for this key\)\)/);
  });
  await withFetch(async () => json(200, { choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'thinking…' } }] }), async () => {
    const error = await call().catch((caught) => caught);
    assert.match(error.message, /finish_reason=length; reasoning-only output/);
  });
});

test('a normal completion still returns trimmed text', async () => {
  await withFetch(async () => json(200, { choices: [{ message: { content: '  أهلاً بك  ' } }] }), async () => {
    assert.equal(await call(), 'أهلاً بك');
  });
});
