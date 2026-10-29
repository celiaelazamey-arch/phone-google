/**
 * Tool registry with mandatory risk classification.
 *
 * Risk levels (AGENT-001 / DEC-012 rule 2):
 * - `read`             pure read; retry is harmless.
 * - `internal_write`   writes only inside Celia's own durable state.
 * - `external_effect`  changes something outside Celia; requires approval (AGENT-002).
 * - `irreversible`     cannot be undone; requires approval and an isolated executor (AGENT-003).
 *
 * M1 executes `read`/`internal_write` only. `external_effect` and `irreversible`
 * are declared so the runtime can refuse them visibly instead of pretending.
 */

export const RISK = Object.freeze({
  read: 'read',
  internalWrite: 'internal_write',
  externalEffect: 'external_effect',
  irreversible: 'irreversible'
});

import { documentAutomationToolDefinitions } from './automation/index.js';
import { auditProductCatalog, buildCreativeWorkflowPlan } from './evaluation.js';
import { gmailToolDefinitions } from './gmail.js';
import { googleReadToolDefinitions } from './google-read.js';

const EXECUTABLE = new Set([RISK.read, RISK.internalWrite]);
const FORBIDDEN_SECRET_KEYS = new Set([
  'apiKey',
  'api_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'clientSecret',
  'client_secret',
  'authorization'
]);

/**
 * Validate tool arguments against the tool's declared contract and safety policy.
 * Returns `{ ok: true }` or `{ ok: false, code, message }`.
 */
export function validateToolInput(tool, args) {
  if (!tool) return { ok: false, code: 'unknown_tool', message: 'Tool is not registered' };
  if (args === null || args === undefined) return { ok: true };
  if (typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, code: 'invalid_tool_arguments', message: 'Tool arguments must be a JSON object' };
  }
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_SECRET_KEYS.has(key)) {
      return { ok: false, code: 'policy_violation_secret_in_args', message: `Secret field ${key} is forbidden in tool arguments` };
    }
  }
  const declared = tool.arguments && typeof tool.arguments === 'object' ? tool.arguments : {};
  const declaredKeys = Object.keys(declared);
  if (declaredKeys.length > 0) {
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined || value === null) continue;
      if (!(key in declared)) {
        return { ok: false, code: 'policy_violation_unknown_argument', message: `Argument ${key} is not in tool contract for ${tool.name}` };
      }
      const expectedType = declared[key];
      if (expectedType && typeof value !== expectedType) {
        return {
          ok: false,
          code: 'policy_violation_argument_type',
          message: `Argument ${key} must be of type ${expectedType}`
        };
      }
    }
  }
  if (tool.name === 'google.calendar_create_event' || tool.name === 'calendar.create') {
    if ('summary' in args && (!args.summary || typeof args.summary !== 'string' || !args.summary.trim())) {
      return { ok: false, code: 'policy_violation_summary_required', message: 'Event summary must be a non-empty string' };
    }
    if ('start' in args || 'end' in args) {
      const startMs = Date.parse(String(args.start || ''));
      const endMs = Date.parse(String(args.end || ''));
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return {
          ok: false,
          code: 'policy_violation_invalid_time_range',
          message: 'Event start and end must be valid ISO timestamps with end > start'
        };
      }
    }
  }
  if (tool.name === 'whatsapp.send_text') {
    if ('phone' in args && (typeof args.phone !== 'string' || !/^\+[1-9]\d{6,14}$/.test(args.phone.trim()))) {
      return {
        ok: false,
        code: 'policy_violation_invalid_phone',
        message: 'Recipient phone must be a valid E.164 number'
      };
    }
    if ('text' in args && (typeof args.text !== 'string' || !args.text.trim() || args.text.trim().length > 4096)) {
      return {
        ok: false,
        code: 'policy_violation_invalid_text',
        message: 'Message text must be 1..4096 non-empty characters'
      };
    }
  }
  if (tool.name === 'google.drive_export_report') {
    if ('title' in args && (typeof args.title !== 'string' || !args.title.trim() || args.title.trim().length > 200)) {
      return {
        ok: false,
        code: 'policy_violation_invalid_drive_title',
        message: 'Drive file title must be 1..200 non-empty characters'
      };
    }
    if ('content' in args && (typeof args.content !== 'string' || !args.content.trim() || args.content.length > 200_000)) {
      return {
        ok: false,
        code: 'policy_violation_invalid_drive_content',
        message: 'Drive file content must be 1..200000 characters'
      };
    }
    if ('mimeType' in args && args.mimeType !== null && args.mimeType !== undefined) {
      const normalizedMime = String(args.mimeType).trim().toLowerCase();
      if (!['application/json', 'text/plain', 'text/markdown', 'text/csv'].includes(normalizedMime)) {
        return {
          ok: false,
          code: 'policy_violation_unsupported_mime_type',
          message: 'Unsupported Drive export MIME type'
        };
      }
    }
  }
  if (typeof tool.validate === 'function') {
    const custom = tool.validate(args);
    if (custom && custom.ok === false) {
      return {
        ok: false,
        code: custom.code || 'policy_violation_custom',
        message: custom.message || custom.code || 'Tool policy validation failed'
      };
    }
  }
  return { ok: true };
}

