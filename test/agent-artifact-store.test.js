/**
 * M-B/B2 — مخزن artifacts المواجه للمالك + أداة `artifact.create` + التنزيل الموقّع.
 *
 * كلها بلا شبكة: منفّذ وهمي يطبق عقد readArtifact (محتوى + بصمة متحققة)، ومخزن
 * SQLite مؤقت حقيقي، وخادم HTTP حقيقي لمسار التنزيل. التكامل الفعلي بالعزل
 * الحقيقي خلف CELIA_SANDBOX_INTEGRATION=1 في ART-09.
 *
 * معيار قبول B2: artifact يظهر للمالك بزر تنزيل، والعبث بالملف بعد التسليم
 * يُكشف بالبصمة ويُرفض — لا بايت معبوث يصل المالك أبدًا.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTempStore } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createToolRegistry, defaultToolDefinitions, RISK } from '../src/agent/tools.js';
import { createArtifactStore } from '../src/agent/artifact-store.js';
import { createAgentRouter } from '../src/agent-routes.js';
import { RUN_STATUS, TOOL_RUN_STATUS } from '../src/agent/store.js';

const SIGNING_KEY = 'artifact-signing-key-for-tests-0123456789abcdef';

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/** منفّذ وهمي: run() يعيد مرجع artifact، وreadArtifact يسلّم المحتوى المبصوم — صفر مضيف. */
function fakeExecutor({ content = Buffer.from('{"total":5}'), name = 'result.json' } = {}) {
  const calls = { run: [], read: [] };
  const digest = sha(content);
  return {
    calls,
    content,
    async run({ runId, code }) {
      calls.run.push({ runId, code });
      return {
        runId,
        sandboxId: 'sb-1',
        status: 'succeeded',
        verdict: 'PASS',
        exitCode: 0,
        reason: null,
        policyHash: 'hash-1',
        network: { mode: 'deny', probe: null },
        artifacts: [{ id: 'art-1', runId, name, bytes: content.length, sha256: digest, uri: 'artifact://art-1', expiresAt: null }]
      };
    },
    async readArtifact({ runId, id }) {
      calls.read.push({ runId, id });
      if (id !== 'art-1') {
        throw Object.assign(new Error('sandbox_artifact_not_found'), { code: 'sandbox_artifact_not_found' });
      }
      return { id, runId, name, bytes: content.length, sha256: digest, uri: 'artifact://art-1', expiresAt: null, content };
    }
  };
}

function scriptedPlanner() {
  return {
    name: 'scripted-artifact-planner',
    async plan(context) {
      const toolRuns = context.toolRuns || [];
      const sandboxRun = toolRuns.find((item) => item.toolName === 'sandbox.exec' && item.status === 'succeeded');
      const published = toolRuns.find((item) => item.toolName === 'artifact.create' && item.status === 'succeeded');
      if (!sandboxRun) {
        return { action: 'call', tool: 'sandbox.exec', args: { code: 'compute' }, reason: 'تنفيذ معزول' };
      }
      if (!published) {
        // كما يفعل مخطط حقيقي: مرجع artifact يُشتق من ناتج التنفيذ المعزول لا من التخمين.
        const artifact = sandboxRun.parsedOutcome?.artifacts?.[0];
        return {
          action: 'call',
          tool: 'artifact.create',
          args: { runId: String(artifact?.runId || ''), id: String(artifact?.id || ''), name: 'report.json' },
          reason: 'نشر الناتج للمالك'
        };
      }
      return { action: 'finish', summary: 'نُشر الملف برابط موقّع وبصمة في السلسلة.' };
    }
  };
}

