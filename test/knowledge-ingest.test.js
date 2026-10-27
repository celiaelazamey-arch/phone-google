import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeStore } from '../src/knowledge/store.js';
import { ingestDirectory, ingestRegistry } from '../src/knowledge/ingest.js';
import { parseCsv, toCsv } from '../src/knowledge/csv.js';
import { findSecret, checkHeader, validateRow, ALLOWED_LICENSES } from '../src/knowledge/validate.js';
import { verifyManifest, sha256 } from '../src/knowledge/manifest.js';
import { canonicalRisk } from '../src/knowledge/tool-policy.js';

const root = path.resolve(import.meta.dirname, '..');
const registryDir = path.join(root, 'data', 'kb');

const tempStore = async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-kb-test-'));
  const store = await KnowledgeStore.open({ file: path.join(directory, 'kb.sqlite3') });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, directory };
};

const source = (extra = {}) => ({
  id: 'src-test',
  kind: 'csv',
  uri: 'repo://test.csv',
  license: 'internal-owner',
  trust: 'T2',
  staleAfterDays: 180,
  lastSync: '2026-10-27',
  ...extra
});

const toolsCsv = (rows) =>
  toCsv(
    ['id', 'name', 'category', 'risk_level', 'requires_approval', 'api_endpoint', 'docs_url', 'owner', 'skills', 'data_egress', 'aliases', 'notes'],
    rows
  );

test('csv: parses quotes, embedded commas and CRLF; rejects broken structure', () => {
  const parsed = parseCsv('a,b,c\r\n1,"x,y","he said ""hi"""\r\n2,,3\r\n');
  assert.deepEqual(parsed.header, ['a', 'b', 'c']);
  assert.equal(parsed.records[0].values.b, 'x,y');
  assert.equal(parsed.records[0].values.c, 'he said "hi"');
  assert.equal(parsed.records[1].values.b, '');
  assert.throws(() => parseCsv('a,b\n1,"unterminated\n'), /unterminated/);
  assert.throws(() => parseCsv('a,a\n1,2\n'), /duplicate column/);
  assert.throws(() => parseCsv(''), /empty file/);
});

test('validate: credentials are refused as data and the row is rejected', () => {
  for (const value of [
    'sk-abcdef0123456789abcdef',
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
    '-----BEGIN PRIVATE KEY-----',
    'password=hunter2',
    'Bearer abcdefghijklmnopqrstuvwxyz123456',
    'AIzaSyA1234567890abcdefghijklmnopqrstu'
  ]) {
    assert.ok(findSecret(value), `should detect: ${value}`);
  }
  assert.equal(findSecret('حالة النظام'), null);
  const result = validateRow('knowledge', {
    id: 'kb-test',
    title: 't',
    type: 'doc',
    description: 'desc',
    source_url: 'https://example.test/x',
    license: 'internal-owner',
    updated_at: '2026-10-27',
    trust_level: 'T2',
    aliases: 'sk-abcdef0123456789abcdef'
  });
  assert.equal(result.ok, false);
  assert.match(result.code, /^secret_/);
});

test('validate: licences, urls and dates are enforced; unknown columns are reported', () => {
  assert.ok(ALLOWED_LICENSES.includes('CC-BY-4.0'));
  const base = {
    id: 'kb-test',
    title: 't',
    type: 'doc',
    description: 'd',
    source_url: 'https://example.test/x',
    license: 'internal-owner',
    updated_at: '2026-10-27',
    trust_level: 'T2'
  };
  assert.equal(validateRow('knowledge', base).ok, true);
  assert.equal(validateRow('knowledge', { ...base, license: 'WTFPL' }).code, 'license_not_allowed');
  assert.equal(validateRow('knowledge', { ...base, license: '' }).code, 'license_missing');
  assert.equal(validateRow('knowledge', { ...base, source_url: 'http://plain.test' }).code, 'invalid_source_url');
  assert.equal(validateRow('knowledge', { ...base, updated_at: '27/10/2026' }).code, 'invalid_updated_at');
  assert.equal(validateRow('knowledge', { ...base, id: 'A B C' }).code, 'invalid_id');
  assert.equal(validateRow('knowledge', { ...base, trust_level: 'T9' }).code, 'invalid_trust_level');
  const header = checkHeader('knowledge', ['id', 'title', 'type', 'description', 'source_url', 'license', 'updated_at', 'trust_level', 'typo_column']);
  assert.equal(header.ok, true);
  assert.deepEqual(header.warnings, [{ code: 'unknown_column', field: 'typo_column' }]);
  assert.equal(checkHeader('knowledge', ['id']).code, 'missing_columns');
});

