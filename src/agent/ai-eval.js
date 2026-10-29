import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSqliteDriver } from './drivers.js';
import { createAgentStore } from './store.js';
import { createAgentRuntime } from './runtime.js';
import { createToolRegistry, RISK } from './tools.js';
import { createCalendarConnector, createConnectorRegistry } from './connectors.js';
import { extractArabicAppointment } from './ai-eval-parser.js';
import { hashOf } from './evidence.js';
import { percentile } from './timing.js';

export const AI_EVAL_THRESHOLDS = Object.freeze({
  minimumCases: 100,
  appointmentSuccessRate: 0.95,
  p50MsExclusive: 30_000,
  p95MsExclusive: 120_000,
  additionalInterventionRateExclusive: 0.1,
  casePassRate: 1,
  duplicateEvents: 0,
  unauthorizedWrites: 0,
  unknownReconciliationRate: 1,
  blindResends: 0
});

const TOOL_NAME = 'eval.extract_appointment';
const CALENDAR_TOOL = 'google.calendar_create_event';
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const round = (value) => Number.isFinite(value) ? Number(value.toFixed(6)) : null;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Load the frozen JSONL corpus; expectations stay outside the provider input. */
export async function loadAiEvalCases(directory) {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => entry.name)
    .sort();
  const cases = [];
  const digest = createHash('sha256');
  for (const file of files) {
    const content = await readFile(path.join(directory, file), 'utf8');
    digest.update(file).update('\0').update(content).update('\0');
    for (const [index, line] of content.split('\n').entries()) {
      if (!line.trim()) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${file}:${index + 1}: ${error.message}`);
      }
      cases.push({ ...value, source: `${file}:${index + 1}` });
    }
  }
  const ids = new Set();
  for (const item of cases) {
    if (!item?.id || !item.message || !item.referenceTime || !item.expected) throw new Error(`Incomplete AI-001 case: ${item.source || 'unknown'}`);
    if (ids.has(item.id)) throw new Error(`Duplicate AI-001 case id: ${item.id}`);
    ids.add(item.id);
    if (item.timeZone !== 'Africa/Cairo') throw new Error(`${item.id}: AI-001 requires Africa/Cairo`);
    if (!Number.isFinite(Date.parse(item.referenceTime))) throw new Error(`${item.id}: invalid referenceTime`);
  }
  if (cases.length < AI_EVAL_THRESHOLDS.minimumCases) throw new Error(`AI-001 needs at least 100 cases; found ${cases.length}`);
  if (!files.length) throw new Error('AI-001 has no JSONL files');
  return { cases, datasetSha256: digest.digest('hex'), files };
}

function lastUserContent(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return String(messages[index].content || '');
  }
  return '';
}

function inputFor(scenario, message) {
  return {
    message,
    referenceTime: scenario.referenceTime,
    timeZone: scenario.timeZone,
    busy: clone(scenario.busy || [])
  };
}

function makeTools(scenario) {
  return createToolRegistry([
    {
      name: TOOL_NAME,
      description: 'مستخرج عربي حتمي للتقييم فقط',
      risk: RISK.read,
      deterministic: true,
      arguments: { message: 'string', referenceTime: 'string', timeZone: 'string', busy: 'object' },
      replayArgs: ({ messages }) => inputFor(scenario, lastUserContent(messages)),
      async execute(args) {
        return extractArabicAppointment(args);
      }
    },
    {
      name: CALENDAR_TOOL,
      description: 'إنشاء حدث Calendar عبر outbox في تقييم AI-001',
      risk: RISK.externalEffect,
      requiresApproval: true,
      connector: 'google.calendar',
      arguments: { summary: 'string', start: 'string', end: 'string' }
    }
  ]);
}

function makePlanner(scenario) {
  return {
    name: 'ai-001-deterministic-mock',
    async plan(context) {
      if (scenario.providerFailure === 'planner' && context.toolRuns.length === 0) {
        throw Object.assign(new Error('mock planner unavailable'), { code: 'mock_provider_unavailable' });
      }
      const extraction = context.toolRuns.find((item) => item.toolName === TOOL_NAME);
      if (!extraction) return { action: 'call', tool: TOOL_NAME, args: inputFor(scenario, lastUserContent(context.messages)), reason: 'تحليل الطلب العربي قبل اقتراح أي أثر' };
      if (extraction.status !== 'succeeded') return { action: 'finish', failed: true, summary: 'فشل التحليل؛ لم يُنشأ أثر خارجي.' };
      const analysis = extraction.parsedOutcome;
      if (analysis.decision !== 'proposal') {
        return {
          action: 'finish',
          failed: true,
          summary: `توقف آمن (${analysis.decision}): ${analysis.reason || 'لا توجد مسودة قابلة للتنفيذ'}؛ لم يُنشأ حدث.`
        };
      }
      const entry = context.outbox[0] || null;
      if (!entry) return { action: 'call', tool: CALENDAR_TOOL, args: analysis.payload, reason: 'عرض مسودة الموعد للموافقة' };
      if (entry.status === 'sent') {
        return { action: 'finish', summary: `تم تسجيل نتيجة قابلة للتحقق؛ مرجع الحدث ${entry.externalRef || 'غير متاح'} وسلسلة الأدلة مرفقة.` };
      }
      if (entry.status === 'failed' && entry.result?.reconciled) {
        return { action: 'finish', failed: true, summary: 'سجلت المصالحة أن الأثر غير موجود؛ لم تُرسل المحاولة مجددًا.' };
      }
      return { action: 'finish', failed: true, summary: `انتهت النية بحالة ${entry.status}؛ لا نجاح ولا إعادة إرسال.` };
    }
  };
}

function makeCalendar(scenario, store) {
  const requests = [];
  const events = [];
  let runId = null;
  let ambiguousSeen = false;
  const transport = {
    async insertEvent({ calendarId, event }) {
      const approvals = runId ? await store.listApprovals(runId) : [];
      const approvedAtRequest = approvals.some((item) => item.decision === 'approved');
      requests.push({ calendarId, event: clone(event), approvedAtRequest, blindResend: ambiguousSeen });
      const reference = `evt-${scenario.id.toLowerCase()}-${events.length + 1}`;
      if (scenario.providerFailure === 'ambiguous' && scenario.reconcileOutcome === 'applied') {
        events.push({ id: reference, event: clone(event) });
      }
      if (scenario.providerFailure === 'ambiguous') {
        ambiguousSeen = true;
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      if (scenario.providerFailure === 'definitive') {
        throw Object.assign(new Error('bad request'), { status: 400, code: 'invalid' });
      }
      events.push({ id: reference, event: clone(event) });
      return { id: reference, htmlLink: `https://calendar.example/${reference}`, iCalUID: event.iCalUID };
    }
  };
  return {
    requests,
    events,
    setRunId(value) { runId = value; },
    connectors: createConnectorRegistry([createCalendarConnector({ transport, timeZone: scenario.timeZone })])
  };
}

