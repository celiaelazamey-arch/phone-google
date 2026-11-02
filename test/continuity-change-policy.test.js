import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDependabotActionPinOnly } from '../scripts/continuity-change-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const artifactDiff = `diff --git a/.github/workflows/agent-branch-pages.yml b/.github/workflows/agent-branch-pages.yml
index 1234567..abcdef0 100644
--- a/.github/workflows/agent-branch-pages.yml
+++ b/.github/workflows/agent-branch-pages.yml
@@ -78 +78 @@ jobs:
-      - uses: actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f # v6.0.0
+      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2`;

const codeqlDiff = `diff --git a/.github/workflows/codeql.yml b/.github/workflows/codeql.yml
index 1234567..abcdef0 100644
--- a/.github/workflows/codeql.yml
+++ b/.github/workflows/codeql.yml
@@ -37 +37 @@ jobs:
-      - uses: github/codeql-action/init@4bfa242aa49c5f7c6770b98670d354a7dfac05f8 # v3
+      - uses: github/codeql-action/init@9b3254085494b55a0f7c4c2b3d2d52cc712ce370 # v4.39.1
@@ -41 +41 @@ jobs:
-      - uses: github/codeql-action/analyze@4bfa242aa49c5f7c6770b98670d354a7dfac05f8 # v3
+      - uses: github/codeql-action/analyze@9b3254085494b55a0f7c4c2b3d2d52cc712ce370 # v4.39.1`;

const oneWorkflow = ['.github/workflows/agent-branch-pages.yml'];

test('Dependabot handoff waiver accepts only paired, pinned action-version edits', () => {
  assert.equal(isDependabotActionPinOnly({ author: 'app/dependabot', paths: oneWorkflow, diff: artifactDiff }), true);
  assert.equal(isDependabotActionPinOnly({ author: 'dependabot[bot]', paths: ['.github/workflows/codeql.yml'], diff: codeqlDiff }), true);
});

test('the waiver rejects human edits, mixed files, and workflow logic changes', () => {
  assert.equal(isDependabotActionPinOnly({ author: 'celiaelazamey-arch', paths: oneWorkflow, diff: artifactDiff }), false);
  assert.equal(isDependabotActionPinOnly({ author: 'app/dependabot', paths: [...oneWorkflow, 'src/worker.js'], diff: artifactDiff }), false);
  assert.equal(isDependabotActionPinOnly({ author: 'app/dependabot', paths: oneWorkflow, diff: `${artifactDiff}\n+      - run: echo changed logic` }), false);
  const renamed = artifactDiff
    .replace('diff --git a/.github/workflows/agent-branch-pages.yml b/.github/workflows/agent-branch-pages.yml', 'diff --git a/src/agent-branch-pages.yml b/.github/workflows/agent-branch-pages.yml')
    .replace('--- a/.github/workflows/agent-branch-pages.yml', '--- a/src/agent-branch-pages.yml');
  assert.equal(isDependabotActionPinOnly({ author: 'app/dependabot', paths: oneWorkflow, diff: renamed }), false);
});

test('the waiver rejects unpinned actions and edits that switch the action identity', () => {
  const unpinned = artifactDiff.replace('actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9', 'actions/upload-artifact@v7');
  const switched = artifactDiff.replace('actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9', 'actions/download-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9');
  assert.equal(isDependabotActionPinOnly({ author: 'app/dependabot', paths: oneWorkflow, diff: unpinned }), false);
  assert.equal(isDependabotActionPinOnly({ author: 'app/dependabot', paths: oneWorkflow, diff: switched }), false);
});

test('the quality workflow passes the trusted PR author to the narrow handoff guard', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/celia-mcp.yml'), 'utf8');
  assert.match(workflow, /CELIA_PULL_REQUEST_AUTHOR:\s*\$\{\{\s*github\.event\.pull_request\.user\.login\s*\}\}/);
});
