// OPS-007 — the scheduled-jobs dashboard is a thin owner console over the edge outbox API (DEC-042).
// These tests read the *source* page in `public/` (never racing the shared `dist/` build) and pin what keeps
// it honest: it calls only the governed `/api/cron/*` routes, it never fakes data when the key or D1 is
// missing, every write button produces an intent (not an upstream call), and the Express copy ships a CSP
// that admits exactly the edge origin — nothing else new.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PUBLIC_DIR, ROOT } from '../scripts/build-pages.mjs';
import { loadConfig } from '../src/config.js';

const html = await readFile(path.join(PUBLIC_DIR, 'cron.html'), 'utf8');
const js = await readFile(path.join(PUBLIC_DIR, 'cron.js'), 'utf8');
const css = await readFile(path.join(PUBLIC_DIR, 'cron.css'), 'utf8');

test('cron page: self-hosted assets, external module script, no third-party link or inline script', () => {
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(([, href]) => href);
  assert.deepEqual(hrefs.filter((href) => /^https?:\/\//i.test(href)), []);
  assert.doesNotMatch(html, /<script(?![^>]*src=)[^>]*>/i, 'no inline script (CSP script-src self)');
  assert.match(html, /<script src="\.\/cron\.js" type="module"><\/script>/);
  assert.match(html, /href="\.\/fonts\.css"/);
  assert.doesNotMatch(css, /url\(\s*['"]?https?:|@import/i);
  assert.match(html, /<html lang="ar" dir="rtl">/);
  for (const link of ['./agent', './kb', './system']) assert.ok(hrefs.includes(link), `nav link ${link} missing`);
});

test('cron page: the script speaks only to the governed edge routes and generates an Idempotency-Key per intent', () => {
  const paths = [...js.matchAll(/api\((?:`|')([^`'$]+)/g)].map(([, p]) => p);
  assert.ok(paths.length >= 5, `expected several api() calls, found ${paths.length}`);
  for (const p of paths) assert.match(p, /^\/api\/cron\//, `unexpected API path ${p}`);
  assert.doesNotMatch(js, /api\.cron-job\.org/, 'the browser never talks to cron-job.org itself');
  assert.match(js, /'idempotency-key': idempotencyKey\(/);
  assert.match(js, /expectedHash: intent\.payloadHash/, 'approval is bound to the displayed payload hash');
  assert.match(js, /\/reconcile`/, 'unknown intents are reconciled by the owner from the page');
  assert.match(js, /sessionStorage/);
  assert.doesNotMatch(js, /localStorage/, 'the owner token must not outlive the tab');
  assert.doesNotMatch(js, /innerHTML/, 'rows are built with DOM APIs, not HTML strings');
  assert.match(js, /window\.confirm\(/, 'approval and rejection ask before acting');
});

test('cron page: it states the governance rule and the honest not-configured states', () => {
  assert.match(html, /DEC-042/);
  assert.match(html, /صندوق الصادر|صندوق صادر/);
  assert.match(html, /لا يوجد وضع تجريبي/);
  assert.match(js, /غير مُهيأ — المفتاح غائب/);
  assert.match(js, /D1 غير مربوط/);
  assert.match(js, /cronjob_not_configured/);
  assert.match(js, /d1_not_bound/);
  for (const state of ['pending_approval', 'dispatching', 'applied', 'failed', 'unknown', 'rejected', 'not_applied']) {
    assert.match(js, new RegExp(`${state}:`), `status label for ${state} missing`);
  }
});

test('cron page: the static build knows ./cron and the Express router serves it with a CSP that admits the edge', async () => {
  const buildSource = await readFile(path.join(ROOT, 'scripts', 'build-pages.mjs'), 'utf8');
  assert.match(buildSource, /cron\\\/\?/, 'rewriteStaticHostLinks must map ./cron');
  assert.match(buildSource, /cron\.html/);

  const config = loadConfig({
    APP_API_TOKEN: 'a'.repeat(40),
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64')
  });
  assert.equal(config.edgeOrigin, 'https://celia-phone-google.celiaelazamey.workers.dev');
  const overridden = loadConfig({
    APP_API_TOKEN: 'a'.repeat(40),
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    CELIA_EDGE_ORIGIN: 'https://edge.example.com/some/path'
  });
  assert.equal(overridden.edgeOrigin, 'https://edge.example.com', 'only the origin is kept');
  const insecure = loadConfig({
    APP_API_TOKEN: 'a'.repeat(40),
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    CELIA_EDGE_ORIGIN: 'http://edge.example.com'
  });
  assert.equal(insecure.edgeOrigin, 'https://celia-phone-google.celiaelazamey.workers.dev', 'a non-https override is ignored');

  const { connectPoolWithFallback, createCeliaMcpApp, loadCeliaMcpConfig } = await import('../src/celia-mcp.js');
  const mcpConfig = loadCeliaMcpConfig(
    {
      NODE_ENV: 'test',
      CELIA_MCP_API_TOKEN: 'c'.repeat(48),
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      CELIA_MCP_DISABLE_MYSQL: 'true',
      CELIA_DISABLE_OLLAMA: 'true'
    },
    { requireToken: true }
  );
  const pool = await connectPoolWithFallback(mcpConfig);
  const app = createCeliaMcpApp({ pool, config: mcpConfig });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    for (const route of ['/cron', '/cron.html']) {
      const res = await fetch(`${baseUrl}${route}`);
      assert.equal(res.status, 200, `${route} must return HTTP 200`);
      assert.match(res.headers.get('content-type') || '', /text\/html/);
      const csp = res.headers.get('content-security-policy') || '';
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /connect-src [^;]*https:\/\/celia-phone-google\.celiaelazamey\.workers\.dev/, 'the page must be allowed to call the edge');
      assert.match(csp, /script-src 'self'/);
      const body = await res.text();
      assert.match(body, /المهام المجدولة/);
    }
    const cssRes = await fetch(`${baseUrl}/cron.css`);
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get('content-type') || '', /text\/css/);
    const jsRes = await fetch(`${baseUrl}/cron.js`);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get('content-type') || '', /javascript/);
    await pool.end?.();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
