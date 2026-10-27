/** Stop accepting work before closing storage; never hide fatal process errors. */
export function installShutdown({
  server,
  pool,
  operations,
  graceMs = 10000,
  exit = (code) => process.exit(code),
}) {
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    operations?.markDraining();
    console.log(`Received ${signal}; draining active requests.`);
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      exit(1);
    }, graceMs);
    timer.unref();
    server.close(async () => {
      try {
        await pool.end();
        clearTimeout(timer);
        exit(0);
      } catch {
        clearTimeout(timer);
        exit(1);
      }
    });
    server.closeIdleConnections?.();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return shutdown;
}
