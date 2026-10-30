/**
 * CRIT-01 — Static guard preventing GitHub Actions shell injection in `run:` steps.
 *
 * Hard-fails on any `${{ inputs.* }}` or `${{ github.event* }}` (both `.` and `_`
 * forms, e.g. `github.event.issue.title` and `github.event_name`) inside `run:`
 * blocks across all `.github/workflows/*.yml`, covering inline single-line/multiline
 * `run:` values and YAML block scalars (`|`, `|-`, `|+`, `>`, `>-`, `>+`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = path.join(root, '.github', 'workflows');

const REMEDIATION_HINT =
  'Use env: indirection — e.g. `EVENT_NAME: ${{ github.event_name }}` then `if [ "$EVENT_NAME" = "workflow_dispatch" ]` in the run: block.';

const BLOCK_SCALAR_HEADER = /^[|>](?:[-+]|[1-9][-+]?|[-+][1-9])?(?:\s+#.*)?$/;

/**
 * Extracts every `run:` script block from a GitHub Actions workflow YAML file
 * without external dependencies.
 */
export function extractRunBlocks(yamlText, file = '<inline>') {
  const lines = String(yamlText).replace(/\r\n/g, '\n').split('\n');
  const blocks = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;

    const match = /^(\s*(?:-\s+)?)run\s*:(.*)$/.exec(line);
    if (!match) continue;

    const keyIndent = match[1].length;
    const rawRest = match[2].trim();
    const startLine = i + 1;

    if (BLOCK_SCALAR_HEADER.test(rawRest)) {
      const bodyLines = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const nextLine = lines[j];
        if (/^\s*$/.test(nextLine)) {
          bodyLines.push({ lineNumber: j + 1, text: nextLine });
          continue;
        }
        const nextIndent = nextLine.match(/^(\s*)/)[1].length;
        if (nextIndent <= keyIndent) break;
        bodyLines.push({ lineNumber: j + 1, text: nextLine });
      }
      blocks.push({
        file,
        kind: 'block',
        startLine,
        text: bodyLines.map((entry) => entry.text).join('\n'),
        lines: bodyLines
      });
      i = j - 1;
      continue;
    }

    const inlineLines = [{ lineNumber: startLine, text: match[2] }];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const nextLine = lines[j];
      if (/^\s*$/.test(nextLine)) break;
      const nextIndent = nextLine.match(/^(\s*)/)[1].length;
      if (nextIndent <= keyIndent) break;
      if (/^\s*#/.test(nextLine)) continue;
      inlineLines.push({ lineNumber: j + 1, text: nextLine });
    }
    blocks.push({
      file,
      kind: 'inline',
      startLine,
      text: inlineLines.map((entry) => entry.text).join('\n'),
      lines: inlineLines
    });
    i = j - 1;
  }

  return blocks;
}

export function scanWorkflowRunBlocks(blocks) {
  const violations = [];
  for (const block of blocks) {
    for (const entry of block.lines) {
      if (/\$\{\{\s*inputs\./.test(entry.text)) {
        violations.push(
          `${block.file}:${entry.lineNumber}: forbidden \${{ inputs.* }} inside run: (${block.kind}) -> ${entry.text.trim()}\n  ${REMEDIATION_HINT}`
        );
      }
      if (/\$\{\{\s*github\.event/.test(entry.text)) {
        violations.push(
          `${block.file}:${entry.lineNumber}: forbidden \${{ github.event* }} inside run: (${block.kind}) -> ${entry.text.trim()}\n  ${REMEDIATION_HINT}`
        );
      }
    }
  }
  return violations;
}

test('CRIT-01: no GitHub Actions workflow interpolates ${{ inputs.* }} or ${{ github.event* }} inside run: blocks', () => {
  const files = fs
    .readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
  assert.ok(files.length >= 10, `expected at least 10 workflow files, found ${files.length}`);

  const allBlocks = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
    allBlocks.push(...extractRunBlocks(content, `.github/workflows/${file}`));
  }
  assert.ok(allBlocks.length > 0, 'scanner must extract run: blocks from workflows');

  const violations = scanWorkflowRunBlocks(allBlocks);
  assert.deepEqual(
    violations,
    [],
    `Shell-injection-prone GitHub Actions expressions found in run: blocks:\n${violations.join('\n')}`
  );
});

test('CRIT-01 scanner: detects inline and all YAML block-scalar forms (|, |-, |+, >, >-, >+) while allowing env: indirection', () => {
  const vulnerableYaml = `
jobs:
  build:
    steps:
      - name: Safe env indirection
        env:
          INPUT_MIN_RATE: \${{ inputs.min_rate }}
          EVENT_NAME: \${{ github.event_name }}
          BASE_SHA: \${{ github.event.pull_request.base.sha }}
        run: |
          if [ "$EVENT_NAME" = "workflow_dispatch" ]; then
            echo "$INPUT_MIN_RATE $BASE_SHA"
          fi
      - run: node scripts/a.mjs --rate \${{ inputs.min_rate }}
      - name: Folded chomp
        run: >-
          node scripts/b.mjs
          \${{ inputs.plan_only && '--plan' || '' }}
      - name: Literal keep
        run: |+
          if [ "\${{ github.event_name }}" = "issues" ]; then
            echo "\${{ github.event.issue.title }}"
          fi
`;
  const blocks = extractRunBlocks(vulnerableYaml, 'synthetic.yml');
  assert.equal(blocks.length, 4);
  const violations = scanWorkflowRunBlocks(blocks);
  assert.equal(violations.length, 4);
  assert.ok(violations.some((v) => v.includes('inputs.*') && v.includes('(inline)')));
  assert.ok(violations.some((v) => v.includes('inputs.*') && v.includes('(block)')));
  assert.ok(violations.some((v) => v.includes('github.event*') && v.includes('github.event_name')));
  assert.ok(violations.some((v) => v.includes('github.event*') && v.includes('github.event.issue.title')));
  assert.ok(violations.every((v) => v.includes(REMEDIATION_HINT)));
});
