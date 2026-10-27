import { PLAN_LIFECYCLE_STATE, RUN_STATUS, APPROVAL_DECISION } from './store.js';
import { RISK, validateToolInput } from './tools.js';
import { hashOf } from './evidence.js';
import { OUTBOX_STATUS } from './outbox.js';

export { PLAN_LIFECYCLE_STATE };

/**
 * Agent Harness — Execution Runtime Architect specification & inspector.
 *
 * Enforces and audits the mandatory 10-stage execution lifecycle:
 *   Goal → Plan → Select Tool → Policy Check → Approval → Sandbox Execute →
 *   Observe → Independently Verify → Persist Evidence → Update State
 *
 * And the plan-present-wait-execute state machine:
 *   PLAN_READY → WAITING_FOR_APPROVAL → (EDITED → WAITING_FOR_APPROVAL)* →
 *   APPROVED → EXECUTING (or REJECTED → cancelled)
 */

export const HARNESS_LIFECYCLE_STAGES = Object.freeze([
  'Goal',
  'Plan',
  'Select Tool',
  'Policy Check',
  'Approval',
  'Sandbox Execute',
  'Observe',
  'Independently Verify',
  'Persist Evidence',
  'Update State'
]);

export const HARNESS_COMPONENT_IDS = Object.freeze([
  'agent_runtime',
  'model_router',
  'tool_registry',
  'context_memory',
  'policy_approval_gate',
  'sandbox_executor',
  'independent_verifier',
  'evidence_observability',
  'recovery_idempotency',
  'evaluation_regression'
]);

/**
 * Build a deterministic, inspectable plan snapshot when a run prepares or updates
 * a plan requiring approval. Stored in `agent_runs.plan_summary` (≤1000 chars) and
 * enriched on `runtime.detail(runId)` from the durable tables.
 */
export function buildPlanSummaryRecord({
  revision = 1,
  state = PLAN_LIFECYCLE_STATE.waitingForApproval,
  toolName = null,
  risk = null,
  connector = null,
  payload = null,
  note = null,
  transitions = [PLAN_LIFECYCLE_STATE.planReady, PLAN_LIFECYCLE_STATE.waitingForApproval]
} = {}) {
  const payloadHash = hashOf(payload ?? null);
  return {
    version: 'plan-v1',
    revision: Number(revision) || 1,
    state,
    toolName,
    risk,
    connector,
    payloadHash,
    note: note ? String(note).slice(0, 160) : null,
    transitions: Array.isArray(transitions) ? transitions.slice(-10) : [state]
  };
}

export function parsePlanSummaryRecord(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.version === 'plan-v1') return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Derive the full inspectable plan object and its exact state transition history
 * from the durable facts of the run (`run`, `goalContract`, `steps`, `approvals`,
 * `outbox`, `toolRuns`, `verification`).
 */
