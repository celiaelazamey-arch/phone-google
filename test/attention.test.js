import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ATTENTION_VERSION,
  NEXT,
  REASON,
  SEVERITY,
  buildAttention,
  checkQueue,
  describeAttention
} from '../src/agent/attention.js';

const NOW = '2026-11-01T12:00:00.000Z';
const ago = (minutes) => new Date(Date.parse(NOW) - minutes * 60000).toISOString();

const run = (id, status, extra = {}) => ({ id, status, createdAt: ago(30), updatedAt: ago(5), ...extra });
const approval = (id, runId, decision = 'pending', extra = {}) => ({ id, runId, decision, createdAt: ago(20), ...extra });
const toolRun = (id, runId, status, extra = {}) => ({ id, runId, status, toolName: 'calendar.create', createdAt: ago(10), ...extra });
const outboxRow = (id, runId, status, extra = {}) => ({ id, runId, status, toolName: 'gmail.send', createdAt: ago(8), ...extra });

const build = (sources, now = NOW) => buildAttention(sources, { now });

test('a run waiting on approval is the first thing the queue says', () => {
  const queue = build({ runs: [run('r1', 'waiting_approval')], approvals: [approval('a1', 'r1')] });
  assert.equal(queue.total, 1);
  assert.equal(queue.items[0].reason, 'approval_pending');
  assert.equal(queue.items[0].severity, SEVERITY.decision);
  assert.equal(queue.items[0].next, NEXT.decide);
  assert.deepEqual(queue.items[0].evidence.approvalIds, ['a1']);
  assert.equal(queue.counts.decision, 1);
  assert.equal(queue.owed, 1);
});

test('a run paused on approval with no approval row still speaks — and names the missing record', () => {
  const queue = build({ runs: [run('r2', 'waiting_approval')] });
  assert.equal(queue.total, 1);
  assert.equal(queue.items[0].reason, 'run_waiting_approval');
  assert.equal(queue.items[0].evidence.missingApprovalRecord, true);
  assert.equal(queue.items[0].severity, SEVERITY.decision);
});

test('an approval whose run is not in the snapshot is not dropped', () => {
  const queue = build({ runs: [], approvals: [approval('a9', 'r9')] });
  assert.equal(queue.total, 1);
  assert.equal(queue.items[0].runId, 'r9');
  assert.equal(queue.items[0].evidence.runMissingFromSnapshot, true);
  assert.equal(queue.items[0].severity, SEVERITY.decision);
});

test('ambiguity is never softened into success, and each unknown effect is its own item', () => {
  const queue = build({
    runs: [run('r3', 'needs_reconciliation')],
    toolRuns: [toolRun('t1', 'r3', 'unknown'), toolRun('t2', 'r3', 'unknown'), toolRun('t3', 'r3', 'succeeded')],
    outbox: [outboxRow('o1', 'r3', 'unknown'), outboxRow('o2', 'r3', 'dispatching'), outboxRow('o3', 'r3', 'sent')]
  });
  const ambiguous = queue.items.filter((item) => item.severity === SEVERITY.ambiguous);
  assert.deepEqual(
    ambiguous.map((item) => item.id).sort(),
    ['outbox:o1', 'outbox:o2', 'run:r3', 'tool:t1', 'tool:t2'],
    'every unknown record appears exactly once'
  );
  assert.equal(queue.counts.ambiguous, 5, 'reconciliation + two unknown tools + one unknown outbox + one dispatching');
  assert.ok(ambiguous.every((item) => item.next === NEXT.reconcile));
  assert.ok(!queue.items.some((item) => ['tool:t3', 'outbox:o3'].includes(item.id)), 'settled records are silent');
});

test('failures and budget stops are reported; ordinary progress is not', () => {
  const queue = build({
    runs: [run('f1', 'failed'), run('b1', 'budget_exhausted'), run('q1', 'queued'), run('x1', 'running'), run('c1', 'cancelled')]
  });
  assert.deepEqual(queue.items.map((item) => item.id).sort(), ['run:b1', 'run:f1']);
  assert.equal(queue.counts.failure, 2);
  assert.equal(queue.owed, 2);
});

test('a clean queue is allowed to be empty, and says so out loud', () => {
  const queue = build({ runs: [run('s1', 'succeeded')] });
  assert.equal(queue.owed, 0);
  assert.equal(queue.clear, true);
  assert.equal(queue.counts.info, 1);
  assert.equal(describeAttention(queue).at(-1).includes('لا يرسل شيئًا'), true);
  const empty = build({});
  assert.equal(empty.total, 0);
  assert.deepEqual(describeAttention(empty), ['لا شيء ينتظرك الآن — لا تشغيل متوقف، ولا أثر غير محسوم.']);
});

test('order is owed-first, then oldest waiting — never by input order', () => {
  const queue = build({
    runs: [
      run('old-fail', 'failed', { createdAt: ago(600) }),
      run('new-fail', 'failed', { createdAt: ago(5) }),
      run('decision', 'waiting_approval', { createdAt: ago(1) }),
      run('amb', 'needs_reconciliation', { createdAt: ago(50) })
    ],
    approvals: [approval('a', 'decision')]
  });
  assert.deepEqual(queue.items.map((item) => item.id), ['run:decision', 'run:amb', 'run:old-fail', 'run:new-fail']);
  const shuffled = build({
    runs: [
      run('amb', 'needs_reconciliation', { createdAt: ago(50) }),
      run('old-fail', 'failed', { createdAt: ago(600) }),
      run('decision', 'waiting_approval', { createdAt: ago(1) }),
      run('new-fail', 'failed', { createdAt: ago(5) })
    ],
    approvals: [approval('a', 'decision')]
  });
  assert.equal(queue.digest, shuffled.digest, 'the queue must not depend on the order rows arrive in');
});

