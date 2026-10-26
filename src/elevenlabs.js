/**
 * محرك صوت سيليا الاقتصادي — المهمة T1 (المرحلة 2)
 * ------------------------------------------------------------------
 * الهدف: صوت عربي حقيقي بتكلفة صفرية تقريبًا على الحصة المجانية.
 *
 *  1) quota()  → GET /v1/user/subscription  (يستهلك 0 حرف، يعرض النسبة المتبقية)
 *  2) speak()  → كاش SHA-256: الجملة المنطوقة سابقًا تُعاد فوراً بـ 0 حرف
 *  3) سقف يومي صارم + حد أقصى لكل رسالة، مع تحويل تلقائي لنطق المتصفح (Web Speech ar-EG)
 *  4) POST /v1/text-to-speech/{voiceId} بنموذج eleven_flash_v2_5 (0.5 نقطة/حرف)
 *
 * قواعد الأمان: المفتاح في الترويسة فقط، لا تُطبع استجابة المزوّد، ولا معرّف الصوت،
 * ولا أي رسالة خطأ قادمة من الشبكة. كل الأخطاء مصنّفة ومطهّرة مسبقًا.
 */

import crypto from 'node:crypto';
import { normalizeProviderBaseUrl } from './ai-router.js';

export const DEFAULT_VOICE_MODEL = 'eleven_flash_v2_5';
export const BROWSER_VOICE_PROVIDER = 'web-speech-ar-EG';
const DEFAULT_BASE_URL = 'https://api.elevenlabs.io/v1';

export class VoiceError extends Error {
  constructor(message, { code = 'voice_error', status = 0 } = {}) {
    super(message);
    this.name = 'VoiceError';
    this.code = code;
    this.status = status;
  }
}

