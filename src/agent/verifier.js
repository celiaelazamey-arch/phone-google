import { RISK } from './tools.js';
import { validateGoalContract } from './goal-contract.js';
import { EVIDENCE_KIND, hashOf, verifyChain } from './evidence.js';
import {
  validateAutomationSchema,
  VALIDATION_STATUS,
  ACTION_STATUS,
  COMPREHENSION_GATE_STATUS
} from './automation/schema.js';
import { evaluateComprehensionGate } from './automation/validator.js';
import { PLANNER_KB_POLICY, plannerEligibility } from '../knowledge/governance.js';

/**
 * Independent verifier (roadmap unit 7).
 *
 * The verifier is a separate component from the producer loop: it never writes,
 * never executes a non-read tool, and never trusts the planner's self-reporting.
 * It judges only from durable facts (runs, steps, tool runs, approvals, the
 * evidence chain) and returns exactly three verdicts:
 *
 * - PASS    every machine-checkable criterion holds and the chain is intact;
 * - BLOCK  a hard, readable contradiction exists (broken chain, missing evidence,
 *           unapproved external effect, schema/licence mismatch, budget breach);
 * - UNKNOWN the truth cannot be established from readable traces (an `unknown`
 *           tool outcome, a re-execution that cannot be reproduced). Saying
 *           UNKNOWN explicitly is part of the contract, not a soft failure.
 *
 * What is deliberately not verified here: the real-world effect of an external
 * system without a readable trace, and any output of a sandbox that does not
 * exist yet (AGENT-003). Those stay UNKNOWN by construction.
 */

export const VERDICT = Object.freeze({
  pass: 'PASS',
  block: 'BLOCK',
  unknown: 'UNKNOWN'
});

const CHECK = Object.freeze({
  pass: VERDICT.pass,
  block: VERDICT.block,
  unknown: VERDICT.unknown
});

const NON_EXECUTABLE_RISK = new Set([RISK.externalEffect, RISK.irreversible]);