test('validate: a CSV cannot grant itself a permission that the code does not', () => {
  assert.equal(canonicalRisk('google_calendar_events_create').requiresApproval, true);
  const row = {
    id: 'google_calendar_events_create',
    name: 'calendar',
    category: 'google',
    risk_level: 'read',
    requires_approval: 'false',
    api_endpoint: '/mcp',
    docs_url: 'https://example.test/docs',
    owner: 'owner'
  };
  const mismatch = validateRow('tools', row, { canonicalRisk });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'registry_risk_mismatch');
  const approval = validateRow('tools', { ...row, risk_level: 'external_effect', requires_approval: 'false' }, { canonicalRisk });
  assert.equal(approval.code, 'registry_approval_mismatch');
  const correct = validateRow('tools', { ...row, risk_level: 'external_effect', requires_approval: 'true' }, { canonicalRisk });
  assert.equal(correct.ok, true);
  assert.equal(correct.record.wired, true);
  const catalogWrite = validateRow(
    'tools',
    { ...row, id: 'some_external_writer', risk_level: 'external_effect', requires_approval: 'false' },
    { canonicalRisk }
  );
  assert.equal(catalogWrite.code, 'catalog_tool_requires_approval', 'catalog rows cannot claim an unguarded write');
});

test('ingest: dry-run writes nothing, then apply is idempotent and reports real counts', async (t) => {
  const { store } = await tempStore(t);
  const csv = toolsCsv([
    {
      id: 'celia_status',
      name: 'celia_status',
      category: 'diagnostics',
      risk_level: 'read',
      requires_approval: 'false',
      api_endpoint: '/mcp',
      docs_url: 'https://example.test/a',
      owner: 'owner',
      aliases: 'حالة النظام'
    }
  ]);
  const dry = ingestRegistry({ store, kind: 'tools', source: source(), csvText: csv, dryRun: true });
  assert.equal(dry.counts.added, 1);
  assert.equal(dry.mode, 'dry-run');
  assert.equal(store.stats().items, 0, 'dry-run leaves no rows');
  assert.equal(store.listSources().length, 0, 'dry-run leaves no source');

  const applied = ingestRegistry({ store, kind: 'tools', source: source(), csvText: csv, dryRun: false });
  assert.equal(applied.counts.added, 1);
  const again = ingestRegistry({ store, kind: 'tools', source: source(), csvText: csv, dryRun: false });
  assert.equal(again.counts.unchanged, 1);
  assert.equal(again.counts.added, 0);
  const stats = store.stats();
  assert.equal(stats.items, 1);
  assert.equal(stats.entities, 1);
  assert.equal(stats.lastRun.counts.unchanged, 1);
});

