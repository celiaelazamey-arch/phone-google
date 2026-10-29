import { findSecret } from '../knowledge/validate.js';

/**
 * WP-2.3 — deterministic agent memory.
 *
 * This module deliberately has no clock, randomness, model call, vector index or
 * database handle. The runtime gives it a finished run and its durable steps;
 * the store owns provenance, ownership and persistence. Text supplied by a user
 * or a tool is admitted only after the repository's credential scanner accepts
 * it. A suspicious result is omitted rather than copied into long-term memory.
 */

export const MEMORY_KIND = Object.freeze({
  summary: 'summary',
  fact: 'fact'
});

export const MEMORY_LIMITS = Object.freeze({
  summaryChars: 4000,
  resultChars: 1200,
  factChars: 2000,
  tagChars: 96
});

const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,96}$/;

export function normalizeMemoryKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  if (['summary', 'summaries', 'thread_summary', 'thread-summary'].includes(kind)) return MEMORY_KIND.summary;
  if (['fact', 'facts', 'owner_fact', 'owner-fact'].includes(kind)) return MEMORY_KIND.fact;
  return null;
}

function oneLine(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Return bounded text only when the existing repository secret scan accepts it. */
export function safeMemoryText(value, max = MEMORY_LIMITS.factChars) {
  const cleaned = oneLine(value);
  if (!cleaned || findSecret(cleaned)) return null;
  return cleaned.slice(0, max);
}

function safeStatus(value) {
  const status = oneLine(value).slice(0, 32);
  return status && !findSecret(status) ? status : 'unknown';
}

function orderedSteps(steps) {
  return (Array.isArray(steps) ? steps : [])
    .filter((step) => step && typeof step === 'object')
    .map((step, position) => ({ step, position }))
    .sort((a, b) => {
      const aValue = a.step.index ?? a.step.stepIndex ?? a.step.step_index;
      const bValue = b.step.index ?? b.step.stepIndex ?? b.step.step_index;
      const ai = Number.isFinite(Number(aValue)) ? Number(aValue) : a.position;
      const bi = Number.isFinite(Number(bValue)) ? Number(bValue) : b.position;
      return ai - bi || a.position - b.position;
    })
    .map(({ step }) => step);
}

function toolNamesOf(steps) {
  const names = [];
  for (const step of steps) {
    const name = String(step.toolName || '');
    if (step.kind === 'act' && TOOL_NAME.test(name) && !findSecret(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Build one current thread summary and tagged owner facts from durable steps.
 * Repeating this function with the same input returns byte-identical content.
 */
export function buildMemoryFromSteps({ run = {}, steps = [] } = {}) {
  const ordered = orderedSteps(steps);
  const status = safeStatus(run.status);
  const tools = toolNamesOf(ordered);
  const delivery = [...ordered].reverse().find((step) => step.kind === 'deliver') || null;
  const result = safeMemoryText(delivery?.summary, MEMORY_LIMITS.resultChars);
  const omittedSecret = Boolean(delivery?.summary && !result);

  const statusLine = `حالة التشغيل الأخير: ${status}.`;
  const stepsLine = `عدد الخطوات المسجلة: ${ordered.length}.`;
  const toolsLine = `الأدوات المسجلة: ${tools.length ? tools.join('، ') : 'لا شيء'}.`;
  const resultLine = result
    ? `آخر نتيجة محفوظة: ${result}`
    : omittedSecret
      ? 'حُذف نص النتيجة من الذاكرة لاشتباه سر.'
      : 'لا نتيجة تسليم مسجلة بعد.';

  let summary = [statusLine, stepsLine, toolsLine, resultLine].join('\n');
  // Defense in depth: even a future edit to the composition above cannot persist
  // a credential-shaped string. The fallback contains only controlled values.
  if (findSecret(summary)) {
    summary = [statusLine, stepsLine, 'حُذفت تفاصيل التشغيل من الذاكرة لاشتباه سر.'].join('\n');
  }
  summary = summary.slice(0, MEMORY_LIMITS.summaryChars);

  const facts = [
    { tag: 'owner.last_run_status', value: status },
    { tag: 'owner.last_run_steps', value: String(ordered.length) }
  ];
  if (tools.length) facts.push({ tag: 'owner.last_tools', value: tools.join(',') });
  if (result) facts.push({ tag: 'owner.last_result', value: result });

  return { summary, facts };
}

export function memoryIsSafe(memory = {}) {
  const values = [memory.summary, ...(memory.facts || []).flatMap((fact) => [fact.tag, fact.value])];
  return values.every((value) => !findSecret(value));
}
