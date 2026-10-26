import test from 'node:test';
import assert from 'node:assert/strict';
import { operatingQuery, operatingSummaryMarkup, operatingSyncMarkup, operatingTableMarkup } from '../public/creator-operating.js';

const fixture = overrides => ({
  source: { revision: '17', refreshedAt: '2026-10-22T12:36:21.692554+00:00' },
  query: { start: '2026-09-12', end: '2026-10-12', sort: 'plays', direction: 'desc' },
  summary: { authors: 2, works: 2, cumulativePlays: null, cumulativeLikes: 0, playsKnown: 0, likesKnown: 1 },
  globalSummary: { authors: 4481, works: 18179 },
  view: 'works', page: 2, pages: 3, pageSize: 30, total: 61,
  items: [{ contentId: '7300000000000000001', sourceRow: 2, sourceUrl: 'https://my.feishu.cn/sheets/example',
    title: '作品 B', authorName: '作者 B', accountId: 'handle_b', authorKey: 'source-author:1:2',
    publishedOn: '2026-10-12', cumulativePlays: null, cumulativeLikes: 0, tracks: ['切片激励'],
    url: 'https://www.douyin.com/video/7300000000000000001', sourceReferences: [] }],
  ...overrides,
});

test('source query preserves applied board/theme/classification, exact author and keyword without losing encoded characters', () => {
  const result = operatingQuery({ board: '一条小团团切片矩阵', theme: 'tuantuan', classification: 'slice',
    start: '2026-09-12', end: '2026-10-12' }, { view: 'authors', q: '团团 & a1+作品', authorKey: 'source-author:1:2',
    sort: 'likes', direction: 'asc', page: 3 });
  assert.deepEqual(Object.fromEntries(result), { board: '一条小团团切片矩阵', theme: 'tuantuan', classification: 'slice',
    view: 'authors', q: '团团 & a1+作品', authorKey: 'source-author:1:2', sort: 'likes', direction: 'asc',
    page: '3', pageSize: '30', start: '2026-09-12', end: '2026-10-12' });
  assert.equal(new URLSearchParams(result.toString()).get('q'), '团团 & a1+作品');
});

test('all-dates opt-in removes only publication dates and retains the chosen scope/search/page', () => {
  const result = operatingQuery({ board: '团团', theme: 'tuantuan', classification: 'ai-remix',
    start: '2026-09-12', end: '2026-10-12' }, { q: '精确账号', allDates: true, page: 4 });
  assert.equal(result.has('start'), false);
  assert.equal(result.has('end'), false);
  assert.equal(result.get('classification'), 'ai-remix');
  assert.equal(result.get('q'), '精确账号');
  assert.equal(result.get('page'), '4');
  assert.equal(result.get('view'), 'works');
  assert.equal(result.get('direction'), 'desc');
});

test('primary source track is an explicit query, independent of inclusive content labels', () => {
  const query = operatingQuery({ board: '', theme: 'tuantuan', classification: 'slice', start: '2026-10-20', end: '2026-10-22' },
    { allDates: true, primaryTrack: 'slice' });
  assert.equal(query.get('primaryTrack'), 'slice');
  assert.equal(query.get('classification'), 'slice');
  assert.equal(query.has('start'), false);
});

test('missing source totals render a dash while a reported zero remains zero; empty scope exposes retained full-corpus counts', () => {
  const markup = operatingSummaryMarkup(fixture());
  assert.match(markup, /原表累计播放<\/span><strong>—<\/strong>/);
  assert.match(markup, /原表累计点赞<\/span><strong>0<\/strong>/);
  assert.match(markup, /不是区间新增/);
  const empty = operatingSummaryMarkup(fixture({ summary: { authors: 0, works: 0, cumulativePlays: null,
    cumulativeLikes: null, playsKnown: 0, likesKnown: 0 }, query: { start: '', end: '' } }), { allDates: true });
  assert.match(empty, /全部已入库日期/);
  assert.match(empty, /查看全部作品日期/);
  assert.match(empty, /4,481/);
  assert.match(empty, /18,179/);
  assert.match(empty, /data-operating-all/);
});

test('source classification is embedded in the TuanTuan operating view without mixing other themes', () => {
  const data = fixture({ query: { theme: 'tuantuan', board: '', start: '', end: '' },
    classificationCoverage: { authors: 4481, withWorkCategory: 4040, registrationOnly: 300, withoutExplicitCategory: 141 },
    tracks: [{ key: 'slice', name: '切片激励', works: 7871, authors: 717, cumulativePlays: 136432488 }] });
  const markup = operatingSummaryMarkup(data, { allDates: true });
  assert.match(markup, /data-operating-track="slice"/);
  assert.match(markup, /7,871 条作品/);
  assert.match(markup, /136,432,488/);
  assert.match(markup, /不是区间新增/);
  assert.match(markup, /300 位仅有登记类型/);
  assert.match(markup, /141 位原表无明确分类/);
  const other = operatingSummaryMarkup({ ...data, query: { ...data.query, theme: 'yuqilin' } });
  assert.match(other, /不会将团团作品混入其他矩阵/);
  assert.equal(other.includes('7,871'), false);
});

