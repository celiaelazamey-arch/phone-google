/**
 * Delegation between agents (UX-005 / DEC-099): the first of the three P1 gaps in `multi_agent`.
 *
 * The system today runs **one** agent through a durable harness. «تفويض المهام بين وكلاء» means a
 * parent run hands a bounded task to a child agent — and the honest risk in that sentence is not the
 * spawning, it is the arithmetic: a child that receives a larger budget, a weaker risk ceiling or a
 * tool the parent never had is a privilege escalation wearing the word «delegation».
 *
 * So the contract comes first, and it is pure: given a parent's *remaining* budget and ceiling, a
 * roster of agents, and a list of requested tasks, it decides — task by task, by name — what may be
 * delegated and what is refused. It never widens, never rounds a budget up, and never invents an
 * agent. A budget that does not fit is refused with the remainder stated, not silently trimmed: a
 * child told it has 12 steps when it has 5 is worse than a child that never started.
 *
 * Four invariants, each one a test:
 *
 *   1. **No widening.** child risk ≤ parent ceiling, and every tool a child may use is one the
 *      parent already holds (when the parent declares an allowlist).
 *   2. **No inflation.** Σ accepted steps ≤ parent remaining steps; the same for micro-costs.
 *   3. **No unbounded recursion.** depth is capped, so delegation cannot become an infinite tree.
 *   4. **No orphan.** every child spec carries the parent run id and a digest of the parent's
 *      identity and evidence, so a child's result can always be traced to who asked for it.
 *
 * Deliberately absent: scheduling, wake-ups, a queue of its own, and any claim to have run the child.
 * The plan says `executes: false` because executing is the runtime's job (`runtime.delegate`), and a
 * contract that pretends to have done it would be the exact kind of lie this repository bans.
 */
import { createHash } from 'node:crypto';

import { findSecret } from '../knowledge/validate.js';
import { RISK } from './tools.js';

export const DELEGATION_VERSION = 'celiaos-delegation-v1';

/** A root run is depth 0; its children are 1. Two hops is the ceiling: a tree, not a fractal. */
export const MAX_DEPTH = 2;

/** More than four children per parent is parallel chaos, not collaboration. */
export const MAX_FANOUT = 4;

/** Ordered from the least to the most consequential, so «≤» means «no more power than». */
export const RISK_ORDER = Object.freeze({ [RISK.read]: 0, [RISK.internalWrite]: 1, [RISK.externalEffect]: 2, [RISK.irreversible]: 3 });

export const REFUSAL = Object.freeze({
  unknown_agent: 'الوكيل المطلوب غير موجود في السجل',
  depth_exceeded: 'سقف عمق التفويض بلغ آخره',
  fanout_exceeded: 'سقف عدد الأطفال لكل أب',
  risk_widening: 'مهمة الطفل أخطر من سقف أبيها',
  tool_not_granted: 'أداة ليست في نطاق الأب أو في قدرات الوكيل',
  budget_exhausted: 'الميزانية المتبقية لا تكفي هذه المهمة',
  invalid_amount: 'خطوات أو تكلفة غير صالحة',
  duplicate_task: 'معرّف مهمة مكرر',
  empty_objective: 'مهمة بلا هدف مكتوب',
  objective_carries_secret: 'هدف يحمل ما يشبه سرًّا',
  no_parent: 'لا أب صالح لهذا التفويض',
  parent_closed: 'تشغيل الأب منتهٍ ولا يفوض'
});

const RISK_NAMES = Object.keys(RISK_ORDER);

const digits = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
};

const sha = (value) => createHash('sha256').update(String(value)).digest('hex');

/** A title that looks like a credential is dropped, never copied into a child spec. */
function cleanText(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { text: '', secret: false };
  if (findSecret(text)) return { text: '', secret: true };
  return { text: text.slice(0, 500), secret: false };
}

/**
 * The parent digest is what a child points back at: the run, its ceiling, and the evidence it already
 * collected. Two parents with the same id but a different ceiling are not the same authority.
 */
export function parentDigest({ runId, maxRisk = RISK.read, depth = 0, evidenceIds = [] }) {
  const ids = [...evidenceIds].map(String).sort().join(',');
  return sha(`${runId}|${maxRisk}|${depth}|${ids}`).slice(0, 12);
}

