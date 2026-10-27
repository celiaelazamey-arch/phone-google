import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  emptyDeploymentState,
  recoverDeployment,
  transitionRelease,
  validateProbe,
  validateTarget,
} from "../src/deployment.js";
import { saveState } from "../scripts/deploy-release.mjs";
import { checkRelease, verifyBundle } from "../scripts/release.mjs";

const old = {
  version: "0.2.0",
  image: `ghcr.io/owner/celia@sha256:${"a".repeat(64)}`,
  databaseSchema: 1,
  storageMode: "mysql",
};
const next = {
  version: "0.3.0",
  image: `ghcr.io/owner/celia@sha256:${"b".repeat(64)}`,
};
const state = () => ({
  format: 1,
  active: { ...old },
  previous: null,
  history: [],
});
const probe = (target = next) => ({
  ready: true,
  storage: { available: true, mode: "mysql", durable: true },
  release: {
    version: target.version,
    database: {
      schema: 1,
      minReadable: 1,
      maxReadable: 1,
      destructiveMigration: false,
    },
  },
});
function adapter(overrides = {}) {
  const calls = [];
  let active = old;
  const saved = [];
  return {
    calls,
    saved,
    stage: async (target) => {
      calls.push("stage");
      return probe(target);
    },
    activate: async (target) => {
      calls.push(`activate:${target.version}`);
      active = target;
    },
    probeActive: async () => {
      calls.push("probe");
      return probe(active);
    },
    save: async (value) => {
      calls.push(value.pending ? "journal" : "save");
      saved.push(value);
    },
    deactivate: async () => {
      calls.push("deactivate");
    },
    discard: async () => {
      calls.push("discard");
    },
    ...overrides,
  };
}

test("release manifest, lockfile and history use a single compatible release identity", async () => {
  assert.deepEqual(await checkRelease(), {
    version: "0.2.1",
    previousVersion: "0.2.0",
    databaseSchema: 1,
  });
});

test("only immutable GHCR digest images and strict versions are accepted", () => {
  validateTarget(next);
  for (const image of [
    "ghcr.io/owner/celia:latest",
    "ghcr.io/owner/celia:0.2.0",
    `ghcr.io/owner/celia@sha256:${"g".repeat(64)}`,
    "--privileged",
    "http://unsafe/image",
  ])
    assert.throws(() => validateTarget({ ...next, image }));
  assert.throws(() => validateTarget({ ...next, version: "v0.3.0;evil" }));
});

test("candidate gating rejects mismatched versions, unhealthy/demonstration storage and destructive schema changes", () => {
  assert.equal(validateProbe(probe(), next).version, next.version);
  for (const invalid of [
    { ...probe(), ready: false },
    { ...probe(), release: { ...probe().release, version: old.version } },
    {
      ...probe(),
      storage: { available: true, durable: false, mode: "memory" },
    },
    {
      ...probe(),
      release: {
        version: next.version,
        database: {
          schema: 2,
          minReadable: 2,
          maxReadable: 2,
          destructiveMigration: false,
        },
      },
    },
    {
      ...probe(),
      release: {
        version: next.version,
        database: {
          schema: 1,
          minReadable: 1,
          maxReadable: 1,
          destructiveMigration: true,
        },
      },
    },
  ])
    assert.throws(() => validateProbe(invalid, next));
});

test("successful switch preflights, journals, activates, probes, then atomically records previous release", async () => {
  const a = adapter();
  const before = state();
  const result = await transitionRelease({
    state: before,
    target: next,
    adapter: a,
  });
  assert.deepEqual(a.calls, [
    "stage",
    "journal",
    `activate:${next.version}`,
    "probe",
    "save",
    "discard",
  ]);
  assert.equal(result.active.version, next.version);
  assert.deepEqual(result.previous, old);
  assert.equal(
    before.active.version,
    old.version,
    "input state must not be mutated",
  );
  const back = await transitionRelease({
    state: result,
    target: result.previous,
    adapter: adapter(),
  });
  assert.equal(back.active.version, old.version);
  assert.equal(back.previous.version, next.version);
});

test("failed candidate never replaces the active service or changes deployment history", async () => {
  const a = adapter({ stage: async () => ({ ...probe(), ready: false }) });
  await assert.rejects(
    transitionRelease({ state: state(), target: next, adapter: a }),
  );
  assert.deepEqual(a.calls, ["discard"]);
  assert.equal(a.saved.length, 0);
});

test("post-switch readiness failure restores and verifies the last healthy release", async () => {
  let probes = 0;
  const a = adapter({
    probeActive: async () =>
      ++probes === 1 ? { ...probe(), ready: false } : probe(old),
  });
  const before = state();
  await assert.rejects(
    transitionRelease({ state: before, target: next, adapter: a }),
  );
  assert.ok(a.calls.includes(`activate:${old.version}`));
  assert.equal(probes, 2);
  assert.deepEqual(a.saved.at(-1), before);
  assert.equal(a.saved[0].pending.target.version, next.version);
});

