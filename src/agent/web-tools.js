import crypto from 'node:crypto';
import { createWebFetcher, validateWebUrl } from './web-fetch.js';
import { scanForInjection } from './issue-triage/injection.js';
import { EVIDENCE_KIND } from './evidence.js';

/**
 * M-C/C1-b + C2a — web access as a governed tool surface.
 *
 * Every fetch gets its **own short-lived grant**, revoked in `finally`, so a run can
 * never hold standing egress authority between steps and a leaked token dies with the
 * call. On top of the proxy's own ceilings this adds the two budget dimensions the
 * loop cares about: how many fetches a run may make, and how much text it may absorb.
 *
 * The text that comes back is untrusted by definition. It is scanned with the same
 * `scanForInjection` the issue pipeline uses, and if anything fires the planner sees
 * the **scrubbed** text plus the rule ids — never the payload phrased as an
 * instruction, and never an extra capability.
 */

export const WEB_TOOL_VERSION = 'agent-web-tools-v1';
export const WEB_FETCH_TOOL = 'web.fetch';

const DEFAULT_LIMITS = Object.freeze({
  maxFetchesPerRun: 6,
  maxTotalCharsPerRun: 80_000,
  grantTtlMs: 30_000
});

function coded(code, status) {
  const error = new Error(code);
  error.code = code;
  if (status) error.status = status;
  return error;
}

