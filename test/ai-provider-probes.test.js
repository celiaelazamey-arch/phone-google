import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { probeAiProviders } from '../scripts/ai-provider-probes.mjs';

const configured = () => Object.fromEntries(['gemini', 'aiGateway', 'deepseek', 'agentrouter']
  .map((name) => [name, { apiKey: 'synthetic-private-marker' }]));

test('AIP-01: four explicit providers, synthetic input, bounded single-attempt transport', async () => {
  const calls = [];
  const report = await probeAiProviders({ config: configured(), generate: async (args) => {
    calls.push(args.provider);
    assert.equal(args.customerMessage, 'Reply with the single word OK.');
    assert.match(args.businessContext, /Synthetic/);
    await args.services.run(args.provider, (signal) => assert.ok(signal instanceof AbortSignal));
    return { provider: args.provider, reply: 'private-response-marker' };
  } });
  assert.deepEqual(calls, ['gemini', 'ai_gateway', 'deepseek', 'agentrouter']);
  assert.equal(report.ok, true);
  assert.equal(report.checks.every((c) => c.status === 'verified'), true);
  assert.doesNotMatch(JSON.stringify(report), /private-marker|private-response-marker/);
});

test('AIP-02: missing and retired providers never make requests or yield a green empty run', async () => {
  const report = await probeAiProviders({ config: { gemini: { apiKey: 'test' }, features: { gemini: false } },
    generate: async () => assert.fail('must not call') });
  assert.equal(report.ok, false);
  assert.equal(report.checks[0].status, 'disabled');
  assert.equal(report.checks.filter((c) => c.status === 'not_configured').length, 3);
});

test('AIP-03: failure does not stop remaining probes; raw errors and keys never enter report', async () => {
  let calls = 0;
  const report = await probeAiProviders({ config: configured(), generate: async ({ provider }) => {
    calls++;
    if (provider === 'gemini') throw Object.assign(new Error('secret-error-marker'), { upstreamStatus: 429 });
    return { provider, reply: 'OK' };
  } });
  assert.equal(calls, 4);
  assert.equal(report.ok, false);
  assert.equal(report.checks[0].httpStatus, 429);
  assert.doesNotMatch(JSON.stringify(report), /secret-error-marker|synthetic-private-marker/);
});

test('AIP-04: local fallback, degraded response and empty content cannot count as live success', async () => {
  for (const response of [{ provider: 'local', reply: 'OK' },
    { provider: 'gemini', reply: 'OK', degraded: true }, { provider: 'gemini', reply: ' ' }]) {
    const report = await probeAiProviders({ config: { gemini: { apiKey: 'test' } }, generate: async () => response });
    assert.equal(report.ok, false);
    assert.equal(report.checks[0].status, 'failed');
  }
});

test('AIP-05: workflow is branch-scoped, read-only and contains no OAuth or deployment credentials', () => {
  const yaml = readFileSync(new URL('../.github/workflows/ai-provider-probes.yml', import.meta.url), 'utf8');
  assert.match(yaml, /github.ref == 'refs\/heads\/arena\/987903b1-phone-google'/);
  assert.match(yaml, /workflow_dispatch:/);
  assert.doesNotMatch(yaml, /^  push:/m);
  assert.match(yaml, /contents: read/);
  assert.match(yaml, /persist-credentials: false/);
  assert.match(yaml, /environment: integration-probes/);
  assert.doesNotMatch(yaml, /workflow_run:|pull_request_target:|contents: write|GOOGLE_CLIENT_SECRET|GOOGLE_CLIENT_ID|CLOUDFLARE_API_TOKEN|RENDER_API_KEY/);
});
