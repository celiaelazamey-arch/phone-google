/**
 * M-C/C1 — اختبارات وسيط الخروج (egress proxy).
 *
 * كلها حقيقية على مقابس محلية: خادم وجهة وهمي، خادم «شرير» يجب ألا يُلمس، وخادم
 * وسيط فعلي. لا إنترنت إطلاقًا — لكن لا محاكاة للمقابس أيضًا، فالسلوك المقاس هو
 * سلوك HTTP/CONNECT الحقيقي.
 *
 * الخصائص المحروسة: لا منحة = لا حزمة؛ القرار قبل DNS؛ كل قرار في سجل تدقيق؛
 * السقوف تقطع الدفق؛ ولا سرّ يتسرب إلى السجل.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {
  EGRESS_DECISION,
  createEgressAllowlist,
  createEgressProxy,
  createEvidenceEgressSink,
  normalizeEgressHost
} from '../src/agent/egress-proxy.js';
import { createTempStore } from './support/agent-fixtures.js';

const TOKEN_HEADER = (token) => ({ 'proxy-authorization': `Bearer ${token}` });

async function startUpstream(handler = null) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, headers: req.headers });
    if (handler) return handler(req, res);
    res.writeHead(200, { 'content-type': 'text/plain', 'x-upstream': 'yes' });
    res.end('ok-body');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    calls,
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

/** طلب عبر الوسيط بصيغة absolute-form — تمامًا كما يفعل عميل يستخدم HTTP_PROXY. */
function proxiedGet({ proxyPort, token, target, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method,
        path: target,
        headers: { ...(token ? TOKEN_HEADER(token) : {}), ...headers }
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (error) => resolve({ status: res.statusCode, error: error.code || 'aborted', body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    // قطع الدفق عند تجاوز السقف هو سلوك مقصود: يُبلَّغ عنه لا يُرمى كخطأ اختبار.
    req.on('error', (error) => resolve({ status: 0, error: error.code || 'aborted', body: '' }));
    if (body) req.write(body);
    req.end();
  });
}

async function setupProxy(t, { limits = {}, onEvent = null } = {}) {
  const events = [];
  const proxy = createEgressProxy({
    clock: () => now,
    limits,
    onEvent: onEvent || ((event) => {
      events.push(event);
    })
  });
  let now = Date.now();
  const address = await proxy.listen({ port: 0 });
  t.after(async () => {
    await proxy.close();
  });
  return {
    proxy,
    events,
    proxyPort: address.port,
    setNow: (value) => {
      now = value;
    },
    advance: (ms) => {
      now += ms;
    }
  };
}

// ─── 1. دلالات القائمة: دقيقة، ومحدودة، ولا «*» ────────────────────────────

test('EP-01: the allowlist is exact-or-subdomain, port-aware, ASCII-only and refuses a catch-all wildcard', () => {
  const list = createEgressAllowlist({ hosts: ['api.example.com', 'Files.Example.COM:443', '*.cdn.example.com'] });
  assert.equal(list.size, 3);
  assert.equal(list.allows({ host: 'api.example.com', port: 80 }), true, 'a bare host allows any port');
  assert.equal(list.allows({ host: 'API.EXAMPLE.COM.', port: 8080 }), true, 'case and trailing dot normalize');
  assert.equal(list.allows({ host: 'files.example.com', port: 443 }), true);
  assert.equal(list.allows({ host: 'files.example.com', port: 80 }), false, 'the declared port is a boundary');
  assert.equal(list.allows({ host: 'a.cdn.example.com', port: 443 }), true);
  assert.equal(list.allows({ host: 'a.b.cdn.example.com', port: 443 }), true);
  assert.equal(list.allows({ host: 'cdn.example.com', port: 443 }), false, 'a wildcard never matches the apex');
  assert.equal(list.allows({ host: 'evilcdn.example.com', port: 443 }), false, 'suffix matching is label-aware');
  assert.equal(list.allows({ host: 'example.com', port: 443 }), false);
  assert.equal(list.allows({ host: '127.0.0.1', port: 80 }), false, 'an IP is never implicitly allowed');
  assert.equal(list.allows({ host: '', port: 80 }), false);

  // لا قائمة = منعٌ للجميع، وليس سماحًا للجميع.
  assert.equal(createEgressAllowlist({ hosts: [] }).size, 0);
  assert.equal(createEgressAllowlist({ hosts: [] }).allows({ host: 'example.com', port: 443 }), false);

  for (const hostile of ['*', '*:*', '**', 'http://example.com', 'example.com/path', 'user@example.com', 'example.com?x=1', '']) {
    assert.throws(() => createEgressAllowlist({ hosts: [hostile] }), (error) => typeof error.code === 'string', `${hostile} must be refused`);
  }
  assert.throws(
    () => createEgressAllowlist({ hosts: ['*.'] }),
    (error) => typeof error.code === 'string',
    'a wildcard with no name is refused, whatever its exact code'
  );
  // شبكة عربية غير مطبَّعة (IDN) تُرفض صراحة بدل مقارنتها بصمت.
  assert.throws(() => normalizeEgressHost('مثال.مصر'), (error) => error.code === 'egress_host_invalid');
  assert.equal(normalizeEgressHost('[::1]'), '::1');
});

// ─── 2. المنحة: لا رمز = لا حزمة ────────────────────────────────────────────

test('EP-02: a missing, unknown or expired grant is refused with 407 before any target is resolved or contacted', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const harness = await setupProxy(t);

  const noToken = await proxiedGet({ proxyPort: harness.proxyPort, target: `${upstream.url}/x` });
  assert.equal(noToken.status, 407);
  assert.equal(JSON.parse(noToken.body).code, 'egress_grant_required');

  const badToken = await proxiedGet({ proxyPort: harness.proxyPort, token: 'f'.repeat(64), target: `${upstream.url}/x` });
  assert.equal(badToken.status, 407);
  assert.equal(JSON.parse(badToken.body).code, 'egress_grant_invalid');

  const grant = harness.proxy.issueGrant({ runId: 'run-ep02', allowlist: [`127.0.0.1:${upstream.port}`], ttlMs: 1_000 });
  harness.advance(2_000);
  const expired = await proxiedGet({ proxyPort: harness.proxyPort, token: grant.token, target: `${upstream.url}/x` });
  assert.equal(expired.status, 407);
  assert.equal(JSON.parse(expired.body).code, 'egress_grant_expired');

  assert.equal(upstream.calls.length, 0, 'a refused grant never reaches the target');
  assert.equal(harness.events.filter((event) => event.decision === EGRESS_DECISION.block).length, 3);
  assert.equal(harness.proxy.activeGrants().length, 0, 'the expired grant is dropped, not kept alive');
});

