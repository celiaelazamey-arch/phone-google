/**
 * CONT-004 / DEC-052 — R0 (2026) continuity & developer-agent foundation tests (R0-01..R0-06).
 *
 * Deterministic and offline: verifies sequential ADR numbering, byte-exact STATE archival with zero
 * truncation, the thin CLAUDE.md shim, the 4 repository skills and their `npm run` bindings, the
 * deterministic NOW.md generator + `--check` drift gate, and R0 scope boundaries (no R1/MCP/gh-aw).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  NOW_RELATIVE_PATH,
  collectNowFacts,
  parseDecisions,
  parseSkillFrontmatter,
  parseStateSummary,
  renderNowMarkdown,
  runCli,
  syncNowFile
} from '../scripts/generate-now.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const EXPECTED_SKILLS = ['continuity-handoff', 'governed-pr-merge', 'quality-gates', 'session-orient'];
const PINNED_PRE_R0_STATE_SHA256 = 'f2674637e82e00e91c2721fd3209a72362879a072a429103bc7d06f872bb3f6c';

function memoryWritable() {
  let text = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += chunk.toString('utf8');
      cb();
    }
  });
  return { stream, output: () => text };
}

test('R0-01 DECISIONS.md covers every ADR from DEC-001 through DEC-052+ with zero duplicates or gaps', () => {
  const md = read('docs/continuity/DECISIONS.md');
  const parsed = parseDecisions(md);
  assert.ok(parsed.total >= 52, `expected at least 52 decisions, got ${parsed.total}`);

  const matches = [...md.matchAll(/^## DEC-(\d{3})\s+—\s+(.+)$/gm)];
  assert.equal(matches.length, parsed.total);
  const numbers = matches.map((m) => Number(m[1]));
  const sorted = [...numbers].sort((a, b) => a - b);
  sorted.forEach((num, index) => {
    const expected = index + 1;
    assert.equal(num, expected, `expected complete sequence without gaps or duplicates at DEC-${String(expected).padStart(3, '0')}, saw DEC-${String(num).padStart(3, '0')}`);
  });

  // Every decision from DEC-025 onward stays strictly monotonic in file order too
  const tail = numbers.filter((n) => n >= 25);
  for (let i = 1; i < tail.length; i += 1) {
    assert.equal(tail[i], tail[i - 1] + 1, `DEC-${String(tail[i]).padStart(3, '0')} follows DEC-${String(tail[i - 1]).padStart(3, '0')} in order`);
  }

  const dec052 = matches.find((m) => m[1] === '052');
  assert.ok(dec052, 'DEC-052 must exist in DECISIONS.md');
  assert.match(dec052[2], /R0/);
  assert.equal(parsed.nextId, `DEC-${String(matches.length + 1).padStart(3, '0')}`);
});

test('R0-02 STATE-ARCHIVE-2026-10.md preserves the pre-R0 STATE.md byte-for-byte while live STATE.md stays compact', () => {
  const archive = read('docs/continuity/STATE-ARCHIVE-2026-10.md');
  const meta = /^<!--\s*state-archive:\s*source=docs\/continuity\/STATE\.md\s+baseline=9f6f8b2\s+sha256=([a-f0-9]{64})\s+bytes=(\d+)\s+lines=(\d+)\s*-->/m.exec(
    archive
  );
  assert.ok(meta, 'archive carries machine-verifiable provenance header');
  assert.equal(meta[1], PINNED_PRE_R0_STATE_SHA256, 'pinned pre-R0 STATE.md SHA-256 never drifts');

  const beginMarker = '<!-- BEGIN VERBATIM STATE SNAPSHOT -->\n';
  const endMarker = '\n<!-- END VERBATIM STATE SNAPSHOT -->';
  const startIdx = archive.indexOf(beginMarker);
  const endIdx = archive.lastIndexOf(endMarker);
  assert.ok(startIdx !== -1 && endIdx > startIdx, 'verbatim snapshot markers exist');

  const snapshot = archive.slice(startIdx + beginMarker.length, endIdx);
  const digest = createHash('sha256').update(snapshot, 'utf8').digest('hex');
  assert.equal(digest, PINNED_PRE_R0_STATE_SHA256, 'archived snapshot matches pre-R0 STATE.md byte-for-byte (zero deletion)');
  assert.equal(Buffer.byteLength(snapshot, 'utf8'), Number(meta[2]));
  assert.equal(snapshot.split('\n').length, Number(meta[3]));
  assert.equal(Number(meta[3]), 983);

  const liveStatePath = path.join(root, 'docs/continuity/STATE.md');
  const liveState = readFileSync(liveStatePath, 'utf8');
  assert.ok(statSync(liveStatePath).size < 20_000, 'live STATE.md stays under 20 KB after archival');
  assert.match(liveState, /\[STATE-ARCHIVE-2026-10\.md\]\(STATE-ARCHIVE-2026-10\.md\)/);
  assert.match(liveState, /\[NOW\.md\]\(NOW\.md\)/);
});

test('R0-03 CLAUDE.md is a thin drift-free pointer to AGENTS.md and continuity references', () => {
  const claudePath = path.join(root, 'CLAUDE.md');
  assert.ok(existsSync(claudePath), 'CLAUDE.md exists at repository root');
  assert.ok(statSync(claudePath).size < 4000, 'CLAUDE.md stays a compact shim (< 4 KB)');

  const claude = readFileSync(claudePath, 'utf8');
  for (const requiredLink of [
    '(AGENTS.md)',
    '(docs/continuity/NOW.md)',
    '(docs/continuity/STATE.md)',
    '(docs/continuity/STATE-ARCHIVE-2026-10.md)',
    '(docs/continuity/BACKLOG.md)',
    '(docs/continuity/DECISIONS.md)',
    '(docs/agent-2026-execution-plan.md)',
    '(docs/compatibility-contract.md)',
    '(.agents/skills/session-orient/SKILL.md)',
    '(.agents/skills/continuity-handoff/SKILL.md)',
    '(.agents/skills/quality-gates/SKILL.md)',
    '(.agents/skills/governed-pr-merge/SKILL.md)'
  ]) {
    assert.ok(claude.includes(requiredLink), `CLAUDE.md links to ${requiredLink}`);
  }
  assert.ok(!claude.includes('## System invariants'), 'CLAUDE.md never duplicates AGENTS.md invariant blocks');
});

test('R0-04 the 4 R0 skills have valid SKILL.md frontmatter and only reference real package.json scripts', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.now, 'node scripts/generate-now.mjs');
  assert.equal(pkg.scripts['now:check'], 'node scripts/generate-now.mjs --check');
  assert.equal(existsSync(path.join(root, 'scripts/generate_now.py')), false, 'no ad-hoc Python generator');

  const skillsDir = path.join(root, '.agents/skills');
  const folders = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(folders, EXPECTED_SKILLS);

  for (const folder of folders) {
    const text = read(`.agents/skills/${folder}/SKILL.md`);
    const fm = parseSkillFrontmatter(text);
    assert.equal(fm.name, folder, `${folder}/SKILL.md frontmatter name matches folder`);
    assert.ok(fm.description.length >= 20, `${folder}/SKILL.md carries a meaningful description`);

    for (const runMatch of text.matchAll(/\bnpm run ([a-zA-Z0-9:_-]+)/g)) {
      const scriptName = runMatch[1];
      assert.ok(Object.hasOwn(pkg.scripts, scriptName), `${folder}/SKILL.md references real npm script "${scriptName}"`);
    }
  }
});

test('R0-05 generate-now.mjs is deterministic, matches committed NOW.md, and fails --check on missing or stale output', async () => {
  const first = renderNowMarkdown(await collectNowFacts(root));
  const second = renderNowMarkdown(await collectNowFacts(root));
  assert.equal(first, second, 'generator output is byte-identical across runs');
  assert.equal(first, read(NOW_RELATIVE_PATH), 'committed NOW.md matches generator output');
  assert.equal((first.match(/`/g) || []).length % 2, 0, 'all inline backticks in NOW.md are balanced');

  const liveCheck = await syncNowFile({ root, check: true });
  assert.equal(liveCheck.ok, true);

  // Parser fallback coverage for minimal inputs
  assert.deepEqual(parseSkillFrontmatter('# No frontmatter\n'), { name: '', description: '' });
  const minimalState = parseStateSummary('# Minimal state\n');
  assert.equal(minimalState.lastReviewed, 'غير محدد');
  assert.equal(minimalState.currentFocus, 'راجع STATE.md');
  assert.equal(minimalState.latestSessionHref, null);

  // Temp workspace end-to-end test of CLI write / idempotent re-run / --check / --stdout
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'celia-r0-now-'));
  try {
    await mkdir(path.join(tmp, 'releases'), { recursive: true });
    await mkdir(path.join(tmp, 'docs/continuity/sessions'), { recursive: true });
    await writeFile(path.join(tmp, 'package.json'), read('package.json'), 'utf8');
    await writeFile(path.join(tmp, 'releases/current.json'), read('releases/current.json'), 'utf8');
    await writeFile(path.join(tmp, 'docs/continuity/STATE.md'), '# الحالة\n', 'utf8');
    await writeFile(path.join(tmp, 'docs/continuity/BACKLOG.md'), read('docs/continuity/BACKLOG.md'), 'utf8');
    await writeFile(path.join(tmp, 'docs/continuity/DECISIONS.md'), read('docs/continuity/DECISIONS.md'), 'utf8');
    await writeFile(path.join(tmp, 'docs/agent-2026-execution-plan.md'), read('docs/agent-2026-execution-plan.md'), 'utf8');

    // Missing NOW.md fails --check
    const out1 = memoryWritable();
    const err1 = memoryWritable();
    assert.equal(await runCli(['--check'], { root: tmp, stdout: out1.stream, stderr: err1.stream }), 1);
    assert.match(err1.output(), /missing/);

    // First write creates NOW.md; second write reports up-to-date
    const out2 = memoryWritable();
    assert.equal(await runCli([], { root: tmp, stdout: out2.stream, stderr: err1.stream }), 0);
    assert.match(out2.output(), /NOW generated/);

    const out3 = memoryWritable();
    assert.equal(await runCli([], { root: tmp, stdout: out3.stream, stderr: err1.stream }), 0);
    assert.match(out3.output(), /NOW up-to-date/);

    // Passing --check
    const out4 = memoryWritable();
    assert.equal(await runCli(['--check'], { root: tmp, stdout: out4.stream, stderr: err1.stream }), 0);
    assert.match(out4.output(), /NOW verified/);

    // --stdout prints rendered markdown
    const out5 = memoryWritable();
    assert.equal(await runCli(['--stdout'], { root: tmp, stdout: out5.stream, stderr: err1.stream }), 0);
    assert.ok(out5.output().startsWith('# اللقطة الفورية المشتقة'));

    // Mutated NOW.md fails --check
    await writeFile(path.join(tmp, NOW_RELATIVE_PATH), `${out5.output()}\n<!-- manual drift -->\n`, 'utf8');
    const err6 = memoryWritable();
    assert.equal(await runCli(['--check'], { root: tmp, stdout: out4.stream, stderr: err6.stream }), 1);
    assert.match(err6.output(), /out of date/);

    await unlink(path.join(tmp, NOW_RELATIVE_PATH));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('R0-06 R0 stays strictly inside scope: CONT-004 is recorded and R1 / MCP-001..002 / gh-aw remain untouched', () => {
  const backlog = read('docs/continuity/BACKLOG.md');
  assert.match(backlog, /^\| CONT-004 \| P1 \| متحقق/m);
  assert.match(backlog, /^\| MCP-001 \| P1 \| مخطط \|/m, 'MCP-001 stays planned (out of R0 scope)');
  assert.match(backlog, /^\| MCP-002 \| P1 \| مخطط \|/m, 'MCP-002 stays planned (out of R0 scope)');

  const workflowNames = readdirSync(path.join(root, '.github/workflows'));
  assert.equal(
    workflowNames.some((name) => /gh-aw|agentic/i.test(name)),
    false,
    'no gh-aw workflow added during R0'
  );
  assert.equal(existsSync(path.join(root, '.github/aw')), false, 'no .github/aw directory added during R0');
});
