#!/usr/bin/env node
/**
 * Visual-First Engineering gate (VFE-001 / DEC-085).
 *
 * Two things are checked, and neither is a matter of taste:
 *
 *   1. **The board is generated.** `docs/design/visual-first.html` must equal the output of
 *      `src/design/visual-registry.js`. A status cannot be improved on the page while its evidence
 *      is missing from the repository.
 *   2. **Every handoff in the change range carries its visual evidence.** A session record either
 *      links a visual artifact that exists (`docs/design/*.html`, `.png`, `.svg`) or states
 *      `لا يوجد تغيير بصري` and why. Silence is the failure this gate is here to catch.
 *
 * The session rule applies only to records inside the change range (`CELIA_CONTINUITY_BASE`), so a
 * hundred historical handoffs are not retro-fitted with a section nobody wrote.
 *
 * Usage:
 *   node scripts/check-visual-first.mjs            # board + (if a base is set) changed handoffs
 *   node scripts/check-visual-first.mjs --no-base  # board only
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { PAGE_PATH, buildHtml } from './render-visual-first.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export const VISUAL_SECTION = 'الدليل البصري';
export const WAIVER = 'لا يوجد تغيير بصري';
const ARTIFACT_LINK = /\]\(([^)\s]+\.(?:html|png|svg))(?:#[^)]*)?\)/g;

/** Extract the body of the `## الدليل البصري` section, or null when the heading is absent. */
export function visualSection(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^##\s+الدليل البصري\s*$/.test(line.trim()));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n').trim();
}

/**
 * Audit handoff records. `root` anchors link resolution; each file is `{ path, text }` with `path`
 * relative to the repository root.
 */
export function auditSessionHandoffs({ files = [], root = ROOT } = {}) {
  const failures = [];
  for (const file of files) {
    const section = visualSection(file.text);
    if (section === null) {
      failures.push({ path: file.path, reason: `missing the "## ${VISUAL_SECTION}" section` });
      continue;
    }
    if (!section) {
      failures.push({ path: file.path, reason: `the "${VISUAL_SECTION}" section is empty` });
      continue;
    }
    const links = [...section.matchAll(ARTIFACT_LINK)].map((match) => match[1]);
    if (section.includes(WAIVER)) continue;
    if (!links.length) {
      failures.push({
        path: file.path,
        reason: `no visual artifact link and no "${WAIVER}" waiver in "${VISUAL_SECTION}"`
      });
      continue;
    }
    for (const link of links) {
      const target = path.resolve(path.dirname(path.join(root, file.path)), link);
      if (!existsSync(target)) failures.push({ path: file.path, reason: `visual artifact ${link} does not exist` });
    }
  }
  return { ok: failures.length === 0, failures };
}

function changedHandoffs(base) {
  const out = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^docs\/continuity\/sessions\/.+\.md$/.test(line))
    .map((file) => ({ path: file, text: readFileSync(path.join(ROOT, file), 'utf8') }));
}

function main() {
  const errors = [];
  let current = null;
  try {
    current = readFileSync(PAGE_PATH, 'utf8');
  } catch {
    errors.push(`docs/design/visual-first.html is missing — run \`npm run visual:first\``);
  }
  if (current !== null && current !== buildHtml()) {
    errors.push('docs/design/visual-first.html is stale — run `npm run visual:first`');
  }

  const base = process.argv.includes('--no-base') ? null : process.env.CELIA_CONTINUITY_BASE;
  if (base) {
    if (!/^[a-f0-9]{40}$/i.test(base)) {
      errors.push('CELIA_CONTINUITY_BASE must be an immutable commit SHA');
    } else {
      const { failures } = auditSessionHandoffs({ files: changedHandoffs(base), root: ROOT });
      for (const failure of failures) errors.push(`${failure.path}: ${failure.reason}`);
    }
  }

  if (errors.length) {
    console.error(['Visual-First check failed:', ...errors.map((error) => `- ${error}`)].join('\n'));
    return 1;
  }
  const scope = base ? 'board + handoffs in range' : 'board';
  console.log(`Visual-First verified: ${scope}, registry and page agree.`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
