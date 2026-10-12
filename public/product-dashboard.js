import { escapeHtml } from './ui-safety.js';
import { businessDateKey, businessTimeZoneLabel, formatBusinessTimestamp, resolveBusinessTimeZone } from './business-time.js';

const METRICS = {
  followers: { label: '粉丝数', change: '粉丝净变化', color: '#5a8dff' },
  likes: { label: '累计点赞（当前）', change: '新增点赞', color: '#9b86f8' },
  estimatedPlays: { label: '新增估算播放', change: '新增点赞 × 100（可比账号）', color: '#e9af62' },
  posts: { label: '作品总数', change: '作品总数净变化', color: '#4ec8b2' },
};
const CHART_METRICS = { ...METRICS, estimatedPlays: { ...METRICS.estimatedPlays, label: '估算播放（新增）' }, publishedSamples: { label: '发布量（已收录）', color: '#55cbb1' } };
const $ = (selector) => document.querySelector(selector);
const esc = escapeHtml;
export const number = (value, signed = false, compact = false) => value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: compact ? 1 : 0, notation: compact && Math.abs(value) >= 10000 ? 'compact' : 'standard', signDisplay: signed ? 'exceptZero' : 'auto' }).format(value);
const percentage = (value) => value === null || value === undefined ? '暂无可比比例' : `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(2)}%`;
const tone = (value) => value === null || value === undefined ? 'muted' : value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
// Date input values are calendar labels, not instants in the browser's local zone.
const calendarDateKey = (date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
const isDeleted = (account) => account.lifecycle?.state === 'deleted' || account.status?.key === 'deleted';
const safeHomepage = (value) => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; } };
const platformName = (platform) => ({ douyin: '抖音', bilibili: 'B站', xiaohongshu: '小红书' })[platform] || platform || '未标注平台';

// Stable, order-independent identity for the latest topic observations. A
// same-day value change must invalidate the history request even when the
// selected calendar window did not change.
export function topicHistorySnapshotKey(targets = []) {
  return (Array.isArray(targets) ? targets : [])
    .filter((target) => target?.type === 'hashtag')
    .map((target) => [
      target.id,
      target.last_checked_at || '',
      target.last_status || '',
      target.latestHashtagQualityStatus || '',
      target.previousHashtagQualityStatus || '',
      target.latestHashtagParticipants ?? '',
      target.latestHashtagViews ?? '',
      target.latestHashtagParticipantsDelta ?? '',
      target.latestHashtagViewsDelta ?? '',
    ].map((value) => JSON.stringify(value)).join(':'))
    .sort()
    .join('|');
}

export function verifiedTopicLatestMetrics(historyTopic) {
  const get = (key) => {
    const metric = historyTopic?.latestKnown?.[key];
    return metric?.sourceVerified === true && metric.qualityStatus !== 'rejected' && metric.qualityStatus !== 'unverified'
      && Number.isSafeInteger(metric.value) && metric.value >= 0 ? metric : null;
  };
  return { participants: get('participants'), views: get('views') };
}

export function csvCell(value) {
  const text = typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : String(value ?? '').replace(/^[=+@\-\t\r]/, (char) => `'${char}`);
  return `"${text.replaceAll('"', '""')}"`;
}

export function validateDateRanges(values, { today = businessDateKey() } = {}) {
  const valid = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && calendarDateKey(new Date(`${value}T12:00:00Z`)) === value;
  for (const [start, end] of [[values.startDate, values.endDate], ...(values.compare ? [[values.comparisonStartDate, values.comparisonEndDate]] : [])]) {
    if (!valid(start) || !valid(end)) return '请填写完整、有效的起止日期。';
    if (start > end) return '开始日期不能晚于结束日期。';
    if (end > today) return '结束日期不能晚于今天。';
    if ((Date.parse(end) - Date.parse(start)) / 86400000 >= 366) return '每段时间最多选择 366 天。';
  }
  return '';
}

export function chartSvg(primary, comparison, metric, mode = 'value', compact = false) {
  if (metric === 'publishedSamples') mode = 'value';
  const chartLabel = metric === 'estimatedPlays' && mode === 'value' ? '累计估算播放（辅助）' : CHART_METRICS[metric].label;
  const key = mode === 'delta' ? `${metric}Delta` : metric;
  const sets = [primary || [], comparison || []];
  const reliabilityField = `${metric}${mode === 'delta' ? 'Delta' : ''}Reliable`;
  const values = sets.flatMap((points) => points
    .filter((point) => point[reliabilityField] !== false)
    .map((point) => point[key]))
    .filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)));
  if (!values.length) return `<div class="${compact ? 'product-spark-empty' : 'product-chart-empty'}">${compact ? '暂无趋势' : '所选时间内暂无这一指标的有效日数据。历史空白保留，不按 0 补齐。'}</div>`;
  const width = compact ? 100 : 1000;
  const height = compact ? 32 : 265;
  const left = compact ? 2 : 78;
  const right = compact ? 2 : 28;
  const top = compact ? 3 : 20;
  const bottom = compact ? 3 : 35;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = (max - min || Math.abs(max) * 0.05 || 1) * 0.15;
  const low = mode === 'value' ? Math.max(0, min - padding) : min - padding;
  const high = max + padding;
  const maxLength = Math.max(...sets.map((points) => points.length), 2);
  const x = (index) => left + index / (maxLength - 1) * (width - left - right);
  const y = (value) => top + (high - value) / (high - low) * (height - top - bottom);
  const grid = compact ? '' : Array.from({ length: 4 }, (_, index) => {
    const value = low + (high - low) * index / 3;
    return `<line x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}" class="product-chart__grid"/><text x="${left - 12}" y="${y(value) + 4}" text-anchor="end">${esc(number(value, false, true))}</text>`;
  }).join('');
  const paths = sets.map((points, setIndex) => {
    let start = true;
    let previousCohort;
    const cohortField = `${metric}${mode === 'delta' ? 'Delta' : ''}CohortKey`;
    const reliabilityField = `${metric}${mode === 'delta' ? 'Delta' : ''}Reliable`;
    let path = '';
    const dots = [];
    points.forEach((point, index) => {
      const value = point[key];
      if (value === null || value === undefined || !Number.isFinite(Number(value))) { start = true; return; }
      // A partial daily cohort is retained in the API for audit/export but is
      // deliberately not drawn as a matrix-wide point. This prevents a
      // failed/partial collection day from creating a fake spike or collapse.
      if (point[reliabilityField] === false) { start = true; return; }
      if (previousCohort !== undefined && point[cohortField] !== previousCohort) start = true;
      previousCohort = point[cohortField];
      path += `${start ? 'M' : 'L'}${x(index).toFixed(2)},${y(value).toFixed(2)} `;
      start = false;
      const count = point[`${metric}${mode === 'delta' ? 'ComparableCount' : 'ObservedCount'}`] ?? point.observedCount;
      dots.push(`<circle cx="${x(index)}" cy="${y(value)}" r="${compact ? 1.5 : 3.5}" fill="${setIndex ? '#d4aaee' : CHART_METRICS[metric].color}"><title>${esc(point.date)} · ${esc(chartLabel)} ${esc(number(value))}${count === undefined ? '' : ` · ${number(count)} 个账号${mode === 'delta' ? '可比' : '有值'}`}</title></circle>`);
    });
    return `<path d="${path}" fill="none" stroke="${setIndex ? '#d4aaee' : CHART_METRICS[metric].color}" stroke-width="${compact ? 1.6 : 2.5}" ${setIndex ? 'stroke-dasharray="7 5"' : ''}/>${dots.join('')}`;
  }).join('');
  const labels = compact ? '' : [0, Math.floor((maxLength - 1) / 2), maxLength - 1].map((index) => `<text x="${x(index)}" y="${height - 10}" text-anchor="${index === 0 ? 'start' : index === maxLength - 1 ? 'end' : 'middle'}">${comparison?.length ? `第 ${index + 1} 天` : esc(primary[index]?.date?.slice(5) || '')}</text>`).join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(chartLabel)}${metric === 'publishedSamples' ? '每日计数' : mode === 'delta' ? '每日净变化' : '每日总量'}趋势${comparison?.length ? '，两段时间按第几天对齐' : ''}" class="${compact ? 'product-spark' : 'product-chart'}">${grid}${paths}${labels}</svg>`;
}

const worksCoverageLabel = (coverage, evidence = null) => ({
  complete: evidence?.kind === 'verified-public-cursor-chain' ? '跨批次公开列表完整' : '本次列表完整返回', limited: '仅部分公开样本', retry: '本次样本未更新',
  unavailable: '当前作品不可用', unknown: '尚无观测记录',
})[coverage] || '尚无观测记录';

export function accountWorksSummary(observation, timeZone) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    return '<small>作品样本：尚无观测记录</small>';
  }
  const date = (value) => esc(formatBusinessTimestamp(value, { timeZone, empty: '未知' }));
  const chain = observation.coverageEvidence?.kind === 'verified-public-cursor-chain' ? observation.coverageEvidence : null;
  return `<small>作品样本：${esc(worksCoverageLabel(observation.coverage, chain))}${observation.carriedForward === true ? ' · 沿用历史' : ''}</small>${chain ? `<small>续页链去重 ${number(chain.uniquePublicPosts)} / 主页总数 ${number(chain.inventory)} · 跨时点校验</small>` : ''}<small>样本采集 ${date(observation.observedAt)}</small><small>样本内最近发布 ${date(observation.latestPublishedAt)}</small>${observation.signal?.key === 'inventory-changed-window-unchanged' ? '<small>主页作品数变化未在样本中体现 · 详情见作者</small>' : ''}`;
}

