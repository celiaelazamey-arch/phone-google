#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { classifyProbeError, probeMetadata, publishProbeReport } from './probe-report.mjs';

// Fixed passive endpoints: /readyz and / on Edge write D1 and are deliberately excluded.
export const PUBLIC_PROBES = Object.freeze([
  { id: 'edge_health', url: 'https://celia-phone-google.celiaelazamey.workers.dev/healthz', health: true },
  { id: 'edge_version', url: 'https://celia-phone-google.celiaelazamey.workers.dev/version' },
  { id: 'pages_version', url: 'https://celiaelazamey-arch.github.io/phone-google/version.json' }
]);
const validVersion = (value) => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value);
const validCommit = (value) => typeof value === 'string' && /^[a-f0-9]{7,40}$/.test(value);

export async function probePublicDeployments(fetchImpl = fetch) {
  const checks = [];
  for (const probe of PUBLIC_PROBES) {
    try {
      const response = await fetchImpl(probe.url, { method: 'GET', redirect: 'error',
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      if (response.status !== 200) {
        checks.push({ id: probe.id, status: 'failed', ...classifyProbeError({ status: response.status }) });
        continue;
      }
      let data;
      try { data = await response.json(); } catch {
        checks.push({ id: probe.id, status: 'failed', reason: 'invalid_json', httpStatus: 200 });
        continue;
      }
      const release = probe.health ? data?.release : data;
      const valid = (!probe.health || (data?.ok === true && data?.service === 'celia-phone-google-edge'))
        && validVersion(release?.version) && validCommit(release?.commit);
      checks.push({ id: probe.id, status: valid ? 'verified' : 'failed', httpStatus: 200,
        reason: valid ? 'passive_response_verified' : 'invalid_response_contract',
        // Only narrowly validated public release metadata, never the response body.
        deployedVersion: validVersion(release?.version) ? release.version : null,
        deployedCommit: validCommit(release?.commit) ? release.commit : null });
    } catch (error) {
      checks.push({ id: probe.id, status: 'failed', ...classifyProbeError(error) });
    }
  }
  const commits = checks.map((c) => c.deployedCommit).filter(Boolean);
  return { schema: 1, checks, ok: checks.every((c) => c.status === 'verified'),
    sameAdvertisedCommit: commits.length === checks.length && new Set(commits).size === 1,
    scope: 'Passive public GET only. Advertised versions, not artifact attestation, database durability, AI configuration, or production readiness.' };
}
async function main() {
  const report = await probePublicDeployments();
  await publishProbeReport({ ...report, ...probeMetadata() }, 'public-deployment-probes');
  process.exitCode = report.ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Public probe setup failed; details suppressed.'); process.exitCode = 1; });
}
