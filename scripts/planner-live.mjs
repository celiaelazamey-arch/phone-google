#!/usr/bin/env node
/**
 * Isolated live run of the provider planner (WP-3.1, DEC-060).
 *
 * What this proves, and only this: with the real `GEMINI_API_KEY` from the environment, the real runtime asks a real
 * model for a plan through `createGeminiPlannerProvider`, executes only the read tools in the closed allowlist, and
 * reaches a verified finish — with measured token usage, no fallback, no external effect and no key in any output.
 *
 * What it deliberately does not do:
 *   - no production activation (`CELIA_AGENT_PLANNER` is set *inside this process* only),
 *   - no MySQL, no deploy, no migration, no outbox effect, no network beyond the single Gemini endpoint,
 *   - no raw provider body, key or prompt in the report: everything passes `sanitize()` and a key scan.
 *
 * Usage:
 *   GEMINI_API_KEY=... node scripts/planner-live.mjs [--model gemini-2.5-flash] [--max-runs 3] [--out path]
 * Exit codes: 0 = live proof passed · 1 = gate failed · 2 = not configured (no key) or bad arguments.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createAgentStore } from '../src/agent/store.js';
import { createSqliteDriver } from '../src/agent/drivers.js';
import { createToolRegistry, defaultToolDefinitions, RISK } from '../src/agent/tools.js';
import { createProviderPlanner, createGeminiPlannerProvider, PROVIDER_PLAN_SCHEMA } from '../src/agent/planner-provider.js';
import { createDemoPlanner } from '../src/agent/planner.js';
import { selectProviderTools } from '../src/agent/index.js';
import { sanitize, secretValues } from './service-reality.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';

const DEFAULT_OUT = '.validation-artifacts/planner-live.json';
const MAX_RUNS_CEILING = 3;
const BOUNDED_DELIVERY = 'bounded_delivery';
const WALL_CLOCK_CEILING_MS = Number(process.env.PLANNER_LIVE_WALL_MS || 180_000);

/** Fixed, synthetic, non-personal goals. Three shapes: tool-then-finish, direct finish, and a vague brief. */
export const LIVE_SCENARIOS = Object.freeze([
  {
    id: 'live-1',
    shape: 'tool_then_finish',
    goal: 'اقرأ عدد رسائل الخيط الحالية ثم اذكر العدد في جملة واحدة.',
    expectTool: true
  },
  {
    id: 'live-2',
    shape: 'finish_without_tool',
    goal: 'Reply with exactly one short sentence confirming you are online. Do not use any tool.',
    expectTool: false
  },
  {
    id: 'live-3',
    shape: 'vague_brief',
    goal: 'نفّذ المهمة.',
    expectTool: false,
    acceptsClarification: true
  }
]);