const riskAtMost = (candidate, ceiling) => (RISK_ORDER[candidate] ?? Infinity) <= (RISK_ORDER[ceiling] ?? -1);

function agentById(roster, id) {
  const list = Array.isArray(roster) ? roster : [];
  return list.find((agent) => agent && String(agent.id) === String(id)) || null;
}

/**
 * Decide which requested tasks a parent may hand out.
 *
 * `parent`  — `{ runId, status, depth, remainingSteps, remainingCostMicros, maxRisk, tools?, evidenceIds? }`
 * `tasks`   — `[{ taskId, agent, objective, steps, costMicros, risk?, tools? }]`
 * `roster`  — `[{ id, tools: [], maxRisk }]`
 *
 * Tasks are visited in `taskId` order so the same request always yields the same plan, whatever order
 * it arrived in. A task that does not fit is refused with the remaining budget it missed — never
 * shrunk to fit.
 */
export function planDelegation({ parent, tasks, roster = [] } = {}, { now = null } = {}) {
  const at = now || new Date().toISOString();
  const problems = [];
  const accepted = [];

  const parentRunId = parent?.runId ? String(parent.runId) : null;
  const parentDepth = digits(parent?.depth) ?? 0;
  const parentRisk = RISK_ORDER[parent?.maxRisk] !== undefined ? parent.maxRisk : RISK.read;
  const parentTools = Array.isArray(parent?.tools) && parent.tools.length ? parent.tools.map(String) : null;
  const remainingSteps = digits(parent?.remainingSteps) ?? 0;
  const remainingCost = digits(parent?.remainingCostMicros) ?? 0;

  if (!parentRunId) problems.push({ code: 'no_parent', taskId: null, detail: REFUSAL.no_parent });
  if (parent?.status && !['queued', 'running', 'waiting_approval'].includes(String(parent.status))) {
    problems.push({ code: 'parent_closed', taskId: null, detail: REFUSAL.parent_closed });
  }

  const blocked = new Set(problems.map((problem) => problem.code));
  const childDepth = parentDepth + 1;
  const canDelegate = !blocked.has('no_parent') && !blocked.has('parent_closed');
  const depthOk = childDepth <= MAX_DEPTH;

  const seen = new Set();
  let stepsLeft = remainingSteps;
  let costLeft = remainingCost;

  const ordered = [...(Array.isArray(tasks) ? tasks : [])].sort((a, b) =>
    String(a?.taskId ?? '').localeCompare(String(b?.taskId ?? ''), 'en')
  );

  for (const task of ordered) {
    const taskId = task?.taskId ? String(task.taskId) : null;
    const refuse = (code, detail = '') => problems.push({ code, taskId, detail: detail || REFUSAL[code] || code });

    // A blocked parent is already named once above; repeating it per task would invent refusals
    // that belong to the parent, not to any single task.
    if (!canDelegate) continue;
    if (!taskId) {
      refuse('empty_objective', 'مهمة بلا معرّف');
      continue;
    }
    if (seen.has(taskId)) {
      refuse('duplicate_task');
      continue;
    }
    seen.add(taskId);

    if (!depthOk) {
      refuse('depth_exceeded', `${REFUSAL.depth_exceeded} (العمق ${childDepth} > ${MAX_DEPTH})`);
      continue;
    }
    if (accepted.length >= MAX_FANOUT) {
      refuse('fanout_exceeded');
      continue;
    }

    const agent = agentById(roster, task.agent);
    if (!agent) {
      refuse('unknown_agent', `${REFUSAL.unknown_agent}: ${String(task.agent ?? '—')}`);
      continue;
    }

    const objective = cleanText(task.objective);
    if (objective.secret) {
      refuse('objective_carries_secret');
      continue;
    }
    if (!objective.text) {
      refuse('empty_objective');
      continue;
    }

    const steps = digits(task.steps);
    const costMicros = digits(task.costMicros);
    if (steps === null || costMicros === null || steps < 1) {
      refuse('invalid_amount');
      continue;
    }

    // Risk may not exceed the parent's ceiling, nor the agent's own declaration.
    const asked = task.risk ? String(task.risk) : RISK_ORDER[agent.maxRisk] !== undefined ? agent.maxRisk : RISK.read;
    if (RISK_ORDER[asked] === undefined) {
      refuse('risk_widening', `درجة خطر غير معروفة: ${asked}`);
      continue;
    }
    if (!riskAtMost(asked, parentRisk) || (agent.maxRisk && !riskAtMost(asked, agent.maxRisk))) {
      refuse('risk_widening', `${REFUSAL.risk_widening}: ${asked} > ${parentRisk}`);
      continue;
    }

    // Tools: only what the parent holds *and* the agent declares.
    const askedTools = Array.isArray(task.tools) && task.tools.length ? task.tools.map(String) : [...(agent.tools || [])];
    const granted = (agent.tools || []).map(String);
    const outsideAgent = askedTools.filter((tool) => !granted.includes(tool));
    const outsideParent = parentTools ? askedTools.filter((tool) => !parentTools.includes(tool)) : [];
    if (outsideAgent.length || outsideParent.length) {
      const named = [...new Set([...outsideAgent, ...outsideParent])].join(', ');
      refuse('tool_not_granted', `${REFUSAL.tool_not_granted}: ${named}`);
      continue;
    }

    if (steps > stepsLeft || costMicros > costLeft) {
      refuse('budget_exhausted', `${REFUSAL.budget_exhausted}: طُلب ${steps} خطوة/${costMicros}µ والمتبقي ${stepsLeft}/${costLeft}`);
      continue;
    }

    stepsLeft -= steps;
    costLeft -= costMicros;
    accepted.push({
      delegationId: `dlg:${sha(`${parentRunId}|${taskId}|${parentDigest({ runId: parentRunId, maxRisk: parentRisk, depth: parentDepth, evidenceIds: parent?.evidenceIds || [] })}`).slice(0, 12)}`,
      taskId,
      agent: String(agent.id),
      objective: objective.text,
      steps,
      costMicros,
      risk: asked,
      tools: askedTools,
      depth: childDepth,
      parentRunId,
      parentDigest: parentDigest({
        runId: parentRunId,
        maxRisk: parentRisk,
        depth: parentDepth,
        evidenceIds: parent?.evidenceIds || []
      })
    });
  }

  const allocated = accepted.reduce(
    (sum, child) => ({ steps: sum.steps + child.steps, costMicros: sum.costMicros + child.costMicros }),
    { steps: 0, costMicros: 0 }
  );

  const plan = {
    version: DELEGATION_VERSION,
    now: at,
    parent: {
      runId: parentRunId,
      depth: parentDepth,
      maxRisk: parentRisk,
      remainingSteps,
      remainingCostMicros: remainingCost
    },
    depth: childDepth,
    accepted,
    refused: problems,
    counts: { requested: Array.isArray(tasks) ? tasks.length : 0, accepted: accepted.length, refused: problems.length },
    allocated,
    unallocated: { steps: stepsLeft, costMicros: costLeft },
    maxDepth: MAX_DEPTH,
    maxFanout: MAX_FANOUT,
    executes: false
  };
  plan.digest = delegationDigest(plan);
  return plan;
}

