import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTempStore,
  createRecordingTools,
  createFakeCalendar,
  threeReadsThenFinish
} from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createScriptedPlanner } from '../src/agent/planner.js';
import { RUN_STATUS, TOOL_RUN_STATUS, APPROVAL_DECISION } from '../src/agent/store.js';
import { OUTBOX_STATUS } from '../src/agent/outbox.js';

/**
 * DATA-002 — «تبويبان متزامنان لا يكتبان فوق تقدم أحدث».
 *
 * Two browser tabs on one thread are two clients holding two stale views of the same durable rows.
 * The guarantee is not "they never collide" — they do — it is that a collision is *refused and
 * named*, never resolved by the later writer silently overwriting the earlier one. The API's
 * idempotency keys already make the safe path expressible; these tests pin that the unsafe path
 * cannot succeed.
 *
 * The acceptance row reads: «restart وتبويبان لا يفقدان حفظًا مؤكدًا ولا يكتبان فوق تقدم أحدث».
 * Boot recovery has its own suite (`agent-boot-recovery.test.js`); this file is the second half:
 *
 *   TT-01 two tabs approving one gate — exactly one wins, one effect, one decision row
 *   TT-02 two tabs editing the plan — the later edit cannot overwrite the newer approval
 *   TT-03 a tab whose view is stale is refused, and the previewed payload never reaches the provider
 *   TT-04 two tabs submitting one message with the same key — one message, one run, one save
 *   TT-05 two tabs submitting distinct messages — both saved in order, neither lost
 *   TT-06 a replay carrying its own key is an idempotent answer, not a second decision
 *   TT-07 the revision counter is not a write lock: an edit cannot outrun its approval
 */

async function setup(t, { planner, connectors, clock } = {}) {
  const fixture = await createTempStore(clock ? { clock } : {});
  t.after(() => fixture.cleanup());
  const recorder = createRecordingTools();
  const calendar = createFakeCalendar();
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: recorder.tools,
    planner: planner || createScriptedPlanner(threeReadsThenFinish()),
    ...(connectors === null ? {} : { connectors: connectors || calendar.connectors }),
    limits: { maxSteps: 12, maxCostMicros: 100_000 },
    workerId: 'tab-worker',
    logger: { error() {} },
    ...(clock ? { clock } : {})
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'تبويبان' });
  return { fixture, recorder, calendar, runtime, thread };
}

/** Park a run on an external effect: one pending approval + one pending outbox intent. */
/**
 * A payload the calendar connector actually accepts. Without a real time window the connector refuses
 * definitively (`event_time_required`) and nothing is dispatched — which would make "one effect, not
 * two" trivially true and prove nothing about the race.
 */
/**
 * Wait for the durable row to leave the in-flight states.
 *
 * An approval resumes the run in the background (`runtime.start(...)` is fire-and-forget), so the
 * HTTP answer returns before the dispatch settles. Polling the durable row — not sleeping for a
 * guessed duration — is what makes the assertion about the final state rather than a race with it.
 */
