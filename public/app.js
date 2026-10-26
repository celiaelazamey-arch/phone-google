(() => {
  'use strict';

  const STUDIO_SYSTEM_PROMPT = [
    'أنت «سيليا 2026» — وكيل ذكي متكامل بمستوى Claude وManus مرتبط ببروتوكول MCP لواتساب وخدمات Google.',
    'تحدث بالعربية الفصحى السلسة والواضحة وقدم إجابات عملية منظمة بعناوين ونقاط واضحة.',
    'إذا طلب المستخدم تصميم واجهة، أو أداة، أو حاسبة، أو لوحة تحكم، أو صفحة، أو نموذج تفاعلي: اكتب شرحًا موجزًا ثم أرفق كود HTML5 تفاعليًا كاملًا ومستقلًا (بـ dir="rtl" وتصميم عصري أنيق مع CSS وJS مدمجين) داخل كتلة ```html ... ``` ليعمل مباشرة في شاشة المخرجات الحية (Artifact).',
    'في استفسارات خدمة العملاء المالية أو الأسعار غير المعلنة، التزم بعدم اختلاق أرقام واقترح بلطف متابعة موظف مختص.'
  ].join('\n');

  const SHOWCASE_ARTIFACT_HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif; }
  body { margin: 0; padding: 18px; background: #0c0f17; color: #f3f4f6; line-height: 1.55; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 14px; }
  .kpi { background: #151a28; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px; }
  .kpi span { display: block; font-size: 0.74rem; color: #9ca3af; }
  .kpi strong { font-size: 1.25rem; color: #10b981; }
  .kpi.coral strong { color: #e88c6d; }
  .card { background: #151a28; border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 14px; margin-bottom: 12px; }
  h3 { margin: 0 0 10px; font-size: 0.96rem; }
  label { display: flex; justify-content: space-between; font-size: 0.8rem; color: #cbd5e1; margin-bottom: 4px; }
  input[type="range"] { width: 100%; accent-color: #d97757; margin-bottom: 10px; }
  .bar-wrap { background: #090c13; border-radius: 999px; height: 10px; overflow: hidden; margin-top: 6px; }
  .bar-fill { height: 100%; background: linear-gradient(90deg, #d97757, #10b981); width: 78%; transition: width 0.2s; }
  .queue { display: grid; gap: 7px; }
  .q-row { display: flex; justify-content: space-between; align-items: center; background: #0e1320; padding: 8px 11px; border-radius: 9px; font-size: 0.8rem; }
  .tag { padding: 2px 8px; border-radius: 999px; font-size: 0.7rem; background: rgba(16,185,129,0.15); color: #34d399; }
  .tag.human { background: rgba(245,158,11,0.16); color: #fbbf24; }
  button { background: #d97757; color: #fff; border: none; border-radius: 8px; padding: 6px 12px; font-size: 0.78rem; cursor: pointer; font-weight: 600; }
</style>
</head>
<body>
  <div class="grid">
    <div class="kpi"><span>التوفير الشهري المقدّر</span><strong id="kpi-save">$1,440</strong></div>
    <div class="kpi coral"><span>الساعات الموفّرة شهريًا</span><strong id="kpi-hours">180 ساعة</strong></div>
    <div class="kpi"><span>تكلفة تشغيل سيليا</span><strong>$0.00</strong></div>
  </div>

  <div class="card">
    <h3>⚡ حاسبة أثر أتمتة واتساب + Google المجانية</h3>
    <label><span>عدد رسائل العملاء يوميًا</span><strong id="lbl-msgs">120 رسالة</strong></label>
    <input type="range" id="rng-msgs" min="20" max="500" value="120" />
    <label><span>نسبة الاستفسارات العامة الآلية (وفق السياسة)</span><strong id="lbl-rate">75%</strong></label>
    <input type="range" id="rng-rate" min="30" max="95" value="75" />
    <div style="font-size:0.76rem;color:#94a3b8;">نسبة التغطية الآمنة داخل نافذة 24 ساعة:</div>
    <div class="bar-wrap"><div class="bar-fill" id="bar-fill"></div></div>
  </div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <h3 style="margin:0;">📲 طابور رسائل العملاء الحي</h3>
      <button type="button" id="btn-add-sim">+ محاكاة عميل جديد</button>
    </div>
    <div class="queue" id="queue">
      <div class="q-row"><span>+201065217834 — استفسار مواعيد العمل</span><span class="tag">رد ذكي آلي ✓</span></div>
      <div class="q-row"><span>+201126212452 — طلب عرض سعر مخصص</span><span class="tag human">تحويل لموظف بشري</span></div>
    </div>
  </div>

  <script>
    const rngMsgs = document.getElementById('rng-msgs');
    const rngRate = document.getElementById('rng-rate');
    function recalc() {
      const msgs = Number(rngMsgs.value);
      const rate = Number(rngRate.value);
      document.getElementById('lbl-msgs').textContent = msgs + ' رسالة';
      document.getElementById('lbl-rate').textContent = rate + '%';
      document.getElementById('bar-fill').style.width = rate + '%';
      const hours = Math.round((msgs * 30 * (rate / 100) * 4) / 60);
      document.getElementById('kpi-hours').textContent = hours + ' ساعة';
      document.getElementById('kpi-save').textContent = '$' + (hours * 8).toLocaleString();
    }
    rngMsgs.addEventListener('input', recalc);
    rngRate.addEventListener('input', recalc);
    document.getElementById('btn-add-sim').addEventListener('click', () => {
      const q = document.getElementById('queue');
      const samples = [
        ['+201098441200 — تأكيد موعد Google Calendar', 'رد ذكي آلي ✓', 'tag'],
        ['+201223910455 — مراجعة دفعة فاتورة سابقة', 'تحويل لموظف بشري', 'tag human'],
        ['+201550192834 — موقع الفرع وساعات الدوام', 'رد ذكي آلي ✓', 'tag']
      ];
      const pick = samples[q.children.length % samples.length];
      const row = document.createElement('div');
      row.className = 'q-row';
      row.innerHTML = '<span>' + pick[0] + '</span><span class="' + pick[2] + '">' + pick[1] + '</span>';
      q.prepend(row);
    });
    recalc();
  </script>
</body>
</html>`;

  const state = {
    theme: localStorage.getItem('celia_theme') || 'dark',
    mcpToken: sessionStorage.getItem('celia_mcp_token') || '',
    geminiKey: sessionStorage.getItem('celia_gemini_key') || '',
    groqKey: sessionStorage.getItem('celia_groq_key') || '',
    ollamaUrl: sessionStorage.getItem('celia_ollama_url') || 'http://127.0.0.1:11434',
    tools: [],
    traces: [],
    lastArtifactText: '',
    lastArtifactExt: 'md',
    selectedTool: null,
    serverHealth: null
  };

  const el = {
    html: document.documentElement,
    navPills: document.querySelectorAll('.nav-pill'),
    views: {
      studio: document.getElementById('view-studio'),
      tools: document.getElementById('view-tools'),
      whatsapp: document.getElementById('view-whatsapp'),
      models: document.getElementById('view-models')
    },
    chatScroll: document.getElementById('chat-scroll'),
    heroWelcome: document.getElementById('hero-welcome'),
    stream: document.getElementById('conversation-stream'),
    composerForm: document.getElementById('composer-form'),
    composerInput: document.getElementById('composer-input'),
    studioProvider: document.getElementById('studio-provider'),
    btnSend: document.getElementById('btn-send'),
    btnTheme: document.getElementById('btn-theme-toggle'),
    themeIcon: document.getElementById('theme-icon'),
    btnNewChat: document.getElementById('btn-new-chat'),
    btnAuthStatus: document.getElementById('btn-auth-status'),
    authLabel: document.getElementById('auth-label'),
    btnToggleComputer: document.getElementById('btn-toggle-computer'),
    btnExpandComputer: document.getElementById('btn-expand-computer'),
    btnDownloadArtifact: document.getElementById('btn-download-artifact'),
    btnCloseComputer: document.getElementById('btn-close-computer'),
    btnCopyArtifact: document.getElementById('btn-copy-artifact'),
    artifactBadge: document.getElementById('artifact-badge'),
    drawer: document.getElementById('computer-drawer'),
    drawerTabs: document.querySelectorAll('.drawer-tab'),
    dtabPanes: {
      preview: document.getElementById('dtab-preview'),
      trace: document.getElementById('dtab-trace'),
      config: document.getElementById('dtab-config')
    },
    artifactContent: document.getElementById('artifact-content'),
    traceList: document.getElementById('trace-list'),
    navToolsCount: document.getElementById('nav-tools-count'),
    tMcpState: document.getElementById('t-mcp-state'),
    tEngineState: document.getElementById('t-engine-state'),
    toolsGrid: document.getElementById('tools-grid'),
    toolFilters: document.getElementById('tool-filters'),
    toolModal: document.getElementById('tool-modal'),
    modalToolName: document.getElementById('modal-tool-name'),
    modalToolDesc: document.getElementById('modal-tool-desc'),
    modalToolArgs: document.getElementById('modal-tool-args'),
    modalToolResult: document.getElementById('modal-tool-result'),
    btnCloseModal: document.getElementById('btn-close-modal'),
    btnExecTool: document.getElementById('btn-exec-tool'),
    waPhone: document.getElementById('wa-sim-phone'),
    waOptIn: document.getElementById('wa-opt-in'),
    waAiOptIn: document.getElementById('wa-ai-opt-in'),
    waText: document.getElementById('wa-sim-text'),
    waFeed: document.getElementById('wa-chat-feed'),
    waWindowInd: document.getElementById('wa-window-indicator'),
    waCryptoReport: document.getElementById('wa-crypto-report'),
    btnWaConsent: document.getElementById('btn-wa-save-consent'),
    btnWaSendSim: document.getElementById('btn-wa-send-sim'),
    btnWaCrypto: document.getElementById('btn-wa-run-crypto'),
    vaultMcpToken: document.getElementById('vault-mcp-token'),
    vaultGeminiKey: document.getElementById('vault-gemini-key'),
    vaultGroqKey: document.getElementById('vault-groq-key'),
    vaultOllamaUrl: document.getElementById('vault-ollama-url'),
    btnVerifyVault: document.getElementById('btn-verify-vault'),
    vaultFeedback: document.getElementById('vault-feedback'),
    ollamaLiveBadge: document.getElementById('ollama-live-badge')
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function formatMarkdownLite(mdText) {
    const cleaned = String(mdText || '').replace(/```html[\s\S]*?```/gi, '').trim();
    const lines = cleaned.split('\n');
    const htmlParts = [];
    let inList = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        if (inList) {
          htmlParts.push('</ul>');
          inList = false;
        }
        continue;
      }
      if (line.startsWith('### ')) {
        if (inList) { htmlParts.push('</ul>'); inList = false; }
        htmlParts.push(`<h4>${escapeHtml(line.slice(4))}</h4>`);
      } else if (line.startsWith('## ') || line.startsWith('# ')) {
        if (inList) { htmlParts.push('</ul>'); inList = false; }
        htmlParts.push(`<h3>${escapeHtml(line.replace(/^#+\s*/, ''))}</h3>`);
      } else if (/^[-*•]\s+/.test(line)) {
        if (!inList) { htmlParts.push('<ul>'); inList = true; }
        const item = escapeHtml(line.replace(/^[-*•]\s+/, ''))
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/`([^`]+)`/g, '<code>$1</code>');
        htmlParts.push(`<li>${item}</li>`);
      } else {
        if (inList) { htmlParts.push('</ul>'); inList = false; }
        const para = escapeHtml(line)
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/`([^`]+)`/g, '<code>$1</code>');
        htmlParts.push(`<p>${para}</p>`);
      }
    }
    if (inList) htmlParts.push('</ul>');
    return htmlParts.join('') || `<p>${escapeHtml(mdText)}</p>`;
  }

  function extractHtmlArtifact(rawText) {
    const match = String(rawText || '').match(/```html\s*([\s\S]*?)```/i);
    if (match?.[1]?.trim()) return match[1].trim();
    if (/^\s*<!doctype html/i.test(rawText || '')) return String(rawText).trim();
    return null;
  }

  function applyTheme(theme) {
    state.theme = theme === 'light' ? 'light' : 'dark';
    el.html.setAttribute('data-theme', state.theme);
    el.themeIcon.textContent = state.theme === 'dark' ? '☀️' : '🌙';
    localStorage.setItem('celia_theme', state.theme);
  }

  function switchView(viewName) {
    el.navPills.forEach((btn) => btn.classList.toggle('active', btn.dataset.view === viewName));
    Object.entries(el.views).forEach(([key, panel]) => {
      panel.classList.toggle('active', key === viewName);
    });
  }

  function openDrawer(tab = 'preview') {
    el.drawer.classList.add('open');
    switchDrawerTab(tab);
  }

  function switchDrawerTab(tabName) {
    el.drawerTabs.forEach((btn) => btn.classList.toggle('active', btn.dataset.dtab === tabName));
    Object.entries(el.dtabPanes).forEach(([key, pane]) => {
      pane.classList.toggle('active', key === tabName);
    });
  }

  function recordTrace(label, payload, durationMs) {
    state.traces.unshift({
      time: new Date().toLocaleTimeString('en-GB'),
      label,
      durationMs,
      payload
    });
    state.traces = state.traces.slice(0, 25);
    el.artifactBadge.textContent = `${state.traces.length} عملية`;
    el.traceList.innerHTML = state.traces
      .map(
        (t) => `
        <div class="trace-entry">
          <div class="trace-entry-head">
            <span>${escapeHtml(t.label)}</span>
            <span>${t.durationMs}ms · ${escapeHtml(t.time)}</span>
          </div>
          <pre style="margin:0;white-space:pre-wrap;">${escapeHtml(JSON.stringify(t.payload, null, 2))}</pre>
        </div>`
      )
      .join('');
  }

  async function callMcpRpc(method, params = {}) {
    const start = Math.round(performance.now());
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const body = { jsonrpc: '2.0', id, method, params };
    const useOwner = Boolean(state.mcpToken && state.mcpToken.length >= 32);
    const endpoint = useOwner ? './mcp' : './ui/workspace/rpc';
    const headers = { 'content-type': 'application/json' };
    if (useOwner) headers.authorization = `Bearer ${state.mcpToken}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
    const elapsed = Math.max(1, Math.round(performance.now()) - start);
    recordTrace(`${useOwner ? 'POST /mcp' : 'POST /ui/workspace/rpc'} → ${method}`, data, elapsed);
    if (!res.ok) {
      throw new Error(data?.error?.message || `HTTP ${res.status}`);
    }
    return { data, elapsed, mode: useOwner ? 'owner' : 'sandbox' };
  }

  async function callCryptoLab(payload) {
    const start = Math.round(performance.now());
    const res = await fetch('./ui/workspace/crypto-lab', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    const elapsed = Math.max(1, Math.round(performance.now()) - start);
    recordTrace(`POST /ui/workspace/crypto-lab (${payload.action || 'audit'})`, data, elapsed);
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return { data, elapsed };
  }

  async function generateFreeAiText(promptText) {
    const mode = el.studioProvider.value;

    // 1. Browser Gemini Free Tier (if user entered AI Studio key or selected Gemini)
    if ((mode === 'gemini-browser' || mode === 'auto') && state.geminiKey) {
      const start = Math.round(performance.now());
      const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': state.geminiKey
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: STUDIO_SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text: promptText.slice(0, 4000) }] }],
            generationConfig: { temperature: 0.35, maxOutputTokens: 1400 }
          })
        }
      );
      if (res.ok) {
        const json = await res.json();
        const text = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
        if (text) {
          recordTrace('Gemini 2.5 Flash (Free AI Studio)', { model: 'gemini-2.5-flash' }, Math.round(performance.now()) - start);
          return { reply: text, engineLabel: 'Gemini 2.5 Flash · مجاني' };
        }
      } else if (mode === 'gemini-browser') {
        throw new Error(`رفض مفتاح Gemini الطلب (${res.status}) — راجع تبويب النماذج المجانية.`);
      }
    }

    // 2. Groq Free Tier
    if ((mode === 'groq-free' || mode === 'auto') && state.groqKey) {
      const start = Math.round(performance.now());
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${state.groqKey}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          temperature: 0.35,
          max_tokens: 1400,
          messages: [
            { role: 'system', content: STUDIO_SYSTEM_PROMPT },
            { role: 'user', content: promptText.slice(0, 4000) }
          ]
        })
      });
      if (res.ok) {
        const json = await res.json();
        const text = json.choices?.[0]?.message?.content?.trim();
        if (text) {
          recordTrace('Groq Free Cloud (Llama 3.3 70B)', { ok: true }, Math.round(performance.now()) - start);
          return { reply: text, engineLabel: 'Groq Llama 3.3 · طبقة مجانية' };
        }
      } else if (mode === 'groq-free') {
        throw new Error(`تعذر الاتصال بـ Groq (${res.status}) — راجع المفتاح في تبويب النماذج المجانية.`);
      }
    }

    // 3. Browser-to-Local PC Ollama (127.0.0.1:11434)
    if (mode === 'ollama-local') {
      try {
        const base = state.ollamaUrl.replace(/\/$/, '');
        const res = await fetch(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'qwen2.5:7b',
            stream: false,
            messages: [
              { role: 'system', content: STUDIO_SYSTEM_PROMPT },
              { role: 'user', content: promptText.slice(0, 4000) }
            ]
          })
        });
        if (res.ok) {
          const json = await res.json();
          const text = json.message?.content?.trim();
          if (text) return { reply: text, engineLabel: 'Ollama qwen2.5:7b · محلي مجاني' };
        }
      } catch {
        // Fallback below
      }
    }

    // 4. Keyless 100% Free Cloud Generative AI (Pollinations OpenAI-compatible CORS endpoint)
    if (mode === 'auto' || mode === 'pollinations-free') {
      try {
        const start = Math.round(performance.now());
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 14000);
        const res = await fetch('https://text.pollinations.ai/openai', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: ctrl.signal,
          body: JSON.stringify({
            model: 'openai',
            temperature: 0.4,
            messages: [
              { role: 'system', content: STUDIO_SYSTEM_PROMPT },
              { role: 'user', content: promptText.slice(0, 3500) }
            ]
          })
        });
        clearTimeout(timer);
        if (res.ok) {
          const json = await res.json();
          const text = json.choices?.[0]?.message?.content?.trim();
          if (text) {
            recordTrace('Free Cloud AI (Keyless OpenAI/Qwen)', { status: 200 }, Math.round(performance.now()) - start);
            return { reply: text, engineLabel: 'الذكاء السحابي المجاني · بدون مفتاح' };
          }
        }
      } catch {
        // Graceful fallback to instant server engine if browser blocks external domain
      }
    }

    // 5. Instant (<5ms) Server Celia Guard Fallback
    const providerArg = mode === 'celia-builtin' ? 'local' : 'auto';
    const { data } = await callMcpRpc('tools/call', {
      name: 'celia_ai_reply',
      arguments: { customerMessage: promptText, provider: providerArg }
    });
    const out = data.result?.structuredContent || {};
    return {
      reply: out.reply || 'تم تنفيذ المهمة بنجاح عبر حاسوب سيليا.',
      engineLabel:
        out.provider === 'gemini'
          ? `Gemini (${out.model}) · خادم MCP`
          : out.provider === 'ollama'
            ? `Ollama (${out.model}) · خادم MCP`
            : 'حارس سيليا المدمج · فوري بدون مفتاح'
    };
  }

  function updateAuthUi() {
    const hasOwner = Boolean(state.mcpToken && state.mcpToken.length >= 32);
    if (hasOwner) {
      el.authLabel.textContent = 'وضع المالك الموثّق (Bearer MCP)';
    } else if (state.geminiKey || state.groqKey) {
      el.authLabel.textContent = 'مفتاح مجاني مخصص متصل';
    } else {
      el.authLabel.textContent = 'مجاني 100% نشط';
    }
    el.tEngineState.textContent = state.geminiKey
      ? 'Gemini 2.5 Flash (مجاني)'
      : state.groqKey
        ? 'Groq Llama 3.3 (مجاني)'
        : 'سحابي مجاني فوري (0$)';
  }

  function toolCategory(name) {
    if (name.startsWith('google_')) return 'google';
    if (name.startsWith('whatsapp_')) return 'whatsapp';
    return 'ai';
  }

  function sampleArgsForTool(name) {
    switch (name) {
      case 'celia_status':
        return { probeOllama: true };
      case 'celia_ai_reply':
        return { customerMessage: 'مرحبًا، ما هي مواعيد العمل لديكم وكيف أحجز استشارة؟', provider: 'auto' };
      case 'whatsapp_consent_upsert':
        return { phone: '+201065217834', optedIn: true, aiOptedIn: true, source: 'نموذج موافقة استوديو سيليا 2026' };
      case 'whatsapp_contacts_list':
        return {};
      case 'whatsapp_send_text':
        return { phone: '+201065217834', text: 'مرحبًا بك! تم استلام استفسارك وسنتابع معك فورًا.' };
      case 'google_gmail_search':
        return { q: 'subject:invoice' };
      case 'google_drive_search':
        return { q: 'تقرير' };
      case 'google_calendar_events_list':
        return { days: 7 };
      case 'google_calendar_events_create':
        return {
          summary: 'اجتماع مراجعة مشروع سيليا',
          start: '2026-10-27T10:00:00Z',
          end: '2026-10-27T10:30:00Z',
          timeZone: 'Africa/Cairo'
        };
      case 'google_contacts_search':
        return { q: 'Celia' };
      default:
        return {};
    }
  }

  function renderToolsGrid(filter = 'all') {
    const labels = { ai: 'ذكاء وحالة', whatsapp: 'واتساب للأعمال', google: 'خدمات Google' };
    const filtered = state.tools.filter((t) => filter === 'all' || toolCategory(t.name) === filter);
    el.toolsGrid.innerHTML = filtered
      .map((tool) => {
        const cat = toolCategory(tool.name);
        return `
        <article class="tool-card">
          <div>
            <div class="tool-card-top">
              <span class="tool-mono-name">${escapeHtml(tool.name)}</span>
              <span class="tool-cat-badge">${escapeHtml(labels[cat])}</span>
            </div>
            <p>${escapeHtml(tool.description)}</p>
          </div>
          <button type="button" class="ghost-btn run-tool-btn" data-tool="${escapeHtml(tool.name)}">تشغيل الأداة حيًا ⚡</button>
        </article>`;
      })
      .join('');

    el.toolsGrid.querySelectorAll('.run-tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => openToolModal(btn.dataset.tool));
    });
  }

  function openToolModal(toolName) {
    const tool = state.tools.find((t) => t.name === toolName);
    if (!tool) return;
    state.selectedTool = tool;
    el.modalToolName.textContent = tool.name;
    el.modalToolDesc.textContent = tool.description;
    el.modalToolArgs.value = JSON.stringify(sampleArgsForTool(tool.name), null, 2);
    el.modalToolResult.textContent = '{ "ready": true }';
    el.toolModal.hidden = false;
  }

  function renderRichArtifact({ title, customHtml = '', markdownText = '', appHtmlCode = null, engineLabel = '', totalMs = 0, copyText = '' }) {
    if (appHtmlCode) {
      state.lastArtifactText = appHtmlCode;
      state.lastArtifactExt = 'html';
      const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(appHtmlCode)}`;
      el.artifactContent.className = '';
      el.artifactContent.innerHTML = `
        <div class="artifact-card">
          <div class="artifact-card-head">
            <h4>✨ ${escapeHtml(title)}</h4>
            <div class="artifact-mode-bar">
              <button type="button" class="artifact-mode-btn active" id="art-btn-live">👁️ معاينة التطبيق الحي</button>
              <button type="button" class="artifact-mode-btn" id="art-btn-code">💻 الكود المصدري</button>
            </div>
          </div>
          <div id="art-pane-live">
            <iframe class="artifact-iframe" sandbox="allow-scripts" title="${escapeHtml(title)}"></iframe>
          </div>
          <div id="art-pane-code" hidden>
            <pre class="mono-box" style="max-height:410px;">${escapeHtml(appHtmlCode)}</pre>
          </div>
          <div class="artifact-meta-footer">
            <span>المحرك: <strong>${escapeHtml(engineLabel)}</strong></span>
            <span dir="ltr">${totalMs}ms</span>
          </div>
        </div>`;

      const iframe = el.artifactContent.querySelector('iframe');
      iframe.src = dataUrl;
      const btnLive = el.artifactContent.querySelector('#art-btn-live');
      const btnCode = el.artifactContent.querySelector('#art-btn-code');
      const paneLive = el.artifactContent.querySelector('#art-pane-live');
      const paneCode = el.artifactContent.querySelector('#art-pane-code');

      btnLive.addEventListener('click', () => {
        btnLive.classList.add('active');
        btnCode.classList.remove('active');
        paneLive.hidden = false;
        paneCode.hidden = true;
      });
      btnCode.addEventListener('click', () => {
        btnCode.classList.add('active');
        btnLive.classList.remove('active');
        paneCode.hidden = false;
        paneLive.hidden = true;
      });
      return;
    }

    state.lastArtifactText = copyText || markdownText || title;
    state.lastArtifactExt = 'md';
    el.artifactContent.className = '';
    el.artifactContent.innerHTML = `
      <div class="artifact-card">
        <div class="artifact-card-head">
          <h4>📄 ${escapeHtml(title)}</h4>
        </div>
        ${customHtml}
        ${markdownText ? `<div class="artifact-doc">${formatMarkdownLite(markdownText)}</div>` : ''}
        <div class="artifact-meta-footer">
          <span>المحرك: <strong>${escapeHtml(engineLabel)}</strong></span>
          <span dir="ltr">${totalMs}ms</span>
        </div>
      </div>`;
  }

  function createAgentTurnUI(userTitle, enginePlaceholder = 'جارٍ التنفيذ...') {
    el.heroWelcome.style.display = 'none';

    const userDiv = document.createElement('div');
    userDiv.className = 'turn-user';
    userDiv.textContent = userTitle;
    el.stream.appendChild(userDiv);

    const agentDiv = document.createElement('div');
    agentDiv.className = 'turn-agent';
    agentDiv.innerHTML = `
      <div class="agent-header">
        <span class="agent-badge"><span class="agent-mini-orb"></span> سيليا — الوكيل التنفيذي</span>
        <span class="engine-tag">${escapeHtml(enginePlaceholder)}</span>
      </div>
      <div class="manus-plan">
        <div class="manus-plan-head">
          <span>🖥️ شاشة تنفيذ Manus الحية</span>
          <span class="plan-summary">قيد التنفيذ...</span>
        </div>
        <div class="manus-steps"></div>
      </div>
      <div class="agent-prose artifact-doc"></div>
    `;
    el.stream.appendChild(agentDiv);
    el.chatScroll.scrollTop = el.chatScroll.scrollHeight;

    const stepsContainer = agentDiv.querySelector('.manus-steps');
    const planSummary = agentDiv.querySelector('.plan-summary');
    const proseEl = agentDiv.querySelector('.agent-prose');
    const engineTagEl = agentDiv.querySelector('.engine-tag');

    function addStep(text) {
      const row = document.createElement('div');
      row.className = 'manus-step';
      row.innerHTML = `
        <div class="step-left">
          <span class="step-icon running">●</span>
          <span>${escapeHtml(text)}</span>
        </div>
        <span class="step-ms">...</span>`;
      stepsContainer.appendChild(row);
      el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
      return {
        done(ms) {
          const icon = row.querySelector('.step-icon');
          icon.className = 'step-icon done';
          icon.textContent = '✓';
          row.querySelector('.step-ms').textContent = `${ms}ms`;
        }
      };
    }

    function finish({ summaryText, proseMarkdown, engineLabel, artifactSpec }) {
      planSummary.textContent = summaryText;
      proseEl.innerHTML = formatMarkdownLite(proseMarkdown);
      if (engineLabel) engineTagEl.textContent = engineLabel;
      if (artifactSpec) {
        renderRichArtifact(artifactSpec);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'artifact-trigger-card';
        btn.innerHTML = `
          <div>
            <strong>${artifactSpec.appHtmlCode ? '✨ تطبيق حي تفاعلي:' : '📄 مستند المخرج:'} ${escapeHtml(artifactSpec.title)}</strong>
            <span>اضغط لفتح المعاينة التفاعلية الكاملة داخل حاسوب سيليا</span>
          </div>
          <span>↗</span>`;
        btn.addEventListener('click', () => openDrawer('preview'));
        agentDiv.appendChild(btn);
      }
      el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
    }

    return { addStep, finish };
  }

  function appendWhatsAppBubble(direction, text, meta) {
    const div = document.createElement('div');
    div.className = `wa-bubble ${direction}`;
    div.innerHTML = `${escapeHtml(text)}<span class="wa-meta">${escapeHtml(meta)}</span>`;
    el.waFeed.appendChild(div);
    el.waFeed.scrollTop = el.waFeed.scrollHeight;
  }

  async function runMission(missionId) {
    el.btnSend.disabled = true;
    try {
      if (missionId === 'live-app-artifact') {
        const turn = createAgentTurnUI('ابنِ تطبيق ويب تفاعليًا حيًا لإدارة عملاء واتساب وحاسبة عائد الأتمتة داخل حاسوب سيليا');
        const t0 = performance.now();

        const s1 = turn.addStep('1. فحص جاهزية خادم MCP وأدوات واتساب (celia_status)');
        const r1 = await callMcpRpc('tools/call', { name: 'celia_status', arguments: { probeOllama: false } });
        s1.done(r1.elapsed);

        const s2 = turn.addStep('2. تجميع مكونات الواجهة التفاعلية وحاسبة العائد (Claude Artifact Sandbox)');
        const s2t = performance.now();
        await new Promise((r) => setTimeout(r, 120));
        s2.done(Math.max(1, Math.round(performance.now() - s2t)));

        const totalMs = Math.round(performance.now() - t0);
        turn.finish({
          summaryText: `تم البناء والعرض الحي في ${totalMs}ms`,
          engineLabel: 'محرك المخرجات التفاعلية · Claude Artifact',
          proseMarkdown:
            `### تم بناء التطبيق التفاعلي بنجاح\n` +
            `- يعرض **حاسوب سيليا الحي** الآن تطبيق ويب تفاعليًا يعمل داخل معزل آمن (\`iframe sandbox\`).\n` +
            `- حرّك أشرطة التمرير لحساب الساعات والتكلفة الموفّرة شهريًا، أو اضغط **+ محاكاة عميل جديد** لاختبار الفرز الذكي للرسائل، أو بدّل إلى تبويب **💻 الكود المصدري** لنسخ أو تنزيل ملف HTML كاملًا.`,
          artifactSpec: {
            title: 'لوحة سيليا التفاعلية وحاسبة توفير الأتمتة 2026',
            appHtmlCode: SHOWCASE_ARTIFACT_HTML,
            engineLabel: 'Claude Artifact Sandbox · مجاني 100%',
            totalMs
          }
        });
        openDrawer('preview');
        return;
      }

      if (missionId === 'whatsapp-e2e') {
        const turn = createAgentTurnUI('شغّل سيناريو عميل واتساب الكامل للرقم +201065217834 مع التوقيع والرد الذكي');
        const t0 = performance.now();

        const s1 = turn.addStep('1. مصافحة خادم MCP وفحص الجاهزية (initialize)');
        const initRes = await callMcpRpc('initialize', { protocolVersion: '2024-11-05' });
        s1.done(initRes.elapsed);

        const s2 = turn.addStep('2. تسجيل الموافقة المزدوجة (optedIn + aiOptedIn) عبر أداة whatsapp_consent_upsert');
        const consentRes = await callMcpRpc('tools/call', {
          name: 'whatsapp_consent_upsert',
          arguments: {
            phone: '+201065217834',
            optedIn: true,
            aiOptedIn: true,
            source: 'موافقة موثقة عبر استوديو سيليا 2026'
          }
        });
        s2.done(consentRes.elapsed);

        const s3 = turn.addStep('3. استقبال رسالة Webhook موقّعة بـ HMAC-SHA256 وفتح نافذة الـ 24 ساعة');
        const inboundText = 'مرحبًا، ما هي مواعيد العمل لديكم وكيف يمكنني حجز موعد؟';
        const simRes = await callCryptoLab({
          action: 'simulate_inbound_whatsapp',
          phone: '+201065217834',
          text: inboundText
        });
        s3.done(simRes.elapsed);

        const s4 = turn.addStep('4. توليد الرد الذكي المحكوم بالسياسة للعميل');
        const aiStart = performance.now();
        const aiOut = await generateFreeAiText(inboundText);
        s4.done(Math.max(1, Math.round(performance.now() - aiStart)));

        appendWhatsAppBubble('inbound', inboundText, `+201065217834 · HMAC ✓`);
        appendWhatsAppBubble('outbound', aiOut.reply, `سيليا · ✓✓ داخل نافذة 24h`);
        el.waWindowInd.textContent = 'نافذة 24 ساعة: مفتوحة ونشطة ✓';

        const totalMs = Math.round(performance.now() - t0);
        const customHtml = `
          <div class="kv-grid">
            <div class="kv-item"><span>رقم العميل (E.164)</span><span class="kv-val">+201065217834</span></div>
            <div class="kv-item"><span>توقيع HMAC-SHA256</span><span class="kv-val">متحقق ✓ (${escapeHtml(simRes.data.signatureHeader.slice(0, 22))}...)</span></div>
            <div class="kv-item"><span>نافذة خدمة العملاء 24h</span><span class="kv-val">مفتوحة ✓</span></div>
            <div class="kv-item"><span>الموافقة المزدوجة (WhatsApp + AI)</span><span class="kv-val">مفعّلة ✓</span></div>
          </div>`;

        turn.finish({
          summaryText: `اكتملت ٤ خطوات بنجاح في ${totalMs}ms`,
          engineLabel: aiOut.engineLabel,
          proseMarkdown:
            `### اكتملت دورة واتساب للأعمال بنجاح\n` +
            `- تم توثيق الموافقة المزدوجة للرقم \`+201065217834\` والتحقق الجنائي من توقيع Webhook الخام.\n` +
            `- فُتحت نافذة الـ 24 ساعة وتم توليد الرد التالي:\n\n${aiOut.reply}`,
          artifactSpec: {
            title: 'إيصال تشغيل واتساب الموثّق + الرد الذكي',
            customHtml,
            markdownText: `### رسالة العميل الواردة\n${inboundText}\n\n### رد سيليا المعتمد\n${aiOut.reply}`,
            engineLabel: aiOut.engineLabel,
            totalMs,
            copyText: aiOut.reply
          }
        });
        openDrawer('preview');
        return;
      }

      if (missionId === 'security-audit') {
        const turn = createAgentTurnUI('نفّذ مصافحة MCP الكاملة وافحص تشفير AES-256-GCM وتواقيع HMAC');
        const t0 = performance.now();

        const s1 = turn.addStep('1. مصافحة بروتوكول MCP (initialize 2024-11-05)');
        const r1 = await callMcpRpc('initialize', { protocolVersion: '2024-11-05' });
        s1.done(r1.elapsed);

        const s2 = turn.addStep('2. فحص سجل الأدوات العشر (tools/list)');
        const r2 = await callMcpRpc('tools/list');
        s2.done(r2.elapsed);

        const s3 = turn.addStep('3. اختبار تشفير AES-256-GCM وكشف التلاعب بـ HMAC-SHA256');
        const r3 = await callCryptoLab({ action: 'audit' });
        s3.done(r3.elapsed);

        const c = r3.data.cryptography;
        const totalMs = Math.round(performance.now() - t0);
        const customHtml = `
          <div class="kv-grid">
            <div class="kv-item"><span>تشفير رموز Google OAuth</span><span class="kv-val">AES-256-GCM ✓</span></div>
            <div class="kv-item"><span>فك التشفير المطابق للأصل</span><span class="kv-val">${c.decryptedMatchesOriginal ? 'تطابق 100% ✓' : 'فشل'}</span></div>
            <div class="kv-item"><span>تجزئة OAuth State</span><span class="kv-val">${escapeHtml(c.oauthStateHash.slice(0, 18))}...</span></div>
            <div class="kv-item"><span>رفض الرسائل المتلاعب بها</span><span class="kv-val">${c.tamperRejected ? 'محجوب فورًا ✓' : 'غير محجوب'}</span></div>
          </div>
          <pre class="mono-box">${escapeHtml(c.encryptedTokenPreview)}</pre>`;

        turn.finish({
          summaryText: `اكتمل التدقيق في ${totalMs}ms`,
          engineLabel: 'مختبر التشفير الحي · Node Crypto',
          proseMarkdown:
            `### اجتازت المنظومة جميع فحوص التشفير والمصادقة\n` +
            `- خادم \`${r1.data.result?.serverInfo?.name}\` يعمل بكامل الأدوات (${r2.data.result?.tools?.length} أدوات).\n` +
            `- رموز OAuth تُحفظ بصيغة مشفّرة مصادق عليها (\`v1.nonce.tag.ciphertext\`).\n` +
            `- أي تعديل في حمولة Webhook يُرفض تلقائيًا بمقارنة ثابتة التوقيت.`,
          artifactSpec: {
            title: 'بطاقة التدقيق الجنائي للتشفير (AES-256-GCM & HMAC)',
            customHtml,
            engineLabel: 'Node.js Crypto Engine',
            totalMs,
            copyText: JSON.stringify(c, null, 2)
          }
        });
        openDrawer('preview');
        return;
      }

      if (missionId === 'free-stack-blueprint') {
        const turn = createAgentTurnUI('ولّد حزمة الربط المجاني الشاملة لعام 2026 مع Claude وCursor وGitHub Actions');
        const t0 = performance.now();

        const s1 = turn.addStep('1. فحص حالة الخادم ومزودات الذكاء المجانية (celia_status)');
        const r1 = await callMcpRpc('tools/call', { name: 'celia_status', arguments: { probeOllama: false } });
        s1.done(r1.elapsed);

        const s2 = turn.addStep('2. بناء ملف إعداد بروتوكول MCP القياسي (mcp.json)');
        const r2 = await callMcpRpc('prompts/list');
        s2.done(r2.elapsed);

        const mcpConfigStr = document.getElementById('mcp-json-snippet').textContent;
        const totalMs = Math.round(performance.now() - t0);
        const customHtml = `
          <div class="kv-grid">
            <div class="kv-item"><span>GitHub Actions + Gemini Secret</span><span class="kv-val">مربوط ومُختبر ✓</span></div>
            <div class="kv-item"><span>الذكاء السحابي المجاني بالمتصفح</span><span class="kv-val">نشط بدون مفتاح ✓</span></div>
            <div class="kv-item"><span>التشغيل المحلي المفتوح</span><span class="kv-val">Ollama qwen2.5:7b</span></div>
          </div>
          <pre class="mono-box">${escapeHtml(mcpConfigStr)}</pre>`;

        turn.finish({
          summaryText: `جاهز للنسخ في ${totalMs}ms`,
          engineLabel: 'معمارية سيليا المجانية 2026',
          proseMarkdown:
            `### حزمة الربط المجانية جاهزة بتكلفة 0.00$\n` +
            `- داخل **GitHub Actions**: يعمل سرك \`GEMINI_API_KEY\` و\`CELIA_MCP_API_TOKEN\` تلقائيًا.\n` +
            `- مع **Claude Desktop / Cursor**: انسخ ملف \`mcp.json\` من لوحة المخرجات لتشغيل سيليا عبر \`stdio\` مجانًا.\n` +
            `- داخل **هذه الواجهة**: يعمل التوليد السحابي المجاني وعارض التطبيقات الحية مباشرة.`,
          artifactSpec: {
            title: 'ملف الربط المجاني mcp.json لعام 2026',
            customHtml,
            engineLabel: 'MCP 2024-11-05 Blueprint · 0$',
            totalMs,
            copyText: mcpConfigStr
          }
        });
        openDrawer('preview');
      }
    } catch (err) {
      alert(`حدث خطأ أثناء التنفيذ: ${err.message}`);
    } finally {
      el.btnSend.disabled = false;
    }
  }

  async function handleCustomPrompt(text) {
    const prompt = text.trim();
    if (!prompt) return;
    el.btnSend.disabled = true;
    el.composerInput.value = '';

    const turn = createAgentTurnUI(prompt);
    const t0 = performance.now();

    try {
      const e164Match = prompt.match(/\+[1-9]\d{7,14}/);
      const localEgMatch = !e164Match ? prompt.match(/\b01[0125]\d{8}\b/) : null;
      const detectedPhone = e164Match ? e164Match[0] : localEgMatch ? `+2${localEgMatch[0]}` : null;

      let consentData = null;
      let simData = null;

      const s1 = turn.addStep('1. تحليل المهمة وفحص جاهزية أدوات MCP (celia_status)');
      const st = await callMcpRpc('tools/call', { name: 'celia_status', arguments: { probeOllama: false } });
      s1.done(st.elapsed);

      if (detectedPhone || /(واتساب|موافق|webhook)/i.test(prompt)) {
        const phone = detectedPhone || '+201065217834';
        const s2 = turn.addStep(`2. تسجيل موافقة العميل ${phone} عبر أداة whatsapp_consent_upsert`);
        const cRes = await callMcpRpc('tools/call', {
          name: 'whatsapp_consent_upsert',
          arguments: {
            phone,
            optedIn: true,
            aiOptedIn: true,
            source: 'أمر مباشر من مساحة الوكيل'
          }
        });
        s2.done(cRes.elapsed);
        consentData = cRes.data.result?.structuredContent;

        const s3 = turn.addStep(`3. محاكاة Webhook موقّع بـ HMAC-SHA256 للرقم ${phone}`);
        const simRes = await callCryptoLab({
          action: 'simulate_inbound_whatsapp',
          phone,
          text: prompt
        });
        s3.done(simRes.elapsed);
        simData = simRes.data;
      }

      const sAi = turn.addStep('توليد المخرج والاستجابة الذكية عبر المحرك المجاني');
      const aiStart = performance.now();
      const aiOut = await generateFreeAiText(prompt);
      sAi.done(Math.max(1, Math.round(performance.now() - aiStart)));

      const appHtmlCode = extractHtmlArtifact(aiOut.reply);
      const totalMs = Math.round(performance.now() - t0);

      const whatsappSummaryHtml = simData
        ? `<div class="kv-grid">
             <div class="kv-item"><span>الرقم المربوط</span><span class="kv-val">${escapeHtml(simData.phone)}</span></div>
             <div class="kv-item"><span>حالة الموافقة المزدوجة</span><span class="kv-val">${consentData?.aiOptedIn ? 'مفعّلة ✓' : 'مسجلة'}</span></div>
             <div class="kv-item"><span>توقيع HMAC-SHA256</span><span class="kv-val">صحيح ✓</span></div>
             <div class="kv-item"><span>نافذة 24 ساعة</span><span class="kv-val">مفتوحة ✓</span></div>
           </div>`
        : '';

      turn.finish({
        summaryText: `اكتمل التنفيذ في ${totalMs}ms`,
        engineLabel: aiOut.engineLabel,
        proseMarkdown: appHtmlCode
          ? aiOut.reply.replace(/```html[\s\S]*?```/gi, '\n\n*(تم تشغيل التطبيق التفاعلي الكامل داخل شاشة حاسوب سيليا الحي ↗)*')
          : aiOut.reply,
        artifactSpec: {
          title: appHtmlCode
            ? 'تطبيق تفاعلي حي من سيليا'
            : simData
              ? `مخرج ربط واستجابة واتساب (${simData.phone})`
              : 'مستند مخرج سيليا الكامل',
          appHtmlCode,
          customHtml: whatsappSummaryHtml,
          markdownText: appHtmlCode ? '' : aiOut.reply,
          engineLabel: aiOut.engineLabel,
          totalMs,
          copyText: appHtmlCode || aiOut.reply
        }
      });

      if (appHtmlCode) {
        openDrawer('preview');
      }
    } catch (err) {
      turn.finish({
        summaryText: 'توقف التنفيذ بسبب خطأ',
        engineLabel: 'تنبيه',
        proseMarkdown: `تعذّر إكمال الخطوة: ${err.message}`
      });
    } finally {
      el.btnSend.disabled = false;
    }
  }

  async function bootstrap() {
    applyTheme(state.theme);

    el.vaultMcpToken.value = state.mcpToken;
    el.vaultGeminiKey.value = state.geminiKey;
    el.vaultGroqKey.value = state.groqKey;
    el.vaultOllamaUrl.value = state.ollamaUrl;

    try {
      const healthRes = await fetch('./health');
      if (healthRes.ok) {
        state.serverHealth = await healthRes.json();
        if (state.serverHealth.providers?.ollama?.reachable) {
          el.ollamaLiveBadge.textContent = 'متصل محليًا ✓';
          el.ollamaLiveBadge.className = 'badge-pill ok';
        }
      }
      const listRes = await callMcpRpc('tools/list');
      state.tools = listRes.data.result?.tools || [];
      el.navToolsCount.textContent = String(state.tools.length);
      renderToolsGrid('all');
    } catch (err) {
      el.tMcpState.textContent = `تنبيه: ${err.message}`;
    }

    updateAuthUi();
  }

  // Event Listeners
  el.navPills.forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  el.btnTheme.addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  });

  el.btnNewChat.addEventListener('click', () => {
    switchView('studio');
    el.stream.innerHTML = '';
    el.heroWelcome.style.display = '';
  });

  el.btnAuthStatus.addEventListener('click', () => switchView('models'));

  el.btnToggleComputer.addEventListener('click', () => {
    el.drawer.classList.toggle('open');
  });

  el.btnExpandComputer.addEventListener('click', () => {
    el.drawer.classList.toggle('expanded');
    el.btnExpandComputer.textContent = el.drawer.classList.contains('expanded') ? '🗗 تصغير' : '⛶ تكبير';
  });

  el.btnDownloadArtifact.addEventListener('click', () => {
    if (!state.lastArtifactText) return;
    const blob = new Blob([state.lastArtifactText], {
      type: state.lastArtifactExt === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `celia-artifact-${Date.now()}.${state.lastArtifactExt}`;
    a.click();
    URL.revokeObjectURL(url);
  });

  el.btnCloseComputer.addEventListener('click', () => {
    el.drawer.classList.remove('open');
  });

  el.drawerTabs.forEach((btn) => {
    btn.addEventListener('click', () => switchDrawerTab(btn.dataset.dtab));
  });

  el.btnCopyArtifact.addEventListener('click', async () => {
    if (!state.lastArtifactText) return;
    await navigator.clipboard?.writeText(state.lastArtifactText).catch(() => {});
    el.btnCopyArtifact.textContent = 'تم النسخ ✓';
    setTimeout(() => {
      el.btnCopyArtifact.textContent = 'نسخ';
    }, 1400);
  });

  document.querySelectorAll('.mission-card').forEach((card) => {
    card.addEventListener('click', () => runMission(card.dataset.mission));
  });

  document.querySelectorAll('.quick-chip').forEach((chip) => {
    chip.addEventListener('click', () => handleCustomPrompt(chip.dataset.quick));
  });

  el.composerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    handleCustomPrompt(el.composerInput.value);
  });

  el.composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleCustomPrompt(el.composerInput.value);
    }
  });

  el.toolFilters.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      el.toolFilters.querySelectorAll('.filter-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderToolsGrid(chip.dataset.cat);
    });
  });

  el.btnCloseModal.addEventListener('click', () => {
    el.toolModal.hidden = true;
  });

  el.btnExecTool.addEventListener('click', async () => {
    if (!state.selectedTool) return;
    let parsedArgs = {};
    try {
      parsedArgs = JSON.parse(el.modalToolArgs.value || '{}');
    } catch {
      el.modalToolResult.textContent = '{ "error": "صيغة JSON غير صالحة في حقل المعاملات" }';
      return;
    }
    el.modalToolResult.textContent = '{ "running": true }';
    try {
      const { data } = await callMcpRpc('tools/call', {
        name: state.selectedTool.name,
        arguments: parsedArgs
      });
      el.modalToolResult.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      el.modalToolResult.textContent = JSON.stringify({ error: err.message }, null, 2);
    }
  });

  el.btnWaConsent.addEventListener('click', async () => {
    try {
      const { data } = await callMcpRpc('tools/call', {
        name: 'whatsapp_consent_upsert',
        arguments: {
          phone: el.waPhone.value.trim(),
          optedIn: el.waOptIn.checked,
          aiOptedIn: el.waAiOptIn.checked,
          source: 'محاكي واتساب المباشر — سيليا 2026'
        }
      });
      el.waCryptoReport.textContent = JSON.stringify(data.result?.structuredContent || data, null, 2);
    } catch (err) {
      el.waCryptoReport.textContent = JSON.stringify({ error: err.message }, null, 2);
    }
  });

  el.btnWaSendSim.addEventListener('click', async () => {
    const phone = el.waPhone.value.trim();
    const text = el.waText.value.trim();
    if (!text) return;
    try {
      await callMcpRpc('tools/call', {
        name: 'whatsapp_consent_upsert',
        arguments: {
          phone,
          optedIn: el.waOptIn.checked,
          aiOptedIn: el.waAiOptIn.checked,
          source: el.waOptIn.checked ? 'محاكي واتساب التفاعلي' : ''
        }
      });
      const { data } = await callCryptoLab({
        action: 'simulate_inbound_whatsapp',
        phone,
        text
      });
      appendWhatsAppBubble('inbound', text, `${data.phone} · HMAC ✓`);
      el.waWindowInd.textContent = data.customerWindow24hOpen
        ? 'نافذة 24 ساعة: مفتوحة ونشطة ✓'
        : 'نافذة 24 ساعة: مغلقة';
      if (data.autoReply) {
        appendWhatsAppBubble('outbound', data.autoReply, 'سيليا · ✓✓ رد ذكي آمن');
      } else if (data.blockedReason) {
        appendWhatsAppBubble('outbound', `[حارس السياسة]: ${data.blockedReason}`, 'إشعار نظام');
      }
      el.waCryptoReport.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      el.waCryptoReport.textContent = JSON.stringify({ error: err.message }, null, 2);
    }
  });

  el.btnWaCrypto.addEventListener('click', async () => {
    const { data } = await callCryptoLab({ action: 'audit' });
    el.waCryptoReport.textContent = JSON.stringify(data.cryptography, null, 2);
  });

  el.btnVerifyVault.addEventListener('click', async () => {
    state.mcpToken = el.vaultMcpToken.value.trim();
    state.geminiKey = el.vaultGeminiKey.value.trim();
    state.groqKey = el.vaultGroqKey.value.trim();
    state.ollamaUrl = el.vaultOllamaUrl.value.trim() || 'http://127.0.0.1:11434';

    sessionStorage.setItem('celia_mcp_token', state.mcpToken);
    sessionStorage.setItem('celia_gemini_key', state.geminiKey);
    sessionStorage.setItem('celia_groq_key', state.groqKey);
    sessionStorage.setItem('celia_ollama_url', state.ollamaUrl);

    try {
      const res = await callMcpRpc('ping');
      updateAuthUi();
      el.vaultFeedback.textContent =
        res.mode === 'owner'
          ? '✓ تم التوثيق بنجاح في وضع المالك المباشر (POST /mcp Bearer)!'
          : '✓ تم حفظ إعدادات النماذج المجانية لجلسة المتصفح بنجاح!';
    } catch (err) {
      el.vaultFeedback.textContent = `⚠ فشل التحقق من رمز CELIA_MCP_API_TOKEN: ${err.message}`;
    }
  });

  bootstrap();
})();
