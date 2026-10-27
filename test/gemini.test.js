import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWhatsAppReply } from '../src/gemini.js';

test('Gemini key is sent only in a header and generated candidate text is returned', async () => {
  const previousFetch = globalThis.fetch;
  let requestUrl = '';
  let requestOptions;
  globalThis.fetch = async (url, options) => {
    requestUrl = String(url);
    requestOptions = options;
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'أهلًا، كيف يمكنني مساعدتك؟' }] } }] }) };
  };
  try {
    const reply = await generateWhatsAppReply({
      config: { gemini: { apiKey: 'secret-test-key', model: 'gemini-test', businessContext: '' } },
      customerMessage: 'مرحبا'
    });
    assert.equal(reply, 'أهلًا، كيف يمكنني مساعدتك؟');
    assert.equal(requestUrl.includes('secret-test-key'), false);
    assert.equal(requestOptions.headers['x-goog-api-key'], 'secret-test-key');
    assert.ok(requestOptions.signal instanceof AbortSignal);
    const body = JSON.parse(requestOptions.body);
    assert.equal(body.contents[0].parts[0].text, 'مرحبا');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Gemini integration refuses to run without an API key', async () => {
  await assert.rejects(generateWhatsAppReply({ config: { gemini: { apiKey: '', model: 'gemini-test', businessContext: '' } }, customerMessage: 'hello' }), /not configured/);
});

test('Gemini request is aborted when its timeout expires', async () => {
  const previousFetch = globalThis.fetch;
  const keepEventLoopAlive = setTimeout(() => {}, 50);
  globalThis.fetch = (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  try {
    await assert.rejects(
      generateWhatsAppReply({
        config: { gemini: { apiKey: 'secret-test-key', model: 'gemini-test', businessContext: '' } },
        customerMessage: 'hello',
        timeoutMs: 5
      }),
      { name: 'TimeoutError' }
    );
  } finally {
    globalThis.fetch = previousFetch;
    clearTimeout(keepEventLoopAlive);
  }
});
