// MAN-001 / MAN-003 / MAN-005 — the manifest is a derived contract, capabilities report the
// truth about configuration, and the two MCP registries cannot drift apart silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildManifest,
  renderManifest,
  toolContract,
  toolDigest,
  readWranglerScalars,
  MANIFEST_FILE
} from '../scripts/build-manifest.mjs';
import {
  CAPABILITY_REQUIREMENTS,
  deriveCapabilityReadiness,
  capabilitySettingNames
} from '../workers/celia-edge/capabilities.js';
import { EDGE_MCP_TOOLS } from '../workers/celia-edge/runtime.js';
import { MCP_TOOLS } from '../src/celia-mcp.js';
import { whatsappOnboardingConfig } from '../workers/celia-edge/whatsapp-store.js';
import { EDGE_CAPABILITIES, edgeCapabilitiesFor } from '../workers/celia-edge/worker.js';

const SECRET_VALUE_PATTERNS = [/sk-[A-Za-z0-9]{12,}/, /ghp_[A-Za-z0-9]{20,}/, /BEGIN [A-Z ]*PRIVATE KEY/, /AIza[0-9A-Za-z_-]{20,}/];

test('MAN-01 the committed manifest matches what the sources generate', async () => {
  const expected = renderManifest(await buildManifest());
  const committed = await readFile(new URL(`../${MANIFEST_FILE}`, import.meta.url), 'utf8');
  assert.equal(committed, expected, 'system.manifest.json is stale — run npm run build:manifest');
});

test('MAN-02 the manifest carries no secret value, only setting names', async () => {
  const text = renderManifest(await buildManifest());
  for (const pattern of SECRET_VALUE_PATTERNS) {
    assert.ok(!pattern.test(text), `manifest must not contain a value matching ${pattern}`);
  }
  // Every required setting is an environment-variable NAME.
  for (const name of capabilitySettingNames()) {
    assert.match(name, /^[A-Z][A-Z0-9_]*$/, `${name} should be a setting name`);
  }
});

test('MAN-03 the module list is the bundler graph in dependency-first order', async () => {
  const manifest = await buildManifest();
  const modules = manifest.targets.edge.modules;
  assert.equal(modules.at(-1), 'worker.js', 'the entry module is uploaded last');
  assert.ok(modules.includes('capabilities.js'), 'the new capability module is in the bundle');
  assert.equal(new Set(modules).size, modules.length, 'no module is listed twice');
});

test('MAN-04 the schema section declares an additive policy and fingerprints every migration', async () => {
  const manifest = await buildManifest();
  assert.equal(manifest.schema.policy, 'additive-expand-contract');
  assert.ok(manifest.schema.migrations.length >= 7);
  for (const migration of manifest.schema.migrations) {
    assert.match(migration.version, /^\d{4}_.*\.sql$/);
    assert.match(migration.digest, /^sha256:[a-f0-9]{64}$/);
  }
});

test('MAN-05 changing a tool contract changes its digest, changing prose does not', () => {
  const base = { name: 't', description: 'بالعربية', inputSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string', description: 'وصف' } } } };
  const translated = { ...base, description: 'in English', inputSchema: { ...base.inputSchema, properties: { q: { type: 'string', description: 'description' } } } };
  const retyped = { ...base, inputSchema: { ...base.inputSchema, properties: { q: { type: 'number' } } } };
  assert.equal(toolDigest(base), toolDigest(translated), 'translation is not a contract change');
  assert.notEqual(toolDigest(base), toolDigest(retyped), 'a type change is a contract change');
});

test('MAN-06 required-array order does not create a false contract diff', () => {
  const a = { name: 't', inputSchema: { required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'string' } } } };
  const b = { name: 't', inputSchema: { required: ['b', 'a'], properties: { b: { type: 'string' }, a: { type: 'string' } } } };
  assert.deepEqual(toolContract(a), toolContract(b));
});

test('MAN-07 wrangler scalars are read without a TOML dependency', () => {
  const parsed = readWranglerScalars('name = "celia-phone-google"\nmain = "worker.js"\ncompatibility_date = "2025-01-01"\n');
  assert.deepEqual(parsed, { name: 'celia-phone-google', main: 'worker.js', compatibilityDate: '2025-01-01' });
  assert.deepEqual(readWranglerScalars('# nothing here'), { name: null, main: null, compatibilityDate: null });
});

// ---- MAN-005: parity gate between the two registries -------------------------------------

test('MAN-08 every edge tool exists on Node with an identical contract', () => {
  for (const edgeTool of EDGE_MCP_TOOLS) {
    const nodeTool = MCP_TOOLS.find((candidate) => candidate.name === edgeTool.name);
    assert.ok(nodeTool, `${edgeTool.name} is missing from the Node registry`);
    assert.deepEqual(
      toolContract(edgeTool),
      toolContract(nodeTool),
      `${edgeTool.name} contract drifted between edge and node`
    );
  }
});

