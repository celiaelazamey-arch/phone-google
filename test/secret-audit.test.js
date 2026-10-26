import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditExitCode,
  buildAuditNotice,
  collectSecrets,
  parseVoiceQuota,
  redactText,
  renderSummary,
  runSecretAudit
} from '../src/secret-audit.js';

const SECRETS = Object.freeze({
  CELIA_MCP_API_TOKEN: 'm'.repeat(64),
  GEMINI_API_KEY: 'gem-secret-abcdef123456',
  AGENETROUTERAPI_KEY: 'agent-secret-abcdef123456',
  DEEPSEEK_API_KEY: 'deep-secret-abcdef123456',
  ELEVENLABS_API_KEY: 'eleven-secret-abcdef123456',
  CELIA_VOICE_ID: 'voice-secret-id-21bcd',
  FIGMA_ACCESS_TOKEN: 'figma-secret-abcdef123456'
});

function response(body = {}, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function allOkFetch(calls) {
  return async (url, options) => {
    const target = String(url);
    calls.push({ url: target, options });
    if (target.includes('elevenlabs.io/v1/user/subscription')) {
      return response({
        character_count: 2500,
        character_limit: 10000,
        next_character_count_reset_unix: 1761955200,
        tier: 'free'
      });
    }
    if (target.includes('generativelanguage.googleapis.com')) {
      return response({ models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-flash-lite-latest' }] });
    }
    if (target.includes('agentrouter.org') || target.includes('api.deepseek.com')) {
      return response({ data: [{ id: 'model-a' }] });
    }
    return response({ id: 'account' });
  };
}

test('collectSecrets accepts the misspelled AgentRouter name and rejects placeholders', () => {
  const map = collectSecrets(SECRETS);
  assert.equal(map.agentRouter.value, SECRETS.AGENETROUTERAPI_KEY);
  assert.equal(map.agentRouter.source, 'AGENETROUTERAPI_KEY');
  assert.equal(map.gemini.source, 'GEMINI_API_KEY');
  assert.equal(collectSecrets({ GEMINI_API_KEY: 'replace-with-a-real-key' }).gemini.value, '');
  assert.equal(collectSecrets({ GOOGLE_API_KEY: 'fallback-key-123456' }).gemini.source, 'GOOGLE_API_KEY');
});

test('all seven secrets are verified with safe GET probes; the voice quota percentage is computed', async () => {
  const calls = [];
  const report = await runSecretAudit({ env: SECRETS, fetchImpl: allOkFetch(calls) });
  assert.equal(report.total, 7);
  assert.equal(report.configured, 7);
  assert.equal(report.verified, 7);
  assert.deepEqual(
    Object.values(report.providers).map((provider) => provider.state),
    ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']
  );
  assert.equal(report.voiceQuota.used, 2500);
  assert.equal(report.voiceQuota.limit, 10000);
  assert.equal(report.voiceQuota.remaining, 7500);
  assert.equal(report.voiceQuota.remainingPct, 75);
  assert.equal(report.voiceQuota.tier, 'free');
  assert.equal(report.providers.gemini.modelsAvailable, 2);

  // مفاتيح المصادقة في الترويسات فقط، ولا تظهر في أي رابط.
  // استثناء معلوم: CELIA_VOICE_ID معرّف مورد يوضع في مسار /v1/voices/{id} (ليس مفتاح مصادقة)،
  // ولا يُطبع هذا الرابط أبدًا في التقرير أو السجلات — انظر اختبار عدم التسريب أدناه.
  const authSecrets = Object.entries(SECRETS)
    .filter(([name]) => name !== 'CELIA_VOICE_ID')
    .map(([, value]) => value);
  for (const call of calls) {
    for (const secret of authSecrets) assert.equal(call.url.includes(secret), false);
  }
  assert.equal(calls.find((c) => c.url.includes('generativelanguage')).options.headers['x-goog-api-key'], SECRETS.GEMINI_API_KEY);
  assert.equal(calls.find((c) => c.url.includes('agentrouter')).options.headers.authorization, `Bearer ${SECRETS.AGENETROUTERAPI_KEY}`);
  assert.equal(calls.find((c) => c.url.includes('elevenlabs.io/v1/user/subscription')).options.headers['xi-api-key'], SECRETS.ELEVENLABS_API_KEY);
  assert.equal(calls.find((c) => c.url.includes('api.figma.com')).options.headers['X-Figma-Token'], SECRETS.FIGMA_ACCESS_TOKEN);
  assert.equal(calls.every((c) => c.options.signal), true);

  // لا سر في التقرير ولا في الـ Summary.
  const safeJson = JSON.stringify(report);
  const markdown = renderSummary(report, Object.values(SECRETS));
  for (const secret of Object.values(SECRETS)) {
    assert.equal(safeJson.includes(secret), false, `secret leaked into report: ${secret.slice(0, 6)}`);
    assert.equal(markdown.includes(secret), false, `secret leaked into summary: ${secret.slice(0, 6)}`);
  }
  assert.match(markdown, /75%/);
  assert.match(markdown, /🟩/);
  assert.match(markdown, /حصة الصوت المجانية/);
  assert.equal(auditExitCode(report, true), 0);
  assert.equal(auditExitCode(report, false), 0);

  // أمر ::notice:: يجب أن يبقى سليمًا بعد التنظيف، وألا يحمل أي سر.
  const notice = buildAuditNotice(report, Object.values(SECRETS));
  assert.match(notice, /^::notice title=Celia 7-Secret Audit::/);
  assert.match(notice, /verified=7\/7 configured=7\/7 voiceQuotaRemainingPct=75/);
  assert.match(notice, /gemini:ok\(http200\)/);
  const noticePayload = notice.slice(notice.indexOf('Audit::') + 'Audit::'.length);
  assert.equal(noticePayload.includes('::'), false);
  for (const secret of Object.values(SECRETS)) assert.equal(notice.includes(secret), false);
  assert.equal(notice.includes('\n'), false);
  assert.equal(notice.includes('\r'), false);
});

test('missing secrets are reported without any network call; strict mode decides the exit code', async () => {
  const report = await runSecretAudit({
    env: {},
    fetchImpl: async () => {
      throw new Error('must not be called when no secret exists');
    }
  });
  assert.equal(report.configured, 0);
  assert.equal(report.verified, 0);
  assert.equal(report.voiceQuota, null);
  assert.equal(Object.values(report.providers).every((provider) => provider.state === 'missing'), true);
  assert.equal(auditExitCode(report, false), 0);
  assert.equal(auditExitCode(report, true), 1);
  assert.match(renderSummary(report), /غير مضبوط/);
});

test('401/429/timeout/network failures are sanitized and never include a response body, URL, or key', async () => {
  const calls = [];
  const report = await runSecretAudit({
    env: SECRETS,
    fetchImpl: async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.includes('generativelanguage.googleapis.com')) {
        return response({ error: { message: `invalid ${SECRETS.GEMINI_API_KEY}` } }, { status: 401 });
      }
      if (target.includes('agentrouter.org')) {
        return response({ error: `quota ${SECRETS.AGENETROUTERAPI_KEY}` }, { status: 429 });
      }
      if (target.includes('api.deepseek.com')) {
        const error = new Error(`socket hang up ${target}`);
        error.name = 'TimeoutError';
        throw error;
      }
      if (target.includes('elevenlabs')) return response({}, { status: 503 });
      return response({}, { status: 403 });
    }
  });

  assert.equal(report.providers.gemini.state, 'invalid');
  assert.equal(report.providers.agentRouter.state, 'limited');
  assert.equal(report.providers.deepseek.state, 'error');
  assert.equal(report.providers.deepseek.note, 'timeout');
  assert.equal(report.providers.elevenLabs.state, 'error');
  assert.equal(report.providers.figma.state, 'invalid');
  assert.equal(report.voiceQuota, null);
  assert.equal(report.verified, 2); // mcpToken + limited agentRouter

  const dump = JSON.stringify(report) + renderSummary(report, Object.values(SECRETS));
  for (const secret of Object.values(SECRETS)) assert.equal(dump.includes(secret), false);
  assert.equal(dump.includes('socket hang up'), false);
  assert.equal(dump.includes('generativelanguage.googleapis.com'), false);
  assert.equal(calls.some((url) => url.includes('leak')), false);
  assert.equal(auditExitCode(report, true), 1);
});

test('DeepSeek retries the alternate /models path when /v1/models returns 404', async () => {
  const urls = [];
  const report = await runSecretAudit({
    env: { DEEPSEEK_API_KEY: SECRETS.DEEPSEEK_API_KEY },
    fetchImpl: async (url) => {
      urls.push(String(url));
      return String(url).includes('/v1/models') ? response({}, { status: 404 }) : response({ data: [] });
    }
  });
  assert.equal(report.providers.deepseek.state, 'ok');
  assert.deepEqual(urls, ['https://api.deepseek.com/v1/models', 'https://api.deepseek.com/models']);
});

test('the voice ID is never printed and is unverified without the ElevenLabs key', async () => {
  const withoutKey = await runSecretAudit({ env: { CELIA_VOICE_ID: SECRETS.CELIA_VOICE_ID }, fetchImpl: async () => response() });
  assert.equal(withoutKey.providers.voiceId.state, 'unverified');
  assert.equal(withoutKey.providers.voiceId.note, 'needs_elevenlabs_key');

  const urls = [];
  const withKey = await runSecretAudit({
    env: { CELIA_VOICE_ID: SECRETS.CELIA_VOICE_ID, ELEVENLABS_API_KEY: SECRETS.ELEVENLABS_API_KEY },
    fetchImpl: async (url) => {
      urls.push(String(url));
      return response({ voice_id: 'anything' });
    }
  });
  assert.equal(withKey.providers.voiceId.state, 'ok');
  assert.equal(urls.some((url) => url.includes(encodeURIComponent(SECRETS.CELIA_VOICE_ID))), true);
  const dump = JSON.stringify(withKey) + renderSummary(withKey, Object.values(SECRETS));
  assert.equal(dump.includes(SECRETS.CELIA_VOICE_ID), false);
  assert.equal(dump.includes(encodeURIComponent(SECRETS.CELIA_VOICE_ID)), false);
});

test('MCP token length is enforced and an optional live 401 guard is recorded', async () => {
  const short = await runSecretAudit({ env: { CELIA_MCP_API_TOKEN: 'too-short' }, fetchImpl: async () => response() });
  assert.equal(short.providers.mcpToken.state, 'invalid');

  const guarded = await runSecretAudit({
    env: { ...SECRETS, AUDIT_MCP_URL: 'http://127.0.0.1:3010/' },
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/mcp')) {
        assert.equal(options.headers.authorization, 'Bearer invalid-audit-token');
        return response({}, { status: 401 });
      }
      return allOkFetch([])(url, options);
    }
  });
  assert.equal(guarded.providers.mcpToken.state, 'ok');
  assert.equal(guarded.providers.mcpToken.bearerGuard, 'enforced');
});

test('parseVoiceQuota rejects malformed payloads and redactText masks injected secrets', () => {
  assert.equal(parseVoiceQuota(null), null);
  assert.equal(parseVoiceQuota({ character_count: 'x', character_limit: 10 }), null);
  assert.equal(parseVoiceQuota({ character_count: 5, character_limit: 0 }), null);
  assert.equal(parseVoiceQuota({ character_count: 12000, character_limit: 10000 }).remaining, 0);
  assert.equal(parseVoiceQuota({ character_count: 1, character_limit: 10, tier: `free ${SECRETS.GEMINI_API_KEY}` }).tier, 'unknown');
  assert.equal(redactText(`value=${SECRETS.GEMINI_API_KEY}`, Object.values(SECRETS)), 'value=[REDACTED]');
});
