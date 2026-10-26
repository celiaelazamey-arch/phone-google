import { DEFAULT_POLICY, generateWhatsAppReply } from './gemini.js';

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
    return { reachable: false, model, modelAvailable: false, reason: error.message || 'unreachable' };
  }
}

export async function generateOllamaReply({
  baseUrl = 'http://127.0.0.1:11434',
  model = 'qwen2.5:7b',
  businessContext = '',
  customerMessage,
  allowRemote = false,
  timeoutMs = 45_000
}) {
  if (typeof customerMessage !== 'string' || !customerMessage.trim()) {
    throw new Error('customerMessage is required');
  }
  const origin = normalizeOllamaBaseUrl(baseUrl, allowRemote);
  const systemText = `${DEFAULT_POLICY}${businessContext ? ` سياق النشاط المعتمد: ${String(businessContext).slice(0, 4000)}` : ''}`;
  const response = await fetch(`${origin}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
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
    throw new Error(`Ollama rejected the request (${response.status})${result.error ? `: ${String(result.error).slice(0, 160)}` : ''}`);
  }
  const text = String(result.message?.content || result.response || '').trim();
  if (!text) throw new Error('Ollama returned no usable reply');
  return text.slice(0, 1000);
}

export async function generateCeliaReply({ config, customerMessage, provider = 'auto', businessContext }) {
  const requested = String(provider || config.celia?.aiProvider || 'auto').toLowerCase();
  if (!['auto', 'gemini', 'ollama'].includes(requested)) {
    throw new Error('provider must be auto, gemini, or ollama');
  }
  const context = typeof businessContext === 'string' ? businessContext : (config.gemini?.businessContext || '');

  if (requested === 'gemini' || (requested === 'auto' && config.gemini?.apiKey)) {
    const primaryModel = config.gemini?.model || 'gemini-2.5-flash';
    try {
      const reply = await generateWhatsAppReply({
        config: { gemini: { apiKey: config.gemini.apiKey, model: primaryModel, businessContext: context } },
        customerMessage
      });
      return { reply, provider: 'gemini', model: primaryModel };
    } catch (geminiError) {
      if (/\((404|429|503)\)/.test(geminiError.message)) {
        for (const fallbackModel of ['gemini-flash-latest', 'gemini-flash-lite-latest']) {
          if (fallbackModel === primaryModel) continue;
          try {
            const reply = await generateWhatsAppReply({
              config: { gemini: { apiKey: config.gemini.apiKey, model: fallbackModel, businessContext: context } },
              customerMessage
            });
            return { reply, provider: 'gemini', model: fallbackModel };
          } catch {
            // Try next fallback model
          }
        }
      }
      if (requested === 'gemini') throw geminiError;
      const ollamaStatus = await checkOllamaHealth({
        baseUrl: config.ollama?.baseUrl,
        model: config.ollama?.model,
        allowRemote: config.ollama?.allowRemote
      });
      if (!ollamaStatus.reachable) throw geminiError;
    }
  }

  if (requested === 'ollama' || requested === 'auto') {
    const model = config.ollama?.model || 'qwen2.5:7b';
    const reply = await generateOllamaReply({
      baseUrl: config.ollama?.baseUrl || 'http://127.0.0.1:11434',
      model,
      businessContext: context,
      customerMessage,
      allowRemote: Boolean(config.ollama?.allowRemote)
    });
    return { reply, provider: 'ollama', model };
  }

  throw new Error('No AI provider configured');
}
