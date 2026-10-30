import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createCeliaMcpApp, loadCeliaMcpConfig } from "../src/celia-mcp.js";
import { createMemoryPool } from "../src/memory-pool.js";
import { createServiceRegistry } from "../src/resilience.js";
import { RELEASE } from "../src/version.js";

const token = crypto.randomBytes(32).toString("hex");
const config = () =>
  loadCeliaMcpConfig({
    CELIA_MCP_API_TOKEN: token,
    CELIA_DISABLE_OLLAMA: "true",
    GEMINI_API_KEY: "private-owner-cloud-key",
  });
async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
function rpc(url, name, args = {}) {
  return fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  }).then((r) => r.json());
}

test("storage outage is isolated, liveness stays up, durable writes fail closed and recovery reuses the same store", async () => {
  let failed = true;
  let now = 0;
  const base = createMemoryPool();
  const pool = {
    isMemory: false,
    execute: (...args) => {
      if (failed) throw new Error("mysql://user:password@private-host");
      return base.execute(...args);
    },
    query: (...args) => {
      if (failed) throw new Error("mysql://user:password@private-host");
      return base.query(...args);
    },
  };
  const cfg = {
    ...config(),
    resilience: {
      timeoutMs: 100,
      failureThreshold: 1,
      cooldownMs: 10,
      maxConcurrent: 2,
    },
  };
  const services = createServiceRegistry(cfg);
  services.now = () => now;
  const app = createCeliaMcpApp({ pool, config: cfg, services });
  const server = await listen(app);
  try {
    const health = await fetch(`${server.url}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.equal(health.headers.get("x-celia-version"), RELEASE.version);
    assert.match(health.headers.get("x-request-id"), /^[a-f0-9-]{36}$/);
    assert.equal((await fetch(`${server.url}/readyz`)).status, 503);
    const system = await fetch(`${server.url}/api/system`).then((r) =>
      r.json(),
    );
    assert.equal(system.status, "degraded");
    assert.equal(system.storage.mode, "mysql");
    assert.equal(system.storage.durable, true);
    assert.equal(system.storage.available, false);
    assert.equal(
      system.components.find((c) => c.id === "core").state,
      "healthy",
    );
    assert.doesNotMatch(
      JSON.stringify(system),
      /password|private-host|private-owner-cloud-key/,
    );
    const blocked = await rpc(server.url, "whatsapp_consent_upsert", {
      phone: "+201000000001",
      optedIn: true,
      source: "test",
    });
    assert.equal(blocked.result.isError, true);
    assert.doesNotMatch(JSON.stringify(blocked), /password|private-host/);
    const local = await rpc(server.url, "celia_ai_reply", {
      customerMessage: "مرحبا",
      provider: "local",
    });
    assert.equal(local.result.isError, false);
    assert.equal(
      local.result.structuredContent.provider,
      "celia-local-policy-engine",
    );
    failed = false;
    now = 20;
    const recovered = await app.locals.operations.snapshot({ fresh: true });
    assert.equal(recovered.ready, true);
    assert.equal(recovered.storage.mode, "mysql");
    const consent = await rpc(server.url, "whatsapp_consent_upsert", {
      phone: "+201000000001",
      optedIn: true,
      source: "test",
    });
    assert.equal(consent.result.isError, false);
    assert.equal((await fetch(`${server.url}/readyz`)).status, 200);
  } finally {
    await server.close();
  }
});

test("public sandbox cannot spend owner provider keys; owner diagnostics require authentication", async () => {
  const app = createCeliaMcpApp({ pool: createMemoryPool(), config: config() });
  const server = await listen(app);
  const native = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = (url, options) => {
    if (!String(url).startsWith(server.url)) {
      externalCalls++;
      throw new Error("External call forbidden");
    }
    return native(url, options);
  };
  try {
    const request = (provider) =>
      fetch(`${server.url}/ui/workspace/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "celia_ai_reply",
            arguments: { customerMessage: "مرحبا", provider },
          },
        }),
      });
    const auto = await request("auto").then((r) => r.json());
    assert.equal(
      auto.result.structuredContent.provider,
      "celia-local-policy-engine",
    );
    assert.equal((await request("gemini")).status, 403);
    assert.equal(externalCalls, 0);
    assert.equal(
      (await fetch(`${server.url}/api/system/diagnostics`)).status,
      401,
    );
    const diagnostics = await fetch(`${server.url}/api/system/diagnostics`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(diagnostics.status, 200);
    assert.doesNotMatch(await diagnostics.text(), /private-owner-cloud-key/);
    for (const route of [
      "/system",
      "/system.html",
      "/system.js",
      "/system.css",
      "/version",
      "/api/releases",
    ]) {
      const response = await fetch(`${server.url}${route}`);
      assert.equal(response.status, 200, route);
    }
    const release = await fetch(`${server.url}/version`).then((r) => r.json());
    assert.equal(release.version, RELEASE.version);
    const catalogue = await fetch(`${server.url}/api/releases`).then((r) =>
      r.json(),
    );
    assert.equal(catalogue.publication, "catalog-only");
    // التقدّم بعد آخر إصدار يُقرأ من CHANGELOG.md، لا من قائمة مكتوبة بيد.
    assert.equal(catalogue.unreleasedSource, "CHANGELOG.md#Unreleased");
    assert.equal(catalogue.unreleased.parsed, true);
    assert.ok(Number.isInteger(catalogue.unreleased.items));
    assert.ok(Object.hasOwn(catalogue.unreleased.sections, "added"));
  } finally {
    globalThis.fetch = native;
    await server.close();
  }
});

