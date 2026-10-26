import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

function fixture() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: 'all', innerHTML: '', textContent: '' });
    return nodes.get(id);
  };
  let savedUrl;
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8')
    .replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  const context = {
    ...model, fmt: model.formatNumber, URL, URLSearchParams,
    location: { href: 'http://127.0.0.1:4188/?theme=tuantuan&classification=slice#accounts' },
    document: { getElementById: node, querySelector: node, querySelectorAll: () => [] },
    history: { replaceState: (_state, _title, url) => { savedUrl = String(url); } },
  };
  runInNewContext(`${source}\nthis.subject = { state, params, renderCatalog, renderSummary, saveLocation, accountThemeMarkup, accountClassificationMarkup, setView, rows, renderCollectionCoverage, accountCollectionMarkup, selectCollectionFilter };`, context);
  const subject = context.subject;
  subject.state.data = {
    boards: [{ key: 'one', name: '团团来源表' }],
    themeSummary: { items: [{ key: 'all', label: '全部主题', count: 4 }, { key: 'tuantuan', label: '团团', count: 3 }] },
    classificationSummary: { items: [{ key: 'all', label: '全部内容', count: 3 }, { key: 'slice', label: '切片', count: 2 }] },
  };
  return { ...subject, node, savedUrl: () => savedUrl };
}

test('rebuild restores major theme from URL and sends it to the insights API', () => {
  const f = fixture();
  assert.equal(f.state.theme, 'tuantuan');
  assert.equal(f.params().get('theme'), 'tuantuan');
  assert.equal(f.params().get('classification'), 'slice');
  f.state.view = 'accounts';
  f.saveLocation();
  assert.equal(new URL(f.savedUrl()).searchParams.get('theme'), 'tuantuan');
  assert.equal(new URL(f.savedUrl()).searchParams.get('classification'), 'slice');
  f.state.theme = 'all';
  f.state.classification = 'all';
  f.saveLocation();
  assert.equal(new URL(f.savedUrl()).searchParams.has('theme'), false);
  assert.equal(new URL(f.savedUrl()).searchParams.has('classification'), false);
});

test('theme and content card selections win over stale dropdown values', () => {
  const f = fixture();
  f.node('themeSelect').value = 'all';
  f.node('classificationSelect').value = 'all';
  f.state.classification = 'slice';
  f.renderCatalog();
  assert.equal(f.node('themeSelect').value, 'tuantuan');
  assert.equal(f.node('classificationSelect').value, 'slice');
  assert.equal(f.state.theme, 'tuantuan');
  assert.match(f.node('pageSubtitle').textContent, /团团/);
  assert.match(f.node('pageSubtitle').textContent, /切片/);
  assert.equal(f.node('clearScopeBtn').hidden, false);
  assert.equal((f.node('classificationSelect').innerHTML.match(/value="all"/g) || []).length, 1);
  f.state.theme = 'all';
  f.state.classification = 'all';
  f.renderCatalog();
  assert.equal(f.node('themeSelect').value, 'all');
  assert.equal(f.node('classificationSelect').value, 'all');
  assert.equal(f.node('clearScopeBtn').hidden, true);
});

test('returning to overview preserves theme and secondary content scope', () => {
  const f = fixture();
  f.setView('overview');
  assert.equal(f.state.theme, 'tuantuan');
  assert.equal(f.state.classification, 'slice');
  assert.equal(new URL(f.savedUrl()).searchParams.get('classification'), 'slice');
});

