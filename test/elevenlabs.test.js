import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVoiceEngine,
  loadVoiceConfig,
  voiceFingerprint,
  VoiceError
} from '../src/elevenlabs.js';

const ENV = Object.freeze({
  ELEVENLABS_API_KEY: 'eleven-secret-abcdef123456',
  CELIA_VOICE_ID: 'voice-secret-id-21bcd'
});

function config(overrides = {}) {
  return loadVoiceConfig({ ...ENV, ...overrides });
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function audioResponse(bytes = [1, 2, 3, 4]) {
  return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
}

function subscription(used = 2500, limit = 10000) {
  return {
    character_count: used,
    character_limit: limit,
    next_character_count_reset_unix: 1761955200,
    tier: 'free'
  };
}

test('T1-01 loadVoiceConfig applies safe defaults, env overrides, and strips wrapping quotes', () => {
  const cfg = config();
  assert.equal(cfg.apiKey, ENV.ELEVENLABS_API_KEY);
  assert.equal(cfg.voiceId, ENV.CELIA_VOICE_ID);
  assert.equal(cfg.modelId, 'eleven_flash_v2_5');
  assert.equal(cfg.baseUrl, 'https://api.elevenlabs.io/v1/');
  assert.equal(cfg.maxCharsPerMessage, 250);
  assert.equal(cfg.dailyCharBudget, 600);
  assert.equal(cfg.outputFormat, 'mp3_44100_128');

  const custom = config({
    ELEVENLABS_API_KEY: '"quoted-key-123456"',
    ELEVENLABS_MODEL_ID: 'eleven_multilingual_v2',
    VOICE_MAX_CHARS_PER_MESSAGE: '120',
    VOICE_DAILY_CHAR_BUDGET: '300'
  });
  assert.equal(custom.apiKey, 'quoted-key-123456');
  assert.equal(custom.modelId, 'eleven_multilingual_v2');
  assert.equal(custom.maxCharsPerMessage, 120);
  assert.equal(custom.dailyCharBudget, 300);
  assert.throws(() => config({ ELEVENLABS_BASE_URL: 'http://evil.example.com/v1' }), /HTTPS/);
});

test('T1-02 the SHA-256 fingerprint is deterministic and changes with text, model, or voice', () => {
  const a = voiceFingerprint({ voiceId: 'v', modelId: 'm', text: 'مرحبًا' });
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, voiceFingerprint({ voiceId: 'v', modelId: 'm', text: 'مرحبًا' }));
  assert.notEqual(a, voiceFingerprint({ voiceId: 'v', modelId: 'm', text: 'مساء الخير' }));
  assert.notEqual(a, voiceFingerprint({ voiceId: 'v2', modelId: 'm', text: 'مرحبًا' }));
  assert.notEqual(a, voiceFingerprint({ voiceId: 'v', modelId: 'm2', text: 'مرحبًا' }));
});

test('T1-03 speak sends the key in a header only and returns MP3 base64 with the correct character count', async () => {
  const calls = [];
  const engine = createVoiceEngine({
    config: config(),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return audioResponse([10, 20, 30]);
    }
  });
  const result = await engine.speak({ text: 'أهلًا بك' });
  assert.equal(result.provider, 'elevenlabs');
  assert.equal(result.cached, false);
  assert.equal(result.charsConsumed, 'أهلًا بك'.length);
  assert.equal(result.audioBase64, Buffer.from([10, 20, 30]).toString('base64'));
  assert.equal(result.mimeType, 'audio/mpeg');
  assert.equal(result.fallback, false);
  assert.equal(result.remainingToday, 600 - 'أهلًا بك'.length);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.includes(ENV.ELEVENLABS_API_KEY), false);
  assert.equal(calls[0].url.includes('/v1/text-to-speech/voice-secret-id-21bcd'), true);
  assert.match(calls[0].url, /output_format=mp3_44100_128/);
  assert.equal(calls[0].options.headers['xi-api-key'], ENV.ELEVENLABS_API_KEY);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model_id, 'eleven_flash_v2_5');
  assert.equal(body.text, 'أهلًا بك');
  assert.equal(calls[0].options.body.includes(ENV.ELEVENLABS_API_KEY), false);
  assert.ok(calls[0].options.signal);
});

