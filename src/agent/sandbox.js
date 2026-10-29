import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as FS_CONSTANTS } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { EVIDENCE_KIND, hashOf } from './evidence.js';
import {
  assertSandboxCode,
  assertSandboxRunId,
  createSandboxPolicy,
  SANDBOX_POLICY_VERSION
} from './sandbox-policy.js';

const ENTRYPOINT = fileURLToPath(new URL('./sandbox-entry.sh', import.meta.url));
const CAPTURE_LIMIT = 8_192;
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ARTIFACT_ID = /^[a-f0-9-]{36}$/;
const BOOTSTRAP_BINARIES = Object.freeze(['/usr/bin/prlimit', '/usr/bin/setpriv', '/usr/bin/env']);
const RUNTIME_LIBRARY_ROOT = new RegExp('^/(?:lib|lib64|usr/lib|usr/lib64|usr/local/lib)/');

function assertRuntimeMountPath(file) {
  if (typeof file !== 'string' || !file.startsWith('/') || file.includes('\0') || /[|\n\r]/.test(file)) {
    throw coded('sandbox_runtime_mount_path_invalid');
  }
  if (path.posix.normalize(file) !== file || !RUNTIME_LIBRARY_ROOT.test(file)) {
    throw coded('sandbox_runtime_mount_outside_system_roots');
  }
  return file;
}

function parseLddPaths(output) {
  if (/not found/.test(output)) throw coded('sandbox_runtime_dependency_missing');
  const paths = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(?:\S+\s+=>\s+)?(\/[^\s()]+)/);
    if (match) paths.push(match[1]);
  }
  return paths;
}

function ldd(binary) {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    let child;
    let timer;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output);
    };
    timer = setTimeout(() => {
      child?.kill('SIGKILL');
      finish(coded('sandbox_runtime_dependency_probe_timeout'));
    }, 2_000);
    try {
      child = spawn('/usr/bin/ldd', [binary], {
        env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'C' },
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      finish(error);
      return;
    }
    const capture = (chunk) => {
      if (output.length < 65_536) output += chunk.toString('utf8').slice(0, 65_536 - output.length);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', finish);
    child.once('close', (code, signal) => {
      if (code === 0 || /statically linked|not a dynamic executable/.test(output)) finish();
      else finish(coded('sandbox_runtime_dependency_probe_failed', new Error(`ldd:${code || signal}`)));
    });
  });
}

async function discoverRuntimeMounts(nodePath) {
  const report = process.report?.getReport?.();
  if (!report?.sharedObjects || !Array.isArray(report.sharedObjects)) throw coded('sandbox_runtime_dependencies_unavailable');
  const mounts = new Map();
  const add = async (source, { bootstrap = false } = {}) => {
    if (source === nodePath || source === 'linux-vdso.so.1') return;
    if (bootstrap) {
      if (!BOOTSTRAP_BINARIES.includes(source) || path.posix.normalize(source) !== source) {
        throw coded('sandbox_bootstrap_path_invalid');
      }
    } else {
      assertRuntimeMountPath(source);
    }
    const resolved = await realpath(source);
    if (bootstrap) {
      if (resolved !== source) throw coded('sandbox_bootstrap_symlink_refused');
    } else {
      assertRuntimeMountPath(resolved);
    }
    await access(source, FS_CONSTANTS.R_OK);
    if (!mounts.has(source)) mounts.set(source, { source, target: source });
  };
  for (const source of report.sharedObjects) {
    if (typeof source === 'string' && source.startsWith('/')) await add(source);
  }
  for (const binary of BOOTSTRAP_BINARIES) {
    await add(binary, { bootstrap: true });
    for (const dependency of parseLddPaths(await ldd(binary))) await add(dependency);
  }
  return [...mounts.values()];
}

// This is executor-owned code. It is never assembled from task input.
const NETWORK_PROBE_SOURCE = String.raw`const net = require('node:net');
const host = process.env.SANDBOX_PROBE_HOST;
const port = Number(process.env.SANDBOX_PROBE_PORT);
const socket = net.connect({ host, port });
let finished = false;
function finish(connected, code) {
  if (finished) return;
  finished = true;
  process.stdout.write(JSON.stringify({ connected, code }) + '\n');
  socket.destroy();
}
socket.setTimeout(200, () => finish(false, 'ETIMEDOUT'));
socket.on('connect', () => finish(true, null));
socket.on('error', (error) => finish(false, error.code || 'NETWORK_ERROR'));
`;

