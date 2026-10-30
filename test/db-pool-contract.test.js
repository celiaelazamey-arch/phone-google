import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { createPool } from '../src/db.js';
import { createMysqlDriver } from '../src/agent/drivers.js';

function mysqlPacket(seq, payload) {
  const head = Buffer.alloc(4);
  head.writeUIntLE(payload.length, 0, 3);
  head[3] = seq & 0xff;
  return Buffer.concat([head, payload]);
}

const OK_PACKET = Buffer.from([0x00, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00]);
const EOF_PACKET = Buffer.from([0xfe, 0x00, 0x00, 0x02, 0x00]);

// Minimal param-definition packet (MySQL 4.1 protocol, type VAR_STRING = 0xfd)
function paramDefPacket() {
  const parts = ['def', '', '', '', '?', ''].map((s) => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  const fixed = Buffer.from([
    0x0c, // length of fixed fields
    0x21, 0x00, // charset utf8
    0xff, 0x00, 0x00, 0x00, // column length
    0xfd, // MYSQL_TYPE_VAR_STRING
    0x00, 0x00, // flags
    0x00, // decimals
    0x00, 0x00 // filler
  ]);
  return Buffer.concat([...parts, fixed]);
}

async function startMysqlWireStub({ failPreparedMatch = null } = {}) {
  const events = [];
  let stmtCounter = 0;
  const stmts = new Map();

  const server = net.createServer((socket) => {
    const ver = Buffer.from('8.0.0-crit02-stub\0', 'ascii');
    const threadId = Buffer.alloc(4);
    threadId.writeUInt32LE(1);
    const auth1 = Buffer.alloc(8, 0x41);
    const filler = Buffer.from([0x00]);
    const capLow = Buffer.alloc(2);
    capLow.writeUInt16LE(0xf7ff);
    const charset = Buffer.from([0x21]);
    const status = Buffer.alloc(2);
    status.writeUInt16LE(0x0002);
    const capHigh = Buffer.alloc(2);
    capHigh.writeUInt16LE(0x0008);
    const authLen = Buffer.from([21]);
    const reserved = Buffer.alloc(10, 0);
    const auth2 = Buffer.concat([Buffer.alloc(12, 0x42), Buffer.from([0x00])]);
    const plugin = Buffer.from('mysql_native_password\0', 'ascii');
    socket.write(
      mysqlPacket(
        0,
        Buffer.concat([
          Buffer.from([0x0a]),
          ver,
          threadId,
          auth1,
          filler,
          capLow,
          charset,
          status,
          capHigh,
          authLen,
          reserved,
          auth2,
          plugin
        ])
      )
    );

    let authenticated = false;
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUIntLE(0, 3);
        const seq = buf[3];
        if (buf.length < 4 + len) break;
        const body = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);

        if (!authenticated) {
          authenticated = true;
          socket.write(mysqlPacket(seq + 1, OK_PACKET));
          continue;
        }

        const cmd = body[0];
        if (cmd === 0x01) {
          socket.end();
          return;
        }
        if (cmd === 0x03) {
          const sql = body.subarray(1).toString('utf8');
          events.push(`QUERY:${sql}`);
          socket.write(mysqlPacket(seq + 1, OK_PACKET));
          continue;
        }
        if (cmd === 0x16) {
          const sql = body.subarray(1).toString('utf8');
          const id = ++stmtCounter;
          const numParams = (sql.match(/\?/g) || []).length;
          stmts.set(id, sql);
          events.push(`PREPARE:${sql}`);
          const stmtOk = Buffer.alloc(12);
          stmtOk[0] = 0x00;
          stmtOk.writeUInt32LE(id, 1);
          stmtOk.writeUInt16LE(0, 5); // num_columns = 0
          stmtOk.writeUInt16LE(numParams, 7); // num_params
          let nextSeq = seq + 1;
          const frames = [mysqlPacket(nextSeq++, stmtOk)];
          if (numParams > 0) {
            for (let i = 0; i < numParams; i += 1) {
              frames.push(mysqlPacket(nextSeq++, paramDefPacket()));
            }
            frames.push(mysqlPacket(nextSeq++, EOF_PACKET));
          }
          socket.write(Buffer.concat(frames));
          continue;
        }
        if (cmd === 0x17) {
          const stmtId = body.readUInt32LE(1);
          const sql = stmts.get(stmtId) || '';
          events.push(`EXECUTE:${sql}`);
          if (failPreparedMatch && failPreparedMatch.test(sql)) {
            const msg = Buffer.from('simulated execution failure', 'utf8');
            const errBody = Buffer.concat([Buffer.from([0xff, 0x48, 0x04, 0x23, 0x48, 0x59, 0x30, 0x30, 0x30]), msg]);
            socket.write(mysqlPacket(seq + 1, errBody));
          } else {
            socket.write(mysqlPacket(seq + 1, OK_PACKET));
          }
          continue;
        }
        if (cmd === 0x19) {
          // COM_STMT_CLOSE has no server response packet.
          continue;
        }
        socket.write(mysqlPacket(seq + 1, OK_PACKET));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    events,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test('CRIT-02: createPool() exposes getConnection() so createMysqlDriver(pool).transaction() commits and rolls back on real connections', async () => {
  const stub = await startMysqlWireStub();
  const pool = createPool({
    nodeEnv: 'test',
    userId: 'owner-1',
    ownerEmail: 'owner@example.com',
    ownerPhone: '+201000000000',
    mysql: {
      host: '127.0.0.1',
      port: stub.port,
      user: 'root',
      password: '',
      database: 'celia_test'
    }
  });

  try {
    const driver = createMysqlDriver(pool);
    const result = await driver.transaction(async (tx) => {
      await tx.run('UPDATE agent_runs SET steps_used = ? WHERE id = ?', [2, 'run_1']);
      return 'ok';
    });
    assert.equal(typeof pool.getConnection, 'function', 'createPool wrapper must expose getConnection()');
    assert.equal(result, 'ok');
    assert.ok(stub.events.some((e) => e.startsWith('PREPARE:INSERT INTO app_users')), 'owner row prepared before transaction');
    assert.ok(stub.events.includes('QUERY:START TRANSACTION'), 'real PoolConnection began transaction');
    assert.ok(stub.events.includes('EXECUTE:UPDATE agent_runs SET steps_used = ? WHERE id = ?'), 'statement ran on transaction connection');
    assert.ok(stub.events.includes('QUERY:COMMIT'), 'real PoolConnection committed transaction');

    await assert.rejects(
      () =>
        driver.transaction(async (tx) => {
          await tx.run('DELETE FROM agent_threads WHERE id = ?', ['thr_1']);
          throw new Error('abort_tx');
        }),
      /abort_tx/
    );
    assert.ok(stub.events.includes('QUERY:ROLLBACK'), 'real PoolConnection rolled back failed transaction');
  } finally {
    await pool.end();
    await stub.close();
  }
});

test('CRIT-02 guard: dropping getConnection from a non-memory pool wrapper fails deterministically', async () => {
  const brokenWrapper = {
    isMemory: false,
    execute: async () => [[]],
    query: async () => [[]],
    end: async () => {}
  };
  const driver = createMysqlDriver(brokenWrapper);
  await assert.rejects(
    () => driver.transaction(async () => 'ok'),
    (err) => err instanceof TypeError || /getConnection/i.test(String(err?.message || ''))
  );
});
