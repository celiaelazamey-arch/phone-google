#!/usr/bin/env node
// VER-02 — one command that either runs the real browser suite or fails loudly.
// It never exits 0 when the browser could not be found: a skipped gate is not a passing gate.
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { loadPackedChromium, resolveBrowserRuntime } from './browser-runtime.mjs';

const cached = chromium.executablePath();
const runtime = await resolveBrowserRuntime({
  playwrightPath: cached && existsSync(cached) ? cached : null,
  loadPacked: loadPackedChromium,
});

if (!runtime.ok) {
  console.error(`\nBrowser gate NOT run: ${runtime.reason}\n`);
  process.exit(1);
}

console.log(`Chromium: ${runtime.path} (source: ${runtime.source})`);
const child = spawn('npx', ['playwright', 'test', ...process.argv.slice(2)], { stdio: 'inherit', env: runtime.env });
child.on('exit', (code) => process.exit(code ?? 1));
