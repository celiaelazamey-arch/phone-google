/**
 * SI-3/C2 — حلقة الرصد الذاتي: بياناتُ الحلقة وحالةٌ تُحسب لا تُعلن.
 *
 * تدقيق `SI-0` (صفّ C2): «Self-Monitoring مستمر مع `OBSERVATION_UNAVAILABLE` — الموجود
 * **زمن-CI لا حلقة مستمرة** (`ci:notify` + البوابات). لا حالة `OBSERVATION_UNAVAILABLE`،
 * ولا `freshness_ttl`. لكن `agents:doctor` يمارس الجوهر: عند تعذّر الجلب الحقيقي أعلن ⛔
 * وسمّى السبب بدل اعتبار الغياب سلامة».
 *
 * ما تنفّذه هذه الوحدة بالاسمين اللذين سمّاهما التدقيق:
 * - **`OBSERVATION_UNAVAILABLE`**: حالة صريحة لغياب الملاحظة أو تخطّيها أو انحراف الساعة —
 *   الغياب ليس سلامة، وskipped يُسجَّل skipped ولا يُحسب نجاحًا.
 * - **`freshness_ttl`**: كل مرصود يحمل عمرَ الطزاجة بالثواني؛ ملاحظة نجاحٍ أقدم منه ⇒ STALE
 *   بأساس مسمّى (الحد الصريح: عند التساوي تمامًا ما زالت طازجة، الفساد فوق الحد فقط).
 *
 * والقرار الحاكم (`DEC-125`): «الحلقة المستمرة» هنا **بياناتُ حلقة لا مُشغِّلُها** — لا
 * `setInterval` ولا مؤقّت ولا جلب شبكي ولا مخزن؛ الملاحظات تُدخلها البنية الخارجية القائمة
 * نفسها (زمن-CI: البوابات و`ci:notify` والطبيب عند الطلب) والحالة تُحسب من أحدث ملاحظة.
 * صفر عمليات/شبكة/مخزن (SP-09 سليم)، والأدوات 18 كما هي عمدًا.
 */

export const SELF_MONITORING_VERSION = 'self-monitoring-v1';
export const OBSERVATION_OUTCOMES = Object.freeze({
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  SKIPPED: 'skipped'
});
export const MONITOR_STATUSES = Object.freeze({
  OK: 'OK',
  FAILING: 'FAILING',
  STALE: 'STALE',
  OBSERVATION_UNAVAILABLE: 'OBSERVATION_UNAVAILABLE'
});
export const SELF_MONITORING_LIMIT = 'حلقة رصد بلا مؤقّت ولا جلب ولا مخزن: الملاحظات تُدخلها البنية الخارجية القائمة (زمن-CI: البوابات وci:notify والطبيب) والحالة تُحسب من أحدث ملاحظة ضد freshness_ttl — الغياب ليس سلامة بل OBSERVATION_UNAVAILABLE';

const MAX_MONITORS = 20;
const MAX_TTL_SECONDS = 365 * 24 * 3600;