test("MCP batches are bounded and shutdown readiness is separate from liveness", async () => {
  const app = createCeliaMcpApp({ pool: createMemoryPool(), config: config() });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        Array.from({ length: 21 }, (_, id) => ({
          jsonrpc: "2.0",
          id,
          method: "ping",
        })),
      ),
    });
    assert.equal(response.status, 413);
    app.locals.operations.markDraining();
    assert.equal((await fetch(`${server.url}/readyz`)).status, 503);
    assert.equal((await fetch(`${server.url}/health`)).status, 200);
  } finally {
    await server.close();
  }
});

test("memory demo capacity is bounded and never claimed to be durable", async () => {
  const pool = createMemoryPool({ maxEntries: 2 });
  for (let i = 0; i < 4; i++)
    await pool.execute(
      "INSERT INTO whatsapp_contacts (phone_e164, last_inbound_at) VALUES (?, UTC_TIMESTAMP())",
      [`+20100000000${i}`],
    );
  const [rows] = await pool.execute(
    "SELECT phone_e164, opted_in, ai_opted_in, consent_source, consented_at, last_inbound_at FROM whatsapp_contacts",
  );
  assert.equal(rows.length, 2);
  const app = createCeliaMcpApp({ pool, config: config() });
  const snapshot = await app.locals.operations.snapshot();
  assert.equal(snapshot.storage.durable, false);
  assert.equal(snapshot.storage.explicitDemo, true);
});

test("production MySQL startup failure never manufactures an empty memory database", async () => {
  const { connectPoolWithFallback } = await import("../src/celia-mcp.js");
  const cfg = loadCeliaMcpConfig({
    CELIA_MCP_API_TOKEN: token,
    NODE_ENV: "production",
    MYSQL_HOST: "127.0.0.1",
    MYSQL_PORT: "9",
  });
  const pool = await connectPoolWithFallback(cfg);
  try {
    assert.equal(pool.isMemory, false);
    const app = createCeliaMcpApp({ pool, config: cfg });
    const snapshot = await app.locals.operations.snapshot();
    assert.equal(snapshot.storage.mode, "mysql");
    assert.equal(snapshot.ready, false);
  } finally {
    await pool.end();
  }
});
