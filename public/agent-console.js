/**
 * لوحات L1 — سجل المحادثات (U2) · صندوق المهام (U5) · معاينة المخرجات (U3).
 *
 * وحدة نقية بلا DOM عند الاستيراد، على نمط `agent-trace.js` نفسه: كل دالة هنا
 * تأخذ بيانات الخادم كما وصلت وتعيد نصًّا أو وصفًا، فتُختبر في Node مباشرة.
 *
 * ثلاث قواعد لا تُكسر:
 *   1. **لا اختراع.** كل معروض مصدره سجل دائم (`agent_threads`/`agent_messages`/
 *      `agent_runs`/طابور الانتباه/`agent_artifacts`). ما لا سجل له لا يُرسم.
 *   2. **لا تلطيف.** صندوق المهام يعيد ترتيب الخادم وشدّته وبصمته كما هي؛ لا
 *      يعيد رتبة ولا يخفف `severity` ولا يسقط بندًا (ثابت `checkQueue`).
 *   3. **لا حقن.** معاينة المخرجات تهرّب كل شيء أولًا، وترفض عرض HTML/SVG رفضًا
 *      صريحًا مسمّى — لا `innerHTML` لحمولة ملف ناتج ولا `iframe` ولا `srcdoc`.
 */

export const CONSOLE_VERSION = '1.0';

/** سقف المعاينة يُقرأ من `bytes` المعلنة في السجل قبل أي جلب — ملف ضخم لا يُنزَّل أصلًا. */
export const PREVIEW_MAX_BYTES = 262_144;
/** سقف ما يُعرض نصًّا بعد الهرم (باقي الملف موجود في التنزيل الموقّع، لا يضيع). */
export const PREVIEW_MAX_TEXT_CHARS = 60_000;
export const PREVIEW_MAX_CSV_ROWS = 200;
export const MESSAGE_MAX_CHARS = 1_200;
/** الخادم يعيد آخر 20 خيطًا (`listThreads` limit افتراضي) — الواجهة تعلن هذا الحد لا تخفيه. */
export const THREAD_LIST_LIMIT = 20;

/** الأنواع التي تُعاين نصًّا، مشتقة من امتداد الاسم لأن السجل لا يحمل `contentType`. */
export const PREVIEWABLE_EXTENSIONS = Object.freeze({
  md: 'markdown',
  markdown: 'markdown',
  csv: 'csv',
  txt: 'text',
  log: 'text',
  json: 'text'
});

/** مرفوضة رفضًا مسمّى: عرضها يعني تنفيذ حمولة ملف ناتج في صفحة المالك. */
export const REFUSED_EXTENSIONS = Object.freeze(['html', 'htm', 'svg', 'xhtml', 'xml', 'js', 'mjs', 'css']);

export const THREAD_STATUS_LABELS = Object.freeze({
  active: ['نشط', 'ok'],
  closed: ['مغلق', 'idle'],
  archived: ['مؤرشف', 'idle']
});

export const ROLE_LABELS = Object.freeze({
  user: 'أنت',
  assistant: 'الوكيل',
  tool: 'أداة',
  system: 'النظام'
});

export const RUN_STATUS_LABELS = Object.freeze({
  queued: ['في الانتظار', 'running'],
  running: ['يعمل', 'running'],
  waiting_approval: ['بانتظار موافقة', 'warn'],
  needs_reconciliation: ['يحتاج مصالحة', 'warn'],
  succeeded: ['نُفذ', 'ok'],
  failed: ['فشل', 'bad'],
  cancelled: ['أُلغي', 'warn'],
  budget_exhausted: ['توقف بالميزانية', 'warn']
});

/** شدّة طابور الانتباه كما يسمّيها الخادم — الترتيب المعروض ترتيبه، لا ترتيبنا. */
export const SEVERITY_LABELS = Object.freeze({
  decision: ['قرار مطلوب', 'bad'],
  ambiguous: ['غير محسوم', 'warn'],
  failure: ['فشل', 'bad'],
  info: ['مكتمل', 'ok']
});

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

export function shortHash(hash) {
  const text = String(hash ?? '');
  return /^[0-9a-f]{64}$/i.test(text) ? `${text.slice(0, 12)}…` : '—';
}