export function aggregateWorksObservationMarkup(observation, timeZone) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    return '<p class="product-note">作品样本覆盖：尚无观测记录；主页更新不代表样本已更新。</p>';
  }
  const date = (value) => esc(formatBusinessTimestamp(value, { timeZone, empty: '未知' }));
  return `<details class="product-works-evidence"><summary>作品样本已观测 ${number(observation.observedCount)}/${number(observation.total)}<small>最近一次采集 ${date(observation.latestObservedAt)}</small><small>样本内最近发布 ${date(observation.latestPublishedAt)}</small></summary><p>分母为全部启用账号；已观测不代表当日全量发布。${number(observation.completeCount)} 本次列表完整返回 / ${number(observation.limitedCount)} 部分样本 / ${number(observation.retryCount)} 本次未更新 / ${number(observation.unknownCount)} 未知 / ${number(observation.inactiveCount)} 已注销。</p><p>样本采集时间范围：${date(observation.oldestObservedAt)} 至 ${date(observation.latestObservedAt)}。板块内最近日期不代表每位作者都已更新。</p>${observation.signalCount > 0 ? `<p>${number(observation.signalCount)} 个账号主页作品数变化未在样本中体现，不能据此计算新发布数量。</p>` : ''}<p>统计截止 ${date(observation.asOf)}。${esc(typeof observation.reason === 'string' ? observation.reason : '')}0 已收录不等于 0 发布。</p></details>`;
}

function metricCards(summary, comparison, timeZone) {
  return `<div class="product-kpis">${Object.entries(METRICS).map(([key, descriptor]) => {
    const metric = summary?.metrics?.[key] || {};
    const other = comparison?.metrics?.[key];
    const headline = key === 'estimatedPlays' ? metric.delta : metric.value;
    const headlineTitle = key === 'estimatedPlays' ? '所选期间新增估算播放；累计点赞换算仅作辅助，不是平台真实播放' : number(metric.value);
    const quality = key === 'estimatedPlays' ? metric.deltaQuality : metric.valueQuality;
    const qualityText = quality?.status === 'partial' ? ` · 部分覆盖 ${number(quality.observedCount)}/${number(quality.enabledCount)}` : quality?.status === 'missing' ? ' · 暂无有效观测' : '';
    return `<article class="product-kpi product-kpi--${esc(key)}"><span>${descriptor.label}${key === 'estimatedPlays' ? '<i class="product-estimate">估算</i>' : ''}</span><strong class="product-kpi__value" title="${esc(headlineTitle)}">${number(headline, false, true)}</strong><p class="product-kpi__coverage">${key === 'estimatedPlays' ? '区间新增 · ' : '总量观测 '}${number(metric.observedCount || 0)}/${number(summary?.enabledCount || 0)}${metric.missingCount ? ` · ${number(metric.missingCount)} 缺失` : ''}${qualityText}</p><div class="product-kpi__change"><b class="is-${tone(metric.delta)}">${number(metric.delta, true, true)}</b><small>${percentage(metric.percent)}</small></div><p>${descriptor.change} · ${number(metric.comparableCount || 0)}/${number(summary?.enabledCount || 0)} 可比</p>${metric.firstInPeriodCount ? `<p>${number(metric.firstInPeriodCount)} 个账号从期内首次记录起算</p>` : ''}${other ? `<div class="product-kpi__comparison">对比段变化 <b class="is-${tone(other.delta)}">${number(other.delta, true, true)}</b><span>${percentage(other.percent)}</span><small>${number(other.comparableCount || 0)}/${number(comparison?.enabledCount || 0)} 可比</small></div>` : ''}</article>`;
  }).join('')}</div>`;
}

function publishedMetricCard(summary) {
  const metric = summary?.publishedSamples || {};
  return `<div class="product-kpis product-kpis--secondary"><article class="product-kpi product-kpi--published"><span>每日新增发布 <i class="product-estimate">已收录</i></span><strong title="${esc(number(metric.value))}">${number(metric.value, false, true)}</strong><p>当前所选区间合计 · 按作品真实发布时间</p><div class="product-kpi__change"><b>区间合计</b><small>已收录作品数</small></div><p>${esc(metric.reason || '只统计已收录作品，不等于完整投稿量。')}</p></article></div>`;
}

function summaryNote(summary) {
  const metric = summary?.metrics?.followers || {};
  return `${number(summary?.enabledCount || 0)} 个启用账号 · ${number(summary?.pausedCount || 0)} 个暂停 · ${number(summary?.inactiveCount)} 个主页已注销 · ${number(metric.gainedCount || 0)} 个涨粉 / ${number(metric.lostCount || 0)} 个掉粉 · ${number(metric.comparableCount || 0)} 个有可比数据`;
}

export function snapshotReadout(summary, boardLabel = '全部板块', scheduler = null, timeZone = '') {
  const followers = summary?.metrics?.followers || {};
  const likes = summary?.metrics?.likes || {};
  const plays = summary?.metrics?.estimatedPlays || {};
  const enabled = Number(summary?.enabledCount) || 0;
  const updated = Number(summary?.updatedCount);
  const stale = Number(summary?.staleCount);
  const runTargetCount = Number(scheduler?.scheduledTargetCount ?? scheduler?.currentRun?.targetCount);
  const runCompletedCount = Number(scheduler?.scheduledProfileCompletedTargetCount ?? scheduler?.scheduledCompletedTargetCount ?? scheduler?.currentRun?.completedCount);
  const todayIncomplete = Number.isFinite(runTargetCount) && runTargetCount > 0 && Number.isFinite(runCompletedCount) && runCompletedCount < runTargetCount;
  const updatedLabel = Number.isFinite(updated) ? `近36小时资料 ${number(updated)}/${number(enabled)}（有资料）` : '资料新鲜度待读取';
  const progressLabel = Number.isFinite(Number(scheduler?.scheduledProfileCompletedTargetCount)) ? '主页三项指标' : '今日采集';
  const staleLabel = todayIncomplete ? `${progressLabel} ${number(runCompletedCount)}/${number(runTargetCount)}，尚未完成（计划进行中）` : Number.isFinite(stale) && stale > 0 ? `${number(stale)} 个账号需要补采` : '当前没有逾期账号';
  const comparable = Number(followers.comparableCount) || 0;
  const statusValue = todayIncomplete ? '今日采集中' : Number.isFinite(updated) && updated > 0 ? `${Math.round((updated / Math.max(enabled, 1)) * 100)}% 新鲜` : comparable > 0 ? '历史可用' : Number.isFinite(updated) ? '待首次采集' : '—';
  const statusHint = todayIncomplete ? `${staleLabel} · 完成后自动保存` : comparable > 0 && Number.isFinite(updated) && updated === 0 ? '当前区间有可比历史；等待下一次自动采集（今日计划尚未写入新快照）' : staleLabel;
  const zoneLabel = timeZone ? businessTimeZoneLabel(timeZone) : '统计时区';
  return `<section class="product-readout" aria-label="${esc(boardLabel)}本期阅读摘要"><div class="product-readout__lead"><span class="product-kicker">先看结果 · ${esc(boardLabel)}</span><strong>本期${followers.delta == null ? '尚无可比涨跌' : followers.delta > 0 ? '整体上涨' : followers.delta < 0 ? '整体回落' : '基本持平'}</strong><p>${updatedLabel} · ${staleLabel} · ${number(comparable)}/${number(enabled)} 个账号可比</p><small class="product-readout__timezone">按 ${esc(zoneLabel)} 切日</small></div><div class="product-readout__item"><span>粉丝净变化</span><b class="is-${tone(followers.delta)}">${number(followers.delta, true, true)}</b><small>${number(followers.gainedCount)} 涨粉 · ${number(followers.lostCount)} 掉粉</small></div><div class="product-readout__item"><span>新增点赞</span><b class="is-${tone(likes.delta)}">${number(likes.delta, true, true)}</b><small>估算播放 ${number(plays.delta, true, true)}</small></div><div class="product-readout__item product-readout__item--status"><span>数据状态</span><b>${statusValue}</b><small>${statusHint}</small></div></section>`;
}

export function boardPulse(board) {
  const followers = board?.metrics?.followers || {};
  const comparable = Number(followers.comparableCount) || 0;
  const enabled = Number(board?.enabledCount) || 0;
  return `<div class="product-board-pulse"><span class="product-board-pulse__total">${number(board?.enabledCount)} 启用</span><span class="product-board-pulse__up">↑ ${number(followers.gainedCount)} 涨粉</span><span class="product-board-pulse__down">↓ ${number(followers.lostCount)} 掉粉</span><span class="product-board-pulse__coverage">${number(comparable)}/${number(enabled)} 可比</span></div>`;
}

export function topicSparkline(points, key) {
  const usable = (point) => point?.sourceVerified === true && point.qualityStatus !== 'unverified'
    && point.qualityStatus !== 'rejected' && point[key] !== null && point[key] !== undefined
    && point[key] !== '' && Number.isFinite(Number(point[key]));
  const values = points.filter(usable).map((point) => Number(point[key]));
  if (!values.length) return '<span class="product-topic-spark-empty">暂无有效趋势</span>';
  const min = Math.min(...values); const max = Math.max(...values); const pad = max === min ? 1 : (max - min) * .12;
  const x = (index) => points.length <= 1 ? 2 : 2 + index / (points.length - 1) * 116;
  const y = (value) => 30 - (value - (min - pad)) / ((max + pad) - (min - pad)) * 26;
  let path = ''; let previous = null;
  points.forEach((point, index) => {
    if (!usable(point)) { previous = null; return; }
    const value = Number(point[key]);
    path += `${previous === null ? 'M' : 'L'}${x(index).toFixed(1)},${y(value).toFixed(1)} `;
    previous = value;
  });
  return `<svg class="product-topic-spark" viewBox="0 0 120 34" role="img" aria-label="${esc(key === 'participants' ? '参与人数' : '播放量')}历史趋势"><path d="${path}" fill="none" stroke="${key === 'participants' ? '#77a8ff' : '#a790f4'}" stroke-width="1.8"/><title>${esc(number(values.at(-1), false, true))}</title></svg>`;
}

