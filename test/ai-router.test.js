import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AiRouterError,
  classifyTask,
  createAiRouter,
  loadAiRouterConfig,
  normalizeProviderBaseUrl
} from '../src/ai-router.js';

const KEYS = Object.freeze({
  gemini: 'gem-key-abcdef123456',
  agent: 'agent-key-abcdef123456',
  deep: 'deep-key-abcdef123456'
});

function makeConfig(overrides = {}) {
  return loadAiRouterConfig({
    GEMINI_API_KEY: KEYS.gemini,
    // الاسم الحرفي الخاطئ الموجود فعلًا في GitHub Secrets.
    AGENETROUTERAPI_KEY: KEYS.agent,
    DEEPSEEK_API_KEY: KEYS.deep,
    ...overrides
  });
}

function jsonResponse(body, { ok = true, status = 200, retryAfter = null } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) },
    json: async () => body
  };
}

function geminiBody(text) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

function openAiBody(text) {
  return { choices: [{ message: { content: text } }] };
}

test('loadAiRouterConfig reads the misspelled AGENETROUTERAPI_KEY and prefers the correct name when both exist', () => {
  const typoConfig = makeConfig();
  assert.equal(typoConfig.agentRouter.apiKey, KEYS.agent);
  assert.equal(typoConfig.agentRouter.apiKeySource, 'AGENETROUTERAPI_KEY');
  assert.equal(typoConfig.agentRouter.baseUrl, 'https://agentrouter.org/v1/');
  assert.equal(typoConfig.deepseek.baseUrl, 'https://api.deepseek.com/v1/');
  assert.equal(typoConfig.gemini.model, 'gemini-2.5-flash');

  const both = makeConfig({ AGENTROUTER_API_KEY: 'correct-name-key-12345678' });
  assert.equal(both.agentRouter.apiKey, 'correct-name-key-12345678');
  assert.equal(both.agentRouter.apiKeySource, 'AGENTROUTER_API_KEY');
});

test('normalizeProviderBaseUrl blocks insecure SSRF-prone URLs and embedded credentials', () => {
  assert.equal(normalizeProviderBaseUrl('https://api.example.com/v1', 'https://agentrouter.org/v1'), 'https://api.example.com/v1/');
  assert.equal(normalizeProviderBaseUrl('http://127.0.0.1:9999/v1', 'https://agentrouter.org/v1'), 'http://127.0.0.1:9999/v1/');
  assert.throws(() => normalizeProviderBaseUrl('http://evil.example.com/v1', 'https://agentrouter.org/v1'), /HTTPS/);
  assert.throws(() => normalizeProviderBaseUrl('https://user:pass@api.example.com/v1', 'https://agentrouter.org/v1'), /credentials/);
  assert.throws(() => normalizeProviderBaseUrl('file:///etc/passwd', 'https://agentrouter.org/v1'), /HTTPS/);
  assert.throws(() => normalizeProviderBaseUrl('not a url', 'https://agentrouter.org/v1'));
});

test('classifyTask separates short customer replies from coding/planning tasks', () => {
  assert.equal(classifyTask({ prompt: 'مرحبًا، ما هي مواعيد العمل؟' }), 'fast');
  assert.equal(classifyTask({ task: 'fast', prompt: '```function x(){}```' }), 'fast');
  assert.equal(classifyTask({ prompt: 'اكتب كود دالة JavaScript لجمع مصفوفة' }), 'deep');
  assert.equal(classifyTask({ task: 'deep', prompt: 'مرحبًا' }), 'deep');
  assert.equal(classifyTask({ prompt: 'كلمة '.repeat(305) }), 'deep');
  assert.throws(() => classifyTask({ task: 'unknown' }), /Unknown task/);
});

