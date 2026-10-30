import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_DECISIONS,
  SOURCE_PROVIDERS,
  candidateProviders,
  isEnabledByDefault,
  loadSourceProviders,
  providerDecision,
  refusedProviders,
  validateRegistry,
} from "../src/source-providers.js";

const root = fileURLToPath(new URL("..", import.meta.url));

test("SRC-01: the registry covers the fourteen reviewed tools and ships nothing enabled", () => {
  assert.equal(SOURCE_PROVIDERS.length, 14);
  assert.equal(isEnabledByDefault(), false);
  for (const provider of SOURCE_PROVIDERS) {
    assert.equal(provider.enabled, false, provider.id);
    assert.ok(PROVIDER_DECISIONS.includes(provider.decision), provider.id);
  }
});

test("SRC-02: tracking and third-party reconnaissance tools are refused with a stated reason", () => {
  const refused = refusedProviders();
  for (const id of ["grabify", "shodan", "leakix", "criminalip", "securitytrails", "data-dumpster"]) {
    assert.ok(refused.includes(id), `${id} must stay refused`);
    assert.equal(providerDecision(id), "refused");
  }
  const grabify = SOURCE_PROVIDERS.find((entry) => entry.id === "grabify");
  assert.equal(grabify.ownerScopedOnly, false, "a tool aimed at other people is never owner-scoped");
});

test("SRC-03: IP classification is refused inside any fetch path, so G10 stays a local check", () => {
  const ipinfo = SOURCE_PROVIDERS.find((entry) => entry.id === "ipinfo");
  assert.equal(ipinfo.decision, "refused");
  assert.match(ipinfo.reason, /local/i);
  assert.equal(ipinfo.sendsQueryUpstream, true);
});

test("SRC-04: only urlscan and HIBP are candidates, and each names the slice it opens", () => {
  assert.deepEqual(candidateProviders().sort(), ["hibp", "urlscan"]);
  for ( const id of candidateProviders()) {
    const provider = SOURCE_PROVIDERS.find((entry) => entry.id === id);
    assert.equal(typeof provider.opens, "string");
    assert.ok(provider.opens.trim().length >= 2);
    assert.equal(provider.ownerScopedOnly, true, `${id} may only ever answer about the owner`);
  }
});

test("SRC-05: validation rejects an enabled provider, a refused-but-enabled one, and anonymous upstream queries", () => {
  const base = JSON.parse(readFileSync(new URL("../docs/source-providers.json", import.meta.url), "utf8"));
  const mutate = (patch) => ({ ...base, providers: base.providers.map((entry) => (entry.id === "urlscan" ? { ...entry, ...patch } : entry)) });

  assert.throws(() => validateRegistry(mutate({ enabled: true })), /must ship disabled/);
  assert.throws(
    () => validateRegistry({ ...base, providers: base.providers.map((entry) => (entry.id === "shodan" ? { ...entry, enabled: true } : entry)) }),
    /cannot be enabled|must ship disabled/,
  );
  assert.throws(() => validateRegistry(mutate({ ownerScopedOnly: false })), /must be owner-scoped/);
  assert.throws(() => validateRegistry(mutate({ decision: "trusted" })), /unknown decision/);
  assert.throws(() => validateRegistry(mutate({ reason: "ok" })), /needs a real reason/);
  assert.throws(
    () => validateRegistry({ ...base, providers: [...base.providers, { ...base.providers[0] }] }),
    /duplicate provider/,
  );
  assert.throws(() => validateRegistry({ providers: [{ id: "x" }] }), /unknown decision/);
  assert.throws(() => validateRegistry({ providers: [{}] }), /provider without id/);
  assert.throws(() => validateRegistry({ providers: [{ id: "   " }] }), /provider without id/);
  assert.throws(() => validateRegistry(null), /registry or providers missing/);
  assert.equal(providerDecision("no-such-provider"), "unknown");
  assert.equal(loadSourceProviders().providers.length, 14);
});

/**
 * حارس الانحراف: يفحص **أسطح التنفيذ والنشر** فقط — كود التشغيل، وسير العمل، وملف
 * النشر — لا الوثائق. الوثائق (CHANGELOG، سجلات الجلسات، §8) هي المكان الذي يُعلن فيه
 * الرفض بالأسماء، ومنع ذكرها هناك يمنع التوثيق الصادق بدل أن يمنع الانحراف.
 */
test("SRC-06: no refused provider leaks into runtime code, deployment profile or workflows", () => {
  const refused = refusedProviders();
  const targets = ["src", "scripts", "workers", ".github/workflows"];
  for (const extra of ["docs/deployment-profile.json", "render.yaml", "package.json"]) {
    try {
      if (statSync(join(root, extra)).isFile()) targets.push(extra);
    } catch {
      /* الملف غير موجود في هذا المستودع */
    }
  }

  const files = [];
  const walk = (entry) => {
    const full = join(root, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      if (["node_modules", ".git", "coverage", "reports"].includes(entry)) return;
      for (const name of readdirSync(full)) walk(join(entry, name));
    } else if (/\.(js|mjs|cjs|json|ya?ml|toml)$/.test(entry)) {
      files.push(full);
    }
  };
  for (const target of targets) walk(target);
  assert.ok(files.length > 50, "the drift guard must actually scan the repository");

  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const id of refused) {
      const pattern = new RegExp(`\\b${id.replace(/[-]/g, "[-_]")}\\b`, "i");
      if (pattern.test(text)) hits.push(`${relative(root, file)}: ${id}`);
    }
  }
  assert.deepEqual(hits, [], `refused provider referenced in runtime or deploy surfaces:\n${hits.join("\n")}`);
});