function coded(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function artifactFileName(record) {
  if (!ARTIFACT_ID.test(String(record?.id || '')) || !ARTIFACT_NAME.test(String(record?.name || ''))) {
    throw coded('sandbox_artifact_identity_invalid');
  }
  return `${record.id}-${record.name}`;
}

function validateProbe(probe) {
  if (probe === null || probe === undefined) return null;
  if (typeof probe !== 'object' || Array.isArray(probe)) throw coded('sandbox_network_probe_invalid');
  const host = typeof probe.host === 'string' ? probe.host.trim() : '';
  const port = Number(probe.port);
  if (!host || host.length > 253 || /[\s/\\]/.test(host) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw coded('sandbox_network_probe_invalid');
  }
  return { host, port };
}

async function readProbe(auditDirectory) {
  const file = path.join(auditDirectory, 'network.json');
  if (!(await exists(file))) throw coded('sandbox_network_audit_missing');
  let value;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw coded('sandbox_network_audit_invalid');
  }
  if (typeof value?.connected !== 'boolean' || (value.code !== null && typeof value.code !== 'string')) {
    throw coded('sandbox_network_audit_invalid');
  }
  return { connected: value.connected, code: value.code };
}

/**
 * Copy only regular files from the declared artifact directory. The sandbox is
 * stopped before this function runs; symlinks, directories, excess files and
 * oversized files are policy violations, never downloadable artifacts.
 */
async function persistArtifacts({ directory, runDirectory, runId, policy, clock }) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > policy.artifacts.maxCount) throw coded('sandbox_artifact_count_exceeded');
  const candidates = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!ARTIFACT_NAME.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      throw coded('sandbox_artifact_type_or_name_refused');
    }
    const file = path.join(directory, entry.name);
    const info = await lstat(file);
    if (!info.isFile() || info.size > policy.artifacts.maxBytes) throw coded('sandbox_artifact_size_or_type_refused');
    const content = await readFile(file);
    if (content.length !== info.size) throw coded('sandbox_artifact_changed_during_export');
    candidates.push({ name: entry.name, content });
  }
  if (!candidates.length) return { records: [], runDirectory: null };

  try {
    const createdAt = new Date(clock()).toISOString();
    const records = [];
    for (const candidate of candidates) {
      const record = {
        id: randomUUID(),
        runId,
        name: candidate.name,
        bytes: candidate.content.length,
        sha256: createHash('sha256').update(candidate.content).digest('hex'),
        createdAt,
        expiresAt: new Date(clock() + policy.artifacts.ttlMs).toISOString()
      };
      record.uri = `sandbox-artifact://${record.id}/${encodeURIComponent(record.name)}`;
      await writeFile(path.join(runDirectory, artifactFileName(record)), candidate.content, { flag: 'wx', mode: 0o600 });
      records.push(record);
    }
    await writeFile(
      path.join(runDirectory, 'manifest.json'),
      JSON.stringify({ version: 1, runId, artifacts: records }, null, 2),
      { flag: 'wx', mode: 0o600 }
    );
    return { records, runDirectory };
  } catch (error) {
    await clearArtifactPayload(runDirectory);
    throw error;
  }
}

async function clearArtifactPayload(runDirectory) {
  if (!runDirectory || !(await exists(runDirectory))) return;
  // Preserve the atomic claim/tombstone. Everything else in this executor-owned
  // directory is a not-yet-published or published artifact payload.
  for (const entry of await readdir(runDirectory)) {
    if (entry === 'claim.json') continue;
    await rm(path.join(runDirectory, entry), { recursive: true, force: true });
  }
}

/**
 * Linux per-run executor. It is intentionally not a default tool and has no
 * host fallback: if namespaces, chroot or rlimits cannot be established, the
 * run is BLOCKed rather than executed on the host.
 */
