// The free-deployment blueprint is the first thing the owner's account runs unattended. A missing or mistyped
// environment key there costs a full deploy cycle and looks like "the system is broken", so the blueprint is
// checked against the code that reads it — not against a hand-written list that drifts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const blueprint = readFileSync(path.join(root, 'render.yaml'), 'utf8');
const config = readFileSync(path.join(root, 'src/config.js'), 'utf8');

const entries = [...blueprint.matchAll(/^ {6}- key: ([A-Z0-9_]+)\n((?: {8}[^\n]*\n)*)/gm)].map(([, key, body]) => ({
  key,
  body
}));
const declared = new Map(entries.map(({ key, body }) => [key, body]));
const keys = [...declared.keys()];

/** Values the blueprint must never carry: real credentials belong in the dashboard, not in Git. */
const SECRET_KEYS = [
  'CELIA_MCP_API_TOKEN', 'TOKEN_ENCRYPTION_KEY', 'APP_API_TOKEN', 'GOOGLE_CLIENT_SECRET', 'GEMINI_API_KEY',
  'ELEVENLABS_API_KEY', 'FIGMA_ACCESS_TOKEN', 'YOUR_CODATA_API_KEY', 'DEEPSEEK_API_KEY', 'AI_GATEWAY_API_KEY',
  'AGENETROUTERAPI_KEY', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN',
  'MYSQL_PASSWORD', 'MYSQL_SSL_CA_BASE64'
];

test('blueprint: everything src/config.js requires to boot is declared (generateValue or sync:false)', () => {
  const required = [...config.matchAll(/required\('([A-Z0-9_]+)'\)/g)].map(([, name]) => name);
  assert.ok(required.includes('TOKEN_ENCRYPTION_KEY'));
  assert.ok(required.includes('APP_API_TOKEN'));

  // APP_API_TOKEN is optional by design: `useFallbackMcpToken` reuses CELIA_MCP_API_TOKEN, which the blueprint
  // generates. Every other required variable must be declared explicitly.
  assert.match(config, /useFallbackMcpToken/, 'the fallback that makes APP_API_TOKEN optional must still exist');
  const OPTIONAL_BY_FALLBACK = ['APP_API_TOKEN'];
  for (const name of required) {
    if (OPTIONAL_BY_FALLBACK.includes(name)) continue;
    assert.ok(declared.has(name), `${name} is required at boot but absent from render.yaml`);
  }
  const appToken = declared.get('APP_API_TOKEN');
  assert.ok(appToken === undefined || /sync: false|generateValue: true/.test(appToken), 'if declared, it must never carry a value');
  assert.match(declared.get('CELIA_MCP_API_TOKEN'), /generateValue: true/);
  assert.match(declared.get('TOKEN_ENCRYPTION_KEY'), /generateValue: true/);
});

test('blueprint: no credential is committed — every secret is generated or left for the dashboard', () => {
  for (const key of SECRET_KEYS.filter((name) => declared.has(name))) {
    assert.match(declared.get(key), /sync: false|generateValue: true/, `${key} must not carry a literal value`);
  }
  // No bearer token, key or password shape anywhere in the file.
  assert.doesNotMatch(blueprint, /(sk-[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|AIza[0-9A-Za-z_-]{20,})/);
});

test('blueprint: the Google channel is only reachable with a real public origin, never localhost', () => {
  // The OAuth redirect defaults to APP_BASE_URL, whose default is http://localhost:PORT — fine locally, fatal on Render.
  assert.match(config, /redirectUri:\s*env\.GOOGLE_REDIRECT_URI \|\| `\$\{env\.APP_BASE_URL/);
  assert.ok(declared.has('APP_BASE_URL'), 'APP_BASE_URL must be declared so the owner is forced to set the public URL');
  assert.match(declared.get('APP_BASE_URL'), /sync: false/, 'Render cannot know its own URL; the owner pastes it');
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']) {
    assert.match(declared.get(key) ?? '', /sync: false/, `${key} must be entered in the dashboard`);
  }
});

test('blueprint: the WhatsApp runtime credentials the code reads are all reachable from the dashboard', () => {
  for (const key of ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN']) {
    assert.ok(declared.has(key), `${key} is read by src/config.js and must exist in the blueprint`);
  }
  // Safety default: never turn the customer auto-reply on by deploying.
  assert.match(declared.get('WHATSAPP_AUTO_REPLY_ENABLED'), /value: 'false'/);
  assert.match(declared.get('WHATSAPP_API_VERSION'), /value: 'v\d+\.\d+'/);
});

test('blueprint: free tier, one service, real health check, and no auto-deploy surprise', () => {
  assert.equal((blueprint.match(/^ {2}- type: web$/gm) || []).length, 1, 'the free 750 hours cover exactly one web service');
  assert.match(blueprint, /plan: free/);
  assert.doesNotMatch(blueprint, /plan: (starter|standard|pro)/);
  assert.doesNotMatch(blueprint, /disk:|type: worker|type: cron/, 'no paid disk, worker or cron job in the free path');
  assert.match(blueprint, /healthCheckPath: \/readyz/);
  assert.match(blueprint, /autoDeployTrigger: 'off'/, 'deploys stay explicit (DEC-028 runs them from CI)');
  const port = /- key: PORT\n\s+value: '(\d+)'/.exec(blueprint)?.[1];
  const mcpPort = /- key: CELIA_MCP_PORT\n\s+value: '(\d+)'/.exec(blueprint)?.[1];
  assert.equal(port, mcpPort, 'the container port and the server port must agree or the health check fails');
  assert.ok(existsSync(path.join(root, 'Dockerfile.mcp')), 'the blueprint dockerfile must exist');
  assert.match(blueprint, /dockerfilePath: \.\/Dockerfile\.mcp/);
});

test('blueprint: durable MySQL is on, and every retired service is pinned off exactly as Git says', () => {
  assert.match(declared.get('CELIA_MCP_DISABLE_MYSQL'), /value: 'false'/, 'production must not silently fall back to memory');
  assert.match(declared.get('MYSQL_SSL'), /value: 'true'/, 'Aiven requires TLS');
  assert.match(declared.get('CELIA_ENABLE_INTEGRATIONS'), /value: 'true'/);

  const profile = JSON.parse(readFileSync(path.join(root, 'docs/deployment-profile.json'), 'utf8'));
  for (const [service, entry] of Object.entries(profile.serviceRetirements || {})) {
    const flag = `CELIA_DISABLE_${service.toUpperCase()}`;
    assert.match(declared.get(flag) ?? '', /value: 'true'/, `${flag} must mirror serviceRetirements.${service} (${entry.decision})`);
  }
  // And the reverse: a flag that is not retired must not be silently switched off in the blueprint.
  for (const key of keys.filter((name) => name.startsWith('CELIA_DISABLE_'))) {
    const service = key.replace('CELIA_DISABLE_', '').toLowerCase();
    if (service === 'ollama') continue;
    assert.ok(profile.serviceRetirements?.[service], `${key} is set but ${service} is not retired in deployment-profile.json`);
  }
});

test('blueprint: the daily runtime values a phone assistant needs are declared', () => {
  assert.match(declared.get('NODE_ENV'), /value: production/);
  assert.match(declared.get('CELIA_TIMEZONE'), /value: Africa\/Cairo/, '"هات جدولي" must resolve times in the owner timezone');
  assert.match(declared.get('CELIA_DB_INITIALIZE'), /value: empty-only/, 'the first boot may create a schema only in an empty database');
});
