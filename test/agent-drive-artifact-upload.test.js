/**
 * M-B/B4 — رفع artifact مبصوم إلى Google Drive المالك خلف بوابة الموافقة القائمة.
 *
 * الجديد في B4 شيئان فقط، وكلاهما داخل العقود القائمة لا بجانبها:
 *   1. مسار `artifactId` في `google.drive_export_report`: البايتات تأتي من مخزن
 *      B2 وتُعاد بصمتها قبل أي طلب — فالملف الذي يصل Drive هو الملف الذي رآه المالك.
 *   2. جسر `resolveArtifact` في موصل Drive، يُركَّب فقط حين يوجد المخزن فعلًا.
 *
 * لا شبكة في أي اختبار: ناقل Drive وهمي يسجل كل نداء، ومخزن SQLite حقيقي.
 * معيار القبول المقاس هنا: بنية واحدة وإرسال واحد؛ و`unknown` للمصالحة لا للإعادة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTempStore } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createArtifactStore } from '../src/agent/artifact-store.js';
import {
  createConnectorRegistry,
  createDriveExportConnector,
  driveMimeForName
} from '../src/agent/connectors.js';
import { createOutbox } from '../src/agent/outbox.js';
import { createToolRegistry, defaultToolDefinitions, RISK } from '../src/agent/tools.js';
import { RUN_STATUS, TOOL_RUN_STATUS } from '../src/agent/store.js';

const SIGNING_KEY = 'artifact-signing-key-for-b4-tests-0123456789abcdef';
const DRIVE_TOOL = 'google.drive_export_report';

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/** ناقل Drive وهمي: يسجل كل محاولة، ويستطيع الفشل عمدًا بطريقة غامضة أو مثبتة. */
function fakeDrive({ failWith = null } = {}) {
  const calls = { create: [], find: [] };
  const files = new Map();
  return {
    calls,
    files,
    transport: {
      async findByOutboxKey({ outboxDigest }) {
        calls.find.push(outboxDigest);
        for (const file of files.values()) {
          if (file.appProperties?.celiaOutboxKey === outboxDigest) return file;
        }
        return null;
      },
      async createFile({ name, mimeType, content, parents, appProperties }) {
        calls.create.push({ name, mimeType, content, parents, appProperties });
        if (failWith === 'ambiguous') throw new Error('socket hang up');
        if (failWith === 'definitive') throw Object.assign(new Error('invalid request'), { status: 400 });
        const created = {
          id: `drv-${calls.create.length}`,
          name,
          mimeType,
          webViewLink: `https://drive.example/file/${calls.create.length}`,
          appProperties
        };
        files.set(created.id, created);
        return created;
      }
    }
  };
}

/** مخطط نصي: قالب B3 ثم رفع ناتجه إلى Drive — نفس مسار المالك الحقيقي. */
function templateUploadPlanner({ repeatAfterSuccess = false } = {}) {
  return {
    name: 'scripted-b4-planner',
    async plan(context) {
      const toolRuns = context.toolRuns || [];
      const rendered = toolRuns.find((run) => run.toolName === 'template.render' && run.status === 'succeeded');
      if (!rendered) {
        return {
          action: 'call',
          tool: 'template.render',
          args: {
            kind: 'markdown_report',
            spec: { title: 'تقرير المبيعات', sections: [{ heading: 'ملخص', body: 'إجمالي **5** عناصر.' }] },
            name: 'report.md'
          },
          reason: 'توليد المخرج حتميًا'
        };
      }
      const exported = toolRuns.find((run) => run.toolName === DRIVE_TOOL && run.status === 'succeeded');
      if (exported && !repeatAfterSuccess) {
        return { action: 'finish', summary: 'رُفع التقرير إلى Drive مرة واحدة.' };
      }
      return {
        action: 'call',
        tool: DRIVE_TOOL,
        args: { artifactId: rendered.parsedOutcome.artifactId },
        reason: 'رفع artifact مبصوم بعد الموافقة'
      };
    }
  };
}