function argOf(argv, name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

/**
 * Gate evaluation is a pure function of the collected runs plus the environment, so a test can drive it offline.
 * Every rule here is about *not* claiming something: a fallback means the model did not plan, zero tokens means
 * nothing was measured, and a leak means the report must not be published.
 */
export function evaluateLiveGate({ runs = [], report = null, env = process.env } = {}) {
  const failures = [];
  if (!runs.length) failures.push('no_runs');
  for (const run of runs) {
    const scenario = LIVE_SCENARIOS.find((item) => item.id === run.id);
    // DEC-061: the runtime records a bounded delivery (a clarification, for instance) as `failed` + `bounded_delivery`.
    // Only the vague-brief scenario may end that way, and only with a verdict of PASS — a red run is never a pass.
    const bounded = run.status === 'failed' && run.error === BOUNDED_DELIVERY && run.verificationVerdict === 'PASS';
    const acceptable = run.status === 'succeeded' || (scenario?.shape === 'vague_brief' && bounded);
    if (!acceptable) failures.push(`${run.id}:status_${run.status || 'missing'}${run.error ? `_${run.error}` : ''}`);
    if (run.fallbacks > 0) failures.push(`${run.id}:planner_fallback_${run.fallbackCodes.join('_') || 'unknown'}`);
    if (!(run.tokens > 0)) failures.push(`${run.id}:tokens_not_measured`);
    if (run.costMicros !== 0) failures.push(`${run.id}:cost_claimed_without_price_table`);
    if (run.verificationVerdict !== 'PASS') failures.push(`${run.id}:verification_${run.verificationVerdict || 'missing'}`);
    if (run.evidenceChainOk !== true) failures.push(`${run.id}:evidence_chain_unverified`);
    if (run.outboxCount !== 0) failures.push(`${run.id}:external_effect_attempted`);
    if (run.approvalsCount !== 0) failures.push(`${run.id}:approval_required`);
    for (const name of run.toolNames) {
      if (run.toolRisks[name] !== RISK.read) failures.push(`${run.id}:non_read_tool_${name}`);
    }
    const usedTool = run.toolNames.length > 0;
    if (scenario?.shape === 'tool_then_finish' && !usedTool) failures.push(`${run.id}:expected_a_read`);
    if (scenario?.shape === 'finish_without_tool' && usedTool) failures.push(`${run.id}:unnecessary_tool_call`);
    // DEC-061: reading the thread before asking a clarifying question is safe and informative; what must not happen is
    // a vague brief turning into open-ended work. The global read-only rule already forbids any write here.
    if (scenario?.shape === 'vague_brief' && run.toolNames.length > 1) failures.push(`${run.id}:vague_brief_exceeded_one_read`);
  }
  if (report && secretValues(env).some((value) => JSON.stringify(report).includes(value))) {
    failures.push('secret_leaked_in_report');
  }
  return { ok: failures.length === 0, failures: [...new Set(failures)] };
}

/** Times each provider decision without changing it; the model text is capped, never echoed whole. */
function timedProvider(base, latencies, calls) {
  return {
    name: base.name,
    model: base.model,
    kind: base.kind,
    async createPlan(request) {
      const started = Date.now();
      try {
        const envelope = await base.createPlan(request);
        const ms = Date.now() - started;
        latencies.push(ms);
        calls.push({ ms, ok: true, tokens: envelope?.usage?.totalTokens ?? null });
        return envelope;
      } catch (error) {
        const ms = Date.now() - started;
        latencies.push(ms);
        // Only the declared code and the bounded details (e.g. `http_status:429`) survive; never a body or a key.
        calls.push({ ms, ok: false, code: String(error?.code || 'unexpected'), details: (error?.details || []).slice(0, 4).map(String) });
        throw error;
      }
    }
  };
}

async function runScenario({ scenario, apiKey, model, timeoutMs, allowedTools }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-live-planner-'));
  const latencies = [];
  const calls = [];
  let driver = null;
  try {
    driver = await createSqliteDriver({ path: path.join(directory, 'live.sqlite3') });
    const store = createAgentStore({ driver });
    const tools = createToolRegistry(defaultToolDefinitions({ statusProvider: () => ({ version: 'live-probe', storage: 'sqlite-temp' }) }));
    const provider = timedProvider(
      createGeminiPlannerProvider({ apiKey, model, timeoutMs }),
      latencies,
      calls
    );
    // The provider planner is *wrapped* in the same deterministic fallback the host uses, so a fallback in a live
    // run is visible here instead of being hidden by a lower-level retry.
    const primary = createProviderPlanner({ provider, tools, allowedTools, name: 'gemini', timeoutMs });
    const { createFallbackPlanner } = await import('../src/agent/planner-provider.js');
    const planner = createFallbackPlanner({ primary, fallback: createDemoPlanner({}) });

    const runtime = createAgentRuntime({
      store,
      tools,
      planner,
      limits: { maxSteps: 4, maxCostMicros: 200_000, sessionBudgetMicros: 200_000 },
      workerId: 'wp31-live',
      logger: { error() {} }
    });
    const thread = await store.createThread({ ownerId: 'owner', title: `WP-3.1 live ${scenario.id}` });
    const submitted = await runtime.submit({ threadId: thread.id, message: scenario.goal });
    const run = await runtime.runToCompletion(submitted.run.id);
    const detail = await runtime.detail(run.id);
    const steps = detail.steps || [];
    const toolRuns = detail.toolRuns || [];
    const fallbackCodes = steps
      .filter((step) => step.title === 'احتياط حتمي مرئي')
      .map((step) => (/\((\w+)\)/.exec(step.summary || '')?.[1] || 'unknown'));
    const toolRisks = Object.fromEntries(toolRuns.map((toolRun) => [toolRun.toolName, tools.get(toolRun.toolName)?.risk || 'unknown']));
    const riskOrder = [...latencies].sort((a, b) => a - b);
    return {
      id: scenario.id,
      shape: scenario.shape,
      goal: scenario.goal,
      status: run.status,
      // The store exposes the run's terminal reason as `lastError` (column `last_error`); `error` is tolerated for fakes.
      error: run.lastError ?? run.error ?? null,
      decision: steps.filter((step) => step.kind === 'decide').map((step) => step.title).slice(0, 6),
      finishedSummary: String(steps.at(-1)?.summary || '').slice(0, 240),
      toolNames: toolRuns.map((toolRun) => toolRun.toolName),
      toolRisks,
      toolStatuses: toolRuns.map((toolRun) => toolRun.status),
      calls,
      providerCalls: latencies.length,
      providerLatencyMs: {
        samples: latencies,
        min: riskOrder[0] ?? null,
        median: riskOrder.length ? riskOrder[Math.floor((riskOrder.length - 1) / 2)] : null,
        max: riskOrder.at(-1) ?? null
      },
      tokens: run.usage?.tokens ?? 0,
      costMicros: run.usage?.costMicros ?? 0,
      steps: steps.length,
      fallbacks: fallbackCodes.length,
      fallbackCodes,
      verificationVerdict: detail.verification?.verdict ?? null,
      evidenceChainOk: detail.evidenceChain?.ok === true,
      outboxCount: (detail.outbox || []).length,
      approvalsCount: (detail.approvals || []).length
    };
  } finally {
    await driver?.close?.().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
}

function renderMarkdown(report) {
  const rows = report.runs.map((run) =>
    `| \`${run.id}\` | ${run.toolNames.length ? run.toolNames.join(', ') : '—'} | ${run.providerCalls} | ${run.providerLatencyMs.median ?? '—'} ms | ${run.tokens} | ${run.fallbacks} | ${run.verificationVerdict} |`
  );
  return [
    '# تشغيل حي معزول لمخطط Gemini (WP-3.1 / DEC-060)',
    '',
    `**الحكم:** ${report.gate.ok ? 'PASS' : 'FAIL'} · **النموذج:** \`${report.model}\` · **التشغيل:** ${report.runId || 'local'}`,
    `**الأدوات المسموحة:** ${report.allowedTools.join(', ')} · **حدود:** maxSteps=${report.bounds.maxSteps}, maxRuns=${report.bounds.maxRuns}, timeoutMs=${report.bounds.timeoutMs}`,
    '',
    '| الحالة | الأدوات المنفَّذة | نداءات المزوّد | وسيط الزمن | الرموز | احتياط | المتحقق |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    report.gate.ok
      ? 'كل الحالات خطّطها النموذج الحقيقي ونُفِّذت بأدوات قراءة فقط، وسلسلة الأدلة سليمة، والتكلفة غير مدّعاة (`costMicros: 0`).'
      : `**أسباب الفشل:** ${report.gate.failures.join(' · ')}`,
    '',
    '> هذا دليل على **تشغيل** المخطط الحقيقي داخل الصندوق المعزول فقط: ليس نشرًا، ولا تفعيلًا إنتاجيًا، ولا قياسًا لجودة التخطيط أو للتكلفة.',
    ''
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  const model = argOf(argv, 'model', process.env.GEMINI_MODEL || 'gemini-2.5-flash');
  const outPath = argOf(argv, 'out', DEFAULT_OUT);
  const requested = Number(argOf(argv, 'max-runs', String(LIVE_SCENARIOS.length)));
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_RUNS_CEILING) {
    process.stderr.write(`planner-live: --max-runs must be an integer between 1 and ${MAX_RUNS_CEILING}\n`);
    return 2;
  }
  if (!apiKey) {
    process.stderr.write('planner-live: GEMINI_API_KEY is not set. This script never runs on a missing key; in CI it comes from the repository secret.\n');
    return 2;
  }
  // The flag lives in this process only: nothing here activates provider mode for any deployed service.
  process.env.CELIA_AGENT_PLANNER = 'provider';

  const probeTools = createToolRegistry(defaultToolDefinitions({ statusProvider: () => ({}) }));
  const allowedTools = selectProviderTools({ tools: probeTools, kb: false });
  const timeoutMs = Number(process.env.CELIA_AGENT_PLANNER_TIMEOUT_MS || 20_000);
  const scenarios = LIVE_SCENARIOS.slice(0, requested);
  const startedAt = Date.now();
  const runs = [];
  for (const scenario of scenarios) {
    if (Date.now() - startedAt > WALL_CLOCK_CEILING_MS) {
      runs.push({ id: scenario.id, status: 'skipped_wall_clock', fallbacks: 0, fallbackCodes: [], tokens: 0, costMicros: 0, toolNames: [], toolRisks: {}, verificationVerdict: null, evidenceChainOk: false, outboxCount: null, approvalsCount: null });
      continue;
    }
    process.stdout.write(`planner-live: running ${scenario.id} (${scenario.shape})\n`);
    try {
      runs.push(await runScenario({ scenario, apiKey, model, timeoutMs, allowedTools }));
    } catch (error) {
      runs.push({
        id: scenario.id,
        shape: scenario.shape,
        goal: scenario.goal,
        status: `error:${error?.code || 'unexpected'}`,
        decision: [],
        toolNames: [],
        toolRisks: {},
        providerCalls: 0,
        providerLatencyMs: { samples: [], min: null, median: null, max: null },
        tokens: 0,
        costMicros: 0,
        steps: 0,
        fallbacks: 1,
        fallbackCodes: [String(error?.code || 'unexpected')],
        verificationVerdict: null,
        evidenceChainOk: false,
        outboxCount: 0,
        approvalsCount: 0
      });
    }
  }

  const report = {
    version: 1,
    decision: 'DEC-060',
    task: 'AI-002 / WP-3.1',
    scope: 'isolated live run; no production activation, no MySQL, no external effect',
    model,
    allowedTools,
    bounds: { maxSteps: 4, maxRuns: requested, timeoutMs, wallClockMs: Date.now() - startedAt },
    runId: process.env.GITHUB_RUN_ID || null,
    sha: process.env.GITHUB_SHA || null,
    runs
  };
  report.gate = evaluateLiveGate({ runs, report, env: process.env });
  const serialized = sanitize(JSON.stringify(report, null, 2), process.env);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${serialized}\n`, 'utf8');
  await mkdir('.validation-artifacts', { recursive: true });
  await writeFile('.validation-artifacts/planner-live-summary.md', `${sanitize(renderMarkdown(report), process.env)}\n`, 'utf8');

  // Annotations are the only channel a reviewer can read without downloading the artifact, so the notice carries
  // every measured fact (latency samples, fallback codes, counters) in one sanitized line.
  process.stdout.write(
    `::notice title=Planner live · ${report.gate.ok ? 'PASS' : 'FAIL'}::${sanitize(JSON.stringify({
      model,
      bounds: report.bounds,
      allowedTools: report.allowedTools,
      runs: runs.map((run) => ({
        id: run.id,
        status: run.status,
        error: run.error || null,
        tools: run.toolNames,
        toolStatuses: run.toolStatuses,
        providerCalls: run.providerCalls,
        calls: run.calls,
        samplesMs: run.providerLatencyMs.samples,
        minMs: run.providerLatencyMs.min,
        medianMs: run.providerLatencyMs.median,
        maxMs: run.providerLatencyMs.max,
        tokens: run.tokens,
        costMicros: run.costMicros,
        steps: run.steps,
        fallbacks: run.fallbacks,
        fallbackCodes: run.fallbackCodes,
        verdict: run.verificationVerdict,
        evidenceChainOk: run.evidenceChainOk,
        outboxCount: run.outboxCount,
        approvalsCount: run.approvalsCount,
        decision: run.decision
      }))
    }), process.env)}\n`
  );
  for (const failure of report.gate.failures) {
    process.stdout.write(`::error title=Planner live gate::${sanitize(failure, process.env)}\n`);
  }
  process.stdout.write(`${sanitize(renderMarkdown(report), process.env)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${sanitize(renderMarkdown(report), process.env)}\n`);
  }
  return report.gate.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`planner-live failed: ${error?.code || 'unexpected'}\n`);
    process.exit(1);
  });
}

export { PROVIDER_PLAN_SCHEMA };
