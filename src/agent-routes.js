import express from 'express';

/**
 * Owner-only HTTP surface for the M1 agent loop (AGENT-001).
 * Every route is behind the caller's existing owner authorization middleware.
 */

const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

function fail(res, error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  return res.status(status).json({ error: error?.code || 'agent_request_failed' });
}

export function createAgentRouter({ agent, authorize, logger = console }) {
  const router = express.Router();
  const json = express.json({ limit: '64kb' });
  router.use(authorize);

  const runtime = async (res) => {
    const status = await agent.status();
    if (!status.enabled) {
      res.status(503).json({ error: status.reason || 'agent_unavailable', mode: status.mode, message: status.message });
      return null;
    }
    try {
      return await agent.get();
    } catch (error) {
      res.status(503).json({ error: error.code || 'agent_unavailable', mode: agent.mode, message: error.message });
      return null;
    }
  };

  router.get('/status', async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await agent.status());
  });

  router.post('/threads', json, async (req, res) => {
    const current = await runtime(res);
    if (!current) return undefined;
    try {
      const title = typeof req.body?.title === 'string' ? req.body.title : '';
      const thread = await current.store.createThread({ ownerId: current.status().ownerId, title });
      return res.status(201).json({ thread });
    } catch (error) {
      return fail(res, error);
    }
  });

  router.get('/threads', async (_req, res, next) => {
    const current = await runtime(res);
    if (!current) return undefined;
    try {
      const threads = await current.store.listThreads(current.status().ownerId);
      return res.json({ threads });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/threads/:id', async (req, res) => {
    const current = await runtime(res);
    if (!current) return undefined;
    try {
      return res.json(await current.threadDetail(req.params.id, current.status().ownerId));
    } catch (error) {
      return fail(res, error);
    }
  });

  router.post('/threads/:id/runs', json, async (req, res) => {
    const current = await runtime(res);
    if (!current) return undefined;
    const headerKey = req.get('idempotency-key');
    const clientMessageId = headerKey || req.body?.clientMessageId || null;
    if (clientMessageId !== null && !CLIENT_ID.test(String(clientMessageId))) {
      return res.status(400).json({ error: 'invalid_client_message_id' });
    }
    try {
      const submitted = await current.submit({
        threadId: req.params.id,
        message: req.body?.message,
        clientMessageId
      });
      if (submitted.run?.status === 'queued' || submitted.run?.status === 'running') {
        current.start(submitted.run.id).catch((error) => logger.error?.('Agent background run failed:', error?.code || 'run_failed'));
      }
      return res.status(submitted.created ? 202 : 200).json({
        runId: submitted.run.id,
        status: submitted.run.status,
        duplicate: submitted.duplicate,
        eventsUrl: `/api/agent/runs/${submitted.run.id}/events`
      });
    } catch (error) {
      return fail(res, error);
    }
  });

  router.get('/runs/:id', async (req, res) => {
    const current = await runtime(res);
    if (!current) return undefined;
    try {
      return res.json(await current.detail(req.params.id, current.status().ownerId));
    } catch (error) {
      return fail(res, error);
    }
  });

  router.get('/runs/:id/events', async (req, res) => {
    const current = await runtime(res);
    if (!current) return undefined;
    let detail;
    try {
      detail = await current.detail(req.params.id, current.status().ownerId);
    } catch (error) {
      return fail(res, error);
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const send = (event) => {
      if (res.writableEnded) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    send({ type: 'snapshot', runId: detail.run.id, at: new Date().toISOString(), ...detail });
    let unsubscribe = () => {};
    let keepAlive;
    const cleanup = () => {
      unsubscribe();
      clearInterval(keepAlive);
      if (!res.writableEnded) res.end();
    };
    unsubscribe = current.subscribe(detail.run.id, (event) => {
      send(event);
      if (event.type === 'run.finished') cleanup();
    });
    keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, 15_000);
    keepAlive.unref?.();
    req.on('close', () => {
      unsubscribe();
      clearInterval(keepAlive);
    });
    if (['succeeded', 'failed', 'cancelled', 'waiting_approval', 'needs_reconciliation', 'budget_exhausted'].includes(detail.run.status)) {
      cleanup();
    }
    return undefined;
  });

  router.post('/runs/:id/cancel', json, async (req, res) => {
    const current = await runtime(res);
    if (!current) return undefined;
    try {
      const run = await current.cancel(req.params.id, current.status().ownerId);
      return res.json({ run });
    } catch (error) {
      return fail(res, error);
    }
  });

  router.use((error, _req, res, _next) => {
    const status = Number.isInteger(error?.status) ? error.status : 400;
    res.status(status).json({ error: status === 400 ? 'invalid_agent_request' : 'agent_request_failed' });
  });

  return router;
}