async function setup(t, { executor, ttlMs = 60_000, clock } = {}) {
  const fixture = await createTempStore();
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'celia-artifact-store-'));
  t.after(() => {
    fixture.cleanup();
    rmSync(rootDir, { recursive: true, force: true });
  });
  const artifacts = createArtifactStore({
    store: fixture.store,
    rootDir,
    signingKey: SIGNING_KEY,
    urlTtlMs: ttlMs,
    ...(clock ? { clock } : {})
  });
  const tools = createToolRegistry(defaultToolDefinitions({
    statusProvider: () => ({ ok: true }),
    sandbox: executor,
    artifacts
  }));
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools,
    planner: scriptedPlanner(),
    artifacts,
    limits: { maxSteps: 16, maxCostMicros: 100_000 },
    workerId: 'artifact-store-test-worker',
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'B2 artifacts' });
  const { run } = await runtime.submit({ threadId: thread.id, message: 'حلّل CSV واكتب تقريرًا' });
  return { fixture, artifacts, tools, runtime, run, rootDir };
}

// ─── سطح الأدوات: الإضافة مشروطة لا تغيّر القائم ────────────────────────────

test('ART-01: artifact.create exists only when both executor and store are wired — the legacy tool surface is untouched', () => {
  const none = createToolRegistry(defaultToolDefinitions({ statusProvider: () => ({}) }));
  assert.equal(none.list().some((tool) => tool.name === 'artifact.create'), false, 'no store, no tool');
  const sandboxOnly = createToolRegistry(defaultToolDefinitions({ statusProvider: () => ({}), sandbox: fakeExecutor() }));
  assert.equal(sandboxOnly.list().some((tool) => tool.name === 'artifact.create'), false, 'executor alone is not enough');

  const { store } = { store: null };
  void store;
  const registry = createToolRegistry(defaultToolDefinitions({
    statusProvider: () => ({}),
    sandbox: fakeExecutor(),
    artifacts: { publish() {}, list() {}, open() {} }
  }));
  const tool = registry.get('artifact.create');
  assert.equal(tool.risk, RISK.internalWrite);
  assert.equal(tool.settledFailures, true);
  assert.equal(registry.executable('artifact.create'), true);
  assert.equal(registry.validateInput('artifact.create', { runId: 'r', id: 'a', name: 'n' }).ok, true);
  assert.equal(registry.validateInput('artifact.create', { runId: 7, id: 'a', name: 'n' }).code, 'policy_violation_argument_type');
});

// ─── معيار قبول B2: الحلقة الكاملة حتى زر التنزيل ────────────────────────────

test('ART-02 (acceptance): full loop — isolated output published, SHA-256 in the evidence chain, bytes served back intact', async (t) => {
  const executor = fakeExecutor();
  const { fixture, artifacts, runtime, run } = await setup(t, { executor });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded);

  const toolRuns = await fixture.store.listToolRuns(run.id);
  const publishRun = toolRuns.find((item) => item.toolName === 'artifact.create');
  assert.equal(publishRun.status, TOOL_RUN_STATUS.succeeded);
  const outcome = JSON.parse(publishRun.outcome);
  assert.equal(outcome.name, 'report.json');
  assert.equal(outcome.sha256, sha(executor.content));
  assert.match(outcome.download.path, /^\/api\/agent\/artifacts\/[0-9a-f-]+\/download\?exp=\d+&sig=[0-9a-f]{64}$/);

  // البصمة دخلت سلسلة الأدلة لحظة النشر، والسلسلة سليمة.
  const evidence = await fixture.store.listEvidence(run.id);
  const published = evidence.find((entry) => entry.kind === 'artifact_published');
  assert.ok(published, 'artifact_published is in the chain');
  const chain = await fixture.store.verifyEvidenceChain(run.id);
  assert.equal(chain.ok, true);

  // القائمة المواجهة للمالك ثم التنزيل الموقّع يعيدان نفس البايتات والبصمة.
  const listing = await runtime.listRunArtifacts(run.id, 'owner');
  assert.equal(listing.enabled, true);
  assert.equal(listing.artifacts.length, 1);
  const url = new URL(`http://x${listing.artifacts[0].download.path}`);
  const { record, content } = await artifacts.open({
    id: url.pathname.split('/')[4],
    exp: url.searchParams.get('exp'),
    sig: url.searchParams.get('sig')
  });
  assert.equal(record.sha256, sha(executor.content));
  assert.deepEqual(content, executor.content);
  assert.deepEqual(JSON.parse(content.toString()), { total: 5 });
});

