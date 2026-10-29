/**
 * Durations the loop can *prove* from timestamps it already writes (WP-1.1, AGENT-008, DEC-047).
 *
 * No migration and no estimate: a tool run's duration is `updated_at − created_at` only when the row was settled by
 * the runtime itself (`succeeded`/`failed` through `finishToolRun`). Rows still `started`, rows the process lost
 * (`unknown`) and rows a human reconciled later (`outcome.reconciled === true` — their `updated_at` is the owner's
 * decision time, not the tool's) have no measurable duration and report `null`, never `0`.
 *
 * Percentiles use the nearest-rank definition (rank = ⌈p/100 · n⌉) so every reported value is an observed sample.
 */

export const SETTLED_TOOL_STATUSES = Object.freeze(['succeeded', 'failed']);

function parseOutcome(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Accepts a raw store row (snake_case) or a mapped tool run (camelCase). */
export function toolRunDurationMs(toolRun) {
  if (!toolRun || typeof toolRun !== 'object') return null;
  if (!SETTLED_TOOL_STATUSES.includes(toolRun.status)) return null;
  const outcome = parseOutcome(toolRun.outcome);
  if (outcome && typeof outcome === 'object' && outcome.reconciled === true) return null;
  const startMs = Date.parse(String(toolRun.createdAt ?? toolRun.created_at ?? ''));
  const endMs = Date.parse(String(toolRun.updatedAt ?? toolRun.updated_at ?? ''));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return endMs - startMs;
}

/** Nearest-rank percentile over finite numbers; `null` when there is nothing to report. */
export function percentile(values, p) {
  const sorted = (Array.isArray(values) ? values : [])
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const share = Math.min(100, Math.max(0, Number(p) || 0)) / 100;
  const rank = Math.max(1, Math.ceil(share * sorted.length));
  return sorted[rank - 1];
}

export function summarizeDurations(values) {
  const finite = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value));
  return {
    count: finite.length,
    p50Ms: percentile(finite, 50),
    p95Ms: percentile(finite, 95),
    maxMs: finite.length ? Math.max(...finite) : null
  };
}

/**
 * Attach `startedAt` / `finishedAt` / `durationMs` / `toolRunId` to steps from the tool run that references them.
 * Steps without a tool run (decide, deliver, approval gates) keep `durationMs: null`: the store records when they
 * were written, not how long they took, and this module does not guess.
 */
export function timeSteps(steps = [], toolRuns = []) {
  const byStep = new Map();
  for (const toolRun of toolRuns) {
    if (toolRun?.stepId && !byStep.has(toolRun.stepId)) byStep.set(toolRun.stepId, toolRun);
  }
  return steps.map((step) => {
    const toolRun = byStep.get(step.id) || null;
    const durationMs = toolRun ? toolRunDurationMs(toolRun) : null;
    return {
      ...step,
      startedAt: step.createdAt ?? null,
      finishedAt: durationMs === null ? null : toolRun.updatedAt,
      durationMs,
      toolRunId: toolRun ? toolRun.id : null,
      // WP-1.2: the stored status of that tool run (`started`/`succeeded`/`failed`/`unknown`) so a trace can say
      // *why* a duration is missing. `null` when no tool run references the step.
      toolRunStatus: toolRun ? toolRun.status ?? null : null
    };
  });
}

export const NOW_STATE = Object.freeze({
  queued: 'queued',
  planning: 'planning',
  executingTool: 'executing_tool',
  waitingApproval: 'waiting_approval',
  needsReconciliation: 'needs_reconciliation',
  finished: 'finished'
});

const TERMINAL_RUN_STATUSES = Object.freeze(['succeeded', 'failed', 'cancelled', 'budget_exhausted']);

function parseMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  return Date.parse(String(value ?? ''));
}

function sinceFields(iso, atMs) {
  const ms = parseMs(iso);
  if (!Number.isFinite(ms)) return { since: null, elapsedMs: null };
  return {
    since: new Date(ms).toISOString(),
    elapsedMs: Number.isFinite(atMs) && atMs >= ms ? atMs - ms : null
  };
}

/**
 * What the run is doing *now* (WP-1.2, AGENT-008) — derived only from stored facts: the run status, the last
 * recorded step with its tool run status, and the pending approval. `since` is the timestamp of the fact that put
 * the run in this state, `elapsedMs` is `at − since`, `totalMs` is the run's age (or its full length once finished).
 * Nothing is predicted; a run whose last step is a tool call still `started` is "executing", anything else that
 * is `running` is "planning" (the planner is being asked). Returns `null` without a run.
 */
export function deriveNow({ run, steps = [], approvals = [], at = Date.now() } = {}) {
  if (!run || typeof run !== 'object') return null;
  const atMs = parseMs(at);
  const last = Array.isArray(steps) && steps.length ? steps[steps.length - 1] : null;
  const createdMs = parseMs(run.createdAt);
  const base = {
    status: run.status ?? null,
    stepId: last?.id ?? null,
    stepIndex: last?.index ?? null,
    toolName: null,
    totalMs: Number.isFinite(createdMs) && Number.isFinite(atMs) && atMs >= createdMs ? atMs - createdMs : null
  };
  if (run.status === 'queued') {
    return { state: NOW_STATE.queued, ...base, ...sinceFields(run.createdAt, atMs) };
  }
  if (run.status === 'waiting_approval') {
    const pending = (Array.isArray(approvals) ? approvals : []).find((item) => item?.decision === 'pending') || null;
    return {
      state: NOW_STATE.waitingApproval,
      ...base,
      toolName: pending?.toolName ?? last?.toolName ?? null,
      ...sinceFields(pending?.createdAt ?? run.updatedAt, atMs)
    };
  }
  if (run.status === 'needs_reconciliation') {
    return {
      state: NOW_STATE.needsReconciliation,
      ...base,
      toolName: last?.toolName ?? null,
      ...sinceFields(run.updatedAt, atMs)
    };
  }
  if (run.status === 'running') {
    const toolOpen = last?.kind === 'act' && (last.toolRunStatus === null || last.toolRunStatus === undefined || last.toolRunStatus === 'started');
    if (toolOpen) {
      return {
        state: NOW_STATE.executingTool,
        ...base,
        toolName: last.toolName ?? last.title ?? null,
        ...sinceFields(last.createdAt, atMs)
      };
    }
    return { state: NOW_STATE.planning, ...base, ...sinceFields(last?.createdAt ?? run.updatedAt ?? run.createdAt, atMs) };
  }
  // Terminal (or unknown) status: the run is over; `totalMs` becomes its proven length.
  const endMs = parseMs(run.finishedAt ?? run.updatedAt);
  return {
    state: NOW_STATE.finished,
    ...base,
    terminal: TERMINAL_RUN_STATUSES.includes(run.status),
    since: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null,
    elapsedMs: null,
    totalMs: Number.isFinite(createdMs) && Number.isFinite(endMs) && endMs >= createdMs ? endMs - createdMs : null
  };
}
