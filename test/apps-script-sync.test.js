/**
 * AS-01…AS-15 — اختبارات `apps-script:sync` (GOOG-006 / DEC-142).
 *
 * كل اختبار يبني نسخة clasp اصطناعية في مجلد مؤقت ويعمل عليها؛ لا يلمس
 * `~/celia-apps` ولا `apps-script/` في المستودع ولا يكتب إلى جذر المستودع.
 * البوابات المثبتة هنا: المعاينة لا تكتب، الحذف لا يُطبق إلا بـ --accept،
 * ملفات الاعتماد لا تُنسخ ولا تُحذف، فحص الأسرار يمنع الكل-أو-لا-شيء،
 * الروابط الرمزية تُرفض، الوجهات الخطرة تُرفض، والتحقق بعد التطبيق حقيقي.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DEST,
  applyProject,
  diffTrees,
  discoverProjects,
  expandHome,
  guardDest,
  inspectSource,
  isExcludedFile,
  parseArgs,
  renderFileChange,
  runSync,
  unifiedDiff,
  walkTree
} from '../scripts/apps-script-sync.mjs';

const script = fileURLToPath(new URL('../scripts/apps-script-sync.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'celia-apps-script-'));
  const source = path.join(root, 'celia-apps');
  const dest = path.join(root, 'repo', 'apps-script');
  mkdirSync(source, { recursive: true });
  return { root, source, dest };
}

function writeProject(source, name, files = { 'Code.js': 'function hello() {}\n' }, scriptId = 'script-id-123') {
  const dir = path.join(source, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.clasp.json'), JSON.stringify({ scriptId, rootDir: '.' }));
  writeFileSync(path.join(dir, 'appsscript.json'), JSON.stringify({ timeZone: 'Africa/Cairo', runtimeVersion: 'V8' }, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: tmpdir(),
    env: { ...process.env, CELIA_APPS_SCRIPTS_DIR: '', ...env },
    encoding: 'utf8'
  });
}

test('AS-01 — preview never writes and exits 1 when differences exist', async () => {
  const { root, source, dest } = makeFixture();
  try {
    writeProject(source, 'proj-a');
    const { report, code } = await runSync({ source, dest });
    assert.equal(code, 1);
    assert.equal(report.mode, 'preview');
    assert.equal(report.projects[0].status, 'changes');
    assert.deepEqual(report.projects[0].added.sort(), ['.clasp.json', 'Code.js', 'appsscript.json']);
    assert.equal(existsSync(dest), false, 'preview must not create the destination');
    const cli = runCli(['--pull', '--source', source, '--dest', dest]);
    assert.equal(cli.status, 1);
    assert.match(cli.stdout, /review the diff above/);
    assert.equal(existsSync(dest), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AS-02 — accept applies additions, modifications and deletions, then verifies', async () => {
  const { root, source, dest } = makeFixture();
  try {
    const dir = writeProject(source, 'proj-a', { 'Code.js': 'v1\n', 'old.js': 'gone\n' });
    let out = await runSync({ source, dest, accept: true });
    assert.equal(out.code, 0);
    assert.equal(out.report.projects[0].status, 'applied');
    assert.equal(readFileSync(path.join(dest, 'proj-a', 'Code.js'), 'utf8'), 'v1\n');

    writeFileSync(path.join(dir, 'Code.js'), 'v2\n');
    rmSync(path.join(dir, 'old.js'));
    writeFileSync(path.join(dir, 'new.js'), 'fresh\n');
    out = await runSync({ source, dest, accept: true });
    assert.equal(out.code, 0);
    assert.deepEqual(out.report.projects[0].modified, ['Code.js']);
    assert.deepEqual(out.report.projects[0].deleted, ['old.js']);
    assert.deepEqual(out.report.projects[0].added, ['new.js']);
    assert.equal(readFileSync(path.join(dest, 'proj-a', 'Code.js'), 'utf8'), 'v2\n');
    assert.equal(existsSync(path.join(dest, 'proj-a', 'old.js')), false);
    assert.equal(readFileSync(path.join(dest, 'proj-a', 'new.js'), 'utf8'), 'fresh\n');

    out = await runSync({ source, dest });
    assert.equal(out.code, 0);
    assert.equal(out.report.projects[0].status, 'in-sync');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AS-03 — deletions are previewed but only applied with accept; empty dirs pruned, project root kept', async () => {
  const { root, source, dest } = makeFixture();
  try {
    const dir = writeProject(source, 'proj-a', { 'sub/deep/leaf.js': 'x\n' });
    await runSync({ source, dest, accept: true });
    rmSync(path.join(dir, 'sub/deep/leaf.js'));

    const preview = await runSync({ source, dest });
    assert.equal(preview.code, 1);
    assert.deepEqual(preview.report.projects[0].deleted, ['sub/deep/leaf.js']);
    assert.equal(existsSync(path.join(dest, 'proj-a', 'sub/deep/leaf.js')), true, 'preview must not delete');

    const applied = await runSync({ source, dest, accept: true });
    assert.equal(applied.code, 0);
    assert.equal(existsSync(path.join(dest, 'proj-a', 'sub/deep/leaf.js')), false);
    assert.equal(existsSync(path.join(dest, 'proj-a', 'sub')), false, 'empty subdirs pruned');
    assert.equal(existsSync(path.join(dest, 'proj-a')), true, 'project root kept');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AS-04 — credential files are excluded on both sides: never copied, never deletion candidates', async () => {
  const { root, source, dest } = makeFixture();
  try {
    const dir = writeProject(source, 'proj-a');
    for (const name of ['.clasprc.json', '.clasprc.local.json', '.env', '.env.production', 'credentials.json', 'token.json', 'client_secret_123.json', 'service-account-prod.json', 'key.pem', 'private.p12', 'server.key', '.DS_Store']) {
      writeFileSync(path.join(dir, name), 'sensitive\n');
    }
    assert.equal(isExcludedFile('.clasprc.json'), true);
    assert.equal(isExcludedFile('.env.local'), true);
    assert.equal(isExcludedFile('Code.js'), false);
    assert.equal(isExcludedFile('appsscript.json'), false);

    const out = await runSync({ source, dest, accept: true });
    assert.equal(out.code, 0);
    assert.equal(out.report.projects[0].excluded.length, 12);
    for (const name of ['.clasprc.json', '.env', 'token.json', 'key.pem']) {
      assert.equal(existsSync(path.join(dest, 'proj-a', name)), false, `${name} must never be copied`);
    }
    assert.equal(existsSync(path.join(dest, 'proj-a', 'Code.js')), true);

    // ملف اعتماد موجود في الوجهة: لا يُحذف ولا يُبلغ كفرق.
    mkdirSync(path.join(dest, 'proj-a'), { recursive: true });
    writeFileSync(path.join(dest, 'proj-a', '.clasprc.json'), 'dest-side\n');
    const after = await runSync({ source, dest, accept: true });
    assert.equal(after.code, 0);
    assert.equal(after.report.projects[0].status, 'in-sync');
    assert.deepEqual(after.report.projects[0].destExcluded, ['.clasprc.json']);
    assert.equal(existsSync(path.join(dest, 'proj-a', '.clasprc.json')), true, 'dest credential file must not be deleted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AS-05 — a secret in any source file blocks the whole apply (all-or-nothing), value never printed', async () => {
  const { root, source, dest } = makeFixture();
  try {
    writeProject(source, 'clean-proj', { 'Code.js': 'clean\n' });
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    writeProject(source, 'dirty-proj', { 'Code.js': `const key = "${secret}";\n` });

    const preview = await runSync({ source, dest });
    assert.equal(preview.code, 2);
    const dirty = preview.report.projects.find((p) => p.name === 'dirty-proj');
    assert.equal(dirty.status, 'refused');
    assert.ok(dirty.refusals.some((r) => r.reason === 'secret:aws_key'));
    assert.equal(JSON.stringify(preview).includes(secret), false, 'secret value must never appear in the report');

    const applied = await runSync({ source, dest, accept: true });
    assert.equal(applied.code, 2);
    assert.equal(applied.report.projects.find((p) => p.name === 'clean-proj').status, 'blocked');
    assert.equal(existsSync(path.join(dest, 'clean-proj')), false, 'clean project must not be applied when another is blocked');
    assert.equal(existsSync(path.join(dest, 'dirty-proj')), false);

    const cli = runCli(['--pull', '--accept', '--source', source, '--dest', dest]);
    assert.equal(cli.status, 2);
    assert.equal(cli.stdout.includes(secret), false);
    assert.equal(cli.stderr.includes(secret), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AS-06 — symlinks are refused in source, destination and discovery (fail closed)', async () => {
  const { root, source, dest } = makeFixture();
  try {
    const dir = writeProject(source, 'proj-a');
    const outside = path.join(root, 'outside.txt');
    writeFileSync(outside, 'outside\n');
    symlinkSync(outside, path.join(dir, 'link.js'));
    let out = await runSync({ source, dest, accept: true });
    assert.equal(out.code, 2);
    assert.ok(out.report.projects[0].refusals.some((r) => r.reason === 'symlink'));
    assert.equal(existsSync(path.join(dest, 'proj-a')), false);

    rmSync(path.join(dir, 'link.js'));
    await runSync({ source, dest, accept: true });
    symlinkSync(outside, path.join(dest, 'proj-a', 'evil.js'));
    out = await runSync({ source, dest, accept: true });
    assert.equal(out.code, 2);
    assert.ok(out.report.projects[0].refusals.some((r) => r.file.startsWith('(destination)') && r.reason === 'symlink'));
    assert.equal(readFileSync(outside, 'utf8'), 'outside\n', 'write must not be redirected through the symlink');

    rmSync(path.join(dest, 'proj-a', 'evil.js'));
    symlinkSync(dir, path.join(source, 'linked-proj'));
    const discovered = await discoverProjects(source);
    assert.ok(discovered.warnings.some((w) => w.project === 'linked-proj' && w.reason === 'symlink'));
    assert.equal(discovered.projects.some((p) => p.name === 'linked-proj'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AS-07 — destination guard refuses repo root, ancestors and protected dirs', async () => {
  const { root, source, dest } = makeFixture();
  try {
    writeProject(source, 'proj-a');
    assert.throws(() => guardDest(repoRoot), /repository root/);
    assert.throws(() => guardDest(path.dirname(repoRoot)), /ancestor/);
    assert.throws(() => guardDest(path.join(repoRoot, '.git')), /refusing/);
    assert.throws(() => guardDest(path.join(repoRoot, 'src', 'nested')), /refusing/);
    assert.throws(() => guardDest(path.join(repoRoot, 'scripts')), /refusing/);
    assert.throws(() => guardDest(path.join(repoRoot, 'test')), /refusing/);
    assert.throws(() => guardDest(path.join(repoRoot, 'node_modules')), /refusing/);
    assert.equal(guardDest(dest), path.resolve(dest));
    await assert.rejects(runSync({ source, dest: repoRoot }), /repository root/);
    const cli = runCli(['--pull', '--source', source, '--dest', path.join(repoRoot, 'src')]);
    assert.equal(cli.status, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AS-08 — discovery: root-level clone, subdirectory clones, and no-projects guidance', async () => {
  const { root, source, dest } = makeFixture();
  try {
    await assert.rejects(runSync({ source, dest }), /no clasp projects found/);
    await assert.rejects(runSync({ source: path.join(root, 'missing'), dest }), /source directory not found/);

    writeProject(source, 'proj-a');
    writeProject(source, 'proj-b');
    mkdirSync(path.join(source, 'not-a-project'));
    let out = await runSync({ source, dest });
    assert.deepEqual(out.report.projects.map((p) => p.name).sort(), ['proj-a', 'proj-b']);

    // جذر هو نفسه نسخة clasp (clasp clone داخل المجلد مباشرة).
    const solo = path.join(root, 'solo-clone');
    writeProject(root, 'solo-clone');
    out = await runSync({ source: solo, dest });
    assert.deepEqual(out.report.projects.map((p) => p.name), ['solo-clone']);
    assert.equal(out.report.projects[0].scriptId, 'script-id-123');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AS-09 — malformed .clasp.json and invalid project names are refused', async () => {
  const { root, source, dest } = makeFixture();
  try {
    const dir = writeProject(source, 'proj-a');
    writeFileSync(path.join(dir, '.clasp.json'), '{not json');
    let out = await runSync({ source, dest, accept: true });
    assert.equal(out.code, 2);
    assert.ok(out.report.projects[0].refusals.some((r) => r.file === '.clasp.json' && r.reason === 'malformed'));
    assert.equal(existsSync(path.join(dest, 'proj-a')), false);

    writeFileSync(path.join(dir, '.clasp.json'), JSON.stringify({ rootDir: '.' }));
    out = await runSync({ source, dest });
    assert.ok(out.report.projects[0].refusals.some((r) => r.reason === 'malformed'), 'missing scriptId is malformed');

    const badName = path.join(source, '.hidden');
    mkdirSync(badName, { recursive: true });
    writeFileSync(path.join(badName, '.clasp.json'), JSON.stringify({ scriptId: 'x' }));
    out = await runSync({ source, dest, project: '.hidden' });
    assert.equal(out.code, 2);
    assert.ok(out.report.projects[0].refusals.some((r) => r.reason === 'invalid-name'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AS-10 — binary source files refuse the project; large binary diffs stay summary-only', async () => {
  const { root, source, dest } = makeFixture();
  try {
    const dir = writeProject(source, 'proj-a');
    writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]));
    const out = await runSync({ source, dest, accept: true });
    assert.equal(out.code, 2);
    assert.ok(out.report.projects[0].refusals.some((r) => r.file === 'blob.bin' && r.reason === 'binary'));
    assert.equal(existsSync(path.join(dest, 'proj-a')), false);

    const lines = renderFileChange('big.js', 'modified', Buffer.from('a\n'.repeat(3000)), Buffer.from('b\n'.repeat(3000)));
    assert.match(lines.join('\n'), /too large to diff/);
    const binary = renderFileChange('blob.bin', 'added', null, Buffer.from([0x00, 0x01]));
    assert.match(binary.join('\n'), /binary content/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AS-11 — destination-only projects are reported, never deleted', async () => {
  const { root, source, dest } = makeFixture();
  try {
    writeProject(source, 'proj-a');
    mkdirSync(path.join(dest, 'orphan-proj'), { recursive: true });
    writeFileSync(path.join(dest, 'orphan-proj', 'Code.js'), 'orphan\n');
    writeFileSync(path.join(dest, 'README.md'), 'kept\n');

    const out = await runSync({ source, dest, accept: true });
    assert.equal(out.code, 0);
    assert.deepEqual(out.report.missingFromSource, ['orphan-proj']);
    assert.equal(existsSync(path.join(dest, 'orphan-proj', 'Code.js')), true, 'orphan project must survive');
    assert.equal(existsSync(path.join(dest, 'README.md')), true, 'dest root README must survive');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AS-12 — CLI contract: --json is one parseable object, exit codes, flag validation', async () => {
  const { root, source, dest } = makeFixture();
  try {
    writeProject(source, 'proj-a');
    const json = runCli(['--pull', '--source', source, '--dest', dest, '--json']);
    assert.equal(json.status, 1);
    const report = JSON.parse(json.stdout);
    assert.equal(report.tool, 'apps-script:sync');
    assert.equal(report.direction, 'pull');
    assert.equal(report.exitCode, 1);

    assert.equal(runCli(['--help']).status, 0);
    assert.equal(runCli([]).status, 2, 'no direction');
    assert.equal(runCli(['--accept']).status, 2, 'accept without pull');
    assert.equal(runCli(['--push']).status, 2, 'push refused');
    assert.match(runCli(['--push']).stderr, /clasp push/);
    assert.equal(runCli(['--bogus']).status, 2);
    assert.equal(runCli(['--pull', '--source']).status, 2, 'missing value');
    assert.equal(runCli(['--pull', '--source', source, '--dest', dest, '--project', 'nope']).status, 2);

    const envRun = runCli(['--pull', '--dest', dest, '--json'], { CELIA_APPS_SCRIPTS_DIR: source });
    assert.equal(envRun.status, 1);
    assert.equal(JSON.parse(envRun.stdout).source, path.resolve(source));

    const badJson = runCli(['--pull', '--source', path.join(root, 'missing'), '--dest', dest, '--json']);
    assert.equal(badJson.status, 2);
    assert.equal(JSON.parse(badJson.stdout).exitCode, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AS-13 — unifiedDiff: context, hunks, identical texts, bounded size', () => {
  assert.equal(unifiedDiff('a\nb\nc', 'a\nb\nc'), '');
  const base = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n').replace('l3', 'c').replace('l18', 'r');
  const diff = unifiedDiff(base, base.replace('c', 'C').replace('r', 'R'));
  assert.match(diff, /@@ -1,6 \+1,6 @@/);
  assert.match(diff, /-c\n\+C/);
  assert.match(diff, /@@ -15,6 \+15,6 @@/);
  assert.match(diff, /-r\n\+R/);
  assert.equal(unifiedDiff('', 'new\nline'), '@@ -0,0 +1,2 @@\n+new\n+line');
  assert.equal(unifiedDiff('gone\nline', ''), '@@ -1,2 +0,0 @@\n-gone\n-line');
  assert.equal(unifiedDiff('x'.repeat(10) + '\n' + 'a\n'.repeat(2000), 'x'.repeat(10) + '\n' + 'b\n'.repeat(2000)), null);
  const added = renderFileChange('Code.js', 'added', null, Buffer.from('function hello() {}\n'));
  assert.match(added.join('\n'), /\+function hello/);
  const deleted = renderFileChange('Old.js', 'deleted', Buffer.from('gone\n'), null);
  assert.match(deleted.join('\n'), /-gone/);
});

test('AS-14 — diffTrees, inspectSource, expandHome, parseArgs and applyProject path guard', async () => {
  const src = new Map([['a', Buffer.from('1')], ['b', Buffer.from('2')], ['c', Buffer.from('3')]]);
  const dst = new Map([['b', Buffer.from('X')], ['c', Buffer.from('3')], ['d', Buffer.from('4')]]);
  const diff = diffTrees(src, dst);
  assert.deepEqual(diff.added, ['a']);
  assert.deepEqual(diff.modified, ['b']);
  assert.deepEqual(diff.deleted, ['d']);
  assert.deepEqual(diff.unchanged, ['c']);

  assert.deepEqual(inspectSource(new Map([['ok.js', Buffer.from('clean')]])), []);
  assert.deepEqual(inspectSource(new Map([['k.js', Buffer.from('password = hunter2hunter2')]])), [{ file: 'k.js', reason: 'secret:generic_secret' }]);
  assert.deepEqual(inspectSource(new Map([['b.bin', Buffer.from([0xff, 0xfe, 0x00])]])), [{ file: 'b.bin', reason: 'binary' }]);

  assert.equal(expandHome('~/x'), path.join(process.env.HOME, 'x'));
  assert.equal(expandHome('/abs'), '/abs');
  assert.equal(expandHome(42), 42);

  const args = parseArgs(['--pull', '--accept', '--source', '/s', '--dest', '/d', '--project', 'p', '--json']);
  assert.deepEqual(
    { pull: args.pull, accept: args.accept, source: args.source, dest: args.dest, project: args.project, json: args.json },
    { pull: true, accept: true, source: '/s', dest: '/d', project: 'p', json: true }
  );
  assert.equal(parseArgs([]).dest, DEFAULT_DEST);
  assert.throws(() => parseArgs(['--dest', '--pull']), /needs a value/);

  const { root, dest } = makeFixture();
  try {
    await assert.rejects(
      applyProject({ projectDest: path.join(dest, 'p'), srcFiles: new Map([['../escape.js', Buffer.from('x')]]), diff: { added: ['../escape.js'], modified: [], deleted: [] } }),
      /escapes the project directory/
    );
    assert.equal(existsSync(path.join(dest, 'escape.js')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AS-15 — walkTree mirrors rootDir subtrees and skips node_modules/.git; --project filters', async () => {
  const { root, source, dest } = makeFixture();
  try {
    const dir = writeProject(source, 'proj-a', { 'src/nested/Deep.js': 'deep\n', 'Code.js': 'top\n' });
    mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'dep\n');
    mkdirSync(path.join(dir, '.git'), { recursive: true });
    writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref\n');
    writeProject(source, 'proj-b', { 'Code.js': 'b\n' });

    const walked = await walkTree(dir);
    assert.deepEqual([...walked.files.keys()].sort(), ['.clasp.json', 'Code.js', 'appsscript.json', 'src/nested/Deep.js']);

    const out = await runSync({ source, dest, project: 'proj-a', accept: true });
    assert.equal(out.code, 0);
    assert.deepEqual(out.report.projects.map((p) => p.name), ['proj-a']);
    assert.equal(readFileSync(path.join(dest, 'proj-a', 'src/nested/Deep.js'), 'utf8'), 'deep\n');
    assert.equal(existsSync(path.join(dest, 'proj-a', 'node_modules')), false);
    assert.equal(existsSync(path.join(dest, 'proj-a', '.git')), false);
    assert.equal(existsSync(path.join(dest, 'proj-b')), false, 'filter must not sync other projects');
    assert.deepEqual(out.report.missingFromSource, [], 'filtered-out source projects are not missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