export function createToolRegistry(definitions = []) {
  const tools = new Map();
  for (const definition of definitions) {
    if (!definition?.name || typeof definition.name !== 'string') throw new Error('Tool name is required');
    if (!Object.values(RISK).includes(definition.risk)) throw new Error(`Tool ${definition.name} needs a valid risk level`);
    if (tools.has(definition.name)) throw new Error(`Duplicate tool ${definition.name}`);
    if (!EXECUTABLE.has(definition.risk) && typeof definition.execute !== 'function') {
      // Declared but unimplemented tools still carry the refusal reason.
      tools.set(definition.name, Object.freeze({ ...definition, execute: null }));
      continue;
    }
    tools.set(definition.name, Object.freeze({ timeoutMs: 10_000, ...definition }));
  }
  return {
    get(name) {
      return tools.get(name) || null;
    },
    has(name) {
      return tools.has(name);
    },
    list() {
      return [...tools.values()].map(({ name, description, risk, requiresApproval = false, connector = null, arguments: args = {} }) => ({
        name,
        description,
        risk,
        requiresApproval: Boolean(requiresApproval || !EXECUTABLE.has(risk)),
        connector,
        arguments: args
      }));
    },
    executable(name) {
      const tool = tools.get(name);
      return Boolean(tool && EXECUTABLE.has(tool.risk) && typeof tool.execute === 'function');
    },
    validateInput(name, args) {
      const tool = tools.get(name);
      return validateToolInput(tool, args);
    }
  };
}

const OUTLINE_LIMIT = 700;

function outline(goal) {
  const cleaned = String(goal || '').replace(/\s+/g, ' ').trim().slice(0, OUTLINE_LIMIT);
  const sentences = cleaned.split(/(?<=[.!?؟])\s+/).filter(Boolean);
  return {
    goal: cleaned,
    steps: [
      'تحديد المخرج المطلوب ومعيار قبوله',
      'جمع السياق من الخيوط والملاحظات المتاحة',
      'صياغة مسودة أولى قابلة للمراجعة',
      'مراجعة الحدود: لا أثر خارجي بلا موافقة'
    ],
    sentences: sentences.slice(0, 6),
    note: 'مسودة آلية حتمية (planner تجريبي) — ليست نصيحة نهائية ولا تنفيذًا خارجيًا'
  };
}

/**
 * Default M1 tools. Nothing here reaches the network or a third party, so an
 * offline run is a truthful offline run.
 */
export function createDefaultTools(options = {}) {
  return createToolRegistry(defaultToolDefinitions(options));
}

/**
 * Read-only knowledge tools. They never reach the network: the knowledge store is
 * a local index, and every answer carries source, licence and trust level.
 */
