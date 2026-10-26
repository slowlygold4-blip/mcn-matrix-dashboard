import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/rebuild.css', import.meta.url), 'utf8');
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
const insight = (day = '2026-09-28') => ({ range: { startDate: day, endDate: day }, period: 'custom',
  summary: { metrics: {}, trend: [] }, accounts: [], boards: [], themeSummary: { items: [] }, classificationSummary: { items: [] } });
const topics = (label, day = '2026-09-28') => ({ startDate: day, endDate: day,
  topics: [{ label, points: [{ date: day, participants: 12, views: 123,
    capturedAt: `${day}T01:23:00Z`, qualityStatus: 'validated', sourceVerified: true }] }] });
function fixture() {
  const nodes = new Map();
  const document = { querySelectorAll: () => [], activeElement: null };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', innerHTML: '', textContent: '', hidden: true, disabled: false,
      attrs: {}, dataset: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
      focus() { document.activeElement = this; }, querySelector() { return null; } });
    return nodes.get(id);
  };
  document.getElementById = node; document.querySelector = () => node('date-controls');
  const context = { ...model, fmt: model.formatNumber, document, URL, URLSearchParams, AbortController, Date, Intl, setTimeout, clearTimeout,
    beijingToday: () => '2026-09-29', rangeFor: (period, end = '2026-09-29') => model.rangeFor(period, end),
    window: { matchMedia: () => ({ matches: true }) },
    location: { href: 'https://example.test/?period=custom&start=2026-09-28&end=2026-09-28#topics' },
    history: { replaceState() {} }, fetch: async () => response({}) };
  runInNewContext(`${source.replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '')}
    this.subject = { state, load, loadTopics, setView };`, context);
  const f = { ...context.subject, node, setFetch(fn) { context.fetch = fn; } };
  f.state.view = 'topics'; f.node('startDate').value = f.node('endDate').value = '2026-09-28';
  return f;
}
async function prime(f, day = '2026-09-28') {
  f.node('startDate').value = f.node('endDate').value = day;
  f.setFetch(async path => response(path.startsWith('/api/topics') ? topics('原话题', day) : path.startsWith('/api/rebuild') ? insight(day) : {}));
  await f.load();
}

test('a quality label alone cannot make unverified topic counters valid observations', async () => {
  const f = fixture();
  for (const verified of [undefined, false]) {
    const payload = topics('来源未核验话题'), point = payload.topics[0].points[0];
    if (verified === undefined) delete point.sourceVerified;
    else point.sourceVerified = verified;
    f.setFetch(async () => response(payload)); await f.loadTopics();
    const html = f.node('topicsGrid').innerHTML;
    assert.equal((html.match(/区间覆盖 0\/1 天有有效观测/g) || []).length, 2);
    assert.match(html, /来源未核验 · 已排除/);
    assert.doesNotMatch(html, /<strong[^>]*>12<\/strong>|<strong[^>]*>123<\/strong>|<td>12<\/td>|<td>123<\/td>/);
  }
});

test('topic cards expose independent valid-observation coverage when the selected period has gaps', async () => {
  const f = fixture();
  f.node('startDate').value = '2026-09-27';
  f.node('endDate').value = '2026-09-29';
  f.state.start = '2026-09-27';
  f.state.end = '2026-09-29';
  const topicData = { startDate: '2026-09-27', endDate: '2026-09-29', topics: [{
    label: '#稀疏话题',
    points: [
      { date: '2026-09-27', participants: 10, views: 100, participantsDelta: null, viewsDelta: null, qualityStatus: 'validated', sourceVerified: true },
      { date: '2026-09-28', participants: 11, views: null, participantsDelta: 1, viewsDelta: null, qualityStatus: 'warning', sourceVerified: true },
      { date: '2026-09-29', participants: null, views: null, participantsDelta: null, viewsDelta: null, qualityStatus: 'missing' },
    ],
    latestKnown: {
      participants: { date: '2026-09-28', value: 11, capturedAt: '2026-09-28T01:23:00Z', qualityStatus: 'warning', sourceVerified: true },
      views: { date: '2026-09-27', value: 100, capturedAt: '2026-09-27T01:23:00Z', qualityStatus: 'validated', sourceVerified: true },
    },
  }] };
  f.setFetch(async path => response(path.startsWith('/api/topics') ? topicData
    : path.startsWith('/api/rebuild') ? { ...insight(), range: { startDate: '2026-09-27', endDate: '2026-09-29' } } : {}));
  await f.load();

  const html = f.node('topicsGrid').innerHTML;
  assert.match(html, /2\/3 天有有效观测/, 'participant coverage is independently visible');
  assert.match(html, /1\/3 天有有效观测/, 'views coverage is independently visible');
  assert.match(html, /最近有效观测 2026-09-28/);
  assert.match(html, /最近有效观测 2026-09-27/);
  assert.match(html, /缺测不补零/);
});

