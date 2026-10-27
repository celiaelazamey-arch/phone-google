import crypto from 'node:crypto';
import { RUN_STATUS, TOOL_RUN_STATUS, isTerminalStatus } from './store.js';
import { RISK } from './tools.js';

/**
 * Agent runtime — the M1 loop (AGENT-001).
 *
 * Task = thread message with `client_message_id` → one durable run → plan / act /
 * observe / decide steps → durable delivery summary. The loop lives in MySQL (or
 * the explicit SQLite demo store), never in a Node map: a restart resumes from the
 * last confirmed step, and a tool call that was in flight when the process died is
 * marked `unknown` and handed to reconciliation instead of being replayed.
 */

export const DEFAULT_LIMITS = Object.freeze({
  maxSteps: 12,
  maxCostMicros: 100_000,
  maxDurationMs: 120_000,
  leaseMs: 30_000,
  toolTimeoutMs: 10_000
});

const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

function httpError(status, code, message) {
  const error = new Error(message || code);
  error.status = status;
  error.code = code;
  return error;
}

const parseOutcome = (value) => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

export function createAgentRuntime({
  store,
  tools,
  planner,
  ownerId = 'owner',
  limits = {},
  clock = Date.now,
  workerId = `w-${crypto.randomBytes(4).toString('hex')}`,
  logger = console
} = {}) {
  if (!store) throw new Error('Agent runtime requires an explicit durable store');
  if (!tools) throw new Error('Agent runtime requires a tool registry');
  if (!planner?.plan) throw new Error('Agent runtime requires a planner');
  const config = Object.freeze({ ...DEFAULT_LIMITS, ...limits });
  const listeners = new Map();
  const controllers = new Map();
  const active = new Map();

  function emit(runId, event) {
    const payload = { runId, at: new Date(clock()).toISOString(), ...event };
    for (const listener of listeners.get(runId) || []) {
      try {
        listener(payload);
      } catch {
        /* a broken stream must never break the run */
      }
    }
    return payload;
  }

  async function contextFor(run, signal) {
    const [messages, steps] = await Promise.all([store.listMessages(run.threadId), store.listSteps(run.id)]);
    const toolRuns = (await store.listToolRuns(run.id)).map((toolRun) => ({
      ...toolRun,
      parsedOutcome: parseOutcome(toolRun.outcome)
    }));
    return { run, messages, steps, toolRuns, signal, limits: config };
  }

  function withTimeout(promise, controller, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      const timer = setTimeout(() => {
        controller.abort();
        finish(reject, httpError(504, 'tool_timeout', 'tool_timeout'));
      }, timeoutMs);
      const onAbort = () => {
        controller.abort();
        finish(reject, httpError(499, 'cancelled', 'cancelled'));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
    });
  }

  async function addStep(runId, step) {
    const stored = await store.appendStep({ runId, ...step });
    emit(runId, { type: 'step', step: stored });
    return stored;
  }

  async function finish(runId, status, { error = null } = {}) {
    const run = await store.finishRun(runId, status, { error });
    emit(runId, { type: 'run.finished', status, run });
    return run;
  }

  async function executeOnce(runId) {
    const claimed = await store.claimRun(runId, { leaseMs: config.leaseMs, workerId });
    if (!claimed) {
      const existing = await store.getRun(runId);
      return { run: existing, claimed: false };
    }
    const controller = new AbortController();
    controllers.set(runId, controller);
    const heartbeat = setInterval(() => {
      store.heartbeat(runId, { leaseMs: config.leaseMs }).catch(() => {});
    }, Math.max(1000, Math.floor(config.leaseMs / 3)));
    heartbeat.unref?.();
    let run = await store.getRun(runId);
    emit(runId, { type: 'run.started', run });
    const deadline = Date.parse(run.createdAt) + config.maxDurationMs;
    try {
      for (;;) {
        run = await store.getRun(runId);
        if (!run || isTerminalStatus(run.status)) return { run, claimed: true };
        if (run.cancelRequested) {
          await addStep(runId, { kind: 'decide', title: 'إلغاء', summary: 'طُلب الإلغاء بين خطوتين؛ توقفت المهمة دون أثر خارجي.' });
          return { run: await finish(runId, RUN_STATUS.cancelled), claimed: true };
        }
        if (clock() > deadline) {
          return { run: await finish(runId, RUN_STATUS.failed, { error: 'run_timeout' }), claimed: true };
        }
        const steps = await store.listSteps(runId);
        if (steps.length >= config.maxSteps) {
          return { run: await finish(runId, RUN_STATUS.budgetExhausted, { error: 'step_budget_exhausted' }), claimed: true };
        }
        if (run.usage.costMicros >= run.limits.maxCostMicros) {
          return { run: await finish(runId, RUN_STATUS.budgetExhausted, { error: 'cost_budget_exhausted' }), claimed: true };
        }

        // A call that was in flight when the process died is never replayed.
        const openRuns = (await store.listToolRuns(runId)).filter(
          (toolRun) => toolRun.status === TOOL_RUN_STATUS.started || toolRun.status === TOOL_RUN_STATUS.unknown
        );
        if (openRuns.length) {
          for (const toolRun of openRuns) {
            if (toolRun.status === TOOL_RUN_STATUS.started) {
              await store.finishToolRun(toolRun.id, TOOL_RUN_STATUS.unknown, JSON.stringify({ reason: 'process_interrupted' }));
            }
          }
          await addStep(runId, {
            kind: 'observe',
            title: 'مصالحة مطلوبة',
            summary: `الاستدعاء ${openRuns[0].toolName} لم يُحسم قبل الانقطاع؛ لا إعادة تنفيذ عمياء (DEC-007).`,
            toolName: openRuns[0].toolName
          });
          return { run: await finish(runId, RUN_STATUS.needsReconciliation, { error: 'outcome_unknown' }), claimed: true };
        }

        const context = await contextFor(run, controller.signal);
        let decision;
        try {
          decision = await planner.plan(context);
        } catch (error) {
          await addStep(runId, { kind: 'decide', title: 'فشل التخطيط', summary: String(error?.code || 'planner_failed') });
          return { run: await finish(runId, RUN_STATUS.failed, { error: 'planner_failed' }), claimed: true };
        }

        if (decision?.action === 'finish') {
          await addStep(runId, {
            kind: 'deliver',
            title: decision.failed ? 'تسليم بحدود' : 'تسليم',
            summary: String(decision.summary || '')
          });
          return { run: await finish(runId, decision.failed ? RUN_STATUS.failed : RUN_STATUS.succeeded), claimed: true };
        }

        if (decision?.action !== 'call' || typeof decision.tool !== 'string') {
          await addStep(runId, { kind: 'decide', title: 'قرار غير صالح', summary: 'المخطط أعاد قرارًا غير مفهوم؛ أُوقفت المهمة.' });
          return { run: await finish(runId, RUN_STATUS.failed, { error: 'invalid_decision' }), claimed: true };
        }

        const tool = tools.get(decision.tool);
        if (!tool) {
          await addStep(runId, { kind: 'decide', title: 'أداة غير مسجلة', summary: `رفض استدعاء أداة غير موجودة: ${decision.tool}` });
          return { run: await finish(runId, RUN_STATUS.failed, { error: 'unknown_tool' }), claimed: true };
        }
        if (!tools.executable(tool.name)) {
          await addStep(runId, {
            kind: 'decide',
            title: 'موافقة مطلوبة',
            summary: `الأداة ${tool.name} مصنفة ${tool.risk}؛ M1 لا ينفذ أثرًا خارجيًا بلا outbox وموافقة (AGENT-002/AGENT-003).`,
            toolName: tool.name
          });
          return { run: await finish(runId, RUN_STATUS.waitingApproval, { error: 'approval_required' }), claimed: true };
        }

        const step = await addStep(runId, {
          kind: 'act',
          title: decision.tool,
          summary: decision.reason ? String(decision.reason).slice(0, 300) : null,
          toolName: decision.tool
        });
        const idempotencyKey = `${runId}:${step.index}:${tool.name}`;
        const { created, toolRun } = await store.startToolRun({
          runId,
          stepId: step.id,
          toolName: tool.name,
          risk: tool.risk,
          idempotencyKey
        });
        if (!created) {
          if (toolRun.status === TOOL_RUN_STATUS.succeeded) {
            await addStep(runId, { kind: 'observe', title: 'نتيجة محفوظة', summary: 'أُعيد استخدام نتيجة سابقة مطابقة؛ لا تنفيذ ثانٍ.' });
            continue;
          }
          if (toolRun.status === TOOL_RUN_STATUS.started || toolRun.status === TOOL_RUN_STATUS.unknown) {
            return { run: await finish(runId, RUN_STATUS.needsReconciliation, { error: 'outcome_unknown' }), claimed: true };
          }
        }

        const toolController = new AbortController();
        try {
          if (typeof tool.execute !== 'function') throw httpError(501, 'tool_not_executable', 'tool_not_executable');
          const outcome = await withTimeout(
            tool.execute(decision.args || {}, {
              signal: toolController.signal,
              context,
              run,
              runtime: { deadline, remainingSteps: config.maxSteps - steps.length }
            }),
            toolController,
            tool.timeoutMs || config.toolTimeoutMs,
            controller.signal
          );
          await store.finishToolRun(toolRun.id, TOOL_RUN_STATUS.succeeded, JSON.stringify(outcome ?? null));
          const preview = JSON.stringify(outcome ?? null).slice(0, 300);
          await addStep(runId, { kind: 'observe', title: `${tool.name} ✓`, summary: preview, toolName: tool.name });
        } catch (error) {
          const cancelled = error?.code === 'cancelled' || controller.signal.aborted;
          const status = tool.risk === RISK.read ? TOOL_RUN_STATUS.failed : TOOL_RUN_STATUS.unknown;
          await store.finishToolRun(toolRun.id, status, JSON.stringify({ error: error?.code || 'tool_failed' }));
          await addStep(runId, {
            kind: 'observe',
            title: `${tool.name} ✗`,
            summary: `فشل الاستدعاء (${error?.code || 'tool_failed'})؛ الحالة المسجلة ${status}.`,
            toolName: tool.name
          });
          if (cancelled) {
            return { run: await finish(runId, RUN_STATUS.cancelled), claimed: true };
          }
          if (tool.risk !== RISK.read) {
            return { run: await finish(runId, RUN_STATUS.needsReconciliation, { error: 'outcome_unknown' }), claimed: true };
          }
        }
        await store.recordCost(runId, { costMicros: Number(decision.costMicros) || 0, tokens: Number(decision.tokens) || 0 });
      }
    } catch (error) {
      logger.error?.('Agent run failed:', error?.code || 'run_failed');
      const stored = await store.finishRun(runId, RUN_STATUS.failed, { error: 'runtime_error' }).catch(() => null);
      if (stored) emit(runId, { type: 'run.finished', status: RUN_STATUS.failed, run: stored });
      return { run: stored, claimed: true };
    } finally {
      clearInterval(heartbeat);
      controllers.delete(runId);
    }
  }

  const runtime = {
    store,
    status() {
      return {
        enabled: true,
        dialect: store.dialect,
        planner: planner.name,
        ownerId,
        limits: config,
        tools: tools.list(),
        durable: true,
        note:
          store.dialect === 'mysql'
            ? 'الحالة في MySQL؛ الاستئناف والإلغاء يعملان بين العمليات.'
            : 'مخزن SQLite محلي/تجريبي صريح — ليس إنتاجًا وليس بديلًا صامتًا عن MySQL.'
      };
    },
    async submit({ threadId, message, clientMessageId = null } = {}) {
      const thread = await store.getThread(threadId, ownerId);
      if (!thread) throw httpError(404, 'thread_not_found', 'thread_not_found');
      const content = typeof message === 'string' ? message.trim() : '';
      if (!content) throw httpError(400, 'message_required', 'message_required');
      if (content.length > 4000) throw httpError(413, 'message_too_long', 'message_too_long');
      if (clientMessageId !== null && !CLIENT_ID.test(String(clientMessageId))) {
        throw httpError(400, 'invalid_client_message_id', 'invalid_client_message_id');
      }
      const key = clientMessageId || crypto.randomUUID();
      const appended = await store.appendMessage({ threadId, role: 'user', content, clientMessageId: key });
      const created = await store.createRun({
        threadId,
        ownerId,
        userMessageId: appended.message.id,
        clientMessageId: key,
        planner: planner.name,
        maxSteps: config.maxSteps,
        maxCostMicros: config.maxCostMicros
      });
      if (created.created) emit(created.run.id, { type: 'run.created', run: created.run });
      return { run: created.run, created: created.created, duplicate: !created.created };
    },
    async start(runId) {
      if (active.has(runId)) return active.get(runId);
      const promise = executeOnce(runId).finally(() => active.delete(runId));
      active.set(runId, promise);
      return promise;
    },
    async runToCompletion(runId) {
      const result = await runtime.start(runId);
      return result.run;
    },
    async resumePending({ limit = 5 } = {}) {
      const pending = await store.findResumableRuns({ limit });
      const resumed = [];
      for (const run of pending) {
        const result = await runtime.runToCompletion(run.id);
        resumed.push({ runId: run.id, status: result?.status || 'unknown' });
      }
      return { attempted: pending.length, resumed };
    },
    async cancel(runId, requesterId = ownerId) {
      const run = await store.requestCancel(runId, requesterId);
      if (!run) throw httpError(404, 'run_not_found', 'run_not_found');
      const controller = controllers.get(runId);
      if (controller) controller.abort();
      emit(runId, { type: 'run.cancel_requested', run });
      return store.getRun(runId);
    },
    async detail(runId, requesterId = ownerId) {
      const run = await store.getRunForOwner(runId, requesterId);
      if (!run) throw httpError(404, 'run_not_found', 'run_not_found');
      const [steps, toolRuns] = await Promise.all([store.listSteps(runId), store.listToolRuns(runId)]);
      return { run, steps, toolRuns: toolRuns.map((toolRun) => ({ ...toolRun, outcome: parseOutcome(toolRun.outcome) })) };
    },
    async threadDetail(threadId, requesterId = ownerId) {
      const thread = await store.getThread(threadId, requesterId);
      if (!thread) throw httpError(404, 'thread_not_found', 'thread_not_found');
      const [messages, runs] = await Promise.all([store.listMessages(threadId), store.listRuns(threadId)]);
      return { thread, messages, runs };
    },
    subscribe(runId, listener) {
      if (typeof listener !== 'function') throw new Error('listener is required');
      if (!listeners.has(runId)) listeners.set(runId, new Set());
      listeners.get(runId).add(listener);
      return () => {
        listeners.get(runId)?.delete(listener);
        if (!listeners.get(runId)?.size) listeners.delete(runId);
      };
    },
    async shutdown() {
      for (const controller of controllers.values()) controller.abort();
      await Promise.allSettled([...active.values()]);
      await store.close();
    }
  };

  return runtime;
}
