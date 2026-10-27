import crypto from 'node:crypto';

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
    }
  };

  return store;
}
