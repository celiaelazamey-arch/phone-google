// Shutdown is the last thing that can lose data: active requests must drain, storage must close, and a
// hung server must not keep the process alive forever. Every branch is exercised here without a real signal.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { installShutdown } from '../src/lifecycle.js';

// installShutdown logs one line per signal; this file checks behaviour, not wording.
console.log = () => {};

function harness({ serverClose, poolEnd, graceMs = 50 } = {}) {
  const events = [];
  const server = {
    close: (callback) => {
      events.push('close');
      if (serverClose) serverClose(callback);
      else callback();
    },
    closeAllConnections: () => events.push('closeAllConnections'),
    closeIdleConnections: () => events.push('closeIdleConnections')
  };
  const pool = { end: poolEnd || (async () => events.push('pool.end')) };
  const shutdown = installShutdown({
    server,
    pool,
    operations: { markDraining: () => events.push('draining') },
    graceMs,
    exit: (code) => events.push(`exit:${code}`)
  });
  return { events, shutdown };
}

const cleanup = () => {
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
};

test('shutdown: drains, closes storage, then exits 0 — and only once', async () => {
  try {
    const { events, shutdown } = harness();
    shutdown('SIGTERM');
    await delay(20);
    assert.deepEqual(events, ['draining', 'close', 'pool.end', 'closeIdleConnections', 'exit:0']);
    shutdown('SIGINT');
    await delay(20);
    assert.equal(events.filter((event) => event.startsWith('exit:')).length, 1, 'a second signal must not re-run shutdown');
  } finally {
    cleanup();
  }
});

test('shutdown: a failing storage close is exit 1, never a silent success', async () => {
  try {
    const { events, shutdown } = harness({ poolEnd: async () => { throw new Error('mysql gone'); } });
    shutdown('SIGTERM');
    await delay(20);
    assert.ok(events.includes('exit:1'));
    assert.ok(!events.includes('exit:0'));
  } finally {
    cleanup();
  }
});

test('shutdown: a server that never closes is force-closed after the grace period', async () => {
  try {
    const { events, shutdown } = harness({ serverClose: () => {}, graceMs: 5 });
    shutdown('SIGTERM');
    await delay(40);
    assert.ok(events.includes('closeAllConnections'), 'open connections are cut');
    assert.ok(events.includes('exit:1'), 'forced shutdown is not reported as healthy');
  } finally {
    cleanup();
  }
});

test('shutdown: no operations registry is fine (the hook is optional)', async () => {
  try {
    const events = [];
    const shutdown = installShutdown({
      server: { close: (callback) => callback() },
      pool: { end: async () => events.push('pool.end') },
      graceMs: 50,
      exit: (code) => events.push(`exit:${code}`)
    });
    shutdown('SIGINT');
    await delay(20);
    assert.deepEqual(events, ['pool.end', 'exit:0']);
  } finally {
    cleanup();
  }
});
