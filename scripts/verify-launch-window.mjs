#!/usr/bin/env node
/**
 * GA-F5 — evidence for the first production window (60 minutes by default).
 *
 * The gate says: a deployment followed by a full window with `attempts > 0`,
 * `successful = attempts`, zero critical errors and stable readiness. Nothing in
 * the repository measured that, so the honest state was "not measured" — this
 * command turns it into one run with a token-free report.
 *
 * What it does, and nothing more:
 *   1. Samples `GET /version` and `GET /readyz` on a fixed cadence for the window.
 *   2. If an owner credential is supplied, reads `GET /api/cron/intents` once at the
 *      end and computes attempts/applied/failed/unknown from the outbox.
 *   3. Writes `.validation-artifacts/launch-window.json` and exits non-zero unless
 *      the window is measured and clean.
 *
 * Hard rules carried from the runbook:
 *   - **Zero attempts is not 100% success.** No traffic inside the window is a
 *     failed measurement, never a pass.
 *   - A missing owner credential leaves the outbox `unmeasured`; it never becomes 0.
 *   - `launch.ready` stays false: human consent, review and rollback readiness are
 *     not something a sampler can assert.
 *   - The report carries no cookie, token, authorization header or raw URL query.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL = 'https://celia-phone-google.celiaelazamey.workers.dev';
const DEFAULT_OUT = '.validation-artifacts/launch-window.json';
const MAX_TICKS = 720;
const INTENT_LIMIT = 100;

export const VERDICTS = Object.freeze(['pass', 'review', 'fail', 'unmeasured']);

export const EXTERNAL_GATES = Object.freeze([
  {
    id: 'GA-F5-consent',
    owner: 'مالك حساب الاختبار',
    requirement: 'رحلتا قبول ورفض بحساب اختبار حقيقي؛ نافذة المراقبة لا تثبت consent.',
    evidence: 'تقرير GA-F3 اليدوي المنقّح.'
  },
  {
    id: 'GA-F5-rollback',
    owner: 'مهندس العمليات',
    requirement: 'خطة تراجع معروفة وهدف `known_good` محدد قبل فتح النافذة.',
    evidence: 'صف الترقية في تشغيلة النشر + سجل النشر.'
  }
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseArgs(argv) {
  const options = {
    url: DEFAULT_URL,
    minutes: 60,
    intervalMs: 60_000,
    out: DEFAULT_OUT,
    expectedCommit: null,
    ticks: null,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--url') options.url = next();
    else if (arg === '--minutes') options.minutes = Number(next());
    else if (arg === '--interval-ms') options.intervalMs = Number(next());
    else if (arg === '--out') options.out = next();
    else if (arg === '--expected-commit') options.expectedCommit = next();
    else if (arg === '--ticks') options.ticks = Number(next());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.minutes) || options.minutes <= 0 || options.minutes > 24 * 60) {
    throw new Error('--minutes must be between 1 and 1440');
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 0 || options.intervalMs > 15 * 60_000) {
    throw new Error('--interval-ms must be between 0 and 900000');
  }
  if (options.ticks !== null && (!Number.isInteger(options.ticks) || options.ticks < 1 || options.ticks > MAX_TICKS)) {
    throw new Error(`--ticks must be an integer between 1 and ${MAX_TICKS}`);
  }
  return options;
}

function protocolOf(value) {
  try {
    return new URL(value).protocol;
  } catch {
    return null;
  }
}

function reasonOf(error) {
  const code = String(error?.code || error?.cause?.code || '').trim();
  if (code) return code;
  const message = String(error?.message || 'request_failed');
  const named = message.match(/^(?:fetch failed|network_error)$/) ? 'network_error' : message.slice(0, 80);
  return named.replace(/https?:\/\/[^\s"']+/gi, '<url>');
}

/** Read the outbox without ever echoing a credential. */
export async function readOutbox({ url, cookie, fetchImpl, timeoutMs }) {
  const target = new URL('/api/cron/intents', url);
  target.searchParams.set('limit', String(INTENT_LIMIT));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target, {
      headers: { accept: 'application/json', ...(cookie ? { cookie } : {}) },
      signal: controller.signal,
      redirect: 'error'
    });
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };
    const body = await response.json();
    const intents = Array.isArray(body?.intents) ? body.intents : [];
    return {
      ok: true,
      counts: body?.counts && typeof body.counts === 'object' ? body.counts : {},
      intents: intents.map((intent) => ({
        status: String(intent?.status || 'unknown'),
        attempts: Number(intent?.attempts || 0),
        createdAt: intent?.createdAt ?? null
      }))
    };
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  } finally {
    clearTimeout(timer);
  }
}