async function makeHarness(t, { failWith = null, planner = templateUploadPlanner() } = {}) {
  const fixture = await createTempStore();
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'celia-b4-drive-'));
  t.after(() => {
    fixture.cleanup();
    rmSync(rootDir, { recursive: true, force: true });
  });
  const drive = fakeDrive({ failWith });
  const artifacts = createArtifactStore({ store: fixture.store, rootDir, signingKey: SIGNING_KEY });
  const connector = createDriveExportConnector({
    transport: drive.transport,
    folderId: 'folder-owner',
    resolveArtifact: (args) => artifacts.readForUpload(args)
  });
  const tools = createToolRegistry(defaultToolDefinitions({ statusProvider: () => ({ ok: true }), artifacts }));
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools,
    planner,
    connectors: createConnectorRegistry([connector]),
    artifacts,
    ownerId: 'owner',
    workerId: 'b4-drive-test',
    limits: { maxSteps: 16, maxCostMicros: 100_000 },
    logger: { error() {} }
  });
  t.after(() => runtime.shutdown().catch(() => {}));
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'B4 Drive upload' });
  const submitted = await runtime.submit({ threadId: thread.id, message: 'حلّل الملف وارفع التقرير إلى Drive' });
  return { fixture, rootDir, drive, artifacts, connector, tools, runtime, run: submitted.run, thread };
}

/** ينشر artifact مباشرة في المخزن (بلا عزل) لتغذية اختبارات الموصل. */
async function publishArtifact(t, { name = 'report.md', content = Buffer.from('# تقرير\n') } = {}) {
  const fixture = await createTempStore();
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'celia-b4-store-'));
  t.after(() => {
    fixture.cleanup();
    rmSync(rootDir, { recursive: true, force: true });
  });
  const artifacts = createArtifactStore({ store: fixture.store, rootDir, signingKey: SIGNING_KEY });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'B4 store' });
  const { run } = await fixture.store.createRun({
    threadId: thread.id,
    ownerId: 'owner',
    planner: 'b4-fixture',
    maxSteps: 4,
    maxCostMicros: 10_000
  });
  const published = await artifacts.publish({
    runId: run.id,
    ownerId: 'owner',
    name,
    content,
    declared: {
      sha256: sha(content),
      bytes: content.length,
      name,
      sourceArtifactId: `tpl-${sha(content).slice(0, 20)}`,
      sandboxRunId: 'fixture-run'
    }
  });
  return { fixture, rootDir, artifacts, record: published.record, content };
}

// ─── 1. العقد: المسار الجديد مشروط بوجود المخزن ولا يغيّر القائم ──────────────

test('B4-01: the artifact path exists only when the store is wired — the legacy contract is byte-for-byte unchanged', () => {
  const legacy = createToolRegistry(defaultToolDefinitions({ statusProvider: () => ({}) }));
  const legacyTool = legacy.get(DRIVE_TOOL);
  assert.deepEqual(Object.keys(legacyTool.arguments), ['title', 'content', 'mimeType']);
  assert.equal(legacyTool.risk, RISK.externalEffect);
  assert.equal(legacyTool.requiresApproval, true);
  assert.equal(legacy.executable(DRIVE_TOOL), false, 'an external effect is never executed in-process');
  // بلا مخزن، تمرير معرّف artifact رفض صريح لا تجاهل.
  assert.equal(
    legacy.validateInput(DRIVE_TOOL, { artifactId: 'abc123' }).code,
    'policy_violation_unknown_argument'
  );

  const withStore = createToolRegistry(
    defaultToolDefinitions({ statusProvider: () => ({}), artifacts: { publish() {}, list() {}, readForUpload() {} } })
  );
  const tool = withStore.get(DRIVE_TOOL);
  assert.deepEqual(Object.keys(tool.arguments), ['title', 'content', 'mimeType', 'artifactId']);
  assert.equal(withStore.validateInput(DRIVE_TOOL, { artifactId: 'a1b2c3' }).ok, true);
  assert.equal(withStore.validateInput(DRIVE_TOOL, { artifactId: '' }).code, 'policy_violation_invalid_drive_artifact_id');
  assert.equal(withStore.validateInput(DRIVE_TOOL, { artifactId: '../etc/passwd' }).code, 'policy_violation_invalid_drive_artifact_id');
  assert.equal(
    withStore.validateInput(DRIVE_TOOL, { artifactId: 'a1', content: '{"x":1}' }).code,
    'policy_violation_drive_artifact_content_conflict'
  );
  assert.equal(withStore.validateInput(DRIVE_TOOL, { artifactId: 'a1', mimeType: 'application/x-msdownload' }).code, 'policy_violation_unsupported_mime_type');
});

