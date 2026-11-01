import { appendFile, mkdir, writeFile } from 'node:fs/promises';

// Only fixed categories and validated numeric HTTP status leave the process.
export function classifyProbeError(error) {
  const raw = error?.upstreamStatus ?? error?.status;
  const httpStatus = Number.isInteger(raw) && raw >= 100 && raw <= 599 ? raw : null;
  const http = { 401: 'authentication_rejected', 402: 'payment_required',
    403: 'forbidden', 404: 'endpoint_or_model_not_found', 429: 'rate_limit_or_quota' };
  if (httpStatus) return { httpStatus, reason: http[httpStatus] ?? (httpStatus >= 500 ? 'upstream_server_error' : 'http_error') };
  const codes = [error?.code, error?.cause?.code, error?.name, error?.cause?.name];
  const categories = {
    timeout: ['AbortError', 'TimeoutError', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'],
    dns: ['ENOTFOUND', 'EAI_AGAIN'],
    tls: ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'],
    connection: ['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET']
  };
  for (const [reason, allowed] of Object.entries(categories)) {
    if (codes.some((code) => allowed.includes(code))) return { httpStatus: null, reason };
  }
  return { httpStatus: null, reason: 'request_failed_unknown' };
}

export function probeMetadata(env = process.env) {
  return { checkedAt: new Date().toISOString(),
    testedCommit: /^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '') ? env.GITHUB_SHA : null,
    runId: /^\d+$/.test(env.GITHUB_RUN_ID || '') ? env.GITHUB_RUN_ID : null };
}
export const escapeCommand = (value) => String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
export function probeAnnotations(report) {
  return report.checks.map((c) => {
    const level = c.status === 'verified' ? 'notice' : c.status === 'failed' ? 'error' : 'warning';
    return `::${level} title=Probe result::${escapeCommand(`${c.id}: ${c.status}; reason=${c.reason ?? c.status}; HTTP ${c.httpStatus ?? 'n/a'}${c.deployedCommit ? `; deployed=${c.deployedVersion}@${c.deployedCommit}` : ''}`)}`;
  });
}
export async function publishProbeReport(report, name, env = process.env) {
  await mkdir('.validation-artifacts', { recursive: true });
  const safe = JSON.stringify(report, null, 2);
  await writeFile(`.validation-artifacts/${name}.json`, `${safe}\n`);
  console.log(safe);
  if (env.GITHUB_ACTIONS === 'true') {
    for (const line of probeAnnotations(report)) console.log(line);
    if (report.sameAdvertisedCommit === false) console.log('::warning title=Deployment versions::A common advertised commit was not established across all public probes.');
  }
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT,
    `ok=${report.ok}\nverified=${report.checks.filter((c) => c.status === 'verified').length}\nfailed=${report.checks.filter((c) => c.status === 'failed').length}\n`);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,
    `## ${name}\n\nProbe commit: ${report.testedCommit ?? 'local'} · run: ${report.runId ?? 'local'}\n\nScope: ${report.scope}\n\n| Check | Status | Reason | HTTP | Deployed version |\n|---|---|---|---|---|\n${report.checks.map((c) => `| ${c.id} | ${c.status} | ${c.reason ?? '—'} | ${c.httpStatus ?? '—'} | ${c.deployedCommit ? `${c.deployedVersion}@${c.deployedCommit}` : '—'} |`).join('\n')}\n`);
}
