import { DEFAULT_POLICY, generateWhatsAppReplyDetailed } from './gemini.js';
import { buildContext } from './context-policy.js';
import { generateOpenAiCompatibleReply } from './ai-providers.js';
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
  knowledge = [],
  history = [],
  budgets,
  allowRemote = false,
  timeoutMs = 8000,
  signal
}) {
  if (typeof customerMessage !== 'string' || !customerMessage.trim()) {
    throw new Error('customerMessage is required');
  }
  const origin = normalizeOllamaBaseUrl(baseUrl, allowRemote);
  // WP-2.1 (DEC-051): the context policy decides what the local model sees, same as the cloud providers.
  const context = buildContext({ instructions: DEFAULT_POLICY, business: businessContext, message: customerMessage, knowledge, history }, budgets);
  const response = await fetch(`${origin}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature: 0.2, num_predict: 180 },
      messages: [
        { role: 'system', content: context.system },
        { role: 'user', content: context.user }
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

export const SUPPORTED_AI_PROVIDERS = Object.freeze([
  'auto',
  'gemini',
  'ai_gateway',
  'deepseek',
  'agentrouter',
  'ollama',
  'local'
]);

export function resolveEffectiveAiProvider(config = {}) {
  const configured = String(config.celia?.aiProvider || 'auto').toLowerCase();
  if (configured !== 'auto' && SUPPORTED_AI_PROVIDERS.includes(configured)) {
    return configured;
  }
  if (config.gemini?.apiKey && config.features?.gemini !== false) return 'gemini';
  if (config.aiGateway?.apiKey && config.features?.ai_gateway !== false) return 'ai_gateway';
  if (config.deepseek?.apiKey && config.features?.deepseek !== false) return 'deepseek';
  if (config.agentrouter?.apiKey && config.features?.agentrouter !== false) return 'agentrouter';
  if (config.features?.ollama !== false) return 'ollama';
  return 'local';
}

export async function generateCeliaReply({ config, customerMessage, provider, businessContext, services = createServiceRegistry(config) }) {
  const requested = String(provider || config.celia?.aiProvider || 'auto').toLowerCase();
  if (!SUPPORTED_AI_PROVIDERS.includes(requested)) {
    throw new Error('provider must be auto, gemini, ai_gateway, deepseek, agentrouter, ollama, or local');
  }
  if (typeof customerMessage !== 'string' || !customerMessage.trim()) throw new Error('customerMessage is required');
  const context = typeof businessContext === 'string' ? businessContext : (config.gemini?.businessContext || '');
  const failures = [];
  const callGemini = async () => {
    if (!config.gemini?.apiKey) throw new Error('Gemini API is not configured');
    const model = config.gemini.model || 'gemini-2.5-flash';
    const detailed = await services.run('gemini', (signal) => generateWhatsAppReplyDetailed({
      config: { gemini: { apiKey: config.gemini.apiKey, model, businessContext: context } },
      customerMessage, signal
    }));
    // WP-1.4: truncation facts travel with the reply so the caller can count them.
    const { text: reply, ...truncation } = detailed;
    return { reply, provider: 'gemini', model, degraded: failures.length > 0, policyEnforced: true, truncation };
  };
  const callOpenAiProvider = async (serviceName, providerCfg, defaultModel) => {
    if (!providerCfg?.apiKey) throw new Error(`${serviceName} API is not configured`);
    const model = providerCfg.model || defaultModel;
    const reply = await services.run(serviceName, (signal) => generateOpenAiCompatibleReply({
      serviceName,
      baseUrl: providerCfg.baseUrl,
      apiKey: providerCfg.apiKey,
      model,
      businessContext: context,
      customerMessage,
      signal
    }));
    return { reply, provider: serviceName, model, degraded: failures.length > 0, policyEnforced: true };
  };
  const callAiGateway = () => callOpenAiProvider('ai_gateway', config.aiGateway, 'google/gemini-2.5-flash');
  const callDeepseek = () => callOpenAiProvider('deepseek', config.deepseek, 'deepseek-flash');
  const callAgentRouter = () => callOpenAiProvider('agentrouter', config.agentrouter, 'deepseek-chat');
  const callOllama = async () => {
    const model = config.ollama?.model || 'qwen2.5:7b';
    const reply = await services.run('ollama', (signal) => generateOllamaReply({
      baseUrl: config.ollama?.baseUrl, model, businessContext: context, customerMessage,
      allowRemote: Boolean(config.ollama?.allowRemote), signal
    }));
    return { reply, provider: 'ollama', model, degraded: failures.length > 0, policyEnforced: true };
  };
  // Explicit providers are strict. By default auto calls at most one cloud provider and fails over only to local processing,
  // unless CELIA_AI_ALLOW_CLOUD_FAILOVER=true explicitly authorizes cross-vendor cloud failover.
  if (requested === 'gemini') return callGemini();
  if (requested === 'ai_gateway') return callAiGateway();
  if (requested === 'deepseek') return callDeepseek();
  if (requested === 'agentrouter') return callAgentRouter();
  if (requested === 'ollama') return callOllama();
  if (requested === 'auto') {
    const cloudCandidates = [
      { id: 'gemini', configured: Boolean(config.gemini?.apiKey), enabled: config.features?.gemini !== false, run: callGemini },
      { id: 'ai_gateway', configured: Boolean(config.aiGateway?.apiKey), enabled: config.features?.ai_gateway !== false, run: callAiGateway },
      { id: 'deepseek', configured: Boolean(config.deepseek?.apiKey), enabled: config.features?.deepseek !== false, run: callDeepseek },
      { id: 'agentrouter', configured: Boolean(config.agentrouter?.apiKey), enabled: config.features?.agentrouter !== false, run: callAgentRouter }
    ].filter((item) => item.configured && item.enabled);

    const allowedClouds = config.allowCloudFailover ? cloudCandidates : cloudCandidates.slice(0, 1);
    for (const candidate of allowedClouds) {
      try {
        return await candidate.run();
      } catch (error) {
        failures.push({ provider: candidate.id, reason: safeError(error) });
      }
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
