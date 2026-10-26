(() => {
  'use strict';

  let currentCat = 'all';
  const elQ = document.getElementById('q');
  const elGrid = document.getElementById('grid');
  const elRaw = document.getElementById('raw');
  const elCount = document.getElementById('count');
  const elStorage = document.getElementById('s-storage');
  const elProvider = document.getElementById('s-provider');
  const elTools = document.getElementById('s-tools');
  const btnFind = document.getElementById('btn-find');
  const btnAll = document.getElementById('btn-all');
  const catChips = document.querySelectorAll('.chip[data-cat]');
  const quickChips = document.querySelectorAll('.chip[data-quick]');

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  async function callFind(query, category) {
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

  function render(j) {
    const out = j.result?.structuredContent || j;
    elRaw.textContent = JSON.stringify(out, null, 2);
    elCount.textContent = `${out.matched ?? 0} / ${out.totalSkills ?? 0}`;
    elStorage.textContent = `التخزين: ${out.liveStatus?.storage || '—'}`;
    elProvider.textContent = `المحرك: ${out.liveStatus?.providers?.effectiveDefault || '—'}`;
    elTools.textContent = `الأدوات: ${out.liveStatus?.toolsCount || out.totalSkills || '—'}`;

    elGrid.innerHTML =
      (out.skills || [])
        .map(
          (s) => `
      <div class="skill-card">
        <h4>${escapeHtml(s.name)}</h4>
        <div class="meta">${escapeHtml(s.description)}</div>
        <div style="margin:6px 0"><span class="chip" style="font-size:.7rem">${escapeHtml((s.tags || []).join(' · ') || 'عام')}</span></div>
        <div class="code">${escapeHtml(s.invocation)}</div>
        <details style="margin-top:6px"><summary style="cursor:pointer;font-size:.82rem">inputSchema</summary><pre class="code" style="margin-top:6px">${escapeHtml(JSON.stringify(s.inputSchema, null, 2))}</pre></details>
        <div style="margin-top:8px;display:flex;gap:6px">
          <button type="button" class="chip" data-copy-skill="${escapeHtml(s.name)}">نسخ اسم المهارة</button>
          <button type="button" class="chip" data-try-skill="${escapeHtml(s.name)}">تجربة عبر الاستوديو →</button>
        </div>
      </div>
    `
        )
        .join('') || '<div class="meta">لا نتائج — جرّب كلمة أخرى.</div>';

    elGrid.querySelectorAll('[data-copy-skill]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const skillName = btn.dataset.copySkill;
        await navigator.clipboard?.writeText(skillName).catch(() => {});
        const prev = btn.textContent;
        btn.textContent = 'تم النسخ ✓';
        setTimeout(() => {
          btn.textContent = prev;
        }, 1200);
      });
    });

    elGrid.querySelectorAll('[data-try-skill]').forEach((btn) => {
      btn.addEventListener('click', () => {
        location.href = `./#tool=${encodeURIComponent(btn.dataset.trySkill)}`;
      });
    });
  }

  async function doFind() {
    elRaw.textContent = 'جارٍ البحث حيًا...';
    try {
      const j = await callFind(elQ.value.trim(), currentCat);
      render(j);
    } catch (e) {
      elRaw.textContent = e.message;
    }
  }

  btnFind.addEventListener('click', doFind);

  btnAll.addEventListener('click', () => {
    elQ.value = '';
    currentCat = 'all';
    catChips.forEach((c) => c.classList.toggle('active', c.dataset.cat === 'all'));
    doFind();
  });

  catChips.forEach((c) => {
    c.addEventListener('click', () => {
      currentCat = c.dataset.cat;
      catChips.forEach((x) => x.classList.remove('active'));
      c.classList.add('active');
      doFind();
    });
  });

  quickChips.forEach((c) => {
    c.addEventListener('click', () => {
      elQ.value = c.dataset.quick;
      doFind();
    });
  });

  elQ.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doFind();
  });

  doFind();
})();
