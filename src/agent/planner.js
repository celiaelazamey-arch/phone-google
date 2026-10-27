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
const SLOT_DURATION_MS = 30 * 60 * 1000;

/**
 * Deterministic proposed slot for an external calendar effect: tomorrow at 10:00 UTC
 * for 30 minutes. It is a *proposal* the owner sees in the outbox payload before
 * approving — never a time the planner invents silently at send time.
 */
function proposedSlot(createdAt) {
  const base = new Date(createdAt);
  if (!Number.isFinite(base.getTime())) return null;
  base.setUTCDate(base.getUTCDate() + 1);
  base.setUTCHours(10, 0, 0, 0);
  return { start: base.toISOString(), end: new Date(base.getTime() + SLOT_DURATION_MS).toISOString() };
}

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

export function createDemoPlanner({ externalEffectTool = 'google.calendar_create_event', knowledge = false } = {}) {
  return {
    name: 'demo-deterministic',
    knowledge,
    async plan({ messages, toolRuns, approvals = [], outbox = [], run = null }) {
      const goal = lastUserMessage(messages);
      const externalApproval = approvals.find((approval) => approval.toolName === externalEffectTool);

      if (knowledge && !succeeded(toolRuns, 'kb.search')) {
        if (failed(toolRuns, 'kb.search')) return this.giveUp(toolRuns, 'kb.search');
        return { action: DECISION.call, tool: 'kb.search', args: { query: goal, limit: 4 } };
      }
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
        if (externalApproval?.decision === 'rejected') {
          return {
            action: DECISION.finish,
            failed: true,
            summary:
              `رُفضت الموافقة على الأثر الخارجي ${externalEffectTool} (${externalApproval.note || 'بلا ملاحظة'}). ` +
              'توقفت المهمة دون أي اتصال خارجي أو أثر، وبقيت القراءات الداخلية فقط محفوظة.'
          };
        }
        // Approved for the first time: decide the call again so the runtime hands the
        // intent to the outbox dispatcher. The planner never sends anything itself.
        const slot = proposedSlot(run?.createdAt);
        return {
          action: DECISION.call,
          tool: externalEffectTool,
          args: {
            summary: goal.slice(0, 180),
            ...(slot || {})
          },
          reason: externalApproval?.decision === 'approved'
            ? 'موافقة مسجلة؛ ينفّذها outbox مرة واحدة عبر مفتاح idempotency'
            : 'الطلب يشير إلى موعد؛ الأثر الخارجي يحتاج موافقة صريحة'
        };
      }
      const draft = outcomeOf(toolRuns, 'celia.draft_outline');
      const status = outcomeOf(toolRuns, 'celia.system_status');
      const evidence = knowledge ? outcomeOf(toolRuns, 'kb.search') : null;
      const externalOutcome = outcomeOf(toolRuns, externalEffectTool);
      const sentEffect = outbox.find((entry) => entry.status === 'sent') || null;
      const failedEffect = outbox.find((entry) => entry.status === 'unknown') || null;
      const steps = draft?.steps || [];
      const citations = (evidence?.items || [])
        .slice(0, 3)
        .map((item) => `- ${item.title} (${item.trust}، ${item.licence}) ${item.uri}`)
        .join('\n');
      const summary = [
        `المخرج: مسودة مخطط من ${steps.length} خطوات لهدف «${(draft?.goal || goal).slice(0, 120)}».`,
        draft?.sentences?.length ? `جمل مفتاحية: ${draft.sentences.slice(0, 3).join(' · ')}` : null,
        evidence?.items?.length ? `أدلة من شبكة المعرفة (${evidence.items.length}، منها ${evidence.entities?.length || 0} كيان):\n${citations}` : null,
        evidence && !evidence.items?.length ? 'لم يجد البحث في شبكة المعرفة دليلًا مطابقًا؛ لم تُختلق مراجع.' : null,
        status ? `حالة النظام المقروءة: الإصدار ${status.version ?? 'غير متاح'}، التخزين ${status.storage ?? 'غير متاح'}.` : null,
        sentEffect
          ? `أُرسل الأثر الخارجي مرة واحدة عبر outbox بعد موافقة مسجلة؛ المرجع ${sentEffect.externalRef || '—'}.`
          : failedEffect
            ? `لم يُحسم الأثر الخارجي (${failedEffect.lastError || 'outcome_unknown'})؛ لا ادعاء بإرسال ولا إعادة محاولة.`
            : 'لم يُنفَّذ أي أثر خارجي؛ أي موعد أو إرسال ينتظر موافقة صريحة ويمرّ بـ outbox.',
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
