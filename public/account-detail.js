import { escapeHtml, safeHttpUrl } from './ui-safety.js';

const PERIODS = { day: '今日', week: '本周', month: '本月', '30d': '近30日', custom: '所选日期' };
const PLATFORMS = { douyin: '抖音', bilibili: 'B站', xiaohongshu: '小红书' };
const TREND_METRICS = {
  followers: '粉丝', likes: '累计获赞', estimatedPlays: '累计点赞代理',
  posts: '作品存量', publishedSamples: '发布量（已收录）',
};
let instanceCount = 0;

function numeric(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberText(value, { signed = false, percent = false } = {}) {
  const number = numeric(value);
  if (number === null) return '—';
  return `${new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: percent ? 2 : 1,
    signDisplay: signed ? 'exceptZero' : 'auto',
  }).format(number)}${percent ? '%' : ''}`;
}

function dateText(value, timeZone, { short = false } = {}) {
  if (!value) return '暂无时间记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间记录无效';
  const options = {
    ...(short ? {} : { year: 'numeric' }),
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {}),
  };
  try { return new Intl.DateTimeFormat('zh-CN', options).format(date); }
  catch { return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; }
}

function dateLabel(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value).slice(5) : '日期未知';
}

function axisNumber(value) {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function externalUrl(value) {
  const safe = safeHttpUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  return url.protocol === 'https:' && !url.port ? safe : null;
}

function externalLink(url, label, className = '') {
  const safe = externalUrl(url);
  return safe
    ? `<a class="${className}" href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
    : `<span class="${className}">${escapeHtml(label)}</span>`;
}

function direction(value) {
  const number = numeric(value);
  return number === null ? 'missing' : number > 0 ? 'up' : number < 0 ? 'down' : 'flat';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Preserve unknown values and the server's comparison semantics; never impute data. */
export function normalizeAccountInsight(payload) {
  if (!payload?.account || typeof payload.account !== 'object') {
    throw new Error('账号详情返回不完整，请重试');
  }
  const account = payload.account;
  return {
    ...payload,
    period: Object.hasOwn(PERIODS, payload.period) ? payload.period : 'day',
    timeZone: typeof payload.timeZone === 'string' ? payload.timeZone : '',
    account: {
      ...account,
      label: String(account.label || '未提供作者名称'),
      publicId: String(account.publicId ?? ''),
      submittedName: typeof account.submittedName === 'string' ? account.submittedName : null,
      submittedAccountId: typeof account.submittedAccountId === 'string'
        ? account.submittedAccountId : null,
      enabled: account.enabled === true || account.enabled === 1 ? true
        : account.enabled === false || account.enabled === 0 ? false : null,
      boards: asArray(account.boards),
      metrics: account.metrics && typeof account.metrics === 'object' ? account.metrics : {},
      trend: asArray(account.trend),
      status: account.status && typeof account.status === 'object' ? account.status : {},
      worksObservation: account.worksObservation && typeof account.worksObservation === 'object'
        && !Array.isArray(account.worksObservation) ? account.worksObservation : null,
      lifecycle: account.lifecycle && typeof account.lifecycle === 'object'
        && !Array.isArray(account.lifecycle) ? account.lifecycle : null,
      identityAliases: asArray(account.identityAliases)
        .filter((event) => event?.type === 'douyin-account-alias-change'),
      identityEvidence: asArray(account.identityEvidence)
        .filter((event) => event && typeof event === 'object' && !Array.isArray(event)),
      sources: asArray(account.sources),
    },
    recentWorks: asArray(payload.recentWorks),
  };
}

/** A null day breaks the line. A single observation is a point, never a trend. */
export function buildAccountTrend(trend, { metric = 'followers', days = 30 } = {}) {
  const field = Object.hasOwn(TREND_METRICS, metric) ? metric : 'followers';
  const limit = days === 'range' ? 366 : days === 7 ? 7 : 30;
  const points = asArray(trend)
    .filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(String(point?.date)))
    .map((point) => ({ ...point, value: numeric(point[field]) }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-limit);
  const observations = points.filter((point) => point.value !== null);
  const values = observations.map((point) => point.value);
  const low = values.length ? Math.min(...values) : null;
  const high = values.length ? Math.max(...values) : null;
  const padding = values.length ? Math.max((high - low) * 0.12, Math.abs(high) * 0.0001, 1) : 0;
  const minimum = values.length ? Math.max(0, low - padding) : null;
  const maximum = values.length ? Math.max(high + padding, minimum + 1) : null;
  const segments = [];
  let segment = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const previous = points[index - 1];
    const gap = previous && Date.parse(point.date) - Date.parse(previous.date) > 86_400_000;
    if (point.value === null || gap) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (point.value !== null) {
      segment.push({
        ...point,
        x: points.length === 1 ? 344 : 70 + (index / (points.length - 1)) * 546,
        y: 22 + ((maximum - point.value) / (maximum - minimum)) * 142,
      });
    }
  }
  if (segment.length) segments.push(segment);
  return { points, observations, segments, minimum, maximum, metric: field, days: days === 'range' ? 'range' : limit };
}

/** Encode dates separately, so malformed ranges cannot become query/path injection. */
export function accountInsightPath(targetId, options = {}) {
  const id = Number(targetId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('账号 ID 无效');
  const dateKeys = ['startDate', 'endDate', 'comparisonStartDate', 'comparisonEndDate'];
  const dates = Object.fromEntries(dateKeys.filter((key) => options[key] !== undefined && options[key] !== '')
    .map((key) => {
      const value = String(options[key]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)
        || Number.isNaN(Date.parse(`${value}T00:00:00Z`))
        || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
        throw new Error('日期须为有效的 YYYY-MM-DD');
      }
      return [key, value];
    }));
  if (Boolean(dates.startDate) !== Boolean(dates.endDate)
    || Boolean(dates.comparisonStartDate) !== Boolean(dates.comparisonEndDate)) {
    throw new Error('请选择完整的起止日期');
  }
  if (dates.comparisonStartDate && !dates.startDate) throw new Error('请先选择主时段日期');
  if (dates.startDate > dates.endDate || dates.comparisonStartDate > dates.comparisonEndDate) {
    throw new Error('结束日期不能早于开始日期');
  }
  const period = dates.startDate ? 'custom' : Object.hasOwn(PERIODS, options.period) ? options.period : 'day';
  if (period === 'custom' && !dates.startDate) throw new Error('自定义周期需要起止日期');
  return `/api/accounts/${id}/insights?${new URLSearchParams({ period, ...dates })}`;
}

function isDeletedAccount(account) {
  return account.lifecycle?.state === 'deleted' || account.status.key === 'deleted';
}

function evidenceRows(entries) {
  return entries.filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`)
    .join('');
}

