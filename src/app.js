import express from 'express';
import helmet from 'helmet';
import { requireApiToken } from './auth.js';
import { createServiceRegistry, isolatePool } from './resilience.js';
import { createOperations, mountOperations } from './operations.js';
import { createGoogleRouter } from './google.js';
import { createSecretsHubRouter } from './secrets-hub.js';
import { createWhatsAppApiRouter, createWhatsAppWebhookRouter } from './whatsapp.js';
import { createAgentHost } from './agent/index.js';
import { createAgentRouter } from './agent-routes.js';

export function createApp({ pool, config, services = createServiceRegistry(config), agentHost }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.nodeEnv === 'production' ? 1 : false);
  app.use(helmet());
  const operations = createOperations({ pool, config, services });
  const authorize = requireApiToken(config);
  app.locals.services = services;
  app.locals.operations = operations;
  mountOperations(app, { operations, authorize });
  pool = isolatePool(pool, services);

  const agents =
    agentHost ||
    createAgentHost({
      config,
      pool,
      statusProvider: () => operations.liveness()
    });
  app.locals.agentHost = agents;
  app.use('/api/agent', createAgentRouter({ agent: agents, authorize }));

  // WhatsApp signature validation needs the exact raw request bytes.
  app.use('/webhooks/whatsapp', createWhatsAppWebhookRouter({ pool, config, services }));
  app.use(express.json({ limit: '256kb' }));
  app.use(createSecretsHubRouter({ config, services, authorize }));
  app.use(createGoogleRouter({ pool, config, services }));
  app.use(createWhatsAppApiRouter({ pool, config, services }));
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((error, _req, res, _next) => {
    console.error('Unhandled request error:', error.code || 'request_failed');
    res.status(error.status || 500).json({ error: 'internal_error' });
  });
  return app;
}