test('ART-03 (acceptance): tampering with the stored file after delivery is detected by digest and refused', async (t) => {
  const executor = fakeExecutor();
  const { artifacts, runtime, run, rootDir } = await setup(t, { executor });
  await runtime.runToCompletion(run.id);
  const listing = await runtime.listRunArtifacts(run.id, 'owner');
  const url = new URL(`http://x${listing.artifacts[0].download.path}`);
  const params = { id: url.pathname.split('/')[4], exp: url.searchParams.get('exp'), sig: url.searchParams.get('sig') };

  // قبل العبث: التنزيل يمر. بعده: بايت واحد مقلوب كافٍ للرفض بالكود الصريح.
  await artifacts.open(params);
  const storagePath = path.join(rootDir, params.id);
  const bytes = readFileSync(storagePath);
  bytes[0] ^= 0xff;
  writeFileSync(storagePath, bytes);
  await assert.rejects(artifacts.open(params), (error) => error.code === 'artifact_tampered');
});

// ─── الرابط الموقّع: التوقيع هو التفويض كله ──────────────────────────────────

test('ART-04: the signed link refuses forged signatures, foreign ids and elapsed expiries — shape first, existence last', async (t) => {
  let now = 1_000_000;
  const executor = fakeExecutor();
  const { artifacts, runtime, run } = await setup(t, { executor, ttlMs: 5_000, clock: () => now });
  await runtime.runToCompletion(run.id);
  const listing = await runtime.listRunArtifacts(run.id, 'owner');
  const url = new URL(`http://x${listing.artifacts[0].download.path}`);
  const id = url.pathname.split('/')[4];
  const exp = url.searchParams.get('exp');
  const sig = url.searchParams.get('sig');

  await assert.rejects(artifacts.open({ id, exp, sig: 'f'.repeat(64) }), (e) => e.code === 'artifact_signature_invalid');
  await assert.rejects(artifacts.open({ id, exp: String(Number(exp) + 1), sig }), (e) => e.code === 'artifact_signature_invalid', 'a changed expiry breaks the signature');
  await assert.rejects(artifacts.open({ id: crypto.randomUUID(), exp, sig }), (e) => e.code === 'artifact_signature_invalid', 'a signature never transfers to another id');
  await assert.rejects(artifacts.open({ id }), (e) => e.code === 'artifact_signature_invalid', 'missing parameters refuse before anything is looked up');

  now = Number(exp) + 1;
  await assert.rejects(artifacts.open({ id, exp, sig }), (e) => e.code === 'artifact_link_expired');
});

test('ART-05: publication is idempotent by database key — a replay returns the same row, a divergent digest refuses', async (t) => {
  const executor = fakeExecutor();
  const { fixture, artifacts } = await setup(t, { executor });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'idempotency' });
  const { run } = await fixture.store.createRun({
    threadId: thread.id, ownerId: 'owner', planner: 'demo', maxSteps: 4, maxCostMicros: 1000
  });
  const declared = { sha256: sha(executor.content), bytes: executor.content.length, name: 'r.json', sourceArtifactId: 'art-1', sandboxRunId: run.id };
  const first = await artifacts.publish({ runId: run.id, ownerId: 'owner', name: 'r.json', content: executor.content, declared });
  assert.equal(first.replayed, false);
  const replay = await artifacts.publish({ runId: run.id, ownerId: 'owner', name: 'r.json', content: executor.content, declared });
  assert.equal(replay.replayed, true);
  assert.equal(replay.record.id, first.record.id);
  assert.equal((await fixture.store.listArtifacts(run.id)).length, 1, 'one row, not two');

  const other = Buffer.from('{"total":6}');
  await assert.rejects(
    artifacts.publish({ runId: run.id, ownerId: 'owner', name: 'r.json', content: other, declared: { ...declared, sha256: sha(other), bytes: other.length } }),
    (error) => error.code === 'artifact_conflict'
  );
});

