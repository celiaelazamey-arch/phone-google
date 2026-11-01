import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyProbeError, probeAnnotations, probeMetadata } from '../scripts/probe-report.mjs';

test('PRP-01: categories are bounded, HTTP takes precedence, raw secrets never exported', () => {
  for (const [code, reason] of [[401, 'authentication_rejected'], [402, 'payment_required'],
    [403, 'forbidden'], [404, 'endpoint_or_model_not_found'], [429, 'rate_limit_or_quota'],
    [503, 'upstream_server_error'], [400, 'http_error']]) {
    assert.deepEqual(classifyProbeError({ upstreamStatus: code, message: 'secret' }), { httpStatus: code, reason });
  }
  for (const [code, reason] of [['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'], ['ECONNREFUSED', 'connection'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout'], ['TimeoutError', 'timeout'], ['AbortError', 'timeout'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls'], ['SELF_SIGNED_CERT_IN_CHAIN', 'tls']]) {
    assert.equal(classifyProbeError({ cause: { code }, message: 'secret' }).reason, reason);
    assert.equal(classifyProbeError({ name: code }).reason, reason);
  }
  const unknown = classifyProbeError({ status: '403', message: 'secret\n::error::injection', code: 'private-code' });
  assert.deepEqual(unknown, { httpStatus: null, reason: 'request_failed_unknown' });
});

test('PRP-02: annotation severity is truthful and newlines cannot inject runner commands', () => {
  const lines = probeAnnotations({ checks: [
    { id: 'gemini', status: 'verified' }, { id: 'deepseek', status: 'failed', httpStatus: 402 },
    { id: 'gateway', status: 'disabled' }, { id: 'missing', status: 'not_configured' },
    { id: 'x', status: 'failed', reason: 'bad%\r\n::notice::injected' }
  ] });
  assert.match(lines[0], /^::notice /);
  assert.match(lines[1], /^::error /);
  assert.match(lines[2], /^::warning /);
  assert.match(lines[3], /^::warning /);
  assert.match(lines[4], /bad%25%0D%0A/);
  assert.ok(lines.every((line) => !line.includes('\n')));
  assert.equal(probeMetadata({ GITHUB_SHA: 'secret', GITHUB_RUN_ID: 'secret' }).testedCommit, null);
  assert.equal(probeMetadata({ GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123' }).runId, '123');
});

test('PRP-03: report, summary and outputs persist only sanitized result fields supplied by probes', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'probe-report-'));
  try {
    const script = `import {publishProbeReport} from ${JSON.stringify(new URL('../scripts/probe-report.mjs', import.meta.url).href)};
      await publishProbeReport({ok:false, scope:'synthetic', checks:[{id:'gemini',status:'verified'},{id:'deepseek',status:'failed',httpStatus:402}]}, 'test', process.env);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_ACTIONS: 'true',
        GITHUB_OUTPUT: path.join(dir, 'outputs'), GITHUB_STEP_SUMMARY: path.join(dir, 'summary') }
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(readFileSync(path.join(dir, 'outputs'), 'utf8'), 'ok=false\nverified=1\nfailed=1\n');
    assert.match(readFileSync(path.join(dir, 'summary'), 'utf8'), /deepseek \| failed/);
    assert.match(child.stdout, /::error title=Probe result::deepseek/);
    assert.equal(JSON.parse(readFileSync(path.join(dir, '.validation-artifacts/test.json'))).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PRP-04: 200 malformed adapter responses retain diagnostics without losing real HTTP rejection', () => {
  assert.deepEqual(classifyProbeError({ upstreamStatus: 200, diagnosticCode: 'NON_JSON_RESPONSE' }),
    { httpStatus: 200, reason: 'unexpected_non_json_response' });
  assert.deepEqual(classifyProbeError({ upstreamStatus: 403, diagnosticCode: 'NON_JSON_RESPONSE' }),
    { httpStatus: 403, reason: 'forbidden' });
  for (const code of ['PROVIDER_ERROR_ENVELOPE', 'MISSING_CHOICES', 'REASONING_ONLY', 'OUTPUT_TOKEN_LIMIT', 'EMPTY_REPLY']) {
    assert.notEqual(classifyProbeError({ upstreamStatus: 200, diagnosticCode: code }).reason, 'http_error');
  }
});
