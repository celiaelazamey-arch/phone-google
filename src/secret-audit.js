/**
 * لوحة فحص الأسرار السبعة — المرحلة 4
 * ------------------------------------------------------------------
 * يتحقق من اتصال المفاتيح السبعة باستدعاءات GET/فحص محلي **غير مستهلكة للحصة**:
 *
 *   CELIA_MCP_API_TOKEN  → فحص بنيوي + اختبار Bearer محلي (401) إن توفر AUDIT_MCP_URL
 *   GEMINI_API_KEY       → GET /v1beta/models            (لا توليد نصوص)
 *   AGENETROUTER*        → GET /v1/models               (لا توليد نصوص)
 *   DEEPSEEK_API_KEY     → GET /models                  (لا توليد نصوص)
 *   ELEVENLABS_API_KEY   → GET /v1/user/subscription   (0 حرف صوتي)
 *   CELIA_VOICE_ID       → GET /v1/voices/{id}          (0 حرف صوتي)
 *   FIGMA_ACCESS_TOKEN   → GET /v1/me                   (قراءة مجانية)
 *
 * قواعد الأمان:
 *  - المفتاح دائمًا في ترويسة (header) لا في رابط الاستعلام.
 *  - لا تُطبع استجابة أي مزوّد، ولا رابط، ولا رسالة خطأ قادمة من الشبكة.
 *  - التقرير يحتوي أرقامًا وحالات معرّفة مسبقًا فقط، مع تمويه إضافي لأي قيمة سرية.
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const AUDIT_VERSION = '1.0.0-phase4';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const AGENTROUTER_URL = 'https://agentrouter.org/v1/models';
const DEEPSEEK_URLS = ['https://api.deepseek.com/v1/models', 'https://api.deepseek.com/models'];
const ELEVENLABS_SUBSCRIPTION_URL = 'https://api.elevenlabs.io/v1/user/subscription';
const ELEVENLABS_VOICES_URL = 'https://api.elevenlabs.io/v1/voices';
const FIGMA_URL = 'https://api.figma.com/v1/me';

export const PROVIDER_ORDER = Object.freeze([
  'mcpToken',
  'gemini',
  'agentRouter',
  'deepseek',
  'elevenLabs',
  'voiceId',
  'figma'
]);

export const PROVIDER_LABELS = Object.freeze({
  mcpToken: { secret: 'CELIA_MCP_API_TOKEN', arabic: 'بوابة الحماية الموحّدة (Bearer MCP)', cost: 'مجاني' },
  gemini: { secret: 'GEMINI_API_KEY', arabic: 'محرك الردود اليومي (Gemini)', cost: 'مجاني' },
  agentRouter: { secret: 'AGENETROUTERAPI_KEY / AGENTROUTER_API_KEY', arabic: 'موزّع النماذج المرن (AgentRouter)', cost: 'مجاني' },
  deepseek: { secret: 'DEEPSEEK_API_KEY', arabic: 'محرك التفكير والكود (DeepSeek)', cost: 'للكود فقط' },
  elevenLabs: { secret: 'ELEVENLABS_API_KEY', arabic: 'الهوية الصوتية (ElevenLabs)', cost: 'حصة مجانية' },
  voiceId: { secret: 'CELIA_VOICE_ID', arabic: 'صوت سيليا المخصص', cost: 'مجاني' },
  figma: { secret: 'FIGMA_ACCESS_TOKEN', arabic: 'جسر التصاميم (Figma)', cost: 'قراءة مجانية' }
});

const SECRET_ENV_NAMES = Object.freeze({
  // AUDIT_MCP_TOKEN اسم بديل يستخدمه GitHub Actions حتى لا يمرّر متغيرًا فارغًا
  // باسم CELIA_MCP_API_TOKEN فوق .env (dotenv لا يستبدل المتغيرات الموجودة).
  mcpToken: ['CELIA_MCP_API_TOKEN', 'AUDIT_MCP_TOKEN'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  agentRouter: ['AGENTROUTER_API_KEY', 'AGENETROUTERAPI_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  elevenLabs: ['ELEVENLABS_API_KEY'],
  voiceId: ['CELIA_VOICE_ID'],
  figma: ['FIGMA_ACCESS_TOKEN']
});

function pickSecret(env, names) {
  for (const name of names) {
    const raw = typeof env[name] === 'string' ? env[name].trim() : '';
    if (raw && !/^replace-with-/i.test(raw)) return { value: raw, source: name };
  }
  return { value: '', source: null };
}

export function collectSecrets(env = process.env) {
  return Object.freeze(
    Object.fromEntries(PROVIDER_ORDER.map((id) => [id, Object.freeze(pickSecret(env, SECRET_ENV_NAMES[id]))]))
  );
}

export function redactText(text, secretValues = []) {
  let output = String(text ?? '');
  for (const secret of secretValues) {
    if (typeof secret === 'string' && secret.length >= 4) output = output.split(secret).join('[REDACTED]');
  }
  return output;
}

function secretValuesFrom(map) {
  return PROVIDER_ORDER.map((id) => map[id].value).filter(Boolean);
}

function stateFromStatus(status, failureReason) {
  if (!status) return { state: 'error', note: failureReason || 'network_error' };
  if (status >= 200 && status < 300) return { state: 'ok', note: 'connected' };
  if (status === 400 || status === 401 || status === 403) return { state: 'invalid', note: 'key_rejected' };
  if (status === 429) return { state: 'limited', note: 'quota_or_rate_limited' };
  if (status === 404 || status === 405) return { state: 'unverified', note: 'probe_endpoint_unavailable' };
  if (status >= 500) return { state: 'error', note: `provider_http_${status}` };
  return { state: 'unverified', note: `unexpected_http_${status}` };
}

async function probe({ url, headers, fetchImpl, timeoutMs, method = 'GET', body }) {
  const doFetch = fetchImpl || globalThis.fetch;
  try {
    const response = await doFetch(url, {
      method,
      headers,
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const status = Number.isInteger(response?.status) ? response.status : response?.ok ? 200 : 0;
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { status, payload, failureReason: null };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { status: 0, payload: null, failureReason: timedOut ? 'timeout' : 'network_error' };
  }
}

function baseResult(id, secrets) {
  const entry = secrets[id];
  return {
    id,
    secret: PROVIDER_LABELS[id].secret,
    label: PROVIDER_LABELS[id].arabic,
    cost: PROVIDER_LABELS[id].cost,
    configured: Boolean(entry.value),
    source: entry.source,
    state: 'missing',
    httpStatus: null,
    note: 'secret_not_set'
  };
}

function finish(result, probeResult) {
  const { state, note } = stateFromStatus(probeResult.status, probeResult.failureReason);
  result.state = state;
  result.note = note;
  result.httpStatus = probeResult.status || null;
  return result;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** يحسب الحصة المتبقية من اشتراك ElevenLabs دون استهلاك أي حرف. */