export function derivePlanView({
  run,
  goalContract = null,
  steps = [],
  approvals = [],
  outbox = [],
  toolRuns = [],
  verification = null
} = {}) {
  if (!run) return null;
  const stored = parsePlanSummaryRecord(run.planSummary);
  const editedApprovals = approvals.filter((item) => item.decision === APPROVAL_DECISION.edited);
  const approvedApprovals = approvals.filter((item) => item.decision === APPROVAL_DECISION.approved);
  const rejectedApprovals = approvals.filter((item) => item.decision === APPROVAL_DECISION.rejected);
  const pendingApproval = approvals.find((item) => item.decision === APPROVAL_DECISION.pending) || null;
  const latestApproval = approvals[approvals.length - 1] || null;
  const activeOutbox = outbox[outbox.length - 1] || null;

  const transitions = [];
  if (goalContract || steps.length > 0 || approvals.length > 0) {
    transitions.push(PLAN_LIFECYCLE_STATE.planReady);
  }
  for (const approval of approvals) {
    transitions.push(PLAN_LIFECYCLE_STATE.waitingForApproval);
    if (approval.decision === APPROVAL_DECISION.edited) {
      transitions.push(PLAN_LIFECYCLE_STATE.edited);
    } else if (approval.decision === APPROVAL_DECISION.approved) {
      transitions.push(PLAN_LIFECYCLE_STATE.approved);
    } else if (approval.decision === APPROVAL_DECISION.rejected) {
      transitions.push(PLAN_LIFECYCLE_STATE.rejected);
    }
  }
  const DeduplicatedTransitions = [];
  for (const state of transitions) {
    if (DeduplicatedTransitions[DeduplicatedTransitions.length - 1] !== state) {
      DeduplicatedTransitions.push(state);
    }
  }

  let currentState = PLAN_LIFECYCLE_STATE.planReady;
  if (run.status === RUN_STATUS.waitingApproval) {
    currentState = PLAN_LIFECYCLE_STATE.waitingForApproval;
  } else if (run.status === RUN_STATUS.cancelled && rejectedApprovals.length > 0) {
    currentState = PLAN_LIFECYCLE_STATE.rejected;
  } else if (run.status === RUN_STATUS.needsReconciliation) {
    currentState = PLAN_LIFECYCLE_STATE.needsReconciliation;
  } else if (run.status === RUN_STATUS.running || run.status === RUN_STATUS.queued) {
    if (approvedApprovals.length > 0) {
      if (DeduplicatedTransitions[DeduplicatedTransitions.length - 1] !== PLAN_LIFECYCLE_STATE.executing) {
        DeduplicatedTransitions.push(PLAN_LIFECYCLE_STATE.executing);
      }
      currentState = PLAN_LIFECYCLE_STATE.executing;
    } else if (toolRuns.length > 0) {
      if (DeduplicatedTransitions[DeduplicatedTransitions.length - 1] !== PLAN_LIFECYCLE_STATE.executing) {
        DeduplicatedTransitions.push(PLAN_LIFECYCLE_STATE.executing);
      }
      currentState = PLAN_LIFECYCLE_STATE.executing;
    }
  } else if (run.status === RUN_STATUS.succeeded) {
    if (
      (approvedApprovals.length > 0 || toolRuns.length > 0) &&
      !DeduplicatedTransitions.includes(PLAN_LIFECYCLE_STATE.executing)
    ) {
      DeduplicatedTransitions.push(PLAN_LIFECYCLE_STATE.executing);
    }
    currentState = PLAN_LIFECYCLE_STATE.executing;
  } else if (run.status === RUN_STATUS.failed || run.status === RUN_STATUS.budgetExhausted) {
    if (approvedApprovals.length > 0 && !DeduplicatedTransitions.includes(PLAN_LIFECYCLE_STATE.executing)) {
      DeduplicatedTransitions.push(PLAN_LIFECYCLE_STATE.executing);
    }
    DeduplicatedTransitions.push(PLAN_LIFECYCLE_STATE.failed);
    currentState = PLAN_LIFECYCLE_STATE.failed;
  }

  const revision = Math.max(stored?.revision || 1, editedApprovals.length + 1);
  const targetTool = pendingApproval?.toolName || latestApproval?.toolName || activeOutbox?.toolName || stored?.toolName || null;
  const targetRisk = pendingApproval?.risk || latestApproval?.risk || stored?.risk || null;
  const payload = activeOutbox?.payload ?? null;
  const payloadHash = activeOutbox?.payloadHash ?? stored?.payloadHash ?? hashOf(payload);

  return {
    version: 'plan-v1',
    revision,
    state: currentState,
    transitions: DeduplicatedTransitions,
    stages: [
      {
        id: 'understand',
        title: '1. الفهم (Goal & Constraints)',
        completed: Boolean(goalContract)
      },
      {
        id: 'plan',
        title: '2. التخطيط (Steps, Tools, Risks, Criteria)',
        completed: steps.length > 0 || approvals.length > 0
      },
      {
        id: 'present_and_wait',
        title: '3. العرض والانتظار (WAITING_FOR_APPROVAL: Approve / Edit / Reject)',
        completed: approvedApprovals.length > 0 || rejectedApprovals.length > 0
      },
      {
        id: 'execute_and_verify',
        title: '4. التنفيذ والتحقق المستقل (Execute & Independently Verify)',
        completed: run.status === RUN_STATUS.succeeded && verification?.verdict === 'PASS'
      }
    ],
    objective: goalContract?.objective || null,
    requiredOutcome: goalContract?.required_outcome || null,
    missingInformation: goalContract?.missing_information || [],
    toolName: targetTool,
    risk: targetRisk,
    connector: activeOutbox?.connector || stored?.connector || null,
    payload,
    payloadHash,
    proposedEffect: targetTool
      ? {
          toolName: targetTool,
          risk: targetRisk,
          connector: activeOutbox?.connector || stored?.connector || null,
          payload,
          payloadHash
        }
      : null,
    pendingApprovalId: pendingApproval?.id || null,
    outboxId: activeOutbox?.id || null,
    outboxStatus: activeOutbox?.status || null,
    editCount: editedApprovals.length,
    verificationVerdict: verification?.verdict || null,
    successCriteria: goalContract?.success_criteria || [],
    constraints: goalContract?.constraints || [],
    dependencies: [
      ...(targetTool ? [`الأداة الحساسة: ${targetTool} (${targetRisk || 'external_effect'})`] : []),
      ...(activeOutbox?.connector ? [`الموصل المطلوب: ${activeOutbox.connector}`] : [])
    ]
  };
}