test('rejected topic observations are labeled and their counters and deltas are hidden in daily history', async () => {
  const f = fixture();
  f.node('startDate').value = '2026-09-27';
  f.node('endDate').value = '2026-09-29';
  f.state.start = '2026-09-27';
  f.state.end = '2026-09-29';
  const topicData = { startDate: '2026-09-27', endDate: '2026-09-29', topics: [{
    label: '#质量校验话题',
    points: [
      { date: '2026-09-27', participants: 10, views: 100, participantsDelta: null, viewsDelta: null, qualityStatus: 'validated', sourceVerified: true },
      { date: '2026-09-28', participants: 9876543210123, views: 8765432109876, participantsDelta: 7654321098765, viewsDelta: 6543210987654, qualityStatus: 'rejected' },
      { date: '2026-09-29', participants: null, views: null, participantsDelta: null, viewsDelta: null, qualityStatus: 'missing' },
    ],
  }] };
  f.setFetch(async () => response(topicData));
  await f.loadTopics();

  const html = f.node('topicsGrid').innerHTML;
  const history = html.slice(html.indexOf('<details>'));
  assert.match(history, /质量状态/);
  assert.match(history, /已排除/);
  assert.match(history, /质量校验未通过/);
  assert.match(history, /title="此观测未计入上方汇总"/);
  assert.match(history, /<td>10<\/td>/, 'validated values remain visible');
  assert.match(history, /<td>有效<\/td>/);
  assert.match(history, /<td>缺测<\/td>/);
  for (const rejectedValue of ['9,876,543,210,123', '8,765,432,109,876', '7,654,321,098,765', '6,543,210,987,654']) {
    assert.doesNotMatch(html, new RegExp(rejectedValue.replaceAll(',', ',?')), `rejected ${rejectedValue} must not leak into the rendered evidence`);
  }
  assert.match(history, /<td>—<\/td><td>—<\/td><td>—<\/td><td>—<\/td>/);
});

test('topic cards switch to a readable single-column layout at medium desktop widths', () => {
  assert.match(styles, /@media\(max-width:1720px\)\{\.topic-grid\{grid-template-columns:minmax\(0,1fr\)\}\}/);
});

test('topic failure is partial success, preserves account success and timestamped topic evidence, and retry recovers', async () => {
  const f = fixture(); await prime(f);
  const previous = f.node('topicsGrid').innerHTML;
  f.setFetch(async path => path.startsWith('/api/topics') ? response({ error: '话题暂不可用' }, 503) : response(path.startsWith('/api/rebuild') ? insight() : {}));
  await f.load({ refreshApplied: true });
  assert.equal(f.node('connectionStatus').textContent, '快照部分读取失败');
  assert.equal(f.node('connectionStatus').attrs['data-state'], 'warning');
  assert.equal(f.node('loadFeedback').attrs['data-state'], 'warning');
  assert.match(f.node('loadFeedback').innerHTML, /账号快照已读取.*话题读取失败/);
  assert.equal(f.node('exportButton').disabled, false, 'valid account export remains available');
  assert.match(f.node('topicsGrid').innerHTML, /原话题/);
  assert.match(f.node('topicsGrid').innerHTML, /09:23/);
  assert.ok(f.node('topicsGrid').innerHTML.includes(previous));
  assert.match(f.node('topicsGrid').innerHTML, /data-retry-topics/);
  assert.equal(f.node('topicsGrid').attrs['aria-busy'], 'false');
  assert.equal(f.state.busy, false);
  f.setFetch(async () => response(topics('重试新话题'))); await f.loadTopics();
  assert.equal(f.node('connectionStatus').textContent, '快照已读取');
  assert.match(f.node('topicsGrid').innerHTML, /重试新话题/);
  assert.doesNotMatch(f.node('topicsGrid').innerHTML, /原话题|data-retry-topics/);
});

