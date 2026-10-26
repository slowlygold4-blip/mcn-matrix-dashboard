import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { MonitorDatabase } from '../lib/database.mjs';
import { getProductInsights } from '../lib/product-insights.mjs';
import * as model from '../public/console-model.js';

// Real read model + actual console renderers; only DOM is substituted.
// No production database, server mutation, session or platform request.
function fixture(t, { baselineCount = 2, count = 10, current = 130 } = {}) {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const sample = database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,
    quality_status,account_status,works_coverage,source_checksum) VALUES(?,?,?,?,?,'validated','available','limited',?)`);
  for (let i = 0; i < count; i++) {
    const target = database.createTarget({ type: 'account', label: `离线团团作者${i + 1}`,
      locator: `MS4wLjABAAAADailyPeer${i}abcdefghijklmnop`, provider: 'public-web', metadata: { platform: 'douyin' } });
    database.assignTargetsToBoard([target.id], '一条小团团切片矩阵');
    // The report is historical (ends 2026-09-29), so its synthetic authors
    // and board relationships must already exist by that cutoff.
    database.db.prepare('UPDATE targets SET created_at=?,updated_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', target.id);
    database.db.prepare('UPDATE target_boards SET category=?,created_at=?,updated_at=? WHERE target_id=?')
      .run('切片', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', target.id);
    const add = (date, value) => sample.run(target.id, `${date}T02:00:00.000Z`, value, value * 10, value,
      `offline-${target.id}-${date}`);
    if (i < baselineCount) add('2026-09-11', 100);
    add('2026-09-14', 110); add('2026-09-29', current);
  }
  const options = { period: 'custom', startDate: '2026-09-12', endDate: '2026-09-29',
    theme: 'tuantuan', classification: 'slice', timeZone: 'Asia/Shanghai', reference: new Date('2026-09-29T04:00:00.000Z') };
  return { database, options, read: extra => getProductInsights(database, { ...options, ...extra }) };
}

function render(data, period = 'since') {
  const nodes = new Map(), node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', innerHTML: '', hidden: false,
      setAttribute() {}, insertAdjacentHTML() {}, querySelector() { return null; } });
    return nodes.get(id);
  };
  const context = { ...model, fmt: model.formatNumber, Date, URL, URLSearchParams, Intl,
    location: new URL(`http://offline.test/?theme=tuantuan&classification=slice&period=${period}`),
    document: { getElementById: node, querySelector: node, querySelectorAll: () => [] },
    history: { replaceState() {} }, beijingToday: () => '2026-09-29',
    rangeFor: p => model.rangeFor(p, '2026-09-29') };
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8')
    .replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  runInNewContext(`${source}\nthis.subject={state,renderSummary,renderMetricExplanation};`, context);
  context.subject.state.data = data;
  context.subject.state.explanationKey = 'followers';
  context.subject.renderSummary();
  return { ...context.subject, node };
}

test('since retains its actual September 12 endpoints but labels growth from only part of the matrix', t => {
  const f = fixture(t), raw = f.read(), before = JSON.stringify(raw);
  assert.equal(raw.summary.metrics.followers.delta, 60);
  assert.equal(raw.summary.metrics.followers.percent, 30);
  assert.equal(raw.summary.metrics.followers.comparableCount, 2);
  assert.equal(raw.recordedWindow.comparableCount, 10, 'broader common window exists but is not the requested operating period');
  const projected = model.projectRecordedWindow(raw, { period: 'since' });
  assert.equal(projected, raw, 'since must never silently replace the fixed business starting date');
  const ui = render(projected), html = ui.node('kpiGrid').innerHTML;
  assert.match(html, /部分账号净变化/);
  assert.match(html, /仅 2 个账号可比，其余 8 个不计入变化/);
  assert.match(html, /30\.00%/);
  assert.match(html, /title="60"/);
  assert.match(html, /最近已知存量合计 1,300/);
  assert.equal(JSON.stringify(raw), before, 'labels must not change source values, percentages, dates or cohort');
});

test('contribution explanation repeats the same partial cohort boundary, including the unchanged total', t => {
  const f = fixture(t), data = f.read(), ui = render(data);
  const html = ui.node('metricExplanation').innerHTML;
  assert.match(html, /部分账号净变化/);
  assert.match(html, /仅 2 个账号可比，其余 8 个不计入变化/);
  assert.match(html, /明细净变化合计 <strong>\+60<\/strong>/);
  assert.match(html, /2026-09-12 至 2026-09-29/);
  assert.equal(model.buildMetricContributions(data, 'followers').reconciled, true);
});