test('MAN-09 the advertised tool count is the measured registry length', () => {
  assert.equal(EDGE_CAPABILITIES.mcpToolsCount, EDGE_MCP_TOOLS.length);
  assert.equal(EDGE_MCP_TOOLS.length, MCP_TOOLS.length);
});

// ---- MAN-003: capability readiness is derived, not asserted -------------------------------

test('MAN-10 an unconfigured environment reports false with the missing setting names', () => {
  const readiness = deriveCapabilityReadiness({});
  assert.equal(readiness.mcp.configured, true, 'the bundle itself always serves MCP');
  assert.equal(readiness.googleOAuth.configured, false);
  assert.deepEqual(readiness.googleOAuth.missing, ['Google OAuth client id', 'Google OAuth client secret', 'D1']);
  assert.equal(readiness.cronScheduler.configured, false);
});

test('MAN-11 placeholders never count as configuration', () => {
  const readiness = deriveCapabilityReadiness({
    GOOGLE_CLIENT_ID: 'replace-with-client-id',
    GOOGLE_CLIENT_SECRET: '   ',
    DB: {}
  });
  assert.equal(readiness.googleOAuth.configured, false);
  assert.deepEqual(readiness.googleOAuth.missing, ['Google OAuth client id', 'Google OAuth client secret']);
});

test('MAN-12 a fully configured environment reports true with nothing missing', () => {
  const readiness = deriveCapabilityReadiness({
    DB: {},
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    WHATSAPP_APP_ID: '123456789',
    WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: '987654321',
    WHATSAPP_APP_SECRET: 'a-long-enough-app-secret',
    TOKEN_ENCRYPTION_KEY: 'key-material',
    GEMINI_API_KEY: 'gemini-key',
    CELIAOS_CRONJOB_ORG_API_KEY: 'cron-key'
  });
  for (const [id, value] of Object.entries(readiness)) {
    assert.equal(value.configured, true, `${id} should be configured`);
    assert.deepEqual(value.missing, []);
  }
});

test('MAN-13 any one AI provider is enough, and none is reported as one grouped label', () => {
  assert.equal(deriveCapabilityReadiness({ DEEPSEEK_API_KEY: 'k' }).aiReply.configured, true);
  const none = deriveCapabilityReadiness({}).aiReply;
  assert.equal(none.configured, false);
  assert.equal(none.missing.length, 1, 'one grouped label, not four secret names');
});

test('MAN-14 readiness never echoes a value, even when a value looks like a secret', () => {
  const secret = 'sk-supersecretvalue123456';
  const readiness = deriveCapabilityReadiness({ GOOGLE_CLIENT_ID: secret, DB: {} });
  const text = JSON.stringify(readiness);
  assert.ok(!text.includes(secret), 'a configured value must never be echoed back');
  assert.ok(!text.includes('supersecret'));
});

test('MAN-15 the mounted booleans keep their old meaning so existing clients do not break', () => {
  const caps = edgeCapabilitiesFor({});
  // verify-live.mjs and older clients assert these three are true.
  assert.equal(caps.mcp, true);
  assert.equal(caps.googleOAuth, true);
  assert.equal(caps.whatsappWebhook, true);
  // The derived truth is additive and says the opposite about readiness.
  assert.equal(caps.readiness.googleOAuth.configured, false);
});

test('MAN-16 the declared onboarding requirements match the code that actually gates linking', () => {
  const declared = CAPABILITY_REQUIREMENTS.find((requirement) => requirement.id === 'whatsappOnboarding');
  // With only D1 present, the real gate names these four operator settings as missing.
  const real = whatsappOnboardingConfig({ DB: {} });
  const derived = deriveCapabilityReadiness({ DB: {} }).whatsappOnboarding;
  assert.equal(derived.configured, false);
  for (const label of real.missing) {
    if (label === 'Graph API version') continue; // has a working default, not an operator setting
    assert.ok(derived.missing.includes(label), `declaration is missing "${label}" reported by the real gate`);
  }
  assert.ok(declared.requires.includes('TOKEN_ENCRYPTION_KEY'), 'the VER-11 gap must stay covered');
});

test('MAN-17 every declared capability appears in the manifest and in runtime readiness', async () => {
  const manifest = await buildManifest();
  const readiness = deriveCapabilityReadiness({});
  for (const requirement of CAPABILITY_REQUIREMENTS) {
    assert.ok(manifest.capabilities.some((entry) => entry.id === requirement.id), `${requirement.id} missing from manifest`);
    assert.ok(readiness[requirement.id], `${requirement.id} missing from runtime readiness`);
  }
});

test('MAN-18 CI runs the manifest drift gate and it cannot fail open', async () => {
  const workflow = await readFile(new URL('../.github/workflows/celia-mcp.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes('build:manifest:check'), 'CI must check manifest drift');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['build:manifest:check'], 'node scripts/build-manifest.mjs --check');
});
