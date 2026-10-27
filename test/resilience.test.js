import test from "node:test";
import assert from "node:assert/strict";
import {
  ServiceRegistry,
  ServiceUnavailableError,
  UpstreamError,
  createServiceRegistry,
  loadResilienceConfig,
  safeError,
} from "../src/resilience.js";
import { generateCeliaReply } from "../src/ollama.js";

const defer = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const fail = () => {
  throw new Error("provider down with private credentials");
};

function registry(options = {}) {
  return new ServiceRegistry({
    timeoutMs: 100,
    failureThreshold: 2,
    cooldownMs: 20,
    ...options,
  })
    .register("cloud")
    .register("local");
}

test("circuit opens only after threshold, rejects quickly and recovers after one half-open probe", async () => {
  let now = 100;
  const r = registry({ now: () => now });
  await assert.rejects(r.run("cloud", fail));
  assert.equal(r.snapshot()[0].state, "closed");
  await assert.rejects(r.run("cloud", fail));
  assert.equal(r.snapshot()[0].state, "open");
  await assert.rejects(
    r.run("cloud", () => assert.fail("must not call open service")),
    { reason: "circuit_open" },
  );
  assert.equal(
    await r.run("local", () => "still available"),
    "still available",
  );
  now += 21;
  assert.equal(await r.run("cloud", () => "recovered"), "recovered");
  assert.equal(r.snapshot()[0].state, "closed");
  assert.ok(r.diagnostics().events.some((e) => e.event === "recovered"));
});

test("a half-open breaker allows exactly one probe, independently of other services", async () => {
  let now = 0;
  const r = registry({ now: () => now, failureThreshold: 1 });
  await assert.rejects(r.run("cloud", fail));
  now = 21;
  const pending = defer();
  const probe = r.run("cloud", () => pending.promise);
  await assert.rejects(
    r.run("cloud", () => "not allowed"),
    { reason: "probe_in_progress" },
  );
  assert.equal(await r.run("local", () => true), true);
  pending.resolve("ok");
  await probe;
  assert.equal(r.snapshot()[0].state, "closed");
});

test("timeouts abort and retain capacity until uncooperative work settles; mutations are not retried", async () => {
  const r = registry({ timeoutMs: 10, maxConcurrent: 1, failureThreshold: 9 });
  const pending = defer();
  let calls = 0;
  let signal;
  await assert.rejects(
    r.run(
      "cloud",
      (value) => {
        calls++;
        signal = value;
        return pending.promise;
      },
      { sideEffect: true },
    ),
    (error) => {
      assert.equal(error.outcomeUnknown, true);
      assert.equal(error.reason, "timeout");
      return true;
    },
  );
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
  assert.equal(r.snapshot()[0].inFlight, 1);
  await assert.rejects(
    r.run("cloud", () => "never"),
    { reason: "capacity_exceeded" },
  );
  pending.resolve("late result");
  await pending.promise;
  await Promise.resolve();
  assert.equal(r.snapshot()[0].inFlight, 0);
  assert.equal(await r.run("cloud", () => "new read"), "new read");
});

test("late successes cannot close a breaker or interfere with a newer half-open probe", async () => {
  let now = 0;
  const r = registry({ now: () => now, failureThreshold: 1, timeoutMs: 1000 });
  const old = defer();
  const probe = defer();
  const oldCall = r.run("cloud", () => old.promise);
  await assert.rejects(r.run("cloud", fail));
  now = 21;
  const newCall = r.run("cloud", () => probe.promise);
  old.resolve("old");
  await oldCall;
  assert.equal(r.snapshot()[0].state, "half-open");
  await assert.rejects(
    r.run("cloud", () => "never"),
    { reason: "probe_in_progress" },
  );
  probe.resolve("new");
  await newCall;
  assert.equal(r.snapshot()[0].state, "closed");
});

test("bulkhead limits concurrent work without unbounded queues", async () => {
  const r = registry({ maxConcurrent: 2 });
  const pending = defer();
  const first = r.run("cloud", () => pending.promise);
  const second = r.run("cloud", () => pending.promise);
  await assert.rejects(
    r.run("cloud", () => "never"),
    { reason: "capacity_exceeded" },
  );
  pending.resolve();
  await Promise.all([first, second]);
  assert.equal(r.snapshot()[0].inFlight, 0);
});