export function parseVoiceQuota(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const used = numberOrNull(payload.character_count);
  const limit = numberOrNull(payload.character_limit);
  if (used === null || limit === null || limit <= 0) return null;
  const remaining = Math.max(0, limit - used);
  const remainingPct = Math.round((remaining / limit) * 1000) / 10;
  const resetUnix = numberOrNull(payload.next_character_count_reset_unix);
  const resetAt = resetUnix && resetUnix > 0 ? new Date(resetUnix * 1000).toISOString() : null;
  const rawTier = typeof payload.tier === 'string' ? payload.tier : '';
  return {
    used,
    limit,
    remaining,
    remainingPct,
    resetAt,
    // قيمة مصفّاة: رمز واحد قصير بلا مسافات، حتى لا يتسرب أي نص حساس من الاستجابة.
    tier: /^[a-z0-9_-]{1,24}$/i.test(rawTier) ? rawTier : 'unknown'
  };
}

function quotaBar(percent) {
  if (!Number.isFinite(percent)) return 'غير متاح';
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return '🟩'.repeat(filled) + '⬜'.repeat(10 - filled);
}

export async function runSecretAudit({ env = process.env, fetchImpl = null, timeoutMs = 8000 } = {}) {
  const secrets = collectSecrets(env);
  const results = Object.fromEntries(PROVIDER_ORDER.map((id) => [id, baseResult(id, secrets)]));
  const common = { fetchImpl, timeoutMs };

  // 1) CELIA_MCP_API_TOKEN — فحص بنيوي + اختبار 401 محلي اختياري.
  if (secrets.mcpToken.value) {
    const token = secrets.mcpToken.value;
    if (token.length < 32) {
      results.mcpToken.state = 'invalid';
      results.mcpToken.note = 'token_shorter_than_32_chars';
    } else {
      results.mcpToken.state = 'ok';
      results.mcpToken.note = 'token_format_ok';
      const mcpUrl = typeof env.AUDIT_MCP_URL === 'string' ? env.AUDIT_MCP_URL.trim().replace(/\/$/, '') : '';
      if (/^https?:\/\//.test(mcpUrl)) {
        const guard = await probe({
          ...common,
          url: `${mcpUrl}/mcp`,
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer invalid-audit-token' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' })
        });
        // 401 مطلوب هنا: نتيجة غير 401 تعني أن البوابة لا تتحقق من الرمز.
        results.mcpToken.bearerGuard = guard.status === 401 ? 'enforced' : 'not_verified';
        if (guard.status === 0) results.mcpToken.bearerGuard = 'server_unreachable';
      }
    }
  }

  // 2) GEMINI_API_KEY — models.list بالمفتاح في الترويسة فقط.
  if (secrets.gemini.value) {
    const result = await probe({
      ...common,
      url: GEMINI_URL,
      headers: { 'x-goog-api-key': secrets.gemini.value }
    });
    finish(results.gemini, result);
    if (Array.isArray(result.payload?.models)) results.gemini.modelsAvailable = result.payload.models.length;
  }

  // 3) AGENTROUTER — يقبل الاسم الصحيح والاسم الحرفي الخاطئ.
  if (secrets.agentRouter.value) {
    const result = await probe({
      ...common,
      url: AGENTROUTER_URL,
      headers: { authorization: `Bearer ${secrets.agentRouter.value}` }
    });
    finish(results.agentRouter, result);
    if (Array.isArray(result.payload?.data)) results.agentRouter.modelsAvailable = result.payload.data.length;
  }

  // 4) DEEPSEEK — نجرّب مسار /v1/models ثم /models لأن المزوّد يدعم الاثنين حسب الإصدار.
  if (secrets.deepseek.value) {
    let result = await probe({
      ...common,
      url: DEEPSEEK_URLS[0],
      headers: { authorization: `Bearer ${secrets.deepseek.value}` }
    });
    if (result.status === 404) {
      const fallback = await probe({
        ...common,
        url: DEEPSEEK_URLS[1],
        headers: { authorization: `Bearer ${secrets.deepseek.value}` }
      });
      if (fallback.status >= 200 && fallback.status < 300) result = fallback;
    }
    finish(results.deepseek, result);
  }

  // 5) ELEVENLABS — الاشتراك (لا يستهلك أحرفًا) + حساب النسبة المتبقية.
  let voiceQuota = null;
  if (secrets.elevenLabs.value) {
    const result = await probe({
      ...common,
      url: ELEVENLABS_SUBSCRIPTION_URL,
      headers: { 'xi-api-key': secrets.elevenLabs.value }
    });
    finish(results.elevenLabs, result);
    voiceQuota = parseVoiceQuota(result.payload);
    if (voiceQuota) results.elevenLabs.remainingCharacters = voiceQuota.remaining;
  }

  // 6) CELIA_VOICE_ID — يعتمد على مفتاح ElevenLabs نفسه.
  if (!secrets.voiceId.value) {
    // يبقى missing كما هو.
  } else if (!secrets.elevenLabs.value) {
    results.voiceId.state = 'unverified';
    results.voiceId.note = 'needs_elevenlabs_key';
  } else {
    const result = await probe({
      ...common,
      url: `${ELEVENLABS_VOICES_URL}/${encodeURIComponent(secrets.voiceId.value)}`,
      headers: { 'xi-api-key': secrets.elevenLabs.value }
    });
    finish(results.voiceId, result);
  }

  // 7) FIGMA_ACCESS_TOKEN — /me مجاني بالكامل (لا نطبع هوية الحساب).
  if (secrets.figma.value) {
    const result = await probe({
      ...common,
      url: FIGMA_URL,
      headers: { 'X-Figma-Token': secrets.figma.value }
    });
    finish(results.figma, result);
  }

  const configured = PROVIDER_ORDER.filter((id) => results[id].configured).length;
  const verified = PROVIDER_ORDER.filter((id) => ['ok', 'limited'].includes(results[id].state)).length;

  return Object.freeze({
    auditVersion: AUDIT_VERSION,
    generatedAt: new Date().toISOString(),
    total: PROVIDER_ORDER.length,
    configured,
    verified,
    providers: results,
    voiceQuota
  });
}