function identityHistoryMarkup(account, timeZone) {
  if (!account.identityAliases.length) return '';
  const records = account.identityAliases.map((event) => `<li><dl class="account-detail__evidence-list">${evidenceRows([
    ['原提交账号', event.submittedAccountId],
    ['变更前平台号', event.previousPublicAccountId],
    ['当次观测平台号', event.currentPublicAccountId],
    ['观测时间', dateText(event.observedAt, timeZone)],
    ['核验时间', dateText(event.verifiedAt, timeZone)],
    ['稳定身份 sec_uid', event.canonicalAccountId],
    ['平台 uid', event.uid],
    ['原来源快照 ID', event.priorSnapshotId],
    ['原快照时间', dateText(event.priorSnapshotCapturedAt, timeZone)],
    ['原证据校验值', event.priorSourceChecksum],
    ['当次证据校验值', event.currentRawSha256],
    ['核验依据', event.reason],
  ])}</dl></li>`).join('');
  return `<details class="account-detail__identity-history"><summary>公开账号曾变更 · 查看改号记录（${account.identityAliases.length}）</summary>
    <p class="account-detail__hint">当前平台账号以上方资料为准。原提交账号、作者名称与名单出处保留；历史改号记录不覆盖原始导入信息。</p>
    <ol>${records}</ol></details>`;
}

