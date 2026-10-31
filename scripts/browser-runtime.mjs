// VER-02 — resolve a usable Chromium for `npm run test:browser` without guessing.
//
// Why this exists: the browser suite is a release gate, but it kept being reported as
// "blocked: no Chromium" whenever the Playwright CDN was unreachable. A gate that is
// silently skipped is not a gate. This module turns "find a browser" into a deterministic,
// testable decision with an explicit reason when it fails, instead of a human improvisation.
//
// It never downloads anything by itself and never returns a path it has not verified.
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Pure decision function: given candidate facts, pick the first usable browser.
 * Kept free of I/O so the ordering itself is unit-tested.
 *
 * @param {object} candidates
 * @param {{path:string, libs?:string}|null} candidates.explicit  already-validated override
 * @param {string|null} candidates.playwright                     Playwright's own cached build
 * @param {string|null} candidates.system                         distro Chromium on PATH
 * @param {{path:string, libs:string}|null} candidates.packed     @sparticuz/chromium + its libs
 * @returns {{ok:true, path:string, libs:string|null, source:string}|{ok:false, reason:string}}
 */
export function chooseBrowser({ explicit = null, playwright = null, system = null, packed = null } = {}) {
  if (explicit?.path) return { ok: true, path: explicit.path, libs: explicit.libs ?? null, source: 'explicit' };
  if (playwright) return { ok: true, path: playwright, libs: null, source: 'playwright' };
  if (system) return { ok: true, path: system, libs: null, source: 'system' };
  if (packed?.path) return { ok: true, path: packed.path, libs: packed.libs ?? null, source: 'packed' };
  return {
    ok: false,
    reason:
      'No Chromium found. Run `npx playwright install --with-deps chromium`, ' +
      'or on a network that blocks the Playwright CDN: `npm install --no-save @sparticuz/chromium` ' +
      'and re-run. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to use a specific binary.',
  };
}

/** Merge a library directory into an existing LD_LIBRARY_PATH without dropping the old one. */
export function mergeLibraryPath(existing, addition) {
  if (!addition) return existing || '';
  const parts = String(existing || '').split(delimiter).filter(Boolean);
  return [addition, ...parts.filter((p) => p !== addition)].join(delimiter);
}

function firstExisting(paths) {
  return paths.find((p) => p && existsSync(p)) || null;
}

function systemChromium(env) {
  const names = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  for (const dir of String(env.PATH || '').split(delimiter).filter(Boolean)) {
    const hit = firstExisting(names.map((n) => join(dir, n)));
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolve a browser and the environment needed to launch it.
 * `loadPacked` is injected so tests can exercise the packed branch without the 70MB package.
 */
export async function resolveBrowserRuntime({ env = process.env, playwrightPath = null, loadPacked } = {}) {
  const explicitPath = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || null;
  if (explicitPath && !existsSync(explicitPath)) {
    return { ok: false, reason: `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH points at a missing file: ${explicitPath}` };
  }
  let packed = null;
  if (!explicitPath && !playwrightPath && !systemChromium(env) && loadPacked) {
    packed = await loadPacked().catch(() => null);
  }
  const choice = chooseBrowser({
    explicit: explicitPath ? { path: explicitPath, libs: env.CELIA_CHROMIUM_LIB_DIR || null } : null,
    playwright: playwrightPath,
    system: systemChromium(env),
    packed,
  });
  if (!choice.ok) return choice;
  const args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
  return {
    ...choice,
    env: {
      ...env,
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: choice.path,
      PLAYWRIGHT_CHROMIUM_ARGS: JSON.stringify(args),
      ...(choice.libs ? { LD_LIBRARY_PATH: mergeLibraryPath(env.LD_LIBRARY_PATH, choice.libs) } : {}),
    },
  };
}

/** Default packed loader: only used when @sparticuz/chromium is actually installed. */
export async function loadPackedChromium() {
  const { default: chromium } = await import('@sparticuz/chromium');
  const { tmpdir } = await import('node:os');
  const path = await chromium.executablePath();
  // The packaged glibc shim is only auto-extracted on Amazon Linux; elsewhere the binary
  // fails with "libnspr4.so: cannot open shared object file" unless we extract it ourselves.
  const libs = join(tmpdir(), 'al2023', 'lib');
  if (!existsSync(join(libs, 'libnspr4.so'))) {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { readFile, writeFile, mkdir } = await import('node:fs/promises');
    const { brotliDecompressSync } = await import('node:zlib');
    const { execFileSync } = await import('node:child_process');
    const tar = join(tmpdir(), 'celia-chromium-libs.tar');
    await writeFile(tar, brotliDecompressSync(await readFile(require.resolve('@sparticuz/chromium/bin/al2023.tar.br'))));
    await mkdir(join(tmpdir(), 'al2023'), { recursive: true });
    execFileSync('tar', ['-xf', tar, '-C', join(tmpdir(), 'al2023')]);
  }
  return { path, libs };
}
