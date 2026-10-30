import { readFileSync } from 'node:fs';

/**
 * سجل مزوّدي الفهارس/الاستطلاع — **بيانات قرار لا قدرة**.
 *
 * كل مزوّد هنا معطّل (`enabled: false`). الغرض أن يكون «ما نرفضه» مُقيدًا في ملف
 * يقرأه اختبار، لا نثرًا في وثيقة: فمن يضيف مزوّدًا إلى قائمة سماح غدًا يصطدم
 * باختبار بدل أن يمرّ بصمت. المصدر: `docs/source-providers.json` (§8 من خطة الفجوات).
 */

const SOURCE = new URL('../docs/source-providers.json', import.meta.url);

export const PROVIDER_DECISIONS = Object.freeze([
  'candidate',
  'deferred',
  'refused',
  'data-source',
  'reference',
]);

function fail(message) {
  const error = new Error(`source-providers: ${message}`);
  error.code = 'source_providers_invalid';
  throw error;
}

/** يتحقّق من الشكل والقواعد الملزمة، ثم يعيد السجل مجمّدًا. */
export function validateRegistry(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.providers)) fail('registry or providers missing');
  const seen = new Set();
  for (const provider of raw.providers) {
    if (!provider || typeof provider.id !== 'string' || !provider.id.trim()) fail('provider without id');
    const id = provider.id.trim();
    if (seen.has(id)) fail(`duplicate provider ${id}`);
    seen.add(id);
    if (!PROVIDER_DECISIONS.includes(provider.decision)) fail(`unknown decision for ${id}`);
    if (typeof provider.reason !== 'string' || provider.reason.trim().length < 20) {
      fail(`provider ${id} needs a real reason`);
    }
    if (provider.decision === 'refused' && provider.enabled !== false) fail(`refused provider ${id} cannot be enabled`);
    // لا مزوّد مفعّلًا في هذا الإصدار: التفعيل قرار مالك مكتوب لا قيمة افتراضية.
    if (provider.enabled !== false) fail(`provider ${id} must ship disabled`);
    // أي مزوّد يُرسل استعلامًا خارجيًا يخدم المالك وحده.
    if (provider.sendsQueryUpstream && provider.ownerScopedOnly !== true) {
      fail(`provider ${id} sends a query upstream and must be owner-scoped`);
    }
    if (provider.decision === 'candidate' && typeof provider.opens !== 'string') {
      fail(`candidate ${id} must name the slice it opens`);
    }
  }
  return Object.freeze({
    version: raw.version,
    updated: raw.updated,
    notice: raw.notice,
    providers: Object.freeze(raw.providers.map((provider) => Object.freeze({ ...provider }))),
  });
}

export function loadSourceProviders(file = SOURCE) {
  return validateRegistry(JSON.parse(readFileSync(file, 'utf8')));
}

const registry = loadSourceProviders();

export const SOURCE_PROVIDERS = registry.providers;

export function providerDecision(id) {
  const provider = SOURCE_PROVIDERS.find((entry) => entry.id === id);
  return provider ? provider.decision : 'unknown';
}

export function refusedProviders() {
  return SOURCE_PROVIDERS.filter((entry) => entry.decision === 'refused').map((entry) => entry.id);
}

export function candidateProviders() {
  return SOURCE_PROVIDERS.filter((entry) => entry.decision === 'candidate').map((entry) => entry.id);
}

export function isEnabledByDefault() {
  return SOURCE_PROVIDERS.some((entry) => entry.enabled === true);
}
