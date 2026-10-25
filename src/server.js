import 'dotenv/config';
import { loadConfig } from './config.js';
import { createPool, ensureOwner } from './db.js';
import { createApp } from './app.js';

const config = loadConfig();
if (config.whatsapp.autoReplyEnabled && (!config.gemini.apiKey || !config.whatsapp.appSecret || !config.whatsapp.accessToken || !config.whatsapp.phoneNumberId)) {
  throw new Error('Gemini auto-replies require GEMINI_API_KEY and complete WhatsApp Cloud API configuration');
}

const pool = createPool(config);
await pool.query('SELECT 1');
await ensureOwner(pool, config);
const app = createApp({ pool, config });
const server = app.listen(config.port, () => console.log(`Assistant API listening on port ${config.port}`));

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
