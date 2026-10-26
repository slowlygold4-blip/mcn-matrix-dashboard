import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

function render(points, range = {}, latestKnown = {}, topic = {}) {
  const grid = { innerHTML: '' };
  const context = { ...model, fmt: model.formatNumber, URL, URLSearchParams, Intl,
    location: new URL('http://127.0.0.1:4188/?period=custom&start=2026-09-12&end=2026-09-27#topics'),
    document: { getElementById: () => grid } };
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8')
    .replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  runInNewContext(`${source}\nthis.renderTopicsData=renderTopicsData;`, context);
  context.renderTopicsData({ startDate: '2026-09-12', endDate: '2026-09-27', ...range,
    topics: [{ label: '#测试话题', points, latestKnown, ...topic }] });
  return { html: grid.innerHTML, card: grid.innerHTML.split('<details>')[0] };
}
const stale = { date: '2026-09-21', baselineDate: '2026-09-20', participants: 309, views: 2250600, participantsDelta: 13, viewsDelta: 34400 };
const absent = { date: '2026-09-27', participants: null, views: null, participantsDelta: null, viewsDelta: null };

test('latest observed totals are prominent without masquerading as selected end-date data', () => {
  const { card, html } = render([stale, absent]);
  assert.match(card, /<strong[^>]*>309<\/strong>/);
  assert.match(card, /<strong[^>]*>225.06万<\/strong>/);
  assert.equal((card.match(/最近有效观测 2026-09-21/g) || []).length, 2);
  assert.match(card, /所选末日 2026-09-27 该指标暂无有效值，当前显示历史观测/);
  assert.match(card, /2026-09-21 较 2026-09-20.*\+13/);
  assert.doesNotMatch(card, /2026-09-27 较|末日较前日/);
  assert.match(html.split('<details>')[1], /2026-09-21/);
  assert.match(html.split('<details>')[1], /\+13/);
});
test('participants and views use independent endpoint and last-observed evidence', () => {
  const { card } = render([stale, { ...absent, baselineDate: '2026-09-26', participants: 400, participantsDelta: 4 }]);
  assert.match(card, /<strong[^>]*>400<\/strong>/);
  assert.match(card, /观测日期 2026-09-27/);
  assert.match(card, /2026-09-27 较 2026-09-26.*\+4/);
  assert.match(card, /<strong[^>]*>225.06万<\/strong>/);
  assert.equal((card.match(/最近有效观测 2026-09-21/g) || []).length, 1);
  assert.doesNotMatch(card, />309<\/strong>/);
});
test('genuine zero is not missing for either metric', () => {
  const { card } = render([{ ...absent, baselineDate: '2026-09-26', participants: 0, views: 0, participantsDelta: 0, viewsDelta: 0 }]);
  assert.equal((card.match(/<strong[^>]*>0<\/strong>/g) || []).length, 2);
  assert.doesNotMatch(card, /暂无有效值|历史观测|缺少前一日/);
  assert.match(card, /累计实际播放量/);
  assert.match(card, /非矩阵区间新增估算/);
});
test('no observations stay unknown, not zero, and do not invent historical dates', () => {
  const { card } = render([absent]);
  assert.equal((card.match(/<strong>—<\/strong>/g) || []).length, 2);
  assert.equal((card.match(/截至 2026-09-27 尚无有效观测/g) || []).length, 2);
  assert.doesNotMatch(card, /最近有效观测|<strong[^>]*>0<\/strong>/);
});
test('last observed metric is chronological, scoped, and cannot use a future point', () => {
  const { card, html } = render([{ ...stale, date: '2026-09-29', participants: 999 }, stale,
    { ...stale, date: '2026-09-22', participants: 320, views: null }, absent,
    { ...stale, date: '2026-09-11', views: 999 }]);
  assert.match(card, /<strong[^>]*>320<\/strong>/);
  assert.match(card, /最近有效观测 2026-09-22/);
  assert.match(card, /<strong[^>]*>225.06万<\/strong>/);
  assert.match(card, /最近有效观测 2026-09-21/);
  assert.doesNotMatch(html, /2026-09-29|2026-09-11|999/);
});
test('missing prior-day baseline keeps the end date total but delta unknown', () => {
  const { card } = render([{ ...absent, participants: 10, views: 50 }]);
  assert.match(card, /<strong[^>]*>10<\/strong>/);
  assert.match(card, /<strong[^>]*>50<\/strong>/);
  assert.equal((card.match(/变化 — · 缺少前一日可比采样/g) || []).length, 2);
  assert.doesNotMatch(card, /class="up"|暂无有效值/);
});

test('today keeps dated latest-known totals while its daily rows stay missing', () => {
  const { card, html } = render([absent], { startDate: absent.date }, {
    participants: { date: stale.date, value: 309, delta: 13, baselineDate: stale.baselineDate, capturedAt: '2026-09-21T11:05:00Z' },
    views: { date: '2026-09-22', value: 2500000, delta: 249400, baselineDate: stale.date },
  });
  assert.match(card, />309<\/strong>/);
  assert.match(card, />250\.00万<\/strong>/);
  assert.match(card, /2026-09-21 19:05（北京时间）/);
  assert.match(card, /最近有效观测 2026-09-22/);
  assert.match(card, /2026-09-22 较 2026-09-21/);
  const table = html.split('<details>')[1];
  assert.doesNotMatch(table, /309|250\.00万|2026-09-21|2026-09-22/);
  assert.match(table, /2026-09-27/);
});

test('future, rejected, and negative latest-known evidence cannot replace missing values', () => {
  for (const point of [
    { date: '2026-09-28', value: 12 },
    { date: '2026-09-26', value: 12, qualityStatus: 'rejected' },
    { date: '2026-09-26', value: -1 },
  ]) {
    const { card } = render([absent], {}, { participants: point, views: point });
    assert.equal((card.match(/<strong>—<\/strong>/g) || []).length, 2);
  }
});

test('a newer in-range observation wins over older latest-known evidence', () => {
  const { card } = render([stale, { ...absent, participants: 400, views: 500 }], {}, {
    participants: { date: '2026-09-11', value: 900 }, views: { date: '2026-09-11', value: 900 },
  });
  assert.match(card, />400<\/strong>/);
  assert.match(card, />500<\/strong>/);
  assert.doesNotMatch(card, /900|2026-09-11/);
});

test('a multi-day change cannot be labelled as daily change even with an upstream delta', () => {
  const { card } = render([{ ...stale, baselineDate: '2026-09-19' }]);
  assert.equal((card.match(/变化 — · 缺少前一日可比采样/g) || []).length, 2);
  assert.doesNotMatch(card, /\+13|\+3.44万|2026-09-21 较/);
});

test('paused topics stay visible with a clear note that daily updates are stopped', () => {
  const { card } = render([stale], {}, {}, { enabled: false });
  assert.match(card, /#测试话题/);
  assert.match(card, /已暂停，不参与每日更新/);
  assert.match(card, />309<\/strong>/);
});

test('warning-quality values carry their warning label into the summary cards', () => {
  const warning = { ...stale, qualityStatus: 'warning', warningCount: 2 };
  const { card } = render([warning]);
  assert.equal((card.match(/需留意 · 采样质量警告/g) || []).length, 2);
  assert.match(card, />309<\/strong>/);
  assert.match(card, />225\.06万<\/strong>/);
});