test('the queue sends nothing and remembers nothing about being read', () => {
  const queue = build({ runs: [run('r1', 'waiting_approval')], approvals: [approval('a1', 'r1')] });
  assert.equal(queue.sends, false);
  assert.equal(queue.tracksRead, false);
  assert.equal(queue.version, ATTENTION_VERSION);
  for (const forbidden of ['push', 'email', 'whatsapp', 'unread', 'seenAt']) {
    assert.ok(!JSON.stringify(queue).includes(forbidden), `the queue must not carry ${forbidden}`);
  }
});

test('a credential-shaped title is dropped, not copied out of the machine', () => {
  const queue = build({
    runs: [run('r1', 'failed', { title: 'api_key=sk-live-do-not-echo' }), run('r2', 'failed', { title: 'تقرير أسبوعي' })]
  });
  const byId = Object.fromEntries(queue.items.map((item) => [item.id, item]));
  assert.equal(byId['run:r1'].title, null);
  assert.equal(byId['run:r2'].title, 'تقرير أسبوعي');
});

test('records without an identifier are reported as dropped, never guessed', () => {
  const queue = build({ runs: [{ status: 'failed' }, run('r1', 'failed')], approvals: [{ decision: 'pending' }] });
  assert.equal(queue.total, 1);
  assert.deepEqual(queue.dropped.map((entry) => entry.reason).sort(), ['no_id', 'no_run_id']);
});

test('an edited queue is refused: dropped item, invented item, softened severity, stale digest', () => {
  const sources = {
    runs: [run('r1', 'waiting_approval'), run('r2', 'failed')],
    approvals: [approval('a1', 'r1')]
  };
  const queue = build(sources);
  assert.deepEqual(checkQueue(queue, sources), { ok: true, problems: [] });

  const dropped = structuredClone(queue);
  dropped.items = dropped.items.filter((item) => item.id !== 'run:r2');
  dropped.total = 1;
  const droppedCheck = checkQueue(dropped, sources);
  assert.equal(droppedCheck.ok, false);
  assert.ok(droppedCheck.problems.some((problem) => problem.includes('item dropped: run:r2')));

  const invented = structuredClone(queue);
  invented.items.push({ id: 'run:ghost', reason: 'run_failed', severity: 'failure', evidence: { runId: 'ghost' } });
  assert.ok(checkQueue(invented, sources).problems.some((problem) => problem.includes('item invented: run:ghost')));

  const softened = structuredClone(queue);
  softened.items[0].severity = 'info';
  const softenedCheck = checkQueue(softened, sources);
  assert.equal(softenedCheck.ok, false);
  assert.ok(softenedCheck.problems.some((problem) => problem.includes('severity softened')));

  const edited = structuredClone(queue);
  edited.items[1].title = 'شيء آخر';
  assert.ok(checkQueue(edited, sources).problems.includes('digest does not match the queue'));

  const claiming = structuredClone(queue);
  claiming.sends = true;
  assert.ok(checkQueue(claiming, sources).problems.includes('the queue may not send anything'));
});

test('every reason the queue can produce is declared with both languages and a severity', () => {
  for (const [reason, meta] of Object.entries(REASON)) {
    assert.ok(meta.ar && meta.en, `${reason} needs both languages`);
    assert.ok(Object.values(SEVERITY).includes(meta.severity), `${reason} needs a known severity`);
  }
  const produced = new Set(
    build({
      runs: ['waiting_approval', 'needs_reconciliation', 'failed', 'budget_exhausted', 'succeeded'].map((status, index) => run(`r${index}`, status)),
      approvals: [approval('a', 'r0')],
      toolRuns: [toolRun('t', 'r1', 'unknown')],
      outbox: [outboxRow('o', 'r1', 'unknown'), outboxRow('o2', 'r1', 'dispatching')]
    }).items
      .concat(build({ runs: [run('r9', 'waiting_approval')] }).items)
      .map((item) => item.reason)
  );
  assert.deepEqual([...produced].sort(), Object.keys(REASON).sort(), 'no reason is declared but unreachable, none produced but undeclared');
});

test('the sentence states the total, the owed count and the digest', () => {
  const lines = describeAttention(build({ runs: [run('r1', 'waiting_approval'), run('r2', 'failed')], approvals: [approval('a', 'r1')] }));
  assert.match(lines[0], /موافقة تنتظر قرارك/);
  assert.match(lines[0], /منذ 30 دقيقة/);
  assert.match(lines.join('\n'), /1 قرارًا مطلوبًا/);
  assert.match(lines.join('\n'), /بصمة الطابور/);
});

test('the CLI reads a snapshot, exits 1 when something is owed and 0 when nothing is', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const path = await import('node:path');
  const target = path.join(process.cwd(), 'scripts', 'attention.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'attention-'));
  const owed = path.join(dir, 'owed.json');
  const clear = path.join(dir, 'clear.json');
  writeFileSync(owed, JSON.stringify({ runs: [run('r1', 'waiting_approval')], approvals: [approval('a1', 'r1')] }), 'utf8');
  writeFileSync(clear, JSON.stringify({ runs: [run('r2', 'succeeded')] }), 'utf8');

  let failure = null;
  try {
    execFileSync(process.execPath, [target, owed, '--now', NOW], { encoding: 'utf8' });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'something owed must not exit 0');
  assert.equal(failure.status, 1);
  assert.match(String(failure.stdout), /موافقة تنتظر قرارك/);

  const nothing = execFileSync(process.execPath, [target, clear, '--now', NOW], { encoding: 'utf8' });
  assert.match(nothing, /المجموع: 1 بندًا/);
  assert.match(nothing, /لا شيء مستحق عليك/);
  rmSync(dir, { recursive: true, force: true });
});
