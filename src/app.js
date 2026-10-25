import express from 'express';
import helmet from 'helmet';
import { createGoogleRouter } from './google.js';
import { createWhatsAppApiRouter, createWhatsAppWebhookRouter } from './whatsapp.js';

export function createApp({ pool, config }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.nodeEnv === 'production' ? 1 : false);
  app.use(helmet());
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // WhatsApp signature validation needs the exact raw request bytes.
  app.use('/webhooks/whatsapp', createWhatsAppWebhookRouter({ pool, config }));
  app.use(express.json({ limit: '256kb' }));
  app.use(createGoogleRouter({ pool, config }));
  app.use(createWhatsAppApiRouter({ pool, config }));
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((error, _req, res, _next) => {
    console.error('Unhandled request error:', error.message);
    res.status(error.status || 500).json({ error: 'internal_error' });
  });
  return app;
}
