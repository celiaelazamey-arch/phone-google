import express from 'express';
import { createGoogleRouter } from './google.js';
import { createWhatsAppApiRouter, createWhatsAppWebhookRouter } from './whatsapp.js';
import { createIdempotencyStore } from './idempotency.js';
import { isolatePool } from './resilience.js';

/** Reuse the existing secured REST routers on MCP's port, without intercepting public UI APIs. */
export function createIntegratedApiRouter({ pool, config, services, idempotencyStore = createIdempotencyStore() }) {
  if (pool.isMemory) throw new Error('Full integration routes cannot use demonstration memory');
  const router = express.Router();
  const guardedPool = isolatePool(pool, services);
  const google = createGoogleRouter({ pool: guardedPool, config, services, idempotencyStore });
  const whatsapp = createWhatsAppApiRouter({ pool: guardedPool, config, services, idempotencyStore });
  const json = express.json({ limit: '256kb' });

  // MUST be before JSON parsing: verify the original signed bytes, not reserialized JSON.
  router.use('/webhooks/whatsapp', createWhatsAppWebhookRouter({ pool: guardedPool, config, services }));
  router.use((req, res, next) => {
    const isGoogle = /^\/(?:auth\/google|api\/google)(?:\/|$)/.test(req.path);
    const isWhatsApp = /^\/api\/whatsapp(?:\/|$)/.test(req.path);
    if (!isGoogle && !isWhatsApp) return next();
    json(req, res, (error) => {
      if (error) return next(error);
      return (isGoogle ? google : whatsapp)(req, res, next);
    });
  });
  router.use((error, _req, res, _next) => {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
    return res.status(status).json({ error: status === 503 ? 'integration_unavailable' : 'integration_request_failed' });
  });
  return router;
}