// ─── 3. المسار المسموح: تمريرة واحدة، ترويسات منظَّفة، تدقيق كامل ─────────────

test('EP-03: an allowed request is forwarded once with hop-by-hop headers stripped and one audit record', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const harness = await setupProxy(t);
  const grant = harness.proxy.issueGrant({ runId: 'run-ep03', allowlist: [`127.0.0.1:${upstream.port}`] });

  const response = await proxiedGet({
    proxyPort: harness.proxyPort,
    token: grant.token,
    target: `${upstream.url}/hello?secret=abc`,
    headers: { 'x-owner': 'celia', 'proxy-connection': 'keep-alive' }
  });
  assert.equal(response.status, 200);
  assert.equal(response.body, 'ok-body');
  assert.equal(response.headers['x-upstream'], 'yes');
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0].url, '/hello?secret=abc');
  assert.equal(upstream.calls[0].headers['proxy-authorization'], undefined, 'the grant never leaves the proxy');
  assert.equal(upstream.calls[0].headers['proxy-connection'], undefined, 'hop-by-hop headers are dropped');
  assert.equal(upstream.calls[0].headers['x-owner'], 'celia', 'ordinary headers pass through');

  const [event] = harness.events;
  assert.equal(event.decision, EGRESS_DECISION.allow);
  assert.equal(event.reason, 'egress_forwarded');
  assert.equal(event.status, 200);
  assert.equal(event.runId, 'run-ep03');
  assert.equal(event.host, '127.0.0.1');
  assert.equal(event.path, '/hello', 'the query string is not recorded');
  assert.ok(event.bytesIn >= 7);
  assert.equal(harness.proxy.stats().allowed, 1);
});