// ─── 2. القراءة الداخلية: البصمة تُعاد دائمًا، والتفويض ليس توقيعًا ─────────────

test('B4-02: readForUpload re-hashes on every read and refuses missing, foreign-run and tampered artifacts with explicit codes', async (t) => {
  const { artifacts, record, content, rootDir, fixture } = await publishArtifact(t);

  const read = await artifacts.readForUpload({ id: record.id });
  assert.deepEqual(read.content, content);
  assert.equal(read.sha256, sha(content));

  await assert.rejects(artifacts.readForUpload({ id: 'nope-0000' }), (error) => error.code === 'artifact_not_found');
  await assert.rejects(artifacts.readForUpload({ id: '../escape' }), (error) => error.code === 'artifact_id_invalid');
  await assert.rejects(
    artifacts.readForUpload({ id: record.id, runId: 'another-run' }),
    (error) => error.code === 'artifact_run_mismatch'
  );

  const storagePath = path.join(rootDir, record.id);
  const bytes = readFileSync(storagePath);
  bytes[bytes.length - 1] ^= 0xff;
  writeFileSync(storagePath, bytes);
  await assert.rejects(artifacts.readForUpload({ id: record.id }), (error) => error.code === 'artifact_tampered');
  // ولم تُكتب بايت معبوث في سلسلة الأدلة: لا نشر جديد حدث.
  const evidence = await fixture.store.listEvidence(record.runId);
  assert.equal(evidence.filter((entry) => entry.kind === 'artifact_published').length, 1);
});

// ─── 3. الموصل: البايتات نفسها، نوع من الامتداد، ملف واحد ────────────────────

test('B4-03: an artifact payload uploads the exact approved bytes once, with the MIME derived from the artifact name', async (t) => {
  const { artifacts, record, content } = await publishArtifact(t, { name: 'report.md', content: Buffer.from('# تقرير\nسطر\n') });
  const drive = fakeDrive();
  const connector = createDriveExportConnector({
    transport: drive.transport,
    folderId: 'folder-owner',
    resolveArtifact: (args) => artifacts.readForUpload(args)
  });
  assert.equal(connector.artifactUploads, true);
  assert.equal(driveMimeForName('report.md'), 'text/markdown');
  assert.equal(driveMimeForName('table.csv'), 'text/csv');
  assert.equal(driveMimeForName('page.html'), 'text/html');
  assert.equal(driveMimeForName('archive.bin'), null);

  const result = await connector.send({ artifactId: record.id }, { idempotencyKey: 'outbox:run1:abc123' });
  assert.equal(drive.calls.create.length, 1);
  assert.equal(drive.calls.create[0].content, content.toString('utf8'));
  assert.equal(drive.calls.create[0].mimeType, 'text/markdown');
  assert.equal(drive.calls.create[0].name, 'report.md', 'the artifact name is the default title');
  assert.deepEqual(drive.calls.create[0].parents, ['folder-owner']);
  assert.equal(result.externalRef, 'drv-1');
  assert.equal(result.deduplicated, false);
  assert.equal(result.source.artifactId, record.id);
  assert.equal(result.source.sha256, sha(content));
  assert.equal(result.source.bytes, content.length);

  // إعادة الإرسال بنفس المفتاح: مصالحة بالملف الموجود، لا ملف ثانٍ.
  const replay = await connector.send({ artifactId: record.id }, { idempotencyKey: 'outbox:run1:abc123' });
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.reconciledBy, 'outbox_key');
  assert.equal(drive.calls.create.length, 1);
});