test('ART-06: publish refuses bytes that do not match the declared digest — nothing is written', async (t) => {
  const executor = fakeExecutor();
  const { fixture, artifacts } = await setup(t, { executor });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'mismatch' });
  const { run } = await fixture.store.createRun({
    threadId: thread.id, ownerId: 'owner', planner: 'demo', maxSteps: 4, maxCostMicros: 1000
  });
  await assert.rejects(
    artifacts.publish({
      runId: run.id,
      ownerId: 'owner',
      name: 'r.json',
      content: Buffer.from('corrupted-in-transit'),
      declared: { sha256: sha(executor.content), bytes: executor.content.length, name: 'r.json', sourceArtifactId: 'art-1', sandboxRunId: run.id }
    }),
    (error) => error.code === 'artifact_hash_mismatch'
  );
  assert.equal((await fixture.store.listArtifacts(run.id)).length, 0);
});

test('ART-07: boot refuses a weak signing key or an out-of-bounds TTL — loudly, before any URL exists', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  assert.throws(
    () => createArtifactStore({ store: fixture.store, rootDir: '/tmp/x', signingKey: 'short' }),
    (error) => error.code === 'artifact_signing_key_weak'
  );
  assert.throws(
    () => createArtifactStore({ store: fixture.store, rootDir: '/tmp/x', signingKey: SIGNING_KEY, urlTtlMs: 10 }),
    (error) => error.code === 'artifact_url_ttl_outside_bounds'
  );
});

// ─── HTTP: زر التنزيل في /agent يمر من هنا ──────────────────────────────────