/** Covers everything an outside reader sees, so an edited plan cannot keep the old fingerprint. */
export function delegationDigest(plan) {
  const body = {
    version: plan?.version ?? null,
    parent: plan?.parent ?? null,
    depth: plan?.depth ?? null,
    accepted: (plan?.accepted || []).map((child) => ({
      delegationId: child.delegationId ?? null,
      taskId: child.taskId ?? null,
      agent: child.agent ?? null,
      steps: child.steps ?? null,
      costMicros: child.costMicros ?? null,
      risk: child.risk ?? null,
      tools: child.tools ?? null,
      depth: child.depth ?? null,
      parentRunId: child.parentRunId ?? null,
      parentDigest: child.parentDigest ?? null
    })),
    refused: (plan?.refused || []).map((problem) => ({ code: problem.code ?? null, taskId: problem.taskId ?? null })),
    allocated: plan?.allocated ?? null,
    unallocated: plan?.unallocated ?? null
  };
  return sha(JSON.stringify(body)).slice(0, 12);
}

/**
 * Re-derive the plan from its sources and name every edit. Recomputation, not trust: a caller that
 * raises a child's budget, drops a refusal or swaps an agent is caught by name rather than by a
 * fingerprint nobody rechecks.
 */
export function checkDelegation(plan, { parent, tasks, roster = [] } = {}, { now = null } = {}) {
  const expected = planDelegation({ parent, tasks, roster }, { now: now || plan?.now || null });
  const problems = [];
  const note = (code, taskId, detail) => problems.push({ code, taskId, detail });

  if (!plan || typeof plan !== 'object') {
    note('plan_missing', null, 'لا خطة لتفويض');
    return { ok: false, problems, digest: null };
  }

  if (plan.digest && plan.digest !== delegationDigest(plan)) {
    note('digest_forged', null, `البصمة ${plan.digest} لا تطابق مضمون الخطة`);
  }

  const key = (child) => `${String(child?.taskId)}`;
  const given = new Map((plan.accepted || []).map((child) => [key(child), child]));
  const wanted = new Map(expected.accepted.map((child) => [key(child), child]));

  for (const [taskId, child] of wanted) {
    const actual = given.get(taskId);
    if (!actual) {
      note('child_dropped', taskId, 'طفل مقبول أُسقط من الخطة');
      continue;
    }
    if (actual.agent !== child.agent) note('agent_swapped', taskId, `${child.agent} ⇒ ${actual.agent}`);
    if (Number(actual.steps) !== child.steps || Number(actual.costMicros) !== child.costMicros) {
      note('budget_raised', taskId, `${child.steps}/${child.costMicros} ⇒ ${actual.steps}/${actual.costMicros}`);
    }
    if (actual.risk !== child.risk) note('risk_raised', taskId, `${child.risk} ⇒ ${actual.risk}`);
    if (Number(actual.depth) !== child.depth) note('depth_raised', taskId, `${child.depth} ⇒ ${actual.depth}`);
    if (actual.parentRunId !== child.parentRunId) note('evidence_stripped', taskId, 'أب مختلف عن مصدر الاشتقاق');
    if (actual.parentDigest !== child.parentDigest) note('evidence_stripped', taskId, 'بصمة الأب مبدّلة');
    if (actual.delegationId !== child.delegationId) note('identity_swapped', taskId, 'معرّف التفويض مبدّل');
  }
  for (const taskId of given.keys()) {
    if (!wanted.has(taskId)) note('child_invented', taskId, 'طفل لا يقابله طلب في المصدر');
  }

  const refusedGiven = new Set((plan.refused || []).map((problem) => `${problem.code}|${problem.taskId}`));
  const refusedWanted = new Set(expected.refused.map((problem) => `${problem.code}|${problem.taskId}`));
  for (const entry of refusedWanted) {
    if (!refusedGiven.has(entry)) note('refusal_hidden', entry.split('|')[1] || null, `رفض مسكوت عنه: ${entry.split('|')[0]}`);
  }
  for (const entry of refusedGiven) {
    if (!refusedWanted.has(entry)) note('refusal_invented', entry.split('|')[1] || null, `رفض لا يقابله سبب في المصدر: ${entry.split('|')[0]}`);
  }

  return { ok: problems.length === 0, problems, digest: delegationDigest(plan) };
}