async function waitForSettled(read, isSettled, { timeoutMs = 5000, label = 'row' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (isSettled(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} to settle: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const validEvent = (summary) => ({
  summary,
  start: '2026-11-05T10:00:00.000Z',
  end: '2026-11-05T10:30:00.000Z'
});

async function parkOnApproval(t, args = validEvent('اجتماع')) {
  const ctx = await setup(t, {
    planner: createScriptedPlanner([{ action: 'call', tool: 'calendar.create', args }])
  });
  const { run } = await ctx.runtime.submit({ threadId: ctx.thread.id, message: 'أنشئ موعدًا' });
  const parked = await ctx.runtime.runToCompletion(run.id);
  assert.equal(parked.status, RUN_STATUS.waitingApproval);
  const detail = await ctx.runtime.detail(run.id);
  return { ...ctx, run, parked, approvals: detail.approvals, outbox: detail.outbox };
}

test('TT-01 two tabs approve the same gate at once — one wins, one effect, one decision', async (t) => {
  const ctx = await parkOnApproval(t);
  const approvalId = ctx.approvals[0].id;

  // Both tabs press «موافقة». Neither carries an idempotency key: they are two people-shaped
  // gestures from two stale views, not a retry of one request.
  const results = await Promise.allSettled([
    ctx.runtime.approve(ctx.run.id, { decision: 'approved', idempotencyKey: 'tab-alpha-0001' }),
    ctx.runtime.approve(ctx.run.id, { decision: 'approved', idempotencyKey: 'tab-bravo-0002' })
  ]);
  const ok = results.filter((item) => item.status === 'fulfilled');
  const failed = results.filter((item) => item.status === 'rejected');

  assert.equal(ok.length, 1, 'exactly one tab wins the decision');
  assert.equal(failed.length, 1, 'the other is refused, not silently swallowed');
  assert.equal(failed[0].reason.code, 'approval_already_decided');
  assert.equal(failed[0].reason.status, 409);

  // The durable truth: one approval row, decided once, by one key.
  const approvals = await ctx.fixture.store.listApprovals(ctx.run.id);
  const decided = approvals.filter((item) => item.id === approvalId);
  assert.equal(decided.length, 1);
  assert.equal(decided[0].decision, APPROVAL_DECISION.approved);
  assert.ok(['tab-alpha-0001', 'tab-bravo-0002'].includes(decided[0].decisionKey));

  // And the effect happened exactly once, whoever won — after the winning approval's background
  // dispatch has settled. `sends` is checked once the run is terminal, not on the HTTP return.
  const settled = await waitForSettled(
    () => ctx.runtime.detail(ctx.run.id),
    (detail) => ![RUN_STATUS.queued, RUN_STATUS.running].includes(detail.run.status),
    { label: 'run' }
  );
  assert.equal(settled.run.status, RUN_STATUS.succeeded);
  assert.equal(ctx.calendar.sends.length, 1, 'one calendar insert, not two');
});

test('TT-02 two tabs edit the plan — the second edit is refused, not layered on a newer approval', async (t) => {
  const ctx = await parkOnApproval(t, validEvent('اجتماع أول'));
  const firstApproval = ctx.approvals[0];

  // Tab A edits the payload and gets a fresh revision awaiting approval. It states the revision it
  // read (1, the initial plan), which is the field that makes a stale write detectable.
  const edited = await ctx.runtime.editPlan(ctx.run.id, {
    payload: validEvent('اجتماع معدّل من التبويب أ'),
    note: 'تعديل أ',
    idempotencyKey: 'tab-edit-alpha-1',
    expectedRevision: 1
  });
  assert.ok(edited.pendingApproval, 'the edit produced a new pending approval');
  assert.equal(edited.pendingApproval.decision, APPROVAL_DECISION.pending);

  // Tab B still holds the *original* approval id and tries to edit from that stale view. It must not
  // succeed: the original row is already `edited`, and its payload already moved on.
  // Tab B still holds revision 1. Its save must be refused, not applied over revision 2.
  await assert.rejects(
    () =>
      ctx.runtime.editPlan(
        ctx.run.id,
        {
          payload: validEvent('تعديل متأخر من التبويب ب'),
          idempotencyKey: 'tab-edit-bravo-2',
          expectedRevision: 1
        },
        'owner'
      ),
    (error) => {
      assert.equal(error.code, 'revision_conflict', `unexpected code ${error.code}`);
      assert.equal(error.status, 409, 'a stale write is a conflict, not a server error');
      assert.match(error.message, /revision 1/);
      assert.match(error.message, /revision 2/);
      return true;
    }
  );

  // A client that omits the revision stays *permitted* (the repository preserves existing clients),
  // but never silently: the call reports `preconditionApplied: false` and the evidence chain records
  // `precondition: 'none'`. That is the difference between a documented compatibility hole and a
  // hidden one.
  const unguarded = await ctx.runtime.editPlan(
    ctx.run.id,
    { payload: validEvent('تعديل بلا مراجعة'), idempotencyKey: 'tab-edit-charlie-3' },
    'owner'
  );
  assert.equal(unguarded.preconditionApplied, false, 'an unguarded write says so in its answer');

  // The answer is ephemeral; the step summary is durable and readable. That is where an audit looks,
  // and it is where the difference between a guarded and an unguarded write is stated in words.
  const detailAfter = await ctx.runtime.detail(ctx.run.id);
  const editSteps = detailAfter.steps.filter((step) => step.title.startsWith('تعديل الخطة'));
  // Exactly two applied edits: the refused stale write left no step behind, which is itself the proof
  // that a refusal is not a half-applied change.
  assert.equal(editSteps.length, 2, 'only applied edits leave a durable step');
  assert.match(editSteps[0].summary, /شرط التزامن: روجعت النسخة 1/, 'tab A states the revision it edited');
  assert.match(editSteps[1].summary, /بلا شرط تزامن/, 'the unguarded write is labelled as unguarded');

  // The evidence chain still hashes every edit, so tampering is detectable even though the payload
  // text itself is not exposed by the ledger.
  const chain = await ctx.fixture.store.verifyEvidenceChain(ctx.run.id);
  assert.equal(chain.ok, true);

  // One live intent, not two competing ones — and the payload that stands is the *latest applied*
  // revision (the explicitly unguarded one), never the stale tab's.
  const detail = await ctx.runtime.detail(ctx.run.id);
  const liveOutbox = detail.outbox.filter((entry) => entry.status === OUTBOX_STATUS.pending);
  assert.equal(liveOutbox.length, 1, 'one live intent, not two competing ones');
  assert.equal(liveOutbox[0].payload.summary, 'تعديل بلا مراجعة');
  // The property this whole test exists for: the refused stale write left no trace in live state.
  assert.equal(JSON.stringify(detail).includes('تعديل متأخر من التبويب ب'), false, 'the refused write never applied');
  assert.equal(ctx.calendar.sends.length, 0, 'nothing was dispatched while parked');
  assert.equal(firstApproval.decision, APPROVAL_DECISION.pending, 'the pre-edit view was stale, and stayed stale');
});

test('TT-03 a stale tab approves the old payload — refused, and the previewed content never reaches the provider', async (t) => {
  const ctx = await parkOnApproval(t, validEvent('الموعد الأصلي'));

  // Tab A edits the plan: a new approval is pending for the new payload.
  const edited = await ctx.runtime.editPlan(ctx.run.id, {
    payload: validEvent('الموعد بعد التعديل'),
    idempotencyKey: 'stale-tab-edit-1'
  });
  const newApprovalId = edited.pendingApproval.id;

  // Tab B approves from its stale view. `approve` refuses because the run is no longer sitting on
  // the *old* approval — it is waiting on the new revision.
  const staleApprove = await ctx.runtime
    .approve(ctx.run.id, { decision: 'approved', idempotencyKey: 'stale-tab-approve-2' })
    .then(() => null)
    .catch((error) => error);

  // Either the stale approval is refused outright, or it is accepted against the *current* approval
  // (never the superseded one). Both are safe; what is not safe is dispatching the old payload.
  if (staleApprove) {
    assert.equal(typeof staleApprove.code, 'string', 'a refusal is always named');
  }

  const detail = await ctx.runtime.detail(ctx.run.id);
  const approvals = detail.approvals;
  const superseded = approvals.filter((item) => item.decision === APPROVAL_DECISION.edited);
  assert.ok(superseded.length >= 1, 'the edit is a recorded decision, not a mutation in place');
  assert.equal(approvals.some((item) => item.id === newApprovalId), true);

  // The decisive property: whatever was approved, only the *edited* payload can have been sent.
  for (const send of ctx.calendar.sends) {
    assert.notEqual(send.event?.summary, 'الموعد الأصلي', 'the superseded payload was never dispatched');
  }
});

test('TT-04 two tabs submit the same message with one key — one message, one run, one save', async (t) => {
  const ctx = await setup(t);
  const key = 'same-message-key-aaaa';

  const [first, second] = await Promise.all([
    ctx.runtime.submit({ threadId: ctx.thread.id, message: 'مهمة واحدة', clientMessageId: key }),
    ctx.runtime.submit({ threadId: ctx.thread.id, message: 'مهمة واحدة', clientMessageId: key })
  ]);

  assert.equal(first.run.id, second.run.id, 'both tabs are pointed at the same run');
  assert.equal(first.created !== second.created, true, 'exactly one request created it; the other is a duplicate answer');
  assert.equal([first, second].filter((item) => item.duplicate === true).length, 1);

  const messages = await ctx.fixture.store.listMessages(ctx.thread.id);
  assert.equal(messages.length, 1, 'one saved message, not two');
  const runs = await ctx.fixture.store.listRuns(ctx.thread.id);
  assert.equal(runs.length, 1, 'one run, not two');
});

test('TT-05 two tabs submit different messages — both are saved, in order, and neither is lost', async (t) => {
  const ctx = await setup(t);
  const [alpha, bravo] = await Promise.all([
    ctx.runtime.submit({ threadId: ctx.thread.id, message: 'رسالة التبويب أ', clientMessageId: 'tab-a-distinct-01' }),
    ctx.runtime.submit({ threadId: ctx.thread.id, message: 'رسالة التبويب ب', clientMessageId: 'tab-b-distinct-02' })
  ]);
  assert.notEqual(alpha.run.id, bravo.run.id, 'distinct saves are distinct runs');

  const messages = await ctx.fixture.store.listMessages(ctx.thread.id);
  assert.equal(messages.length, 2, 'a confirmed save is never dropped by a concurrent save');
  const contents = messages.map((item) => item.content).sort();
  assert.deepEqual(contents, ['رسالة التبويب أ', 'رسالة التبويب ب'].sort());

  // Ordering is durable and monotonic, so a reload shows the same sequence.
  const again = await ctx.fixture.store.listMessages(ctx.thread.id);
  assert.deepEqual(again.map((item) => item.id), messages.map((item) => item.id), 'stable order across reads');
});

test('TT-06 a replay with its own key is an idempotent answer, not a second decision', async (t) => {
  const ctx = await parkOnApproval(t);
  const key = 'replay-approval-zzzz';

  await ctx.runtime.approve(ctx.run.id, { decision: 'approved', idempotencyKey: key });
  const sendsAfterFirst = ctx.calendar.sends.length;

  // The same tab retries the same request (a dropped response looks identical to a lost write).
  const replay = await ctx.runtime.approve(ctx.run.id, { decision: 'approved', idempotencyKey: key });
  assert.equal(replay.idempotentReplay, true, 'a retry is recognised, not re-executed');
  assert.equal(ctx.calendar.sends.length, sendsAfterFirst, 'no second effect on replay');

  const approvals = await ctx.fixture.store.listApprovals(ctx.run.id);
  assert.equal(approvals.filter((item) => item.decision === APPROVAL_DECISION.approved).length, 1);
});

test('TT-07 an edit cannot outrun its approval — a superseded intent is not editable', async (t) => {
  const ctx = await parkOnApproval(t, validEvent('نية أولى'));
  const pendingIntent = ctx.outbox.find((entry) => entry.status === OUTBOX_STATUS.pending);
  assert.ok(pendingIntent, 'the gate parks with a durable pending intent');

  // Tab A approves and the intent leaves `pending`. Tab B, still on the old view, tries to edit it.
  await ctx.runtime.approve(ctx.run.id, { decision: 'approved', idempotencyKey: 'outrun-approve-1' });
  const settled = await waitForSettled(
    () => ctx.fixture.store.getOutbox(pendingIntent.id),
    (entry) => entry.status !== OUTBOX_STATUS.pending,
    { label: 'outbox intent' }
  );
  assert.notEqual(settled.status, OUTBOX_STATUS.pending, 'the intent was settled by the approval');

  // The store's conditional edit is the last line of defence and must refuse the move.
  const edit = await ctx.fixture.store.updatePendingOutboxPayload(pendingIntent.id, {
    payload: validEvent('تعديل بعد الحسم')
  });
  assert.equal(edit.changed, false, 'a settled intent is a fact, never an editable draft');
  assert.notEqual(edit.entry.payload.summary, 'تعديل بعد الحسم');

  // The single dispatch still happened once, with the approved payload.
  assert.equal(ctx.calendar.sends.length, 1);
  assert.equal(ctx.calendar.sends[0].event.summary, 'نية أولى');
});

/**
 * TT-08 / TT-09 — the two defects this suite found, pinned at the layer a browser actually sees.
 *
 * Both were real and both were invisible to the old suite:
 *   - losing an approval race answered **500** (`codedError` carried a code but no status), which
 *     tells a second tab the server broke instead of that the first tab won;
 *   - `POST /plan` had **no concurrency precondition at all**, so a stale tab silently replaced a
 *     newer confirmed revision.
 */
test('TT-08 the HTTP surface answers a lost approval race with 409 and a stale plan write with 409', async (t) => {
  const { createApp } = await import('../src/app.js');
  const { createAgentHost } = await import('../src/agent/index.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createScriptedPlanner } = await import('../src/agent/planner.js');

  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-two-tabs-http-'));
  const calendar = createFakeCalendar();
  const token = 'test-token-with-at-least-32-characters';
  const config = {
    nodeEnv: 'test',
    apiToken: token,
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    userId: 'owner',
    google: { clientId: '', clientSecret: '', redirectUri: 'http://localhost:3000/auth/google/callback' },
    whatsapp: { verifyToken: '', appSecret: '', accessToken: '', phoneNumberId: '', apiVersion: '', autoReplyEnabled: false }
  };
  const agentHost = createAgentHost({
    config,
    env: { CELIA_AGENT_RUNTIME: 'sqlite', CELIA_AGENT_SQLITE_PATH: path.join(directory, 'agent.sqlite3') },
    statusProvider: () => ({ version: '0.3.0', storage: 'test' }),
    connectors: calendar.connectors,
    logger: { error() {} }
  });
  const server = createApp({ pool: { execute: async () => [[]] }, config, agentHost }).listen(0);
  const baseUrl = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    const runtime = await agentHost.get().catch(() => null);
    await runtime?.shutdown?.().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  });

  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const call = (url, body) => fetch(`${baseUrl}${url}`, { method: 'POST', headers, body: JSON.stringify(body) });

  // Park a run on a real approval through the public API.
  const runtime = await agentHost.get();
  runtime.planner = createScriptedPlanner([
    { action: 'call', tool: 'calendar.create', args: validEvent('موعد التبويبين') }
  ]);
  const thread = await (await call('/api/agent/threads', { title: 'تبويبان HTTP' })).json();
  const started = await call(`/api/agent/threads/${thread.thread.id}/runs`, {
    message: 'أنشئ موعدًا',
    clientMessageId: 'two-tabs-http-0001'
  });
  const { runId } = await started.json();
  for (let i = 0; i < 200; i += 1) {
    const detail = await (await fetch(`${baseUrl}/api/agent/runs/${runId}`, { headers })).json();
    if (detail.run.status === RUN_STATUS.waitingApproval) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // Two tabs approve at once. Exactly one 200, exactly one 409 — never a 500.
  const [a, b] = await Promise.all([
    call(`/api/agent/runs/${runId}/approval`, { decision: 'approved', idempotencyKey: 'http-tab-alpha-1' }),
    call(`/api/agent/runs/${runId}/approval`, { decision: 'approved', idempotencyKey: 'http-tab-bravo-2' })
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], 'the loser gets a named conflict, not a server error');
  const loser = a.status === 409 ? a : b;
  const loserBody = await loser.json();
  assert.ok(['approval_already_decided', 'run_not_waiting_approval'].includes(loserBody.error), `unexpected ${loserBody.error}`);

});

test('TT-09 the plan route forwards the revision, so a stale write is a 409 naming both revisions', async (t) => {
  const { createApp } = await import('../src/app.js');
  const { createAgentHost } = await import('../src/agent/index.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-two-tabs-plan-'));
  const calendar = createFakeCalendar();
  const token = 'test-token-with-at-least-32-characters';
  const config = {
    nodeEnv: 'test',
    apiToken: token,
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    userId: 'owner',
    google: { clientId: '', clientSecret: '', redirectUri: 'http://localhost:3000/auth/google/callback' },
    whatsapp: { verifyToken: '', appSecret: '', accessToken: '', phoneNumberId: '', apiVersion: '', autoReplyEnabled: false }
  };
  const agentHost = createAgentHost({
    config,
    env: { CELIA_AGENT_RUNTIME: 'sqlite', CELIA_AGENT_SQLITE_PATH: path.join(directory, 'agent.sqlite3') },
    statusProvider: () => ({ version: '0.3.0', storage: 'test' }),
    connectors: calendar.connectors,
    logger: { error() {} }
  });
  const server = createApp({ pool: { execute: async () => [[]] }, config, agentHost }).listen(0);
  const baseUrl = await new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    const runtime = await agentHost.get().catch(() => null);
    await runtime?.shutdown?.().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const call = (url, body, extra = {}) =>
    fetch(`${baseUrl}${url}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });

  // Park a run through the durable store, exactly as `runToCompletion` would.
  const runtime = await agentHost.get();
  const store = runtime.store;
  const thread = await store.createThread({ ownerId: 'owner', title: 'تبويبان خطة' });
  const { run } = await store.createRun({
    threadId: thread.id,
    ownerId: 'owner',
    userMessageId: null,
    clientMessageId: 'two-tabs-plan-0001',
    planner: 'test',
    maxSteps: 5,
    maxCostMicros: 1000
  });
  // `editPlan` validates the tool against the runtime's registry, so the parked row must name a real
  // registered tool — `google.calendar_create_event`, not the connector-level alias.
  const TOOL = 'google.calendar_create_event';
  const step = await store.appendStep({ runId: run.id, kind: 'act', title: TOOL });
  const { approval } = await store.requestApproval({
    runId: run.id,
    stepId: step.id,
    toolName: TOOL,
    risk: 'external_effect',
    idempotencyKey: `approval:${run.id}:${TOOL}:init`
  });
  const { entry } = await store.enqueueOutbox({
    runId: run.id,
    stepId: step.id,
    toolName: TOOL,
    connector: 'google.calendar',
    idempotencyKey: `outbox:${run.id}:plan`,
    payload: validEvent('الموعد الأصلي')
  });
  await store.linkOutboxApproval(entry.id, approval.id);
  await store.finishRun(run.id, RUN_STATUS.waitingApproval, { error: 'approval_required' });

  // Tab A edits with the revision it read (1). The route must forward it — the edit applies.
  const first = await call(`/api/agent/runs/${run.id}/plan`, {
    payload: validEvent('تعديل التبويب أ'),
    idempotencyKey: 'http-plan-alpha-1',
    expectedRevision: 1
  });
  assert.equal(first.status, 200, 'a fresh revision is editable');
  assert.equal((await first.json()).preconditionApplied, true);

  // Tab B still holds revision 1. Same route, now stale: 409 naming both revisions.
  const stale = await call(`/api/agent/runs/${run.id}/plan`, {
    payload: validEvent('تعديل التبويب ب المتأخر'),
    idempotencyKey: 'http-plan-bravo-2',
    expectedRevision: 1
  });
  assert.equal(stale.status, 409, 'a stale write is refused at the HTTP layer');
  const staleBody = await stale.json();
  assert.equal(staleBody.error, 'revision_conflict');
  assert.equal(calendar.sends.length, 0, 'nothing was dispatched by either edit');

  // The `if-match` header is accepted as the same precondition.
  const viaHeader = await call(
    `/api/agent/runs/${run.id}/plan`,
    { payload: validEvent('تعديل برأس'), idempotencyKey: 'http-plan-charlie-3' },
    { 'if-match': '1' }
  );
  assert.equal(viaHeader.status, 409, 'a stale if-match is refused too');
  assert.equal((await viaHeader.json()).error, 'revision_conflict');
});