function sourceIdentityEvidenceMarkup(account, timeZone) {
  const records = account.identityEvidence.map((event) => {
    const fields = evidenceRows([
      ['原提交账号', event.submittedAccountId],
      ['当次主页平台号', event.currentPublicAccountId],
      ['稳定身份 sec_uid', event.canonicalAccountId],
      ['平台 uid', event.uid],
      ['作品命中字段', event.sourceMatchField],
      ['作品详情校验值', event.detailResponseChecksum],
      ['当次主页校验值', event.currentRawSha256],
      ['观测时间', event.observedAt ? dateText(event.observedAt, timeZone) : null],
      ['核验时间', event.verifiedAt ? dateText(event.verifiedAt, timeZone) : null],
      ['核验依据', event.reason],
    ]);
    const videoId = event.sourceVideoId;
    const hasVideo = videoId !== undefined && videoId !== null && videoId !== '';
    const video = hasVideo ? `<div><dt>来源作品</dt><dd>${typeof videoId === 'string' && /^\d{15,25}$/.test(videoId)
      ? externalLink(`https://www.douyin.com/video/${videoId}`, videoId)
      : escapeHtml(String(videoId))}</dd></div>` : '';
    return fields || video ? `<li><dl class="account-detail__evidence-list">${video}${fields}</dl></li>` : '';
  }).filter(Boolean);
  if (!records.length) return '';
  return `<details class="account-detail__identity-evidence"><summary>原作品身份凭据（${records.length}）</summary>
    <p class="account-detail__hint">原作品详情中的公开身份字段与当前主页交叉核验；这是身份凭据，不表示账号发生改号。原提交信息保留。</p>
    <ol>${records.join('')}</ol></details>`;
}

function lifecycleEvidenceMarkup(account, timeZone) {
  if (!isDeletedAccount(account)) return '';
  const lifecycle = account.lifecycle || {};
  const records = evidenceRows([
    ['主页状态', '官方主页显示已注销'],
    ['状态观测时间', dateText(lifecycle.observedAt, timeZone)],
    ['判定依据', lifecycle.reason],
    ['请求账号身份', lifecycle.requestedAccountId],
    ['平台回传 uid', lifecycle.reportedUid],
    ['原始证据校验值', lifecycle.sourceChecksum],
  ]);
  return `<details class="account-detail__lifecycle-evidence"><summary>查看注销判定证据</summary>
    <p class="account-detail__hint">状态观测时间不等于指标采样时间；注销不代表粉丝、获赞或作品数为0。</p>
    <dl class="account-detail__evidence-list">${records}</dl></details>`;
}

function metricCard(label, metric = {}, timeZone, historical = false) {
  const comparable = metric.comparable === true;
  const delta = comparable ? numeric(metric.delta) : null;
  const percent = comparable ? numeric(metric.percent) : null;
  const comparison = metric.comparisonLabel || (comparable ? '区间变化' : '暂不可比');
  const percentLabel = percent !== null
    ? numberText(percent, { signed: true, percent: true })
    : comparable && numeric(metric.baseline) === 0 ? '基数为0，比例不可算' : '比例暂无';
  return `<article class="account-detail__metric">
    <h3>${escapeHtml(label)}</h3>
    <p class="account-detail__metric-value">${numberText(metric.value)}</p>
    <div class="account-detail__change account-detail__change--${direction(delta)}">
      <strong>${numberText(delta, { signed: true })}</strong><span>${escapeHtml(percentLabel)}</span>
    </div>
    <p class="account-detail__metric-caption">${escapeHtml(comparison)}</p>
    <p class="account-detail__metric-date">${historical ? '历史数据' : '数据'}：${escapeHtml(dateText(metric.currentAt, timeZone, { short: true }))}</p>
    ${metric.stale ? '<p class="account-detail__metric-reason">此项数据偏旧，当前展示的是已保存的历史值。</p>' : ''}
    ${metric.reason ? `<p class="account-detail__metric-reason">${escapeHtml(metric.reason)}</p>` : ''}
  </article>`;
}

function statusMessages(account, timeZone) {
  const { status } = account;
  const messages = [];
  const deleted = isDeletedAccount(account);
  if (deleted) messages.push({
    type: 'neutral', title: '官方主页显示已注销',
    text: `保留历史数据，以下指标与作品不代表当前实时值。启用监控时每天检查主页状态，不再反复获取不可用作品。${account.lifecycle?.observedAt ? `状态观测：${dateText(account.lifecycle.observedAt, timeZone)}。` : ''}`,
  });
  if (account.enabled === false) messages.push({
    type: 'neutral', title: '监控已暂停',
    text: '暂停期间不会自动更新；已保存的资料和历史数据仍可查看。',
  });
  const missing = ['followers', 'likes', 'posts']
    .every((key) => numeric(account.metrics[key]?.value) === null);
  if (missing) messages.push({
    type: 'warning', title: '尚无可展示的账号快照',
    text: '已接入名单不代表已取得数据。缺失指标显示为“—”，不会按0计算。',
  });
  if (status.stale && !missing && !deleted) messages.push({
    type: 'warning', title: '数据需要更新',
    text: `以下是已保存的历史观测，不代表当前实时值。${status.lastSuccessAt ? `最近成功：${dateText(status.lastSuccessAt, timeZone)}。` : ''}`,
  });
  if (status.error && !deleted) messages.push({
    type: 'warning', title: '最近一次更新未完成', text: String(status.error),
  });
  return messages.map((message) => `<section class="account-detail__notice account-detail__notice--${message.type}">
    <strong>${escapeHtml(message.title)}</strong><p>${escapeHtml(message.text)}</p>
  </section>`).join('');
}

function trendMarkup(account, { trendMetric, trendDays, idPrefix, customRange = false, controls = true, heading = '真实数据趋势', rangeLabel = '', rangeNote = '' }) {
  const model = buildAccountTrend(account.trend, { metric: trendMetric, days: trendDays });
  // A preset's metric comparison window can differ from its 7/30-day trend window.
  const shownRangeLabel = model.points.length
    ? `${model.points[0].date} 至 ${model.points.at(-1).date}` : rangeLabel;
  const metricLabel = TREND_METRICS[model.metric];
  const isPublished = model.metric === 'publishedSamples';
  const changeLabel = model.metric === 'estimatedPlays'
    ? '新增估算播放'
    : `较前一日${model.metric === 'posts' ? '存量净变化' : ''}`;
  const windowLabel = model.days === 'range' ? '所选范围' : `近${model.days}日`;
  const id = `${idPrefix}-trend`;
  let chart;
  if (!model.observations.length) {
    chart = `<div class="account-detail__empty"><strong>${windowLabel}暂无${metricLabel}${isPublished ? '计数记录' : '观测'}</strong><p>${isPublished ? '有已收录作品的日计数后才会绘制趋势；未提供的计数不会补零。' : '有真实快照后才会绘制趋势，缺失日期不会补零。'}</p></div>`;
  } else {
    const paths = model.segments.map((segment) => {
      const line = segment.length > 1
        ? `<path d="${segment.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')}" />`
        : '';
      const circles = segment.map((point) => `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3"><title>${escapeHtml(`${point.date} · ${metricLabel} ${numberText(point.value)}`)}</title></circle>`).join('');
      return `${line}${circles}`;
    }).join('');
    chart = `<svg class="account-detail__chart" viewBox="0 0 640 205" role="img" aria-labelledby="${id}-label">
      <title id="${id}-label">${windowLabel}${metricLabel}，${model.observations.length}天有${isPublished ? '计数记录' : '观测'}；缺失日期断开</title>
      <g class="account-detail__chart-grid"><line x1="70" y1="22" x2="616" y2="22"/><line x1="70" y1="93" x2="616" y2="93"/><line x1="70" y1="164" x2="616" y2="164"/></g>
      <g class="account-detail__chart-labels"><text x="60" y="27" text-anchor="end">${axisNumber(model.maximum)}</text><text x="60" y="169" text-anchor="end">${axisNumber(model.minimum)}</text><text x="70" y="192">${escapeHtml(dateLabel(model.points[0]?.date))}</text><text x="616" y="192" text-anchor="end">${escapeHtml(dateLabel(model.points.at(-1)?.date))}</text></g>
      <g class="account-detail__chart-series">${paths}</g>
    </svg>${model.observations.length === 1 ? '<p class="account-detail__hint">仅1天有观测，暂不能判断趋势。</p>' : ''}`;
  }
  const deltaKey = { followers: 'followersDelta', likes: 'likesDelta', estimatedPlays: 'estimatedPlaysDelta', posts: 'postsDelta' }[model.metric];
  const table = model.points.map((point) => `<tr><th scope="row">${escapeHtml(point.date)}</th><td>${numberText(point[model.metric])}</td>${isPublished ? '' : `<td class="account-detail__change--${direction(point[deltaKey])}">${numberText(point[deltaKey], { signed: true })}</td><td>${numberText(point.publishedSamples)}</td>`}</tr>`).join('');
  const windows = customRange ? [7, 30, 'range'] : [7, 30];
  return `<section class="account-detail__section" aria-labelledby="${id}">
    <div class="account-detail__section-heading"><h3 id="${id}">${escapeHtml(heading)}</h3>${controls ? `<div class="account-detail__segments" role="group" aria-label="趋势时间范围">${windows.map((days) => `<button type="button" data-detail-days="${days}" data-detail-focus="days-${days}" aria-pressed="${model.days === days}">${days === 'range' ? '所选范围' : `近${days}日`}</button>`).join('')}</div>` : `<span class="account-detail__hint">${escapeHtml(metricLabel)}</span>`}</div>
    ${shownRangeLabel ? `<p class="account-detail__range-label">${escapeHtml(shownRangeLabel)}</p>` : ''}
    ${rangeNote ? `<p class="account-detail__hint">${escapeHtml(rangeNote)}</p>` : ''}
    ${controls ? `<div class="account-detail__segments" role="group" aria-label="趋势指标">${Object.entries(TREND_METRICS).map(([key, label]) => `<button type="button" data-detail-metric="${key}" data-detail-focus="metric-${key}" aria-pressed="${model.metric === key}">${label}</button>`).join('')}</div>` : ''}
    ${chart}<p class="account-detail__hint">${isPublished ? '按已收录作品的真实发布时间分日计数；截至所选区间结束已收录的作品才计入本期，之后才收录的不回填本期。不代表完整发布量；0仅表示尚未收录当日发布样本，不代表作者没有发布。' : '仅显示当天真实观测；缺测日断开，不补零。下表涨跌仅比较相邻两日；每日发布量只统计已收录作品，不代表完整发布量。'}</p>
    ${model.metric === 'estimatedPlays' ? '<p class="account-detail__hint">累计点赞代理＝累计获赞 × 100；新增估算播放＝新增点赞 × 100；均不是平台实测播放量。</p>' : ''}
    ${model.metric === 'posts' ? '<p class="account-detail__hint">作品存量净变化不是新增投稿数；删除、隐藏作品也可能改变存量。</p>' : ''}
    ${model.points.length ? `<details class="account-detail__daily"><summary>查看每日数值</summary><div class="account-detail__table-scroll" tabindex="0" aria-label="每日数据表，可横向滚动"><table><thead><tr><th scope="col">日期</th><th scope="col">${metricLabel}</th>${isPublished ? '' : `<th scope="col">${changeLabel}</th><th scope="col">每日发布量（已收录）</th>`}</tr></thead><tbody>${table}</tbody></table></div></details>` : ''}
  </section>`;
}

