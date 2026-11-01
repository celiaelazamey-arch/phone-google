import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diagnoseProviders, responseDiagnosis, readBounded } from '../scripts/provider-diagnostics.mjs';
const config = { aiGateway: { apiKey: 'private-key-marker', model: 'model-x', baseUrl: 'https://ai-gateway.vercel.sh/v1' },
  agentrouter: { apiKey: 'private-key-marker', model: 'model-x', baseUrl: 'https://agentrouter.org/v1' } };

test('PD-01: four bounded requests only; no redirects, retries, production or DeepSeek', async () => {
  const calls = [];
  const report = await diagnoseProviders({ config, fetchImpl: async (url, init) => {
    calls.push(url);
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    if (init.method === 'POST') assert.equal(JSON.parse(init.body).max_tokens, 180);
    return Response.json(url.endsWith('/models') ? { data: [{ id: 'model-x' }] }
      : { choices: [{ message: { content: 'private-response-marker' } }] });
  } });
  assert.equal(calls.length, 4);
  assert.equal(report.ok, true);
  assert.doesNotMatch(JSON.stringify(report), /private-key-marker|private-response-marker/);
});

test('PD-02: classify response shape, empty choices, reasoning and token exhaustion', () => {
  assert.equal(responseDiagnosis(200, '<html>private</html>', 'chat').reason, 'unexpected_html_response');
  assert.equal(responseDiagnosis(200, 'private', 'chat').reason, 'unexpected_non_json_response');
  for (const [body, reason] of [[{}, 'missing_choices'], [{ choices: [{ message: {} }] }, 'empty_reply'],
    [{ choices: [{ message: { reasoning_content: 'private' } }] }, 'reasoning_only_response'],
    [{ choices: [{ message: {}, finish_reason: 'length' }] }, 'empty_reply_token_limit']]) {
    assert.equal(responseDiagnosis(200, JSON.stringify(body), 'chat').reason, reason);
  }
  assert.equal(responseDiagnosis(200, '{"data":[]}', 'models', 'x').configuredModelListed, false);
  assert.equal(responseDiagnosis(200, '{}', 'models').status, 'failed');
});

test('PD-03: provider hints never print raw messages and are not treated as success', () => {
  const report = responseDiagnosis(403, JSON.stringify({ error: { message: 'private-key-marker: insufficient balance; verify identity; access denied; region restriction' } }), 'chat');
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.providerHints, ['balance_hint', 'permission_hint', 'region_hint', 'verification_hint']);
  assert.doesNotMatch(JSON.stringify(report), /private-key-marker|insufficient balance/);
  assert.equal(responseDiagnosis(200, '{"error":{"message":"invalid key"}}', 'chat').status, 'failed');
});

test('PD-04: no secret forwarded on redirect or unapproved endpoint; failures continue', async () => {
  let calls = 0;
  const report = await diagnoseProviders({ config, fetchImpl: async () => {
    calls++; return new Response('', { status: 302, headers: { location: 'https://untrusted.example' } });
  } });
  assert.equal(calls, 4);
  assert.ok(report.checks.every((c) => c.reason === 'redirect_refused'));
  const refused = await diagnoseProviders({ config: { aiGateway: { ...config.aiGateway, baseUrl: 'https://untrusted.example' } },
    fetchImpl: async () => assert.fail('must not call') });
  assert.equal(refused.checks[0].reason, 'unapproved_endpoint');
  const disabled = await diagnoseProviders({ config: { ...config, features: { ai_gateway: false, agentrouter: false } },
    fetchImpl: async () => assert.fail('must not call') });
  assert.equal(disabled.ok, false);
});

test('PD-05: bounded body and transport failures reveal only static categories', async () => {
  await assert.rejects(readBounded(new Response('x'.repeat(65537))), /response_too_large/);
  assert.equal(await readBounded(new Response(null)), '');
  for (const fetchImpl of [async () => new Response('x'.repeat(65537)),
    async () => { throw Object.assign(new Error('private-marker'), { cause: { code: 'ENOTFOUND' } }); }]) {
    const report = await diagnoseProviders({ config, fetchImpl });
    assert.equal(report.ok, false);
    assert.equal(report.checks.length, 4);
    assert.doesNotMatch(JSON.stringify(report), /private-marker/);
  }
});

test('PD-06: workflow does not inject unrelated credentials or trigger production', () => {
  const workflow = readFileSync(new URL('../.github/workflows/provider-diagnostics.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /secrets\.(DEEPSEEK|GEMINI|GOOGLE|RENDER|CLOUDFLARE)|workflow_run:|contents: write/);
  assert.match(workflow, /branches: \[arena\/987903b1-phone-google\]/);
});
