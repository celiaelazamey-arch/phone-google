import mysql from 'mysql2/promise';

const OWNER_SQL = 'INSERT INTO app_users (id, email, phone_e164) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email), phone_e164 = VALUES(phone_e164)';

export function createPool(config, { prepareOwner = true } = {}) {
  const raw = mysql.createPool({
    ...config.mysql,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 20,
    connectTimeout: 1500,
    charset: 'utf8mb4',
    timezone: 'Z',
    ssl: config.mysql.ssl ? { ...config.mysql.ssl } : (config.nodeEnv === 'production' ? { minVersion: 'TLSv1.2', rejectUnauthorized: true, verifyIdentity: true } : undefined)
  });
  let prepared;
  const prepare = () => {
    if (!prepared) {
      prepared = raw.execute({ sql: OWNER_SQL, timeout: 3000 }, [config.userId, config.ownerEmail || null, config.ownerPhone || null])
        .catch((error) => { prepared = null; throw error; });
    }
    return prepared;
  };
  const invoke = async (method, sql, params) => {
    try {
      if (prepareOwner) await prepare();
      return await raw[method](typeof sql === 'string' ? { sql, timeout: 3000 } : sql, params);
    } catch (error) { prepared = null; throw error; }
  };
  // No data migration, no memory fallback, bounded queue. Re-prepares after reconnection.
  return {
    isMemory: false,
    execute: (sql, params) => invoke('execute', sql, params),
    query: (sql, params) => invoke('query', sql, params),
    end: () => raw.end()
  };
}

export async function ensureOwner(pool, config) {
  await pool.execute(OWNER_SQL, [config.userId, config.ownerEmail || null, config.ownerPhone || null]);
}
