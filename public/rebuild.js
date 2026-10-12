import { METRICS, numeric, formatNumber as fmt, beijingToday, rangeFor, shiftDate, sortAccounts, periodDelta, csvCell, periodEvidenceCaption, metricObservationCaption, readNavigationState, writeNavigationState, buildMetricContributions, buildTrendView, hasRecordedWindowShape, projectRecordedWindow, recordedWindowCaption, buildRecordedWindowAlternative, getWorkflowMetric, createWorkflowSummary, filterWorkflowAccounts } from './console-model.js?v=20261005-daily-workflow-1';

const $ = (id) => document.getElementById(id);
const READ_TIMEOUT_MS = 25_000;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const initial = new URL(location.href);
// Only a validated roster-to-target binding may supply historical search names.
// Pending source entries never become metric rows through this search index.
let rosterSearchAliases = new Map();
let rosterSearchSignature = '';
const navigation = readNavigationState(initial, { today: beijingToday() });
const workflowLabels = { all: '全部', growing: '增长', declining: '下滑', unobserved: '缺可比数据' };
const state = { session: null, csrf: '', ...navigation,
  workflowTask: Object.hasOwn(workflowLabels, initial.searchParams.get('task')) ? initial.searchParams.get('task') : 'all',
  workflowMetric: getWorkflowMetric(initial.searchParams.get('metric')),
  view: 'overview', pageSize: 20, metric: 'followers', explanationKey: null, data: null, requestId: 0, busy: false, detailId: null };
let controller = null;
let topicController = null;
let detailController = null;
let detailRequest = 0;
let accountHistory = null;
let historyGeneration = 0;
let topicRequest = 0;
let topicSnapshot = null, topicReadFailed = false;
let topicReadContext = null;
let importRequest = 0;
let importResultCommitted = false;
let importSubmissionSequence = 0, importJobSelectionVersion = 0;
const IMPORT_IDEMPOTENCY_STORAGE_KEY = 'mcnImportIdempotencyKeysV1';
const IMPORT_IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const importIdempotencyMemory = new Map();
const acceptedImportJobs = new Map();
let acceptedImportJobsSignature = '';
let currentImportJob = null, importJobReadVersion = 0, importJobReadPromise = null;
let recentImportJobsPromise = null, recentImportJobsReadAt = 0;
let pasteDraftVersion = 0, activePastePreview = null, pastePreviewPending = false;
let sourceImportSignature = '';
let detailTrigger = null;
let detailTriggerId = null;
let drawerClosing = false;
let detailCloseAnimation = null;
const DETAIL_HISTORY_KEY = 'mcnAccountDetail';
const detailHistoryOwner = `${Date.now()}-${Math.random()}`;
let detailHistorySequence = 0;
let detailHistoryContext = null;
let pendingModalCloseTraversal = null;
let ledgerMode = null, ledgerMetric = 'followers', detailTrendAccount = null, detailTrendMetric = 'followers';
let ledgerPrintState = null;
const chartReadings = new Map();
let detailTrendRange = null;
let detailTrendComparison = null;
let monitoringRequest = 0;
let showCustomClassifications = false;
let liveSync = null, liveTimer = null, liveFlushTimer = null;
let collectionRefresh = null;
let collectionReadPending = false;
let appliedRequest = null, appliedContext = null, latestMonitoringStatus = null;
let pendingInsightsRead = null;
let importWorkspaceReadPromise = null, importWorkspaceReadOwner = null;
let insightsNeedRead = true, navigationRangePending = true;
let lastUserActivity = 0;
let comparisonAuto = !navigation.compare || navigation.comparisonAuto === true;
let previousComparisonDraft = null;
const platformNames = { douyin: '抖音', bilibili: 'B站', xiaohongshu: '小红书', kuaishou: '快手' };
const periodLabels = { day: '今日', week: '近 7 天', month: '本月', '30d': '近 30 天', since: '9月12日起', custom: '自定义日期' };
const dateTime = (v) => v ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(v)) : '尚无采样';
const signed = (v) => numeric(v) === null ? '<span class="flat">—</span>' : `<span class="${v > 0 ? 'up' : v < 0 ? 'down' : 'flat'}" title="${esc(fmt(v, true))}">${v > 0 ? '+' : ''}${fmt(v)}</span>`;

async function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...options.headers };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
  const read = String(options.method || 'GET').toUpperCase() === 'GET';
  const requestController = read ? new AbortController() : null;
  const callerSignal = options.signal;
  let timeoutId = null, rejectCallerAbort = null;
  const callerAbort = read ? new Promise((_, reject) => { rejectCallerAbort = reject; }) : null;
  const abortCallerRead = () => {
    requestController?.abort();
    const error = new Error('读取已取消'); error.name = 'AbortError';
    rejectCallerAbort?.(error);
  };
  const onCallerAbort = () => abortCallerRead();
  if (read && callerSignal?.aborted) abortCallerRead();
  else if (read && callerSignal) callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  const requestOptions = { credentials: 'same-origin', ...options, headers,
    ...(read ? { signal: requestController.signal } : {}) };
  const perform = async () => {
    const response = await fetch(path, requestOptions);
    const body = await response.json().catch(() => null);
    if (!response.ok) { const error = new Error(body?.error || `请求失败（${response.status}）`); error.status = response.status; throw error; }
    if (!body) throw new Error('服务器未返回有效数据');
    return body;
  };
  if (!read) return perform();
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  timeoutId = setTimeout(() => {
    const error = new Error(`读取超过 ${READ_TIMEOUT_MS / 1000} 秒仍未完成；已保留上次快照，可刷新重试。`);
    error.name = 'TimeoutError';
    requestController.abort();
    rejectDeadline(error);
  }, READ_TIMEOUT_MS);
  try { return await Promise.race([perform(), deadline, callerAbort]); }
  finally {
    clearTimeout(timeoutId);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}
function notice(message = '', error = false) { $('notice').textContent = message; $('notice').className = `notice ${error ? 'error' : ''}`; $('notice').hidden = !message; }
function appliedRange() { return state.data?.range?.startDate && state.data?.range?.endDate ? { start: state.data.range.startDate, end: state.data.range.endDate } : { start: state.start, end: state.end }; }
function effectiveMetricRange() { const range = state.data?.effectiveMetricRange; return range ? { start: range.startDate, end: range.endDate } : appliedRange(); }
function reducedMotion() { return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; }
function loadingMarkup(message) { return `<div class="loading-state" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>${esc(message)}</span></div>`; }
function setLoadFeedback(mode, markup) {
  const feedback = $('loadFeedback');
  feedback.setAttribute?.('data-state', mode === 'partial' ? 'warning' : mode);
  feedback.setAttribute?.('data-read-state', mode);
  feedback.hidden = mode === 'success';
  feedback.innerHTML = markup;
}
function busy(value, outcome = 'success') {
  state.busy = value;
  $('refreshBtn').disabled = value; $('applyDateBtn').disabled = value;
  $('refreshBtn').textContent = value ? '读取中…' : '刷新快照';
  renderCollectionRefresh();
  $('main').setAttribute('aria-busy', String(value));
  const warning = !value && !$('notice').hidden;
  const partial = state.view === 'topics' && topicReadFailed;
  const mode = value ? 'loading' : outcome === 'error' ? 'error' : partial ? 'partial' : warning ? 'warning' : 'success';
  $('connectionStatus').textContent = ({ loading: '正在读取快照', error: '快照读取失败', partial: '快照部分读取失败', warning: '筛选需要检查', success: '快照已读取' })[mode];
  $('connectionStatus').setAttribute?.('data-state', mode === 'partial' ? 'warning' : mode);
  setLoadFeedback(mode, value
    ? `${loadingMarkup(state.data ? '正在读取所选范围 · 下方保留上次成功快照' : '正在读取账号与每日快照…')}`
    : outcome === 'error'
      ? '<span>未取得新结果，请查看上方提示并重试。</span>'
      : partial ? '<span>账号快照已读取；话题读取失败，请在话题区域重试。保留内容以原日期为准。</span>'
      : warning ? '<span>快照已读取；当前筛选有待检查项。</span>'
      : '<span>已读取保存的快照</span><small>实际采样时间与覆盖见下方；自动页面同步只读取数据，手动刷新快照才发起采集。</small>');
  if (!value && collectionReadPending) void Promise.resolve().then(refreshAfterCollection);
}
function coreUpdateCoverage(value) {
  const integer = number => Number.isInteger(number) && number >= 0;
  if (!value || !integer(value.total) || !integer(value.complete) || value.complete > value.total
      || value.missing !== value.total - value.complete || value.requiredPercent !== 80) return '未知（尚无有效更新率统计）';
  if (value.total === 0) return value.ratioPercent === null && value.status === 'unknown' ? '0 / 0 · 无启用账号，状态未知' : '未知（统计字段需核对）';
  const ratio = value.complete / value.total * 100, met = value.complete * 100 >= 80 * value.total;
  if (typeof value.ratioPercent !== 'number' || !Number.isFinite(value.ratioPercent)
      || Math.abs(value.ratioPercent - ratio) > 0.000001 || value.status !== (met ? 'met' : 'below-target')) return '未知（统计字段需核对）';
  return `${(Math.floor(ratio * 10) / 10).toFixed(1)}% · ${fmt(value.complete, true)} / ${fmt(value.total, true)} · ${met ? '核心三项达标' : '核心三项未达标'}`;
}
function verifiedWorksCoverageCounts(value) {
  const counts = value?.counts;
  const keys = ['complete', 'limited', 'unavailable', 'unknown', 'missing'];
  if (!Number.isInteger(value?.total) || value.total < 0 || !Number.isInteger(value?.complete)
      || !counts || keys.some(key => !Number.isInteger(counts[key]) || counts[key] < 0)
      || keys.reduce((sum, key) => sum + counts[key], 0) !== value.total || counts.complete !== value.complete) {
    return null;
  }
  return { ...counts, total: value.total, sampleAvailable: counts.complete + counts.limited };
}
function worksSampleCoverage(value, formatCount = fmt) {
  const counts = verifiedWorksCoverageCounts(value);
  return counts ? `${formatCount(counts.sampleAvailable)}/${formatCount(counts.total)}` : '—/—';
}
function worksCoverageBreakdown(value, formatCount = fmt) {
  const counts = verifiedWorksCoverageCounts(value);
  if (!counts) return '近 8 小时作品明细分类待确认';
  const diagnostics = value.latestAttemptDiagnostics;
  const reasonKeys = ['http403', 'loginRequired', 'rateLimited', 'collectorPartial', 'collectorUnavailable', 'networkError', 'upstreamChanged', 'other'];
  const validDiagnostics = diagnostics && Number.isInteger(diagnostics.attemptedTargets) && diagnostics.attemptedTargets >= 0
    && diagnostics.attemptedTargets <= counts.total && Number.isInteger(diagnostics.failureCount) && diagnostics.failureCount >= 0
    && diagnostics.failureCount <= diagnostics.attemptedTargets && diagnostics.reasons
    && reasonKeys.every(key => Number.isInteger(diagnostics.reasons[key]) && diagnostics.reasons[key] >= 0)
    && reasonKeys.reduce((sum, key) => sum + diagnostics.reasons[key], 0) === diagnostics.failureCount;
  const labels = { http403: 'HTTP 403 访问被拒', loginRequired: '需要登录/授权', rateLimited: '触发限流',
    collectorPartial: '采集异常（有样本）', collectorUnavailable: '采集未完成', networkError: '网络/响应异常',
    upstreamChanged: '上游响应变化', other: '其他已记录异常' };
  const reasons = validDiagnostics && diagnostics.failureCount
    ? ` · 已核验的最近尝试异常 ${formatCount(diagnostics.failureCount)} / ${formatCount(diagnostics.attemptedTargets)} 个有记录账号：${reasonKeys.filter(key => diagnostics.reasons[key] > 0).map(key => `${labels[key]} ${formatCount(diagnostics.reasons[key])}`).join('、')}`
    : '';
  return `近 8 小时作品明细：有样本 ${formatCount(counts.sampleAvailable)} / ${formatCount(counts.total)}（完整 ${formatCount(counts.complete)}） · 有限 ${formatCount(counts.limited)} · 未取得 ${formatCount(counts.unavailable)} · 未核验 ${formatCount(counts.unknown)} · 无记录 ${formatCount(counts.missing)}${reasons}`;
}
function coreUpdateMarkup(sla) {
  return `<div class="monitoring-sla"><strong>全局核心三项更新率</strong><p>今日更新：${coreUpdateCoverage(sla?.coreAccounts?.daily)}<br>近 8 小时新鲜率：${coreUpdateCoverage(sla?.coreAccounts?.fresh8h)}</p><small>核心三项 = 粉丝、获赞、作品存量；目标 ≥80%，分母为全部启用账号（含手动/失败账号）。不代表作品明细或话题完整，也不代表取得实际播放量。</small></div>`;
}
function sourceTaskReadout(source, count) {
  const current = source.currentJobScope === 'registered-source-latest-import-jobs-not-author-identity-queue';
  const unknown = current && Number.isSafeInteger(source.activeJobUnknownCount) && source.activeJobUnknownCount >= 0
    ? source.activeJobUnknownCount : null;
  const active = current && unknown === 0 ? source.activeJobCount : null;
  const historical = source.historicalReviewSourceCountUnit === 'sources-with-historical-pending-completion-receipts-not-authors'
    ? source.historicalReviewSourceCount : source.businessPendingCount;
  return { active: count(active), historical: count(historical),
    unknownNote: unknown === null ? '任务实时状态未确认' : unknown > 0 ? `${count(unknown)} 个任务引用状态未确认` : '' };
}
function openSourceReview() {
  setView('import');
  $('sourceImportHistory').open = true;
  const region = $('sourceImportResults');
  region.setAttribute?.('tabindex', '-1');
  region.focus?.({ preventScroll: true });
  region.scrollIntoView?.({ block: 'start', behavior: 'auto' });
}
async function loadMonitoringStatus({ signal, rethrow = false } = {}) {
  const id = ++monitoringRequest;
  const panel = $('monitoringStatus');
  panel.setAttribute?.('aria-busy', 'true');
  try {
    const data = await api('/api/monitoring-status', signal ? { signal } : {});
    if (id !== monitoringRequest) return data;
    latestMonitoringStatus = data;
    const scheduler = data.scheduler || {}, source = data.sourcePoller || {};
    const browserLane = data.browserLane || {}, laneLocked = browserLane.locked === true;
    const laneReasons = { BROWSER_CLEANUP_UNCERTAIN: '旧采集进程退出尚未确认', BROWSER_PROTOCOL_INVALID: '进程通信校验未通过', BROWSER_OWNERSHIP_CHANGED: '采集进程身份已变化', BROWSER_OWNERSHIP_UNKNOWN: '无法确认采集进程身份', BROWSER_LANE_LOCKED: '作品采集安全锁定' };
    const laneReason = Object.hasOwn(laneReasons, browserLane.reason) ? laneReasons[browserLane.reason] : '作品采集安全检查未通过';
    const count = value => Number.isInteger(value) && value >= 0 ? fmt(value, true) : '—';
    const times = Array.isArray(scheduler.slotTimes) ? scheduler.slotTimes.filter(time => /^\d{2}:\d{2}$/.test(time)).join(' / ') : '';
    const next = scheduler.nextRunAt && Number.isFinite(Date.parse(scheduler.nextRunAt)) ? dateTime(scheduler.nextRunAt) : '待确认';
    const hours = Number.isFinite(scheduler.scheduleIntervalHours) && scheduler.scheduleIntervalHours > 0 ? `每 ${scheduler.scheduleIntervalHours} 小时` : '计划待确认';
    const total = count(scheduler.scheduledAccountTargetCount);
    const topicTotal = count(scheduler.scheduledTopicTargetCount);
    const topicComplete = count(scheduler.scheduledTopicMetricCompletedTargetCount);
    const topicState = Number.isInteger(scheduler.scheduledTopicTargetCount) && Number.isInteger(scheduler.scheduledTopicMetricCompletedTargetCount)
      ? scheduler.scheduledTopicTargetCount === 0 ? '未配置话题' : scheduler.scheduledTopicMetricCompletedTargetCount === scheduler.scheduledTopicTargetCount ? '本轮齐全' : '本轮有缺项'
      : '覆盖待确认';
    const runLabel = laneLocked ? '作品通道暂停 · 主页/话题独立调度' : scheduler.running === true ? '正在采集' : scheduler.running === false ? '等待计划时点' : '运行状态待确认';
    const staleChecked = Number.isInteger(source.staleCount) && source.staleCount >= 0
      && Number.isInteger(source.uncheckedCount) && source.uncheckedCount >= 0
      ? Math.max(0, source.staleCount - source.uncheckedCount) : null;
    const sourceAlerts = [['未检查', source.uncheckedCount], ['失败', source.failedCount], ['受限', source.blockedCount], ['过期', staleChecked]]
      .filter(([, value]) => !Number.isInteger(value) || value !== 0).map(([label, value]) => `${label} ${count(value)}`);
    if (source.currentJobScope === 'registered-source-latest-import-jobs-not-author-identity-queue') {
      if (Number.isSafeInteger(source.currentFailedJobCount) && source.currentFailedJobCount > 0) sourceAlerts.push(`来源任务失败 ${count(source.currentFailedJobCount)}`);
      if (Number.isSafeInteger(source.activeJobUnknownCount) && source.activeJobUnknownCount > 0) sourceAlerts.push(`任务状态未确认 ${count(source.activeJobUnknownCount)}`);
    }
    const sourceTasks = sourceTaskReadout(source, count);
    const worksBreakdown = worksCoverageBreakdown(data.updateSla?.works?.fresh8h, count);
    const worksCounts = verifiedWorksCoverageCounts(data.updateSla?.works?.fresh8h);
    const worksSample = worksSampleCoverage(data.updateSla?.works?.fresh8h, count);
    const worksComplete = worksCounts ? `${count(worksCounts.complete)}/${count(worksCounts.total)}` : '—/—';
    const brief = $('monitoringBrief');
    const sourceState = source.status === 'error' ? 'error' : source.status === 'ok' && sourceAlerts.length === 0 ? 'ready' : 'warning';
    brief.textContent = `全局本轮主页 ${count(scheduler.scheduledProfileCompletedTargetCount)}/${total} · 近 8 小时完整作品明细 ${worksComplete} · 有作品样本 ${worksSample} · 话题双指标 ${topicComplete}/${topicTotal} · 来源今日已检查 ${count(source.checkedTodayCount)}/${count(source.sourceCount)} · 成功读取 ${count(source.successfulTodayCount)} · 来源任务在途 ${sourceTasks.active}${sourceAlerts.length ? ` · ${sourceAlerts.join(' · ')}` : ''}`;
    if (laneLocked) brief.textContent = `作品采集进程暂停（安全检查未通过） · ${brief.textContent}`;
    brief.setAttribute?.('data-state', laneLocked ? 'error' : sourceState);
    panel.innerHTML = `<div class="monitoring-column"><div class="monitoring-title"><strong>账号自动更新 · ${esc(hours)}</strong><span class="monitoring-state${scheduler.running === true ? ' is-running' : ''}">${runLabel}</span></div><p>北京时间 ${esc(times || '时点待确认')} · 下一次 ${esc(next)}</p><small>本轮主页 ${count(scheduler.scheduledProfileCompletedTargetCount)} / ${total} · 近 8 小时完整作品明细 ${worksComplete}。</small><small>${esc(worksBreakdown)}。完整表示连续公开分页通过校验且与主页总数匹配；跨批次采样不是同一时点快照。有限表示只覆盖已确认的公开窗口；无记录表示此时段没有有效明细采样，不代表账号没有作品。</small><small>公开作品窗口不等于全部历史作品。官方账号视频列表需应用审核、video.list 权限及账号持有人授权，且最多4页；本台目前没有此官方授权连接器，不能匿名查全矩阵。<a href="https://open.douyin.com/platform/resource/docs/openapi/video-management/douyin/search-video/account-video-list/" target="_blank" rel="noopener noreferrer">查看抖音官方权限与范围</a></small></div><div class="monitoring-column"><div class="monitoring-title"><strong>话题每日监控 · 双指标</strong><span>${esc(topicState)}</span></div><p>参与人数与实际播放量均有有效观测 ${topicComplete} / ${topicTotal}</p><small>两项须分别有本轮真实观测；话题只展示平台参与人数和累计实际播放量，不使用点赞换算。历史缺日不补齐。</small></div><div class="monitoring-column"><div class="monitoring-title"><strong>名单来源 · 每日检查</strong><span>今日已检查 ${count(source.checkedTodayCount)} / ${count(source.sourceCount)}</span></div><p>成功读取 ${count(source.successfulTodayCount)} · 未检查 ${count(source.uncheckedCount)} · 失败 ${count(source.failedCount)} · 访问受限 ${count(source.blockedCount)} · 过期 ${count(staleChecked)}</p><p>来源任务在途 ${sourceTasks.active}${sourceTasks.unknownNote ? ` · ${esc(sourceTasks.unknownNote)}` : ''}<br>历史回执含待审记录：${sourceTasks.historical} 个来源</p><small>在途数只统计已登记来源最近导入任务，不是作者核验队列。历史回执保留任务完成时的结果，不代表当前仍在排队；来源读取成功也不等于账号已接入。</small><button class="link-btn" type="button" data-open-source-review>查看来源回执与逐项审查 →</button></div>`;
    panel.innerHTML += coreUpdateMarkup(data.updateSla);
    if (laneLocked) {
      const lockedAt = typeof browserLane.lockedAt === 'string' && Number.isFinite(Date.parse(browserLane.lockedAt)) ? ` · 发现于 ${dateTime(browserLane.lockedAt)}` : '';
      const recovery = browserLane.recoveryEligible === true ? '等待旧进程退出后自动复核；复核前不重启作品采集。' : '需服务安全恢复；不会自动绕过检查。';
      panel.innerHTML = `<div class="monitoring-column monitoring-lane-warning" role="status"><strong>作品采集进程暂停（安全检查未通过）</strong><p>${esc(laneReason)}${esc(lockedAt)}。</p><small>${recovery}主页和话题独立调度，其成功情况以下方各自覆盖为准；已保存数据不受影响。</small></div>${panel.innerHTML}`;
    }
    if (!laneLocked && scheduler.worksOnlyRetry?.deferred === true) {
      const retryAt = scheduler.worksOnlyRetry.nextEligibleAt;
      const retryLabel = typeof retryAt === 'string' && Number.isFinite(Date.parse(retryAt)) ? dateTime(retryAt) : '待确认';
      panel.innerHTML += `<p class="monitoring-column" role="status">作品补采连续失败，已暂停重试；最早 ${esc(retryLabel)} 后自动复查。主页与话题的既有更新计划不变，已保存数据保留。</p>`;
    }
    renderSourceImportResults(source);
    if (typeof CustomEvent === 'function') document.dispatchEvent?.(new CustomEvent('mcn:master-roster-refresh', { detail: { force: false } }));
    if (state.view === 'import' && !document.hidden && ['queued', 'running'].includes(currentImportJob?.status)) void loadImportJob();
    return data;
  } catch (error) {
    if (signal?.aborted) { if (rethrow) throw error; return; }
    if (id !== monitoringRequest) return;
    panel.innerHTML = '<p class="monitoring-unavailable">自动更新状态暂不可用；不影响下方已保存的快照。刷新后重试。</p>';
    $('monitoringBrief').textContent = '状态暂不可用 · 已保存快照仍可查看';
    $('monitoringBrief').setAttribute?.('data-state', 'error');
    $('sourceImportFreshness').textContent = '来源状态读取未完成；下方保留上次已读的历史回执。';
    if (rethrow) throw error;
  } finally {
    if (id === monitoringRequest) panel.setAttribute?.('aria-busy', 'false');
    syncImportMonitoring();
  }
}
function committedControls() {
  return { board: state.board, theme: state.theme, classification: state.classification, period: state.period,
    start: state.start, end: state.end, compare: state.compare, comparisonAuto,
    compareStart: $('compareStart').value, compareEnd: $('compareEnd').value };
}
function validateInsights(data, controls = {}) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const objectList = value => Array.isArray(value) && value.every(object);
  const optionalObjectList = value => value == null || objectList(value);
  const day = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  const range = value => object(value) && day(value.startDate) && day(value.endDate) && value.startDate <= value.endDate;
  const summary = value => object(value) && object(value.metrics) && Array.isArray(value.trend) && value.trend.every(object);
  const catalog = value => value == null || object(value) && (value.items == null || objectList(value.items));
  const account = value => object(value) && optionalObjectList(value.boards) && optionalObjectList(value.trend)
    && (value.metrics == null || object(value.metrics))
    && (value.classification == null || object(value.classification) && optionalObjectList(value.classification.labels));
  const sources = value => value == null || Array.isArray(value) && value.every(source => object(source)
    && (source.urls == null || Array.isArray(source.urls) && source.urls.every(url => typeof url === 'string')));
  const requestedPeriod = controls.period || data?.period;
  const periodCanUseRecordedWindow = ['week', 'month', '30d', 'since'].includes(requestedPeriod);
  const comparisonRequested = controls.compare === true || data?.comparison != null;
  const strictMetricsIncomplete = object(data?.summary?.metrics)
    && Object.keys(METRICS).some(key => numeric(data.summary.metrics[key]?.delta) === null);
  const recordedWindowContractInvalid = periodCanUseRecordedWindow && !comparisonRequested && strictMetricsIncomplete
    && (!Object.prototype.hasOwnProperty.call(data, 'recordedWindow')
      || data.recordedWindow !== null && !hasRecordedWindowShape(data));
  if (!object(data) || !range(data.range) || !Array.isArray(data.accounts) || !data.accounts.every(account) || !summary(data.summary)
      || !optionalObjectList(data.boards) || !catalog(data.themeSummary) || !catalog(data.classificationSummary) || !sources(data.classificationSources)
      || (data.comparison != null && (!object(data.comparison) || !range(data.comparison.range) || !summary(data.comparison.summary)))
      || recordedWindowContractInvalid) {
    if (recordedWindowContractInvalid) throw new Error('后台共同采样窗口字段缺失或无效，数据读取版本可能未同步；已保留上次画面，请联系管理员检查后台服务。');
    throw new Error('快照响应不完整，未替换已保存的画面');
  }
  return data;
}
function validateTopics(data) {
  if (!data || !Array.isArray(data.topics) || data.topics.some(topic => !topic || !Array.isArray(topic.points)
      || topic.points.some(point => !point || typeof point !== 'object'))) throw new Error('话题快照响应不完整，未采用本次记录');
  return data;
}
function presentationControls() { return state.view === 'import' ? committedControls() : appliedContext || committedControls(); }
function rememberAppliedRequest(query, dispatchedControls = committedControls(), observedRange = null) {
  appliedRequest = query; appliedContext = { ...dispatchedControls, start: observedRange?.startDate || state.start, end: observedRange?.endDate || state.end };
  liveSync?.markApplied(latestMonitoringStatus);
}
function automaticScopeKey() {
  return JSON.stringify([appliedRequest, state.board, state.theme, state.classification, state.period, state.compare, state.view]);
}
function hasUnappliedScope() {
  if (!appliedContext) return true;
  const current = committedControls();
  return ['board', 'theme', 'classification', 'period', 'compare', 'start', 'end'].some(key => current[key] !== appliedContext[key])
    || (state.period === 'custom' && ($('startDate').value !== appliedContext.start || $('endDate').value !== appliedContext.end))
    || (state.compare && (current.comparisonAuto !== appliedContext.comparisonAuto || current.compareStart !== appliedContext.compareStart || current.compareEnd !== appliedContext.compareEnd));
}
function updateCustomDateDraftNotice() {
  if (state.period !== 'custom') return;
  notice(hasUnappliedScope()
    ? state.data
      ? '日期范围或对比尚未应用；当前显示数据与导出仍使用已应用范围。点击「应用」后才会更新。'
      : '日期范围尚未应用；点击「应用」后读取所选范围。'
    : '日期与已应用范围一致；当前显示数据与导出范围未改变。');
}
function syncDataBlockedReason() {
  if ($('accountDialog').open) return '正在查看账号详情，关闭后同步';
  if (!importResultCommitted && (!$('importPreview').hidden || $('fileInput').files?.length || $('pasteAuthorsText')?.value?.trim())) return '保留导入草稿，完成或取消后同步';
  if (state.view === 'import') return currentImportJob ? '正在查看导入结果，返回看板后同步' : '正在查看导入页，返回看板后同步';
  if (!appliedContext) return '等待首次快照';
  if (hasUnappliedScope()) return '保留未应用的日期或筛选，请先应用或恢复';
  return '';
}
function syncBlockedReason() {
  const blocked = syncDataBlockedReason();
  if (blocked) return blocked;
  // This selector is not rebuilt or assigned during automaticApply. Merely
  // leaving focus on its already-applied value must not freeze the dashboard.
  const stablePeriodFocus = document.activeElement === $('periodSelect')
    && $('periodSelect').value === appliedContext.period;
  if (!stablePeriodFocus && document.activeElement?.matches?.('input,select,textarea,[contenteditable="true"]')) return '正在输入，离开输入框后同步';
  // These outer summaries survive automaticApply; only their content panels
  // change. Keeping keyboard focus here must not freeze fresh snapshots.
  // Dynamically rebuilt metric/topic summaries and links remain protected.
  const active = document.activeElement;
  const stableDisclosureFocus = active?.tagName === 'SUMMARY'
    && ['operationsDetails', 'filterDetails', 'rosterDistribution'].some(id => $(id)?.firstElementChild === active);
  if (!stableDisclosureFocus && active?.matches?.('summary,a')) return '保留当前阅读焦点，移开后同步';
  if (Date.now() - lastUserActivity < 1500) return '操作完成后同步';
  return '';
}
function deriveReadRequest(controls, { advance = false } = {}) {
  const context = { ...controls };
  if (advance && context.period !== 'custom') {
    Object.assign(context, rangeFor(context.period));
    if (context.compare && context.comparisonAuto) {
      const previous = previousEqualPeriod(context.start, context.end);
      if (previous) { context.compareStart = previous.start; context.compareEnd = previous.end; }
    }
  }
  // Pin both endpoints, including today/month. An implicit server clock may
  // cross midnight after dispatch and must not split primary/comparison dates.
  const query = new URLSearchParams({ period: context.period === 'day' ? 'day' : 'custom',
    board: context.board, theme: context.theme, classification: context.classification,
    startDate: context.start, endDate: context.end });
  if (context.compare) {
    query.set('comparisonStartDate', context.compareStart); query.set('comparisonEndDate', context.compareEnd);
    // Overview reads only B's summary/range. Account detail uses its own full
    // comparison endpoint; never send this projection with that request.
    query.set('comparisonProjection', 'summary');
  }
  return { query: query.toString(), context };
}
async function automaticRead({ signal }) {
  if (!appliedRequest || !appliedContext) throw new Error('尚无已应用的数据范围');
  const request = deriveReadRequest(appliedContext, { advance: true });
  const insights = validateInsights(await api(`/api/rebuild/insights?${request.query}`, { signal }), request.context);
  signal?.throwIfAborted?.();
  const topics = state.view === 'topics' ? validateTopics(await api(`/api/topics/history?startDate=${insights.range.startDate}&endDate=${insights.range.endDate}`, { signal })) : null;
  return { insights, topics, query: request.query };
}
function captureReadingPosition() {
  const active = document.activeElement;
  let anonymousDetailsIndex = 0;
  const dataKey = ['accountId', 'sort', 'page', 'metric', 'metricExplanation', 'contributionLedger', 'view', 'theme', 'classification', 'collectionFilter', 'workflowTask'].find(key => active?.dataset?.[key]);
  const root = active?.closest?.('#accountsTable,#overviewTable,#pager,#accountsPagerTop,#metricTabs,#themeGrid,#classificationGrid,#classificationSources,#kpiGrid,#metricExplanation,#dailyWorkflow,#accountWorkflow');
  return { active, id: active?.id, dataKey, dataValue: dataKey ? active.dataset[dataKey] : null, rootId: root?.id,
    x: window.scrollX, y: window.scrollY,
    scrollers: ['accountsTable', 'overviewTable', 'topicsGrid'].map(id => ({ id, left: $(id).scrollLeft, top: $(id).scrollTop })),
    details: [...document.querySelectorAll('details')].map(el => ({ id: el.id, index: el.id ? null : anonymousDetailsIndex++, open: el.open })) };
}
function restoreReadingPosition(position) {
  const details = [...document.querySelectorAll('details')].filter(el => !el.id);
  for (const item of position.details) { const target = item.id ? $(item.id) : details[item.index]; if (target) target.open = item.open; }
  for (const item of position.scrollers) { const target = $(item.id); target.scrollLeft = item.left; target.scrollTop = item.top; }
  let target = position.active?.isConnected ? position.active : position.id ? $(position.id) : null;
  if (!target && position.dataKey) target = [...(position.rootId ? $(position.rootId) : document).querySelectorAll('button')].find(el => el.dataset[position.dataKey] === position.dataValue);
  if (target && !target.disabled) target.focus?.({ preventScroll: true });
  else if (position.active && position.active !== document.body && !position.active.isConnected) $('pageTitle').focus?.({ preventScroll: true });
  window.scrollTo({ left: position.x, top: position.y, behavior: 'instant' });
}
function automaticApply(payload, { scopeKey }) {
  if (scopeKey !== automaticScopeKey() || state.busy || syncBlockedReason()) return false;
  validateInsights(payload?.insights, appliedContext || {});
  if (payload.topics) validateTopics(payload.topics);
  const position = captureReadingPosition();
  state.data = projectRecordedWindow(payload.insights, appliedContext); state.start = payload.insights.range.startDate; state.end = payload.insights.range.endDate;
  notice(); $('exportButton').disabled = false;
  $('startDate').value = state.start; $('endDate').value = state.end;
  if (appliedContext.compare && appliedContext.comparisonAuto) {
    const query = new URLSearchParams(payload.query);
    $('compareStart').value = state.compareStart = query.get('comparisonStartDate');
    $('compareEnd').value = state.compareEnd = query.get('comparisonEndDate');
    renderComparisonHint();
  }
  for (const id of ['startDate', 'endDate', 'compareStart', 'compareEnd']) $(id).max = beijingToday();
  appliedRequest = payload.query; appliedContext = committedControls();
  renderCatalog(); renderSummary(); renderAccounts(); renderTrend();
  if (payload.topics) { topicRequest++; renderTopicsData(payload.topics); $('topicsGrid').setAttribute('aria-busy', 'false'); }
  busy(false);
  restoreReadingPosition(position);
  return true;
}
function renderLiveStatus(event) {
  const label = $('liveSyncMessage'), button = $('applyLiveUpdate');
  const status = $('liveSyncStatus'), connection = $('connectionStatus');
  const messages = {
    ready: '自动同步已开启 · 可见时每 30 秒检查', checked: '已核对更新状态 · 每 30 秒检查',
    checking: '后台读取新快照，保留当前画面…', updated: '已同步新快照 · 筛选与阅读位置已保留',
    offline: '网络已断开，保留当前快照；联网后自动核对',
    pending: `有新快照待同步 · ${event.reason || '稍后应用，不打断当前操作'}`,
    error: [401, 403].includes(event.status) ? '自动同步未完成：登录或访问权限需检查；当前快照已保留' : '自动同步未完成，保留当前快照；下一轮重试',
  };
  label.textContent = messages[event.kind] || messages.ready;
  status.setAttribute('data-state', event.kind);
  status.hidden = !event.pending && ['ready', 'checked', 'updated'].includes(event.kind);
  // Keep quiet sync outcomes available on the compact connection indicator
  // without overwriting a snapshot warning or error with a background success.
  connection.setAttribute?.('data-live-state', event.kind);
  connection.setAttribute?.('title', label.textContent);
  connection.setAttribute?.('aria-description', label.textContent);
  button.hidden = !event.pending;
  // Reading focus defers background repaint, not the user's explicit choice.
  // Drafts, dialogs and imports remain protected in either case.
  button.disabled = Boolean(syncDataBlockedReason()) || state.busy;
  button.textContent = button.disabled ? '稍后自动应用' : '应用更新';
}
async function startLiveSync() {
  if (liveSync) return;
  const { createLiveSync } = await import('./live-sync.js?v=20261009-import-light-1');
  liveSync = createLiveSync({
    readStatus: ({ signal }) => loadMonitoringStatus({ signal, rethrow: true }), readData: automaticRead, applyData: automaticApply,
    context: () => ({ visible: !document.hidden, online: navigator.onLine !== false, busy: state.busy || !state.session?.authenticated,
      readDataAllowed: state.view !== 'import' && Boolean(appliedRequest && appliedContext),
      blocked: syncBlockedReason(), scopeKey: automaticScopeKey() }), notify: renderLiveStatus,
  });
  liveSync.markApplied(latestMonitoringStatus);
  const schedule = () => {
    clearTimeout(liveTimer);
    if (!document.hidden) liveTimer = setTimeout(() => { void liveSync.tick().finally(schedule); }, 30_000);
  };
  const resume = () => { if (!document.hidden) { void liveSync.tick().finally(schedule); liveSync.flush(); } };
  document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(liveTimer); liveSync.pause(); } else resume(); });
  window.addEventListener('online', resume); window.addEventListener('focus', resume);
  window.addEventListener('offline', () => { liveSync.pause(); void liveSync.tick(); });
  document.addEventListener('focusout', () => { clearTimeout(liveFlushTimer); liveFlushTimer = setTimeout(() => liveSync.flush(), 1600); });
  for (const type of ['input', 'pointerdown', 'keydown', 'scroll']) document.addEventListener(type, () => {
    lastUserActivity = Date.now();
    clearTimeout(liveFlushTimer); liveFlushTimer = setTimeout(() => liveSync.flush(), 1600);
  }, { passive: true, capture: true });
  $('applyLiveUpdate').onclick = () => {
    if (state.busy || syncDataBlockedReason()) return false;
    lastUserActivity = 0;
    $('applyLiveUpdate').focus({ preventScroll: true });
    const applied = liveSync.flush();
    if (applied) $('refreshBtn').focus({ preventScroll: true });
    return applied;
  };
  schedule();
}
function navigationUrl() {
  // URL range describes displayed evidence, not unsubmitted/failed controls.
  // Local searching, sorting, paging and navigation remain independently live.
  const url = writeNavigationState(location.href, { ...state, ...presentationControls() });
  if (state.workflowTask !== 'all') url.searchParams.set('task', state.workflowTask); else url.searchParams.delete('task');
  if (state.workflowMetric !== 'followers') url.searchParams.set('metric', state.workflowMetric); else url.searchParams.delete('metric');
  url.hash = state.view;
  return url;
}

