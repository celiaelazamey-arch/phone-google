import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { loadMysqlConfig } from '../src/mysql-config.js';
import { bootstrapEmptySchema, REQUIRED_COLUMNS } from '../src/bootstrap-schema.js';
import { loadCeliaMcpConfig, createCeliaMcpApp } from '../src/celia-mcp.js';
import { createMemoryPool } from '../src/memory-pool.js';
import { releaseInfo } from '../src/version.js';
import { deploymentStatus } from '../src/hosting.js';

const token = crypto.randomBytes(32).toString('hex');
const key = crypto.randomBytes(32).toString('base64');
const fullEnv = { CELIA_MCP_API_TOKEN: token, TOKEN_ENCRYPTION_KEY: key, CELIA_ENABLE_INTEGRATIONS: 'true', CELIA_DISABLE_OLLAMA: 'true' };

test('MySQL TLS verifies certificates and supports an explicit CA without exposing it on validation errors', () => {
  const encoded = Buffer.from(rootCertificates[0]).toString('base64');
  const config = loadMysqlConfig({ NODE_ENV: 'production', MYSQL_SSL_CA_BASE64: encoded, MYSQL_PORT: '25060' });
  assert.equal(config.port, 25060);
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.ssl.verifyIdentity, true);
  assert.equal(config.ssl.minVersion, 'TLSv1.2');
  assert.equal(config.ssl.ca, rootCertificates[0]);
  assert.equal(loadMysqlConfig({}).ssl, undefined);
  assert.equal(loadMysqlConfig({ MYSQL_SSL: 'true' }).ssl.rejectUnauthorized, true);
  for (const env of [{ NODE_ENV: 'production', MYSQL_SSL: 'false' }, { MYSQL_SSL: 'yes' }, { MYSQL_PORT: 'NaN' }, { MYSQL_PORT: '65536' }, { MYSQL_SSL_CA_BASE64: encoded }, { NODE_ENV: 'production', MYSQL_SSL_CA_BASE64: 'private-invalid-value' }]) {
    assert.throws(() => loadMysqlConfig(env), (error) => !error.message.includes('private-invalid-value') && !error.message.includes(encoded));
  }
});

test('legacy mode remains opt-in while full mode rejects memory, missing keys and insecure production origins', () => {
  assert.equal(loadCeliaMcpConfig({ CELIA_MCP_API_TOKEN: token }).hosting.integrationsEnabled, false);
  assert.equal(loadCeliaMcpConfig({ ...fullEnv, PORT: '4187' }).port, 4187);
  assert.equal(loadCeliaMcpConfig({ CELIA_MCP_API_TOKEN: token, PORT: '3000', CELIA_MCP_PORT: '3010' }).port, 3010);
  assert.equal(loadCeliaMcpConfig({ CELIA_MCP_API_TOKEN: token, PORT: '3000' }).port, 3010);
  for (const env of [
    { ...fullEnv, CELIA_MCP_DISABLE_MYSQL: 'true' },
    { ...fullEnv, TOKEN_ENCRYPTION_KEY: '' },
    { ...fullEnv, NODE_ENV: 'production' },
    { ...fullEnv, NODE_ENV: 'production', APP_BASE_URL: 'http://plain.example' },
    { ...fullEnv, APP_BASE_URL: 'https://user:secret@example.test' },
    { ...fullEnv, APP_BASE_URL: 'https://example.test/prefix' },
    { ...fullEnv, CELIA_DB_INITIALIZE: 'always' },
    { ...fullEnv, CELIA_SOURCE_REF: '../main' },
    { ...fullEnv, CELIA_ENABLE_INTEGRATIONS: 'yes' }
  ]) assert.throws(() => loadCeliaMcpConfig(env));
  const config = loadCeliaMcpConfig({ ...fullEnv, NODE_ENV: 'production', RENDER_EXTERNAL_URL: 'https://celia-example.onrender.com' });
  assert.equal(config.hosting.integrationConfig.google.redirectUri, 'https://celia-example.onrender.com/auth/google/callback');
  assert.equal(config.hosting.integrationConfig.apiToken, token);
  assert.throws(() => createCeliaMcpApp({ pool: createMemoryPool(), config }), /demonstration memory/);
});

function connectionFixture({ existing = [], valid = true, lock = 1, failDdl = false } = {}) {
  const calls = [];
  let ended = false;
  return {
    calls,
    get ended() { return ended; },
    async query(input) {
      const sql = input.sql;
      calls.push(sql);
      if (sql.includes('GET_LOCK')) return [[{ acquired: lock }]];
      if (sql.includes('information_schema.TABLES')) return [existing.map((tableName) => ({ tableName }))];
      if (sql.includes('information_schema.COLUMNS')) return [valid ? Object.entries(REQUIRED_COLUMNS).flatMap(([tableName, cols]) => cols.map((columnName) => ({ tableName, columnName }))) : []];
      if (failDdl && sql.startsWith('CREATE')) throw new Error('driver-error-containing-secret-do-not-log');
      return [[]];
    },
    async end() { ended = true; }
  };
}

