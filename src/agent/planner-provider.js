import { RISK } from './tools.js';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * Provider-planner contract for the first AI-002 vertical slice.
 *
 * A provider receives only the current goal/state, memory and a closed set of
 * read-only tool schemas. It returns one structured plan. The runtime remains
 * the only executor: this module never invokes a tool or a connector itself.
 */
export const PROVIDER_PLAN_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: ['action', 'tool', 'args', 'summary', 'rationale', 'successCriteria'],
  properties: {
    action: { type: 'string', enum: ['call', 'finish', 'clarify'] },
    tool: { type: ['string', 'null'], maxLength: 128 },
    args: { type: ['object', 'null'] },
    summary: { type: ['string', 'null'], maxLength: 4000 },
    rationale: { type: 'string', minLength: 1, maxLength: 2000 },
    successCriteria: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: { type: 'string', minLength: 1, maxLength: 500 }
    }
  }
});

const PLAN_PROPERTIES = new Set(Object.keys(PROVIDER_PLAN_SCHEMA.properties));
const ACTIONS = new Set(PROVIDER_PLAN_SCHEMA.properties.action.enum);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function codedError(code, providerTrace = null, details = []) {
  return Object.assign(new Error(code), { code, providerTrace, details });
}

function parseJson(value, code, trace) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw codedError(code, trace);
  }
}

/** Validate the exact plan envelope, then the action-specific invariants. */
export function validateProviderPlan(plan, { allowedTools = null } = {}) {
  const errors = [];
  if (!isObject(plan)) return { ok: false, errors: ['plan_not_object'] };
  for (const key of Object.keys(plan)) {
    if (!PLAN_PROPERTIES.has(key)) errors.push(`additional_property:${key}`);
  }
  for (const key of PROVIDER_PLAN_SCHEMA.required) {
    if (!Object.hasOwn(plan, key)) errors.push(`required:${key}`);
  }
  if (!ACTIONS.has(plan.action)) errors.push('invalid_action');
  if (plan.tool !== null && !nonEmptyString(plan.tool, 128)) errors.push('invalid_tool');
  if (plan.args !== null && !isObject(plan.args)) errors.push('invalid_args');
  if (plan.summary !== null && (typeof plan.summary !== 'string' || plan.summary.length > 4000)) {
    errors.push('invalid_summary');
  }
  if (!nonEmptyString(plan.rationale, 2000)) errors.push('rationale_required');
  if (!Array.isArray(plan.successCriteria) || plan.successCriteria.length < 1 || plan.successCriteria.length > 8
    || plan.successCriteria.some((item) => !nonEmptyString(item, 500))) {
    errors.push('success_criteria_required');
  }

  if (plan.action === 'call') {
    if (!nonEmptyString(plan.tool, 128)) errors.push('call_tool_required');
    if (!isObject(plan.args)) errors.push('call_args_required');
    if (Array.isArray(allowedTools) && !allowedTools.includes(plan.tool)) {
      errors.push(`tool_not_allowed:${plan.tool}`);
    }
  } else if (ACTIONS.has(plan.action)) {
    if (plan.tool !== null) errors.push('non_call_tool_must_be_null');
    if (plan.args !== null) errors.push('non_call_args_must_be_null');
    if (!nonEmptyString(plan.summary, 4000)) errors.push('non_call_summary_required');
  }
  return { ok: errors.length === 0, errors };
}

function schemaForTools(names) {
  return deepFreeze({
    ...PROVIDER_PLAN_SCHEMA,
    properties: {
      ...PROVIDER_PLAN_SCHEMA.properties,
      tool: { ...PROVIDER_PLAN_SCHEMA.properties.tool, enum: [...names, null] }
    }
  });
}

function plannerTools(tools, allowedTools) {
  if (!tools || typeof tools.list !== 'function') throw new Error('Provider planner requires the runtime tool registry');
  if (!Array.isArray(allowedTools) || allowedTools.length < 2 || allowedTools.length > 4) {
    throw new Error('AI-002 first slice requires between two and four allowed read tools');
  }
  const names = [...new Set(allowedTools)];
  if (names.length !== allowedTools.length) throw new Error('Duplicate provider planner tool');
  return names.map((name) => {
    const definition = tools.get(name);
    if (!definition) throw new Error(`Provider planner tool is not registered: ${name}`);
    if (name === 'kb.search' && definition.plannerSafe !== true) {
      throw new Error('Provider planner kb.search requires a plannerSafe tool definition');
    }
    if (definition.risk !== RISK.read || !tools.executable(name)) {
      throw new Error(`Provider planner tool must be an executable read tool: ${name}`);
    }
    const properties = Object.fromEntries(
      Object.entries(definition.arguments || {}).map(([key, type]) => [key, { type }])
    );
    return deepFreeze({
      name,
      description: definition.description || '',
      risk: definition.risk,
      input_schema: {
        type: 'object',
        properties,
        required: [],
        additionalProperties: false
      }
    });
  });
}

function lastGoal(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return String(messages[index].content || '');
  }
  return '';
}

function toolResultsOf(toolRuns = []) {
  return toolRuns.map((toolRun) => ({
    type: 'tool_result',
    tool_run_id: toolRun.id,
    step_id: toolRun.stepId || null,
    name: toolRun.toolName,
    status: toolRun.status,
    content: toolRun.parsedOutcome !== undefined ? toolRun.parsedOutcome : toolRun.outcome ?? null
  }));
}

