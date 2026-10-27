import crypto from 'node:crypto';
import {
  EVIDENCE_VERSION,
  entryHash,
  genesisHash,
  hashOf,
  verifyChain
} from './evidence.js';
import { OUTBOX_STATUS } from './outbox.js';

/**
 * Durable agent store (AGENT-001).
 *
 * One implementation over two drivers (`mysql` production, `sqlite` local/demo).
 * Every write that decides "did this already happen?" is guarded by a unique key
 * in the database, not by Node memory: messages by `client_message_id`, tool calls
 * by `idempotency_key`, steps by `(run_id, step_index)`, runs by a lease.
 */

export const RUN_STATUS = Object.freeze({
  queued: 'queued',
  running: 'running',
  waitingApproval: 'waiting_approval',
  needsReconciliation: 'needs_reconciliation',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  budgetExhausted: 'budget_exhausted'
});

const TERMINAL = new Set([
  RUN_STATUS.succeeded,
  RUN_STATUS.failed,
  RUN_STATUS.cancelled,
  RUN_STATUS.budgetExhausted,
  RUN_STATUS.waitingApproval,
  RUN_STATUS.needsReconciliation
]);

export const TOOL_RUN_STATUS = Object.freeze({
  started: 'started',
  succeeded: 'succeeded',
  failed: 'failed',
  unknown: 'unknown'
});

export const APPROVAL_DECISION = Object.freeze({
  pending: 'pending',
  approved: 'approved',
  rejected: 'rejected'
});

const nowIso = (clock) => new Date(clock()).toISOString();
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

export function isTerminalStatus(status) {
  return TERMINAL.has(status);
}

function mapThread(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    clientMessageId: row.client_message_id ?? null,
    createdAt: row.created_at
  };
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    threadId: row.thread_id,
    ownerId: row.owner_id,
    userMessageId: row.user_message_id ?? null,
    clientMessageId: row.client_message_id ?? null,
    status: row.status,
    planner: row.planner,
    planSummary: row.plan_summary ?? null,
    limits: {
      maxSteps: Number(row.max_steps),
      maxCostMicros: Number(row.max_cost_micros)
    },
    usage: {
      steps: Number(row.steps_used),
      costMicros: Number(row.cost_micros),
      tokens: Number(row.tokens_used)
    },
    cancelRequested: Boolean(row.cancel_requested),
    leaseUntil: row.lease_until ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at ?? null
  };
}

function mapStep(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    index: Number(row.step_index),
    kind: row.kind,
    title: row.title,
    summary: row.summary ?? null,
    toolName: row.tool_name ?? null,
    createdAt: row.created_at
  };
}

function mapToolRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id ?? null,
    toolName: row.tool_name,
    risk: row.risk,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    outcome: row.outcome ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapApproval(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id ?? null,
    toolName: row.tool_name,
    risk: row.risk,
    idempotencyKey: row.idempotency_key,
    decision: row.decision,
    decisionKey: row.decision_key ?? null,
    actor: row.actor ?? null,
    note: row.note ?? null,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapEvidence(row) {
  if (!row) return null;
  let sourceIds = [];
  if (row.source_ids) {
    try {
      const parsed = JSON.parse(row.source_ids);
      if (Array.isArray(parsed)) sourceIds = parsed;
    } catch {
      sourceIds = [];
    }
  }
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id ?? null,
    seq: Number(row.seq),
    kind: row.kind,
    inputHash: row.input_hash,
    outputHash: row.output_hash ?? null,
    sourceIds,
    verdict: row.verdict ?? null,
    version: row.version,
    prevHash: row.prev_hash,
    hash: row.hash,
    createdAt: row.created_at
  };
}