function topicPanel(state, esc, number, dateText) {
  const topics = (state.bootstrap?.targets || []).filter((target) => target.type === 'hashtag');
  const topicMode = state.bootstrap?.topicResolverMode === 'authenticated-topic-dedicated-profile';
  const history = state.topicHistory || {};
  const historyById = new Map((history.data?.topics || []).map((item) => [Number(item.id), item]));
  const topicMetric = (label, metric) => `<div class="product-topic-metric"><span>${label}</span><strong>${number(metric?.value, false, true)}</strong><small>${metric?.baselineDate ? `较 ${esc(metric.baselineDate)}（前一日）` : '前一日无可比值'} <b class="is-${tone(metric?.delta)}">${number(metric?.delta, true, true)}</b></small></div>`;
  const sparkline = topicSparkline;
  const historyMarkup = (topic) => {
    const item = historyById.get(Number(topic.id));
    const days = Number(history.days) || 30;
    if (history.loading && !item) return '<div class="product-topic-history product-topic-history--loading">正在读取已保存的 7 / 30 天历史…</div>';
    if (history.error && !item) return `<div class="product-topic-history product-topic-history--error">历史读取失败：${esc(history.error.message || '暂时无法读取')} <button type="button" class="text-button" data-topic-history-retry>重试</button></div>`;
    if (!item) return '<div class="product-topic-history product-topic-history--empty">暂无已保存历史；每日自动采集后会在此形成趋势。</div>';
    const visible = item.points || [];
    const observedDays = (key) => visible.filter((point) => point?.sourceVerified === true
      && point.qualityStatus !== 'unverified' && point.qualityStatus !== 'rejected'
      && point?.[key] !== null && point?.[key] !== undefined && Number.isFinite(Number(point[key]))).length;
    const participantsObserved = item.participantsObservedCount ?? observedDays('participants');
    const viewsObserved = item.viewsObservedCount ?? observedDays('views');
    const rows = visible.slice(-Math.min(30, visible.length)).map((point) => {
      const trusted = point.sourceVerified === true && point.qualityStatus !== 'unverified' && point.qualityStatus !== 'rejected';
      const hasParticipants = trusted && point.participants !== null && point.participants !== undefined && Number.isFinite(Number(point.participants));
      const hasViews = trusted && point.views !== null && point.views !== undefined && Number.isFinite(Number(point.views));
      const hasMetric = hasParticipants || hasViews;
      const bothMetrics = hasParticipants && hasViews;
      const warning = point.qualityStatus === 'warning';
      const hasStoredObservation = Boolean(point.capturedAt || point.snapshotId);
      const unverified = point.qualityStatus === 'unverified' || point.sourceVerified === false
        || (hasStoredObservation && point.sourceVerified !== true);
      const status = unverified ? '来源未核验 · 已排除'
        : point.qualityStatus === 'rejected' ? '已拒绝'
        : point.qualityStatus === 'missing' ? '缺采'
          : warning ? `需留意${hasMetric && !bothMetrics ? '（部分指标缺失）' : ''}`
            : bothMetrics ? '两项齐全' : hasMetric ? '部分指标缺失' : '无官方值';
      const statusKey = unverified ? 'unverified'
        : point.qualityStatus === 'rejected' ? 'rejected'
        : point.qualityStatus === 'missing' ? 'missing'
          : warning ? 'warning' : bothMetrics ? 'validated' : hasMetric ? 'partial' : 'missing-metrics';
      const participants = trusted ? point.participants : null;
      const participantsDelta = trusted ? point.participantsDelta : null;
      const views = trusted ? point.views : null;
      const viewsDelta = trusted ? point.viewsDelta : null;
      return `<tr><td>${esc(point.date.slice(5))}</td><td>${number(participants, false, true)}</td><td class="is-${tone(participantsDelta)}">${number(participantsDelta, true, true)}</td><td>${number(views, false, true)}</td><td class="is-${tone(viewsDelta)}">${number(viewsDelta, true, true)}</td><td><span class="product-topic-history-status product-topic-history-status--${esc(statusKey)}">${status}</span></td></tr>`;
    }).join('');
    return `<div class="product-topic-history"><div class="product-topic-history__head"><div><strong>历史趋势</strong><small>参与人数有值 ${number(participantsObserved)}/${number(visible.length)} 天 · 播放量有值 ${number(viewsObserved)}/${number(visible.length)} 天 · 已采样 ${number(item.sampledCount ?? item.observedCount ?? 0)} 天；缺口不补 0，也不跨缺口计算涨跌</small></div><div class="product-topic-history__actions"><button type="button" data-topic-history-days="7" class="${days === 7 ? 'active' : ''}">7天</button><button type="button" data-topic-history-days="30" class="${days === 30 ? 'active' : ''}">30天</button></div></div><div class="product-topic-history__sparks"><div><span>参与人数</span>${sparkline(visible, 'participants')}</div><div><span>播放量</span>${sparkline(visible, 'views')}</div></div><div class="product-topic-history__table"><table class="product-data-table"><thead><tr><th>日期</th><th>参与人数</th><th>日变化</th><th>播放量</th><th>日变化</th><th>状态</th></tr></thead><tbody>${rows || '<tr><td colspan="6">暂无历史记录</td></tr>'}</tbody></table></div></div>`;
  };
    return `<div class="product-heading"><div><p class="product-kicker">独立监控 · 不参与板块归类</p><h1>话题监控</h1><p>只呈现抖音话题参与人数、播放量及有相邻日期基线时的变化。</p></div><a class="product-status-link" href="#updates"><span class="product-status-dot"></span>每日自动更新 · 查看进度 →</a></div><section class="product-panel product-topic-panel"><div class="product-panel__head"><div><h2>话题数据面板</h2><p>后台会按带 <code>#</code> 的完整话题名检索，再用抖音官方话题详情复核；公开接口未返回时保持空值，不按 0 补齐。</p><small class="product-note">采集模式：${topicMode ? '一次授权后自动复用应用专用会话（账号监控仍走匿名公开 HTTP）' : '匿名公开链路；如需全网话题统计，请先完成一次管理员授权'}</small></div></div>${topics.length ? `<div class="product-topic-list">${topics.map((topic) => {
      const historyTopic = historyById.get(Number(topic.id));
      const verifiedMetrics = verifiedTopicLatestMetrics(historyTopic);
      const latestDate = [verifiedMetrics.participants?.date, verifiedMetrics.views?.date].filter(Boolean).sort().at(-1);
      const unverifiedSamples = Math.max(0, Number(historyTopic?.sampledCount || 0) - Number(historyTopic?.observedCount || 0));
      const note = history.loading && !historyTopic ? '正在读取来源验真的历史快照；读取完成前不显示未核验数字'
        : history.error && !historyTopic ? '历史来源校验暂不可用；未显示未核验数字'
        : topic.last_status === 'error' ? '本次采集失败，保留最近一条来源验真的历史观测'
        : unverifiedSamples ? `${unverifiedSamples} 条最近采样未通过来源核验，未计入指标${latestDate ? `；有效数据截至 ${latestDate}` : ''}`
        : latestDate ? `显示来源验真的平台历史值${latestDate ? `；有效数据截至 ${latestDate}` : ''}`
        : historyTopic?.sampledCount ? '已有采样记录，但没有可验证的平台指标，保持空值'
        : '尚无已验真的平台指标；缺测保持空值，不补 0';
      return `<article class="product-topic-card"><div><strong>${esc(topic.label)}</strong><small>抖音话题 · ${topic.enabled ? '监控中' : '已暂停'} · 最近采集尝试 ${esc(dateText(topic.last_checked_at))}</small></div><div class="product-topic-metrics">${topicMetric('参与人数', verifiedMetrics.participants)}${topicMetric('播放量', verifiedMetrics.views)}</div><span class="product-note">${esc(note)}</span>${historyMarkup(topic)}</article>`;
    }).join('')}</div>` : '<p class="product-empty-small">尚未添加话题目标。可在监控对象管理中新增话题标签。</p>'}</section>`;
}

