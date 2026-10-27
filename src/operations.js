import crypto from "node:crypto";
import { releaseInfo, RELEASE_HISTORY, SERVER_INFO } from "./version.js";
import { isolatePool } from "./resilience.js";

export function createOperations({
  pool,
  config,
  services,
  toolsCount = 0,
  cacheMs = 1000,
}) {
  const guardedPool = isolatePool(pool, services);
  const release = releaseInfo();
  let draining = false;
  let cached = null;
  let expiresAt = 0;
  let pending;
  const configured = {
    gemini: Boolean(config.gemini?.apiKey),
    ollama: true,
    google: Boolean(
      config.google?.clientId &&
      config.google?.clientSecret &&
      config.encryptionKey,
    ),
    whatsapp: Boolean(
      config.whatsapp?.accessToken && config.whatsapp?.phoneNumberId,
    ),
  };

  function liveness() {
    return {
      status: "ok",
      service: SERVER_INFO.name,
      version: release.version,
      release,
      toolsCount,
      storage: pool.isMemory ? "memory" : "mysql",
      draining,
      providers: {
        configuredMode: config.celia?.aiProvider || "auto",
        effectiveDefault:
          config.gemini?.apiKey && config.features?.gemini !== false
            ? "gemini"
            : "local",
        gemini: { configured: configured.gemini, model: config.gemini?.model },
        ollama: {
          model: config.ollama?.model,
          reachable: null,
          modelAvailable: null,
        },
        google: {
          oauthConfigured: Boolean(
            config.google?.clientId && config.google?.clientSecret,
          ),
          encryptionReady: Boolean(config.encryptionKey),
        },
        whatsapp: {
          cloudApiConfigured: configured.whatsapp,
          webhookConfigured: Boolean(
            config.whatsapp?.verifyToken && config.whatsapp?.appSecret,
          ),
          autoReplyEnabled: Boolean(config.whatsapp?.autoReplyEnabled),
        },
      },
    };
  }

  async function probe() {
    let storageAvailable = true;
    try {
      await guardedPool.query("SELECT 1");
    } catch {
      storageAvailable = false;
    }
    const circuits = services.snapshot();
    const storage = {
      mode: pool.isMemory ? "memory" : "mysql",
      durable: !pool.isMemory,
      available: storageAvailable,
      explicitDemo: Boolean(pool.isMemory),
    };
    const components = [
      {
        id: "core",
        state: draining ? "draining" : "healthy",
        critical: true,
        detail: "HTTP / MCP / UI",
      },
      {
        id: "storage",
        state: storageAvailable
          ? pool.isMemory
            ? "demo"
            : "healthy"
          : "unavailable",
        critical: true,
        detail: pool.isMemory
          ? "ذاكرة مؤقتة صريحة؛ ليست نسخة احتياطية"
          : "MySQL — لا استبدال تلقائي بالذاكرة",
      },
      {
        id: "local-policy",
        state: "healthy",
        critical: false,
        detail: "بديل قواعد محلي بلا اتصال خارجي",
      },
      ...["gemini", "ollama", "google", "whatsapp"].map((id) => {
        const related = circuits.filter(
          (c) => c.name === id || c.name.startsWith(`${id}.`),
        );
        const blocked =
          (id === "google" || id === "whatsapp") && !storageAvailable;
        const state =
          config.features?.[id] === false
            ? "disabled"
            : !configured[id]
              ? "unconfigured"
              : blocked
                ? "blocked"
                : related.some((c) => c.state === "open")
                  ? "isolated"
                  : related.some((c) => c.state === "half-open")
                    ? "recovering"
                    : related.some((c) => c.lastSuccessAt)
                      ? "healthy"
                      : "standby";
        return {
          id,
          state,
          critical: false,
          detail:
            id === "ollama"
              ? "اختياري — التهيئة لا تعني اتصالًا مؤكدًا"
              : "فشل هذه الوحدة لا يوقف النواة",
        };
      }),
    ];
    return {
      status: components.some((c) =>
        [
          "unavailable",
          "isolated",
          "blocked",
          "draining",
          "recovering",
        ].includes(c.state),
      )
        ? "degraded"
        : "ok",
      ready: !draining && storageAvailable,
      release,
      storage,
      components,
      circuits,
      generatedAt: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      scope: "server",
      notice:
        "القواطع والقياسات داخل هذه العملية وتُصفّر عند إعادة تشغيلها. standby ليس اختبار اتصال.",
    };
  }

  return {
    liveness,
    markDraining() {
      draining = true;
      cached = null;
      expiresAt = 0;
    },
    get draining() {
      return draining;
    },
    async snapshot({ fresh = false } = {}) {
      if (!fresh && cached && Date.now() < expiresAt) return cached;
      if (!pending) {
        pending = probe()
          .then((value) => {
            cached = value;
            expiresAt = Date.now() + cacheMs;
            return value;
          })
          .finally(() => {
            pending = null;
          });
      }
      return pending;
    },
    diagnostics: () => services.diagnostics(),
  };
}

export function mountOperations(app, { operations, authorize }) {
  app.use((req, res, next) => {
    res.set("X-Request-ID", crypto.randomUUID());
    res.set("X-Celia-Version", operations.liveness().version);
    next();
  });
  const noCache = (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  };
  app.get("/health", noCache, (_req, res) => res.json(operations.liveness()));
  app.get("/healthz", noCache, (_req, res) => res.json(operations.liveness()));
  app.get("/version", noCache, (_req, res) =>
    res.json(operations.liveness().release),
  );
  app.get("/readyz", noCache, async (_req, res) => {
    const snapshot = await operations.snapshot();
    res
      .status(snapshot.ready ? 200 : 503)
      .json({
        ready: snapshot.ready,
        status: snapshot.status,
        release: snapshot.release,
        storage: snapshot.storage,
      });
  });
  app.get("/api/system", noCache, async (_req, res) =>
    res.json(await operations.snapshot()),
  );
  app.get("/api/releases", noCache, (_req, res) =>
    res.json({
      current: operations.liveness().release,
      releases: RELEASE_HISTORY,
      publication: "catalog-only",
      notice:
        "هذا سجل المصدر، وليس تأكيدًا على نشر كل إصدار. التبديل يتم من أدوات النشر بصلاحية المشغّل، وليس من المتصفح.",
    }),
  );
  app.get("/api/system/diagnostics", authorize, noCache, (_req, res) =>
    res.json(operations.diagnostics()),
  );
}
