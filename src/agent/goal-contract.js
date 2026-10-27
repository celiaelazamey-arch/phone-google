/**
 * Goal contract (governance layer, step 2 of the agent roadmap).
 *
 * A run starts from a data contract, not free text: the objective, machine-checkable
 * success criteria, explicit constraints, stop conditions, a deadline and the budget.
 * The independent verifier (`./verifier.js`) evaluates the machine-checkable parts;
 * nothing here pretends a human-semantic criterion can be judged automatically.
 *
 * The builder is deterministic: the same objective and limits produce the same
 * contract, so the contract hash in the evidence ledger is reproducible.
 */

export const GOAL_CONTRACT_VERSION = 'goal-contract-v1';

const OBJECTIVE_MAX = 1000;
const TEXT_MAX = 600;

const STOP_CONDITIONS = Object.freeze([
  'step_budget_exhausted',
  'cost_budget_exhausted',
  'run_timeout',
  'waiting_approval',
  'needs_reconciliation',
  'cancelled',
  'verification_blocked',
  'verification_unknown'
]);

function clip(value, max = TEXT_MAX) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const EXTERNAL_HINTS_RE = /(تقويم|موعد|اجتماع|calendar|event|meeting)/i;
const EXPLICIT_ISO_TIME_RE = /\b\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2})?/;

/**
 * Identify what information is missing from the raw user request so the plan can
 * surface proposals explicitly instead of inventing silent defaults.
 */
export function detectMissingInformation(objective) {
  const text = clip(objective, OBJECTIVE_MAX);
  const missing = [];
  if (EXTERNAL_HINTS_RE.test(text) && !EXPLICIT_ISO_TIME_RE.test(text)) {
    missing.push('وقت البداية والنهاية الدقيق للموعد غير محدد نصيًا؛ سيقترح المخطط فترة مبدئية في الخطة بانتظار موافقتك أو تعديلك');
  }
  return Object.freeze(missing);
}

/**
 * Build the contract for a new run. `limits` are the runtime's resolved limits
 * (maxSteps/maxCostMicros/maxDurationMs) so the contract never promises more than
 * the loop is actually configured to spend.
 */
export function buildGoalContract({ objective, limits = {}, createdAt = Date.now() } = {}) {
  const text = clip(objective, OBJECTIVE_MAX);
  const maxSteps = Number.isInteger(limits.maxSteps) && limits.maxSteps > 0 ? limits.maxSteps : 0;
  const maxCostMicros = Number.isInteger(limits.maxCostMicros) && limits.maxCostMicros >= 0 ? limits.maxCostMicros : 0;
  const maxDurationMs = Number.isInteger(limits.maxDurationMs) && limits.maxDurationMs > 0 ? limits.maxDurationMs : 0;
  const deadline = new Date(createdAt + maxDurationMs).toISOString();
  const missingInformation = detectMissingInformation(text);
  const requiresExternalApproval = EXTERNAL_HINTS_RE.test(text);
  return Object.freeze({
    version: GOAL_CONTRACT_VERSION,
    objective: text,
    required_outcome: requiresExternalApproval
      ? 'إعداد خطة تنفيذية وعرض أثر التقويم المقترح في بوابة الموافقات قبل أي إرسال خارجي'
      : 'إعداد مخرج موثق بالأدلة والتحقق المستقل ضمن حدود الميزانية والخطوات',
    missing_information: missingInformation,
    success_criteria: Object.freeze([
      'اكتمال حلقة plan→act→observe مع خطوة تسليم مسجلة',
      'كل استدعاء أداة له مخرج محفوظ في سجل الأدلة المسلسل',
      'لا أثر خارجي قبل موافقة مالك مسجلة في جدول الموافقات',
      'حكم المُتحقِّق المستقل PASS عند التسليم'
    ]),
    constraints: Object.freeze([
      `سقف الخطوات: ${maxSteps}`,
      `سقف التكلفة: ${maxCostMicros} وحدة مايكرو (10⁻⁶ $)`,
      'الأدوات ذات الأثر الخارجي معلنة بلا تنفيذ قبل outbox AGENT-002',
      'لا إعادة تنفيذ عمياء لاستدعاء حالته unknown؛ المصالحة أولًا'
    ]),
    stop_conditions: Object.freeze([...STOP_CONDITIONS]),
    deadline,
    budget: Object.freeze({ maxSteps, maxCostMicros, maxDurationMs })
  });
}

function isNonEmptyStringArray(value, { maxEntries = 12 } = {}) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= maxEntries &&
    value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)
  );
}

/**
 * Structural validation used both at submit time and by the verifier.
 * Returns `{ ok: true }` or `{ ok: false, errors: [...] }` — never throws — so a
 * malformed persisted contract is reported as evidence instead of crashing a run.
 */
export function validateGoalContract(contract) {
  const errors = [];
  if (!contract || typeof contract !== 'object') return { ok: false, errors: ['contract_not_object'] };
  if (contract.version !== GOAL_CONTRACT_VERSION) errors.push('unexpected_contract_version');
  if (typeof contract.objective !== 'string' || !contract.objective.trim()) errors.push('objective_required');
  if (!isNonEmptyStringArray(contract.success_criteria)) errors.push('success_criteria_required');
  if (!isNonEmptyStringArray(contract.constraints)) errors.push('constraints_required');
  if (!isNonEmptyStringArray(contract.stop_conditions)) errors.push('stop_conditions_required');
  if (Number.isNaN(Date.parse(contract.deadline))) errors.push('deadline_not_parseable');
  const budget = contract.budget;
  if (!budget || typeof budget !== 'object') {
    errors.push('budget_required');
  } else {
    if (!Number.isInteger(budget.maxSteps) || budget.maxSteps <= 0) errors.push('budget_max_steps_invalid');
    if (!Number.isInteger(budget.maxCostMicros) || budget.maxCostMicros < 0) errors.push('budget_max_cost_invalid');
    if (!Number.isInteger(budget.maxDurationMs) || budget.maxDurationMs <= 0) errors.push('budget_max_duration_invalid');
  }
  return { ok: errors.length === 0, errors };
}
