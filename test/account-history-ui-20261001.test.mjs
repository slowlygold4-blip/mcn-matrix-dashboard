import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8');
const asOf = '2026-10-01T00:49:00.000Z';
const revision = { snapshotMaxId: 2000, postMaxId: 2000, postMetricMaxId: 2000 };
const response = body => ({ ok: true, status: 200, json: async () => body });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
function history(kind = 'works', { total = 45, page = 1, pageSize = 20, startDate = null, endDate = null, workId = 17 } = {}) {
  const count = Math.min(pageSize, Math.max(0, total - (page - 1) * pageSize));
  return { version: 1, targetId: 477, kind, asOf, revision: { ...revision },
    range: { startDate, endDate, firstRecordedDate: '2026-08-01', lastRecordedDate: '2026-09-30' },
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    coverage: { scope: 'all-saved-account-history', platformComplete: false, missingDatesFilled: false },
    items: Array.from({ length: count }, (_, n) => ({ id: (page - 1) * pageSize + n + 1, workId,
      caption: `合成作品 ${n}`, publishedAt: '2026-08-01T00:00:00.000Z', lastObservedAt: '2026-09-30T00:00:00.000Z',
      capturedAt: '2026-09-30T00:00:00.000Z', date: '2026-09-30', likes: 0, comments: null, shares: 4, collects: 0,
      plays: null, followers: 100, posts: 20, followersDelta: -5, likesDelta: 0, postsDelta: null })) };
}
function harness() {
  const nodes = new Map(), listeners = new Map(), requests = [];
  const document = { activeElement: null, body: { id: 'body' }, querySelector: () => null,
    querySelectorAll(selector) {
      const key = selector.match(/^\[data-history-(page|kind|work-page)\]$/)?.[1];
      return key ? [...nodes.values()].filter(node => node.dataset[key === 'work-page' ? 'historyWorkPage' : `history${key[0].toUpperCase() + key.slice(1)}`]) : [];
    }, addEventListener(name, fn) { listeners.set(name, fn); }, createElement() { return { click() {} }; } };
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', innerHTML: '', textContent: '', hidden: false, disabled: false, open: false,
      isConnected: true, dataset: {}, attributes: {}, setAttribute(key, value) { this.attributes[key] = String(value); },
      addEventListener() {}, scrolls: [], scrollIntoView(options) { this.scrolls.push(options); }, focus() { document.activeElement = this; }, close() { this.open = false; }, showModal() { this.open = true; },
      insertAdjacentHTML(_where, html) { this.innerHTML += html; } });
    return nodes.get(id);
  }
  document.getElementById = node; document.activeElement = document.body;
  const context = { ...model, fmt: model.formatNumber, URL, URLSearchParams, Date, Intl, AbortController, Set,
    location: new URL('http://127.0.0.1:4188/?period=week#accounts'), document,
    window: { matchMedia: () => ({ matches: true }) }, setTimeout() {}, clearTimeout() {},
    fetch: async (path, options) => { requests.push({ path, options }); throw new Error('unexpected network'); } };
  runInNewContext(`${source.replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '')}\nthis.subject={state,accountHistoryShell,mountAccountHistory,loadAccountHistory,changeHistoryKind,changeHistorySort,applyHistoryDates,loadWorkHistory,clearWorkHistory,cancelAccountHistory,closeAccount,historyQuery,validateAccountHistory,historyTable,historyCsv,readAllHistoryPages,historySortOptions,get history(){return accountHistory;}};`, context);
  context.subject.state.detailId = 477; context.subject.state.start = '2026-09-25'; context.subject.state.end = '2026-10-01';
  node('accountDialog').open = true;
  return { ...context.subject, get history() { return context.subject.history; }, node, nodes, document, requests,
    setFetch(fn) { context.fetch = async (path, options) => { requests.push({ path, options }); return fn(path, options); }; } };
}
function fixtureState(extra = {}) {
  return { targetId: 477, kind: 'works', asOf, revision: { ...revision }, page: 1, pageSize: 20,
    sort: 'publishedAt', order: 'desc', startDate: '', endDate: '', ...extra };
}