function renderAppliedScope() {
  const root = $('scopeSummary'), bar = $('appliedScopeBar');
  if (!root || !bar) return;
  const data = state.data || {}, shown = presentationControls(), range = appliedRange();
  const period = `${periodLabels[shown.period] || shown.period || '日期'} · ${range.start || '—'} → ${range.end || '—'}`;
  let items;
  if (state.view === 'topics') {
    items = [['scope', '话题范围', '全部监控话题'], ['period', '统计周期', period]];
  } else {
    const board = shown.board ? data.boards?.find(item => item.key === shown.board)?.name || `未识别：${shown.board}` : '全部矩阵';
    const theme = shown.theme === 'all' ? '全部主题' : data.themeSummary?.items?.find(item => item.key === shown.theme)?.label || `未识别：${shown.theme}`;
    const classification = shown.classification === 'all' ? '全部类型' : data.classificationSummary?.items?.find(item => item.key === shown.classification)?.label || `未识别：${shown.classification}`;
    items = [['board', '矩阵', board], ['theme', '大主题', theme], ['classification', '矩阵类型 / 内容标签', classification], ['period', '统计周期', period]];
    const compared = data.comparison?.range;
    if (compared) items.push(['comparison', '对比期', `${compared.startDate} → ${compared.endDate}`]);
  }
  root.innerHTML = items.map(([key, label, value]) => `<span class="scope-chip" data-scope-key="${key}"><small>${label}</small><strong>${esc(value)}</strong></span>`).join('');
  const pending = Boolean(state.data) && hasUnappliedScope();
  bar.setAttribute?.('data-pending', String(pending));
  const adjust = $('adjustScopeButton');
  if (adjust) adjust.textContent = pending ? '有更改待应用' : '调整范围';
  if ($('filterBrief')) $('filterBrief').textContent = state.view === 'topics'
    ? `全部监控话题 · ${period}`
    : `${items[1][2]} · ${items[2][2]}${items[4] ? ` · 对比 ${items[4][2].replace(' → ', ' 至 ')}` : ' · 未开启时段对比'} · ${items[0][2]} · ${period}`;
}

function syncAccountMode({ focus = false, focusSearch = false, query } = {}) {
  const mode = state.accountMode === 'roster' ? 'roster' : 'operating';
  state.accountMode = mode;
  const operating = $('operatingAccountsPanel'), roster = $('rosterAccountsPanel');
  if (!operating || !roster) return;
  operating.hidden = mode !== 'operating'; roster.hidden = mode !== 'roster';
  for (const button of document.querySelectorAll('#accountModeSwitch [data-account-mode]')) {
    const selected = button.dataset.accountMode === mode;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus?.({ preventScroll: true });
  }
  if (state.view === 'accounts' && mode === 'roster') {
    document.dispatchEvent(new CustomEvent('mcn:account-mode-change', { detail: { mode } }));
    if (query !== undefined) document.dispatchEvent(new CustomEvent('mcn:master-roster-open', { detail: { query, theme: state.theme } }));
    else document.dispatchEvent(new CustomEvent('mcn:master-roster-activate', { detail: { focusSearch } }));
  } else if (state.view === 'accounts' && mode === 'operating' && focusSearch) $('accountSearch')?.focus?.({ preventScroll: true });
}

function setAccountMode(mode, options = {}) {
  if (!['operating', 'roster'].includes(mode)) return false;
  state.accountMode = mode;
  syncAccountMode(options);
  saveLocation();
  return true;
}
function saveLocation() {
  // Preserve our modal entry (and any unrelated browser state) on repaint.
  const url = navigationUrl();
  let browserState = history.state ?? null;
  const entry = accountDetailHistory(browserState);
  if (entry && entry.base !== url.href) {
    browserState = { ...browserState, [DETAIL_HISTORY_KEY]: { ...entry, base: url.href } };
    if (detailHistoryContext?.sequence === entry.sequence) detailHistoryContext.base = url.href;
  }
  history.replaceState(browserState, '', url);
}
function params() {
  return new URLSearchParams(deriveReadRequest(committedControls()).query);
}
function previousEqualPeriod(start, end) {
  const valid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!valid(start) || !valid(end) || start > end) return null;
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
  return { start: shiftDate(start, -days), end: shiftDate(start, -1), days };
}
function comparisonRangeDraft() {
  return state.period === 'custom' ? { start: $('startDate').value, end: $('endDate').value } : rangeFor(state.period);
}
function renderComparisonHint(message = '') {
  const hint = $('comparisonHint');
  if (!hint) return;
  const range = comparisonRangeDraft(), previous = previousEqualPeriod(range.start, range.end);
  hint.textContent = message || (comparisonAuto && previous ? `上一等长 ${previous.days} 天 · 点击「应用」查看；缺采不补零` : '已保留手工对比日期 · 点击「应用」查看');
  $('restoreComparison').hidden = !previousComparisonDraft;
}
function fillPreviousComparison({ remember = false, range = comparisonRangeDraft() } = {}) {
  const previous = previousEqualPeriod(range.start, range.end);
  if (!previous) { renderComparisonHint('请先填写有效的本期开始和结束日期'); return false; }
  if (remember) previousComparisonDraft = { start: $('compareStart').value, end: $('compareEnd').value, auto: comparisonAuto };
  $('compareStart').value = previous.start; $('compareEnd').value = previous.end;
  comparisonAuto = true; renderComparisonHint(); return true;
}
function restoreComparisonDraft() {
  if (!previousComparisonDraft) return;
  const draft = previousComparisonDraft; previousComparisonDraft = null;
  $('compareStart').value = draft.start; $('compareEnd').value = draft.end; comparisonAuto = draft.auto;
  renderComparisonHint('已恢复上次对比日期 · 点击「应用」查看');
  $('previousEqualPeriod').focus?.({ preventScroll: true });
}
function selectedDates() {
  if (state.period === 'custom') { state.start = $('startDate').value; state.end = $('endDate').value; }
  else Object.assign(state, rangeFor(state.period));
  if (!state.start || !state.end || state.start > state.end || state.end > beijingToday()) throw new Error('请选择有效日期：开始不晚于结束，结束不晚于今天。');
  if (state.compare && comparisonAuto) fillPreviousComparison({ range: { start: state.start, end: state.end } });
  if (state.compare) { state.compareStart = $('compareStart').value; state.compareEnd = $('compareEnd').value; if (!state.compareStart || !state.compareEnd || state.compareStart > state.compareEnd || state.compareEnd > beijingToday()) throw new Error('请填写有效的对比日期。'); }
}
function setupDates() {
  const custom = state.period === 'custom';
  if (!custom) Object.assign(state, rangeFor(state.period));
  $('startDate').value = state.start; $('endDate').value = state.end;
  $('startDateWrap').hidden = !custom; $('endDateWrap').hidden = !custom;
  for (const id of ['startDate', 'endDate', 'compareStart', 'compareEnd']) $(id).max = beijingToday();
  if (comparisonAuto) fillPreviousComparison({ range: { start: state.start, end: state.end } }); else renderComparisonHint();
}

function renderCollectionRefresh() {
  const view = collectionRefresh?.getState();
  if (!view) {
    if (state.session?.authenticated && !canEdit() && !state.busy) $('refreshBtn').textContent = '读取已保存数据';
    return;
  }
  const { job, submitting, checking, error } = view;
  const active = ['queued', 'running'].includes(job?.status);
  const button = $('refreshBtn');
  button.disabled = state.busy || submitting || active || checking;
  button.textContent = submitting ? '正在提交采集…' : active ? job.status === 'queued' ? '采集排队中…' : '正在采集…'
    : state.busy ? '读取中…' : checking ? '核对采集状态…' : '刷新快照';
  const panel = $('collectionRefreshStatus'), text = $('collectionRefreshMessage');
  if (!panel || !text) return;
  panel.hidden = !job && !error && !submitting;
  const count = n => Number.isSafeInteger(n) && n >= 0 ? fmt(n, true) : '—';
  const p = job?.progress || {};
  const total = count(p.targetCount ?? job?.result?.targetCount);
  let message = submitting ? '正在请求全局采集，范围为全部已启用账号及话题，不受当前筛选影响。' : '';
  if (job?.status === 'queued') message = '采集已排队：等待当前采集安全结束后执行全部已启用账号及话题，不重复并发。';
  if (job?.status === 'running') message = `正在采集全部已启用账号及话题：已处理 ${count(p.processedCount)}/${total}，成功 ${count(p.successCount)}，失败 ${count(p.errorCount)}，含警告 ${count(p.warningCount)}。采集结束后自动读取新快照，期间可继续查看数据。`;
  if (job && !active) {
    const r = job.result || p;
    const label = { completed: '本次采集已结束', failed: '本次采集失败', interrupted: '本次采集中断' }[job.status];
    message = `${label}：成功 ${count(r.successCount)}/${total}，失败 ${count(r.errorCount)}，含警告 ${count(r.warningCount)}，跳过 ${count(r.skippedCount)}。${job.result ? `主页指标可用 ${count(r.profileUsableCount)} 个，话题双指标可用 ${count(r.topicMetricsUsableCount)} 个；作品明细另行分批采集。` : ''}${job.error ? `原因：${job.error}。` : ''}失败项不冒充已更新；可在“自动更新与来源”查看覆盖。`;
  }
  text.textContent = `${message}${error ? ` ${error}` : ''}`;
  panel.setAttribute('data-state', error || ['failed','interrupted'].includes(job?.status) ? 'error' : active || submitting ? 'loading' : 'finished');
  $('collectionRefreshRead').hidden = !error;
  $('collectionRefreshRead').disabled = checking || submitting;
}
async function initializeCollectionRefresh() {
  if (!canEdit()) {
    $('refreshBtn').textContent = '读取已保存数据';
    $('refreshBtn').title = '只读成员不能发起采集，只能读取已保存数据';
    return;
  }
  const { createCollectionRefresh } = await import('./refresh-collection.js?v=20261009-collect-refresh-1');
  collectionRefresh?.dispose();
  collectionRefresh = createCollectionRefresh({ api, onChange: renderCollectionRefresh,
    onComplete: refreshAfterCollection });
  $('collectionRefreshRead').onclick = () => void collectionRefresh.restore();
  await collectionRefresh.restore();
}
async function refreshAfterCollection() {
  if (state.busy) { collectionReadPending = true; return; }
  collectionReadPending = false;
  await readSavedSnapshot();
}
async function refreshSnapshot() {
  if (state.busy) return;
  if (!canEdit()) return readSavedSnapshot();
  if (!collectionRefresh) { notice('采集入口尚未就绪，请稍后重试；本次未提交采集。', true); return; }
  return collectionRefresh.request();
}
async function readSavedSnapshot() {
  if (state.busy) return;
  const trigger = $('refreshBtn');
  const ownedFocus = document.activeElement === trigger;
  let focusMoved = false;
  const noteFocus = event => {
    if (event.target !== trigger && event.target !== document.body && event.target !== document.documentElement) focusMoved = true;
  };
  const notePointer = event => { if (!trigger.contains(event.target)) focusMoved = true; };
  if (ownedFocus) {
    document.addEventListener('focusin', noteFocus, true);
    document.addEventListener('pointerdown', notePointer, true);
  }
  let requestId = null;
  try {
    const pending = load({ refreshApplied: true });
    requestId = state.requestId;
    await pending;
    if (typeof CustomEvent === 'function') document.dispatchEvent?.(new CustomEvent('mcn:master-roster-refresh', { detail: { force: true } }));
  }
  finally {
    if (ownedFocus) {
      document.removeEventListener('focusin', noteFocus, true);
      document.removeEventListener('pointerdown', notePointer, true);
      const active = document.activeElement;
      // Native disabled buttons lose focus. Restore only that loss, never a
      // later choice made by the user, a newer request, or a background tab.
      if (!focusMoved && requestId === state.requestId && !state.busy && trigger.isConnected && !trigger.disabled
          && (active === document.body || active === document.documentElement)
          && document.hasFocus()) trigger.focus({ preventScroll: true });
    }
  }
}

