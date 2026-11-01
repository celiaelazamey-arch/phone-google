/**
 * Memory consolidation (MEM-001 / DEC-096): the second P0 gap — «إزالة التكرار وتحديث المعلومات».
 *
 * The audit asked for consolidation; the code answered a narrower question first: where can
 * duplicates and stale values exist *at all*? `agent_owner_facts` has a unique (owner, tag) key, so a
 * second row for one tag cannot exist — but the same fact can be asserted by many documents, and the
 * same value can be restated by many sources. That is where consolidation earns its name.
 *
 * So consolidation here is a **view**, not a mutation:
 *
 *   - duplicate assertions of one value collapse into one entry that keeps **every** source;
 *   - disagreeing values stay side by side, contested and unresolved — `findConflicts` decides that,
 *     and this module never overrules it;
 *   - nothing is deleted, nothing is rewritten, and the report states both facts about itself.
 *
 * The invariant that matters is measured, not promised: every claim that went in is still reachable
 * in the output, so consolidation can never quietly drop evidence. `checkReport` re-derives it.
 */
import { createHash } from 'node:crypto';

import { claimKey, findConflicts, normalizeValue } from '../knowledge/conflict.js';

export const CONSOLIDATION_VERSION = 'celiaos-memory-consolidation-v1';

export const STATUS = Object.freeze({
  endorsed: 'endorsed',
  contested: 'contested'
});

const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);

const sourceOf = (claim) => ({
  sourceId: claim.sourceId ?? claim.source_id ?? 'unknown',
  trust: claim.trust ?? null,
  observedAt: claim.observedAt ?? claim.observed_at ?? null,
  itemId: claim.itemId ?? claim.item_id ?? null,
  statement: claim.statement ?? null
});

/**
 * Build the consolidated view. Deterministic: the same claims in any order produce the same bytes,
 * so the digest can be quoted as evidence.
 */
export function consolidate(claims = []) {
  const buckets = new Map();
  let rejected = 0;

  for (const claim of claims) {
    const raw = String(claim?.value ?? '').trim();
    const subject = String(claim?.subject ?? '').trim();
    if (!raw || !subject) {
      rejected += 1;
      continue;
    }
    const key = claimKey(claim);
    const value = normalizeValue(raw);
    if (!buckets.has(key)) buckets.set(key, { subject, predicate: String(claim.predicate ?? 'value'), values: new Map() });
    const bucket = buckets.get(key);
    const valueKey = value.kind === 'number' ? `n:${value.number}:${value.unit}` : `t:${value.value}`;
    if (!bucket.values.has(valueKey)) bucket.values.set(valueKey, { normalized: value.value, kind: value.kind, raw: [], sources: [] });
    const entry = bucket.values.get(valueKey);
    if (!entry.raw.includes(raw)) entry.raw.push(raw);
    entry.sources.push(sourceOf(claim));
  }

  const groups = [];
  let collapsed = 0;
  let contested = 0;
  for (const [key, bucket] of [...buckets].sort(([left], [right]) => left.localeCompare(right))) {
    const values = [...bucket.values.values()]
      .map((value) => {
        const sources = [...value.sources].sort((left, right) =>
          `${left.sourceId}|${left.itemId ?? ''}`.localeCompare(`${right.sourceId}|${right.itemId ?? ''}`)
        );
        return { ...value, raw: [...value.raw].sort(), sources, sourceCount: sources.length };
      })
      .sort((left, right) => right.sourceCount - left.sourceCount || String(left.normalized).localeCompare(String(right.normalized)));
    collapsed += values.reduce((sum, value) => sum + Math.max(0, value.sourceCount - 1), 0);
    const status = values.length === 1 ? STATUS.endorsed : STATUS.contested;
    if (status === STATUS.contested) contested += 1;
    groups.push({
      key,
      subject: bucket.subject,
      predicate: bucket.predicate,
      status,
      values,
      sources: [...new Set(values.flatMap((value) => value.sources.map((source) => source.sourceId)))].sort(),
      /** A contested group is reported as such; no value is preferred. */
      resolution: status === STATUS.contested ? 'unresolved' : 'single_value'
    });
  }

  const endorsed = groups.filter((group) => group.status === STATUS.endorsed).length;
  const report = {
    version: CONSOLIDATION_VERSION,
    claims: claims.length,
    rejected,
    groups: groups.length,
    endorsed,
    contested,
    collapsed,
    /** Measured, not asserted: every admitted claim is still reachable through a group. */
    retained: groups.reduce((sum, group) => sum + group.values.reduce((inner, value) => inner + value.sourceCount, 0), 0),
    resolution: contested > 0 ? 'unresolved' : 'consolidated',
    mutatesData: false,
    deletesData: false,
    groupsList: groups
  };
  return { ...report, digest: digestOf(stripDigest(report)) };
}

const stripDigest = ({ digest: _ignored, ...rest }) => rest;

/**
 * Re-derive what the report promises. A report that lost a claim, preferred a value in a contested
 * group, or hid a source is refused here rather than published.
 */
export function checkReport(report) {
  const problems = [];
  if (report?.version !== CONSOLIDATION_VERSION) problems.push('unknown_report_version');
  if (report?.mutatesData !== false) problems.push('a consolidation report may not mutate data');
  if (report?.deletesData !== false) problems.push('a consolidation report may not delete data');

  const retained = (report?.groupsList ?? []).reduce(
    (sum, group) => sum + (group.values ?? []).reduce((inner, value) => inner + (value.sources ?? []).length, 0),
    0
  );
  if (retained !== (report?.claims ?? 0) - (report?.rejected ?? 0)) {
    problems.push(`claims lost: ${report?.claims} in, ${retained} retained, ${report?.rejected} rejected`);
  }
  for (const group of report?.groupsList ?? []) {
    const values = group.values ?? [];
    if (group.status === STATUS.contested && group.resolution !== 'unresolved') {
      problems.push(`${group.key}: a contested group must stay unresolved`);
    }
    if (group.status === STATUS.contested && values.length < 2) problems.push(`${group.key}: contested with one value`);
    if (group.status === STATUS.endorsed && values.length !== 1) problems.push(`${group.key}: endorsed with ${values.length} values`);
    const declared = new Set(group.sources ?? []);
    for (const value of values) {
      for (const source of value.sources ?? []) {
        if (!declared.has(source.sourceId)) problems.push(`${group.key}: source ${source.sourceId} is missing from the group list`);
      }
    }
  }
  const expected = digestOf(stripDigest(report ?? {}));
  if (report?.digest !== expected) problems.push('digest does not match the report');
  return { ok: problems.length === 0, problems };
}

/** One line per finding, in Arabic; contests first because they need a person. */
export function describeConsolidation(report) {
  const lines = [];
  for (const group of report.groupsList.filter((item) => item.status === STATUS.contested)) {
    const sides = group.values
      .map((value) => `${value.raw[0]} (${value.sources.map((source) => source.sourceId).join('، ')})`)
      .join(' ≠ ');
    lines.push(`متنازَع عليه — ${group.subject} / ${group.predicate}: ${sides}`);
  }
  lines.push(
    `مُجمَّع: ${report.groups} ادعاءً مستقلًا من ${report.claims} ادعاءً (${report.collapsed} تكرارًا دُمج، ${report.endorsed} مُجمع عليه، ${report.contested} متنازَع عليه).`
  );
  lines.push(`بصمة التجميع ${report.digest} — لا حذف ولا إعادة كتابة.`);
  return lines;
}
