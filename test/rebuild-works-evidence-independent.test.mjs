import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

// Independent contract tests execute the actual console implementation. Only
// DOM/network boundaries are substituted; no evidence calculations are copied.
const range = { start: '2026-09-22', end: '2026-09-28' };
function payload() {
  return {
    account: {
      id: 477, label: '审查账号', platform: 'douyin', publicId: 'fixture-only', boards: [], trend: [],
      metrics: Object.fromEntries(['followers', 'likes', 'posts'].map(key => [key, {
        value: key === 'posts' ? 145 : 1000, delta: key === 'posts' ? 2 : 10,
        currentAt: '2026-09-28T01:00:00.000Z',
      }])),
      publishedSamples: { value: 6, scope: 'observed-public-posts', basis: 'published_at',
        asOfBasis: 'first_seen_at', asOf: '2026-09-28T01:00:00.000Z' },
      collection: { date: range.end, profileObserved: true, worksState: 'limited' },
      recentWorks: [{ caption: '不得使用账号内冗余列表', url: 'https://www.douyin.com/video/100' }],
    },
    recentWorks: Array.from({ length: 20 }, (_, i) => ({
      id: i + 1, caption: `公开样本 ${i + 1}`, url: `https://www.douyin.com/video/${7000 + i}`,
      publishedAt: i < 6 ? '2026-09-25T01:00:00.000Z' : '2026-09-20T01:00:00.000Z',
      lastObservedAt: '2026-09-28T01:00:00.000Z',
    })),
  };
}
function harness() {
  const nodes = new Map();
  const document = { activeElement: null, querySelector: () => null, querySelectorAll: () => [] };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      id, innerHTML: '', textContent: '', open: false, value: '', attributes: {}, isConnected: true,
      showModal() { this.open = true; }, close() { this.open = false; },
      setAttribute(key, value) { this.attributes[key] = value; },
      focus() { document.activeElement = this; },
    });
    return nodes.get(id);
  };
  document.getElementById = node;
  document.activeElement = node('original-trigger');
  const context = {
    ...model, fmt: model.formatNumber, beijingToday: () => '2026-09-28',
    URL, URLSearchParams, Intl, Date, AbortController, document, setTimeout, clearTimeout,
    location: new URL('http://127.0.0.1:4188/#accounts'),
    window: { matchMedia: () => ({ matches: true }) },
    fetch: async () => { throw new Error('unexpected network'); },
  };
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8')
    .replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  runInNewContext(`${source}\nthis.subject={state,renderWorksEvidence,worksEvidenceTime,safeWorkUrl,openAccount,closeAccount};`, context);
  context.subject.state.data = { range: { startDate: range.start, endDate: range.end }, accounts: [payload().account] };
  return { ...context.subject, node, document, setFetch(fn) { context.fetch = fn; } };
}
const response = body => ({ ok: true, status: 200, json: async () => body });
const sampleValue = html => html.match(/本期已收录发布样本<\/small><strong>(.*?)<span>/s)?.[1];

test('independent works review: 145 stock, +2 net and 6 publication samples remain distinct from recent 20', async () => {
  const f = harness();
  f.setFetch(async () => response(payload()));
  await f.openAccount(477);
  const html = f.node('dialogBody').innerHTML;
  assert.match(html, /<strong>145<\/strong>/);
  assert.match(html, /作品存量净变化/);
  assert.match(html, />\+2<\/span>/);
  assert.equal(sampleValue(html), '6');
  assert.match(html, /不等于新增发布量/);
  assert.match(html, /仅部分作品/);
  assert.match(html, /最多 20 条/);
  assert.match(html, /不是本期发布全集/);
  assert.match(html, /不代表全部历史/);
  assert.equal((html.match(/<li>/g) || []).length, 20);
  assert.doesNotMatch(html, /不得使用账号内冗余列表/);
  assert.equal(f.node('dialogBody').attributes['aria-busy'], 'false');
});

test('independent works review: absent, invalid and explicit zero sample counts never coalesce', () => {
  const f = harness();
  for (const value of [null, undefined, '', '6', -1, 1.5, Infinity, true, Number.MAX_SAFE_INTEGER + 1]) {
    const data = payload(); data.account.publishedSamples.value = value;
    assert.equal(sampleValue(f.renderWorksEvidence(data, range)), '—', `invalid count ${String(value)}`);
  }
  const data = payload(); data.account.publishedSamples.value = 0;
  const html = f.renderWorksEvidence(data, range);
  assert.equal(sampleValue(html), '0');
  assert.match(html, /已收录 0 条不等于没有发布/);
  assert.match(html, /不能据样本判断全量产能/);
});

test('independent works review: missing net change stays unknown while a measured zero stays zero', () => {
  const f = harness(), data = payload();
  data.account.metrics.posts.delta = null;
  assert.match(f.renderWorksEvidence(data, range), /作品存量净变化<\/small><strong><span class="flat">—<\/span>/);
  data.account.metrics.posts.delta = 0;
  assert.match(f.renderWorksEvidence(data, range), /作品存量净变化<\/small><strong><span class="flat" title="0">0<\/span>/);
});