test('T1-04 a repeated sentence is served from the cache with ZERO characters consumed', async () => {
  let calls = 0;
  const engine = createVoiceEngine({
    config: config(),
    fetchImpl: async () => {
      calls += 1;
      return audioResponse([7]);
    }
  });
  const first = await engine.speak({ text: 'مرحبًا سيليا' });
  const second = await engine.speak({ text: 'مرحبًا سيليا' });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.charsConsumed, 0);
  assert.equal(second.audioBase64, first.audioBase64);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(calls, 1);
  assert.equal(engine.status().cache.hits, 1);
  assert.equal(engine.status().usedToday, 'مرحبًا سيليا'.length);
});

test('T1-05 long text falls back to the free browser voice with the FULL text (no truncation, no API call)', async () => {
  let calls = 0;
  const engine = createVoiceEngine({
    config: config({ VOICE_MAX_CHARS_PER_MESSAGE: '20' }),
    fetchImpl: async () => {
      calls += 1;
      return audioResponse();
    }
  });
  const longText = 'هذا النص أطول من عشرين حرفًا ولذلك يجب أن يُنطق مجانًا عبر المتصفح بالكامل دون بتر.';
  const result = await engine.speak({ text: longText });
  assert.equal(result.provider, 'web-speech-ar-EG');
  assert.equal(result.locale, 'ar-EG');
  assert.equal(result.text, longText);
  assert.equal(result.charsConsumed, 0);
  assert.equal(result.reason, 'text_too_long');
  assert.equal(calls, 0);
});

test('T1-06 the daily budget is enforced and never exceeded', async () => {
  let calls = 0;
  const engine = createVoiceEngine({
    config: config({ VOICE_DAILY_CHAR_BUDGET: '10', VOICE_MAX_CHARS_PER_MESSAGE: '100' }),
    fetchImpl: async () => {
      calls += 1;
      return audioResponse([9]);
    }
  });
  const first = await engine.speak({ text: '123456' });
  assert.equal(first.charsConsumed, 6);
  // نص مختلف (ليس من الكاش) حتى يُختبر السقف اليومي فعلًا.
  const second = await engine.speak({ text: 'abcdef' });
  assert.equal(second.provider, 'web-speech-ar-EG');
  assert.equal(second.reason, 'daily_budget_exhausted');
  assert.equal(second.charsConsumed, 0);
  assert.equal(calls, 1);
  assert.equal(engine.status().usedToday, 6);
  assert.equal(engine.status().remainingToday, 4);
});

test('T1-07 quota() reads the free character balance without generating any audio', async () => {
  const urls = [];
  const engine = createVoiceEngine({
    config: config(),
    fetchImpl: async (url) => {
      urls.push(String(url));
      return jsonResponse(subscription(2500, 10000));
    }
  });
  const result = await engine.quota();
  assert.equal(result.available, true);
  assert.equal(result.used, 2500);
  assert.equal(result.limit, 10000);
  assert.equal(result.remaining, 7500);
  assert.equal(result.remainingPct, 75);
  assert.equal(result.tier, 'free');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.dailyBudget.used, 0);
  assert.equal(urls[0], 'https://api.elevenlabs.io/v1/user/subscription');
  for (const secret of Object.values(ENV)) assert.equal(JSON.stringify(result).includes(secret), false);
});

test('T1-08 quota() with no key returns a graceful result and performs no network call', async () => {
  const engine = createVoiceEngine({
    config: loadVoiceConfig({}),
    fetchImpl: async () => {
      throw new Error('must not be called');
    }
  });
  const result = await engine.quota();
  assert.equal(result.available, false);
  assert.equal(result.reason, 'not_configured');
  const speaking = await engine.speak({ text: 'مرحبًا' });
  assert.equal(speaking.provider, 'web-speech-ar-EG');
  assert.equal(speaking.reason, 'not_configured');
});

test('T1-09 a rejected key triggers cooldown and all later speech uses the free fallback', async () => {
  let calls = 0;
  const engine = createVoiceEngine({
    config: config(),
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ detail: { message: `bad key ${ENV.ELEVENLABS_API_KEY}` } }, 401);
    }
  });
  const result = await engine.quota();
  assert.equal(result.available, false);
  assert.equal(result.reason, 'key_rejected');
  assert.equal(result.httpStatus, 401);
  assert.equal(engine.status().inCooldown, true);
  assert.equal(calls, 2); // xi-api-key ثم Bearer
  const speaking = await engine.speak({ text: 'مرحبًا' });
  assert.equal(speaking.reason, 'provider_cooldown');
  assert.equal(calls, 2); // لا استدعاء جديد أثناء التهدئة
  assert.equal(JSON.stringify(result).includes(ENV.ELEVENLABS_API_KEY), false);
});

