import crypto from 'node:crypto';
import { parseCsv } from './csv.js';
import { verifyManifest } from './manifest.js';
import { checkHeader, validateRow } from './validate.js';
import { canonicalRisk } from './tool-policy.js';

/**
 * Registry import.
 *
 * Two phases, because relations cross files (a tool depends on a skill that belongs
 * to a project):
 *   1. rows → items + entities, rejections recorded per line;
 *   2. declared relations → graph edges, only between entities that exist.
 *
 * Dry-run by default, one transaction per run, and a structural error (checksum,
 * header) aborts that file before any write.
 */

const KIND_TYPES = Object.freeze({
  knowledge: 'doc',
  tools: 'tool',
  skills: 'skill',
  projects: 'project',
  sources: 'source'
});

const ENTITY_TYPES = Object.freeze({
  knowledge: 'concept',
  tools: 'tool',
  skills: 'skill',
  projects: 'project',
  sources: 'source'
});

const stableId = (sourceId, kind, key) =>
  `kb_${crypto.createHash('sha256').update(`${sourceId}|${kind}|${key}`).digest('hex').slice(0, 20)}`;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** Body text used for indexing and snippets — original words, no invented content. */
export function bodyFor(kind, record) {
  if (kind === 'knowledge') {
    return [record.description, record.type, ...(record.aliases || []), ...(record.tags || []), ...(record.related || [])].join(' · ');
  }
  if (kind === 'tools') {
    return [
      record.title,
      record.category,
      `risk: ${record.risk}`,
      record.requiresApproval ? 'requires approval' : 'no approval required',
      record.wired ? 'wired in code' : 'catalog only',
      record.dataEgress ? 'sends data to a provider' : 'no external data egress',
      record.notes,
      ...(record.aliases || []),
      ...(record.skills || []).map((skill) => `requires ${skill}`)
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (kind === 'skills') {
    return [record.title, record.category, `level ${record.level}`, record.source, record.notes, ...(record.aliases || [])]
      .filter(Boolean)
      .join(' · ');
  }
  if (kind === 'projects') {
    return [record.title, record.domain, `status ${record.status}`, `priority ${record.priority}`, record.notes, ...(record.aliases || [])]
      .filter(Boolean)
      .join(' · ');
  }
  return [record.title, record.kind, record.uri, record.notes, ...(record.aliases || [])].filter(Boolean).join(' · ');
}

function relationPlan(kind, value) {
  const edges = [];
  if (kind === 'knowledge' && value.related?.length) {
    for (const target of value.related) edges.push({ srcType: 'concept', srcId: value.id, rel: 'mentions', dstRef: target });
  }
  if (kind === 'tools' && value.skills?.length) {
    for (const target of value.skills) edges.push({ srcType: 'tool', srcId: value.id, rel: 'requires', dstRef: target });
  }
  if (kind === 'skills') {
    for (const target of value.projects || []) edges.push({ srcType: 'skill', srcId: value.id, rel: 'part_of', dstRef: target });
    for (const target of value.tools || []) edges.push({ srcType: 'tool', srcId: target, rel: 'requires', dstRef: value.id });
  }
  if (kind === 'projects' && value.related?.length) {
    for (const target of value.related) edges.push({ srcType: 'project', srcId: value.id, rel: 'mentions', dstRef: target });
  }
  return edges;
}

/**
 * Imports one parsed registry file into an open store.
 * `dryRun` performs the whole run inside a transaction that is rolled back.
 * `edgeMode: 'collect'` returns the declared relations instead of writing them.
 */
export function ingestRegistry({
  store,
  kind,
  source,
  csvText,
  fileName,
  dryRun = true,
  full = false,
  edgeMode = 'apply',
  clock = Date.now
}) {
  if (!KIND_TYPES[kind]) throw new Error(`unknown_registry_kind: ${kind}`);
  if (store.readOnly) throw new Error('knowledge store is read-only');
  const parsed = parseCsv(csvText);
  const header = checkHeader(kind, parsed.header);
  if (!header.ok) throw new Error(`${header.code}: ${(header.missing || []).join(', ')}`);

  let runId = null;
  const counts = { added: 0, updated: 0, deduplicated: 0, unchanged: 0, rejected: 0, markedAbsent: 0 };
  const warnings = [...(header.warnings || [])];
  const errors = [];
  const seenIds = new Set();
  const seenEntityKeys = new Set();
  const pendingEdges = [];
  const recordIdsByKey = new Map();

  const fail = (line, code, field) => {
    counts.rejected += 1;
    if (runId) store.reject(runId, { line, code, field });
    errors.push({ line, code, field: field || null });
  };

  const work = () => {
    // The source row must exist before the run row: the ledger references it.
    store.upsertSource({
      id: source.id,
      kind: source.kind,
      uri: source.uri,
      license: source.license,
      trust: source.trust,
      staleAfterDays: source.staleAfterDays,
      lastSyncAt: source.lastSync ?? null
    });
    runId = store.startRun({ sourceId: source.id, kind, mode: dryRun ? 'dry-run' : 'apply' });

    for (const record of parsed.records) {
      const rowId = record.values.id || '';
      if (rowId && seenIds.has(rowId)) {
        fail(record.line, 'duplicate_id', 'id');
        continue;
      }
      const validation = validateRow(kind, record.values, { canonicalRisk });
      if (!validation.ok) {
        fail(record.line, validation.code, validation.field);
        continue;
      }
      seenIds.add(rowId);
      const value = validation.record;
      const itemId = stableId(source.id, kind, value.id);
      const body = bodyFor(kind, value);
      const contentHash = sha256(`${value.title}\n${body}`);
      const item = {
        id: itemId,
        sourceId: source.id,
        kind: KIND_TYPES[kind],
        title: value.title,
        body,
        contentHash,
        lang: value.lang || 'mixed',
        trust: source.trust,
        uri: value.sourceUrl || value.docsUrl || value.evidenceUrl || value.repoUrl || source.uri,
        sourceUpdatedAt: value.updatedAt || value.lastSync || source.lastSync || null
      };
      const outcome = store.putItem(item);
      counts[outcome.status] += 1;
      recordIdsByKey.set(value.id, outcome.itemId || itemId);

      const entityType = ENTITY_TYPES[kind];
      seenEntityKeys.add(`${entityType}:${value.id}`);
      store.putEntity({
        id: `ent_${crypto.createHash('sha256').update(`${source.id}|${entityType}|${value.id}`).digest('hex').slice(0, 20)}`,
        type: entityType,
        key: value.id,
        title: value.title,
        status: kind === 'projects' && value.status !== 'active' ? 'deprecated' : 'active',
        risk: kind === 'tools' ? value.risk : null,
        requiresApproval: kind === 'tools' ? value.requiresApproval : false,
        wired: kind === 'tools' ? value.wired : false,
        evidenceItemId: outcome.itemId || itemId,
        trust: source.trust,
        attrs:
          kind === 'tools'
            ? {
                category: value.category,
                apiEndpoint: value.apiEndpoint,
                docsUrl: value.docsUrl,
                owner: value.owner,
                dataEgress: value.dataEgress,
                approval: value.requiresApproval ? 'required' : 'not-required',
                wiring: value.wired ? 'wired' : 'catalog-only'
              }
            : kind === 'skills'
              ? { level: value.level, category: value.category, source: value.source, evidenceUrl: value.evidenceUrl }
              : kind === 'projects'
                ? { domain: value.domain, status: value.status, priority: value.priority, owner: value.owner, repoUrl: value.repoUrl }
                : kind === 'sources'
                  ? { kind: value.kind, uri: value.uri, lastSync: value.lastSync, staleAfterDays: String(value.staleAfterDays) }
                  : { type: value.type, sourceUrl: value.sourceUrl, updatedAt: value.updatedAt }
      });

      for (const edge of relationPlan(kind, value)) {
        pendingEdges.push({ ...edge, evidenceItemId: outcome.itemId || itemId, line: record.line });
      }
    }

    if (edgeMode === 'apply') {
      for (const edge of pendingEdges) {
        const src = store.getEntityByKey(edge.srcId);
        const dst = store.getEntityByKey(edge.dstRef);
        if (!src || !dst) {
          fail(edge.line, 'edge_target_missing', 'related');
          continue;
        }
        store.putEdge({
          srcType: src.type,
          srcId: src.key,
          dstType: dst.type,
          dstId: dst.key,
          rel: edge.rel,
          evidenceItemId: edge.evidenceItemId
        });
      }
    }

    if (full) {
      counts.markedAbsent = store.markAbsent({ sourceId: source.id, kind: KIND_TYPES[kind], seenIds: [...recordIdsByKey.values()] });
    }
    store.finishRun(runId, counts, { errorCode: errors.length ? 'row_rejections' : null });
  };

  store.transaction(work, { rollback: dryRun });

  return {
    file: fileName || null,
    kind,
    sourceId: source.id,
    mode: dryRun ? 'dry-run' : 'apply',
    runId,
    lineCount: parsed.records.length,
    counts,
    warnings,
    errors,
    ids: [...seenEntityKeys],
    pendingEdges: edgeMode === 'collect' ? pendingEdges : []
  };
}

/**
 * Resolves collected relations across files; unresolved ones are reported, never
 * guessed. `knownKeys` is the set of `${type}:${key}` entities expected after the
 * import — required in dry-run, where nothing is committed yet.
 */
export function applyEdges({ store, edges, dryRun = true, knownKeys = null }) {
  const unresolved = [];
  let written = 0;
  const exists = (type, key) => {
    if (knownKeys) return knownKeys.has(`${type}:${key}`);
    return Boolean(store.getEntityByKey(key));
  };
  const work = () => {
    for (const edge of edges) {
      const srcOk = exists(edge.srcType, edge.srcId);
      const dstType = edge.dstRef.startsWith('proj-')
        ? 'project'
        : edge.dstRef.startsWith('skill-')
          ? 'skill'
          : edge.dstRef.startsWith('tool-') || edge.dstRef.includes('.') || edge.dstRef.includes('_')
            ? 'tool'
            : edge.dstRef.startsWith('kb-')
              ? 'concept'
              : 'concept';
      const dstOk = exists(dstType, edge.dstRef);
      if (!srcOk || !dstOk) {
        unresolved.push({
          line: edge.line,
          code: 'edge_target_missing',
          field: edge.rel,
          from: `${edge.srcType}:${edge.srcId}`,
          to: `${dstType}:${edge.dstRef}`
        });
        continue;
      }
      if (dryRun) {
        written += 1;
        continue;
      }
      store.putEdge({
        srcType: edge.srcType,
        srcId: edge.srcId,
        dstType,
        dstId: edge.dstRef,
        rel: edge.rel,
        evidenceItemId: edge.evidenceItemId
      });
      written += 1;
    }
  };
  store.transaction(work, { rollback: dryRun });
  return { written, unresolved };
}

/** Reads the manifest, verifies checksums, imports every listed file, then links the graph. */
export async function ingestDirectory({ store, directory, dryRun = true, full = false, clock = Date.now, kinds } = {}) {
  const { files } = await verifyManifest(directory);
  const selected = kinds ? files.filter((file) => kinds.includes(file.kind)) : files;
  if (!selected.length) throw new Error('manifest_has_no_matching_files');
  const reports = [];
  const collectedEdges = [];
  for (const file of selected) {
    const source = {
      id: file.sourceId || `src_${file.kind}`,
      kind: file.sourceKind || 'csv',
      uri: file.uri || `repo://data/kb/${file.name}`,
      license: file.license,
      trust: file.trust,
      staleAfterDays: file.stale_after_days ?? 180,
      lastSync: file.last_sync || null
    };
    const report = ingestRegistry({
      store,
      kind: file.kind,
      source,
      csvText: file.source,
      fileName: file.name,
      dryRun,
      full,
      edgeMode: 'collect',
      clock
    });
    reports.push(report);
    collectedEdges.push(...report.pendingEdges);
  }
  const knownKeys = new Set(reports.flatMap((report) => report.ids));
  const graph = applyEdges({ store, edges: collectedEdges, dryRun, knownKeys });
  const totals = reports.reduce(
    (accumulator, report) => {
      for (const key of ['added', 'updated', 'deduplicated', 'unchanged', 'rejected', 'markedAbsent']) {
        accumulator[key] += report.counts[key] ?? 0;
      }
      accumulator.rejectedRows += report.errors.length;
      return accumulator;
    },
    { added: 0, updated: 0, deduplicated: 0, unchanged: 0, rejected: 0, markedAbsent: 0, rejectedRows: 0 }
  );
  totals.rejectedRows += graph.unresolved.length;
  return {
    mode: dryRun ? 'dry-run' : 'apply',
    files: reports.map(({ pendingEdges, ...rest }) => rest),
    graph,
    totals
  };
}