test('independent works review: stale or unknown works coverage never inherits successful profile completeness', () => {
  const f = harness();
  for (const worksState of [undefined, 'unknown', 'missing', 'unavailable', 'limited']) {
    const data = payload(); data.account.collection.worksState = worksState;
    const html = f.renderWorksEvidence(data, range);
    assert.doesNotMatch(html, /记录完整/);
    assert.match(html, /不能据样本判断全量产能/);
  }
  const data = payload();
  data.account.collection = { date: '2026-09-27', worksState: 'complete', profileObserved: true };
  assert.match(f.renderWorksEvidence(data, range), /作品范围未知/);
  data.account.collection.date = range.end;
  const completeHtml = f.renderWorksEvidence(data, range);
  assert.match(completeHtml, /本次记录完整/);
  assert.match(completeHtml, /历史范围未核验/);
});

test('independent works review: publication, observation and range-end evidence remain separate in Beijing time', () => {
  const f = harness(), data = payload();
  data.account.publishedSamples.asOf = '2026-09-27T16:01:00.000Z';
  data.recentWorks = [{ caption: '上期发布本期观测', publishedAt: '2026-09-20T15:59:00.000Z',
    lastObservedAt: '2026-09-27T16:00:00.000Z' }];
  const html = f.renderWorksEvidence(data, range);
  assert.match(html, /2026-09-22 至 2026-09-28/);
  assert.match(html, /按发布时间统计/);
  assert.match(html, /发布时间<\/dt><dd>2026\/09\/20 23:59/);
  assert.match(html, /最近观测<\/dt><dd>2026\/09\/28 00:00/);
  assert.match(html, /收录截止 2026\/09\/28 00:01/);
  assert.match(html, /结束后才发现的旧作品不计入/);
  assert.match(html, /列表中的作品可能早于本期/);
  for (const value of [null, undefined, '', 'not-a-date', '<img src=x>']) {
    assert.equal(f.worksEvidenceTime(value), '未知');
  }
});

test('independent works review: captions are escaped and executable or credential-bearing URLs are not links', () => {
  const f = harness(), data = payload();
  data.recentWorks = ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'http://www.douyin.com/video/123', 'https://name:secret@www.douyin.com/video/123'].map(url => ({
    caption: '<img src=x onerror="alert(1)"> & "title"', url,
  }));
  const html = f.renderWorksEvidence(data, range);
  assert.doesNotMatch(html, /<img|<script|<a\s|href=|javascript:|name:secret/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&quot;alert\(1\)&quot;/);
  data.recentWorks = [{ caption: '正常链接', url: 'https://www.douyin.com/video/123' }];
  assert.match(f.renderWorksEvidence(data, range), /href="https:\/\/www.douyin.com\/video\/123" target="_blank" rel="noopener noreferrer"/);
});

test('independent works review: absent and capped sample lists never imply zero publications', () => {
  const f = harness(), data = payload();
  data.recentWorks = null;
  assert.match(f.renderWorksEvidence(data, range), /缺采不等于没有发布/);
  data.recentWorks = Array.from({ length: 25 }, (_, i) => ({ caption: `样本序号 ${i}` }));
  const html = f.renderWorksEvidence(data, range);
  assert.equal((html.match(/<li>/g) || []).length, 20);
  assert.match(html, /样本序号 19/);
  assert.doesNotMatch(html, /样本序号 20/);
  assert.equal(sampleValue(html), '6', 'list cap must not recalculate publication sample count');
});

test('independent works review: details use committed dates rather than an unapplied date draft', async () => {
  const f = harness(); let requested;
  f.state.start = '2026-09-01'; f.state.end = '2026-09-02';
  f.node('startDate').value = '2026-09-01'; f.node('endDate').value = '2026-09-02';
  f.setFetch(async path => { requested = path; return response(payload()); });
  await f.openAccount(477);
  const url = new URL(requested, 'http://fixture.local');
  assert.equal(url.searchParams.get('startDate'), range.start);
  assert.equal(url.searchParams.get('endDate'), range.end);
  assert.match(f.node('dialogBody').innerHTML, /2026-09-22 至 2026-09-28/);
  assert.doesNotMatch(f.node('dialogBody').innerHTML, /2026-09-01 至 2026-09-02/);
});

test('independent works review: late detail response cannot reopen or overwrite a closed drawer', async () => {
  const f = harness(); let deliver;
  const wait = new Promise(resolve => { deliver = resolve; });
  f.setFetch(() => wait);
  const opening = f.openAccount(477);
  await f.closeAccount();
  const before = f.node('dialogBody').innerHTML;
  deliver(response(payload())); await opening;
  assert.equal(f.node('accountDialog').open, false);
  assert.equal(f.node('dialogBody').innerHTML, before);
  assert.equal(f.document.activeElement, f.node('original-trigger'));
});
