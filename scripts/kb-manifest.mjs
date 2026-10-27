#!/usr/bin/env node
/** Rebuilds data/kb/manifest.json from the CSVs and descriptors (no file rewriting). */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../src/knowledge/manifest.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'data', 'kb');

async function main() {
  const descriptors = JSON.parse(await readFile(path.join(directory, 'descriptors.json'), 'utf8'));
  const manifest = { version: 1, generated_at: new Date().toISOString(), files: [] };
  for (const descriptor of descriptors.files) {
    const source = await readFile(path.join(directory, descriptor.name), 'utf8');
    manifest.files.push({ ...descriptor, sha256: sha256(source) });
  }
  await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`manifest.json: ${manifest.files.length} files`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
