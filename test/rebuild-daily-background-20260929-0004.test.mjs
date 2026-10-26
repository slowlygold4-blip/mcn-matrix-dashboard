import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

function data() {
  return { period: 'day', range: { startDate: '2026-09-29', endDate: '2026-09-29' }, accounts: [],
    summary: { enabledCount: 10, metrics: { followers: { delta: null } }, trend: Array.from({ length: 30 }, (_, i) => ({
      date: model.shiftDate('2026-09-29', i - 29), followersDelta: i === 29 ? null : i === 3 ? 0 : i - 5,
      followers: i === 29 ? null : 1000 + i, followersComparableCount: i === 29 ? 0 : 10,
      followersObservedCount: i === 29 ? 0 : 10, followersDeltaReliable: i !== 29,
      followersDeltaCohortKey: 'cohort-a', followersCohortKey: 'cohort-a' })) } };
}
function fixture(snapshot = data()) {
  const nodes = new Map(), node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, innerHTML: '', textContent: '', hidden: false, dataset: {},
      setAttribute() {}, querySelectorAll: () => [], querySelector: () => null });
    return nodes.get(id);
  };
  const context = { ...model, fmt: model.formatNumber, URL, URLSearchParams, Date, Intl,
    location: { href: 'http://matrix.test/#overview' },
    document: { getElementById: node, querySelector: node, querySelectorAll: () => [] } };
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  runInNewContext(`${source}\nthis.subject={state,renderTrend,chartMarkup,commit(c){appliedContext=c;}};`, context);
  const f = context.subject; f.state.data = snapshot; f.state.metric = 'followers'; f.state.period = 'day';
  f.commit({ period: 'day', start: snapshot.range.startDate, end: snapshot.range.endDate });
  return { ...f, node };
}

test('daily background shows 30 calendar days while single-day KPI and data remain untouched', () => {
  const snapshot = data(), before = JSON.stringify(snapshot), f = fixture(snapshot); f.renderTrend();
  assert.match(f.node('trendCaption').textContent, /近 30 天/);
  assert.match(f.node('chartAxis').innerHTML, /2026-08-31/);
  assert.match(f.node('trendEvidence').innerHTML, /2026-08-31/);
  assert.match(f.node('trendEvidence').innerHTML, /2026-09-29/);
  assert.equal((f.node('trendEvidence').innerHTML.match(/<tr(?:\s[^>]*)?>/g) || []).length, 31);
  assert.equal(JSON.stringify(snapshot), before); assert.equal(snapshot.summary.metrics.followers.delta, null);
});

test('historical fixed day backgrounds end at its selected cutoff, never at the machine today', () => {
  const snapshot = data(); snapshot.range = { startDate: '2026-09-20', endDate: '2026-09-20' };
  const f = fixture(snapshot); f.renderTrend();
  assert.match(f.node('chartAxis').innerHTML, /2026-08-22/);
  assert.match(f.node('chartAxis').innerHTML, /2026-09-20/);
  assert.doesNotMatch(f.node('trendEvidence').innerHTML, /2026-09-29/);
});

test('comparison and explicit custom periods stay limited to the selected interval', () => {
  const snapshot = data(); snapshot.comparison = { range: { startDate: '2026-09-28', endDate: '2026-09-28' }, summary: snapshot.summary };
  const f = fixture(snapshot); f.renderTrend(); assert.doesNotMatch(f.node('trendCaption').textContent, /近 30 天/);
  assert.equal((f.node('trendEvidence').innerHTML.match(/<tr>/g) || []).length, 2);
  delete snapshot.comparison; snapshot.period = 'custom';
  f.commit({ period: 'custom' }); f.renderTrend();
  assert.doesNotMatch(f.node('trendCaption').textContent, /近 30 天/);
  assert.equal((f.node('trendEvidence').innerHTML.match(/<tr>/g) || []).length, 2);
});

test('draft period changes do not change the background of already applied daily data', () => {
  const f = fixture(); f.state.period = 'custom'; f.state.start = '2099-01-01'; f.renderTrend();
  assert.match(f.node('chartAxis').innerHTML, /2026-08-31/); assert.doesNotMatch(f.node('chartAxis').innerHTML, /2099/);
});

test('missing coverage stays unknown while observed zero and negative daily changes remain visible', () => {
  const snapshot = data(); delete snapshot.summary.trend[0].followersComparableCount;
  const f = fixture(snapshot); f.renderTrend(); const table = f.node('trendEvidence').innerHTML;
  const first = table.match(/<tr><td[^>]*>2026-08-31[\s\S]*?<\/tr>/)?.[0] || '';
  assert.match(first, /—/); assert.doesNotMatch(first, />0 \/ 10</);
  assert.match(table, /-5/); assert.match(table, />0<\/span>/);
});

test('chart does not join observed values across an absent day or a changed cohort', () => {
  const f = fixture();
  const html = f.chartMarkup([{date:'2026-09-01',followersDelta:1,followersDeltaReliable:true,followersDeltaCohortKey:'a'},
    {date:'2026-09-03',followersDelta:2,followersDeltaReliable:true,followersDeltaCohortKey:'a'}], 'followersDelta');
  const path = html.match(/<path d="([^"]*)"/)?.[1] || '';
  assert.doesNotMatch(path, /L/); assert.equal((path.match(/M/g)||[]).length, 2);
});
