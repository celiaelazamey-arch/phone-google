/**
 * M-A/A1 (خطة «منافس مانوس») — مزوّد Gemini خلف عقد `provider.createPlan(request)`.
 *
 * هذا المحوّل لا يخطط ولا ينفّذ: يبني طلبًا واحدًا محدود الحجم إلى
 * `generateContent`، ويعيد مغلفًا `{ plan, model, usage }` يفحصه
 * `createProviderPlanner` بالمخطط الصارم `PROVIDER_PLAN_SCHEMA` قبل أن يصل أي
 * قرار إلى الحلقة. البوابة النهائية محلية دائمًا (`validateProviderPlan`)؛
 * `responseMimeType: application/json` وتضمين العقد في تعليمات النظام وسيلتان
 * لرفع نسبة الالتزام لا بديلان عن التحقق.
 *
 * حدود معلنة لهذه الشريحة:
 * - لا إعادة محاولة داخل المحوّل: أي فشل شبكة/حالة يُرفع بكود واحد واضح
 *   (`planner_provider_unavailable`) ويقرر الغلاف المحكوم ما يحدث بعده.
 * - `responseSchema/responseJsonSchema` لم يُرسلا عمدًا: العقد يحوي أنواعًا
 *   nullable وكائن `args` مفتوحًا لا يعبّر عنهما subset المخططات المضمون عبر
 *   كل الموديلات؛ اعتمادهما قرار لاحق بعد قياس حي (A5) لا افتراض.
 * - التكلفة غير مقاسة هنا (`costMicros: 0`)؛ قياسها وتوجيه النماذج ملك A4.
 */

const GEMINI_ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const PLACEHOLDER_RE = /^replace-with-/i;
const MODEL_ID_RE = /^[A-Za-z0-9._-]{2,128}$/;

export const GEMINI_PLANNER_MAX_OUTPUT_TOKENS = 1024;

/** سقوف حتمية لما يصل المزوّد — قصّ معلن لا إسقاط صامت. */
export const GEMINI_PLANNER_INPUT_LIMITS = Object.freeze({
  maxThreadMessages: 12,
  maxMessageChars: 2000,
  maxToolResultChars: 4000,
  maxMemoryItemChars: 600
});