test('visible independent entry labels all saved, not complete platform history; existing evidence remains capped', () => {
  const f = harness(), html = f.accountHistoryShell();
  assert.match(html, /全部已保存历史/); assert.match(html, /不受主页日期限制/); assert.match(html, /不代表平台全部作品/);
  assert.match(source, /\$\{accountHistoryShell\(\)\}\$\{renderWorksEvidence\(data, detailRange\)\}/);
  assert.match(source, /recentWorks.*slice\(0, 20\)/);
  assert.match(source, /正在查看账号详情，关闭后同步/);
});

test('initial history omits homepage dates and cutoff; first response pins UTC cutoff and all three revision caps', async () => {
  const f = harness(); f.setFetch(async () => response(history()));
  await f.mountAccountHistory();
  const first = new URL(f.requests[0].path, 'http://local').searchParams;
  assert.equal(first.has('startDate'), false); assert.equal(first.has('endDate'), false); assert.equal(first.has('asOf'), false);
  assert.equal(f.history.asOf, asOf); assert.deepEqual({ ...f.history.revision }, revision);
  assert.match(f.node('historyResults').innerHTML, /共 45 条/); assert.match(f.node('historyResults').innerHTML, /第 1 \/ 3 页/);
  f.history.page = 3; f.setFetch(async () => response(history('works', { page: 3 })));
  await f.loadAccountHistory();
  const next = new URL(f.requests.at(-1).path, 'http://local').searchParams;
  assert.equal(next.get('asOf'), asOf);
  for (const key of Object.keys(revision)) assert.equal(next.get(key), String(revision[key]));
  assert.equal((f.node('historyResults').innerHTML.match(/<tr>/g) || []).length, 6);
});

test('switching daily keeps pinned snapshot and applied dates, resets page, and offers numeric sorts', async () => {
  const f = harness(); f.setFetch(async () => response(history())); await f.mountAccountHistory();
  f.history.page = 3; f.setFetch(async () => response(history('daily'))); await f.changeHistoryKind('daily');
  assert.equal(f.history.page, 1); assert.equal(f.history.asOf, asOf); assert.equal(f.history.sort, 'date');
  assert.deepEqual(Array.from(f.historySortOptions('daily'), row => row[0]), ['date', 'followers', 'followersDelta', 'likes', 'likesDelta', 'posts', 'postsDelta', 'estimatedPlays', 'estimatedPlaysDelta']);
  assert.match(f.node('historyResults').innerHTML, /-5/); assert.match(f.node('historyResults').innerHTML, /title="0">0/);
  assert.match(f.node('historyResults').innerHTML, /class="flat">—/);
});

test('date drafts do not dispatch until valid paired dates are applied; clearing restores all saved, not homepage week', async () => {
  const f = harness(); f.setFetch(async () => response(history())); await f.mountAccountHistory();
  const before = f.requests.length;
  f.node('historyStartDate').value = '2026-09-01'; await f.applyHistoryDates(); assert.equal(f.requests.length, before);
  f.node('historyEndDate').value = '2026-08-01'; await f.applyHistoryDates(); assert.equal(f.requests.length, before);
  f.node('historyEndDate').value = '2026-09-30';
  f.setFetch(async () => response(history('works', { startDate: '2026-09-01', endDate: '2026-09-30' })));
  await f.applyHistoryDates(); assert.equal(f.history.startDate, '2026-09-01'); assert.equal(f.history.asOf, asOf);
  f.setFetch(async () => response(history())); await f.applyHistoryDates({ clear: true });
  assert.equal(f.history.startDate, ''); assert.equal(f.history.endDate, ''); assert.equal(f.history.asOf, asOf);
});