// ─── 4. مضيف غير مسموح: قرار قبل DNS، وصفر اتصال ────────────────────────────

test('EP-04: a host outside the run allowlist is refused 403 without any DNS lookup or connection', async (t) => {
  const evil = await startUpstream(() => {
    throw new Error('this upstream must never be reached');
  });
  t.after(() => evil.close());
  const harness = await setupProxy(t);
  const grant = harness.proxy.issueGrant({ runId: 'run-ep04', allowlist: ['allowed.example.com'] });

  // اسم لا يُحلّ أصلًا: لو حاول الوسيط الـDNS لانتهى بـ502 بدل 403.
  const blocked = await proxiedGet({ proxyPort: harness.proxyPort, token: grant.token, target: `http://evil.not-allowed.invalid:${evil.port}/steal` });
  assert.equal(blocked.status, 403);
  assert.equal(JSON.parse(blocked.body).code, 'egress_host_not_allowed');

  const blockedIp = await proxiedGet({ proxyPort: harness.proxyPort, token: grant.token, target: `${evil.url}/steal` });
  assert.equal(blockedIp.status, 403, 'an IP that is not listed is refused like any other host');

  assert.equal(evil.calls.length, 0);
  const blocks = harness.events.filter((event) => event.reason === 'egress_host_not_allowed');
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every((event) => event.decision === EGRESS_DECISION.block && event.status === 403));
  assert.equal(harness.proxy.stats().blocked, 2);
});

// ─── 5. النفق CONNECT: نفس القرار، وحجمه معلن ───────────────────────────────

function connectTunnel({ proxyPort, token, target, payload = 'ping' }) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: target,
      headers: token ? TOKEN_HEADER(token) : {}
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return resolve({ status: res.statusCode, data: '' });
      }
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
        socket.destroy();
        resolve({ status: res.statusCode, data });
      });
      socket.write(payload);
    });
    req.on('error', () => resolve({ status: 407, data: '' }));
    req.end();
  });
}

test('EP-05: CONNECT tunnels only to allowlisted host:port, and a refused tunnel is closed with 403', async (t) => {
  const echo = net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(`echo:${chunk.toString('utf8')}`));
  });
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => echo.close(() => resolve())));
  const echoPort = echo.address().port;

  const harness = await setupProxy(t);
  const grant = harness.proxy.issueGrant({ runId: 'run-ep05', allowlist: [`127.0.0.1:${echoPort}`] });

  const allowed = await connectTunnel({ proxyPort: harness.proxyPort, token: grant.token, target: `127.0.0.1:${echoPort}` });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.data, 'echo:ping');

  const blocked = await connectTunnel({ proxyPort: harness.proxyPort, token: grant.token, target: '127.0.0.1:9' });
  assert.equal(blocked.status, 403, 'another port on an allowlisted host is still a different destination');

  const sawTunnel = await waitFor(() => harness.events.some((event) => event.method === 'CONNECT' && event.decision === EGRESS_DECISION.allow));
  assert.equal(sawTunnel, true, 'the tunnel close is evidenced');
  const tunnelEvent = harness.events.find((event) => event.method === 'CONNECT' && event.decision === EGRESS_DECISION.allow);
  assert.ok(tunnelEvent.bytesIn >= 9 && tunnelEvent.bytesOut >= 4, 'both directions are counted');
});