test('T1-10 HTTP 429 returns the browser fallback and activates cooldown', async () => {
  const engine = createVoiceEngine({ config: config(), fetchImpl: async () => jsonResponse({}, 429) });
  const result = await engine.speak({ text: 'مرحبًا' });
  assert.equal(result.provider, 'web-speech-ar-EG');
  assert.equal(result.reason, 'rate_limited');
  assert.equal(result.charsConsumed, 0);
  assert.equal(engine.status().inCooldown, true);
});

test('T1-11 timeouts and 5xx errors are sanitized: no URL, body, or key in the thrown error', async () => {
  const timeoutEngine = createVoiceEngine({
    config: config(),
    fetchImpl: async () => {
      const error = new Error(`socket hang up https://api.elevenlabs.io/v1?key=${ENV.ELEVENLABS_API_KEY}`);
      error.name = 'TimeoutError';
      throw error;
    }
  });
  await assert.rejects(timeoutEngine.speak({ text: 'مرحبًا' }), (error) => {
    assert.ok(error instanceof VoiceError);
    assert.equal(error.code, 'timeout');
    assert.equal(error.message.includes(ENV.ELEVENLABS_API_KEY), false);
    assert.equal(error.message.includes('elevenlabs.io'), false);
    return true;
  });

  const serverEngine = createVoiceEngine({
    config: config(),
    fetchImpl: async () => jsonResponse({ detail: `leak ${ENV.ELEVENLABS_API_KEY}` }, 500)
  });
  await assert.rejects(serverEngine.speak({ text: 'مرحبًا' }), (error) => {
    assert.equal(error.code, 'provider_error');
    assert.equal(error.status, 500);
    assert.equal(error.message.includes(ENV.ELEVENLABS_API_KEY), false);
    return true;
  });
});

test('T1-12 quota() degrades gracefully on malformed subscription payloads and tier injection', async () => {
  const malformed = createVoiceEngine({ config: config(), fetchImpl: async () => jsonResponse({ character_count: 'x' }) });
  assert.equal((await malformed.quota()).reason, 'unexpected_subscription_shape');

  // حقنة tier هدفها التأكد من تصفية النص الحر القادم من المزوّد.
  const tierEngine = createVoiceEngine({
    config: config(),
    fetchImpl: async () => jsonResponse({ ...subscription(), tier: `free ${ENV.ELEVENLABS_API_KEY}` })
  });
  const result = await tierEngine.quota();
  assert.equal(result.tier, 'unknown');
  assert.equal(JSON.stringify(result).includes(ENV.ELEVENLABS_API_KEY), false);
});

test('T1-13 status() never contains a secret or a voice identifier', () => {
  const engine = createVoiceEngine({ config: config(), fetchImpl: async () => audioResponse() });
  const dump = JSON.stringify(engine.status());
  for (const secret of Object.values(ENV)) assert.equal(dump.includes(secret), false);
  assert.equal(engine.status().configured, true);
  assert.equal(engine.status().browserFallbackProvider, 'web-speech-ar-EG');
});

test('T1-14 the cache respects its maximum size and reset() clears all counters', async () => {
  const engine = createVoiceEngine({
    config: config({ VOICE_CACHE_MAX_ENTRIES: '2' }),
    fetchImpl: async () => audioResponse([1])
  });
  await engine.speak({ text: 'أ' });
  await engine.speak({ text: 'ب' });
  await engine.speak({ text: 'ج' });
  assert.equal(engine.status().cache.entries, 2);
  assert.equal(engine.status().usedToday, 3);
  engine.reset();
  assert.equal(engine.status().cache.entries, 0);
  assert.equal(engine.status().usedToday, 0);
  assert.equal(engine.status().cache.hits, 0);
});

test('T1-15 empty text is rejected with a clear code', async () => {
  const engine = createVoiceEngine({ config: config(), fetchImpl: async () => audioResponse() });
  await assert.rejects(engine.speak({ text: '   ' }), /text is required/);
  await assert.rejects(engine.speak(), /text is required/);
});