// ─── 4. الرفض قبل الشبكة: مثبت دائمًا، وصفر نداء ────────────────────────────

test('B4-04: a missing, tampered, oversized, binary or untyped artifact is a definitive failure with zero Drive calls', async (t) => {
  const drive = fakeDrive();
  const plain = await publishArtifact(t, { name: 'report.md' });
  const connector = createDriveExportConnector({
    transport: drive.transport,
    resolveArtifact: (args) => plain.artifacts.readForUpload(args)
  });

  await assert.rejects(
    connector.send({ artifactId: 'missing-1' }, { idempotencyKey: 'k-missing' }),
    (error) => error.code === 'artifact_not_found' && error.definitive === true
  );
  await assert.rejects(
    connector.send({ artifactId: 'bad id' }, { idempotencyKey: 'k-bad' }),
    (error) => error.code === 'invalid_drive_artifact_id' && error.definitive === true
  );
  await assert.rejects(
    connector.send({ artifactId: plain.record.id, content: '{}' }, { idempotencyKey: 'k-conflict' }),
    (error) => error.code === 'drive_artifact_content_conflict' && error.definitive === true
  );

  // بايتات غير نصية: تحويلها إلى نص سيكون تحريفًا صامتًا.
  const binary = await publishArtifact(t, { name: 'blob.txt', content: Buffer.from([0xff, 0xfe, 0x41]) });
  const binaryConnector = createDriveExportConnector({
    transport: drive.transport,
    resolveArtifact: (args) => binary.artifacts.readForUpload(args)
  });
  await assert.rejects(
    binaryConnector.send({ artifactId: binary.record.id }, { idempotencyKey: 'k-binary' }),
    (error) => error.code === 'drive_artifact_not_text' && error.definitive === true
  );

  // امتداد بلا نوع معلن: لا تخمين.
  const unknown = await publishArtifact(t, { name: 'bundle.bin', content: Buffer.from('text') });
  const unknownConnector = createDriveExportConnector({
    transport: drive.transport,
    resolveArtifact: (args) => unknown.artifacts.readForUpload(args)
  });
  await assert.rejects(
    unknownConnector.send({ artifactId: unknown.record.id }, { idempotencyKey: 'k-ext' }),
    (error) => error.code === 'unsupported_drive_mime_type' && error.definitive === true
  );

  // الحد الأقصى: بايت واحد فوق السقف يكفي للرفض قبل الشبكة.
  const large = Buffer.alloc(200_001, 0x61);
  const oversized = await publishArtifact(t, { name: 'big.txt', content: large });
  const bigConnector = createDriveExportConnector({
    transport: drive.transport,
    resolveArtifact: (args) => oversized.artifacts.readForUpload(args)
  });
  await assert.rejects(
    bigConnector.send({ artifactId: oversized.record.id }, { idempotencyKey: 'k-big' }),
    (error) => error.code === 'drive_artifact_too_large' && error.definitive === true
  );

  assert.equal(drive.calls.create.length, 0, 'no provider request was ever attempted');
  assert.equal(drive.calls.find.length, 0, 'not even the dedup query ran');
});

// ─── 5. معيار القبول: المهمة الكاملة تمر، وملف واحد يصل ─────────────────────