test('EP-06: the per-grant tunnel ceiling refuses the next CONNECT with 429', async (t) => {
  const echo = net.createServer((socket) => socket.on('data', (chunk) => socket.write(chunk)));
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => echo.close(() => resolve())));
  const echoPort = echo.address().port;
  const harness = await setupProxy(t, { limits: { maxTunnelsPerGrant: 1 } });
  const grant = harness.proxy.issueGrant({ runId: 'run-ep06', allowlist: [`127.0.0.1:${echoPort}`] });

  const first = http.request({ host: '127.0.0.1', port: harness.proxyPort, method: 'CONNECT', path: `127.0.0.1:${echoPort}`, headers: TOKEN_HEADER(grant.token) });
  const established = await new Promise((resolve) => {
    first.on('connect', (res, socket) => resolve({ res, socket }));
    first.end();
  });
  assert.equal(established.res.statusCode, 200);

  const second = await connectTunnel({ proxyPort: harness.proxyPort, token: grant.token, target: `127.0.0.1:${echoPort}` });
  assert.equal(second.status, 429);

  established.socket.destroy();
});

// ─── 7. السقوف تقطع الدفق ولا تخزّنه ───────────────────────────────────────

test('EP-07: a response above the byte ceiling aborts the stream, is evidenced as blocked and truncated', async (t) => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('a'.repeat(2_048));
    res.end('a'.repeat(2_048));
  });
  t.after(() => upstream.close());
  const harness = await setupProxy(t, { limits: { maxResponseBytes: 1_024 } });
  const grant = harness.proxy.issueGrant({ runId: 'run-ep07', allowlist: [`127.0.0.1:${upstream.port}`] });

  const response = await proxiedGet({ proxyPort: harness.proxyPort, token: grant.token, target: `${upstream.url}/big` });
  assert.ok(response.status === 0 || response.body.length <= 1_024 + 64, 'the client never buffers the whole oversized body');
  const sawBlock = await waitFor(() => harness.events.some((event) => event.reason === 'egress_response_too_large'));
  assert.equal(sawBlock, true, 'the oversize decision is recorded');
  const event = harness.events.find((row) => row.reason === 'egress_response_too_large');
  assert.equal(event.decision, EGRESS_DECISION.block);
  assert.equal(event.reason, 'egress_response_too_large');
  assert.equal(event.truncated, true);
  assert.ok(event.bytesIn > 1_024);
});

// ─── 8. لا سرّ في السجل ────────────────────────────────────────────────────

test('EP-08: the audit trail carries no credential, no header value and no query string', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const harness = await setupProxy(t);
  const grant = harness.proxy.issueGrant({ runId: 'run-ep08', allowlist: [`127.0.0.1:${upstream.port}`] });

  await proxiedGet({
    proxyPort: harness.proxyPort,
    token: grant.token,
    target: `${upstream.url}/p?token=super-secret-value`,
    headers: { cookie: 'session=leaky', authorization: 'Bearer upstream-secret' }
  });
  await proxiedGet({ proxyPort: harness.proxyPort, token: grant.token, target: `${upstream.url}/p?again=super-secret-value` });

  const serialized = JSON.stringify(harness.events);
  assert.equal(serialized.includes(grant.token), false, 'the grant token is never written down');
  assert.equal(serialized.includes('super-secret-value'), false, 'query strings are not recorded');
  assert.equal(serialized.includes('leaky'), false, 'cookie values are not recorded');
  assert.equal(serialized.includes('upstream-secret'), false, 'authorization headers are not recorded');
  assert.ok(harness.events.every((event) => Object.keys(event).every((key) => key !== 'headers')));
});

// ─── 9. التدقيق الدائم في سلسلة الأدلة ──────────────────────────────────────

