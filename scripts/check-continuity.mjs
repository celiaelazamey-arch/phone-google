#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = 'docs/continuity';
const errors = [];
async function list(dir) {
  const files = [];
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await list(relative));
    else if (entry.name.endsWith('.md')) files.push(relative);
  }
  return files;
}
const files = ['AGENTS.md', 'README.md', 'docs/2026-development-plan.md', 'docs/agent-runtime-plan.md', 'docs/google-connect.md', 'docs/compatibility-contract.md', 'docs/free-hosting.md', ...await list(directory)];
const sources = new Map(await Promise.all(files.map(async (file) => [file, await readFile(path.join(root, file), 'utf8')])));
let links = 0;
for (const [file, content] of sources) {
  for (const match of content.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1];
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) || href.startsWith('#')) continue;
    links++;
    const target = path.resolve(root, path.dirname(file), decodeURIComponent(href.split(/[?#]/)[0]));
    if (target !== root && !target.startsWith(root + path.sep)) { errors.push(`${file}: link escapes repository`); continue; }
    if (!(await stat(target).catch(() => null))?.isFile()) errors.push(`${file}: broken local link ${href}`);
  }
}
const pattern = /\b[A-Z]{2,8}-\d{3}\b/g;
const tasks = new Map();
for (const row of sources.get(`${directory}/BACKLOG.md`).split('\n')) {
  if (!/^\| [A-Z]{2,8}-\d{3} /.test(row)) continue;
  const cells = row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  if (cells.length !== 5) { errors.push('Malformed backlog row'); continue; }
  if (tasks.has(cells[0])) errors.push(`Duplicate task ${cells[0]}`);
  if (!['P0', 'P1', 'P2'].includes(cells[1])) errors.push(`${cells[0]}: invalid priority`);
  if (!['منجز توثيقيًا', 'مخطط', 'بانتظار', 'جارٍ', 'متحقق', 'منشور'].some((status) => cells[2].startsWith(status))) errors.push(`${cells[0]}: invalid status`);
  tasks.set(cells[0], cells);
}
if (!tasks.size) errors.push('Backlog cannot be empty');
for (const [file, content] of sources) {
  for (const id of content.match(pattern) || []) {
    if (id.startsWith('DEC-') || /^(?:AES|SHA)-\d{3}$/.test(id)) continue;
    if (!tasks.has(id)) errors.push(`${file}: unknown task ${id}`);
  }
}
const visited = new Set(), active = new Set();
function visit(id) {
  if (active.has(id)) { errors.push(`Dependency cycle at ${id}`); return; }
  if (visited.has(id)) return;
  active.add(id);
  for (const dep of tasks.get(id)?.[3].match(pattern) || []) {
    if (!tasks.has(dep)) errors.push(`${id}: unknown dependency ${dep}`);
    else visit(dep);
  }
  active.delete(id); visited.add(id);
}
for (const id of tasks.keys()) visit(id);
const base = process.env.CELIA_CONTINUITY_BASE;
if (base) {
  if (!/^[a-f0-9]{40}$/i.test(base)) errors.push('Continuity base must be an immutable commit SHA');
  else {
    const changed = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
    const implementationChanged = changed.some((name) => /^(src|public|scripts|sql|integration|test|e2e)\//.test(name) || /^(package(?:-lock)?\.json|Dockerfile.*|render.*\.yaml)$/.test(name) || name.startsWith('.github/workflows/'));
    if (implementationChanged && (!changed.includes(`${directory}/STATE.md`) || !changed.some((name) => name.startsWith(`${directory}/sessions/`) && name.endsWith('.md')))) {
      errors.push('Implementation changes require an updated STATE and a session handoff in the same PR/commit range');
    }
  }
}
if (errors.length) {
  console.error([...new Set(errors)].join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Continuity verified: ${files.length} documents, ${links} local links, ${tasks.size} unique tasks; no dependency cycles.${base ? ' Handoff change gate checked.' : ' No change-range gate requested.'}`);
  console.log('This structural check does not certify the truth of human statements or production safety.');
}
