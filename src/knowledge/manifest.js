import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Registry manifest: every CSV carries a SHA-256 recorded in `manifest.json`.
 * Import refuses to run when a file changed without a refreshed manifest, so a
 * silent hand edit can never masquerade as a reviewed data change.
 */

export const MANIFEST_NAME = 'manifest.json';

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export async function readManifest(directory) {
  const file = path.join(directory, MANIFEST_NAME);
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new Error(`manifest_missing: ${MANIFEST_NAME} not found in ${directory}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error('manifest_invalid_json');
  }
  if (!manifest || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('manifest_empty');
  for (const entry of manifest.files) {
    if (!entry?.name || !entry?.kind || !/^[a-f0-9]{64}$/.test(entry?.sha256 || '')) {
      throw new Error('manifest_entry_invalid');
    }
    if (entry.name.includes('/') || entry.name.includes('..')) throw new Error('manifest_path_escape');
  }
  return manifest;
}

/** Verifies checksums and returns the parsed entries with their sources. */
export async function verifyManifest(directory) {
  const manifest = await readManifest(directory);
  const files = [];
  for (const entry of manifest.files) {
    const source = await readFile(path.join(directory, entry.name), 'utf8').catch(() => null);
    if (source === null) throw new Error(`registry_missing: ${entry.name}`);
    const checksum = sha256(source);
    if (checksum !== entry.sha256) {
      throw new Error(`manifest_checksum_mismatch: ${entry.name} (run: npm run kb:manifest)`);
    }
    files.push({ ...entry, source });
  }
  return { manifest, files };
}

/** Rebuilds the manifest from the CSV files on disk (used by `npm run kb:manifest`). */
export async function buildManifest(directory, descriptors) {
  const files = [];
  for (const descriptor of descriptors) {
    const source = await readFile(path.join(directory, descriptor.name), 'utf8');
    files.push({ ...descriptor, sha256: sha256(source) });
  }
  return { version: 1, generated_at: new Date().toISOString(), files };
}
