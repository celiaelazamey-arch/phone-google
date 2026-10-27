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

const EXECUTABLE = new Set([RISK.read, RISK.internalWrite]);

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
      return [...tools.values()].map(({ name, description, risk, arguments: args = {} }) => ({
        name,
        description,
        risk,
        arguments: args
      }));
    },
    executable(name) {
      const tool = tools.get(name);
      return Boolean(tool && EXECUTABLE.has(tool.risk) && typeof tool.execute === 'function');
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
export function knowledgeToolDefinitions({ kb } = {}) {
  if (!kb) return [];
  return [
    {
      name: 'kb.search',
      description: 'بحث في شبكة المعرفة المحلية وإرجاع أدلة مع المصدر والترخيص ومستوى الثقة',
      risk: RISK.read,
      timeoutMs: 5000,
      arguments: { query: 'string', limit: 'number' },
      async execute(args) {
        const query = typeof args?.query === 'string' ? args.query.trim() : '';
        if (!query) throw new Error('query is required');
        const limit = Number.isInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 8) : 4;
        const result = await kb.search({ query, limit, maxChars: 900 });
        return {
          terms: result.terms,
          items: result.items.map((item) => ({
            id: item.id,
            title: item.title,
            uri: item.uri,
            kind: item.kind,
            trust: item.trust,
            licence: item.licence,
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

export function defaultToolDefinitions({ statusProvider, kb } = {}) {
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
    {
      name: 'google.calendar_create_event',
      description: 'إنشاء موعد في Google Calendar — أثر خارجي يمرّ بـ outbox بعد موافقة صريحة',
      risk: RISK.externalEffect,
      requiresApproval: true,
      connector: 'google.calendar',
      arguments: { summary: 'string', start: 'string', end: 'string' }
    },
    {
      name: 'sandbox.exec',
      description: 'تنفيذ كود داخل حاوية معزولة — غير متاح قبل AGENT-003',
      risk: RISK.irreversible,
      requiresApproval: true,
      arguments: { code: 'string' }
    },
    ...knowledgeToolDefinitions({ kb })
  ];
}