test("failed activation is treated as possibly destructive and triggers restoration", async () => {
  const base = adapter();
  let count = 0;
  const a = {
    ...base,
    activate: async (target) => {
      base.calls.push(target.version);
      if (++count === 1) throw new Error("compose failed after replacement");
    },
    probeActive: async () => probe(old),
  };
  await assert.rejects(
    transitionRelease({ state: state(), target: next, adapter: a }),
  );
  assert.ok(a.calls.includes(old.version));
  assert.equal(count, 2);
});

test("state commit failure also restores previous runtime, rather than claiming a successful deployment", async () => {
  let saves = 0;
  const a = adapter({
    save: async () => {
      if (++saves === 2) throw new Error("disk full");
    },
  });
  await assert.rejects(
    transitionRelease({ state: state(), target: next, adapter: a }),
    /disk full/,
  );
  assert.equal(saves, 3);
  assert.ok(a.calls.includes(`activate:${old.version}`));
});

test("failed rollback retains recovery journal and raises an explicit manual intervention error", async () => {
  const a = adapter({
    activate: async () => {
      throw new Error("host down");
    },
  });
  await assert.rejects(
    transitionRelease({ state: state(), target: next, adapter: a }),
    { code: "MANUAL_RECOVERY_REQUIRED" },
  );
  assert.equal(a.saved.length, 1);
  assert.ok(a.saved[0].pending);
});

test("first deployment failure removes only its application container; no previous version is invented", async () => {
  const a = adapter({
    probeActive: async () => ({ ...probe(), ready: false }),
  });
  await assert.rejects(
    transitionRelease({
      state: emptyDeploymentState(),
      target: next,
      adapter: a,
    }),
  );
  assert.ok(a.calls.includes("deactivate"));
  assert.equal(a.saved.at(-1).active, null);
});

test("interrupted deployment blocks new switches and recover restores recorded active version", async () => {
  const interrupted = { ...state(), pending: { target: next } };
  await assert.rejects(
    transitionRelease({ state: interrupted, target: next, adapter: adapter() }),
    /recovery/,
  );
  const a = adapter();
  const result = await recoverDeployment({ state: interrupted, adapter: a });
  assert.equal(result.active.version, old.version);
  assert.equal(result.pending, undefined);
  assert.deepEqual(a.calls, [`activate:${old.version}`, "probe", "save"]);
});

test("code switches may not change storage mode, even with --allow-memory", async () => {
  const a = adapter({
    stage: async () => ({
      ...probe(),
      storage: { available: true, durable: false, mode: "memory" },
    }),
  });
  await assert.rejects(
    transitionRelease({
      state: state(),
      target: next,
      adapter: a,
      requireDurable: false,
    }),
    /Storage mode changes/,
  );
});

test("deployment state writes are atomic, parseable and owner-only", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "celia-deploy-test-"));
  try {
    const file = path.join(directory, "state.json");
    await saveState(file, state());
    assert.deepEqual(JSON.parse(await readFile(file)), state());
    assert.equal((await stat(file)).mode & 0o077, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release checksum verification detects corruption, incomplete bundles and path traversal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "celia-bundle-test-"));
  const files = {
    "celia-v0.2.0-source.tar.gz": "source",
    "celia-v0.2.0-site.tar.gz": "site",
    "sbom.cdx.json": "{}",
    "release.json": JSON.stringify({
      version: "0.2.0",
      commit: "a".repeat(40),
    }),
  };
  try {
    for (const [name, content] of Object.entries(files))
      await writeFile(path.join(directory, name), content);
    const sums = Object.entries(files)
      .map(
        ([name, content]) =>
          `${createHash("sha256").update(content).digest("hex")}  ${name}`,
      )
      .join("\n");
    await writeFile(path.join(directory, "SHA256SUMS"), sums);
    assert.equal((await verifyBundle(directory)).verified, true);
    await writeFile(path.join(directory, "sbom.cdx.json"), "tampered");
    await assert.rejects(verifyBundle(directory), /Checksum mismatch/);
    await writeFile(
      path.join(directory, "SHA256SUMS"),
      `${"a".repeat(64)}  ../outside`,
    );
    await assert.rejects(verifyBundle(directory), /Unsafe/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("candidate cleanup cannot conceal a rollback failure or fabricate a successful command", async () => {
  const failed = adapter({
    activate: async () => {
      throw new Error("engine down");
    },
    discard: async () => {
      throw new Error("cleanup down");
    },
  });
  await assert.rejects(
    transitionRelease({ state: state(), target: next, adapter: failed }),
    { code: "MANUAL_RECOVERY_REQUIRED" },
  );
  const healthy = adapter({
    discard: async () => {
      throw new Error("cleanup down");
    },
  });
  await assert.rejects(
    transitionRelease({ state: state(), target: next, adapter: healthy }),
    /DEPLOYMENT_SAVED_CLEANUP_REQUIRED/,
  );
  assert.equal(healthy.saved.at(-1).active.version, next.version);
});
