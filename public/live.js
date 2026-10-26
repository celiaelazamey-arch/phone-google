(() => {
  'use strict';

  const els = {
    stats: document.getElementById('stats-grid'),
    skillsGrid: document.getElementById('skills-grid'),
    liveJson: document.getElementById('live-json'),
    skillsJson: document.getElementById('skills-json'),
    q: document.getElementById('q'),
    cat: document.getElementById('cat'),
    pillStorage: document.getElementById('pill-storage'),
    pillProvider: document.getElementById('pill-provider'),
    tTools: document.getElementById('t-tools'),
    liveCount: document.getElementById('live-count'),
    liveTime: document.getElementById('live-time'),
    liveUptime: document.getElementById('live-uptime'),
    hostInfo: document.getElementById('host-info'),
    nowTick: document.getElementById('now-tick'),
    btnFind: document.getElementById('btn-find'),
    btnLive: document.getElementById('btn-live'),
    btnRefresh: document.getElementById('btn-refresh'),
    btnCopyLive: document.getElementById('btn-copy-live')
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  els.hostInfo.textContent = `${location.host} — ${location.pathname}`;
  const updateClock = () => {
    els.nowTick.textContent = new Date().toLocaleString('ar-EG');
  };
  updateClock();
  setInterval(updateClock, 1000);

  async function fetchHealth() {
    const r = await fetch('./health');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function rpcFindSkills(query, category) {
    const body = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: 'find_skills', arguments: { query, category, liveCheck: true } }
    };
    const r = await fetch('./ui/workspace/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function rpcLiveView() {
    const body = {
      jsonrpc: '2.0',
      id: Date.now() + 1,
      method: 'tools/call',
      params: { name: 'system_live_view', arguments: { includeTelemetry: true, probeOllama: true } }
    };
    const r = await fetch('./ui/workspace/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  function renderStats(health, live) {
    const p = health.providers || {};
    const totalTools = health.toolsCount || 12;
    els.pillStorage.textContent = `التخزين: ${health.storage === 'memory' ? 'ذاكرة حية (Memory)' : 'MySQL'}`;
    els.pillProvider.textContent = `المحرك: ${p.effectiveDefault || '—'}${p.gemini?.configured ? ' · Gemini جاهز' : ' · محلي مجاني'}`;
    els.tTools.textContent = String(totalTools);
    els.liveCount.textContent = `${totalTools} مهارة`;

    const cards = [
      { t: 'حالة الخادم', v: health.status === 'ok' ? 'نشط ✓' : '—', s: `${health.service || ''} @ ${health.version || ''}` },
      { t: 'التخزين', v: health.storage === 'memory' ? 'Memory (حي)' : 'MySQL', s: p.google?.encryptionReady ? 'تشفير AES-256-GCM جاهز' : 'تشفير مؤقت sandbox' },
      { t: 'Gemini', v: p.gemini?.configured ? 'مُهيأ ✓' : 'غير مُهيأ (محلي)', s: p.gemini?.model || '—' },
      { t: 'Ollama', v: p.ollama?.reachable ? 'متصل ✓' : 'غير متصل (اختياري)', s: `${p.ollama?.model || 'qwen2.5:7b'} @ ${p.ollama?.baseUrl || ''}` },
      { t: 'Google OAuth', v: p.google?.oauthConfigured ? 'مُهيأ ✓' : 'تجريبي', s: p.google?.encryptionReady ? 'مفتاح 32 بايت جاهز' : '—' },
      {
        t: 'WhatsApp',
        v: `${p.whatsapp?.webhookConfigured ? 'Webhook ✓' : 'بدون'} · ${p.whatsapp?.cloudApiConfigured ? 'Cloud API' : 'sandbox'}`,
        s: p.whatsapp?.autoReplyEnabled ? 'رد تلقائي مفعّل' : 'رد تلقائي متوقف (آمن)'
      }
    ];

    els.stats.innerHTML = cards
      .map(
        (c) =>
          `<div class="stat-card"><h4>${escapeHtml(c.t)}</h4><div class="val">${escapeHtml(c.v)}</div><div class="sub">${escapeHtml(c.s)}</div></div>`
      )
      .join('');

    if (live) {
      els.liveTime.textContent = new Date(live.telemetry?.timestamp || live.timestamp || Date.now()).toLocaleString('ar-EG');
      els.liveUptime.textContent = live.telemetry?.uptime || '—';
      els.liveJson.textContent = JSON.stringify(live, null, 2);
    }
  }

  function renderSkills(data) {
    const out = data?.result?.structuredContent || data;
    els.skillsJson.textContent = JSON.stringify(out, null, 2);
    const skills = out.skills || [];
    els.skillsGrid.innerHTML =
      skills
        .map(
          (s) => `
      <div class="skill-card">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
          <strong>${escapeHtml(s.name)}</strong>
          <span class="skill-tag">${escapeHtml((s.tags || []).join(' · ') || 'system')}</span>
        </div>
        <div class="meta">${escapeHtml(s.description)}</div>
        <div style="font-size:.78rem;color:var(--text-muted)">استدعاء: <code style="direction:ltr;display:inline-block">${escapeHtml(s.invocation)}</code></div>
        <details><summary style="cursor:pointer;font-size:.8rem">مخطط الإدخال (inputSchema)</summary><pre style="white-space:pre-wrap;font-size:.75rem;background:var(--bg-code);padding:8px;border-radius:8px;direction:ltr;text-align:left">${escapeHtml(JSON.stringify(s.inputSchema, null, 2))}</pre></details>
      </div>
    `
        )
        .join('') || '<div style="color:var(--text-muted)">لا توجد نتائج — جرّب كلمة أخرى أو اختر "كل الفئات".</div>';
  }

  async function refreshAll() {
    try {
      const [health, liveR, f] = await Promise.all([
        fetchHealth(),
        rpcLiveView(),
        rpcFindSkills(els.q.value.trim(), els.cat.value)
      ]);
      const live = liveR.result?.structuredContent || liveR;
      renderStats(health, live);
      renderSkills(f);
    } catch (e) {
      els.liveJson.textContent = `خطأ: ${e.message}`;
    }
  }

  els.btnFind.addEventListener('click', async () => {
    const q = els.q.value.trim();
    const cat = els.cat.value;
    els.skillsJson.textContent = 'جارٍ البحث...';
    try {
      const f = await rpcFindSkills(q, cat);
      renderSkills(f);
    } catch (e) {
      els.skillsJson.textContent = e.message;
    }
  });

  els.btnLive.addEventListener('click', async () => {
    els.liveJson.textContent = 'جارٍ جلب system_live_view...';
    try {
      const [health, l] = await Promise.all([fetchHealth(), rpcLiveView()]);
      renderStats(health, l.result?.structuredContent || l);
    } catch (e) {
      els.liveJson.textContent = e.message;
    }
  });

  els.btnRefresh.addEventListener('click', refreshAll);

  els.btnCopyLive.addEventListener('click', async () => {
    await navigator.clipboard?.writeText(els.liveJson.textContent).catch(() => {});
    const original = els.btnCopyLive.textContent;
    els.btnCopyLive.textContent = 'تم النسخ ✓';
    setTimeout(() => {
      els.btnCopyLive.textContent = original;
    }, 1400);
  });

  els.q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.btnFind.click();
  });

  els.cat.addEventListener('change', () => els.btnFind.click());

  refreshAll();
  setInterval(async () => {
    try {
      const h = await fetchHealth();
      els.liveTime.textContent = new Date().toLocaleTimeString('ar-EG');
      els.liveCount.textContent = `${h.toolsCount || 12} مهارة`;
    } catch {
      // ignore transient poll failure
    }
  }, 4000);
})();