test('theme cells use confirmed source classification and escape imported labels', () => {
  const f = fixture();
  assert.match(f.accountThemeMarkup({ label: '团团昵称' }), /待归属/);
  const html = f.accountThemeMarkup({ classification: { theme: { key: 'tuantuan', label: '<script>团团</script>' } } });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('account rows expose source-confirmed total-sheet labels instead of showing unexplained inferred chips', () => {
  const f = fixture();
  const html = f.accountClassificationMarkup({
    classification: { labels: [
      { key: 'original', label: '原创', color: 'blue', sourceConfirmed: true },
      { key: 'ai-remix', label: '<script>AI二创</script>', color: 'amber', sourceConfirmed: true },
    ] }, boards: [],
  });
  assert.match(html, /来源：/);
  assert.match(html, /总表分类：原创/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;AI二创/);
  const separated = f.accountClassificationMarkup({
    classification: { labels: [{ key: 'slice', label: '切片', color: 'violet', sourceConfirmed: true }],
      sourceDescriptions: ['3D搞笑剧情／字幕特效'] },
    boards: [{ category: '抖音主播', tier: '超头部' }],
  });
  assert.match(separated, /账号层级：超头部/);
  assert.match(separated, /原表描述：3D搞笑剧情／字幕特效/);
  assert.doesNotMatch(separated, /总表分类：超头部/);
});

test('live renderer distinguishes the selected cutoff, terminal historical values and each fresh metric cohort', () => {
  const f = fixture();
  f.state.start = f.state.end = '2026-09-26';
  f.state.data.range = { end: '2026-09-26T03:00:00Z', partialEndDay: true };
  f.state.data.accounts = [];
  f.state.data.summary = { enabledCount: 10, metrics: {
    followers: { value: 1000, observedCount: 9, comparableCount: 8, fullPeriodComparableCount: 8 },
    likes: { value: 1200, observedCount: 7, comparableCount: 6, fullPeriodComparableCount: 6 },
    posts: { value: 10, observedCount: 5, comparableCount: 4, fullPeriodComparableCount: 4 },
  }, trend: [{ date: '2026-09-25', followersObservedCount: 10 },
    { date: '2026-09-26', followersObservedCount: 8, likesObservedCount: 6, postsObservedCount: 4 }] };
  f.renderCatalog(); f.renderSummary();
  assert.match(f.node('rangeEvidence').textContent, /2026\/09\/26 11:00/);
  assert.match(f.node('rangeEvidence').textContent, /结束日尚未结束/);
  const html=f.node('kpiGrid').innerHTML;
  assert.match(html, /最近已知存量合计 1,000 · 9\/10 账号；选中末日 2026-09-26 新采 8\/10/);
  assert.match(html, /最近已知存量合计 1,200 · 7\/10 账号；选中末日 2026-09-26 新采 6\/10/);
  assert.match(html, /最近已知存量合计 10 · 5\/10 账号；选中末日 2026-09-26 新采 4\/10/);
  assert.doesNotMatch(html,/期末当日新采 10\/10/);
  assert.doesNotMatch(html, /undefined\/10/);
  assert.match(html, /<span class="quality">—\/10 可比<\/span>/);
  assert.match(f.node('dataHealth').innerHTML,/已知合计可含历史值/);
});

test('coverage panel separates observed profiles from complete works and rejects stale summaries', () => {
  const f = fixture();
  f.state.end = '2026-09-25';
  f.state.data.summary = { collectionCoverage: { date: '2026-09-25', total: 701, profileObservedCount: 696, profileMissingCount: 5,
    works: { complete: 14, limited: 0, unavailable: 682, unknown: 0, missing: 5 } } };
  f.renderCollectionCoverage();
  assert.match(f.node('collectionSummary').innerHTML, /主页有数据 <strong>696\/701/);
  assert.match(f.node('collectionSummary').innerHTML, /作品明细完整 <strong>14\/701/);
  assert.match(f.node('collectionBody').innerHTML, /作品存量及其净变化取自主页统计/);
  assert.match(f.node('collectionBody').innerHTML, /不等于主页作品数缺失/);
  assert.match(f.node('collectionBody').innerHTML, /不代表已收齐历史删除、隐藏的全部作品/);
  assert.match(f.node('collectionBody').innerHTML, /查看主页缺采 · 5/);
  assert.match(f.node('collectionBody').innerHTML, /查看作品明细不完整 · 687/);
  f.state.end = '2026-09-24';
  f.renderCollectionCoverage();
  assert.match(f.node('collectionSummary').textContent, /暂无核验结果/);
  assert.doesNotMatch(f.node('collectionBody').innerHTML, /data-collection-filter/);
});

test('rolling seven-day and thirty-day filters send exact date endpoints, not calendar-week aliases', () => {
  const f = fixture();
  for (const [period, start] of [['week', '2026-09-19'], ['30d', '2026-08-27'], ['since', '2026-09-12']]) {
    f.state.period = period;
    Object.assign(f.state, model.rangeFor(period, '2026-09-25'));
    assert.equal(f.params().get('period'), 'custom');
    assert.equal(f.params().get('startDate'), start);
    assert.equal(f.params().get('endDate'), '2026-09-25');
  }
});

test('coverage drilldown resets hidden local filters and keeps source theme', () => {
  const f = fixture();
  f.state.end = f.state.start = '2026-09-25';
  const account = (id, observed, worksState, enabled = true, date = f.state.end) => ({ id, label: `账号${id}`, enabled, platform: 'douyin',
    status: {}, metrics: {}, collection: { date, profileObserved: observed, worksState } });
  f.state.data.accounts = [account(1, true, 'complete'), account(2, true, 'unavailable'), account(3, false, 'missing'),
    account(4, false, 'missing', false), account(5, true, 'complete', true, '2026-09-24')];
  f.state.query = '没有此账号'; f.state.platform = 'bilibili'; f.state.enabled = 'paused';
  f.selectCollectionFilter('missing-profile');
  assert.equal(f.state.view, 'accounts');
  assert.equal(f.state.theme, 'tuantuan');
  assert.equal(f.state.classification, 'slice');
  assert.equal(f.state.query, ''); assert.equal(f.state.platform, 'all'); assert.equal(f.state.enabled, 'active');
  assert.deepEqual(Array.from(f.rows(), row => row.id).sort(), [3, 5]);
  assert.equal(f.node('collectionSelect').value, 'missing-profile');
  assert.match(f.node('accountCount').textContent, /期末主页缺采/);
  assert.match(f.node('overviewTable').innerHTML, /账号1/);
  assert.match(f.node('overviewTable').innerHTML, /账号2/);
  assert.doesNotMatch(f.node('overviewTable').innerHTML, /账号4/);
  f.selectCollectionFilter('incomplete-works');
  assert.deepEqual(Array.from(f.rows(), row => row.id).sort(), [2, 3, 5]);
  assert.match(f.accountCollectionMarkup(f.state.data.accounts[4]), /期末主页缺采/);
  assert.doesNotMatch(f.accountCollectionMarkup(f.state.data.accounts[4]), /作品明细完整/);
  f.selectCollectionFilter('all');
  assert.equal(f.rows().length, 4);
  f.state.platform = 'bilibili'; f.state.query = 'nothing'; f.state.enabled = 'paused';
  assert.equal(f.rows().length, 0);
  assert.equal(f.rows({ overview: true }).length, 4);
});
