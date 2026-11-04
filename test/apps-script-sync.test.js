/**
 * AS-01..AS-10 — `apps-script:sync`: مزامنة clasp آمنة بين `deploy/apps-script/`
 * ونسخة العمل `~/celia-apps`.
 *
 * القاعدة المحروسة: **لا تُقال «متزامن» عن شيء لم يُقَس فرقه، ولا يُطبَّق فرق بلا `--accept`**.
 * كل اختبار يعمل على مجلدات مؤقتة حقيقية و`exec` وهمي يحاكي `clasp pull` بكتابة ملفات —
 * فلا شبكة ولا حساب Google ولا clasp حقيقي في CI أبدًا.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  APPS_SCRIPT_SYNC_VERSION,
  assessPrerequisites,
  diffSnapshots,
  hashContent,
  maskScriptId,
  parseArgs,
  runAppsScriptSync,
  scanForSecrets,
  snapshotTree
} from '../scripts/apps-script-sync.mjs';

async function makeTrees(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'celia-apps-script-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const localDir = path.join(root, 'repo', 'deploy', 'apps-script');
  const workDir = path.join(root, 'celia-apps');
  const homedir = path.join(root, 'home');
  await mkdir(localDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await mkdir(homedir, { recursive: true });
  await writeFile(path.join(localDir, 'Code.gs'), 'var V = 1;\n');
  await writeFile(path.join(localDir, 'appsscript.json'), '{"timeZone":"Africa/Cairo"}\n');
  return { root, localDir, workDir, homedir };
}

const noExec = () => { throw new Error('exec must not be called'); };

test('AS-01 parseArgs: الافتراضي فحص جاف، و--pull --accept صريحان لا ضمنيان', () => {
  assert.equal(APPS_SCRIPT_SYNC_VERSION, '1');
  assert.deepEqual(
    (({ mode, accept, json }) => ({ mode, accept, json }))(parseArgs([])),
    { mode: 'dry-run', accept: false, json: false }
  );
  const pull = parseArgs(['--pull', '--accept']);
  assert.equal(pull.mode, 'pull');
  assert.equal(pull.accept, true);
  assert.equal(parseArgs(['--pull']).accept, false, 'pull وحده لا يعني قبولًا أبدًا');
  assert.equal(parseArgs(['--script-id=abc123', '--work-dir', '/tmp/x']).scriptId, 'abc123');
});

test('AS-02 maskScriptId يقنّع المعرّف ولا يعيد القصير كاملًا', () => {
  assert.equal(maskScriptId('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'), '1BxiMV…upms');
  assert.equal(maskScriptId('short'), '***');
  assert.equal(maskScriptId(''), null);
  assert.equal(maskScriptId(undefined), null);
});

test('AS-03 diffSnapshots يسمّي كل نوع فرق بدل «يختلف» جملةً', async (t) => {
  const { localDir, workDir } = await makeTrees(t);
  await writeFile(path.join(workDir, 'Code.gs'), 'var V = 2;\n');            // معدّل
  await writeFile(path.join(workDir, 'appsscript.json'), '{"timeZone":"Africa/Cairo"}\n'); // مطابق
  await writeFile(path.join(workDir, 'Extra.gs'), '// remote only\n');        // مضاف عند البعيد
  // Old.gs عند المحلي فقط ⇒ removed من منظور السحب
  await writeFile(path.join(localDir, 'Old.gs'), '// local only\n');

  const diff = diffSnapshots(await snapshotTree(localDir), await snapshotTree(workDir));
  assert.equal(diff.identical, false);
  assert.deepEqual(diff.added, ['Extra.gs']);
  assert.deepEqual(diff.removed, ['Old.gs']);
  assert.deepEqual(diff.changed, ['Code.gs']);
  assert.deepEqual(diff.unchanged, ['appsscript.json']);

  const same = diffSnapshots(await snapshotTree(localDir), await snapshotTree(localDir));
  assert.equal(same.identical, true);
  assert.equal(hashContent(Buffer.from('x')), hashContent(Buffer.from('x')));
  assert.notEqual(hashContent(Buffer.from('x')), hashContent(Buffer.from('y')));
});

test('AS-04 الفحص الجاف بلا نسخة عمل: not-configured بأفعال مالك مسمّاة، وصفر استدعاء exec وصفر كتابة', async (t) => {
  const { root, localDir, homedir } = await makeTrees(t);
  const before = await readFile(path.join(localDir, 'Code.gs'), 'utf8');
  const report = await runAppsScriptSync({
    argv: [], homedir, repoRoot: path.join(root, 'repo'),
    localDirUnused: undefined,
    exec: noExec,
    // localDir الافتراضي = repoRoot/deploy/apps-script — نمرّر repoRoot مطابقًا لبنيتنا
    env: {}
  }).catch((e) => e);
  // makeTrees يبني localDir داخل root/repo/deploy/apps-script فالافتراضي صحيح.
  assert.equal(report.verdict, 'not-configured');
  assert.equal(report.exitCode, 2);
  assert.equal(report.remoteSynced, false);
  assert.ok(report.nextOwnerActions.join(' ').includes('cp -r'), 'يسمّي خطوة النسخ للمالك');
  assert.equal(await readFile(path.join(localDir, 'Code.gs'), 'utf8'), before, 'الفحص الجاف لا يكتب');
});

test('AS-05 الفحص الجاف مع نسخة عمل مطابقة: identical وخروج 0، ومع اختلاف: differs وخروج 1', async (t) => {
  const { root, localDir, workDir, homedir } = await makeTrees(t);
  await writeFile(path.join(workDir, 'Code.gs'), 'var V = 1;\n');
  await writeFile(path.join(workDir, 'appsscript.json'), '{"timeZone":"Africa/Cairo"}\n');
  const base = { homedir, repoRoot: path.join(root, 'repo'), exec: noExec, env: {} };

  const same = await runAppsScriptSync({ ...base, argv: ['--work-dir', workDir] });
  assert.equal(same.verdict, 'identical');
  assert.equal(same.exitCode, 0);

  await writeFile(path.join(workDir, 'Code.gs'), 'var V = 9;\n');
  const differs = await runAppsScriptSync({ ...base, argv: ['--work-dir', workDir] });
  assert.equal(differs.verdict, 'differs');
  assert.equal(differs.exitCode, 1);
  assert.deepEqual(differs.diff.changed, ['Code.gs']);
  assert.equal(await readFile(path.join(localDir, 'Code.gs'), 'utf8'), 'var V = 1;\n');
});

test('AS-06 --pull بلا --accept: يسحب في نسخة العمل ويعرض الفرق ولا يلمس مصدر المستودع', async (t) => {
  const { root, localDir, workDir, homedir } = await makeTrees(t);
  await writeFile(path.join(homedir, '.clasprc.json'), '{}');
  await writeFile(path.join(workDir, '.clasp.json'), JSON.stringify({ scriptId: 'x'.repeat(30) }));
  await writeFile(path.join(workDir, 'Code.gs'), 'var V = 1;\n');
  await writeFile(path.join(workDir, 'appsscript.json'), '{"timeZone":"Africa/Cairo"}\n');

  let calls = 0;
  const exec = async (cmd, argv, opts) => {
    calls += 1;
    assert.equal(cmd, 'npx');
    assert.deepEqual(argv, ['-y', '@google/clasp', 'pull']);
    assert.equal(opts.cwd, workDir);
    await writeFile(path.join(workDir, 'Code.gs'), 'var V = 2; // pulled\n');
    return { status: 0, stdout: '', stderr: '' };
  };
  const report = await runAppsScriptSync({
    argv: ['--pull', '--work-dir', workDir], homedir, repoRoot: path.join(root, 'repo'), exec, env: {}
  });
  assert.equal(calls, 1);
  assert.equal(report.verdict, 'diff-pending-review');
  assert.equal(report.exitCode, 1);
  assert.equal(report.remoteSynced, true);
  assert.equal(report.localModified, false);
  assert.deepEqual(report.diff.changed, ['Code.gs']);
  assert.equal(await readFile(path.join(localDir, 'Code.gs'), 'utf8'), 'var V = 1;\n', 'بلا accept لا يتغير المصدر');
});

test('AS-07 --pull --accept: يطبّق بعد نسخة احتياطية، والفرق بعد القبول صفر', async (t) => {
  const { root, localDir, workDir, homedir } = await makeTrees(t);
  await writeFile(path.join(homedir, '.clasprc.json'), '{}');
  await writeFile(path.join(workDir, '.clasp.json'), JSON.stringify({ scriptId: 'y'.repeat(30) }));
  await writeFile(path.join(workDir, 'Code.gs'), 'var V = 1;\n');
  await writeFile(path.join(workDir, 'appsscript.json'), '{"timeZone":"Africa/Cairo"}\n');
  await writeFile(path.join(localDir, 'Stale.gs'), '// will be removed upstream\n');

  const exec = async (cmd, argv, opts) => {
    await writeFile(path.join(opts.cwd, 'Code.gs'), 'var V = 3; // pulled\n');
    await writeFile(path.join(opts.cwd, 'New.gs'), '// added upstream\n');
    await rm(path.join(opts.cwd, 'Stale.gs'), { force: true });
    // Stale.gs غير موجود في نسخة العمل أصلًا في هذا السيناريو؛ الحذف يُقاس من غيابه عند البعيد.
    return { status: 0, stdout: '', stderr: '' };
  };
  const report = await runAppsScriptSync({
    argv: ['--pull', '--accept', '--work-dir', workDir],
    homedir, repoRoot: path.join(root, 'repo'), exec, env: {},
    now: new Date('2026-11-04T10:00:00.000Z')
  });
  assert.equal(report.verdict, 'accepted');
  assert.equal(report.exitCode, 0);
  assert.equal(report.localModified, true);
  assert.equal(report.diffAfterAccept.identical, true);
  assert.equal(await readFile(path.join(localDir, 'Code.gs'), 'utf8'), 'var V = 3; // pulled\n');
  assert.equal(await readFile(path.join(localDir, 'New.gs'), 'utf8'), '// added upstream\n');
  assert.equal(existsSync(path.join(localDir, 'Stale.gs')), false, 'المحذوف عند البعيد يُحذف محليًا عند القبول فقط');
  assert.ok(report.backupDir.includes('.validation-artifacts'), 'النسخة الاحتياطية خارج Git');
  assert.equal(
    await readFile(path.join(report.backupDir, 'Code.gs'), 'utf8'), 'var V = 1;\n',
    'النسخة الاحتياطية تحمل ما قبل القبول حرفيًا'
  );
});

test('AS-08 --pull بلا تسجيل دخول أو بلا SCRIPT_ID: not-configured ولا يُستدعى clasp', async (t) => {
  const { root, workDir, homedir } = await makeTrees(t);
  let calls = 0;
  const exec = () => { calls += 1; return { status: 0, stdout: '', stderr: '' }; };
  const report = await runAppsScriptSync({
    argv: ['--pull', '--work-dir', workDir], homedir, repoRoot: path.join(root, 'repo'), exec, env: {}
  });
  assert.equal(report.verdict, 'not-configured');
  assert.equal(report.exitCode, 2);
  assert.equal(calls, 0, 'النقص يوقف قبل أي استدعاء خارجي');
  const codes = report.prerequisites.missing.map((m) => m.code);
  assert.ok(codes.includes('clasp_login_missing'));
  assert.ok(codes.includes('script_id_missing'));
  assert.ok(report.nextOwnerActions.join(' ').includes('clasp login'));
});

test('AS-09 --push مرفوض صراحةً و--clone بلا SCRIPT_ID موقوف قبل الشبكة', async (t) => {
  const { root, workDir, homedir } = await makeTrees(t);
  const push = await runAppsScriptSync({
    argv: ['--push', '--work-dir', workDir], homedir, repoRoot: path.join(root, 'repo'), exec: noExec, env: {}
  });
  assert.equal(push.verdict, 'refused');
  assert.equal(push.exitCode, 2);
  assert.equal(push.remoteSynced, false);

  await writeFile(path.join(homedir, '.clasprc.json'), '{}');
  const clone = await runAppsScriptSync({
    argv: ['--clone', '--work-dir', workDir], homedir, repoRoot: path.join(root, 'repo'), exec: noExec, env: {}
  });
  assert.equal(clone.verdict, 'not-configured');
  assert.ok(clone.prerequisites.missing.some((m) => m.code === 'script_id_missing'));
});

test('AS-10 سرّ ظاهر في المسحوب يوقف القبول بأسماء الملفات فقط، وassessPrerequisites يفشل مغلقًا', async (t) => {
  const { root, localDir, workDir, homedir } = await makeTrees(t);
  await writeFile(path.join(homedir, '.clasprc.json'), '{}');
  await writeFile(path.join(workDir, '.clasp.json'), JSON.stringify({ scriptId: 'z'.repeat(30) }));
  await writeFile(path.join(workDir, 'Code.gs'), 'var V = 1;\n');
  await writeFile(path.join(workDir, 'appsscript.json'), '{"timeZone":"Africa/Cairo"}\n');

  const exec = async (cmd, argv, opts) => {
    await writeFile(path.join(opts.cwd, 'Code.gs'), 'var K = "-----BEGIN PRIVATE KEY-----";\n');
    return { status: 0, stdout: '', stderr: '' };
  };
  const report = await runAppsScriptSync({
    argv: ['--pull', '--accept', '--work-dir', workDir],
    homedir, repoRoot: path.join(root, 'repo'), exec, env: {}
  });
  assert.equal(report.verdict, 'blocked-secret');
  assert.equal(report.localModified, false);
  assert.deepEqual(report.secretFiles, ['Code.gs']);
  assert.equal(JSON.stringify(report).includes('BEGIN PRIVATE KEY'), false, 'لا تُطبع قيمة السر في التقرير');
  assert.equal(await readFile(path.join(localDir, 'Code.gs'), 'utf8'), 'var V = 1;\n');

  assert.deepEqual(scanForSecrets(null), []);
  const prereq = assessPrerequisites({ mode: 'dry-run', localExists: true, workExists: false, loginExists: false, scriptId: null });
  assert.equal(prereq.ok, true, 'الفحص الجاف لا يحتاج حسابًا كي يقيس المحلي');
  const pullPrereq = assessPrerequisites({ mode: 'pull', localExists: true, workExists: true, loginExists: false, scriptId: null });
  assert.equal(pullPrereq.ok, false);
  assert.equal(pullPrereq.missing.length, 2);
});
