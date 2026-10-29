import crypto from 'node:crypto';
import {
  RUN_STATUS,
  TOOL_RUN_STATUS,
  APPROVAL_DECISION,
  PLAN_LIFECYCLE_STATE,
  isTerminalStatus
} from './store.js';
import { RISK } from './tools.js';
import { buildGoalContract } from './goal-contract.js';
import { EVIDENCE_KIND, hashOf } from './evidence.js';
import { createVerifier, VERDICT } from './verifier.js';
import { createOutbox, OUTBOX_STATUS, outboxKey } from './outbox.js';
import { createEmptyConnectorRegistry } from './connectors.js';
import {
  buildPlanSummaryRecord,
  derivePlanView,
  inspectAgentHarness,
  parsePlanSummaryRecord,
  validatePlanEditPolicy,
  verifyApprovedEffectIntegrity
} from './harness.js';
import {
  CELIA_SEVEN_STAGE_LOOP,
  buildTruthPartition,
  computeAgentMetrics,
  recommendTaskStrategy
} from './evaluation.js';
import { deriveNow, timeSteps } from './timing.js';
import { buildMemoryFromSteps, normalizeMemoryKind } from './memory.js';

export { PLAN_LIFECYCLE_STATE };

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

/**
 * A `dispatching` intent is only reconcilable once its lease lapsed: while the lease
 * is live another worker may still be inside the request, and settling it then would
 * contradict a request that is still in flight.
 */
function leaseExpired(entry, now = Date.now()) {
  if (!entry?.leaseUntil) return true;
  const until = Date.parse(entry.leaseUntil);
  return !Number.isFinite(until) || until <= now;
}

