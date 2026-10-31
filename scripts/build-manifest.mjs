#!/usr/bin/env node
// MAN-001 — generate the system's declarative contract from the sources that already exist.
//
// Why generated and not hand-written: package.json, wrangler.toml, the Worker import graph and
// the two MCP tool registries are already authoritative. A fifth hand-maintained file would
// drift from all four (DEC-074). So this derives `system.manifest.json` and `--check` fails CI
// when it goes stale, exactly like scripts/build-edge-ui.mjs.
//
// Privacy: setting NAMES only, never values. The generator never reads a secret's value; it
// reads requirement declarations and file contents that are already committed.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectWorkerModules, loadMigrationFiles } from './deploy-cloudflare-edge.mjs';
import { CAPABILITY_REQUIREMENTS, capabilitySettingNames } from '../workers/celia-edge/capabilities.js';
import { EDGE_MCP_TOOLS } from '../workers/celia-edge/runtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_FILE = 'system.manifest.json';
export const MANIFEST_VERSION = 1;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Canonical JSON: stable key order so the drift gate compares content, not formatting. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

/** Schema fingerprint that ignores prose: descriptions are translated, contracts are not. */
export function toolContract(tool) {
  const schema = tool.inputSchema || {};
  const properties = {};
  for (const name of Object.keys(schema.properties || {}).sort()) {
    const property = schema.properties[name] || {};
    properties[name] = canonical({
      type: property.type ?? null,
      enum: property.enum ?? null,
      minimum: property.minimum ?? null,
      maximum: property.maximum ?? null
    });
  }
  return {
    name: tool.name,
    required: [...(schema.required || [])].sort(),
    additionalProperties: schema.additionalProperties ?? null,
    properties
  };
}

export function toolDigest(tool) {
  return `sha256:${sha256(JSON.stringify(canonical(toolContract(tool))))}`;
}

/** Read wrangler.toml without adding a TOML dependency for two scalar keys. */
export function readWranglerScalars(text) {
  const main = /^\s*main\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null;
  const compatibilityDate = /^\s*compatibility_date\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null;
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null;
  return { name, main, compatibilityDate };
}

export async function buildManifest({ nodeTools } = {}) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const wrangler = readWranglerScalars(await readFile(path.join(root, 'workers/celia-edge/wrangler.toml'), 'utf8'));
  const modules = await collectWorkerModules();
  const migrations = await loadMigrationFiles();

  // Read the Node registry too, so `surfaces` is a measured fact rather than an assumption.
  // Its SQLite handle is opened lazily inside a function, so importing the registry alone
  // creates no database and writes nothing.
  const resolvedNodeTools = nodeTools ?? (await import('../src/celia-mcp.js')).MCP_TOOLS;
  const tools = EDGE_MCP_TOOLS.map((tool) => ({
    name: tool.name,
    contractDigest: toolDigest(tool),
    surfaces: resolvedNodeTools.some((candidate) => candidate.name === tool.name) ? ['edge', 'node'] : ['edge']
  })).sort((a, b) => a.name.localeCompare(b.name));

  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    name: 'celia',
    version: pkg.version,
    generator: 'scripts/build-manifest.mjs',
    targets: {
      edge: {
        runtime: 'cloudflare-workers',
        script: wrangler.name,
        entry: wrangler.main,
        compatibilityDate: wrangler.compatibilityDate,
        // Dependency-first order, straight from the bundler's own graph walk.
        modules: modules.map((module) => module.name),
        bundleDigest: `sha256:${sha256(modules.map((m) => `${m.name}\n${m.source}`).join('\n'))}`
      },
      node: { runtime: 'node-express-esm', entry: 'src/server.js', engines: pkg.engines?.node ?? null }
    },
    // Declarative capability contract, shared verbatim with the running Worker.
    capabilities: CAPABILITY_REQUIREMENTS.map((requirement) => ({
      id: requirement.id,
      label: requirement.label,
      requires: [...requirement.requires],
      anyOf: [...(requirement.anyOf || [])],
      settingLabels: { ...(requirement.labels || {}) }
    })),
    requiredSettings: capabilitySettingNames(),
    tools,
    schema: {
      store: 'cloudflare-d1',
      // Additive only: D1 migrations do not roll back (DEC-074 §4.2).
      policy: 'additive-expand-contract',
      migrations: migrations.map((file) => ({ version: file.version, digest: `sha256:${sha256(file.sql)}` }))
    },
    provenance: {
      // Recorded by the release workflow; the manifest only names the artifacts.
      sbom: 'sbom.cdx.json',
      sums: 'SHA256SUMS',
      attestationWorkflow: '.github/workflows/release.yml'
    }
  };
  return canonical(manifest);
}

export function renderManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function main() {
  const expected = renderManifest(await buildManifest());
  const target = path.join(root, MANIFEST_FILE);
  if (process.argv.includes('--check')) {
    const actual = await readFile(target, 'utf8').catch(() => '');
    if (actual !== expected) {
      console.error(`${MANIFEST_FILE} is stale. Run: npm run build:manifest`);
      process.exit(1);
    }
    console.log(`System manifest is current: ${MANIFEST_FILE}`);
    return;
  }
  await writeFile(target, expected);
  console.log(`Generated ${MANIFEST_FILE} (${expected.length} bytes).`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