function summariseAttempts({ intents, counts, windowStart }) {
  const inWindow = intents.filter((intent) => !windowStart || !intent.createdAt || String(intent.createdAt) >= windowStart);
  const attempts = inWindow.reduce((sum, intent) => sum + (Number.isFinite(intent.attempts) ? intent.attempts : 0), 0);
  const byStatus = inWindow.reduce((acc, intent) => {
    acc[intent.status] = (acc[intent.status] || 0) + 1;
    return acc;
  }, {});
  const successful = byStatus.applied || 0;
  const failed = (byStatus.failed || 0) + (byStatus.unknown || 0);
  return {
    sampledIntents: inWindow.length,
    attempts,
    successful,
    failed,
    maxAttempts: inWindow.reduce((max, intent) => Math.max(max, intent.attempts || 0), 0),
    byStatus,
    cumulativeCounts: counts
  };
}

function verdictOf({ samples, readinessFailures, outbox, credentialSupplied }) {
  const reasons = [];
  if (!samples.length) reasons.push({ code: 'no_samples', severity: 'fail' });
  if (readinessFailures.length) reasons.push({ code: 'readiness_unstable', severity: 'fail', count: readinessFailures.length });

  if (!credentialSupplied) {
    reasons.push({ code: 'owner_credential_missing_outbox_unmeasured', severity: 'unmeasured' });
    return { verdict: 'unmeasured', reasons };
  }
  if (!outbox?.ok) {
    reasons.push({ code: 'outbox_unreadable', severity: 'fail', detail: outbox?.reason || null });
    return { verdict: 'fail', reasons };
  }
  if (outbox.attempts === 0) {
    reasons.push({ code: 'zero_attempts_is_not_success', severity: 'fail' });
    return { verdict: 'fail', reasons };
  }
  if (outbox.failed > 0) {
    reasons.push({ code: 'failed_or_unknown_intents', severity: 'review', count: outbox.failed });
  }
  if (outbox.successful !== outbox.attempts) {
    reasons.push({ code: 'successful_not_equal_attempts', severity: 'review', successful: outbox.successful, attempts: outbox.attempts });
  }
  if (readinessFailures.length) return { verdict: 'fail', reasons };
  return { verdict: reasons.length ? 'review' : 'pass', reasons };
}

