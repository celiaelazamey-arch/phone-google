import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempStore, createRecordingTools, threeReadsThenFinish } from './support/agent-fixtures.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createScriptedPlanner } from '../src/agent/planner.js';
import { genesisHash, hashOf, canonicalize, entryHash } from '../src/agent/evidence.js';

async function newRun(store, owner = 'owner') {
  const thread = await store.createThread({ ownerId: owner, title: 'دليل' });
  const created = await store.createRun({
    threadId: thread.id,
    ownerId: owner,
    planner: 'scripted',
    maxSteps: 8,
    maxCostMicros: 1000
  });
  return { thread, run: created.run };
}

test('evidence ledger: entries are sequential, hash-chained and anchored at a per-run genesis', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const { store } = fixture;
  const { run } = await newRun(store);

  const first = await store.appendEvidence({ runId: run.id, kind: 'goal_contract', input: { a: 1 }, sourceIds: [] });
  const second = await store.appendEvidence({
    runId: run.id,
    kind: 'tool_call',
    input: { tool: 'read.alpha', args: {} },
    output: { alpha: true },
    sourceIds: ['tool-1'],
    verdict: 'PASS'
  });

  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(first.prevHash, genesisHash(run.id));
  assert.equal(second.prevHash, first.hash);
  assert.equal(first.inputHash, hashOf({ a: 1 }));
  assert.equal(second.outputHash, hashOf({ alpha: true }));

  const expected = entryHash({
    prevHash: first.prevHash,
    runId: run.id,
    seq: 1,
    kind: 'goal_contract',
    inputHash: first.inputHash,
    outputHash: null,
    sourceIds: [],
    verdict: null,
    version: first.version,
    at: first.createdAt
  });
  assert.equal(first.hash, expected);

  const verification = await store.verifyEvidenceChain(run.id);
  assert.deepEqual(verification, { ok: true, count: 2, head: second.hash });
});

test('evidence ledger: canonical hashing ignores object key order but respects values and array order', () => {
  assert.equal(hashOf({ a: 1, b: 2 }), hashOf({ b: 2, a: 1 }));
  assert.notEqual(hashOf({ a: 1, b: 2 }), hashOf({ a: 1, b: 3 }));
  assert.notEqual(hashOf([1, 2, 3]), hashOf([3, 2, 1]));
  assert.equal(canonicalize({ z: [1, { y: 2, x: 1 }] }), canonicalize({ z: [1, { x: 1, y: 2 }] }));
});

test('evidence ledger: tampering with a stored row breaks the chain at that exact entry', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const { store, driver } = fixture;
  const { run } = await newRun(store);
  await store.appendEvidence({ runId: run.id, kind: 'goal_contract', input: { v: 1 } });
  const target = await store.appendEvidence({ runId: run.id, kind: 'tool_call', input: { v: 2 }, output: { ok: true } });

  await driver.run('UPDATE agent_evidence SET verdict = ? WHERE id = ?', ['UNKNOWN', target.id]);
  const broken = await store.verifyEvidenceChain(run.id);
  assert.equal(broken.ok, false);
  assert.equal(broken.brokenSeq, target.seq);
  assert.equal(broken.reason, 'entry_hash_mismatch');
});

test('evidence ledger: deleting an entry is detected as a sequence gap', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const { store, driver } = fixture;
  const { run } = await newRun(store);
  await store.appendEvidence({ runId: run.id, kind: 'goal_contract', input: { v: 1 } });
  const middle = await store.appendEvidence({ runId: run.id, kind: 'tool_call', input: { v: 2 } });
  await store.appendEvidence({ runId: run.id, kind: 'delivery', input: { v: 3 } });

  await driver.run('DELETE FROM agent_evidence WHERE id = ?', [middle.id]);
  const broken = await store.verifyEvidenceChain(run.id);
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, 'seq_gap_or_reorder');
});

test('evidence ledger: two runs keep independent genesis-anchored chains', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const { store } = fixture;
  const a = await newRun(store);
  const b = await newRun(store);
  const entryA = await store.appendEvidence({ runId: a.run.id, kind: 'goal_contract', input: { run: 'a' } });
  const entryB = await store.appendEvidence({ runId: b.run.id, kind: 'goal_contract', input: { run: 'b' } });
  assert.equal(entryA.seq, 1);
  assert.equal(entryB.seq, 1);
  assert.equal(entryA.prevHash, genesisHash(a.run.id));
  assert.equal(entryB.prevHash, genesisHash(b.run.id));
  assert.ok((await store.verifyEvidenceChain(a.run.id)).ok);
  assert.ok((await store.verifyEvidenceChain(b.run.id)).ok);
});

test('evidence ledger: a full run records contract → tool calls → verification → delivery and survives reopen', async (t) => {
  const fixture = await createTempStore();
  t.after(() => fixture.cleanup());
  const recorder = createRecordingTools();
  const runtime = createAgentRuntime({
    store: fixture.store,
    tools: recorder.tools,
    planner: createScriptedPlanner(threeReadsThenFinish()),
    logger: { error() {} }
  });
  const thread = await fixture.store.createThread({ ownerId: 'owner', title: 'سلسلة كاملة' });
  const submitted = await runtime.submit({ threadId: thread.id, message: 'مهمة كاملة', clientMessageId: 'evidence-full-01' });
  const finished = await runtime.runToCompletion(submitted.run.id);
  assert.equal(finished.status, 'succeeded');

  const entries = await fixture.store.listEvidence(submitted.run.id);
  assert.deepEqual(entries[0].kind, 'goal_contract');
  assert.deepEqual(
    entries.filter((entry) => entry.kind === 'tool_call').map((entry) => entry.sourceIds.length),
    [1, 1, 1]
  );
  assert.equal(entries.filter((entry) => entry.kind === 'verification').length, 1);
  assert.equal(entries.at(-1).kind, 'delivery');
  assert.ok((await fixture.store.verifyEvidenceChain(submitted.run.id)).ok);

  const reopened = await fixture.reopen();
  const afterReopen = await reopened.store.verifyEvidenceChain(submitted.run.id);
  assert.equal(afterReopen.ok, true, 'the chain is durable in the SQLite file');
  const reloaded = await reopened.store.listEvidence(submitted.run.id);
  assert.equal(reloaded.length, entries.length);
});
