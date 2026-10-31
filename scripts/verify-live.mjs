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
  const options = { url: null, mode: 'mysql', expectCommit: null, expectVersion: null, samples: 3, d1Samples: 5, maxFirstMs: 10_000, out: DEFAULT_OUT, allowHttp: false, timeoutMs: 90_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--url') options.url = next();
    else if (arg === '--mode') {
      const m = next();
      if (!['mysql', 'edge'].includes(m)) throw new Error('--mode must be mysql or edge');
      options.mode = m;
    }
    else if (arg === '--expect-commit') options.expectCommit = next();
    else if (arg === '--expect-version') options.expectVersion = next();
    else if (arg === '--samples') options.samples = Number(next());
    else if (arg === '--d1-samples') options.d1Samples = Number(next());
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
  mode = 'mysql',
  token = null,
  expectCommit = null,
  expectVersion = null,
  samples = 3,
  d1Samples = 5,
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

  let onboardingReadiness = null;
  if (mode === 'edge') {
    // 3e. Readiness with durable Cloudflare D1 + full edge runtime capabilities (card-free path, DEC-037).
    try {
      const ready = await get('/readyz');
      const storage = ready.body?.storage || {};
      const caps = ready.body?.capabilities || {};
      onboardingReadiness = ready.body?.whatsappOnboarding ?? null;
      const ok =
        ready.status === 200 &&
        ready.body?.ready === true &&
        storage.mode === 'd1' &&
        storage.durable === true &&
        caps.mcp === true &&
        caps.googleOAuth === true &&
        caps.whatsappWebhook === true;
      add('ready_durable', '/readyz يعيد 200 مع storage.mode=d1 وdurable=true ومسارات الحافة الكاملة', ok ? 'pass' : 'fail', {
        httpStatus: ready.status,
        ready: ready.body?.ready ?? null,
        cardFreeHosting: ready.body?.cardFreeHosting ?? null,
        storage: { mode: storage.mode ?? null, durable: storage.durable ?? null },
        capabilities: caps
      });
    } catch (error) {
      add('ready_durable', '/readyz يعيد 200 مع storage.mode=d1 وdurable=true ومسارات الحافة الكاملة', 'fail', { reason: error?.code || error?.name || 'request_failed' });
    }

    // 3f. D1 latency as a series, not a number (WP-1.4, DEC-050). Every /readyz call writes a fresh token and reads it
    //     back, so `storage.latencyMs` is a real write+read round trip inside the worker; the client round trip is
    //     reported next to it. Measurement first — no threshold is enforced yet (DEC-045).
    const seriesTitle = `زمن D1 (كتابة + قراءة) كسلسلة من ${Math.max(2, Number(d1Samples) || 5)} قياسات متتالية: أدنى/وسيط/أقصى لا رقم واحد`;
    try {
      const count = Math.max(2, Math.min(20, Number(d1Samples) || 5));
      const latencies = [];
      const roundTrips = [];
      let durableAll = true;
      for (let index = 0; index < count; index += 1) {
        const probe = await get('/readyz');
        const storage = probe.body?.storage || {};
        latencies.push(typeof storage.latencyMs === 'number' && Number.isFinite(storage.latencyMs) ? storage.latencyMs : null);
        roundTrips.push(probe.elapsedMs);
        if (!(probe.status === 200 && storage.durable === true)) durableAll = false;
      }
      const measured = latencies.filter((value) => typeof value === 'number');
      const ok = durableAll && measured.length === latencies.length;
      const stats = (values) => ({ minMs: Math.min(...values), medianMs: median(values), maxMs: Math.max(...values) });
      const d1 = measured.length ? stats(measured) : { minMs: null, medianMs: null, maxMs: null };
      add('d1_latency_series', seriesTitle, ok ? 'pass' : 'fail', {
        samples: latencies.length,
        latencyMs: latencies,
        ...d1,
        spreadRatio: d1.medianMs ? Math.round((d1.maxMs / d1.medianMs) * 100) / 100 : null,
        roundTrip: stats(roundTrips),
        durableAll,
        reason: ok ? null : !durableAll ? 'not_durable_in_series' : 'latency_not_reported',
        note: 'المصدر storage.latencyMs من /readyz (كتابة رمز + قراءته داخل العامل)؛ لا عتبة بعد — القياس أولًا.'
      });
    } catch (error) {
      add('d1_latency_series', seriesTitle, 'fail', { reason: error?.code || error?.name || 'request_failed' });
    }

    // 4e. Owner MCP surface is gated: no token → 401.
    try {
      const gate = await get('/mcp');
      add('edge_auth_gate', 'خادم MCP على الحافة يرفض الطلب بلا رمز المالك (401)', gate.status === 401 ? 'pass' : 'fail', { httpStatus: gate.status });
    } catch (error) {
      add('edge_auth_gate', 'خادم MCP على الحافة يرفض الطلب بلا رمز المالك (401)', 'fail', { reason: error?.code || error?.name || 'request_failed' });
    }

    // 5e. With owner token (env only): JSON-RPC 2.0 `tools/list` returns the 12 official Celia tools.
    if (!token) {
      add('edge_mcp_tools', 'POST /mcp (tools/list) يعيد أدوات سيليا الـ12', 'skipped', { reason: 'CELIA_MCP_API_TOKEN not provided to this process' });
    } else {
      try {
        const startedAt = now();
        const rpcRes = await fetchImpl(`${base}/mcp`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs)
        });
        const elapsedMs = Math.round(now() - startedAt);
        const rpcBody = await rpcRes.json().catch(() => null);
        const tools = Array.isArray(rpcBody?.result?.tools) ? rpcBody.result.tools : [];
        const ok = rpcRes.status === 200 && tools.length === 12;
        add('edge_mcp_tools', 'POST /mcp (tools/list) يعيد أدوات سيليا الـ12', ok ? 'pass' : 'fail', {
          httpStatus: rpcRes.status,
          toolsCount: tools.length,
          elapsedMs
        });
      } catch (error) {
        add('edge_mcp_tools', 'POST /mcp (tools/list) يعيد أدوات سيليا الـ12', 'fail', { reason: error?.code || error?.name || 'request_failed' });
      }
    }

    // 6e. Governed scheduler (DEC-042): cron writes go through the D1 outbox and need the owner's approval. The
    //     owner-gated status endpoint proves the deployed code *and* the `0003_cron_outbox` migration (outbox counts
    //     come from the table itself). The token is used for the request and nowhere else.
    const cronTitle = 'GET /api/cron/status يعيد writes=outbox-approval-only مع durable=true وجدول outbox موجود (DEC-042)';
    if (!token) {
      add('edge_cron_governed', cronTitle, 'skipped', { reason: 'CELIA_MCP_API_TOKEN not provided to this process' });
      add('edge_reply_metrics', 'GET /api/whatsapp/reply-metrics يعيد عدد الردود ونسبة المقصوص منها بحسب السبب (DEC-050)', 'skipped', { reason: 'CELIA_MCP_API_TOKEN not provided to this process' });
      return finish();
    }
    try {
      const cron = await get('/api/cron/status', { authorization: `Bearer ${token}` });
      const body = cron.body || {};
      const outboxOk = body.outbox && typeof body.outbox === 'object' && !body.outbox.error;
      const ok =
        cron.status === 200 &&
        body.mode === 'governed-scheduler' &&
        body.writes === 'outbox-approval-only' &&
        body.durable === true &&
        body.decision === 'DEC-042' &&
        Boolean(outboxOk);
      add('edge_cron_governed', cronTitle, ok ? 'pass' : 'fail', {
        httpStatus: cron.status,
        mode: body.mode ?? null,
        writes: body.writes ?? null,
        durable: body.durable ?? null,
        configured: body.configured ?? null,
        decision: body.decision ?? null,
        outbox: outboxOk ? body.outbox : { error: body.outbox?.error ?? 'missing' }
      });
    } catch (error) {
      add('edge_cron_governed', cronTitle, 'fail', { reason: error?.code || error?.name || 'request_failed' });
    }

    // 7e. Truncated-reply ratio (WP-1.4, DEC-050): the number that must be known before `maxOutputTokens` changes.
    //     `replies: 0` with `truncatedRatio: null` is a valid measurement ("nothing generated yet"), never a failure;
    //     a 404/503 means old code or a missing `0004_reply_metrics` migration and fails.
    const metricsTitle = 'GET /api/whatsapp/reply-metrics يعيد عدد الردود ونسبة المقصوص منها بحسب السبب (DEC-050)';
    try {
      const metrics = await get('/api/whatsapp/reply-metrics?days=30', { authorization: `Bearer ${token}` });
      const body = metrics.body || {};
      const ok =
        metrics.status === 200 &&
        body.ok === true &&
        Number.isInteger(body.replies) &&
        Number.isInteger(body.truncated) &&
        Number.isInteger(body.maxOutputTokens) &&
        body.decision === 'DEC-050';
      add('edge_reply_metrics', metricsTitle, ok ? 'pass' : 'fail', {
        httpStatus: metrics.status,
        replies: body.replies ?? null,
        truncated: body.truncated ?? null,
        truncatedRatio: body.truncatedRatio ?? null,
        byReason: body.byReason ?? null,
        byProvider: body.byProvider ?? null,
        maxOutputTokens: body.maxOutputTokens ?? null,
        charCap: body.charCap ?? null,
        windowDays: body.windowDays ?? null,
        lastAt: body.lastAt ?? null,
        reason: ok ? null : body.reason ?? body.error ?? (metrics.status === 404 ? 'route_missing' : 'unexpected_shape')
      });
    } catch (error) {
      add('edge_reply_metrics', metricsTitle, 'fail', { reason: error?.code || error?.name || 'request_failed' });
    }

    // WA-007 / VER-05: the self-service WhatsApp surface must be deployed and must NOT
    // claim a live Meta link. This proves the page and account API shipped; it deliberately
    // does not assert that onboarding is configured, because that is an operator setting.
    try {
      // `get()` parses JSON; the page is HTML, so read it as text on its own.
      const response = await fetchImpl(`${base}/whatsapp`, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      const html = await response.text();
      const page = { status: response.status };
      const served = page.status === 200 && html.includes('id="connect"') && html.includes('dir="rtl"');
      add('whatsapp_page', 'صفحة /whatsapp منشورة بالعربية وتحتوي زر الربط وحساب المستخدم', served ? 'pass' : 'fail', {
        httpStatus: page.status,
        hasConnectButton: html.includes('id="connect"'),
        hasAccountPanel: html.includes('id="account-panel"'),
        bytes: html.length
      });
    } catch (error) {
      add('whatsapp_page', 'صفحة /whatsapp منشورة بالعربية وتحتوي زر الربط وحساب المستخدم', 'fail', { reason: error?.code || error?.name || 'request_failed' });
    }

    try {
      // An unauthenticated caller must be refused, never handed an owner session.
      const me = await get('/api/account/me');
      const status = await get('/api/whatsapp/session/status');
      const ok = me.status === 401 && status.status === 401;
      add('whatsapp_auth_gate', 'واجهات الحساب والربط ترفض الزائر بلا جلسة (401) ولا تمنح جلسة مالك', ok ? 'pass' : 'fail', {
        accountMeStatus: me.status,
        sessionStatus: status.status
      });
    } catch (error) {
      add('whatsapp_auth_gate', 'واجهات الحساب والربط ترفض الزائر بلا جلسة (401) ولا تمنح جلسة مالك', 'fail', { reason: error?.code || error?.name || 'request_failed' });
    }

    // VER-09: report whether the ordinary-user linking flow can actually start. This is
    // an operator setting, not a code defect, so it is reported as `skipped` with the
    // missing setting names (never values) instead of failing the deploy or hiding it.
    try {
      // Reuse the ready_durable probe: an extra /readyz would pollute the D1 latency series.
      const onboarding = onboardingReadiness;
      const configured = onboarding?.configured === true;
      add('whatsapp_onboarding_config', 'تهيئة Meta جاهزة لبدء ربط المستخدم العادي (أسماء الإعدادات الناقصة فقط، بلا قيم)', configured ? 'pass' : 'skipped', {
        configured,
        missing: Array.isArray(onboarding?.missing) ? onboarding.missing : null,
        reason: configured ? null : 'operator_settings_missing'
      });
    } catch (error) {
      add('whatsapp_onboarding_config', 'تهيئة Meta جاهزة لبدء ربط المستخدم العادي (أسماء الإعدادات الناقصة فقط، بلا قيم)', 'skipped', { reason: error?.code || error?.name || 'request_failed' });
    }

    // VER-08: prove the account tables really exist in D1. A 401 from /api/account/me
    // only proves the cookie guard; a login with a non-existent address must reach the
    // database and answer 401 invalid_email_or_password. A missing table answers 5xx.
    // This writes one rate-limit row for a synthetic address and creates no account.
    try {
      const probe = await fetchImpl(`${base}/api/account/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base, 'x-celia-request': 'whatsapp' },
        body: JSON.stringify({ email: 'acceptance-probe@example.invalid', password: 'not-a-real-password-000' }),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs)
      });
      const body = await probe.json().catch(() => ({}));
      const ok = probe.status === 401 && body?.error === 'invalid_email_or_password';
      add('whatsapp_accounts_schema', 'جداول الحسابات مُرحّلة فعليًا في D1 (تسجيل دخول لعنوان غير موجود يرد 401 لا 5xx)', ok ? 'pass' : 'fail', {
        httpStatus: probe.status,
        error: body?.error ?? null,
        note: 'synthetic address; no account is created'
      });
    } catch (error) {
      add('whatsapp_accounts_schema', 'جداول الحسابات مُرحّلة فعليًا في D1 (تسجيل دخول لعنوان غير موجود يرد 401 لا 5xx)', 'fail', { reason: error?.code || error?.name || 'request_failed' });
    }

    return finish();
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
      'Usage: npm run verify:live -- --url https://<service> [--expect-commit <sha>] [--expect-version <semver>] [--d1-samples <n>] ' +
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
    mode: options.mode,
    token: env.CELIA_MCP_API_TOKEN || null,
    expectCommit: options.expectCommit,
    d1Samples: options.d1Samples,
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
  // On GitHub Actions every failed check becomes an annotation that names the check id and its reason, so a red
  // deploy run says *which* gate failed on the run summary itself (the logs/artifacts are not always reachable).
  if (env.GITHUB_ACTIONS === 'true') {
    for (const check of report.checks.filter((entry) => entry.status === 'fail')) {
      const reason = check.detail?.reason ?? check.detail?.httpStatus ?? '';
      stdout.write(`::error title=verify-live ${check.id}::${check.id}${reason === '' ? '' : ` (${reason})`} — ${check.title}\n`);
    }
  }
  return report.verdict === 'pass' ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = await runCli();
}