test('all-account comparable and zero-comparable results keep their distinct meanings', t => {
  const full = fixture(t, { baselineCount: 10 }), fullHtml = render(full.read()).node('kpiGrid').innerHTML;
  assert.doesNotMatch(fullHtml, /部分账号净变化|其余 0 个不计入变化/);
  assert.match(fullHtml, /本期净变化/);
  const empty = fixture(t, { baselineCount: 0 }), emptyHtml = render(empty.read()).node('kpiGrid').innerHTML;
  assert.match(emptyHtml, /末日已观测；缺开始日前一日基准/);
  assert.doesNotMatch(emptyHtml, /部分账号净变化|仅 0 个账号可比/);
});

test('missing selected end date names the exact metric and date while preserving the last known stock', t => {
  const f = fixture(t);
  f.database.db.prepare("DELETE FROM snapshots WHERE captured_at >= '2026-09-29T00:00:00.000Z' AND captured_at < '2026-09-30T00:00:00.000Z'").run();
  const data = f.read(), html = render(data).node('kpiGrid').innerHTML;
  assert.match(html, /末日 2026-09-29 该项无有效观测/);
  assert.match(html, /最近已知存量合计/);
  assert.match(html, /选中末日 2026-09-29 新采 0\/10 账号/);
  assert.equal(data.summary.metrics.followers.delta, null, 'missing endpoint must remain unknown, not zero');
});

test('zero and negative partial deltas remain real numbers rather than suppressed growth', t => {
  for (const current of [100, 90]) {
    const f = fixture(t, { current }), data = f.read(), ui = render(data);
    assert.match(ui.node('kpiGrid').innerHTML, /部分账号净变化/);
    assert.match(ui.node('kpiGrid').innerHTML, new RegExp(`title="${2 * (current - 100)}"`));
    assert.equal(data.summary.metrics.followers.delta, 2 * (current - 100));
  }
});

test('custom and comparison remain strict and the existing recorded preset contract remains intact', t => {
  const f = fixture(t), raw = f.read();
  for (const period of ['day', 'custom', 'since']) assert.equal(model.projectRecordedWindow(raw, { period }), raw);
  const compared = f.read({ comparisonStartDate: '2026-09-12', comparisonEndDate: '2026-09-29' });
  assert.equal(compared.recordedWindow, null);
  assert.equal(model.projectRecordedWindow(compared, { period: 'month', compare: true }), compared);
  for (const period of ['week', 'month', '30d']) {
    const projected = model.projectRecordedWindow(raw, { period });
    assert.equal(projected, raw, 'preset metrics keep the server exact-period result');
    assert.equal(projected.summary.metrics.followers.delta, raw.summary.metrics.followers.delta);
    assert.equal(projected.range, raw.range);
  }
});

test('each KPI names its own comparable cohort, with the estimated-play cohort following likes', t => {
  const f = fixture(t);
  f.database.db.prepare("UPDATE snapshots SET total_likes=NULL WHERE target_id=2 AND captured_at='2026-09-11T02:00:00.000Z'").run();
  const data = f.read(), before = JSON.stringify(data), ui = render(data);
  const cards = [...ui.node('kpiGrid').innerHTML.matchAll(/<article class="kpi">([\s\S]*?)<\/article>/g)].map(match => match[1]);
  assert.equal(cards.length, 4);
  for (const index of [0, 3]) assert.match(cards[index], /仅 2 个账号可比，其余 8 个不计入变化/);
  for (const index of [1, 2]) assert.match(cards[index], /仅 1 个账号可比，其余 9 个不计入变化/);
  ui.state.explanationKey = 'likes'; ui.renderMetricExplanation();
  assert.match(ui.node('metricExplanation').innerHTML, /仅 1 个账号可比，其余 9 个不计入变化/);
  assert.equal(JSON.stringify(data), before);
});

test('comparison uses its own partial cohort without relabeling a fully comparable main range', t => {
  const f = fixture(t), data = f.read({ startDate: '2026-09-15', comparisonStartDate: '2026-09-12', comparisonEndDate: '2026-09-29' });
  assert.equal(data.summary.metrics.followers.comparableCount, 10);
  assert.equal(data.comparison.summary.metrics.followers.comparableCount, 2);
  const ui = render(data, 'custom');
  const firstCard = ui.node('kpiGrid').innerHTML.match(/<article class="kpi">([\s\S]*?)<\/article>/)[1];
  const [primary, comparison] = firstCard.split('<div class="compare-note">');
  assert.match(primary, /本期净变化/); assert.doesNotMatch(primary, /部分账号净变化|其余/);
  assert.match(comparison, /对比时段 · 部分账号净变化/);
  assert.match(comparison, /仅 2 个账号可比，其余 8 个不计入变化/);
  assert.equal(data.summary.metrics.followers.delta, 200);
  assert.equal(data.comparison.summary.metrics.followers.delta, 60);
  assert.equal(data.recordedWindow, null);
});
