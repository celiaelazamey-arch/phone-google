#!/usr/bin/env node
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
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
      const status = error?.upstreamStatus;
      checks.push({ id, status: 'failed', reason: 'request_failed',
        httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null });
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
  const safe = JSON.stringify(report, null, 2);
  await mkdir('.validation-artifacts', { recursive: true });
  await writeFile('.validation-artifacts/ai-provider-probes.json', `${safe}\n`);
  console.log(safe);
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const check of report.checks) {
      console.log(`::notice title=AI provider probe::${check.id}: ${check.status}; HTTP ${check.httpStatus ?? 'n/a'}`);
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## Isolated AI provider probes\n\nNo OAuth, deployment, or response content.\n\n| Provider | Status | HTTP |\n|---|---|---|\n${report.checks.map((c) => `| ${c.id} | ${c.status} | ${c.httpStatus ?? '—'} |`).join('\n')}\n`);
  }
  process.exitCode = report.ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('AI probe setup failed; details suppressed to protect credentials.'); process.exitCode = 1; });
}
