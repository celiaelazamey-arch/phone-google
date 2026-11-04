/**
 * AS-09..AS-16 — حراسة التزامن بين المستودع ومحرّر Apps Script.
 *
 * الفكرة: بعد أول لصق، تصبح هناك **نسختان من الحقيقة** — واحدة في Git وأخرى في Drive. أي تعديل
 * في المحرّر يجعل الواحدة تسبق الأخرى بلا إشعار. هذا الاختبار يجعل الانحراف **مقيسًا وفاشلًا**،
 * ولا يدّعي أنه يمنع التعديل في Drive (لا يمكن منع ذلك تقنيًا) بل يمنع أن يمرّ **غير مرئي**.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT,
  LOCK,
  MANIFEST,
  REQUIRED_SCOPES,
  auditManifest,
  auditSecrets,
  diffAgainstLock,
  fingerprintTree,
  projectFiles
} from '../scripts/apps-script-sync.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (rel) => path.join(root, rel);

test('AS-09 the lock matches the files on disk, so drift is a failing check and not a surprise', () => {
  const lock = JSON.parse(readFileSync(at(LOCK), 'utf8'));
  const tree = fingerprintTree(at(ROOT));
  assert.deepEqual(diffAgainstLock(tree, lock), [], 'run `npm run apps-script:sync -- --push` only after a real push');
  assert.ok(tree.files.length >= 4, 'three scripts plus the manifest');
  assert.ok(tree.files.includes('appsscript.json'), 'the manifest is part of the deployed project');
});

test('AS-10 a file edited in the Apps Script editor is caught, not silently accepted', () => {
  const lock = { files: { 'keepalive.gs': 'a'.repeat(64), 'deep-check.gs': 'b'.repeat(64) } };
  const changed = diffAgainstLock({ files: ['keepalive.gs', 'deep-check.gs'], hashes: { 'keepalive.gs': 'c'.repeat(64), 'deep-check.gs': 'b'.repeat(64) } }, lock);
  assert.deepEqual(changed, [{ kind: 'changed', file: 'keepalive.gs' }], 'one drifted file is named exactly');
});

test('AS-11 a file added only in Drive, or deleted from Git, is caught too', () => {
  const lock = { files: { 'keepalive.gs': 'a'.repeat(64), 'old.gs': 'b'.repeat(64) } };
  const problems = diffAgainstLock({ files: ['keepalive.gs', 'new.gs'], hashes: { 'keepalive.gs': 'a'.repeat(64), 'new.gs': 'd'.repeat(64) } }, lock);
  assert.deepEqual(problems.sort((x, y) => x.kind.localeCompare(y.kind)), [
    { kind: 'missing', file: 'old.gs' },   // in the lock, gone from disk
    { kind: 'unlocked', file: 'new.gs' }   // on disk, never declared
  ]);
  // A deleted file must not pass just because nothing remained to compare.
  assert.equal(diffAgainstLock({ files: [], hashes: {} }, lock).length, 2);
});

test('AS-12 the manifest grants exactly the three scopes the code uses, and nothing broader', () => {
  const manifest = JSON.parse(readFileSync(at(MANIFEST), 'utf8'));
  assert.deepEqual(auditManifest(manifest), [], 'the committed manifest must be minimal and complete');
  assert.deepEqual(manifest.oauthScopes.slice().sort(), REQUIRED_SCOPES.slice().sort());
  assert.equal(manifest.runtimeVersion, 'V8', 'the scripts use let/const');
  assert.ok(manifest.timeZone, 'triggers depend on a timezone');
});

test('AS-13 a broadened permission request is refused before it reaches the owner', () => {
  const broadened = { ...JSON.parse(readFileSync(at(MANIFEST), 'utf8')) };
  broadened.oauthScopes = [...broadened.oauthScopes, 'https://www.googleapis.com/auth/drive'];
  const problems = auditManifest(broadened);
  assert.ok(problems.some((p) => p.kind === 'scope-too-broad' && p.scope.endsWith('/auth/drive')));

  const narrowed = { ...JSON.parse(readFileSync(at(MANIFEST), 'utf8')) };
  narrowed.oauthScopes = narrowed.oauthScopes.filter((s) => !s.includes('send_mail'));
  assert.ok(auditManifest(narrowed).some((p) => p.kind === 'scope-missing'), 'a missing scope is a broken deploy, not a stricter one');
});

test('AS-14 no credential pattern survives into the deployed project', () => {
  const clean = readFileSync(at(`${ROOT}/keepalive.gs`), 'utf8');
  assert.deepEqual(auditSecrets(clean), [], 'the shipped script carries no secret');

  assert.equal(auditSecrets(`var token = 'Bearer abcdefghijklmnopqrstuvwxyz012345';`).length, 1);
  assert.equal(auditSecrets(`var k = 'AIza${'a'.repeat(35)}';`).length, 1);
  assert.equal(auditSecrets(`{"SERVICE_URL":"https://real.example"}`).length, 1, 'a committed URL literal is configuration hiding as code');
});

test('AS-15 only deliverable files are pushed: no README, no test, no stray directory', () => {
  const files = projectFiles(at(ROOT));
  assert.equal(files.some((name) => name.endsWith('.md')), false);
  assert.equal(files.some((name) => name.startsWith('test')), false);
  assert.ok(files.every((name) => name.endsWith('.gs') || name === 'appsscript.json'));
});

test('AS-16 the fingerprint is deterministic and sensitive to a single byte', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'apps-script-'));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'a.gs'), 'function a() { return 1; }\n');
    const first = fingerprintTree(dir);
    const second = fingerprintTree(dir);
    assert.deepEqual(first, second, 'same bytes, same fingerprint');

    writeFileSync(path.join(dir, 'a.gs'), 'function a() { return 2; }\n');
    const changed = fingerprintTree(dir);
    assert.notEqual(first.hashes['a.gs'], changed.hashes['a.gs'], 'one character must be detectable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
