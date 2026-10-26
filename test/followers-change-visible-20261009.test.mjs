import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

function render(metric, delta, { period = 'custom', dailyComparable = true, direction = 'desc', sort = 'followers.delta', likesDelta = 70, likesDailyComparable = true } = {}) {
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8')
    .replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  const context = { ...model, fmt: model.formatNumber, URL, URLSearchParams, Intl, Date,
    location: new URL('http://fixture.invalid/?theme=tuantuan&period=month#overview'), document: {}, window: {} };
  runInNewContext(`${source}\nthis.subject={state,overviewAccountTable};`, context);
  const { state, overviewAccountTable } = context.subject;
  state.workflowMetric = metric; state.sort = sort; state.direction = direction; state.data = { period };
  const account = { id: 99, label: '核对作者', platform: 'douyin', status: {}, metrics: {
    followers: { value: 100, delta, dailyComparable }, likes: { value: 800, delta: likesDelta, dailyComparable: likesDailyComparable },
    posts: { value: 30, delta: 5 }, estimatedPlays: { delta: 7000 } } };
  return overviewAccountTable([account]);
}

for (const metric of ['followers', 'likes', 'posts', 'estimatedPlays']) {
  test(`followers change stays adjacent to follower stock while focused on ${metric}`, () => {
    const html = render(metric, 23), head = html.split('</thead>')[0];
    const keys = [...head.matchAll(/data-sort="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(keys.slice(0, 3), ['label', 'followers.value', 'followers.delta']);
    assert.equal(keys.filter(key => key === 'followers.delta').length, 1);
    assert.equal(keys.filter(key => key === `${metric}.delta`).length, 1);
    assert.match(html, />\+23</);
    assert.match(head, /aria-sort="descending"><button[^>]+data-sort="followers.delta"/);
  });
  test(`likes change stays adjacent to like stock while focused on ${metric}`, () => {
    const html = render(metric, 23), head = html.split('</thead>')[0];
    const keys = [...head.matchAll(/data-sort="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(keys.slice(0, 6), ['label', 'followers.value', 'followers.delta', 'likes.value', 'likes.delta', 'posts.value']);
    assert.equal(keys.filter(key => key === 'likes.delta').length, 1);
    assert.equal(keys.filter(key => key === `${metric}.delta`).length, 1);
    assert.match(html, />\+70</);
  });
}
test('follower decline, true zero and missing values preserve their own meaning', () => {
  assert.match(render('likes', -19), />-19</);
  assert.match(render('posts', 0), /class="flat"[^>]*>0</);
  const html = render('likes', null), firstRow = html.split('<tbody>')[1];
  const cells = firstRow.match(/<td\b[^>]*>[\s\S]*?<\/td>/g);
  assert.match(cells[2], /—/); assert.doesNotMatch(cells[2], />0</);
});
test('a daily non-comparable delta does not become a made-up daily follower change', () => {
  const html = render('posts', 23, { period: 'day', dailyComparable: false });
  const cells = html.split('<tbody>')[1].match(/<td\b[^>]*>[\s\S]*?<\/td>/g);
  assert.match(cells[2], /—/); assert.doesNotMatch(cells[2], />\+23</);
});
test('follower change header supports ascending direction independently of focused metric', () => {
  assert.match(render('likes', 23, { direction: 'asc' }), /aria-sort="ascending"><button[^>]+data-sort="followers.delta"/);
});
test('like decline, true zero and missing values preserve their own meaning', () => {
  const cell = (value, options = {}) => render('followers', 23, { likesDelta: value, ...options })
    .split('<tbody>')[1].match(/<td\b[^>]*>[\s\S]*?<\/td>/g)[4];
  assert.match(cell(-19), />-19</);
  assert.match(cell(0), /class="flat"[^>]*>0</);
  assert.match(cell(null), /—/); assert.doesNotMatch(cell(null), />0</);
  assert.match(cell(70, { period: 'day', likesDailyComparable: false }), /—/);
  assert.doesNotMatch(cell(70, { period: 'day', likesDailyComparable: false }), />\+70</);
});
test('like change header supports both sort directions without changing the focused metric', () => {
  for (const direction of ['asc', 'desc']) {
    const html = render('followers', 23, { sort: 'likes.delta', direction });
    assert.match(html, new RegExp(`aria-sort="${direction === 'asc' ? 'ascending' : 'descending'}"><button[^>]+data-sort="likes.delta"`));
  }
});
