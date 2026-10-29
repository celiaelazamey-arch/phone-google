import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSandboxExecutor } from '../src/agent/sandbox.js';
import { createSandboxPolicy } from '../src/agent/sandbox-policy.js';
import { EVIDENCE_KIND, hashOf } from '../src/agent/evidence.js';
import { createTempStore } from './support/agent-fixtures.js';

const REAL = process.env.CELIA_SANDBOX_INTEGRATION === '1';
const integration = (name, fn) => test(name, { skip: REAL ? false : 'set CELIA_SANDBOX_INTEGRATION=1 on Linux with user namespaces' }, fn);

async function sandboxFor(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'celia-sandbox-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return createSandboxExecutor({ artifactRoot: path.join(directory, 'artifacts'), ...options });
}

async function hostListener(t) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, port: server.address().port, connections: 0 };
}

test('AGENT-003 policy is frozen, closed, and has no unenforced egress allowlist', () => {
  const policy = createSandboxPolicy();
  assert.equal(policy.network.mode, 'deny');
  assert.deepEqual(policy.network.allowlist, []);
  assert.equal(policy.filesystem.rootReadOnly, true);
  assert.equal(policy.artifacts.maxCount, 1);
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.resources));
  assert.throws(() => createSandboxPolicy({ network: { allowlist: ['example.com:443'] } }), /allowlist_backend_unavailable/);
  assert.throws(() => createSandboxPolicy({ resources: { unknown: 1 } }), /unknown_field/);
  assert.throws(() => createSandboxPolicy({ artifacts: { maxCount: 2 } }), /outside_bounds/);
  assert.throws(() => createSandboxPolicy({ network: { mode: 'allow' } }), /default_deny/);
});

