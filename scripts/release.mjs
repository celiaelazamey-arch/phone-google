#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RELEASE, RELEASE_HISTORY } from "../src/version.js";
import { build } from "./build-pages.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, ".release-artifacts");
const run = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function checkRelease() {
  const { stdout: tracked } = await run("git", ["ls-files", "-z"], {
    cwd: ROOT,
  });
  if (
    tracked
      .split("\0")
      .some(
        (file) =>
          /(^|\/)\.env($|\.)/.test(file) && !/(^|\/)\.env\.example$/.test(file),
      )
  )
    throw new Error("Secret environment file is tracked; release refused");
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json")));
  const lock = JSON.parse(await readFile(path.join(ROOT, "package-lock.json")));
  if (
    pkg.version !== RELEASE.version ||
    lock.version !== RELEASE.version ||
    lock.packages[""].version !== RELEASE.version
  )
    throw new Error("Package, lockfile and release versions differ");
  if (
    RELEASE_HISTORY[0]?.version !== RELEASE.version ||
    RELEASE_HISTORY[1]?.version !== RELEASE.previousVersion
  )
    throw new Error("Release history is inconsistent");
  if (
    new Set(RELEASE_HISTORY.map((r) => r.version)).size !==
    RELEASE_HISTORY.length
  )
    throw new Error("Duplicate release history version");
  const db = RELEASE.database;
  if (
    ![db.schema, db.minReadable, db.maxReadable].every(
      (v) => Number.isInteger(v) && v > 0,
    ) ||
    db.minReadable > db.schema ||
    db.maxReadable < db.schema ||
    db.destructiveMigration !== false
  )
    throw new Error("Unsafe database compatibility contract");
  if (Number(process.versions.node.split(".")[0]) < RELEASE.minimumNode)
    throw new Error(`Node ${RELEASE.minimumNode}+ required`);
  return {
    version: RELEASE.version,
    previousVersion: RELEASE.previousVersion,
    databaseSchema: db.schema,
  };
}

export async function verifyBundle(directory = OUTPUT) {
  const checksumText = await readFile(
    path.join(directory, "SHA256SUMS"),
    "utf8",
  );
  const seen = new Set();
  for (const line of checksumText.trim().split("\n")) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!match || seen.has(match[2]))
      throw new Error("Unsafe or duplicate checksum entry");
    seen.add(match[2]);
    if (sha256(await readFile(path.join(directory, match[2]))) !== match[1])
      throw new Error(`Checksum mismatch: ${match[2]}`);
  }
  const manifest = JSON.parse(
    await readFile(path.join(directory, "release.json")),
  );
  const expected = [
    `celia-v${manifest.version}-source.tar.gz`,
    `celia-v${manifest.version}-site.tar.gz`,
    "sbom.cdx.json",
    "release.json",
  ];
  if (
    expected.length !== seen.size ||
    expected.some((file) => !seen.has(file)) ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    !/^[a-f0-9]{40}$/.test(manifest.commit)
  )
    throw new Error("Incomplete or invalid release bundle");
  return {
    verified: true,
    version: manifest.version,
    commit: manifest.commit,
    files: [...seen],
  };
}

export async function bundleRelease() {
  await checkRelease();
  const { stdout: dirty } = await run("git", ["status", "--porcelain"], {
    cwd: ROOT,
  });
  if (dirty.trim())
    throw new Error("Release bundles require a clean committed worktree");
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: ROOT });
  const commit = stdout.trim();
  await mkdir(OUTPUT, { recursive: true });
  const source = `celia-v${RELEASE.version}-source.tar.gz`;
  const site = `celia-v${RELEASE.version}-site.tar.gz`;
  await run(
    "git",
    [
      "archive",
      "--format=tar.gz",
      "--prefix=celia/",
      `--output=${path.join(OUTPUT, source)}`,
      commit,
    ],
    { cwd: ROOT },
  );
  await build();
  await run(
    "tar",
    ["-czf", path.join(OUTPUT, site), "-C", path.join(ROOT, "dist"), "."],
    { cwd: ROOT },
  );
  const sbom = await run(
    "npm",
    ["sbom", "--sbom-format=cyclonedx", "--omit=dev"],
    { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 },
  );
  await writeFile(path.join(OUTPUT, "sbom.cdx.json"), sbom.stdout);
  const image = process.env.CELIA_RELEASE_IMAGE || null;
  if (image && !/^ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Release image must be an immutable GHCR digest");
  await writeFile(
    path.join(OUTPUT, "release.json"),
    `${JSON.stringify({ ...RELEASE, commit, image, builtAt: new Date().toISOString(), authenticity: "Verify GitHub artifact attestations where available; checksums alone are not signatures." }, null, 2)}\n`,
  );
  const entries = [];
  for (const file of [source, site, "sbom.cdx.json", "release.json"])
    entries.push(`${sha256(await readFile(path.join(OUTPUT, file)))}  ${file}`);
  await writeFile(path.join(OUTPUT, "SHA256SUMS"), `${entries.join("\n")}\n`);
  return verifyBundle();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const command = process.argv[2] || "check";
  const actions = {
    check: checkRelease,
    bundle: bundleRelease,
    verify: () => verifyBundle(process.argv[3] || OUTPUT),
  };
  if (!actions[command]) {
    console.error("Usage: release.mjs check|bundle|verify [directory]");
    process.exitCode = 1;
  } else
    actions[command]()
      .then((value) => console.log(JSON.stringify(value, null, 2)))
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
}