test('ingest: duplicate ids and unresolved relations are reported, never silently dropped', async (t) => {
  const { store } = await tempStore(t);
  const csv = toCsv(
    ['id', 'name', 'level', 'category', 'source', 'evidence_url', 'projects', 'aliases', 'notes'],
    [
      { id: 'skill-a', name: 'A', level: 'basic', category: 'c', source: 'repo', evidence_url: 'https://example.test/a', projects: 'proj-missing' },
      { id: 'skill-a', name: 'A2', level: 'basic', category: 'c', source: 'repo', evidence_url: 'https://example.test/a2' }
    ]
  );
  const report = ingestRegistry({ store, kind: 'skills', source: source(), csvText: csv, dryRun: false });
  assert.deepEqual(
    report.errors.map((error) => error.code).sort(),
    ['duplicate_id', 'edge_target_missing'],
    'a relation to a missing entity is rejected too, not silently dropped'
  );
  assert.equal(report.counts.rejected, 2);
  assert.equal(report.counts.added, 1);
  const edgeReport = ingestRegistry({ store, kind: 'skills', source: source(), csvText: csv, dryRun: true, edgeMode: 'collect' });
  assert.equal(edgeReport.pendingEdges.length, 1);
  assert.equal(store.stats().items, 1, 'the collected edge was not written in collect mode');
});

test('ingest: full re-import marks absence instead of deleting, and clears it when the row returns', async (t) => {
  const { store } = await tempStore(t);
  const header = ['id', 'title', 'type', 'description', 'source_url', 'license', 'updated_at', 'trust_level'];
  const rowA = {
    id: 'kb-a',
    title: 'A',
    type: 'doc',
    description: 'd',
    source_url: 'https://example.test/a',
    license: 'internal-owner',
    updated_at: '2026-10-27',
    trust_level: 'T2'
  };
  const rowB = { ...rowA, id: 'kb-b', title: 'B', source_url: 'https://example.test/b' };
  ingestRegistry({ store, kind: 'knowledge', source: source(), csvText: toCsv(header, [rowA, rowB]), dryRun: false, full: true });
  assert.equal(store.stats().items, 2);
  const second = ingestRegistry({ store, kind: 'knowledge', source: source(), csvText: toCsv(header, [rowA]), dryRun: false, full: true });
  assert.equal(second.counts.markedAbsent, 1);
  const stats = store.stats();
  assert.equal(stats.items, 1);
  assert.equal(stats.absentItems, 1, 'the vanished row is kept as absent, not deleted');
  const third = ingestRegistry({ store, kind: 'knowledge', source: source(), csvText: toCsv(header, [rowA, rowB]), dryRun: false, full: true });
  assert.equal(third.counts.markedAbsent, 0);
  assert.equal(store.stats().absentItems, 0);
});

test('ingest: the real registries in data/kb import cleanly with zero rejections', async (t) => {
  const { store } = await tempStore(t);
  const report = await ingestDirectory({ store, directory: registryDir, dryRun: false, full: true });
  assert.equal(report.totals.rejectedRows, 0, JSON.stringify(report.files.flatMap((file) => file.errors)));
  assert.ok(report.totals.added >= 50, 'seeded registries import');
  assert.equal(report.graph.unresolved.length, 0);
  assert.ok(report.graph.written >= 40, 'relations resolve across files');
  const stats = store.stats();
  assert.equal(stats.entities, stats.items);
  assert.ok(stats.edges >= 40);
});

test('manifest: a hand-edited CSV without a refreshed manifest is refused', async (t) => {
  const { store, directory } = await tempStore(t);
  const copy = path.join(directory, 'kb');
  cpSync(registryDir, copy, { recursive: true });
  const toolsPath = path.join(copy, 'tools_registry.csv');
  const original = await readFile(toolsPath, 'utf8');
  await verifyManifest(copy);
  writeFileSync(toolsPath, `${original}`, 'utf8');
  await ingestDirectory({ store, directory: copy, dryRun: true });
  const tampered = original.replace('diagnostics', 'diagnosticsX');
  writeFileSync(toolsPath, tampered, 'utf8');
  await assert.rejects(() => verifyManifest(copy), /manifest_checksum_mismatch/);
  await assert.rejects(() => ingestDirectory({ store, directory: copy, dryRun: true }), /manifest_checksum_mismatch/);
  assert.equal(sha256(tampered), sha256(tampered));
});
