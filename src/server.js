import 'dotenv/config';
import { loadConfig } from './config.js';
import { createPool, ensureOwner } from './db.js';
import { createApp } from './app.js';
import { installShutdown } from './lifecycle.js';

const config = loadConfig();
const pool = createPool(config);
try { await ensureOwner(pool, config); }
catch { console.error('Storage unavailable at startup; core remains online in degraded mode.'); }
const app = createApp({ pool, config });
const server = app.listen(config.port, '0.0.0.0', () => console.log(`Assistant API listening on port ${config.port}`));

installShutdown({ server, pool, operations: app.locals.operations });
