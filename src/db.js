import mysql from 'mysql2/promise';

export function createPool(config) {
  return mysql.createPool({
    ...config.mysql,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
    timezone: 'Z',
    ssl: config.nodeEnv === 'production' ? { minVersion: 'TLSv1.2' } : undefined
  });
}

export async function ensureOwner(pool, config) {
  await pool.execute(
    'INSERT INTO app_users (id, email, phone_e164) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email), phone_e164 = VALUES(phone_e164)',
    [config.userId, config.ownerEmail || null, config.ownerPhone]
  );
}