/** What the owner reads: who was given what, and what was refused — including the reason. */
export function describeDelegation(plan) {
  if (!plan || typeof plan !== 'object') return 'لا خطة تفويض.';
  const lines = [];
  const { accepted = [], refused = [], allocated = { steps: 0, costMicros: 0 } } = plan;
  if (!accepted.length && !refused.length) {
    lines.push('لا شيء يُفوَّض — لا مهام مطلوبة.');
  }
  if (accepted.length) {
    lines.push(
      `فوّض ${accepted.length} مهمة داخل ${plan.parent?.runId || '—'} بحد ${allocated.steps} خطوة و${allocated.costMicros} ميكرو-دولار.`
    );
    for (const child of accepted) {
      lines.push(`  ← ${child.taskId}: ${child.agent} · ${child.steps} خطوة · خطر ${child.risk} · ${child.objective}`);
    }
  }
  if (refused.length) {
    lines.push(`رُفض ${refused.length} طلبًا بالاسم:`);
    for (const problem of refused) lines.push(`  ✕ ${problem.taskId || '—'}: ${problem.detail || problem.code}`);
  }
  const left = `المتبقي في الأب: ${plan.unallocated?.steps ?? 0} خطوة/${plan.unallocated?.costMicros ?? 0}µ — العقد يقرر ولا ينفّذ.`;
  lines.push(`${left} بصمة ${plan.digest ?? '—'}.`);
  return lines.join('\n');
}