function importBoardCatalog(previewCatalog = []) {
  const boards = new Map();
  for (const board of [...(state.data?.boards || []), ...(Array.isArray(previewCatalog) ? previewCatalog : [])]) {
    if (board?.key === '__unassigned__' || typeof board?.name !== 'string' || !board.name.trim()) continue;
    const name = board.name.trim(), normalized = name.normalize('NFKC').toLowerCase();
    const key = typeof board.key === 'string' ? board.key : boards.get(normalized)?.key || name;
    boards.set(normalized, { key, name });
  }
  return [...boards.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}
function importSelectedBoard(catalog, requested = undefined, selectedKey = state.board) {
  // A URL is navigation intent, not evidence of an existing board. Only a
  // catalog-confirmed exact key/name can supply a default for blank rows.
  if (requested !== undefined) return catalog.find(board => board.name === requested)?.name || '';
  if (!selectedKey || selectedKey === '__unassigned__') return '';
  return catalog.find(board => board.key === selectedKey || board.name === selectedKey)?.name || '';
}
async function loadImportWorkspace({ refresh = false } = {}) {
  renderScopeSubtitle(); saveLocation();
  const jobId = new URL(location.href).searchParams.get('importJob');
  if (canEdit()) {
    void loadRecentImportJobs({ automatic: !refresh });
    if (jobId && (refresh || currentImportJob?.id !== jobId)) void openImportJob(jobId);
    else if (refresh && currentImportJob) void loadImportJob();
  }
  const session = state.session, requestId = state.requestId;
  if (importWorkspaceReadPromise && importWorkspaceReadOwner?.session === session
      && importWorkspaceReadOwner.requestId === requestId) return importWorkspaceReadPromise;
  const owner = { session, requestId }; importWorkspaceReadOwner = owner;
  const current = () => state.view === 'import' && state.session === session && state.requestId === requestId;
  $('refreshBtn').disabled = true; $('refreshBtn').textContent = '读取状态…';
  $('main').setAttribute('aria-busy', 'false');
  $('connectionStatus').textContent = '正在核对导入状态';
  $('connectionStatus').setAttribute?.('data-state', 'loading');
  setLoadFeedback('loading', '<span>名单预览与任务读取独立运行，无需等待矩阵统计。</span>');
  if (!state.data) {
    $('boardSelect').innerHTML = '<option value="">全部矩阵</option>' + (state.board
      ? `<option value="${esc(state.board)}">当前选择：${esc(state.board)}</option>` : '');
    $('boardSelect').value = state.board;
  }
  importWorkspaceReadPromise = (async () => {
    try {
      await loadMonitoringStatus({ rethrow: true });
      if (!current()) return;
      $('connectionStatus').textContent = '导入状态已核对';
      $('connectionStatus').setAttribute?.('data-state', 'success');
      setLoadFeedback('success', '<span>导入页只更新来源与任务状态，不读取全量矩阵统计，也不会触发平台采集。</span>');
    } catch (error) {
      if (!current()) return;
      $('connectionStatus').textContent = '导入状态读取失败';
      $('connectionStatus').setAttribute?.('data-state', 'error');
      setLoadFeedback('error', `<span>状态读取失败：${esc(error.message)}。已保留名单预览和任务回执，可更新状态重试。</span>`);
    } finally {
      if (current()) { $('refreshBtn').disabled = false; $('refreshBtn').textContent = canEdit() ? '刷新快照' : '更新导入状态'; renderCollectionRefresh(); }
      if (importWorkspaceReadOwner === owner) { importWorkspaceReadPromise = null; importWorkspaceReadOwner = null; }
    }
  })();
  return importWorkspaceReadPromise;
}
async function load({ refreshApplied = false, scopeOnly = false } = {}) {
  if (state.view === 'import') return loadImportWorkspace({ refresh: refreshApplied });
  const refreshContext = refreshApplied && appliedRequest && appliedContext ? { ...appliedContext } : null;
  const refreshRequest = refreshContext ? deriveReadRequest(refreshContext, { advance: !hasUnappliedScope() }) : null;
  // Account navigation changes its scope, not the date/comparison form draft.
  // Without a successful first read, use the normal initial date validation.
  const scopeRequest = scopeOnly && appliedContext ? deriveReadRequest({ ...appliedContext,
    board: state.board, theme: state.theme, classification: state.classification }) : null;
  const readRequest = scopeRequest || refreshRequest;
  liveSync?.invalidate();
  $('exportButton').disabled = true;
  try { if (!readRequest) selectedDates(); } catch (error) { notice(error.message, true); return; }
  const id = ++state.requestId;
  pendingInsightsRead = null;
  // Supersede topic reads at dispatch, before the new account range arrives.
  topicController?.abort(); topicController = null;
  topicRequest++;
  topicReadContext = null;
  $('topicsGrid').setAttribute?.('aria-busy', 'false');
  if (state.view === 'topics') $('topicsGrid').innerHTML = retainedTopicsMarkup();
  controller?.abort(); controller = new AbortController();
  busy(true); notice();
  void loadMonitoringStatus();
  let outcome = 'success';
  try {
    const query = readRequest?.query || params().toString();
    const dispatchedControls = readRequest?.context || committedControls();
    pendingInsightsRead = { ownerRequestId: id,
      range: { start: dispatchedControls.start, end: dispatchedControls.end } };
    if (state.view === 'topics') {
      void loadTopics({ rangeOverride: { start: dispatchedControls.start, end: dispatchedControls.end }, ownerRequestId: id });
    }
    const response = await api(`/api/rebuild/insights?${query}`, { signal: controller.signal });
    if (id !== state.requestId) return;
    const data = validateInsights(response, dispatchedControls);
    const keepDraft = Boolean(scopeRequest) || (refreshContext && hasUnappliedScope());
    state.data = projectRecordedWindow(data, dispatchedControls);
    if (!keepDraft) {
      state.start = data.range.startDate; state.end = data.range.endDate;
      if (refreshRequest) { $('startDate').value = state.start; $('endDate').value = state.end; }
      if (refreshRequest && dispatchedControls.compare && dispatchedControls.comparisonAuto) {
        $('compareStart').value = state.compareStart = dispatchedControls.compareStart;
        $('compareEnd').value = state.compareEnd = dispatchedControls.compareEnd;
        renderComparisonHint();
      }
      for (const field of ['startDate', 'endDate', 'compareStart', 'compareEnd']) $(field).max = beijingToday();
    }
    rememberAppliedRequest(query, dispatchedControls, data.range);
    insightsNeedRead = false; navigationRangePending = false;
    $('exportButton').disabled = false;
    renderCatalog(); renderSummary(); renderAccounts(); renderTrend(); saveLocation();
    if (state.view === 'topics') {
      const expectedRange = { start: data.range.startDate, end: data.range.endDate };
      const topicMatches = topicReadContext?.ownerRequestId === id
        && topicReadContext.range.start === expectedRange.start && topicReadContext.range.end === expectedRange.end;
      if (!topicMatches) void loadTopics({ rangeOverride: expectedRange, ownerRequestId: id });
    }
    if (keepDraft && hasUnappliedScope()) notice(scopeRequest
      ? '已按当前已应用日期切换账号范围；未应用的日期或对比草稿已保留，点击「应用」后生效。'
      : '已刷新当前已应用范围的数据；未应用的日期或筛选已保留，点击「应用」后再切换范围。');
  } catch (error) {
    if (error.name === 'AbortError' || id !== state.requestId) return;
    outcome = 'error';
    notice(`读取失败：${error.message}。${state.data ? '当前保留上次已读取的数据，未伪装为最新结果。' : '可点击刷新重试。'}`, true);
    $('exportButton').disabled = true;
    $('connectionStatus').textContent = '数据读取失败';
  } finally {
    if (id === state.requestId) { pendingInsightsRead = null; busy(false, outcome); }
  }
}
function renderClassificationFilter() {
  const items = state.data?.classificationSummary?.items || [];
  const selected = state.classification;
  const systems = items.filter(item => item.key !== 'all' && !item.key.startsWith('custom:'));
  const custom = items.filter(item => item.key.startsWith('custom:') && (item.count || item.key === selected));
  const visibleCustom = showCustomClassifications ? custom : custom.filter(item => item.key === selected);
  const options = values => values.map(item => `<option value="${esc(item.key)}">${esc(item.label)} · ${fmt(item.count)}</option>`).join('');
  $('classificationSelect').innerHTML = '<option value="all">全部矩阵类型与内容标签</option>'
    + (systems.length ? `<optgroup label="矩阵类型与标准内容标签">${options(systems)}</optgroup>` : '')
    + (visibleCustom.length ? `<optgroup label="${showCustomClassifications ? '原表描述标签' : '当前已选原表描述'}">${options(visibleCustom)}</optgroup>` : '');
  if (selected && selected !== 'all' && !items.some(item => item.key === selected)) $('classificationSelect').insertAdjacentHTML('beforeend', `<option value="${esc(selected)}">无效分类：${esc(selected)}</option>`);
  $('classificationSelect').value = selected;
  $('classificationMore').hidden = !custom.length;
  $('classificationMore').textContent = showCustomClassifications ? '收起原表描述' : `查看原表描述（${custom.length}）`;
  $('classificationMore').setAttribute?.('aria-expanded', String(showCustomClassifications));
}
function toggleCustomClassifications() {
  showCustomClassifications = !showCustomClassifications;
  renderClassificationFilter();
}
function missingRecordedWindowCaption(data) {
  const period = appliedContext?.period || state.period;
  const strictMetricsIncomplete = Object.keys(METRICS).some(key => numeric(data?.summary?.metrics?.[key]?.delta) === null);
  if (!['week', 'month', '30d', 'since'].includes(period) || data?.recordedWindow !== null
      || data?.activeRecordedWindow || data?.comparison || !strictMetricsIncomplete) return '';
  return '所选区间尚无覆盖达标的共同起止采样窗口。净变化“—”表示未知，不是 0；可缩短或调整日期范围后点击应用。';
}
function renderScopeSubtitle() {
  const data = state.data || {}, shown = presentationControls(), range = appliedRange();
  if (state.view === 'topics') {
    $('pageSubtitle').textContent = `全部监控话题 · ${range.start} 至 ${range.end} · 北京时间（独立于账号筛选）`;
    return;
  }
  const themeLabel = shown.theme !== 'all' ? data.themeSummary?.items?.find(t => t.key === shown.theme)?.label : '';
  const contentLabel = shown.classification !== 'all' ? data.classificationSummary?.items?.find(c => c.key === shown.classification)?.label : '';
  const boardLabel = shown.board ? data.boards?.find(b => b.key === shown.board)?.name || shown.board : '全部矩阵';
  $('pageSubtitle').textContent = `${boardLabel}${themeLabel ? ` · ${themeLabel}` : ''}${contentLabel ? ` · ${contentLabel}` : ''} · ${range.start} 至 ${range.end} · 北京时间`;
}
function renderCatalog() {
  const data = state.data;
  const shown = presentationControls(), range = appliedRange();
  const boards = data.boards || [];
  $('boardSelect').innerHTML = '<option value="">全部矩阵</option>' + boards.map(b => `<option value="${esc(b.key)}">${esc(b.name || b.label)}</option>`).join('');
  if (state.board && !boards.some(b => b.key === state.board)) $('boardSelect').insertAdjacentHTML('beforeend', `<option value="${esc(state.board)}">无效矩阵：${esc(state.board)}</option>`);
  $('boardSelect').value = state.board;
  const themes = data.themeSummary?.items || [];
  const selectedTheme = state.theme;
  $('themeSelect').innerHTML = '<option value="all">全部大主题</option>' + themes.filter(t => t.key !== 'all' && (t.count || t.key === selectedTheme)).map(t => `<option value="${esc(t.key)}">${esc(t.label)} · ${fmt(t.count)}</option>`).join('');
  if (selectedTheme !== 'all' && !themes.some(t => t.key === selectedTheme)) $('themeSelect').insertAdjacentHTML('beforeend', `<option value="${esc(selectedTheme)}">无效主题：${esc(selectedTheme)}</option>`);
  state.theme = selectedTheme;
  $('themeSelect').value = state.theme;
  const classifications = data.classificationSummary?.items || [];
  renderClassificationFilter();
  renderScopeSubtitle();
  $('rangeEvidence').textContent = periodEvidenceCaption(data.range);
  const recordedNotice = $('recordedWindowNotice');
  const recordedCaption = recordedWindowCaption(data) || missingRecordedWindowCaption(data);
  if (recordedNotice) { recordedNotice.textContent = recordedCaption; recordedNotice.hidden = !recordedCaption || ['topics', 'import'].includes(state.view); }
  const invalidBoard = state.board && !boards.some(b => b.key === state.board);
  const invalidTheme = state.theme !== 'all' && !themes.some(t => t.key === state.theme);
  const invalidClassification = state.classification !== 'all' && !classifications.some(c => c.key === state.classification);
  const selectedThemeSummary = themes.find(item => item.key === state.theme);
  const selectedClassification = classifications.find(item => item.key === state.classification);
  if (invalidBoard || invalidTheme || invalidClassification) {
    notice('当前链接含有未识别的筛选值；已保留并标记，不会伪装成“全部”。请选择有效值或清除筛选。', true);
  } else if (state.theme !== 'all' && selectedThemeSummary?.count === 0) {
    notice(`当前矩阵没有“${selectedThemeSummary.label}”账号；筛选已保留，结果为空，未自动扩大范围。选择“全部大主题”查看当前矩阵。`);
  } else if (state.classification !== 'all' && (!selectedClassification || selectedClassification.count === 0)) {
    notice(`当前筛选范围没有“${selectedClassification?.label || state.classification}”账号；筛选已保留，结果为空，未自动扩大范围。选择“全部内容类型”查看当前范围。`);
  }
  $('clearScopeBtn').hidden = !state.board && state.theme === 'all' && state.classification === 'all';
  renderAppliedScope();
}
function partialMetricCaption(metric, total) {
  const count = metric?.comparableCount;
  return Number.isSafeInteger(total) && Number.isSafeInteger(count) && count > 0 && count < total
    ? `仅 ${fmt(count, true)} 个账号可比，其余 ${fmt(total - count, true)} 个不计入变化；净变化和百分比均仅针对可比账号。` : '';
}
function renderSummary() {
  const s = state.data.summary;
  const shown = presentationControls();
  const total = s.enabledCount;
  const endPoint = s.trend?.find(point => point.date === effectiveMetricRange().end);
  const alternative = buildRecordedWindowAlternative(state.data, shown);
  $('kpiGrid').innerHTML = ['followers', 'likes', 'posts', 'estimatedPlays'].map(key => {
    const label = METRICS[key];
    const m = s.metrics[key] || {};
    const comparableCount = Number.isSafeInteger(m.comparableCount) ? fmt(m.comparableCount) : '—';
    const delta = numeric(m.delta);
    const windowDelta = numeric(alternative?.metrics?.[key]?.delta);
    const windowReadout = delta === null && windowDelta !== null
      ? `<div class="kpi-window-readout" role="note"><span>另有共同采样窗口实测净变化</span><strong>${signed(windowDelta)}</strong><small>${esc(alternative.baselineDate)} → ${esc(alternative.endDate)} · 同一批 ${fmt(alternative.comparableCount)}/${fmt(alternative.enabledCount)} 个账号 · 非完整所选周期</small></div>`
      : '';
    const partialScope = partialMetricCaption(m, total);
    const endObservedCount = endPoint?.[`${key}ObservedCount`];
    const missingEndpointLabel = Number.isInteger(endObservedCount)
      ? endObservedCount === 0 ? `末日 ${endPoint.date} 该项无有效观测` : '末日已观测；缺开始日前一日基准'
      : '缺少可比起止快照';
    const baselineLabel = !m.comparableCount ? missingEndpointLabel : partialScope
      ? `部分账号净变化${state.data.activeRecordedWindow ? ' · 已记录时段' : ''}`
      : state.data.activeRecordedWindow ? '已记录时段净变化' : m.fullPeriodComparableCount < m.comparableCount ? '可比采样净变化' : '本期净变化';
    const current = state.data.activeRecordedWindow && key !== 'estimatedPlays'
      ? `共同结束日 ${state.data.activeRecordedWindow.endDate} · 可比账号存量 ${fmt(m.value)} · ${comparableCount}/${total} 账号；不是所选末日的新采覆盖`
      : metricObservationCaption(key, m, total, endPoint);
    const comp = state.data.comparison?.summary?.metrics?.[key];
    const comparisonScope = partialMetricCaption(comp, state.data.comparison?.summary?.enabledCount);
    const comparisonCount = Number.isSafeInteger(comp?.comparableCount) ? fmt(comp.comparableCount) : '—';
    return `<article class="kpi" data-kpi-metric="${key}"><div class="kpi-label"><span>${label}${key === 'estimatedPlays' ? '变化' : '净变化'}</span><span class="quality">${comparableCount}/${total} 可比</span></div><div class="kpi-value">${signed(delta)}</div><div class="kpi-delta">${baselineLabel}${m.percent == null ? '' : ` <span class="submetric">${Number(m.percent).toFixed(2)}%</span>`}</div>${windowReadout}${key === 'estimatedPlays' ? '<p class="kpi-formula">获赞净变化 × 100 · 非实际播放</p>' : ''}<details class="kpi-context"><summary>采样范围与口径</summary>${partialScope ? `<div class="kpi-note">${esc(partialScope)}</div>` : ''}<div class="kpi-note">${esc(current)}</div></details>${comp ? `<div class="compare-note">对比时段${comparisonScope ? ' · 部分账号净变化' : ''} ${signed(comp.delta)} · ${comparisonCount} 个账号${comparisonScope ? `<div>${esc(comparisonScope)}</div>` : ''}</div>` : ''}<button type="button" class="link-btn metric-explain-button" data-metric-explanation="${key}" aria-controls="metricExplanation" aria-expanded="${state.explanationKey === key}" aria-label="查看${label}变化的账号贡献">查看账号贡献 →</button></article>`;
  }).join('');
  renderMetricExplanation();
  const alternativePanel = $('recordedWindowAlternative');
  if (alternativePanel) {
    const signature = alternative ? JSON.stringify([shown.board, shown.theme, shown.classification, shown.period, alternative.baselineDate, alternative.endDate]) : '';
    if (alternativePanel.getAttribute?.('data-window-key') !== signature) alternativePanel.open = Boolean(alternative);
    alternativePanel.setAttribute?.('data-window-key', signature);
    alternativePanel.hidden = !alternative;
    alternativePanel.innerHTML = alternative ? `<summary><strong>共同采样窗口 · 非完整所选区间</strong><span>${esc(alternative.baselineDate)} → ${esc(alternative.endDate)} · ${alternative.comparableCount}/${alternative.enabledCount} 个账号可比</span><span class="disclosure-action" aria-hidden="true">收起 / 展开</span></summary><p>以下四项只代表这两个实际采样日之间、同一批可比账号的净变化，不等于所选 ${esc(alternative.requestedRange.startDate)} 至 ${esc(alternative.requestedRange.endDate)} 全期。上方主卡、台账、账号明细与导出仍严格按所选日期；两种口径不能相加。</p><dl>${Object.entries(METRICS).map(([key, label]) => `<div><dt>${esc(label)}${key === 'estimatedPlays' ? '变化' : '净变化'}</dt><dd>${signed(alternative.metrics[key].delta)}</dd></div>`).join('')}</dl><small>缺测不补零；估算播放 = 此窗口获赞净变化 × 100，非实际播放量；作品存量净变化不是完整新增发布量。</small>` : '';
  }
  const classification = state.data.classificationSummary || { total: 0, classified: 0, unclassified: 0, items: [] };
  const allClassificationItems = (classification.items || []).filter(item => item.key !== 'all' && item.count > 0).sort((a, b) => Number(b.count) - Number(a.count));
  const items = allClassificationItems.filter(item => !item.key.startsWith('custom:') || item.key === shown.classification);
  const classTotal = Number(classification.total) || 0;
  const classified = Number(classification.classified) || 0;
  $('classificationGrid').innerHTML = items.length ? items.map(item => {
    const count = Number(item.count) || 0;
    const ratio = classTotal ? Math.round(count / classTotal * 100) : 0;
    const active = shown.classification === item.key;
    return `<button type="button" class="classification-card${active ? ' active' : ''}" data-classification="${esc(item.key)}" aria-pressed="${active}"><span class="classification-name"><i class="classification-dot ${esc(item.color || 'slate')}" aria-hidden="true"></i>${esc(item.label)}</span><strong>${fmt(count)}</strong><span class="classification-meta">${ratio}% · 建档账号（含暂停）</span><span class="classification-bar"><i style="width:${Math.min(100, ratio)}%"></i></span></button>`;
  }).join('') : '<div class="empty">暂无可展示的分类资料。</div>';
  $('classificationSummary').textContent = `已分类 ${fmt(classified)} / ${fmt(classTotal)} 个账号 · 待分类 ${fmt(Number(classification.unclassified) || 0)} 个`;
  const themeSummary = state.data.themeSummary || { total: 0, assigned: 0, unassigned: 0, items: [] };
  const themeItems = (themeSummary.items || []).filter(item => item.key !== 'all' && item.count > 0).sort((a, b) => Number(a.key === 'unassigned') - Number(b.key === 'unassigned') || Number(b.count) - Number(a.count));
  $('themeGrid').innerHTML = themeItems.length ? themeItems.map(item => {
    const count = Number(item.count) || 0;
    const ratio = themeSummary.total ? Math.round(count / themeSummary.total * 100) : 0;
    const active = shown.theme === item.key;
    return `<button type="button" class="theme-card${active ? ' active' : ''}" data-theme="${esc(item.key)}" aria-pressed="${active}"><span class="theme-name">${esc(item.label)}</span><strong>${fmt(count)}</strong><span class="theme-meta">${ratio}% · 建档账号（含暂停）</span><span class="theme-bar"><i style="width:${Math.min(100, ratio)}%"></i></span></button>`;
  }).join('') : '<div class="empty">暂无大主题资料。</div>';
  $('themeSummary').textContent = `已归属 ${fmt(themeSummary.assigned)} / ${fmt(themeSummary.total)} 个账号 · 待归属 ${fmt(themeSummary.unassigned)} 个`;
  const sourceRows = (state.data.classificationSources || []).map(source => {
    const title = source.fileName || source.sheetName || source.type || '已保存来源';
    const suffix = source.sheetName && source.fileName ? ` · ${source.sheetName}` : '';
    const links = (source.urls || []).map(url => `<a href="${esc(url)}" target="_blank" rel="noreferrer">打开表格</a>`).join('');
    return `<li><strong>${esc(title)}</strong>${esc(suffix)}${links}<span>${fmt(source.accounts)} 个账号 · ${fmt(source.explicitCategories)} 条明确分类${source.rows ? ` · ${fmt(source.rows)} 行` : ''}</span></li>`;
  }).join('');
  const labelRows = allClassificationItems.map(item => `<button type="button" class="classification-source-tag" data-classification="${esc(item.key)}"><span>${esc(item.label)}</span><strong>${fmt(item.count)}</strong></button>`).join('');
  $('classificationSources').innerHTML = `${sourceRows ? `<p class="source-note">以下来源来自已保存的导入表格记录；“明确分类”只统计表格的分类/分层字段，不用作者昵称猜测。</p><ul class="source-list">${sourceRows}</ul>` : '<p class="empty">当前筛选没有可追溯的表格来源。</p>'}${labelRows ? `<div class="source-labels"><h3>表格明确标签与系统归并</h3><div class="classification-source-tags">${labelRows}</div></div>` : ''}`;
  const successTimes = state.data.accounts.map(a => a.status?.lastSuccessAt).filter(Boolean).sort();
  $('dataHealth').innerHTML = `<span><strong>${total}</strong> 个启用账号</span><span>最新有效采样 <strong>${dateTime(successTimes.at(-1))}</strong></span><span>${s.pendingCount || 0} 个等待首次数据 · ${s.staleCount || 0} 个数据过期</span><button class="link-btn" data-view="accounts">查看账号明细 →</button><span>已知合计可含历史值（如已注销账号）；当天采集情况以新采覆盖为准。</span>`;
  renderCollectionCoverage();
  $('metricTabs').innerHTML = Object.entries(METRICS).map(([key, label]) => `<button type="button" data-metric="${key}" aria-pressed="${key === state.metric}">${label}变化</button>`).join('');
  $('pageTitle').textContent = state.view === 'overview' ? (shown.period === 'day' ? '今天的矩阵' : '矩阵经营总览') : ({ accounts: '账号台账', topics: '话题观察', import: '导入作者名单' })[state.view];
}
function metricContributionScope(data) {
  const theme = data.themeSummary?.items?.find(item => item.key === data.theme)?.label;
  const classification = data.classificationSummary?.items?.find(item => item.key === data.classification)?.label;
  return [data.selectedBoard?.name || '全部矩阵', data.theme && data.theme !== 'all' ? theme || data.theme : '全部大主题',
    data.classification && data.classification !== 'all' ? classification || data.classification : '全部内容类型'].join(' ∩ ');
}
function renderMetricExplanation() {
  const panel = $('metricExplanation'); if (!panel) return;
  const data = state.data, key = state.explanationKey;
  const evidence = buildMetricContributions(data, key);
  panel.hidden = !evidence;
  for (const button of document.querySelectorAll('[data-metric-explanation]')) button.setAttribute('aria-expanded', String(button.dataset.metricExplanation === key));
  if (!evidence) { panel.innerHTML = ''; return; }
  const exact = value => value === null ? '—' : `${value > 0 ? '+' : ''}${fmt(value, true)}`;
  const range = data.effectiveMetricRange || data.range;
  const header = `<div class="metric-explanation-head"><h2 id="metricExplanationTitle" tabindex="-1">${METRICS[key]}变化 · 账号贡献</h2><button type="button" class="link-btn" data-metric-explanation="${key}" aria-label="收起账号贡献">收起</button></div><p class="metric-explanation-scope">${esc(metricContributionScope(data))} · ${esc(data.activeRecordedWindow ? recordedWindowCaption(data) : `${range?.startDate} 至 ${range?.endDate}`)} · 北京时间</p><p class="muted">只统计当前范围的启用账号；台账的搜索、平台和采集筛选不会改变此卡。按当前名单与归属回看历史，不代表当时成员名册。</p>`;
  if (!evidence.reconciled) {
    panel.innerHTML = `${header}<p class="metric-reconcile-warning" role="status">贡献明细暂未对齐，暂不展示贡献排名。指标卡保留服务端原值，请刷新快照后重试。</p>`;
    return;
  }
  const partialScope = partialMetricCaption({ comparableCount: evidence.comparableCount }, evidence.enabledCount);
  const formula = key === 'estimatedPlays'
    ? `本期可比账号获赞净变化 ${exact(data.summary.metrics.likes?.delta ?? null)} × 100 = ${exact(evidence.delta)} 估算播放变化；不是平台实际播放量。负值是获赞净减少的换算。`
    : key === 'posts' ? '作品存量净变化，可受删除或隐藏影响；不等于本期新增发布量。' : '按同一账号开始日前一日基准与结束日观测相减，再汇总；缺少端点不计入净变化。';
  const groups = evidence.groups.map(group => `<tr><th scope="row">${esc(group.label)}</th><td>${group.count}</td><td>${esc(exact(group.delta))}</td></tr>`).join('');
  const top = evidence.rows.slice(0, 10).map(({ account, delta, themeLabel }) => {
    const metric = account.metrics?.[key] || {};
    const startAt = metric.baselineAt || null, endAt = metric.currentAt || null;
    const endpointTitle = `基准采样：${startAt || '未知'}；结束采样：${endAt || '未知'}`;
    return `<tr><td><button type="button" class="row-btn" data-account-id="${account.id}">${esc(account.label)}</button><small>${esc(platformNames[account.platform] || account.platform)} · ${esc(account.publicId || account.submittedAccountId || '尚无账号 ID')}</small></td><td>${esc(themeLabel)}</td><td>${esc(exact(delta))}<small class="metric-endpoint-times" title="${esc(endpointTitle)}">北京时间采样端点 ${esc(dateTime(startAt))} → ${esc(dateTime(endAt))}</small></td></tr>`;
  }).join('');
  panel.innerHTML = `${header}<p class="metric-explanation-formula">${esc(formula)}</p>${partialScope ? `<p class="muted">部分账号净变化：${esc(partialScope)}</p>` : ''}<p class="metric-explanation-counts">${evidence.comparableCount} / ${evidence.enabledCount} 个启用账号可比 · ${evidence.missingCount} 个缺少可比端点，未补零 · 明细净变化合计 <strong>${esc(exact(evidence.delta))}</strong></p>${evidence.rows.length ? `<div class="metric-explanation-columns"><section><h3>按大主题拆分</h3><p class="muted">每个账号只计入一个大主题；多板块成员不重复相加。</p><div class="table-card"><table class="table"><thead><tr><th>大主题</th><th>可比账号</th><th>净贡献</th></tr></thead><tbody>${groups}</tbody></table></div></section><section><h3>变动最大的 ${Math.min(10, evidence.rows.length)} 个账号</h3><p class="muted">按变化绝对值排序，保留上涨与下降；此列表不是全部贡献。</p><div class="table-card"><table class="table"><thead><tr><th>账号（可点开详情）</th><th>大主题</th><th>净贡献</th></tr></thead><tbody>${top}</tbody></table></div></section></div>` : '<p class="muted">没有可比账号，净变化保持未知，不记为 0。</p>'}<button type="button" class="secondary-btn" data-contribution-ledger="${key}">查看此范围全部账号 →</button><p class="muted">进入台账时清除局部筛选，保留矩阵、分类和日期；按本指标净变化降序，缺测仍显示“—”。</p>`;
}
function selectMetricExplanation(key) {
  if (!Object.hasOwn(METRICS, key) || state.busy) return;
  state.explanationKey = state.explanationKey === key ? null : key;
  renderMetricExplanation();
  if (state.explanationKey) { $('metricExplanationTitle')?.focus?.({ preventScroll: true }); $('metricExplanation')?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' }); }
  else document.querySelector?.(`#kpiGrid [data-metric-explanation="${key}"]`)?.focus?.({ preventScroll: true });
}
function clearLocalAccountFilters({ collection = 'all' } = {}) {
  state.workflowTask = 'all';
  state.query = ''; state.platform = 'all'; state.enabled = 'active'; state.collectionFilter = collection; state.page = 1;
  if ($('accountSearch')) $('accountSearch').value = '';
  if ($('platformSelect')) $('platformSelect').value = 'all';
  if ($('enabledSelect')) $('enabledSelect').value = 'active';
  if ($('collectionSelect')) $('collectionSelect').value = collection;
}
function showContributionLedger(key) {
  if (!Object.hasOwn(METRICS, key) || state.busy) return;
  if (hasUnappliedScope()) {
    notice('请先应用或恢复未应用的筛选，再查看此快照的全部账号。当前日期草稿已保留。', true);
    $('notice').scrollIntoView?.({ block: 'center', behavior: 'instant' });
    return;
  }
  clearLocalAccountFilters();
  state.sort = `${key}.delta`; state.direction = 'desc';
  setView('accounts');
  $('accountCount')?.focus?.({ preventScroll: true });
}
const worksLabels = { complete: '本次明细完整', limited: '明细仅部分', unavailable: '明细未取得', unknown: '明细未核验', missing: '当日无明细记录' };
const collectionLabels = { all: '全部采集状态', 'missing-profile': '期末主页缺采', 'incomplete-works': '期末作品明细不完整' };
function collectionOnDate(account) {
  return account.collection?.date === appliedRange().end ? account.collection : { profileObserved: false, worksState: 'missing' };
}
function renderCollectionCoverage() {
  const c = state.data?.summary?.collectionCoverage;
  if (!c || c.date !== appliedRange().end) {
    $('collectionSummary').textContent = '期末采集覆盖 · 暂无核验结果';
    $('collectionBody').innerHTML = '<p>未取得此日期的覆盖记录，不以 0 或历史成功代替。</p>';
    return;
  }
  $('collectionSummary').innerHTML = `<span>期末采集覆盖 · ${esc(c.date)}</span><span>主页有数据 <strong>${c.profileObservedCount}/${c.total}</strong></span><span>作品明细完整 <strong>${c.works.complete}/${c.total}</strong></span>`;
  $('collectionBody').innerHTML = `<p>只统计当前矩阵与分类内启用账号，在期末当天的真实观测。主页有数据表示至少一项有效主页指标；详细指标仍以各卡片的可比账号数为准。</p><p>作品存量及其净变化取自主页统计，与逐条作品明细是两条采集链路。明细仅部分或未取得，不等于主页作品数缺失；本次明细完整也不代表已收齐历史删除、隐藏的全部作品。</p><div class="collection-states">${Object.entries(worksLabels).map(([key, label]) => `<span>${label} <strong>${c.works[key]}</strong></span>`).join('')}</div><div class="collection-actions"><button type="button" class="secondary-btn" data-collection-filter="missing-profile" ${c.profileMissingCount ? '' : 'disabled'}>查看主页缺采 · ${c.profileMissingCount}</button><button type="button" class="secondary-btn" data-collection-filter="incomplete-works" ${c.total > c.works.complete ? '' : 'disabled'}>查看作品明细不完整 · ${c.total - c.works.complete}</button></div>`;
}
function selectCollectionFilter(value) {
  clearLocalAccountFilters({ collection: Object.hasOwn(collectionLabels, value) ? value : 'all' });
  setView('accounts'); renderAccounts();
}
function accountCollectionMarkup(account) {
  const c = collectionOnDate(account);
  const dayLabel = state.data?.activeRecordedWindow ? `所选末日 ${appliedRange().end}` : '期末';
  return `<small class="${c.profileObserved ? 'muted' : 'down'}">${dayLabel}主页${c.profileObserved ? '有数据' : '缺采'}</small><small class="muted">${worksLabels[c.worksState] || worksLabels.unknown}</small>`;
}
function rows({ overview = false, ignoreWorkflow = false } = {}) {
  const q = overview ? '' : state.query.trim().toLocaleLowerCase();
  const enabled = overview ? 'active' : state.enabled;
  const selected = (state.data?.accounts || []).filter(a => {
    if (enabled === 'active' && !a.enabled) return false;
    if (enabled === 'paused' && a.enabled) return false;
    if (!overview && state.platform !== 'all' && a.platform !== state.platform) return false;
    const collection = collectionOnDate(a);
    if (!overview && state.collectionFilter === 'missing-profile' && collection.profileObserved) return false;
    if (!overview && state.collectionFilter === 'incomplete-works' && collection.worksState === 'complete') return false;
    return !q || [a.label, a.submittedName, a.publicId, a.submittedAccountId, ...(rosterSearchAliases.get(a.id) || [])].some(v => String(v || '').toLocaleLowerCase().includes(q));
  });
  const filtered = !ignoreWorkflow && state.workflowTask !== 'all'
    ? filterWorkflowAccounts(selected, { task: state.workflowTask, metric: state.workflowMetric, period: state.data?.period }) : selected;
  return sortAccounts(filtered, state.sort, state.direction, state.data?.period);
}
function renderWorkflow() {
  for (const [id, overview] of [['dailyWorkflow', true], ['accountWorkflow', false]]) {
    const root = $(id); if (!root) continue;
    const base = rows({ overview, ignoreWorkflow: true });
    const counts = createWorkflowSummary(base, state.workflowMetric, state.data?.period);
    if (!overview) { counts.all = base.length; root.hidden = state.enabled === 'paused'; }
    root.innerHTML = Object.entries(workflowLabels).map(([task, label]) => `<button type="button" class="workflow-button" data-workflow-task="${task}" aria-pressed="${state.workflowTask === task}"><span>${label}</span><strong>${fmt(counts[task], true)}</strong></button>`).join('');
  }
  for (const id of ['workflowMetric', 'accountWorkflowMetric']) if ($(id)) $(id).value = state.workflowMetric;
  if ($('accountWorkflowMetric')) $('accountWorkflowMetric').disabled = state.enabled === 'paused';
  if ($('accountWorkflowCaption')) $('accountWorkflowCaption').textContent = state.enabled === 'paused'
    ? '当前只查看暂停账号；增长、下滑与缺可比数据筛选仅用于启用账号。'
    : `${state.enabled === 'all' ? '“全部”包含暂停账号；表现筛选只统计启用账号。' : '按当前搜索与平台条件统计启用账号。'}真实零变化保留在“全部”。${state.workflowMetric === 'estimatedPlays' ? '估算播放 = 获赞净变化 × 100，非实际播放。' : ''}`;
  const accounts = rows({ overview: true });
  if ($('workflowCaption')) $('workflowCaption').textContent = `${METRICS[state.workflowMetric]} · ${workflowLabels[state.workflowTask]} · ${accounts.length} 个启用账号，展示前 ${Math.min(accounts.length, 8)} 个。仅筛选下方列表，上方区间总计不变；真实零变化保留在“全部”。${state.workflowMetric === 'estimatedPlays' ? '估算播放 = 获赞净变化 × 100，非实际播放。' : ''}`;
}
function selectWorkflow(task, metric = state.workflowMetric) {
  if (!Object.hasOwn(workflowLabels, task) || !Object.hasOwn(METRICS, metric)) return;
  state.workflowTask = task; state.workflowMetric = metric; state.page = 1;
  if (task !== 'all') { state.enabled = 'active'; if ($('enabledSelect')) $('enabledSelect').value = 'active'; }
  state.sort = `${metric}.delta`; state.direction = task === 'declining' ? 'asc' : 'desc';
  state.metric = metric;
  renderAccounts();
  if (state.view === 'overview') renderTrend();
}
function overviewAccountTable(accounts) {
  if (!accounts.length) return '<div class="table-empty">当前条件下没有账号。<button type="button" class="link-btn" data-workflow-task="all">查看全部表现</button></div>';
  const key = `${state.workflowMetric}.delta`;
  // Keep follower and like changes visible beside their totals regardless
  // of the investigation metric. Only append other focused metrics.
  const tableColumns = [['label', '账号'], ['followers.value', '粉丝数'], ['followers.delta', '粉丝净变化'],
    ['likes.value', '获赞数'], ['likes.delta', '获赞净变化'], ['posts.value', '作品数'],
    ...(['followers.delta', 'likes.delta'].includes(key) ? [] : [[key, `${METRICS[state.workflowMetric]}净变化`]])];
  return `<table class="table overview-ledger"><thead><tr>${tableColumns.map(([sort, label]) => `<th scope="col" aria-sort="${state.sort === sort ? state.direction === 'asc' ? 'ascending' : 'descending' : 'none'}"><button type="button" class="sort-button" data-sort="${sort}">${esc(label)}<span aria-hidden="true">${state.sort === sort ? state.direction === 'asc' ? ' ↑' : ' ↓' : ' ↕'}</span></button></th>`).join('')}<th scope="col">大主题</th><th scope="col">最近采样</th></tr></thead><tbody>${accounts.map(a => `<tr><td><button type="button" class="row-btn account-cell" data-account-id="${a.id}" data-account-metric="${state.workflowMetric}"><span><strong>${esc(a.label)}</strong><small>${esc(platformNames[a.platform] || a.platform)} · ${esc(a.publicId || a.submittedAccountId || '暂无账号ID')}</small></span></button></td>${tableColumns.slice(1).map(([metric]) => accountMetricCell(a, metric, 'overviewTable')).join('')}<td>${accountThemeMarkup(a)}</td><td>${dateTime(a.status?.lastSuccessAt)}</td></tr>`).join('')}</tbody></table>`;
}
const columns = [['label', '账号'], ['followers.value', '粉丝数'], ['followers.delta', '粉丝净变化'], ['likes.value', '获赞数'], ['likes.delta', '获赞净变化'], ['estimatedPlays.delta', '估算播放变化'], ['posts.value', '作品数'], ['posts.delta', '作品净变化']];
function compactLedger() { return ledgerMode === 'compact' || ledgerMode === null && typeof window !== 'undefined' && window.matchMedia?.('(max-width: 720px)').matches; }
function ledgerControls() {
  const root = $('ledgerReadingControls'); if (!root) return;
  root.innerHTML = `<label>阅读模式<select id="ledgerMode"><option value="auto">随屏幕 · 当前${compactLedger()?'紧凑':'完整'}</option><option value="compact">紧凑读数</option><option value="full">完整台账</option></select></label><label>紧凑指标<select id="ledgerMetric">${Object.entries(METRICS).map(([key,label])=>`<option value="${key}">${esc(label)}${key==='estimatedPlays'?' · 仅净变化':''}</option>`).join('')}</select></label>`;
  $('ledgerMode').value = ledgerMode || 'auto'; $('ledgerMetric').value = ledgerMetric;
  $('ledgerMetric').disabled = !compactLedger();
}
function changeLedgerReading(key, value) {
  if (key === 'mode' && ['auto','compact','full'].includes(value)) ledgerMode = value === 'auto' ? null : value;
  else if (key === 'metric' && Object.hasOwn(METRICS,value)) ledgerMetric = value;
  else return;
  const top = $('accountsTable').scrollTop, left = $('accountsTable').scrollLeft;
  renderAccounts(); $('accountsTable').scrollTop = top; $('accountsTable').scrollLeft = left;
}
function ledgerSortButton(key) {
  return `<button type="button" class="sort-button" data-sort="${key}">${esc(columns.find(([column])=>column===key)[1])}<span aria-hidden="true">${state.sort===key?(state.direction==='asc'?' ↑':' ↓'):' ↕'}</span></button>`;
}
function compactAccountTable(accounts) {
  if (!accounts.length) return '<div class="table-empty">没有符合条件的账号。试试清除搜索或切换矩阵。</div>';
  const keys = ledgerMetric === 'estimatedPlays' ? ['estimatedPlays.delta'] : [`${ledgerMetric}.value`,`${ledgerMetric}.delta`];
  return `<table class="table compact-ledger"><thead><tr><th scope="col" aria-sort="${state.sort==='label'?(state.direction==='asc'?'ascending':'descending'):'none'}">${ledgerSortButton('label')}</th><th scope="col" aria-sort="${keys.includes(state.sort)?(state.direction==='asc'?'ascending':'descending'):'none'}">${keys.map(ledgerSortButton).join('')}</th></tr></thead><tbody>${accounts.map(a=>`<tr><td><button class="row-btn account-cell" data-account-id="${esc(a.id)}"><span><strong>${esc(a.label)}</strong><small>${esc(platformNames[a.platform]||a.platform)} · ${esc(a.publicId||a.submittedAccountId||'尚无账号 ID')}</small>${a.enabled?'':'<small>已暂停</small>'}</span></button><small>${dateTime(a.status?.lastSuccessAt)}</small>${accountCollectionMarkup(a)}</td><td>${keys.map(key=>`<div class="compact-metric"><small>${esc(columns.find(([column])=>column===key)[1])}</small>${accountMetricCell(a,key,'accountsTable','div')}</div>`).join('')}${ledgerMetric==='estimatedPlays'?'<small class="muted">获赞净变化 × 100 · 非实际播放量</small>':''}</td></tr>`).join('')}</tbody></table>`;
}
function accountMetricCell(a, key, tableId, tag = 'td') {
  const [metric, field] = key.split('.'); const m = a.metrics?.[metric] || {};
  const value = field === 'delta' ? periodDelta(m, state.data.period) : m.value;
  const exact = fmt(value, true), compact = fmt(value);
  const title = m.reason ? `${exact} · ${m.reason}` : exact;
  const reasonId = `metric-reason-${encodeURIComponent(JSON.stringify([tableId, a.id, key]))}`;
  const reason = m.reason ? `<details id="${esc(reasonId)}" class="account-metric-reason"><summary id="${esc(reasonId)}-summary">${esc(columns.find(([column]) => column === key)[1])}说明</summary><p>${esc(m.reason)}</p></details>` : '';
  const exactLine = field === 'value' && compact !== exact ? `<small class="metric-exact muted">记录 ${esc(exact)}</small>` : '';
  return `<${tag} title="${esc(title)}">${field === 'delta' ? signed(value) : `<span class="metric">${compact}</span>${exactLine}${m.recordedStockOutsideWindow ? `<small class="muted">历史值 · ${dateTime(m.currentAt)}</small>` : ''}`}${reason}</${tag}>`;
}
function accountClassificationMarkup(account) {
  const labels = account.classification?.labels?.length
    ? account.classification.labels
    : [{ label: account.classification?.primaryLabel || '待分类', color: 'slate' }];
  const visible = labels.slice(0, 3).map(item => `<span class="classification-chip classification-chip-${esc(item.color || 'slate')}">${esc(item.label)}</span>`).join('');
  const more = labels.length > 3 ? `<span class="classification-more">+${labels.length - 3}</span>` : '';
  const categories = (account.boards || []).map(board => String(board.category || '').trim()).filter(Boolean);
  const tiers = (account.boards || []).map(board => String(board.tier || '').trim()).filter(Boolean);
  const sourceConfirmed = labels.filter(item => item.sourceConfirmed).map(item => `总表分类：${item.label}`);
  const sourceDescriptions = (account.classification?.sourceDescriptions || []).map(value => `原表描述：${value}`);
  const raw = [...new Set([...categories.map(value => `板块分类：${value}`), ...tiers.map(value => `账号层级：${value}`), ...sourceConfirmed, ...sourceDescriptions])].join('；');
  const evidence = raw ? `<small class="classification-evidence" title="${esc(raw)}">来源：${esc(raw.length > 62 ? `${raw.slice(0, 62)}…` : raw)}</small>` : '';
  return `${visible}${more}${evidence}`;
}
function accountThemeMarkup(account) {
  const theme = account.classification?.theme || { key: 'unassigned', label: '待归属' };
  return `<span class="theme-chip theme-chip-${esc(theme.key || 'unassigned')}">${esc(theme.label || '待归属')}</span>`;
}
function accountTable(accounts, tableId = 'accountsTable') {
  if (!accounts.length) return '<div class="table-empty">没有符合条件的账号。试试清除搜索或切换矩阵。</div>';
  return `<table class="table"><thead><tr>${columns.map(([key, name]) => `<th scope="col" aria-sort="${state.sort === key ? state.direction === 'asc' ? 'ascending' : 'descending' : 'none'}"><button class="sort-button" data-sort="${key}">${name}<span aria-hidden="true">${state.sort === key ? state.direction === 'asc' ? ' ↑' : ' ↓' : ' ↕'}</span></button></th>`).join('')}<th scope="col">大主题</th><th scope="col">矩阵类型 / 内容标签</th><th scope="col">采样时间</th></tr></thead><tbody>${accounts.map(a => `<tr><td><button class="row-btn account-cell" data-account-id="${a.id}"><span class="avatar" aria-hidden="true">${esc(Array.from(a.label || '?')[0])}</span><span><strong>${esc(a.label)}</strong><small>${esc(platformNames[a.platform] || a.platform)} · ${esc(a.publicId || a.submittedAccountId || '尚无账号 ID')}</small>${a.enabled ? '' : '<small>已暂停</small>'}</span></button></td>${columns.slice(1).map(([key]) => {
    return accountMetricCell(a, key, tableId);
  }).join('')}<td class="theme-cell">${accountThemeMarkup(a)}</td><td class="classification-cell">${accountClassificationMarkup(a)}</td><td><span>${dateTime(a.status?.lastSuccessAt)}</span>${accountCollectionMarkup(a)}</td></tr>`).join('')}</tbody></table>`;
}
function renderAccounts() {
  if (!state.data) return;
  const active = document.activeElement;
  const reasonFocusId = active?.closest?.('.account-metric-reason') ? active.id : null;
  const openReasons = [...document.querySelectorAll('.account-metric-reason[open]')].map(el => el.id);
  const focusKey = active?.dataset?.sort ? ['sort', active.dataset.sort, active.closest?.('#overviewTable') ? 'overviewTable' : 'accountsTable']
    : active?.dataset?.page ? ['page', active.dataset.page, active.closest?.('#accountsPagerTop') ? 'accountsPagerTop' : 'pager'] : null;
  const accounts = rows(), pages = Math.max(1, Math.ceil(accounts.length / state.pageSize));
  state.page = Math.max(1, Math.min(state.page, pages));
  const start = (state.page - 1) * state.pageSize;
  const ledgerFocus = active?.id?.startsWith('ledger') ? active.id : null;
  ledgerControls();
  const pageRows = accounts.slice(start, start + state.pageSize);
  $('accountsTable').innerHTML = compactLedger() ? compactAccountTable(pageRows) : accountTable(pageRows, 'accountsTable');
  // Overview always describes the same enabled source scope as its KPI cards.
  // Keep local investigation filters in the ledger without leaking them here.
  $('overviewTable').innerHTML = overviewAccountTable(rows({ overview: true }).slice(0, 8));
  renderWorkflow();
  for (const id of openReasons) { const reason = $(id); if (reason) reason.open = true; }
  $('collectionSelect').value = state.collectionFilter;
  const scopedAccounts = Array.isArray(state.data.accounts) ? state.data.accounts : [];
  const scopedEnabled = scopedAccounts.filter(account => account.enabled).length;
  const scopedPaused = scopedAccounts.length - scopedEnabled;
  const range = effectiveMetricRange(); $('accountCount').textContent = `当前范围已建档 ${scopedAccounts.length} 个（启用 ${scopedEnabled} · 暂停 ${scopedPaused}） · 当前筛选 ${accounts.length} 个 · ${collectionLabels[state.collectionFilter]} · ${state.data.activeRecordedWindow ? `已记录时段变化：${state.data.activeRecordedWindow.baselineDate} 采样 → ${range.end} 采样` : `列表变化对应 ${range.start} 至 ${range.end}`}`;
  const sortLabel = columns.find(([key]) => key === state.sort)?.[1] || state.sort;
  const sortDirection = state.sort === 'label' ? (state.direction === 'asc' ? '名称升序' : '名称降序') : (state.direction === 'asc' ? '从低到高' : '从高到低');
  const [sortMetric, sortField] = state.sort.split('.');
  const hiddenDailyDelta = sortField === 'delta' && accounts.some(account => numeric(account.metrics?.[sortMetric]?.delta) !== null && periodDelta(account.metrics?.[sortMetric], state.data.period) === null);
  const sortBoundary = state.sort === 'label' ? '' : hiddenDailyDelta ? ' · 非日可比变化显示— · 缺测最后' : ' · 缺测最后';
  $('accountCount').textContent += ` · 当前按${sortLabel} · ${sortDirection}${sortBoundary}`;
  if (state.workflowTask !== 'all') $('accountCount').textContent += ` · ${METRICS[state.workflowMetric]}${workflowLabels[state.workflowTask]}`;
  const pagination = `<span>${accounts.length ? start + 1 : 0}–${Math.min(start + state.pageSize, accounts.length)} / ${accounts.length} 个账号</span><button data-page="prev" ${state.page === 1 ? 'disabled' : ''}>上一页</button><span>${state.page} / ${pages}</span><button data-page="next" ${state.page >= pages ? 'disabled' : ''}>下一页</button>`;
  $('accountsPagerTop').innerHTML = pagination;
  $('pager').innerHTML = pagination;
  if (focusKey) {
    const [attribute, value, root] = focusKey;
    const next = $(root).querySelector?.(`[data-${attribute}="${value}"]`);
    (next?.disabled ? $(root).querySelector?.('button:not(:disabled)') || $('accountCount') : next)?.focus?.({ preventScroll: true });
  }
  if (reasonFocusId) ($(reasonFocusId) || $('accountCount')).focus?.({ preventScroll: true });
  if (ledgerFocus) $(ledgerFocus)?.focus?.({ preventScroll: true });
  saveLocation();
}
function changeAccountPage(direction) {
  const previousPage = state.page;
  state.page += direction === 'next' ? 1 : -1;
  renderAccounts();
  if (state.page === previousPage) return;
  $('accountsTable').scrollTop = 0;
  const pager = $('accountsPagerTop');
  const sameDirection = pager.querySelector?.(`[data-page="${direction}"]`);
  const focusTarget = sameDirection?.disabled ? pager.querySelector?.('button:not(:disabled)') : sameDirection;
  (focusTarget || $('accountCount')).focus?.({ preventScroll: true });
  pager.scrollIntoView?.({ block: 'start', behavior: 'instant' });
}
function chartAxisLabel(value) {
  const compact = fmt(value);
  return compact.length <= 8 ? compact : value.toExponential(1).replace('+', '');
}
const CHART_GEOMETRY = Object.freeze({ width: 980, height: 235, left: 68, right: 24 });
function chartXAtIndex(index, length) {
  const { width, left, right } = CHART_GEOMETRY;
  return left + (width - left - right) * (length <= 1 ? .5 : index / (length - 1));
}
function chartMarkup(points, key, comparison = [], labelKey = state.metric, { background = false, selectedDate = null, singleAccount = false } = {}) {
  const { width, height } = CHART_GEOMETRY, pad = { l: CHART_GEOMETRY.left, r: CHART_GEOMETRY.right, t: 22, b: 30 };
  const values = points.map(p => p.conflict ? null : numeric(p[key]));
  const other = comparison.map(p => p.conflict ? null : numeric(p[key]));
  const valid = [...values, ...other].filter(v => v !== null);
  if (!valid.length) return '<div class="empty">这个时段还没有可比快照。缺少数据的日期保持空白，不计为 0。</div>';
  const min = Math.min(0, ...valid), max = Math.max(0, ...valid), span = max - min || 1;
  const scaleLength = Math.max(points.length, comparison.length, 1);
  const x = (i) => pad.l + (width - pad.l - pad.r) * (scaleLength <= 1 ? .5 : i / (scaleLength - 1));
  const y = v => height - pad.b - (v - min) / span * (height - pad.b - pad.t);
  const ticks = [...new Set([Math.ceil(min), Math.round(min + span / 2), Math.floor(min + span)])];
  const grid = ticks.map(v => `<line x1="${pad.l}" y1="${y(v)}" x2="${width - pad.r}" y2="${y(v)}" stroke="var(--line)"/><text x="${pad.l - 10}" y="${y(v) + 4}" text-anchor="end" fill="var(--muted)" font-size="12">${chartAxisLabel(v)}</text>`).join('');
  const cohortField = `${key}CohortKey`, reliableField = `${key}Reliable`;
  const series = (items, vals, color, dashed = false) => {
    let connected = false, path = '';
    vals.forEach((v, i) => {
      const previous = items[i - 1], current = items[i];
      const sameCohort = singleAccount || Boolean(previous?.[cohortField] && previous[cohortField] === current?.[cohortField]);
      const previousDay = Date.parse(`${previous?.date}T00:00:00Z`);
      const adjacent = Number.isFinite(previousDay) && new Date(previousDay + 86400000).toISOString().slice(0, 10) === current?.date;
      if (v === null || (!singleAccount && current?.[reliableField] !== true)) { connected = false; return; }
      path += `${connected && sameCohort && adjacent ? 'L' : 'M'}${x(i)},${y(v)} `;
      connected = true;
    });
    return `<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" ${dashed ? 'stroke-dasharray="6 5"' : ''}/>${vals.map((v, i) => {
      if (v === null) return '';
      const reliable = singleAccount || items[i]?.[reliableField] === true;
      const quality = reliable ? '可比观测' : items[i]?.[reliableField] === false ? '部分可比账号，覆盖不足；不连线' : '可比覆盖待核验；不连线';
      return `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="${reliable ? color : 'var(--panel)'}" stroke="${reliable ? color : 'var(--muted)'}" stroke-width="1.5"><title>${esc(items[i]?.date)} · ${fmt(v, true)} · ${quality}</title></circle>`;
    }).join('')}`;
  };
  const selectedIndex = background ? points.findIndex(p => p.date === selectedDate) : -1;
  const selectedMarker = selectedIndex < 0 ? '' : `<line x1="${x(selectedIndex)}" x2="${x(selectedIndex)}" y1="${pad.t}" y2="${height - pad.b}" stroke="var(--muted)" stroke-dasharray="3 4"><title>所选日 ${esc(selectedDate)}；上方 KPI 仅统计此日</title></line>`;
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(METRICS[labelKey] || labelKey)}每日变化，${singleAccount ? (comparison.length ? '单账号实线为A本期，虚线为B对比期，按第N天对齐，缺日断线' : '单账号相邻日期观测，缺日断线') : background ? '截至所选日近30天背景，所选日KPI不变，非累计变化；空心点为部分可比账号或覆盖待核验，不连线' : '实线为本期，虚线为对比期；空心点为部分可比账号或覆盖待核验，不连线'}">${grid}${selectedMarker}${series(points, values, 'var(--blue)')}${comparison.length ? series(comparison, other, 'var(--muted)', true) : ''}</svg>`;
}
function chartPointQuality(point, key, singleAccount) {
  if (!point) return '范围外，无对应日期';
  if (point.conflict) return '同日记录冲突，留空待核对';
  if (numeric(point[key]) === null) return '缺少可比快照，不补零';
  if (singleAccount || point[`${key}Reliable`] === true) return '可比观测';
  return point[`${key}Reliable`] === false ? '部分可比账号，覆盖不足；不连线' : '可比覆盖待核验；不连线';
}
function chartReadingText(reading) {
  const unit = reading.metric === 'followers' ? '人' : reading.metric === 'posts' ? '条' : '次';
  return [reading.points, ...(reading.comparison.length ? [reading.comparison] : [])].map((items, side) => {
    const point = items[reading.index], value = point && !point.conflict ? numeric(point[reading.key]) : null;
    return `<div><strong>${side ? '对比期' : '本期'} · ${esc(point?.date || '范围外')}</strong><span>${esc(METRICS[reading.metric])}净变化 · 记录 ${value === null ? '—（缺测）' : esc(fmt(value, true)) + ` ${unit}`}</span><small>${esc(chartPointQuality(point, reading.key, reading.singleAccount))}</small></div>`;
  }).join('') + (reading.metric === 'estimatedPlays' ? '<small>获赞净变化 × 100，非实际播放量。</small>' : '');
}
function chartDayIndexAtPointer(svg, event, length) {
  if (!svg || !event || !Number.isSafeInteger(length) || length < 1) return null;
  try {
    const matrix = svg.getScreenCTM?.();
    if (!matrix || typeof matrix.inverse !== 'function') return null;
    const inverse = matrix.inverse();
    let point;
    if (typeof svg.createSVGPoint === 'function') {
      point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
    } else if (typeof DOMPoint === 'function') point = new DOMPoint(event.clientX, event.clientY);
    else return null;
    const x = point.matrixTransform(inverse).x;
    if (!Number.isFinite(x)) return null;
    const { width, left, right } = CHART_GEOMETRY;
    return Math.round(Math.max(0, Math.min(1, (x - left) / (width - left - right))) * (length - 1));
  } catch { return null; }
}
function readableChartMarkup(owner, scope, points, key, comparison, metric, options = {}) {
  const previous = chartReadings.get(owner), length = Math.max(points.length, comparison.length);
  const index = previous?.scope === scope ? Math.min(previous.index, Math.max(0, length - 1)) : Math.max(0, points.length - 1);
  const reading = { scope, points, comparison, key, metric, singleAccount: Boolean(options.singleAccount), index };
  chartReadings.set(owner, reading);
  const position = chartXAtIndex(index, length);
  const svg = chartMarkup(points, key, comparison, metric, options).replace('</svg>', `<line class="chart-reading-marker" x1="${position}" x2="${position}" y1="22" y2="205" stroke="var(--ink)" stroke-dasharray="3 4" aria-hidden="true"/></svg>`);
  return `<section class="chart-reading" data-chart-owner="${owner}" aria-label="${esc(METRICS[metric])}逐日读数"><div class="chart-reading-controls"><label>读数日期<select id="${owner}ChartDate" data-chart-date="${owner}" ${length ? '' : 'disabled'}>${Array.from({length}, (_, i) => `<option value="${i}" ${i === index ? 'selected' : ''}>${esc(points[i]?.date || '本期范围外')}${comparison.length ? ` / 对比 ${esc(comparison[i]?.date || '范围外')}` : ''}</option>`).join('')}</select></label><span>点按图表或聚焦图表后用左右键选日；不改变上方区间指标。</span></div><div class="chart-reading-plot" id="${owner}ChartPlot" data-chart-plot="${owner}" tabindex="0" role="group" aria-label="${esc(METRICS[metric])}逐日图，左右键选择日期">${svg}</div><div class="chart-reading-value" id="${owner}ChartReading" aria-live="polite" aria-atomic="true">${length ? chartReadingText(reading) : '范围内没有日期记录，缺采不是零。'}</div></section>`;
}
function selectChartDay(owner, index) {
  const reading = chartReadings.get(owner);
  if (!reading || owner === 'detail' && (!detailTrendAccount || state.detailId !== detailTrendAccount.id || !$('accountDialog').open || drawerClosing)) return;
  const length = Math.max(reading.points.length, reading.comparison.length);
  if (!length || !Number.isInteger(index)) return;
  reading.index = Math.max(0, Math.min(index, length - 1));
  $(`${owner}ChartDate`).value = String(reading.index);
  $(`${owner}ChartReading`).innerHTML = chartReadingText(reading);
  const position = chartXAtIndex(reading.index, length);
  const marker = document.querySelector(`[data-chart-plot="${owner}"] .chart-reading-marker`);
  marker?.setAttribute('x1', position); marker?.setAttribute('x2', position);
}
function renderTrend() {
  if (!state.data) return;
  const range = appliedRange(), applied = presentationControls();
  const view = buildTrendView(state.data, { period: applied.period, compare: applied.compare });
  const { points, comparison } = view;
  const compData = state.data.comparison;
  $('trendChart').innerHTML = readableChartMarkup('overview', JSON.stringify([range, compData?.range, applied.board, applied.theme, applied.classification, view.start, view.end, state.metric]), points, `${state.metric}Delta`, comparison, state.metric, { background: view.background, selectedDate: range.end });
  $('chartAxis').innerHTML = comparison.length
    ? `<span>第 1 天</span><span>实线：${esc(range.start)}–${esc(range.end)}；虚线：${esc(compData.range.startDate)}–${esc(compData.range.endDate)} · 按第 N 天对齐</span><span>第 ${Math.max(points.length, comparison.length)} 天</span>`
    : `<span>${esc(view.start)}</span><span>${view.background ? '背景：每日净变化 · 非 30 天累计' : '实线：本期每日净变化'}</span><span>${esc(view.end)}</span>`;
  $('trendCaption').textContent = `${METRICS[state.metric]}每日净变化${view.background ? ' · 截至所选日的近 30 天背景趋势' : ''} · 缺采/覆盖变化断开 · 相邻两日同一批账号`;
  const count = n => Number.isSafeInteger(n) && n >= 0 ? String(n) : '—';
  const metric = state.metric, base = metric === 'estimatedPlays' ? 'likes' : metric;
  const quality = p => p.conflict ? '同日记录冲突，留空待核对' : numeric(p[`${metric}Delta`]) === null ? '缺少可比快照，不补零'
    : p[`${metric}DeltaReliable`] === true ? '可比观测' : p[`${metric}DeltaReliable`] === false ? '部分可比账号，覆盖不足；不连线' : '可比覆盖待核验；不连线';
  const observedLabel = ({ followers: '当日观测粉丝数', likes: '当日观测获赞数', posts: '当日观测作品存量', estimatedPlays: '当日观测点赞数（换算基数）' })[metric];
  $('trendContext').innerHTML = `<div class="trend-context-heading"><strong>${view.background ? '近 30 天背景趋势' : compData ? '所选时段对比' : '所选时段走势'}</strong><span>${esc(view.start)} — ${esc(view.end)}</span></div><p>${view.background ? `上方 KPI 仅统计 ${esc(range.end)}；此图提供历史背景，不扩大日报统计范围，也不是 30 天累计。` : state.data.activeRecordedWindow ? '此图保留所选范围的逐日记录和缺口；上方卡片仅统计已注明的共同采样时段。逐日可比账号可能不同，不能简单相加代替卡片净变化。' : '图表与上方指标保持所选日期范围；每日净变化不是观测总量的简单差额。'}</p><div class="trend-quality-legend"><span><i class="trend-solid" aria-hidden="true"></i>实心：覆盖达标观测</span><span><i class="trend-hollow" aria-hidden="true"></i>空心：部分可比账号或覆盖待核验，不连线</span><span>缺日留空 · 可比账号变化断线</span></div>${metric === 'estimatedPlays' ? '<p>估算播放的每日变化 = 当日获赞净变化 × 100，非实际播放量；表内观测总量仅显示点赞基数。</p>' : ''}`;
  $('trendEvidence').innerHTML = `<summary>查看逐日数值与覆盖账号${view.background ? ' · 近 30 天' : ''}</summary><p class="trend-table-note">“净变化”比较相邻两日同一批账号；“当日观测总量”是当日有数据账号的存量，不能跨日相减代替增长。未知覆盖显示 —，不是 0。</p><div class="table-card"><table class="table trend-evidence-table"><thead><tr><th>日期</th><th>${METRICS[metric]}净变化</th><th>可比账号</th><th>${observedLabel}</th><th>当日观测账号</th><th>数据说明</th></tr></thead><tbody>${points.map(p => `<tr${view.background && p.date === range.end ? ' class="trend-selected-day"' : ''}><td>${esc(p.date)}${view.background && p.date === range.end ? '<small>所选日 · 对应上方 KPI</small>' : ''}</td><td>${signed(p[`${metric}Delta`])}</td><td>${count(p[`${base}ComparableCount`])} / ${count(state.data.summary.enabledCount)}</td><td>${fmt(p[base], true)}</td><td>${count(p[`${base}ObservedCount`])} / ${count(state.data.summary.enabledCount)}</td><td>${quality(p)}</td></tr>`).join('')}</tbody></table></div>`;
  document.querySelectorAll('[data-metric]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.metric === state.metric)));
}

function worksEvidenceTime(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '未知';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}
function safeWorkUrl(value) {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
function renderWorksEvidence(data, range) {
  const account = data.account || {}, published = account.publishedSamples;
  const sampleCount = published?.basis === 'published_at' && published.scope === 'observed-public-posts'
    && Number.isSafeInteger(published.value) && published.value >= 0 ? published.value : null;
  const collection = account.collection?.date === range.end ? account.collection : null;
  const coverage = ({ complete: '本次记录完整 · 历史范围未核验', limited: '仅部分作品', unavailable: '作品未取得', unknown: '作品范围未核验', missing: '当日无作品记录' })[collection?.worksState] || '作品范围未知';
  const items = Array.isArray(data.recentWorks) ? data.recentWorks.filter(item => item && typeof item === 'object').slice(0, 20) : [];
  const rows = items.map(item => {
    const title = String(item.caption || '未提供标题'), url = safeWorkUrl(item.url);
    return `<li><div class="works-item-title">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(title)}">${esc(title)} <span aria-hidden="true">↗</span></a>` : `<span>${esc(title)}</span>`}</div><dl><div><dt>发布时间</dt><dd>${esc(worksEvidenceTime(item.publishedAt))}</dd></div><div><dt>最近观测</dt><dd>${esc(worksEvidenceTime(item.lastObservedAt))}</dd></div></dl></li>`;
  }).join('');
  return `<section class="works-evidence" aria-label="作品与发布证据"><div class="works-evidence-heading"><h3>作品与发布证据</h3><span class="works-coverage">${esc(range.end)} · ${coverage}</span></div><div class="works-evidence-metrics"><div><small>作品存量净变化</small><strong>${signed(account.metrics?.posts?.delta)}</strong><p>总量的净变化，可受删除或隐藏影响，不等于新增发布量。</p></div><div><small>本期已收录发布样本</small><strong>${sampleCount === null ? '—' : fmt(sampleCount, true)}<span> 条</span></strong><p>${esc(range.start)} 至 ${esc(range.end)} · 按发布时间统计；${sampleCount === 0 ? '已收录 0 条不等于没有发布。' : '样本不代表全部发布量。'}</p></div></div><p class="works-evidence-note">收录截止 ${esc(worksEvidenceTime(published?.asOf))}（北京时间）；结束后才发现的旧作品不计入。作品范围未完整核验时，不能据样本判断全量产能。</p><details class="works-samples"><summary>查看最近已收录作品 · 最多 20 条</summary><p>这是截至本期末的最近已收录样本，不是本期发布全集，也不代表全部历史；列表中的作品可能早于本期。时间均为北京时间。</p>${rows ? `<ul class="works-list">${rows}</ul>` : '<p class="works-empty">暂无可展示的已收录作品记录；缺采不等于没有发布。</p>'}</details></section>`;
}
function accountHistoryShell() {
  return '<section class="account-history" aria-labelledby="accountHistoryTitle"><div class="history-heading"><h3 id="accountHistoryTitle" tabindex="-1">全部已保存历史</h3><button type="button" class="secondary-btn" data-history-open>浏览全部已保存历史</button></div><p class="history-boundary">可核验范围内已保存的作品与每日统计，不受主页日期限制；不代表所有原始记录已通过校验，也不代表平台全部作品或未采到的历史。</p><div id="accountHistoryPanel" hidden></div></section>';
}
function cancelAccountHistory() {
  historyGeneration++;
  accountHistory?.controller?.abort(); accountHistory?.exportController?.abort();
  accountHistory?.work?.controller?.abort(); accountHistory = null;
}
function historyIsCurrent(value) {
  return accountHistory === value && value.generation === historyGeneration
    && state.detailId === value.targetId && $('accountDialog').open && !drawerClosing;
}
function historyDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function historyQuery(value, { kind = value.kind, page = value.page, workId = null, sort = value.sort, order = value.order, pageSize = value.pageSize } = {}) {
  const query = new URLSearchParams({ kind, page: String(page), pageSize: String(pageSize), sort, order });
  if (value.asOf) query.set('asOf', value.asOf);
  if (value.revision) for (const key of ['snapshotMaxId', 'postMaxId', 'postMetricMaxId']) query.set(key, String(value.revision[key]));
  if (value.startDate) query.set('startDate', value.startDate);
  if (value.endDate) query.set('endDate', value.endDate);
  if (workId !== null) query.set('workId', String(workId));
  return `/api/rebuild/accounts/${encodeURIComponent(value.targetId)}/history?${query}`;
}
function validateAccountHistory(data, value, { kind = value.kind, page = value.page, pageSize = value.pageSize } = {}) {
  const p = data?.pagination;
  if (data?.version !== 1 || data.targetId !== value.targetId || data.kind !== kind
      || typeof data.asOf !== 'string' || !Number.isFinite(Date.parse(data.asOf)) || new Date(data.asOf).toISOString() !== data.asOf
      || (value.asOf && data.asOf !== value.asOf)
      || !data.revision || ['snapshotMaxId', 'postMaxId', 'postMetricMaxId'].some(key => !Number.isSafeInteger(data.revision[key]) || data.revision[key] < 0 || (value.revision && data.revision[key] !== value.revision[key]))
      || !data.range || !p || !Number.isSafeInteger(p.total) || p.total < 0
      || data.range.startDate !== (value.startDate || null) || data.range.endDate !== (value.endDate || null)
      || data.coverage?.scope !== 'all-saved-account-history' || data.coverage.platformComplete !== false || data.coverage.missingDatesFilled !== false
      || p.page !== page || p.pageSize !== pageSize
      || p.totalPages !== Math.ceil(p.total / pageSize)
      || !Array.isArray(data.items) || data.items.length !== Math.min(pageSize, Math.max(0, p.total - (page - 1) * pageSize))
      || data.items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('历史响应不完整或范围已改变，未采用本次记录');
  }
  const cap = data.revision[kind === 'works' ? 'postMaxId' : kind === 'daily' ? 'snapshotMaxId' : 'postMetricMaxId'];
  if (value.data && value.loadedSignature === historyQuery(value, { page: 1 }) && value.data.pagination.total !== p.total) throw new Error('固定截面内历史条数改变，未采用本次记录');
  if (data.items.some(item => !Number.isSafeInteger(item.id) || item.id < 1 || item.id > cap
      || (kind === 'workMetrics' && item.workId !== value.workId))
      || new Set(data.items.map(item => item.id)).size !== data.items.length) throw new Error('历史记录编号或作品归属不一致，未采用本次记录');
  return data;
}
function historySortOptions(kind) {
  return kind === 'works' ? [['publishedAt', '发布时间'], ['lastObservedAt', '最近观测'], ['likes', '点赞'], ['comments', '评论'], ['shares', '分享'], ['collects', '收藏'], ['plays', '播放来源值']]
    : kind === 'daily' ? [['date', '日期'], ['followers', '粉丝'], ['followersDelta', '粉丝净变化'], ['likes', '获赞'], ['likesDelta', '获赞净变化'], ['posts', '作品存量'], ['postsDelta', '作品净变化'], ['estimatedPlays', '估算播放（获赞×100）'], ['estimatedPlaysDelta', '估算播放净变化（获赞净变化×100）']]
      : [['capturedAt', '采样时间'], ['likes', '点赞'], ['comments', '评论'], ['shares', '分享'], ['collects', '收藏'], ['plays', '播放来源值']];
}
function mountAccountHistory() {
  const value = { targetId: state.detailId, generation: historyGeneration, kind: 'works', page: 1, pageSize: 20,
    sort: 'publishedAt', order: 'desc', startDate: '', endDate: '', asOf: '', revision: null, data: null, request: 0, exporting: false, work: null };
  accountHistory = value;
  const panel = $('accountHistoryPanel'); panel.hidden = false;
  panel.innerHTML = '<div class="history-kind" role="group" aria-label="已保存历史类型"><button type="button" class="secondary-btn" data-history-kind="works" aria-pressed="true">已保存作品</button><button type="button" class="secondary-btn" data-history-kind="daily" aria-pressed="false">每日统计</button></div><div class="history-controls"><label>开始日期<input id="historyStartDate" type="date"></label><label>结束日期<input id="historyEndDate" type="date"></label><button type="button" class="secondary-btn" data-history-apply>应用日期</button><button type="button" class="link-btn" data-history-clear>恢复全部日期</button><label>排序<select id="historySort"></select></label><label>方向<select id="historyOrder"><option value="desc">从高到低 / 从新到旧</option><option value="asc">从低到高 / 从旧到新</option></select></label></div><div class="history-actions"><button type="button" class="link-btn" data-history-refresh>读取最新保存记录</button><button type="button" class="secondary-btn" id="historyExport" data-history-export disabled>导出全部筛选结果</button></div><p id="historyScope" class="history-scope" tabindex="-1"></p><p id="historyStatus" class="history-status" role="status" aria-live="polite"></p><div id="historyResults" aria-busy="false"></div><div id="historyWorkPanel" hidden></div>';
  updateHistorySortOptions(value);
  $('historySort').onchange = () => { value.sort = $('historySort').value; value.page = 1; void loadAccountHistory(); };
  $('historyOrder').onchange = () => { value.order = $('historyOrder').value; value.page = 1; void loadAccountHistory(); };
  document.querySelector('[data-history-open]')?.setAttribute('aria-expanded', 'true');
  return loadAccountHistory();
}
function updateHistorySortOptions(value) {
  $('historySort').innerHTML = historySortOptions(value.kind).map(([key, label]) => `<option value="${key}">${label}</option>`).join('');
  $('historySort').value = value.sort;
  document.querySelectorAll('[data-history-kind]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.historyKind === value.kind)));
}
function historyPlayCaption(item) {
  return numeric(item.plays) === null ? '来源未提供'
    : item.playsEvidence?.mayBePlaceholder === true ? '来源 0 可能是占位值' : '来源值，未独立核验';
}
function historyPlayCell(item) {
  return `${fmt(item.plays, true)}<small>${esc(historyPlayCaption(item))}</small>`;
}
function historySortHeader(label, key, { workHistory = false } = {}) {
  const value = accountHistory, sorted = workHistory ? value?.work : value;
  const selected = sorted?.sort === key, direction = selected ? sorted.order === 'asc' ? 'ascending' : 'descending' : 'none';
  return key ? `<th scope="col" aria-sort="${direction}"><button type="button" class="sort-button" ${workHistory ? 'data-history-work-sort-key' : 'data-history-sort-key'}="${key}">${label}${selected ? `<span>${sorted.order === 'asc' ? '升序' : '降序'}</span>` : ''}</button></th>` : `<th scope="col">${label}</th>`;
}
function historyMetricProvenance(item) {
  return `<details class="history-provenance"><summary>查看采样依据</summary><dl>${['followers', 'likes', 'posts'].map(key => `<div><dt>${METRICS[key]}</dt><dd>观测：${esc(worksEvidenceTime(item[`${key}At`]))}<br>来源校验：${esc(item[`${key}Checksum`] || '未知')}<br>相邻前日基准：${esc(worksEvidenceTime(item[`${key}BaselineAt`]))}<br>基准校验：${esc(item[`${key}BaselineChecksum`] || '未知')}</dd></div>`).join('')}</dl><p>各项可能来自同日不同采样；没有前一业务日的有效端点时不计算净变化。</p></details>`;
}
function historyTable(data, { workHistory = false } = {}) {
  if (!data.items.length) return '<p class="history-empty">此范围暂无已保存记录；没有记录不等于没有发布或没有变化。</p>';
  const works = data.kind === 'works', daily = data.kind === 'daily';
  const headers = works ? [['作品 / 指标历史', null], ['发布时间', 'publishedAt'], ['点赞', 'likes'], ['评论', 'comments'], ['分享', 'shares'], ['收藏', 'collects'], ['播放来源值', 'plays'], ['最近观测', 'lastObservedAt']]
    : daily ? [['业务日期 / 最后记录', 'date'], ['粉丝', 'followers'], ['粉丝净变化', 'followersDelta'], ['获赞', 'likes'], ['获赞净变化', 'likesDelta'], ['作品存量', 'posts'], ['作品净变化', 'postsDelta'], ['估算播放（获赞×100）', 'estimatedPlays'], ['估算播放净变化', 'estimatedPlaysDelta'], ['各项采样依据', null]]
      : [['采样时间', 'capturedAt'], ['点赞', 'likes'], ['评论', 'comments'], ['分享', 'shares'], ['收藏', 'collects'], ['播放来源值', 'plays']];
  const rows = data.items.map(item => {
    if (works) {
      const url = safeWorkUrl(item.url), caption = String(item.caption || '未提供标题');
      const label = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(caption)}</a>` : esc(caption);
      const detail = Number.isSafeInteger(item.id) && item.id > 0 ? `<button type="button" class="link-btn" data-history-work="${item.id}">查看指标历史</button>` : '';
      return `<tr><td class="history-title">${label}${detail}</td><td>${esc(worksEvidenceTime(item.publishedAt))}</td>${['likes', 'comments', 'shares', 'collects'].map(key => `<td>${fmt(item[key], true)}</td>`).join('')}<td>${historyPlayCell(item)}</td><td>${esc(worksEvidenceTime(item.lastObservedAt))}</td></tr>`;
    }
    const values = daily ? [`${esc(item.date)}<small>当日最后记录 ${esc(worksEvidenceTime(item.capturedAt))}</small>`, fmt(item.followers, true), signed(item.followersDelta), fmt(item.likes, true), signed(item.likesDelta), fmt(item.posts, true), signed(item.postsDelta), fmt(item.estimatedPlays, true), signed(item.estimatedPlaysDelta), historyMetricProvenance(item)]
      : [esc(worksEvidenceTime(item.capturedAt)), fmt(item.likes, true), fmt(item.comments, true), fmt(item.shares, true), fmt(item.collects, true), historyPlayCell(item)];
    return `<tr>${values.map(value => `<td>${value}</td>`).join('')}</tr>`;
  }).join('');
  return `<div class="table-card history-table"><table class="table"><caption class="sr-only">${workHistory ? '单作品已保存指标历史' : works ? '已保存作品' : '全部已保存每日统计'}</caption><thead><tr>${headers.map(([label, key]) => historySortHeader(label, key, { workHistory })).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
function historyPager(data, work = false, location = 'bottom') {
  const p = data.pagination, prefix = work ? 'data-history-work-page' : 'data-history-page';
  return `<div class="pager history-pager" role="group" aria-label="${work ? '单作品历史翻页' : '已保存历史翻页'}${location === 'top' ? '顶部' : '底部'}"><button type="button" class="secondary-btn" data-history-location="${location}" ${prefix}="${p.page - 1}"${p.page <= 1 ? ' disabled' : ''}>上一页</button><span>第 ${p.totalPages ? p.page : 0} / ${p.totalPages} 页 · 共 ${fmt(p.total, true)} 条 · 每页 ${p.pageSize} 条</span><button type="button" class="secondary-btn" data-history-location="${location}" ${prefix}="${p.page + 1}"${p.page >= p.totalPages ? ' disabled' : ''}>下一页</button></div>`;
}
function clearWorkHistory(value) {
  value.work?.controller?.abort(); value.work = null;
  const panel = $('historyWorkPanel'); if (panel) { panel.hidden = true; panel.innerHTML = ''; }
}
async function loadAccountHistory({ latest = false } = {}) {
  const value = accountHistory; if (!value || !historyIsCurrent(value)) return;
  value.controller?.abort(); value.exportController?.abort(); value.exporting = false; clearWorkHistory(value);
  const request = ++value.request; value.controller = new AbortController();
  if (latest) { value.asOf = ''; value.revision = null; value.page = 1; }
  const focus = document.activeElement, pageFocus = focus?.dataset?.historyPage;
  const sortFocus = focus?.dataset?.historySortKey;
  const focusLocation = focus?.dataset?.historyLocation || 'bottom';
  const focusDirection = Number(pageFocus) > (value.data?.pagination.page || 1) ? 'next' : 'previous';
  $('historyStatus').textContent = value.data ? '正在读取历史；下方保留上次成功列表，请以原范围为准。' : '正在读取全部已保存历史…';
  $('historyResults').setAttribute?.('aria-busy', 'true'); $('historyExport').disabled = true;
  document.querySelectorAll('[data-history-page]').forEach(button => { button.disabled = true; });
  const expected = { ...value };
  try {
    const data = validateAccountHistory(await api(historyQuery(expected), { signal: value.controller.signal }), expected);
    if (!historyIsCurrent(value) || request !== value.request) return;
    value.asOf = data.asOf; value.revision = data.revision; value.data = data; value.loadedSignature = historyQuery(value, { page: 1 });
    const range = data.range;
    $('historyScope').textContent = `${value.kind === 'works' ? '作品按发布时间筛选' : '统计按业务日期筛选'} · ${value.startDate || value.endDate ? `${value.startDate || '最早'} 至 ${value.endDate || '截止日'}` : '全部已保存日期'} · 已记录 ${range.firstRecordedDate || '未知'} 至 ${range.lastRecordedDate || '未知'} · 读取截止 ${worksEvidenceTime(data.asOf)}（北京时间）`;
    $('historyResults').innerHTML = historyPager(data, false, 'top') + historyTable(data) + historyPager(data);
    const coverage = data.coverage || {};
    $('historyStatus').textContent = `已读取保存记录；缺测显示 —，不补零。${value.kind === 'works' ? '作品指标是保存的来源值，未逐条独立核验。' : '每日统计经来源校验；净变化只比较相邻有观测业务日。估算播放=获赞×100，非实际播放。'}${Number.isSafeInteger(coverage.metadataUnknownCount) && coverage.metadataUnknownCount > 0 ? ` ${coverage.metadataUnknownCount} 条记录的部分元信息未知。` : ''}${Number.isSafeInteger(coverage.excludedCount) && coverage.excludedCount > 0 ? ` ${coverage.excludedCount} 条${value.kind === 'daily' ? '旧' : ''}保存记录因来源或账号证据不足未显示数值，原始数据仍保留。` : ''}`;
    if ((pageFocus || sortFocus) && (document.activeElement === focus || (!focus?.isConnected && document.activeElement === document.body))) {
      const buttons = [...document.querySelectorAll('[data-history-page]')].filter(button => (button.dataset.historyLocation || 'bottom') === focusLocation);
      const target = sortFocus ? document.querySelector(`[data-history-sort-key="${sortFocus}"]`) : focusDirection === 'next' ? buttons.at(-1) : buttons[0];
      (target && !target.disabled ? target : $('historyScope')).focus?.({ preventScroll: true });
    }
  } catch (error) {
    if (error.name !== 'AbortError' && historyIsCurrent(value) && request === value.request) {
      $('historyStatus').textContent = `读取失败：${error.message}。${value.data ? '保留上次成功列表，不代表当前筛选。' : ''}可点击“重试当前历史”。`;
      if (!value.data) $('historyResults').innerHTML = '';
      $('historyResults').insertAdjacentHTML?.('beforeend', '<button type="button" class="secondary-btn" data-history-retry>重试当前历史</button>');
    }
  } finally {
    if (historyIsCurrent(value) && request === value.request) {
      $('historyResults').setAttribute?.('aria-busy', 'false');
      $('historyExport').disabled = !value.data || value.loadedSignature !== historyQuery(value, { page: 1 });
    }
  }
}
function applyHistoryDates({ clear = false } = {}) {
  const value = accountHistory; if (!value || !historyIsCurrent(value)) return;
  const start = clear ? '' : $('historyStartDate').value, end = clear ? '' : $('historyEndDate').value;
  if (Boolean(start) !== Boolean(end) || (start && !historyDay(start)) || (end && !historyDay(end)) || (start && end && start > end)) {
    $('historyStatus').textContent = '请同时填写有效开始与结束日期，开始日期不能晚于结束日期；当前列表未改变。'; return;
  }
  value.startDate = start; value.endDate = end; value.page = 1;
  $('historyStartDate').value = start; $('historyEndDate').value = end;
  return loadAccountHistory();
}
function changeHistoryKind(kind) {
  const value = accountHistory; if (!value || !['works', 'daily'].includes(kind) || value.kind === kind) return;
  value.kind = kind; value.page = 1; value.sort = kind === 'works' ? 'publishedAt' : 'date';
  updateHistorySortOptions(value); return loadAccountHistory();
}
function changeHistorySort(key, { work = false } = {}) {
  const value = accountHistory, sorted = work ? value?.work : value;
  if (!value || !historyIsCurrent(value) || !sorted || !historySortOptions(work ? 'workMetrics' : value.kind).some(([option]) => option === key)) return;
  sorted.order = sorted.sort === key && sorted.order === 'desc' ? 'asc' : 'desc'; sorted.sort = key;
  if (work) return loadWorkHistory(sorted.id);
  value.page = 1; $('historySort').value = key; $('historyOrder').value = value.order;
  return loadAccountHistory();
}
async function loadWorkHistory(workId, page = 1) {
  const value = accountHistory;
  if (!value || !historyIsCurrent(value) || !value.asOf || !Number.isSafeInteger(workId) || workId < 1) return;
  value.work?.controller?.abort();
  const active = document.activeElement, focusId = active?.id, sortFocus = active?.dataset?.historyWorkSortKey;
  const pageFocus = active?.dataset?.historyWorkPage, focusLocation = active?.dataset?.historyLocation || 'bottom';
  const prior = value.work?.id === workId ? value.work : null;
  const initialOpen = !prior && active?.dataset?.historyWork === String(workId);
  const work = { id: workId, page, sort: prior?.sort || 'capturedAt', order: prior?.order || 'desc', controller: new AbortController() }; value.work = work;
  const panel = $('historyWorkPanel'); panel.hidden = false;
  panel.innerHTML = `<div class="history-heading"><h4 tabindex="-1" id="historyWorkTitle">单作品指标历史</h4><button type="button" class="link-btn" data-history-work-close>返回历史列表</button></div>${loadingMarkup('读取此作品已保存的指标…')}`;
  const expected = { ...value, startDate: '', endDate: '', kind: 'workMetrics', workId, page, sort: work.sort, order: work.order };
  try {
    const data = validateAccountHistory(await api(historyQuery(expected, { workId }), { signal: work.controller.signal }), expected);
    if (!historyIsCurrent(value) || value.work !== work) return;
    if (prior?.data && prior.sort === work.sort && prior.order === work.order && prior.data.pagination.total !== data.pagination.total) throw new Error('固定截面内作品指标条数改变，未采用本次记录');
    work.data = data;
    panel.innerHTML = `<div class="history-heading"><h4 tabindex="-1" id="historyWorkTitle">单作品指标历史</h4><button type="button" class="link-btn" data-history-work-close>返回历史列表</button></div><p class="history-boundary">全部已保存采样日期；不继承作品列表的发布时间筛选。作品各项指标是保存的来源值，未逐条独立核验；播放也不称作已核实实际播放，— 表示缺测，不使用点赞估算。截止 ${esc(worksEvidenceTime(value.asOf))}（北京时间）。</p><div class="history-controls"><label>指标历史排序<select id="historyWorkSort">${historySortOptions('workMetrics').map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label><label>指标历史方向<select id="historyWorkOrder"><option value="desc">从高到低 / 从新到旧</option><option value="asc">从低到高 / 从旧到新</option></select></label></div>${historyPager(data, true, 'top')}${historyTable(data, { workHistory: true })}${historyPager(data, true)}`;
    $('historyWorkSort').value = work.sort; $('historyWorkOrder').value = work.order;
    $('historyWorkSort').onchange = () => { work.sort = $('historyWorkSort').value; void loadWorkHistory(workId); };
    $('historyWorkOrder').onchange = () => { work.order = $('historyWorkOrder').value; void loadWorkHistory(workId); };
    if (document.activeElement === active || (!active?.isConnected && document.activeElement === document.body)) {
      const buttons = [...document.querySelectorAll('[data-history-work-page]')].filter(button => (button.dataset.historyLocation || 'bottom') === focusLocation);
      const pageTarget = Number(pageFocus) > (prior?.data?.pagination.page || 1) ? buttons.at(-1) : buttons[0];
      const target = sortFocus ? document.querySelector(`[data-history-work-sort-key="${sortFocus}"]`) || $('historyWorkTitle') : pageFocus && pageTarget && !pageTarget.disabled ? pageTarget : ['historyWorkSort', 'historyWorkOrder'].includes(focusId) ? $(focusId) : $('historyWorkTitle');
      target.focus?.({ preventScroll: true });
      // A user-requested child panel lives after the work table. Bring its
      // heading into view only on first open, never on paging/sorting or after
      // the user has chosen a newer input. Instant movement adds no animation.
      if (initialOpen && target === $('historyWorkTitle')) target.scrollIntoView?.({ block: 'center', behavior: 'instant' });
    }
  } catch (error) {
    if (error.name !== 'AbortError' && historyIsCurrent(value) && value.work === work) panel.innerHTML = `<div class="notice error" role="alert">${esc(error.message)}</div><button type="button" class="secondary-btn" data-history-work="${workId}">重试此作品</button><button type="button" class="link-btn" data-history-work-close>返回历史列表</button>`;
  }
}
function historyCsv(data, items) {
  const works = data.kind === 'works';
  const fields = works ? ['id', 'caption', 'publishedAt', 'lastObservedAt', 'likes', 'comments', 'shares', 'collects', 'plays', 'url']
    : ['date', 'capturedAt', 'sourceChecksum', 'followers', 'followersDelta', 'likes', 'likesDelta', 'posts', 'postsDelta', 'estimatedPlays', 'estimatedPlaysDelta', ...['followers', 'likes', 'posts'].flatMap(key => [`${key}At`, `${key}Checksum`, `${key}BaselineAt`, `${key}BaselineChecksum`])];
  const names = works ? ['作品ID', '标题', '发布时间', '最近观测', '点赞', '评论', '分享', '收藏', '播放来源值（未独立核验）', '公开链接'] : ['业务日期', '当日最后记录时间UTC', '当日最后记录校验', '粉丝', '粉丝净变化', '获赞', '获赞净变化', '作品存量', '作品净变化', '估算播放（获赞×100非实际）', '估算播放净变化', ...['粉丝', '获赞', '作品存量'].flatMap(label => [`${label}观测时间UTC`, `${label}来源校验`, `${label}前日基准时间UTC`, `${label}基准校验`])];
  return '\ufeff' + [[...names, ...(works ? ['全部作品指标说明', '播放说明'] : []), '读取截止UTC', '筛选开始日期', '筛选结束日期', '因证据不足排除记录数（原始保留）'], ...items.map(item => [...fields.map(key => key === 'url' ? safeWorkUrl(item[key]) || '' : item[key] ?? ''), ...(works ? ['保存的来源值，未逐条独立核验', historyPlayCaption(item)] : []), data.asOf, data.range.startDate || '', data.range.endDate || '', data.coverage?.excludedCount ?? ''])].map(row => row.map(csvCell).join(',')).join('\r\n');
}
async function readAllHistoryPages(value, { signal, onPage = () => {} } = {}) {
  const expected = { ...value, page: 1 }, rows = [];
  let first = null;
  for (let page = 1; ; page++) {
    signal?.throwIfAborted?.();
    const data = validateAccountHistory(await api(historyQuery(expected, { page }), { signal }), expected, { page });
    if (!first) { first = data; expected.asOf = data.asOf; expected.revision = data.revision; }
    if (data.asOf !== first.asOf || data.pagination.total !== first.pagination.total || data.pagination.totalPages !== first.pagination.totalPages) throw new Error('导出期间记录范围改变，未下载不完整结果');
    rows.push(...data.items); onPage(page, data.pagination.totalPages);
    if (page >= data.pagination.totalPages) break;
  }
  if (rows.length !== first.pagination.total) throw new Error('导出条数与历史总数不一致，未下载');
  if (new Set(rows.map(item => item.id)).size !== rows.length) throw new Error('导出跨页记录重复，未下载不完整结果');
  return { data: first, rows, csv: historyCsv(first, rows) };
}
async function exportAccountHistory() {
  const value = accountHistory; if (!value || !historyIsCurrent(value) || !value.data || value.exporting || !value.asOf || value.loadedSignature !== historyQuery(value, { page: 1 })) return;
  value.exporting = true; const exportController = new AbortController(); value.exportController = exportController; $('historyExport').disabled = true;
  try {
    const result = await readAllHistoryPages(value, { signal: exportController.signal, onPage: (page, pages) => {
      if (historyIsCurrent(value) && value.exportController === exportController && !exportController.signal.aborted) $('historyStatus').textContent = `正在读取导出第 ${page} / ${pages || 1} 页；全部成功后才下载。`;
    } });
    if (!historyIsCurrent(value) || value.exportController !== exportController || exportController.signal.aborted) return;
    const url = URL.createObjectURL(new Blob([result.csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `账号${value.targetId}_${value.kind}_已保存历史.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    $('historyStatus').textContent = `已导出全部筛选结果 ${fmt(result.rows.length, true)} 条；截止时点与当前历史相同。`;
  } catch (error) {
    if (error.name !== 'AbortError' && historyIsCurrent(value) && value.exportController === exportController) $('historyStatus').textContent = `导出失败：${error.message}；未下载部分结果。`;
  } finally {
    if (historyIsCurrent(value) && value.exportController === exportController) { value.exporting = false; $('historyExport').disabled = value.loadedSignature !== historyQuery(value, { page: 1 }); }
  }
}
function detailTrendChart(account, metric) {
  const range = detailTrendRange || effectiveMetricRange();
  const comparisonData = detailTrendComparison;
  const { points, comparison } = buildTrendView({ period: 'custom', range: { startDate: range.start, endDate: range.end }, summary: { trend: account.trend },
    comparison: comparisonData ? { range: comparisonData.range, summary: { trend: comparisonData.account.trend } } : null }, { period: 'custom' });
  return readableChartMarkup('detail', JSON.stringify([account.id, range, comparisonData?.range, metric]), points, `${metric}Delta`, comparison, metric, { singleAccount: true });
}
function detailMetricReason(account, metric) {
  return account.metrics?.[metric]?.reason || '变化采用所选区间前一日基准和结束日采样；缺少端点时不计算。';
}
function detailTrendMarkup(account) {
  const range = detailTrendRange || effectiveMetricRange(), comparisonRange = detailTrendComparison?.range;
  const caption = comparisonRange ? `实线：A 本期 ${range.start} 至 ${range.end}；虚线：B 对比期 ${comparisonRange.startDate} 至 ${comparisonRange.endDate} · 按第 N 天对齐，缺采不补零。` : '逐日净变化 · 不是累计曲线；完整记录见下方逐日明细。';
  return `<section class="detail-trend" aria-label="账号每日净变化"><div class="metric-tabs" aria-label="详情趋势指标">${['followers','likes','posts'].map(key=>`<button type="button" data-detail-metric="${key}" aria-pressed="${key===detailTrendMetric}">${METRICS[key]}净变化</button>`).join('')}</div><h3 id="detailTrendTitle">${METRICS[detailTrendMetric]}每日净变化</h3><div class="detail-chart" id="detailTrendChart">${detailTrendChart(account, detailTrendMetric)}</div><p class="muted" id="detailTrendReason">所选区间${METRICS[detailTrendMetric]}口径：${esc(detailMetricReason(account, detailTrendMetric))}</p><p class="muted">${esc(caption)}</p></section>`;
}
function detailKpiMarkup(account, { recorded = false, comparison = null } = {}) {
  return `<div class="detail-kpis">${['followers', 'likes', 'posts'].map(key => {
    const metric = account.metrics[key], other = comparison?.account.metrics?.[key];
    const left = numeric(metric.delta), right = numeric(other?.delta);
    const difference = Number.isSafeInteger(left) && Number.isSafeInteger(right) && Number.isSafeInteger(left - right) ? left - right : null;
    return `<div class="detail-kpi"><small>${METRICS[key]}${comparison ? ' · A 本期' : ''} · 截至 ${dateTime(metric.currentAt)}</small><strong>${fmt(metric.value, true)}</strong><span>${comparison ? 'A 本期区间变化' : recorded ? '已记录变化' : '区间变化'} ${signed(metric.delta)}</span>${comparison ? `<p class="muted">B 对比期期末值 ${fmt(other?.value, true)} · 截至 ${dateTime(other?.currentAt)}<br>B 对比期区间变化 ${signed(other?.delta)}<br>A − B 净变化差 ${signed(difference)}</p><small>${esc(other?.reason || 'B 缺少端点时不计算变化；缺测不是零。')}</small>` : ''}</div>`;
  }).join('')}</div>`;
}
function detailDailyTable(account, range, label = '') {
  return `<details open><summary>逐日变化明细${label ? ` · ${esc(label)}` : ''} · ${esc(range.start)} 至 ${esc(range.end)}</summary><div class="table-card"><table class="table"><thead><tr><th scope="col">日期</th><th scope="col">粉丝</th><th scope="col">粉丝净变化</th><th scope="col">获赞</th><th scope="col">获赞净变化</th><th scope="col">作品</th><th scope="col">作品净变化</th></tr></thead><tbody>${(account.trend || []).map(p => `<tr><td>${esc(p.date)}</td><td>${fmt(p.followers, true)}</td><td>${signed(p.followersDelta)}</td><td>${fmt(p.likes, true)}</td><td>${signed(p.likesDelta)}</td><td>${fmt(p.posts, true)}</td><td>${signed(p.postsDelta)}</td></tr>`).join('')}</tbody></table></div></details>`;
}
function changeDetailTrend(metric) {
  if (!['followers','likes','posts'].includes(metric) || !detailTrendAccount || detailTrendAccount.id !== state.detailId || !$('accountDialog').open || drawerClosing) return;
  detailTrendMetric = metric;
  $('detailTrendChart').innerHTML = detailTrendChart(detailTrendAccount, metric);
  $('detailTrendTitle').textContent = `${METRICS[metric]}每日净变化`;
  $('detailTrendReason').textContent = `所选区间${METRICS[metric]}口径：${detailMetricReason(detailTrendAccount, metric)}`;
  document.querySelectorAll('[data-detail-metric]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.detailMetric===metric)));
}
function accountDetailHistory(value = typeof history === 'undefined' ? null : history.state) {
  const entry = value?.[DETAIL_HISTORY_KEY];
  return entry?.owner === detailHistoryOwner && Number.isSafeInteger(entry.id) && entry.id > 0
    && entry.base === location.href ? entry : null;
}
function rememberAccountDetailHistory(id, { fromHistory = false } = {}) {
  if (fromHistory || typeof history === 'undefined' || typeof history.pushState !== 'function') return;
  const current = accountDetailHistory();
  if (current) {
    history.replaceState({ ...history.state, [DETAIL_HISTORY_KEY]: { ...current, id } }, '', location.href);
    return;
  }
  const entry = { owner: detailHistoryOwner, sequence: ++detailHistorySequence, id,
    base: location.href, parentBase: location.href };
  detailHistoryContext = { ...entry, position: captureReadingPosition() };
  history.pushState({ ...history.state, [DETAIL_HISTORY_KEY]: entry }, '', location.href);
}
async function openAccount(id, { fromHistory = false } = {}) {
  // A newer explicit account selection supersedes the closing animation too;
  // do not silently drop a fast switch to another author.
  if (drawerClosing) cancelAccountClose();
  cancelAccountHistory(); const request = ++detailRequest;
  detailTrendAccount = null;
  const requestedMetric = document.activeElement?.closest?.('[data-account-metric]')?.dataset.accountMetric;
  const investigationMetric = getWorkflowMetric(requestedMetric, state.view === 'overview' ? state.workflowMetric : getWorkflowMetric(state.sort, state.metric));
  detailTrendMetric = investigationMetric === 'estimatedPlays' ? 'likes' : investigationMetric;
  chartReadings.delete('detail'); detailTrendRange = null; detailTrendComparison = null;
  state.detailId = id; detailController?.abort(); detailController = new AbortController();
  const dialog = $('accountDialog');
  rememberAccountDetailHistory(id, { fromHistory });
  if (!dialog.open) { detailTrigger = document.activeElement; detailTriggerId = id; dialog.showModal(); }
  $('dialogName').textContent = state.data.accounts.find(a => a.id === id)?.label || '账号详情';
  $('dialogMeta').textContent = '正在读取所选日期的历史记录';
  $('dialogBody').setAttribute?.('aria-busy', 'true');
  $('dialogBody').innerHTML = loadingMarkup('读取该账号的历史记录…');
  try {
    const appliedData = state.data, detailRange = effectiveMetricRange(); const recorded = appliedData?.activeRecordedWindow;
    const comparisonRange = appliedData?.comparison?.range;
    const p = new URLSearchParams({ period: 'custom', startDate: detailRange.start, endDate: detailRange.end });
    if (comparisonRange) { p.set('comparisonStartDate', comparisonRange.startDate); p.set('comparisonEndDate', comparisonRange.endDate); }
    const data = await api(`/api/rebuild/accounts/${id}/insights?${p}`, { signal: detailController.signal });
    if (state.detailId !== id || !dialog.open || request !== detailRequest) return;
    if (!data.account) throw new Error('账号不存在');
    if (comparisonRange && (data.comparison?.account?.id !== id || data.comparison.range?.startDate !== comparisonRange.startDate || data.comparison.range?.endDate !== comparisonRange.endDate)) throw new Error('账号对比记录缺失或与已应用日期不一致，请重新读取。');
    const projected = recorded && appliedData.accounts.find(account => account.id === id);
    const a = projected ? { ...data.account, metrics: projected.metrics } : data.account;
    data.account = a;
    detailTrendAccount = a;
    detailTrendRange = detailRange;
    detailTrendComparison = comparisonRange ? data.comparison : null;
    $('dialogMeta').textContent = `${platformNames[a.platform] || a.platform} · ${a.publicId || a.submittedAccountId || '暂无账号ID'} · ${a.boards.map(b => b.name).join(' / ') || '未分板块'}`;
    $('dialogBody').innerHTML = `${recorded ? `<p class="recorded-window-notice">${esc(recordedWindowCaption(appliedData))}</p>` : ''}${comparisonRange ? `<p class="muted">A 本期 ${esc(detailRange.start)} 至 ${esc(detailRange.end)} · B 对比期 ${esc(comparisonRange.startDate)} 至 ${esc(comparisonRange.endDate)}。期末值与区间净变化分别展示，缺测不补零。</p>` : ''}${detailKpiMarkup(a, { recorded, comparison: detailTrendComparison })}${investigationMetric === 'estimatedPlays' ? '<p class="muted">你正在查看估算播放对应的获赞变化：下方先显示获赞原始曲线，估算播放为获赞净变化 × 100，非平台实际播放量。</p>' : ''}${detailTrendMarkup(a)}${accountHistoryShell()}${renderWorksEvidence(data, detailRange)}${detailDailyTable(a, detailRange, comparisonRange ? 'A 本期' : '')}${detailTrendComparison ? detailDailyTable(detailTrendComparison.account, { start: comparisonRange.startDate, end: comparisonRange.endDate }, 'B 对比期') : ''}<p class="muted">粉丝区间变化口径：${esc(a.metrics.followers.reason || '变化采用所选区间前一日基准和结束日采样；缺少端点时不计算。')}</p>${a.profileUrl ? `<a class="link-btn" href="${esc(a.profileUrl)}" target="_blank" rel="noreferrer noopener">查看公开主页 ↗</a>` : ''}`;
  } catch (error) { if (error.name !== 'AbortError' && state.detailId === id && dialog.open && request === detailRequest) $('dialogBody').innerHTML = `<div class="notice error" role="alert">${esc(error.message)} <button type="button" class="link-btn" data-retry-account>重新读取</button></div>`; }
  finally { if (state.detailId === id && request === detailRequest) $('dialogBody').setAttribute?.('aria-busy', 'false'); }
}
function restoreAccountFocus() {
  detailTrendAccount = null;
  chartReadings.delete('detail'); detailTrendRange = null; detailTrendComparison = null;
  cancelAccountHistory(); detailRequest++;
  detailController?.abort(); state.detailId = null; drawerClosing = false;
  const trigger = detailTrigger?.isConnected ? detailTrigger
    : document.querySelector(`[data-view-panel]:not([hidden]) [data-account-id="${detailTriggerId}"]`) || $('pageTitle');
  trigger?.focus?.({ preventScroll: true });
  detailTrigger = null; detailTriggerId = null;
}
function cancelAccountClose() {
  // Browser traversal is newer intent than an outstanding X/Escape animation.
  // Invalidate its continuation even if an animation ignores cancellation.
  detailRequest++; drawerClosing = false;
  const animation = detailCloseAnimation; detailCloseAnimation = null;
  animation?.cancel?.();
}
async function closeAccount({ fromHistory = false, instant = false, restorePosition = true } = {}) {
  const dialog = $('accountDialog');
  if (!dialog.open) return;
  if (drawerClosing) {
    if (!fromHistory || !instant) return;
    cancelAccountClose();
  }
  const entry = accountDetailHistory();
  drawerClosing = true; detailController?.abort(); state.detailId = null;
  cancelAccountHistory(); const closeRequest = ++detailRequest;
  if (!instant && !reducedMotion() && dialog.animate) {
    const animation = dialog.animate([{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(32px)', opacity: 0 }], { duration: 160, easing: 'ease-in' });
    detailCloseAnimation = animation;
    try { await animation.finished; }
    catch { /* A cancelled animation must never prevent closing. */ }
    finally { if (detailCloseAnimation === animation) detailCloseAnimation = null; }
  }
  if (closeRequest !== detailRequest) return;
  dialog.close();
  restoreAccountFocus();
  if (restorePosition && detailHistoryContext?.base === location.href) restoreReadingPosition(detailHistoryContext.position);
  // Only consume the modal record we created in this page lifetime. A direct
  // close or a reload with foreign history state must never leave the product.
  if (!fromHistory && entry && accountDetailHistory()?.sequence === entry.sequence) {
    const navigationRequest = detailRequest;
    const traversal = { owner: entry.owner, sequence: entry.sequence, parentBase: entry.parentBase || entry.base,
      request: navigationRequest, dispatched: false, view: null };
    pendingModalCloseTraversal = traversal;
    queueMicrotask(() => {
      if (navigationRequest !== detailRequest || dialog.open || accountDetailHistory()?.sequence !== entry.sequence) {
        if (pendingModalCloseTraversal === traversal) pendingModalCloseTraversal = null;
        return;
      }
      if (typeof history.back === 'function') {
        traversal.dispatched = true;
        history.back();
      }
      else {
        if (pendingModalCloseTraversal === traversal) pendingModalCloseTraversal = null;
        const next = { ...history.state }; delete next[DETAIL_HISTORY_KEY];
        history.replaceState(next, '', location.href);
        if (traversal.view) setView(traversal.view.view, { renderData: traversal.view.renderData });
      }
    });
  }
}
function renderTopicsData(data, rangeOverride = null) {
  const range = rangeOverride || appliedRange();
  const start = data.startDate || range.start, end = data.endDate || range.end;
  const firstDay = Date.parse(`${start}T00:00:00Z`), lastDay = Date.parse(`${end}T00:00:00Z`);
  const expectedDays = Number.isFinite(firstDay) && Number.isFinite(lastDay) && lastDay >= firstDay
    ? Math.floor((lastDay - firstDay) / 86400000) + 1 : 0;
  $('topicsGrid').innerHTML = (data.topics || []).map(t => {
    const points = t.points.filter(p => p.date >= start && p.date <= end).sort((a, b) => a.date.localeCompare(b.date));
    const metric = (key, label) => {
      const validValue = value => numeric(value) !== null && numeric(value) >= 0;
      const trusted = p => p.sourceVerified === true && p.qualityStatus !== 'rejected' && p.qualityStatus !== 'unverified';
      const observedDays = new Set(points.filter(p => trusted(p) && validValue(p[key])).map(p => p.date)).size;
      const coverage = expectedDays ? `${observedDays}/${expectedDays} 天有有效观测` : '所选范围无有效日期';
      const last = [...points].reverse().find(p => trusted(p) && validValue(p[key]));
      const known = t.latestKnown?.[key];
      // Extra history is evidence only: it never fills a missing day in the
      // returned daily series or turns an older observation into today's.
      const knownValid = known && /^\d{4}-\d{2}-\d{2}$/.test(known.date)
        && known.date <= end && validValue(known.value) && known.sourceVerified === true
        && known.qualityStatus !== 'rejected' && known.qualityStatus !== 'unverified';
      const point = last && (!knownValid || last.date >= known.date) ? {
        ...last, value: last[key], delta: last[`${key}Delta`],
      } : knownValid ? known : null;
      if (!point) return `<div class="topic-stat topic-stat-missing"><small>${label}</small><small class="topic-observation">区间覆盖 ${coverage}</small><strong>—</strong><span class="topic-missing">截至 ${esc(end)} 尚无有效观测</span></div>`;
      const historical = point.date !== end;
      const adjacent = point.baselineDate === shiftDate(point.date, -1);
      const delta = adjacent ? numeric(point.delta) : null;
      const change = delta === null ? '变化 — · 缺少前一日可比采样'
        : `${esc(point.date)} 较 ${esc(point.baselineDate)} ${signed(delta)}`;
      const samplingTime = point.capturedAt && Number.isFinite(Date.parse(point.capturedAt))
        ? `${point.date} ${dateTime(point.capturedAt).split(' ').at(-1)}（北京时间）` : point.date;
      const qualityNotice = point.qualityStatus === 'warning' ? '<small class="topic-quality-warning">需留意 · 采样质量警告</small>' : '';
      return `<div class="topic-stat${historical ? ' topic-stat-historical' : ''}"><small>${label}</small><small class="topic-observation">区间覆盖 ${coverage}</small><strong title="${esc(fmt(point.value, true))}">${fmt(point.value)}</strong><small class="topic-observation">${historical ? '最近有效观测' : '观测日期'} ${esc(samplingTime)}</small>${qualityNotice}<div class="topic-change">${change}</div>${historical ? `<small class="topic-missing">所选末日 ${esc(end)} 该指标暂无有效值，当前显示历史观测</small>` : ''}</div>`;
    };
    const historyRow = p => {
      const rejected = p.qualityStatus === 'rejected';
      const hasStoredObservation = Boolean(p.capturedAt || p.snapshotId);
      const unverified = !rejected && (p.sourceVerified === false || p.qualityStatus === 'unverified'
        || (hasStoredObservation && p.sourceVerified !== true));
      const status = rejected ? '<span class="topic-history-rejected" title="此观测未计入上方汇总">已排除</span><small>质量校验未通过</small>'
        : unverified ? '<span class="topic-history-unverified" title="缺少与平台话题、采集任务和审查记录匹配的来源证据；该行已从真实指标中排除">来源未核验 · 已排除</span>'
        : p.qualityStatus === 'validated' ? '有效'
          : p.qualityStatus === 'warning' ? '需留意'
            : p.qualityStatus === 'missing' ? '缺测' : '未标记';
      // Preserve the raw observation in storage, but never present a rejected
      // counter/delta as ordinary evidence in the operator-facing daily table.
      const excluded = rejected || unverified;
      const participants = excluded ? '—' : fmt(p.participants);
      const participantsDelta = excluded ? '—' : signed(p.participantsDelta);
      const views = excluded ? '—' : fmt(p.views);
      const viewsDelta = excluded ? '—' : signed(p.viewsDelta);
      return `<tr${rejected ? ' class="topic-history-row-rejected"' : unverified ? ' class="topic-history-row-unverified"' : ''}><td>${esc(p.date)}</td><td>${participants}</td><td>${participantsDelta}</td><td>${views}</td><td>${viewsDelta}</td><td>${status}</td></tr>`;
    };
    const status = t.enabled === false ? '<span class="topic-status topic-status-paused">已暂停，不参与每日更新</span>' : '';
    return `<article class="topic-card"><div class="topic-card-heading"><h3>${esc(t.label)}</h3>${status}</div><div class="topic-stats">${metric('participants', '参与人数')}${metric('views', '累计实际播放量')}</div><p class="muted">变化仅比较标注日期与前一日采样，不代表整月或整周增量；缺测不补零。话题播放为平台累计值，非矩阵区间新增估算。</p><details><summary>每日记录</summary><div class="table-card"><table class="table"><thead><tr><th>日期</th><th>参与人数</th><th>变化</th><th>播放量</th><th>变化</th><th>质量状态</th></tr></thead><tbody>${points.map(historyRow).join('')}</tbody></table></div></details></article>`;
  }).join('') || '<div class="empty">没有已录入的话题。</div>';
  topicSnapshot = { start, end, html: $('topicsGrid').innerHTML };
  topicReadFailed = false;
}
function retainedTopicsMarkup() {
  return topicSnapshot ? `<div class="notice">保留上次成功话题快照：${esc(topicSnapshot.start)} 至 ${esc(topicSnapshot.end)}；不代表本次所选范围已读取。各指标观察时间见下方。</div>${topicSnapshot.html}` : '';
}
async function loadTopics({ rangeOverride = null, ownerRequestId = state.requestId } = {}) {
  topicController?.abort();
  const requestController = new AbortController(); topicController = requestController;
  const id = ++topicRequest;
  const range = rangeOverride || appliedRange();
  topicReadContext = { id, ownerRequestId, range: { ...range } };
  const current = () => id === topicRequest && ownerRequestId === state.requestId && state.view === 'topics';
  $('topicsGrid').setAttribute?.('aria-busy', 'true');
  $('topicsGrid').innerHTML = loadingMarkup('读取话题每日快照…') + retainedTopicsMarkup();
  try {
    const query = new URLSearchParams({ startDate: range.start, endDate: range.end });
    const data = validateTopics(await api(`/api/topics/history?${query}`, { signal: requestController.signal }));
    if (!current()) return;
    if ((data.startDate && data.startDate !== range.start) || (data.endDate && data.endDate !== range.end)) throw new Error('话题响应日期与请求范围不一致，未采用本次记录');
    renderTopicsData(data, range);
  } catch (error) {
    if (!current()) return;
    topicReadFailed = true;
    $('topicsGrid').innerHTML = `<div class="notice error">话题 ${esc(range.start)} 至 ${esc(range.end)} 读取失败：${esc(error.message)} <button class="link-btn" data-retry-topics>重试</button></div>${retainedTopicsMarkup()}`;
  } finally {
    if (topicController === requestController) topicController = null;
    if (current()) {
      $('topicsGrid').setAttribute?.('aria-busy', 'false');
      // A topic retry must not hide a separate failure to read account data.
      if (!state.busy && state.view === 'topics') busy(false, $('connectionStatus').getAttribute?.('data-state') === 'error' ? 'error' : 'success');
    }
  }
}

function setView(view, { renderData = true, fromHistory = false } = {}) {
  const aliases = { targets: 'accounts', boards: 'accounts', reports: 'overview', updates: 'import', audit: 'overview' };
  view = aliases[view] || view;
  if (!['overview', 'accounts', 'topics', 'import'].includes(view)) view = 'overview';
  // A dispatched history traversal cannot be cancelled. Keep the latest
  // explicit destination until our modal Back is consumed, rather than let
  // its late popstate undo a view/URL that has already been rendered.
  if (!fromHistory && pendingModalCloseTraversal) {
    pendingModalCloseTraversal.view = { view, renderData, request: detailRequest };
    return;
  }
  const previousView = state.view;
  if (view !== 'topics' && state.view === 'topics') {
    topicController?.abort(); topicController = null; topicRequest++;
    topicReadContext = null;
    $('topicsGrid').setAttribute?.('aria-busy', 'false');
  }
  state.view = view;
  syncImportMonitoring();
  if (view === 'import' && previousView !== 'import') {
    insightsNeedRead = true;
    liveSync?.invalidate();
    if (state.busy || pendingInsightsRead) {
      controller?.abort(); controller = null; state.requestId++; pendingInsightsRead = null;
      busy(false);
    }
  }
  document.querySelectorAll('[data-view-panel]').forEach(el => el.hidden = el.id !== `${view}View`);
  document.querySelectorAll('.nav-item').forEach(el => { el.classList.toggle('active', el.dataset.view === view); el.setAttribute('aria-current', el.dataset.view === view ? 'page' : 'false'); });
  $('pageTitle').textContent = ({ overview: presentationControls().period === 'day' ? '今天的矩阵' : '矩阵经营总览', accounts: '账号台账', topics: '话题观察', import: '导入作者名单' })[view];
  renderScopeSubtitle();
  document.querySelector('.date-controls').hidden = view === 'import';
  $('compareControls').hidden = view === 'import' || view === 'topics';
  $('appliedScopeBar').hidden = view === 'import';
  $('filterDetails').hidden = view === 'import';
  if ($('primaryScope')) $('primaryScope').hidden = view === 'import' || view === 'topics';
  $('rangeEvidence').hidden = view === 'import';
  if ($('recordedWindowNotice')) {
    const caption = recordedWindowCaption(state.data) || missingRecordedWindowCaption(state.data);
    $('recordedWindowNotice').textContent = caption;
    $('recordedWindowNotice').hidden = !caption || ['topics', 'import'].includes(view);
  }
  if (view === 'topics' && (previousView !== 'topics' || state.data)) {
    const pendingRange = pendingInsightsRead?.ownerRequestId === state.requestId ? pendingInsightsRead.range : null;
    void loadTopics({ rangeOverride: pendingRange, ownerRequestId: state.requestId });
  }
  renderAppliedScope();
  if (view === 'accounts') {
    if (renderData) renderAccounts();
    syncAccountMode();
  }
  if (view === 'import' && previousView !== 'import' && canEdit()) void loadRecentImportJobs({ automatic: true });
  if (previousView !== view && renderData) $('pageTitle')?.scrollIntoView?.({ block: 'start', behavior: 'instant' });
  liveSync?.flush();
  saveLocation();
  if (renderData && view === 'import' && previousView !== 'import') void loadImportWorkspace();
  else if (renderData && view !== 'import' && insightsNeedRead && !state.busy) {
    void load({ scopeOnly: !navigationRangePending && Boolean(appliedContext) });
  }
}
document.addEventListener?.('mcn:open-account', event => {
  const id = Number(event.detail?.id);
  if (Number.isSafeInteger(id) && id > 0) void openAccount(id);
});
document.addEventListener?.('mcn:import-monitoring-supplement', event => {
  const detail = event.detail;
  if (!canEdit() || state.view !== 'import' || currentImportJob?.status !== 'completed'
    || detail?.jobId !== currentImportJob.id || typeof detail.entryKey !== 'string' || !detail.entryKey || detail.entryKey.length > 500
    || !['douyin','bilibili','xiaohongshu'].includes(detail.platform) || typeof detail.submittedId !== 'string'
    || !detail.submittedId || detail.submittedId.length > 180) return;
  setView('accounts');
  document.dispatchEvent(new CustomEvent('mcn:master-roster-open', { detail: {
    query:detail.submittedId,theme:'all',entryKey:detail.entryKey,platform:detail.platform,submittedId:detail.submittedId,
  } }));
});
document.addEventListener?.('mcn:master-roster-loaded', event => {
  if (!Array.isArray(event.detail?.items)) return;
  const next = new Map();
  for (const item of event.detail.items) {
    if (!Number.isSafeInteger(item?.targetId) || item.targetId <= 0) continue;
    const values = [item.name, ...(Array.isArray(item.originalNames) ? item.originalNames : []), ...(Array.isArray(item.accountIds) ? item.accountIds : [])]
      .filter(value => typeof value === 'string').map(value => value.slice(0, 240));
    next.set(item.targetId, [...new Set([...(next.get(item.targetId) || []), ...values])]);
  }
  const signature = JSON.stringify([...next]);
  if (signature === rosterSearchSignature) return;
  rosterSearchSignature = signature; rosterSearchAliases = next;
  if (state.view === 'accounts' && state.data && state.query.trim()) renderAccounts();
});
function downloadCsv() {
  if (!state.data) return;
  const range = effectiveMetricRange(), requested = appliedRange(), recorded = state.data.activeRecordedWindow;
  const names = ['账号', '平台', '账号ID', '大主题', '内容分类', '粉丝数', '粉丝净变化', '获赞数', '获赞净变化', '估算播放变化(获赞净变化×100)', '作品数', '作品净变化', '最近采样', '开始日期', '结束日期', '变化口径', '采样基准日期', '所选开始日期', '所选结束日期'];
  const matrix = rows().map(a => [a.label, platformNames[a.platform], a.publicId || a.submittedAccountId, a.classification?.theme?.label || '待归属', (a.classification?.labels || []).map(item => item.label).join('；'), a.metrics.followers.value, periodDelta(a.metrics.followers, state.data.period), a.metrics.likes.value, periodDelta(a.metrics.likes, state.data.period), periodDelta(a.metrics.estimatedPlays, state.data.period), a.metrics.posts.value, periodDelta(a.metrics.posts, state.data.period), a.status.lastSuccessAt, range.start, range.end, recorded ? '已记录时段净变化（非完整所选区间）' : '所选区间净变化', recorded?.baselineDate || shiftDate(range.start, -1), requested.start, requested.end]);
  const blob = new Blob(['\ufeff', [names, ...matrix].map(row => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `矩阵数据_${range.start}_${range.end}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function canEdit() { return ['admin', 'editor'].includes(state.session?.user?.role); }
function bindMasterRosterSession() {
  document.dispatchEvent?.(new CustomEvent('mcn:master-roster-bind', { detail: { api, canEdit } }));
}
document.addEventListener?.('mcn:master-roster-ready', bindMasterRosterSession);
const importCount = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? fmt(value, true) : '—';
const importTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? dateTime(value) : '时间未提供';
function importedIdentityKeyFromRow(row = {}) {
  const platform = ['douyin', 'bilibili', 'xiaohongshu'].includes(row.platform)
    ? row.platform
    : row.bilibiliId ? 'bilibili' : row.xiaohongshuId ? 'xiaohongshu' : row.platform ? null : 'douyin';
  if (!platform) return null;
  const textId = value => typeof value === 'string' ? value.normalize('NFKC').trim() : '';
  const locator = textId(row.locator);
  let accountId = '';
  if (platform === 'douyin') {
    if (/^MS4wLj[\w-]{12,220}$/.test(locator)) accountId = `secuid:${locator}`;
    else {
      const submittedId = textId(row.douyinId);
      if (/^[A-Za-z0-9._-]{1,64}$/.test(submittedId)) accountId = `id:${submittedId.toLowerCase()}`;
    }
  } else if (platform === 'bilibili') {
    const value = /^\d{2,20}$/.test(locator) ? locator : textId(row.bilibiliId);
    if (/^\d{2,20}$/.test(value)) accountId = `uid:${value}`;
  } else {
    let profileId = '';
    try {
      const url = new URL(locator);
      if (['https://www.xiaohongshu.com', 'https://xiaohongshu.com'].includes(url.origin)) {
        profileId = url.pathname.match(/^\/user\/profile\/([0-9a-z]{16,40})\/?$/i)?.[1] || '';
      }
    } catch {}
    const value = profileId || textId(row.xiaohongshuId);
    if (/^[0-9a-z]{16,40}$/i.test(value)) accountId = `uid:${value.toLowerCase()}`;
  }
  return accountId ? `${platform}:${accountId}` : null;
}
function importIdentityFallback(rows) {
  const keys = new Set();
  let unresolvedRows = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const hasAuthorEvidence = ['name', 'locator', 'douyinId', 'bilibiliId', 'xiaohongshuId', 'videoId', 'shareUrl']
      .some(key => typeof row[key] === 'string' && row[key].trim());
    if (!hasAuthorEvidence) continue;
    const key = importedIdentityKeyFromRow(row);
    if (key) keys.add(key);
    else unresolvedRows++;
  }
  return { known: keys.size, unresolvedRows };
}
function importPreviewIdentityCaption(summary, rows, { totalRows = Array.isArray(rows) ? rows.length : 0 } = {}) {
  const fallback = importIdentityFallback(rows);
  const sampleCount = Array.isArray(rows) ? rows.length : 0;
  const fullCount = Number.isSafeInteger(totalRows) && totalRows >= sampleCount ? totalRows : sampleCount;
  const sampleOnly = fullCount > sampleCount;
  const hasV2Summary = summary?.identityCountVersion === 2
    && Number.isSafeInteger(summary.knownUniqueAuthors) && summary.knownUniqueAuthors >= 0
    && Number.isSafeInteger(summary.unresolvedIdentityRows) && summary.unresolvedIdentityRows >= 0
    && summary.knownUniqueAuthors + summary.unresolvedIdentityRows <= fullCount
    && (summary.totalRows === undefined || summary.totalRows === fullCount)
    && (summary.unresolvedIdentityRows > 0
      ? summary.uniqueAuthors === null
      : summary.uniqueAuthors === summary.knownUniqueAuthors);
  if (!hasV2Summary) {
    const clueCount = importCount(fallback.known), pendingCount = importCount(fallback.unresolvedRows);
    const scope = `${summary?.identityCountVersion === 2 ? '统计摘要待核对' : '旧版服务摘要'}${sampleOnly ? ` · 仅样例前 ${sampleCount} 行（非全表统计）` : ''}`;
    return fallback.unresolvedRows > 0
      ? `${scope} · ${clueCount} 位主页/平台账号 ID 线索 · ${pendingCount} 行身份待核验；昵称与作品不计为账号身份`
      : `${scope} · ${clueCount} 位主页/平台账号 ID 线索（尚未核验公开归属）`;
  }
  const knownCount = importCount(summary.knownUniqueAuthors);
  return summary.unresolvedIdentityRows > 0
    ? `${knownCount} 位主页/平台账号 ID 线索 · ${importCount(summary.unresolvedIdentityRows)} 行身份待核验；昵称与作品不计为账号身份`
    : `可按账号身份去重 ${importCount(summary.uniqueAuthors)} 位作者`;
}
function importIdentityCaption(identity = {}, inputIdentity = null) {
  const queueCount = importCount(identity.knownDistinctSubmittedIdentityCount);
  const totalCount = importCount(inputIdentity?.knownDistinctSubmittedIdentityCount ?? inputIdentity?.distinctAccountCount);
  const subset = totalCount !== '—' ? `；这是全部 ${totalCount} 个明确提交身份中的证据队列子集` : '';
  return `证据队列覆盖身份：已知提交标识 ${queueCount} 个（按平台与提交 ID 去重，未证明所有权${subset}）；${importCount(identity.unknownIdentityItemCount)} 项缺少唯一身份，其中冲突 ${importCount(identity.ambiguousIdentityItemCount)} 项；队列内可完整计数身份 ${importCount(identity.distinctAccountCount)}。`;
}
function importRowReviewMarkup(row = {}) {
  const status = typeof row.status === 'string' ? row.status : '';
  const labels = { needs_locator: '待补充账号身份', identity_conflict: '身份信息冲突', existing: '已有账号', ready: '身份线索齐全（非已核验）', resolvable: '待识别账号', duplicate: '表内重复', unresolved: '暂未确认', skipped: '暂不接入' };
  const label = Object.hasOwn(labels, status) ? labels[status] : '状态待确认';
  const reasons = [...new Set([row.reason, ...(Array.isArray(row.issues) ? row.issues : []), ...(Array.isArray(row.warnings) ? row.warnings : [])].filter(value => typeof value === 'string' && value.trim()))];
  return `<span title="${esc(`原始状态：${status || '未提供'}`)}">${label}</span>${reasons.length ? `<small>${esc(reasons.join('；'))}</small>` : ''}`;
}
const importProblemStatuses = new Set(['identity_conflict', 'needs_locator', 'skipped', 'duplicate']);
function importSummaryCount(summary, key) {
  const value = summary?.[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function importProblemTotal(summary = {}) {
  const counts = ['identityConflictRows', 'needsLocatorRows', 'skippedRows', 'duplicateRows'].map(key => importSummaryCount(summary, key));
  return counts.every(value => value !== null) ? counts.reduce((total, value) => total + value, 0) : null;
}
function importProblemProjection(preview = {}, fallbackRows = []) {
  const provided = Array.isArray(preview.problemRows) ? preview.problemRows : null;
  const rows = (provided || (Array.isArray(fallbackRows) ? fallbackRows.filter(row => importProblemStatuses.has(row?.status)) : [])).slice(0, 100);
  const exact = importSummaryCount(preview, 'problemRowCount') ?? importProblemTotal(preview.summary);
  const total = exact === null ? rows.length : Math.max(exact, rows.length);
  return { rows, total, truncated: Math.max(0, total - rows.length) };
}
function importPreviewStatusMarkup(summary = {}) {
  const ready = importSummaryCount(summary, 'importableRows');
  const resolvable = importSummaryCount(summary, 'resolvableRows');
  const processable = ready === null || resolvable === null ? null : ready + resolvable;
  const items = [
    ['可送处理', processable],
    ['待补身份', importSummaryCount(summary, 'needsLocatorRows')],
    ['身份冲突', importSummaryCount(summary, 'identityConflictRows')],
    ['表内重复', importSummaryCount(summary, 'duplicateRows')],
    ['暂不接入', importSummaryCount(summary, 'skippedRows')],
    ['已有记录', importSummaryCount(summary, 'existingRows')],
  ];
  return `<dl class="import-preview-status-grid" aria-label="全表预览状态">${items.map(([label, value]) => `<div><dt>${label}</dt><dd>${value === null ? '—' : importCount(value)}</dd></div>`).join('')}</dl>`;
}
function importPreviewTableMarkup(rows = []) {
  return `<div class="upload-preview-table" tabindex="0" role="region" aria-label="导入预览行，可横向滚动"><table class="table"><thead><tr><th>源行</th><th>作者</th><th>账号ID</th><th>表内板块</th><th>审查</th></tr></thead><tbody>${rows.map(row => `<tr><td>${esc(row.sourceRow)}</td><td>${esc(row.name || '未填写')}</td><td>${esc(row.douyinId || row.bilibiliId || row.xiaohongshuId || row.locator || row.submittedIdRaw || '待解析')}${row.submittedIdIssue ? '<small>格式异常，不计入账号去重</small>' : ''}</td><td>${esc(row.board || '空白，将用下方设置')}</td><td>${importRowReviewMarkup(row)}</td></tr>`).join('')}</tbody></table></div>`;
}
function importProblemRowsMarkup(projection) {
  if (!projection.total) return '<p class="import-problem-clear">未发现身份冲突、缺身份、跳过或表内重复行；仍需核对板块和作者资料后再提交。</p>';
  const shown = projection.rows.length;
  return `<section class="import-problem-panel" aria-label="提交前问题定位"><div class="import-problem-head"><div><p class="eyebrow">REVIEW FIRST</p><h4>提交前问题定位</h4></div><p>已定位 ${importCount(shown)} / ${importCount(projection.total)} 行${projection.truncated ? `，另有 ${importCount(projection.truncated)} 行未展开` : ''}</p></div>${shown ? importPreviewTableMarkup(projection.rows) : '<p class="muted">当前服务提供了全表问题计数，但未返回可定位行；请更新服务后重新预览，不要把前 50 行样例当作全表无问题。</p>'}</section>`;
}
function importNoActionableMarkup(summary = {}) {
  return importSummaryCount(summary, 'autoMonitorAuthors') === 0
    ? '<p class="import-no-actionable" role="note">本次不会新增可监控账号；仍可保存来源审查或既有账号关系资料，但不要把任务提交当作监控接入成功。</p>'
    : '';
}
function importOutcomeDetails(result = {}, job = {}) {
  const hasCount = (...values) => values.some(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
  const identity = result.queuedAccountIdentitySummary || {}, resolution = result.resolution || {};
  const hasIdentity = hasCount(identity.knownDistinctSubmittedIdentityCount, identity.unknownIdentityItemCount, identity.ambiguousIdentityItemCount, identity.distinctAccountCount);
  const hasEvidence = hasCount(result.submittedEvidenceRequestCount, result.evidenceReusedEvidenceRequestCount, result.alreadyResolvedEvidenceRequestCount, result.verifiedExistingEvidenceRequestCount);
  const hasNetwork = hasCount(resolution.deferredEvidenceRequestCount, resolution.fetchFailedEvidenceRequestCount);
  if (!hasIdentity && !hasEvidence && !hasNetwork) return '<p class="import-unit-note">此历史任务未记录提交标识去重、证据状态和网络阶段统计，无法补算。</p>';
  const missing = [!hasIdentity && '提交标识去重', !hasEvidence && '证据状态', !hasNetwork && '网络阶段'].filter(Boolean);
  return [
    hasIdentity && `<p class="import-unit-note">${importIdentityCaption(identity, job.inputAccountIdentitySummary)}</p>`,
    hasEvidence && `<p class="import-unit-note">送交处理 ${importCount(result.submittedEvidenceRequestCount)} 项证据 · 复用历史核验凭证 ${importCount(result.evidenceReusedEvidenceRequestCount)} 项 · 已有成功请求 ${importCount(result.alreadyResolvedEvidenceRequestCount)} 项${hasCount(result.verifiedExistingEvidenceRequestCount) ? `，其中本次复核既有成功凭证 ${importCount(result.verifiedExistingEvidenceRequestCount)} 项` : ''}。历史凭证复用不是新采样；复核也不更新原验证时间。</p>`,
    hasNetwork && `<p class="import-unit-note">初阶段主动延后 ${importCount(resolution.deferredEvidenceRequestCount)} 项证据请求（未发起网络请求） · 返回抓取错误 ${importCount(resolution.fetchFailedEvidenceRequestCount)} 项证据请求。初阶段延后可能随后通过历史凭证解决，不是剩余队列。</p>`,
    missing.length && `<p class="import-unit-note">此任务未记录${missing.join('、')}统计，无法补算。</p>`,
  ].filter(Boolean).join('');
}
function importReceiptScopeMarkup(job = {}) {
  const identity = job.inputAccountIdentitySummary;
  if (!identity || typeof identity !== 'object') return '<p class="import-unit-note">此历史任务未记录原始行与去重提交身份，不能从证据请求数倒推作者人数。</p>';
  const rows = importCount(identity.inputItemCount);
  const known = importCount(identity.knownDistinctSubmittedIdentityCount);
  const unknown = importCount(identity.unknownIdentityItemCount);
  return `<section class="import-receipt-scope" aria-label="任务输入口径"><strong>本任务读取 ${rows} 行，识别 ${known} 个明确提交账号身份</strong><p>${unknown === '0' ? '所有输入行均有可计数的明确提交身份。' : `另有 ${unknown} 行缺少唯一身份或存在冲突，未冒充独立作者。`} 下方证据请求、审查记录和来源行都是处理工作量，不是作者人数。</p></section>`;
}
function importOutcomeMetrics(result = {}) {
  const items = [
    ['新建账号', result.createdCount, '个账号'], ['复用既有账号记录', result.reusedExistingCount, '行来源记录'],
    ['待核验证据', result.queuedEvidenceRequestCount, '项证据请求'], ['需审查记录', result.reviewRequiredCount, '项审查记录'],
  ];
  return `<dl class="import-outcome-grid">${items.map(([label, value, unit]) => `<div><dt>${label}</dt><dd>${importCount(value)}<small>${unit}</small></dd></div>`).join('')}</dl>`;
}
function importIdempotencyScope(uploadSha256, sheetName, defaultBoard) {
  const value = `${uploadSha256}\u0000${sheetName}\u0000${defaultBoard}`;
  let first = 2166136261, second = 2246822519;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619) >>> 0;
    second = Math.imul(second ^ (code + index), 3266489917) >>> 0;
  }
  return `${uploadSha256}:${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}
function newImportIdempotencyKey() {
  const generated = globalThis.crypto?.randomUUID?.();
  if (typeof generated === 'string' && /^[0-9a-f-]{36}$/i.test(generated)) return generated;
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const random = Math.floor(Math.random() * 16);
    return (char === 'x' ? random : (random & 3) | 8).toString(16);
  });
}
function readImportIdempotencyEntries() {
  try {
    const raw = globalThis.sessionStorage?.getItem(IMPORT_IDEMPOTENCY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function importIdempotencyKeyFor(scope) {
  const now = Date.now(), entries = readImportIdempotencyEntries();
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || !/^[0-9a-f-]{36}$/i.test(entry.key) || Number(entry.expiresAt) <= now) delete entries[key];
  }
  const existing = entries[scope] || importIdempotencyMemory.get(scope);
  if (existing?.key && Number(existing.expiresAt) > now) return existing.key;
  const entry = { key: newImportIdempotencyKey(), expiresAt: now + IMPORT_IDEMPOTENCY_TTL_MS };
  entries[scope] = entry; importIdempotencyMemory.set(scope, entry);
  try { globalThis.sessionStorage?.setItem(IMPORT_IDEMPOTENCY_STORAGE_KEY, JSON.stringify(entries)); } catch {}
  return entry.key;
}
function clearImportIdempotencyKey(scope, key) {
  importIdempotencyMemory.delete(scope);
  const entries = readImportIdempotencyEntries();
  if (entries[scope]?.key === key) {
    delete entries[scope];
    try { globalThis.sessionStorage?.setItem(IMPORT_IDEMPOTENCY_STORAGE_KEY, JSON.stringify(entries)); } catch {}
  }
}
function syncImportMonitoring(job = currentImportJob) {
  if (typeof CustomEvent === 'function') document.dispatchEvent?.(new CustomEvent('mcn:import-monitoring', {
    detail: { job, api, canRead: () => Boolean(state.session?.authenticated && canEdit()),
      isVisible: () => state.view === 'import' && !document.hidden },
  }));
}
function renderImportJob(job) {
  const panel = $('importJobResult'), result = job?.result && typeof job.result === 'object' ? job.result : {};
  const statuses = { queued: '已提交 · 等待后台处理', running: '后台处理中', completed: '任务处理完成', failed: '任务处理失败' };
  const id = typeof job?.id === 'string' && /^[0-9a-f-]{36}$/i.test(job.id) ? job.id : null;
  panel.hidden = false;
  $('importJobHeading').textContent = statuses[job?.status] || '任务状态未确认';
  $('importJobMeta').textContent = `${job?.fileName || '已提交名单'}${id ? ` · 任务 ${id.slice(0, 8)}` : ''} · ${importTime(job?.finishedAt || job?.createdAt)}`;
  const completed = job?.status === 'completed', failed = job?.status === 'failed';
  $('importJobBody').innerHTML = completed
    ? `${importReceiptScopeMarkup(job)}${importOutcomeMetrics(result)}${importOutcomeDetails(result, job)}<p class="import-unit-note">这是任务完成时的历史结果，不是实时队列余额。来源行、证据请求和审查项不能直接相加，也不等于独立作者数。任务完成不代表首次采样完成；既有暂停账号不会因此开启。</p>${id ? `<a class="link-btn" href="/api/author-spreadsheet/jobs/${encodeURIComponent(id)}/skipped?format=csv">下载该任务完整审查清单 CSV</a>` : ''}`
    : failed ? `<p class="notice error">${esc(job?.error || '后台任务未完成，记录已保留。')}</p><p class="import-unit-note">检查结果只读取已有任务，不重复提交名单。</p>`
      : ['queued', 'running'].includes(job?.status) ? `${importReceiptScopeMarkup(job)}<p class="import-unit-note">名单已保存到后台；排队不是网络失败，也不表示作者已完成核验。停留导入页时随自动状态检查更新，也可检查处理结果，无需重复上传。</p>`
        : '<p class="import-unit-note">正在核对指定任务，尚未确认处理结果。只读取已有回执，不提交名单。</p>';
  $('checkImportJob').hidden = !id;
  if (typeof CustomEvent === 'function') document.dispatchEvent?.(new CustomEvent('mcn:import-review-job', { detail: { job, api, canRead: canEdit } }));
  syncImportMonitoring(job);
}
function renderAcceptedImportJobs() {
  $('importSessionJobs').hidden = !canEdit() && !acceptedImportJobs.size;
  const jobs = [...acceptedImportJobs.values()].sort((a, b) => b.order - a.order);
  const signature = JSON.stringify([currentImportJob?.id, jobs]);
  if (signature === acceptedImportJobsSignature) return;
  const list = $('importSessionJobList');
  const focusedId = list.contains?.(document.activeElement) ? document.activeElement?.dataset?.importJob : null;
  acceptedImportJobsSignature = signature;
  const statuses = { queued: '等待处理', running: '处理中', completed: '已完成', failed: '失败' };
  list.innerHTML = jobs
    .map(job => `<button type="button" class="secondary-btn" data-import-job="${esc(job.id)}" aria-pressed="${currentImportJob?.id === job.id}">${esc(job.fileName)}${job.sheetName ? ` · ${esc(job.sheetName)}` : ''} · ${importTime(job.createdAt)} · ${esc(job.id.slice(0, 8))} · ${statuses[job.status] || '待核对'}${job.uncertainCandidate ? ' · 文件/工作表/时间候选' : ''}</button>`).join('');
  if (focusedId && /^[0-9a-f-]{36}$/i.test(focusedId)) list.querySelector?.(`[data-import-job="${focusedId}"]`)?.focus?.({ preventScroll: true });
}
function loadRecentImportJobs({ automatic = false } = {}) {
  if (!canEdit()) return Promise.resolve();
  if (recentImportJobsPromise) return recentImportJobsPromise;
  if (automatic && Date.now() - recentImportJobsReadAt < 30_000) return Promise.resolve();
  const session = state.session;
  const button = $('loadRecentImportJobs'), status = $('importHistoryStatus');
  $('importSessionJobs').hidden = false;
  if (button) button.disabled = true;
  if (status) status.textContent = '正在读取本人最近 8 条任务；不会重新提交名单…';
  recentImportJobsPromise = (async () => {
    try {
      const recent = await api('/api/author-spreadsheet/jobs/recent?limit=8&scope=mine');
      if (session !== state.session || !canEdit()) return;
      if (recent?.scope !== 'mine') throw new Error('当前服务尚未确认本人任务范围，请待服务更新后再查');
      if (!Array.isArray(recent.jobs) || recent.jobs.length > 8 || recent.jobs.some(job => !job || !/^[0-9a-f-]{36}$/i.test(job.id || '') || !['queued', 'running', 'completed', 'failed'].includes(job.status))) throw new Error('最近任务回执格式无效');
      for (const [index, job] of recent.jobs.entries()) {
        const remembered = acceptedImportJobs.get(job.id);
        acceptedImportJobs.set(job.id, { ...remembered, ...job, order: Date.parse(job.createdAt) || remembered?.order || recent.jobs.length - index });
      }
      recentImportJobsReadAt = Date.now();
      renderAcceptedImportJobs();
      if (status) status.textContent = `已读取本人最近 ${recent.jobs.length} 条任务${acceptedImportJobs.size > recent.jobs.length ? '，另保留本次会话回执' : ''}。点击只读查看；此列表不代表全部历史，也不代表实时待处理人数。`;
    } catch (error) {
      if (session === state.session && status) status.textContent = `最近任务读取失败：${error.message}。保留已有回执和导入草稿；可重试读取，不要重新上传。`;
    } finally {
      if (button) button.disabled = !canEdit();
      recentImportJobsPromise = null;
    }
  })();
  return recentImportJobsPromise;
}
function showSubmittedImportJob(job) {
  importJobReadVersion++; importJobReadPromise = null; currentImportJob = job;
  $('checkImportJob').disabled = false; $('importJobReadStatus').textContent = '';
  renderImportJob(job);
  if (acceptedImportJobs.size) renderAcceptedImportJobs();
}
function rememberImportJobId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return;
  const url = new URL(location.href); url.searchParams.set('importJob', id);
  history.replaceState(null, '', url);
}
function openImportJob(id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return Promise.resolve();
  importJobSelectionVersion++;
  if (currentImportJob?.id === id) return loadImportJob();
  rememberImportJobId(id); showSubmittedImportJob({ id, fileName: '已保存任务', ...acceptedImportJobs.get(id) });
  return loadImportJob();
}
function loadImportJob() {
  const id = currentImportJob?.id;
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return Promise.resolve();
  if (importJobReadPromise) return importJobReadPromise;
  const version = ++importJobReadVersion;
  $('checkImportJob').disabled = true; $('importJobReadStatus').textContent = '正在读取已有任务，不重新提交…';
  importJobReadPromise = (async () => {
    try {
      const job = await api(`/api/author-spreadsheet/jobs/${encodeURIComponent(id)}`);
      if (version !== importJobReadVersion || currentImportJob?.id !== id) return;
      if (job?.id !== id || !['queued', 'running', 'completed', 'failed'].includes(job.status)) throw new Error('任务回执格式无效');
      currentImportJob = job; renderImportJob(job);
      if (acceptedImportJobs.has(id)) {
        acceptedImportJobs.set(id, { ...acceptedImportJobs.get(id), status: job.status });
        renderAcceptedImportJobs();
      }
      $('importJobReadStatus').textContent = job.status === 'completed' ? '已读取任务完成时结果；不是实时队列余额。' : '已读取任务状态；可稍后再次检查。';
    } catch (error) {
      if (version !== importJobReadVersion) return;
      $('importJobReadStatus').textContent = `结果读取失败：${error.message}；保留上次回执，不重新提交名单。`;
    } finally {
      if (version === importJobReadVersion) { $('checkImportJob').disabled = false; importJobReadPromise = null; }
    }
  })();
  return importJobReadPromise;
}
function renderSourceImportResults(source = {}) {
  const sources = Array.isArray(source.sources) ? source.sources : [];
  const rows = sources.filter(item => item?.sourceJobSummary?.version === 1 && item.sourceJobSummary.jobStatus === 'completed');
  const issues = sources.filter(item => ['blocked', 'failed', 'pending', 'unchecked', 'unknown'].includes(item?.lastStatus));
  $('sourceImportFreshness').textContent = '全局来源的任务完成时历史回执，不受当前板块筛选影响，也不是实时待处理队列。元数据检查不等于名单导入。';
  const signature = JSON.stringify({ rows: rows.map(({ title, sourceJobSummary }) => ({ title, sourceJobSummary })), issues: issues.map(({ title, lastStatus, lastError, lastCheckedAt }) => ({ title, lastStatus, lastError, lastCheckedAt })), canReadJobs: canEdit() });
  if (signature === sourceImportSignature) return;
  if ($('sourceImportResults').contains?.(document.activeElement)) return;
  sourceImportSignature = signature;
  const issueLabels = { blocked: '来源受限', failed: '读取失败', pending: '等待处理回执', unchecked: '尚未检查', unknown: '状态未确认' };
  const issueMarkup = issues.map(item => `<article class="source-import-receipt source-import-issue"><h3>${esc(item.title || '未命名来源')} · ${issueLabels[item.lastStatus]}</h3><p>${esc(item.lastError || '尚未取得可确认的来源检查结果；不视为导入完成。')}</p><small>检查时间 ${importTime(item.lastCheckedAt)}</small></article>`).join('');
  $('sourceImportResults').innerHTML = issueMarkup + (rows.length ? rows.map(source => {
    const item = source.sourceJobSummary;
    return `<article class="source-import-receipt"><h3>${esc(source.title || '来源名称未提供')}</h3><p class="muted">任务 ${esc(typeof item.jobId === 'string' ? item.jobId.slice(0, 8) : '编号未提供')} · 完成 ${importTime(item.finishedAt)} · 回执读取 ${importTime(item.observedAt)}</p>${importOutcomeMetrics({ createdCount: item.createdAccountCount, reusedExistingCount: item.reusedExistingRowCount, queuedEvidenceRequestCount: item.queuedEvidenceRequestCount, reviewRequiredCount: item.reviewRequiredItemCount })}${canEdit() && typeof item.jobId === 'string' && /^[0-9a-f-]{36}$/i.test(item.jobId) ? `<button class="link-btn" type="button" data-import-job="${esc(item.jobId)}">查看任务及逐项审查</button>` : '<p class="muted">逐项名单仅任务提交者或管理员可查看。</p>'}</article>`;
  }).join('') : '<p class="muted">当前接口未提供来源任务的业务结果。未提供的计数显示为 —，不推断为零或全部成功。</p>');
}
async function handleWorkbookBatchFile(file, { defaultBoard } = {}) {
  if (!file) return;
  if (!canEdit()) { notice('当前为只读身份，名单导入需要编辑权限。', true); return; }
  let initialDefaultBoard = defaultBoard;
  const selectedBoardKey = state.board;
  const preview = $('importPreview'), id = ++importRequest;
  importResultCommitted = false;
  preview.hidden = false; preview.innerHTML = loadingMarkup('正在一次读取工作簿并检查各工作表…');
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('文件超过 8MB，请拆分后上传');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const contentBase64 = btoa(binary);
    const result = await api('/api/author-spreadsheet/batch-preview', { method: 'POST', body: JSON.stringify({ fileName: file.name, contentBase64 }) });
    if (id !== importRequest) return;
    if (!Array.isArray(result?.sheets) || !/^[a-f0-9]{64}$/i.test(String(result.uploadSha256 ?? ''))) throw new Error('批量预览回执不完整，请重试读取文件');
    const boardCatalog = importBoardCatalog(result.boardCatalog);
    initialDefaultBoard = importSelectedBoard(boardCatalog, initialDefaultBoard, selectedBoardKey);
    const boardOptions = boardCatalog.map(board => board.name);
    const validSheets = result.sheets.filter(sheet => sheet.importable && sheet.rowCount > 0);
    preview.innerHTML = `<div class="import-batch-head"><div><p class="eyebrow">BATCH REVIEW</p><h3>${esc(file.name)}</h3><p class="muted">一次读取 ${result.sheets.length} 张工作表，识别出 ${validSheets.length} 张含作者数据的表，共 ${importCount(result.totalAuthorRows)} 行。逐表核对后可统一提交；表内填写的板块优先，下方设置只补空白板块。</p></div><span class="import-batch-cap">单次批量上限 ${importCount(result.maxBatchRows || 10000)} 行</span></div><div class="import-batch-list" role="list" aria-label="工作表导入清单">${result.sheets.map((sheet, index) => {
      const available = Boolean(sheet.importable && sheet.rowCount > 0);
      const summary = sheet.summary || {};
      const caption = available ? importPreviewIdentityCaption(summary, sheet.sampleRows || [], { totalRows: sheet.rowCount }) : sheet.issue || '未识别作者表头';
      const sampleRows = sheet.sampleRows || [];
      const problemProjection = importProblemProjection(sheet, sampleRows);
      const boardSelect = `<label class="batch-board-label" for="batchBoard_${index}"><span>空白板块归入</span><select id="batchBoard_${index}" ${available ? '' : 'disabled'}><option value="">未分板块</option>${boardOptions.map(board => `<option value="${esc(board)}">${esc(board)}</option>`).join('')}</select></label>`;
      return `<article class="import-batch-sheet${available ? '' : ' is-unavailable'}" role="listitem"><div class="import-batch-sheet-main"><label class="import-batch-check"><input id="batchInclude_${index}" type="checkbox" data-batch-sheet="${index}" ${available ? 'checked' : 'disabled'}><span><strong>${esc(sheet.name)}</strong><small>${available ? `${importCount(sheet.rowCount)} 行作者资料 · 表头第 ${importCount(sheet.headerRow || 0)} 行` : esc(sheet.issue || '未识别作者表头')}</small></span></label><span id="batchResult_${index}" class="import-batch-status">${available ? '待提交' : '不参与导入'}</span></div><p class="import-batch-caption">${esc(caption)}</p>${available ? `${importPreviewStatusMarkup(summary)}${importNoActionableMarkup(summary)}${importProblemRowsMarkup(problemProjection)}` : ''}${boardSelect}<details class="batch-sample-details" ${available ? '' : 'hidden'}><summary>查看普通样例（前 ${Math.min(50, sampleRows.length)} 行 / 共 ${importCount(sheet.rowCount)} 行）</summary>${importPreviewTableMarkup(sampleRows)}${sheet.validationWarnings?.length ? `<p class="muted">${esc(sheet.validationWarnings.join('；'))}</p>` : ''}</details></article>`;
    }).join('')}</div><div class="import-actions"><button id="commitImport" class="primary-btn" ${validSheets.length ? '' : 'disabled'}>提交已勾选的 ${validSheets.length} 张工作表</button><button id="batchRetry" class="primary-btn" type="button" hidden>安全核对并继续</button><button id="cancelImport" class="secondary-btn">关闭预览</button></div><p id="importStatus" role="status" aria-live="polite">每张工作表会建立独立处理任务，可在结果中逐表查看；未选中的工作表不会提交。</p><p id="recentImportStatus" role="status"></p>`;
    const defaultBoardName = importSelectedBoard(boardCatalog, initialDefaultBoard);
    result.sheets.forEach((sheet, index) => {
      const checkbox = $(`batchInclude_${index}`);
      const select = $(`batchBoard_${index}`);
      if (select && sheet.importable) select.value = defaultBoardName;
      if (checkbox) checkbox.onchange = () => {
        const selectedCount = result.sheets.reduce((total, _item, sheetIndex) => total + (document.getElementById(`batchInclude_${sheetIndex}`)?.checked ? 1 : 0), 0);
        $('commitImport').textContent = `提交已勾选的 ${selectedCount} 张工作表`;
      };
    });
    const resolvedSheets = new Set();
    let submitting = false, uncertain = false, savedRetryAssignments = null;
    const cancel = $('cancelImport');
    cancel.onclick = () => {
      if (id !== importRequest) return;
      importRequest++; importJobSelectionVersion++; preview.hidden = true; $('fileInput').value = '';
      if (submitting) notice('已关闭预览；批量提交在服务器端继续处理，可在导入任务中核对结果。');
    };
    const submitBatch = async ({ retry = false } = {}) => {
      if (id !== importRequest || submitting) return;
      if (!canEdit()) { $('importStatus').textContent = '当前为只读身份，名单导入需要编辑权限。'; return; }
      const assignments = retry ? savedRetryAssignments : result.sheets.flatMap((sheet, index) => {
        const checkbox = $(`batchInclude_${index}`);
        if (!sheet.importable || !checkbox?.checked || resolvedSheets.has(sheet.name)) return [];
        const fallback = $(`batchBoard_${index}`)?.value || '';
        const scope = importIdempotencyScope(result.uploadSha256, sheet.name, fallback);
        return [{ sheetName: sheet.name, defaultBoard: fallback, idempotencyKey: importIdempotencyKeyFor(scope) }];
      });
      if (!Array.isArray(assignments) || !assignments.length) { $('importStatus').textContent = '请先勾选至少一张尚未提交的作者工作表。'; return; }
      if (!retry) savedRetryAssignments = assignments;
      const submission = ++importSubmissionSequence, selectionVersion = importJobSelectionVersion;
      submitting = true;
      const button = retry ? $('batchRetry') : $('commitImport');
      button.disabled = true; button.textContent = retry ? '正在安全核对…' : '正在逐表提交…';
      $('importStatus').textContent = `正在提交 ${assignments.length} 张工作表；每张表独立排队，提交中请勿关闭或重复点击。`;
      try {
        const currentBytes = new Uint8Array(await file.arrayBuffer());
        let currentBinary = ''; for (let i = 0; i < currentBytes.length; i += 0x8000) currentBinary += String.fromCharCode(...currentBytes.subarray(i, i + 0x8000));
        const response = await api('/api/author-spreadsheet/auto-monitor-batch', { method: 'POST', body: JSON.stringify({ fileName: file.name, contentBase64: btoa(currentBinary), uploadSha256: result.uploadSha256, assignments }) });
        const assignmentNames = new Set(assignments.map(assignment => assignment.sheetName));
        const responseNames = new Set((response?.results || []).map(item => item?.sheetName));
        if (!Array.isArray(response?.results) || response.results.length !== assignments.length || responseNames.size !== assignments.length
          || response.results.some(item => !assignmentNames.has(item?.sheetName) || !['accepted', 'replayed', 'rejected'].includes(item?.status)
            || (['accepted', 'replayed'].includes(item?.status) && (!item.job || typeof item.job.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.job.id))))) {
          throw new Error('批量受理回执不完整，请先执行安全核对');
        }
        if (id !== importRequest) {
          response.results.forEach((item, sheetIndex) => {
            const assignment = assignments.find(candidate => candidate.sheetName === item.sheetName);
            const scope = importIdempotencyScope(result.uploadSha256, item.sheetName, assignment?.defaultBoard || '');
            if (item.status === 'rejected') {
              clearImportIdempotencyKey(scope, assignment?.idempotencyKey);
              return;
            }
            const job = item.job;
            if (job && typeof job.id === 'string' && /^[0-9a-f-]{36}$/i.test(job.id)) {
              acceptedImportJobs.set(job.id, { id: job.id, fileName: job.fileName || file.name, sheetName: item.sheetName, status: job.status, order: Date.now() + sheetIndex });
            }
          });
          renderAcceptedImportJobs();
          return;
        }
        uncertain = false; savedRetryAssignments = null;
        let latestJob = null, accepted = 0, replayed = 0, rejected = 0;
        response.results.forEach(item => {
          const sheetIndex = result.sheets.findIndex(sheet => sheet.name === item.sheetName);
          if (sheetIndex < 0) return;
          const assignment = assignments.find(candidate => candidate.sheetName === item.sheetName);
          const scope = importIdempotencyScope(result.uploadSha256, item.sheetName, assignment?.defaultBoard || '');
          const key = assignment?.idempotencyKey;
          if (item.status === 'accepted' || item.status === 'replayed') {
            resolvedSheets.add(item.sheetName);
            const job = item.job;
            if (job && typeof job.id === 'string' && /^[0-9a-f-]{36}$/i.test(job.id)) {
              latestJob = job; acceptedImportJobs.set(job.id, { id: job.id, fileName: job.fileName || file.name, sheetName: item.sheetName, status: job.status, order: Date.now() + sheetIndex });
            }
            if (item.status === 'replayed') replayed += 1; else accepted += 1;
            $(`batchResult_${sheetIndex}`).textContent = item.status === 'replayed' ? `已存在任务 ${job?.id?.slice(0, 8) || ''}` : `已提交 ${job?.id?.slice(0, 8) || ''}`;
            $(`batchInclude_${sheetIndex}`).disabled = true;
          } else {
            clearImportIdempotencyKey(scope, key); rejected += 1;
            $(`batchResult_${sheetIndex}`).textContent = `未提交：${item.error || '服务器拒绝'}`;
          }
        });
        renderAcceptedImportJobs();
        if (latestJob && submission === importSubmissionSequence && selectionVersion === importJobSelectionVersion) { showSubmittedImportJob(latestJob); rememberImportJobId(latestJob.id); void loadImportJob(); }
        const finished = accepted + replayed;
        if (finished > 0) { importResultCommitted = true; $('fileInput').value = ''; }
        $('importStatus').textContent = `批量结果：${accepted} 张新建任务，${replayed} 张复用已有任务，${rejected} 张未提交。每张表的任务都已独立显示${rejected ? '；可取消未提交表后继续其余选择' : '，请不要重新导入已提交的表'}。`;
        if (!rejected) { $('commitImport').disabled = true; $('commitImport').textContent = '已完成批量提交'; }
        else {
          $('commitImport').disabled = result.sheets.every(sheet => resolvedSheets.has(sheet.name) || !sheet.importable);
          $('commitImport').textContent = '继续提交未完成的工作表';
        }
        $('batchRetry').hidden = true;
      } catch (error) {
        if (id !== importRequest) return;
        const status = Number(error?.status);
        const definitelyRejected = Number.isInteger(status) && status >= 400 && status < 500 && ![408, 425].includes(status);
        if (definitelyRejected) {
          for (const assignment of assignments) clearImportIdempotencyKey(importIdempotencyScope(result.uploadSha256, assignment.sheetName, assignment.defaultBoard), assignment.idempotencyKey);
          savedRetryAssignments = null; uncertain = false;
          $('importStatus').textContent = `服务器在入队前明确拒绝本批次（${status}）：${error.message}。没有创建批量任务，请修正后重新提交。`;
          button.disabled = false; button.textContent = retry ? '安全核对并继续' : `重试提交 ${assignments.length} 张工作表`;
        } else {
          uncertain = true; savedRetryAssignments = assignments;
          $('importStatus').textContent = `本批次提交结果暂时无法确认：${error.message}。不会自动重复提交；可以点“安全核对并继续”，逐表幂等凭证会避免已受理工作表重复建任务。`;
          $('batchRetry').hidden = false; $('batchRetry').disabled = false; $('batchRetry').textContent = '安全核对并继续';
          button.disabled = true; button.textContent = '结果待核对';
          for (const sheet of result.sheets) { $(`batchInclude_${result.sheets.indexOf(sheet)}`).disabled = true; $(`batchBoard_${result.sheets.indexOf(sheet)}`).disabled = true; }
        }
      } finally { submitting = false; }
    };
    $('commitImport').onclick = () => submitBatch();
    $('batchRetry').onclick = () => uncertain ? submitBatch({ retry: true }) : undefined;
  } catch (error) {
    if (id !== importRequest) return;
    preview.innerHTML = `<div class="notice error" role="alert">${esc(error.message)}</div><div class="import-actions"><button id="retryBatchPreview" class="primary-btn" type="button">重试读取此文件</button><button id="cancelBatchPreview" class="secondary-btn" type="button">取消，改选文件</button></div>`;
    $('retryBatchPreview').onclick = () => { if (id === importRequest) void handleWorkbookBatchFile(file, { defaultBoard: initialDefaultBoard }); };
    $('cancelBatchPreview').onclick = () => { if (id === importRequest) { importRequest++; preview.hidden = true; preview.innerHTML = ''; $('fileInput').value = ''; $('fileInput').focus?.({ preventScroll: true }); } };
  }
}

function pastedAuthorFile(text, mode = 'table', platform = 'douyin') {
  const content = String(text ?? '').replace(/^\uFEFF/, '');
  if (!content.trim()) throw new Error('请先粘贴作者资料。');
  if (content.length > 1_000_000) throw new Error('粘贴内容超过 100 万字符，请拆分或改用文件上传。');
  if (!['table', 'names', 'ids', 'links'].includes(mode)) throw new Error('请选择粘贴内容的格式。');
  if (mode === 'table') {
    // Keep blank leading/trailing columns. Tabs inside a later CSV value are
    // content, not a reason to reinterpret the whole table as TSV.
    const firstLine = content.split(/\r\n?|\n/, 1)[0];
    const extension = firstLine.includes('\t') ? 'tsv' : 'csv';
    return new File(['\ufeff', content], `粘贴作者表格.${extension}`, { type: 'text/plain;charset=utf-8' });
  }
  if (!['douyin', 'bilibili', 'xiaohongshu'].includes(platform)) throw new Error('请选择名单所属平台。');
  const lines = content.split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length > 10_000) throw new Error('单次最多粘贴 10,000 行，请拆分名单。');
  if (lines.some(line => line.includes('\t'))) throw new Error('检测到多列表格，请选择“带表头的表格”并保留表头；不会把整行猜成账号。');
  const column = mode === 'names' ? '作者名称' : mode === 'links' ? '主页链接' : { douyin: '抖音号', bilibili: 'B站UID', xiaohongshu: '小红书用户ID' }[platform];
  const quote = value => `"${String(value).replace(/"/g, '""')}"`;
  const csv = [['平台', column], ...lines.map(line => [platformNames[platform], line])].map(row => row.map(quote).join(',')).join('\r\n');
  return new File(['\ufeff', csv], `粘贴${column}_${platformNames[platform]}.csv`, { type: 'text/csv;charset=utf-8' });
}
function invalidatePastedPreview() {
  pasteDraftVersion++;
  const hadPastePreview = activePastePreview !== null;
  if (activePastePreview !== null) {
    importRequest++; importJobSelectionVersion++;
    $('importPreview').hidden = true;
    activePastePreview = null;
    $('pasteAuthorsStatus').textContent = '粘贴内容已更改，请重新预览。此前已提交的任务不会取消，可在最近任务中核对。';
  }
  if (hadPastePreview || $('pasteAuthorsText')?.value?.trim()) importResultCommitted = false;
  $('pasteAuthorsText')?.removeAttribute?.('aria-invalid');
}
function renderPasteAuthorsHelp() {
  const mode = $('pasteAuthorsMode').value;
  $('pastePlatformLabel').hidden = mode === 'table';
  const help = {
    table: '从 Excel / 飞书复制时请带上表头，保留制表符；也支持逗号分隔 CSV。推荐列：平台、作者名称、抖音号 / B站UID / 小红书用户ID、主页链接、板块。平台未填时按原导入规则识别，混合平台请逐行写明。',
    names: '每行只填一个作者昵称，不按空格拆分。昵称不是唯一身份，系统会保留为待识别资料，不会仅凭同名强行匹配。想更快加入监控，可使用账号 ID 或主页链接。',
    ids: '每行一个真实平台账号 ID：抖音填写抖音号，B站填写数字 UID，小红书填写主页中的用户 ID。请先选对平台，不要把昵称当作 ID。',
    links: '每行一个完整主页或分享链接，并选对平台。链接用于核对作者身份；分享作品不会被当作已确认作者，核验成功后才会加入监控。',
  };
  $('pasteAuthorsHelp').textContent = help[mode] || help.table;
}
async function handlePastedAuthors() {
  if (!canEdit()) { $('pasteAuthorsStatus').textContent = '当前为只读身份，名单导入需要编辑权限。'; return; }
  if (pastePreviewPending) return;
  let file;
  try { file = pastedAuthorFile($('pasteAuthorsText').value, $('pasteAuthorsMode').value, $('pasteAuthorsPlatform').value); }
  catch (error) {
    $('pasteAuthorsText').setAttribute?.('aria-invalid', 'true');
    $('pasteAuthorsStatus').textContent = error.message;
    $('pasteAuthorsText').focus?.({ preventScroll: true }); return;
  }
  const version = pasteDraftVersion;
  pastePreviewPending = true;
  $('previewPastedAuthors').disabled = true;
  $('pasteAuthorsStatus').textContent = '正在预览粘贴资料；不会自动提交名单…';
  try {
    await handleFile(file, undefined, { pasted: true });
    if (version === pasteDraftVersion && activePastePreview === version) {
      $('pasteAuthorsStatus').textContent = '读取已完成，请核对下方预览或错误信息。此步骤没有提交名单；核对后需单独确认提交。';
      if (document.activeElement === $('previewPastedAuthors')) $('importPreview').focus?.({ preventScroll: true });
    }
  } finally { pastePreviewPending = false; $('previewPastedAuthors').disabled = !canEdit(); }
}
async function handleFile(file, sheetName, { defaultBoard, restoreSheetFocus = false, pasted = false } = {}) {
  if (!file) return;
  activePastePreview = pasted ? pasteDraftVersion : null;
  if (/\.(?:xlsx|xls|xlsm|xlsb)$/i.test(file.name)) return handleWorkbookBatchFile(file, { defaultBoard });
  if (!canEdit()) { notice('当前为只读身份，名单导入需要编辑权限。', true); return; }
  let selectedDefaultBoard = defaultBoard;
  const selectedBoardKey = state.board;
  const preview = $('importPreview'), id = ++importRequest;
  importResultCommitted = false;
  preview.hidden = false; preview.innerHTML = loadingMarkup('正在读取并核对表头…');
  let focusMoved = false;
  const trackFocus = () => { focusMoved = true; };
  if (restoreSheetFocus) document.addEventListener?.('focusin', trackFocus);
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('文件超过 8MB，请拆分后上传');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const contentBase64 = btoa(binary);
    const result = await api('/api/author-spreadsheet/preview', { method: 'POST', body: JSON.stringify({ fileName: file.name, contentBase64, ...(sheetName ? { sheetName } : {}) }) });
    if (id !== importRequest) return;
    const summary = result.summary || {};
    const identitySummary = importPreviewIdentityCaption(summary, result.rows);
    const sheets = Array.isArray(result.sheets) && result.sheets.length ? result.sheets : [{ name: result.selectedSheet || sheetName || '当前工作表' }];
    const selectedSheet = result.selectedSheet || sheetName || sheets[0].name;
    const boardCatalog = importBoardCatalog(result.boardCatalog);
    selectedDefaultBoard = importSelectedBoard(boardCatalog, selectedDefaultBoard, selectedBoardKey);
    const uploadSha256 = /^[a-f0-9]{64}$/i.test(String(result.uploadSha256 ?? '')) ? String(result.uploadSha256).toLowerCase() : '';
    const sampleRows = Array.isArray(result.sampleRows) ? result.sampleRows : result.rows.slice(0, 50);
    const problemProjection = importProblemProjection(result, result.rows);
    preview.innerHTML = `<h3>${esc(file.name)}</h3><p>工作簿共 ${sheets.length} 页；当前工作表：${esc(selectedSheet)}。每次仅提交当前工作表，其他作者工作表需分别预览和提交。</p><label>选择工作表<select id="importSheet" ${sheets.length < 2 ? 'disabled' : ''}>${sheets.map(sheet => `<option value="${esc(sheet.name)}" ${sheet.headerScore === 0 ? 'disabled' : ''}>${esc(sheet.name)}${sheet.headerScore === 0 ? '（未识别作者表头）' : ''}</option>`).join('')}</select></label><p>当前工作表识别 ${result.rows.length} 行 · ${identitySummary} · ${importCount(summary.existingRows)} 行匹配既有记录 · ${importCount(summary.autoMonitorAuthors)} 个可处理分组（非已核验人数）</p>${importPreviewStatusMarkup(summary)}${importNoActionableMarkup(summary)}${importProblemRowsMarkup(problemProjection)}<label>没有填写板块的作者归入<select id="importBoard"><option value="">未分板块</option>${(state.data?.boards || []).filter(b => b.key !== '__unassigned__').map(b => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join('')}</select></label><details class="batch-sample-details"><summary>查看普通样例（前 ${Math.min(50, sampleRows.length)} 行 / 共 ${importCount(result.rows.length)} 行）</summary>${importPreviewTableMarkup(sampleRows)}</details><p class="muted">问题定位来自全表审查；普通样例最多显示前 50 行。已有账号按身份去重，历史数据保留；预览不代表已新增或已取得采样。</p><div class="import-actions"><button id="commitImport" class="primary-btn" ${!result.rows.length ? 'disabled' : ''}>确认当前工作表并提交处理</button><button id="cancelImport" class="secondary-btn">关闭预览</button></div><p id="importStatus" role="status"></p><button id="checkRecentImportJobs" class="secondary-btn" type="button" hidden>核对本人最近任务</button><p id="recentImportStatus" role="status"></p>`;
    $('importBoard').innerHTML = '<option value="">未分板块</option>' + boardCatalog.map(board => `<option value="${esc(board.name)}">${esc(board.name)}</option>`).join('');
    $('importBoard').value = importSelectedBoard(boardCatalog, selectedDefaultBoard);
    $('importSheet').value = selectedSheet;
    $('importSheet').onchange = () => {
      if (id !== importRequest) return;
      return handleFile(file, $('importSheet').value, { defaultBoard: $('importBoard').value, restoreSheetFocus: document.activeElement === $('importSheet'), pasted });
    };
    let submitting = false, submitted = false;
    let uncertainSubmissionStartedAt = 0;
    $('cancelImport').onclick = () => {
      if (id !== importRequest) return;
      importRequest++; importJobSelectionVersion++; preview.hidden = true; $('fileInput').value = '';
      if (submitting) notice('已关闭预览；已发出的提交未被取消，可在导入页核对本人最近任务。');
    };
    $('checkRecentImportJobs').onclick = async () => {
      if (id !== importRequest) return;
      const checkButton = $('checkRecentImportJobs'); checkButton.disabled = true;
      $('recentImportStatus').textContent = '正在读取当前账号最近任务，不会重新提交…';
      try {
        let recent;
        try { recent = await api('/api/author-spreadsheet/jobs/recent?limit=8&scope=mine'); }
        catch (error) {
          if (error?.status === 404) {
            $('recentImportStatus').textContent = '当前运行服务尚未加载最近任务回查接口。提交仍保持锁定，请勿重提；待服务安全更新后再核对。';
            return;
          }
          throw error;
        }
        if (id !== importRequest) return;
        if (recent?.scope !== 'mine') throw new Error('当前服务尚未确认本人任务范围，请待服务更新后再查');
        if (!Array.isArray(recent?.jobs)) throw new Error('最近任务回执格式无效');
        const jobs = recent.jobs.filter(job => typeof job?.id === 'string' && /^[0-9a-f-]{36}$/i.test(job.id));
        const candidateIds = new Set(jobs.filter(job => job.fileName === file.name && job.sheetName === selectedSheet
          && Number.isFinite(Date.parse(job.createdAt)) && Date.parse(job.createdAt) >= uncertainSubmissionStartedAt - 60_000
          && Date.parse(job.createdAt) <= Date.now() + 60_000).map(job => job.id));
        jobs.forEach((job, order) => acceptedImportJobs.set(job.id, { ...job, order: Date.parse(job.createdAt) || (jobs.length - order), uncertainCandidate: candidateIds.has(job.id) }));
        renderAcceptedImportJobs();
        const candidateNote = candidateIds.size ? `其中 ${candidateIds.size} 条仅按文件名、工作表和时间列为候选，仍需核对任务时间与内容。` : '未找到文件名、工作表和时间接近的候选；这里只查最近 8 条，不能据此断定本次未受理。';
        $('recentImportStatus').textContent = `已读取本人最近 ${jobs.length} 条任务。${candidateNote}点击列表只读查看，不会重提。`;
      } catch (error) {
        if (id === importRequest) $('recentImportStatus').textContent = `最近任务读取失败：${error.message}；本次提交仍锁定，请稍后只重试读取。`;
      } finally {
        if (id === importRequest) checkButton.disabled = false;
      }
    };
    $('commitImport').onclick = async () => {
      if (id !== importRequest || submitting || submitted || !result.rows.length) return;
      if (!canEdit()) { $('importStatus').textContent = '当前为只读身份，名单导入需要编辑权限。'; return; }
      submitting = true;
      const submission = ++importSubmissionSequence, selectionVersion = importJobSelectionVersion;
      const submitStartedAt = Date.now();
      const button = $('commitImport'); button.disabled = true; button.textContent = '正在提交…';
      const defaultBoard = $('importBoard').value;
      const idempotencyScope = uploadSha256 ? importIdempotencyScope(uploadSha256, selectedSheet, defaultBoard) : '';
      const idempotencyKey = idempotencyScope ? importIdempotencyKeyFor(idempotencyScope) : '';
      try {
        const response = await api('/api/author-spreadsheet/auto-monitor', { method: 'POST', ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}), body: JSON.stringify({ fileName: file.name, sheetName: selectedSheet, contentBase64, defaultBoard, ...(uploadSha256 ? { uploadSha256 } : {}) }) });
        if (typeof response?.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(response.id) || !['queued', 'running', 'completed', 'failed'].includes(response.status)) throw new Error('后台受理回执格式无效，请核对任务记录后再决定是否重试');
        if (idempotencyScope && idempotencyKey) clearImportIdempotencyKey(idempotencyScope, idempotencyKey);
        submitted = true;
        acceptedImportJobs.set(response.id, { id: response.id, fileName: response.fileName || file.name, sheetName: response.sheetName || selectedSheet, status: response.status, order: submission });
        if (submission === importSubmissionSequence && selectionVersion === importJobSelectionVersion && id === importRequest) {
          showSubmittedImportJob(response); rememberImportJobId(response.id); void loadImportJob();
        }
        renderAcceptedImportJobs();
        if (id === importRequest) {
          importResultCommitted = true; $('fileInput').value = '';
          $('importStatus').textContent = response.idempotencyReplay
            ? `已识别到同一文件的此前任务，没有重复创建${response.id ? `，任务 ${String(response.id).slice(0, 8)}` : ''}。下面可读取该任务结果。`
            : `名单已提交后台处理${response.id ? `，任务 ${String(response.id).slice(0, 8)}` : ''}。下面可读取该任务结果，不需要重复提交。`;
        }
        button.textContent = '已提交';
      } catch (error) {
        if (id === importRequest) {
          const status = Number(error?.status);
          const definitelyRejected = Number.isInteger(status) && status >= 400 && status < 500 && ![408, 409, 425].includes(status);
          if (definitelyRejected) {
            if (idempotencyScope && idempotencyKey) clearImportIdempotencyKey(idempotencyScope, idempotencyKey);
            $('importStatus').textContent = `服务器明确拒绝本次提交（${status}）：${error.message}。修正问题后可安全重试。`;
            button.disabled = false; button.textContent = '重试提交';
          } else {
            submitted = true; uncertainSubmissionStartedAt = submitStartedAt;
            $('importStatus').textContent = `提交结果不确定：${error.message}。本次预览已锁定；若该文件凭证受支持，重新上传相同文件/工作表/板块会复用幂等键，避免重建任务。先核对本人最近任务。`;
            button.disabled = true; button.textContent = '结果待核对';
            $('checkRecentImportJobs').hidden = false;
          }
        }
      }
      finally { submitting = false; }
    };
    if (restoreSheetFocus && !focusMoved && (!document.activeElement || document.activeElement === document.body || document.activeElement === document.documentElement)) $('importSheet').focus?.({ preventScroll: true });
  } catch (error) {
    if (id === importRequest) {
      preview.innerHTML = `<div class="notice error" role="alert">${esc(error.message)}</div><div class="import-actions"><button id="retryImportPreview" class="primary-btn" type="button">重试读取此文件</button><button id="cancelImportPreview" class="secondary-btn" type="button">取消，改选文件</button></div>`;
      $('retryImportPreview').onclick = async () => { if (id === importRequest) await handleFile(file, sheetName, { defaultBoard: selectedDefaultBoard, pasted }); };
      $('cancelImportPreview').onclick = () => {
        if (id !== importRequest) return;
        importRequest++; preview.hidden = true; preview.innerHTML = ''; $('fileInput').value = '';
        $('fileInput').focus?.({ preventScroll: true });
      };
    }
  }
  finally { if (restoreSheetFocus) document.removeEventListener?.('focusin', trackFocus); }
}

function enhanceShell() {
  $('periodSelect').innerHTML = '<option value="day">今日</option><option value="week">近 7 天</option><option value="month">本月</option><option value="30d">近 30 天</option><option value="since">9月12日起</option><option value="custom">自定义日期</option>';
  document.querySelector('.legend').remove();
  $('trendCard').insertAdjacentHTML('beforebegin', '<div class="metric-tabs" id="metricTabs" aria-label="趋势指标"></div>');
  $('trendCard').insertAdjacentHTML('afterbegin', '<div id="trendContext" class="trend-context" aria-label="趋势时间范围与数据说明"></div>');
  $('trendCard').insertAdjacentHTML('afterend', '<details class="trend-evidence" id="trendEvidence"></details>');
  $('kpiGrid').insertAdjacentHTML('afterend', '<div class="data-health" id="dataHealth"><span>正在读取账号资料…</span></div><details class="collection-panel" id="collectionPanel"><summary id="collectionSummary">正在核对采集覆盖…</summary><div id="collectionBody"></div></details>');
  $('kpiGrid').insertAdjacentHTML('afterend', '<section id="metricExplanation" class="metric-explanation" aria-labelledby="metricExplanationTitle" hidden></section>');
  $('scopeEditorBody').insertAdjacentHTML('beforeend', '<div class="compare-controls" id="compareControls"><label><input id="compareToggle" type="checkbox"> 对比另一时段</label><div id="compareDates" hidden><div class="comparison-date-row"><label>对比开始<input id="compareStart" type="date" aria-describedby="comparisonHint"></label><label>对比结束<input id="compareEnd" type="date" aria-describedby="comparisonHint"></label></div><div class="comparison-actions"><button type="button" class="link-btn" id="previousEqualPeriod">上一等长时段</button><button type="button" class="link-btn" id="restoreComparison" hidden>恢复上次对比日期</button></div><span class="muted" id="comparisonHint" role="status"></span></div><label>大主题<select id="themeSelect"><option value="all">全部大主题</option></select></label><label>矩阵类型 / 内容标签<select id="classificationSelect"><option value="all">全部矩阵类型与内容标签</option></select></label></div>');
  $('compareControls').insertAdjacentHTML('beforeend', '<button type="button" class="link-btn" id="clearScopeBtn" hidden>清除矩阵与分类筛选</button>');
  $('classificationSelect').parentElement.insertAdjacentHTML('afterend', '<button type="button" class="classification-more-toggle" id="classificationMore" aria-controls="classificationSelect" aria-expanded="false" hidden>查看原表描述</button>');
  $('primaryScope').append($('themeSelect').parentElement, $('classificationSelect').parentElement, $('classificationMore'), $('clearScopeBtn'));
  $('filterDetails').insertAdjacentHTML('afterend', '<p class="muted" id="rangeEvidence" aria-live="polite"></p>');
  $('sortSelect').parentElement.remove();
  $('accountsTable').insertAdjacentHTML('beforebegin', '<div class="ledger-reading-controls" id="ledgerReadingControls" aria-label="台账阅读与排序"></div>');
  $('ledgerReadingControls').addEventListener('change', event => {
    const key = ({ledgerMode:'mode',ledgerMetric:'metric'})[event.target.id];
    if (key) changeLedgerReading(key, event.target.value);
  });
  ledgerControls();
  window.matchMedia?.('(max-width: 720px)').addEventListener?.('change', () => {
    if (ledgerMode !== null || !state.data) return;
    const position = captureReadingPosition(); renderAccounts(); restoreReadingPosition(position);
  });
  window.addEventListener('beforeprint', () => {
    if (ledgerPrintState || !state.data) return;
    ledgerPrintState = { mode: ledgerMode, position: captureReadingPosition() };
    ledgerMode = 'full'; renderAccounts();
  });
  window.addEventListener('afterprint', () => {
    if (!ledgerPrintState) return;
    const saved = ledgerPrintState; ledgerPrintState = null; ledgerMode = saved.mode;
    renderAccounts(); restoreReadingPosition(saved.position);
  });
  $('accountsTable').insertAdjacentHTML('beforebegin', '<div class="pager pager-top" id="accountsPagerTop" role="group" aria-label="账号列表翻页"></div>');
  $('pager').setAttribute('role', 'group');
  $('pager').setAttribute('aria-label', '账号列表底部翻页');
  document.querySelector('.table-tools').insertAdjacentHTML('beforeend', '<label class="sort-label">平台<select id="platformSelect"><option value="all">全部平台</option><option value="douyin">抖音</option><option value="bilibili">B站</option><option value="xiaohongshu">小红书</option><option value="kuaishou">快手</option></select></label><label class="sort-label">范围<select id="enabledSelect"><option value="active">启用账号</option><option value="all">已建档（含暂停）</option><option value="paused">已暂停</option></select></label><button class="secondary-btn" id="exportButton">导出明细</button>');
  $('exportButton').insertAdjacentHTML('beforebegin', '<label class="sort-label">采集<select id="collectionSelect"><option value="all">全部采集状态</option><option value="missing-profile">期末主页缺采</option><option value="incomplete-works">期末作品明细不完整</option></select></label>');
  $('accountDialog').setAttribute('aria-labelledby', 'dialogName');
  $('authDialog').setAttribute('aria-label', '进入矩阵数据台');
  $('compareStart').value = state.compareStart || ''; $('compareEnd').value = state.compareEnd || '';
  $('compareToggle').checked = state.compare; $('compareDates').hidden = !state.compare;
  $('periodSelect').value = state.period; $('accountSearch').value = state.query;
  $('platformSelect').value = state.platform; $('enabledSelect').value = state.enabled; $('collectionSelect').value = state.collectionFilter;
  syncAccountMode();
}
async function restoreNavigation(event) {
  const entry = accountDetailHistory(event && 'state' in event ? event.state : history.state);
  const traversal = pendingModalCloseTraversal;
  if (traversal?.dispatched) {
    pendingModalCloseTraversal = null;
    if (!entry && location.href === traversal.parentBase && traversal.owner === detailHistoryOwner) {
      const newerAccount = $('accountDialog').open && state.detailId !== null && detailRequest !== traversal.request;
      if (newerAccount && (!traversal.view || traversal.view.request !== detailRequest)) {
        // Back removed the old modal record, not the newer account selection.
        // Re-establish the new selection so its own Back/Forward still works.
        rememberAccountDetailHistory(state.detailId);
        return;
      }
      if (traversal.view) {
        void closeAccount({ fromHistory: true, instant: true, restorePosition: false });
        setView(traversal.view.view, { renderData: traversal.view.renderData, fromHistory: true });
        return;
      }
    }
  }
  const sameContext = detailHistoryContext?.base === location.href && navigationUrl().href === location.href;
  if (sameContext) {
    if (entry) await openAccount(entry.id, { fromHistory: true });
    else await closeAccount({ fromHistory: true, instant: true });
    return;
  }
  // Leaving the parent scope invalidates in-flight detail/history requests
  // before a different page or date range is allowed to render behind them.
  // The instant path closes synchronously, before the hashchange event which
  // can accompany this same browser traversal; do not yield in between.
  void closeAccount({ fromHistory: true, instant: true, restorePosition: false });
  const destination = location.href;
  const restored = readNavigationState(location.href, { today: beijingToday() });
  Object.assign(state, restored); comparisonAuto = !restored.compare || restored.comparisonAuto === true; previousComparisonDraft = null;
  navigationRangePending = true;
  const workflowUrl = new URL(location.href);
  state.workflowTask = Object.hasOwn(workflowLabels, workflowUrl.searchParams.get('task')) ? workflowUrl.searchParams.get('task') : 'all';
  state.workflowMetric = getWorkflowMetric(workflowUrl.searchParams.get('metric'));
  $('compareStart').value = state.compareStart || ''; $('compareEnd').value = state.compareEnd || '';
  setupDates();
  if ($('periodSelect')) $('periodSelect').value = state.period;
  if ($('accountSearch')) $('accountSearch').value = state.query;
  if ($('platformSelect')) $('platformSelect').value = state.platform;
  if ($('enabledSelect')) $('enabledSelect').value = state.enabled;
  if ($('collectionSelect')) $('collectionSelect').value = state.collectionFilter;
  if ($('compareToggle')) $('compareToggle').checked = state.compare;
  if ($('compareDates')) $('compareDates').hidden = !state.compare;
  setView(location.hash.slice(1) || 'overview', { renderData: false, fromHistory: true }); await load();
  if (entry && destination === location.href && navigationUrl().href === destination
      && accountDetailHistory()?.sequence === entry.sequence && !state.busy && state.data)
    await openAccount(entry.id, { fromHistory: true });
}
function bind() {
  document.addEventListener('change', event => {
    const owner = event.target.dataset?.chartDate;
    if (owner) selectChartDay(owner, Number(event.target.value));
  });
  document.addEventListener('keydown', event => {
    const owner = event.target.dataset?.chartPlot, reading = chartReadings.get(owner);
    if (!reading || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    selectChartDay(owner, event.key === 'Home' ? 0 : event.key === 'End' ? Math.max(reading.points.length, reading.comparison.length) - 1 : reading.index + (event.key === 'ArrowLeft' ? -1 : 1));
  });
  document.addEventListener('click', event => {
    const plot = event.target.closest?.('[data-chart-plot]'), reading = chartReadings.get(plot?.dataset.chartPlot);
    if (!plot || !reading) return;
    const svg = plot.querySelector('svg'), length = Math.max(reading.points.length, reading.comparison.length);
    const index = chartDayIndexAtPointer(svg, event, length);
    if (index === null) return;
    selectChartDay(plot.dataset.chartPlot, index);
    plot.focus({ preventScroll: true });
  });
  document.dispatchEvent?.(new CustomEvent('mcn:works-settings-bind', { detail: { api, canManage: () => state.session?.user?.role === 'admin' } }));
  $('checkImportJob').onclick = () => void loadImportJob();
  document.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.hasAttribute('data-history-open')) {
      if (!accountHistory && state.detailId !== null) void mountAccountHistory();
      else $('accountHistoryTitle').focus?.({ preventScroll: true });
      return;
    }
    if (button.dataset.historyKind) { void changeHistoryKind(button.dataset.historyKind); return; }
    if (button.dataset.historySortKey) { void changeHistorySort(button.dataset.historySortKey); return; }
    if (button.dataset.historyWorkSortKey) { void changeHistorySort(button.dataset.historyWorkSortKey, { work: true }); return; }
    if (button.hasAttribute('data-history-apply')) { void applyHistoryDates(); return; }
    if (button.hasAttribute('data-history-clear')) { void applyHistoryDates({ clear: true }); return; }
    if (button.hasAttribute('data-history-refresh')) { void loadAccountHistory({ latest: true }); return; }
    if (button.hasAttribute('data-history-retry')) { void loadAccountHistory(); return; }
    if (button.hasAttribute('data-history-export')) { void exportAccountHistory(); return; }
    if (button.dataset.historyPage && !button.disabled && accountHistory) {
      const page = Number(button.dataset.historyPage);
      if (Number.isSafeInteger(page) && page >= 1 && page <= (accountHistory.data?.pagination.totalPages || 0)) { accountHistory.page = page; void loadAccountHistory(); }
      return;
    }
    if (button.dataset.historyWork) { void loadWorkHistory(Number(button.dataset.historyWork)); return; }
    if (button.dataset.historyWorkPage && !button.disabled && accountHistory?.work) {
      const page = Number(button.dataset.historyWorkPage), work = accountHistory.work;
      if (Number.isSafeInteger(page) && page >= 1 && page <= (work.data?.pagination.totalPages || 0)) void loadWorkHistory(work.id, page);
      return;
    }
    if (button.hasAttribute('data-history-work-close') && accountHistory) {
      const workId = accountHistory.work?.id; clearWorkHistory(accountHistory);
      (document.querySelector(`[data-history-work="${workId}"]`) || $('historyScope')).focus?.({ preventScroll: true }); return;
    }
    if (button.hasAttribute('data-open-source-review')) { openSourceReview(); return; }
    if (button.dataset.action === 'search-master-roster') {
      setAccountMode('roster', { focusSearch: true, query: state.query });
      return;
    }
    if (button.dataset.accountMode) { setAccountMode(button.dataset.accountMode); return; }
    if (button.dataset.importJob) { void openImportJob(button.dataset.importJob); return; }
    if (button.dataset.metricExplanation) { selectMetricExplanation(button.dataset.metricExplanation); return; }
    if (button.dataset.contributionLedger) { showContributionLedger(button.dataset.contributionLedger); return; }
    if (button.dataset.workflowTask) {
      const rootId = button.closest('#accountWorkflow') ? 'accountWorkflow' : 'dailyWorkflow';
      selectWorkflow(button.dataset.workflowTask);
      $(rootId)?.querySelector?.(`[data-workflow-task="${state.workflowTask}"]`)?.focus?.({ preventScroll: true });
      return;
    }
    if (button.dataset.action === 'workflow-accounts') {
      // Keep the investigation, but do not silently inherit an older search.
      const task = state.workflowTask;
      clearLocalAccountFilters(); state.workflowTask = task;
      setView('accounts'); return;
    }
    if (button.dataset.view) setView(button.dataset.view);
    if (button.dataset.action === 'accounts') setView('accounts');
    if (button.dataset.accountId) void openAccount(Number(button.dataset.accountId));
    if (button.dataset.sort) { const key = button.dataset.sort; state.direction = state.sort === key && state.direction === 'desc' ? 'asc' : 'desc'; state.sort = key; state.page = 1; renderAccounts(); }
    if (button.dataset.page && !button.disabled) changeAccountPage(button.dataset.page);
    if (button.dataset.metric) { state.metric = button.dataset.metric; renderTrend(); }
    if (button.dataset.detailMetric) changeDetailTrend(button.dataset.detailMetric);
    if (button.dataset.collectionFilter && !button.disabled) selectCollectionFilter(button.dataset.collectionFilter);
    if (button.dataset.classification) {
      state.classification = button.dataset.classification;
      clearLocalAccountFilters();
      setView('accounts');
      void load({ scopeOnly: true });
    }
    if (button.dataset.theme) {
      state.theme = button.dataset.theme;
      clearLocalAccountFilters();
      setView('accounts');
      void load({ scopeOnly: true });
    }
    if (button.hasAttribute('data-close-dialog')) void closeAccount();
    if (button.hasAttribute('data-retry-account') && state.detailId !== null) void openAccount(state.detailId);
    if (button.hasAttribute('data-retry-topics')) void loadTopics();
  });
  $('boardSelect').onchange = () => { state.board = $('boardSelect').value; clearLocalAccountFilters(); renderAppliedScope(); void load({ scopeOnly: true }); };
  $('accountDialog').addEventListener('cancel', event => { event.preventDefault(); void closeAccount(); });
  $('accountDialog').addEventListener('close', () => { if (!$('accountDialog').open && (detailTrigger || detailTriggerId !== null)) restoreAccountFocus(); });
  document.querySelector('.skip').addEventListener('click', event => { event.preventDefault(); $('main').focus(); });
  $('themeSelect').onchange = () => { state.theme = $('themeSelect').value; clearLocalAccountFilters(); renderAppliedScope(); void load({ scopeOnly: true }); };
  $('classificationSelect').onchange = () => { state.classification = $('classificationSelect').value; clearLocalAccountFilters(); renderAppliedScope(); void load({ scopeOnly: true }); };
  $('classificationMore').onclick = toggleCustomClassifications;
  $('clearScopeBtn').onclick = () => { state.board = ''; state.theme = 'all'; state.classification = 'all'; clearLocalAccountFilters(); renderAppliedScope(); void load({ scopeOnly: true }); };
  $('periodSelect').onchange = () => { state.period = $('periodSelect').value; state.page = 1; setupDates(); renderAppliedScope(); if (state.period !== 'custom') void load(); else updateCustomDateDraftNotice(); };
  $('applyDateBtn').onclick = () => void load(); $('refreshBtn').onclick = refreshSnapshot;
  $('adjustScopeButton').onclick = () => {
    $('filterDetails').open = true;
    $('adjustScopeButton').setAttribute('aria-expanded', 'true');
    ($('boardSelect').hidden ? $('periodSelect') : $('boardSelect')).focus?.({ preventScroll: true });
  };
  $('filterDetails').addEventListener('toggle', () => {
    $('adjustScopeButton').setAttribute('aria-expanded', String($('filterDetails').open));
  });
  $('accountModeSwitch').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const mode = event.key === 'Home' || event.key === 'ArrowLeft' ? 'operating' : 'roster';
    setAccountMode(mode, { focus: true });
  });
  $('compareToggle').onchange = () => {
    state.compare = $('compareToggle').checked; $('compareDates').hidden = !state.compare;
    if (state.compare && comparisonAuto) fillPreviousComparison();
    renderAppliedScope();
    notice(hasUnappliedScope() ? '日期或对比设置尚未应用；点击「应用」后生效，当前数据仍保持已应用范围。' : '对比设置与已应用范围一致；当前数据未改变。');
  };
  $('previousEqualPeriod').onclick = () => fillPreviousComparison({ remember: true });
  $('restoreComparison').onclick = restoreComparisonDraft;
  for (const id of ['compareStart', 'compareEnd']) $(id).oninput = () => { comparisonAuto = false; renderComparisonHint(); renderAppliedScope(); };
  for (const id of ['startDate', 'endDate']) $(id).oninput = () => {
    if (comparisonAuto) fillPreviousComparison();
    updateCustomDateDraftNotice();
    renderAppliedScope();
  };
  $('accountSearch').oninput = () => { state.query = $('accountSearch').value; state.page = 1; renderAccounts(); };
  $('platformSelect').onchange = () => { state.platform = $('platformSelect').value; state.page = 1; renderAccounts(); };
  $('enabledSelect').onchange = () => { state.enabled = $('enabledSelect').value; state.workflowTask = 'all'; state.page = 1; renderAccounts(); };
  for (const id of ['workflowMetric', 'accountWorkflowMetric']) $(id).onchange = () => selectWorkflow(state.workflowTask, $(id).value);
  $('collectionSelect').onchange = () => { state.collectionFilter = $('collectionSelect').value; state.page = 1; renderAccounts(); };
  $('exportButton').onclick = downloadCsv;
  $('loadRecentImportJobs').onclick = () => void loadRecentImportJobs();
  $('previewPastedAuthors').onclick = () => void handlePastedAuthors();
  $('pasteAuthorsText').oninput = invalidatePastedPreview;
  $('pasteAuthorsMode').onchange = () => { invalidatePastedPreview(); renderPasteAuthorsHelp(); };
  $('pasteAuthorsPlatform').onchange = invalidatePastedPreview;
  $('clearPastedAuthors').onclick = () => { $('pasteAuthorsText').value = ''; invalidatePastedPreview(); $('pasteAuthorsStatus').textContent = '粘贴内容已清空；已提交任务和监控资料均未删除。'; $('pasteAuthorsText').focus?.({ preventScroll: true }); };
  $('fileInput').onchange = () => void handleFile($('fileInput').files[0]);
  $('uploadDrop').ondragover = event => { event.preventDefault(); $('uploadDrop').classList.add('dragging'); };
  $('uploadDrop').ondragleave = () => $('uploadDrop').classList.remove('dragging');
  $('uploadDrop').ondrop = event => { event.preventDefault(); $('uploadDrop').classList.remove('dragging'); void handleFile(event.dataTransfer.files[0]); };
  $('authForm').onsubmit = async event => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try { state.session = await api('/api/auth/join', { method: 'POST', body: JSON.stringify({ displayName: data.get('displayName'), code: data.get('code') }) }); state.csrf = state.session.csrfToken || ''; clearInviteFragment(); $('authDialog').close(); await boot(); }
    catch (error) { $('authStatus').textContent = error.message; } finally { button.disabled = false; }
  };
  window.addEventListener('hashchange', () => {
    if (location.hash.slice(1) === state.view) return;
    if ($('accountDialog').open) void closeAccount({ fromHistory: true, instant: true, restorePosition: false });
    setView(location.hash.slice(1), { fromHistory: true });
  });
  window.addEventListener('popstate', restoreNavigation);
}
function readInviteCodeFromFragment(hash) {
  if (typeof hash !== 'string' || hash.length > 512) return null;
  const entries = hash.replace(/^#/, '').split('&').filter(part => part.startsWith('invite='));
  if (entries.length !== 1) return null;
  const encoded = entries[0].slice(7);
  if (encoded.length > 117) return null;
  try {
    const code = decodeURIComponent(encoded);
    return /^[a-f0-9]{4}(?:-[a-f0-9]{4}){7}$/i.test(code) ? code.toUpperCase() : null;
  } catch { return null; }
}
function initializeInviteFromFragment() {
  const code = readInviteCodeFromFragment(location.hash);
  if (code) $('authForm').elements.code.value = code;
}
function clearInviteFragment() {
  const url = new URL(location.href);
  const remaining = url.hash.slice(1).split('&').filter(part => !part.startsWith('invite='));
  if (remaining.join('&') === url.hash.slice(1)) return;
  url.hash = remaining.join('&');
  history.replaceState(history.state, '', url);
  initial.hash = url.hash;
}
async function boot() {
  document.dispatchEvent?.(new CustomEvent('mcn:import-review-session'));
  document.dispatchEvent?.(new CustomEvent('mcn:works-settings-session'));
  document.dispatchEvent?.(new CustomEvent('mcn:team-access-bind', { detail: { api, canManage: () => state.session?.user?.role === 'admin' } }));
  bindMasterRosterSession();
  $('userChip').textContent = state.session.user?.displayName || '已登录';
  $('fileInput').disabled = !canEdit();
  for (const id of ['pasteAuthorsMode', 'pasteAuthorsPlatform', 'pasteAuthorsText', 'previewPastedAuthors', 'clearPastedAuthors', 'loadRecentImportJobs']) if ($(id)) $(id).disabled = !canEdit();
  $('importSessionJobs').hidden = !canEdit();
  if (!canEdit()) $('uploadDrop').insertAdjacentHTML('afterend', '<p class="notice">你当前为只读成员，名单导入需要编辑权限。</p>');
  const view = initial.hash.slice(1) || 'overview'; setView(view, { renderData: false }); await load();
  await initializeCollectionRefresh();
  await startLiveSync();
}
async function init() {
  enhanceShell(); setupDates(); bind();
  try {
    if (location.protocol === 'file:') { location.replace('http://127.0.0.1:4188/'); return; }
    initializeInviteFromFragment();
    state.session = await api('/api/auth/session'); state.csrf = state.session.csrfToken || '';
    if (!state.session.authenticated) { $('authDialog').showModal(); $('connectionStatus').textContent = '等待登录'; return; }
    await boot();
  } catch (error) { notice(`无法连接后台：${error.message}。请检查当前网址的服务是否在线，然后刷新重试。`, true); $('connectionStatus').textContent = '连接失败'; }
}
void init();