test('only explicit latest refresh resets cutoff and revisions; page/filter navigation does not', async () => {
  const f = harness(); f.setFetch(async () => response(history())); await f.mountAccountHistory();
  await f.loadAccountHistory({ latest: true });
  const query = new URL(f.requests.at(-1).path, 'http://local').searchParams;
  assert.equal(query.has('asOf'), false); assert.equal(query.has('snapshotMaxId'), false); assert.equal(query.get('page'), '1');
});

test('malformed, foreign-account, missing revision and changed snapshots fail closed', () => {
  const f = harness(), expected = fixtureState();
  for (const change of [d => { d.targetId = 478; }, d => { delete d.revision; }, d => { d.revision.postMaxId++; },
    d => { d.pagination.totalPages++; }, d => { d.items.pop(); }, d => { d.items[0].id = 9999; },
    d => { d.items[1].id = d.items[0].id; }, d => { d.coverage.platformComplete = true; },
    d => { d.range.startDate = '2026-09-01'; }, d => { d.asOf = '2026-10-01T00:50:00.000Z'; }]) {
    const data = history(); change(data); assert.throws(() => f.validateAccountHistory(data, expected));
  }
  const empty = history('works', { total: 0 }); empty.revision = { snapshotMaxId: 0, postMaxId: 0, postMetricMaxId: 0 };
  assert.equal(f.validateAccountHistory(empty, fixtureState({ revision: null })), empty);
  assert.match(f.historyQuery(fixtureState({ revision: empty.revision })), /postMaxId=0/);
});

test('escaped captions, safe URLs, 0/unavailable plays and unknown dates are not upgraded into verified actual reach', () => {
  const f = harness(), data = history('works', { total: 1 });
  Object.assign(data.items[0], { caption: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)', publishedAt: null,
    plays: 0, playsEvidence: { mayBePlaceholder: true } });
  const html = f.historyTable(data);
  assert.doesNotMatch(html, /<img|href="javascript/); assert.match(html, /&lt;img/); assert.match(html, /未知/);
  assert.match(html, /来源 0 可能是占位值/); assert.match(html, /播放来源值/); assert.doesNotMatch(html, /已核实实际播放/);
  data.items[0].plays = null; assert.match(f.historyTable(data), /来源未提供/);
});

test('late older page response cannot overwrite newer page; close cancels and ignores even abort-insensitive responses', async () => {
  const f = harness(); f.setFetch(async () => response(history())); await f.mountAccountHistory();
  const old = deferred(); f.history.page = 2; f.setFetch(() => old.promise); const reading = f.loadAccountHistory();
  const oldSignal = f.requests.at(-1).options.signal;
  f.history.page = 3; f.setFetch(async () => response(history('works', { page: 3 }))); await f.loadAccountHistory();
  assert.equal(oldSignal.aborted, true); const latest = f.node('historyResults').innerHTML;
  old.resolve(response(history('works', { page: 2 }))); await reading; assert.equal(f.node('historyResults').innerHTML, latest);
  const closing = deferred(); f.setFetch(() => closing.promise); const pending = f.loadAccountHistory();
  const closeSignal = f.requests.at(-1).options.signal; await f.closeAccount();
  assert.equal(closeSignal.aborted, true); closing.resolve(response(history('works', { page: 3 }))); await pending;
  assert.equal(f.history, null); assert.equal(f.node('historyResults').innerHTML, latest);
});

test('account switch invalidates old generation and cannot insert foreign results', async () => {
  const f = harness(), delayed = deferred(); f.setFetch(() => delayed.promise); const pending = f.mountAccountHistory();
  f.cancelAccountHistory(); f.state.detailId = 478; f.node('historyResults').innerHTML = 'new author';
  delayed.resolve(response(history())); await pending; assert.equal(f.node('historyResults').innerHTML, 'new author');
});