test("validation, missing consent and client permission errors do not trip breakers", async () => {
  const r = registry({ failureThreshold: 1 });
  for (const error of [
    new Error("recipient_has_not_opted_in"),
    new Error("q is required"),
    new UpstreamError("cloud", 403),
    new ServiceUnavailableError("storage", "circuit_open"),
  ]) {
    await assert.rejects(
      r.run("cloud", () => {
        throw error;
      }),
    );
    assert.equal(r.snapshot()[0].state, "closed");
  }
  await assert.rejects(
    r.run("cloud", () => {
      throw new UpstreamError("cloud", 429);
    }),
  );
  assert.equal(r.snapshot()[0].state, "open");
});

test("disabled services cannot run and diagnostics are bounded and contain no error messages", async () => {
  const r = new ServiceRegistry({
    failureThreshold: 1,
    cooldownMs: 1,
    now: () => Date.now(),
  });
  r.register("disabled", { disabled: true });
  await assert.rejects(
    r.run("disabled", () => assert.fail("must not execute")),
    { reason: "disabled" },
  );
  r.register("cloud");
  for (let i = 0; i < 80; i++) await assert.rejects(r.run("cloud", fail));
  assert.ok(r.diagnostics().events.length <= 60);
  assert.doesNotMatch(JSON.stringify(r.diagnostics()), /private credentials/);
  assert.equal(
    safeError(new Error("https://example.invalid/?access_token=private-value")),
    "integration_request_failed",
  );
  assert.equal(
    safeError(new Error("arbitrary upstream content")),
    "integration_request_failed",
  );
});

test("resilience settings are bounded and reject invalid input", () => {
  assert.equal(loadResilienceConfig({}).timeoutMs, 8000);
  for (const env of [
    { CELIA_SERVICE_TIMEOUT_MS: "Infinity" },
    { CELIA_SERVICE_CONCURRENCY: "0" },
    { CELIA_CIRCUIT_FAILURE_THRESHOLD: "1.5" },
  ])
    assert.throws(() => loadResilienceConfig(env));
  assert.throws(() => new ServiceRegistry({ maxConcurrent: -1 }));
});

test("auto AI fails over to a conservative local reply; explicit cloud mode remains strict", async () => {
  const oldFetch = globalThis.fetch;
  let cloudCalls = 0;
  const config = {
    gemini: { apiKey: "never-expose-this-key", model: "test" },
    features: { ollama: false },
    resilience: {
      failureThreshold: 1,
      timeoutMs: 100,
      cooldownMs: 1000,
      maxConcurrent: 1,
    },
  };
  const services = createServiceRegistry(config);
  globalThis.fetch = async () => {
    cloudCalls++;
    return {
      ok: false,
      status: 503,
      json: async () => ({ error: "never-expose-this-key" }),
    };
  };
  try {
    const result = await generateCeliaReply({
      config,
      services,
      customerMessage: "كم سعر المنتج؟",
      provider: "auto",
    });
    assert.equal(result.provider, "celia-local-policy-engine");
    assert.equal(result.degraded, true);
    assert.match(result.reply, /خدمة العملاء/);
    assert.doesNotMatch(JSON.stringify(result), /never-expose-this-key/);
    await generateCeliaReply({
      config,
      services,
      customerMessage: "مرحبا",
      provider: "auto",
    });
    assert.equal(
      cloudCalls,
      1,
      "open circuit must stop repeated upstream calls",
    );
    await assert.rejects(
      generateCeliaReply({
        config,
        services,
        customerMessage: "مرحبا",
        provider: "gemini",
      }),
      { reason: "circuit_open" },
    );
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("invalid per-call timeout cannot leave a half-open circuit stuck", async () => {
  let now = 0;
  const r = registry({ now: () => now, failureThreshold: 1 });
  await assert.rejects(r.run("cloud", fail));
  now = 21;
  await assert.rejects(
    r.run("cloud", () => true, { timeoutMs: 0 }),
    /Invalid service timeout/,
  );
  assert.equal(r.snapshot()[0].state, "open");
  assert.equal(await r.run("cloud", () => "recovered"), "recovered");
});