const STATE_MARKS = Object.freeze({
  ok: '✅ متصل',
  limited: '🟡 متصل مع تحديد معدل (429)',
  unverified: '⚠️ تعذّر تأكيد الاتصال',
  invalid: '❌ المفتاح مرفوض',
  error: '❌ خطأ اتصال',
  missing: '⚪ غير مضبوط'
});

export function renderSummary(report, secretValues = []) {
  const lines = [
    `## 🔐 لوحة فحص الأسرار السبعة — ${report.auditVersion}`,
    '',
    `**النتيجة:** ${report.verified}/${report.total} مزوّد متصل · ${report.configured}/${report.total} مفتاح مضبوط · ${new Date(report.generatedAt).toUTCString()}`,
    '',
    '| المزوّد | السر في GitHub | الحالة | التفاصيل الآمنة |',
    '|---|---|---|---|'
  ];

  for (const id of PROVIDER_ORDER) {
    const item = report.providers[id];
    const details = [
      item.httpStatus ? `HTTP ${item.httpStatus}` : null,
      item.source ? `المصدر: \`${item.source}\`` : null,
      item.note ? `\`${item.note}\`` : null,
      item.modelsAvailable !== undefined ? `نماذج: ${item.modelsAvailable}` : null,
      item.bearerGuard ? `حارس Bearer: ${item.bearerGuard}` : null
    ]
      .filter(Boolean)
      .join(' · ');
    lines.push(`| ${item.label} (${item.cost}) | \`${item.secret}\` | ${STATE_MARKS[item.state] || item.state} | ${details || '—'} |`);
  }

  lines.push('', '### 🎙️ حصة الصوت المجانية (ElevenLabs)');
  if (report.voiceQuota) {
    const quota = report.voiceQuota;
    lines.push(
      `- **النسبة المتبقية:** \`${quota.remainingPct}%\` — ${quotaBar(quota.remainingPct)}`,
      `- **الأحرف:** ${quota.used.toLocaleString('en-US')} مستخدم من ${quota.limit.toLocaleString('en-US')} (المتبقي ${quota.remaining.toLocaleString('en-US')})`,
      `- **الباقة:** \`${quota.tier}\`${quota.resetAt ? ` · **تجديد الحصة:** ${quota.resetAt.slice(0, 10)}` : ''}`
    );
  } else {
    lines.push('- ⚪ بيانات الحصة غير متاحة (المفتاح غير مضبوط أو تعذّر قراءة الاشتراك).');
  }

  lines.push(
    '',
    '> ✅ كل الفحوص **لا تستهلك أي حصة**: قوائم النماذج، قراءة الاشتراك، قراءة الصوت، و`/me` في Figma. لا تظهر أي قيمة سرية في هذا التقرير أو في السجلات.',
    ''
  );

  return redactText(lines.join('\n'), secretValues);
}

