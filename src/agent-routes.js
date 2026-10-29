import express from 'express';
import { runDocumentAutomationBenchmark } from './agent/automation/index.js';

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

  // M-B/B2: التنزيل الموقّع يسبق authorize عمدًا — توقيع HMAC المنتهي الصلاحية هو
  // التفويض الكامل (زر التنزيل في /agent رابط مباشر لا يحمل ترويسة Bearer).
  // بلا توقيع صالح: 401 دون كشف وجود الملف؛ بعد المهلة: 410؛ عبث بالبايتات: 409.
  router.get('/artifacts/:id/download', async (req, res) => {
    const current = await runtime(res);
    if (!current) return undefined;
    try {
      const { record, content } = await current.openArtifactDownload({
        id: req.params.id,
        exp: req.query.exp,
        sig: req.query.sig
      });
      return res
        .set({
          'Cache-Control': 'no-store',
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(record.bytes),
          'Content-Disposition': `attachment; filename="${record.name}"`,
          'X-Artifact-SHA256': record.sha256
        })
        .send(content);
    } catch (error) {
      return fail(res, error);
    }
  });

  router.use(authorize);

  router.get('/status', async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await agent.status());
  });

  // M-C/C1-b: حالة الوصول إلى الويب — الوضع والقائمة وأعداد القرارات.
  // لا رمز منحة ولا ترويسة ولا URL لمضيف غير مسموح في أي رد هنا.
  router.get('/egress', async (_req, res) => {
    if (typeof agent.egress !== 'function') return res.status(404).json({ error: 'agent_egress_unavailable' });
    await runtime(res); // يبقى العقد: 503 حين لا يكون الوكيل ممكنًا أصلًا.
    return res.set('Cache-Control', 'no-store').json(agent.egress());
  });

  router.get('/harness', async (_req, res) => {
    const current = await runtime(res);
    if (!current) return undefined;
    return res.set('Cache-Control', 'no-store').json(current.harness());
  });

  router.get('/metrics', async (_req, res) => {
    const current = await runtime(res);
    if (!current) return undefined;
    try {
      const report = await current.metrics(current.status().ownerId);
      return res.set('Cache-Control', 'no-store').json(report);
    } catch (error) {
      return fail(res, error);
    }
  });

  router.get('/benchmark', async (_req, res) => {
    try {
      return res.set('Cache-Control', 'no-store').json(await runDocumentAutomationBenchmark());
    } catch (error) {
      return fail(res, error);
    }
  });

  // WP-2.3: owner-only, non-vector memory. Expired rows are hidden by default.
  router.get('/memory', async (req, res) => {
    const current = await runtime(res);
    if (!current) return undefined;
    try {
      const queryKind = req.query.kind || req.query.type;
      const queryId = req.query.id || req.query.memoryId;
      if (queryId || queryKind) {
        if (!queryId || !queryKind) return res.status(400).json({ error: 'memory_kind_and_id_required' });
        const item = await current.memoryItem(queryKind, queryId, current.status().ownerId, {
          includeExpired: req.query.includeExpired === 'true'
        });
        return res.set('Cache-Control', 'no-store').json(item);
      }
      const memory = await current.memory(current.status().ownerId, {
        threadId: typeof req.query.threadId === 'string' && req.query.threadId ? req.query.threadId : null,
        includeExpired: req.query.includeExpired === 'true'
      });
      return res.set('Cache-Control', 'no-store').json(memory);
    } catch (error) {
      return fail(res, error);
    }
  });

  // DELETE /api/agent/memory accepts { kind: 'summary'|'fact', id } (or query
  // parameters), and never falls back to an owner-independent lookup.
  router.delete('/memory', json, async (req, res) => {
    const current = await runtime(res);
    if (!current) return undefined;
    try {
      const kind = req.body?.kind || req.body?.type || req.query.kind || req.query.type;
      const id = req.body?.id || req.body?.memoryId || req.query.id || req.query.memoryId;
      const result = await current.deleteMemory(kind, id, current.status().ownerId);
      return res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      return fail(res, error);
    }
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

  router.delete('/threads/:id', async (req, res) => {
    const current = await runtime(res);
    if (!current) return undefined;
    try {
      return res.json(await current.deleteThread(req.params.id, current.status().ownerId));
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

  // M-B/B2: قائمة artifacts التشغيل خلف نفس ملكية detail؛ كل استدعاء يوقّع
  // روابط تنزيل جديدة بمهلة صريحة.
  router.get('/runs/:id/artifacts', async (req, res) => {
    const current = await runtime(res);
    if (!current) return undefined;
    try {
      return res.set('Cache-Control', 'no-store').json(await current.listRunArtifacts(req.params.id, current.status().ownerId));
    } catch (error) {
      return fail(res, error);
    }
  });

  router.get('/runs/:id/audit-bundle', async (req, res) => {
    const current = await runtime(res);
    if (!current) return undefined;
    try {
      const bundle = await current.exportAuditBundle(req.params.id, current.status().ownerId);
      return res.set('Cache-Control', 'no-store').json(bundle);
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

  // Durable intents for external effects: pending/approved payloads, sent references
  // and honest `unknown` settlements. Read-only; sending happens only inside the run.
  router.get('/runs/:id/outbox', async (req, res) => {
    const current = await runtime(res);
    if (!current) return undefined;
    try {
      const detail = await current.detail(req.params.id, current.status().ownerId);
      return res.json({ outbox: detail.outbox });
    } catch (error) {
      return fail(res, error);
    }
  });

  // Owner resolution of an `unknown` outcome — the exit from needs_reconciliation.
  // Bookkeeping only: no connector is called and nothing is re-sent.
  router.post('/runs/:id/reconcile', json, async (req, res) => {
    const current = await runtime(res);
    if (!current) return undefined;
    const target = String(req.body?.target || '').trim();
    if (!['tool_run', 'outbox'].includes(target)) {
      return res.status(400).json({ error: 'invalid_reconcile_target' });
    }
    const outcome = String(req.body?.outcome || '').trim().toLowerCase();
    if (!['applied', 'not_applied'].includes(outcome)) {
      return res.status(400).json({ error: 'invalid_reconcile_outcome' });
    }
    const targetId = typeof req.body?.targetId === 'string' ? req.body.targetId.trim() : '';
    if (!targetId) return res.status(400).json({ error: 'reconcile_target_required' });
    const headerKey = req.get('idempotency-key');
    const idempotencyKey = headerKey || req.body?.idempotencyKey || null;
    if (idempotencyKey !== null && !CLIENT_ID.test(String(idempotencyKey))) {
      return res.status(400).json({ error: 'invalid_client_message_id' });
    }
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null;
    const externalRef = typeof req.body?.externalRef === 'string' ? req.body.externalRef : null;
    try {
      const result = await current.reconcile(
        req.params.id,
        { target, targetId, outcome, externalRef, note, idempotencyKey, resume: req.body?.resume === true },
        current.status().ownerId
      );
      return res.json(result);
    } catch (error) {
      return fail(res, error);
    }
  });

  router.get('/runs/:id/approvals', async (req, res) => {
    const current = await runtime(res);
    if (!current) return undefined;
    try {
      const detail = await current.detail(req.params.id, current.status().ownerId);
      return res.json({ approvals: detail.approvals, plan: detail.plan });
    } catch (error) {
      return fail(res, error);
    }
  });

  router.get('/runs/:id/plan', async (req, res) => {
    const current = await runtime(res);
    if (!current) return undefined;
    try {
      const detail = await current.detail(req.params.id, current.status().ownerId);
      return res.json({ plan: detail.plan, approvals: detail.approvals, outbox: detail.outbox });
    } catch (error) {
      return fail(res, error);
    }
  });

  router.post('/runs/:id/plan', json, async (req, res) => {
    const current = await runtime(res);
    if (!current) return undefined;
    const headerKey = req.get('idempotency-key');
    const idempotencyKey = headerKey || req.body?.idempotencyKey || null;
    if (idempotencyKey !== null && !CLIENT_ID.test(String(idempotencyKey))) {
      return res.status(400).json({ error: 'invalid_client_message_id' });
    }
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null;
    try {
      const result = await current.editPlan(
        req.params.id,
        {
          payload: req.body?.payload ?? null,
          summary: req.body?.summary ?? null,
          note,
          idempotencyKey
        },
        current.status().ownerId
      );
      return res.json(result);
    } catch (error) {
      return fail(res, error);
    }
  });

  // Owner decision on a parked run. Idempotent via Idempotency-Key or body key.
  // Supports `approved`, `rejected`, and `edited` (updates the plan, re-validates
  // policies, and returns the run to waiting_approval for review).
  // A run with an unresolved (`unknown`/`started`) tool call is refused with 409
  // reconciliation_required: approval must never replay an uncertain call.
  router.post('/runs/:id/approval', json, async (req, res) => {
    const current = await runtime(res);
    if (!current) return undefined;
    const decision = String(req.body?.decision || '').trim().toLowerCase();
    if (!['approved', 'rejected', 'edited'].includes(decision)) {
      return res.status(400).json({ error: 'invalid_approval_decision' });
    }
    const headerKey = req.get('idempotency-key');
    const idempotencyKey = headerKey || req.body?.idempotencyKey || null;
    if (idempotencyKey !== null && !CLIENT_ID.test(String(idempotencyKey))) {
      return res.status(400).json({ error: 'invalid_client_message_id' });
    }
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null;
    try {
      const result = await current.approve(
        req.params.id,
        {
          decision,
          payload: req.body?.payload ?? null,
          summary: req.body?.summary ?? null,
          note,
          idempotencyKey
        },
        current.status().ownerId
      );
      return res.json(result);
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
