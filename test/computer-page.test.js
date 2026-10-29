// The computer-use page is a visual explainer, and a visual explainer is exactly where a repository starts
// claiming things it cannot do. These tests pin the two properties that keep it honest — it says what is not
// implemented, and it makes no external request — plus the ordinary things that rot quietly (dead links,
// reduced-motion, navigation).
//
// They read the *source* page in `public/`, so they never race the single `build()` that `test/static-shim.test.js`
// performs (two concurrent builds share one `dist/` directory and delete it under each other).
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PUBLIC_DIR, ROOT } from '../scripts/build-pages.mjs';

const html = await readFile(path.join(PUBLIC_DIR, 'computer.html'), 'utf8');
const css = await readFile(path.join(PUBLIC_DIR, 'computer.css'), 'utf8');
const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(([, href]) => href);

test('computer page: the whole page asks for nothing from a third party', () => {
  const external = hrefs.filter((href) => /^https?:\/\//i.test(href));
  assert.deepEqual(external, [], `external links found: ${external.join(', ')}`);
  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\./i);
  assert.doesNotMatch(html, /<(script|img|iframe)[^>]+src=/i, 'no remote script, image or frame');
  assert.doesNotMatch(css, /url\(\s*['"]?https?:/i, 'no remote font or image in the stylesheet');
  assert.doesNotMatch(css, /@import/i);
  assert.match(html, /href="\.\/fonts\.css"/, 'fonts are self-hosted like every other page');
});

test('computer page: it never presents the engine or the numbers as running reality', () => {
  assert.match(html, /عرض توضيحي/, 'the illustrative nature must be stated in the page');
  assert.match(html, /غير مُفعَّل/, 'the computer-use engine must be declared inactive');
  assert.match(html, /AGENT-003/, 'the decision that keeps it inactive is named, not vague');
  for (const kpi of ['5/5', '100%', '0', '3']) {
    assert.ok(html.includes(`<b>${kpi}</b>`), `KPI ${kpi} missing`);
  }
  // Every KPI label carries the word "توضيحي", so a screenshot cannot be quoted as a measurement.
  const kpiLabels = [...html.matchAll(/<div class="cu-kpi"><b>[^<]+<\/b><span>([^<]+)<\/span>/g)].map(([, label]) => label);
  assert.equal(kpiLabels.length, 4);
  for (const label of kpiLabels) assert.match(label, /توضيحي/, `KPI label "${label}" must be marked illustrative`);
  assert.match(html, /ليست تشغيلًا حيًّا/);
  assert.match(html, /ليست قياسًا/);
  // The route to the real state must be one click away, not a footnote promise.
  assert.match(html, /href="\.\/system"/);
});

test('computer page: the trace is labelled static instead of pretending to stream', () => {
  assert.match(html, /عرض ثابت/);
  assert.doesNotMatch(html, /الوكيل نشط/, 'a pulsing "agent active" badge on static markup would be a false signal');
  assert.match(html, /role="img"[\s\S]{0,200}aria-label="مثال توضيحي/);
  // A blocked step is part of the design, not an afterthought.
  assert.match(html, /<em class="x">محظور<\/em>/);
});

test('computer page: reduced-motion is honoured for every animated element', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(block, /animation: none !important/);
  assert.match(block, /transition: none !important/);
  // The moving pieces exist in the first place (otherwise the guard would be decoration).
  for (const keyframe of ['cu-sh', 'cu-ping', 'cu-pl', 'cu-in']) {
    assert.ok(css.includes(`@keyframes ${keyframe}`), `@keyframes ${keyframe} missing`);
  }
});

test('computer page: accessible structure', () => {
  assert.match(html, /<html lang="ar" dir="rtl">/);
  assert.match(html, /<a class="cu-skip" href="#main-content">/);
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, 'exactly one h1');
  assert.match(html, /aria-current="page"/);
  assert.ok(html.includes('data-page="computer"'));
  // Decorative icons must be hidden from assistive technology.
  const svgs = [...html.matchAll(/<svg(?![^>]*aria-hidden)[^>]*>/g)];
  assert.deepEqual(svgs.map(([tag]) => tag), [], 'every inline svg must be aria-hidden');
  // The colour pair used for text must not be the only signal: statuses carry words too.
  for (const word of ['تم', 'محظور']) assert.ok(html.includes(word), `status word ${word} missing`);
});

test('computer page: every internal link resolves to a page that exists', async () => {
  const internal = hrefs
    .filter((href) => href.startsWith('./'))
    .map((href) => href.split(/[?#]/)[0].replace(/^\.\//, ''))
    .filter(Boolean);
  assert.ok(internal.length >= 6, 'the page should link back into the site');
  for (const target of new Set(internal)) {
    const candidates = [target, `${target}.html`].map((name) => path.join(PUBLIC_DIR, name));
    let found = false;
    for (const candidate of candidates) {
      try {
        await access(candidate);
        found = true;
        break;
      } catch {
        /* try the next candidate */
      }
    }
    assert.ok(found, `dead link: ./${target}`);
  }
});

test('computer page: it is reachable from the studio and from the status page', async () => {
  for (const page of ['index.html', 'system.html']) {
    const source = await readFile(path.join(PUBLIC_DIR, page), 'utf8');
    assert.match(source, /href="\.\/computer"/, `${page} must link to the computer page`);
  }
  // The extension-less form is rewritten at build time; the rewrite map has to know this page.
  // The extension-less form is rewritten at build time; the rewrite map has to know this page.
  const buildScript = await readFile(path.join(ROOT, 'scripts/build-pages.mjs'), 'utf8');
  const rewriteFn = buildScript.slice(
    buildScript.indexOf('function rewriteStaticHostLinks'),
    buildScript.indexOf('export async function build')
  );
  assert.match(rewriteFn, /computer/, 'the rewrite map must know ./computer');
  assert.match(rewriteFn, /computer\.html/, 'and must point it at computer.html');
});

test('computer page: Express UI router serves /computer, /computer-permissions, and /computer.css with strict CSP', async () => {
  const { connectPoolWithFallback, createCeliaMcpApp, loadCeliaMcpConfig } = await import('../src/celia-mcp.js');
  const config = loadCeliaMcpConfig(
    {
      NODE_ENV: 'test',
      CELIA_MCP_API_TOKEN: 'c'.repeat(48),
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      CELIA_MCP_DISABLE_MYSQL: 'true',
      CELIA_DISABLE_OLLAMA: 'true'
    },
    { requireToken: true }
  );
  const pool = await connectPoolWithFallback(config);
  const app = createCeliaMcpApp({ pool, config });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    for (const route of ['/computer', '/computer.html', '/computer-permissions', '/computer-permissions.html']) {
      const res = await fetch(`${baseUrl}${route}`);
      assert.equal(res.status, 200, `${route} must return HTTP 200 on Express UI router`);
      assert.match(res.headers.get('content-type') || '', /text\/html/);
      assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
      const body = await res.text();
      assert.ok(body.length > 500, `${route} body should not be empty`);
    }
    const cssRes = await fetch(`${baseUrl}/computer.css`);
    assert.equal(cssRes.status, 200, '/computer.css must return HTTP 200');
    assert.match(cssRes.headers.get('content-type') || '', /text\/css/);
    await pool.end?.();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