function codedError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function truncateText(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[قُصّ ${text.length - max} حرفًا]`;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

/** نص النظام: العقد كاملًا + قواعد صارمة؛ يُبنى حتميًا من الطلب وحده. */
export function buildGeminiPlannerPrompt(request) {
  const limits = GEMINI_PLANNER_INPUT_LIMITS;
  const contract = {
    planSchema: request.planSchema,
    allowedTools: request.allowedTools,
    tools: request.tools
  };
  const system = [
    'أنت مخطط خطوة واحدة داخل حلقة وكيل محكومة. مهمتك إعادة كائن JSON واحد فقط يطابق planSchema حرفيًا، دون أي نص آخر ودون Markdown ودون أسوار شيفرة.',
    'القواعد غير القابلة للتفاوض:',
    '- action واحدة من: call (نفّذ أداة قراءة واحدة من allowedTools حصراً)، finish (الدليل كافٍ؛ ضع الخلاصة في summary)، clarify (الهدف غامض؛ ضع سؤال التوضيح في summary).',
    '- عند call: tool من allowedTools فقط و args كائن يطابق input_schema الخاص بالأداة. عند finish/clarify: tool=null و args=null و summary نص غير فارغ.',
    '- rationale يشرح سبب هذه الخطوة بإيجاز، و successCriteria قائمة 1-8 معايير قابلة للفحص.',
    '- لا تخترع أدوات أو حقولًا إضافية؛ أي حقل خارج المخطط يرفضه فاحص صارم خارجك.',
    '- لا تدّع تنفيذ شيء: أنت تقترح الخطوة التالية فقط والحلقة هي المنفّذ الوحيد.',
    'العقد (planSchema + الأدوات المتاحة):',
    JSON.stringify(contract)
  ].join('\n');

  const state = {
    goal: truncateText(request.goal, limits.maxMessageChars),
    threadMessages: (request.threadMessages || [])
      .slice(-limits.maxThreadMessages)
      .map((message) => ({ role: message.role, content: truncateText(message.content, limits.maxMessageChars) })),
    steps: (request.state?.steps || []).map((step) => ({
      index: step.index,
      kind: step.kind,
      title: truncateText(step.title, limits.maxMemoryItemChars),
      toolName: step.toolName || null
    })),
    toolResults: (request.state?.toolResults || []).map((result) => ({
      name: result.name,
      status: result.status,
      content: truncateText(JSON.stringify(result.content ?? null), limits.maxToolResultChars)
    })),
    memory: {
      summaries: (request.memory?.summaries || []).map((item) => ({
        ...item,
        summary: truncateText(item.summary, limits.maxMemoryItemChars)
      })),
      facts: (request.memory?.facts || []).map((item) => ({
        ...item,
        value: truncateText(item.value, limits.maxMemoryItemChars)
      }))
    }
  };
  return { system, user: JSON.stringify(state) };
}

/** جسم الطلب كاملًا — مفصول ليُختبر دون شبكة وليُسجَّل في أي تتبع لاحق. */
export function buildGeminiPlannerRequestBody(request) {
  const prompt = buildGeminiPlannerPrompt(request);
  return {
    systemInstruction: { parts: [{ text: prompt.system }] },
    contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: GEMINI_PLANNER_MAX_OUTPUT_TOKENS,
      responseMimeType: 'application/json'
    }
  };
}

export function createGeminiPlannerProvider({ apiKey, model = 'gemini-2.5-flash', fetchImpl = fetch } = {}) {
  const key = String(apiKey || '').trim();
  if (!key || PLACEHOLDER_RE.test(key) || key.length < 20) {
    throw new Error('Gemini planner provider requires a configured GEMINI_API_KEY (no placeholder, at least 20 characters)');
  }
  const modelId = String(model || '').trim();
  if (!MODEL_ID_RE.test(modelId)) throw new Error('Gemini planner model id is invalid');
  if (typeof fetchImpl !== 'function') throw new Error('Gemini planner provider requires a fetch implementation');
  const endpoint = `${GEMINI_ENDPOINT_BASE}/${encodeURIComponent(modelId)}:generateContent`;

  return {
    name: 'gemini-planner',
    model: modelId,
    endpoint,
    async createPlan(request) {
      const body = buildGeminiPlannerRequestBody(request);
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(body),
          signal: request.signal
        });
      } catch (error) {
        // الإلغاء/المهلة ملك `createProviderPlanner`؛ لا نعيد تسميته هنا.
        if (request.signal?.aborted || error?.name === 'AbortError') throw error;
        throw codedError('planner_provider_unavailable', `Gemini request failed: ${error?.message || 'network error'}`);
      }
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw codedError('planner_provider_unavailable', `Gemini responded with HTTP ${response.status}`);
      }
      const text = (result.candidates?.[0]?.content?.parts || [])
        .map((part) => part.text || '')
        .join('')
        .trim();
      if (!text) throw codedError('planner_provider_unavailable', 'Gemini returned no candidate text');

      // نص غير JSON يمر كما هو فيرفضه الفاحص بـ`invalid_provider_plan` — لا "إصلاح" صامت.
      let plan = text;
      try {
        plan = JSON.parse(text);
      } catch {
        /* strict rejection happens in createProviderPlanner */
      }
      // الشذوذ الوحيد المسوّى هنا: `args` كسلسلة JSON بدل كائن (سلوك موثق لبعض الموديلات).
      if (plan && typeof plan === 'object' && !Array.isArray(plan) && typeof plan.args === 'string') {
        try {
          plan = { ...plan, args: JSON.parse(plan.args) };
        } catch {
          /* validator rejects invalid_args */
        }
      }

      const usageMetadata = result.usageMetadata;
      const usage = {
        inputTokens: finiteNonNegative(usageMetadata?.promptTokenCount),
        outputTokens: finiteNonNegative(usageMetadata?.candidatesTokenCount),
        costMicros: 0,
        measured: Boolean(usageMetadata)
      };
      if (usageMetadata?.totalTokenCount !== undefined) {
        usage.totalTokens = finiteNonNegative(usageMetadata.totalTokenCount);
      }
      return { plan, model: result.modelVersion || modelId, usage };
    }
  };
}