function requestFor(context, definitions, names, planSchema) {
  const goal = lastGoal(context.messages);
  const toolResults = toolResultsOf(context.toolRuns);
  const memory = context.memory || { summaries: [], facts: [] };
  const threadMessages = (context.messages || []).map((message) => ({
    role: message.role,
    content: String(message.content || '')
  }));
  return {
    goal,
    messages: [{ role: 'user', type: 'goal', content: goal }, ...toolResults.map((item) => ({ role: 'tool', ...item }))],
    threadMessages,
    context: { memory, contextMemory: context.context_memory || null },
    state: {
      run: context.run ? { id: context.run.id, status: context.run.status } : null,
      goalContract: context.goalContract || null,
      steps: (context.steps || []).map((step) => ({
        id: step.id,
        index: step.index,
        kind: step.kind,
        title: step.title,
        toolName: step.toolName || null
      })),
      toolResults
    },
    memory,
    allowedTools: [...names],
    tools: definitions,
    planSchema
  };
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function usageOf(envelope) {
  const usage = isObject(envelope?.usage) ? envelope.usage : {};
  const inputTokens = finiteNonNegative(usage.inputTokens);
  const outputTokens = finiteNonNegative(usage.outputTokens);
  const totalTokens = usage.totalTokens === undefined
    ? inputTokens + outputTokens
    : finiteNonNegative(usage.totalTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costMicros: finiteNonNegative(usage.costMicros),
    measured: Boolean(usage.measured)
  };
}

async function callProvider(provider, request, timeoutMs) {
  if (request.signal?.aborted) throw codedError('planner_cancelled');
  const controller = new AbortController();
  let timer = null;
  let rejectCancellation;
  const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
  const cancel = (code) => {
    controller.abort();
    rejectCancellation(codedError(code));
  };
  const onAbort = () => cancel('planner_cancelled');
  if (request.signal?.aborted) onAbort();
  request.signal?.addEventListener('abort', onAbort, { once: true });
  timer = setTimeout(() => cancel('planner_provider_timeout'), timeoutMs);
  try {
    return await Promise.race([
      Promise.resolve().then(() => provider.createPlan({ ...request, signal: controller.signal })),
      cancellation
    ]);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Create a planner backed by an injected provider. No provider SDK, network,
 * retries, fallback or live enablement is built into this first slice.
 */
export function createProviderPlanner({
  provider,
  tools,
  allowedTools,
  timeoutMs = 20_000,
  name = 'provider-structured-v1'
} = {}) {
  if (!provider || typeof provider.createPlan !== 'function') {
    throw new Error('Provider planner requires provider.createPlan(request)');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Provider planner timeout must be positive');
  const definitions = plannerTools(tools, allowedTools);
  const names = Object.freeze(definitions.map((item) => item.name));
  const planSchema = schemaForTools(names);

  return {
    name,
    providerDriven: true,
    allowedTools: names,
    async plan(context) {
      const request = requestFor(context, definitions, names, planSchema);
      const trace = { provider: provider.name || name, model: provider.model || null, request, plan: null };
      let envelope;
      try {
        envelope = await callProvider(provider, { ...request, signal: context.signal }, timeoutMs);
      } catch (error) {
        if (error.providerTrace) throw error;
        throw codedError(error.code || 'planner_provider_unavailable', trace);
      }
      envelope = parseJson(envelope, 'invalid_provider_plan', trace);
      const rawPlan = isObject(envelope) && Object.hasOwn(envelope, 'plan') ? envelope.plan : envelope;
      const plan = parseJson(rawPlan, 'invalid_provider_plan', trace);
      trace.plan = plan;
      trace.model = envelope?.model || trace.model;
      const validation = validateProviderPlan(plan, { allowedTools: names });
      if (!validation.ok) throw codedError('invalid_provider_plan', trace, validation.errors);
      const failedRead = (context.toolRuns || []).find((toolRun) => toolRun.status !== 'succeeded');
      if (failedRead && plan.action === 'call') {
        // WP-3.2 owns any future revision policy. This slice may observe a
        // failure and finish/clarify, but may not silently choose another call.
        throw codedError('automatic_replan_disabled', trace, [`failed_tool:${failedRead.toolName}`]);
      }
      if (plan.action === 'call') {
        const inputCheck = tools.validateInput(plan.tool, plan.args);
        if (!inputCheck.ok) throw codedError(inputCheck.code || 'invalid_provider_tool_arguments', trace, [inputCheck.code]);
      }
      const usage = usageOf(envelope);
      return {
        action: plan.action === 'clarify' ? 'finish' : plan.action,
        tool: plan.action === 'call' ? plan.tool : undefined,
        args: plan.action === 'call' ? plan.args : undefined,
        summary: plan.summary,
        reason: plan.rationale,
        failed: plan.action === 'clarify',
        clarification: plan.action === 'clarify',
        successCriteria: plan.successCriteria,
        tokens: usage.totalTokens,
        costMicros: usage.costMicros,
        providerTrace: { ...trace, usage }
      };
    }
  };
}
