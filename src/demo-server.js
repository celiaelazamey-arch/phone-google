import 'dotenv/config';
import { createDemoApp } from './demo-app.js';

const { app, config, pool, setLocalOrigin } = await createDemoApp();

const server = app.listen(config.port, '0.0.0.0', () => {
  const { port } = server.address();
  setLocalOrigin(`http://127.0.0.1:${port}`);
  console.log(`FREE DEMO ready on http://0.0.0.0:${port} (no accounts, no secrets, no external calls)`);
  console.log(`Demo bearer token (ephemeral, regenerated on restart): ${config.apiToken}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down demo.`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