function worksCoverageLabel(coverage, evidence = null) {
  return ({
    complete: evidence?.kind === 'verified-public-cursor-chain' ? '跨批次公开列表完整' : '本次公开列表完整返回', limited: '仅部分公开样本', retry: '本次未取得有效作品响应',
    unavailable: '当前作品不可用', unknown: '尚无作品观测记录',
  })[coverage] || '尚无作品观测记录';
}

export function worksObservationMarkup(observation, timeZone) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    return '<p class="account-detail__hint">尚无作品样本观测记录；主页更新不代表作品样本已更新。</p>';
  }
  const signal = observation.signal?.key === 'inventory-changed-window-unchanged' ? observation.signal : null;
  const checksum = typeof observation.sourceChecksum === 'string' && /^[a-f\d]{64}$/i.test(observation.sourceChecksum)
    ? observation.sourceChecksum : null;
  const evidence = evidenceRows([
    ['作品响应采集', observation.observedAt ? dateText(observation.observedAt, timeZone) : null],
    ['最近作品尝试', observation.lastAttemptAt ? dateText(observation.lastAttemptAt, timeZone) : null],
    ['响应样本数量', numeric(observation.sampleCount)],
    ['样本内最近发布', observation.latestPublishedAt ? dateText(observation.latestPublishedAt, timeZone) : null],
    ['统计截止', observation.asOf ? dateText(observation.asOf, timeZone) : null],
    ['证据范围', observation.evidenceScope === 'stored-public-sample' ? '已保存的公开作品样本' : null],
    ['跨批次续页核验', observation.coverageEvidence?.kind === 'verified-public-cursor-chain'
      ? `${numeric(observation.coverageEvidence.segments?.length)} 段；去重 ${numeric(observation.coverageEvidence.uniquePublicPosts)} / 主页总量 ${numeric(observation.coverageEvidence.inventory)}；跨时点非原子采样` : null],
    ['续页链证据校验值', observation.coverageEvidence?.kind === 'verified-public-cursor-chain'
      && /^[a-f\d]{64}$/i.test(observation.coverageEvidence.checksum || '') ? observation.coverageEvidence.checksum : null],
    ['来源校验值', checksum],
    ['采集终止原因（来源值）', typeof observation.stopReason === 'string' ? observation.stopReason : null],
    ['样本说明', typeof observation.reason === 'string' ? observation.reason : null],
    ['上次主页作品数', signal ? numeric(signal.inventoryBefore) : null],
    ['本次主页作品数', signal ? numeric(signal.inventoryAfter) : null],
    ['主页作品存量净变化', signal ? numeric(signal.inventoryDelta) : null],
    ['前次样本采集', signal?.previousObservedAt ? dateText(signal.previousObservedAt, timeZone) : null],
    ['本次样本采集', signal?.observedAt ? dateText(signal.observedAt, timeZone) : null],
  ]);
  const coverageEvidence = observation.coverageEvidence?.kind === 'verified-public-cursor-chain' ? observation.coverageEvidence : null;
  return `<div class="account-detail__works-observation">
    <p class="account-detail__hint">作品样本：${escapeHtml(worksCoverageLabel(observation.coverage, coverageEvidence))}${observation.carriedForward === true ? ' · 沿用历史样本，未用本次尝试时间刷新旧证据' : ''}。样本采集 ${escapeHtml(dateText(observation.observedAt, timeZone, { short: true }))} · 样本内最近发布 ${escapeHtml(dateText(observation.latestPublishedAt, timeZone, { short: true }))}。</p>
    ${coverageEvidence ? '<p class="account-detail__hint">完整度来自连续公开续页链去重后与各次主页作品总数相符；采集跨多个时点，不是同一时点快照。</p>' : ''}
    ${signal ? '<p class="account-detail__hint">主页作品数有变化，返回样本未体现该变化；不能据此计算实际新发布数量。</p>' : ''}
    <details class="account-detail__works-evidence"><summary>查看作品样本依据</summary><dl class="account-detail__evidence-list">${evidence}</dl><p class="account-detail__hint">${coverageEvidence ? '跨批次完整仅指连续公开游标链去重后与各次主页作品总量一致；采样不是同一时点快照，且不保证包含私密、删除或不可见作品。' : '公开响应可能未包含最新发布；完整返回只指本次公开列表，不代表全量发布记录。'} 0 已收录不等于 0 发布。</p></details>
  </div>`;
}

