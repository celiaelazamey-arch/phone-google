#!/usr/bin/env node
/**
 * Executable acceptance for a deployed Celia service (deploy/free-always-on/README.md §5).
 *
 * The owner runs it against the public URL; it turns the checklist into evidence a
 * session record can quote. It never prints the owner token, never writes the full
 * URL (host only), and a CI pass is not an input: only the live service answers.
 *
 *   npm run verify:live -- --url https://<service>.onrender.com [--expect-commit <sha>]
 *   CELIA_MCP_API_TOKEN=… npm run verify:live -- --url https://…   # adds the owner-only checks
 *
 * Exit code 1 when any check fails. Checks it cannot perform from outside (restart
 * persistence, monthly quota, an approval→reconciliation round trip) are listed as
 * `manual` so nobody mistakes "the script passed" for "the checklist is done".
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = '.validation-artifacts/live-acceptance.json';

export const MANUAL_CHECKS = Object.freeze([
  {
    id: 'restart_persistence',
    title: 'إعادة تشغيل الخدمة لا تفقد البيانات المؤكدة (استعلام بعد الإقلاع)',
    how: 'Render → Manual Deploy/Restart، ثم أعد تشغيل هذا الأمر وقارن عدد الخيوط/التشغيلات من /agent.'
  },
  {
    id: 'approval_reconcile_roundtrip',
    title: 'موافقة مالك مسجلة ثم مصالحة applied تعمل وسلسلة الأدلة ok:true — بلا أي إرسال خارجي',
    how: 'من /agent على الخدمة الحقيقية مع CELIA_AGENT_CONNECTORS=none؛ لا يُنشئ هذا السكربت بيانات على قاعدة الإنتاج.'
  },
  {
    id: 'monthly_quota',
    title: 'استهلاك الحصة < 750 ساعة في الشهر',
    how: 'لوحة Render → Billing/Usage في نهاية الشهر؛ خدمة واحدة فقط.'
  },
  {
    id: 'static_hosting_pointer',
    title: '/api/deployment/hosting على الواجهة الثابتة يذكر الرابط الصحيح',
    how: 'افتح الواجهة الثابتة وتحقق أن realService.url هو نفس المضيف؛ الحالة تبقى verified:false في الكود وتُغيَّر في تقرير الجلسة فقط.'
  }
]);

function parseArgs(argv) {
  const options = { url: null, expectCommit: null, expectVersion: null, samples: 3, maxFirstMs: 10_000, out: DEFAULT_OUT, allowHttp: false, timeoutMs: 90_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--url') options.url = next();
    else if (arg === '--expect-commit') options.expectCommit = next();
    else if (arg === '--expect-version') options.expectVersion = next();
    else if (arg === '--samples') options.samples = Number(next());
    else if (arg === '--max-first-ms') options.maxFirstMs = Number(next());
    else if (arg === '--timeout-ms') options.timeoutMs = Number(next());
    else if (arg === '--out') options.out = next();
    else if (arg === '--allow-http') options.allowHttp = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** Only the origin ever leaves this process: no path, query, user info or token. */
export function describeTarget(url) {
  const parsed = new URL(url);
  return { origin: parsed.origin, host: parsed.host, protocol: parsed.protocol.replace(':', '') };
}