test('first installation creates only the original schema on an empty database and releases its lock', async () => {
  const connection = connectionFixture();
  const result = await bootstrapEmptySchema({ mysql: { database: 'dedicated-test' } }, { connect: async () => connection });
  assert.equal(result.action, 'initialized-empty-database');
  assert.equal(result.tables, 5);
  assert.equal(connection.calls.filter((s) => s.startsWith('CREATE TABLE')).length, 5);
  assert.equal(connection.calls.some((s) => /\b(DROP|ALTER|TRUNCATE)\b/.test(s)), false);
  assert.ok(connection.calls.some((s) => s.includes('RELEASE_LOCK')));
  assert.equal(connection.ended, true);
});

test('existing compatible databases are inspected, never modified, even when they have extra tables', async () => {
  const connection = connectionFixture({ existing: [...Object.keys(REQUIRED_COLUMNS), 'unrelated'] });
  const result = await bootstrapEmptySchema({ mysql: { database: 'existing-test' } }, { connect: async () => connection });
  assert.equal(result.action, 'existing-database-unchanged');
  assert.equal(connection.calls.some((s) => /\b(CREATE|DROP|ALTER|INSERT|DELETE|UPDATE|TRUNCATE)\b/.test(s)), false);
});

test('non-empty incompatible databases and busy installers fail closed without attempting repair', async () => {
  for (const scenario of [{ existing: ['unrelated'], valid: false }, { existing: ['app_users'], valid: false }, { lock: 0 }]) {
    const connection = connectionFixture(scenario);
    await assert.rejects(bootstrapEmptySchema({ mysql: { database: 'test' } }, { connect: async () => connection }), /refused|busy/);
    assert.equal(connection.calls.some((s) => /\b(CREATE|DROP|ALTER|TRUNCATE)\b/.test(s)), false);
    assert.equal(connection.ended, true);
  }
});

test('installation failures do not leak raw driver errors or silently continue a partially initialized schema', async () => {
  const connection = connectionFixture({ failDdl: true });
  await assert.rejects(bootstrapEmptySchema({ mysql: { database: 'test' } }, { connect: async () => connection }), (error) => !error.message.includes('driver-error') && /first installation failed/.test(error.message));
  assert.equal(connection.ended, true);
  await assert.rejects(bootstrapEmptySchema({ envDisableMysql: true, mysql: {} }), /demonstration memory/);
});

async function serve(config, fn) {
  const memory = createMemoryPool();
  // Unit-only adapter: SQL integration and persistence are tested separately against real MySQL in CI.
  const pool = { isMemory: false, query: memory.query.bind(memory), execute: memory.execute.bind(memory), end: memory.end.bind(memory) };
  const app = createCeliaMcpApp({ pool, config });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await pool.end(); }
}

test('one-port full runtime preserves public status, protected REST, MCP and raw HMAC verification', async () => {
  const config = loadCeliaMcpConfig({ ...fullEnv, WHATSAPP_APP_SECRET: 'synthetic-webhook-key', WHATSAPP_VERIFY_TOKEN: 'synthetic-verify-token' });
  await serve(config, async (base) => {
    for (const route of ['/health', '/api/system', '/api/live', '/api/releases', '/api/deployment', '/deploy', '/studio']) {
      assert.equal((await fetch(base + route)).status, 200, route);
    }
    for (const route of ['/api/google/gmail/search?q=test', '/auth/google']) assert.equal((await fetch(base + route)).status, 401);
    assert.equal((await fetch(`${base}/api/whatsapp/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/mcp`)).status, 401);
    assert.equal((await fetch(`${base}/auth/google`, { headers: { authorization: `Bearer ${token}` } })).status, 503);
    assert.equal(await (await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=synthetic-verify-token&hub.challenge=123`)).text(), '123');
    const body = '{ "object": "whatsapp_business_account", "entry": [] }';
    const signature = `sha256=${crypto.createHmac('sha256', 'synthetic-webhook-key').update(body).digest('hex')}`;
    const response = await fetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body });
    assert.equal(response.status, 200);
    assert.equal((await fetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body: body + ' ' })).status, 401);
    const status = await (await fetch(`${base}/api/deployment`)).json();
    assert.equal(status.fullApiMounted, true);
    assert.equal(status.allCapabilitiesVerified, false);
    const serialized = JSON.stringify(status);
    for (const secret of [token, key, 'synthetic-webhook-key', 'synthetic-verify-token']) assert.equal(serialized.includes(secret), false);
  });
});

test('deployment report cannot claim full publication from configured credentials or a host-provided URL', () => {
  const config = loadCeliaMcpConfig({ ...fullEnv, RENDER_EXTERNAL_URL: 'https://celia-test.onrender.com' });
  const report = deploymentStatus({ config, snapshot: { ready: true, storage: { durable: true, available: true }, components: ['google', 'whatsapp', 'gemini'].map((id) => ({ id, state: 'healthy' })) } });
  assert.equal(report.configuredRuntimeReady, true);
  assert.equal(report.publicUrl, 'https://celia-test.onrender.com');
  assert.equal(report.publicUrlVerification, 'not-externally-verified');
  assert.equal(report.allCapabilitiesVerified, false);
});

test('Docker default unknown build label cannot mask the real Render commit', () => {
  const sha = 'd'.repeat(40);
  assert.equal(releaseInfo({ CELIA_BUILD_SHA: 'unknown', RENDER_GIT_COMMIT: sha }).commit, sha);
  assert.equal(releaseInfo({ CELIA_BUILD_SHA: 'a'.repeat(40), RENDER_GIT_COMMIT: sha }).commit, 'a'.repeat(40));
});