test('status() exposes only non-secret diagnostics and the two routing chains', () => {
  const router = createAiRouter({ config: makeConfig() });
  const snapshot = JSON.stringify(router.status());
  for (const secret of Object.values(KEYS)) assert.equal(snapshot.includes(secret), false);
  assert.deepEqual(router.status().chains.fast, ['gemini', 'agentrouter', 'ollama', 'local']);
  assert.deepEqual(router.status().chains.deep, ['deepseek', 'agentrouter', 'gemini', 'ollama']);
  assert.equal(router.status().providers.agentRouter.configured, true);
  assert.equal(router.status().providers.agentRouter.apiKeySource, 'AGENETROUTERAPI_KEY');
});

test('fast task uses Gemini first, sends the key in a header only, and never returns it', async () => {
  const calls = [];
  const router = createAiRouter({
    config: makeConfig(),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse(geminiBody('مرحبًا! يسعدنا خدمتك.'));
    }
  });

  const result = await router.generate({ customerMessage: 'ما هي الخدمات؟' });
  assert.equal(result.provider, 'gemini');
  assert.equal(result.model, 'gemini-2.5-flash');
  assert.equal(result.task, 'fast');
  assert.equal(result.reply, 'مرحبًا! يسعدنا خدمتك.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.includes(KEYS.gemini), false);
  assert.equal(calls[0].url.includes('generateContent'), true);
  assert.equal(calls[0].options.headers['x-goog-api-key'], KEYS.gemini);
  assert.equal(calls[0].options.body.includes(KEYS.gemini), false);
  assert.match(calls[0].options.signal?.constructor?.name || '', /AbortSignal/);
});

test('Gemini 429 triggers cooldown and automatic failover to AgentRouter (then skips Gemini while cooling)', async () => {
  const calls = [];
  const router = createAiRouter({
    config: makeConfig(),
    fetchImpl: async (url, options) => {
      const target = String(url);
      calls.push(target);
      if (target.includes('generativelanguage.googleapis.com')) {
        return jsonResponse({ error: { message: `bad key ${KEYS.gemini}` } }, { ok: false, status: 429, retryAfter: '120' });
      }
      if (target.includes('agentrouter.org/v1/chat/completions')) {
        assert.equal(options.headers.authorization, `Bearer ${KEYS.agent}`);
        return jsonResponse(openAiBody('رد من AgentRouter'));
      }
      throw new Error(`Unexpected URL: ${target}`);
    }
  });

  const first = await router.generate({ prompt: 'مرحبًا' });
  assert.equal(first.provider, 'agentrouter');
  assert.equal(first.model, 'glm-4.5-air');
  assert.deepEqual(first.attempts, [{ provider: 'gemini', model: null, status: 429, reason: 'http_429' }]);
  assert.ok(calls.some((url) => url.includes('generativelanguage.googleapis.com')));

  const cooldown = router.status().providers.gemini;
  assert.equal(cooldown.inCooldown, true);
  assert.ok(cooldown.cooldownRemainingMs >= 119_000);

  const second = await router.generate({ prompt: 'سؤال ثانٍ' });
  assert.equal(second.provider, 'agentrouter');
  assert.deepEqual(second.attempts, [{ provider: 'gemini', reason: 'cooldown' }]);
  assert.equal(calls.filter((url) => url.includes('generativelanguage.googleapis.com')).length, 1);

  router.resetCooldowns();
  assert.equal(router.status().providers.gemini.inCooldown, false);
});

test('Gemini 404 retries the next free model before leaving the provider', async () => {
  const models = [];
  const router = createAiRouter({
    config: makeConfig(),
    fetchImpl: async (url) => {
      const model = /\/models\/([^:]+):/.exec(String(url))?.[1];
      models.push(model);
      if (model === 'gemini-2.5-flash') return jsonResponse({}, { ok: false, status: 404 });
      return jsonResponse(geminiBody('رد من النموذج الاحتياطي'));
    }
  });
  const result = await router.generate({ prompt: 'مرحبًا' });
  assert.equal(result.provider, 'gemini');
  assert.equal(result.model, 'gemini-flash-latest');
  assert.deepEqual(models, ['gemini-2.5-flash', 'gemini-flash-latest']);
});