function worksMarkup(works, timeZone, idPrefix, historical = false, observation = null) {
  const content = works.length ? `<ol class="account-detail__works">${works.map((work) => `<li>
    <div class="account-detail__work-title">${externalLink(work.url, work.caption || `作品 ${work.externalId || work.id || '未命名'}`)}</div>
    <p class="account-detail__work-time">发布 ${escapeHtml(dateText(work.publishedAt, timeZone))} · 样本采集 ${escapeHtml(dateText(work.lastObservedAt, timeZone))}</p>
    <dl class="account-detail__work-metrics">${[['点赞', work.likes], ['评论', work.comments], ['分享', work.shares], ['收藏', work.collects], ['估算播放', numeric(work.likes) === null ? null : numeric(work.likes) * 100]].map(([label, value]) => `<div><dt>${label}</dt><dd>${numberText(value)}</dd></div>`).join('')}</dl>
    ${numeric(work.plays) !== null ? `<details><summary>查看来源播放字段</summary><p class="account-detail__hint">公开来源返回：${numberText(work.plays)}；0可能是匿名占位，不能视为真实播放量。此字段不用于上方估算。</p></details>` : ''}
  </li>`).join('')}</ol>` : `<div class="account-detail__empty"><strong>${historical ? '暂无已保存的历史作品' : '暂无已采集的公开作品'}</strong><p>这不等于作者没有发布作品；账号资料和作品列表的可读取范围可能不同。</p></div>`;
  return `<section class="account-detail__section" aria-labelledby="${idPrefix}-works"><div class="account-detail__section-heading"><h3 id="${idPrefix}-works">${historical ? '已保存的历史作品' : '已收录的公开作品样本'}</h3><span class="account-detail__hint">当前展示 ${works.length} 条</span></div><p class="account-detail__hint">仅列已保存的公开作品样本，不保证覆盖最新或全量发布。估算播放＝该作品点赞 × 100，不是平台真实播放；缺少点赞时不计算。</p>${worksObservationMarkup(observation, timeZone)}${content}</section>`;
}

function comparisonMarkup(metrics, timeZone) {
  return ['followers', 'likes', 'estimatedPlays', 'posts'].map((key) => {
    const metric = metrics[key] || {};
    const label = { followers: '粉丝', likes: '累计获赞', estimatedPlays: '累计点赞代理', posts: '作品存量' }[key];
    const reason = metric.comparable === true
      ? `${dateText(metric.baselineAt, timeZone)} → ${dateText(metric.comparisonCurrentAt || metric.currentAt, timeZone)}`
      : metric.reason || '缺少可比观测，尚不能计算变化';
    return `<li><strong>${label}</strong><span>${escapeHtml(metric.comparisonLabel || '暂不可比')}</span><p>${escapeHtml(reason)}</p></li>`;
  }).join('');
}