function requireText(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`monitor_${field}_required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`monitor_${field}_too_long`);
  return trimmed;
}

function requireIsoTimestamp(value, field) {
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value.trim()))) {
    throw new Error(`monitor_${field}_invalid`);
  }
  return value.trim();
}

function requireFreshnessTtl(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > MAX_TTL_SECONDS) {
    throw new Error('monitor_freshness_ttl_invalid');
  }
  return value;
}

/** مرصود واحد مجمّد: هوية وطزاجة ومصدر إدخال الملاحظات. */
export function createMonitor({ id, label, freshnessTtlSeconds, source } = {}) {
  return Object.freeze({
    id: requireText(id, 'id', 100),
    label: requireText(label, 'label'),
    freshnessTtlSeconds: requireFreshnessTtl(freshnessTtlSeconds),
    source: requireText(source, 'source', 200)
  });
}

/**
 * حلقة الرصد مجمّدة: مراصد لا تقل عن واحد وهوياتها مميزة، وملاحظات تبدأ فارغة.
 * الغياب الابتدائي ليس حالة صحّة — انظر computeMonitorStatus.
 */
export function createMonitorLoop({ monitors } = {}) {
  if (!Array.isArray(monitors) || monitors.length < 1 || monitors.length > MAX_MONITORS) {
    throw new Error('monitor_loop_monitors_required');
  }
  const built = monitors.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('monitor_loop_monitors_required');
    return createMonitor(entry);
  });
  const ids = built.map((monitor) => monitor.id);
  if (new Set(ids).size !== ids.length) throw new Error('monitor_loop_ids_distinct');
  return Object.freeze({
    version: SELF_MONITORING_VERSION,
    monitors: Object.freeze(built),
    observations: Object.freeze([]),
    limit: SELF_MONITORING_LIMIT
  });
}

/** يُلحق ملاحظة بلا طفر: يعيد حلقة جديدة ولا يمسّ الأصل. */
export function recordObservation(loop, { monitorId, outcome, observedAt } = {}) {
  if (!loop || !Array.isArray(loop.monitors) || !loop.monitors.some((monitor) => monitor.id === monitorId)) {
    throw new Error('monitor_unknown');
  }
  if (!Object.values(OBSERVATION_OUTCOMES).includes(outcome)) {
    throw new Error('observation_outcome_unknown');
  }
  const at = requireIsoTimestamp(observedAt, 'observedAt');
  return Object.freeze({
    ...loop,
    observations: Object.freeze([
      ...loop.observations,
      Object.freeze({ monitorId, outcome, observedAt: at })
    ])
  });
}

/** الحاكم آخرُ ملاحظة أُدخلت بترتيب الإدخال (كما تصله من زمن-CI) — الطوابع تُقاس ضد freshness_ttl فقط. */
function latestObservation(loop, monitorId) {
  const matching = loop.observations.filter((observation) => observation.monitorId === monitorId);
  return matching.length ? matching[matching.length - 1] : null;
}

/**
 * حالة مرصود واحد تُحسب لا تُعلن، وstatusBasis يسمّي السبب دائمًا:
 * لا ملاحظة قطّ ⇒ OBSERVATION_UNAVAILABLE/no_observation · ملاحظة مستقبلية ⇒ clock_skew ·
 * فشل ⇒ FAILING أعمّ ما تكون عن الطزاجة · تخطٍّ ⇒ OBSERVATION_UNAVAILABLE (ليس نجاحًا) ·
 * نجاح أحدث من freshness_ttl ⇒ OK وفوقه ⇒ STALE (وعند التساوي: طازجة).
 */
export function computeMonitorStatus(loop, monitorId, { now } = {}) {
  if (!loop || !Array.isArray(loop.monitors)) throw new Error('monitor_unknown');
  const definition = loop.monitors.find((monitor) => monitor.id === monitorId);
  if (!definition) throw new Error('monitor_unknown');
  const at = requireIsoTimestamp(now ?? new Date().toISOString(), 'now');
  const latest = latestObservation(loop, monitorId);
  if (!latest) {
    return Object.freeze({ monitorId, status: MONITOR_STATUSES.OBSERVATION_UNAVAILABLE, statusBasis: 'no_observation' });
  }
  const ageMs = Date.parse(at) - Date.parse(latest.observedAt);
  if (ageMs < 0) {
    return Object.freeze({ monitorId, status: MONITOR_STATUSES.OBSERVATION_UNAVAILABLE, statusBasis: 'clock_skew_future_observation' });
  }
  if (latest.outcome === OBSERVATION_OUTCOMES.FAILED) {
    return Object.freeze({ monitorId, status: MONITOR_STATUSES.FAILING, statusBasis: 'latest_observation_failed' });
  }
  if (latest.outcome === OBSERVATION_OUTCOMES.SKIPPED) {
    return Object.freeze({ monitorId, status: MONITOR_STATUSES.OBSERVATION_UNAVAILABLE, statusBasis: 'latest_observation_skipped' });
  }
  if (ageMs > definition.freshnessTtlSeconds * 1000) {
    return Object.freeze({ monitorId, status: MONITOR_STATUSES.STALE, statusBasis: 'freshness_ttl_exceeded' });
  }
  return Object.freeze({ monitorId, status: MONITOR_STATUSES.OK, statusBasis: 'fresh_within_ttl' });
}

/**
 * حالة الحلقة كلّها: أسوأ الحالات تتقدّم (FAILING ثم STALE ثم OBSERVATION_UNAVAILABLE ثم OK)
 * بأساس مسمّى — لا ادعاء سلامة ما دام مرصود واحد بلا ملاحظة صالحة طازجة.
 */
export function computeLoopStatus(loop, { now } = {}) {
  const perMonitor = loop.monitors.map((monitor) => computeMonitorStatus(loop, monitor.id, { now }));
  const severity = {
    [MONITOR_STATUSES.FAILING]: 0,
    [MONITOR_STATUSES.STALE]: 1,
    [MONITOR_STATUSES.OBSERVATION_UNAVAILABLE]: 2,
    [MONITOR_STATUSES.OK]: 3
  };
  let worst = perMonitor[0];
  for (const entry of perMonitor) {
    if (severity[entry.status] < severity[worst.status]) worst = entry;
  }
  const basisBySeverity = {
    [MONITOR_STATUSES.FAILING]: 'any_monitor_failing',
    [MONITOR_STATUSES.STALE]: 'any_monitor_stale_beyond_ttl',
    [MONITOR_STATUSES.OBSERVATION_UNAVAILABLE]: 'some_observations_unavailable',
    [MONITOR_STATUSES.OK]: 'all_monitors_fresh_within_ttl'
  };
  return Object.freeze({
    version: SELF_MONITORING_VERSION,
    status: worst.status,
    statusBasis: basisBySeverity[worst.status],
    monitors: Object.freeze(perMonitor)
  });
}
