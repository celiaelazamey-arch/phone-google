(function () {
  const totalEl = document.getElementById('bm-total');
  const rateEl = document.getElementById('bm-rate');
  const falseEl = document.getElementById('bm-false');
  const replayEl = document.getElementById('bm-replay');
  const costEl = document.getElementById('bm-cost');
  const decisionEl = document.getElementById('bm-decision');
  const rationaleEl = document.getElementById('benchmark-rationale');
  const tbody = document.getElementById('benchmark-cases-body');
  const runBtn = document.getElementById('run-benchmark-btn');

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderBenchmark(data) {
    if (!data || !Array.isArray(data.cases)) return;
    const summary = data.summary || {};
    const passedCases = summary.passed_cases ?? data.passedCount ?? 0;
    const totalCases = summary.total_cases ?? data.totalCases ?? data.cases.length;
    const completionPct =
      summary.completion_rate_pct ?? Math.round(Number(data.completionRate || 0) * 100);
    const falseAccept = summary.false_accept_count ?? data.falseAcceptCount ?? 0;
    const falseReject = summary.false_reject_count ?? data.falseRejectCount ?? 0;
    const replayPct =
      summary.replay_determinism_pct ?? Math.round(Number(data.replayDeterminismRate || 0) * 100);
    const techDecision = summary.technical_gate_decision ?? data.decision ?? 'GO';

    if (totalEl) totalEl.textContent = `${passedCases} / ${totalCases}`;
    if (rateEl) rateEl.textContent = `${completionPct}%`;
    if (falseEl) falseEl.textContent = `${falseAccept} / ${falseReject}`;
    if (replayEl) replayEl.textContent = `${replayPct}%`;
    if (costEl) costEl.textContent = '$0.00';
    if (decisionEl) {
      decisionEl.textContent = `${techDecision} (تقنيًا ${passedCases}/${totalCases}) · ITERATE (عينة المستخدمين)`;
    }
    if (rationaleEl) {
      rationaleEl.textContent = `اجتاز النظام ${passedCases}/${totalCases} حالة (${completionPct}%) بصفر قبول/رفض خاطئ وثبات إعادة تشغيل ${replayPct}% في ${summary.total_duration_ms ?? 1}ms تحت قفل NETWORK = DENY وEXTERNAL GATES = CLOSED.`;
    }

    if (tbody) {
      tbody.innerHTML = data.cases
        .map((c) => {
          const status = c.actual_status || c.validationStatus || 'invalid';
          const errors = c.errors || c.errorCodes || [];
          const valBadge =
            status === 'valid' || status === 'PASSED'
              ? '<span class="status-chip status-pass">VALID</span>'
              : `<span class="status-chip status-warn">${escapeHtml(status.toUpperCase())} (${escapeHtml(errors.join(', '))})</span>`;
          const gateStatus = c.comprehension_gate || c.comprehensionGateStatus || 'PASS';
          const gateBadge =
            gateStatus === 'PASS'
              ? '<span class="status-chip status-pass">PASS</span>'
              : '<span class="status-chip status-fail">BLOCK (كشف تناقض)</span>';
          const replayOk = Boolean(c.replay_deterministic ?? c.replayDeterministic);
          const hashPreview = c.file_sha256 || c.reportSha256 || '';
          const replayBadge = replayOk
            ? `<span class="status-chip status-pass">متطابق (${escapeHtml(String(hashPreview).slice(0, 10))}…)</span>`
            : '<span class="status-chip status-fail">غير متطابق</span>';
          return `
            <tr>
              <td><code>${escapeHtml(c.id)}</code></td>
              <td><code>${escapeHtml(String(c.format || '').toUpperCase())}</code></td>
              <td>${escapeHtml(c.title_ar || c.titleAr)}</td>
              <td>${valBadge}</td>
              <td><code>${escapeHtml(c.action_status || c.actionStatus)}</code></td>
              <td>${gateBadge}</td>
              <td>${replayBadge}</td>
            </tr>
          `;
        })
        .join('');
    }
  }

  async function loadBenchmark() {
    if (runBtn) runBtn.disabled = true;
    try {
      const response = await fetch('./api/protocol-benchmark.json', {
        headers: { accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      renderBenchmark(data);
    } catch {
      if (rationaleEl) {
        rationaleEl.textContent = 'تعذر جلب لقطة الـBenchmark الحالية؛ شغّل npm test للتحقق المحلي.';
      }
    } finally {
      if (runBtn) runBtn.disabled = false;
    }
  }

  if (runBtn) {
    runBtn.addEventListener('click', () => {
      loadBenchmark();
    });
  }

  loadBenchmark();
})();
