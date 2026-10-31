// VER-02 — the browser gate must never turn "not found" into a silent pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chooseBrowser, mergeLibraryPath, resolveBrowserRuntime } from '../scripts/browser-runtime.mjs';

test('VER-02 browser resolution prefers an explicit binary, then Playwright, then system, then packed', () => {
  assert.equal(chooseBrowser({ explicit: { path: '/x' }, playwright: '/p', system: '/s', packed: { path: '/k', libs: '/l' } }).source, 'explicit');
  assert.equal(chooseBrowser({ playwright: '/p', system: '/s', packed: { path: '/k', libs: '/l' } }).source, 'playwright');
  assert.equal(chooseBrowser({ system: '/s', packed: { path: '/k', libs: '/l' } }).source, 'system');
  const packed = chooseBrowser({ packed: { path: '/k', libs: '/l' } });
  assert.equal(packed.source, 'packed');
  assert.equal(packed.libs, '/l', 'packed Chromium needs its bundled glibc libraries');
});

test('VER-02 no browser is an explicit failure with a remedy, never an empty success', () => {
  const result = chooseBrowser({});
  assert.equal(result.ok, false);
  assert.match(result.reason, /playwright install/);
  assert.match(result.reason, /sparticuz/);
  assert.equal(result.path, undefined);
});

test('VER-02 library path merging keeps existing entries and never duplicates the addition', () => {
  assert.equal(mergeLibraryPath('', '/libs'), '/libs');
  assert.equal(mergeLibraryPath(undefined, '/libs'), '/libs');
  assert.equal(mergeLibraryPath('/old', '/libs'), '/libs:/old');
  assert.equal(mergeLibraryPath('/libs:/old', '/libs'), '/libs:/old');
  assert.equal(mergeLibraryPath('/old', null), '/old');
});

test('VER-02 a stale explicit override fails loudly instead of silently falling back', async () => {
  const result = await resolveBrowserRuntime({
    env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/definitely/missing/chromium' },
    playwrightPath: '/present',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing file/);
});

test('VER-02 the resolved runtime exports the executable, sandbox args and merged library path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'celia-browser-test-'));
  try {
    const binary = path.join(dir, 'chromium');
    await writeFile(binary, '#!/bin/sh\n');
    const runtime = await resolveBrowserRuntime({
      env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: binary, CELIA_CHROMIUM_LIB_DIR: '/libs', LD_LIBRARY_PATH: '/old' },
    });
    assert.equal(runtime.ok, true);
    assert.equal(runtime.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, binary);
    assert.equal(runtime.env.LD_LIBRARY_PATH, '/libs:/old');
    assert.deepEqual(JSON.parse(runtime.env.PLAYWRIGHT_CHROMIUM_ARGS), ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('VER-02 the packed loader is only consulted when nothing better exists', async () => {
  let called = 0;
  const loadPacked = async () => { called += 1; return { path: '/packed', libs: '/packed/lib' }; };
  const viaPlaywright = await resolveBrowserRuntime({ env: {}, playwrightPath: '/p', loadPacked });
  assert.equal(viaPlaywright.source, 'playwright');
  assert.equal(called, 0, 'no 70MB extraction when Playwright already has a browser');
  const viaPacked = await resolveBrowserRuntime({ env: { PATH: '' }, playwrightPath: null, loadPacked });
  assert.equal(viaPacked.source, 'packed');
  assert.equal(called, 1);
});

test('VER-02 a packed loader that throws degrades to a clear failure, not a crash', async () => {
  const result = await resolveBrowserRuntime({ env: { PATH: '' }, playwrightPath: null, loadPacked: async () => { throw new Error('not installed'); } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /No Chromium found/);
});

test('VER-02 CI cannot report success while gates are skipped or the browser never launches', async () => {
  const { readFile } = await import('node:fs/promises');
  const workflow = await readFile(new URL('../.github/workflows/celia-mcp.yml', import.meta.url), 'utf8');
  assert.match(workflow, /unshare --user --map-root-user true/, 'real namespace tests run only where the host supports them');
  assert.match(workflow, /CELIA_SANDBOX_INTEGRATION=1/, 'the capability probe enables the real acceptance tests');
  assert.match(workflow, /node scripts\/check-test-skips\.mjs \/tmp\/unit-tap\.log --allow-env-gates/, 'only named environment gates may be un-run');
  assert.match(workflow, /npm run test:coverage:ci/, 'the skip gate reads the same run it gates, through the mandated :ci wrapper');
  assert.match(workflow, /npm run test:browser/, 'the browser suite still runs in CI');

  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['test:browser'], 'node scripts/run-browser-tests.mjs', 'the browser command resolves a real binary or fails');
  const runner = await readFile(new URL('../scripts/run-browser-tests.mjs', import.meta.url), 'utf8');
  assert.match(runner, /process\.exit\(1\)/, 'a missing browser exits non-zero instead of passing quietly');
  assert.ok(!/continue-on-error:\s*true/.test(workflow), 'no gate is allowed to fail open');
});

test('VER-06 the skip gate allows only named environment gaps and fails on anything else', async () => {
  const { parseSkips, evaluateSkips } = await import('../scripts/check-test-skips.mjs');
  const tap = [
    'ok 1 - AGENT-003 creates/destroys a non-root run # SKIP set CELIA_SANDBOX_INTEGRATION=1',
    'ok 2 - SBX-09 (REAL acceptance): full loop # SKIP namespaces',
    'ok 3 - MCP_TOOLS preserves strict N/N-1 backward compatibility with 0.2.0 baseline # SKIP shallow clone',
    'ok 4 - WA-005 onboarding: v5 code exchange # SKIP convenient',
  ].join('\n');
  const skips = parseSkips(tap);
  assert.equal(skips.length, 4);

  const strict = evaluateSkips(skips);
  assert.equal(strict.ok, false, 'with no allowance, every skip fails');

  const gated = evaluateSkips(skips, { allowEnvironmentGates: true });
  assert.equal(gated.ok, false, 'an ordinary test skipped for convenience still fails');
  assert.equal(gated.allowed.length, 3);
  assert.deepEqual(gated.unexpected.map((s) => s.name), ['WA-005 onboarding: v5 code exchange']);
  assert.ok(gated.allowed.every((s) => s.capability), 'every tolerated gap names its missing capability');

  assert.equal(evaluateSkips([], { allowEnvironmentGates: true }).ok, true);
  assert.deepEqual(parseSkips('ok 1 - a passing test'), []);
});
