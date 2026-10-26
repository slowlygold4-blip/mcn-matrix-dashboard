import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

const js = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/rebuild.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/rebuild.css', import.meta.url), 'utf8');

function fixture(payload = {}) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, textContent: '', innerHTML: '', value: '', hidden: false,
      attrs: {}, dataset: {}, setAttribute(k, v) { this.attrs[k] = v; }, insertAdjacentHTML(_position, value) { this.innerHTML += value; } });
    return nodes.get(id);
  };
  const context = { ...model, fmt: model.formatNumber, URL, URLSearchParams, AbortController, Date, Intl, setTimeout, clearTimeout,
    location: { href: 'https://matrix.example.test/?theme=tuantuan&classification=custom%3Aai#overview' },
    history: { replaceState() {} }, window: {},
    document: { getElementById: node, querySelectorAll: () => [], querySelector: () => node('date-controls') },
    fetch: async () => ({ ok: true, json: async () => payload }) };
  runInNewContext(`${js.replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '')}
    this.subject = { state, renderCatalog, loadMonitoringStatus, setView, sourceTaskReadout };`, context);
  const state = context.subject.state;
  state.start = '2026-09-21'; state.end = '2026-09-27';
  state.data = { range: { startDate: state.start, endDate: state.end }, accounts: [], boards: [],
    themeSummary: { items: [{ key: 'tuantuan', label: '团团', count: 3 }] },
    classificationSummary: { items: [{ key: 'custom:ai', label: 'AI 二创', count: 2 }] } };
  return { ...context.subject, node, setFetch: fn => { context.fetch = fn; } };
}