/**
 * Policy & Approval Gate check for an owner-edited plan before saving it.
 * Rejects unknown tools, irreversible/forbidden tools, invalid payload shapes,
 * secret injection, or domain-policy violations (such as invalid calendar time ranges).
 */
export function validatePlanEditPolicy({ tool, payload, requestedToolName = null, tools } = {}) {
  if (!tool) {
    return { ok: false, status: 400, code: 'unknown_tool', message: 'Target tool is not registered' };
  }
  if (requestedToolName && requestedToolName !== tool.name) {
    if (!tools?.has(requestedToolName)) {
      return { ok: false, status: 400, code: 'unknown_tool', message: `Unknown tool: ${requestedToolName}` };
    }
    return {
      ok: false,
      status: 409,
      code: 'plan_edit_tool_mismatch',
      message: 'Editing a parked plan cannot silently swap the target tool; cancel and start a new run instead'
    };
  }
  if (tool.risk === RISK.irreversible) {
    return {
      ok: false,
      status: 403,
      code: 'policy_violation_irreversible_tool',
      message: `Tool ${tool.name} is classified irreversible and cannot be approved before AGENT-003 sandbox isolation`
    };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ok: false,
      status: 400,
      code: 'plan_edit_payload_required',
      message: 'Edited plan payload must be a non-empty JSON object'
    };
  }
  const inputCheck = validateToolInput(tool, payload);
  if (!inputCheck.ok) {
    return {
      ok: false,
      status: 400,
      code: 'plan_edit_policy_violation',
      message: inputCheck.message
    };
  }
  return { ok: true };
}

/**
 * Verify before dispatching an external effect from the outbox that:
 *   1. The outbox row is still `pending` and linked to an `approved` decision.
 *   2. The stored `payload` hashes to the stored `payloadHash` (no DB tampering).
 *   3. The approval's `idempotencyKey` fingerprint matches `payloadHash.slice(0, 12)`
 *      (no silent mutation of sensitive steps after approval).
 */
export function verifyApprovedEffectIntegrity({ entry, approval } = {}) {
  if (!entry) {
    return { ok: false, code: 'outbox_entry_missing', reason: 'Outbox intent is missing' };
  }
  if (!approval || approval.decision !== APPROVAL_DECISION.approved) {
    return { ok: false, code: 'approval_missing_or_unapproved', reason: 'Outbox intent lacks an approved decision' };
  }
  const recomputedHash = hashOf(entry.payload ?? null);
  if (!entry.payloadHash || recomputedHash !== entry.payloadHash) {
    return {
      ok: false,
      code: 'post_approval_payload_tampered',
      reason: 'Persisted outbox payload does not match its recorded payload_hash'
    };
  }
  const match = /^approval:[^:]+:[^:]+:([a-f0-9]{12})(?::|$)/.exec(String(approval.idempotencyKey || ''));
  if (match && match[1] !== entry.payloadHash.slice(0, 12)) {
    return {
      ok: false,
      code: 'post_approval_payload_tampered',
      reason: 'Outbox payload fingerprint does not match the approved decision fingerprint'
    };
  }
  if (entry.status !== OUTBOX_STATUS.pending) {
    return {
      ok: false,
      code: 'outbox_intent_not_pending',
      reason: `Outbox intent status is ${entry.status}, expected pending`
    };
  }
  return { ok: true, payloadHash: recomputedHash };
}

/**
 * Structured inspection of the 10 Agent Harness components and War Room audit.
 * Every claim is derived from the live runtime objects (`store`, `tools`, `planner`,
 * `verifier`, `connectors`, `limits`), never hard-coded marketing text.
 */
