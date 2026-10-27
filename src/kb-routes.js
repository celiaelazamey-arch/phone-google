import express from 'express';

/**
 * Owner-only HTTP surface for the knowledge network.
 * Remote import is an explicit, disposable-environment admin action and stays off
 * unless `CELIA_KB_ALLOW_REMOTE_IMPORT=true`; deploy-time import is the CLI.
 */

const MAX_QUERY = 500;
const ENTITY_TYPES = new Set(['tool', 'skill', 'project', 'person', 'dataset', 'concept', 'source', 'doc']);

export function createKbRouter({ kb, authorize, env = process.env }) {
  const router = express.Router();
  const json = express.json({ limit: '32kb' });
  router.use(authorize);

  const unavailable = (res, status) =>
    res.status(503).json({
      error: status.reason || 'knowledge_unavailable',
      mode: status.mode,
      required: status.required,
      note: status.note
    });

  const guard = async (res) => {
    const status = await kb.status();
    if (!status.enabled) {
      unavailable(res, status);
      return null;
    }
    return status;
  };

  router.get('/status', async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await kb.status());
  });

  router.post('/search', json, async (req, res) => {
    if (!(await guard(res))) return undefined;
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) return res.status(400).json({ error: 'query_required' });
    if (query.length > MAX_QUERY) return res.status(413).json({ error: 'query_too_long' });
    const limit = Number(req.body?.limit ?? 6);
    const maxChars = Number(req.body?.maxChars ?? 1200);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return res.status(400).json({ error: 'invalid_limit' });
    if (!Number.isInteger(maxChars) || maxChars < 200 || maxChars > 6000) return res.status(400).json({ error: 'invalid_max_chars' });
    try {
      const result = await kb.search({ query, limit, maxChars });
      return res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      return res.status(500).json({ error: 'knowledge_search_failed', message: String(error.message).split(':')[0] });
    }
  });

  router.get('/entities', async (req, res) => {
    if (!(await guard(res))) return undefined;
    const type = String(req.query.type || '').trim();
    if (type && !ENTITY_TYPES.has(type)) return res.status(400).json({ error: 'invalid_entity_type' });
    const limit = Number(req.query.limit ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return res.status(400).json({ error: 'invalid_limit' });
    return res.json({ entities: await kb.entities({ type: type || undefined, limit }) });
  });

  router.get('/entities/:type/:key', async (req, res) => {
    if (!(await guard(res))) return undefined;
    if (!ENTITY_TYPES.has(req.params.type)) return res.status(400).json({ error: 'invalid_entity_type' });
    const detail = await kb.entity(req.params.type, req.params.key);
    if (!detail) return res.status(404).json({ error: 'entity_not_found' });
    return res.json(detail);
  });

  router.get('/stale', async (req, res) => {
    if (!(await guard(res))) return undefined;
    const days = req.query.days === undefined ? undefined : Number(req.query.days);
    if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650)) {
      return res.status(400).json({ error: 'invalid_days' });
    }
    return res.json(await kb.stale(days === undefined ? {} : { days }));
  });

  router.get('/export', async (_req, res) => {
    if (!(await guard(res))) return undefined;
    const body = await kb.exportJsonl();
    res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="celia-knowledge.jsonl"');
    res.set('Cache-Control', 'no-store');
    return res.send(body);
  });

  router.post('/import', json, async (req, res) => {
    if (!(await guard(res))) return undefined;
    if (env.CELIA_KB_ALLOW_REMOTE_IMPORT !== 'true') {
      return res.status(403).json({ error: 'remote_import_disabled', use: 'npm run kb -- import --apply' });
    }
    const dryRun = req.body?.apply !== true;
    try {
      const report = await kb.importDirectory({ dryRun, full: req.body?.full === true });
      return res.json(report);
    } catch (error) {
      return res.status(400).json({ error: String(error.message).split(':')[0] });
    }
  });

  router.use((error, _req, res, _next) => {
    const status = Number.isInteger(error?.status) ? error.status : 400;
    res.status(status).json({ error: status === 400 ? 'invalid_knowledge_request' : 'knowledge_request_failed' });
  });

  return router;
}
