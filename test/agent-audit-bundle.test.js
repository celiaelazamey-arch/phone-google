import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createDefaultTools } from '../src/agent/tools.js';
import { createDemoPlanner } from '../src/agent/planner.js';
import { hashOf } from '../src/agent/evidence.js';
import { createAgentRouter } from '../src/agent-routes.js';
import { loadConfig } from '../src/config.js';
import { inspectUnwiredEnvironmentVariables } from '../src/secrets-hub.js';
import { createFakeCalendar, createTempStore } from './support/agent-fixtures.js';

const TOKEN = 'audit-test-owner-token-0000000000000000';

async function startRouterServer(runtime) {
  const app = express();
  const agent = {
    mode: 'sqlite',
    ready: Promise.resolve(runtime),
    async status() {
      return runtime.status();
    },
    async get() {
      return runtime;
    }
  };
  const authorize = (req, res, next) => {
    if (req.get('authorization') !== `Bearer ${TOKEN}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  };
  app.use('/api/agent', createAgentRouter({ agent, authorize }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test('AUDIT-01: exportAuditBundle and GET /api/agent/runs/:id/audit-bundle produce a deterministic SHA-256 signed audit bundle and enforce ownership', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const calendar = createFakeCalendar();
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: createDefaultTools({ statusProvider: () => ({ version: '0.2.1', storage: 'sqlite' }) }),
    planner: createDemoPlanner(),
    connectors: calendar.connectors,
    ownerId: 'owner',
    logger: { error() {} }
  });
  t.after(() => runtime.shutdown().catch(() => {}));

  const server = await startRouterServer(runtime);
  t.after(() => server.close());

  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'خيط التدقيق' });
  const submitted = await runtime.submit({
    threadId: thread.id,
    message: 'استخرج بيانات الفاتورة invoice-valid-1042.csv',
    clientMessageId: 'audit-bundle-run-1'
  });
  await runtime.runToCompletion(submitted.run.id);

  const res = await fetch(`${server.baseUrl}/api/agent/runs/${submitted.run.id}/audit-bundle`, {
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  assert.equal(res.status, 200);
  const bundle = await res.json();
  assert.equal(bundle.capability, 'agent_audit_bundle');
  assert.equal(bundle.schema_version, '1.0');
  assert.equal(bundle.run.id, submitted.run.id);
  assert.equal(bundle.evidenceChain.ok, true);
  assert.equal(bundle.verification.verdict, 'PASS');
  assert.equal(bundle.truthPartition.verified.verdict, 'PASS');
  assert.match(bundle.bundle_sha256, /^[0-9a-f]{64}$/);

  const { exported_at: _exportedAt, bundle_sha256: actualHash, ...canonicalBody } = bundle;
  assert.equal(actualHash, hashOf(canonicalBody), 'bundle_sha256 must match the canonical SHA-256 digest of the bundle body');

  // Non-owner must receive 404:
  await assert.rejects(
    () => runtime.exportAuditBundle(submitted.run.id, 'intruder'),
    (err) => err.status === 404 && err.code === 'run_not_found'
  );
});

test('AUDIT-02: deleteThread and DELETE /api/agent/threads/:id refuse deletion of uncertain work and cleanly cascade-delete completed threads', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const calendar = createFakeCalendar({ failWith: 'ambiguous' });
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: createDefaultTools({ statusProvider: () => ({ version: '0.2.1', storage: 'sqlite' }) }),
    planner: createDemoPlanner(),
    connectors: calendar.connectors,
    ownerId: 'owner',
    logger: { error() {} }
  });
  t.after(() => runtime.shutdown().catch(() => {}));

  const server = await startRouterServer(runtime);
  t.after(() => server.close());

  // 1) A thread with an uncertain outbox (`needs_reconciliation`) refuses deletion with 409:
  const uncertainThread = await fixture.store.createThread({ ownerId: 'owner', title: 'خيط غير محسوم' });
  const sub1 = await runtime.submit({
    threadId: uncertainThread.id,
    message: 'أنشئ موعد مراجعة غدًا',
    clientMessageId: 'del-uncertain-1'
  });
  await runtime.runToCompletion(sub1.run.id);
  await runtime.approve(sub1.run.id, { decision: 'approved', idempotencyKey: 'Approve-Uncertain-1' });
  const afterApprove = await runtime.runToCompletion(sub1.run.id);
  assert.equal(afterApprove.status, 'needs_reconciliation');

  const blockedRes = await fetch(`${server.baseUrl}/api/agent/threads/${uncertainThread.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  assert.equal(blockedRes.status, 409);
  const blockedPayload = await blockedRes.json();
  assert.equal(blockedPayload.error, 'thread_has_active_or_uncertain_work');

  // 2) A completed thread deletes cleanly and removes all child rows:
  const completedThread = await fixture.store.createThread({ ownerId: 'owner', title: 'خيط مكتمل للحذف' });
  const sub2 = await runtime.submit({
    threadId: completedThread.id,
    message: 'جهّز خطة أسبوعية وراجع حالة النظام',
    clientMessageId: 'del-complete-2'
  });
  const fin2 = await runtime.runToCompletion(sub2.run.id);
  assert.equal(fin2.status, 'succeeded');

  // Non-owner cannot delete:
  await assert.rejects(
    () => runtime.deleteThread(completedThread.id, 'intruder'),
    (err) => err.status === 404 && err.code === 'thread_not_found'
  );

  const delRes = await fetch(`${server.baseUrl}/api/agent/threads/${completedThread.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  assert.equal(delRes.status, 200);
  const delPayload = await delRes.json();
  assert.equal(delPayload.deleted, true);
  assert.equal(delPayload.deletedRunsCount, 1);

  assert.equal(await fixture.store.getThread(completedThread.id, 'owner'), null);
  assert.equal(await fixture.store.getRun(sub2.run.id), null);
});

test('AUDIT-03: loadConfig supports PHONE_NUMBER fallback alias and inspectUnwiredEnvironmentVariables reports unwired names without leaking values', () => {
  const key = crypto.randomBytes(32).toString('base64');
  const token = 'a'.repeat(36);
  const cfg = loadConfig({
    APP_API_TOKEN: token,
    TOKEN_ENCRYPTION_KEY: key,
    PHONE_NUMBER: '+201012345678'
  });
  assert.equal(cfg.ownerPhone, '+201012345678');

  const unwiredReport = inspectUnwiredEnvironmentVariables({
    PHONE_NUMBER: '+201012345678',
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'super-secret-r2-value-do-not-leak',
    CELIAOS_CRONJOB_ORG_API_KEY: 'super-secret-cron-value-do-not-leak'
  });
  assert.equal(unwiredReport.phoneAliasUsed, true);
  assert.deepEqual(unwiredReport.presentUnwiredNames, [
    'CELIAOS_CRONJOB_ORG_API_KEY',
    'CLOUDFLARE_R2_SECRET_ACCESS_KEY'
  ]);
  const serialized = JSON.stringify(unwiredReport);
  assert.equal(serialized.includes('super-secret-r2-value-do-not-leak'), false);
  assert.equal(serialized.includes('super-secret-cron-value-do-not-leak'), false);
});
