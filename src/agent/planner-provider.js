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

/* -------------------------------------------------------------------------- */
/* WP-3.1 (DEC-059): one concrete provider adapter + a visible deterministic   */
/* fallback. The adapter is a transport: it forwards the closed request, maps  */
/* the answer, and can be injected/replaced in any test without a network.     */
/* -------------------------------------------------------------------------- */

/**
 * System instruction for the provider planner. It states the contract the executor already enforces:
 * one JSON object, only the listed read tools, no invented tool, no external effect, no prose.
 */
export const GEMINI_PLANNER_POLICY = [
  'أنت مخطط تنفيذ داخل نظام محدود الصلاحيات.',
  'أعد كائن JSON واحدًا فقط يطابق المخطط المعطى بلا أي نص قبله أو بعده وبلا Markdown.',
  'الحقول المطلوبة كلها: action وtool وargs وsummary وrationale وsuccessCriteria.',
  'action إما call أو finish أو clarify. عند call يجب أن يكون tool أحد الأدوات المدرجة حرفيًا في القائمة المغلقة، وargs كائنًا يطابق مدخلاتها.',
  'عند finish أو clarify يجب أن يكون tool وargs بالقيمة null وأن يحمل summary النتيجة أو سؤال التوضيح.',
  'لا تخترع أداة ولا وسيطًا غير مدرج، ولا تطلب تنفيذ أي أثر خارجي أو كتابة أو شبكة؛ الأدوات المتاحة قراءة فقط.',
  'rationale جملة واحدة تشرح لماذا هذا القرار اعتمادًا على الحالة ونتائج الأدوات السابقة، وsuccessCriteria من عنصر إلى ثمانية عناصر قابلة للتحقق.',
  'إن كانت المعلومات ناقصة فاختر clarify بدل تخمين قيمة.'
].join('\n');

/** Gemini accepts a closed subset of JSON Schema; these keys are not part of it. */
const GEMINI_UNSUPPORTED_SCHEMA_KEYS = Object.freeze([
  'additionalProperties',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  '$schema',
  'title'
]);

/**
 * Converts our local plan schema into Gemini's response-schema dialect.
 *
 * The local schema stays the authority: `type: ['string','null']` becomes `{ type: 'string', nullable: true }`,
 * which is the only nullable spelling Gemini accepts, and anything outside its subset is dropped from the wire
 * (never from our validator — the same plan is still checked locally against PROVIDER_PLAN_SCHEMA).
 */
export function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const convert = (node) => {
    if (Array.isArray(node)) return node.map(convert);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.includes(key)) continue;
      if (key === 'properties' && value && typeof value === 'object') {
        out.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, convert(child)]));
        continue;
      }
      out[key] = convert(value);
    }
    if (Array.isArray(out.type)) {
      const types = out.type.filter((type) => type !== 'null');
      out.type = types.length === 1 ? types[0] : types;
      if (node.type.includes('null')) out.nullable = true;
    }
    if (Array.isArray(out.enum)) {
      const values = out.enum.filter((value) => value !== null);
      if (values.length !== out.enum.length) out.nullable = true;
      out.enum = values;
    }
    return out;
  };
  return deepFreeze(convert(schema));
}

function plannerUsage(usageMetadata) {
  const inputTokens = finiteNonNegative(usageMetadata?.promptTokenCount);
  const outputTokens = finiteNonNegative(usageMetadata?.candidatesTokenCount);
  return {
    inputTokens,
    outputTokens,
    totalTokens: usageMetadata?.totalTokenCount === undefined ? inputTokens + outputTokens : finiteNonNegative(usageMetadata.totalTokenCount),
    // Cost is not claimed: this repository holds no price table, and DEC-054/DEC-059 forbid inventing one.
    costMicros: 0,
    measured: Boolean(usageMetadata),
    priceKnown: false
  };
}

/**
 * Gemini planner transport (WP-3.1, DEC-059).
 *
 * - No retry, no silent second endpoint, no SDK. One POST, one JSON body, one closed schema.
 * - Errors carry a code and the HTTP status only: never the key, never the response body, never the prompt.
 * - `fetchImpl` is injectable so a test can exercise the exact wire contract offline.
 */