test('B4-05 (acceptance): template → approval → exactly one Drive file carrying the rendered, hash-attested bytes', async (t) => {
  const { fixture, drive, runtime, run } = await makeHarness(t);

  const parked = await runtime.runToCompletion(run.id);
  assert.equal(parked.status, RUN_STATUS.waitingApproval);
  assert.equal(drive.calls.create.length, 0, 'nothing leaves before the owner decides');

  const detailBefore = await runtime.detail(run.id);
  assert.equal(detailBefore.plan.proposedEffect.toolName, DRIVE_TOOL);
  const pending = detailBefore.outbox.filter((entry) => entry.status === 'pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].connector, 'google.drive');
  assert.equal(typeof pending[0].payload.artifactId, 'string');
  assert.equal(pending[0].payload.content, undefined, 'the approval binds a source, not a text blob');

  await runtime.approve(run.id, { decision: 'approved', idempotencyKey: 'approve-b4-05' });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.succeeded);

  const completed = await runtime.detail(run.id);
  assert.equal(completed.verification.verdict, 'PASS');
  assert.equal(drive.calls.create.length, 1, 'one send, one file');
  assert.deepEqual(drive.calls.create[0].parents, ['folder-owner']);

  // البايتات التي وصلت Drive هي بايتات artifact المنشور حرفيًا.
  const renderRun = (await fixture.store.listToolRuns(run.id)).find((entry) => entry.toolName === 'template.render');
  assert.equal(renderRun.status, TOOL_RUN_STATUS.succeeded);
  const rendered = JSON.parse(renderRun.outcome);
  const listing = await runtime.listRunArtifacts(run.id, 'owner');
  assert.equal(listing.artifacts.length, 1);
  assert.equal(listing.artifacts[0].sha256, rendered.sha256);
  assert.equal(sha(Buffer.from(drive.calls.create[0].content, 'utf8')), rendered.sha256);

  // سلسلة الأدلة سليمة وفيها إرسال واحد مسوّى.
  const chain = await fixture.store.verifyEvidenceChain(run.id);
  assert.equal(chain.ok, true);
  const settled = (await fixture.store.listEvidence(run.id)).filter((entry) => entry.kind === 'external_effect_settled');
  assert.equal(settled.length, 1, 'one settlement entry for one send');
  assert.equal(settled[0].verdict, 'PASS');
  const settledOutbox = completed.outbox.find((entry) => entry.status === 'sent');
  assert.equal(settledOutbox.externalRef, 'drv-1');
  assert.equal(settledOutbox.result.source.sha256, rendered.sha256);
});

// ─── 6. نية واحدة وإرسال واحد تحت التكرار ───────────────────────────────────

test('B4-06: re-entering the loop reuses one intent and one send — the outbox refuses a second live row', async (t) => {
  const { fixture, drive, artifacts, run } = await makeHarness(t);
  const content = Buffer.from('# تقرير واحد\n');
  const published = await artifacts.publish({
    runId: run.id,
    ownerId: 'owner',
    name: 'report.md',
    content,
    declared: {
      sha256: sha(content),
      bytes: content.length,
      name: 'report.md',
      sourceArtifactId: 'tpl-fixed-single-send',
      sandboxRunId: 'fixture-run'
    }
  });
  const outbox = createOutbox({
    store: fixture.store,
    connectors: createConnectorRegistry([
      createDriveExportConnector({ transport: drive.transport, resolveArtifact: (args) => artifacts.readForUpload(args) })
    ])
  });

  const payload = { artifactId: published.record.id };
  const first = await outbox.enqueue({ runId: run.id, toolName: DRIVE_TOOL, connector: 'google.drive', payload });
  const second = await outbox.enqueue({ runId: run.id, toolName: DRIVE_TOOL, connector: 'google.drive', payload });
  assert.equal(first.created, true);
  assert.equal(second.created, false, 'the second intent reuses the live row instead of minting a duplicate');
  assert.equal(second.entry.id, first.entry.id);
  assert.equal(first.entry.idempotencyKey, second.entry.idempotencyKey);
  assert.equal((await fixture.store.listOutbox(run.id)).length, 1);

  const sent = await outbox.dispatch(first.entry.id);
  assert.equal(sent.status, 'sent');
  assert.equal(drive.calls.create.length, 1);

  const again = await outbox.dispatch(first.entry.id);
  assert.equal(again.dispatched, false);
  assert.equal(again.status, 'sent');
  assert.equal(drive.calls.create.length, 1, 'a settled intent never mints a second file');
});