export async function verifyLaunchWindow({
  url = DEFAULT_URL,
  minutes = 60,
  intervalMs = 60_000,
  expectedCommit = null,
  cookie = '',
  ticks = null,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  now = () => new Date(),
  timeoutMs = 20_000
} = {}) {
  if (protocolOf(url) !== 'https:') throw new Error('Target must be an https:// origin');
  const origin = new URL('/', url).toString();

  const planned = ticks ?? Math.min(MAX_TICKS, Math.max(1, Math.round((minutes * 60_000) / Math.max(intervalMs, 1_000))));
  const samples = [];
  const readinessFailures = [];
  const startedAt = now();

  for (let index = 0; index < planned; index += 1) {
    const sample = { at: now().toISOString(), index };
    for (const route of ['/version', '/readyz']) {
      const target = new URL(route, origin);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const began = Date.now();
      try {
        const response = await fetchImpl(target, { headers: { accept: 'application/json' }, signal: controller.signal });
        const body = await response.json().catch(() => null);
        sample[route] = { status: response.status, ms: Date.now() - began, body };
      } catch (error) {
        sample[route] = { status: 0, ms: Date.now() - began, error: reasonOf(error) };
      } finally {
        clearTimeout(timer);
      }
    }
    const version = sample['/version'];
    const ready = sample['/readyz'];
    const problems = [];
    if (version.status !== 200) problems.push('version_status');
    if (!version.body || typeof version.body.version !== 'string') problems.push('version_body');
    if (expectedCommit && version.body?.commit && version.body.commit !== expectedCommit) problems.push('version_commit_mismatch');
    if (ready.status !== 200) problems.push('readyz_status');
    if (!ready.body || ready.body.ok !== true || ready.body.ready !== true) problems.push('readyz_not_ready');
    if (problems.length) readinessFailures.push({ index, problems });
    sample.problems = problems;
    samples.push(sample);
    if (index < planned - 1 && intervalMs > 0) await sleepImpl(intervalMs);
  }

  const windowStart = startedAt.toISOString();
  const outboxRaw = cookie ? await readOutbox({ url: origin, cookie, fetchImpl, timeoutMs }) : null;
  const outbox = outboxRaw?.ok
    ? { ok: true, ...summariseAttempts({ intents: outboxRaw.intents, counts: outboxRaw.counts, windowStart }) }
    : outboxRaw;

  const { verdict, reasons } = verdictOf({
    samples,
    readinessFailures,
    outbox,
    credentialSupplied: Boolean(cookie)
  });

  const latencies = samples.flatMap((sample) => [sample['/readyz'].ms, sample['/version'].ms]).filter((value) => Number.isFinite(value));
  latencies.sort((a, b) => a - b);
  const percentile = (fraction) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(fraction * latencies.length))] : null);

  return {
    schema: 1,
    gate: 'GA-F5',
    generatedAt: now().toISOString(),
    window: {
      plannedSamples: planned,
      completedSamples: samples.length,
      intervalMs,
      intendedMinutes: minutes,
      startedAt: windowStart,
      endedAt: now().toISOString()
    },
    target: { origin },
    version: {
      expectedCommit,
      observed: samples.at(-1)?.['/version']?.body?.version ?? null,
      commit: samples.at(-1)?.['/version']?.body?.commit ?? null
    },
    readiness: {
      failures: readinessFailures,
      failureCount: readinessFailures.length,
      latencyMs: { p50: percentile(0.5), p95: percentile(0.95), max: latencies.at(-1) ?? null }
    },
    outbox: outbox ?? { ok: false, reason: 'owner_credential_missing' },
    verdict,
    verdictReasons: reasons,
    launch: {
      ready: false,
      summary: 'النافذة تُقاس؛ والقبول الحقيقي والمراجعة البشرية وخطة التراجع بوابات خارجية لا يمنحها هذا الملف.'
    },
    blockedPendingExternalGates: EXTERNAL_GATES.map((gate) => gate.id),
    notes: [
      'صفر محاولات ليس نجاحًا: غياب الحركة داخل النافذة قياس فاشل لا 100%.',
      'أعداد الحالة تراكمية على الـoutbox، وتُقصّ عند 100 صف في القراءة الواحدة.',
      'لا يحمل التقرير كوكي أو رمزًا أو ترويسة مصادقة أو استعلام URL خامًّا.'
    ]
  };
}

export async function runCli(argv = process.argv.slice(2), { fetchImpl = globalThis.fetch, sleepImpl = sleep } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('node scripts/verify-launch-window.mjs [--url URL] [--minutes 60] [--interval-ms 60000] [--out FILE] [--expected-commit SHA]');
    console.log('Owner credential (optional, never printed): CELIA_OWNER_COOKIE');
    return 0;
  }
  const cookie = String(process.env.CELIA_OWNER_COOKIE || '').trim();
  const report = await verifyLaunchWindow({
    url: options.url,
    minutes: options.minutes,
    intervalMs: options.intervalMs,
    expectedCommit: options.expectedCommit,
    cookie,
    ticks: options.ticks,
    fetchImpl,
    sleepImpl
  });
  const out = path.resolve(process.cwd(), options.out);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const summary = [
    `GA-F5 window: ${report.window.completedSamples} samples · readiness failures ${report.readiness.failureCount}`,
    `outbox: ${report.outbox.ok ? `attempts ${report.outbox.attempts} · applied ${report.outbox.successful} · failed/unknown ${report.outbox.failed}` : 'unmeasured'}`,
    `verdict: ${report.verdict} (${report.verdictReasons.map((reason) => reason.code).join(', ') || 'clean'})`,
    `written: ${path.relative(process.cwd(), out)}`
  ].join('\n');
  console.log(summary);
  return report.verdict === 'pass' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runCli();
  } catch (error) {
    console.error(`GA-F5 window aborted: ${reasonOf(error)}`);
    process.exitCode = 1;
  }
}