/** Pure renderer. Every external string is escaped; numbers and SVG coordinates are finite. */
export function renderAccountDetail(payload, options = {}) {
  const data = normalizeAccountInsight(payload);
  const { account, timeZone } = data;
  const { status, metrics } = account;
  const idPrefix = String(options.idPrefix || 'account-detail').replace(/[^a-zA-Z0-9_-]/g, '');
  const period = Object.hasOwn(PERIODS, options.period) ? options.period : data.period;
  const deleted = isDeletedAccount(account);
  const currentStatus = deleted ? '官方主页显示已注销'
    : status.label || (account.enabled === false ? '已暂停' : '已接入监控');
  const canManage = options.canManage && account.enabled !== null;
  const estimated = metrics.estimatedPlays || {};
  const estimatedDelta = estimated.comparable === true ? numeric(estimated.delta) : null;
  const rangeLabel = data.range ? `${data.range.startDate} 至 ${data.range.endDate}` : '';
  const comparison = data.comparison?.account;
  const comparisonMetrics = comparison?.metrics || {};
  const comparisonLabel = data.comparison?.range
    ? `${data.comparison.range.startDate} 至 ${data.comparison.range.endDate}` : '';
  const comparisonCards = comparison ? `<section class="account-detail__section"><h3>对比时段指标</h3><p class="account-detail__range-label">${escapeHtml(comparisonLabel || '所选对比时段')}</p><div class="account-detail__metrics">${metricCard('粉丝', comparisonMetrics.followers, timeZone)}${metricCard('累计获赞', comparisonMetrics.likes, timeZone)}${metricCard('累计点赞代理', comparisonMetrics.estimatedPlays, timeZone)}${metricCard('作品存量', comparisonMetrics.posts, timeZone)}</div><p class="account-detail__hint">两组指标分别按各自时段计算；两时段的差值不作为每日增长。</p></section>` : '';
  const boardMarkup = account.boards.length
    ? account.boards.map((board, index) => `<button type="button" class="account-detail__board" data-detail-board="${escapeHtml(board.key || board.name || '')}" data-detail-focus="board-${index}">${escapeHtml(board.name || board.key || '未命名板块')}</button>`).join('')
    : '<span class="account-detail__muted">未分板块</span>';
  const submittedIdentity = evidenceRows([
    ['原提交姓名', account.submittedName?.trim() ? account.submittedName : null],
    ['原提交账号', account.submittedAccountId?.trim() ? account.submittedAccountId : null],
  ]);
  const sources = account.sources.map((source) => `<li>${source.url ? externalLink(source.url, source.fileName || source.type || '来源表格') : escapeHtml(source.fileName || source.type || '来源记录')}<span>${escapeHtml([source.sheetName, source.row != null ? `原表第${source.row}行` : ''].filter(Boolean).join(' · '))}</span></li>`).join('');
  const warnings = [...(deleted && status.error ? [String(status.error)] : []),
    ...asArray(status.warnings).map((warning) => typeof warning === 'string' ? warning : warning?.message || warning?.reason || '')]
    .filter(Boolean);
  const worksCoverage = worksCoverageLabel(account.worksObservation?.coverage || status.worksCoverage);
  return `<header class="account-detail__header">
    <div class="account-detail__topline"><span>账号详情</span><button type="button" class="account-detail__close" data-detail-close data-detail-focus="close" aria-label="关闭账号详情">关闭</button></div>
    <h2 id="${idPrefix}-title">${escapeHtml(account.label)}</h2>
    <p class="account-detail__identity"><span>${escapeHtml(PLATFORMS[account.platform] || account.platform || '平台未标注')}</span><span class="account-detail__badge">${escapeHtml(currentStatus)}</span>${deleted && account.enabled !== null ? `<span class="account-detail__badge">${account.enabled ? '监控设置：启用' : '监控设置：暂停'}</span>` : ''}</p>
  </header>
  <div class="account-detail__body">
    <section class="account-detail__profile" aria-label="账号资料"><dl><div><dt>当前平台号</dt><dd>${escapeHtml(account.publicId || '尚未取得公开账号ID')}</dd></div>${submittedIdentity}<div><dt>作者主页</dt><dd>${externalUrl(account.profileUrl) ? externalLink(account.profileUrl, '打开公开主页') : '尚未取得可用主页'}</dd></div><div><dt>所属板块</dt><dd class="account-detail__boards">${boardMarkup}</dd></div></dl>${identityHistoryMarkup(account, timeZone)}${sourceIdentityEvidenceMarkup(account, timeZone)}</section>
    ${statusMessages(account, timeZone)}
    <section class="account-detail__section" aria-labelledby="${idPrefix}-metrics"><div class="account-detail__section-heading"><h3 id="${idPrefix}-metrics">${deleted ? '已保存的历史指标' : '账号指标'}</h3><div class="account-detail__segments" role="group" aria-label="指标对比周期">${Object.entries(PERIODS).filter(([key]) => key !== 'custom' || period === 'custom').map(([key, label]) => `<button type="button" data-detail-period="${key}" data-detail-focus="period-${key}" aria-pressed="${period === key}">${label}</button>`).join('')}</div></div>
      ${rangeLabel ? `<p class="account-detail__range-label">${escapeHtml(rangeLabel)}</p>` : ''}
      <p class="account-detail__hint">统计截止 ${escapeHtml(dateText(data.referenceAt, timeZone))} · 统计时区 ${escapeHtml(timeZone || '未提供')}</p>
      <div class="account-detail__metrics">${metricCard('粉丝', metrics.followers, timeZone, deleted)}${metricCard('累计获赞', metrics.likes, timeZone, deleted)}${metricCard('累计点赞代理', metrics.estimatedPlays, timeZone, deleted)}${metricCard('作品存量', metrics.posts, timeZone, deleted)}</div>
      <div class="account-detail__estimate"><div><span>新增估算播放</span><strong class="account-detail__change--${direction(estimatedDelta)}">${numberText(estimatedDelta, { signed: true })}</strong></div><p>新增估算播放＝${escapeHtml(estimated.formula || '新增点赞 × 100')}；不是平台实测播放量。${escapeHtml(estimated.comparisonLabel || '')}</p></div>
      <details class="account-detail__comparison"><summary>查看计算依据与对比日期</summary><ul>${comparisonMarkup(metrics, timeZone)}</ul><p class="account-detail__hint">若使用本期首条快照作基线，只代表已观察时段的变化，不等于完整日增；基数为0时不计算百分比。</p></details>
      <p class="account-detail__hint">作品变化表示存量净变化，不等于新增投稿。${account.publishedSamples ? `本期已观察到的公开投稿样本：${numberText(account.publishedSamples.value)} 条。截至所选区间结束已收录的作品才计入本期，之后才收录的不回填本期。${escapeHtml(account.publishedSamples.reason || '')}` : ''}</p>
    </section>
    ${comparisonCards}
    ${trendMarkup(account, { trendMetric: options.trendMetric, trendDays: options.trendDays, idPrefix, customRange: period === 'custom', rangeLabel })}
    ${comparison ? trendMarkup(comparison, { trendMetric: options.trendMetric, trendDays: options.trendDays, idPrefix: `${idPrefix}-comparison`, customRange: true, controls: false, heading: '对比时段真实趋势', rangeLabel: comparisonLabel, rangeNote: '两图纵轴独立，请结合数值表对比' }) : ''}
    ${worksMarkup(data.recentWorks, timeZone, idPrefix, deleted, account.worksObservation)}
    <section class="account-detail__section" aria-labelledby="${idPrefix}-updates"><h3 id="${idPrefix}-updates">更新与来源</h3><dl class="account-detail__update-list"><div><dt>${deleted ? '最近有效资料' : '最近成功'}</dt><dd>${escapeHtml(dateText(status.lastSuccessAt, timeZone))}</dd></div><div><dt>最近尝试</dt><dd>${escapeHtml(dateText(status.lastAttemptAt, timeZone))}</dd></div><div><dt>${deleted ? '历史作品覆盖' : '作品覆盖'}</dt><dd>${escapeHtml(worksCoverage)}</dd></div></dl>${lifecycleEvidenceMarkup(account, timeZone)}${sources ? `<details class="account-detail__sources"><summary>查看名单来源</summary><ul>${sources}</ul></details>` : '<p class="account-detail__hint">暂无名单来源记录。</p>'}${warnings.length ? `<details class="account-detail__warnings"><summary>查看${deleted ? '历史采集记录' : '采集说明'}（${warnings.length}）</summary>${deleted ? '<p class="account-detail__hint">以下保留历史诊断，不是当前待办；当前主页状态以上方注销证据为准。</p>' : ''}<ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></details>` : ''}</section>
    <div class="account-detail__action-error" role="alert">${options.actionError ? escapeHtml(options.actionError) : ''}</div>
  </div>
  <footer class="account-detail__footer"><span>${canManage ? deleted ? '启停只控制主页状态检查，不改变平台注销状态' : '更改启停不会删除历史数据' : '当前仅查看账号资料'}</span>${canManage ? `<button type="button" class="account-detail__manage" data-detail-enabled="${!account.enabled}" data-detail-focus="enabled" ${options.actionBusy ? 'disabled' : ''}>${options.actionBusy ? '正在保存…' : account.enabled ? '暂停监控' : '启用监控'}</button>` : ''}</footer>`;
}

