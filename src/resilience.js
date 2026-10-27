/** In-process bulkheads. No retries: mutations must never be replayed implicitly. */
export class ServiceUnavailableError extends Error {
  constructor(service, reason, { sideEffect = false } = {}) {
    super(
      `${service}:${reason}${sideEffect && reason === "timeout" ? ":outcome_unknown_do_not_retry_blindly" : ""}`,
    );
    this.name = "ServiceUnavailableError";
    this.code = "SERVICE_UNAVAILABLE";
    this.status = 503;
    this.service = service;
    this.reason = reason;
    this.outcomeUnknown = sideEffect && reason === "timeout";
  }
}

export class UpstreamError extends Error {
  constructor(service, status) {
    super(`${service} API rejected the request (${status})`);
    this.name = "UpstreamError";
    this.code = "UPSTREAM_ERROR";
    this.status = 502;
    this.upstreamStatus = status;
  }
}

const VALIDATION_ERRORS = new Set([
  "q is required",
  "customerMessage is required",
  "provider must be auto, gemini, ai_gateway, deepseek, agentrouter, ollama, or local",
  "summary, start, and end are required",
  "invalid_event_time_range",
  "google_not_configured",
  "google_not_connected",
  "encryption_key_missing",
  "whatsapp_not_configured",
  "valid_phone_optedIn_and_consent_source_required",
  "valid_phone_and_text_required",
  "recipient_has_not_opted_in",
  "outside_customer_service_window_use_approved_template",
  "elevenlabs_not_configured",
  "voice_id_not_configured",
  "voice_text_required",
  "figma_not_configured",
  "invalid_figma_file_key",
  "codata_not_configured",
  "codata_base_url_not_configured",
]);

function countsAsFailure(error) {
  if (VALIDATION_ERRORS.has(error.message)) return false;
  if (error instanceof ServiceUnavailableError && error.reason !== "timeout")
    return false;
  const status = error.upstreamStatus || error.response?.status || error.status;
  // Missing consent, invalid inputs, OAuth setup and permission errors aren't outages.
  return !status || status === 408 || status === 429 || status >= 500;
}

export class ServiceRegistry {
  #services = new Map();
  #events = [];
  constructor({
    timeoutMs = 8000,
    failureThreshold = 3,
    cooldownMs = 30000,
    maxConcurrent = 6,
    now = Date.now,
  } = {}) {
    for (const [key, value] of Object.entries({
      timeoutMs,
      failureThreshold,
      cooldownMs,
      maxConcurrent,
    })) {
      if (!Number.isInteger(value) || value < 1)
        throw new Error(`Invalid resilience option: ${key}`);
    }
    this.defaults = { timeoutMs, failureThreshold, cooldownMs, maxConcurrent };
    this.now = now;
  }

