import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createAgentHost } from '../src/agent/index.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '..');

test('CRIT-04: unawaited boot rejection in createAgentHost does not crash process with ERR_UNHANDLED_REJECTION', async () => {
  const script = `
    import assert from 'node:assert/strict';
    import { createAgentHost } from './src/agent/index.js';
    const host = createAgentHost({
      config: { nodeEnv: 'test' },
      env: { CELIA_AGENT_RUNTIME: 'mysql' },
      pool: null,
      logger: { info() {}, error() {} }
    });
    // Simulate server boot when CELIA_AGENT_RESUME_ON_BOOT=false: nobody awaits host.ready on tick 0.
    await new Promise((r) => setTimeout(r, 40));
    const st = await host.status();
    assert.equal(st.enabled, false);
    assert.equal(st.reason, 'agent_storage_required');
    await assert.rejects(() => host.ready, (err) => err.code === 'agent_storage_required');
  `;

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { cwd: repoRoot, timeout: 10_000 }
  );
  assert.equal(stdout, '');
  assert.equal(stderr.includes('ERR_UNHANDLED_REJECTION'), false);
});

test('CRIT-04: invalid CELIA_AGENT_EGRESS config degrades host.status() cleanly instead of throwing synchronously during createAgentHost()', async () => {
  let host;
  assert.doesNotThrow(() => {
    host = createAgentHost({
      config: { nodeEnv: 'test' },
      env: {
        CELIA_AGENT_RUNTIME: 'sqlite',
        CELIA_AGENT_SQLITE_PATH: ':memory:',
        CELIA_AGENT_EGRESS: 'proxy'
        // Missing CELIA_AGENT_EGRESS_ALLOWLIST
      },
      logger: { info() {}, error() {} }
    });
  });

  const status = await host.status();
  assert.equal(status.enabled, false);
  assert.equal(status.reason, 'agent_egress_allowlist_required');
  await assert.rejects(() => host.ready, (err) => err.code === 'agent_egress_allowlist_required');
});

test('CRIT-04: host.close() shuts down runtime and closes egressProxy listener so event loop exits cleanly', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'celia-crit04-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sqlitePath = path.join(dir, 'agent.sqlite3');

  const host = createAgentHost({
    config: { nodeEnv: 'test' },
    env: {
      NODE_ENV: 'test',
      CELIA_AGENT_RUNTIME: 'sqlite',
      CELIA_AGENT_SQLITE_PATH: sqlitePath,
      CELIA_AGENT_EGRESS: 'proxy',
      CELIA_AGENT_EGRESS_ALLOWLIST: 'https://api.example.com'
    },
    logger: { info() {}, error() {} }
  });

  await host.ready;
  const egressUrl = new URL(host.egress().url);
  const proxyPort = Number(egressUrl.port);
  assert.ok(proxyPort > 0, 'egress proxy bound an ephemeral loopback port');

  assert.equal(typeof host.close, 'function', 'agent host exposes async close()');
  await host.close();

  // Port must now refuse connections because egressProxy.close() closed the server.
  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        const sock = net.connect({ host: '127.0.0.1', port: proxyPort }, () => {
          sock.destroy();
          resolve();
        });
        sock.once('error', reject);
      }),
    (err) => err.code === 'ECONNREFUSED'
  );

  // Also verify a child process exits naturally (code 0, no process.exit) after host.close().
  const childSqlitePath = path.join(dir, 'child-agent.sqlite3');
  const script = `
    import { createAgentHost } from './src/agent/index.js';
    const host = createAgentHost({
      config: { nodeEnv: 'test' },
      env: {
        NODE_ENV: 'test',
        CELIA_AGENT_RUNTIME: 'sqlite',
        CELIA_AGENT_SQLITE_PATH: ${JSON.stringify(childSqlitePath)},
        CELIA_AGENT_EGRESS: 'proxy',
        CELIA_AGENT_EGRESS_ALLOWLIST: 'https://api.example.com'
      },
      logger: { info() {}, error() {} }
    });
    await host.ready;
    await host.close();
  `;
  await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    timeout: 5_000
  });
});
