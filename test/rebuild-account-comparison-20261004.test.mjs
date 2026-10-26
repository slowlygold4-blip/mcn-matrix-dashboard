import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

// Exercises the actual main-site rebuild.js account dialog. Only DOM, clock,
// and the read-only fetch boundary are replaced; no database or collector.
const A = { startDate: '2026-09-20', endDate: '2026-09-21' };
const B = { startDate: '2026-09-12', endDate: '2026-09-14' };
const DRAFT = { startDate: '2026-09-01', endDate: '2026-09-02' };

function account(id, range, { missingB = false, alternate = false } = {}) {
  const metrics = Object.fromEntries(['followers', 'likes', 'posts', 'estimatedPlays'].map((key, index) => [key, {
    value: 1000 + index, delta: key === 'followers' && missingB ? null : key === 'likes' && alternate ? 0 : (alternate ? index + 7 : index + 2), currentAt: `${range.endDate}T02:00:00.000Z`, reason: '有可比区间端点',
  }]));
  const first = Date.parse(`${range.startDate}T00:00:00Z`), last = Date.parse(`${range.endDate}T00:00:00Z`);
  const trend = Array.from({ length: Math.round((last - first) / 86400000) + 1 }, (_, index) => ({ date: new Date(first + index * 86400000).toISOString().slice(0, 10),
    followers: 1000 + index, followersDelta: keyDelta('followers', alternate, index, missingB),
    likes: 2000 + index, likesDelta: alternate && index === 1 ? 0 : keyDelta('likes', alternate, index, false),
    posts: 10 + index, postsDelta: keyDelta('posts', alternate, index, false),
  }));
  return { id, label: '合成作者', platform: 'douyin', publicId: 'fixture-id', enabled: true,
    boards: [{ name: '测试板块' }], profileUrl: null, metrics, trend,
    status: {}, collection: { date: range.endDate, worksState: 'unknown' } };
}
function keyDelta(key, alternate, index, missing) {
  if (missing && index === 1) return null;
  return (key === 'followers' ? 3 : key === 'likes' ? 10 : 1) + (alternate ? 7 : 1) + index;
}

function fixture({ comparison = true, missingB = false, badResponse = null } = {}) {
  const nodes = new Map(), calls = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', innerHTML: '', textContent: '', hidden: false,
      open: false, disabled: false, checked: false, dataset: {}, isConnected: true, scrollLeft: 0, scrollTop: 0,
      setAttribute() {}, getAttribute() { return null; }, hasAttribute() { return false; }, focus() {},
      showModal() { this.open = true; }, close() { this.open = false; }, querySelector() { return null; },
      closest() { return null; }, addEventListener() {}, click() {} });
    return nodes.get(id);
  };
  const listeners = new Map();
  const document = { activeElement: node('body'), body: node('body'), getElementById: node,
    querySelector: selector => selector === '.skip' ? node('skip') : null, querySelectorAll: () => [], createElement: () => ({ click() {} }),
    addEventListener(type, handler) { listeners.set(type, [...(listeners.get(type) || []), handler]); }, dispatchEvent() {} };
  const location = new URL(`http://matrix.test/?period=custom&start=${A.startDate}&end=${A.endDate}${comparison ? `&compare=1&compareStart=${B.startDate}&compareEnd=${B.endDate}` : ''}#accounts`);
  const history = { state: null, pushState(value, _title, url) { this.state = value; if (url) location.href = String(url); },
    replaceState(value, _title, url) { this.state = value; if (url) location.href = String(url); }, back() {} };
  const window = { scrollX: 0, scrollY: 0, scrollTo() {}, matchMedia: () => ({ matches: true }), addEventListener() {} };
  const primary = account(1, A), alternate = account(badResponse === 'wrong-account' ? 2 : 1, B, { missingB, alternate: true });
  let comparisonResponse = comparison ? { account: alternate, range: { ...B } } : null;
  if (badResponse === 'missing') comparisonResponse = null;
  if (badResponse === 'wrong-date') comparisonResponse = { account: alternate, range: { ...B, endDate: '2026-09-15' } };
  const context = { ...model, fmt: model.formatNumber, document, location, history, window, URL, URLSearchParams, Date, Intl,
    CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    Blob, AbortController, Map, Set, Promise, queueMicrotask, console, setTimeout: () => 1, clearTimeout() {},
    fetch: async path => {
      calls.push(String(path));
      return { ok: true, json: async () => ({ account: primary, recentWorks: [], comparison: comparisonResponse }) };
    } };
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8')
    .replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  runInNewContext(`${source}\nthis.subject={state,openAccount,closeAccount,changeDetailTrend,selectChartDay,bind};`, context);
  const state = context.subject.state;
  Object.assign(state, { period: 'custom', start: A.startDate, end: A.endDate, compare: comparison,
    compareStart: B.startDate, compareEnd: B.endDate, detailId: null,
    data: { period: 'custom', range: { ...A }, accounts: [primary],
      comparison: comparison ? { range: { ...B }, summary: {} } : null } });
  node('compareStart').value = DRAFT.startDate; node('compareEnd').value = DRAFT.endDate;
  return { ...context.subject, node, calls, location, context, listeners };
}