export async function verifyLive({
  url,
  token = null,
  expectCommit = null,
  expectVersion = null,
  samples = 3,
  maxFirstMs = 10_000,
  timeoutMs = 90_000,
  allowHttp = false,
  fetchImpl = globalThis.fetch,
  now = () => performance.now(),
  clock = () => new Date()
} = {}) {
  const checks = [];
  const add = (id, title, status, detail = {}) => {
    checks.push({ id, title, status, detail });
    return status === 'pass';
  };

  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    add('url', 'الرابط صالح وآمن', 'fail', { reason: 'invalid_url' });
    return finish();
  }
  if (parsed.username || parsed.password) {
    add('url', 'الرابط صالح وآمن', 'fail', { reason: 'credentials_in_url' });
    return finish();
  }
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    add('url', 'الرابط صالح وآمن', 'fail', { reason: 'https_required', protocol: parsed.protocol });
    return finish();
  }
  add('url', 'الرابط صالح وآمن', 'pass', { protocol: parsed.protocol.replace(':', '') });
  const base = parsed.origin;

  const get = async (route, headers = {}) => {
    const startedAt = now();
    const response = await fetchImpl(`${base}${route}`, {
      headers: { accept: 'application/json', ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    });
    const elapsedMs = Math.round(now() - startedAt);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body, elapsedMs };
  };

  // 1. Wake-up latency: the first request tells whether the periodic ping kept the
  //    service awake. Meaningful only after ~20 idle minutes — say so in the report.
  const latencies = [];
  let first;
  try {
    first = await get('/healthz');
    latencies.push(first.elapsedMs);
    for (let index = 1; index < Math.max(1, samples); index += 1) latencies.push((await get('/healthz')).elapsedMs);
  } catch (error) {
    add('reachable', 'الخدمة تجيب من الإنترنت العام', 'fail', { reason: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable', code: error?.code || null });
    return finish();
  }
  add('reachable', 'الخدمة تجيب من الإنترنت العام', first.status === 200 ? 'pass' : 'fail', { httpStatus: first.status });
  add('wake_latency', 'أول طلب يستجيب دون زمن إقلاع (دليل فعالية النداء الدوري)', first.elapsedMs <= maxFirstMs ? 'pass' : 'fail', {
    firstMs: first.elapsedMs,
    medianMs: median(latencies),
    samples: latencies.length,
    maxFirstMs,
    note: 'ذو معنى فقط بعد ~20 دقيقة بلا زيارات؛ أول طلب أبطأ من الحد يعني أن الخدمة كانت نائمة.'
  });

  // 2. Version/commit parity with what was meant to be deployed.
  try {
    const version = await get('/version');
    const body = version.body || {};
    const versionOk = version.status === 200 && typeof body.version === 'string' && (!expectVersion || body.version === expectVersion);
    const commitOk = !expectCommit || (typeof body.commit === 'string' && body.commit.toLowerCase() === String(expectCommit).toLowerCase());
    add('version', '/version يطابق الإصدار والـcommit المقصودين', versionOk && commitOk ? 'pass' : 'fail', {
      httpStatus: version.status,
      version: body.version ?? null,
      commit: body.commit ?? null,
      expectedVersion: expectVersion,
      expectedCommit: expectCommit,
      schema: body.database?.schema ?? null
    });
  } catch (error) {
    add('version', '/version يطابق الإصدار والـcommit المقصودين', 'fail', { reason: error?.code || error?.name || 'request_failed' });
  }

  // 3. Readiness with durable MySQL — a memory demo can never pass this.
  try {
    const ready = await get('/readyz');
    const storage = ready.body?.storage || {};
    const ok = ready.status === 200 && ready.body?.ready === true && storage.mode === 'mysql' && storage.durable === true && storage.available === true;
    add('ready_durable', '/readyz يعيد 200 مع storage.mode=mysql وdurable=true (لا ذاكرة)', ok ? 'pass' : 'fail', {
      httpStatus: ready.status,
      ready: ready.body?.ready ?? null,
      storage: { mode: storage.mode ?? null, durable: storage.durable ?? null, available: storage.available ?? null, explicitDemo: storage.explicitDemo ?? null }
    });
  } catch (error) {
    add('ready_durable', '/readyz يعيد 200 مع storage.mode=mysql وdurable=true (لا ذاكرة)', 'fail', { reason: error?.code || error?.name || 'request_failed' });
  }

  // 4. The owner surface is gated: no token → 401. This needs no secret.
  try {
    const gate = await get('/api/agent/status');
    add('agent_auth_gate', 'مسارات الوكيل ترفض الطلب بلا رمز المالك (401)', gate.status === 401 ? 'pass' : 'fail', { httpStatus: gate.status });
  } catch (error) {
    add('agent_auth_gate', 'مسارات الوكيل ترفض الطلب بلا رمز المالك (401)', 'fail', { reason: error?.code || error?.name || 'request_failed' });
  }

  // 5. With the owner token (env only): the loop is on, durable, on MySQL, and the
  //    boot-recovery policy is visible. The token is used for the request and nowhere else.
  if (!token) {
    add('agent_status', '/api/agent/status يعيد enabled:true وdialect:mysql', 'skipped', { reason: 'CELIA_MCP_API_TOKEN not provided to this process' });
  } else {
    try {
      const status = await get('/api/agent/status', { authorization: `Bearer ${token}` });
      const body = status.body || {};
      const ok = status.status === 200 && body.enabled === true && body.dialect === 'mysql' && body.durable === true;
      add('agent_status', '/api/agent/status يعيد enabled:true وdialect:mysql', ok ? 'pass' : 'fail', {
        httpStatus: status.status,
        enabled: body.enabled ?? null,
        mode: body.mode ?? null,
        dialect: body.dialect ?? null,
        reason: body.reason ?? null,
        planner: body.planner ?? null,
        connectors: Array.isArray(body.connectors) ? body.connectors.map((entry) => entry?.name || entry) : null,
        bootRecovery: body.bootRecovery
          ? { policy: body.bootRecovery.policy, lastPerformed: body.bootRecovery.last?.performed ?? null, lastAt: body.bootRecovery.last?.at ?? null }
          : null
      });
    } catch (error) {
      add('agent_status', '/api/agent/status يعيد enabled:true وdialect:mysql', 'fail', { reason: error?.code || error?.name || 'request_failed' });
    }
  }

  return finish();

  function finish() {
    const failed = checks.filter((check) => check.status === 'fail');
    const skipped = checks.filter((check) => check.status === 'skipped');
    return {
      kind: 'celia-live-acceptance',
      verifiedAt: clock().toISOString(),
      target: parsed ? describeTarget(parsed.href) : null,
      verdict: failed.length ? 'fail' : 'pass',
      summary: { pass: checks.filter((check) => check.status === 'pass').length, fail: failed.length, skipped: skipped.length, manual: MANUAL_CHECKS.length },
      checks,
      manual: MANUAL_CHECKS,
      note:
        'دليل يشغّله المالك على الرابط العام. نجاح CI ليس بديلًا عنه، ونجاح هذا السكربت لا يُغلق البنود اليدوية ولا يصف الطبقة المجانية بأنها تشغيل مضمون.'
    };
  }
}

export async function runCli(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 2;
  }
  if (options.help || !options.url) {
    stderr.write(
      'Usage: npm run verify:live -- --url https://<service> [--expect-commit <sha>] [--expect-version <semver>] ' +
        '[--samples 3] [--max-first-ms 10000] [--timeout-ms 90000] [--out .validation-artifacts/live-acceptance.json]\n' +
        'Owner-only checks run when CELIA_MCP_API_TOKEN is set in the environment (never passed as an argument).\n'
    );
    return options.help ? 0 : 2;
  }
  let expectVersion = options.expectVersion;
  if (!expectVersion) {
    try {
      expectVersion = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
    } catch {
      expectVersion = null;
    }
  }
  const report = await verifyLive({
    url: options.url,
    token: env.CELIA_MCP_API_TOKEN || null,
    expectCommit: options.expectCommit,
    expectVersion,
    samples: options.samples,
    maxFirstMs: options.maxFirstMs,
    timeoutMs: options.timeoutMs,
    allowHttp: options.allowHttp
  });
  const serialized = JSON.stringify(report, null, 2);
  if (env.CELIA_MCP_API_TOKEN && serialized.includes(env.CELIA_MCP_API_TOKEN)) {
    stderr.write('Refusing to write a report that contains the owner token.\n');
    return 3;
  }
  const outPath = path.resolve(root, options.out);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${serialized}\n`, 'utf8');
  stdout.write(`${serialized}\n`);
  stderr.write(`${report.verdict === 'pass' ? 'PASS' : 'FAIL'} — ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.skipped} skipped, ${report.summary.manual} manual. Report: ${path.relative(root, outPath)}\n`);
  return report.verdict === 'pass' ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = await runCli();
}
