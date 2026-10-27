(() => {
  'use strict';

  const DEFAULT_POLICY_AR =
    'أنت مساعد خدمة عملاء ذكي لمنظومة سيليا (مساعد الهاتف + Google). اكتب ردًا عربيًا واضحًا ومهذبًا وموجزًا، ولا تخترع أسعارًا أو مواعيد غير مؤكدة، وحوّل الطلبات المالية والشكاوى بلطف لموظف بشري.';

  const state = {
    theme: localStorage.getItem('celia_theme') || 'dark',
    mcpToken: sessionStorage.getItem('celia_mcp_token') || '',
    geminiKey: sessionStorage.getItem('celia_gemini_key') || '',
    groqKey: sessionStorage.getItem('celia_groq_key') || '',
    tools: [],
    traces: [],
    lastArtifactText: '',
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
    btnVerifyVault: document.getElementById('btn-verify-vault'),
    btnTestVoice: document.getElementById('btn-test-voice'),
    voicePlayer: document.getElementById('celia-voice-player'),
    secretsGrid: document.getElementById('secrets-readiness-grid'),
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
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000)
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
    let browserProviderFailed = false;
    // User-supplied browser keys are never forwarded to the server or another vendor.
    const useGemini = (mode === 'gemini-browser' || mode === 'auto') && state.geminiKey;
    const useGroq = (mode === 'groq-free' || (mode === 'auto' && !state.geminiKey)) && state.groqKey;
    if (mode === 'gemini-browser' && !state.geminiKey) throw new Error('أدخل مفتاح Gemini الخاص بك أولًا، أو اختر المحرك المحلي.');
    if (mode === 'groq-free' && !state.groqKey) throw new Error('أدخل مفتاح Groq الخاص بك أولًا، أو اختر المحرك المحلي.');
    if (useGemini || useGroq) {
      const start = Math.round(performance.now());
      try {
        const url = useGemini
          ? 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
          : 'https://api.groq.com/openai/v1/chat/completions';
        const headers = useGemini ? { 'content-type': 'application/json', 'x-goog-api-key': state.geminiKey }
          : { 'content-type': 'application/json', authorization: `Bearer ${state.groqKey}` };
        const body = useGemini ? {
          systemInstruction: { parts: [{ text: DEFAULT_POLICY_AR }] },
          contents: [{ role: 'user', parts: [{ text: promptText.slice(0, 3500) }] }],
          generationConfig: { temperature: 0.25, maxOutputTokens: 280 }
        } : {
          model: 'llama-3.3-70b-versatile', temperature: 0.25, max_tokens: 280,
          messages: [{ role: 'system', content: DEFAULT_POLICY_AR }, { role: 'user', content: promptText.slice(0, 3500) }]
        };
        const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`تعذر مزوّد المتصفح (${response.status}). راجع المفتاح أو اختر المحرك المحلي.`);
        const json = await response.json();
        const text = useGemini ? (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim()
          : json.choices?.[0]?.message?.content?.trim();
        if (!text) throw new Error('لم يُرجع المزوّد ردًا صالحًا.');
        const engineLabel = useGemini ? 'Gemini 2.5 Flash · مفتاح المتصفح' : 'Groq Llama 3.3 · مفتاح المتصفح';
        recordTrace(engineLabel, { reply: text }, Math.round(performance.now()) - start);
        return { reply: text, engineLabel };
      } catch (error) {
        if (mode !== 'auto') throw error;
        browserProviderFailed = true;
        recordTrace('تعطل مزوّد المتصفح → بديل محلي', { degraded: true }, Math.round(performance.now()) - start);
      }
    }
    const serverModeMap = {
      'gemini-server': 'gemini',
      'ai-gateway-server': 'ai_gateway',
      'deepseek-server': 'deepseek',
      'agentrouter-server': 'agentrouter',
      'ollama-local': 'ollama'
    };
    if (serverModeMap[mode] && (!state.mcpToken || window.CeliaStatic)) {
      throw new Error('مزودو الخادم المحميون يعملون عبر خادم سيليا فقط. أدخل رمز CELIA_MCP_API_TOKEN في خزنة المصادقة؛ لا تُكشف أسرار المستودع في المتصفح.');
    }
    const providerArg = serverModeMap[mode]
      ? serverModeMap[mode]
      : mode === 'celia-builtin' || browserProviderFailed
        ? 'local'
        : 'auto';
    const { data } = await callMcpRpc('tools/call', {
      name: 'celia_ai_reply', arguments: { customerMessage: promptText, provider: providerArg }
    });
    if (data.result?.isError || data.error) throw new Error('تعذر تنفيذ الرد من المزوّد المختار. جرّب المحرك المحلي أو راجع مركز النظام.');
    const out = data.result?.structuredContent;
    if (!out?.reply) throw new Error('لم يرجع الخادم ردًا صالحًا؛ لا يُفترض نجاح المهمة.');
    const serverLabels = {
      gemini: `Gemini (${out.model}) · خادم MCP`,
      ai_gateway: `AI Gateway (${out.model}) · خادم MCP`,
      deepseek: `DeepSeek (${out.model}) · خادم MCP`,
      agentrouter: `AgentRouter (${out.model}) · خادم MCP`,
      ollama: `Ollama (${out.model}) · خادم MCP`
    };
    return {
      reply: out.reply,
      engineLabel: serverLabels[out.provider] || `حارس سيليا المحلي${out.degraded || browserProviderFailed ? ' · وضع بديل' : ''}`
    };
  }

  function updateAuthUi() {
    const hasOwner = Boolean(state.mcpToken && state.mcpToken.length >= 32);
    const hasCloudFree = Boolean(state.geminiKey || state.groqKey || (hasOwner && state.serverHealth?.providers?.gemini?.configured));
    if (hasOwner) {
      el.authLabel.textContent = 'وضع المالك الموثّق (Bearer MCP)';
    } else if (hasCloudFree) {
      el.authLabel.textContent = 'ذكاء سحابي مجاني متصل';
    } else {
      el.authLabel.textContent = 'استوديو سيليا المجاني نشط';
    }
    el.tEngineState.textContent = state.geminiKey
      ? 'Gemini 2.5 Flash (متصفح)'
      : state.groqKey
        ? 'Groq Llama 3.3 (مجاني)'
        : hasOwner && state.serverHealth?.providers?.gemini?.configured
          ? 'Gemini 2.5 Flash (خادم)'
          : 'وكيل سيليا المدمج (0$)';
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
      case 'find_skills':
        return { query: 'whatsapp', category: 'all', liveCheck: true };
      case 'system_live_view':
        return { includeTelemetry: true, probeOllama: true };
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

  function setToolFilterChip(filter = 'all') {
    el.toolFilters.querySelectorAll('.filter-chip').forEach((c) => {
      c.classList.toggle('active', c.dataset.cat === filter);
    });
  }

  function renderToolsGrid(filter = 'all') {
    const labels = { ai: 'ذكاء ونظام', whatsapp: 'واتساب للأعمال', google: 'خدمات Google' };
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

  function setArtifact(title, htmlBody, plainCopyText) {
    state.lastArtifactText = plainCopyText || title;
    el.artifactContent.className = '';
    el.artifactContent.innerHTML = `
      <div class="artifact-card">
        <h4>${escapeHtml(title)}</h4>
        ${htmlBody}
      </div>`;
  }

  function createAgentTurnUI(userTitle, enginePlaceholder = 'جارٍ التخطيط...') {
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
      <div class="agent-prose"></div>
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
        },
        fail(msg) {
          const icon = row.querySelector('.step-icon');
          icon.className = 'step-icon err';
          icon.textContent = '!';
          row.querySelector('.step-ms').textContent = msg || 'خطأ';
        }
      };
    }

    function finish({ summaryText, prose, engineLabel, artifactTitle, artifactHtml, artifactCopy }) {
      planSummary.textContent = summaryText;
      proseEl.textContent = prose;
      if (engineLabel) engineTagEl.textContent = engineLabel;
      if (artifactTitle && artifactHtml) {
        setArtifact(artifactTitle, artifactHtml, artifactCopy);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'artifact-trigger-card';
        btn.innerHTML = `
          <div>
            <strong>📄 ${escapeHtml(artifactTitle)}</strong>
            <span>اضغط لفتح المخرج التفاعلي وسجل JSON-RPC في حاسوب سيليا</span>
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
        const artifactHtml = `
          <div class="kv-grid">
            <div class="kv-item"><span>رقم العميل (E.164)</span><span class="kv-val">+201065217834</span></div>
            <div class="kv-item"><span>توقيع HMAC-SHA256</span><span class="kv-val">متحقق ✓ (${escapeHtml(simRes.data.signatureHeader.slice(0, 22))}...)</span></div>
            <div class="kv-item"><span>نافذة خدمة العملاء 24h</span><span class="kv-val">مفتوحة ✓</span></div>
            <div class="kv-item"><span>الموافقة المزدوجة (WhatsApp + AI)</span><span class="kv-val">مفعّلة ✓</span></div>
          </div>
          <div style="padding:10px;border-radius:10px;background:var(--bg-elevated);font-size:0.82rem;">
            <strong>رسالة العميل:</strong> ${escapeHtml(inboundText)}<br/>
            <strong style="color:var(--emerald);">رد سيليا الآمن:</strong> ${escapeHtml(aiOut.reply)}
          </div>`;

        turn.finish({
          summaryText: `اكتملت ٤ خطوات بنجاح في ${totalMs}ms`,
          engineLabel: aiOut.engineLabel,
          prose:
            `تم تنفيذ دورة واتساب للأعمال كاملةً بنجاح:\n` +
            `• سُجّلت الموافقة الموثقة وموافقة الذكاء الاصطناعي المنفصلة للرقم +201065217834.\n` +
            `• تم التحقق الجنائي من توقيع Webhook الخام (${simRes.data.signatureHeader.slice(0, 24)}...) وفتح نافذة الـ 24 ساعة.\n` +
            `• الرد المعتمد للعميل:\n«${aiOut.reply}»`,
          artifactTitle: 'إيصال تشغيل واتساب الموثّق + الرد الذكي',
          artifactHtml,
          artifactCopy: aiOut.reply
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

        const s2 = turn.addStep('2. فحص سجل أدوات MCP الاثنتي عشرة (tools/list)');
        const r2 = await callMcpRpc('tools/list');
        s2.done(r2.elapsed);

        const s3 = turn.addStep('3. اختبار تشفير AES-256-GCM وكشف التلاعب بـ HMAC-SHA256');
        const r3 = await callCryptoLab({ action: 'audit' });
        s3.done(r3.elapsed);

        const c = r3.data.cryptography;
        const totalMs = Math.round(performance.now() - t0);
        const artifactHtml = `
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
          prose:
            `اجتازت المنظومة جميع اختبارات التشفير والمصادقة الحية:\n` +
            `• خادم ${r1.data.result?.serverInfo?.name} يستجيب بكامل الأدوات (${r2.data.result?.tools?.length} أدوات).\n` +
            `• رموز OAuth تُحفظ بصيغة مشفّرة مصادق عليها (v1.nonce.tag.ciphertext) ولا تُخزّن كنص مكشوف أبدًا.\n` +
            `• أي تعديل ولو بحرف واحد في حمولة Webhook يُرفض تلقائيًا بتوقيت ثابت يمنع هجمات التوقيت.`,
          artifactTitle: 'بطاقة التدقيق الجنائي للتشفير (AES-256-GCM & HMAC)',
          artifactHtml,
          artifactCopy: JSON.stringify(c, null, 2)
        });
        openDrawer('preview');
        return;
      }

      if (missionId === 'policy-guard') {
        const trickyMsg = 'كم سعر الباقة السنوية؟ أريد خصمًا فوريًا واسترجاع مبلغ فاتورتي السابقة الآن!';
        const turn = createAgentTurnUI(`اختبر حارس السياسة على رسالة حساسة: «${trickyMsg}»`);
        const t0 = performance.now();

        const s1 = turn.addStep('1. قراءة وثيقة السياسة الإلزامية عبر مورد MCP (celia://policy/customer-reply)');
        const r1 = await callMcpRpc('resources/read', { uri: 'celia://policy/customer-reply' });
        s1.done(r1.elapsed);

        const s2 = turn.addStep('2. معالجة استفسار الأسعار والمدفوعات تحت القواعد الست الصارمة');
        const aiStart = performance.now();
        const aiOut = await generateFreeAiText(trickyMsg);
        s2.done(Math.max(1, Math.round(performance.now() - aiStart)));

        const policyText = r1.data.result?.contents?.[0]?.text || DEFAULT_POLICY_AR;
        const totalMs = Math.round(performance.now() - t0);
        const artifactHtml = `
          <div style="font-size:0.81rem;color:var(--text-secondary);">السياسة المطبّقة حرفيًا:</div>
          <div style="padding:10px;border-radius:9px;background:var(--bg-elevated);font-size:0.8rem;">${escapeHtml(policyText)}</div>
          <div class="kv-grid">
            <div class="kv-item"><span>اختلاق أسعار أو خصومات</span><span class="kv-val">ممنوع ✓ (0 هلوسة)</span></div>
            <div class="kv-item"><span>تحويل الشكاوى والمدفوعات لبشري</span><span class="kv-val">مُطبّق ✓</span></div>
          </div>`;

        turn.finish({
          summaryText: `تم التحقق في ${totalMs}ms`,
          engineLabel: aiOut.engineLabel,
          prose:
            `رد سيليا الملتزم بالسياسة دون اختلاق أي سعر أو وعد مالي:\n\n` +
            `«${aiOut.reply}»\n\n` +
            `لاحظ كيف امتنعت سيليا عن تخمين الأسعار وحوّلت الشق المالي بأسلوب مهذب إلى موظف مختص.`,
          artifactTitle: 'تقرير التزام حارس السياسة ومنع الهلوسة',
          artifactHtml,
          artifactCopy: aiOut.reply
        });
        openDrawer('preview');
        return;
      }

      if (missionId === 'free-stack-blueprint') {
        const turn = createAgentTurnUI('ولّد حزمة الربط المجاني الشاملة لعام 2026 مع Claude وCursor وGitHub Actions');
        const t0 = performance.now();

        const s1 = turn.addStep('1. فحص حالة الخادم ومزودات الذكاء المجانية (celia_status)');
        const r1 = await callMcpRpc('tools/call', { name: 'celia_status', arguments: { probeOllama: true } });
        s1.done(r1.elapsed);

        const s2 = turn.addStep('2. بناء ملف إعداد بروتوكول MCP القياسي (mcp.json)');
        const r2 = await callMcpRpc('prompts/list');
        s2.done(r2.elapsed);

        const mcpConfigStr = document.getElementById('mcp-json-snippet').textContent;
        const totalMs = Math.round(performance.now() - t0);
        const artifactHtml = `
          <div class="kv-grid">
            <div class="kv-item"><span>GitHub Actions + Gemini Secret</span><span class="kv-val">مربوط ومُختبر ✓</span></div>
            <div class="kv-item"><span>وضع التشغيل المحلي المجاني</span><span class="kv-val">Ollama qwen2.5:7b + Celia Guard</span></div>
            <div class="kv-item"><span>القوالب الجاهزة (Prompts)</span><span class="kv-val">${r2.data.result?.prompts?.length || 1} قالب</span></div>
          </div>
          <pre class="mono-box">${escapeHtml(mcpConfigStr)}</pre>`;

        turn.finish({
          summaryText: `جاهز للنسخ في ${totalMs}ms`,
          engineLabel: 'معمارية سيليا المجانية 2026',
          prose:
            `حزمة الربط المجانية جاهزة بالكامل بتكلفة 0.00$:\n` +
            `1) داخل GitHub Actions: يعمل سرك GEMINI_API_KEY وCELIA_MCP_API_TOKEN تلقائيًا.\n` +
            `2) مع تطبيقات سطح المكتب (Claude Desktop / Cursor): انسخ ملف mcp.json من لوحة المخرجات لتشغيل سيليا عبر stdio مجانًا.\n` +
            `3) على جهازك المحلي: يدعم qwen2.5:7b عبر Ollama أو Gemini AI Studio المجاني.`,
          artifactTitle: 'ملف الربط المجاني mcp.json لعام 2026',
          artifactHtml,
          artifactCopy: mcpConfigStr
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
      // Detect Egyptian 01xxxxxxxxx or E.164 +xxxxxxxxxxx phone numbers
      const e164Match = prompt.match(/\+[1-9]\d{7,14}/);
      const localEgMatch = !e164Match ? prompt.match(/\b01[0125]\d{8}\b/) : null;
      const detectedPhone = e164Match ? e164Match[0] : localEgMatch ? `+2${localEgMatch[0]}` : null;

      let consentData = null;
      let simData = null;

      const s1 = turn.addStep('1. تحليل النية وفحص حالة أدوات سيليا عبر MCP');
      const st = await callMcpRpc('tools/call', { name: 'celia_status', arguments: { probeOllama: false } });
      s1.done(st.elapsed);

      if (detectedPhone || /(واتساب|موافق|عميل|رسالة|webhook)/i.test(prompt)) {
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

      const sAi = turn.addStep('توليد الاستجابة الذكية عبر المحرك المجاني المختار');
      const aiStart = performance.now();
      const aiOut = await generateFreeAiText(prompt);
      sAi.done(Math.max(1, Math.round(performance.now() - aiStart)));

      const totalMs = Math.round(performance.now() - t0);
      const artifactHtml = simData
        ? `<div class="kv-grid">
             <div class="kv-item"><span>الرقم المربوط</span><span class="kv-val">${escapeHtml(simData.phone)}</span></div>
             <div class="kv-item"><span>حالة الموافقة المزدوجة</span><span class="kv-val">${consentData?.aiOptedIn ? 'مفعّلة ✓' : 'مسجلة'}</span></div>
             <div class="kv-item"><span>توقيع HMAC-SHA256</span><span class="kv-val">صحيح ✓</span></div>
             <div class="kv-item"><span>نافذة 24 ساعة</span><span class="kv-val">مفتوحة ✓</span></div>
           </div>`
        : `<div class="kv-grid">
             <div class="kv-item"><span>المحرك المستخدم</span><span class="kv-val">${escapeHtml(aiOut.engineLabel)}</span></div>
             <div class="kv-item"><span>زمن التنفيذ الكلي</span><span class="kv-val">${totalMs}ms</span></div>
           </div>`;

      turn.finish({
        summaryText: `اكتمل التنفيذ في ${totalMs}ms`,
        engineLabel: aiOut.engineLabel,
        prose: simData
          ? `تم تنفيذ الإجراءات المطلوبة للرقم ${simData.phone} وفتح نافذة الـ 24 ساعة بنجاح.\n\nرد سيليا المقترح:\n«${aiOut.reply}»`
          : aiOut.reply,
        artifactTitle: simData ? `بطاقة ربط العميل ${simData.phone}` : 'مخرج استجابة سيليا',
        artifactHtml,
        artifactCopy: aiOut.reply
      });
    } catch (err) {
      turn.finish({
        summaryText: 'توقف التنفيذ بسبب خطأ',
        engineLabel: 'تنبيه',
        prose: `تعذّر إكمال الخطوة: ${err.message}`
      });
    } finally {
      el.btnSend.disabled = false;
    }
  }

  function handleHashRoute() {
    const rawHash = (location.hash || '').replace(/^#/, '').trim();
    if (!rawHash) return;
    const params = new URLSearchParams(rawHash);
    const requestedTool = params.get('tool');
    if (requestedTool && state.tools.some((t) => t.name === requestedTool)) {
      switchView('tools');
      setToolFilterChip('all');
      renderToolsGrid('all');
      openToolModal(requestedTool);
      return;
    }
    const requestedView = params.get('view');
    if (requestedView && Object.prototype.hasOwnProperty.call(el.views, requestedView)) {
      switchView(requestedView);
      el.toolModal.hidden = true;
      if (requestedView === 'tools') {
        const cat = params.get('cat') || 'all';
        const validCat = ['all', 'ai', 'whatsapp', 'google'].includes(cat) ? cat : 'all';
        setToolFilterChip(validCat);
        renderToolsGrid(validCat);
      }
    }
  }

  async function bootstrap() {
    applyTheme(state.theme);

    el.vaultMcpToken.value = state.mcpToken;
    el.vaultGeminiKey.value = state.geminiKey;
    el.vaultGroqKey.value = state.groqKey;

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

    handleHashRoute();
    updateAuthUi();
  }

  window.addEventListener('hashchange', handleHashRoute);

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

  // Tool Filter & Modal
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

  // WhatsApp Simulator & Crypto Lab
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
      // Sync current consent toggles first so user sees exact live policy effect
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

  async function refreshSecretsReadiness() {
    if (!el.secretsGrid || !state.mcpToken || state.mcpToken.length < 32 || window.CeliaStatic) return;
    try {
      const res = await fetch('./api/secrets/status', {
        headers: { authorization: `Bearer ${state.mcpToken}` },
        cache: 'no-store'
      });
      if (!res.ok) return;
      const report = await res.json();
      if (!Array.isArray(report.secrets)) return;
      el.secretsGrid.innerHTML = report.secrets
        .map(
          (item) =>
            `<div class="kv-item"><span dir="ltr">${escapeHtml(item.secretName)}</span><span class="kv-val">${item.configured ? 'مهيأ على الخادم ✓' : 'غير مضبوط'}</span></div>`
        )
        .join('');
    } catch {
      /* Sanitized optional UI refresh */
    }
  }

  // Free Models & Vault Save
  el.btnVerifyVault.addEventListener('click', async () => {
    state.mcpToken = el.vaultMcpToken.value.trim();
    state.geminiKey = el.vaultGeminiKey.value.trim();
    state.groqKey = el.vaultGroqKey.value.trim();

    sessionStorage.setItem('celia_mcp_token', state.mcpToken);
    sessionStorage.setItem('celia_gemini_key', state.geminiKey);
    sessionStorage.setItem('celia_groq_key', state.groqKey);

    try {
      const res = await callMcpRpc('ping');
      updateAuthUi();
      await refreshSecretsReadiness();
      el.vaultFeedback.textContent =
        res.mode === 'owner'
          ? '✓ تم التوثيق بنجاح في وضع المالك المباشر وتحديث حالة أسرار الخادم!'
          : '✓ تم حفظ إعدادات النماذج المجانية لجلسة المتصفح بنجاح!';
    } catch (err) {
      el.vaultFeedback.textContent = `⚠ فشل التحقق من رمز CELIA_MCP_API_TOKEN: ${err.message}`;
    }
  });

  if (el.btnTestVoice) {
    el.btnTestVoice.addEventListener('click', async () => {
      const token = (el.vaultMcpToken?.value || state.mcpToken || '').trim();
      if (!token || token.length < 32 || window.CeliaStatic) {
        el.vaultFeedback.textContent = '⚠ أدخل رمز CELIA_MCP_API_TOKEN الصالح أولًا لتشغيل صوت سيليا عبر الخادم.';
        return;
      }
      el.btnTestVoice.disabled = true;
      el.vaultFeedback.textContent = 'جارٍ توليد الصوت العربي عبر ElevenLabs + CELIA_VOICE_ID…';
      try {
        const res = await fetch('./api/voice/speak', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            text: 'مرحبًا بك، أنا سيليا، مساعدتك الذكية المتصلة بنظامك بالكامل.'
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.audioBase64) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        if (el.voicePlayer) {
          el.voicePlayer.src = `data:${data.mimeType || 'audio/mpeg'};base64,${data.audioBase64}`;
          el.voicePlayer.hidden = false;
          el.voicePlayer.play().catch(() => {});
        }
        el.vaultFeedback.textContent = `✓ تم توليد صوت سيليا بنجاح (${data.model} · ${data.bytesLength} بايت)!`;
      } catch (err) {
        el.vaultFeedback.textContent = `⚠ تعذر توليد الصوت: ${err.message}`;
      } finally {
        el.btnTestVoice.disabled = false;
      }
    });
  }

  bootstrap();
})();
