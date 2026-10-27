/* Independent panels: a failed status request must not erase the release catalogue. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const state = { snapshot: null, catalogue: null, refreshing: false };
  const labels = {
    healthy: "سليم",
    standby: "بانتظار الاستخدام",
    unconfigured: "غير مُهيّأ",
    disabled: "متوقف بالإعدادات",
    isolated: "معزول بالقاطع",
    recovering: "جارٍ اختبار التعافي",
    unavailable: "غير متاح",
    blocked: "متأثر بالتخزين",
    demo: "تجريبي",
    draining: "جارٍ الإغلاق الآمن",
  };
  const names = {
    core: "النواة",
    storage: "التخزين",
    "local-policy": "الحارس المحلي",
    gemini: "Gemini",
    ollama: "Ollama",
    google: "Google",
    whatsapp: "WhatsApp",
  };
  const escape = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  const allowedState = (value) =>
    Object.hasOwn(labels, value) ? value : "unconfigured";
  function notice(text) {
    $("notice").textContent = text;
    $("notice").hidden = !text;
  }
  async function get(url) {
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
  function renderStatus(data) {
    state.snapshot = data;
    const demo = data.scope === "browser-demo";
    $("connection").dataset.state = data.status === "ok" ? "ok" : "error";
    $("connection").innerHTML =
      `<i></i>${demo ? "معاينة متصفح" : data.status === "ok" ? "النواة متصلة" : "تشغيل جزئي — عطل معزول"}`;
    $("metric-version").textContent = `v${data.release.version}`;
    $("core-version").textContent = `CORE v${data.release.version}`;
    $("metric-channel").textContent = demo
      ? "GitHub Pages · ليست خدمة إنتاجية"
      : `${data.release.name} · ${data.release.channel}`;
    $("metric-components").innerHTML =
      `${data.components.filter((c) => c.state === "healthy").length} <small>/ ${data.components.length}</small>`;
    $("metric-circuits").textContent = demo
      ? "—"
      : String(
          data.circuits.filter(
            (c) => c.state === "open" || c.state === "half-open",
          ).length,
        );
    $("metric-circuit-note").textContent = demo
      ? "قواطع الخادم غير متاحة في Pages"
      : `${data.circuits.length} حدّ خدمة · قياسات داخل العملية`;
    $("metric-storage").textContent = data.storage.durable
      ? "MySQL"
      : "ذاكرة مؤقتة";
    $("metric-storage-note").textContent = !data.storage.available
      ? "غير متاح — لا كتابة بديلة"
      : data.storage.durable
        ? "تخزين دائم · نسخ احتياطي مستقل مطلوب"
        : "تجريبي؛ تُفقد البيانات عند الإغلاق";
    $("schema").textContent =
      `SCHEMA ${data.release.database.schema} / DECLARED`;
    $("updated").textContent = new Date(data.generatedAt).toLocaleTimeString(
      "ar-EG",
      { hour: "2-digit", minute: "2-digit", second: "2-digit" },
    );
    $("component-grid").innerHTML = data.components
      .map(
        (c) =>
          `<article class="component-card"><div class="component-head"><h3>${escape(names[c.id] || c.id)}</h3><span class="status ${allowedState(c.state)}">${escape(labels[c.state] || c.state)}</span></div><p>${escape(c.detail)}</p></article>`,
      )
      .join("");
    document.querySelectorAll("[data-node]").forEach((node) => {
      const component = data.components.find((c) => c.id === node.dataset.node);
      if (component) {
        node.dataset.state = allowedState(component.state);
        node.querySelector("small").textContent =
          labels[component.state] || component.state;
      }
    });
    if (demo) notice(data.notice);
    else if (!data.storage.durable)
      notice(
        "أنت في وضع الذاكرة التجريبي. بياناته مؤقتة وليست نسخة احتياطية من MySQL.",
      );
    else if (data.status !== "ok")
      notice(
        "يوجد مكوّن متعطل أو معزول. الخدمات المستقلة متاحة؛ راجع حالة كل مكوّن قبل تنفيذ كتابة جديدة.",
      );
    else notice("");
  }
  function renderReleases(data) {
    state.catalogue = data;
    $("catalog-notice").textContent = data.notice;
    $("release-list").innerHTML = data.releases
      .map((release) => {
        const current = release.version === data.current.version;
        return `<article class="release-card ${current ? "current" : ""}"><div class="release-head"><strong class="mono">v${escape(release.version)}</strong><span class="release-badge ${current ? "" : "baseline"}">${current ? "نسخة التشغيل" : "خط أساس المصدر"}</span><time class="release-date">${escape(release.date)}</time></div><div class="release-name" dir="ltr">${escape(release.name)}</div><ul>${release.highlights.map((line) => `<li>${escape(line)}</li>`).join("")}</ul><div class="release-meta"><span aria-hidden="true">${release.managedDeployment ? "◇" : "ⓘ"}</span>${release.managedDeployment ? "يقبل النشر المُدار · يُفحص التوافق قبل التبديل" : "نسخة سابقة غير مُدارة؛ الاستعادة من المصدر فقط"}</div></article>`;
      })
      .join("");
  }
  async function refresh() {
    if (state.refreshing) return;
    state.refreshing = true;
    $("refresh").disabled = true;
    const results = await Promise.allSettled([
      get("./api/system"),
      get("./api/releases"),
    ]);
    if (results[0].status === "fulfilled") renderStatus(results[0].value);
    else {
      $("connection").dataset.state = "error";
      $("connection").innerHTML = "<i></i>تعذر التحديث";
      notice(
        "تعذر جلب حالة الخادم. القيم المعروضة — إن وُجدت — من آخر فحص ناجح، وليست تأكيدًا على استمرار الاتصال.",
      );
      if (!state.snapshot)
        $("component-grid").textContent =
          "حالة المكوّنات غير معروفة حاليًا. أعد المحاولة دون إعادة إرسال عمليات سابقة.";
    }
    if (results[1].status === "fulfilled") renderReleases(results[1].value);
    else if (!state.catalogue)
      $("release-list").textContent =
        "تعذر تحميل سجل الإصدارات. حالة المكوّنات مستقلة عن هذا الطلب.";
    $("refresh").disabled = false;
    state.refreshing = false;
  }
  $("refresh").addEventListener("click", refresh);
  $("download").addEventListener("click", () => {
    if (!state.snapshot) {
      notice("انتظر أول فحص ناجح لتنزيل تقرير حالة حقيقي.");
      return;
    }
    const blob = new Blob(
      [
        JSON.stringify(
          { ...state.snapshot, catalogue: state.catalogue },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `celia-system-${state.snapshot.release.version}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  refresh();
  setInterval(() => {
    if (!document.hidden) refresh();
  }, 15000);
})();