export function knowledgeToolDefinitions({ kb, plannerSafe = false } = {}) {
  if (!kb) return [];
  return [
    {
      name: 'kb.search',
      // Provider construction checks this code-level marker and fails closed;
      // it is not part of the model-facing schema or a caller-supplied arg.
      plannerSafe: plannerSafe === true,
      description: plannerSafe
        ? 'بحث Planner آمن: مستندات operational_guidance فقط، T1/T2، وreview_due سارية؛ النتيجة تحمل provenance'
        : 'بحث في شبكة المعرفة المحلية وإرجاع أدلة مع المصدر والترخيص ومستوى الثقة',
      risk: RISK.read,
      timeoutMs: 5000,
      arguments: { query: 'string', limit: 'number' },
      async execute(args) {
        const query = typeof args?.query === 'string' ? args.query.trim() : '';
        if (!query) throw new Error('query is required');
        const limit = Number.isInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 8) : 4;
        const result = await kb.search({ query, limit, maxChars: 900, profile: plannerSafe ? 'planner' : 'default' });
        return {
          terms: result.terms,
          governance: result.governance || null,
          items: result.items.map((item) => ({
            id: item.id,
            title: item.title,
            uri: item.uri,
            kind: item.kind,
            trust: item.trust,
            licence: item.licence,
            claimType: item.claimType || null,
            reviewDue: item.reviewDue || null,
            reviewStatus: item.reviewStatus || 'missing',
            plannerEligible: item.plannerEligible === true,
            snippet: String(item.snippet || '').slice(0, 300)
          })),
          entities: result.entities.slice(0, 5).map((entity) => ({
            type: entity.type,
            key: entity.key,
            title: entity.title,
            risk: entity.risk,
            requiresApproval: entity.requiresApproval,
            wired: entity.wired
          })),
          omitted: result.omitted,
          reason: result.reason || null
        };
      }
    },
    {
      name: 'kb.tool_profile',
      description: 'ملف أداة من شبكة المعرفة: تصنيف المخاطر، الموافقة، التسجيل في الكود، والدليل',
      risk: RISK.read,
      timeoutMs: 5000,
      arguments: { name: 'string' },
      async execute(args) {
        const name = typeof args?.name === 'string' ? args.name.trim() : '';
        if (!name) throw new Error('name is required');
        const detail = await kb.entity('tool', name);
        if (!detail) throw new Error('tool_not_found');
        return detail;
      }
    },
    {
      name: 'kb.project_context',
      description: 'سياق مشروع من شبكة المعرفة مع المهارات والحواف المرتبطة',
      risk: RISK.read,
      timeoutMs: 5000,
      arguments: { key: 'string' },
      async execute(args) {
        const key = typeof args?.key === 'string' ? args.key.trim() : '';
        if (!key) throw new Error('key is required');
        const detail = await kb.entity('project', key);
        if (!detail) throw new Error('project_not_found');
        return detail;
      }
    }
  ];
}

