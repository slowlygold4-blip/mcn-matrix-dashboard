export const METRICS = { followers: '粉丝', likes: '点赞', estimatedPlays: '估算播放', posts: '作品存量' };
export { sourceColumns, accountStateLabel, unifiedRosterCaption, sourceMetricCell, sourceFactsMarkup, sourceWorksMarkup } from './unified-account-ui.js';
export { getWorkflowMetric, createWorkflowSummary, filterWorkflowAccounts } from './console-workflow.js?v=20261005-daily-workflow-1';
const NAV_PERIODS = new Set(['day', 'week', 'month', '30d', 'since', 'custom']);
const NAV_PLATFORMS = new Set(['all', 'douyin', 'bilibili', 'xiaohongshu', 'kuaishou']);
const NAV_ENABLED = new Set(['active', 'all', 'paused', 'source']);
const NAV_COLLECTION = new Set(['all', 'missing-profile', 'incomplete-works']);
const NAV_ACCOUNT_MODES = new Set(['operating', 'roster']);
const NAV_SORTS = new Set(['label', 'followers.value', 'followers.delta', 'likes.value', 'likes.delta', 'estimatedPlays.delta', 'posts.value', 'posts.delta', 'sourceSummary.works', 'sourceSummary.cumulativePlays', 'sourceSummary.cumulativeLikes']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(value) {
  const text = String(value || '');
  if (!ISO_DATE.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}
function dateDistance(start, end) { return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000); }
export function readNavigationState(input, options = {}) {
  const url = input instanceof URL ? new URL(input.href) : new URL(String(input || 'http://127.0.0.1/'), 'http://127.0.0.1/');
  const p = url.searchParams;
  let period = NAV_PERIODS.has(p.get('period')) ? p.get('period') : 'day';
  let start = p.get('start') || '', end = p.get('end') || '';
  const today = options.today && validDate(options.today) ? options.today : '';
  if (period === 'custom' && (!validDate(start) || !validDate(end) || start > end || dateDistance(start, end) > 366 || (today && end > today))) { period = 'day'; start = ''; end = ''; }
  const rawPage = Number(p.get('page'));
  const page = Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= 100000 ? rawPage : 1;
  const compareStart = p.get('compareStart') || '', compareEnd = p.get('compareEnd') || '';
  const compare = p.get('compare') === '1' && validDate(compareStart) && validDate(compareEnd) && compareStart <= compareEnd && dateDistance(compareStart, compareEnd) <= 366 && (!today || compareEnd <= today);
  return { board: p.get('board') || '', theme: p.get('theme') || 'all', classification: p.get('classification') || 'all', period, start, end,
    query: p.get('q') || '', platform: NAV_PLATFORMS.has(p.get('platform')) ? p.get('platform') : 'all',
    enabled: NAV_ENABLED.has(p.get('enabled')) ? p.get('enabled') : 'all', collectionFilter: NAV_COLLECTION.has(p.get('collectionFilter')) ? p.get('collectionFilter') : 'all',
    sort: NAV_SORTS.has(p.get('sort')) ? p.get('sort') : 'followers.delta', direction: p.get('direction') === 'asc' ? 'asc' : 'desc', page,
    accountMode: NAV_ACCOUNT_MODES.has(p.get('accountMode')) ? p.get('accountMode') : 'operating',
    compare, compareStart: compare ? compareStart : '', compareEnd: compare ? compareEnd : '',
    ...(compare && p.get('compareMode') === 'auto' ? { comparisonAuto: true } : {}) };
}
export function writeNavigationState(input, state = {}) {
  const url = input instanceof URL ? new URL(input.href) : new URL(String(input || 'http://127.0.0.1/'), 'http://127.0.0.1/');
  const values = { board: state.board, theme: state.theme !== 'all' ? state.theme : '', classification: state.classification !== 'all' ? state.classification : '',
    period: state.period !== 'day' ? state.period : '', start: state.period === 'custom' ? state.start : '', end: state.period === 'custom' ? state.end : '',
    q: state.query, platform: state.platform !== 'all' ? state.platform : '', enabled: state.enabled !== 'all' ? state.enabled : '',
    collectionFilter: state.collectionFilter !== 'all' ? state.collectionFilter : '', sort: state.sort !== 'followers.delta' ? state.sort : '', direction: state.direction !== 'desc' ? state.direction : '',
    page: Number(state.page) > 1 ? String(Math.floor(state.page)) : '', accountMode: state.accountMode === 'roster' ? 'roster' : '',
    compare: state.compare ? '1' : '', compareStart: state.compare ? state.compareStart : '', compareEnd: state.compare ? state.compareEnd : '',
    compareMode: state.compare && state.comparisonAuto === true ? 'auto' : '' };
  const allowed = new Set(Object.keys(values));
  [...url.searchParams.keys()].filter(key => allowed.has(key)).forEach(key => url.searchParams.delete(key));
  for (const [key, value] of Object.entries(values)) if (value !== '' && value != null) url.searchParams.set(key, String(value));
  return url;
}
export function numeric(value) { return value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value); }
export function formatNumber(value, exact = false) {
  const n = numeric(value); if (n === null) return '—';
  if (exact) return n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(2)}万`;
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}
export function shiftDate(date, days) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
export function beijingToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
export function periodEvidenceCaption(range) {
  if (!range?.end || !Number.isFinite(Date.parse(range.end))) return '统计截止时间待确认；缺测不补零。';
  const cutoff = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(range.end));
  const completion = range.partialEndDay === true ? '结束日尚未结束' : range.partialEndDay === false ? '所选日期已结束，缺采不代表已补齐' : '日期完成状态待确认';
  return `统计截止 ${cutoff}（北京时间）· ${completion}。按实际采样计数，不是实时数据。`;
}
export function metricObservationCaption(key, metric, total, endPoint) {
  if (key === 'estimatedPlays') return '点赞净变化 × 100 · 不是实际播放量';
  const count = endPoint?.[`${key}ObservedCount`];
  const daily = Number.isInteger(count) && count >= 0
    ? `选中末日 ${endPoint.date} 新采 ${count}/${total} 账号`
    : '选中末日新采覆盖待核验';
  const knownValue = metric.knownValue ?? metric.value;
  const knownCount = metric.knownCount ?? metric.observedCount;
  return `最近已知存量合计 ${formatNumber(knownValue)} · ${knownCount ?? '—'}/${total} 账号；${daily}`;
}
export function rangeFor(period, end = beijingToday()) {
  if (period === 'day') return { start: end, end };
  if (period === 'month') return { start: `${end.slice(0, 8)}01`, end };
  if (period === 'since') return { start: '2026-09-12', end };
  return { start: shiftDate(end, period === '30d' ? -29 : -6), end };
}
// Server-verified common-window evidence is optional. Preset/custom main
// metrics keep their exact requested scope; only the fixed since preset has a
// legacy, explicitly labelled fallback when its exact-period metrics are all absent.
export function hasRecordedWindowShape(data) {
  const window = data?.recordedWindow, range = window?.range;
  return Boolean(window && validDate(window.baselineDate) && validDate(window.endDate)
    && window.baselineDate < window.endDate && range?.startDate === shiftDate(window.baselineDate, 1)
    && range?.endDate === window.endDate && Array.isArray(window.accounts)
    && Object.keys(METRICS).every(key => window.metrics?.[key]));
}
function validRecordedWindowForRange(data) {
  if (!hasRecordedWindowShape(data)) return false;
  const window = data.recordedWindow, range = window.range;
  const requested = data.range, enabled = data.summary?.enabledCount, paired = window.comparableCount;
  if (!validDate(requested?.startDate) || !validDate(requested?.endDate)
      || window.baselineDate < shiftDate(requested.startDate, -1) || window.endDate > requested.endDate
      || !Number.isSafeInteger(enabled) || enabled <= 0 || window.enabledCount !== enabled
      || !Number.isSafeInteger(paired) || paired < Math.ceil(enabled * 0.9) || paired > enabled
      || !Object.keys(METRICS).every(key => window.metrics[key].deltaReliable === true
        && window.metrics[key].comparableCount === paired && numeric(window.metrics[key].delta) !== null)) return false;
  const cutoff = Date.parse(requested.end);
  return Number.isFinite(cutoff) && !(range.end && (!Number.isFinite(Date.parse(range.end)) || Date.parse(range.end) > cutoff))
    && !window.accounts.some(account => Object.values(account.metrics || {}).some(metric =>
      ['currentAt', 'comparisonCurrentAt', 'baselineAt'].some(key => metric?.[key] != null
        && (!Number.isFinite(Date.parse(metric[key])) || Date.parse(metric[key]) > cutoff))));
}
export function projectRecordedWindow(data, { period = data?.period, compare = false } = {}) {
  const window = data?.recordedWindow, range = window?.range;
  // Calendar presets and explicit ranges must remain strict on every surface.
  // A separately labelled common window is available below; never project it
  // into the selected-period KPI, ledger, account detail, or export.
  if (period !== 'since' || compare || data?.comparison || !hasRecordedWindowShape(data)) return data;
  // Keep any real result for the fixed business period, even a partial
  // cohort or observed zero. The shorter window only fills a wholly absent
  // growth presentation; it must not replace already measured growth.
  if (Object.keys(METRICS).some(key => numeric(data.summary?.metrics?.[key]?.delta) !== null)) return data;
  if (!validRecordedWindowForRange(data)) return data;
  const missingMetrics = metrics => Object.fromEntries(Object.keys(METRICS).map(key => [key,
    { ...metrics?.[key], delta: null, percent: null, comparable: false, dailyComparable: false,
      fullPeriodComparable: false, baseline: null, baselineAt: null, observedWindow: null,
      reason: '未取得该账号在共同起止日的完整三项快照，不计入已记录时段变化。' }]));
  const byAccount = new Map(window.accounts.map(account => [account.id, account.metrics]));
  const byBoard = new Map((window.boards || []).map(board => [board.key, board.metrics]));
  const accountMetrics = account => {
    const metrics = byAccount.get(account.id) || missingMetrics(account.metrics);
    return Object.fromEntries(Object.keys(METRICS).map(key => {
      const metric = metrics[key], original = account.metrics?.[key];
      if (metric?.comparable === true || numeric(original?.value) === null || key === 'estimatedPlays') return [key, metric];
      return [key, { ...metric, value: original.value, currentAt: original.currentAt,
        knownValue: original.knownValue, knownAt: original.knownAt, recordedStockOutsideWindow: true,
        reason: `${metric.reason || '缺少共同起止日快照，不计入净变化。'} 存量保留最近已知值，不代表共同结束日新采。` }];
    }));
  };
  return { ...data, requestedRange: data.range, effectiveMetricRange: range, activeRecordedWindow: window,
    summary: { ...data.summary, metrics: window.metrics },
    accounts: (data.accounts || []).map(account => ({ ...account, metrics: accountMetrics(account) })),
    boards: (data.boards || []).map(board => ({ ...board, metrics: byBoard.get(board.key) || missingMetrics(board.metrics) })) };
}
export function recordedWindowCaption(data) {
  const window = data?.activeRecordedWindow;
  return window ? `已记录时段净变化：${window.baselineDate} 采样 → ${window.endDate} 采样；所选 ${data.requestedRange.startDate} 至 ${data.requestedRange.endDate} 完整区间数据尚不齐全。按共同起止日的同一批账号计算，缺测不补零。` : '';
}
// A separate, reconciled preview: never overwrite selected-period data,
// change selection/exports, or combine growth from two different baselines.
export function buildRecordedWindowAlternative(data, { period = data?.period, compare = false } = {}) {
  if (!['week', 'month', '30d', 'since'].includes(period) || compare || data?.comparison || data?.activeRecordedWindow
      || !validRecordedWindowForRange(data) || !Array.isArray(data.accounts)) return null;
  const window = data.recordedWindow, keys = Object.keys(METRICS);
  const cohortKey = window.metrics.followers.deltaCohortKey;
  if (typeof cohortKey !== 'string' || !/^[a-f0-9]{64}$/.test(cohortKey)
      || !keys.every(key => window.metrics[key].deltaCohortKey === cohortKey)) return null;
  const strictCounts = keys.map(key => data.summary.metrics[key]?.comparableCount);
  if (!strictCounts.every(count => Number.isSafeInteger(count) && count >= 0 && count <= window.enabledCount)
      || !strictCounts.some(count => count < window.comparableCount)) return null;
  const sourceIds = new Set(data.accounts.map(account => account.id)), mapping = new Map();
  if (sourceIds.size !== data.accounts.length) return null;
  const beijingSampleDate = value => {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
    return new Date(Date.parse(value) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  };
  for (const account of window.accounts) {
    if (!Number.isSafeInteger(account?.id) || !sourceIds.has(account.id) || mapping.has(account.id)) return null;
    const comparable = account.metrics?.followers?.comparable;
    if (typeof comparable !== 'boolean' || !keys.every(key => account.metrics?.[key]?.comparable === comparable)) return null;
    if (comparable && !keys.every(key => beijingSampleDate(account.metrics[key].baselineAt) === window.baselineDate
      && ['currentAt', 'comparisonCurrentAt'].every(field => beijingSampleDate(account.metrics[key][field]) === window.endDate))) return null;
    mapping.set(account.id, account.metrics);
  }
  if (mapping.size !== sourceIds.size) return null;
  const view = { ...data, summary: { ...data.summary, metrics: window.metrics },
    accounts: data.accounts.map(account => ({ ...account, metrics: mapping.get(account.id) || {} })) };
  if (!keys.every(key => buildMetricContributions(view, key)?.reconciled === true)) return null;
  return { baselineDate: window.baselineDate, endDate: window.endDate,
    requestedRange: { startDate: data.range.startDate, endDate: data.range.endDate },
    enabledCount: window.enabledCount, comparableCount: window.comparableCount,
    metrics: Object.fromEntries(keys.map(key => [key, { delta: window.metrics[key].delta }])) };
}
// Presentation only. Preserve server values, and never expand a KPI/report scope.
export function buildTrendView(data, { period = data?.period, compare = false } = {}) {
  const range = data?.range || {};
  const validRange = (start, end) => validDate(start) && validDate(end) && start <= end && dateDistance(start, end) < 366;
  const background = period === 'day' && data?.period === 'day' && !compare && !data?.comparison
    && validRange(range.startDate, range.endDate) && range.startDate === range.endDate;
  const start = background ? shiftDate(range.endDate, -29) : range.startDate, end = range.endDate;
  const normalize = (rows, from, to) => {
    if (!validRange(from, to)) return [];
    const emptyPoint = (date, marker) => ({ date, ...Object.fromEntries(Object.keys(METRICS).flatMap(key =>
      ['', 'Delta', 'ComparableCount', 'ObservedCount', 'DeltaReliable', 'DeltaCohortKey'].map(suffix => [`${key}${suffix}`, null]))), ...marker });
    const byDate = new Map();
    for (const point of Array.isArray(rows) ? rows : []) {
      if (!point || !validDate(point.date) || point.date < from || point.date > to) continue;
      // A duplicate date has no ordering evidence. Do not choose either value.
      byDate.set(point.date, byDate.has(point.date) ? emptyPoint(point.date, { conflict: true }) : { ...point });
    }
    return Array.from({ length: dateDistance(from, to) + 1 }, (_, i) => {
      const date = shiftDate(from, i);
      return byDate.get(date) || emptyPoint(date, { missing: true });
    });
  };
  const comparisonRange = data?.comparison?.range || null;
  return { background, start, end, points: normalize(data?.summary?.trend, start, end), comparisonRange,
    comparison: comparisonRange ? normalize(data.comparison.summary?.trend, comparisonRange.startDate, comparisonRange.endDate) : [] };
}
export function compareNumbers(a, b, direction = 'desc') {
  const left = numeric(a), right = numeric(b);
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return direction === 'asc' ? left - right : right - left;
}
export function sortAccounts(rows, key, direction, period) {
  const [metric, field = 'value'] = key.split('.');
  const value = account => metric === 'sourceSummary' ? account.sourceSummary?.[field]
    : field === 'delta' ? periodDelta(account.metrics?.[metric], period) : account.metrics?.[metric]?.[field];
  return [...rows].sort((a, b) => {
    const result = key === 'label' ? String(a.label).localeCompare(String(b.label), 'zh-CN') * (direction === 'asc' ? 1 : -1)
      : compareNumbers(value(a), value(b), direction);
    return result || (typeof a.id === 'number' && typeof b.id === 'number' ? a.id - b.id : String(a.id).localeCompare(String(b.id)));
  });
}
export function periodDelta(metric, period) {
  if (!metric) return null;
  // Across missing dates is not a daily delta. Retain it only in the evidence.
  if (period === 'day' && metric.dailyComparable === false) return null;
  return numeric(metric.delta);
}
// Explanation only: never replace the server's metric or infer missing samples.
// The API has already scoped these accounts by board/theme/classification.
export function buildMetricContributions(data, key) {
  const metric = data?.summary?.metrics?.[key];
  if (!Object.hasOwn(METRICS, key) || !metric || !Array.isArray(data?.accounts)) return null;
  const enabled = data.accounts.filter(account => account.enabled === true);
  const seen = new Set(), groups = new Map(), rows = [];
  let invalid = false, total = 0;
  for (const account of enabled) {
    if (!Number.isSafeInteger(account.id) || account.id < 1 || seen.has(account.id)) { invalid = true; continue; }
    seen.add(account.id);
    const value = account.metrics?.[key];
    if (value?.comparable !== true || (data.period === 'day' && value.dailyComparable === false)) continue;
    if (!Number.isSafeInteger(value.delta)) { invalid = true; continue; }
    const source = account.metrics?.likes;
    if (key === 'estimatedPlays' && (source?.comparable !== true || (data.period === 'day' && source.dailyComparable === false)
        || !Number.isSafeInteger(source?.delta) || value.delta !== source.delta * 100)) { invalid = true; continue; }
    const theme = account.classification?.theme;
    const themeKey = typeof theme?.key === 'string' && theme.key ? theme.key : 'unassigned';
    const themeLabel = typeof theme?.label === 'string' && theme.label ? theme.label : '待归属';
    const row = { account, delta: value.delta, themeKey, themeLabel };
    rows.push(row);
    total += row.delta; if (!Number.isSafeInteger(total)) invalid = true;
    if (!groups.has(themeKey)) groups.set(themeKey, { key: themeKey, label: themeLabel, count: 0, delta: 0 });
    const group = groups.get(themeKey); group.count++; group.delta += row.delta;
    if (!Number.isSafeInteger(group.delta)) invalid = true;
  }
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.account.id - b.account.id);
  const delta = rows.length ? total : null;
  const summaryDelta = metric.delta === null ? null : Number.isSafeInteger(metric.delta) ? metric.delta : undefined;
  const likes = data.summary.metrics.likes;
  const proxyAligned = key !== 'estimatedPlays' || (likes?.comparableCount === metric.comparableCount
    && (summaryDelta === null ? likes?.delta === null : Number.isSafeInteger(likes?.delta) && likes.delta * 100 === summaryDelta));
  const reconciled = !invalid && (delta === null || Number.isSafeInteger(delta))
    && proxyAligned && summaryDelta !== undefined && delta === summaryDelta
    && rows.length === metric.comparableCount && enabled.length === data.summary.enabledCount;
  return { key, rows, groups: [...groups.values()].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.key.localeCompare(b.key)),
    enabledCount: enabled.length, comparableCount: rows.length, missingCount: enabled.length - rows.length,
    delta, summaryDelta, reconciled };
}
export function csvCell(value) {
  // Numeric declines must stay numbers when spreadsheets sum the export.
  // Only untrusted text needs formula-prefix protection; non-finite metrics
  // are unknown, not textual "NaN"/"Infinity" or fabricated zero.
  if (typeof value === 'number') return `"${Number.isFinite(value) ? String(value) : ''}"`;
  const text = String(value ?? '');
  const guarded = /^(?:\s*[=+@-]|[\t\r\n])/.test(text) ? `'${text}` : text;
  return `"${guarded.replaceAll('"', '""')}"`;
}
