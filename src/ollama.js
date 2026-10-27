import { DEFAULT_POLICY, generateWhatsAppReply } from './gemini.js';
import { generateLocalPolicyReply } from './policy.js';
import { createServiceRegistry, safeError, UpstreamError } from './resilience.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function normalizeOllamaBaseUrl(rawUrl = 'http://127.0.0.1:11434', allowRemote = false) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl).trim());
  } catch {
    throw new Error('OLLAMA_BASE_URL must be a valid HTTP/HTTPS URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('OLLAMA_BASE_URL must use http or https');
  }
  if (!allowRemote && !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('OLLAMA_BASE_URL must point to localhost/127.0.0.1 unless OLLAMA_ALLOW_REMOTE=true');
  }
  if (parsed.username || parsed.password) throw new Error('OLLAMA_BASE_URL must not contain credentials');
  return parsed.origin;
}

export async function checkOllamaHealth({
  baseUrl = 'http://127.0.0.1:11434',
  model = 'qwen2.5:7b',
  allowRemote = false,
  timeoutMs = 1500
} = {}) {
  try {
    const origin = normalizeOllamaBaseUrl(baseUrl, allowRemote);
    const response = await fetch(`${origin}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      return { reachable: false, model, modelAvailable: false, reason: `http_${response.status}` };
    }
    const payload = await response.json().catch(() => ({}));
    const models = Array.isArray(payload.models)
      ? payload.models.map((item) => String(item.name || item.model || '')).filter(Boolean)
      : [];
    const target = model.toLowerCase();
    const modelAvailable = models.some((name) => {
      const lower = name.toLowerCase();
      return lower === target || lower === `${target}:latest`;
    });
    return { reachable: true, model, modelAvailable, installedModels: models.slice(0, 20) };
  } catch (error) {
    return { reachable: false, model, modelAvailable: false, reason: 'unreachable' };
  }
}

export async function generateOllamaReply({
  baseUrl = 'http://127.0.0.1:11434',
  model = 'qwen2.5:7b',
  businessContext = '',
  customerMessage,
  allowRemote = false,
  timeoutMs = 8000,
  signal
}) {
  if (typeof customerMessage !== 'string' || !customerMessage.trim()) {
    throw new Error('customerMessage is required');
  }
  const origin = normalizeOllamaBaseUrl(baseUrl, allowRemote);
  const systemText = `${DEFAULT_POLICY}${businessContext ? ` سياق النشاط المعتمد: ${String(businessContext).slice(0, 4000)}` : ''}`;
  const response = await fetch(`${origin}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature: 0.2, num_predict: 180 },
      messages: [
        { role: 'system', content: systemText },
        { role: 'user', content: customerMessage.slice(0, 4000) }
      ]
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new UpstreamError('ollama', response.status);
  }
  const text = String(result.message?.content || result.response || '').trim();
  if (!text) throw new Error('Ollama returned no usable reply');
  return text.slice(0, 1000);
}

export async function generateCeliaReply({ config, customerMessage, provider, businessContext, services = createServiceRegistry(config) }) {
  const requested = String(provider || config.celia?.aiProvider || 'auto').toLowerCase();
  if (!['auto', 'gemini', 'ollama', 'local'].includes(requested)) {
    throw new Error('provider must be auto, gemini, ollama, or local');
  }
  if (typeof customerMessage !== 'string' || !customerMessage.trim()) throw new Error('customerMessage is required');
  const context = typeof businessContext === 'string' ? businessContext : (config.gemini?.businessContext || '');
  const failures = [];
  const callGemini = async () => {
    if (!config.gemini?.apiKey) throw new Error('Gemini API is not configured');
    const model = config.gemini.model || 'gemini-2.5-flash';
    const reply = await services.run('gemini', (signal) => generateWhatsAppReply({
      config: { gemini: { apiKey: config.gemini.apiKey, model, businessContext: context } },
      customerMessage, signal
    }));
    return { reply, provider: 'gemini', model, degraded: false, policyEnforced: true };
  };
  const callOllama = async () => {
    const model = config.ollama?.model || 'qwen2.5:7b';
    const reply = await services.run('ollama', (signal) => generateOllamaReply({
      baseUrl: config.ollama?.baseUrl, model, businessContext: context, customerMessage,
      allowRemote: Boolean(config.ollama?.allowRemote), signal
    }));
    return { reply, provider: 'ollama', model, degraded: failures.length > 0, policyEnforced: true };
  };
  // Explicit providers are strict. Auto fails over only to local processing, never to a new cloud vendor.
  if (requested === 'gemini') return callGemini();
  if (requested === 'ollama') return callOllama();
  if (requested === 'auto') {
    if (config.gemini?.apiKey && config.features?.gemini !== false) {
      try { return await callGemini(); } catch (error) { failures.push({ provider: 'gemini', reason: safeError(error) }); }
    }
    if (config.features?.ollama !== false) {
      try { return await callOllama(); } catch (error) { failures.push({ provider: 'ollama', reason: safeError(error) }); }
    }
  }
  return {
    reply: generateLocalPolicyReply({ customerMessage, businessContext: context }),
    provider: 'celia-local-policy-engine', model: 'celia-guard-ar-2026',
    degraded: failures.length > 0, fallbackReasons: failures, policyEnforced: true,
    notice: 'رد قواعد محلي محافظ، وليس نموذج ذكاء اصطناعي توليديًا. لا ينفذ أي إجراء خارجي.'
  };
}
