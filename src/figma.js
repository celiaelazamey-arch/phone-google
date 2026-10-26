/**
 * جسر Figma → واجهة حية — المهمة T4 (المرحلة 3)
 * ------------------------------------------------------------------
 * يقرأ ملف/إطار Figma عبر REST API (قراءة مجانية على الباقة المجانية)،
 * ثم يُنتج ملخصًا مُصفّى وواجهة HTML/CSS عربية مستقلة بلا موارد خارجية.
 *
 * الأمان:
 *  - التوكن في الترويسة فقط (X-Figma-Token أو Bearer)، لا في الرابط.
 *  - التحقق الصارم من fileKey/nodeId قبل بناء أي URL (منع SSRF/حقن مسار).
 *  - لا تُعاد الاستجابة الخام أبدًا؛ تُستخرج حقول محددة فقط بعد تعقيمها.
 *  - كل نص يدخل HTML يمرّ على escapeHtml، ولا يُسمح بأي سكربت أو رابط خارجي.
 */

import { normalizeProviderBaseUrl } from './ai-router.js';

const DEFAULT_BASE_URL = 'https://api.figma.com/v1';
const FIGMA_HOSTS = new Set(['figma.com', 'www.figma.com']);
const FILE_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
const NODE_ID_RE = /^[A-Za-z0-9:;_-]{1,80}$/;

export class FigmaError extends Error {
  constructor(message, { code = 'figma_error', status = 0 } = {}) {
    super(message);
    this.name = 'FigmaError';
    this.code = code;
    this.status = status;
  }
}