function requestParams(f) {
  const request = f.calls.find(path => path.includes('/api/rebuild/accounts/'));
  assert.ok(request, 'account detail GET must execute');
  return new URL(request, f.location).searchParams;
}

for (const metric of ['likes', 'posts']) {
  test(`account detail preserves the ${metric} investigation from the sorted ledger`, async () => {
    const f = fixture({ comparison: false });
    f.state.view = 'accounts'; f.state.sort = `${metric}.delta`;
    await f.openAccount(1);
    const body = f.node('dialogBody').innerHTML;
    assert.match(body, new RegExp(`data-detail-metric="${metric}" aria-pressed="true"`));
    assert.ok(body.indexOf('class="detail-trend"') < body.indexOf('class="works-evidence'),
      'the investigation curve precedes secondary works diagnostics');
  });
}

test('overview account detail carries the explicitly selected performance metric', async () => {
  const f = fixture({ comparison: false });
  f.state.view = 'overview'; f.state.workflowMetric = 'posts'; f.state.sort = 'followers.value';
  await f.openAccount(1);
  assert.match(f.node('dialogBody').innerHTML, /data-detail-metric="posts" aria-pressed="true"/);
});

test('estimated play investigation names the underlying likes curve and its estimate boundary', async () => {
  const f = fixture({ comparison: false });
  f.state.view = 'overview'; f.state.workflowMetric = 'estimatedPlays';
  await f.openAccount(1);
  const body = f.node('dialogBody').innerHTML;
  assert.match(body, /data-detail-metric="likes" aria-pressed="true"/);
  assert.match(body, /先显示获赞原始曲线，估算播放为获赞净变化 × 100，非平台实际播放量/);
});

test('main account detail requests the applied B dates, never the unsubmitted comparison draft', async () => {
  const f = fixture();
  await f.openAccount(1);
  const params = requestParams(f);
  assert.equal(params.get('startDate'), A.startDate);
  assert.equal(params.get('endDate'), A.endDate);
  assert.equal(params.get('comparisonStartDate'), B.startDate);
  assert.equal(params.get('comparisonEndDate'), B.endDate);
  assert.notEqual(params.get('comparisonStartDate'), DRAFT.startDate);
  assert.notEqual(params.get('comparisonEndDate'), DRAFT.endDate);
});

test('main account detail stays single-period when comparison is off', async () => {
  const f = fixture({ comparison: false });
  await f.openAccount(1);
  const params = requestParams(f), body = f.node('dialogBody').innerHTML;
  assert.equal(params.has('comparisonStartDate'), false);
  assert.equal(params.has('comparisonEndDate'), false);
  assert.doesNotMatch(body, /对比期|B 区间|B时段/);
});