function boundedInt(raw, fallback, min, max) {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function loadVoiceConfig(env = process.env) {
  let apiKey = clean(env.ELEVENLABS_API_KEY);
  if (apiKey.length >= 2 && ((apiKey.startsWith('"') && apiKey.endsWith('"')) || (apiKey.startsWith("'") && apiKey.endsWith("'")))) {
    apiKey = apiKey.slice(1, -1).trim();
  }
  return Object.freeze({
    apiKey,
    voiceId: clean(env.CELIA_VOICE_ID),
    modelId: clean(env.ELEVENLABS_MODEL_ID) || DEFAULT_VOICE_MODEL,
    baseUrl: normalizeProviderBaseUrl(env.ELEVENLABS_BASE_URL, DEFAULT_BASE_URL),
    outputFormat: 'mp3_44100_128',
    maxCharsPerMessage: boundedInt(env.VOICE_MAX_CHARS_PER_MESSAGE, 250, 10, 1000),
    dailyCharBudget: boundedInt(env.VOICE_DAILY_CHAR_BUDGET, 600, 10, 100_000),
    cacheMaxEntries: boundedInt(env.VOICE_CACHE_MAX_ENTRIES, 200, 2, 5000),
    cooldownMs: boundedInt(env.VOICE_COOLDOWN_MS, 60_000, 1000, 3_600_000),
    timeoutMs: boundedInt(env.VOICE_TIMEOUT_MS, 15_000, 1000, 120_000)
  });
}

export function voiceFingerprint({ voiceId, modelId, text }) {
  return crypto
    .createHash('sha256')
    .update(`${voiceId}\u0000${modelId}\u0000${text}`)
    .digest('hex');
}

function browserFallback({ text, reason }) {
  return {
    provider: BROWSER_VOICE_PROVIDER,
    model: 'browser-speech-synthesis',
    locale: 'ar-EG',
    cached: false,
    charsConsumed: 0,
    audioBase64: null,
    mimeType: null,
    text,
    fallback: true,
    reason
  };
}

function sanitizeFailure(error) {
  const name = error?.name;
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error';
}

/**
 * ينشئ محركًا يحتفظ بالكاش والسقف اليومي في الذاكرة (لا يحتاج قاعدة بيانات).
 * يمكن تمرير fetchImpl و now للاختبارات الحتمية.
 */
export function createVoiceEngine({ config = loadVoiceConfig(), fetchImpl = null, now = () => Date.now() } = {}) {
  const cache = new Map();
  const dailyUsage = new Map();
  const stats = { hits: 0, misses: 0, synthCalls: 0, quotaCalls: 0 };
  let cooldownUntil = 0;

  function dayKey() {
    return new Date(now()).toISOString().slice(0, 10);
  }

  function usedToday() {
    return dailyUsage.get(dayKey()) || 0;
  }

  function reserve(chars) {
    const key = dayKey();
    dailyUsage.set(key, usedToday() + chars);
    // نحتاج آخر 3 أيام فقط لمنع نمو الذاكرة بلا حدود.
    if (dailyUsage.size > 3) {
      const oldest = [...dailyUsage.keys()].sort()[0];
      dailyUsage.delete(oldest);
    }
  }

  function remember(entry) {
    if (cache.size >= config.cacheMaxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(entry.fingerprint, entry);
  }

  function cooldownRemaining() {
    return Math.max(0, cooldownUntil - now());
  }

  function status() {
    return {
      configured: Boolean(config.apiKey && config.voiceId),
      model: config.modelId,
      baseUrl: config.baseUrl,
      maxCharsPerMessage: config.maxCharsPerMessage,
      dailyCharBudget: config.dailyCharBudget,
      usedToday: usedToday(),
      remainingToday: Math.max(0, config.dailyCharBudget - usedToday()),
      cache: { entries: cache.size, maxEntries: config.cacheMaxEntries, hits: stats.hits, misses: stats.misses },
      cooldownRemainingMs: cooldownRemaining(),
      inCooldown: cooldownRemaining() > 0,
      browserFallbackProvider: BROWSER_VOICE_PROVIDER
    };
  }

  async function request({ path, method = 'GET', headers, body, expectAudio = false }) {
    const doFetch = fetchImpl || globalThis.fetch;
    let response;
    try {
      response = await doFetch(new URL(path, config.baseUrl).href, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(config.timeoutMs)
      });
    } catch (error) {
      return { status: 0, payload: null, audio: null, reason: sanitizeFailure(error) };
    }
    const status = Number.isInteger(response?.status) ? response.status : response?.ok ? 200 : 0;
    if (expectAudio && status >= 200 && status < 300) {
      try {
        const buffer = await response.arrayBuffer();
        return { status, payload: null, audio: Buffer.from(buffer), reason: null };
      } catch {
        return { status, payload: null, audio: null, reason: 'invalid_audio' };
      }
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { status, payload, audio: null, reason: null };
  }

  /**
   * قراءة الحصة المجانية: لا تُنتج صوتًا ولا تستهلك أي حرف.
   * تُعيد دائمًا كائنًا (لا ترمي استثناءً) حتى تظهر في MCP كنتيجة قابلة للعرض.
   */
  async function quota() {
    stats.quotaCalls += 1;
    const daily = { used: usedToday(), limit: config.dailyCharBudget, remaining: Math.max(0, config.dailyCharBudget - usedToday()) };
    const base = {
      provider: 'elevenlabs',
      available: false,
      model: config.modelId,
      dailyBudget: daily,
      cache: { entries: cache.size, hits: stats.hits, misses: stats.misses }
    };
    if (!config.apiKey) return { ...base, reason: 'not_configured' };

    let result = await request({ path: 'user/subscription', headers: { 'xi-api-key': config.apiKey, accept: 'application/json' } });
    if (result.status === 401 || result.status === 403) {
      const bearer = await request({ path: 'user/subscription', headers: { authorization: `Bearer ${config.apiKey}`, accept: 'application/json' } });
      if (bearer.status >= 200 && bearer.status < 300) result = bearer;
    }
    if (result.status === 0) return { ...base, reason: result.reason, httpStatus: 0 };
    if (result.status === 401 || result.status === 403) {
      cooldownUntil = now() + config.cooldownMs;
      return { ...base, reason: 'key_rejected', httpStatus: result.status };
    }
    if (result.status >= 400) return { ...base, reason: `http_${result.status}`, httpStatus: result.status };

    const payload = result.payload || {};
    const used = Number(payload.character_count);
    const limit = Number(payload.character_limit);
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
      return { ...base, reason: 'unexpected_subscription_shape', httpStatus: result.status };
    }
    const remaining = Math.max(0, limit - used);
    const resetUnix = Number(payload.next_character_count_reset_unix);
    const rawTier = typeof payload.tier === 'string' ? payload.tier : '';
    return {
      ...base,
      available: true,
      httpStatus: result.status,
      used,
      limit,
      remaining,
      remainingPct: Math.round((remaining / limit) * 1000) / 10,
      resetAt: Number.isFinite(resetUnix) && resetUnix > 0 ? new Date(resetUnix * 1000).toISOString() : null,
      tier: /^[a-z0-9_-]{1,24}$/i.test(rawTier) ? rawTier : 'unknown'
    };
  }

  /** تحويل نص إلى MP3 مع كاش البصمة والسقف اليومي والـ fallback المجاني. */
  async function speak({ text, maxChars } = {}) {
    const fullText = String(text ?? '').trim();
    if (!fullText) throw new VoiceError('text is required', { code: 'missing_text' });
    const limit = boundedInt(maxChars, config.maxCharsPerMessage, 1, config.maxCharsPerMessage);

    // النصوص الطويلة تُترك كاملة لنطق المتصفح المجاني بدل بترها أو حرق الحصة.
    if (fullText.length > limit) {
      return browserFallback({ text: fullText, reason: 'text_too_long' });
    }

    const fingerprint = voiceFingerprint({ voiceId: config.voiceId, modelId: config.modelId, text: fullText });
    const cached = cache.get(fingerprint);
    if (cached) {
      stats.hits += 1;
      return {
        provider: 'elevenlabs',
        model: config.modelId,
        cached: true,
        charsConsumed: 0,
        audioBase64: cached.audioBase64,
        mimeType: 'audio/mpeg',
        text: fullText,
        fingerprint: fingerprint.slice(0, 12),
        fallback: false
      };
    }
    stats.misses += 1;

    if (!config.apiKey || !config.voiceId) {
      return browserFallback({ text: fullText, reason: 'not_configured' });
    }
    if (cooldownRemaining() > 0) {
      return browserFallback({ text: fullText, reason: 'provider_cooldown' });
    }
    if (fullText.length > config.dailyCharBudget - usedToday()) {
      return browserFallback({ text: fullText, reason: 'daily_budget_exhausted' });
    }

    const url = new URL(`text-to-speech/${encodeURIComponent(config.voiceId)}`, config.baseUrl);
    url.searchParams.set('output_format', config.outputFormat);
    stats.synthCalls += 1;
    const doFetch = fetchImpl || globalThis.fetch;
    let response;
    try {
      response = await doFetch(url.href, {
        method: 'POST',
        headers: {
          'xi-api-key': config.apiKey,
          'content-type': 'application/json',
          accept: 'audio/mpeg'
        },
        body: JSON.stringify({
          text: fullText,
          model_id: config.modelId,
          voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.2 }
        }),
        signal: AbortSignal.timeout(config.timeoutMs)
      });
    } catch (error) {
      throw new VoiceError(`Voice synthesis failed: ${sanitizeFailure(error)}`, { code: sanitizeFailure(error) });
    }

    const status = Number.isInteger(response?.status) ? response.status : response?.ok ? 200 : 0;
    if (status === 401 || status === 403 || status === 429) {
      cooldownUntil = now() + config.cooldownMs;
      return browserFallback({
        text: fullText,
        reason: status === 429 ? 'rate_limited' : 'key_rejected'
      });
    }
    if (status === 0 || status >= 400) {
      throw new VoiceError(`Voice synthesis failed: http_${status}`, { code: 'provider_error', status });
    }

    let audioBase64;
    try {
      audioBase64 = Buffer.from(await response.arrayBuffer()).toString('base64');
    } catch {
      throw new VoiceError('Voice synthesis failed: invalid_audio', { code: 'invalid_audio', status });
    }
    if (!audioBase64) throw new VoiceError('Voice synthesis failed: empty_audio', { code: 'empty_audio', status });

    reserve(fullText.length);
    remember({ fingerprint, audioBase64, chars: fullText.length, createdAt: now() });
    return {
      provider: 'elevenlabs',
      model: config.modelId,
      cached: false,
      charsConsumed: fullText.length,
      audioBase64,
      mimeType: 'audio/mpeg',
      text: fullText,
      fingerprint: fingerprint.slice(0, 12),
      fallback: false,
      remainingToday: Math.max(0, config.dailyCharBudget - usedToday())
    };
  }

  function reset() {
    cache.clear();
    dailyUsage.clear();
    cooldownUntil = 0;
    stats.hits = 0;
    stats.misses = 0;
    stats.synthCalls = 0;
    stats.quotaCalls = 0;
  }

  return Object.freeze({ speak, quota, status, reset, config });
}
