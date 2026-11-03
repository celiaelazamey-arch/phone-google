/**
 * SIE-001 / SI-3/C2 — حلقة الرصد الذاتي: بيانات الحلقة وحالة تُحسب لا تُعلن.
 *
 * العقيدة (تدقيق `SI-0` · `DEC-125`): الناقصان المسمّيان بالاسم — حالة
 * `OBSERVATION_UNAVAILABLE` و`freshness_ttl` — والغياب ليس سلامة، وskipped يُسجَّل skipped
 * لا يُحسب نجاحًا. الحلقة بياناتُها لا مُشغِّلُها: لا مؤقّت ولا جلب ولا مخزن، والملاحظات
 * تُدخلها البنية الخارجية القائمة (زمن-CI) والحالة تُحسب من أحدث ملاحظة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SELF_MONITORING_VERSION,
  SELF_MONITORING_LIMIT,
  OBSERVATION_OUTCOMES,
  MONITOR_STATUSES,
  createMonitorLoop,
  recordObservation,
  computeMonitorStatus,
  computeLoopStatus
} from '../src/agent/self-monitoring.js';

function loop() {
  return createMonitorLoop({
    monitors: [
      { id: 'quality', label: 'بوابة الجودة', freshnessTtlSeconds: 1800, source: 'ci:quality' },
      { id: 'doctor', label: 'الطبيب عند الطلب', freshnessTtlSeconds: 3600, source: 'manual:doctor' }
    ]
  });
}

const T0 = '2026-11-03T12:00:00.000Z';

test('C2: the loop carries the audited shape — frozen, with the declared limit', () => {
  const l = loop();
  assert.equal(l.version, SELF_MONITORING_VERSION);
  assert.equal(l.limit, SELF_MONITORING_LIMIT);
  assert.match(l.limit, /لا مؤقّت ولا جلب ولا مخزن/);
  assert.match(l.limit, /OBSERVATION_UNAVAILABLE/);
  assert.equal(Object.isFrozen(l), true);
  assert.equal(Object.isFrozen(l.monitors), true);
  assert.equal(Object.isFrozen(l.observations), true);
  assert.equal(Object.isFrozen(l.monitors[0]), true);
  assert.throws(() => { 'use strict'; l.version = 'tampered'; }, TypeError, 'the loop cannot be mutated');
});

test('C2: fail closed — bad monitors, bad freshness_ttl, unknown observations', () => {
  assert.throws(() => createMonitorLoop({ monitors: [] }), /monitors_required/);
  assert.throws(
    () => createMonitorLoop({ monitors: [
      { id: 'x', label: 'l', freshnessTtlSeconds: 60, source: 's' },
      { id: 'x', label: 'l', freshnessTtlSeconds: 60, source: 's' }
    ] }),
    /ids_distinct/,
    'monitor identities are distinct'
  );
  for (const bad of [0, -5, 1.5, '600', Number.NaN, Infinity]) {
    assert.throws(
      () => createMonitorLoop({ monitors: [{ id: 'x', label: 'l', freshnessTtlSeconds: bad, source: 's' }] }),
      /freshness_ttl_invalid/,
      `freshness_ttl rejects ${String(bad)}`
    );
  }
  assert.throws(() => createMonitorLoop({ monitors: [{ id: ' ', label: 'l', freshnessTtlSeconds: 60, source: 's' }] }), /id_required/);
  assert.throws(() => loop().monitors && recordObservation(loop(), { monitorId: 'ghost', outcome: 'succeeded', observedAt: T0 }), /monitor_unknown/);
  assert.throws(() => recordObservation(loop(), { monitorId: 'quality', outcome: 'ok', observedAt: T0 }), /outcome_unknown/);
  assert.throws(() => recordObservation(loop(), { monitorId: 'quality', outcome: 'succeeded', observedAt: 'not-a-date' }), /observedAt_invalid/);
});

test('C2: OBSERVATION_UNAVAILABLE and freshness_ttl — the two audited artifacts, computed not declared', () => {
  const statuses = computeMonitorStatus(loop(), 'quality', { now: T0 });
  assert.deepEqual(
    { status: statuses.status, statusBasis: statuses.statusBasis },
    { status: MONITOR_STATUSES.OBSERVATION_UNAVAILABLE, statusBasis: 'no_observation' },
    'absence is not health'
  );
  const fresh = recordObservation(loop(), { monitorId: 'quality', outcome: OBSERVATION_OUTCOMES.SUCCEEDED, observedAt: '2026-11-03T11:45:00.000Z' });
  assert.equal(computeMonitorStatus(fresh, 'quality', { now: T0 }).status, MONITOR_STATUSES.OK);
  assert.equal(computeMonitorStatus(fresh, 'quality', { now: T0 }).statusBasis, 'fresh_within_ttl');
  const boundary = recordObservation(loop(), { monitorId: 'quality', outcome: OBSERVATION_OUTCOMES.SUCCEEDED, observedAt: '2026-11-03T11:30:00.000Z' });
  assert.equal(computeMonitorStatus(boundary, 'quality', { now: T0 }).status, MONITOR_STATUSES.OK, 'exactly at the ttl (1800s) is still fresh — the boundary is declared');
  const aged = recordObservation(loop(), { monitorId: 'quality', outcome: OBSERVATION_OUTCOMES.SUCCEEDED, observedAt: '2026-11-03T11:29:59.000Z' });
  const stale = computeMonitorStatus(aged, 'quality', { now: T0 });
  assert.equal(stale.status, MONITOR_STATUSES.STALE);
  assert.equal(stale.statusBasis, 'freshness_ttl_exceeded');
  const failing = recordObservation(loop(), { monitorId: 'quality', outcome: OBSERVATION_OUTCOMES.FAILED, observedAt: '2026-11-03T11:59:00.000Z' });
  assert.equal(computeMonitorStatus(failing, 'quality', { now: T0 }).status, MONITOR_STATUSES.FAILING, 'failure is louder than freshness');
  const skipped = recordObservation(loop(), { monitorId: 'quality', outcome: OBSERVATION_OUTCOMES.SKIPPED, observedAt: '2026-11-03T11:59:00.000Z' });
  const skippedStatus = computeMonitorStatus(skipped, 'quality', { now: T0 });
  assert.equal(skippedStatus.status, MONITOR_STATUSES.OBSERVATION_UNAVAILABLE, 'skipped is recorded as skipped, never as success');
  assert.equal(skippedStatus.statusBasis, 'latest_observation_skipped');
  const future = recordObservation(loop(), { monitorId: 'quality', outcome: OBSERVATION_OUTCOMES.SUCCEEDED, observedAt: '2026-11-03T12:00:01.000Z' });
  const skew = computeMonitorStatus(future, 'quality', { now: T0 });
  assert.equal(skew.status, MONITOR_STATUSES.OBSERVATION_UNAVAILABLE);
  assert.equal(skew.statusBasis, 'clock_skew_future_observation');
});

test('C2: no mutation — recording returns a new loop and the latest observation wins', () => {
  const l = loop();
  const first = recordObservation(l, { monitorId: 'quality', outcome: OBSERVATION_OUTCOMES.FAILED, observedAt: '2026-11-03T11:00:00.000Z' });
  const second = recordObservation(first, { monitorId: 'quality', outcome: OBSERVATION_OUTCOMES.SUCCEEDED, observedAt: '2026-11-03T11:55:00.000Z' });
  assert.equal(l.observations.length, 0, 'the original loop stays untouched');
  assert.equal(first.observations.length, 1);
  assert.equal(second.observations.length, 2);
  assert.equal(computeMonitorStatus(second, 'quality', { now: T0 }).status, MONITOR_STATUSES.OK, 'the latest observation governs');
  const older = recordObservation(second, { monitorId: 'quality', outcome: OBSERVATION_OUTCOMES.FAILED, observedAt: '2026-11-03T11:10:00.000Z' });
  assert.equal(older.observations.length, 3);
  const governed = computeMonitorStatus(older, 'quality', { now: T0 });
  assert.equal(governed.status, MONITOR_STATUSES.FAILING, 'the most recently recorded observation governs — feed order, not timestamps');
  assert.equal(governed.statusBasis, 'latest_observation_failed');
});

test('C2: the realistic CI-shaped loop never claims health while observations are missing', () => {
  let l = createMonitorLoop({
    monitors: [
      { id: 'quality', label: 'الجودة', freshnessTtlSeconds: 1800, source: 'ci:quality' },
      { id: 'reality', label: 'الواقعية', freshnessTtlSeconds: 1800, source: 'ci:reality' },
      { id: 'doctor', label: 'الطبيب', freshnessTtlSeconds: 3600, source: 'manual:doctor' }
    ]
  });
  const before = computeLoopStatus(l, { now: T0 });
  assert.equal(before.status, MONITOR_STATUSES.OBSERVATION_UNAVAILABLE);
  assert.equal(before.statusBasis, 'some_observations_unavailable');
  l = recordObservation(l, { monitorId: 'quality', outcome: OBSERVATION_OUTCOMES.SUCCEEDED, observedAt: '2026-11-03T11:50:00.000Z' });
  l = recordObservation(l, { monitorId: 'reality', outcome: OBSERVATION_OUTCOMES.SKIPPED, observedAt: '2026-11-03T11:50:00.000Z' });
  const after = computeLoopStatus(l, { now: T0 });
  assert.deepEqual(
    after.monitors.map((entry) => entry.status),
    [MONITOR_STATUSES.OK, MONITOR_STATUSES.OBSERVATION_UNAVAILABLE, MONITOR_STATUSES.OBSERVATION_UNAVAILABLE],
    'one fresh success does not mask the unavailable monitors'
  );
  assert.equal(after.status, MONITOR_STATUSES.OBSERVATION_UNAVAILABLE);
  assert.equal(after.statusBasis, 'some_observations_unavailable');
  const failing = recordObservation(l, { monitorId: 'doctor', outcome: OBSERVATION_OUTCOMES.FAILED, observedAt: '2026-11-03T11:58:00.000Z' });
  const worst = computeLoopStatus(failing, { now: T0 });
  assert.equal(worst.status, MONITOR_STATUSES.FAILING, 'failing outranks unavailable at the loop level');
  assert.equal(worst.statusBasis, 'any_monitor_failing');
});