function same(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function payloadIntegrity(requests, displayedPayload) {
  return requests.every((request) => {
    if (!displayedPayload) return false;
    return request.event.summary === displayedPayload.summary
      && Date.parse(request.event.start?.dateTime || '') === Date.parse(displayedPayload.start || '')
      && Date.parse(request.event.end?.dateTime || '') === Date.parse(displayedPayload.end || '');
  });
}

async function runCase(scenario, { store, setClock }) {
  // Execution providers receive only scenario inputs. Keep expectations in the
  // assertion scope so a future planner/connector edit cannot read the answer.
  const { expected, ...executionScenario } = scenario;
  const started = performance.now();
  setClock(Date.parse(executionScenario.referenceTime));
  const ownerId = `owner-${executionScenario.id.toLowerCase()}`;
  const thread = await store.createThread({ ownerId, title: `AI-001 ${executionScenario.id}` });
  for (const message of executionScenario.context || []) {
    await store.appendMessage({ threadId: thread.id, role: message.role, content: message.content });
  }
  const calendar = makeCalendar(executionScenario, store);
  const runtime = createAgentRuntime({
    store,
    tools: makeTools(executionScenario),
    planner: makePlanner(executionScenario),
    ownerId,
    connectors: calendar.connectors,
    clock: () => Date.parse(executionScenario.referenceTime),
    workerId: `worker-${executionScenario.id.toLowerCase()}`,
    logger: { error() {} }
  });
  const clientMessageId = `client-${executionScenario.id.toLowerCase()}`;
  const submitted = await runtime.submit({ threadId: thread.id, message: executionScenario.message, clientMessageId });
  calendar.setRunId(submitted.run.id);
  let duplicateReplay = false;
  if (executionScenario.duplicateMessage) {
    const replay = await runtime.submit({ threadId: thread.id, message: executionScenario.message, clientMessageId });
    duplicateReplay = replay.duplicate && replay.run.id === submitted.run.id;
  }

  let run = await runtime.runToCompletion(submitted.run.id);
  let displayedPayload = null;
  let displayedPayloadHash = null;
  if (run.status === 'waiting_approval') {
    const beforeDecision = await runtime.detail(run.id);
    displayedPayload = clone(beforeDecision.plan?.payload ?? null);
    displayedPayloadHash = beforeDecision.plan?.payloadHash ?? null;
    if (executionScenario.ownerDecision === 'approved' || executionScenario.ownerDecision === 'rejected') {
      await runtime.approve(run.id, {
        decision: executionScenario.ownerDecision,
        note: `AI-001 ${executionScenario.id}`,
        idempotencyKey: `decision-${executionScenario.id.toLowerCase()}`
      });
      run = await runtime.runToCompletion(run.id);
    }
  }

  let unknownObserved = false;
  let reconciled = false;
  let detail = await runtime.detail(run.id);
  const unknownOutbox = detail.outbox.find((entry) => entry.status === 'unknown');
  const unknownTool = detail.toolRuns.find((entry) => entry.status === 'unknown' || entry.status === 'started');
  unknownObserved = Boolean(unknownOutbox || unknownTool);
  if (unknownObserved) {
    // A resume while unresolved must not send again.
    await runtime.runToCompletion(run.id);
    const outcome = executionScenario.reconcileOutcome || 'not_applied';
    const externalRef = outcome === 'applied' ? calendar.events[0]?.id || null : null;
    await runtime.reconcile(run.id, {
      target: unknownOutbox ? 'outbox' : 'tool_run',
      targetId: unknownOutbox?.id || unknownTool.id,
      outcome,
      externalRef,
      note: `AI-001 owner finding: ${outcome}`,
      idempotencyKey: `reconcile-${executionScenario.id.toLowerCase()}`
    });
    run = await runtime.runToCompletion(run.id);
    detail = await runtime.detail(run.id);
    reconciled = detail.evidence.some((entry) => entry.kind === 'reconciliation')
      && detail.outbox.every((entry) => entry.status !== 'unknown' && entry.status !== 'dispatching')
      && detail.toolRuns.every((entry) => entry.status !== 'unknown' && entry.status !== 'started');
  }

  if (executionScenario.duplicateMessage) {
    const replay = await runtime.submit({ threadId: thread.id, message: executionScenario.message, clientMessageId });
    duplicateReplay = duplicateReplay && replay.duplicate && replay.run.id === run.id;
  }

  detail = await runtime.detail(run.id);
  const extraction = detail.toolRuns.find((item) => item.toolName === TOOL_NAME);
  const analysis = extraction?.outcome || null;
  const decision = analysis?.decision || (executionScenario.providerFailure === 'planner' ? 'provider_error' : 'unknown');
  const outbox = detail.outbox[0] || null;
  const ownerDecision = detail.approvals.at(-1)?.decision || null;
  const runCount = (await store.listRuns(thread.id)).length;
  const unauthorizedWrites = calendar.requests.filter((request) => !request.approvedAtRequest).length;
  const blindResends = calendar.requests.filter((request) => request.blindResend).length;
  const duplicateEvents = Math.max(0, calendar.events.length - 1);
  const integrity = payloadIntegrity(calendar.requests, displayedPayload);
  const result = {
    id: scenario.id,
    category: scenario.category,
    source: scenario.source,
    decision,
    draftPayload: clone(analysis?.payload ?? null),
    displayedPayload,
    displayedPayloadHash,
    ownerDecision,
    runStatus: detail.run.status,
    runCount,
    duplicateReplay,
    outbox: outbox ? {
      id: outbox.id,
      status: outbox.status,
      idempotencyKey: outbox.idempotencyKey,
      attempts: outbox.attempts,
      externalRef: outbox.externalRef,
      reconciled: outbox.result?.reconciled === true
    } : null,
    eventRef: outbox?.externalRef ?? null,
    provider: {
      requestCount: calendar.requests.length,
      eventCount: calendar.events.length,
      eventRefs: calendar.events.map((event) => event.id),
      requests: calendar.requests.map((request) => ({
        approvedAtRequest: request.approvedAtRequest,
        blindResend: request.blindResend,
        summary: request.event.summary,
        start: request.event.start,
        end: request.event.end
      }))
    },
    payloadIntegrity: integrity,
    unknownObserved,
    reconciled,
    additionalHumanIntervention: ['clarification', 'conflict', 'provider_error'].includes(decision)
      || unknownObserved || outbox?.status === 'failed',
    verification: detail.verification?.verdict ?? null,
    evidenceChainOk: detail.evidenceChain.ok,
    evidenceHead: detail.evidence.at(-1)?.hash ?? null,
    evidence: detail.evidence.map((entry) => ({
      seq: entry.seq,
      kind: entry.kind,
      verdict: entry.verdict,
      sourceIds: entry.sourceIds,
      prevHash: entry.prevHash,
      hash: entry.hash
    })),
    duplicateEvents,
    unauthorizedWrites,
    blindResends
  };

  const failures = [];
  const expect = (field, actual, expected) => {
    if (!same(actual, expected)) failures.push(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  expect('decision', result.decision, expected.decision);
  expect('draftPayload', result.draftPayload, expected.payload ?? null);
  expect('displayedPayload', result.displayedPayload, expected.displayedPayload ?? null);
  expect('ownerDecision', result.ownerDecision, executionScenario.ownerDecision ?? null);
  expect('runStatus', result.runStatus, expected.runStatus);
  expect('outboxStatus', result.outbox?.status ?? null, expected.outboxStatus ?? null);
  expect('verification', result.verification, expected.verification ?? null);
  expect('providerRequests', result.provider.requestCount, expected.providerRequests);
  expect('providerEvents', result.provider.eventCount, expected.providerEvents);
  expect('eventRef', result.eventRef, expected.externalRef ?? null);
  expect('reconciled', result.reconciled, expected.reconciled === true);
  expect('duplicateReplay', result.duplicateReplay, expected.duplicateReplay === true);
  expect('unknownObserved', result.unknownObserved, executionScenario.providerFailure === 'ambiguous');
  expect('evidenceChainOk', result.evidenceChainOk, true);
  expect('payloadIntegrity', result.payloadIntegrity, true);
  expect('runCount', result.runCount, 1);
  expect('duplicateEvents', result.duplicateEvents, 0);
  expect('unauthorizedWrites', result.unauthorizedWrites, 0);
  expect('blindResends', result.blindResends, 0);
  result.failures = failures;
  result.pass = failures.length === 0;
  result.durationMs = Number((performance.now() - started).toFixed(3));
  return result;
}

export function evaluateAiGates(metrics) {
  const definitions = [
    ['dataset_size', metrics.totalCases, '>=', AI_EVAL_THRESHOLDS.minimumCases, metrics.totalCases >= AI_EVAL_THRESHOLDS.minimumCases],
    ['required_duplicate_case', metrics.duplicateScenarioCount, '>=', 1, metrics.duplicateScenarioCount >= 1],
    ['required_unknown_case', metrics.unknownScenarioCount, '>=', 1, metrics.unknownScenarioCount >= 1],
    ['appointment_success', metrics.appointmentSuccessRate, '>=', AI_EVAL_THRESHOLDS.appointmentSuccessRate, metrics.appointmentSuccessRate !== null && metrics.appointmentSuccessRate >= AI_EVAL_THRESHOLDS.appointmentSuccessRate],
    ['latency_p50', metrics.p50Ms, '<', AI_EVAL_THRESHOLDS.p50MsExclusive, metrics.p50Ms !== null && metrics.p50Ms < AI_EVAL_THRESHOLDS.p50MsExclusive],
    ['latency_p95', metrics.p95Ms, '<', AI_EVAL_THRESHOLDS.p95MsExclusive, metrics.p95Ms !== null && metrics.p95Ms < AI_EVAL_THRESHOLDS.p95MsExclusive],
    ['additional_intervention', metrics.additionalInterventionRate, '<', AI_EVAL_THRESHOLDS.additionalInterventionRateExclusive, metrics.additionalInterventionRate !== null && metrics.additionalInterventionRate < AI_EVAL_THRESHOLDS.additionalInterventionRateExclusive],
    ['case_conformance', metrics.casePassRate, '>=', AI_EVAL_THRESHOLDS.casePassRate, metrics.casePassRate === AI_EVAL_THRESHOLDS.casePassRate],
    ['duplicate_event_creation', metrics.duplicateEvents, '===', 0, metrics.duplicateEvents === 0],
    ['unauthorized_external_write', metrics.unauthorizedWrites, '===', 0, metrics.unauthorizedWrites === 0],
    ['unknown_reconciliation', metrics.unknownReconciliationRate, '>=', 1, metrics.unknownReconciliationRate !== null && metrics.unknownReconciliationRate >= 1],
    ['blind_resend', metrics.blindResends, '===', 0, metrics.blindResends === 0]
  ];
  return definitions.map(([id, actual, comparator, threshold, pass]) => ({ id, actual, comparator, threshold, pass }));
}

function buildReport(scenarios, cases, datasetSha256) {
  const eligible = scenarios.filter((scenario) => scenario.expected.runStatus === 'succeeded'
    && scenario.expected.outboxStatus === 'sent' && scenario.expected.providerEvents === 1);
  const eligibleIds = new Set(eligible.map((scenario) => scenario.id));
  const correctAppointments = cases.filter((item) => eligibleIds.has(item.id) && item.pass).length;
  const unknownOutcomes = cases.filter((item) => item.unknownObserved).length;
  const reconciledUnknowns = cases.filter((item) => item.unknownObserved && item.reconciled).length;
  const durations = cases.map((item) => item.durationMs);
  const metrics = {
    totalCases: cases.length,
    passedCases: cases.filter((item) => item.pass).length,
    casePassRate: cases.length ? cases.filter((item) => item.pass).length / cases.length : null,
    appointmentEligible: eligible.length,
    correctAppointments,
    appointmentSuccessRate: eligible.length ? correctAppointments / eligible.length : null,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    additionalInterventions: cases.filter((item) => item.additionalHumanIntervention).length,
    additionalInterventionRate: cases.length ? cases.filter((item) => item.additionalHumanIntervention).length / cases.length : null,
    duplicateEvents: cases.reduce((sum, item) => sum + item.duplicateEvents, 0),
    unauthorizedWrites: cases.reduce((sum, item) => sum + item.unauthorizedWrites, 0),
    unknownOutcomes,
    reconciledUnknowns,
    unknownReconciliationRate: unknownOutcomes ? reconciledUnknowns / unknownOutcomes : null,
    blindResends: cases.reduce((sum, item) => sum + item.blindResends, 0),
    duplicateScenarioCount: scenarios.filter((scenario) => scenario.duplicateMessage).length,
    unknownScenarioCount: scenarios.filter((scenario) => scenario.providerFailure === 'ambiguous').length
  };
  for (const key of ['casePassRate', 'appointmentSuccessRate', 'additionalInterventionRate', 'unknownReconciliationRate']) metrics[key] = round(metrics[key]);
  const gates = evaluateAiGates(metrics);
  return {
    schema_version: '1.0',
    suite: 'AI-001',
    provider: { kind: 'deterministic-arabic-mock', network: false, liveModelQualityMeasured: false },
    timeZone: 'Africa/Cairo',
    dataset: { cases: cases.length, sha256: datasetSha256 || hashOf(scenarios) },
    thresholds: AI_EVAL_THRESHOLDS,
    metrics,
    cost: { measurable: false, totalUsd: null, costPerCompletedAppointmentUsd: null },
    gates,
    pass: gates.every((gate) => gate.pass),
    cases
  };
}

/** Run cases through the real durable runtime, approval gate, outbox and evidence chain. */
export async function runAiEvaluation({ cases, datasetSha256 = null } = {}) {
  if (!Array.isArray(cases) || !cases.length) throw new Error('AI-001 requires cases');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'celia-ai-001-'));
  let driver;
  try {
    driver = await createSqliteDriver({ path: path.join(directory, 'eval.sqlite3') });
    let sequence = 0;
    let clockMs = Date.parse(cases[0].referenceTime);
    const store = createAgentStore({
      driver,
      clock: () => clockMs,
      idFactory: () => `ai001-${String(++sequence).padStart(8, '0')}`
    });
    const results = [];
    for (const scenario of cases) {
      results.push(await runCase(scenario, { store, setClock: (value) => { clockMs = value; } }));
    }
    return buildReport(cases, results, datasetSha256);
  } finally {
    if (driver) await driver.close();
    await rm(directory, { recursive: true, force: true });
  }
}
