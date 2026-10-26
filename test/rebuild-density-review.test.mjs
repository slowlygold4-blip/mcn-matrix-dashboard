import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

const html = readFileSync(new URL('../public/rebuild.html', import.meta.url), 'utf8');
const code = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8');
function assertOutsideDisclosure(position) {
  assert.ok(position >= 0, 'the visible element must exist');
  let depth = 0;
  for (const [tag] of html.slice(0, position).matchAll(/<\/?details\b[^>]*>/g)) {
    depth += tag.startsWith('</') ? -1 : 1;
  }
  assert.equal(depth, 0, 'the required visible element cannot be inside a collapsed disclosure');
}
function fixture() {
  const nodes = new Map();
  const document = { activeElement: null, getElementById: id => node(id),
    querySelectorAll: selector => selector === 'details' ? [node('filterDetails'), node('operationsDetails'), node('collectionPanel')] : [] };
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { id, innerHTML: '', textContent: '', value: '', hidden: false, open: false,
      disabled: false, isConnected: true, dataset: {}, attributes: {}, scrollLeft: 0, scrollTop: 0,
      setAttribute(name, value) { this.attributes[name] = value; }, closest: () => null,
      focus() { document.activeElement = this; }, insertAdjacentHTML(_position, value) { this.innerHTML += value; } });
    return nodes.get(id);
  }
  const context = { ...model, fmt: model.formatNumber, document, URL, URLSearchParams, Intl, Date, AbortController, setTimeout, clearTimeout,
    location: new URL('http://fixture.invalid/#overview'),
    window: { scrollX: 17, scrollY: 412, scrollTo(value) { this.lastScroll = value; } },
    fetch: async () => ({ ok: true, status: 200, json: async () => context.monitoring }) };
  const source = code.replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  runInNewContext(`${source}\nthis.review={state,renderSummary,renderCollectionCoverage,loadMonitoringStatus,captureReadingPosition,restoreReadingPosition};`, context);
  const r = context.review;
  r.state.start = '2026-09-28'; r.state.end = '2026-09-28';
  r.state.data = { period: 'day', range: { startDate: r.state.start, endDate: r.state.end }, accounts: [],
    summary: { enabledCount: 8, pendingCount: 8, staleCount: 0, trend: [],
      metrics: Object.fromEntries(Object.keys(model.METRICS).map(key => [key, { value: null, delta: null,
        comparableCount: 0, fullPeriodComparableCount: 0, observedCount: 0, percent: null }])) } };
  return { ...r, node, window: context.window, document,
    monitoring(value) { context.monitoring = value; } };
}

test('independent density: estimate and missing-data warning remain outside all collapsed disclosures', () => {
  const overview = html.slice(html.indexOf('<section id="overviewView"'), html.indexOf('<section class="theme-panel"'));
  const boundary = overview.match(/<p class="metric-boundary"[^>]*>[\s\S]*?<\/p>/)?.[0];
  assert.ok(boundary, 'the warning is a standalone visible paragraph, not just text inside a disclosure');
  assert.match(boundary, /缺采不补零/);
  assert.match(boundary, /估算播放\s*=\s*获赞净变化\s*×\s*100/);
  assert.match(boundary, /非平台实际播放量/);
  assert.doesNotMatch(boundary, /<[^>]*\bhidden\b|aria-hidden="true"/);
  assert.doesNotMatch(overview.match(/^<section[^>]*>/)?.[0] || '', /\bhidden\b|aria-hidden="true"/);
  assertOutsideDisclosure(html.indexOf(boundary));
  assert.ok(overview.indexOf('metric-boundary') < overview.indexOf('id="kpiGrid"'));
});

test('independent density: collapsed controls use native keyboard-operable summaries with meaningful names', () => {
  for (const [id, label] of [['filterDetails', '范围设置'], ['operationsDetails', '自动更新与来源']]) {
    const start = html.indexOf(`<details id="${id}"`);
    assert.ok(start >= 0);
    const block = html.slice(start, html.indexOf('</details>', start));
    assert.match(block, new RegExp(`<summary><strong>${label}</strong>`));
    assert.doesNotMatch(block.match(/<summary[^>]*>/)?.[0] || '', /tabindex="-1"|aria-hidden/);
  }
  const primary = html.match(/<section id="primaryScope"[^>]*>/)?.[0];
  assert.ok(primary, 'theme and content controls have a permanent primary scope host');
  assert.match(primary, /aria-label="矩阵、主题与内容筛选"/);
  assert.doesNotMatch(primary, /\bhidden\b|aria-hidden="true"/);
  const filterStart = html.indexOf('<details id="filterDetails"');
  const filterEnd = html.indexOf('</details>', filterStart);
  assert.ok(html.indexOf(primary) > filterStart && html.indexOf(primary) < filterEnd,
    'editable scope controls belong to the explicitly opened range editor');
  const applied = html.match(/<section id="appliedScopeBar"[^>]*>/)?.[0];
  assert.ok(applied, 'the applied scope remains visible while the editor is collapsed');
  assert.match(applied, /aria-label="已应用数据范围"/);
  assertOutsideDisclosure(html.indexOf(applied));
  assert.ok(html.indexOf(applied) < filterStart);
  assert.match(html, /id="adjustScopeButton"[^>]+aria-controls="filterDetails"/);
  assert.match(html, /class="skip" href="#main"/);
  assert.match(html, /id="main"[^>]+tabindex="-1"/);
});

