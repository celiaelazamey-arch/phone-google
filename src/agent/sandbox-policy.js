/**
 * AGENT-003 policy is code, not a prompt or a caller-provided capability.
 * This first backend is deliberately deny-by-default: no egress, no inherited
 * credentials, no host workspace, and no executable tool registration.
 */
export const SANDBOX_POLICY_VERSION = 'agent-sandbox-v1';
export const SANDBOX_WORKSPACE = '/workspace';
export const SANDBOX_MAX_CODE_CHARS = 100_000;

const DEFAULTS = Object.freeze({
  network: Object.freeze({ mode: 'deny', allowlist: Object.freeze([]) }),
  resources: Object.freeze({
    cpuSeconds: 2,
    addressSpaceBytes: 1_073_741_824,
    heapMb: 64,
    semiSpaceMb: 4,
    maxProcesses: 16,
    maxOpenFiles: 64,
    maxFileBytes: 1_048_576,
    workspaceBytes: 8_388_608,
    tmpBytes: 4_194_304,
    wallTimeoutMs: 2_000,
    maxConcurrent: 2
  }),
  artifacts: Object.freeze({ maxCount: 1, maxBytes: 1_048_576, ttlMs: 3_600_000 })
});

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name}_must_be_object`);
  }
  return value;
}

function keys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${name}_unknown_field:${key}`);
  }
}

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name}_outside_bounds`);
  }
  return value;
}

export function assertSandboxRunId(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(runId)) {
    throw new Error('sandbox_run_id_invalid');
  }
  return runId;
}

export function assertSandboxCode(code) {
  if (typeof code !== 'string' || !code.trim() || code.length > SANDBOX_MAX_CODE_CHARS) {
    throw new Error('sandbox_code_invalid_or_too_large');
  }
  return code;
}

/** Return a fresh, deeply frozen policy; unknown fields fail closed. */
export function createSandboxPolicy(overrides = {}) {
  object(overrides, 'sandbox_policy');
  keys(overrides, ['network', 'resources', 'artifacts'], 'sandbox_policy');
  const network = { ...DEFAULTS.network, ...(overrides.network || {}) };
  keys(network, ['mode', 'allowlist'], 'sandbox_network');
  if (network.mode !== 'deny') throw new Error('sandbox_network_must_default_deny');
  if (!Array.isArray(network.allowlist) || network.allowlist.length !== 0) {
    // No proxy/egress backend is claimed in this slice. Do not accept an
    // allowlist and then silently run without enforcing it.
    throw new Error('sandbox_egress_allowlist_backend_unavailable');
  }

  const resources = { ...DEFAULTS.resources, ...(overrides.resources || {}) };
  keys(resources, Object.keys(DEFAULTS.resources), 'sandbox_resources');
  integer(resources.cpuSeconds, 'sandbox_cpu_seconds', 1, 60);
  integer(resources.addressSpaceBytes, 'sandbox_address_space', 268_435_456, 8_589_934_592);
  integer(resources.heapMb, 'sandbox_heap_mb', 16, 512);
  integer(resources.semiSpaceMb, 'sandbox_semi_space_mb', 1, 64);
  integer(resources.maxProcesses, 'sandbox_processes', 4, 128);
  integer(resources.maxOpenFiles, 'sandbox_open_files', 16, 1_024);
  integer(resources.maxFileBytes, 'sandbox_file_bytes', 1_024, 16_777_216);
  // M-B/B1: الحد الأقصى القابل للطلب رُفع إلى 256MiB — الافتراضي يبقى 8MiB،
  // والرفع قرار تهيئة معلن لكل نشر (لا يغيّره المخطط ولا أي مستدعٍ وقت التشغيل).
  integer(resources.workspaceBytes, 'sandbox_workspace_bytes', 1_048_576, 268_435_456);
  integer(resources.tmpBytes, 'sandbox_tmp_bytes', 1_048_576, 67_108_864);
  integer(resources.wallTimeoutMs, 'sandbox_wall_timeout', 100, 30_000);
  integer(resources.maxConcurrent, 'sandbox_concurrency', 1, 8);

  const artifacts = { ...DEFAULTS.artifacts, ...(overrides.artifacts || {}) };
  keys(artifacts, Object.keys(DEFAULTS.artifacts), 'sandbox_artifacts');
  integer(artifacts.maxCount, 'sandbox_artifact_count', 1, 1);
  integer(artifacts.maxBytes, 'sandbox_artifact_bytes', 1_024, 16_777_216);
  integer(artifacts.ttlMs, 'sandbox_artifact_ttl', 1_000, 86_400_000);
  if (artifacts.maxBytes > resources.workspaceBytes) throw new Error('sandbox_artifact_exceeds_workspace_quota');

  return freeze({
    version: SANDBOX_POLICY_VERSION,
    network: { mode: 'deny', allowlist: [] },
    filesystem: {
      rootReadOnly: true,
      workspace: SANDBOX_WORKSPACE,
      hostMounts: 'runtime-read-only-plus-fresh-workspace',
      inheritedCredentials: false
    },
    identity: { nonRoot: true, credentials: 'none' },
    resources,
    artifacts
  });
}

export const DEFAULT_SANDBOX_POLICY = createSandboxPolicy();
