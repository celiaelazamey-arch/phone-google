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
      toolRunId: toolRun ? toolRun.id : null
    };
  });
}
