import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createPool, ensureOwner } from './db.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const pool = createPool(config);
try {
  const schema = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
  for (const statement of schema.split(';').map((part) => part.trim()).filter(Boolean)) {
    await pool.query(statement);
  }
  await ensureOwner(pool, config);
  console.log('Database schema initialized.');
} finally {
  await pool.end();
}
