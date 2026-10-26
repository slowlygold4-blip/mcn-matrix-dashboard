// Pure view of already verified date-summary points. This is not a source/hash/asOf verifier.
// No Node imports: the same contract can be used by the local product and public browser.
export const DAILY_COVERAGE_METRICS = Object.freeze(['followers', 'likes', 'posts']);
export const DAILY_COVERAGE_REASONS = Object.freeze(['comparable', 'missingCurrent', 'missingBaseline']);
const DAY_MS = 86_400_000;
const POINT_KEYS = ['targetId', 'date', 'capturedAt', 'followers', 'followersAt', 'likes', 'likesAt', 'posts', 'postsAt'];
const MAX_DAYS = 366;

function demand(valid, detail) {
  if (!valid) {
    const error = new Error(`daily-coverage-invalid-${detail}`);
    error.code = error.message;
    throw error;
  }
}
const validId = value => Number.isSafeInteger(value) && value > 0 && value <= 99_999_999;

// Mirrors the existing strict calendar contract without pulling utils.mjs's node:crypto into a browser.
function dateMs(value) {
  demand(typeof value === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) && value.slice(0, 4) !== '0000', 'date');
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  demand(Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value, 'date');
  return ms;
}

function rangeDates(start, end) {
  const first = dateMs(start), last = dateMs(end);
  const count = (last - first) / DAY_MS + 1;
  demand(Number.isInteger(count) && count >= 1 && count <= MAX_DAYS, 'range');
  const baselineStart = new Date(first - DAY_MS).toISOString().slice(0, 10);
  dateMs(baselineStart);
  return { baselineStart, dates: Array.from({ length: count }, (_, i) => new Date(first + i * DAY_MS).toISOString().slice(0, 10)) };
}

function canonicalTime(value) {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}
function beijingDay(time) {
  return new Date(Date.parse(time) + 8 * 3_600_000).toISOString().slice(0, 10);
}

function selectedAccounts(accounts) {
  demand(Array.isArray(accounts), 'accounts');
  const seen = new Set(), selected = [];
  for (const account of accounts) {
    demand(account && typeof account === 'object' && !Array.isArray(account)
      && validId(account.id) && typeof account.enabled === 'boolean'
      && typeof account.label === 'string' && typeof account.platform === 'string' && account.platform.length > 0, 'account');
    demand(!seen.has(account.id), 'duplicate-account');
    seen.add(account.id);
    if (account.enabled === true) selected.push({ id: account.id, label: account.label, platform: account.platform });
  }
  return selected.sort((a, b) => a.id - b.id);
}

function selectedIndex(accounts, points, start, end) {
  demand(Array.isArray(points), 'points');
  const ids = new Set(accounts.map(account => account.id)), index = new Map();
  for (const point of points) {
    demand(point && typeof point === 'object' && !Array.isArray(point)
      && Object.keys(point).length === POINT_KEYS.length && POINT_KEYS.every(key => Object.hasOwn(point, key))
      && validId(point.targetId), 'point');
    dateMs(point.date);
    // Caller has already validated all sealed source points. Keep this index bounded to the applied scope.
    if (!ids.has(point.targetId) || point.date < start || point.date > end) continue;
    demand(canonicalTime(point.capturedAt) && beijingDay(point.capturedAt) === point.date, 'captured-at');
    for (const metric of DAILY_COVERAGE_METRICS) {
      const value = point[metric], at = point[`${metric}At`];
      demand(value === null || (Number.isSafeInteger(value) && value >= 0), 'metric-value');
      demand(at === null || (canonicalTime(at) && at <= point.capturedAt), 'metric-at');
      demand(value === null || (at !== null && beijingDay(at) === point.date), 'metric-at');
    }
    const key = `${point.date}/${point.targetId}`;
    demand(!index.has(key), 'duplicate-point');
    index.set(key, point);
  }
  return index;
}

function metricPair(current, baseline, metric) {
  const currentValue = current?.[metric] ?? null, baselineValue = baseline?.[metric] ?? null;
  const reason = currentValue === null ? 'missingCurrent'
    : baselineValue === null ? 'missingBaseline' : 'comparable';
  return { reason, currentValue, currentAt: current?.[`${metric}At`] ?? null,
    baselineValue, baselineAt: baseline?.[`${metric}At`] ?? null,
    delta: reason === 'comparable' ? currentValue - baselineValue : null };
}

/** One immutable-in-input count row per selected Beijing date. Missing data is never fabricated. */
export function buildDailyCoverage(accounts, points, { start, end } = {}) {
  const selected = selectedAccounts(accounts), { baselineStart, dates } = rangeDates(start, end);
  const index = selectedIndex(selected, points, baselineStart, end);
  return dates.map((date, position) => {
    const baselineDate = position === 0 ? baselineStart : dates[position - 1];
    const metrics = Object.fromEntries(DAILY_COVERAGE_METRICS.map(metric => [metric,
      { total: selected.length, observed: 0, comparable: 0, missingCurrent: 0, missingBaseline: 0 }]));
    for (const account of selected) {
      const current = index.get(`${date}/${account.id}`), baseline = index.get(`${baselineDate}/${account.id}`);
      for (const metric of DAILY_COVERAGE_METRICS) {
        const pair = metricPair(current, baseline, metric), counts = metrics[metric];
        counts[pair.reason]++;
        if (pair.currentValue !== null) counts.observed++;
      }
    }
    return { date, baselineDate, metrics };
  });
}

/** Stable ID-sorted drilldown; caller can page the returned current roster without losing members. */
export function dailyCoverageMembers(accounts, points, { date, metric, reason } = {}) {
  demand(DAILY_COVERAGE_METRICS.includes(metric), 'metric');
  demand(DAILY_COVERAGE_REASONS.includes(reason), 'reason');
  const selected = selectedAccounts(accounts), { baselineStart } = rangeDates(date, date);
  const index = selectedIndex(selected, points, baselineStart, date), rows = [];
  for (const account of selected) {
    const pair = metricPair(index.get(`${date}/${account.id}`), index.get(`${baselineStart}/${account.id}`), metric);
    if (pair.reason === reason) rows.push({ ...account, ...pair });
  }
  return rows;
}
