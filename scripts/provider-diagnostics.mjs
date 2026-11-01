#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { classifyProbeError, probeMetadata, publishProbeReport } from './probe-report.mjs';

const TARGETS = [
  ['ai_gateway', 'aiGateway', 'https://ai-gateway.vercel.sh/v1'],
  ['agentrouter', 'agentrouter', 'https://agentrouter.org/v1']
];
const LIMIT = 65536;
export async function readBounded(response, limit = LIMIT) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('response_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

// Hints reflect provider wording, not a proven root cause. Never return that wording.
export function responseDiagnosis(status, text, kind, model) {
  let json;
  try { json = JSON.parse(text); } catch { /* report shape only */ }
  const html = /^\s*(?:<!doctype html|<html)/i.test(text);
  const shape = html ? 'html' : json !== undefined ? 'json' : 'non_json';
  const message = JSON.stringify([json?.error, json?.message, json?.msg, json?.detail, json?.reason]).toLowerCase();
  const hints = [
    ['credential_hint', /invalid.{0,25}(key|token)|incorrect.{0,25}(key|token)|unauthorized/],
    ['balance_hint', /insufficient.{0,25}(balance|credit|fund)|payment|billing|余额|额度不足/],
    ['permission_hint', /permission|not authorized|access denied|forbidden/],
    ['region_hint', /country|region|location/],
    ['model_hint', /model.{0,40}(not found|not supported|unavailable|not allowed)/],
    ['verification_hint', /verif(y|ication)|identity/],
    ['request_blocked_hint', /blocked|restricted|suspended|disabled|not permitted/],
    ['project_scope_hint', /project|team|organization|oidc/]
  ].filter(([, regex]) => regex.test(message)).map(([id]) => id);
  const base = { httpStatus: status, responseShape: shape, providerHints: hints };
  if (status < 200 || status >= 300) return { ...base, status: 'failed',
    reason: `${classifyProbeError({ status }).reason}_${shape}${hints.length ? `_${hints.join('_')}` : ''}` };
  if (shape !== 'json') return { ...base, status: 'failed', reason: `unexpected_${shape}_response` };
  if (kind === 'models') {
    const models = Array.isArray(json?.data) ? json.data : null;
    return { ...base, status: models ? 'verified' : 'failed',
      reason: models ? (models.some((m) => m?.id === model) ? 'models_list_available_configured_model_listed' : 'models_list_available_configured_model_absent') : 'invalid_models_contract',
      configuredModelListed: models ? models.some((m) => m?.id === model) : null };
  }
  const choice = json?.choices?.[0];
  const content = choice?.message?.content;
  const reply = typeof content === 'string' ? content : Array.isArray(content)
    ? content.map((p) => typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '').join('') : '';
  // An error envelope is not success even if it contains a reply.
  if (json?.error) return { ...base, status: 'failed', reason: `provider_error_envelope${hints.length ? `_${hints.join('_')}` : ''}` };
  if (reply.trim()) return { ...base, status: 'verified', reason: 'synthetic_completion_received' };
  const reason = !choice ? 'missing_choices' : choice.message?.reasoning_content || choice.message?.reasoning
    ? 'reasoning_only_response' : choice.finish_reason === 'length' ? 'empty_reply_token_limit' : 'empty_reply';
  return { ...base, status: 'failed', reason };
}

export async function diagnoseProviders({ config, fetchImpl = fetch }) {
  const checks = [];
  for (const [id, field, allowedBase] of TARGETS) {
    const cfg = config[field];
    if (config.features?.[id] === false || !cfg?.apiKey?.trim()) {
      checks.push({ id, status: config.features?.[id] === false ? 'disabled' : 'not_configured' });
      continue;
    }
    // No configurable secret-bearing destination or cross-origin redirect.
    if (cfg.baseUrl !== allowedBase) {
      checks.push({ id, status: 'failed', reason: 'unapproved_endpoint' });
      continue;
    }
    for (const kind of ['models', 'chat']) {
      try {
        const response = await fetchImpl(`${allowedBase}/${kind === 'models' ? 'models' : 'chat/completions'}`, {
          method: kind === 'models' ? 'GET' : 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000),
          headers: { authorization: `Bearer ${cfg.apiKey}`, accept: 'application/json', 'content-type': 'application/json' },
          ...(kind === 'chat' ? { body: JSON.stringify({ model: cfg.model, max_tokens: 180, temperature: 0.2, stream: false,
            messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }) } : {})
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          checks.push({ id: `${id}_${kind}`, status: 'failed', reason: 'redirect_refused', httpStatus: response.status });
          continue;
        }
        const text = await readBounded(response, kind === 'models' ? 1048576 : LIMIT);
        checks.push({ id: `${id}_${kind}`, ...responseDiagnosis(response.status, text, kind, cfg.model) });
      } catch (error) {
        checks.push({ id: `${id}_${kind}`, status: 'failed', ...(error?.message === 'response_too_large'
          ? { reason: 'response_too_large', httpStatus: null } : classifyProbeError(error)) });
      }
    }
  }
  return { schema: 1, checks, ok: checks.length === 4 && checks.every((c) => c.status === 'verified'),
    scope: 'AI Gateway and AgentRouter diagnostics only. Models listing is not proof of authenticated completion. Provider hints are not confirmed root causes. DeepSeek unchanged: last observed HTTP 402; not re-probed. No OAuth or deployment.' };
}
async function main() {
  const { loadCeliaMcpConfig } = await import('../src/celia-mcp.js');
  const config = loadCeliaMcpConfig({ ...process.env, CELIA_MCP_API_TOKEN: 'synthetic-diagnostics-not-a-production-token', CELIA_MCP_DISABLE_MYSQL: 'true' });
  const report = await diagnoseProviders({ config });
  await publishProbeReport({ ...report, ...probeMetadata() }, 'provider-diagnostics');
  process.exitCode = report.ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Diagnostics setup failed; raw details suppressed.'); process.exitCode = 1; });
}
