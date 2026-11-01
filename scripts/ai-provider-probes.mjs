#!/usr/bin/env node
import { classifyProbeError, probeMetadata, publishProbeReport } from './probe-report.mjs';
import { pathToFileURL } from 'node:url';

const providers = [
  ['gemini', 'gemini'], ['ai_gateway', 'aiGateway'],
  ['deepseek', 'deepseek'], ['agentrouter', 'agentrouter']
];

// Explicit providers only; one attempt, bounded time, no fallback or raw error output.
export async function probeAiProviders({ config, generate }) {
  const checks = [];
  for (const [id, field] of providers) {
    if (config.features?.[id] === false) {
      checks.push({ id, status: 'disabled' });
      continue;
    }
    if (!config[field]?.apiKey?.trim()) {
      checks.push({ id, status: 'not_configured' });
      continue;
    }
    try {
      const result = await generate({ config, provider: id,
        customerMessage: 'Reply with the single word OK.',
        businessContext: 'Synthetic connectivity test only. No customer or project data.',
        services: { run: (_name, operation) => operation(AbortSignal.timeout(30_000)) }
      });
      const verified = result?.provider === id && result.degraded !== true
        && typeof result.reply === 'string' && result.reply.trim().length > 0;
      checks.push({ id, status: verified ? 'verified' : 'failed',
        reason: verified ? 'live_response' : 'empty_or_fallback_response' });
    } catch (error) {
      checks.push({ id, status: 'failed', ...classifyProbeError(error) });
    }
  }
  return { schema: 1, checks, ok: checks.some((c) => c.status === 'verified')
    && !checks.some((c) => c.status === 'failed'), responseContentLogged: false };
}

async function main() {
  const [{ loadCeliaMcpConfig }, { generateCeliaReply }] = await Promise.all([
    import('../src/celia-mcp.js'), import('../src/ollama.js')
  ]);
  const config = loadCeliaMcpConfig({ ...process.env,
    CELIA_MCP_API_TOKEN: 'synthetic-probe-only-not-a-production-token',
    CELIA_MCP_DISABLE_MYSQL: 'true', CELIA_DISABLE_OLLAMA: 'true' });
  const report = await probeAiProviders({ config, generate: generateCeliaReply });
  await publishProbeReport({ ...report, ...probeMetadata(), scope: 'Synthetic AI requests only; not production readiness. No OAuth or deployment.' }, 'ai-provider-probes');
  process.exitCode = report.ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('AI probe setup failed; details suppressed to protect credentials.'); process.exitCode = 1; });
}