test('AGENT-003 never falls back to host execution on an unsupported backend', async (t) => {
  let spawned = false;
  const sandbox = await sandboxFor(t, {
    platform: 'darwin',
    spawnImpl: () => { spawned = true; throw new Error('must_not_spawn'); }
  });
  const result = await sandbox.run({ runId: 'unsupported', code: 'throw new Error("must_not_run")' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'sandbox_linux_namespaces_required');
  assert.equal(spawned, false);
});

integration('AGENT-003 creates/destroys a non-root run and exports one hashed artifact', async (t) => {
  const sandbox = await sandboxFor(t);
  const code = `
    const fs = require('node:fs');
    const read = (file) => { try { fs.readFileSync(file); return 'READ'; } catch (e) { return e.code; } };
    const write = (file) => { try { fs.writeFileSync(file, 'x'); return 'WRITE'; } catch (e) { return e.code; } };
    const result = {
      uid: process.getuid(), gid: process.getgid(), home: process.env.HOME,
      capabilities: fs.readFileSync('/proc/self/status', 'utf8').split('\\n').filter((line) => /^Cap(?:Prm|Eff|Bnd|Amb):/.test(line)),
      secret: read('/home/user/phone-google/.env'), etc: read('/etc/passwd'),
      shell: read('/bin/sh'), ls: read('/usr/bin/ls'), git: read('/usr/bin/git'),
      procEscape: read('/proc/1/root/etc/passwd'), rootWrite: write('/root-write-probe'),
      ssh: read('/root/.ssh/id_rsa'), cloud: read('/root/.config/gcloud/credentials.json')
    };
    fs.writeFileSync('/workspace/artifacts/result.json', JSON.stringify(result));
  `;
  const result = await sandbox.run({ runId: 'success_escape', code });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal(result.artifacts.length, 1);
  assert.match(result.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.cleanup.destroyed, true);
  assert.equal(result.cleanup.rootRemoved, true);
  const artifact = await sandbox.readArtifact(result.artifacts[0]);
  const value = JSON.parse(artifact.content.toString('utf8'));
  assert.equal(value.uid, 1001);
  assert.equal(value.gid, 1001);
  assert.equal(value.home, '/workspace');
  assert.equal(value.capabilities.length, 4);
  assert.ok(value.capabilities.every((line) => /:\s*0{16}$/.test(line)), value.capabilities.join('\n'));
  for (const key of ['secret', 'etc', 'shell', 'ls', 'git', 'procEscape', 'ssh', 'cloud']) {
    assert.ok(['ENOENT', 'EACCES', 'EPERM'].includes(value[key]), `${key}: ${value[key]}`);
  }
  assert.ok(['EROFS', 'ENOENT', 'EACCES'].includes(value.rootWrite));
});

integration('AGENT-003 denies and records an external network probe', async (t) => {
  const sandbox = await sandboxFor(t);
  const result = await sandbox.run({
    runId: 'network_deny',
    code: "require('node:fs').writeFileSync('/workspace/artifacts/network.json', 'ok')",
    networkProbe: { host: '192.0.2.1', port: 80 }
  });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal(result.network.probe.connected, false);
  assert.equal(result.network.probe.code, 'ENETUNREACH');
  const event = result.evidence.find((item) => item.kind === EVIDENCE_KIND.sandboxNetworkAttempt);
  assert.ok(event);
  assert.equal(event.output.observed, true);
  assert.equal(event.output.denied, true);
  assert.equal(event.verdict, 'PASS');
});

integration('AGENT-003 cannot reach a real host TCP service from the run network namespace', async (t) => {
  const listener = await hostListener(t);
  listener.server.on('connection', () => { listener.connections += 1; });
  const sandbox = await sandboxFor(t);
  const actual = await sandbox.run({
    runId: 'internal_service',
    code: 'module.exports = true;',
    networkProbe: { host: '127.0.0.1', port: listener.port }
  });
  assert.equal(actual.status, 'succeeded', JSON.stringify(actual));
  assert.equal(actual.network.probe.connected, false);
  assert.equal(listener.connections, 0);
});

integration('AGENT-003 wall timeout kills the process group and destroys the root', async (t) => {
  const sandbox = await sandboxFor(t);
  const result = await sandbox.run({ runId: 'wall_timeout', code: 'while (true) {}' });
  assert.equal(result.status, 'timeout');
  assert.equal(result.verdict, 'TIMEOUT');
  assert.equal(result.reason, 'sandbox_wall_timeout');
  assert.equal(result.cleanup.destroyed, true);
});

integration('AGENT-003 kills leftover descendants before exporting artifacts', async (t) => {
  const sandbox = await sandboxFor(t);
  const result = await sandbox.run({
    runId: 'descendant_cleanup',
    code: `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      const child = spawn('/runtime/node', ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'inherit' });
      child.unref();
      fs.writeFileSync('/workspace/artifacts/descendant.txt', 'parent-only');
    `
  });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal(result.artifacts.length, 1);
  const artifact = await sandbox.readArtifact(result.artifacts[0]);
  assert.equal(artifact.content.toString(), 'parent-only');
  assert.equal(result.cleanup.destroyed, true);
});

integration('AGENT-003 CPU limit is BLOCK, not a normal task failure', async (t) => {
  const sandbox = await sandboxFor(t, { policy: { resources: { cpuSeconds: 1, wallTimeoutMs: 5_000 } } });
  const result = await sandbox.run({ runId: 'cpu_limit', code: 'while (true) {}' });
  assert.equal(result.status, 'resource_limit', JSON.stringify(result));
  assert.equal(result.verdict, 'BLOCK');
  assert.equal(result.reason, 'sandbox_resource_limit');
  assert.equal(result.cleanup.destroyed, true);
});

integration('AGENT-003 memory limit is BLOCK and no artifact escapes', async (t) => {
  const sandbox = await sandboxFor(t);
  const result = await sandbox.run({
    runId: 'memory_limit',
    code: "const values = []; while (true) values.push(new Array(100000).fill('x'));"
  });
  assert.equal(result.status, 'resource_limit', JSON.stringify(result));
  assert.equal(result.verdict, 'BLOCK');
  assert.equal(result.artifacts.length, 0);
  assert.equal(result.cleanup.destroyed, true);
});

integration('AGENT-003 total workspace tmpfs quota is enforced, not only per-file size', async (t) => {
  const sandbox = await sandboxFor(t);
  const result = await sandbox.run({
    runId: 'storage_limit',
    code: "const fs=require('node:fs'); for (let i=0; i<20; i++) fs.writeFileSync('/workspace/f'+i, Buffer.alloc(800000));"
  });
  assert.equal(result.status, 'resource_limit', JSON.stringify(result));
  assert.equal(result.verdict, 'BLOCK');
  assert.equal(result.reason, 'sandbox_resource_limit');
  assert.equal(result.artifacts.length, 0);
  assert.equal(result.cleanup.destroyed, true);
});

integration('AGENT-003 concurrency circuit breaker refuses work before creating another run', async (t) => {
  const sandbox = await sandboxFor(t, { policy: { resources: { maxConcurrent: 1, wallTimeoutMs: 300 } } });
  const first = sandbox.run({ runId: 'concurrency_first', code: 'while (true) {}' });
  const second = await sandbox.run({ runId: 'concurrency_second', code: 'module.exports = true;' });
  assert.equal(second.status, 'blocked');
  assert.equal(second.reason, 'sandbox_concurrency_limit');
  assert.equal(second.sandboxId, null);
  const firstResult = await first;
  assert.equal(firstResult.status, 'timeout');
  assert.equal(sandbox.activeCount, 0);
});

integration('AGENT-003 refuses multiple or non-regular artifacts', async (t) => {
  const sandbox = await sandboxFor(t);
  const multiple = await sandbox.run({
    runId: 'too_many_artifacts',
    code: "const fs=require('node:fs'); fs.writeFileSync('/workspace/artifacts/a', 'a'); fs.writeFileSync('/workspace/artifacts/b', 'b');"
  });
  assert.equal(multiple.status, 'blocked');
  assert.equal(multiple.reason, 'sandbox_artifact_count_exceeded');
  assert.equal(multiple.artifacts.length, 0);
  const symlink = await sandbox.run({
    runId: 'symlink_artifact',
    code: "require('node:fs').symlinkSync('/task.cjs', '/workspace/artifacts/link')"
  });
  assert.equal(symlink.status, 'blocked');
  assert.equal(symlink.reason, 'sandbox_artifact_type_or_name_refused');
  assert.equal(symlink.artifacts.length, 0);
});

integration('AGENT-003 task cannot change policy, regain root, or read inherited secrets', async (t) => {
  const sandbox = await sandboxFor(t);
  const result = await sandbox.run({
    runId: 'policy_immutable',
    code: `
      const fs = require('node:fs');
      const attempt = (fn) => { try { fn(); return 'ALLOWED'; } catch (e) { return e.code || 'BLOCKED'; } };
      const result = {
        envSecret: process.env.SECRET || null,
        envToken: process.env.GITHUB_TOKEN || null,
        setuid: attempt(() => process.setuid(0)),
        runWrite: attempt(() => fs.writeFileSync('/run/network.json', '{}')),
        runtimeWrite: attempt(() => fs.writeFileSync('/runtime/node', 'x')),
        policyWrite: attempt(() => fs.writeFileSync('/usr/bin/node-policy', 'x'))
      };
      fs.writeFileSync('/workspace/artifacts/policy.json', JSON.stringify(result));
    `
  });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  const artifact = await sandbox.readArtifact(result.artifacts[0]);
  const value = JSON.parse(artifact.content.toString('utf8'));
  assert.equal(value.envSecret, null);
  assert.equal(value.envToken, null);
  assert.notEqual(value.setuid, 'ALLOWED');
  assert.notEqual(value.runWrite, 'ALLOWED');
  assert.notEqual(value.runtimeWrite, 'ALLOWED');
  assert.notEqual(value.policyWrite, 'ALLOWED');
});

integration('AGENT-003 sandbox and artifact events join the verified Evidence chain', async (t) => {
  const fixture = await createTempStore();
  t.after(async () => { await fixture.driver.close(); fixture.cleanup(); });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'sandbox' });
  const created = await fixture.store.createRun({
    threadId: thread.id, ownerId: 'owner', planner: 'sandbox-test', maxSteps: 2, maxCostMicros: 100
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'celia-sandbox-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sandbox = createSandboxExecutor({ artifactRoot: directory, evidenceStore: fixture.store });
  const result = await sandbox.run({
    runId: created.run.id,
    stepId: 'step-sandbox-1',
    code: "require('node:fs').writeFileSync('/workspace/artifacts/evidence.txt', 'verified')",
    networkProbe: { host: '192.0.2.1', port: 80 }
  });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  const evidence = await fixture.store.listEvidence(created.run.id);
  assert.deepEqual(evidence.map((item) => item.kind), [
    EVIDENCE_KIND.sandboxCreated,
    EVIDENCE_KIND.sandboxNetworkAttempt,
    EVIDENCE_KIND.sandboxArtifact,
    EVIDENCE_KIND.sandboxFinished
  ]);
  assert.ok(evidence.every((item) => item.stepId === 'step-sandbox-1'));
  const storedArtifactEvent = evidence.find((item) => item.kind === EVIDENCE_KIND.sandboxArtifact);
  assert.equal(storedArtifactEvent.outputHash, hashOf({
    uri: result.artifacts[0].uri,
    bytes: result.artifacts[0].bytes,
    sha256: result.artifacts[0].sha256,
    expiresAt: result.artifacts[0].expiresAt
  }));
  assert.equal((await fixture.store.verifyEvidenceChain(created.run.id)).ok, true);
  const artifact = await sandbox.readArtifact(result.artifacts[0]);
  assert.equal(artifact.content.toString(), 'verified');
});

test('AGENT-003 artifact references cannot be path traversal primitives', async (t) => {
  // This is a pure reference check; no sandbox process is needed.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'celia-artifact-ref-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sandbox = createSandboxExecutor({ artifactRoot: directory, clock: () => 2_000 });
  await assert.rejects(() => sandbox.readArtifact({ runId: '../escape', id: 'x' }), /run_id_invalid/);
  await assert.rejects(() => sandbox.readArtifact({ runId: 'run', id: '../../secret' }), /identity_invalid/);
});

integration('AGENT-003 durable run claims refuse replay across executor instances', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'celia-sandbox-claims-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = createSandboxExecutor({ artifactRoot: directory });
  const second = createSandboxExecutor({ artifactRoot: directory });
  const code = "require('node:fs').writeFileSync('/workspace/artifacts/once.txt', 'once')";
  const result = await first.run({ runId: 'duplicate_claim', code });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  const acrossRestart = await second.run({ runId: 'duplicate_claim', code });
  assert.equal(acrossRestart.status, 'blocked');
  assert.equal(acrossRestart.reason, 'sandbox_duplicate_run');
  const sameExecutor = await first.run({ runId: 'duplicate_claim', code });
  assert.equal(sameExecutor.status, 'blocked');
  assert.equal(sameExecutor.reason, 'sandbox_duplicate_run');
  const artifact = await second.readArtifact(result.artifacts[0]);
  assert.equal(artifact.content.toString(), 'once');
});

integration('AGENT-003 expired artifact references are denied', async (t) => {
  let now = 1_700_000_000_000;
  const sandbox = await sandboxFor(t, { clock: () => now });
  const result = await sandbox.run({
    runId: 'artifact_ttl',
    code: "require('node:fs').writeFileSync('/workspace/artifacts/ttl.txt', 'short-lived')"
  });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  now += 3_600_001;
  await assert.rejects(() => sandbox.readArtifact(result.artifacts[0]), /sandbox_artifact_expired/);
});