export function createGeminiPlannerProvider({
  apiKey,
  model = 'gemini-2.5-flash',
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
  timeoutMs = 20_000
} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw codedError('planner_provider_not_configured');
  if (typeof fetchImpl !== 'function') throw codedError('planner_provider_transport_missing');
  if (typeof model !== 'string' || !model.trim()) throw codedError('planner_provider_model_invalid');
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:generateContent`;

  return {
    name: 'gemini',
    model,
    kind: 'cloud',
    async createPlan(request) {
      // The request the runtime built is the whole state: goal, thread, tool results, memory, closed tool set.
      const body = {
        systemInstruction: { parts: [{ text: GEMINI_PLANNER_POLICY }] },
        contents: [
          {
            role: 'user',
            parts: [{
              text: JSON.stringify({
                goal: request.goal,
                threadMessages: request.threadMessages,
                state: request.state,
                memory: request.memory,
                allowedTools: request.allowedTools,
                tools: request.tools
              })
            }]
          }
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(request.planSchema)
        }
      };
      const signal = request.signal
        ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
          signal
        });
      } catch (error) {
        // A cancellation is not a provider failure; the wrapper below re-throws it unchecked.
        if (request.signal?.aborted) throw codedError('planner_cancelled');
        throw codedError(error?.name === 'TimeoutError' ? 'planner_provider_timeout' : 'planner_provider_unreachable');
      }
      if (!response.ok) {
        throw codedError('planner_provider_failed', null, [`http_status:${response.status}`]);
      }
      const data = await response.json().catch(() => null);
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .map((part) => String(part?.text || ''))
        .join('')
        .trim();
      if (!text) throw codedError('planner_provider_empty', null, [`finish_reason:${data?.candidates?.[0]?.finishReason || 'unknown'}`]);
      return { plan: text, model: String(data?.modelVersion || model), usage: plannerUsage(data?.usageMetadata) };
    }
  };
}

/** Codes that mean "the model did not deliver a usable plan" — the only ones the fallback may answer. */
export const PLANNER_PROVIDER_FAILURES = Object.freeze([
  'invalid_provider_plan',
  'invalid_provider_tool_arguments',
  'planner_provider_not_configured',
  'planner_provider_transport_missing',
  'planner_provider_model_invalid',
  'planner_provider_unreachable',
  'planner_provider_failed',
  'planner_provider_empty',
  'planner_provider_timeout',
  'planner_provider_unavailable',
  'automatic_replan_disabled'
]);

/**
 * Deterministic fallback wrapper (WP-3.1, DEC-059).
 *
 * Enabling a provider must never make the loop *less* reliable than the demo planner, and a silent switch would be
 * worse than either. So a provider failure produces the demo decision **with a marker** (`plannerFallback`) that the
 * runtime turns into a visible step and a `plan_created` evidence entry with verdict `block`.
 *
 * Refusals that must not be softened:
 *   - `planner_cancelled` is re-thrown: a cancelled run never plans again, with any planner.
 *   - a failure the fallback itself hits is re-thrown as the original error with its provider trace.
 * The wrapper inherits the provider's closed tool allowlist, so turning the flag on can never widen the tool surface.
 */
export function createFallbackPlanner({ primary, fallback, name = null } = {}) {
  if (!primary?.plan) throw new Error('Fallback planner requires a primary planner');
  if (!fallback?.plan) throw new Error('Fallback planner requires a deterministic fallback planner');
  return {
    name: name || `${primary.name}+deterministic-fallback`,
    providerDriven: primary.providerDriven === true,
    allowedTools: primary.allowedTools ? [...primary.allowedTools] : null,
    primary: primary.name,
    fallback: fallback.name,
    async plan(context) {
      try {
        return await primary.plan(context);
      } catch (error) {
        const code = error?.code || 'planner_provider_unavailable';
        if (code === 'planner_cancelled' || context?.signal?.aborted) throw error;
        if (!PLANNER_PROVIDER_FAILURES.includes(code)) throw error;
        const decision = await fallback.plan(context);
        const plannerFallback = {
          code,
          details: Array.isArray(error.details) ? [...error.details] : [],
          provider: error?.providerTrace?.provider || primary.name,
          model: error?.providerTrace?.model || null,
          request: error?.providerTrace?.request || null
        };
        const allowed = Array.isArray(primary.allowedTools) ? primary.allowedTools : null;
        if (allowed && decision?.action === 'call' && !allowed.includes(decision.tool)) {
          // DEC-062: the fallback may never widen the tool surface. The deterministic planner reasons about the whole
          // registry, so after a provider failure it can name a tool the closed provider list does not contain; handing
          // that to the runtime produced a dead run (`planner_tool_not_allowed`) in live run 40937158612. A bounded,
          // verified delivery names the blocked tool and stops instead.
          return {
            action: 'finish',
            failed: true,
            summary: `تعذّر التخطيط بالمزوّد (${code})، واقترح الاحتياط أداةً خارج نطاق المخطط (${decision.tool}) فلم تُنفَّذ. لم يُحدث التشغيل أثرًا خارجيًا؛ أعد المحاولة لاحقًا.`,
            reason: code,
            successCriteria: ['A bounded delivery with no external effect and a named reason.'],
            plannerFallback: { ...plannerFallback, blockedTool: decision.tool }
          };
        }
        return { ...decision, plannerFallback };
      }
    }
  };
}