/**
 * api(path,{signal}) returns the response JSON.
 * onAction({type:'set-enabled',targetId,enabled,target}) owns all authorization and mutations.
 * canManage() optionally controls edit visibility using the host's current permission state.
 * onBoardSelect(key,{targetId}) owns main-page navigation. Opening is strictly read-only.
 */
export function createAccountDetail({ api, onAction, onBoardSelect, canManage, document: documentRef = globalThis.document } = {}) {
  if (typeof api !== 'function') throw new TypeError('账号详情需要 api 读取函数');
  if (!documentRef?.body) throw new Error('账号详情需要已就绪的页面');
  const idPrefix = `account-detail-${++instanceCount}`;
  const dialog = documentRef.createElement('dialog');
  dialog.className = 'account-detail';
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', `${idPrefix}-title`);
  dialog.setAttribute('role', 'dialog');
  dialog.tabIndex = -1;
  documentRef.body.append(dialog);
  const state = {
    targetId: null, period: 'day', range: {}, trendDays: 30, trendMetric: 'followers',
    payload: null, loading: false, error: '', actionError: '', actionBusy: false,
  };
  let opened = false;
  let destroyed = false;
  let requestVersion = 0;
  let actionVersion = 0;
  let controller = null;
  let returnFocus = null;
  let returnAccountId = null;
  let originalOverflow = '';
  let inertSiblings = [];
  const canEdit = () => typeof onAction === 'function'
    && (typeof canManage === 'function' ? Boolean(canManage()) : canManage !== false);

  const focusedControl = () => documentRef.activeElement?.getAttribute?.('data-detail-focus');
  function focusControl(key = 'close') {
    const control = [...dialog.querySelectorAll('[data-detail-focus]')]
      .find((element) => element.getAttribute('data-detail-focus') === key && !element.disabled);
    (control || dialog).focus({ preventScroll: true });
  }

  function render() {
    const focusKey = dialog.contains(documentRef.activeElement) ? focusedControl() : null;
    dialog.setAttribute('aria-busy', String(state.loading));
    if (state.payload) {
      dialog.innerHTML = renderAccountDetail(state.payload, {
        idPrefix, period: state.period, trendDays: state.trendDays, trendMetric: state.trendMetric,
        canManage: canEdit(), actionBusy: state.actionBusy,
        actionError: state.actionError,
      });
      if (state.loading) dialog.insertAdjacentHTML('afterbegin', '<p class="account-detail__refreshing" role="status">正在更新详情…</p>');
      if (state.error) dialog.insertAdjacentHTML('afterbegin', `<div class="account-detail__load-error" role="alert"><span>${escapeHtml(state.error)}</span><button type="button" data-detail-retry data-detail-focus="retry">重试读取</button></div>`);
    } else {
      dialog.innerHTML = `<header class="account-detail__header"><div class="account-detail__topline"><h2 id="${idPrefix}-title">账号详情</h2><button type="button" class="account-detail__close" data-detail-close data-detail-focus="close" aria-label="关闭账号详情">关闭</button></div></header><div class="account-detail__body"><section class="account-detail__empty" role="${state.error ? 'alert' : 'status'}"><strong>${state.error ? '暂时无法读取账号详情' : '正在读取账号资料…'}</strong><p>${escapeHtml(state.error || '正在获取已保存的指标、趋势与来源记录。')}</p>${state.error ? '<button type="button" class="account-detail__primary" data-detail-retry data-detail-focus="retry">重试读取</button>' : ''}</section></div>`;
    }
    if (focusKey && opened) focusControl(focusKey);
  }

  async function refresh() {
    if (!opened || destroyed) return null;
    const version = ++requestVersion;
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    const targetId = state.targetId;
    const period = state.period;
    state.loading = true;
    state.error = '';
    render();
    try {
      const response = await api(accountInsightPath(targetId, { period, ...state.range }), { signal });
      if (!opened || version !== requestVersion || signal.aborted) return null;
      const payload = normalizeAccountInsight(response);
      if (Number(payload.account.id) !== targetId) throw new Error('返回账号与请求不一致，已停止展示');
      state.payload = payload;
      return payload;
    } catch (error) {
      if (!opened || version !== requestVersion || signal.aborted || error?.name === 'AbortError') return null;
      state.error = error?.message || '读取失败，请稍后重试';
      return null;
    } finally {
      if (opened && version === requestVersion && !signal.aborted) {
        state.loading = false;
        render();
      }
    }
  }

  function close() {
    if (!opened) return;
    opened = false;
    requestVersion += 1;
    actionVersion += 1;
    controller?.abort();
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
    if (documentRef.body.style.overflow === 'hidden') documentRef.body.style.overflow = originalOverflow;
    for (const [element, previous] of inertSiblings) element.inert = previous;
    inertSiblings = [];
    let focusTarget = returnFocus?.isConnected !== false ? returnFocus : null;
    if (!focusTarget && returnAccountId) {
      focusTarget = [...(documentRef.querySelectorAll?.('[data-account]') || [])]
        .find((element) => element.getAttribute('data-account') === returnAccountId
          && (!element.getClientRects || element.getClientRects().length));
    }
    focusTarget?.focus?.({ preventScroll: true });
  }

  async function open(targetId, options = {}) {
    const id = Number(targetId);
    if (destroyed) throw new Error('账号详情已销毁');
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('账号 ID 无效');
    const path = accountInsightPath(id, options);
    const parameters = new URL(path, 'https://local.invalid').searchParams;
    if (!opened) {
      returnFocus = documentRef.activeElement;
      returnAccountId = returnFocus?.getAttribute?.('data-account');
      originalOverflow = documentRef.body.style.overflow;
    }
    state.targetId = id;
    state.period = parameters.get('period');
    state.range = Object.fromEntries(['startDate', 'endDate', 'comparisonStartDate', 'comparisonEndDate']
      .filter((key) => parameters.has(key)).map((key) => [key, parameters.get(key)]));
    state.trendDays = state.period === 'custom' ? 'range' : 30;
    state.payload = null;
    state.error = '';
    state.actionError = '';
    state.actionBusy = false;
    actionVersion += 1;
    render();
    if (!opened) {
      opened = true;
      documentRef.body.style.overflow = 'hidden';
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else {
        dialog.setAttribute('open', '');
        inertSiblings = [...documentRef.body.children].filter((element) => element !== dialog)
          .map((element) => [element, element.inert]);
        for (const [element] of inertSiblings) element.inert = true;
      }
    }
    focusControl();
    return refresh();
  }

  async function changeEnabled(enabled) {
    if (!canEdit() || !state.payload || state.actionBusy) return;
    const targetId = state.targetId;
    const version = ++actionVersion;
    state.actionBusy = true;
    state.actionError = '';
    render();
    try {
      await onAction({ type: 'set-enabled', targetId, enabled, target: state.payload.account });
      if (opened && version === actionVersion && targetId === state.targetId) await refresh();
    } catch (error) {
      if (opened && version === actionVersion) state.actionError = error?.message || '操作未完成，请重试';
    } finally {
      if (opened && version === actionVersion) {
        state.actionBusy = false;
        render();
      }
    }
  }

  function onClick(event) {
    const button = event.target?.closest?.('button');
    if (button && dialog.contains(button)) {
      if (button.hasAttribute('data-detail-close')) close();
      else if (button.hasAttribute('data-detail-retry')) void refresh();
      else if (button.hasAttribute('data-detail-period')) {
        const period = button.getAttribute('data-detail-period');
        if (!Object.hasOwn(PERIODS, period)) return;
        state.period = period;
        if (period !== 'custom') { state.range = {}; state.trendDays = 30; }
        state.payload = null;
        void refresh();
      } else if (button.hasAttribute('data-detail-metric')) {
        const metric = button.getAttribute('data-detail-metric');
        state.trendMetric = Object.hasOwn(TREND_METRICS, metric) ? metric : 'followers';
        render();
      } else if (button.hasAttribute('data-detail-days')) {
        const days = button.getAttribute('data-detail-days');
        state.trendDays = days === 'range' ? 'range' : days === '7' ? 7 : 30;
        render();
      } else if (button.hasAttribute('data-detail-enabled')) {
        void changeEnabled(button.getAttribute('data-detail-enabled') === 'true');
      } else if (button.hasAttribute('data-detail-board') && onBoardSelect) {
        const key = button.getAttribute('data-detail-board');
        const targetId = state.targetId;
        close();
        void Promise.resolve().then(() => onBoardSelect(key, { targetId })).catch(() => {});
      }
      return;
    }
    if (event.target === dialog) {
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right
        || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll('button, a[href], summary, [tabindex]')]
      .filter((element) => !element.disabled && !element.hidden && element.tabIndex >= 0
        && (!element.getClientRects || element.getClientRects().length));
    const first = items[0];
    const last = items.at(-1);
    if (!first) { event.preventDefault(); dialog.focus(); return; }
    if (event.shiftKey && (documentRef.activeElement === first || documentRef.activeElement === dialog)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (documentRef.activeElement === last || !dialog.contains(documentRef.activeElement))) {
      event.preventDefault(); first.focus();
    }
  }

  dialog.addEventListener('click', onClick);
  dialog.addEventListener('keydown', onKeyDown);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('close', close);
  return {
    open, close, refresh,
    destroy() { close(); destroyed = true; dialog.remove(); },
  };
}