export function defaultToolDefinitions({
  statusProvider,
  kb,
  documentAutomation = true,
  allowedDocumentRoots,
  modelRouter = null,
  ledgerStore = null,
  plannerSafe = false,
  gmail = null,
  googleReaders = {},
  // M-B/B1: منفّذ عزل AGENT-003 (createSandboxExecutor). الافتراض null يحفظ
  // تعريف الرفض القائم حرفيًا — التفعيل قرار استضافة معلن لا سلوك ضمني.
  sandbox = null
} = {}) {
  return [
    {
      name: 'celia.system_status',
      description: 'قراءة حالة النظام والإصدار والتخزين دون أي أسرار',
      risk: RISK.read,
      arguments: {},
      async execute() {
        const status = typeof statusProvider === 'function' ? await statusProvider() : {};
        return {
          version: status.version ?? null,
          storage: status.storage ?? null,
          toolsCount: status.toolsCount ?? null,
          providers: status.providers ?? null
        };
      }
    },
    {
      name: 'celia.thread_context',
      description: 'قراءة عدد رسائل الخيط الحالية وآخر رسالة فيه',
      risk: RISK.read,
      deterministic: true,
      arguments: {},
      replayArgs: () => ({}),
      async execute(_args, { context } = {}) {
        const messages = context?.messages || [];
        const last = messages[messages.length - 1];
        return {
          messageCount: messages.length,
          lastRole: last?.role ?? null,
          lastMessage: last ? String(last.content).slice(0, 400) : null
        };
      }
    },
    {
      name: 'celia.draft_outline',
      description: 'بناء مسودة مخطط حتمية من هدف المستخدم (لا كتابة خارجية)',
      risk: RISK.read,
      deterministic: true,
      arguments: { goal: 'string' },
      replayArgs: ({ messages = [] } = {}) => {
        const last = [...messages].reverse().find((message) => message.role === 'user');
        return { goal: last ? String(last.content) : '' };
      },
      async execute(args) {
        if (!args || typeof args.goal !== 'string' || !args.goal.trim()) {
          throw new Error('goal is required');
        }
        return outline(args.goal);
      }
    },
    ...gmailToolDefinitions({ gmail }),
    ...googleReadToolDefinitions(googleReaders),
    {
      name: 'google.calendar_create_event',
      description: 'إنشاء موعد في Google Calendar — أثر خارجي يمرّ بـ outbox بعد موافقة صريحة',
      risk: RISK.externalEffect,
      requiresApproval: true,
      connector: 'google.calendar',
      arguments: { summary: 'string', start: 'string', end: 'string' }
    },
    {
      name: 'whatsapp.send_text',
      description: 'إرسال رسالة واتساب نصية عبر outbox بعد موافقة صريحة والتحقق من نافذة 24 ساعة',
      risk: RISK.externalEffect,
      requiresApproval: true,
      connector: 'whatsapp.cloud',
      arguments: { phone: 'string', text: 'string' }
    },
    {
      name: 'google.drive_export_report',
      description: 'تصدير تقرير موثّق إلى Google Drive عبر outbox بعد موافقة صريحة ومنع التكرار',
      risk: RISK.externalEffect,
      requiresApproval: true,
      connector: 'google.drive',
      arguments: { title: 'string', content: 'string', mimeType: 'string' }
    },
    // M-B/B1: أول «محوّل» جديد يُبنى داخل العقد القائم نفسه — التصنيف يتبع الضمانة لا الاسم:
    // مع منفّذ AGENT-003 (شبكة deny، جذر قراءة، غير جذري، workspace معزول يُدمَّر) التنفيذ
    // كتابة داخلية مسوّاة محليًا؛ بدونه يبقى التعريف الرافض القائم حرفيًا. لا host fallback أبدًا:
    // أي حالة غير `succeeded` من المنفّذ تُرفع بكودها الصريح ولا يُنفَّذ أي شيء على المضيف.
    sandbox
      ? {
          name: 'sandbox.exec',
          description: 'تنفيذ Node داخل عزل AGENT-003 (شبكة deny، جذر قراءة فقط، غير جذري)؛ النتائج تصدر حصرًا كـartifacts مبصومة SHA-256 في سلسلة الأدلة',
          risk: RISK.internalWrite,
          // فشل العزل مسوّى محليًا بالتعريف (لا أثر خارجي جزئي ممكن) — الحلقة تسجله
          // `failed` قابلًا للقياس لا `unknown`، ولا تفتح مصالحة بشرية بلا داعٍ.
          settledFailures: true,
          timeoutMs: 35_000,
          arguments: { code: 'string' },
          async execute(args, { run } = {}) {
            const outcome = await sandbox.run({ runId: String(run?.id || ''), code: String(args?.code ?? '') });
            if (outcome.status !== 'succeeded') {
              throw Object.assign(new Error(outcome.reason || 'sandbox_execution_failed'), {
                code: outcome.reason || 'sandbox_execution_failed',
                sandbox: {
                  status: outcome.status,
                  verdict: outcome.verdict,
                  exitCode: outcome.exitCode ?? null,
                  signal: outcome.signal ?? null,
                  policyHash: outcome.policyHash
                }
              });
            }
            return {
              sandboxId: outcome.sandboxId,
              status: outcome.status,
              verdict: outcome.verdict,
              exitCode: outcome.exitCode ?? null,
              policyHash: outcome.policyHash,
              network: outcome.network,
              outputTruncated: Boolean(outcome.outputTruncated),
              artifacts: (outcome.artifacts || []).map((artifact) => ({
                id: artifact.id,
                runId: artifact.runId ?? null,
                name: artifact.name,
                bytes: artifact.bytes,
                sha256: artifact.sha256,
                uri: artifact.uri,
                expiresAt: artifact.expiresAt ?? null
              }))
            };
          }
        }
      : {
          name: 'sandbox.exec',
          description: 'تنفيذ كود داخل حاوية معزولة — غير متاح قبل AGENT-003',
          risk: RISK.irreversible,
          requiresApproval: true,
          arguments: { code: 'string' }
        },
    {
      name: 'product.catalog_audit',
      description: 'تحليل ملف/قائمة المنتجات واكتشاف الحقول الناقصة وصياغة وصف أولي للمراجعة قبل النشر',
      risk: RISK.read,
      deterministic: true,
      arguments: { products: 'object' },
      async execute(args) {
        const products = Array.isArray(args?.products) ? args.products : [];
        return auditProductCatalog({ products });
      }
    },
    {
      name: 'creative.workflow_plan',
      description: 'بناء سير عمل إبداعي من 6 مراحل (الملخص، الاتجاهات، المسودة، الفحص، التعديل، التسليم المنظم)',
      risk: RISK.read,
      deterministic: true,
      arguments: {
        brand: 'string',
        audience: 'string',
        message: 'string',
        style: 'string',
        dimensions: 'string'
      },
      async execute(args) {
        return buildCreativeWorkflowPlan(args || {});
      }
    },
    ...knowledgeToolDefinitions({ kb, plannerSafe }),
    ...(documentAutomation
      ? documentAutomationToolDefinitions({
          allowedRoots: allowedDocumentRoots,
          modelRouter,
          ledgerStore
        })
      : [])
  ];
}