test('first-screen controls use native closed disclosures and keep data caveats outside', () => {
  for (const id of ['filterDetails', 'operationsDetails']) {
    const details = html.match(new RegExp(`<details id="${id}"[^>]*>([\\s\\S]*?)</details>`));
    assert.ok(details, `${id} is present`);
    assert.doesNotMatch(details[0].split('>')[0], /\bopen\b/);
    assert.match(details[1], /<summary>/);
    assert.doesNotMatch(details[1], /id="(?:notice|liveSyncStatus|rangeEvidence|kpiGrid)"/);
  }
  const operationsEnd = html.indexOf('</details>', html.indexOf('<details id="operationsDetails"'));
  const runtimeBoundary = html.indexOf('id="runtimeCollectionBoundary"');
  assert.ok(runtimeBoundary < operationsEnd, 'the full operational explanation belongs inside its disclosure');
  assert.ok(html.indexOf('id="runtimeCollectionHint"') > operationsEnd,
    'a compact, honest offline and refresh boundary remains visible when the disclosure is collapsed');
  assert.match(html, /id="runtimeCollectionHint">刷新快照 = 发起全局采集 \+ 更新数据；采集需本机开机联网，失败和缺测不补零。/);
  const filterStart = html.indexOf('<details id="filterDetails"');
  const filterEnd = html.indexOf('</details>', filterStart);
  assert.match(html.slice(filterStart, filterEnd), /<summary><strong>范围设置<\/strong>/);
  assert.ok(html.indexOf('id="primaryScope"') > filterStart && html.indexOf('id="primaryScope"') < filterEnd,
    'editable matrix, theme and content controls live in the explicit range editor');
  assert.ok(html.indexOf('id="appliedScopeBar"') < filterStart,
    'the applied matrix, theme, classification and period remain visible without opening the editor');
  assert.match(html, /id="adjustScopeButton"[^>]+aria-controls="filterDetails"/);
  assert.match(html, /关机、睡眠或断网期间会暂停/);
  assert.match(html, /离线缺口不补造/);
  assert.match(html, /公开只读镜像仅展示已发布快照，不在云端执行采集/);
  assert.match(css, /#runtimeCollectionBoundary[^}]*overflow-wrap:\s*anywhere/,
    'the expanded operational explanation wraps instead of widening the viewport');
  const publicViewLink = html.match(/<a class="public-view-link"[^>]+>([^<]+)<span aria-hidden="true">↗<\/span><\/a>/);
  assert.ok(publicViewLink, 'the local admin provides a visible public read-only link');
  assert.match(publicViewLink[0], /href="https:\/\/mcn-matrix-observatory\.slowlygold4\.chatgpt\.site\/"/);
  assert.match(publicViewLink[0], /target="_blank" rel="noopener noreferrer"/);
  assert.match(publicViewLink[0], /仅查看已发布快照；账号管理、导入和采集仍在本机管理台/);
  assert.match(html, /class="metric-boundary">区间净变化 · 缺采不补零 · 估算播放 = 获赞净变化 × 100，非平台实际播放量/);
  const kpiPosition = html.indexOf('id="kpiGrid"');
  const recordedWindowPosition = html.indexOf('id="recordedWindowAlternative"');
  const themePosition = html.indexOf('class="theme-panel"');
  assert.ok(kpiPosition < recordedWindowPosition && recordedWindowPosition < themePosition,
    'when strict week/month totals are unknown, the real observed-window alternative must appear immediately after the KPI cards, not below the theme and classification grids');
  assert.match(js, /\$\('kpiGrid'\)\.insertAdjacentHTML\('afterend', '<div class="data-health"[^\n]+collection-panel/);
  assert.doesNotMatch(js, /\$\('kpiGrid'\)\.insertAdjacentHTML\('beforebegin'/);
  assert.match(html, /rebuild\.css\?v=\d{8}-[a-z0-9-]+/,
    'the current stylesheet must carry a versioned cache-busting URL');
  assert.match(html, /rebuild\.js\?v=\d{8}-[a-z0-9-]+/,
    'the current frontend bundle must carry a versioned cache-busting URL');
  assert.match(html, /rebuild\.js\?v=20261022-unified-roster-1/,
    'the unified work ledger release must use its new frontend cache generation');
  assert.doesNotMatch(html, /rebuild\.js\?v=20261010-tuantuan-classification-1/);
});

test('only redundant success feedback is suppressed; errors and small-screen denominators remain readable', () => {
  assert.match(css, /#loadFeedback\[data-state="success"\]\s*\{\s*display:\s*none/);
  assert.doesNotMatch(css, /#(?:notice|liveSyncStatus|monitoringBrief)\s*\{[^}]*display:\s*none/);
  assert.doesNotMatch(css, /#loadFeedback\[data-state="(?:warning|loading|error)"\]\s*\{[^}]*display:\s*none/);
  assert.match(css, /#overviewView \.kpi-label \.quality\s*\{[^}]*max-width:\s*none;[^}]*overflow:\s*visible;[^}]*white-space:\s*normal/);
  assert.match(css, /#filterDetails > summary:focus-visible, #operationsDetails > summary:focus-visible/);
});

test('collapsed filter summary retains custom deep links and uses the actually applied comparison', () => {
  const f = fixture(); f.state.compare = true;
  f.node('compareStart').value = '2026-01-01';
  f.state.data.comparison = { range: { startDate: '2026-09-14', endDate: '2026-09-20' } };
  f.renderCatalog();
  assert.match(f.node('filterBrief').textContent, /团团 · AI 二创 · 对比 2026-09-14 至 2026-09-20/);
  assert.doesNotMatch(f.node('filterBrief').textContent, /2026-01-01/);
  assert.equal(f.state.classification, 'custom:ai');
  assert.equal(f.node('classificationSelect').value, 'custom:ai');
});

test('collapsed operations summary takes complete works coverage from the verified 8-hour read, not the stale schedule field', async () => {
  const f = fixture({ scheduler: { scheduledProfileCompletedTargetCount: 279, scheduledWorksCompleteTargetCount: 0, scheduledAccountTargetCount: 756,
    scheduledTopicMetricCompletedTargetCount: 3, scheduledTopicTargetCount: 4 },
    updateSla: { works: { fresh8h: { total: 701, complete: 5,
      counts: { complete: 5, limited: 240, unavailable: 452, unknown: 0, missing: 4 } } } },
    sourcePoller: { status: 'warning', checkedTodayCount: 3, sourceCount: 8, uncheckedCount: 5, failedCount: 1, blockedCount: 2, staleCount: 8,
      businessPendingCount: 2, sources: [{ lastStatus: 'submitted' }, { lastStatus: 'unchanged' }, { lastStatus: 'submitted' }] } });
  await f.loadMonitoringStatus();
  assert.equal(f.node('monitoringBrief').textContent, '全局本轮主页 279/756 · 近 8 小时完整作品明细 5/701 · 有作品样本 245/701 · 话题双指标 3/4 · 来源今日已检查 3/8 · 成功读取 — · 来源任务在途 — · 未检查 5 · 失败 1 · 受限 2 · 过期 3');
  assert.equal(f.node('monitoringBrief').attrs['data-state'], 'warning');
  assert.doesNotMatch(f.node('monitoringBrief').textContent, /100%|全部完成|全部成功/);
  const panel = f.node('monitoringStatus').innerHTML;
  assert.match(panel, /话题每日监控 · 双指标/);
  assert.match(panel, /参与人数与实际播放量均有有效观测 3 \/ 4/);
  assert.match(panel, /历史回执含待审记录：2 个来源/);
  assert.match(panel, /历史回执保留任务完成时的结果，不代表当前仍在排队/);
  assert.match(panel, /data-open-source-review>查看来源回执与逐项审查/);
});

test('historical source review does not masquerade as current work or override current source health', async () => {
  const f = fixture({ scheduler: {}, sourcePoller: { status: 'ok', checkedTodayCount: 8, sourceCount: 8, successfulTodayCount: 8,
    uncheckedCount: 0, failedCount: 0, blockedCount: 0, staleCount: 0, businessPendingCount: 1,
    currentJobScope: 'registered-source-latest-import-jobs-not-author-identity-queue', activeJobCount: 0, activeJobUnknownCount: 0,
    sources: [{ lastStatus: 'submitted' }] } });
  await f.loadMonitoringStatus();
  assert.match(f.node('monitoringBrief').textContent, /来源今日已检查 8\/8 · 成功读取 8 · 来源任务在途 0/);
  assert.doesNotMatch(f.node('monitoringBrief').textContent, /业务结果待核实|历史|全部完成/);
  assert.equal(f.node('monitoringBrief').attrs['data-state'], 'ready');
  assert.match(f.node('monitoringStatus').innerHTML, /历史回执含待审记录：1 个来源/);
});

test('current source task counts require their bounded source scope and no unknown references', () => {
  const f = fixture(), count = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : '—';
  const base = { currentJobScope: 'registered-source-latest-import-jobs-not-author-identity-queue',
    activeJobCount: 2, activeJobUnknownCount: 0, historicalReviewSourceCount: 15,
    historicalReviewSourceCountUnit: 'sources-with-historical-pending-completion-receipts-not-authors' };
  assert.equal(f.sourceTaskReadout(base, count).active, '2');
  assert.equal(f.sourceTaskReadout(base, count).historical, '15');
  assert.equal(f.sourceTaskReadout({ ...base, activeJobUnknownCount: 1 }, count).active, '—');
  assert.match(f.sourceTaskReadout({ ...base, activeJobUnknownCount: 1 }, count).unknownNote, /1 个任务引用状态未确认/);
  assert.equal(f.sourceTaskReadout({ ...base, currentJobScope: 'identity-queue' }, count).active, '—');
  for (const value of [null, '0', -1, NaN, 0.5]) assert.equal(f.sourceTaskReadout({ ...base, activeJobUnknownCount: value }, count).active, '—');
  assert.equal(f.sourceTaskReadout({}, count).historical, '—');
});

test('source review shortcut expands its destination and focuses it without submitting or collecting', () => {
  const calls = [], nodes = { sourceImportHistory: { open: false }, sourceImportResults: {
    setAttribute: (...args) => calls.push(['attribute', ...args]), focus: () => calls.push(['focus']),
    scrollIntoView: value => calls.push(['scroll', value.behavior]),
  } };
  const block = js.slice(js.indexOf('function openSourceReview()'), js.indexOf('async function loadMonitoringStatus'));
  runInNewContext(`${block}\nopenSourceReview();`, { setView: view => calls.push(['view', view]), $: id => nodes[id] });
  assert.equal(nodes.sourceImportHistory.open, true);
  assert.deepEqual(calls, [['view', 'import'], ['attribute', 'tabindex', '-1'], ['focus'], ['scroll', 'auto']]);
  assert.match(js, /hasAttribute\('data-open-source-review'\).*openSourceReview\(\)/);
});

test('works coverage shows complete, limited, unavailable and truly unobserved rows separately', async () => {
  const f = fixture({ scheduler: { scheduledProfileCompletedTargetCount: 697, scheduledWorksCompleteTargetCount: 0, scheduledAccountTargetCount: 701,
    scheduledTopicMetricCompletedTargetCount: 4, scheduledTopicTargetCount: 4 }, updateSla: { works: { fresh8h: {
      total: 701, complete: 0, counts: { complete: 0, limited: 240, unavailable: 457, unknown: 0, missing: 4 },
      latestAttemptDiagnostics: { attemptedTargets: 100, failureCount: 61, reasons: { http403: 59, loginRequired: 0, rateLimited: 0,
        collectorPartial: 1, collectorUnavailable: 0, networkError: 1, upstreamChanged: 0, other: 0 } },
    } } } });
  await f.loadMonitoringStatus();
  const panel = f.node('monitoringStatus').innerHTML;
  assert.match(panel, /近 8 小时作品明细：有样本 240 \/ 701（完整 0） · 有限 240 · 未取得 457 · 未核验 0 · 无记录 4/);
  assert.match(panel, /已核验的最近尝试异常 61 \/ 100 个有记录账号：HTTP 403 访问被拒 59、采集异常（有样本） 1、网络\/响应异常 1/);
  assert.match(panel, /完整表示连续公开分页通过校验且与主页总数匹配；跨批次采样不是同一时点快照。有限表示只覆盖已确认的公开窗口/);
  assert.match(panel, /官方账号视频列表需应用审核、video\.list 权限及账号持有人授权，且最多4页/);
  assert.match(panel, /本台目前没有此官方授权连接器，不能匿名查全矩阵/);
  assert.match(panel, /https:\/\/open\.douyin\.com\/platform\/resource\/docs\/openapi\/video-management\/douyin\/search-video\/account-video-list\//);
  assert.match(f.node('monitoringBrief').textContent, /有作品样本 240\/701/);
});

test('invalid works coverage breakdown stays unknown instead of rendering misleading totals', async () => {
  const f = fixture({ updateSla: { works: { fresh8h: { total: 2, complete: 0,
    counts: { complete: 0, limited: 2, unavailable: 0, unknown: 0, missing: 1 } } } } });
  await f.loadMonitoringStatus();
  assert.match(f.node('monitoringStatus').innerHTML, /近 8 小时作品明细分类待确认/);
  assert.match(f.node('monitoringBrief').textContent, /有作品样本 —\/—/);
  assert.doesNotMatch(f.node('monitoringStatus').innerHTML, /有限 2.*无记录 1/);
});

test('unbalanced works error summaries are suppressed and raw diagnostics never reach HTML', async () => {
  const f = fixture({ updateSla: { works: { fresh8h: { total: 2, complete: 0,
    counts: { complete: 0, limited: 1, unavailable: 1, unknown: 0, missing: 0 },
    latestAttemptDiagnostics: { attemptedTargets: 1, failureCount: 2, message: 'SECRET https://example.test/token',
      reasons: { http403: 1, loginRequired: 0, rateLimited: 0, collectorPartial: 0, collectorUnavailable: 0,
        networkError: 0, upstreamChanged: 0, other: 0 } } } } } });
  await f.loadMonitoringStatus();
  const panel = f.node('monitoringStatus').innerHTML;
  assert.doesNotMatch(panel, /已核验的最近尝试异常|SECRET|https:\/\/example\.test|token/);
});

test('missing operation counts remain unknown and failed status remains exposed when collapsed', async () => {
  const f = fixture(); await f.loadMonitoringStatus();
  assert.match(f.node('monitoringBrief').textContent, /本轮主页 —\/— · 近 8 小时完整作品明细 —\/— · 有作品样本 —\/— · 话题双指标 —\/— · 来源今日已检查 —\/—/);
  assert.match(f.node('monitoringBrief').textContent, /未检查 — · 失败 — · 受限 — · 过期 —/);
  const data = f.state.data;
  f.setFetch(async () => { throw new Error('offline'); });
  await f.loadMonitoringStatus();
  assert.match(f.node('monitoringBrief').textContent, /状态暂不可用/);
  assert.equal(f.node('monitoringBrief').attrs['data-state'], 'error');
  assert.equal(f.state.data, data);
  assert.match(html, /元数据检查不等于名单内容同步/);
  assert.doesNotMatch(js, /本轮完整作品明细 \$\{count\(scheduler\.scheduledWorksCompleteTargetCount\)/);
});

test('topic monitor distinguishes a genuine empty configuration from unknown coverage', async () => {
  const f = fixture({ scheduler: { scheduledTopicMetricCompletedTargetCount: 0, scheduledTopicTargetCount: 0 } });
  await f.loadMonitoringStatus();
  assert.match(f.node('monitoringBrief').textContent, /话题双指标 0\/0/);
  assert.match(f.node('monitoringStatus').innerHTML, /未配置话题/);
  assert.match(css, /@media\s*\(max-width:\s*960px\)\s*\{\s*\.monitoring-status\s*\{[^}]*grid-template-columns:\s*1fr/);
});

test('all four views retain operations; topics keep date scope without account filters', () => {
  const f = fixture();
  for (const view of ['overview', 'accounts', 'topics', 'import']) {
    f.setView(view, { renderData: false });
    assert.equal(f.node('operationsDetails').hidden, false, `${view} retains operational access`);
    assert.equal(f.node('filterDetails').hidden, view === 'import');
    assert.equal(f.node('appliedScopeBar').hidden, view === 'import');
    assert.equal(f.node('primaryScope').hidden, ['topics', 'import'].includes(view));
  }
});

test('theme and classification operating totals explicitly include paused accounts unlike enabled-account KPIs', () => {
  for (const id of ['themeTitle', 'classificationTitle']) {
    const section = html.match(new RegExp(`<h2 id="${id}">[^<]+</h2><p class="muted">([^<]+)</p>`));
    assert.ok(section, `${id} has a directly visible explanatory caption`);
    assert.match(section[1], /主题人数包含来源资料，平台变化仅统计有实测的启用账号|已确认归属团团的合并名册统一以“切片矩阵”为主分类/);
  }
  assert.match(js, /const total = s\.enabledCount/);
  assert.match(js, /unifiedRosterCaption\(scopedAccounts\)/);
});