test('failed new topic range keeps old range explicit without relabeling old values', async () => {
  const f = fixture(); await prime(f, '2026-09-27');
  f.node('startDate').value = f.node('endDate').value = '2026-09-28';
  f.setFetch(async path => path.startsWith('/api/topics') ? response({ error: 'offline' }, 503) : response(path.startsWith('/api/rebuild') ? insight() : {}));
  await f.load();
  assert.equal(f.state.data.range.endDate, '2026-09-28');
  assert.match(f.node('topicsGrid').innerHTML, /上次成功话题快照.*2026-09-27.*2026-09-27/);
  assert.match(f.node('topicsGrid').innerHTML, /不代表本次所选范围/);
  assert.match(f.node('topicsGrid').innerHTML, /观测日期 2026-09-27 09:23/);
  assert.doesNotMatch(f.node('topicsGrid').innerHTML, /观测日期 2026-09-28/);
});

for (const lateFailure of [false, true]) test(`superseded topic ${lateFailure ? 'failure' : 'success'} cannot alter newer applied range`, async () => {
  const f = fixture(); await prime(f, '2026-09-27');
  let finish;
  f.setFetch(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.loadTopics();
  f.node('startDate').value = f.node('endDate').value = '2026-09-28';
  f.setFetch(async path => response(path.startsWith('/api/topics') ? topics('新范围话题') : path.startsWith('/api/rebuild') ? insight() : {}));
  await f.load();
  finish(lateFailure ? response({ error: '旧范围错误' }, 503) : response(topics('旧范围响应', '2026-09-27')));
  await pending;
  assert.match(f.node('topicsGrid').innerHTML, /新范围话题/);
  assert.doesNotMatch(f.node('topicsGrid').innerHTML, /旧范围/);
  assert.equal(f.node('connectionStatus').textContent, '快照已读取');
});

test('first topic failure has retry but no fabricated prior snapshot and cannot claim full success', async () => {
  const f = fixture();
  f.setFetch(async path => path.startsWith('/api/topics') ? response({ error: 'offline' }, 503) : response(path.startsWith('/api/rebuild') ? insight() : {}));
  await f.load();
  assert.equal(f.node('connectionStatus').textContent, '快照部分读取失败');
  assert.match(f.node('topicsGrid').innerHTML, /data-retry-topics/);
  assert.doesNotMatch(f.node('topicsGrid').innerHTML, /上次成功话题快照/);
});

test('topic history loads independently when the account insights endpoint fails', async () => {
  const f = fixture();
  let topicRequests = 0;
  f.setFetch(async path => {
    if (path.startsWith('/api/topics/history')) { topicRequests++; return response(topics('独立读取话题')); }
    if (path.startsWith('/api/rebuild/insights')) return response({ error: '账号统计接口失败' }, 503);
    return response({});
  });
  await f.load();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(topicRequests, 1);
  assert.match(f.node('topicsGrid').innerHTML, /独立读取话题/);
  assert.equal(f.node('connectionStatus').textContent, '快照读取失败');
  assert.equal(f.node('exportButton').disabled, true, 'an account API failure still disables account export');
});

test('topic reads rejoin the newly applied date range after leaving and returning mid-request', async () => {
  const f = fixture(); await prime(f, '2026-09-27');
  f.node('startDate').value = f.node('endDate').value = '2026-09-28';
  let finishInsights;
  const topicPaths = [];
  f.setFetch(path => {
    if (path.startsWith('/api/topics/history')) {
      topicPaths.push(path);
      const day = new URL(path, 'https://example.test').searchParams.get('startDate');
      return Promise.resolve(response(topics(`话题${day}`, day)));
    }
    if (path.startsWith('/api/rebuild/insights')) return new Promise(resolve => { finishInsights = resolve; });
    return Promise.resolve(response({}));
  });
  const pending = f.load();
  f.setView('overview');
  f.setView('topics');
  await new Promise(resolve => setImmediate(resolve));
  finishInsights(response(insight('2026-09-28')));
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(topicPaths.filter(path => path.includes('startDate=2026-09-28')).length, 2,
    'the in-flight range is reused after navigation; a canceled read is dispatched again');
  assert.doesNotMatch(topicPaths.join('\n'), /startDate=2026-09-27/, 'navigation must not regress to the stale account range');
  assert.match(f.node('topicsGrid').innerHTML, /话题2026-09-28/);
});

test('entering topics during a failing first account read still loads topic history', async () => {
  const f = fixture(); f.state.view = 'overview';
  let topicRequests = 0;
  f.setFetch(async path => {
    if (path.startsWith('/api/topics/history')) { topicRequests++; return response(topics('切换时独立话题')); }
    if (path.startsWith('/api/rebuild/insights')) return response({ error: '账号读取失败' }, 503);
    return response({});
  });
  const pending = f.load();
  f.setView('topics');
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(topicRequests, 1);
  assert.match(f.node('topicsGrid').innerHTML, /切换时独立话题/);
  assert.equal(f.node('connectionStatus').textContent, '快照读取失败');
});

for (const lateFailure of [false, true]) test(`topic ${lateFailure ? 'failure' : 'success'} dispatched before a new account read is ignored before that read commits`, async () => {
  const f = fixture(); await prime(f, '2026-09-27');
  let finishOld, finishAccounts;
  f.setFetch(() => new Promise(resolve => { finishOld = resolve; }));
  const oldTopics = f.loadTopics();
  f.node('startDate').value = f.node('endDate').value = '2026-09-28';
  f.setFetch(path => path.startsWith('/api/rebuild') ? new Promise(resolve => { finishAccounts = resolve; })
    : Promise.resolve(response(path.startsWith('/api/topics') ? topics('新范围话题') : {})));
  const pendingAccount = f.load();
  finishOld(lateFailure ? response({ error: '过期错误' }, 503) : response(topics('过期结果', '2026-09-27')));
  await oldTopics;
  assert.doesNotMatch(f.node('topicsGrid').innerHTML, /过期错误|过期结果/);
  assert.match(f.node('topicsGrid').innerHTML, /原话题/);
  assert.equal(f.node('connectionStatus').textContent, '正在读取快照');
  finishAccounts(response(insight())); await pendingAccount;
  assert.match(f.node('topicsGrid').innerHTML, /新范围话题/);
  assert.equal(f.node('connectionStatus').textContent, '快照已读取');
});

test('a successful topic-only retry cannot hide a separate account read failure', async () => {
  const f = fixture(); await prime(f);
  f.setFetch(async () => response({ error: '账号读取失败' }, 503)); await f.load();
  f.setFetch(async () => response(topics('重试话题'))); await f.loadTopics();
  assert.equal(f.node('connectionStatus').textContent, '快照读取失败');
  assert.equal(f.node('exportButton').disabled, true);
  assert.match(f.node('topicsGrid').innerHTML, /重试话题/);
});

test('mismatched topic envelope dates are rejected while original observations remain intact', async () => {
  const f = fixture(); await prime(f);
  f.setFetch(async () => response(topics('错范围结果', '2026-09-27'))); await f.loadTopics();
  assert.match(f.node('topicsGrid').innerHTML, /响应日期与请求范围不一致/);
  assert.match(f.node('topicsGrid').innerHTML, /原话题/);
  assert.doesNotMatch(f.node('topicsGrid').innerHTML, /错范围结果/);
  assert.equal(f.node('connectionStatus').textContent, '快照部分读取失败');
});