  register(name, options = {}) {
    if (this.#services.has(name)) return this;
    this.#services.set(name, {
      name,
      ...this.defaults,
      ...options,
      state: "closed",
      openedAt: null,
      probe: false,
      epoch: 0,
      failures: 0,
      inFlight: 0,
      calls: 0,
      successes: 0,
      errors: 0,
      timeouts: 0,
      rejected: 0,
      lastSuccessAt: null,
    });
    return this;
  }

  #event(service, event) {
    this.#events.unshift({
      service,
      event,
      at: new Date(this.now()).toISOString(),
    });
    this.#events.length = Math.min(this.#events.length, 60);
  }

  async run(name, task, { sideEffect = false, timeoutMs } = {}) {
    const s = this.#services.get(name);
    if (!s) throw new Error("Unknown service boundary");
    const budget = timeoutMs ?? s.timeoutMs;
    if (!Number.isInteger(budget) || budget < 1)
      throw new Error("Invalid service timeout");
    const reject = (reason) => {
      s.rejected++;
      throw new ServiceUnavailableError(name, reason);
    };
    if (s.disabled) return reject("disabled");
    if (s.state === "open" && this.now() - s.openedAt < s.cooldownMs)
      return reject("circuit_open");
    if (s.state === "half-open" || s.probe) return reject("probe_in_progress");
    if (s.inFlight >= s.maxConcurrent) return reject("capacity_exceeded");
    if (s.state === "open") {
      s.state = "half-open";
      s.epoch++;
      s.probe = true;
      this.#event(name, "half-open");
    }
    const epoch = s.epoch;
    s.inFlight++;
    s.calls++;
    const controller = new AbortController();
    let timer;
    // Keep the slot occupied until the actual operation settles, even if it ignores abort.
    const work = Promise.resolve().then(() => task(controller.signal));
    work.then(
      () => {
        s.inFlight--;
      },
      () => {
        s.inFlight--;
      },
    );
    const deadline = new Promise((_, rejectDeadline) => {
      timer = setTimeout(() => {
        const error = new ServiceUnavailableError(name, "timeout", {
          sideEffect,
        });
        rejectDeadline(error);
        controller.abort(error);
      }, budget);
    });
    try {
      const result = await Promise.race([work, deadline]);
      s.successes++;
      s.lastSuccessAt = new Date(this.now()).toISOString();
      // A late result from a different concurrent call cannot close an open breaker.
      if (epoch === s.epoch && s.state === "half-open")
        this.#event(name, "recovered");
      if (epoch === s.epoch && s.state !== "open") {
        s.state = "closed";
        s.failures = 0;
        s.openedAt = null;
      }
      return result;
    } catch (error) {
      s.errors++;
      if (error.reason === "timeout") s.timeouts++;
      if (epoch === s.epoch && countsAsFailure(error)) {
        s.failures++;
        if (s.failures >= s.failureThreshold || s.state === "half-open") {
          if (s.state !== "open") this.#event(name, "opened");
          s.state = "open";
          s.epoch++;
          s.openedAt = this.now();
        }
      } else if (epoch === s.epoch && s.state === "half-open") {
        s.state = "closed";
        s.failures = 0;
        s.openedAt = null;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (epoch === s.epoch || s.state === "open") s.probe = false;
    }
  }

  snapshot() {
    return [...this.#services.values()].map((s) => ({
      name: s.name,
      state: s.disabled ? "disabled" : s.state,
      inFlight: s.inFlight,
      limit: s.maxConcurrent,
      calls: s.calls,
      successes: s.successes,
      errors: s.errors,
      timeouts: s.timeouts,
      rejected: s.rejected,
      consecutiveFailures: s.failures,
      lastSuccessAt: s.lastSuccessAt,
      retryAfterMs:
        s.state === "open"
          ? Math.max(0, s.cooldownMs - (this.now() - s.openedAt))
          : 0,
    }));
  }

  diagnostics() {
    return { services: this.snapshot(), events: [...this.#events] };
  }
}

export function loadResilienceConfig(env = process.env) {
  const integer = (key, fallback, min, max) => {
    const value =
      env[key] === undefined || env[key] === "" ? fallback : Number(env[key]);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`${key} must be an integer between ${min} and ${max}`);
    return value;
  };
  return Object.freeze({
    timeoutMs: integer("CELIA_SERVICE_TIMEOUT_MS", 8000, 50, 60000),
    failureThreshold: integer("CELIA_CIRCUIT_FAILURE_THRESHOLD", 3, 1, 20),
    cooldownMs: integer("CELIA_CIRCUIT_COOLDOWN_MS", 30000, 100, 300000),
    maxConcurrent: integer("CELIA_SERVICE_CONCURRENCY", 6, 1, 32),
  });
}

export function loadFeatures(env = process.env) {
  return Object.freeze(
    Object.fromEntries(
      [
        "google",
        "whatsapp",
        "gemini",
        "ollama",
        "ai_gateway",
        "deepseek",
        "agentrouter",
        "elevenlabs",
        "figma",
        "codata",
      ].map((name) => [
        name,
        env[`CELIA_DISABLE_${name.toUpperCase()}`] !== "true",
      ]),
    ),
  );
}

export function createServiceRegistry(config = {}) {
  const registry = new ServiceRegistry(config.resilience);
  registry.register("storage", {
    timeoutMs: Math.min(config.resilience?.timeoutMs || 3000, 3000),
    maxConcurrent: 5,
  });
  for (const name of [
    "gemini",
    "ai_gateway",
    "deepseek",
    "agentrouter",
    "ollama",
    "elevenlabs",
    "figma",
    "codata",
    "whatsapp",
    "google.oauth",
    "google.gmail",
    "google.drive",
    "google.calendar",
    "google.contacts",
  ]) {
    registry.register(name, {
      disabled: config.features?.[name.split(".")[0]] === false,
    });
  }
  return registry;
}

export function isolatePool(pool, services) {
  return new Proxy(pool, {
    get(target, property) {
      if (property === "execute" || property === "query") {
        return (...args) =>
          services.run("storage", () => target[property](...args), {
            sideEffect: !/^\s*SELECT\b/i.test(
              typeof args[0] === "string" ? args[0] : args[0]?.sql || "",
            ),
          });
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function safeError(error) {
  if (error instanceof ServiceUnavailableError) return error.message;
  if (error instanceof UpstreamError) return error.message;
  if (VALIDATION_ERRORS.has(error?.message)) return error.message;
  return "integration_request_failed";
}