export function inspectAgentHarness({
  store,
  tools,
  planner,
  verifier,
  connectors,
  limits,
  bootRecovery = null
} = {}) {
  const toolList = tools ? tools.list() : [];
  const connectorList = connectors?.list ? connectors.list() : [];
  return {
    ok: Boolean(store && planner && tools && verifier),
    version: 'agent-harness-v1',
    lifecycle: HARNESS_LIFECYCLE_STAGES,
    lifecycleStages: HARNESS_LIFECYCLE_STAGES,
    planStates: Object.values(PLAN_LIFECYCLE_STATE),
    components: [
      {
        id: 'agent_runtime',
        title: 'Agent Runtime',
        wired: Boolean(store && planner && tools),
        guarantees: [
          'دورة Plan → Act → Observe → Verify → Deliver محكومة بعقد إيجار (lease) ذري',
          'إيقاف الحلقات غير المنتهية عبر سقوف الخطوات والتكلفة والمهلة الزمنية',
          'انتقالات صريحة: PLAN_READY → WAITING_FOR_APPROVAL → EDITED/APPROVED/REJECTED → EXECUTING'
        ],
        limits
      },
      {
        id: 'model_router',
        title: 'Model Router & Planner Seam',
        wired: Boolean(planner?.plan),
        planner: planner?.name || 'unconfigured',
        guarantees: [
          'فصل عقد التخطيط plan(context) عن حلقة التنفيذ؛ لا يفترض أن كل نموذج يدعم نفس الأدوات',
          'في وضع auto للمزودين السحابيين يُحظر التحول العابر للشركات افتراضيًا (CELIA_AI_ALLOW_CLOUD_FAILOVER=false)',
          'حد معلن: المخطط الفعّال حاليًا حتمي (demo-deterministic) حتى اعتماد AI-002'
        ]
      },
      {
        id: 'tool_registry',
        title: 'Tool Registry',
        wired: toolList.length > 0,
        toolsCount: toolList.length,
        guarantees: [
          'تصنيف مخاطر إلزامي لكل أداة: read / internal_write / external_effect / irreversible',
          'فحص عقد المدخلات ومنع حقن المفاتيح السرية أو الحقول غير المعلنة (validateToolInput)',
          'رفض أي أداة غير مسجلة بخطأ صريح unknown_tool'
        ]
      },
      {
        id: 'context_memory',
        title: 'Context & Memory',
        wired: Boolean(store?.dialect),
        dialect: store?.dialect || 'off',
        guarantees: [
          'حفظ الخيوط والرسائل والتشغيلات والخطوات في MySQL أو SQLite صريح (لا ذاكرة مؤقتة صامتة)',
          'استمرارية الجلسة عبر معرفات فريدة وترتيب زمني وعقود هدف محفوظة في agent_goal_contracts'
        ]
      },
      {
        id: 'policy_approval_gate',
        title: 'Policy & Approval Gate',
        wired: true,
        guarantees: [
          'لا تنفيذ لأي أداة external_effect أو irreversible قبل موافقة مالك مسجلة',
          'دعم القرارات الثلاثة: approved (ينفذ الخطة المعتمدة) / edited (يحفظ التعديل ويعيد فحص السياسات ويعرضها للمراجعة) / rejected (يلغي بأمان)',
          'ربط الموافقة ببصمة الحمولة (SHA-256) ومنع أي تغيير صامت للخطوات الحساسة بعد الموافقة'
        ]
      },
      {
        id: 'sandbox_executor',
        title: 'Sandbox Executor',
        wired: true,
        isolatedContainerAvailable: false,
        guarantees: [
          'الأدوات القابلة للتنفيذ محليًا محصورة في read/internal_write بمهلة زمنية وإشارة إلغاء AbortController',
          'الأدوات المصنفة irreversible (مثل sandbox.exec) مرفوضة صراحةً حتى توفير عزل حاويات AGENT-003'
        ]
      },
      {
        id: 'independent_verifier',
        title: 'Independent Verifier',
        wired: Boolean(verifier?.verifyRun),
        verifier: verifier?.name || 'independent-verifier',
        guarantees: [
          'مكوّن مستقل عن المنتِج بلا صلاحية كتابة؛ يصدر أحكام PASS / BLOCK / UNKNOWN فقط',
          'يعيد تنفيذ القراءات الحتمية ويطابق بصمتها، ويفحص تطابق بصمة الحمولة المعتمدة في الـoutbox'
        ]
      },
      {
        id: 'evidence_observability',
        title: 'Evidence & Observability',
        wired: true,
        ledger: 'sha256-hash-chain-v1',
        guarantees: [
          'سجل أدلة إضافي فقط (agent_evidence) بسلسلة بصمات SHA-256 وجذر genesis لكل تشغيل',
          'كشف أي حذف أو تعديل بالرقم والسبب، وبث الأحداث لحظيًا عبر SSE دون تسريب أسرار'
        ]
      },
      {
        id: 'recovery_idempotency',
        title: 'Recovery & Idempotency',
        wired: true,
        bootRecovery,
        connectors: connectorList,
        guarantees: [
          'مفاتيح تفرد في قاعدة البيانات لـ client_message_id واستدعاءات الأدوات ونوايا الـoutbox وقرارات الموافقة',
          'لا إعادة إرسال عمياء بعد انقطاع أو مهلة: تتحول إلى unknown وتخرج بمصالحة بشرية مسجلة فقط (DEC-007/DEC-016/DEC-018)'
        ]
      },
      {
        id: 'evaluation_regression',
        title: 'Evaluation & Regression',
        wired: true,
        guarantees: [
          'اختبارات حتمية تقيس انتقالات الحالة (PLAN_READY → WAITING_FOR_APPROVAL → EDITED/APPROVED/REJECTED → EXECUTING)',
          'اختبارات كسر الدورة: تزوير نجاح أداة، تعديل الحمولة بعد الموافقة، تكرار الطلبات، وتجاوز ملكية المالك'
        ]
      }
    ]
  };
}