test('EP-09: the evidence sink writes one verifiable chain row per decision, with BLOCK for refusals', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const upstream = await startUpstream();
  t.after(() => upstream.close());

  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'C1 egress' });
  const { run } = await fixture.store.createRun({
    threadId: thread.id,
    ownerId: 'owner',
    planner: 'c1-fixture',
    maxSteps: 4,
    maxCostMicros: 10_000
  });

  const proxy = createEgressProxy({ onEvent: createEvidenceEgressSink({ store: fixture.store }) });
  const address = await proxy.listen({ port: 0 });
  t.after(() => proxy.close());

  // مسار audit متزامن: ننتظر ظهور صفّي الأدلة بدل افتراض التوقيت.
  const grant = proxy.issueGrant({ runId: run.id, allowlist: [`127.0.0.1:${upstream.port}`] });
  await proxiedGet({ proxyPort: address.port, token: grant.token, target: `${upstream.url}/ok` });
  await proxiedGet({ proxyPort: address.port, token: grant.token, target: `http://blocked.invalid:${upstream.port}/no` });

  const rows = await fixture.store.listEvidence(run.id);
  const expected = await waitFor(() => rows.length >= 2);
  assert.equal(expected, true, 'both decisions reached the evidence chain');

  const chain = await fixture.store.verifyEvidenceChain(run.id);
  assert.equal(chain.ok, true);
  const fresh = await fixture.store.listEvidence(run.id);
  const egress = fresh.filter((row) => row.kind === 'egress_request');
  assert.equal(egress.length, 2);
  assert.deepEqual(egress.map((row) => row.verdict).sort(), ['BLOCK', 'PASS']);
});

async function waitFor(predicate, { attempts = 50, delayMs = 20 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

// ─── 10. لا شبكة بلا منحة: الافتراضي في كائن الوسيط نفسه ────────────────────

test('EP-10: a fresh proxy grants nothing, and revoking a run drops its tunnels authority immediately', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const harness = await setupProxy(t);
  assert.deepEqual(harness.proxy.activeGrants(), []);
  assert.equal(harness.proxy.stats().activeGrants, 0);

  const grant = harness.proxy.issueGrant({ runId: 'run-ep10', allowlist: [`127.0.0.1:${upstream.port}`] });
  assert.equal(harness.proxy.activeGrants().length, 1);
  assert.equal(harness.proxy.revokeRun('run-ep10'), 1);
  const refused = await proxiedGet({ proxyPort: harness.proxyPort, token: grant.token, target: `${upstream.url}/x` });
  assert.equal(refused.status, 407);
  assert.equal(upstream.calls.length, 0);
  assert.equal(harness.proxy.revokeGrant(grant.token), false, 'revoking twice is a no-op, never an error');
});

// ─── 11. لا يُفتح allowlist داخل العزل قبل أن يُركَّب الوسيط (C1-b) ──────────

test('EP-11: the sandbox still refuses to open its own allowlist — permanently, by DEC-060', async () => {
  const { createSandboxPolicy } = await import('../src/agent/sandbox-policy.js');
  assert.throws(
    () => createSandboxPolicy({ network: { mode: 'deny', allowlist: ['api.example.com'] } }),
    /sandbox_egress_allowlist_backend_unavailable/
  );
  assert.throws(() => createSandboxPolicy({ network: { mode: 'allowlist' } }), /sandbox_network_must_default_deny/);
  const policy = createSandboxPolicy();
  assert.deepEqual(policy.network, { mode: 'deny', allowlist: [] }, 'the default is still a closed door');
});

// ─── 12. الرفض الشكلي: طريقة أو هدف غير صالح ───────────────────────────────

test('EP-14: a single global connection ceiling bounds in-flight requests, refuses the next one with 429 and audits it', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const upstream = await startUpstream(async (req, res) => {
    await gate;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('slow-ok');
  });
  t.after(() => upstream.close());
  const harness = await setupProxy(t, { limits: { maxConnections: 1 } });
  const grant = harness.proxy.issueGrant({ runId: 'run-ep14', allowlist: [`127.0.0.1:${upstream.port}`] });

  const first = proxiedGet({ proxyPort: harness.proxyPort, token: grant.token, target: `${upstream.url}/slow` });
  const inFlight = await waitFor(() => harness.proxy.stats().activeConnections === 1);
  assert.equal(inFlight, true, 'the first request is counted while it is open');

  // الثانية تُرفض عند السقف قبل أي اتصال بالوجهة.
  const before = upstream.calls.length;
  const refused = await proxiedGet({ proxyPort: harness.proxyPort, token: grant.token, target: `${upstream.url}/second` });
  assert.equal(refused.status, 429);
  assert.equal(refused.body.includes('egress_connection_limit'), true);
  assert.equal(upstream.calls.length, before, 'the refused request never reached the origin');
  assert.equal(
    await waitFor(() => harness.events.some((event) => event.reason === 'egress_connection_limit')),
    true,
    'the ceiling decision is audited like any other block'
  );

  release();
  const done = await first;
  assert.equal(done.status, 200);
  assert.equal(done.body, 'slow-ok');
  assert.equal(await waitFor(() => harness.proxy.stats().activeConnections === 0), true, 'the slot is released');

  // بعد التحرير يعمل الطلب التالي عاديًا: السقف ليس قاطعًا دائمًا.
  const after = await proxiedGet({ proxyPort: harness.proxyPort, token: grant.token, target: `${upstream.url}/after` });
  assert.equal(after.status, 200);
});

