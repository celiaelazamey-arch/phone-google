// The `--self-test` path is what CI and the operator run before trusting the MCP server. It is exercised
// in-process here, offline: memory storage, no cloud provider, no Ollama.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runSelfTest } from '../src/celia-mcp.js';

test('mcp self-test: runs the real server end-to-end offline and reports what it actually verified', async () => {
  const lines = [];
  await runSelfTest({
    env: {
      CELIA_MCP_DISABLE_MYSQL: 'true',
      CELIA_DISABLE_OLLAMA: 'true',
      CELIA_VERIFY_SKIP_CLOUD: 'true',
      GEMINI_API_KEY: '',
      ELEVENLABS_API_KEY: ''
    },
    log: (line) => lines.push(String(line))
  });
  const report = JSON.parse(lines.join('\n'));
  assert.equal(report.selfTest, 'passed');
  assert.equal(report.toolsCount, 12);
  assert.equal(report.storage, 'memory');
  assert.ok(report.totalSecretsTracked >= 9);
  // Only the generated owner token counts as configured here; no provider credential exists.
  assert.equal(report.secretsConfiguredCount, 1);
  assert.equal(report.aiVerification.tested, false);
  assert.doesNotMatch(lines.join('\n'), /[a-f0-9]{64}/, 'the generated fallback token is never printed');
});

test('mcp self-test: a provider key present in the environment is reported as configured, never printed', async () => {
  const lines = [];
  await runSelfTest({
    env: {
      CELIA_MCP_DISABLE_MYSQL: 'true',
      CELIA_DISABLE_OLLAMA: 'true',
      CELIA_VERIFY_SKIP_CLOUD: 'true',
      GEMINI_API_KEY: 'a-gemini-key-that-must-not-appear'
    },
    log: (line) => lines.push(String(line))
  });
  assert.doesNotMatch(lines.join('\n'), /a-gemini-key-that-must-not-appear/);
  const report = JSON.parse(lines.join('\n'));
  assert.equal(report.geminiConfigured, true);
  assert.ok(report.secretsConfiguredCount >= 1);
});
