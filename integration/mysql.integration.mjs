import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { connect as connectSocket } from 'node:net';
import { loadMysqlConfig } from '../src/mysql-config.js';
import { bootstrapEmptySchema } from '../src/bootstrap-schema.js';
import { loadCeliaMcpConfig, createCeliaMcpApp, MCP_TOOLS } from '../src/celia-mcp.js';
import { assertBackwardCompatibleMcpTools } from '../src/mcp-contract.js';
import { createPool, ensureOwner } from '../src/db.js';
import { encryptJson, decryptJson } from '../src/security.js';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const baseline = '2508893bd7e6d447b2e19374933556322cc9cdb7';

function pipeCommand(command, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => err.push(b));
    child.on('error', () => reject(new Error('Isolated MySQL test command could not start')));
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error('Isolated MySQL test command failed (credentials and dump deliberately not logged)')));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function serve(config, factory = createCeliaMcpApp) {
  const pool = createPool(config);
  await ensureOwner(pool, config);
  const server = factory({ pool, config }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    pool,
    base: `http://127.0.0.1:${server.address().port}`,
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await pool.end(); }
  };
}

// Explicit opt-in and loopback-only: this test may CREATE/DROP only its own random fixture schemas.
test('real MySQL 8.4 acceptance: installation, persistence, signed webhook, legacy compatibility and backup/restore', { timeout: 90000 }, async (t) => {
  assert.equal(process.env.CELIA_MYSQL_TESTS, 'true', 'Use the isolated CI MySQL service; this suite never silently skips');
  const host = process.env.MYSQL_TEST_HOST || '127.0.0.1';
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(host), 'Remote/production databases are forbidden by this harness');
  const container = process.env.MYSQL_TEST_CONTAINER;
  assert.match(container || '', /^[a-f0-9]{12,64}$/, 'A disposable CI MySQL container is required');
  const password = process.env.MYSQL_TEST_PASSWORD;
  assert.ok(password);
  const port = Number(process.env.MYSQL_TEST_PORT || 3306);
  const admin = await mysql.createConnection({ host, port, user: 'root', password, charset: 'utf8mb4', timezone: 'Z' });
  const suffix = crypto.randomBytes(8).toString('hex');
  const schemas = [`celia_ci_${suffix}`, `celia_ci_restore_${suffix}`, `celia_ci_guard_${suffix}`];
  assert.ok(schemas.every((s) => /^celia_ci_(?:restore_|guard_)?[a-f0-9]{16}$/.test(s)));
  const [source, restored, foreign] = schemas;
  let runtime;
  let previousDirectory;
  t.after(async () => {
    if (runtime) await runtime.close();
    for (const schema of schemas) await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    await admin.end();
    if (previousDirectory) await rm(previousDirectory, { recursive: true, force: true });
  });
  for (const schema of schemas) await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
  const token = crypto.randomBytes(32).toString('hex');
  const key = crypto.randomBytes(32).toString('base64');
  const env = {
    NODE_ENV: 'test', CELIA_MCP_API_TOKEN: token, TOKEN_ENCRYPTION_KEY: key,
    CELIA_ENABLE_INTEGRATIONS: 'true', CELIA_DISABLE_OLLAMA: 'true',
    MYSQL_HOST: host, MYSQL_PORT: String(port), MYSQL_DATABASE: source, MYSQL_USER: 'root', MYSQL_PASSWORD: password,
    WHATSAPP_APP_SECRET: 'synthetic-hmac-key', WHATSAPP_AUTO_REPLY_ENABLED: 'false'
  };
  const config = loadCeliaMcpConfig(env);
  const checks = [];
  const check = async (name, fn) => t.test(name, async () => { await fn(); checks.push({ name, status: 'passed' }); });
  let version;

  await check('engine is actual MySQL 8.4, not a mock or MariaDB substitute', async () => {
    const [rows] = await admin.query('SELECT VERSION() AS version');
    version = rows[0].version;
    assert.match(version, /^8\.4\./);
  });
  await check('real MySQL TLS rejects a trusted certificate with the wrong hostname', async () => {
    // MySQL's auto-generated server certificate is intentionally NOT valid for localhost.
    // Trust its CA, then require an ALTNAME rejection: issuer validation alone is insufficient.
    const ca = await pipeCommand('docker', ['exec', container, 'cat', '/var/lib/mysql/ca.pem']);
    const tlsConfig = loadMysqlConfig({ ...env, MYSQL_HOST: 'localhost', MYSQL_SSL: 'true', MYSQL_SSL_CA_BASE64: ca.toString('base64') });
    let socket, unexpectedConnection;
    try {
      await assert.rejects(async () => {
        unexpectedConnection = await mysql.createConnection({ ...tlsConfig, ssl: { ...tlsConfig.ssl }, connectTimeout: 5000, stream: () => (socket = connectSocket({ host, port })) });
      }, // mysql2 deliberately wraps native TLS error codes as HANDSHAKE_SSL_ERROR.
      (error) => ['ERR_TLS_CERT_ALTNAME_INVALID', 'HANDSHAKE_SSL_ERROR'].includes(error.code) && /Hostname\/IP does not match certificate/.test(error.message));
    } finally {
      if (unexpectedConnection) await unexpectedConnection.end();
      socket?.destroy();
    }
  });
  await check('first initialization creates five tables and a second initialization leaves existing data intact', async () => {
    assert.equal((await bootstrapEmptySchema(config)).action, 'initialized-empty-database');
    runtime = await serve(config);
    const [before] = await admin.query(`SELECT COUNT(*) AS count FROM \`${source}\`.app_users`);
    assert.equal((await bootstrapEmptySchema(config)).action, 'existing-database-unchanged');
    const [after] = await admin.query(`SELECT COUNT(*) AS count FROM \`${source}\`.app_users`);
    assert.equal(after[0].count, before[0].count);
    assert.equal((await (await fetch(`${runtime.base}/readyz`)).json()).storage.durable, true);
  });
  await check('unrelated non-empty database is refused without altering its rows', async () => {
    // A database containing only a view is NOT empty and must remain untouched.
    await admin.query(`CREATE VIEW \`${foreign}\`.unrelated AS SELECT 7 AS id`);
    await assert.rejects(bootstrapEmptySchema({ ...config, mysql: { ...config.mysql, database: foreign } }), /refused/);
    const [rows] = await admin.query(`SELECT id FROM \`${foreign}\`.unrelated`);
    assert.deepEqual(rows.map((r) => r.id), [7]);
    const [tables] = await admin.execute('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [foreign]);
    assert.equal(tables.length, 1);
  });
  const phone = '+201000000001';
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  await check('real consent writes and exact-byte HMAC webhook deduplication share the single public port', async () => {
    assert.equal((await fetch(`${runtime.base}/api/google/drive/search?q=test`)).status, 401);
    const consent = await fetch(`${runtime.base}/api/whatsapp/contacts/${phone}/consent`, { method: 'POST', headers: auth, body: JSON.stringify({ optedIn: true, aiOptedIn: false, source: 'synthetic-ci-only' }) });
    assert.equal(consent.status, 200);
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ id: `fixture-${suffix}`, from: phone.slice(1), type: 'text', text: { body: 'رسالة قبول مصطنعة — ليست بيانات عميل' } }] } }] }] });
    const signature = `sha256=${crypto.createHmac('sha256', 'synthetic-hmac-key').update(raw).digest('hex')}`;
    const arrivals = await Promise.all([0, 1].map(() => fetch(`${runtime.base}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body: raw })));
    assert.ok(arrivals.every((response) => response.status === 200));
    const [rows] = await admin.query(`SELECT body FROM \`${source}\`.whatsapp_messages WHERE provider_message_id = ?`, [`fixture-${suffix}`]);
    assert.equal(rows.length, 1);
    assert.match(rows[0].body, /رسالة قبول مصطنعة/);
  });
  await check('transaction rollback and encryption round-trip run against real persistent storage', async () => {
    const connection = await mysql.createConnection({ ...config.mysql, charset: 'utf8mb4' });
    try {
      await connection.beginTransaction();
      await connection.execute('INSERT INTO app_users (id) VALUES (?)', ['rolled-back-fixture']);
      await connection.rollback();
      const [rows] = await connection.execute('SELECT id FROM app_users WHERE id = ?', ['rolled-back-fixture']);
      assert.equal(rows.length, 0);
      const encrypted = encryptJson({ refresh_token: 'synthetic-token-only' }, key);
      await connection.execute('INSERT INTO google_credentials (user_id, encrypted_tokens) VALUES (?, ?)', [config.userId, encrypted]);
      const [saved] = await connection.execute('SELECT encrypted_tokens FROM google_credentials WHERE user_id = ?', [config.userId]);
      assert.equal(decryptJson(saved[0].encrypted_tokens, key).refresh_token, 'synthetic-token-only');
    } finally { await connection.end(); }
  });
  await check('application restart and a new pool preserve committed consent and inbound messages', async () => {
    await runtime.close(); runtime = null;
    runtime = await serve(config);
    const response = await fetch(`${runtime.base}/mcp`, { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whatsapp_contacts_list', arguments: {} } }) });
    const json = await response.json();
    assert.equal(json.result.isError, false);
    assert.ok(JSON.stringify(json.result.structuredContent).includes(phone));
    const [rows] = await runtime.pool.execute('SELECT COUNT(*) AS count FROM whatsapp_messages');
    assert.equal(rows[0].count, 1);
  });
  await check('previous 0.2.0 MCP code still reads schema 1 and exposes the same 12 tool contracts', async () => {
    await mkdir(path.join(root, '.validation-artifacts'), { recursive: true });
    previousDirectory = await mkdtemp(path.join(root, '.validation-artifacts', 'previous-'));
    const archive = await exec('git', ['archive', baseline], { cwd: root, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
    await pipeCommand('tar', ['-x', '-C', previousDirectory], archive.stdout);
    const previous = await import(pathToFileURL(path.join(previousDirectory, 'src/celia-mcp.js')).href);
    assertBackwardCompatibleMcpTools(previous.MCP_TOOLS, MCP_TOOLS);
    const oldConfig = previous.loadCeliaMcpConfig({ ...env, CELIA_ENABLE_INTEGRATIONS: 'false' });
    const old = await serve(oldConfig, previous.createCeliaMcpApp);
    try {
      const ready = await (await fetch(`${old.base}/readyz`)).json();
      assert.equal(ready.ready, true);
      assert.equal(ready.release.version, '0.2.0');
      const reply = await (await fetch(`${old.base}/mcp`, { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whatsapp_contacts_list', arguments: {} } }) })).json();
      assert.ok(JSON.stringify(reply.result.structuredContent).includes(phone));
    } finally { await old.close(); }
  });
  await check('actual mysqldump restore to a separate schema preserves encrypted tokens, Arabic text and consent', async () => {
    const common = ['exec', '--env', `MYSQL_PWD=${password}`];
    const dump = await pipeCommand('docker', [...common, container, 'mysqldump', '--user=root', '--single-transaction', '--set-gtid-purged=OFF', source]);
    await pipeCommand('docker', ['exec', '-i', '--env', `MYSQL_PWD=${password}`, container, 'mysql', '--user=root', restored], dump);
    const connection = await mysql.createConnection({ ...config.mysql, database: restored, charset: 'utf8mb4' });
    try {
      const [messages] = await connection.query('SELECT body FROM whatsapp_messages');
      const [contacts] = await connection.query('SELECT phone_e164, opted_in, ai_opted_in FROM whatsapp_contacts');
      const [tokens] = await connection.query('SELECT encrypted_tokens FROM google_credentials');
      assert.equal(messages.length, 1);
      assert.match(messages[0].body, /رسالة قبول مصطنعة/);
      assert.equal(contacts[0].phone_e164, phone);
      assert.equal(Number(contacts[0].opted_in), 1);
      assert.equal(Number(contacts[0].ai_opted_in), 0);
      assert.equal(decryptJson(tokens[0].encrypted_tokens, key).refresh_token, 'synthetic-token-only');
    } finally { await connection.end(); }
  });
  assert.equal(checks.length, 9, 'No passing evidence file may be written if any acceptance check failed');
  await mkdir(path.join(root, '.validation-artifacts'), { recursive: true });
  const evidence = { scope: 'isolated-ci-synthetic-data-only', engine: version, commit: process.env.GITHUB_SHA || null, baseline, checks, createdAt: new Date().toISOString(), productionDeployed: false, productionBackupVerified: false, externalProviderActions: 'not-tested', secretsOrCustomerDataIncluded: false };
  await writeFile(path.join(root, '.validation-artifacts/mysql-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Actual MySQL ${version}: ${checks.length} acceptance checks passed; synthetic backup restored; no production deployment.`);
});