test('EP-12: unsupported methods and malformed or non-CONNECT https targets are refused with explicit codes', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const harness = await setupProxy(t);
  const grant = harness.proxy.issueGrant({ runId: 'run-ep12', allowlist: [`127.0.0.1:${upstream.port}`] });

  const trace = await proxiedGet({ proxyPort: harness.proxyPort, token: grant.token, target: `${upstream.url}/x`, method: 'TRACE' });
  assert.equal(trace.status, 405);
  assert.equal(JSON.parse(trace.body).code, 'egress_method_not_allowed');

  const https = await proxiedGet({ proxyPort: harness.proxyPort, token: grant.token, target: 'https://example.com/x' });
  assert.equal(https.status, 403);
  assert.equal(JSON.parse(https.body).code, 'egress_target_scheme_unsupported', 'TLS must go through CONNECT, not plain forwarding');

  const relative = await proxiedGet({ proxyPort: harness.proxyPort, token: grant.token, target: '/no-host' });
  assert.equal(relative.status, 403);
  assert.equal(JSON.parse(relative.body).code, 'egress_target_invalid');

  assert.equal(upstream.calls.length, 0);
  assert.equal(harness.events.length, 3);
  assert.ok(harness.events.every((event) => event.decision === EGRESS_DECISION.block));
});

// ─── 13. المهل والانقطاع: 504 و502 مسجّلان لا معلّقان ──────────────────────

test('EP-13: a silent upstream times out as 504 and a closed port settles as 502 — both evidenced', async (t) => {
  const silent = http.createServer(() => {
    /* يستقبل ولا يرد أبدًا */
  });
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => silent.close(() => resolve())));
  const silentPort = silent.address().port;

  // منفذ مغلق: نحجزه ثم نغلقه فورًا.
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const closedPort = closed.address().port;
  await new Promise((resolve) => closed.close(() => resolve()));

  const harness = await setupProxy(t, { limits: { timeoutMs: 200 } });
  const grant = harness.proxy.issueGrant({ runId: 'run-ep13', allowlist: [`127.0.0.1:${silentPort}`, `127.0.0.1:${closedPort}`] });

  const timedOut = await proxiedGet({ proxyPort: harness.proxyPort, token: grant.token, target: `http://127.0.0.1:${silentPort}/slow` });
  assert.equal(timedOut.status, 504);
  assert.equal(JSON.parse(timedOut.body).code, 'egress_upstream_timeout');

  const unreachable = await proxiedGet({ proxyPort: harness.proxyPort, token: grant.token, target: `http://127.0.0.1:${closedPort}/gone` });
  assert.equal(unreachable.status, 502);
  assert.equal(JSON.parse(unreachable.body).code, 'egress_upstream_unreachable');

  const reasons = harness.events.map((event) => event.reason);
  assert.ok(reasons.includes('egress_upstream_timeout'));
  assert.ok(reasons.includes('egress_upstream_unreachable'));
  assert.ok(harness.events.every((event) => event.status === 504 || event.status === 502));
});