export function createAgentRuntime({
  store,
  tools,
  planner,
  // An executor-side allowlist is independent of the prompt/provider contract.
  // Null preserves the existing demo runtime; an array closes tool execution to it.
  plannerToolAllowlist = null,
  ownerId = 'owner',
  limits = {},
  connectors = createEmptyConnectorRegistry(),
  clock = Date.now,
  workerId = `w-${crypto.randomBytes(4).toString('hex')}`,
  logger = console
} = {}) {
  if (!store) throw new Error('Agent runtime requires an explicit durable store');
  if (!tools) throw new Error('Agent runtime requires a tool registry');
  if (!planner?.plan) throw new Error('Agent runtime requires a planner');
  const effectivePlannerAllowlist = plannerToolAllowlist
    ?? (planner.providerDriven ? planner.allowedTools : null);
  if (effectivePlannerAllowlist !== null && (!Array.isArray(effectivePlannerAllowlist)
    || effectivePlannerAllowlist.some((name) => typeof name !== 'string' || !name))) {
    throw new Error('plannerToolAllowlist must be null or an array of tool names');
  }
  const plannerToolSet = effectivePlannerAllowlist === null ? null : new Set(effectivePlannerAllowlist);
  const config = Object.freeze({ ...DEFAULT_LIMITS, ...limits });
  const verifier = createVerifier({ tools, clock });
  const outbox = createOutbox({ store, connectors, clock, workerId: `${workerId}-outbox` });
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

  async function recordProviderEvent({ runId, stepId, kind, input, output, sourceIds = [], verdict = null }) {
    const evidence = await store.appendEvidence({
      runId,
      stepId,
      kind,
      input,
      output,
      sourceIds,
      verdict
    });
    emit(runId, {
      type: kind,
      stepId,
      evidenceId: evidence.id,
      inputHash: evidence.inputHash,
      outputHash: evidence.outputHash,
      verdict
    });
    return evidence;
  }

  async function contextFor(run, signal) {
    const [messages, steps, approvals, goalContract, outboxEntries, memory] = await Promise.all([
      store.listMessages(run.threadId),
      store.listSteps(run.id),
      store.listApprovals(run.id),
      store.getGoalContract(run.id),
      store.listOutbox(run.id),
      store.listMemory(run.ownerId, { threadId: run.threadId, summaryLimit: 1, factLimit: 20 })
    ]);
    const toolRuns = (await store.listToolRuns(run.id)).map((toolRun) => ({
      ...toolRun,
      parsedOutcome: parseOutcome(toolRun.outcome)
    }));
    return {
      run,
      messages,
      steps,
      toolRuns,
      approvals,
      outbox: outboxEntries,
      goalContract,
      signal,
      limits: config,
      memory,
      context_memory: { summaries: true, facts: true }
    };
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

  /**
   * Record a step and emit it (WP-1.2 enriched `step` event). Besides the step itself the event carries what the
   * trace needs without a round trip, all of it readable again from `GET /runs/:id`: the run's `usage`/`limits`
   * (budget bar), `now` (what the loop is doing at this instant) and — when a tool run has just settled —
   * `settledStep`: the earlier `act` step with the duration its tool run proves (`null` when nothing is provable).
   */
  async function addStep(runId, step, { settled = null } = {}) {
    const stored = await store.appendStep({ runId, ...step });
    const run = await store.getRun(runId);
    const [timed] = timeSteps([stored], []);
    const settledStep =
      settled?.step && settled?.toolRun ? timeSteps([settled.step], [settled.toolRun])[0] : null;
    emit(runId, {
      type: 'step',
      step: timed,
      settledStep,
      status: run?.status ?? null,
      usage: run?.usage ?? null,
      limits: run?.limits ?? null,
      now: run ? deriveNow({ run, steps: [timed], at: clock() }) : null
    });
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

  /**
   * Evidence for the durable intent, written exactly once. The gate may be re-entered
   * after a restart, so the check is the ledger itself, not process memory.
   */
  async function ensureEnqueueEvidence(runId, stepId, entry) {
    const evidence = await store.listEvidence(runId);
    if (evidence.some((row) => row.sourceIds.includes(entry.id))) return false;
    await store.appendEvidence({
      runId,
      stepId,
      kind: EVIDENCE_KIND.externalEffectEnqueued,
      input: { tool: entry.toolName, connector: entry.connector, payload: entry.payload },
      output: { outboxId: entry.id, status: entry.status, approvalId: entry.approvalId },
      sourceIds: [entry.id],
      verdict: null
    });
    return true;
  }

  /**
   * Turn one approved intent into at most one request. The tool run is started before
   * the call, so a process that dies mid-flight leaves a `started` row the reconciler
   * turns into `unknown` — never a silent replay.
   */
  async function dispatchExternalEffect({ runId, tool, entry, controller }) {
    const started = await store.startToolRun({
      runId,
      stepId: entry.stepId,
      toolName: tool.name,
      risk: tool.risk,
      idempotencyKey: entry.idempotencyKey
    });
    if (!started.created) {
      if (started.toolRun.status === TOOL_RUN_STATUS.succeeded) {
        return { status: OUTBOX_STATUS.sent, outcome: started.toolRun.parsedOutcome ?? null, reused: true };
      }
      if (started.toolRun.status === TOOL_RUN_STATUS.started || started.toolRun.status === TOOL_RUN_STATUS.unknown) {
        return { status: OUTBOX_STATUS.unknown, outcome: null, reused: true };
      }
    }
    const toolRun = started.toolRun;
    const dispatched = await outbox.dispatch(entry.id, { signal: controller.signal });
    const outcome = {
      outboxId: entry.id,
      outboxStatus: dispatched.status,
      externalRef: dispatched.entry?.externalRef ?? null,
      providerResult: dispatched.entry?.result ?? null,
      error: dispatched.error ?? null,
      lastError: dispatched.entry?.lastError ?? null
    };
    const toolStatus =
      dispatched.status === OUTBOX_STATUS.sent
        ? TOOL_RUN_STATUS.succeeded
        : dispatched.status === OUTBOX_STATUS.failed
          ? TOOL_RUN_STATUS.failed
          : TOOL_RUN_STATUS.unknown;
    await store.finishToolRun(toolRun.id, toolStatus, JSON.stringify(outcome));
    await store.appendEvidence({
      runId,
      stepId: entry.stepId,
      kind: EVIDENCE_KIND.externalEffectSettled,
      input: { tool: tool.name, outboxId: entry.id, idempotencyKey: entry.idempotencyKey },
      output: outcome,
      sourceIds: [entry.id, toolRun.id],
      verdict:
        dispatched.status === OUTBOX_STATUS.sent
          ? VERDICT.pass
          : dispatched.status === OUTBOX_STATUS.unknown
            ? VERDICT.unknown
            : VERDICT.block
    });
    return { status: dispatched.status, outcome, error: dispatched.error ?? null, toolRunId: toolRun.id };
  }

  /**
   * Settle one intent and say what the run must do next. Used by both entry points:
   * the gate (planner asked again while approved) and the resume drain (approved
   * intents are dispatched even if the planner never repeats the call).
   */
  async function handleExternalEffect({ runId, entry, approval = null, controller }) {
    const tool = tools.get(entry.toolName);
    if (!tool) {
      await addStep(runId, {
        kind: 'decide',
        title: 'أداة غير مسجلة',
        summary: `النية الخارجية تشير إلى أداة غير مسجلة: ${entry.toolName}`
      });
      return { finish: { status: RUN_STATUS.failed, error: 'unknown_tool' } };
    }
    const resolvedApproval =
      approval || (await store.listApprovals(runId)).find((item) => item.id === entry.approvalId) || null;
    const integrity = verifyApprovedEffectIntegrity({ entry, approval: resolvedApproval });
    if (!integrity.ok) {
      await store.appendEvidence({
        runId,
        stepId: entry.stepId,
        kind: EVIDENCE_KIND.externalEffectSettled,
        input: { tool: tool.name, outboxId: entry.id, approvalId: entry.approvalId },
        output: { error: integrity.code, reason: integrity.reason },
        sourceIds: [entry.id, ...(resolvedApproval ? [resolvedApproval.id] : [])],
        verdict: VERDICT.block
      });
      await addStep(runId, {
        kind: 'decide',
        title: 'منع تغيير صامت للخطة المعتمدة',
        summary: `رفضت بوابة الموافقات تنفيذ ${tool.name} (${integrity.code}): بصمة الحمولة لا تطابق القرار المعتمد.`,
        toolName: tool.name
      });
      return { finish: { status: RUN_STATUS.failed, error: integrity.code } };
    }
    const existingRun = await store.getRun(runId);
    const prevPlan = parsePlanSummaryRecord(existingRun?.planSummary);
    await store.setPlanSummary(
      runId,
      JSON.stringify(
        buildPlanSummaryRecord({
          revision: prevPlan?.revision || 1,
          state: PLAN_LIFECYCLE_STATE.executing,
          toolName: tool.name,
          risk: tool.risk,
          connector: entry.connector,
          payload: entry.payload,
          transitions: [
            ...(prevPlan?.transitions || [
              PLAN_LIFECYCLE_STATE.planReady,
              PLAN_LIFECYCLE_STATE.waitingForApproval,
              PLAN_LIFECYCLE_STATE.approved
            ]),
            PLAN_LIFECYCLE_STATE.executing
          ]
        })
      )
    );
    const effect = await dispatchExternalEffect({ runId, tool, entry, controller });
    if (effect.status === OUTBOX_STATUS.sent) {
      await addStep(runId, {
        kind: 'observe',
        title: `${tool.name} ✓ (outbox)`,
        summary: `أُرسل الأثر الخارجي مرة واحدة بعد موافقة مسجلة؛ المرجع ${effect.outcome?.externalRef || '—'}.`,
        toolName: tool.name
      });
      return { sent: true };
    }
    if (effect.status === OUTBOX_STATUS.failed) {
      const unavailable = effect.error === 'connector_unavailable';
      await addStep(runId, {
        kind: 'decide',
        title: unavailable ? 'موافقة بلا منفذ تنفيذ' : 'فشل الأثر الخارجي',
        summary: unavailable
          ? `الموافقة على ${tool.name} مسجلة، لكن لا موصل مُهيَّأ لهذا الأثر؛ أُغلقت النية كفشل مؤكد دون أي طلب خارجي.`
          : `رفض الموصل الطلب قبل أي أثر (${effect.error}); النية مسجلة failed ولا إعادة محاولة.`,
        toolName: tool.name
      });
      return {
        finish: {
          status: RUN_STATUS.failed,
          error: unavailable ? 'external_connector_unavailable' : 'external_effect_failed'
        }
      };
    }
    // unknown / still in progress: reconciliation first, never a replay (DEC-007).
    await addStep(runId, {
      kind: 'observe',
      title: 'أثر خارجي غير محسوم',
      summary: `لم يُحسم إرسال ${tool.name} (${effect.error || 'outcome_unknown'}); لا إعادة إرسال عمياء والمصالحة مطلوبة.`,
      toolName: tool.name
    });
    return { finish: { status: RUN_STATUS.needsReconciliation, error: 'outcome_unknown' } };
  }

  /** Dispatch every approved-and-still-pending intent. Returns a terminal run, or null. */
  async function drainApprovedIntents(runId, controller) {
    const [entries, approvals] = await Promise.all([store.listOutbox(runId), store.listApprovals(runId)]);
    const approvedById = new Map(
      approvals
        .filter((approval) => approval.decision === APPROVAL_DECISION.approved)
        .map((approval) => [approval.id, approval])
    );
    const ready = entries.filter(
      (entry) => entry.status === OUTBOX_STATUS.pending && entry.approvalId && approvedById.has(entry.approvalId)
    );
    for (const entry of ready) {
      const handled = await handleExternalEffect({
        runId,
        entry,
        approval: approvedById.get(entry.approvalId) || null,
        controller
      });
      if (handled.finish) {
        return finish(runId, handled.finish.status, { error: handled.finish.error });
      }
    }
    return null;
  }

  /** Persist deterministic long-term memory immediately before run.finished. */
  async function updateMemory(run) {
    const steps = await store.listSteps(run.id);
    const next = buildMemoryFromSteps({ run, steps });
    const summary = await store.saveThreadSummary({
      threadId: run.threadId,
      ownerId: run.ownerId,
      sourceRunId: run.id,
      summary: next.summary,
      expiresAt: null
    });
    const facts = [];
    for (const fact of next.facts) {
      facts.push(await store.saveOwnerFact({
        ownerId: run.ownerId,
        sourceRunId: run.id,
        tag: fact.tag,
        value: fact.value,
        expiresAt: null
      }));
    }
    return { summaries: true, facts: true, summary, savedFacts: facts };
  }

  async function finish(runId, status, { error = null } = {}) {
    const run = await store.finishRun(runId, status, { error });
    const memory = await updateMemory(run);
    emit(runId, { type: 'run.finished', status, run, memory });
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

        // Approved intents are dispatched here, before the planner is asked anything:
        // the outbox is the sender, so a planner that forgets to repeat its call can
        // never strand an approved external effect.
        const drained = await drainApprovedIntents(runId, controller);
        if (drained) return { run: drained, claimed: true };

        const context = await contextFor(run, controller.signal);
        let decision;
        let planEvidence = null;
        try {
          decision = await planner.plan(context);
        } catch (error) {
          const failureStep = await addStep(runId, {
            kind: 'decide',
            title: 'فشل التخطيط',
            summary: String(error?.code || 'planner_failed')
          });
          if (error?.providerTrace) {
            await recordProviderEvent({
              runId,
              stepId: failureStep.id,
              kind: EVIDENCE_KIND.planCreated,
              input: error.providerTrace.request,
              output: {
                valid: false,
                code: error.code || 'planner_failed',
                details: error.details || [],
                plan: error.providerTrace.plan ?? null
              },
              verdict: VERDICT.block
            });
          }
          return {
            run: await finish(runId, RUN_STATUS.failed, { error: error?.providerTrace ? error.code : 'planner_failed' }),
            claimed: true
          };
        }
        if (decision?.plannerFallback) {
          // A1: فشل مزوّد قابل للتحويل — يُسجَّل علنًا خطوةً ودليل BLOCK قبل متابعة القرار الحتمي.
          const fb = decision.plannerFallback;
          const fallbackStep = await addStep(runId, {
            kind: 'decide',
            title: 'planner_fallback',
            summary: `فشل مزوّد التخطيط (${fb.code})؛ تحويل مرئي إلى المسار الحتمي (${fb.mode}).`
          });
          await recordProviderEvent({
            runId,
            stepId: fallbackStep.id,
            kind: EVIDENCE_KIND.planCreated,
            input: fb.providerTrace?.request ?? { provider: fb.provider || null },
            output: {
              valid: false,
              code: fb.code,
              details: fb.details || [],
              plan: fb.providerTrace?.plan ?? null,
              fallback: { stage: fb.stage, mode: fb.mode, provider: fb.provider || null }
            },
            verdict: VERDICT.block
          });
        }
        if (decision?.providerTrace) {
          // A2: مراجعة محكومة تُعنون `plan.revised` وتُربط بالخطوة الفاشلة في السلسلة —
          // العنوان نفسه هو مصدر العدّ الحتمي لسياسة إعادة التخطيط (REVISION_STEP_TITLE).
          const revision = decision.planRevision || null;
          const planStep = await addStep(runId, {
            kind: 'decide',
            title: revision ? 'plan.revised' : `خطة النموذج: ${decision.providerTrace.plan?.action || decision.action}`,
            summary: revision
              ? `مراجعة محكومة ${revision.attempt}/${revision.maxPerStep} بعد فشل ${revision.failedTool}: ${String(decision.reason || '').slice(0, 700)}`
              : String(decision.reason || '').slice(0, 900),
            toolName: decision.action === 'call' ? decision.tool : null
          });
          planEvidence = await recordProviderEvent({
            runId,
            stepId: planStep.id,
            kind: EVIDENCE_KIND.planCreated,
            input: decision.providerTrace.request,
            output: {
              valid: true,
              plan: decision.providerTrace.plan,
              usage: decision.providerTrace.usage,
              ...(revision ? { revision } : {})
            },
            verdict: VERDICT.pass
          });
          if (decision.costMicros > 0 || decision.tokens > 0) {
            await store.recordCost(runId, { costMicros: decision.costMicros || 0, tokens: decision.tokens || 0 });
          }
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
            outbox: verifyContext.outbox,
            messages: verifyContext.messages
          });
          const verifyStep = await addStep(runId, {
            kind: 'verify',
            title: `تحقق مستقل: ${verification.verdict}`,
            summary: verification.checks.map((check) => `${check.id}=${check.status}`).join(' · ').slice(0, 900)
          });
          const verificationInput = {
            runId,
            stepId: verifyStep.id,
            input: { objective: verification.objective, verifier: verification.version },
            output: verification,
            sourceIds: priorEvidence.map((entry) => entry.id),
            verdict: verification.verdict
          };
          const verificationEvidence = decision.providerTrace
            ? await recordProviderEvent({ ...verificationInput, kind: EVIDENCE_KIND.verificationResult })
            : await store.appendEvidence({ ...verificationInput, kind: EVIDENCE_KIND.verification });
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
          const rejectedStep = await addStep(runId, { kind: 'decide', title: 'أداة غير مسجلة', summary: `رفض استدعاء أداة غير موجودة: ${decision.tool}` });
          if (decision.providerTrace) {
            await recordProviderEvent({
              runId,
              stepId: rejectedStep.id,
              kind: EVIDENCE_KIND.toolSelected,
              input: decision.providerTrace.plan,
              output: { allowed: false, tool: decision.tool, reason: 'unknown_tool' },
              sourceIds: planEvidence ? [planEvidence.id] : [],
              verdict: VERDICT.block
            });
          }
          return { run: await finish(runId, RUN_STATUS.failed, { error: 'unknown_tool' }), claimed: true };
        }
        if (plannerToolSet && !plannerToolSet.has(tool.name)) {
          const rejectedStep = await addStep(runId, {
            kind: 'decide',
            title: 'أداة خارج نطاق المخطط',
            summary: `رفض ${tool.name} في المنفذ: الأداة غير موجودة في plannerToolAllowlist؛ لم تبدأ أي موافقة أو كتابة.`,
            toolName: tool.name
          });
          if (decision.providerTrace) {
            await recordProviderEvent({
              runId,
              stepId: rejectedStep.id,
              kind: EVIDENCE_KIND.toolSelected,
              input: decision.providerTrace.plan,
              output: { allowed: false, tool: tool.name, reason: 'planner_tool_not_allowed' },
              sourceIds: planEvidence ? [planEvidence.id] : [],
              verdict: VERDICT.block
            });
          }
          return { run: await finish(runId, RUN_STATUS.failed, { error: 'planner_tool_not_allowed' }), claimed: true };
        }
        const inputValidation = decision.providerTrace || plannerToolSet
          ? tools.validateInput(tool.name, decision.args ?? {})
          : { ok: true };
        if (!inputValidation.ok) {
          const rejectedStep = await addStep(runId, {
            kind: 'decide',
            title: 'مدخلات أداة غير صالحة',
            summary: `رفض المنفذ مدخلات ${tool.name}: ${inputValidation.code}`,
            toolName: tool.name
          });
          if (decision.providerTrace) {
            await recordProviderEvent({
              runId,
              stepId: rejectedStep.id,
              kind: EVIDENCE_KIND.toolSelected,
              input: decision.providerTrace.plan,
              output: { allowed: false, tool: tool.name, reason: inputValidation.code },
              sourceIds: planEvidence ? [planEvidence.id] : [],
              verdict: VERDICT.block
            });
          }
          return { run: await finish(runId, RUN_STATUS.failed, { error: inputValidation.code }), claimed: true };
        }
        if (!tools.executable(tool.name)) {
          const gateStep = await addStep(runId, {
            kind: 'decide',
            title: 'موافقة مطلوبة',
            summary: `الأداة ${tool.name} مصنفة ${tool.risk}؛ لا ينفَّذ أثر خارجي بلا outbox وموافقة مالك مسجلة (AGENT-002/AGENT-003).`,
            toolName: tool.name
          });
          // Idempotent: a re-entered loop reuses the same pending/decided request instead of cloning it.
          // An approval authorises an exact effect, not a tool name. Binding the key to
          // the canonical payload hash means a retry that changes the payload can never
          // ride on an earlier decision: it parks for a new one.
          const requested = await store.requestApproval({
            runId,
            stepId: gateStep.id,
            toolName: tool.name,
            risk: tool.risk,
            idempotencyKey: `approval:${runId}:${tool.name}:${hashOf(decision.args ?? null).slice(0, 12)}`
          });
          const approval = requested.approval;
          // The intent is durable before the decision exists: the owner approves an exact
          // payload, and a crash can never lose the request or mint a second one.
          const enqueued = await outbox.enqueue({
            runId,
            stepId: gateStep.id,
            approvalId: approval.id,
            toolName: tool.name,
            connector: tool.connector,
            payload: decision.args ?? null
          });
          await ensureEnqueueEvidence(runId, gateStep.id, enqueued.entry);
          if (enqueued.created) emit(runId, { type: 'outbox.enqueued', entry: enqueued.entry });

          if (approval.decision === APPROVAL_DECISION.rejected) {
            await store.cancelPendingOutbox(runId);
            await store.setPlanSummary(
              runId,
              JSON.stringify(
                buildPlanSummaryRecord({
                  revision: 1,
                  state: PLAN_LIFECYCLE_STATE.rejected,
                  toolName: tool.name,
                  risk: tool.risk,
                  connector: tool.connector,
                  payload: decision.args ?? null,
                  transitions: [
                    PLAN_LIFECYCLE_STATE.planReady,
                    PLAN_LIFECYCLE_STATE.waitingForApproval,
                    PLAN_LIFECYCLE_STATE.rejected
                  ]
                })
              )
            );
            await addStep(runId, {
              kind: 'decide',
              title: 'موافقة مرفوضة',
              summary: `المالك رفض الموافقة على ${tool.name}؛ أُلغيت النية في outbox ولم يُرسل أي طلب خارجي.`,
              toolName: tool.name
            });
            return { run: await finish(runId, RUN_STATUS.cancelled, { error: 'approval_rejected' }), claimed: true };
          }
          if (approval.decision === APPROVAL_DECISION.approved) {
            const handled = await handleExternalEffect({ runId, entry: enqueued.entry, approval, controller });
            if (handled.finish) {
              return {
                run: await finish(runId, handled.finish.status, { error: handled.finish.error }),
                claimed: true
              };
            }
            continue;
          }
          await store.setPlanSummary(
            runId,
            JSON.stringify(
              buildPlanSummaryRecord({
                revision: 1,
                state: PLAN_LIFECYCLE_STATE.waitingForApproval,
                toolName: tool.name,
                risk: tool.risk,
                connector: tool.connector,
                payload: decision.args ?? null,
                transitions: [PLAN_LIFECYCLE_STATE.planReady, PLAN_LIFECYCLE_STATE.waitingForApproval]
              })
            )
          );
          emit(runId, { type: 'approval.requested', approval });
          return { run: await finish(runId, RUN_STATUS.waitingApproval, { error: 'approval_required' }), claimed: true };
        }

        const step = await addStep(runId, {
          kind: 'act',
          title: decision.tool,
          summary: decision.reason ? String(decision.reason).slice(0, 300) : null,
          toolName: decision.tool
        });
        const selectionEvidence = decision.providerTrace
          ? await recordProviderEvent({
              runId,
              stepId: step.id,
              kind: EVIDENCE_KIND.toolSelected,
              input: decision.providerTrace.plan,
              output: { allowed: true, tool: tool.name, args: decision.args ?? {} },
              sourceIds: planEvidence ? [planEvidence.id] : [],
              verdict: VERDICT.pass
            })
          : null;
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
          const settledToolRun = await store.finishToolRun(toolRun.id, TOOL_RUN_STATUS.succeeded, JSON.stringify(outcome ?? null));
          const toolEvidenceInput = {
            runId,
            stepId: step.id,
            input: { tool: tool.name, args: decision.args || null },
            output: outcome ?? null,
            sourceIds: decision.providerTrace
              ? [selectionEvidence?.id, toolRun.id].filter(Boolean)
              : [toolRun.id],
            verdict: VERDICT.pass
          };
          if (decision.providerTrace) {
            await recordProviderEvent({ ...toolEvidenceInput, kind: EVIDENCE_KIND.toolExecuted });
          } else {
            await store.appendEvidence({ ...toolEvidenceInput, kind: EVIDENCE_KIND.toolCall });
          }
          const preview = JSON.stringify(outcome ?? null).slice(0, 300);
          await addStep(
            runId,
            { kind: 'observe', title: `${tool.name} ✓`, summary: preview, toolName: tool.name },
            { settled: { step, toolRun: settledToolRun } }
          );
        } catch (error) {
          const cancelled = error?.code === 'cancelled' || controller.signal.aborted;
          const status = tool.risk === RISK.read ? TOOL_RUN_STATUS.failed : TOOL_RUN_STATUS.unknown;
          const settledToolRun = await store.finishToolRun(toolRun.id, status, JSON.stringify({ error: error?.code || 'tool_failed' }));
          const toolEvidenceInput = {
            runId,
            stepId: step.id,
            input: { tool: tool.name, args: decision.args || null },
            output: { error: error?.code || 'tool_failed', status },
            sourceIds: decision.providerTrace
              ? [selectionEvidence?.id, toolRun.id].filter(Boolean)
              : [toolRun.id],
            verdict: status === TOOL_RUN_STATUS.unknown ? VERDICT.unknown : VERDICT.block
          };
          if (decision.providerTrace) {
            await recordProviderEvent({ ...toolEvidenceInput, kind: EVIDENCE_KIND.toolExecuted });
          } else {
            await store.appendEvidence({ ...toolEvidenceInput, kind: EVIDENCE_KIND.toolCall });
          }
          await addStep(
            runId,
            {
              kind: 'observe',
              title: `${tool.name} ✗`,
              summary: `فشل الاستدعاء (${error?.code || 'tool_failed'})؛ الحالة المسجلة ${status}.`,
              toolName: tool.name
            },
            { settled: { step, toolRun: settledToolRun } }
          );
          if (cancelled) {
            return { run: await finish(runId, RUN_STATUS.cancelled), claimed: true };
          }
          if (tool.risk !== RISK.read) {
            return { run: await finish(runId, RUN_STATUS.needsReconciliation, { error: 'outcome_unknown' }), claimed: true };
          }
        }
        if (!decision.providerTrace) {
          await store.recordCost(runId, { costMicros: Number(decision.costMicros) || 0, tokens: Number(decision.tokens) || 0 });
        }
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
        plannerToolAllowlist: plannerToolSet ? [...plannerToolSet] : null,
        verifier: verifier.name,
        approvalGate: true,
        evidenceLedger: 'sha256-hash-chain-v1',
        outbox: 'transactional-single-dispatch-v1',
        connectors: connectors.list(),
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
    /**
     * What a process must do when it comes back — after a crash, a deploy, or a free
     * tier waking from sleep. Order matters and nothing here re-sends anything:
     *   1. outbox rows a vanished dispatcher left `dispatching` become `unknown`
     *      (the outcome is exactly what is unknown; reconciliation decides, DEC-007/015);
     *   2. runs left `queued`/`running` with an expired lease resume from their last
     *      confirmed step; one whose call is unresolved parks in `needs_reconciliation`.
     * The report carries ids and statuses only — never message or payload content.
     */
    async recoverOnBoot({ limit = 5, staleLimit = 50 } = {}) {
      const startedAt = clock();
      const stale = await outbox.recoverStale({ limit: staleLimit });
      const pending = await runtime.resumePending({ limit });
      return {
        at: new Date(startedAt).toISOString(),
        durationMs: Math.max(0, clock() - startedAt),
        staleOutbox: stale.recovered.map((entry) => ({ id: entry.id, runId: entry.runId, status: entry.status })),
        runs: pending
      };
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
      const [rawSteps, rawToolRuns, goalContract, approvals, evidence, evidenceChain, outboxEntries] = await Promise.all([
        store.listSteps(runId),
        store.listToolRuns(runId),
        store.getGoalContract(runId),
        store.listApprovals(runId),
        store.listEvidence(runId),
        store.verifyEvidenceChain(runId),
        store.listOutbox(runId)
      ]);
      const toolRuns = rawToolRuns.map((toolRun) => ({ ...toolRun, outcome: parseOutcome(toolRun.outcome) }));
      // WP-1.1: every step carries the duration its tool run proves (or null) — nothing is estimated.
      const steps = timeSteps(rawSteps, toolRuns);
      const verificationEntry = [...evidence].reverse().find((entry) => (
        entry.kind === EVIDENCE_KIND.verification || entry.kind === EVIDENCE_KIND.verificationResult
      )) || null;
      const verification = verificationEntry
        ? { seq: verificationEntry.seq, verdict: verificationEntry.verdict, at: verificationEntry.createdAt, hash: verificationEntry.hash }
        : null;
      const plan = derivePlanView({
        run,
        goalContract,
        steps,
        approvals,
        outbox: outboxEntries,
        toolRuns,
        verification
      });
      const truthPartition = buildTruthPartition({
        run,
        toolRuns,
        approvals,
        outbox: outboxEntries,
        verification,
        evidenceChain
      });
      // WP-1.2: "now" is part of the detail so the trace UI never shows a fact that is not in GET /runs/:id.
      const now = deriveNow({ run, steps, approvals, at: clock() });
      return {
        run,
        plan,
        truthPartition,
        now,
        steps,
        toolRuns,
        goalContract,
        approvals,
        outbox: outboxEntries,
        evidence,
        evidenceChain,
        verification
      };
    },
    async metrics(requesterId = ownerId, { limit = 20 } = {}) {
      const threads = await store.listThreads(requesterId, { limit });
      const runDetails = [];
      for (const thread of threads) {
        const runs = await store.listRuns(thread.id);
        for (const r of runs.slice(0, 10)) {
          const detail = await runtime.detail(r.id, requesterId);
          runDetails.push(detail);
        }
      }
      return {
        loopStages: CELIA_SEVEN_STAGE_LOOP,
        metrics: computeAgentMetrics(runDetails),
        strategyExamples: [
          recommendTaskStrategy({ taskType: 'pricing_and_invoices' }),
          recommendTaskStrategy({ taskType: 'document_extraction' }),
          recommendTaskStrategy({ taskType: 'text_summarization_classification' }),
          recommendTaskStrategy({ taskType: 'complex_technical_analysis' }),
          recommendTaskStrategy({ taskType: 'creative_design_and_ads' }),
          recommendTaskStrategy({ taskType: 'external_site_or_tool_actions' })
        ]
      };
    },
    async memory(requesterId = ownerId, options = {}) {
      return store.listMemory(requesterId, options);
    },
    async memoryItem(kind, id, requesterId = ownerId, options = {}) {
      const normalized = normalizeMemoryKind(kind);
      const memoryId = typeof id === 'string' ? id.trim() : '';
      if (!normalized) throw httpError(400, 'invalid_memory_kind', 'invalid_memory_kind');
      if (!memoryId || memoryId.length > 128) throw httpError(400, 'invalid_memory_id', 'invalid_memory_id');
      const item = await store.getMemoryItem(normalized, memoryId, requesterId, options);
      if (!item) throw httpError(404, 'memory_not_found', 'memory_not_found');
      return item;
    },
    async deleteMemory(kind, id, requesterId = ownerId) {
      const normalized = normalizeMemoryKind(kind);
      const memoryId = typeof id === 'string' ? id.trim() : '';
      if (!normalized) throw httpError(400, 'invalid_memory_kind', 'invalid_memory_kind');
      if (!memoryId || memoryId.length > 128) throw httpError(400, 'invalid_memory_id', 'invalid_memory_id');
      const result = await store.deleteMemory(normalized, memoryId, requesterId);
      if (!result.deleted) throw httpError(404, result.reason || 'memory_not_found', result.reason || 'memory_not_found');
      return result;
    },
    harness() {
      return inspectAgentHarness({
        store,
        tools,
        planner,
        verifier,
        connectors,
        limits: config
      });
    },
    /**
     * Edit a parked plan (`PLAN_READY → WAITING_FOR_APPROVAL → EDITED → WAITING_FOR_APPROVAL`).
     *
     * Saves the owner's modification, re-validates policies against the tool contract,
     * marks the previous approval row `edited`, creates a new pending approval bound to
     * the new payload hash, updates the pending outbox intent, appends a `plan_edited`
     * entry to the SHA-256 evidence chain, and keeps the run in `waiting_approval`
     * until the owner explicitly approves or rejects the edited version.
     */
    async editPlan(
      runId,
      { payload = null, summary = null, note = null, idempotencyKey = null } = {},
      requesterId = ownerId
    ) {
      const run = await store.getRunForOwner(runId, requesterId);
      if (!run) throw httpError(404, 'run_not_found', 'run_not_found');
      if (idempotencyKey !== null && !CLIENT_ID.test(String(idempotencyKey))) {
        throw httpError(400, 'invalid_client_message_id', 'invalid_client_message_id');
      }
      if (idempotencyKey) {
        const existingApprovals = await store.listApprovals(runId);
        const replay = existingApprovals.filter(
          (approval) => approval.decision === APPROVAL_DECISION.edited && approval.decisionKey === idempotencyKey
        );
        if (replay.length) {
          const detail = await runtime.detail(runId, requesterId);
          return {
            run: detail.run,
            plan: detail.plan,
            editedApproval: replay[0],
            pendingApproval: detail.approvals.find((item) => item.decision === APPROVAL_DECISION.pending) || null,
            approvals: detail.approvals,
            outbox: detail.outbox,
            resumed: false,
            idempotentReplay: true
          };
        }
      }
      if (run.status !== RUN_STATUS.waitingApproval) {
        throw httpError(409, 'run_not_waiting_approval', 'run_not_waiting_approval');
      }
      const unresolved = (await store.listToolRuns(runId)).filter(
        (toolRun) => toolRun.status === TOOL_RUN_STATUS.unknown || toolRun.status === TOOL_RUN_STATUS.started
      );
      if (unresolved.length) {
        await store.finishRun(runId, RUN_STATUS.needsReconciliation, { error: 'outcome_unknown' });
        throw httpError(409, 'reconciliation_required', 'reconciliation_required');
      }
      const allApprovals = await store.listApprovals(runId);
      const pending = allApprovals.filter((approval) => approval.decision === APPROVAL_DECISION.pending);
      if (!pending.length) throw httpError(409, 'approval_request_missing', 'approval_request_missing');
      const currentApproval = pending[pending.length - 1];
      const tool = tools.get(currentApproval.toolName);
      const requestedToolName =
        summary && typeof summary === 'object' && typeof summary.toolName === 'string' ? summary.toolName : null;
      const policyCheck = validatePlanEditPolicy({ tool, payload, requestedToolName, tools });
      if (!policyCheck.ok) {
        throw httpError(policyCheck.status || 400, policyCheck.code, policyCheck.message);
      }

      const outboxEntries = await store.listOutbox(runId);
      const pendingOutbox =
        outboxEntries.find(
          (entry) => entry.approvalId === currentApproval.id && entry.status === OUTBOX_STATUS.pending
        ) ||
        outboxEntries.find(
          (entry) => entry.toolName === currentApproval.toolName && entry.status === OUTBOX_STATUS.pending
        );
      if (!pendingOutbox) {
        throw httpError(409, 'outbox_intent_not_editable', 'outbox_intent_not_editable');
      }

      const memo = typeof note === 'string' ? note.trim().slice(0, 500) || null : null;
      const newPayloadHash = hashOf(payload);
      const decisionKey =
        idempotencyKey || `edit:${runId}:${currentApproval.id}:${newPayloadHash.slice(0, 12)}`;
      const decidedEdit = await store.decideApproval({
        approvalId: currentApproval.id,
        decision: APPROVAL_DECISION.edited,
        actor: requesterId,
        note: memo,
        decisionKey
      });

      const revision =
        allApprovals.filter((approval) => approval.decision === APPROVAL_DECISION.edited).length + 2;
      const editStep = await addStep(runId, {
        kind: 'decide',
        title: `تعديل الخطة (مراجعة #${revision})`,
        summary:
          `حُفظ تعديل المالك (${requesterId}) على خطة ${tool.name} وأُعيد التحقق من السياسات بنجاح؛ ` +
          `الخطة بانتظار الموافقة على النسخة المعدّلة.${memo ? ` ملاحظة: ${memo}` : ''}`,
        toolName: tool.name
      });

      const nextApprovalKey = `approval:${runId}:${tool.name}:${newPayloadHash.slice(0, 12)}:r${revision}`;
      const nextRequested = await store.requestApproval({
        runId,
        stepId: editStep.id,
        toolName: tool.name,
        risk: tool.risk,
        idempotencyKey: nextApprovalKey
      });
      const nextApproval = nextRequested.approval;
      const nextOutboxKey = outboxKey({ runId, toolName: tool.name, payload });
      const updatedOutbox = await store.updatePendingOutboxPayload(pendingOutbox.id, {
        payload,
        idempotencyKey: nextOutboxKey,
        approvalId: nextApproval.id,
        stepId: editStep.id
      });
      if (!updatedOutbox.changed) {
        throw httpError(409, 'outbox_intent_not_editable', 'outbox_intent_not_editable');
      }

      await store.appendEvidence({
        runId,
        stepId: editStep.id,
        kind: EVIDENCE_KIND.planEdited,
        input: {
          tool: tool.name,
          revision,
          previousPayloadHash: pendingOutbox.payloadHash,
          newPayloadHash,
          payload,
          actor: requesterId,
          note: memo
        },
        output: {
          outboxId: updatedOutbox.entry.id,
          previousApprovalId: currentApproval.id,
          pendingApprovalId: nextApproval.id,
          policyCheck: 'PASS'
        },
        sourceIds: [currentApproval.id, nextApproval.id, updatedOutbox.entry.id],
        verdict: VERDICT.pass
      });

      const prevPlan = parsePlanSummaryRecord(run.planSummary);
      const transitions = [
        ...(prevPlan?.transitions || [
          PLAN_LIFECYCLE_STATE.planReady,
          PLAN_LIFECYCLE_STATE.waitingForApproval
        ]),
        PLAN_LIFECYCLE_STATE.edited,
        PLAN_LIFECYCLE_STATE.waitingForApproval
      ];
      await store.setPlanSummary(
        runId,
        JSON.stringify(
          buildPlanSummaryRecord({
            revision,
            state: PLAN_LIFECYCLE_STATE.waitingForApproval,
            toolName: tool.name,
            risk: tool.risk,
            connector: tool.connector,
            payload,
            note: memo,
            transitions
          })
        )
      );

      emit(runId, {
        type: 'plan.edited',
        revision,
        editedApproval: decidedEdit.approval,
        approval: nextApproval,
        outbox: updatedOutbox.entry
      });
      emit(runId, { type: 'approval.requested', approval: nextApproval });

      const detail = await runtime.detail(runId, requesterId);
      return {
        run: detail.run,
        plan: detail.plan,
        editedApproval: decidedEdit.approval,
        pendingApproval: nextApproval,
        approvals: detail.approvals,
        outbox: detail.outbox,
        resumed: false,
        idempotentReplay: false
      };
    },
    /**
     * Owner decision on a parked run. The strict rule: an approval never resumes a
     * call whose outcome is `unknown`/`started` — reconciliation comes first.
     * Supports `approved`, `rejected`, and `edited` (which delegates to `editPlan`).
     */
    async approve(
      runId,
      { decision, payload = null, summary = null, note = null, idempotencyKey = null } = {},
      requesterId = ownerId
    ) {
      if (decision === APPROVAL_DECISION.edited) {
        return runtime.editPlan(runId, { payload, summary, note, idempotencyKey }, requesterId);
      }
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
            const detail = await runtime.detail(runId, requesterId);
            return { run: detail.run, plan: detail.plan, approvals: replay, resumed: false, idempotentReplay: true };
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
      const prevPlan = parsePlanSummaryRecord(run.planSummary);
      const baseTransitions = prevPlan?.transitions || [
        PLAN_LIFECYCLE_STATE.planReady,
        PLAN_LIFECYCLE_STATE.waitingForApproval
      ];
      emit(runId, { type: 'approval.decided', decision, approvals: decided });
      if (decision === APPROVAL_DECISION.rejected) {
        // The intent never leaves the outbox: cancelling it is the whole effect of a rejection.
        const cancelledIntents = await store.cancelPendingOutbox(runId);
        await store.setPlanSummary(
          runId,
          JSON.stringify(
            buildPlanSummaryRecord({
              revision: prevPlan?.revision || 1,
              state: PLAN_LIFECYCLE_STATE.rejected,
              toolName: decided[0]?.toolName || prevPlan?.toolName || null,
              risk: decided[0]?.risk || prevPlan?.risk || null,
              connector: prevPlan?.connector || null,
              note,
              transitions: [...baseTransitions, PLAN_LIFECYCLE_STATE.rejected]
            })
          )
        );
        await addStep(runId, {
          kind: 'decide',
          title: 'موافقة مرفوضة',
          summary:
            `رفض المالك الأثر الخارجي (${decided.map((approval) => approval.toolName).join('، ')}؛ ` +
            `أُلغيت ${cancelledIntents} نية في outbox ولم يُرسل أي طلب.`
        });
        const cancelled = await finish(runId, RUN_STATUS.cancelled, { error: 'approval_rejected' });
        const detail = await runtime.detail(runId, requesterId);
        return { run: cancelled, plan: detail.plan, approvals: decided, resumed: false };
      }
      await store.setPlanSummary(
        runId,
        JSON.stringify(
          buildPlanSummaryRecord({
            revision: prevPlan?.revision || 1,
            state: PLAN_LIFECYCLE_STATE.approved,
            toolName: decided[0]?.toolName || prevPlan?.toolName || null,
            risk: decided[0]?.risk || prevPlan?.risk || null,
            connector: prevPlan?.connector || null,
            note,
            transitions: [...baseTransitions, PLAN_LIFECYCLE_STATE.approved]
          })
        )
      );
      const requeued = await store.requeueRun(runId);
      const updated = await store.getRun(runId);
      const detail = await runtime.detail(runId, requesterId);
      emit(runId, { type: 'run.approved', run: updated, plan: detail.plan });
      if (requeued) {
        runtime.start(runId).catch((error) => logger.error?.('Approved run resume failed:', error?.code || 'resume_failed'));
      }
      return { run: updated, plan: detail.plan, approvals: decided, resumed: requeued };
    },
    /**
     * Everything in this run whose truth is still unknown. Reconciliation is complete
     * only when both lists are empty — the same predicate the approval gate uses, so
     * the two can never disagree.
     */
    async unresolvedFor(runId) {
      const [toolRuns, outboxEntries] = await Promise.all([store.listToolRuns(runId), store.listOutbox(runId)]);
      return {
        toolRuns: toolRuns.filter(
          (toolRun) => toolRun.status === TOOL_RUN_STATUS.unknown || toolRun.status === TOOL_RUN_STATUS.started
        ),
        outbox: outboxEntries.filter(
          (entry) => entry.status === OUTBOX_STATUS.unknown || (entry.status === OUTBOX_STATUS.dispatching && leaseExpired(entry))
        )
      };
    },
    /**
     * Owner resolution of an uncertain outcome — the missing exit from
     * `needs_reconciliation`.
     *
     * This path is deliberately narrow: it changes bookkeeping only. It never calls a
     * connector, never re-sends, and never rewrites a settled row. The owner states a
     * finding (`applied` / `not_applied`), that finding is hashed into the evidence
     * chain, and the run is requeued only when nothing uncertain is left.
     */
    async reconcile(
      runId,
      { target, targetId, outcome, externalRef = null, note = null, idempotencyKey = null, resume = false } = {},
      requesterId = ownerId
    ) {
      const run = await store.getRunForOwner(runId, requesterId);
      if (!run) throw httpError(404, 'run_not_found', 'run_not_found');
      if (!['tool_run', 'outbox'].includes(target)) throw httpError(400, 'invalid_reconcile_target', 'invalid_reconcile_target');
      if (!['applied', 'not_applied'].includes(outcome)) {
        throw httpError(400, 'invalid_reconcile_outcome', 'invalid_reconcile_outcome');
      }
      if (typeof targetId !== 'string' || !targetId.trim()) {
        throw httpError(400, 'reconcile_target_required', 'reconcile_target_required');
      }
      const reference = typeof externalRef === 'string' ? externalRef.trim().slice(0, 240) || null : null;
      const memo = typeof note === 'string' ? note.trim().slice(0, 500) || null : null;
      const at = new Date(clock()).toISOString();
      const verdict = outcome === 'applied' ? VERDICT.pass : VERDICT.block;
      // Deterministic by construction: `at` is deliberately excluded so the same
      // decision replayed with the same idempotency key hashes identically, and the
      // ledger — not process memory — decides whether it was already recorded.
      const finding = {
        target,
        targetId,
        outcome,
        externalRef: reference,
        note: memo,
        actor: requesterId,
        ...(idempotencyKey ? { idempotencyKey } : {})
      };

      // A retried POST carrying a key already recorded is an idempotent replay, never
      // a second write to the chain.
      if (idempotencyKey) {
        const inputHash = hashOf(finding);
        const existing = (await store.listEvidence(runId)).find(
          (entry) => entry.kind === EVIDENCE_KIND.reconciliation && entry.inputHash === inputHash
        );
        if (existing) {
          return {
            run: await store.getRun(runId),
            reconciliation: { outcome, target, targetId, sourceIds: existing.sourceIds, seq: existing.seq },
            remaining: await runtime.unresolvedFor(runId),
            idempotentReplay: true
          };
        }
      }

      const toolRuns = await store.listToolRuns(runId);
      const outboxEntries = await store.listOutbox(runId);
      const settledToolStatus = outcome === 'applied' ? TOOL_RUN_STATUS.succeeded : TOOL_RUN_STATUS.failed;
      const settledOutboxStatus = outcome === 'applied' ? OUTBOX_STATUS.sent : OUTBOX_STATUS.failed;
      const sourceIds = [];
      let retryRequested = false;

      const applyToolRun = async (toolRun) => {
        const written = await store.reconcileToolRun(toolRun.id, {
          status: settledToolStatus,
          outcome: { ...finding, reconciled: true, at }
        });
        // Lost a race: another request already settled this row. Report the conflict,
        // do not pretend the decision was applied.
        if (!written.changed) throw httpError(409, 'target_not_reconcilable', 'target_not_reconcilable');
        sourceIds.push(toolRun.id);
        return written.toolRun;
      };

      const applyOutbox = async (entry) => {
        const written = await store.reconcileOutboxEntry(entry.id, {
          status: settledOutboxStatus,
          externalRef: outcome === 'applied' ? reference : null,
          result: { ...finding, reconciled: true, at },
          lastError: outcome === 'applied' ? 'reconciled_by_owner' : 'reconciled_not_applied',
          at
        });
        if (!written.changed) throw httpError(409, 'target_not_reconcilable', 'target_not_reconcilable');
        sourceIds.push(entry.id);
        return written.entry;
      };

      const isUncertainToolRun = (toolRun) =>
        toolRun && (toolRun.status === TOOL_RUN_STATUS.unknown || toolRun.status === TOOL_RUN_STATUS.started);
      const isUncertainOutbox = (entry) =>
        entry && (entry.status === OUTBOX_STATUS.unknown || (entry.status === OUTBOX_STATUS.dispatching && leaseExpired(entry)));

      if (target === 'tool_run') {
        const toolRun = toolRuns.find((item) => item.id === targetId);
        // A target from another run is not merely wrong, it must not be disclosed.
        if (!toolRun) throw httpError(400, 'target_not_in_run', 'target_not_in_run');
        if (!isUncertainToolRun(toolRun)) throw httpError(409, 'target_not_reconcilable', 'target_not_reconcilable');
        await applyToolRun(toolRun);
        // One decision, one truth: the intent that produced this call moves with it.
        const paired = outboxEntries.find((entry) => entry.idempotencyKey === toolRun.idempotencyKey);
        if (isUncertainOutbox(paired)) await applyOutbox(paired);
      } else {
        const entry = outboxEntries.find((item) => item.id === targetId);
        if (!entry) throw httpError(400, 'target_not_in_run', 'target_not_in_run');
        if (entry.status === OUTBOX_STATUS.failed) {
          // A `failed` intent already proves nothing reached the provider, so there is
          // nothing to decide: the owner is only authorising a retry. Re-confirming an
          // effect that was never sent would be a fiction, so `applied` is refused.
          if (outcome !== 'not_applied' || resume !== true) {
            throw httpError(409, 'target_not_reconcilable', 'target_not_reconcilable');
          }
          retryRequested = true;
          sourceIds.push(entry.id);
        } else {
          if (!isUncertainOutbox(entry)) throw httpError(409, 'target_not_reconcilable', 'target_not_reconcilable');
          await applyOutbox(entry);
          const paired = toolRuns.find((item) => item.idempotencyKey === entry.idempotencyKey);
          if (isUncertainToolRun(paired)) await applyToolRun(paired);
        }
      }

      await store.appendEvidence({
        runId,
        kind: EVIDENCE_KIND.reconciliation,
        input: finding,
        output: { outcome, settledStatus: target === 'tool_run' ? settledToolStatus : settledOutboxStatus, sourceIds, at },
        sourceIds,
        verdict
      });
      await addStep(runId, {
        kind: 'decide',
        title: retryRequested
          ? 'إعادة محاولة مصرّح بها'
          : outcome === 'applied'
            ? 'مصالحة: الأثر موجود'
            : 'مصالحة: الأثر غير موجود',
        summary:
          (retryRequested
            ? `أذن المالك (${requesterId}) بإعادة محاولة نية فاشلة ثبت أنها لم تصل (${targetId})؛ ` +
              'ستبقى في outbox بنفس المفتاح ولن تُرسل إلا بعد قرار مسجل.'
            : `قرر المالك (${requesterId}) أن النتيجة «${outcome}» لـ${target === 'outbox' ? 'نية خارجية' : 'استدعاء أداة'} ` +
              `${targetId}${reference ? `؛ المرجع ${reference}` : ''}. لم يُرسل أي طلب من هذا المسار.`) +
          (memo ? ` ملاحظة: ${memo}` : '')
      });
      emit(runId, { type: 'reconciliation.recorded', runId, target, targetId, outcome, sourceIds });

      const remaining = await runtime.unresolvedFor(runId);
      const resolvedNothingLeft = remaining.toolRuns.length === 0 && remaining.outbox.length === 0;
      let resumed = false;
      if (retryRequested) {
        if (!resolvedNothingLeft) {
          await store.finishRun(runId, RUN_STATUS.needsReconciliation, { error: 'outcome_unknown' });
        } else if ([RUN_STATUS.failed, RUN_STATUS.needsReconciliation].includes(run.status)) {
          resumed = await store.requeueRun(runId, { from: [RUN_STATUS.failed, RUN_STATUS.needsReconciliation] });
        }
      } else if (!resolvedNothingLeft) {
        if (run.status !== RUN_STATUS.needsReconciliation) {
          await store.finishRun(runId, RUN_STATUS.needsReconciliation, { error: 'outcome_unknown' });
        }
      } else if (run.status === RUN_STATUS.needsReconciliation) {
        resumed = await store.requeueRun(runId, { from: [RUN_STATUS.needsReconciliation] });
      } else if (run.status === RUN_STATUS.failed && resume === true) {
        // Explicit manual retry (AGENT-002). Safe only because nothing is uncertain:
        // a `failed` intent proved nothing reached the provider and is reused by key.
        resumed = await store.requeueRun(runId, { from: [RUN_STATUS.failed] });
      }
      if (resumed) {
        emit(runId, { type: 'run.reconciled', runId, resumed: true });
        runtime.start(runId).catch((error) => logger.error?.('Reconciled run resume failed:', error?.code || 'resume_failed'));
      }
      return {
        run: await store.getRun(runId),
        reconciliation: { outcome, target, targetId, sourceIds, resumed },
        remaining,
        idempotentReplay: false
      };
    },
    async threadDetail(threadId, requesterId = ownerId) {
      const thread = await store.getThread(threadId, requesterId);
      if (!thread) throw httpError(404, 'thread_not_found', 'thread_not_found');
      const [messages, runs] = await Promise.all([store.listMessages(threadId), store.listRuns(threadId)]);
      return { thread, messages, runs };
    },
    async deleteThread(threadId, requesterId = ownerId) {
      const result = await store.deleteThread(threadId, requesterId);
      if (!result.deleted) {
        if (result.reason === 'thread_not_found') {
          throw httpError(404, 'thread_not_found', 'thread_not_found');
        }
        throw httpError(409, result.reason || 'thread_delete_blocked', result.reason || 'thread_delete_blocked');
      }
      return result;
    },
    async exportAuditBundle(runId, requesterId = ownerId) {
      const detail = await runtime.detail(runId, requesterId);
      const bundleBody = {
        schema_version: '1.0',
        capability: 'agent_audit_bundle',
        run: detail.run,
        goalContract: detail.goalContract,
        plan: detail.plan,
        truthPartition: detail.truthPartition,
        steps: detail.steps,
        toolRuns: detail.toolRuns,
        approvals: detail.approvals,
        outbox: detail.outbox,
        evidence: detail.evidence,
        evidenceChain: detail.evidenceChain,
        verification: detail.verification
      };
      return {
        ...bundleBody,
        exported_at: new Date(clock()).toISOString(),
        bundle_sha256: hashOf(bundleBody)
      };
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
