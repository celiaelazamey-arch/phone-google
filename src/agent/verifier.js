import { RISK } from './tools.js';
import { validateGoalContract } from './goal-contract.js';
import { hashOf, verifyChain } from './evidence.js';

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
        args = tool.replayArgs({ messages, toolRun });
      } catch (error) {
        checks.push({ id, status: CHECK.unknown, detail: `replay_args_failed:${error?.code || 'error'}` });
        continue;
      }
      try {
        const fresh = await tool.execute(args, { context: { messages } });
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

  function knowledgeLicenceChecks(toolRuns, checks) {
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
    const unapproved = attempted.filter((entry) => {
      const approval = entry.approvalId ? approvalsById.get(entry.approvalId) : null;
      return approval?.decision !== 'approved';
    });
    checks.push(
      unapproved.length === 0
        ? {
            id: 'outbox_approval',
            status: CHECK.pass,
            detail: `${attempted.length} dispatched effect(s) each carry a recorded approved decision`
          }
        : {
            id: 'outbox_approval',
            status: CHECK.block,
            detail: `external effect without an approved decision: ${unapproved
              .map((entry) => `${entry.toolName}(${entry.status})`)
              .join(', ')}`
          }
    );

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
    knowledgeLicenceChecks(toolRuns, checks);

    // 7. Goal contract: structural validity plus the machine-checkable criteria.
    const contractCheck = validateGoalContract(contract);
    if (!contractCheck.ok) {
      checks.push({ id: 'goal_contract', status: CHECK.block, detail: contractCheck.errors.join(', ') });
    } else {
      const budgetBreach =
        run.usage.steps > run.limits.maxSteps || run.usage.costMicros > run.limits.maxCostMicros;
      const failedTools = toolRuns.filter((item) => item.status === 'failed').length;
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