test('independent density: missing KPI values stay dashes with zero comparable coverage, not invented zero changes', () => {
  const f = fixture(); f.renderSummary();
  const output = f.node('kpiGrid').innerHTML;
  assert.equal((output.match(/0\/8 可比/g) || []).length, 4);
  assert.equal((output.match(/缺少可比起止快照/g) || []).length, 4);
  assert.match(output, /估算播放变化/);
  assert.doesNotMatch(output, /NaN|undefined|Infinity/);
  for (const [, value] of output.matchAll(/<div class="kpi-value">(.*?)<\/div>/g)) {
    assert.match(value, /—/); assert.doesNotMatch(value, />0</);
  }
  assert.match(f.node('collectionSummary').textContent, /暂无核验结果/);
  assert.doesNotMatch(f.node('collectionSummary').textContent, /0\/8/);
});

test('independent density: collapsed summary cannot conceal unavailable works or uninspected sources', async () => {
  const f = fixture();
  f.monitoring({ scheduler: { scheduleIntervalHours: 8, scheduledAccountTargetCount: 8,
    scheduledProfileCompletedTargetCount: 8, scheduledWorksCompleteTargetCount: 8,
    scheduledTopicMetricCompletedTargetCount: 3, scheduledTopicTargetCount: 4 },
    updateSla: { works: { fresh8h: { total: 8, complete: 0,
      counts: { complete: 0, limited: 0, unavailable: 8, unknown: 0, missing: 0 } } } },
    sourcePoller: { checkedTodayCount: 3, sourceCount: 5, uncheckedCount: 2, failedCount: 1, blockedCount: 1, staleCount: 2 } });
  await f.loadMonitoringStatus();
  const brief = f.node('monitoringBrief').textContent;
  assert.match(brief, /本轮主页 8\/8/); assert.match(brief, /近 8 小时完整作品明细 0\/8/);
  assert.match(brief, /有作品样本 0\/8/);
  assert.doesNotMatch(brief, /完整作品明细 8\/8/, 'obsolete scheduler success cannot override verified works evidence');
  assert.match(brief, /话题双指标 3\/4/);
  assert.match(brief, /来源今日(?:已检查)? 3\/5/); assert.match(brief, /未检查 2/);
  assert.match(brief, /失败 1/); assert.match(brief, /受限 1/);
  assert.match(f.node('monitoringStatus').innerHTML, /话题每日监控 · 双指标/);
  assert.match(f.node('monitoringStatus').innerHTML, /有限 0 · 未取得 8 · 未核验 0 · 无记录 0/);
  assert.doesNotMatch(brief, /100%|已同步|全部成功/);
});

test('independent density: refresh restores open disclosures, reading focus and scroll positions', () => {
  const f = fixture(); f.node('filterDetails').open = true; f.node('operationsDetails').open = false;
  f.node('collectionPanel').open = true; f.node('accountsTable').scrollLeft = 211;
  f.document.activeElement = f.node('scopeSummary');
  const position = f.captureReadingPosition();
  f.node('filterDetails').open = false; f.node('operationsDetails').open = true;
  f.node('collectionPanel').open = false; f.node('accountsTable').scrollLeft = 0;
  f.document.activeElement = f.node('pageTitle');
  f.restoreReadingPosition(position);
  assert.equal(f.node('filterDetails').open, true); assert.equal(f.node('operationsDetails').open, false);
  assert.equal(f.node('collectionPanel').open, true); assert.equal(f.node('accountsTable').scrollLeft, 211);
  assert.equal(f.document.activeElement.id, 'scopeSummary');
  assert.equal(f.window.lastScroll.top, 412); assert.equal(f.window.lastScroll.left, 17);
});