function boundedInt(raw, fallback, min, max) {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function loadFigmaConfig(env = process.env) {
  let accessToken = clean(env.FIGMA_ACCESS_TOKEN);
  if (accessToken.length >= 2 && ((accessToken.startsWith('"') && accessToken.endsWith('"')) || (accessToken.startsWith("'") && accessToken.endsWith("'")))) {
    accessToken = accessToken.slice(1, -1).trim();
  }
  return Object.freeze({
    accessToken,
    baseUrl: normalizeProviderBaseUrl(env.FIGMA_BASE_URL, DEFAULT_BASE_URL),
    timeoutMs: boundedInt(env.FIGMA_TIMEOUT_MS, 12_000, 1000, 60_000),
    maxNodes: boundedInt(env.FIGMA_MAX_NODES, 40, 5, 200),
    maxDepth: boundedInt(env.FIGMA_MAX_DEPTH, 4, 1, 8)
  });
}

/** يقبل رابط ملف/تصميم Figma أو fileKey مباشر، ويعيد مرجعًا مُتحققًا منه. */
export function parseFigmaReference(input) {
  const raw = clean(input);
  if (!raw) throw new FigmaError('figma_reference_required', { code: 'invalid_reference' });
  if (FILE_KEY_RE.test(raw) && !raw.includes('/')) {
    return { fileKey: raw, nodeId: null, source: 'file_key' };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new FigmaError('figma_reference_must_be_a_valid_url', { code: 'invalid_reference' });
  }
  if (url.protocol !== 'https:' || !FIGMA_HOSTS.has(url.hostname.toLowerCase())) {
    throw new FigmaError('figma_reference_must_be_an_https_figma_url', { code: 'invalid_reference' });
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const marker = parts.findIndex((part) => ['file', 'design', 'proto', 'board'].includes(part.toLowerCase()));
  const fileKey = marker >= 0 ? parts[marker + 1] : '';
  if (!FILE_KEY_RE.test(fileKey || '')) {
    throw new FigmaError('figma_file_key_is_invalid', { code: 'invalid_reference' });
  }
  const rawNode = url.searchParams.get('node-id');
  const nodeId = rawNode ? rawNode.replace(/-/g, ':') : null;
  if (nodeId && !NODE_ID_RE.test(nodeId)) {
    throw new FigmaError('figma_node_id_is_invalid', { code: 'invalid_reference' });
  }
  return { fileKey, nodeId, source: 'url' };
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function toHex(color) {
  if (!color || typeof color !== 'object') return null;
  const channel = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(255, Math.round(n * 255)))
      .toString(16)
      .padStart(2, '0');
  };
  const r = channel(color.r);
  const g = channel(color.g);
  const b = channel(color.b);
  return r && g && b ? `#${r}${g}${b}`.toUpperCase() : null;
}

function shortText(value, max = 120) {
  return clean(value).slice(0, max);
}

/** استخراج شجرة مُصفّاة (بلا بيانات حساسة) مع عدّاد للعقد. */
export function sanitizeFigmaTree(rootNode, { maxNodes = 40, maxDepth = 4 } = {}) {
  const colors = new Set();
  const fonts = new Set();
  const components = new Set();
  let visited = 0;
  let truncated = false;

  function walk(node, depth) {
    if (!node || typeof node !== 'object') return null;
    if (visited >= maxNodes) {
      truncated = true;
      return null;
    }
    visited += 1;
    const result = {
      id: shortText(node.id, 60),
      name: shortText(node.name || node.type || 'node', 120),
      type: shortText(node.type || 'UNKNOWN', 40)
    };
    const box = node.absoluteBoundingBox;
    if (box && Number.isFinite(Number(box.width)) && Number.isFinite(Number(box.height))) {
      result.size = {
        width: Math.round(Number(box.width)),
        height: Math.round(Number(box.height))
      };
    }
    for (const fill of Array.isArray(node.fills) ? node.fills : []) {
      if (fill?.type === 'SOLID' || fill?.color) {
        const hex = toHex(fill.color);
        if (hex) colors.add(hex);
      }
    }
    const family = shortText(node.style?.fontFamily, 80);
    if (family) fonts.add(family);
    if (result.type === 'COMPONENT' || result.type === 'INSTANCE' || result.type === 'COMPONENT_SET') {
      components.add(result.name);
    }
    if (depth >= maxDepth) {
      if (Array.isArray(node.children) && node.children.length) truncated = true;
      return result;
    }
    const children = [];
    for (const child of Array.isArray(node.children) ? node.children : []) {
      if (visited >= maxNodes) {
        truncated = true;
        break;
      }
      const cleanChild = walk(child, depth + 1);
      if (cleanChild) children.push(cleanChild);
    }
    if (children.length) result.children = children;
    return result;
  }

  const tree = walk(rootNode, 0);
  return {
    tree,
    colors: [...colors].slice(0, 12),
    fonts: [...fonts].slice(0, 8),
    components: [...components].slice(0, 20),
    nodeCount: visited,
    truncated
  };
}

async function requestFigma({ config, reference, depth, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const path = reference.nodeId
    ? `files/${encodeURIComponent(reference.fileKey)}/nodes?ids=${encodeURIComponent(reference.nodeId)}`
    : `files/${encodeURIComponent(reference.fileKey)}?depth=${encodeURIComponent(String(depth))}`;
  const url = new URL(path, config.baseUrl).href;
  const headers = { 'X-Figma-Token': config.accessToken, accept: 'application/json' };

  async function call(overrides) {
    try {
      const response = await doFetch(url, {
        method: 'GET',
        headers: overrides,
        signal: AbortSignal.timeout(config.timeoutMs)
      });
      const status = Number.isInteger(response?.status) ? response.status : response?.ok ? 200 : 0;
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      return { status, payload, reason: null };
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      return { status: 0, payload: null, reason: timedOut ? 'timeout' : 'network_error' };
    }
  }

  let result = await call(headers);
  if (result.status === 401 || result.status === 403) {
    const bearer = await call({ authorization: `Bearer ${config.accessToken}`, accept: 'application/json' });
    if (bearer.status >= 200 && bearer.status < 300) result = bearer;
  }
  return result;
}

/** يقرأ تصميم Figma ويعيد ملخصًا آمنًا (لا استجابة خام، لا توكن، لا بريد حساب). */
export async function inspectDesign({
  config = loadFigmaConfig(),
  url,
  fileKey,
  nodeId,
  depth,
  fetchImpl = null
} = {}) {
  if (!config.accessToken) throw new FigmaError('FIGMA_ACCESS_TOKEN is not configured', { code: 'not_configured' });
  const reference = parseFigmaReference(url || fileKey);
  const effectiveNodeId = nodeId ? String(nodeId).replace(/-/g, ':') : reference.nodeId;
  if (effectiveNodeId && !NODE_ID_RE.test(effectiveNodeId)) {
    throw new FigmaError('figma_node_id_is_invalid', { code: 'invalid_reference' });
  }
  const effectiveDepth = boundedInt(depth, config.maxDepth, 1, config.maxDepth);
  const result = await requestFigma({
    config,
    reference: { ...reference, nodeId: effectiveNodeId },
    depth: effectiveDepth,
    fetchImpl
  });
  if (result.status === 0) {
    throw new FigmaError(`Figma request failed: ${result.reason}`, { code: result.reason });
  }
  if (result.status === 401 || result.status === 403) {
    throw new FigmaError('Figma rejected the access token', { code: 'token_rejected', status: result.status });
  }
  if (result.status >= 400) {
    throw new FigmaError(`Figma request failed: http_${result.status}`, { code: 'provider_error', status: result.status });
  }

  const payload = result.payload || {};
  let rootNode = payload.document;
  let name = shortText(payload.name, 120);
  if (effectiveNodeId && payload.nodes) {
    const entry = payload.nodes[effectiveNodeId] || Object.values(payload.nodes)[0];
    rootNode = entry?.document || entry;
    name = shortText(entry?.document?.name || name, 120);
  }
  if (!rootNode) throw new FigmaError('Figma response contained no document', { code: 'invalid_response' });

  const extracted = sanitizeFigmaTree(rootNode, { maxNodes: config.maxNodes, maxDepth: effectiveDepth });
  return {
    provider: 'figma',
    fileKey: reference.fileKey,
    nodeId: effectiveNodeId || null,
    referenceSource: reference.source,
    name,
    lastModified: shortText(payload.lastModified, 60),
    httpStatus: result.status,
    depth: effectiveDepth,
    ...extracted
  };
}

function contrastText(hex) {
  const value = String(hex || '#000000').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(value)) return '#FFFFFF';
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111827' : '#FFFFFF';
}

/**
 * يحوّل الملخص المُصفّى إلى واجهة HTML/CSS عربية مستقلة.
 * بلا سكربتات، بلا موارد خارجية، وكل النصوص معقّمة → آمنة للعرض داخل حاسوب سيليا.
 */
export function buildLiveArtifact(design, { title } = {}) {
  const safeTitle = shortText(title || design?.name || 'واجهة سيليا الحية', 100);
  const colors = Array.isArray(design?.colors) && design.colors.length ? design.colors : ['#6366F1', '#0EA5E9', '#F8FAFC'];
  const fonts = Array.isArray(design?.fonts) ? design.fonts : [];
  const fontStack = fonts.length
    ? fonts.map((font) => `"${escapeHtml(font)}"`).join(', ')
    : '"Cairo", "Tajawal", system-ui, sans-serif';
  const primary = colors[0];
  const secondary = colors[1] || primary;
  const surface = colors[2] || '#F8FAFC';
  const nodes = (design?.tree?.children || []).slice(0, 8);
  const cards = nodes.length
    ? nodes
        .map((node, index) => {
          const label = escapeHtml(node.name || `عنصر ${index + 1}`);
          const size = node.size ? `${escapeHtml(String(node.size.width))}×${escapeHtml(String(node.size.height))}` : '—';
          const kind = escapeHtml(node.type || 'FRAME');
          return `<details class="cf-card" ${index === 0 ? 'open' : ''}>
        <summary><span class="cf-dot" style="background:${escapeHtml(colors[index % colors.length])}"></span>${label}</summary>
        <div class="cf-meta"><span>${kind}</span><span>${size}</span></div>
      </details>`;
        })
        .join('\n')
    : '<div class="cf-empty">لا توجد إطارات فرعية في هذا التصميم.</div>';

  const css = `
.celia-figma-artifact{font-family:${fontStack};background:${escapeHtml(surface)};color:#111827;padding:18px;border-radius:14px;direction:rtl;max-width:100%}
.celia-figma-artifact .cf-head{background:linear-gradient(135deg,${escapeHtml(primary)},${escapeHtml(secondary)});color:${contrastText(primary)};padding:16px;border-radius:12px;margin-bottom:14px}
.celia-figma-artifact .cf-head h3{margin:0 0 6px;font-size:1.05rem}
.celia-figma-artifact .cf-head p{margin:0;font-size:.8rem;opacity:.9}
.celia-figma-artifact .cf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
.celia-figma-artifact .cf-card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px}
.celia-figma-artifact .cf-card summary{cursor:pointer;font-weight:600;font-size:.84rem;display:flex;align-items:center;gap:8px}
.celia-figma-artifact .cf-dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.celia-figma-artifact .cf-meta{display:flex;justify-content:space-between;font-size:.72rem;color:#6b7280;margin-top:8px}
.celia-figma-artifact .cf-empty,.celia-figma-artifact .cf-foot{font-size:.78rem;color:#6b7280;margin-top:12px}
.celia-figma-artifact .cf-swatches{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
.celia-figma-artifact .cf-swatch{width:26px;height:26px;border-radius:6px;border:1px solid rgba(0,0,0,.12)}
`.trim();

  const html = `<div class="celia-figma-artifact">
  <style>${css}</style>
  <div class="cf-head">
    <h3>${escapeHtml(safeTitle)}</h3>
    <p>واجهة حية مولّدة من Figma · ${escapeHtml(String(design?.nodeCount || 0))} عقدة · ${escapeHtml(String(colors.length))} لون</p>
  </div>
  <div class="cf-grid">${cards}</div>
  <div class="cf-swatches">${colors
    .slice(0, 8)
    .map((color) => `<span class="cf-swatch" style="background:${escapeHtml(color)}" title="${escapeHtml(color)}"></span>`)
    .join('')}</div>
  <div class="cf-foot">الخطوط: ${escapeHtml(fonts.length ? fonts.join(' · ') : 'افتراضي عربي')} · لا سكربتات ولا موارد خارجية.</div>
</div>`;

  return {
    provider: 'figma-live-artifact',
    title: safeTitle,
    html,
    css,
    colors,
    fonts,
    nodeCount: design?.nodeCount || 0,
    safe: true,
    scriptFree: true
  };
}