test('EP-15 (CRIT-03): mid-stream upstream timeout after response headers are flushed aborts without ERR_HTTP_HEADERS_SENT', async (t) => {
  const halfStream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('partial-chunk');
    // Intentionally never call res.end() so proxy hits upstream timeout after headersSent=true.
  });
  t.after(() => halfStream.close());

  const harness = await setupProxy(t, { limits: { timeoutMs: 150 } });
  const grant = harness.proxy.issueGrant({ runId: 'run-ep14', allowlist: [`127.0.0.1:${halfStream.port}`] });

  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));

  const res = await Promise.race([
    proxiedGet({
      proxyPort: harness.proxyPort,
      token: grant.token,
      target: `${halfStream.url}/stall-mid-stream`
    }),
    new Promise((resolve) => setTimeout(() => resolve({ status: -1, body: 'hung' }), 800))
  ]);

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(uncaught.length, 0, `expected zero uncaught exceptions, got: ${uncaught.map((e) => e.code || e.message).join(', ')}`);
  assert.equal(res.status, 200);
  assert.equal(res.body, 'partial-chunk');
  assert.ok(harness.events.some((event) => event.reason === 'egress_upstream_timeout' && event.decision === EGRESS_DECISION.block));
});

test('EP-16 (CRIT-03): in-memory proxy events() log is bounded by limits.maxEvents while stats stay exact', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());

  const harness = await setupProxy(t, { limits: { maxEvents: 5 } });
  const grant = harness.proxy.issueGrant({ runId: 'run-ep15', allowlist: [`127.0.0.1:${upstream.port}`] });

  for (let i = 0; i < 12; i += 1) {
    const ok = await proxiedGet({ proxyPort: harness.proxyPort, token: grant.token, target: `${upstream.url}/item-${i}` });
    assert.equal(ok.status, 200);
  }

  const retained = harness.proxy.events();
  assert.equal(retained.length, 5, 'in-memory audit log stays capped at maxEvents');
  assert.equal(retained[0].path, '/item-7');
  assert.equal(retained[4].path, '/item-11');
  assert.equal(harness.proxy.stats().allowed, 12, 'cumulative counters remain exact');
});

test('EP-17 (CRIT-03): CONNECT pipelined head bytes are counted in bytesOut and enforced against maxRequestBytes', async (t) => {
  const received = [];
  const tcpUpstream = net.createServer((sock) => {
    sock.on('data', (chunk) => received.push(chunk));
  });
  await new Promise((resolve) => tcpUpstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => tcpUpstream.close(() => resolve())));
  const targetPort = tcpUpstream.address().port;

  const harness = await setupProxy(t, { limits: { maxRequestBytes: 1_024 } });
  const grant = harness.proxy.issueGrant({ runId: 'run-ep16', allowlist: [`127.0.0.1:${targetPort}`] });

  // Send a CONNECT request with a 1,200-byte pipelined head in the same TCP write so `head` is non-empty.
  const oversizedHead = Buffer.alloc(1_200, 0x61);
  await new Promise((resolve) => {
    const client = net.connect({ host: '127.0.0.1', port: harness.proxyPort }, () => {
      const reqHead = Buffer.from(
        `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nProxy-Authorization: Bearer ${grant.token}\r\n\r\n`,
        'ascii'
      );
      client.write(Buffer.concat([reqHead, oversizedHead]));
    });
    const timer = setTimeout(() => {
      client.destroy();
      resolve();
    }, 500);
    client.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    client.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(received.length, 0, 'oversized pipelined CONNECT head must not be forwarded');
  const blocked = harness.events.find((e) => e.reason === 'egress_request_too_large');
  assert.ok(blocked, 'expected egress_request_too_large audit event');
  assert.equal(blocked.bytesOut, 1_200);
});

