/**
 * Planner seam: the runtime asks "what is the next step?" and nothing else.
 *
 * `demo` is a deterministic planner: it proves the loop, persistence, resume,
 * cancellation and risk gate without claiming model reasoning. A provider-backed
 * planner (AI-002) plugs into the same `plan()` contract and must return the same
 * decision shapes; until then no document may describe this as a general agent.
 */

export const DECISION = Object.freeze({
  call: 'call',
  finish: 'finish'
});

const EXTERNAL_HINTS = /(تقويم|موعد|اجتماع|calendar|event|meeting)/i;

function lastUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messages[index].content;
  }
  return '';
}

function succeeded(toolRuns, name) {
  return toolRuns.some((toolRun) => toolRun.toolName === name && toolRun.status === 'succeeded');
}

function failed(toolRuns, name) {
  return toolRuns.some((toolRun) => toolRun.toolName === name && toolRun.status !== 'succeeded');
}

function outcomeOf(toolRuns, name) {
  const found = [...toolRuns].reverse().find((toolRun) => toolRun.toolName === name && toolRun.status === 'succeeded');
  if (!found?.outcome) return null;
  try {
    return JSON.parse(found.outcome);
  } catch {
    return null;
  }
}

export function createDemoPlanner({ externalEffectTool = 'google.calendar_create_event' } = {}) {
  return {
    name: 'demo-deterministic',
    async plan({ messages, toolRuns }) {
      const goal = lastUserMessage(messages);

      if (!succeeded(toolRuns, 'celia.thread_context')) {
        if (failed(toolRuns, 'celia.thread_context')) return this.giveUp(toolRuns, 'celia.thread_context');
        return { action: DECISION.call, tool: 'celia.thread_context', args: {} };
      }
      if (!succeeded(toolRuns, 'celia.system_status')) {
        if (failed(toolRuns, 'celia.system_status')) return this.giveUp(toolRuns, 'celia.system_status');
        return { action: DECISION.call, tool: 'celia.system_status', args: {} };
      }
      if (!succeeded(toolRuns, 'celia.draft_outline')) {
        if (failed(toolRuns, 'celia.draft_outline')) return this.giveUp(toolRuns, 'celia.draft_outline');
        return { action: DECISION.call, tool: 'celia.draft_outline', args: { goal } };
      }
      const externalAttempted = toolRuns.some((toolRun) => toolRun.toolName === externalEffectTool);
      if (EXTERNAL_HINTS.test(goal) && !externalAttempted) {
        return {
          action: DECISION.call,
          tool: externalEffectTool,
          args: { summary: goal.slice(0, 180) },
          reason: 'الطلب يشير إلى موعد؛ الأثر الخارجي يحتاج موافقة صريحة'
        };
      }
      const draft = outcomeOf(toolRuns, 'celia.draft_outline');
      const status = outcomeOf(toolRuns, 'celia.system_status');
      const steps = draft?.steps || [];
      const summary = [
        `المخرج: مسودة مخطط من ${steps.length} خطوات لهدف «${(draft?.goal || goal).slice(0, 120)}».`,
        draft?.sentences?.length ? `جمل مفتاحية: ${draft.sentences.slice(0, 3).join(' · ')}` : null,
        status ? `حالة النظام المقروءة: الإصدار ${status.version ?? 'غير متاح'}، التخزين ${status.storage ?? 'غير متاح'}.` : null,
        'لم يُنفَّذ أي أثر خارجي؛ أي موعد أو إرسال ينتظر موافقة صريحة (AGENT-002).',
        'المخطط تجريبي حتمي وليس استدلالًا عامًا من نموذج.'
      ]
        .filter(Boolean)
        .join('\n');
      return { action: DECISION.finish, summary };
    },
    giveUp(toolRuns, toolName) {
      const lastFailure = [...toolRuns].reverse().find((toolRun) => toolRun.toolName === toolName && toolRun.status !== 'succeeded');
      return {
        action: DECISION.finish,
        summary: `توقفت المهمة: فشل الأداة ${toolName} (${lastFailure?.status || 'failed'}). لم يُعد المحاولة تلقائيًا لأن النتيجة غير مؤكدة.`,
        failed: true
      };
    }
  };
}

/** Deterministic planner for tests: plays the given decisions, then finishes. */
export function createScriptedPlanner(decisions = [], { summary = 'اكتملت المهمة' } = {}) {
  let index = 0;
  const seen = [];
  return {
    name: 'scripted',
    seen,
    async plan(context) {
      seen.push({ toolRuns: context.toolRuns.length });
      if (index < decisions.length) return decisions[index++];
      return { action: DECISION.finish, summary };
    }
  };
}