export function createSandboxExecutor({
  policy: suppliedPolicy = null,
  artifactRoot = path.join('.data', 'agent-artifacts'),
  evidenceStore = null,
  clock = Date.now,
  platform = process.platform,
  uid = process.getuid?.(),
  gid = process.getgid?.(),
  nodePath = process.execPath,
  unsharePath = '/usr/bin/unshare',
  entrypoint = ENTRYPOINT,
  spawnImpl = spawn
} = {}) {
  const policy = suppliedPolicy ? createSandboxPolicy(suppliedPolicy) : createSandboxPolicy();
  const policyHash = hashOf(policy);
  const artifactsPath = path.resolve(artifactRoot);
  let active = 0;
  let runtimeMountsPromise = null;
  const claimedRunIds = new Set();

  async function claimRun(runId, sandboxId) {
    const runDirectory = path.join(artifactsPath, runId);
    try {
      await mkdir(artifactsPath, { recursive: true, mode: 0o700 });
      await mkdir(runDirectory, { recursive: false, mode: 0o700 });
      await writeFile(
        path.join(runDirectory, 'claim.json'),
        JSON.stringify({ version: 1, runId, sandboxId, policyHash, claimedAt: new Date(clock()).toISOString() }),
        { flag: 'wx', mode: 0o600 }
      );
      return runDirectory;
    } catch (error) {
      if (error?.code === 'EEXIST') throw coded('sandbox_duplicate_run', error);
      if (String(error?.code || '').startsWith('sandbox_')) throw error;
      throw coded('sandbox_claim_failed', error);
    }
  }

  async function preflight() {
    if (platform !== 'linux') throw coded('sandbox_linux_namespaces_required');
    if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid <= 0 || gid <= 0) {
      throw coded('sandbox_non_root_host_identity_required');
    }
    const required = [
      unsharePath,
      entrypoint,
      nodePath,
      '/bin/sh',
      '/usr/bin/mount',
      '/usr/bin/touch',
      '/usr/bin/test',
      '/usr/bin/mkdir',
      '/usr/bin/cp',
      '/usr/bin/rm',
      '/usr/bin/ldd',
      '/usr/sbin/chroot',
      '/usr/bin/prlimit',
      '/usr/bin/setpriv',
      '/usr/bin/env'
    ];
    for (const file of required) {
      try {
        await access(file, file === entrypoint ? FS_CONSTANTS.R_OK : FS_CONSTANTS.X_OK);
      } catch (error) {
        throw coded('sandbox_backend_unavailable', error);
      }
    }
    if (!runtimeMountsPromise) {
      runtimeMountsPromise = discoverRuntimeMounts(nodePath).catch((error) => {
        if (String(error?.code || '').startsWith('sandbox_')) throw error;
        throw coded('sandbox_runtime_dependencies_unavailable', error);
      });
    }
    return runtimeMountsPromise;
  }

  async function prepare(base, code, runtimeMounts) {
    const root = path.join(base, 'root');
    const exportDirectory = path.join(base, 'export');
    const audit = path.join(base, 'audit');
    for (const directory of [
      path.join(root, 'usr', 'bin'),
      path.join(root, 'usr', 'lib'),
      path.join(root, 'usr', 'lib64'),
      path.join(root, 'proc'),
      path.join(root, 'dev'),
      path.join(root, 'workspace'),
      path.join(root, 'export'),
      path.join(root, 'tmp'),
      path.join(root, 'run'),
      path.join(root, 'runtime'),
      path.join(root, 'etc'),
      exportDirectory,
      audit
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    for (const mount of runtimeMounts) {
      await mkdir(path.dirname(path.join(root, `.${mount.target}`)), { recursive: true, mode: 0o700 });
    }
    await writeFile(
      path.join(root, 'runtime', 'mounts.list'),
      `${runtimeMounts.map((mount) => `${mount.source}|${mount.target}`).join('\n')}\n`,
      { mode: 0o600, flag: 'wx' }
    );
    await writeFile(path.join(root, 'task.cjs'), code, { mode: 0o600, flag: 'wx' });
    await writeFile(path.join(root, 'runtime', 'network-probe.cjs'), NETWORK_PROBE_SOURCE, { mode: 0o600, flag: 'wx' });
    return { root, exportDirectory, audit };
  }

  function execute(paths, runId, probe) {
    const resources = policy.resources;
    const args = [
      `--map-user=${uid}`,
      `--map-group=${gid}`,
      '--keep-caps',
      '--mount',
      '--net',
      '--pid',
      '--fork',
      '--kill-child=KILL',
      '--ipc',
      '--uts',
      '--propagation',
      'private',
      '/bin/sh',
      entrypoint,
      paths.root,
      paths.exportDirectory,
      paths.audit,
      nodePath,
      runId,
      String(resources.cpuSeconds),
      String(resources.addressSpaceBytes),
      String(resources.heapMb),
      String(resources.semiSpaceMb),
      String(resources.maxProcesses),
      String(resources.maxOpenFiles),
      String(resources.maxFileBytes),
      String(resources.tmpBytes),
      String(resources.workspaceBytes),
      probe ? '1' : '0',
      probe?.host || '',
      probe ? String(probe.port) : ''
    ];
    return new Promise((resolve) => {
      let child;
      let timedOut = false;
      let settled = false;
      let stdout = '';
      let stderr = '';
      let outputTruncated = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (!child?.pid) return;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try { child.kill('SIGKILL'); } catch { /* already exited */ }
        }
      }, resources.wallTimeoutMs);
      timer.unref?.();
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ...value, timedOut, stdout, stderr, outputTruncated });
      };
      try {
        child = spawnImpl(unsharePath, args, {
          detached: true,
          env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'C' },
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        finish({ spawnError: error });
        return;
      }
      const capture = (stream, target) => {
        stream?.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          if (target === 'stdout') {
            if (stdout.length < CAPTURE_LIMIT) stdout += text.slice(0, CAPTURE_LIMIT - stdout.length);
            else outputTruncated = true;
          } else {
            if (stderr.length < CAPTURE_LIMIT) stderr += text.slice(0, CAPTURE_LIMIT - stderr.length);
            else outputTruncated = true;
          }
        });
      };
      capture(child.stdout, 'stdout');
      capture(child.stderr, 'stderr');
      child.once('error', (spawnError) => finish({ spawnError }));
      child.once('close', (exitCode, signal) => finish({ exitCode, signal }));
    });
  }

  async function run({ runId, code, stepId = null, networkProbe = null } = {}) {
    assertSandboxRunId(runId);
    assertSandboxCode(code);
    const probe = validateProbe(networkProbe);
    if (claimedRunIds.has(runId)) {
      return {
        runId,
        sandboxId: null,
        status: 'blocked',
        verdict: 'BLOCK',
        reason: 'sandbox_duplicate_run',
        policyHash,
        artifacts: [],
        evidence: [],
        cleanup: { destroyed: false, rootRemoved: null }
      };
    }
    if (active >= policy.resources.maxConcurrent) {
      return {
        runId,
        sandboxId: null,
        status: 'blocked',
        verdict: 'BLOCK',
        reason: 'sandbox_concurrency_limit',
        policyHash,
        artifacts: [],
        evidence: [],
        cleanup: { destroyed: false, rootRemoved: null }
      };
    }
    claimedRunIds.add(runId);
    active += 1;
    const sandboxId = randomUUID();
    const startedAt = performance.now();
    const events = [];
    let base = null;
    let runDirectory = null;
    let startedEvent = null;
    let artifactDirectory = null;
    let outcome = {
      runId,
      sandboxId,
      status: 'blocked',
      verdict: 'BLOCK',
      reason: 'sandbox_not_started',
      exitCode: null,
      signal: null,
      policyHash,
      network: { mode: 'deny', probe: null },
      artifacts: [],
      outputTruncated: false
    };

    const record = async (kind, input, output, { sourceIds = [], verdict = null } = {}) => {
      const entry = evidenceStore
        ? await evidenceStore.appendEvidence({ runId, stepId, kind, input, output, sourceIds, verdict })
        : { id: randomUUID(), runId, stepId, kind, input, output, sourceIds, verdict };
      events.push(entry);
      return entry;
    };

    try {
      const runtimeMounts = await preflight();
      runDirectory = await claimRun(runId, sandboxId);
      base = await mkdtemp(path.join(os.tmpdir(), `celia-sandbox-${runId}-`));
      const paths = await prepare(base, code, runtimeMounts);
      startedEvent = await record(
        EVIDENCE_KIND.sandboxCreated,
        { runId, policyHash },
        {
          sandboxId,
          policyVersion: SANDBOX_POLICY_VERSION,
          network: 'deny',
          rootReadOnly: true,
          nonRoot: true,
          inheritedCredentials: false
        },
        { verdict: 'PASS' }
      );
      const child = await execute(paths, runId, probe);
      outcome.exitCode = child.exitCode ?? null;
      outcome.signal = child.signal ?? null;
      outcome.outputTruncated = child.outputTruncated;
      const taskStarted = await exists(path.join(paths.audit, 'task-started'));
      if (child.timedOut) {
        outcome.status = 'timeout';
        outcome.verdict = 'TIMEOUT';
        outcome.reason = 'sandbox_wall_timeout';
      } else if (child.spawnError || !taskStarted) {
        outcome.status = 'blocked';
        outcome.reason = child.spawnError ? 'sandbox_start_failed' : 'sandbox_setup_failed';
      } else if (child.exitCode !== 0) {
        const resourceFailure = child.signal === 'SIGXCPU'
          || child.signal === 'SIGKILL'
          || [133, 134, 137].includes(child.exitCode)
          || /out of memory|fatal process|coderange|heap|sigprocmask unblock failed|cpu time limit|resource temporarily unavailable|enospc|no space left|file too large|file size limit|err_fs_file_too_large/i.test(child.stderr);
        outcome.status = resourceFailure ? 'resource_limit' : 'failed';
        outcome.reason = resourceFailure ? 'sandbox_resource_limit' : 'sandbox_task_exit_nonzero';
      } else {
        outcome.status = 'succeeded';
        outcome.verdict = 'PASS';
        outcome.reason = null;
      }

      if (probe && taskStarted) {
        const network = await readProbe(paths.audit);
        outcome.network.probe = { host: probe.host, port: probe.port, ...network };
        await record(
          EVIDENCE_KIND.sandboxNetworkAttempt,
          { runId, host: probe.host, port: probe.port, policy: 'default-deny' },
          { observed: true, connected: network.connected, denied: !network.connected, code: network.code },
          { sourceIds: [startedEvent.id], verdict: network.connected ? 'BLOCK' : 'PASS' }
        );
        if (network.connected) {
          outcome.status = 'blocked';
          outcome.verdict = 'BLOCK';
          outcome.reason = 'sandbox_network_policy_breach';
        } else if (outcome.status === 'succeeded') {
          outcome.network.denied = true;
        }
      }

      if (outcome.status === 'succeeded') {
        const persisted = await persistArtifacts({
          directory: paths.exportDirectory,
          runDirectory,
          runId,
          policy,
          clock
        });
        artifactDirectory = persisted.runDirectory;
        outcome.artifacts = persisted.records;
        for (const artifact of persisted.records) {
          await record(
            EVIDENCE_KIND.sandboxArtifact,
            { runId, artifactId: artifact.id, name: artifact.name },
            { uri: artifact.uri, bytes: artifact.bytes, sha256: artifact.sha256, expiresAt: artifact.expiresAt },
            { sourceIds: [startedEvent.id], verdict: 'PASS' }
          );
        }
      }
    } catch (error) {
      outcome.status = 'blocked';
      outcome.verdict = 'BLOCK';
      outcome.reason = error?.code || 'sandbox_executor_failed';
    } finally {
      let rootRemoved = true;
      if (base) {
        try {
          await rm(base, { recursive: true, force: true });
          rootRemoved = !(await exists(base));
        } catch {
          rootRemoved = false;
        }
      }
      if (!rootRemoved) {
        outcome.status = 'blocked';
        outcome.verdict = 'BLOCK';
        outcome.reason = 'sandbox_cleanup_failed';
      }
      if (outcome.status !== 'succeeded' && artifactDirectory) {
        await clearArtifactPayload(artifactDirectory);
        outcome.artifacts = [];
      }
      outcome.cleanup = { destroyed: rootRemoved, rootRemoved };
      outcome.durationMs = Number((performance.now() - startedAt).toFixed(3));
      if (startedEvent) {
        try {
          await record(
            EVIDENCE_KIND.sandboxFinished,
            { runId, sandboxId },
            {
              status: outcome.status,
              reason: outcome.reason,
              exitCode: outcome.exitCode,
              signal: outcome.signal,
              cleanup: outcome.cleanup,
              artifactCount: outcome.artifacts.length
            },
            { sourceIds: [startedEvent.id], verdict: outcome.verdict }
          );
        } catch (error) {
          outcome.status = 'blocked';
          outcome.verdict = 'BLOCK';
          outcome.reason = 'sandbox_evidence_failed';
          outcome.evidenceError = error?.code || 'append_failed';
          if (artifactDirectory) {
            await clearArtifactPayload(artifactDirectory);
            outcome.artifacts = [];
          }
        }
      }
      outcome.evidence = events;
      active -= 1;
    }
    return outcome;
  }

  async function readArtifact(reference) {
    assertSandboxRunId(reference?.runId);
    if (!ARTIFACT_ID.test(String(reference?.id || ''))) throw coded('sandbox_artifact_identity_invalid');
    const runDirectory = path.join(artifactsPath, reference.runId);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(runDirectory, 'manifest.json'), 'utf8'));
    } catch (error) {
      throw coded('sandbox_artifact_manifest_unavailable', error);
    }
    const record = manifest.artifacts?.find((item) => item.id === reference.id && item.runId === reference.runId);
    if (!record) throw coded('sandbox_artifact_not_found');
    if (Date.parse(record.expiresAt) <= clock()) throw coded('sandbox_artifact_expired');
    const content = await readFile(path.join(runDirectory, artifactFileName(record)));
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== record.sha256 || content.length !== record.bytes) throw coded('sandbox_artifact_hash_mismatch');
    return { ...record, content };
  }

  return {
    policy,
    policyHash,
    run,
    readArtifact,
    get activeCount() { return active; }
  };
}