test('turning comparison off after an A/B detail does not leak the previous B series', async () => {
  const f = fixture();
  await f.openAccount(1);
  assert.match(f.node('dialogBody').innerHTML, /B 对比期区间变化/);
  await f.closeAccount({ instant: true });
  f.state.compare = false; f.state.data.comparison = null;
  await f.openAccount(1);
  const body = f.node('dialogBody').innerHTML;
  assert.doesNotMatch(body, /B 对比期区间变化|逐日变化明细 · B 对比期/);
  const chart = body.split('<div class="detail-chart" id="detailTrendChart">')[1].split('</div><p class="muted" id="detailTrendReason">')[0];
  assert.equal((chart.match(/<path\b/g) || []).length, 1);
});

test('account detail keeps a missing B endpoint unknown instead of filling zero', async () => {
  const f = fixture({ missingB: true });
  await f.openAccount(1);
  const body = f.node('dialogBody').innerHTML;
  assert.match(body, /对比期|B 区间|B时段/);
  assert.match(body, /缺测|不可比|未知|—/);
  assert.match(body, /B 对比期区间变化 <span class="flat"[^>]*>—<\/span>/);
  assert.doesNotMatch(body, /B[^<\n]{0,40}(?:粉丝|followers)[^<\n]{0,20}>\s*0\s*</i);
});

for (const badResponse of ['missing', 'wrong-account', 'wrong-date']) {
  test(`main account detail rejects ${badResponse} comparison evidence instead of silently showing A only`, async () => {
    const f = fixture({ badResponse });
    await f.openAccount(1);
    assert.match(f.node('dialogBody').innerHTML, /账号对比记录缺失或与已应用日期不一致/);
  });
}

test('main account detail presents the B curve and paired A/B daily rows', async () => {
  const f = fixture();
  await f.openAccount(1);
  const body = f.node('dialogBody').innerHTML;
  assert.match(body, /对比期|B 区间|B时段/);
  assert.match(body, /2026-09-20/);
  assert.match(body, /2026-09-12/);
  assert.match(body, /comparison|对比期|B 区间|B时段/);
  assert.match(body, /followersDelta|粉丝净变化/);
  assert.match(body, /likesDelta|获赞净变化/);
  assert.match(body, /postsDelta|作品净变化/);
  const chart = body.split('<div class="detail-chart" id="detailTrendChart">')[1].split('</div><p class="muted" id="detailTrendReason">')[0];
  assert.match(chart, /对比期/);
  assert.equal((chart.match(/<path\b/g) || []).length, 2, 'SVG should contain one A curve and one B curve');
  assert.match(body, /逐日变化明细 · A 本期/);
  assert.match(body, /逐日变化明细 · B 对比期/);
  assert.match(body, /2026-09-14/);
  assert.match(body, /B 对比期区间变化 <span class="flat"[^>]*>0<\/span>/, 'a genuine zero stays distinct from missing');
  f.changeDetailTrend('likes');
  assert.equal(f.node('detailTrendTitle').textContent, '点赞每日净变化');
  const refreshedChart = f.node('detailTrendChart').innerHTML;
  assert.equal((refreshedChart.match(/<path\b/g) || []).length, 2, 'switching metric must retain both A/B curves');
  f.bind();
  const event = { target: { dataset: { chartPlot: 'detail' } }, key: 'ArrowLeft', prevented: false,
    preventDefault() { this.prevented = true; } };
  f.listeners.get('keydown').find(Boolean)(event);
  assert.equal(event.prevented, true);
  assert.match(f.node('detailChartReading').innerHTML, /本期 · 2026-09-20/);
  assert.match(f.node('detailChartReading').innerHTML, /对比期 · 2026-09-12/);
  event.key = 'ArrowRight'; event.prevented = false;
  f.listeners.get('keydown').find(Boolean)(event);
  assert.match(f.node('detailChartReading').innerHTML, /本期 · 2026-09-21/);
  assert.match(f.node('detailChartReading').innerHTML, /对比期 · 2026-09-13/);
  assert.match(f.node('detailChartReading').innerHTML, /记录 0 次/);
});