test('single work metrics uses workId, fixed revision and historical dates; rejects mismatched work IDs', async () => {
  const f = harness(); f.setFetch(async () => response(history())); await f.mountAccountHistory();
  f.setFetch(async () => response(history('workMetrics', { total: 21, workId: 17 }))); await f.loadWorkHistory(17);
  const query = new URL(f.requests.at(-1).path, 'http://local').searchParams;
  assert.equal(query.get('workId'), '17'); assert.equal(query.get('asOf'), asOf); assert.equal(query.get('postMetricMaxId'), '2000');
  assert.match(f.node('historyWorkPanel').innerHTML, /第 1 \/ 2 页/); assert.match(f.node('historyWorkPanel').innerHTML, /historyWorkSort/);
  assert.match(f.node('historyWorkPanel').innerHTML, /未逐条独立核验/);
  const wrong = history('workMetrics', { total: 1, workId: 18 });
  assert.throws(() => f.validateAccountHistory(wrong, fixtureState({ kind: 'workMetrics', workId: 17 })));
});

test('CSV reads ALL 45 filtered rows across three pages, carries fixed snapshot and whitelists fields', async () => {
  const f = harness(), queryValues = [];
  f.setFetch(async path => { const q = new URL(path, 'http://local').searchParams; queryValues.push(q);
    const data = history('works', { page: Number(q.get('page')) }); data.items.forEach(item => { item.caption = '=SUM(1,2)'; item.raw_json = 'SECRET-DO-NOT-EXPORT'; }); return response(data); });
  const result = await f.readAllHistoryPages(fixtureState());
  assert.equal(result.rows.length, 45); assert.equal(queryValues.length, 3); assert.equal(result.csv.split('\r\n').length, 46);
  for (const q of queryValues) { assert.equal(q.get('asOf'), asOf); assert.equal(q.get('postMaxId'), '2000'); }
  assert.match(result.csv, /'=SUM/); assert.doesNotMatch(result.csv, /SECRET-DO-NOT-EXPORT|raw_json/);
  assert.match(result.csv, /播放来源值（未独立核验）/);
});

test('partial or inconsistent CSV pages never produce a completed export', async () => {
  const f = harness();
  for (const alteration of [d => { d.revision.postMetricMaxId++; }, d => { d.pagination.total++; },
    d => { d.items.pop(); }, d => { d.items[0].id = 1; }]) {
    f.setFetch(async path => { const page = Number(new URL(path, 'http://local').searchParams.get('page'));
      const data = history('works', { page }); if (page === 2) alteration(data); return response(data); });
    await assert.rejects(f.readAllHistoryPages(fixtureState()));
  }
});

test('history fails without replacement or allowing export under unapplied response scope', async () => {
  const f = harness(); f.setFetch(async () => response(history())); await f.mountAccountHistory();
  const old = f.node('historyResults').innerHTML;
  f.history.startDate = '2026-09-01'; f.history.endDate = '2026-09-30';
  f.setFetch(async () => { throw new Error('synthetic read failure'); }); await f.loadAccountHistory();
  assert.ok(f.node('historyResults').innerHTML.startsWith(old)); assert.match(f.node('historyStatus').textContent, /不代表当前筛选/);
  assert.equal(f.node('historyExport').disabled, true); assert.match(f.node('historyResults').innerHTML, /重试当前历史/);
});

test('every numeric daily header is a real keyboard button with aria-sort and toggles both directions without changing snapshot', async () => {
  const f = harness(); f.setFetch(async () => response(history())); await f.mountAccountHistory();
  f.setFetch(async () => response(history('daily'))); await f.changeHistoryKind('daily');
  await f.changeHistorySort('followersDelta');
  assert.equal(f.history.sort, 'followersDelta'); assert.equal(f.history.order, 'desc');
  assert.match(f.node('historyResults').innerHTML, /aria-sort="descending"><button[^>]+data-history-sort-key="followersDelta"/);
  await f.changeHistorySort('followersDelta'); assert.equal(f.history.order, 'asc');
  assert.match(f.node('historyResults').innerHTML, /aria-sort="ascending"><button[^>]+data-history-sort-key="followersDelta"/);
  assert.equal(f.history.asOf, asOf); assert.equal(f.history.page, 1);
  const count = f.requests.length; await f.changeHistorySort('raw_json'); assert.equal(f.requests.length, count);
});

test('work metric history never inherits works publication filters and uses independent all-saved dates', async () => {
  const f = harness(); f.setFetch(async () => response(history())); await f.mountAccountHistory();
  f.history.startDate = '2026-09-01'; f.history.endDate = '2026-09-30';
  f.setFetch(async () => response(history('workMetrics', { total: 1, workId: 17 }))); await f.loadWorkHistory(17);
  const query = new URL(f.requests.at(-1).path, 'http://local').searchParams;
  assert.equal(query.has('startDate'), false); assert.equal(query.has('endDate'), false); assert.equal(query.get('asOf'), asOf);
  assert.match(f.node('historyWorkPanel').innerHTML, /不继承作品列表的发布时间筛选/);
});

test('daily page and CSV retain per-metric source and baseline, never call final daily record the universal metric sample', () => {
  const f = harness(), data = history('daily', { total: 1 }), point = data.items[0];
  Object.assign(point, { sourceChecksum: 'final-record-checksum', followersAt: '2026-09-30T00:00:00.000Z',
    followersChecksum: 'follower-source', followersBaselineAt: '2026-09-29T00:00:00.000Z', followersBaselineChecksum: 'follower-baseline',
    likesAt: '2026-09-30T03:00:00.000Z', likesChecksum: 'likes-source', likesBaselineAt: '2026-09-29T02:00:00.000Z', likesBaselineChecksum: 'likes-baseline' });
  const html = f.historyTable(data), csv = f.historyCsv(data, [point]);
  assert.match(html, /查看采样依据/); assert.match(html, /各项可能来自同日不同采样/);
  for (const value of ['follower-source', 'follower-baseline', 'likes-source', 'likes-baseline']) { assert.ok(html.includes(value)); assert.ok(csv.includes(value)); }
  assert.match(csv, /粉丝观测时间UTC.*粉丝前日基准时间UTC.*获赞观测时间UTC/);
  assert.ok(csv.includes('2026-09-30T03:00:00.000Z')); assert.match(csv, /当日最后记录时间UTC/);
});

test('failed or changed fixed-page totals cannot unlock export under a new scope', async () => {
  const f = harness(); f.setFetch(async () => response(history())); await f.mountAccountHistory();
  f.history.page = 2; f.setFetch(async () => response(history('works', { page: 2, total: 46 }))); await f.loadAccountHistory();
  assert.match(f.node('historyStatus').textContent, /固定截面内历史条数改变/);
  assert.match(f.node('historyResults').innerHTML, /共 45 条/);
});

test('late history completion never steals a newer date input focus', async () => {
  const f = harness(); f.setFetch(async () => response(history())); await f.mountAccountHistory();
  const pager = f.node('nextPage'); pager.dataset.historyPage = '2'; f.document.activeElement = pager;
  const pending = deferred(); f.history.page = 2; f.setFetch(() => pending.promise); const read = f.loadAccountHistory();
  const input = f.node('historyStartDate'); input.focus(); pending.resolve(response(history('works', { page: 2 }))); await read;
  assert.equal(f.document.activeElement, input);
});

test('main history keeps TOP and BOTTOM pagination focus at the clicked location', async () => {
  for (const location of ['top', 'bottom']) {
    const f = harness(); f.setFetch(async () => response(history())); await f.mountAccountHistory();
    for (const place of ['top', 'bottom']) for (const [direction, page] of [['prev', '1'], ['next', '3']]) {
      const button = f.node(`${place}-${direction}`); button.dataset.historyPage = page; button.dataset.historyLocation = place;
    }
    const old = { dataset: { historyPage: '2', historyLocation: location }, isConnected: false };
    f.document.activeElement = old; f.history.page = 2;
    f.setFetch(async () => {
      f.document.activeElement = f.document.body;
      // The minimal DOM boundary reuses objects; emulate enabled replacement
      // pager nodes created by innerHTML in a real browser.
      for (const button of f.nodes.values()) if (button.dataset.historyPage) button.disabled = false;
      return response(history('works', { page: 2 }));
    });
    await f.loadAccountHistory(); assert.equal(f.document.activeElement, f.node(`${location}-next`));
    assert.match(f.node('historyResults').innerHTML, /已保存历史翻页顶部/); assert.match(f.node('historyResults').innerHTML, /已保存历史翻页底部/);
  }
});

test('single-work history keeps pagination focus in the same TOP or BOTTOM position', async () => {
  for (const location of ['top', 'bottom']) {
    const f = harness(); f.setFetch(async () => response(history())); await f.mountAccountHistory();
    f.setFetch(async () => response(history('workMetrics', { total: 45, workId: 17 }))); await f.loadWorkHistory(17);
    for (const place of ['top', 'bottom']) for (const [direction, page] of [['prev', '1'], ['next', '3']]) {
      const button = f.node(`${place}-${direction}`); button.dataset.historyWorkPage = page; button.dataset.historyLocation = place;
    }
    const old = { dataset: { historyWorkPage: '2', historyLocation: location }, isConnected: false }; f.document.activeElement = old;
    f.setFetch(async () => { f.document.activeElement = f.document.body; return response(history('workMetrics', { total: 45, page: 2, workId: 17 })); });
    await f.loadWorkHistory(17, 2); assert.equal(f.document.activeElement, f.node(`${location}-next`));
    assert.match(f.node('historyWorkPanel').innerHTML, /单作品历史翻页顶部/); assert.match(f.node('historyWorkPanel').innerHTML, /单作品历史翻页底部/);
  }
});

test('first explicit work open brings its real child heading into view with instant movement', async () => {
  const f = harness(); f.setFetch(async () => response(history())); await f.mountAccountHistory();
  const trigger = f.node('work-trigger'); trigger.dataset.historyWork = '17'; trigger.focus();
  f.setFetch(async () => response(history('workMetrics', { total: 45, workId: 17 }))); await f.loadWorkHistory(17);
  assert.equal(f.document.activeElement, f.node('historyWorkTitle'));
  assert.equal(f.node('historyWorkTitle').scrolls.length, 1);
  assert.equal(f.node('historyWorkTitle').scrolls[0].behavior, 'instant');
  assert.equal(f.node('historyWorkTitle').scrolls[0].block, 'center');
});

test('late first work response does not scroll or refocus after the user chooses a newer input', async () => {
  const f = harness(); f.setFetch(async () => response(history())); await f.mountAccountHistory();
  const trigger = f.node('work-trigger'); trigger.dataset.historyWork = '17'; trigger.focus();
  const pending = deferred(); f.setFetch(() => pending.promise); const read = f.loadWorkHistory(17);
  const newer = f.node('historyStartDate'); newer.focus(); pending.resolve(response(history('workMetrics', { total: 45, workId: 17 }))); await read;
  assert.equal(f.document.activeElement, newer); assert.equal(f.node('historyWorkTitle').scrolls.length, 0);
});

test('same-work paging and sorting never repeat the first-open scroll', async () => {
  const f = harness(); f.setFetch(async () => response(history())); await f.mountAccountHistory();
  const trigger = f.node('work-trigger'); trigger.dataset.historyWork = '17'; trigger.focus();
  f.setFetch(async () => response(history('workMetrics', { total: 45, workId: 17 }))); await f.loadWorkHistory(17);
  const pager = f.node('child-pager'); pager.dataset.historyWorkPage = '2'; pager.dataset.historyLocation = 'top'; pager.focus();
  f.setFetch(async () => response(history('workMetrics', { total: 45, page: 2, workId: 17 }))); await f.loadWorkHistory(17, 2);
  const sort = f.node('child-sort'); sort.dataset.historyWorkSortKey = 'likes'; sort.focus();
  f.setFetch(async () => response(history('workMetrics', { total: 45, workId: 17 }))); await f.changeHistorySort('likes', { work: true });
  assert.equal(f.node('historyWorkTitle').scrolls.length, 1);
});