// ─── 7. unknown للمصالحة لا للإعادة ─────────────────────────────────────────

test('B4-07: an ambiguous transport error settles unknown, parks the run for reconciliation and never resends', async (t) => {
  const { fixture, drive, runtime, run } = await makeHarness(t, { failWith: 'ambiguous' });

  const parked = await runtime.runToCompletion(run.id);
  assert.equal(parked.status, RUN_STATUS.waitingApproval);
  await runtime.approve(run.id, { decision: 'approved', idempotencyKey: 'approve-b4-07' });
  const settled = await runtime.runToCompletion(run.id);
  assert.equal(settled.status, RUN_STATUS.needsReconciliation);
  assert.equal(settled.lastError, 'outcome_unknown');
  assert.equal(drive.calls.create.length, 1);

  const entries = await fixture.store.listOutbox(run.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'unknown');
  assert.equal(entries[0].lastError, 'connector_failed');

  // استئناف التشغيل لا يعيد الإرسال: الصف مسوّى unknown وليس pending.
  const resumed = await runtime.runToCompletion(run.id);
  assert.equal(resumed.status, RUN_STATUS.needsReconciliation);
  assert.equal(drive.calls.create.length, 1, 'an unknown outcome is reconciled, never replayed');
});

// ─── 8. العبث بعد الموافقة يُكشف قبل الشبكة ─────────────────────────────────

test('B4-08 (acceptance): tampering after approval is caught by digest before the provider — failed, zero Drive calls', async (t) => {
  const { fixture, drive, runtime, run, rootDir } = await makeHarness(t);

  const parked = await runtime.runToCompletion(run.id);
  assert.equal(parked.status, RUN_STATUS.waitingApproval);
  const renderRun = (await fixture.store.listToolRuns(run.id)).find((entry) => entry.toolName === 'template.render');
  const artifactId = JSON.parse(renderRun.outcome).artifactId;

  // المالك وافق على بصمة محددة؛ ثم تغيّر الملف على القرص.
  const storagePath = path.join(rootDir, artifactId);
  const bytes = readFileSync(storagePath);
  bytes[0] ^= 0xff;
  writeFileSync(storagePath, bytes);

  await runtime.approve(run.id, { decision: 'approved', idempotencyKey: 'approve-b4-08' });
  const finished = await runtime.runToCompletion(run.id);
  assert.equal(finished.status, RUN_STATUS.failed);
  assert.equal(finished.lastError, 'external_effect_failed');
  assert.equal(drive.calls.create.length, 0, 'the changed bytes never reached the provider');

  const [entry] = await fixture.store.listOutbox(run.id);
  assert.equal(entry.status, 'failed');
  assert.equal(entry.lastError, 'artifact_tampered');
  const chain = await fixture.store.verifyEvidenceChain(run.id);
  assert.equal(chain.ok, true);
  const settled = (await fixture.store.listEvidence(run.id)).find((row) => row.kind === 'external_effect_settled');
  assert.equal(settled.verdict, 'BLOCK', 'the evidence chain records a blocked effect, not a failed provider call');
});

// ─── 9. لا جسر = رفض صريح، لا رفع صامت ──────────────────────────────────────

test('B4-09: without the store bridge the artifact path refuses explicitly — inline exports keep working unchanged', async () => {
  const drive = fakeDrive();
  const plain = createDriveExportConnector({ transport: drive.transport });
  assert.equal(plain.artifactUploads, false);
  await assert.rejects(
    plain.send({ artifactId: 'art-1' }, { idempotencyKey: 'k-nobridge' }),
    (error) => error.code === 'drive_artifact_export_unavailable' && error.definitive === true
  );
  assert.equal(drive.calls.create.length, 0);

  const legacy = await plain.send(
    { title: 'تقرير', content: '{"total":5}', mimeType: 'application/json' },
    { idempotencyKey: 'k-inline' }
  );
  assert.equal(legacy.externalRef, 'drv-1');
  assert.equal(legacy.source, undefined, 'inline exports carry no artifact provenance');
});
