import crypto from 'node:crypto';
import { RUN_STATUS, TOOL_RUN_STATUS, APPROVAL_DECISION, isTerminalStatus } from './store.js';
import { RISK } from './tools.js';
import { buildGoalContract } from './goal-contract.js';
import { EVIDENCE_KIND } from './evidence.js';
import { createVerifier, VERDICT } from './verifier.js';

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
  const verifier = createVerifier({ tools, clock });
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
    const [messages, steps, approvals, goalContract] = await Promise.all([
      store.listMessages(run.threadId),
      store.listSteps(run.id),
      store.listApprovals(run.id),
      store.getGoalContract(run.id)
    ]);
    const toolRuns = (await store.listToolRuns(run.id)).map((toolRun) => ({
      ...toolRun,
      parsedOutcome: parseOutcome(toolRun.outcome)
    }));
    return { run, messages, steps, toolRuns, approvals, goalContract, signal, limits: config };
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

  /**
   * Reconstruct ledger coverage for tool runs a crashed process durably recorded but
   * never evidenced. The entry is labelled `tool_call_reconciled` and hashes the stored
   * outcome: it attests to the durable row, never to a call this process witnessed.
   */
  async function backfillToolEvidence(runId, toolRuns, evidenceRows) {
    const covered = new Set();
    for (const entry of evidenceRows) for (const sourceId of entry.sourceIds) covered.add(sourceId);
    let changed = false;
    for (const toolRun of toolRuns) {
      if (covered.has(toolRun.id)) continue;
      await store.appendEvidence({
        runId,
        stepId: toolRun.stepId,
        kind: EVIDENCE_KIND.toolCallReconciled,
        input: { reconstructed: true, reason: 'ledger_write_interrupted' },
        output: parseOutcome(toolRun.outcome),
        sourceIds: [toolRun.id],
        verdict:
          toolRun.status === TOOL_RUN_STATUS.succeeded
            ? VERDICT.pass
            : toolRun.status === TOOL_RUN_STATUS.unknown
              ? VERDICT.unknown
              : VERDICT.block
      });
      changed = true;
    }
    return changed;
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
          // No deliver without an independent verification step (roadmap rule, unit 7).
          const verifyContext = await contextFor(run, controller.signal);
          let priorEvidence = await store.listEvidence(runId);
          if (await backfillToolEvidence(runId, verifyContext.toolRuns, priorEvidence)) {
            priorEvidence = await store.listEvidence(runId);
          }
          const verification = await verifier.verifyRun({
            run: verifyContext.run,
            contract: verifyContext.goalContract,
            steps: verifyContext.steps,
            toolRuns: verifyContext.toolRuns,
            evidence: priorEvidence,
            approvals: verifyContext.approvals,
            messages: verifyContext.messages
          });
          const verifyStep = await addStep(runId, {
            kind: 'verify',
            title: `تحقق مستقل: ${verification.verdict}`,
            summary: verification.checks.map((check) => `${check.id}=${check.status}`).join(' · ').slice(0, 900)
          });
          const verificationEvidence = await store.appendEvidence({
            runId,
            stepId: verifyStep.id,
            kind: EVIDENCE_KIND.verification,
            input: { objective: verification.objective, verifier: verification.version },
            output: verification,
            sourceIds: priorEvidence.map((entry) => entry.id),
            verdict: verification.verdict
          });
          emit(runId, { type: 'verification', verification });
          await addStep(runId, {
            kind: 'deliver',
            title: decision.failed ? 'تسليم بحدود' : 'تسليم',
            summary: String(decision.summary || '')
          });
          await store.appendEvidence({
            runId,
            kind: EVIDENCE_KIND.delivery,
            input: { summary: String(decision.summary || ''), bounded: Boolean(decision.failed) },
            output: { verdict: verification.verdict },
            sourceIds: [verificationEvidence.id]
          });
          if (verification.verdict === VERDICT.block) {
            return { run: await finish(runId, RUN_STATUS.failed, { error: 'verification_blocked' }), claimed: true };
          }
          if (verification.verdict === VERDICT.unknown) {
            return { run: await finish(runId, RUN_STATUS.needsReconciliation, { error: 'verification_unknown' }), claimed: true };
          }
          return {
            run: await finish(runId, decision.failed ? RUN_STATUS.failed : RUN_STATUS.succeeded, decision.failed ? { error: 'bounded_delivery' } : {}),
            claimed: true
          };
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
          const gateStep = await addStep(runId, {
            kind: 'decide',
            title: 'موافقة مطلوبة',
            summary: `الأداة ${tool.name} مصنفة ${tool.risk}؛ لا ينفَّذ أثر خارجي بلا outbox وموافقة مالك مسجلة (AGENT-002/AGENT-003).`,
            toolName: tool.name
          });
          // Idempotent: a re-entered loop reuses the same pending/decided request instead of cloning it.
          const requested = await store.requestApproval({
            runId,
            stepId: gateStep.id,
            toolName: tool.name,
            risk: tool.risk,
            idempotencyKey: `approval:${runId}:${tool.name}`
          });
          const approval = requested.approval;
          if (approval.decision === APPROVAL_DECISION.rejected) {
            await addStep(runId, {
              kind: 'decide',
              title: 'موافقة مرفوضة',
              summary: `المالك رفض الموافقة على ${tool.name}؛ أُوقف التشغيل دون أي أثر خارجي.`,
              toolName: tool.name
            });
            return { run: await finish(runId, RUN_STATUS.cancelled, { error: 'approval_rejected' }), claimed: true };
          }
          if (approval.decision === APPROVAL_DECISION.approved) {
            // Safety net: an approval without the AGENT-002 outbox connector must never fake execution.
            await addStep(runId, {
              kind: 'decide',
              title: 'موافقة بلا منفذ تنفيذ',
              summary: `الموافقة على ${tool.name} مسجلة، لكن منفذ الأثر الخارجي (outbox AGENT-002) غير مبني بعد؛ لا تنفيذ وهمي ولا إعادة محاولة.`,
              toolName: tool.name
            });
            return { run: await finish(runId, RUN_STATUS.failed, { error: 'external_connector_unavailable' }), claimed: true };
          }
          emit(runId, { type: 'approval.requested', approval });
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
          await store.appendEvidence({
            runId,
            stepId: step.id,
            kind: EVIDENCE_KIND.toolCall,
            input: { tool: tool.name, args: decision.args || null },
            output: outcome ?? null,
            sourceIds: [toolRun.id],
            verdict: VERDICT.pass
          });
          const preview = JSON.stringify(outcome ?? null).slice(0, 300);
          await addStep(runId, { kind: 'observe', title: `${tool.name} ✓`, summary: preview, toolName: tool.name });
        } catch (error) {
          const cancelled = error?.code === 'cancelled' || controller.signal.aborted;
          const status = tool.risk === RISK.read ? TOOL_RUN_STATUS.failed : TOOL_RUN_STATUS.unknown;
          await store.finishToolRun(toolRun.id, status, JSON.stringify({ error: error?.code || 'tool_failed' }));
          await store.appendEvidence({
            runId,
            stepId: step.id,
            kind: EVIDENCE_KIND.toolCall,
            input: { tool: tool.name, args: decision.args || null },
            output: { error: error?.code || 'tool_failed', status },
            sourceIds: [toolRun.id],
            verdict: status === TOOL_RUN_STATUS.unknown ? VERDICT.unknown : VERDICT.block
          });
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
        verifier: verifier.name,
        approvalGate: true,
        evidenceLedger: 'sha256-hash-chain-v1',
        ownerId,
        limits: config,
        tools: tools.list(),
        durable: true,
        note:
          store.dialect === 'mysql'
            ? 'الحالة في MySQL؛ الاستئناف والإلغاء وبوابة الموافقات وسجل الأدلة تعمل بين العمليات.'
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
      if (created.created) {
        // Every run carries an inspectable goal contract; its hash anchors the evidence chain.
        const contract = buildGoalContract({ objective: content, limits: config, createdAt: clock() });
        await store.saveGoalContract(created.run.id, contract);
        await store.appendEvidence({
          runId: created.run.id,
          kind: EVIDENCE_KIND.goalContract,
          input: contract,
          output: null,
          sourceIds: [appended.message.id],
          verdict: null
        });
        emit(created.run.id, { type: 'run.created', run: created.run, goalContract: contract });
      }
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
      const [steps, rawToolRuns, goalContract, approvals, evidence, evidenceChain] = await Promise.all([
        store.listSteps(runId),
        store.listToolRuns(runId),
        store.getGoalContract(runId),
        store.listApprovals(runId),
        store.listEvidence(runId),
        store.verifyEvidenceChain(runId)
      ]);
      const toolRuns = rawToolRuns.map((toolRun) => ({ ...toolRun, outcome: parseOutcome(toolRun.outcome) }));
      const verificationEntry = [...evidence].reverse().find((entry) => entry.kind === EVIDENCE_KIND.verification) || null;
      return {
        run,
        steps,
        toolRuns,
        goalContract,
        approvals,
        evidence,
        evidenceChain,
        verification: verificationEntry
          ? { seq: verificationEntry.seq, verdict: verificationEntry.verdict, at: verificationEntry.createdAt, hash: verificationEntry.hash }
          : null
      };
    },
    /**
     * Owner decision on a parked run. The strict rule: an approval never resumes a
     * call whose outcome is `unknown`/`started` — reconciliation comes first.
     */
    async approve(runId, { decision, note = null, idempotencyKey = null } = {}, requesterId = ownerId) {
      const run = await store.getRunForOwner(runId, requesterId);
      if (!run) throw httpError(404, 'run_not_found', 'run_not_found');
      if (![APPROVAL_DECISION.approved, APPROVAL_DECISION.rejected].includes(decision)) {
        throw httpError(400, 'invalid_approval_decision', 'invalid_approval_decision');
      }
      if (run.status !== RUN_STATUS.waitingApproval) {
        // A retried POST carrying the key of a decision already recorded is an idempotent replay.
        if (idempotencyKey) {
          const replay = (await store.listApprovals(runId)).filter((approval) => approval.decisionKey === idempotencyKey);
          if (replay.length) {
            return { run: await store.getRun(runId), approvals: replay, resumed: false, idempotentReplay: true };
          }
        }
        throw httpError(409, 'run_not_waiting_approval', 'run_not_waiting_approval');
      }
      const unresolved = (await store.listToolRuns(runId)).filter(
        (toolRun) => toolRun.status === TOOL_RUN_STATUS.unknown || toolRun.status === TOOL_RUN_STATUS.started
      );
      if (unresolved.length) {
        await store.finishRun(runId, RUN_STATUS.needsReconciliation, { error: 'outcome_unknown' });
        throw httpError(409, 'reconciliation_required', 'reconciliation_required');
      }
      const pending = (await store.listApprovals(runId)).filter(
        (approval) => approval.decision === APPROVAL_DECISION.pending
      );
      if (!pending.length) throw httpError(409, 'approval_request_missing', 'approval_request_missing');
      const decisionKey = idempotencyKey || `decision:${runId}:${pending[0].id}:${decision}`;
      const decided = [];
      for (const approval of pending) {
        const result = await store.decideApproval({
          approvalId: approval.id,
          decision,
          actor: requesterId,
          note,
          decisionKey
        });
        if (!result.approval) continue;
        decided.push(result.approval);
        await store.appendEvidence({
          runId,
          stepId: approval.stepId,
          kind: EVIDENCE_KIND.approval,
          input: { tool: approval.toolName, risk: approval.risk, decision, actor: requesterId, note },
          output: null,
          sourceIds: [approval.id],
          verdict: decision === APPROVAL_DECISION.approved ? VERDICT.pass : VERDICT.block
        });
      }
      emit(runId, { type: 'approval.decided', decision, approvals: decided });
      if (decision === APPROVAL_DECISION.rejected) {
        await addStep(runId, {
          kind: 'decide',
          title: 'موافقة مرفوضة',
          summary: `رفض المالك الأثر الخارجي (${decided.map((approval) => approval.toolName).join('، ')}؛ أُوقف التشغيل دون أي أثر.`
        });
        const cancelled = await finish(runId, RUN_STATUS.cancelled, { error: 'approval_rejected' });
        return { run: cancelled, approvals: decided, resumed: false };
      }
      const requeued = await store.requeueRun(runId);
      const updated = await store.getRun(runId);
      emit(runId, { type: 'run.approved', run: updated });
      if (requeued) {
        runtime.start(runId).catch((error) => logger.error?.('Approved run resume failed:', error?.code || 'resume_failed'));
      }
      return { run: updated, approvals: decided, resumed: requeued };
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