export function createVerifier({ tools, clock = Date.now } = {}) {
  if (!tools) throw new Error('Verifier requires the tool registry');

  function lastUserMessage(messages = []) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === 'user') return messages[index].content;
    }
    return '';
  }

  function parseOutcome(toolRun) {
    if (toolRun?.parsedOutcome !== undefined) return toolRun.parsedOutcome;
    if (!toolRun?.outcome) return null;
    if (typeof toolRun.outcome !== 'string') return toolRun.outcome;
    try {
      return JSON.parse(toolRun.outcome);
    } catch {
      return null;
    }
  }

  /**
   * Re-execute a deterministic read and compare the output hash. Eligibility is
   * stricter than the tool's own claims: read risk, flagged deterministic, with
   * an executor and an explicit `replayArgs` builder. Anything else is skipped —
   * the verifier never invokes a tool it cannot prove side-effect-free.
   */
  async function reexecutionChecks(toolRuns, messages, checks) {
    for (const toolRun of toolRuns.filter((item) => item.status === 'succeeded')) {
      const tool = tools.get(toolRun.toolName);
      const eligible =
        tool &&
        tool.risk === RISK.read &&
        tool.deterministic === true &&
        typeof tool.execute === 'function' &&
        typeof tool.replayArgs === 'function';
      if (!eligible) continue;
      const id = `deterministic_reexecution:${toolRun.toolName}`;
      let args;
      try {
        args = tool.replayArgs({ messages, toolRun, context: { messages, toolRuns } });
      } catch (error) {
        checks.push({ id, status: CHECK.unknown, detail: `replay_args_failed:${error?.code || 'error'}` });
        continue;
      }
      try {
        const fresh = await tool.execute(args, { context: { messages, toolRuns } });
        const recorded = parseOutcome(toolRun);
        if (hashOf(fresh) === hashOf(recorded)) {
          checks.push({ id, status: CHECK.pass, detail: 'output_hash_matches_recorded_outcome' });
        } else {
          checks.push({ id, status: CHECK.block, detail: 'output_hash_mismatch_on_reexecution' });
        }
      } catch (error) {
        checks.push({ id, status: CHECK.unknown, detail: `reexecution_failed:${error?.code || 'error'}` });
      }
    }
  }

  function knowledgeLicenceChecks(toolRuns, checks, { planner = false } = {}) {
    for (const toolRun of toolRuns.filter((item) => item.toolName === 'kb.search' && item.status === 'succeeded')) {
      const outcome = parseOutcome(toolRun);
      const items = outcome?.items;
      if (!Array.isArray(items)) {
        checks.push({ id: 'kb_schema', status: CHECK.block, detail: 'kb.search outcome has no items array' });
        continue;
      }
      const missing = items.filter(
        (item) => !item?.uri || !item?.licence || !item?.trust
      ).length;
      checks.push(
        missing === 0
          ? { id: 'kb_source_licence_trust', status: CHECK.pass, detail: `all ${items.length} items carry uri+licence+trust` }
          : { id: 'kb_source_licence_trust', status: CHECK.block, detail: `${missing} kb item(s) missing uri/licence/trust` }
      );
      // Provider runs are identifiable from their durable evidence kinds. A
      // missing governance envelope is therefore BLOCK, not an opt-out from
      // the policy; ordinary deterministic KB runs keep their legacy contract.
      if (planner || outcome?.governance?.profile === PLANNER_KB_POLICY.profile) {
        const policy = outcome?.governance;
        const policyValid = Boolean(policy)
          && policy.profile === PLANNER_KB_POLICY.profile
          && policy.kind === PLANNER_KB_POLICY.kind
          && policy.reviewRequired === PLANNER_KB_POLICY.reviewRequired
          && JSON.stringify(policy.claimTypes) === JSON.stringify(PLANNER_KB_POLICY.claimTypes)
          && JSON.stringify(policy.trust) === JSON.stringify(PLANNER_KB_POLICY.trust);
        const invalidGoverned = items.filter((item) => {
          const eligibility = plannerEligibility(item, clock());
          return !eligibility.eligible || item.plannerEligible !== true || item.reviewStatus !== 'current';
        });
        checks.push({
          id: 'kb_planner_governance',
          status: policyValid && invalidGoverned.length === 0 ? CHECK.pass : CHECK.block,
          detail: !policyValid
            ? 'planner KB policy metadata is missing or does not match the closed policy'
            : invalidGoverned.length
              ? `planner received ${invalidGoverned.length} KB item(s) outside the governance policy`
              : 'planner KB items are governed, current and operational'
        });
      }
    }
  }

  function documentAutomationChecks({ toolRuns = [], outbox = [], checks } = {}) {
    const reports = toolRuns.filter((item) => item.toolName === 'data.report' && item.status === 'succeeded');
    for (const reportRun of reports) {
      const outcome = parseOutcome(reportRun);
      const schemaCheck = validateAutomationSchema(outcome);
      if (!schemaCheck.ok) {
        checks.push({
          id: 'document_automation_schema',
          status: CHECK.block,
          detail: `data.report violated schema 1.0: ${schemaCheck.errors.join(', ')}`
        });
        continue;
      }
      checks.push({
        id: 'document_automation_schema',
        status: CHECK.pass,
        detail: `data.report conforms to schema ${outcome.schema_version} (${outcome.validation?.status})`
      });

      if (outcome.explanation) {
        const gateEval = evaluateComprehensionGate({
          explanation: outcome.explanation,
          extracted: outcome,
          validation: outcome.validation,
          action: outcome.action
        });
        const issues = [...gateEval.contradictions, ...gateEval.ungrounded_claims];
        checks.push(
          gateEval.status === COMPREHENSION_GATE_STATUS.pass
            ? {
                id: 'comprehension_gate_grounding',
                status: CHECK.pass,
                detail: `explanation grounded (${outcome.explanation.verified_facts?.length || 0} verified facts, status=${outcome.explanation.verification_status})`
              }
            : gateEval.status === COMPREHENSION_GATE_STATUS.unknown
              ? {
                  id: 'comprehension_gate_grounding',
                  status: CHECK.unknown,
                  detail: 'explanation reflects unresolved (unknown) execution state'
                }
              : {
                  id: 'comprehension_gate_grounding',
                  status: CHECK.block,
                  detail: `explanation contradicts evidence or lacks provenance: ${issues.join(', ')}`
                }
        );
      }

      if (outcome.validation?.status !== VALIDATION_STATUS.valid) {
        const illegalCommitAttempt = outbox.some(
          (entry) =>
            entry.toolName === 'document.commit_purchase_ledger' &&
            ['dispatching', 'sent'].includes(entry.status)
        );
        if (outcome.action?.status !== ACTION_STATUS.notCommitted || illegalCommitAttempt) {
          checks.push({
            id: 'document_automation_policy',
            status: CHECK.block,
            detail: `non-valid document (${outcome.validation?.status}) attempted or claimed commitment`
          });
        } else {
          checks.push({
            id: 'document_automation_policy',
            status: CHECK.pass,
            detail: `non-valid document (${outcome.validation?.status}) remained not_committed`
          });
        }
      }
    }

    const ledgerCommits = outbox.filter(
      (entry) => entry.toolName === 'document.commit_purchase_ledger' && entry.status === 'sent'
    );
    for (const commitEntry of ledgerCommits) {
      const payload = commitEntry.payload || {};
      const savedRecord = commitEntry.result?.record || null;
      const parityOk =
        payload.validation_status === VALIDATION_STATUS.valid &&
        savedRecord &&
        savedRecord.invoice_fingerprint === payload.invoice_fingerprint &&
        savedRecord.invoice_number === payload.invoice_number &&
        savedRecord.total === payload.total;
      checks.push(
        parityOk
          ? {
              id: 'document_automation_commit_parity',
              status: CHECK.pass,
              detail: `committed purchase ledger record ${savedRecord.id} matches approved invoice ${payload.invoice_number}`
            }
          : {
              id: 'document_automation_commit_parity',
              status: CHECK.block,
              detail: 'committed purchase ledger record does not match approved invoice payload'
            }
      );
    }
  }

  /**
   * Outbox checks (AGENT-002). An external effect is only ever claimed through this
   * table, so the verifier can state precisely what happened: sent, provably not
   * attempted, or genuinely unknown.
   */
  function outboxChecks({ outbox = [], approvals = [], evidence = [], toolRuns = [], checks } = {}) {
    const approvalsById = new Map(approvals.map((approval) => [approval.id, approval]));
    const evidenced = new Set();
    for (const entry of evidence) {
      for (const sourceId of parseIds(entry.source_ids ?? entry.sourceIds)) evidenced.add(sourceId);
    }

    const attempted = outbox.filter((entry) =>
      ['dispatching', 'sent', 'unknown'].includes(entry.status)
    );
    const unapproved = [];
    const tampered = [];
    for (const entry of attempted) {
      const approval = entry.approvalId ? approvalsById.get(entry.approvalId) : null;
      if (approval?.decision !== 'approved') {
        unapproved.push(entry);
        continue;
      }
      const recomputedPayloadHash = hashOf(entry.payload ?? null);
      if (entry.payloadHash && recomputedPayloadHash !== entry.payloadHash) {
        tampered.push(`${entry.toolName}(payload_hash_mismatch)`);
        continue;
      }
      const keyMatch = /^approval:[^:]+:[^:]+:([a-f0-9]{12})(?::|$)/.exec(String(approval.idempotencyKey || ''));
      if (keyMatch && entry.payloadHash && keyMatch[1] !== entry.payloadHash.slice(0, 12)) {
        tampered.push(`${entry.toolName}(approval_fingerprint_mismatch)`);
      }
    }
    checks.push(
      unapproved.length === 0 && tampered.length === 0
        ? {
            id: 'outbox_approval',
            status: CHECK.pass,
            detail: `${attempted.length} dispatched effect(s) each carry a recorded approved decision matching the exact payload hash`
          }
        : {
            id: 'outbox_approval',
            status: CHECK.block,
            detail: [
              unapproved.length
                ? `external effect without an approved decision: ${unapproved
                    .map((entry) => `${entry.toolName}(${entry.status})`)
                    .join(', ')}`
                : null,
              tampered.length ? `approved payload tampered after decision: ${tampered.join(', ')}` : null
            ]
              .filter(Boolean)
              .join('; ')
          }
    );

    const editedApprovals = approvals.filter((approval) => approval.decision === 'edited');
    if (editedApprovals.length > 0) {
      const uneditedEvidence = editedApprovals.filter((approval) => !evidenced.has(approval.id));
      checks.push(
        uneditedEvidence.length === 0
          ? {
              id: 'plan_edit_evidence',
              status: CHECK.pass,
              detail: `${editedApprovals.length} edited plan revision(s) witnessed in evidence chain`
            }
          : {
              id: 'plan_edit_evidence',
              status: CHECK.block,
              detail: `edited approval without ledger evidence: ${uneditedEvidence.map((item) => item.toolName).join(', ')}`
            }
      );
    }

    const unsettled = outbox.filter((entry) =>
      ['pending', 'dispatching', 'unknown'].includes(entry.status)
    );
    checks.push(
      unsettled.length === 0
        ? { id: 'outbox_outcome', status: CHECK.pass, detail: 'every intent reached a readable settlement' }
        : {
            id: 'outbox_outcome',
            status: CHECK.unknown,
            detail: `unsettled intent(s): ${unsettled
              .map((entry) => `${entry.toolName}=${entry.status}`)
              .join(', ')} — no delivery is claimed`
          }
    );

    const unevidenced = outbox.filter((entry) => !evidenced.has(entry.id));
    checks.push(
      unevidenced.length === 0
        ? { id: 'outbox_evidence', status: CHECK.pass, detail: `${outbox.length} intent(s) evidenced` }
        : {
            id: 'outbox_evidence',
            status: CHECK.block,
            detail: `intent without a ledger entry: ${unevidenced.map((entry) => entry.toolName).join(', ')}`
          }
    );

    // A sent intent must be backed by a successful tool run, and vice versa.
    const sentTools = new Set(outbox.filter((entry) => entry.status === 'sent').map((entry) => entry.toolName));
    const succeededExternal = new Set(
      toolRuns.filter((item) => item.status === 'succeeded').map((item) => item.toolName)
    );
    const mismatched = [...sentTools].filter((tool) => !succeededExternal.has(tool));
    checks.push(
      mismatched.length === 0
        ? { id: 'outbox_tool_run_parity', status: CHECK.pass, detail: 'sent intents match successful tool runs' }
        : {
            id: 'outbox_tool_run_parity',
            status: CHECK.block,
            detail: `intent marked sent without a successful tool run: ${mismatched.join(', ')}`
          }
    );
  }

  /**
   * Reconciliation checks (G1). A row an owner marked `reconciled` is a claim about an
   * event nobody in this process watched, so its only witness is the evidence chain.
   * Without that entry the claim is unsupported and must block; a `sent` intent that
   * the owner confirmed without naming any external reference is left UNKNOWN, because
   * "it exists, I cannot name it" is a real state, not a pass and not a lie.
   */
  function reconciliationChecks({ toolRuns = [], outbox = [], evidence = [], checks } = {}) {
    const evidenced = new Set();
    let reconciliationEntries = 0;
    for (const entry of evidence) {
      const kind = entry.kind;
      if (kind !== 'reconciliation') continue;
      reconciliationEntries += 1;
      for (const sourceId of parseIds(entry.source_ids ?? entry.sourceIds)) evidenced.add(sourceId);
    }
    const reconciledToolRuns = toolRuns.filter((item) => {
      const outcome = parseOutcome(item);
      return outcome && typeof outcome === 'object' && outcome.reconciled === true;
    });
    const reconciledOutbox = outbox.filter(
      (entry) => entry.result && typeof entry.result === 'object' && entry.result.reconciled === true
    );
    const unsupported = [...reconciledToolRuns, ...reconciledOutbox].filter((item) => !evidenced.has(item.id));
    const total = reconciledToolRuns.length + reconciledOutbox.length;
    checks.push(
      unsupported.length === 0
        ? {
            id: 'reconciliation_evidence',
            status: CHECK.pass,
            detail: `${total} reconciled row(s) backed by ${reconciliationEntries} ledger entry(ies)`
          }
        : {
            id: 'reconciliation_evidence',
            status: CHECK.block,
            detail: `reconciled without a ledger entry: ${unsupported
              .map((item) => item.toolName || item.id)
              .join(', ')}`
          }
    );

    const unnameable = reconciledOutbox.filter(
      (entry) => entry.result?.outcome === 'applied' && !entry.externalRef && !entry.result?.note
    );
    checks.push(
      unnameable.length === 0
        ? { id: 'reconciliation_reference', status: CHECK.pass, detail: 'every confirmed effect names a reference or a note' }
        : {
            id: 'reconciliation_reference',
            status: CHECK.unknown,
            detail: `${unnameable.length} confirmed effect(s) carry neither an external reference nor an owner note`
          }
    );
  }

  async function verifyRun({
    run,
    contract = null,
    steps = [],
    toolRuns = [],
    evidence = [],
    approvals = [],
    outbox = [],
    messages = []
  } = {}) {
    const checks = [];
    const startedAt = new Date(clock()).toISOString();

    // 1. Hash-chain integrity over the persisted evidence ledger.
    const chain = verifyChain(evidence, { runId: run.id });
    checks.push(
      chain.ok
        ? { id: 'evidence_chain', status: CHECK.pass, detail: `${chain.count} linked entries` }
        : { id: 'evidence_chain', status: CHECK.block, detail: `${chain.reason} at seq ${chain.brokenSeq}` }
    );

    // 2. Every persisted tool run must be covered by at least one ledger entry.
    const coveredIds = new Set();
    for (const entry of evidence) {
      for (const sourceId of parseIds(entry.source_ids ?? entry.sourceIds)) coveredIds.add(sourceId);
    }
    const uncovered = toolRuns.filter((toolRun) => !coveredIds.has(toolRun.id));
    checks.push(
      uncovered.length === 0
        ? { id: 'evidence_completeness', status: CHECK.pass, detail: `${toolRuns.length} tool run(s) evidenced` }
        : { id: 'evidence_completeness', status: CHECK.block, detail: `missing evidence for: ${uncovered.map((item) => item.toolName).join(', ')}` }
    );

    // 3. Unknown/started outcomes cannot be verified from readable traces.
    const unresolved = toolRuns.filter((item) => item.status === 'unknown' || item.status === 'started');
    checks.push(
      unresolved.length === 0
        ? { id: 'outcome_resolved', status: CHECK.pass, detail: 'all tool outcomes are resolved' }
        : {
            id: 'outcome_resolved',
            status: CHECK.unknown,
            detail: `unresolved outcome(s): ${unresolved.map((item) => item.toolName).join(', ')} — reconciliation required`
          }
    );

    // 4. External effects: no external/irreversible tool without a recorded approval.
    const decidedApprovals = new Map(approvals.map((approval) => [approval.toolName, approval.decision]));
    const externalRuns = toolRuns.filter((item) => {
      const tool = tools.get(item.toolName);
      return tool && NON_EXECUTABLE_RISK.has(tool.risk);
    });
    const unapproved = externalRuns.filter((item) => decidedApprovals.get(item.toolName) !== 'approved');
    const pendingApprovals = approvals.filter((approval) => approval.decision === 'pending');
    if (unapproved.length || pendingApprovals.length) {
      checks.push({
        id: 'external_effect_approval',
        status: CHECK.block,
        detail: [
          unapproved.length ? `external tool run without approval: ${unapproved.map((item) => item.toolName).join(', ')}` : null,
          pendingApprovals.length ? `undecided approval(s): ${pendingApprovals.map((item) => item.toolName).join(', ')}` : null
        ].filter(Boolean).join('; ')
      });
    } else {
      checks.push({ id: 'external_effect_approval', status: CHECK.pass, detail: 'no external effect without a recorded decision' });
    }

    // 5. Deterministic read re-execution (only for explicitly eligible tools).
    await reexecutionChecks(toolRuns, messages, checks);

    // 6. Outcome schema: stored outcomes must parse; KB items carry provenance.
    const unparseable = toolRuns.filter((item) => item.status === 'succeeded' && parseOutcome(item) === null && item.outcome);
    checks.push(
      unparseable.length === 0
        ? { id: 'outcome_schema', status: CHECK.pass, detail: 'all stored outcomes parse as JSON' }
        : { id: 'outcome_schema', status: CHECK.block, detail: `unparseable outcome(s): ${unparseable.map((item) => item.toolName).join(', ')}` }
    );
    const providerEvidence = evidence.some((entry) => [
      EVIDENCE_KIND.planCreated,
      EVIDENCE_KIND.toolSelected,
      EVIDENCE_KIND.toolExecuted,
      EVIDENCE_KIND.verificationResult
    ].includes(entry.kind));
    knowledgeLicenceChecks(toolRuns, checks, { planner: providerEvidence });

    // 7. Goal contract: structural validity plus the machine-checkable criteria.
    const contractCheck = validateGoalContract(contract);
    if (!contractCheck.ok) {
      checks.push({ id: 'goal_contract', status: CHECK.block, detail: contractCheck.errors.join(', ') });
    } else {
      const budgetBreach =
        run.usage.steps > run.limits.maxSteps || run.usage.costMicros > run.limits.maxCostMicros;
      // A failure the owner adjudicated as `not_applied` is a closed historical fact
      // with a ledger entry; a later successful retry may still deliver. An
      // unadjudicated failure keeps blocking, as before.
      const adjudicated = (item) => {
        const outcome = parseOutcome(item);
        return outcome && typeof outcome === 'object' && outcome.reconciled === true && outcome.outcome === 'not_applied';
      };
      const failedTools = toolRuns.filter((item) => item.status === 'failed' && !adjudicated(item)).length;
      const hasSteps = steps.length > 0;
      const contractFailures = [
        !hasSteps ? 'no_step_recorded' : null,
        budgetBreach ? 'budget_breached' : null,
        failedTools ? `${failedTools}_failed_tool_run(s)` : null
      ].filter(Boolean);
      checks.push(
        contractFailures.length === 0
          ? {
              id: 'goal_contract',
              status: CHECK.pass,
              detail: `objective «${contract.objective.slice(0, 80)}» — machine-checkable criteria hold`
            }
          : { id: 'goal_contract', status: CHECK.block, detail: contractFailures.join('; ') }
      );
    }

    // 8. External effects: the outbox is the only exit, so judge it directly.
    outboxChecks({ outbox, approvals, evidence, toolRuns, checks });

    // 9. Human reconciliation must be witnessed by the chain, never asserted alone.
    reconciliationChecks({ toolRuns, outbox, evidence, checks });

    // 10. Document & Data Automation schema, policy, and ledger parity checks.
    documentAutomationChecks({ toolRuns, outbox, checks });

    const verdict = checks.some((check) => check.status === CHECK.block)
      ? VERDICT.block
      : checks.some((check) => check.status === CHECK.unknown)
        ? VERDICT.unknown
        : VERDICT.pass;

    return Object.freeze({
      verdict,
      checks: Object.freeze(checks.map((check) => Object.freeze(check))),
      runId: run.id,
      objective: contract?.objective || lastUserMessage(messages),
      at: startedAt,
      version: 'verifier-v1'
    });
  }

  return { name: 'independent-verifier', verifyRun };
}

function parseIds(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
