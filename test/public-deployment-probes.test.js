import test from 'node:test';
import assert from 'node:assert/strict';
import { probePublicDeployments, PUBLIC_PROBES } from '../scripts/public-deployment-probes.mjs';
const release = { version: '0.2.1', commit: 'a'.repeat(40) };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('PDP-01: only three fixed passive GETs, no auth, redirects, root or readiness writes', async () => {
  const urls = [];
  const report = await probePublicDeployments(async (url, init) => {
    urls.push(url);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, { accept: 'application/json' });
    assert.ok(init.signal instanceof AbortSignal);
    return response(url.endsWith('/healthz') ? { ok: true, service: 'celia-phone-google-edge', release } : release);
  });
  assert.deepEqual(urls, PUBLIC_PROBES.map((p) => p.url));
  assert.ok(urls.every((u) => !u.endsWith('/') && !u.includes('/readyz')));
  assert.equal(report.ok, true);
  assert.equal(report.sameAdvertisedCommit, true);
});

test('PDP-02: different deployments are reported without asserting branch equals production', async () => {
  const report = await probePublicDeployments(async (url) => response(url.endsWith('/healthz')
    ? { ok: true, service: 'celia-phone-google-edge', release }
    : { ...release, commit: 'b'.repeat(40) }));
  assert.equal(report.ok, true);
  assert.equal(report.sameAdvertisedCommit, false);
});

test('PDP-03: HTTP, JSON, transport and invalid contract failures fail closed without raw payloads', async () => {
  for (const fetcher of [async () => response({ secret: 'private-marker' }, 403),
    async () => new Response('private-marker'),
    async () => { throw Object.assign(new Error('private-marker'), { cause: { code: 'ENOTFOUND' } }); },
    async () => response({ version: 'private-marker', commit: '::error::private-marker' }),
    async () => response(null)]) {
    const report = await probePublicDeployments(fetcher);
    assert.equal(report.ok, false);
    assert.ok(report.checks.every((c) => c.status === 'failed'));
    assert.doesNotMatch(JSON.stringify(report), /private-marker/);
  }
});