test('work cells preserve missing counts and render the exact backend page order without client sorting or slicing', () => {
  const data = fixture();
  data.items.push({ ...data.items[0], contentId: '7300000000000000002', title: '作品 A', cumulativePlays: 2,
    cumulativeLikes: null, publishedOn: '' });
  const markup = operatingTableMarkup(data);
  assert.ok(markup.indexOf('作品 B') < markup.indexOf('作品 A'), 'backend order is preserved');
  assert.equal((markup.match(/<tr>/g) || []).length, 3, 'renders header plus exactly the returned two records');
  assert.match(markup, /<td>—<small>缺测<\/small><\/td><td>0<small>原表累计<\/small><\/td>/);
  assert.match(markup, /<td>2<small>原表累计<\/small><\/td><td>—<small>缺测<\/small><\/td>/);
  assert.match(markup, /<td>—<small>原表推算日期<\/small>/);
});

test('ascending, descending and unsorted column headers expose accessible sorting state for both ledgers', () => {
  for (const [direction, aria, arrow] of [['asc', 'ascending', '↑'], ['desc', 'descending', '↓']]) {
    const markup = operatingTableMarkup(fixture({ query: { sort: 'plays', direction } }));
    assert.ok(markup.includes(`aria-sort="${aria}"><button type="button" class="sort-button" data-operating-sort="plays">播放（采用值） ${arrow}`));
    assert.match(markup, /aria-sort="none"><button[^>]+data-operating-sort="likes"/);
  }
  const authors = operatingTableMarkup(fixture({ view: 'authors', query: { sort: 'works', direction: 'asc' },
    items: [{ key: 'source-author:1:2', name: '作者 A', accountId: 'a', works: 1, cumulativePlays: 0,
      cumulativeLikes: null, classifications: ['slice'] }] }));
  assert.match(authors, /aria-sort="ascending"><button[^>]+data-operating-sort="works"/);
  assert.match(authors, /仅来源资料，未确认监控身份/);
});

test('platform additions display adopted values and evidence without inventing a source row', () => {
  const data = fixture({items:[{contentId:'7300000000000000003',sourceRow:null,
    title:'平台新增作品',authorName:'已关联作者',publishedOn:'2026-10-24',dateSource:'platform-published-at',
    latestLikes:42,latestPlays:null,cumulativeLikes:null,cumulativePlays:null,
    metricOrigin:{likes:'platform'},firstSeenAt:'2026-10-24T01:00:00Z',latestObservedAt:'2026-10-24T02:00:00Z'}]});
  const markup = operatingTableMarkup(data);
  assert.match(markup,/42<small>平台实测/);
  assert.match(markup,/查看平台采样依据/);
  assert.match(markup,/平台发布时间 · 北京/);
  assert.doesNotMatch(markup,/总表第|来源更新/);
});

test('author ledger distinguishes registration labels from categories with saved works', () => {
  const markup = operatingTableMarkup(fixture({ view: 'authors', items: [{ key: 'source-author:1:6', name: '登记作者',
    accountId: 'handle_d', works: 0, cumulativePlays: null, cumulativeLikes: null,
    classifications: ['slice', 'ai-remix'], workClassifications: ['slice'], registeredClassifications: ['ai-remix'] }] }));
  assert.match(markup, /切片激励<\/span>/);
  assert.match(markup, /即梦二创 · 登记<\/span>/);
  assert.match(markup, /登记表明确分类，尚无该类已入库作品/);
});

test('automated source status is visible without exposing untrusted error markup', () => {
  assert.match(operatingSyncMarkup({ status: 'unchanged', checkedAt: '2026-10-22T12:00:00Z' }), /云表无新版本/);
  assert.match(operatingSyncMarkup({ status: 'deferred' }), /下一轮重试/);
  const failed = operatingSyncMarkup({ status: 'failed', reason: '<img src=x onerror=alert(1)>' });
  assert.match(failed, /保留上一版数据/);
  assert.equal(failed.includes('<img'), false);
});

test('untrusted title/name/tag/evidence attributes are escaped and script/data/credential URLs are not links', () => {
  const attack = `<img src=x onerror="alert(1)"> & 'quoted'`;
  const data = fixture({ source: { revision: attack, refreshedAt: null } });
  data.items = [{ ...data.items[0], title: attack, authorName: attack, accountId: attack, authorKey: attack,
    contentId: attack, tracks: [attack], url: 'javascript:alert(1)', sourceUrl: 'data:text/html,<script>alert(1)</script>',
    sourceReferences: [{ reference: attack, url: 'https://user:password@example.com/secret' }] }];
  const markup = operatingTableMarkup(data);
  assert.equal(markup.includes('<img'), false);
  assert.equal(markup.includes('<script'), false);
  assert.equal(markup.includes('href='), false);
  assert.ok(markup.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;quoted&#39;'));
  assert.equal(markup.includes('data-operating-author="<'), false);
  const summary = operatingSummaryMarkup(fixture({ query: { start: attack, end: attack } }));
  assert.equal(summary.includes('<img'), false);
});

test('valid external source links retain safe new-window attributes and empty pages do not synthesize numeric rows', () => {
  const markup = operatingTableMarkup(fixture());
  assert.match(markup, /target="_blank" rel="noopener noreferrer"/);
  const empty = operatingTableMarkup(fixture({ items: [] }));
  assert.match(empty, /未知值显示 —，不填 0/);
  assert.equal(empty.includes('<tr>'), false);
});
