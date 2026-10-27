#!/usr/bin/env node
import crypto from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { connectPoolWithFallback, createCeliaMcpApp, loadCeliaMcpConfig } from '../src/celia-mcp.js';
import { buildSecretsReadiness } from '../src/secrets-hub.js';

const SECRET_ENV_NAMES = [
  'AGENETROUTERAPI_KEY',
  'AGENTROUTER_API_KEY',
  'AI_GATEWAY_API_KEY',
  'CELIA_MCP_API_TOKEN',
  'CELIA_VOICE_ID',
  'ELEVENLABS_VOICE_ID',
  'DEEPSEEK_API_KEY',
  'ELEVENLABS_API_KEY',
  'FIGMA_ACCESS_TOKEN',
  'GEMINI_API_KEY',
  'YOUR_CODATA_API_KEY',
  'CODATA_API_KEY'
];

const isPlaceholder = (v) => !v || /^replace-with-/i.test(String(v).trim());

const rawMcpToken = String(process.env.CELIA_MCP_API_TOKEN || '').trim();
const mcpTokenProvidedValid = !isPlaceholder(rawMcpToken) && rawMcpToken.length >= 32;
const mcpTokenProvidedAny = !isPlaceholder(rawMcpToken);
const runtimeToken = mcpTokenProvidedValid ? rawMcpToken : crypto.randomBytes(32).toString('hex');

const config = loadCeliaMcpConfig(
  {
    ...process.env,
    CELIA_MCP_API_TOKEN: runtimeToken,
    CELIA_MCP_DISABLE_MYSQL: 'true',
    CELIA_DISABLE_OLLAMA: 'true'
  },
  { requireToken: true }
);

const pool = await connectPoolWithFallback(config);
const app = createCeliaMcpApp({ pool, config });
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const unauth = await fetch(`${baseUrl}/api/secrets/status`);
  if (unauth.status !== 401) {
    throw new Error(`Expected 401 on unauthenticated /api/secrets/status, received ${unauth.status}`);
  }

  const authHeaders = { authorization: `Bearer ${runtimeToken}` };
  const [healthText, liveText, systemText, deployText, secretsRes] = await Promise.all([
    fetch(`${baseUrl}/health`).then((r) => r.text()),
    fetch(`${baseUrl}/api/live`).then((r) => r.text()),
    fetch(`${baseUrl}/api/system`).then((r) => r.text()),
    fetch(`${baseUrl}/api/deployment`).then((r) => r.text()),
    fetch(`${baseUrl}/api/secrets/status`, { headers: authHeaders })
  ]);

  if (secretsRes.status !== 200) {
    throw new Error(`/api/secrets/status returned HTTP ${secretsRes.status}`);
  }
  const secretsText = await secretsRes.text();
  const report = JSON.parse(secretsText);
  if (report.totalSecretsTracked !== 9) {
    throw new Error(`Expected 9 tracked repository secrets, received ${report.totalSecretsTracked}`);
  }

  // Ensure zero secret values ever leak into public or authenticated status payloads.
  const combinedOutputs = [healthText, liveText, systemText, deployText, secretsText].join('\n');
  const candidateSecretValues = SECRET_ENV_NAMES
    .map((name) => String(process.env[name] || '').trim())
    .filter((val) => val.length >= 4 && !isPlaceholder(val));
  candidateSecretValues.push(runtimeToken);

  for (const secretVal of candidateSecretValues) {
    if (combinedOutputs.includes(secretVal)) {
      throw new Error('Security gate failed: a secret value was detected in an HTTP status response');
    }
  }

  const envReadiness = buildSecretsReadiness({
    ...config,
    celia: { ...config.celia, apiToken: mcpTokenProvidedValid ? rawMcpToken : '' }
  });

  const summary = {
    wiringVerified: true,
    zeroLeakVerified: true,
    totalSecretsTracked: envReadiness.totalSecretsTracked,
    envSecretsConfiguredCount: envReadiness.configuredCount,
    mcpTokenLengthValid: mcpTokenProvidedAny ? mcpTokenProvidedValid : null,
    secrets: envReadiness.secrets.map((s) => ({
      secretName: s.secretName,
      configured: s.configured,
      role: s.role,
      boundary: s.boundary
    }))
  };

  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = summary.secrets
      .map((s) => `| \`${s.secretName}\` | ${s.configured ? 'Configured' : 'Not injected'} | \`${s.role}\` | \`${s.boundary}\` |`)
      .join('\n');
    const md = [
      '### Celia Repository Secrets Wiring (Sanitized)',
      '',
      `Tracked secrets: **${summary.envSecretsConfiguredCount} / ${summary.totalSecretsTracked}** configured in this workflow context · Zero-leak check: **passed**.`,
      '',
      '| Secret Name | State | Role | Isolation Boundary |',
      '|---|---|---|---|',
      rows,
      ''
    ].join('\n');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, md, 'utf8');
  }

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