function truncate(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return { text: value, truncated: false };
  return { text: value.slice(0, max), truncated: true };
}

/**
 * U2 — تصفية الخيوط محليًا في ما حمّله الخادم فعلًا (آخر 20).
 * لا تُعلن «بحث في كل المحادثات» لأن السجل لا يُستعلم هنا؛ التطابق على العنوان
 * أو بادئة المعرّف، ويُعاد سبب التطابق ليظهر في الواجهة بدل ادّعاء ذكاء.
 */
export function filterThreads({ threads = [], query = '' } = {}) {
  const needle = String(query ?? '').trim().toLowerCase();
  const items = (Array.isArray(threads) ? threads : []).map((thread) => {
    const title = String(thread?.title ?? '');
    const id = String(thread?.id ?? '');
    if (!needle) return { thread, matched: 'all' };
    if (title.toLowerCase().includes(needle)) return { thread, matched: 'title' };
    if (id.toLowerCase().startsWith(needle)) return { thread, matched: 'id' };
    return null;
  }).filter(Boolean);
  return { items, total: Array.isArray(threads) ? threads.length : 0, shown: items.length, filtered: Boolean(needle) };
}

export function renderThreadList({ threads = [], activeThreadId = null, query = '' } = {}) {
  const { items, total, shown, filtered } = filterThreads({ threads, query });
  if (!total) {
    return { html: '<li class="empty">لا خيوط محفوظة بعد — أول مهمة تنشئ أول خيط.</li>', shown: 0, total: 0 };
  }
  if (!shown) {
    return {
      html: `<li class="empty">لا خيط يطابق «${escapeHtml(query)}» ضمن آخر ${total} خيطًا محمّلًا.</li>`,
      shown: 0,
      total
    };
  }
  const html = items
    .map(({ thread, matched }) => {
      const [label, kind] = THREAD_STATUS_LABELS[thread.status] || [thread.status || 'غير معلن', 'idle'];
      const active = thread.id === activeThreadId ? ' aria-current="true"' : '';
      const mark = filtered && matched === 'id' ? ' <span class="tag">تطابق بالمعرّف</span>' : '';
      return `<li class="thread-item"${active}>
        <button type="button" class="thread-open" data-thread-id="${escapeHtml(thread.id)}">
          <span class="t-title">${escapeHtml(thread.title || 'مهمة')}${mark}</span>
          <span class="t-meta"><span class="pill ${kind}">${escapeHtml(label)}</span>
            <span class="t-id">${escapeHtml(String(thread.id).slice(0, 8))}</span>
            <time datetime="${escapeHtml(thread.updatedAt || '')}">${escapeHtml(thread.updatedAt || '—')}</time></span>
        </button>
      </li>`;
    })
    .join('');
  return { html, shown, total };
}

/**
 * U2 — تفاصيل الخيط: رسائله المسجلة وتشغيلاته. يُعرض ما في السجل فقط؛ إن كانت
 * الرسائل من دور واحد (`user`) فذلك ما يُعرض، ولا يُخترع رد وكيل غير مسجل.
 */