export function createProductDashboard({ api, onAccount, onBoard, onImport, onSettings, onSource }) {
  // A just-opened week can be empty before the 10:00 Shanghai collection.
  // Start with the latest 30-day window so managers see saved history first,
  // then switch to today/week/month or the fixed 9/12 anchor explicitly.
  const state = { data: null, bootstrap: null, board: '__all__', range: { period: '30d' }, metric: 'followers', mode: 'delta', query: '', filter: 'enabled', classification: 'all', sort: 'followers', page: 0, size: 10, boardMemberPage: 0, boardMemberSize: 10, boardMemberSort: { key: 'followersValue', direction: 'desc' }, topicHistory: { loading: false, days: 7, data: null, dataKey: '', error: null, request: 0 }, request: 0, controller: null, currentPage: 'overview' };

  const boardMemberSorts = {
    followersValue: { label: '粉丝数', get: (account) => account.metrics?.followers?.value },
    followersDelta: { label: '粉丝净变化', get: (account) => account.metrics?.followers?.delta },
    likesDelta: { label: '点赞净变化', get: (account) => account.metrics?.likes?.delta },
    estimatedPlaysDelta: { label: '估算播放变化', get: (account) => account.metrics?.estimatedPlays?.delta },
    postsValue: { label: '作品总数', get: (account) => account.metrics?.posts?.value },
    postsDelta: { label: '作品净变化', get: (account) => account.metrics?.posts?.delta },
  };

  function sortBoardMembers(accounts) {
    const descriptor = boardMemberSorts[state.boardMemberSort.key] || boardMemberSorts.followersValue;
    const direction = state.boardMemberSort.direction === 'asc' ? 1 : -1;
    return [...accounts].sort((a, b) => {
      const av = descriptor.get(a);
      const bv = descriptor.get(b);
      const aMissing = av === null || av === undefined || !Number.isFinite(Number(av));
      const bMissing = bv === null || bv === undefined || !Number.isFinite(Number(bv));
      if (aMissing || bMissing) return aMissing === bMissing ? a.id - b.id : aMissing ? 1 : -1;
      return (Number(av) - Number(bv)) * direction || a.id - b.id;
    });
  }

  function boardMemberSortButton(label, key) {
    const active = state.boardMemberSort.key === key;
    const arrow = active ? (state.boardMemberSort.direction === 'asc' ? '↑' : '↓') : '↕';
    const nextDirection = active && state.boardMemberSort.direction === 'desc' ? '升序' : '降序';
    return `<button type="button" class="product-sort-button${active ? ' active' : ''}" data-board-member-sort="${esc(key)}" aria-label="按${esc(label)}${active ? `，当前${state.boardMemberSort.direction === 'asc' ? '升序' : '降序'}，点击切换${nextDirection}` : '排序'}">${esc(label)} <span aria-hidden="true">${arrow}</span></button>`;
  }

  function boardMembersPanel(accounts, summary) {
    const rows = sortBoardMembers(accounts);
    const total = rows.length;
    const pageCount = Math.max(1, Math.ceil(total / state.boardMemberSize));
    state.boardMemberPage = Math.min(state.boardMemberPage, pageCount - 1);
    const start = state.boardMemberPage * state.boardMemberSize;
    const pageRows = rows.slice(start, start + state.boardMemberSize);
    const descriptor = boardMemberSorts[state.boardMemberSort.key] || boardMemberSorts.followersValue;
    const direction = state.boardMemberSort.direction === 'asc' ? '升序' : '倒序';
    return `<section class="product-panel"><div class="product-panel__head"><div><h2>板块成员</h2><p>${summaryNote(summary)} · 点击任一指标表头切换正序 / 倒序，当前按${descriptor.label}${direction}。</p></div><a href="#targets">管理账号 →</a></div>${accountsTable(pageRows, { sortable: true })}<div class="product-pager"><span>${total ? `${start + 1}–${Math.min(start + state.boardMemberSize, total)}` : '0'} / ${number(total)} 个成员</span><div><button type="button" data-board-member-page="-1" ${state.boardMemberPage === 0 ? 'disabled' : ''}>上一页</button><span>第 ${state.boardMemberPage + 1} / ${pageCount} 页</span><button type="button" data-board-member-page="1" ${state.boardMemberPage + 1 >= pageCount ? 'disabled' : ''}>下一页</button></div></div></section>`;
  }

  function businessTimeZone() { return resolveBusinessTimeZone(state.bootstrap?.scheduler?.timeZone, state.bootstrap?.continuity?.timeZone, state.data?.timeZone); }
  const dateText = (value, zone = businessTimeZone()) => formatBusinessTimestamp(value, { timeZone: zone, empty: '暂无记录' });
  const dateKey = (date = new Date()) => businessDateKey(date, businessTimeZone());
  function topicHistoryBounds(days = state.topicHistory.days || 7) {
    const endDate = dateKey(new Date());
    const actualDays = Math.max(1, Math.min(30, Number(days) || 7));
    const start = new Date(`${endDate}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - actualDays + 1);
    return { startDate: calendarDateKey(start), endDate, days: actualDays };
  }
  // A calendar-day key alone is not enough for an open dashboard: the
  // scheduler can append a newer same-day snapshot while this page remains
  // mounted. Include the current topic observations in the request key so a
  // bootstrap refresh invalidates only the affected history window.
  function topicSnapshotKey() {
    return topicHistorySnapshotKey(state.bootstrap?.targets);
  }
  async function loadTopicHistory(days = state.topicHistory.days || 7, force = false) {
    const range = topicHistoryBounds(days);
    const key = `${range.startDate}:${range.endDate}:${topicSnapshotKey()}`;
    if (!force && state.topicHistory.dataKey === key && state.topicHistory.data) return;
    if (!force && state.topicHistory.dataKey === key && state.topicHistory.error) return;
    if (state.topicHistory.loading && state.topicHistory.dataKey === key) return;
    // Do not render a previous window under the new date/snapshot label while
    // its replacement is in flight. The request token below still protects
    // against an older response winning the race.
    if (state.topicHistory.dataKey !== key) state.topicHistory.data = null;
    state.topicHistory.days = range.days;
    state.topicHistory.dataKey = key;
    state.topicHistory.loading = true;
    state.topicHistory.error = null;
    const request = ++state.topicHistory.request;
    try {
      const data = await api(`/api/topics/history?days=${range.days}&startDate=${encodeURIComponent(range.startDate)}&endDate=${encodeURIComponent(range.endDate)}`);
      if (request !== state.topicHistory.request) return;
      state.topicHistory.data = data;
    } catch (error) {
      if (request !== state.topicHistory.request) return;
      state.topicHistory.error = error;
    } finally {
      if (request !== state.topicHistory.request) return;
      state.topicHistory.loading = false;
      if (state.currentPage === 'topics') render();
    }
  }
  function latestObservedDate() {
    const points = state.data?.summary?.trend || [];
    const valid = points.filter((point) => ['followers', 'likes', 'posts'].some((key) => point[key] !== null && point[key] !== undefined));
    return valid.at(-1)?.date || dateKey(new Date(state.data?.referenceAt || Date.now()));
  }
  function options() { return { ...state.range }; }
  function boardTitle() { return state.data?.boards?.find((board) => board.key === state.board)?.label || (state.board === '__unassigned__' ? '未分板块' : state.board === '__all__' || !state.board ? '全部板块' : state.board); }
  function drawControls() {
    const controlKey = JSON.stringify([state.range, state.data?.range?.startDate, state.data?.range?.endDate, businessTimeZone()]);
    if ($('#productDateForm') && state.controlsKey === controlKey) return;
    state.controlsKey = controlKey;
    const anchorActive = state.range.period === 'custom' && state.range.startDate === '2026-09-12';
    $('#productControls').innerHTML = `<form class="product-dates" id="productDateForm"><div class="product-presets" role="group" aria-label="快捷时间范围">${[['day', '今天'], ['week', '本周'], ['month', '本月'], ['30d', '近30天']].map(([key, name]) => `<button type="button" data-product-period="${key}" class="${state.range.period === key ? 'active' : ''}" aria-pressed="${state.range.period === key}">${name}</button>`).join('')}<button type="button" data-product-anchor="2026-09-12" class="${anchorActive ? 'active' : ''}" aria-pressed="${anchorActive}">9/12 起</button></div><div class="product-dates__range"><label><span>开始日期</span><input name="startDate" type="date" required value="${esc(state.data?.range?.startDate || state.range.startDate || dateKey(new Date()))}"></label><span>至</span><label><span>结束日期</span><input name="endDate" type="date" required value="${esc(state.data?.range?.endDate || state.range.endDate || dateKey(new Date()))}"></label></div><label class="product-compare-toggle"><input type="checkbox" name="compare" ${state.range.comparisonStartDate ? 'checked' : ''}>对比另一时段</label><div class="product-dates__range" id="productCompareDates" ${state.range.comparisonStartDate ? '' : 'hidden'}><label><span>对比开始</span><input name="comparisonStartDate" type="date" value="${esc(state.range.comparisonStartDate || '')}"></label><span>至</span><label><span>对比结束</span><input name="comparisonEndDate" type="date" value="${esc(state.range.comparisonEndDate || '')}"></label></div><button class="button button-quiet" type="submit">应用日期</button></form><p class="product-date-hint">日期按 ${esc(businessTimeZoneLabel(businessTimeZone()))} 切日。${state.range.period === 'custom' ? '区间变化＝结束日记录－开始日前一日记录；缺少端点或中间缺采时留空，不补 0。' : '卡片对应所选周期，曲线默认回看最近30日。'}${anchorActive ? ' 已选中 9 月 12 日起的管理区间。' : ''}</p>`;
  }

  function chartPanel(summary, comparison) {
    const trend = summary?.trend || [];
    const other = comparison?.trend || [];
    const actualRange = trend.length ? `${trend[0].date} — ${trend.at(-1).date}` : '暂无历史';
    const playbackMode = state.metric === 'estimatedPlays' ? 'delta' : state.mode;
    const playbackNote = state.metric === 'estimatedPlays' ? '<p class="product-note" style="padding:0 22px">播放只显示新增估算播放＝可比账号的新增点赞 × 100；累计点赞 × 100 仅是代理存量，不是抖音平台真实播放量。覆盖不足或缺采日保持空白。</p>' : '';
    return `<section class="product-panel product-trend"><div class="product-panel__head"><div><h2>每日数据趋势</h2><p>${esc(actualRange)}${other.length ? ` <span class="product-legend-comparison">对比 ${esc(other[0].date)} — ${esc(other.at(-1).date)}</span>` : ''}</p></div><div class="product-chart-modes"><button type="button" data-chart-mode="value" class="${state.mode === 'value' ? 'active' : ''}" ${state.metric === 'estimatedPlays' ? 'disabled title="播放只显示新增估算播放"' : ''}>每日总量</button><button type="button" data-chart-mode="delta" class="${playbackMode === 'delta' ? 'active' : ''}">每日变化</button></div></div><div class="product-metric-tabs" role="group" aria-label="曲线指标">${Object.entries(CHART_METRICS).map(([key, descriptor]) => `<button type="button" data-chart-metric="${key}" class="${state.metric === key ? 'active' : ''}" aria-pressed="${state.metric === key}">${descriptor.label}</button>`).join('')}</div>${playbackNote}${state.metric === 'publishedSamples' ? '<p class="product-note" style="padding:0 22px">仅按已收录作品的实际发布时间计数；截至所选区间结束已收录的作品才计入本期，之后才收录的不回填本期。不是完整投稿量，0条样本不代表当天没有发布。</p>' : ''}${chartSvg(trend, other, state.metric, playbackMode)}<div class="product-chart-foot"><span>${other.length ? '实线为当前时段，虚线为对比时段；按第几天对齐。' : '最近30日逐日取末次有效观测；自选日期显示所选范围。'} 缺失日、低覆盖日或观测账号集合不同不连线；人数变化不代表真实涨跌。</span><button type="button" class="text-button" data-export-daily>导出日数据 CSV</button></div><details class="product-daily"><summary>展开每天的精确数值与覆盖人数</summary>${dailyTable(trend, other)}</details></section>`;
  }

  function dailyTable(primary, comparison) {
    return `<div class="product-table-scroll"><table class="product-data-table"><thead><tr><th>时段 / 日期</th><th>粉丝数</th><th>每日涨跌</th><th>累计点赞</th><th>新增估算播放<br><small>点赞变化 × 100</small></th><th>作品总数</th><th>发布样本</th><th>有粉丝值 / 可比</th></tr></thead><tbody>${[[primary, '当前'], [comparison, '对比']].flatMap(([points, label]) => points.map((point) => `<tr><td>${label} · ${esc(point.date)}</td><td>${number(point.followers)}</td><td class="is-${tone(point.followersDelta)}">${number(point.followersDelta, true)}</td><td>${number(point.likes)}</td><td class="is-${tone(point.estimatedPlaysDelta)}" title="可比账号点赞净变化 × 100">${number(point.estimatedPlaysDelta, true)}</td><td>${number(point.posts)}</td><td>${number(point.publishedSamples)}</td><td>${number(point.followersObservedCount)} / ${number(point.followersComparableCount)}</td></tr>`)).join('') || '<tr><td colspan="8">暂无日快照</td></tr>'}</tbody></table></div>`;
  }

  function ranking(accounts, descending = true) {
    const rows = accounts.filter((account) => account.enabled && account.metrics.followers.delta !== null && (descending ? account.metrics.followers.delta > 0 : account.metrics.followers.delta < 0)).sort((a, b) => (descending ? -1 : 1) * (a.metrics.followers.delta - b.metrics.followers.delta)).slice(0, 5);
    return `<section class="product-panel"><div class="product-panel__head"><div><h2>${descending ? '涨粉排行' : '掉粉关注'}</h2><p>当前所选期间 · ${descending ? '增长最多' : '下降最多'}的账号</p></div><a href="#targets">全部账号 →</a></div><div class="product-rank">${rows.map((account, index) => `<button type="button" data-account="${account.id}"><span class="product-rank__number">${index + 1}</span><span class="product-rank__name"><strong>${esc(account.label)}</strong><small>${esc(platformName(account.platform))} · ${number(account.metrics.followers.value, false, true)} 粉丝</small></span><span class="product-rank__trend">${chartSvg(account.trend, [], 'followers', 'value', true)}</span><span class="product-rank__delta is-${tone(account.metrics.followers.delta)}"><b>${number(account.metrics.followers.delta, true)}</b><small>${percentage(account.metrics.followers.percent)}</small></span></button>`).join('') || '<p class="product-empty-small">本期暂无符合条件的可比账号，不用缺失值参与排名。</p>'}</div></section>`;
  }

  function boardsTable(boards, compact = false) {
    const rows = [...boards].sort((a, b) => b.enabledCount - a.enabledCount);
    return `<div class="product-table-scroll"><table class="product-data-table product-board-table"><thead><tr><th>板块</th><th>本期成员状态</th><th>启用 / 全部</th><th>粉丝数</th><th>粉丝净变化</th><th>点赞净变化</th>${compact ? '' : '<th>估算播放变化</th><th>作品净变化</th>'}<th>可比覆盖</th><th></th></tr></thead><tbody>${rows.map((board) => `<tr><td><button type="button" class="product-name-button" data-product-board="${esc(board.key)}">${esc(board.label || board.name)}</button><small class="product-table-subtitle">点击进入板块详情</small></td><td>${boardPulse(board)}</td><td>${number(board.enabledCount)} / ${number(board.memberCount)}</td><td>${number(board.metrics.followers.value, false, true)}</td><td class="is-${tone(board.metrics.followers.delta)} product-delta-cell">${number(board.metrics.followers.delta, true, true)}<small>${percentage(board.metrics.followers.percent)}</small></td><td class="is-${tone(board.metrics.likes.delta)} product-delta-cell">${number(board.metrics.likes.delta, true, true)}</td>${compact ? '' : `<td class="is-${tone(board.metrics.estimatedPlays.delta)} product-delta-cell">${number(board.metrics.estimatedPlays.delta, true, true)}</td><td class="is-${tone(board.metrics.posts.delta)} product-delta-cell">${number(board.metrics.posts.delta, true)}</td>`}<td><div class="product-coverage"><span>${number(board.metrics.followers.comparableCount || 0)}/${number(board.enabledCount)}</span><progress value="${board.metrics.followers.comparableCount || 0}" max="${Math.max(board.enabledCount, 1)}"></progress></div></td><td><button type="button" class="text-button" data-product-board="${esc(board.key)}">查看 →</button></td></tr>`).join('')}</tbody></table></div>`;
  }

  function renderOverview() {
    const data = state.data;
    $('#overview').innerHTML = `<div class="product-heading"><div><p class="product-kicker">${esc(boardTitle())}</p><h1>数据总览</h1><p>${summaryNote(data.summary)}</p></div><a class="product-status-link" href="#updates"><span class="product-status-dot"></span>每日自动更新 · 查看进度 →</a></div>${snapshotReadout(data.summary, boardTitle(), state.board === '__all__' ? state.bootstrap?.scheduler : null, businessTimeZone())}${classificationPanel(data)}${metricCards(data.summary, data.comparison?.summary)}${publishedMetricCard(data.summary)}${chartPanel(data.summary, data.comparison?.summary)}<div class="product-two-col">${ranking(data.accounts, true)}${ranking(data.accounts, false)}</div><section class="product-panel"><div class="product-panel__head"><div><h2>板块表现</h2><p>先看成员状态和涨跌，再进入板块查看每个账号的明细。独立查看每个板块；全部板块按账号去重汇总。</p></div><a href="#boards">板块分析 →</a></div>${boardsTable(data.boards, true)}</section>${methodology()}`;
  }

  function classificationPanel(data) {
    const summary = data.classificationSummary || { total: data.accounts?.length || 0, classified: 0, unclassified: data.accounts?.length || 0, items: [] };
    const items = (summary.items || []).filter((item) => item.key !== 'all');
    const standard = items.filter((item) => !item.key.startsWith('custom:'));
    const custom = items.filter((item) => item.key.startsWith('custom:') && item.count > 0).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'zh-CN'));
    const visibleItems = [...standard, ...custom].filter((item) => item.count > 0 || item.key === 'unclassified').slice(0, 12);
    const cards = visibleItems.map((item) => `<button type="button" class="product-classification-card product-classification-card--${esc(item.color || 'slate')}" data-classification-pick="${esc(item.key)}"><strong>${number(item.count)}</strong><span>${esc(item.label)}</span><small>${summary.total ? Math.round(item.count / summary.total * 100) : 0}% · 查看明细 →</small></button>`).join('');
    const extraCount = Math.max(0, items.filter((item) => item.count > 0).length - visibleItems.filter((item) => item.count > 0).length);
    return `<section class="product-panel product-classification-panel"><div class="product-panel__head"><div><p class="product-kicker">自动归类 · 可解释规则</p><h2>作者内容分类</h2><p>当前范围内 ${number(summary.total)} 个已进入监控的作者，支持多标签；分类优先读取表格分类、板块和来源，不凭昵称强猜。待核验名单仍单独保留。</p></div><a href="#targets">查看全部作者 →</a></div><div class="product-classification-grid">${cards || '<p class="product-empty-small">当前范围还没有可用分类标签。</p>'}</div><div class="product-classification-foot"><span>已自动归类 ${number(summary.classified)} · 待分类 ${number(summary.unclassified)}${extraCount ? ` · 另有 ${number(extraCount)} 个自定义标签可在作者管理中筛选` : ''}</span><small>点击任一分类进入作者明细；作者可能同时属于多个分类。</small></div></section>`;
  }

  function methodology() {
    return '<details class="product-method"><summary>数据口径与历史保存说明</summary><p>总量取截止日期前最后已保存快照，变化只使用有效的起止证据；每项“可比人数”可能不同。期内首次建档不代表完整期间增长。历史缺失日不填 0，暂停账号不进入当前汇总。板块成员按当前归属回看历史，不代表历史时点的成员名单。</p><p>估算播放＝累计点赞 × 100；估算播放变化＝点赞净变化 × 100，不是平台实测播放。累计换算只作辅助存量，主读数使用可比账号的新增点赞 × 100；低覆盖日不作为矩阵总量。作品总数净变化可能受删除、隐藏影响；发布样本数只计算已收录且有真实发布时间的作品，不冒充完整投稿数。截至所选区间结束已收录的作品才计入本期，之后才收录的不回填本期。</p><p>快照由后台追加保存，关闭网页不影响后台；电脑休眠、断网或平台未返回数据时会留下缺口，恢复后补采不能还原从未采到的历史。</p></details>';
  }

  function renderBoards() {
    const data = state.data;
    $('#boards').innerHTML = `<div class="product-heading"><div><p class="product-kicker">分组管理与对比</p><h1>${state.board === '__all__' ? '板块分析' : esc(boardTitle())}</h1><p>${summaryNote(data.summary)}</p></div><button class="button button-quiet" type="button" data-product-import>更新本板块名单</button></div>${snapshotReadout(data.summary, boardTitle(), state.board === '__all__' ? state.bootstrap?.scheduler : null, businessTimeZone())}${state.board !== '__all__' ? metricCards(data.summary, data.comparison?.summary) + publishedMetricCard(data.summary) + chartPanel(data.summary, data.comparison?.summary) : ''}<section class="product-panel"><div class="product-panel__head"><div><h2>所有板块</h2><p>每行先看启用、涨粉、掉粉和可比覆盖；点击板块名称查看具体成员。空板块保留，不混入其他作者。</p></div></div>${boardsTable(data.boards)}</section>${state.board !== '__all__' ? boardMembersPanel(data.accounts, data.summary) : ''}${methodology()}`;
  }

  function renderTopics() {
    $('#topics').innerHTML = `${topicPanel(state, esc, number, dateText)}${methodology()}`;
  }

  function accountsTable(accounts, { sortable = false } = {}) {
    const header = (label, key) => sortable ? `<th scope="col">${boardMemberSortButton(label, key)}</th>` : `<th scope="col">${label}</th>`;
    return `<div class="product-table-scroll"><table class="product-data-table product-accounts-table"><thead><tr><th scope="col">作者 / 账号</th>${header('粉丝数', 'followersValue')}${header('粉丝净变化', 'followersDelta')}${header('点赞净变化', 'likesDelta')}${header('估算播放变化', 'estimatedPlaysDelta')}${header('作品总数', 'postsValue')}${header('作品净变化', 'postsDelta')}<th scope="col">粉丝趋势</th><th scope="col">资料 / 状态</th></tr></thead><tbody>${accounts.map((account) => {
      const metrics = account.metrics;
      const status = isDeleted(account) ? '官方主页显示已注销' : !account.enabled ? '已暂停' : account.status?.label || (metrics.followers.value === null ? '尚无资料' : '监控中');
      const freshness = metrics.followers.currentAt ? dateText(metrics.followers.currentAt, businessTimeZone(), { dateStyle: 'short' }) : '暂无资料';
      // Keep one primary account state. Works coverage is a separate sample
      // state below, so a usable historical profile cannot read as both
      // "已更新" and "更新待重试" in the same cell.
      const dataState = account.status?.stale
        ? '主页资料偏旧'
        : metrics.followers.currentAt ? '主页有记录' : '主页待首次采集';
      const worksState = worksCoverageLabel(account.worksObservation?.coverage, account.worksObservation?.coverageEvidence);
      const classification = account.classification || {};
      const chips = (classification.labels || []).map((item) => `<span class="product-classification-chip product-classification-chip--${esc(item.color || 'slate')}" title="${esc(`置信度 ${Math.round(Number(item.confidence || 0) * 100)}%`)}">${esc(item.label)}</span>`).join('') || '<span class="product-classification-chip product-classification-chip--slate">待分类</span>';
      return `<tr><td class="product-account-cell"><button class="product-author" type="button" data-account="${account.id}"><span class="product-initial">${esc([...account.label][0] || '账')}</span><span><strong>${esc(account.label)}</strong><small>${esc(platformName(account.platform))}${account.publicId ? ` · ${esc(account.publicId)}` : ''}</small></span></button><div class="product-classification-chips">${chips}</div><div class="product-author-meta"><span class="product-freshness product-freshness--${account.status?.stale ? 'stale' : metrics.followers.currentAt ? 'fresh' : 'missing'}"><i></i>${dataState}</span><span>最后资料 ${esc(freshness)}</span></div>${safeHomepage(account.profileUrl) ? `<a class="text-button product-homepage" href="${esc(safeHomepage(account.profileUrl))}" target="_blank" rel="noopener noreferrer">作者主页 ↗</a>` : ''}</td><td class="product-value-cell"><strong>${number(metrics.followers.value, false, true)}</strong></td><td class="is-${tone(metrics.followers.delta)} product-delta-cell" title="${esc(metrics.followers.reason || metrics.followers.comparisonLabel || '')}"><strong>${number(metrics.followers.delta, true)}</strong><small>${percentage(metrics.followers.percent)}</small></td><td class="is-${tone(metrics.likes.delta)} product-delta-cell"><strong>${number(metrics.likes.delta, true, true)}</strong></td><td class="is-${tone(metrics.estimatedPlays.delta)} product-delta-cell"><strong>${number(metrics.estimatedPlays.delta, true, true)}</strong></td><td class="product-value-cell"><strong>${number(metrics.posts.value)}</strong></td><td class="is-${tone(metrics.posts.delta)} product-delta-cell"><strong>${number(metrics.posts.delta, true)}</strong></td><td>${chartSvg(account.trend, [], 'followers', 'value', true)}</td><td><span class="product-account-status ${!account.enabled ? 'muted' : ''}">${esc(status)}</span><small>粉丝记录 ${esc(dateText(metrics.followers.currentAt))}</small><small class="product-works-status">作品样本 · ${esc(worksState)}</small>${isDeleted(account) ? `<small>状态检查 ${esc(dateText(account.lifecycle?.observedAt))}</small><small>监控设置：${account.enabled ? '启用（每天复查主页）' : '已暂停'}</small>` : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="9"><div class="product-empty-small">没有符合条件的账号。尝试切换筛选，或上传这个板块的名单。</div></td></tr>'}</tbody></table></div>`;
  }

  function filteredAccounts() {
    return state.data.accounts.filter((account) => (!state.query || `${account.label} ${account.publicId} ${account.submittedName || ''} ${account.submittedAccountId || ''} ${account.platform} ${(account.boards || []).map((board) => typeof board === 'string' ? board : board.label || board.name).join(' ')}`.toLowerCase().includes(state.query.toLowerCase())) && (state.classification === 'all' || account.classification?.primaryKey === state.classification || account.classification?.labels?.some((item) => item.key === state.classification)) && (state.filter === 'all' || (state.filter === 'enabled' ? account.enabled : state.filter === 'paused' ? !account.enabled : state.filter === 'deleted' ? isDeleted(account) : state.filter === 'gained' ? account.metrics.followers.delta > 0 : state.filter === 'lost' ? account.metrics.followers.delta < 0 : state.filter === 'missing' ? account.metrics.followers.delta === null : account.platform === state.filter))).sort((a, b) => {
      if (state.sort === 'name') return a.label.localeCompare(b.label, 'zh-CN');
      const key = state.sort === 'likes' ? 'likes' : 'followers';
      const field = ['gained', 'lost'].includes(state.sort) ? 'delta' : 'value';
      const av = a.metrics[key][field];
      const bv = b.metrics[key][field];
      if (av === null) return bv === null ? a.id - b.id : 1;
      if (bv === null) return -1;
      return (state.sort === 'lost' ? 1 : -1) * (av - bv) || a.id - b.id;
    });
  }

  function renderAccounts() {
    const active = document.activeElement;
    const searchFocused = active?.id === 'productAccountSearch';
    const selection = searchFocused ? [active.selectionStart, active.selectionEnd] : null;
    const rows = filteredAccounts();
    state.page = Math.min(state.page, Math.max(0, Math.ceil(rows.length / state.size) - 1));
    const classOptions = (state.data.classificationCatalog || []).map((item) => `<option value="${esc(item.key)}" ${state.classification === item.key ? 'selected' : ''}>${esc(item.label)}</option>`).join('');
    $('#targets').innerHTML = `<div class="product-heading"><div><p class="product-kicker">${esc(boardTitle())}</p><h1>账号管理 <span>${number(rows.length)}</span></h1><p>先看全部，再按内容分类细分；点击作者查看完整资料、每日曲线和来源。分类由表格、板块和来源证据自动生成。</p></div><button class="button button-primary" type="button" data-product-import>上传 / 更新名单</button></div><section class="product-panel"><div class="product-account-toolbar"><label class="product-search"><span>搜索账号</span><input id="productAccountSearch" aria-label="搜索作者、账号或板块" type="search" placeholder="作者名称、账号 ID、板块" value="${esc(state.query)}"></label><label><span>内容分类</span><select id="productAccountClassification">${classOptions}</select></label><label><span>显示范围</span><select id="productAccountFilter">${[['enabled', '启用监控'], ['all', '全部状态'], ['paused', '已暂停'], ['deleted', '主页已注销'], ['gained', '涨粉账号'], ['lost', '掉粉账号'], ['missing', '缺少可比数据'], ['douyin', '抖音'], ['bilibili', 'B站'], ['xiaohongshu', '小红书']].map(([value, label]) => `<option value="${value}" ${state.filter === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label><span>排序</span><select id="productAccountSort">${[['followers', '粉丝最多'], ['gained', '涨粉最多'], ['lost', '掉粉最多'], ['likes', '累计点赞最多'], ['name', '作者名称']].map(([value, label]) => `<option value="${value}" ${state.sort === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><button type="button" class="text-button" data-export-accounts>导出当前列表</button></div>${accountsTable(rows.slice(state.page * state.size, (state.page + 1) * state.size))}<div class="product-pager"><span>${rows.length ? `${state.page * state.size + 1}–${Math.min((state.page + 1) * state.size, rows.length)}` : '0'} / ${number(rows.length)} 个账号</span><div><button type="button" data-page-step="-1" ${state.page === 0 ? 'disabled' : ''}><span class="sr-only">上一页</span></button><span>第 ${state.page + 1} 页</span><button type="button" data-page-step="1" ${(state.page + 1) * state.size >= rows.length ? 'disabled' : ''}><span class="sr-only">下一页</span></button></div></div></section>${methodology()}`;
    if (searchFocused) { $('#productAccountSearch').focus(); $('#productAccountSearch').setSelectionRange(...selection); }
  }

  function renderUpdates() {
    const bootstrap = state.bootstrap;
    if (!bootstrap) return;
    const scheduler = bootstrap.scheduler || {};
    const schedulerZone = resolveBusinessTimeZone(scheduler.timeZone, businessTimeZone());
    const continuity = bootstrap.continuity;
    const live = scheduler.currentRun;
    const summary = state.data?.summary;
    const batch = bootstrap.automaticRuns?.latestBatch || bootstrap.automation?.latestBatch;
    const profileCompleted = Number(scheduler.scheduledProfileCompletedTargetCount);
    const coreProgress = Number.isFinite(profileCompleted)
      ? `主页三项指标 ${number(profileCompleted)}/${number(scheduler.scheduledTargetCount)}${Number(scheduler.scheduledWorksDeferredTargetCount) > 0 ? ` · ${number(scheduler.scheduledWorksDeferredTargetCount)} 个作品接口延后至下次` : ''}`
      : `${number(scheduler.scheduledCompletedTargetCount)} 份自动指标`;
    const updateMarkup = `<div class="product-heading"><div><p class="product-kicker">名单维护 · 每日留档</p><h1>导入与更新</h1><p>维护名单与查看自动任务在这里完成。更新名单会复用已有账号，保留历史和暂停状态。</p></div></div><div class="product-two-col"><section class="product-panel product-update-card"><span class="product-kicker">后台自动采集</span><h2>${live ? '正在更新数据' : '每日自动保存，网页无需常开'}</h2><p>当前计划：每天 ${esc(scheduler.scheduleTime || '10:00')} · ${esc(businessTimeZoneLabel(schedulerZone))}</p><div class="product-update-next"><span>下次更新 · ${esc(businessTimeZoneLabel(schedulerZone))}</span><strong>${esc(dateText(scheduler.nextRunAt, schedulerZone))}</strong>${schedulerZone === 'Asia/Shanghai' ? '' : `<small>北京时间 ${esc(dateText(scheduler.nextRunAt, 'Asia/Shanghai'))}</small>`}</div>${scheduler.scheduledTargetCount !== null && scheduler.scheduledTargetCount !== undefined ? `<p>今日当前名单 ${number(scheduler.scheduledTargetCount)}：${coreProgress}、${number(scheduler.scheduledInactiveTargetCount)} 个注销复查、${number(scheduler.scheduledPendingTargetCount)} 个待补采${scheduler.scheduledExhaustedTargetCount > 0 ? `、${number(scheduler.scheduledExhaustedTargetCount)} 个达到重试上限` : ''}。${scheduler.scheduledManualTargetCount > 0 ? `${number(scheduler.scheduledManualTargetCount)} 条当时身份未通过记录，当前状态以账号详情为准。` : ''}</p>` : ''}${live ? `<progress max="${Math.max(live.targetCount || 1, 1)}" value="${live.completedCount || 0}"></progress><p>本批 ${number(live.completedCount || 0)}/${number(live.targetCount)} 已处理 · ${number(live.successCount || 0)} 成功</p>` : ''}<p id="productContinuitySummary">${batch ? `最近完整批次 ${esc(dateText(batch.finished_at, schedulerZone))} · ${number(batch.success_count)}/${number(batch.target_count)} 成功` : '全量计划覆盖与历史批次见数据检查；单账号补采不等于完成整批。'}</p><button type="button" class="text-button" data-product-settings>调整采集设置 →</button></section><section class="product-panel product-update-card"><span class="product-kicker">历史与数据完整性</span><h2>${esc(boardTitle())}</h2><div class="product-update-stats"><div><strong>${number(summary?.enabledCount)}</strong><span>启用账号</span></div><div><strong>${number(summary?.updatedCount)}</strong><span>最近36h有资料</span></div><div><strong>${number(summary?.staleCount)}</strong><span>超过36h未更新（不含注销）</span></div><div><strong>${number(summary?.inactiveCount)}</strong><span>主页已注销 · 保留历史</span></div></div><p>四项数据按采集时间追加保存；缺少点赞时估算播放也留空。不会覆盖旧日数据，也不会回填并不存在的快照。</p><a class="text-button" href="#audit">查看数据检查与自动备份 →</a></section></div><section class="product-panel product-import-guide"><div><h2>更新一份名单，只需三步</h2><p>选择表格或飞书链接 → 核对作者与所属板块 → 确认提交。旧账号自动去重，新账号加入监控，冲突单独提示。</p><small>再次上传不会删除本次缺席的旧账号，不会自动恢复已暂停账号。飞书来源目前按所选工作表读取，不会静默读取其他工作表。</small></div></section>${sourceCards(bootstrap.authorSources || [])}`;
    $('#productUpdates').innerHTML = updateMarkup;
    renderContinuity();
    enforcePermissions();
  }

  function renderContinuity() {
    const continuity = state.bootstrap?.continuity;
    if (continuity) {
      const plan = continuity.latestPlan;
      if (plan) $('#productContinuitySummary').innerHTML = `最近日计划 ${esc(plan.date)}（历史实际任务范围）：<strong>${number(plan.completedTargetCount)}/${number(plan.targetCount)} 个目标取得新指标</strong>${plan.denominatorComplete ? '' : plan.running ? '（批次进行中，目标记录尚未齐）' : '（历史分母记录不完整）'}，${number(plan.inactiveTargetCount)} 个已注销并检查状态、${number(plan.manualTargetCount)} 条当时身份未通过记录、${number(plan.retryTargetCount)} 个当时待补采。${number(plan.runCount)} 个批次含重试，不重复算人数；当前名单进度见上方，账号当前状态以详情为准。`;
      $('#productUpdates').insertAdjacentHTML('beforeend', `<section class="product-panel"><div class="product-panel__head"><div><h2>四项数据更新情况 · 全部启用账号</h2><p>新鲜≤24小时，偏旧24–72小时，过期&gt;72小时；已注销单列，五类合计等于全部启用账号。注销保留历史值，不当作新指标成功。</p></div><span class="product-note">${continuity.schedulerReady ? '后台时钟正常' : '后台时钟需检查'}</span></div><div class="product-table-scroll"><table class="product-data-table"><thead><tr><th>指标</th><th>新鲜</th><th>偏旧</th><th>过期</th><th>缺失</th><th>主页已注销</th><th>最后记录</th></tr></thead><tbody>${Object.entries(METRICS).map(([key, metric]) => { const value = continuity.freshness?.metrics?.[key] || {}; return `<tr><td>${metric.label}</td><td>${number(value.freshCount)}</td><td>${number(value.agingCount)}</td><td class="${value.staleCount ? 'is-down' : ''}">${number(value.staleCount)}</td><td>${number(value.missingCount)}</td><td>${number(value.inactiveCount)}</td><td>${esc(dateText(value.latestAt, resolveBusinessTimeZone(continuity.timeZone, businessTimeZone())))}</td></tr>`; }).join('')}</tbody></table></div><p class="product-note" style="padding:0 22px">自动备份：${continuity.backup?.status === 'ok' ? '检查通过' : '需检查'} · 日期按 ${esc(businessTimeZoneLabel(resolveBusinessTimeZone(continuity.timeZone, businessTimeZone())))} 切日。</p></section>`);
    }
  }

  function sourceCards(sources) {
    return sources.length ? `<section class="product-panel"><div class="product-panel__head"><h2>已导入的飞书来源</h2><p>读取新版本后仍先预览，不直接覆盖。</p></div>${sources.map((source, index) => `<div class="product-source"><div><strong>${esc(source.title || source.fileName || '飞书名单')}</strong><small>${esc(source.sheetName || '')} · ${esc(source.defaultBoard || '表内板块')} · 上次读取 ${esc(dateText(source.readAt))}</small></div><button type="button" class="button button-quiet" data-source-index="${index}">读取最新版本</button></div>`).join('')}</section>` : '';
  }

  function route() {
    state.currentPage = ['overview', 'boards', 'topics', 'targets', 'updates', 'reports', 'audit'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
    document.querySelectorAll('[data-product-page]').forEach((page) => { page.hidden = page.id !== state.currentPage; });
    $('#productControls').hidden = !['overview', 'boards', 'targets'].includes(state.currentPage);
    $('#productScope').hidden = state.currentPage === 'topics';
  }

  function enforcePermissions() {
    document.querySelectorAll('[data-product-import], [data-source-index]').forEach((element) => { element.hidden = !state.bootstrap?.auth?.permissions?.edit; });
    document.querySelectorAll('[data-product-settings]').forEach((element) => { element.hidden = !state.bootstrap?.auth?.permissions?.administer; });
  }

  function render() {
    const active = document.activeElement;
    const focusId = active?.id;
    const focusData = ['data-chart-metric', 'data-chart-mode', 'data-page-step', 'data-board-member-sort', 'data-board-member-page'].find((key) => active?.hasAttribute?.(key));
    const focusValue = focusData && active.getAttribute(focusData);
    route();
    renderUpdates();
    if (!state.data) return;
    if (state.currentPage === 'topics') loadTopicHistory(state.topicHistory.days);
    renderOverview(); renderBoards(); renderTopics(); renderAccounts();
    document.querySelectorAll('[data-chart-mode]').forEach((button) => { button.hidden = state.metric === 'publishedSamples'; });
    enforcePermissions();
    if (focusId && !active.isConnected) document.getElementById(focusId)?.focus({ preventScroll: true });
    else if (focusData) $(`#${state.currentPage} [${focusData}="${CSS.escape(focusValue)}"]`)?.focus({ preventScroll: true });
  }

  async function load({ bootstrap, board, force = false } = {}) {
    let topicBootstrapChanged = false;
    if (bootstrap) {
      const nextTopicKey = topicHistorySnapshotKey(bootstrap.targets);
      topicBootstrapChanged = Boolean(state.topicBootstrapKey) && state.topicBootstrapKey !== nextTopicKey;
      state.topicBootstrapKey = nextTopicKey;
      state.bootstrap = bootstrap;
    }
    const changed = board !== undefined && board !== state.board;
    if (board !== undefined) state.board = board;
    if (changed) {
      state.page = 0;
      state.boardMemberPage = 0;
      state.data = null;
      for (const id of ['overview', 'boards', 'targets']) $(`#${id}`).innerHTML = '<div class="product-loading">正在读取这个板块的数据…</div>';
    }
    route();
    renderUpdates();
    enforcePermissions();
    if (!force && !changed && state.data) {
      // Bootstrap can be refreshed independently of the heavier insights
      // request. Re-render the topic page immediately so same-day snapshots
      // invalidate its history cache without requiring a 7/30-day toggle.
      if (topicBootstrapChanged && state.currentPage === 'topics') render();
      return;
    }
    state.controller?.abort();
    state.controller = new AbortController();
    const request = ++state.request;
    const params = new URLSearchParams(state.range);
    if (state.board !== '__all__') params.set('board', state.board);
    $('#productFeedback').innerHTML = '<span class="product-fetching">正在读取已保存数据…</span>';
    document.querySelectorAll('[data-product-page]').forEach((page) => page.setAttribute('aria-busy', 'true'));
    try {
      const data = await api(`/api/insights?${params}`, { signal: state.controller.signal });
      if (request !== state.request) return;
      const signature = JSON.stringify([state.board, state.range, data.timeZone, data.summary, data.boards, data.accounts, data.comparison?.summary, data.comparison?.accounts]);
      const unchanged = state.signature === signature;
      state.signature = signature;
      state.data = data;
      $('#productFeedback').innerHTML = '';
      drawControls();
      if (!unchanged || changed || topicBootstrapChanged) render();
    } catch (error) {
      if (error.name === 'AbortError' || request !== state.request) return;
      $('#productFeedback').innerHTML = `<div class="product-error">本次数据读取失败：${esc(error.message)}。${state.data ? '下方保留上次结果，请勿将其视为新结果。' : ''}<button type="button" class="text-button" data-product-retry>重新读取</button></div>`;
    } finally {
      if (request === state.request) document.querySelectorAll('[data-product-page]').forEach((page) => page.setAttribute('aria-busy', 'false'));
    }
  }

  function exportCsv(rows, name) {
    const blob = new Blob(['\ufeff', rows.map((row) => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `${name}-${dateKey(new Date())}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.boardMemberSort) {
      const key = button.dataset.boardMemberSort;
      if (state.boardMemberSort.key === key) state.boardMemberSort.direction = state.boardMemberSort.direction === 'desc' ? 'asc' : 'desc';
      else state.boardMemberSort = { key, direction: 'desc' };
      state.boardMemberPage = 0;
      render();
      return;
    }
    if (button.dataset.boardMemberPage) {
      state.boardMemberPage = Math.max(0, state.boardMemberPage + Number(button.dataset.boardMemberPage));
      render();
      return;
    }
    if (button.dataset.topicHistoryDays) {
      state.topicHistory.days = Number(button.dataset.topicHistoryDays) === 7 ? 7 : 30;
      state.topicHistory.data = null;
      state.topicHistory.dataKey = '';
      loadTopicHistory(state.topicHistory.days, true);
      render();
      return;
    }
    if (button.hasAttribute('data-topic-history-retry')) {
      state.topicHistory.data = null;
      state.topicHistory.dataKey = '';
      loadTopicHistory(state.topicHistory.days, true);
      render();
      return;
    }
    if (button.dataset.account) onAccount(Number(button.dataset.account), options());
    if (button.dataset.productBoard) { onBoard(button.dataset.productBoard); location.hash = '#boards'; }
    if (button.dataset.classificationPick) { state.classification = button.dataset.classificationPick; state.page = 0; location.hash = '#targets'; renderAccounts(); }
    if (button.hasAttribute('data-product-import')) onImport(state.board);
    if (button.hasAttribute('data-product-settings')) onSettings();
    if (button.dataset.sourceIndex !== undefined) onSource?.(state.bootstrap.authorSources[Number(button.dataset.sourceIndex)]);
    if (button.dataset.productPeriod) { state.range = { period: button.dataset.productPeriod }; load({ force: true }); }
    if (button.dataset.productAnchor) {
      // If today's 10:00 collection has not run yet, anchor to the latest
      // saved observation instead of selecting an empty future endpoint.
      const endDate = latestObservedDate();
      state.range = { period: 'custom', startDate: button.dataset.productAnchor, endDate };
      state.controlsKey = null;
      load({ force: true });
    }
    if (button.dataset.chartMetric) { state.metric = button.dataset.chartMetric; render(); }
    if (button.dataset.chartMode) { state.mode = button.dataset.chartMode; render(); }
    if (button.dataset.pageStep) { state.page += Number(button.dataset.pageStep); renderAccounts(); }
    if (button.hasAttribute('data-product-retry')) load({ force: true });
    if (button.hasAttribute('data-export-daily') && state.data) exportCsv([['时段', '日期', '粉丝数', '粉丝日变化', '累计赞', '点赞日变化', '累计点赞代理存量(赞×100)', '新增估算播放(点赞净变化×100)', '作品总数', '作品总数日变化', '发布样本(非完整)', '有粉丝值人数', '粉丝可比人数'], ...[[state.data.summary.trend, '当前'], [state.data.comparison?.summary.trend || [], '对比']].flatMap(([points, label]) => points.map((point) => [label, point.date, point.followers, point.followersDelta, point.likes, point.likesDelta, point.estimatedPlays, point.estimatedPlaysDelta, point.posts, point.postsDelta, point.publishedSamples, point.followersObservedCount, point.followersComparableCount]))], '每日数据对比');
    if (button.hasAttribute('data-export-accounts') && state.data) exportCsv([['作者', '账号', '平台', '粉丝', '粉丝变化', '粉丝变化率(%)', '点赞', '点赞变化', '累计点赞代理存量(赞×100)', '新增估算播放(点赞净变化×100)', '作品总数', '作品总数变化', '粉丝观测时间', '粉丝基准时间', '主页状态', '监控设置', '原提交姓名', '原提交账号', '作者主页', '状态检查时间'], ...filteredAccounts().map((account) => [account.label, account.publicId, platformName(account.platform), ...['followers', 'likes', 'estimatedPlays', 'posts'].flatMap((key) => [account.metrics[key].value, account.metrics[key].delta, ...(key === 'followers' ? [account.metrics[key].percent] : [])]), account.metrics.followers.currentAt, account.metrics.followers.baselineAt, account.status?.label, account.enabled ? '启用' : '暂停', account.submittedName, account.submittedAccountId, safeHomepage(account.profileUrl), account.lifecycle?.observedAt])], '账号数据');
  });
  document.addEventListener('input', (event) => { if (event.target.id === 'productAccountSearch') { state.query = event.target.value; state.page = 0; renderAccounts(); } });
  document.addEventListener('change', (event) => {
    if (event.target.id === 'productAccountClassification') { state.classification = event.target.value; state.page = 0; renderAccounts(); $('#productAccountClassification').focus({ preventScroll: true }); }
    if (event.target.id === 'productAccountFilter') { state.filter = event.target.value; state.page = 0; renderAccounts(); $('#productAccountFilter').focus({ preventScroll: true }); }
    if (event.target.id === 'productAccountSort') { state.sort = event.target.value; state.page = 0; renderAccounts(); $('#productAccountSort').focus({ preventScroll: true }); }
    if (event.target.name === 'compare' && event.target.closest('#productDateForm')) {
      $('#productCompareDates').hidden = !event.target.checked;
      if (event.target.checked) {
        const form = event.target.form;
        const start = new Date(`${form.elements.startDate.value}T12:00:00Z`);
        const end = new Date(`${form.elements.endDate.value}T12:00:00Z`);
        const days = Math.max(1, Math.round((end - start) / 86400000) + 1);
        end.setTime(start.getTime()); end.setUTCDate(end.getUTCDate() - 1);
        start.setUTCDate(start.getUTCDate() - days);
        form.elements.comparisonStartDate.value ||= calendarDateKey(start);
        form.elements.comparisonEndDate.value ||= calendarDateKey(end);
      }
    }
  });
  document.addEventListener('submit', (event) => {
    if (event.target.id !== 'productDateForm') return;
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target));
    const today = dateKey(new Date(state.data?.referenceAt || Date.now()));
    const error = validateDateRanges(values, { today });
    if (error) { $('#productFeedback').textContent = error; return; }
    state.range = { period: 'custom', startDate: values.startDate, endDate: values.endDate, ...(values.compare ? { comparisonStartDate: values.comparisonStartDate, comparisonEndDate: values.comparisonEndDate } : {}) };
    load({ force: true });
  });
  window.addEventListener('hashchange', () => { route(); render(); });
  return { load, render, route, options, filter(value) { state.filter = value; state.page = 0; renderAccounts(); } };
}