test('deep task starts with DeepSeek V3 and uses the reasoning policy', async () => {
  const calls = [];
  const router = createAiRouter({
    config: makeConfig({ DEEPSEEK_MODEL: 'deepseek-reasoner' }),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse(openAiBody('function sum(a) { return a + b; }'));
    }
  });
  const result = await router.generate({ task: 'deep', prompt: 'اكتب كود دالة جمع آمنة' });
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.model, 'deepseek-reasoner');
  assert.equal(result.task, 'deep');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${KEYS.deep}`);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 2048);
  assert.match(body.messages[0].content, /مهندس برمجيات/);
});

test('the local guard is the free last resort when all cloud providers are unavailable', async () => {
  const config = loadAiRouterConfig({});
  const router = createAiRouter({
    config,
    fetchImpl: async () => {
      const error = new Error('connection refused');
      error.name = 'TypeError';
      throw error;
    }
  });
  const result = await router.generate({ customerMessage: 'كم سعر الاشتراك؟' });
  assert.equal(result.provider, 'local');
  assert.equal(result.model, 'celia-guard-ar-2026');
  assert.match(result.reply, /ممثلي خدمة العملاء/);
  assert.deepEqual(result.attempts, [
    { provider: 'gemini', reason: 'not_configured' },
    { provider: 'agentrouter', reason: 'not_configured' },
    { provider: 'ollama', model: null, status: null, reason: 'network_error' }
  ]);
});

test('timeouts and HTTP errors are sanitized: no response body, URL, or key ever reaches the error', async () => {
  const router = createAiRouter({
    config: makeConfig(),
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes('generativelanguage.googleapis.com')) {
        const error = new Error(`fetch failed for ${target}?key=${KEYS.gemini}`);
        error.name = 'TimeoutError';
        throw error;
      }
      if (target.includes('ollama') || target.includes('11434')) {
        return jsonResponse({ error: `invalid ${KEYS.agent}` }, { ok: false, status: 500 });
      }
      return jsonResponse({ error: { message: `leak ${KEYS.deep}` } }, { ok: false, status: 503 });
    }
  });

  const result = await router.generate({ prompt: 'مرحبًا' });
  assert.equal(result.provider, 'local');
  const reasons = result.attempts.map((attempt) => attempt.reason);
  // سلسلة fast: Gemini (timeout) → AgentRouter (503) → Ollama (500) → الحارس المحلي.
  assert.deepEqual(reasons, ['timeout', 'http_503', 'http_500']);

  await assert.rejects(
    router.generate({ task: 'deep', prompt: 'صمّم واجهة' }),
    (error) => {
      assert.ok(error instanceof AiRouterError);
      assert.equal(error.code, 'all_providers_failed');
      assert.equal(error.attempts.length, 4);
      for (const secret of Object.values(KEYS)) assert.equal(error.message.includes(secret), false);
      return true;
    }
  );
});

test('provider echoes the secret in its reply → redacted before it leaves the router', async () => {
  const router = createAiRouter({
    config: makeConfig(),
    fetchImpl: async () => jsonResponse(geminiBody(`المفتاح هو ${KEYS.gemini}`))
  });
  const result = await router.generate({ prompt: 'مرحبًا' });
  assert.equal(result.reply.includes(KEYS.gemini), false);
  assert.match(result.reply, /\[REDACTED\]/);
});

test('forcing an unconfigured or unknown provider fails fast with a clear code', async () => {
  const router = createAiRouter({ config: loadAiRouterConfig({}) });
  await assert.rejects(router.generate({ prompt: 'مرحبًا', provider: 'deepseek' }), (error) => {
    assert.equal(error.code, 'provider_not_configured');
    return true;
  });
  await assert.rejects(router.generate({ prompt: 'مرحبًا', provider: 'made-up' }), /Unknown provider/);
  await assert.rejects(router.generate({}), /prompt.*required/);
});