export function renderThreadDetail({ thread = null, messages = [], runs = [] } = {}) {
  if (!thread) return '<p class="empty">اختر خيطًا لعرض سجلّه.</p>';
  const parts = [`<h3>الرسائل المسجلة <span class="count">${Number(messages?.length ?? 0)}</span></h3>`];
  if (!messages?.length) {
    parts.push('<p class="empty">لا رسالة محفوظة في هذا الخيط.</p>');
  } else {
    parts.push('<ol class="messages">');
    for (const message of messages) {
      const { text, truncated } = truncate(message?.content ?? '', MESSAGE_MAX_CHARS);
      parts.push(`<li class="msg" data-role="${escapeHtml(message?.role ?? '')}">
        <span class="who">${escapeHtml(ROLE_LABELS[message?.role] || message?.role || 'غير معلن')}</span>
        <span class="body">${escapeHtml(text)}${truncated ? ' <span class="tag">مقتطع للعرض — النص الكامل في السجل</span>' : ''}</span>
        <time datetime="${escapeHtml(message?.createdAt ?? '')}">${escapeHtml(message?.createdAt ?? '—')}</time>
      </li>`);
    }
    parts.push('</ol>');
  }
  parts.push(`<h3>التشغيلات <span class="count">${Number(runs?.length ?? 0)}</span></h3>`);
  if (!runs?.length) {
    parts.push('<p class="empty">لا تشغيل في هذا الخيط.</p>');
  } else {
    parts.push('<ol class="thread-runs">');
    for (const run of runs.slice(0, 10)) {
      const [label, kind] = RUN_STATUS_LABELS[run?.status] || [run?.status || 'غير معلن', 'idle'];
      parts.push(`<li class="run-item">
        <button type="button" class="run-open" data-run-id="${escapeHtml(run?.id ?? '')}">
          <span class="pill ${kind}">${escapeHtml(label)}</span>
          <span class="r-id">${escapeHtml(String(run?.id ?? '').slice(0, 8))}</span>
          <span class="r-plan">${escapeHtml(run?.planSummary || 'بلا ملخص خطة')}</span>
        </button>
      </li>`);
    }
    if (runs.length > 10) parts.push(`<li class="empty">… و${runs.length - 10} تشغيلًا آخر في السجل (العرض أول 10).</li>`);
    parts.push('</ol>');
  }
  return parts.join('');
}

/**
 * U5 — صندوق المهام: تجميع بلا إعادة ترتيب. الخادم رتّب بالشدّة ثم بالأقدم،
 * والتجميع يحافظ على ذلك الترتيب داخل كل شدة وعلى الشدّة كما سُمّيت.
 */
export function groupAttention(queue) {
  const items = Array.isArray(queue?.items) ? queue.items : [];
  const groups = [];
  const index = new Map();
  for (const item of items) {
    const severity = String(item?.severity ?? 'info');
    if (!index.has(severity)) {
      index.set(severity, groups.length);
      groups.push({ severity, items: [] });
    }
    groups[index.get(severity)].items.push(item);
  }
  return {
    version: queue?.version ?? null,
    now: queue?.now ?? null,
    total: Number(queue?.total ?? items.length),
    counts: queue?.counts ?? null,
    owed: Number(queue?.owed ?? 0),
    clear: Boolean(queue?.clear),
    sends: Boolean(queue?.sends),
    tracksRead: Boolean(queue?.tracksRead),
    digest: queue?.digest ?? null,
    dropped: Array.isArray(queue?.dropped) ? queue.dropped : [],
    groups
  };
}

export function renderInbox(queue) {
  const view = groupAttention(queue);
  if (!view.total) {
    return {
      html: '<li class="empty">لا شيء ينتظرك الآن — لا تشغيل متوقف، ولا أثر غير محسوم.</li>',
      view
    };
  }
  const html = view.groups
    .map(({ severity, items }) => {
      const [label, kind] = SEVERITY_LABELS[severity] || [severity, 'idle'];
      const rows = items
        .map((item) => {
          const evidence = Object.entries(item?.evidence ?? {})
            .map(([key, value]) => `${escapeHtml(key)}=${escapeHtml(value)}`)
            .join(' · ');
          const next = item?.next && item.next !== 'none' ? ` <span class="tag">${escapeHtml(String(item.next))}</span>` : '';
          return `<li class="inbox-item">
            <span class="i-head"><b>${escapeHtml(item?.ar || item?.reason || 'بند')}</b>${next}</span>
            <span class="meta">${escapeHtml(item?.en || '')}</span>
            <span class="meta">المعرّف: <code>${escapeHtml(String(item?.id ?? '—'))}</code>${evidence ? ` · ${evidence}` : ''}${
              item?.waitingMs ? ` · منتظر ${Math.round(Number(item.waitingMs) / 60000)} دقيقة` : ''
            }</span>
          </li>`;
        })
        .join('');
      return `<li class="inbox-group"><span class="pill ${kind}">${escapeHtml(label)} · ${items.length}</span><ul>${rows}</ul></li>`;
    })
    .join('');
  return { html, view };
}