test('ART-08: over real HTTP — the signed link downloads the exact bytes, an unsigned request gets 401, tampering gets 409', async (t) => {
  const executor = fakeExecutor();
  const { runtime, run, rootDir } = await setup(t, { executor });
  await runtime.runToCompletion(run.id);

  const TOKEN = 'routes-token-with-at-least-32-characters!';
  const app = express();
  app.use('/api/agent', createAgentRouter({
    agent: { mode: 'sqlite', status: async () => ({ enabled: true, mode: 'sqlite' }), get: async () => runtime },
    authorize: (req, res, next) => {
      if (req.headers.authorization === `Bearer ${TOKEN}`) return next();
      return res.status(401).json({ error: 'unauthorized' });
    }
  }));
  const server = app.listen(0);
  const base = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  // القائمة خلف التوكن؛ وبدونه لا شيء.
  const denied = await fetch(`${base}/api/agent/runs/${run.id}/artifacts`);
  assert.equal(denied.status, 401);
  const listed = await (await fetch(`${base}/api/agent/runs/${run.id}/artifacts`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.equal(listed.enabled, true);
  assert.equal(listed.artifacts.length, 1);
  const downloadPath = listed.artifacts[0].download.path;

  // زر التنزيل: رابط موقّع بلا ترويسة — البايتات والبصمة مطابقتان.
  const download = await fetch(`${base}${downloadPath}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('x-artifact-sha256'), sha(executor.content));
  assert.match(download.headers.get('content-disposition'), /attachment; filename="report\.json"/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), executor.content);

  // بلا توقيع: 401 دون كشف شيء. بتوقيع مزوّر: 401 كذلك.
  const artifactId = downloadPath.split('/')[4];
  assert.equal((await fetch(`${base}/api/agent/artifacts/${artifactId}/download`)).status, 401);
  assert.equal((await fetch(`${base}/api/agent/artifacts/${artifactId}/download?exp=9999999999999&sig=${'e'.repeat(64)}`)).status, 401);

  // العبث بعد التسليم: 409 بالكود الصريح، ولا بايت معبوث يُرسل.
  const storagePath = path.join(rootDir, artifactId);
  const bytes = readFileSync(storagePath);
  bytes[0] ^= 0xff;
  writeFileSync(storagePath, bytes);
  const tampered = await fetch(`${base}${downloadPath}`);
  assert.equal(tampered.status, 409);
  assert.equal((await tampered.json()).error, 'artifact_tampered');
});

// ─── التكامل الحقيقي: عزل فعلي ← نشر ← تنزيل (خلف علم البيئة) ────────────────

test(
  'ART-09 (real integration): actual namespaces sandbox output published and downloaded back byte-identical',
  { skip: process.env.CELIA_SANDBOX_INTEGRATION !== '1' ? 'set CELIA_SANDBOX_INTEGRATION=1 on Linux to run' : false },
  async (t) => {
    const { createSandboxExecutor } = await import('../src/agent/sandbox.js');
    const fixture = await createTempStore();
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'celia-artifact-real-'));
    const artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'celia-sandbox-export-'));
    t.after(() => {
      fixture.cleanup();
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(artifactRoot, { recursive: true, force: true });
    });
    const executor = createSandboxExecutor({ evidenceStore: fixture.store, artifactRoot });
    const artifacts = createArtifactStore({ store: fixture.store, rootDir, signingKey: SIGNING_KEY });
    const tools = createToolRegistry(defaultToolDefinitions({ statusProvider: () => ({ ok: true }), sandbox: executor, artifacts }));
    const runtime = createAgentRuntime({
      store: fixture.store,
      tools,
      planner: {
        name: 'real-artifact-planner',
        async plan(context) {
          const toolRuns = context.toolRuns || [];
          const sandboxRun = toolRuns.find((item) => item.toolName === 'sandbox.exec' && item.status === 'succeeded');
          const published = toolRuns.find((item) => item.toolName === 'artifact.create' && item.status === 'succeeded');
          if (!sandboxRun) {
            const code = 'const rows = `a,2\\nb,3`.split("\\n").map((r) => r.split(","));\n'
              + 'const total = rows.reduce((s, [, n]) => s + Number(n), 0);\n'
              + 'require("fs").writeFileSync("/workspace/artifacts/result.json", JSON.stringify({ total }));';
            return { action: 'call', tool: 'sandbox.exec', args: { code }, reason: 'تنفيذ معزول حقيقي' };
          }
          if (!published) {
            const artifact = sandboxRun.parsedOutcome?.artifacts?.[0];
            return {
              action: 'call',
              tool: 'artifact.create',
              args: { runId: String(artifact?.runId || ''), id: String(artifact?.id || ''), name: 'result.json' },
              reason: 'نشر الناتج'
            };
          }
          return { action: 'finish', summary: 'الناتج الحقيقي منشور ومبصوم.' };
        }
      },
      artifacts,
      limits: { maxSteps: 16, maxCostMicros: 100_000 },
      workerId: 'artifact-real-test-worker',
      logger: { error() {} }
    });
    const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'B2 real' });
    const { run } = await runtime.submit({ threadId: thread.id, message: 'حلّل CSV واكتب تقريرًا' });
    const finished = await runtime.runToCompletion(run.id);
    assert.equal(finished.status, RUN_STATUS.succeeded);

    const listing = await runtime.listRunArtifacts(run.id, 'owner');
    assert.equal(listing.artifacts.length, 1);
    const url = new URL(`http://x${listing.artifacts[0].download.path}`);
    const { content } = await artifacts.open({
      id: url.pathname.split('/')[4],
      exp: url.searchParams.get('exp'),
      sig: url.searchParams.get('sig')
    });
    assert.deepEqual(JSON.parse(content.toString()), { total: 5 }, 'the real isolated computation round-trips to the owner');
    const chain = await fixture.store.verifyEvidenceChain(run.id);
    assert.equal(chain.ok, true);
    const evidence = await fixture.store.listEvidence(run.id);
    assert.ok(evidence.some((entry) => entry.kind === 'artifact_published'));
  }
);