function mapOutbox(row) {
  if (!row) return null;
  const parse = (value) => {
    if (value === null || value === undefined) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id ?? null,
    approvalId: row.approval_id ?? null,
    toolName: row.tool_name,
    connector: row.connector,
    idempotencyKey: row.idempotency_key,
    payload: parse(row.payload),
    payloadHash: row.payload_hash,
    status: row.status,
    attempts: Number(row.attempts),
    leaseUntil: row.lease_until ?? null,
    externalRef: row.external_ref ?? null,
    result: parse(row.result),
    lastError: row.last_error ?? null,
    enqueuedAt: row.enqueued_at,
    dispatchedAt: row.dispatched_at ?? null,
    settledAt: row.settled_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapGoalContract(row) {
  if (!row) return null;
  try {
    return JSON.parse(row.contract);
  } catch {
    return null;
  }
}

function codedError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

export function createAgentStore({ driver, clock = Date.now, idFactory = crypto.randomUUID } = {}) {
  if (!driver) throw new Error('createAgentStore requires an explicit driver');

  const store = {
    dialect: driver.dialect,
    async migrate() {
      return driver.verifySchema();
    },
    async verifySchema() {
      return driver.verifySchema();
    },
    async close() {
      await driver.close?.();
    },
    async createThread({ ownerId, title }) {
      const id = idFactory();
      const at = nowIso(clock);
      await driver.run(
        'INSERT INTO agent_threads (id, owner_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, ownerId, text(title, 200) || 'مهمة جديدة', 'active', at, at]
      );
      return store.getThread(id, ownerId);
    },
    async getThread(threadId, ownerId) {
      return mapThread(
        await driver.get('SELECT * FROM agent_threads WHERE id = ? AND owner_id = ?', [threadId, ownerId])
      );
    },
    async listThreads(ownerId, { limit = 20 } = {}) {
      const rows = await driver.all(
        'SELECT * FROM agent_threads WHERE owner_id = ? ORDER BY updated_at DESC LIMIT ?',
        [ownerId, Math.min(Math.max(Number(limit) || 20, 1), 100)]
      );
      return rows.map(mapThread);
    },
    async appendMessage({ threadId, role, content, clientMessageId = null }) {
      const id = idFactory();
      const at = nowIso(clock);
      try {
        await driver.transaction(async (tx) => {
          await tx.run(
            'INSERT INTO agent_messages (id, thread_id, role, content, client_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [id, threadId, role, text(content, 8000), clientMessageId, at]
          );
          await tx.run('UPDATE agent_threads SET updated_at = ? WHERE id = ?', [at, threadId]);
        });
        return { created: true, message: mapMessage(await driver.get('SELECT * FROM agent_messages WHERE id = ?', [id])) };
      } catch (error) {
        if (!driver.isUniqueViolation(error) || !clientMessageId) throw error;
        const existing = await driver.get(
          'SELECT * FROM agent_messages WHERE thread_id = ? AND client_message_id = ?',
          [threadId, clientMessageId]
        );
        return { created: false, message: mapMessage(existing) };
      }
    },
    async listMessages(threadId) {
      const rows = await driver.all(
        'SELECT * FROM agent_messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC',
        [threadId]
      );
      return rows.map(mapMessage);
    },
    async createRun({ threadId, ownerId, userMessageId = null, clientMessageId = null, planner, maxSteps, maxCostMicros }) {
      const id = idFactory();
      const at = nowIso(clock);
      try {
        await driver.run(
          `INSERT INTO agent_runs (id, thread_id, owner_id, user_message_id, client_message_id, status, planner,
            max_steps, max_cost_micros, steps_used, cost_micros, tokens_used, cancel_requested, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?)`,
          [
            id,
            threadId,
            ownerId,
            userMessageId,
            clientMessageId,
            RUN_STATUS.queued,
            text(planner, 64),
            maxSteps,
            maxCostMicros,
            at,
            at
          ]
        );
        return { created: true, run: await store.getRun(id) };
      } catch (error) {
        if (!driver.isUniqueViolation(error) || !clientMessageId) throw error;
        const existing = await driver.get(
          'SELECT * FROM agent_runs WHERE thread_id = ? AND client_message_id = ?',
          [threadId, clientMessageId]
        );
        return { created: false, run: mapRun(existing) };
      }
    },
    async getRun(runId) {
      return mapRun(await driver.get('SELECT * FROM agent_runs WHERE id = ?', [runId]));
    },
    async getRunForOwner(runId, ownerId) {
      return mapRun(await driver.get('SELECT * FROM agent_runs WHERE id = ? AND owner_id = ?', [runId, ownerId]));
    },
    async listRuns(threadId, { limit = 20 } = {}) {
      const rows = await driver.all(
        'SELECT * FROM agent_runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?',
        [threadId, Math.min(Math.max(Number(limit) || 20, 1), 100)]
      );
      return rows.map(mapRun);
    },
    /** Atomic lease claim: the only way a run can be executed by this process. */
    async claimRun(runId, { leaseMs = 30_000, workerId = 'worker' } = {}) {
      const at = nowIso(clock);
      const leaseUntil = new Date(clock() + leaseMs).toISOString();
      const result = await driver.run(
        `UPDATE agent_runs SET status = ?, lease_until = ?, lease_owner = ?, updated_at = ?
         WHERE id = ? AND status IN (?, ?) AND (lease_until IS NULL OR lease_until < ?)`,
        [RUN_STATUS.running, leaseUntil, workerId, at, runId, RUN_STATUS.queued, RUN_STATUS.running, at]
      );
      return result.changes > 0;
    },
    async heartbeat(runId, { leaseMs = 30_000 } = {}) {
      const leaseUntil = new Date(clock() + leaseMs).toISOString();
      await driver.run('UPDATE agent_runs SET lease_until = ? WHERE id = ? AND status = ?', [
        leaseUntil,
        runId,
        RUN_STATUS.running
      ]);
      return leaseUntil;
    },
    async finishRun(runId, status, { error = null } = {}) {
      const at = nowIso(clock);
      await driver.run(
        `UPDATE agent_runs SET status = ?, last_error = ?, finished_at = ?, lease_until = NULL, lease_owner = NULL, updated_at = ?
         WHERE id = ?`,
        [status, error ? text(error, 240) : null, at, at, runId]
      );
      return store.getRun(runId);
    },
    async requestCancel(runId, ownerId) {
      const at = nowIso(clock);
      const run = await store.getRunForOwner(runId, ownerId);
      if (!run) return null;
      if (isTerminalStatus(run.status)) return run;
      await driver.run('UPDATE agent_runs SET cancel_requested = 1, updated_at = ? WHERE id = ?', [at, runId]);
      return store.getRun(runId);
    },
    async recordCost(runId, { costMicros = 0, tokens = 0 } = {}) {
      await driver.run(
        'UPDATE agent_runs SET cost_micros = cost_micros + ?, tokens_used = tokens_used + ?, updated_at = ? WHERE id = ?',
        [Math.max(0, Math.round(costMicros)), Math.max(0, Math.round(tokens)), nowIso(clock), runId]
      );
    },
    async appendStep({ runId, kind, title, summary = null, toolName = null }) {
      return driver.transaction(async (tx) => {
        const row = await tx.get(
          'SELECT COALESCE(MAX(step_index), 0) AS currentIndex FROM agent_steps WHERE run_id = ?',
          [runId]
        );
        const index = Number(row?.currentIndex || 0) + 1;
        const id = idFactory();
        const at = nowIso(clock);
        await tx.run(
          `INSERT INTO agent_steps (id, run_id, step_index, kind, title, summary, tool_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, runId, index, text(kind, 16), text(title, 200), summary === null ? null : text(summary, 1000), toolName, at]
        );
        await tx.run('UPDATE agent_runs SET steps_used = ?, updated_at = ? WHERE id = ?', [index, at, runId]);
        return mapStep(await tx.get('SELECT * FROM agent_steps WHERE id = ?', [id]));
      });
    },
    async listSteps(runId) {
      const rows = await driver.all('SELECT * FROM agent_steps WHERE run_id = ? ORDER BY step_index ASC', [runId]);
      return rows.map(mapStep);
    },
    async startToolRun({ runId, stepId = null, toolName, risk, idempotencyKey }) {
      const id = idFactory();
      const at = nowIso(clock);
      try {
        await driver.run(
          `INSERT INTO agent_tool_runs (id, run_id, step_id, tool_name, risk, idempotency_key, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, runId, stepId, toolName, risk, idempotencyKey, TOOL_RUN_STATUS.started, at, at]
        );
        return { created: true, toolRun: mapToolRun(await driver.get('SELECT * FROM agent_tool_runs WHERE id = ?', [id])) };
      } catch (error) {
        if (!driver.isUniqueViolation(error)) throw error;
        const existing = await driver.get('SELECT * FROM agent_tool_runs WHERE idempotency_key = ?', [idempotencyKey]);
        return { created: false, toolRun: mapToolRun(existing) };
      }
    },
    async finishToolRun(toolRunId, status, outcome = null) {
      await driver.run('UPDATE agent_tool_runs SET status = ?, outcome = ?, updated_at = ? WHERE id = ?', [
        status,
        outcome === null ? null : text(typeof outcome === 'string' ? outcome : JSON.stringify(outcome), 4000),
        nowIso(clock),
        toolRunId
      ]);
      return mapToolRun(await driver.get('SELECT * FROM agent_tool_runs WHERE id = ?', [toolRunId]));
    },
    async listToolRuns(runId) {
      const rows = await driver.all('SELECT * FROM agent_tool_runs WHERE run_id = ? ORDER BY created_at ASC', [runId]);
      return rows.map(mapToolRun);
    },
    /**
     * Search already completed document reports in the durable agent ledger.
     * This deliberately reuses agent_tool_runs: no parallel document database or
     * schema migration is introduced. It is a historical duplicate check; concurrent
     * executions still require the normal single-worker/lease controls.
     */
    async findExistingDocumentReport({ documentHash = null, invoiceFingerprint = null } = {}) {
      if (!documentHash && !invoiceFingerprint) return null;
      const rows = await driver.all(
        "SELECT run_id AS runId, outcome FROM agent_tool_runs WHERE tool_name = ? AND status = ? ORDER BY created_at DESC LIMIT 2000",
        ['data.report', TOOL_RUN_STATUS.succeeded]
      );
      for (const row of rows) {
        let report;
        try {
          report = typeof row.outcome === 'string' ? JSON.parse(row.outcome) : row.outcome;
        } catch {
          continue;
        }
        if (
          (documentHash && report?.document_hash === documentHash) ||
          (invoiceFingerprint && report?.invoice_fingerprint === invoiceFingerprint)
        ) {
          return {
            run_id: row.runId,
            document_hash: report.document_hash || null,
            invoice_fingerprint: report.invoice_fingerprint || null
          };
        }
      }
      return null;
    },
    /**
     * A tool run another process may have started and never settled. Matched by its
     * idempotency key so a reconciled outbox intent and its tool run stay one truth.
     */
    async findToolRunByKey(runId, idempotencyKey) {
      return mapToolRun(
        await driver.get('SELECT * FROM agent_tool_runs WHERE run_id = ? AND idempotency_key = ?', [runId, idempotencyKey])
      );
    },
    /**
     * Conditional reconciliation of an uncertain call. Only `started`/`unknown` may
     * move: a settled row is a historical fact and is never rewritten by a later
     * human guess. Returns `{ changed: false }` when the conditional UPDATE missed,
     * so the caller can report a conflict instead of a silent overwrite.
     */
    async reconcileToolRun(toolRunId, { status, outcome = null, from = [TOOL_RUN_STATUS.started, TOOL_RUN_STATUS.unknown] } = {}) {
      if (!['succeeded', 'failed'].includes(status)) throw new Error(`Invalid reconciled tool status: ${status}`);
      const sources = from.length ? from : [TOOL_RUN_STATUS.unknown];
      const placeholders = sources.map(() => '?').join(', ');
      const result = await driver.run(
        `UPDATE agent_tool_runs SET status = ?, outcome = ?, updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
        [
          status,
          outcome === null ? null : text(typeof outcome === 'string' ? outcome : JSON.stringify(outcome), 4000),
          nowIso(clock),
          toolRunId,
          ...sources
        ]
      );
      const toolRun = mapToolRun(await driver.get('SELECT * FROM agent_tool_runs WHERE id = ?', [toolRunId]));
      return { changed: result.changes > 0, toolRun };
    },
    /** Runs a previous process left behind: queued, or running with an expired lease. */
    async findResumableRuns({ limit = 10 } = {}) {
      const at = nowIso(clock);
      const rows = await driver.all(
        `SELECT * FROM agent_runs WHERE status IN (?, ?) AND (lease_until IS NULL OR lease_until < ?)
         ORDER BY created_at ASC LIMIT ?`,
        [RUN_STATUS.queued, RUN_STATUS.running, at, Math.min(Math.max(Number(limit) || 10, 1), 50)]
      );
      return rows.map(mapRun);
    },
    async setPlanSummary(runId, summary) {
      await driver.run('UPDATE agent_runs SET plan_summary = ?, updated_at = ? WHERE id = ?', [
        text(summary, 1000),
        nowIso(clock),
        runId
      ]);
    },
    // ── Goal contract (one inspectable data contract per run) ──────────────
    async saveGoalContract(runId, contract) {
      const at = nowIso(clock);
      await driver.run(
        'INSERT INTO agent_goal_contracts (run_id, contract, created_at) VALUES (?, ?, ?)',
        [runId, JSON.stringify(contract), at]
      );
      return store.getGoalContract(runId);
    },
    async getGoalContract(runId) {
      return mapGoalContract(
        await driver.get('SELECT * FROM agent_goal_contracts WHERE run_id = ?', [runId])
      );
    },
    // ── Approval gate: durable pending/approved/rejected decisions ─────────
    async requestApproval({ runId, stepId = null, toolName, risk, idempotencyKey }) {
      const id = idFactory();
      const at = nowIso(clock);
      try {
        await driver.run(
          `INSERT INTO agent_approvals
             (id, run_id, step_id, tool_name, risk, idempotency_key, decision, requested_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, runId, stepId, text(toolName, 64), text(risk, 24), text(idempotencyKey, 160), APPROVAL_DECISION.pending, at, at, at]
        );
        return { created: true, approval: mapApproval(await driver.get('SELECT * FROM agent_approvals WHERE id = ?', [id])) };
      } catch (error) {
        if (!driver.isUniqueViolation(error)) throw error;
        const existing = await driver.get('SELECT * FROM agent_approvals WHERE idempotency_key = ?', [idempotencyKey]);
        return { created: false, approval: mapApproval(existing) };
      }
    },
    async listApprovals(runId) {
      const rows = await driver.all(
        'SELECT * FROM agent_approvals WHERE run_id = ? ORDER BY requested_at ASC, created_at ASC',
        [runId]
      );
      return rows.map(mapApproval);
    },
    async getApproval(approvalId) {
      return mapApproval(await driver.get('SELECT * FROM agent_approvals WHERE id = ?', [approvalId]));
    },
    /** Idempotent decision: a retried call carrying the same decision key returns the same row. */
    async decideApproval({ approvalId, decision, actor, note = null, decisionKey }) {
      const existing = await driver.get('SELECT * FROM agent_approvals WHERE id = ?', [approvalId]);
      if (!existing) return { changed: false, approval: null };
      if (existing.decision !== APPROVAL_DECISION.pending) {
        if (decisionKey && existing.decision_key === decisionKey) {
          return { changed: false, approval: mapApproval(existing) };
        }
        throw codedError('approval_already_decided', 'approval_already_decided');
      }
      const at = nowIso(clock);
      const result = await driver.run(
        `UPDATE agent_approvals
           SET decision = ?, decision_key = ?, actor = ?, note = ?, decided_at = ?, updated_at = ?
         WHERE id = ? AND decision = ?`,
        [
          text(decision, 16),
          decisionKey ? text(decisionKey, 160) : null,
          text(actor, 64),
          note === null ? null : text(note, 500),
          at,
          at,
          approvalId,
          APPROVAL_DECISION.pending
        ]
      );
      if (result.changes === 0) {
        // Lost a concurrent decision race: the conditional UPDATE matched nothing.
        throw codedError('approval_already_decided', 'approval_already_decided');
      }
      return { changed: true, approval: mapApproval(await driver.get('SELECT * FROM agent_approvals WHERE id = ?', [approvalId])) };
    },
    /** Move a parked run back to the queue after an approval; only waiting_approval is eligible. */
    async requeueRun(runId, { from = [RUN_STATUS.waitingApproval] } = {}) {
      const at = nowIso(clock);
      const sources = from.length ? from : [RUN_STATUS.waitingApproval];
      const placeholders = sources.map(() => '?').join(', ');
      const result = await driver.run(
        `UPDATE agent_runs
           SET status = ?, lease_until = NULL, lease_owner = NULL, last_error = NULL, finished_at = NULL, updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
        [RUN_STATUS.queued, at, runId, ...sources]
      );
      return result.changes > 0;
    },
    // ── Append-only evidence ledger with a SHA-256 hash chain ──────────────
    async appendEvidence({
      runId,
      stepId = null,
      kind,
      input = null,
      output = null,
      sourceIds = [],
      verdict = null,
      version = EVIDENCE_VERSION
    }) {
      return driver.transaction(async (tx) => {
        const row = await tx.get('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM agent_evidence WHERE run_id = ?', [runId]);
        const seq = Number(row?.maxSeq || 0) + 1;
        const id = idFactory();
        const at = nowIso(clock);
        const inputHash = hashOf(input);
        const outputHash = output === null || output === undefined ? null : hashOf(output);
        const prevRow = await tx.get(
          'SELECT hash FROM agent_evidence WHERE run_id = ? ORDER BY seq DESC LIMIT 1',
          [runId]
        );
        const prevHash = prevRow?.hash || genesisHash(runId);
        const ids = (Array.isArray(sourceIds) ? sourceIds : []).map((entry) => String(entry));
        const hash = entryHash({
          prevHash,
          runId,
          seq,
          kind: text(kind, 32),
          inputHash,
          outputHash,
          sourceIds: ids,
          verdict,
          version: text(version, 24),
          at
        });
        await tx.run(
          `INSERT INTO agent_evidence
             (id, run_id, step_id, seq, kind, input_hash, output_hash, source_ids, verdict, version, prev_hash, hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, runId, stepId, seq, text(kind, 32), inputHash, outputHash, JSON.stringify(ids), verdict, text(version, 24), prevHash, hash, at]
        );
        return mapEvidence(await tx.get('SELECT * FROM agent_evidence WHERE id = ?', [id]));
      });
    },
    async listEvidence(runId) {
      const rows = await driver.all('SELECT * FROM agent_evidence WHERE run_id = ? ORDER BY seq ASC', [runId]);
      return rows.map(mapEvidence);
    },
    async verifyEvidenceChain(runId) {
      const rows = await driver.all('SELECT * FROM agent_evidence WHERE run_id = ? ORDER BY seq ASC', [runId]);
      return verifyChain(rows, { runId });
    },
    // ── Transactional outbox for external effects (AGENT-002) ──────────────
    /**
     * Record one intent. Inside a single transaction the store refuses a second
     * live row for the same (run, tool): a re-entered loop reuses the existing
     * intent instead of minting a duplicate external effect.
     */
    async enqueueOutbox({
      runId,
      stepId = null,
      approvalId = null,
      toolName,
      connector,
      idempotencyKey,
      payload = null
    }) {
      const payloadText = JSON.stringify(payload ?? null);
      const payloadHash = hashOf(payload ?? null);
      try {
        return await driver.transaction(async (tx) => {
          const live = await tx.get(
            `SELECT * FROM agent_outbox
             WHERE run_id = ? AND tool_name = ? AND status IN (?, ?, ?, ?)
             ORDER BY enqueued_at ASC LIMIT 1`,
            [runId, toolName, OUTBOX_STATUS.pending, OUTBOX_STATUS.dispatching, OUTBOX_STATUS.sent, OUTBOX_STATUS.unknown]
          );
          if (live) return { created: false, entry: mapOutbox(live) };
          // A provably failed or cancelled intent may be attempted again under the same
          // key: nothing reached the provider, so reusing the row cannot duplicate a send.
          const byKey = await tx.get('SELECT * FROM agent_outbox WHERE idempotency_key = ?', [idempotencyKey]);
          if (byKey) {
            if (byKey.status === OUTBOX_STATUS.failed || byKey.status === OUTBOX_STATUS.cancelled) {
              const retryAt = nowIso(clock);
              await tx.run(
                `UPDATE agent_outbox
                   SET status = ?, last_error = NULL, settled_at = NULL, step_id = ?, approval_id = ?,
                       payload = ?, payload_hash = ?, updated_at = ?
                 WHERE id = ? AND idempotency_key = ?`,
                [
                  OUTBOX_STATUS.pending,
                  stepId,
                  approvalId,
                  payloadText,
                  payloadHash,
                  retryAt,
                  byKey.id,
                  idempotencyKey
                ]
              );
              return {
                created: false,
                retried: true,
                entry: mapOutbox(await tx.get('SELECT * FROM agent_outbox WHERE id = ?', [byKey.id]))
              };
            }
            return { created: false, entry: mapOutbox(byKey) };
          }
          const id = idFactory();
          const at = nowIso(clock);
          await tx.run(
            `INSERT INTO agent_outbox
               (id, run_id, step_id, approval_id, tool_name, connector, idempotency_key, payload, payload_hash,
                status, attempts, enqueued_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
            [
              id,
              runId,
              stepId,
              approvalId,
              text(toolName, 64),
              text(connector, 64),
              text(idempotencyKey, 120),
              payloadText,
              payloadHash,
              OUTBOX_STATUS.pending,
              at,
              at,
              at
            ]
          );
          return { created: true, entry: mapOutbox(await tx.get('SELECT * FROM agent_outbox WHERE id = ?', [id])) };
        });
      } catch (error) {
        if (!driver.isUniqueViolation(error)) throw error;
        const existing = await driver.get('SELECT * FROM agent_outbox WHERE idempotency_key = ?', [idempotencyKey]);
        return { created: false, entry: mapOutbox(existing) };
      }
    },
    async linkOutboxApproval(outboxId, approvalId) {
      await driver.run('UPDATE agent_outbox SET approval_id = ?, updated_at = ? WHERE id = ? AND approval_id IS NULL', [
        approvalId,
        nowIso(clock),
        outboxId
      ]);
      return mapOutbox(await driver.get('SELECT * FROM agent_outbox WHERE id = ?', [outboxId]));
    },
    async getOutbox(outboxId) {
      return mapOutbox(await driver.get('SELECT * FROM agent_outbox WHERE id = ?', [outboxId]));
    },
    async getOutboxByKey(idempotencyKey) {
      return mapOutbox(await driver.get('SELECT * FROM agent_outbox WHERE idempotency_key = ?', [idempotencyKey]));
    },
    async listOutbox(runId) {
      const rows = await driver.all(
        'SELECT * FROM agent_outbox WHERE run_id = ? ORDER BY enqueued_at ASC, created_at ASC',
        [runId]
      );
      return rows.map(mapOutbox);
    },
    /** Conditional claim: only a `pending` intent can start dispatching, exactly once. */
    async claimOutbox(outboxId, { leaseMs = 30_000, workerId = 'worker' } = {}) {
      const at = nowIso(clock);
      const leaseUntil = new Date(clock() + leaseMs).toISOString();
      const result = await driver.run(
        `UPDATE agent_outbox
           SET status = ?, attempts = attempts + 1, lease_until = ?, lease_owner = ?,
               dispatched_at = COALESCE(dispatched_at, ?), updated_at = ?
         WHERE id = ? AND status = ?`,
        [OUTBOX_STATUS.dispatching, leaseUntil, workerId, at, at, outboxId, OUTBOX_STATUS.pending]
      );
      return result.changes > 0;
    },
    /** Terminal settlement. Only a dispatched or pending intent can be settled. */
    async settleOutbox(outboxId, { status, externalRef = null, result = null, lastError = null }) {
      const at = nowIso(clock);
      await driver.run(
        `UPDATE agent_outbox
           SET status = ?, external_ref = COALESCE(?, external_ref), result = COALESCE(?, result),
               last_error = ?, lease_until = NULL, lease_owner = NULL, settled_at = ?, updated_at = ?
         WHERE id = ? AND status IN (?, ?)`,
        [
          text(status, 16),
          externalRef,
          result === null ? null : JSON.stringify(result),
          lastError === null ? null : text(lastError, 120),
          at,
          at,
          outboxId,
          OUTBOX_STATUS.pending,
          OUTBOX_STATUS.dispatching
        ]
      );
      return mapOutbox(await driver.get('SELECT * FROM agent_outbox WHERE id = ?', [outboxId]));
    },
    /**
     * Conditional human reconciliation of an intentionally uncertain intent.
     *
     * Only `unknown` — or a `dispatching` row whose lease has expired — may move. A
     * live dispatch keeps its lease (another worker may still be mid-request), and a
     * settled row (`sent`/`failed`/`cancelled`) is never rewritten: it is a fact, not
     * an opinion. No request is made here; the caller records a human finding only.
     */
    async reconcileOutboxEntry(outboxId, { status, externalRef = null, result = null, lastError = null, at = null } = {}) {
      if (!['sent', 'failed', 'cancelled'].includes(status)) throw new Error(`Invalid reconciled outbox status: ${status}`);
      const now = nowIso(clock);
      // `at` lets a caller state the observation instant (tests, offline audits); the
      // lease comparison must use the same instant or the check would be meaningless.
      const reference = at ?? now;
      const changed = await driver.run(
        `UPDATE agent_outbox
           SET status = ?, external_ref = COALESCE(?, external_ref), result = COALESCE(?, result),
               last_error = ?, lease_until = NULL, lease_owner = NULL, settled_at = ?, updated_at = ?
         WHERE id = ? AND (status = ? OR (status = ? AND (lease_until IS NULL OR lease_until < ?)))`,
        [
          text(status, 16),
          externalRef === null ? null : text(externalRef, 240),
          result === null ? null : JSON.stringify(result),
          lastError === null ? null : text(lastError, 120),
          at ?? now,
          now,
          outboxId,
          OUTBOX_STATUS.unknown,
          OUTBOX_STATUS.dispatching,
          reference
        ]
      );
      return {
        changed: changed.changes > 0,
        entry: mapOutbox(await driver.get('SELECT * FROM agent_outbox WHERE id = ?', [outboxId]))
      };
    },
    /** A rejected approval cancels its intents: nothing was, or will be, sent. */
    async cancelPendingOutbox(runId) {
      const at = nowIso(clock);
      const result = await driver.run(
        `UPDATE agent_outbox SET status = ?, last_error = ?, settled_at = ?, updated_at = ?
         WHERE run_id = ? AND status = ?`,
        [OUTBOX_STATUS.cancelled, 'approval_rejected', at, at, runId, OUTBOX_STATUS.pending]
      );
      return result.changes;
    },
    /** Intents whose dispatcher vanished. Reported for reconciliation, never re-sent. */
    async findStaleOutbox({ limit = 20 } = {}) {
      const at = nowIso(clock);
      const rows = await driver.all(
        `SELECT * FROM agent_outbox WHERE status = ? AND (lease_until IS NULL OR lease_until < ?)
         ORDER BY enqueued_at ASC LIMIT ?`,
        [OUTBOX_STATUS.dispatching, at, Math.min(Math.max(Number(limit) || 20, 1), 100)]
      );
      return rows.map(mapOutbox);
    }
  };

  return store;
}