/**
 * U3 — قرار المعاينة قبل أي جلب: النوع من امتداد الاسم (السجل لا يحمل contentType)،
 * والحجم من `bytes` المعلنة. الرفض مسمّى بكود، لا صمت.
 */
export function previewKind({ name = '', bytes = 0 } = {}) {
  const lower = String(name ?? '').toLowerCase();
  const extension = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  if (!extension) return { mode: 'refused', reason: 'name_has_no_extension' };
  if (REFUSED_EXTENSIONS.includes(extension)) return { mode: 'refused', reason: 'html_not_rendered' };
  const mode = PREVIEWABLE_EXTENSIONS[extension];
  if (!mode) return { mode: 'refused', reason: 'type_not_previewable' };
  const size = Number(bytes ?? 0);
  if (!Number.isFinite(size) || size <= 0) return { mode: 'refused', reason: 'unknown_size' };
  if (size > PREVIEW_MAX_BYTES) return { mode: 'refused', reason: 'too_large_for_preview' };
  return { mode, reason: null, extension, bytes: size };
}

/** Markdown subset مغلق: هرم كامل أولًا، ثم أربع قواعد ضيقة فقط (كما في output-templates.js). */
export function renderMarkdownPreview(source) {
  const { text, truncated } = truncate(source, PREVIEW_MAX_TEXT_CHARS);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) { out.push('<ul>'); list = true; }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    if (list) { out.push('</ul>'); list = false; }
    if (heading) {
      const level = heading[1].length + 3; // h4..h6 — لا عنوان أعلى من عنوان اللوحة
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (!line.trim()) continue;
    out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return { html: out.join(''), truncated };
}

function inline(value) {
  let html = escapeHtml(value);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  return html;
}

/** CSV: هرم كل خلية، وفواصل بسيطة بلا اقتباسات متداخلة، وسقف صفوف معلن. */
export function renderCsvPreview(source) {
  const { text, truncated: textTruncated } = truncate(source, PREVIEW_MAX_TEXT_CHARS);
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((line) => line.trim() !== '');
  const rows = lines.slice(0, PREVIEW_MAX_CSV_ROWS).map((line) => splitCsvLine(line));
  const body = rows
    .map((cells, index) => {
      const tag = index === 0 ? 'th' : 'td';
      return `<tr>${cells.map((cell) => `<${tag}>${escapeHtml(cell)}</${tag}>`).join('')}</tr>`;
    })
    .join('');
  const rowCapped = lines.length > PREVIEW_MAX_CSV_ROWS;
  return {
    html: rows.length ? `<table class="csv"><tbody>${body}</tbody></table>` : '<p class="empty">الملف بلا صفوف.</p>',
    rows: rows.length,
    totalRows: lines.length,
    truncated: textTruncated || rowCapped
  };
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') { current += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else current += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') { cells.push(current); current = ''; }
    else current += char;
  }
  cells.push(current);
  return cells;
}

/** نص عادي (txt/log/json): هرم فقط داخل <pre> — لا تلوين ولا تفسير. */
export function renderTextPreview(source) {
  const { text, truncated } = truncate(source, PREVIEW_MAX_TEXT_CHARS);
  return { html: `<pre class="raw">${escapeHtml(text)}</pre>`, truncated };
}

export const PREVIEW_REFUSALS = Object.freeze({
  html_not_rendered: 'ملف HTML/SVG لا يُعرض داخل الصفحة عمدًا — عرضه يعني تنفيذ حمولة ناتجة في سياق المالك. نزّله وافتحه خارج المتصفح.',
  type_not_previewable: 'نوع غير مُعلن للمعاينة — التنزيل الموقّع متاح.',
  too_large_for_preview: `أكبر من سقف المعاينة (${PREVIEW_MAX_BYTES} بايت) — التنزيل الموقّع متاح.`,
  unknown_size: 'حجم غير معلن في السجل — لا معاينة بلا حجم.',
  name_has_no_extension: 'الاسم بلا امتداد — لا يُخمن النوع.',
  fetch_failed: 'تعذّر جلب المعاينة من الرابط الموقّع.',
  digest_mismatch: 'رفض الخادم التسليم (بصمة لا تطابق) — لا تُعرض بايتات مشكوك فيها.'
});