export function createWebAccess({
  proxy,
  proxyUrl,
  allowlist,
  clock = Date.now,
  limits = {},
  fetcher = null,
  store = null,
  onEvent = null
} = {}) {
  if (!proxy || typeof proxy.issueGrant !== 'function' || typeof proxy.revokeGrant !== 'function') {
    throw coded('web_access_proxy_required');
  }
  if (!allowlist || typeof allowlist.allows !== 'function') throw coded('web_allowlist_required');
  const config = { ...DEFAULT_LIMITS, ...limits };
  for (const [key, min, max] of [
    ['maxFetchesPerRun', 1, 24],
    ['maxTotalCharsPerRun', 1_000, 500_000],
    ['grantTtlMs', 1_000, 300_000]
  ]) {
    if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) {
      throw coded(`web_limit_invalid:${key}`);
    }
  }
  if (store && typeof store.appendEvidence !== 'function') throw coded('web_store_invalid');
  const transport = fetcher || createWebFetcher({ proxyUrl, allowlist, clock });
  const usage = new Map();
  const counters = { fetches: 0, allowed: 0, blocked: 0, bytes: 0, auditFailures: 0 };

  // كل محاولة تُشهد: مصدر مجلوب (`PASS`) أو منع (`BLOCK`) — والرحلة الناجحة هي وحدها
  // التي تحمل بصمة، فسلسلة الأدلة لا تشهد على نص لم يُقرأ.
  const record = async ({ runId, url, decision, code = null, result = null }) => {
    const event = {
      version: WEB_TOOL_VERSION,
      runId,
      url,
      decision,
      reason: code,
      status: result?.status ?? null,
      finalUrl: result?.finalUrl ?? null,
      sha256: result?.sha256 ?? null,
      chars: result?.chars ?? null,
      bytes: result?.bytes ?? null,
      injection: result?.injection ?? null,
      at: new Date(clock()).toISOString()
    };
    if (decision === 'block') counters.blocked += 1;
    if (onEvent) {
      try {
        await onEvent(event);
      } catch {
        counters.auditFailures += 1;
      }
    }
    if (!store) return;
    try {
      await store.appendEvidence({
        runId,
        kind: EVIDENCE_KIND.webSource,
        input: { url, finalUrl: event.finalUrl, decision, reason: code },
        output: {
          status: event.status,
          sha256: event.sha256,
          chars: event.chars,
          bytes: event.bytes,
          injection: event.injection
        },
        verdict: decision === 'allow' ? 'PASS' : 'BLOCK'
      });
    } catch {
      // التدقيق لا يغيّر القرار: الجلب وقع أو مُنع فعلًا قبل هذه الكتابة.
      counters.auditFailures += 1;
    }
  };

  return {
    version: WEB_TOOL_VERSION,
    limits: Object.freeze({ ...config }),

    async fetch({ runId, url, signal } = {}) {
      if (typeof runId !== 'string' || !runId) throw coded('web_run_required');
      const used = usage.get(runId) || { fetches: 0, chars: 0 };
      if (used.fetches >= config.maxFetchesPerRun) {
        await record({ runId, url, decision: 'block', code: 'web_budget_exhausted' });
        throw coded('web_budget_exhausted', 429);
      }

      let result;
      let grant;
      try {
        grant = proxy.issueGrant({ runId, allowlist, ttlMs: config.grantTtlMs });
        result = await transport.fetch({ url, token: grant.token, signal });
      } catch (error) {
        // المنع مسجّل بالكود نفسه، والرابط كما طلبه المشغّل — لا كمحاولة نجحت.
        await record({ runId, url, decision: 'block', code: error?.code || 'web_fetch_failed' });
        throw error;
      } finally {
        // The authority dies with the call, whatever the outcome.
        if (grant) proxy.revokeGrant(grant.token);
      }

      const scan = scanForInjection(result.title, result.text);
      const text = scan.tainted ? scan.scrubbed : result.text;
      if (used.chars + text.length > config.maxTotalCharsPerRun) {
        await record({ runId, url, decision: 'block', code: 'web_chars_budget_exhausted' });
        throw coded('web_chars_budget_exhausted', 429);
      }
      usage.set(runId, { fetches: used.fetches + 1, chars: used.chars + text.length });
      counters.fetches += 1;

      const settled = {
        ...result,
        text,
        chars: text.length,
        sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
        injection: {
          tainted: scan.tainted,
          score: scan.score,
          ruleIds: scan.ruleIds
        }
      };
      counters.allowed += 1;
      counters.bytes += settled.bytes || 0;
      await record({ runId, url, decision: 'allow', result: settled });
      return settled;
    },

    stats() {
      return {
        version: WEB_TOOL_VERSION,
        fetches: counters.fetches,
        blocked: counters.blocked,
        allowed: counters.allowed,
        bytes: counters.bytes,
        auditFailures: counters.auditFailures,
        liveRuns: usage.size,
        limits: { ...config }
      };
    },

    usage(runId) {
      const used = usage.get(runId) || { fetches: 0, chars: 0 };
      return {
        fetches: used.fetches,
        chars: used.chars,
        maxFetchesPerRun: config.maxFetchesPerRun,
        maxTotalCharsPerRun: config.maxTotalCharsPerRun
      };
    },

    reset(runId) {
      usage.delete(runId);
    }
  };
}

export function webToolDefinitions({ web } = {}) {
  if (!web) return [];
  if (typeof web.fetch !== 'function') throw new TypeError('web.fetch requires a web access service');
  return [
    {
      name: WEB_FETCH_TOOL,
      description:
        'جلب صفحة عبر وسيط الخروج المحكوم (allowlist لكل تشغيل، سقوف حجم، تدقيق كل طلب) وإرجاع نص مقروء مبصوم SHA-256 بعد تنقية أي تعليمات حقن — لا كتابة ولا إرسال',
      risk: 'read',
      // كل فشل هنا مسوّى محليًا قبل أي أثر خارجي: لا يوجد أثر خارجي أصلًا في الجلب.
      settledFailures: true,
      timeoutMs: 25_000,
      arguments: { url: 'string' },
      validate: (args) => {
        try {
          validateWebUrl(args?.url);
          return { ok: true };
        } catch (error) {
          return { ok: false, code: error?.code || 'web_url_invalid' };
        }
      },
      execute: (args, { run, signal } = {}) =>
        web.fetch({ runId: String(run?.id || ''), url: args?.url, signal })
    }
  ];
}

export const WEB_LIMITS = DEFAULT_LIMITS;
