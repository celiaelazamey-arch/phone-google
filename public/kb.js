/* شبكة المعرفة — قراءة فقط. الرمز في sessionStorage لهذه التبويبة فقط. */
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'celia.kb.token';
const state = { token: sessionStorage.getItem(TOKEN_KEY) || '', enabled: false };

const RISK_LABEL = {
  read: 'قراءة',
  internal_write: 'كتابة داخلية',
  external_effect: 'أثر خارجي',
  irreversible: 'غير قابل للتراجع'
};

function setStatus(text, kind = '') {
  const el = $('auth-status');
  el.textContent = text;
  el.className = `status ${kind}`.trim();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${state.token}`,
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function renderStatus(status) {
  const badge = $('kb-badge');
  state.enabled = Boolean(status.enabled);
  if (!status.enabled) {
    badge.textContent = status.reason === 'knowledge_disabled' ? 'الفهرس متوقف (off)' : 'غير متاح';
    badge.className = 'badge off';
    $('kb-note').textContent = status.note || `مطلوب: ${status.required || 'CELIA_KB=sqlite'}`;
    for (const id of ['fact-items', 'fact-entities', 'fact-edges', 'fact-sources', 'fact-absent', 'fact-stale']) $(id).textContent = '—';
    $('search').disabled = true;
    $('load-entities').disabled = true;
    return;
  }
  badge.textContent = `يعمل · ${status.mode}`;
  badge.className = 'badge ok';
  $('fact-items').textContent = status.stats.items;
  $('fact-entities').textContent = status.stats.entities;
  $('fact-edges').textContent = status.stats.edges;
  $('fact-sources').textContent = status.stats.sources;
  $('fact-absent').textContent = status.stats.absentItems;
  $('fact-stale').textContent = status.stale.count;
  const run = status.lastRun;
  $('kb-runs').textContent = run
    ? `آخر استيراد: ${run.sourceId} · ${run.mode} · +${run.counts.added} / ${run.counts.unchanged} بلا تغيير / ${run.counts.rejected} مرفوض${run.errorCode ? ` · ${run.errorCode}` : ''}`
    : 'لا استيراد مسجل بعد.';
  const notes = [status.note];
  if (status.durability?.warning) notes.push(`تنبيه التخزين: ${status.durability.warning}`);
  if (status.lastRejections?.length) {
    notes.push(`آخر مرفوضات: ${status.lastRejections.map((row) => `سطر ${row.line}: ${row.code}`).join(' · ')}`);
  }
  $('kb-note').textContent = notes.filter(Boolean).join(' — ');
  $('search').disabled = false;
  $('load-entities').disabled = false;
}

function entityMeta(entity) {
  const parts = [];
  if (entity.risk) parts.push(`<span class="risk-${entity.risk.startsWith('external') ? 'external' : entity.risk === 'read' ? 'read' : 'other'}">${RISK_LABEL[entity.risk] || entity.risk}</span>`);
  if (entity.requiresApproval) parts.push('<span>موافقة مطلوبة</span>');
  if (entity.wired) parts.push('<span>مسجلة في الكود</span>');
  return parts.join('');
}

function renderResults(result) {
  const list = $('results');
  list.innerHTML = '';
  if (result.reason === 'no_match' || !result.items?.length) {
    const item = document.createElement('li');
    item.className = 'empty-state';
    item.textContent = 'لا دليل مطابق في الفهرس. لم يُختلق أي مرجع.';
    list.append(item);
  }
  for (const hit of result.items || []) {
    const item = document.createElement('li');
    const title = document.createElement('div');
    title.className = 'title';
    const link = document.createElement('a');
    link.href = hit.uri;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = hit.title;
    const kind = document.createElement('span');
    kind.className = 'tag';
    kind.textContent = hit.kind;
    title.append(link, kind);

    const snippet = document.createElement('p');
    snippet.className = 'snippet';
    snippet.textContent = hit.snippet;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const chips = [`ثقة ${hit.trust}`, `ترخيص ${hit.licence}`, hit.sourceKind || hit.sourceId, `تقييم ${hit.score}`];
    if (hit.breakdown) {
      chips.push(`معجمي ${hit.breakdown.lexical} · حداثة ${hit.breakdown.fresh} · شبكة ${hit.breakdown.proximity}`);
    }
    for (const chip of chips) {
      const span = document.createElement('span');
      span.textContent = chip;
      meta.append(span);
    }
    item.append(title, snippet, meta);
    list.append(item);
  }
  const meta = $('search-meta');
  const entityLine = (result.entities || [])
    .slice(0, 4)
    .map((entity) => `${entity.title} [${RISK_LABEL[entity.risk] || entity.type}${entity.requiresApproval ? ' · موافقة' : ''}]`)
    .join(' · ');
  meta.textContent = result.reason
    ? `الحالة: ${result.reason}`
    : `${result.items.length} نتيجة من ${result.candidates} مرشحًا في ${result.tookMs.toFixed(1)}ms${result.omitted ? ` · ${result.omitted} مستبعد` : ''}${result.truncated ? ' · قُصّت الميزانية' : ''}${entityLine ? ` — كيانات: ${entityLine}` : ''}`;
}

async function search() {
  const query = $('query').value.trim();
  if (!query) {
    setStatus('اكتب سؤالًا أولًا.', 'bad');
    return;
  }
  $('search').disabled = true;
  try {
    const result = await api('/api/kb/search', {
      method: 'POST',
      body: JSON.stringify({ query, limit: 6, ...($('min-trust').checked ? {} : {}) })
    });
    renderResults(result);
    setStatus('تم البحث.', 'ok');
  } catch (error) {
    setStatus(`تعذّر البحث: ${error.message}`, 'bad');
  } finally {
    $('search').disabled = false;
  }
}

async function loadEntities() {
  const type = $('entity-type').value;
  try {
    const { entities } = await api(`/api/kb/entities?type=${encodeURIComponent(type)}&limit=100`);
    const list = $('entities');
    list.innerHTML = '';
    if (!entities.length) {
      const item = document.createElement('li');
      item.className = 'empty-state';
      item.textContent = 'لا كيانات من هذا النوع في الفهرس.';
      list.append(item);
      return;
    }
    for (const entity of entities) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link';
      button.textContent = entity.title;
      button.addEventListener('click', () => showEntity(entity.type, entity.key));
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = `${entity.key} · ثقة ${entity.trust}`;
      const risk = document.createElement('span');
      risk.className = 'tag';
      risk.textContent = entity.risk ? RISK_LABEL[entity.risk] || entity.risk : '—';
      item.append(button, tag, risk);
      list.append(item);
    }
  } catch (error) {
    setStatus(`تعذّر تحميل الكيانات: ${error.message}`, 'bad');
  }
}

async function showEntity(type, key) {
  const box = $('entity-detail');
  try {
    const detail = await api(`/api/kb/entities/${encodeURIComponent(type)}/${encodeURIComponent(key)}`);
    box.hidden = false;
    box.innerHTML = '';
    const title = document.createElement('h3');
    title.textContent = detail.entity.title;
    const dl = document.createElement('dl');
    const rows = [
      ['المعرّف', `${detail.entity.type}:${detail.entity.key}`],
      ['الحالة', detail.entity.status],
      ['الثقة', detail.entity.trust],
      ['المخاطر', detail.entity.risk ? RISK_LABEL[detail.entity.risk] || detail.entity.risk : '—'],
      ['الموافقة', detail.entity.requiresApproval ? 'مطلوبة' : 'غير مطلوبة'],
      ['التسجيل في الكود', detail.entity.wired ? 'مسجلة' : 'كتالوج فقط']
    ];
    for (const [label, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      dl.append(dt, dd);
    }
    if (detail.evidence) {
      const dt = document.createElement('dt');
      dt.textContent = 'الدليل';
      const dd = document.createElement('dd');
      const link = document.createElement('a');
      link.href = detail.evidence.uri;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = detail.evidence.title;
      dd.append(link, document.createTextNode(` — ${detail.evidence.licence} · ${detail.evidence.trust}`));
      dl.append(dt, dd);
    }
    box.append(title, dl);
    for (const [label, edges] of [
      ['حواف صادرة', detail.outgoing],
      ['حواف واردة', detail.incoming]
    ]) {
      if (!edges.length) continue;
      const heading = document.createElement('p');
      heading.textContent = `${label} (${edges.length})`;
      const ul = document.createElement('ul');
      for (const edge of edges.slice(0, 10)) {
        const li = document.createElement('li');
        li.textContent = `${edge.rel} → ${edge.title} (${edge.type}:${edge.key})`;
        ul.append(li);
      }
      box.append(heading, ul);
    }
  } catch (error) {
    setStatus(`تعذّر التحميل: ${error.message}`, 'bad');
  }
}

async function showStale() {
  try {
    const report = await api('/api/kb/stale');
    const box = $('stale-report');
    box.hidden = false;
    box.innerHTML = '';
    const heading = document.createElement('p');
    heading.textContent = `${report.items.length} عنصرًا تجاوز عمره الحد · ${report.absentCount} عنصرًا غائبًا عن مصدره (معلَّم لا محذوف) · فُحص ${report.checked}`;
    box.append(heading);
    if (report.items.length) {
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const label of ['العنصر', 'المصدر', 'العمر (يوم)', 'الحد']) {
        const th = document.createElement('th');
        th.textContent = label;
        headRow.append(th);
      }
      thead.append(headRow);
      const tbody = document.createElement('tbody');
      for (const item of report.items.slice(0, 20)) {
        const row = document.createElement('tr');
        for (const value of [item.title, item.sourceId, item.ageDays, item.threshold]) {
          const cell = document.createElement('td');
          cell.textContent = String(value);
          row.append(cell);
        }
        tbody.append(row);
      }
      table.append(thead, tbody);
      box.append(table);
    }
  } catch (error) {
    setStatus(`تعذّر التقرير: ${error.message}`, 'bad');
  }
}

async function connect() {
  state.token = $('token').value.trim();
  if (!state.token) return setStatus('أدخل رمز الوصول أولًا.', 'bad');
  sessionStorage.setItem(TOKEN_KEY, state.token);
  setStatus('جارٍ التحقق…');
  try {
    const status = await api('/api/kb/status');
    renderStatus(status);
    setStatus(status.enabled ? 'متصل — الفهرس جاهز' : 'متصل، لكن الفهرس متوقف', status.enabled ? 'ok' : 'bad');
    if (status.enabled) await loadEntities();
  } catch (error) {
    setStatus(error.status === 401 ? 'رمز غير صحيح (401).' : `تعذّر الاتصال: ${error.message}`, 'bad');
  }
}

$('connect').addEventListener('click', connect);
$('token').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') connect();
});
$('search').addEventListener('click', search);
$('query').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') search();
});
$('load-entities').addEventListener('click', loadEntities);
$('entity-type').addEventListener('change', loadEntities);
$('stale-btn').addEventListener('click', showStale);

const STATIC_HOST =
  document.documentElement.dataset.celiaStatic === 'true' || /\.github\.io$/i.test(location.hostname);
if (STATIC_HOST) {
  // Pages is a static snapshot: no API, no index. Say it instead of failing silently.
  const badge = $('kb-badge');
  badge.textContent = 'نسخة ثابتة — لا فهرس هنا';
  badge.className = 'badge off';
  $('kb-note').textContent =
    'GitHub Pages تقدم صفحات ثابتة فقط؛ شبكة المعرفة تحتاج خدمة Node مع ملف SQLite (CELIA_KB=sqlite). لا تُدخل رمزك هنا.';
  $('search').disabled = true;
  $('load-entities').disabled = true;
  $('token').disabled = true;
  $('connect').disabled = true;
} else if (state.token) {
  $('token').value = state.token;
  connect();
} else {
  const badge = $('kb-badge');
  badge.textContent = 'أدخل الرمز لعرض الحالة';
  badge.className = 'badge off';
}