/** يبني أمر ::notice:: آمنًا (تنظيف الحمولة فقط دون المساس ببادئة الأمر). */
export function buildAuditNotice(report, secretValues = []) {
  const compact = PROVIDER_ORDER.map((id) => {
    const item = report.providers[id];
    return `${id}:${item.state}${item.httpStatus ? `(http${item.httpStatus})` : ''}`;
  }).join(',');
  const quota = report.voiceQuota ? String(report.voiceQuota.remainingPct) : 'n/a';
  const payload = redactText(
    `verified=${report.verified}/${report.total} configured=${report.configured}/${report.total} voiceQuotaRemainingPct=${quota} ${compact}`,
    secretValues
  )
    // تهريب صيغة أوامر الـ workflow: علامة % أولًا ثم الأسطر، وأخيرًا نمنع أي :: داخل الحمولة.
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/::/g, ':');
  return `::notice title=Celia 7-Secret Audit::${payload}`;
}

export function auditExitCode(report, strict = false) {
  if (!strict) return 0;
  return PROVIDER_ORDER.every((id) => ['ok', 'limited'].includes(report.providers[id].state)) ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const env = process.env;
  const strict = String(env.AUDIT_STRICT || '').toLowerCase() === 'true';
  const report = await runSecretAudit({ env });
  const secrets = secretValuesFrom(collectSecrets(env));
  const safeJson = redactText(
    JSON.stringify(
      {
        auditVersion: report.auditVersion,
        total: report.total,
        configured: report.configured,
        verified: report.verified,
        voiceQuota: report.voiceQuota,
        providers: Object.fromEntries(
          PROVIDER_ORDER.map((id) => [
            id,
            {
              state: report.providers[id].state,
              source: report.providers[id].source,
              httpStatus: report.providers[id].httpStatus,
              note: report.providers[id].note
            }
          ])
        )
      },
      null,
      2
    ),
    secrets
  );
  console.log(safeJson);
  const markdown = renderSummary(report, secrets);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);

  // قناة ملاحظة قابلة للقراءة عبر GitHub Checks API (مفيدة حين يتعذّر تنزيل سجلات التشغيل).
  console.log(buildAuditNotice(report, secrets));
  process.exitCode = auditExitCode(report, strict);
}
