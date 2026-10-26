import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

const js = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/rebuild.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/rebuild.html', import.meta.url), 'utf8');

function fixture({ reduced = false, url = 'https://matrix.example.test/?theme=tuantuan&classification=slice#accounts' } = {}) {
  const nodes = new Map();
  const document = { activeElement: null, querySelectorAll: () => [], querySelector: () => null };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      id, value: '', innerHTML: '', textContent: '', hidden: true, open: false, disabled: false,
      attrs: {}, dataset: {}, isConnected: true,
      setAttribute(key, value) { this.attrs[key] = value; },
      focus() { document.activeElement = this; this.focused = true; },
      showModal() { this.open = true; }, close() { this.open = false; },
      insertAdjacentHTML(_where, value) { this.innerHTML += value; },
      querySelector() { return null; },
    });
    return nodes.get(id);
  };
  document.getElementById = node;
  document.querySelector = selector => selector === '.date-controls' ? node('date-controls') : null;
  const context = {
    ...model, fmt: model.formatNumber, URL, URLSearchParams, AbortController, Intl, Date,
    setTimeout, clearTimeout, queueMicrotask,
    beijingToday: () => '2026-09-26', rangeFor: (period, end = '2026-09-26') => model.rangeFor(period, end),
    document, window: { matchMedia: () => ({ matches: reduced }) },
    location: { href: url },
    history: { replaceState() {} },
    fetch: async () => { throw new Error('网络暂不可用'); },
  };
  runInNewContext(`${js.replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '')}
    this.subject = { state, busy, load, renderCatalog, renderClassificationFilter, toggleCustomClassifications, renderAccounts, openAccount, closeAccount, loadTopics, loadMonitoringStatus, setView };`, context);
  const { state } = context.subject;
  state.start = state.end = '2026-09-26';
  state.data = { range: { startDate: state.start, endDate: state.end }, accounts: [],
    boards: [{ key: 'roster', name: '团团名单' }],
    themeSummary: { items: [{ key: 'tuantuan', label: '团团', count: 1 }] },
    classificationSummary: { items: [{ key: 'slice', label: '切片', count: 1 }] },
  };
  return { ...context.subject, node, document, setFetch(fn) { context.fetch = fn; } };
}

test('refresh visibly distinguishes reading saved snapshots from collection without changing data', () => {
  const f = fixture(); const original = f.state.data;
  f.busy(true);
  assert.equal(f.state.data, original);
  assert.equal(f.node('refreshBtn').disabled, true);
  assert.equal(f.node('applyDateBtn').disabled, true);
  assert.equal(f.node('main').attrs['aria-busy'], 'true');
  assert.match(f.node('loadFeedback').innerHTML, /保留上次成功快照/);
  assert.match(f.node('loadFeedback').innerHTML, /loading-spinner/);
  f.busy(false);
  assert.equal(f.node('refreshBtn').disabled, false);
  assert.equal(f.node('main').attrs['aria-busy'], 'false');
  assert.equal(f.node('connectionStatus').attrs['data-state'], 'success');
  assert.match(f.node('loadFeedback').innerHTML, /自动页面同步只读取数据，手动刷新快照才发起采集/);
  assert.doesNotMatch(f.node('loadFeedback').innerHTML, /最新数据|采集完成/);
});

test('failed refresh keeps saved data and cannot display a success status', async () => {
  const f = fixture(); const original = f.state.data;
  await f.load();
  assert.equal(f.state.data, original);
  assert.equal(f.node('connectionStatus').attrs['data-state'], 'error');
  assert.equal(f.node('connectionStatus').textContent, '快照读取失败');
  assert.equal(f.node('main').attrs['aria-busy'], 'false');
  assert.equal(f.node('exportButton').disabled, true);
  assert.match(f.node('notice').textContent, /保留上次/);
  assert.match(f.node('loadFeedback').innerHTML, /未取得新结果/);
});

test('scope hierarchy is explicit and escapes source labels without changing URL filters', () => {
  const f = fixture(); f.state.board = 'roster';
  f.state.data.themeSummary.items[0].label = '<团团>';
  f.renderCatalog();
  const scope = f.node('scopeSummary').innerHTML;
  assert.match(scope, /当前数据范围/);
  assert.match(scope, /矩阵.*团团名单.*大主题.*&lt;团团&gt;.*内容类型.*切片/);
  assert.doesNotMatch(scope, /<团团>/);
  assert.equal(f.state.classification, 'slice');
  f.setView('topics'); assert.equal(f.node('scopeSummary').hidden, true);
  f.setView('overview'); assert.equal(f.node('scopeSummary').hidden, false);
});

test('reduced-motion drawer closes immediately, aborts detail fetch, and restores its trigger', async () => {
  const f = fixture({ reduced: true });
  const trigger = f.node('account-trigger'); trigger.focus();
  f.state.data.accounts = [{ id: 42, label: '真实名单账号' }];
  let signal; let animationCalls = 0;
  f.node('accountDialog').animate = () => { animationCalls++; return { finished: Promise.resolve() }; };
  f.setFetch((_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))));
  });
  const pending = f.openAccount(42);
  assert.equal(f.node('accountDialog').open, true);
  assert.equal(f.node('dialogBody').attrs['aria-busy'], 'true');
  await f.closeAccount(); await pending;
  assert.equal(signal.aborted, true);
  assert.equal(animationCalls, 0);
  assert.equal(f.node('accountDialog').open, false);
  assert.equal(f.state.detailId, null);
  assert.equal(f.document.activeElement, trigger);
});

test('drawer exit only animates transform/opacity and never delays reduced-motion users', async () => {
  const f = fixture(); f.node('accountDialog').open = true;
  let frames, options;
  f.node('accountDialog').animate = (keyframes, settings) => { frames = keyframes; options = settings; return { finished: Promise.resolve() }; };
  await f.closeAccount();
  assert.equal(options.duration, 160);
  assert.deepEqual(Object.keys(frames[0]).sort(), ['opacity', 'transform']);
  assert.deepEqual(Object.keys(frames[1]).sort(), ['opacity', 'transform']);
  assert.equal(f.node('accountDialog').open, false);
});

test('cancelled drawer animation cannot trap a user inside a modal', async () => {
  const f = fixture(); f.node('accountDialog').open = true;
  f.node('accountDialog').animate = () => ({ finished: Promise.reject(new Error('animation cancelled')) });
  await f.closeAccount();
  assert.equal(f.node('accountDialog').open, false);
  assert.equal(f.state.detailId, null);
});

test('sorting restores the same column control after replacing table content', () => {
  const f = fixture();
  f.document.activeElement = { dataset: { sort: 'followers.delta' }, closest: () => null };
  const replacement = f.node('replacement-sort');
  f.node('accountsTable').querySelector = selector => selector === '[data-sort="followers.delta"]' ? replacement : null;
  f.renderAccounts();
  assert.equal(f.document.activeElement, replacement);
});

test('pagination focus falls back when reaching a disabled boundary control', () => {
  const f = fixture(); f.document.activeElement = { dataset: { page: 'next' } };
  const disabled = f.node('next'); disabled.disabled = true;
  const previous = f.node('prev');
  f.node('pager').querySelector = selector => selector.includes('data-page') ? disabled : previous;
  f.renderAccounts();
  assert.equal(f.document.activeElement, previous);
});

test('failed topic loading always clears its busy state and exposes a retry action', async () => {
  const f = fixture(); f.state.view = 'topics'; await f.loadTopics();
  assert.equal(f.node('topicsGrid').attrs['aria-busy'], 'false');
  assert.match(f.node('topicsGrid').innerHTML, /data-retry-topics/);
  assert.doesNotMatch(f.node('topicsGrid').innerHTML, /loading-spinner/);
});

test('motion and keyboard contracts are implemented without fake metric animations', () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /#accountDialog\[open\], \.loading-spinner \{ animation: none !important/);
  assert.match(html, /id="connectionStatus" role="status" aria-live="polite"/);
  assert.match(html, /id="main" class="content" tabindex="-1"/);
  assert.match(js, /addEventListener\('cancel', event => \{ event\.preventDefault\(\); void closeAccount\(\)/);
  assert.match(js, /querySelector\('\.skip'\)\.addEventListener\('click', event => \{ event\.preventDefault\(\); \$\('main'\)\.focus\(\)/);
  assert.doesNotMatch(js, /countUp|animateNumber|requestAnimationFrame/);
});

test('monitoring status separates profile round counts from verified eight-hour works coverage', async () => {
  const f = fixture();
  f.setFetch(async () => ({ ok: true, json: async () => ({ scheduler: { scheduleIntervalHours: 8, slotTimes: ['02:00', '10:00', '18:00'], nextRunAt: '2026-09-28T02:00:00Z', running: true, scheduledProfileCompletedTargetCount: 700, scheduledAccountTargetCount: 701, scheduledWorksCompleteTargetCount: 699, scheduledWorksAwaitingNextSlotTargetCount: 688 },
    updateSla: { works: { fresh8h: { total: 701, complete: 12,
      counts: { complete: 12, limited: 188, unavailable: 496, unknown: 0, missing: 5 } } } },
    sourcePoller: { checkedTodayCount: 3, sourceCount: 5, failedCount: 1, blockedCount: 1, staleCount: 2 } }) }));
  await f.loadMonitoringStatus();
  const result = f.node('monitoringStatus').innerHTML;
  assert.match(result, /每 8 小时/);
  assert.match(result, /02:00 \/ 10:00 \/ 18:00/);
  assert.match(result, /正在采集/);
  assert.match(result, /本轮主页 700 \/ 701 · 近 8 小时完整作品明细 12\/701/);
  assert.match(result, /有样本 200 \/ 701（完整 12） · 有限 188 · 未取得 496 · 未核验 0 · 无记录 5/);
  assert.doesNotMatch(result, /完整作品明细 699|本轮作品明细完整/);
  assert.match(result, /今日已检查 3 \/ 5/);
  assert.doesNotMatch(result, /100%|全部完成|全部成功/);
});

test('works-only pause shows a bounded retry time without changing homepage or topic plans', async () => {
  const f = fixture();
  f.setFetch(async () => ({ ok: true, json: async () => ({ scheduler: { running: false,
    worksOnlyRetry: { deferred: true, nextEligibleAt: '2026-09-29T01:05:00.000Z' } } }) }));
  await f.loadMonitoringStatus();
  assert.match(f.node('monitoringStatus').innerHTML, /作品补采连续失败，已暂停重试/);
  assert.match(f.node('monitoringStatus').innerHTML, /09:05/);
  assert.match(f.node('monitoringStatus').innerHTML, /主页与话题的既有更新计划不变/);
  f.setFetch(async () => ({ ok: true, json: async () => ({ scheduler: { worksOnlyRetry: { deferred: false } } }) }));
  await f.loadMonitoringStatus();
  assert.doesNotMatch(f.node('monitoringStatus').innerHTML, /已暂停重试/);
});

test('works-only pause never renders an untrusted invalid retry date', async () => {
  const f = fixture();
  f.setFetch(async () => ({ ok: true, json: async () => ({ scheduler: {
    worksOnlyRetry: { deferred: true, nextEligibleAt: '<script>private-invalid-date</script>' } } }) }));
  await f.loadMonitoringStatus();
  assert.match(f.node('monitoringStatus').innerHTML, /最早 待确认 后自动复查/);
  assert.doesNotMatch(f.node('monitoringStatus').innerHTML, /private-invalid-date/);
});

test('monitoring failure is isolated from loaded snapshots and missing counts are never zero-filled', async () => {
  const f = fixture(); const original = f.state.data;
  await f.loadMonitoringStatus();
  assert.equal(f.state.data, original);
  assert.match(f.node('monitoringStatus').innerHTML, /不影响下方已保存/);
  f.setFetch(async () => ({ ok: true, json: async () => ({ scheduler: { running: true }, sourcePoller: {} }) }));
  await f.loadMonitoringStatus();
  assert.match(f.node('monitoringStatus').innerHTML, /本轮主页 — \/ —/);
  assert.match(f.node('monitoringStatus').innerHTML, /今日已检查 — \/ —/);
});

test('late monitoring responses cannot overwrite a newer status read', async () => {
  const f = fixture(); const pending = [];
  f.setFetch(() => new Promise(resolve => pending.push(resolve)));
  const first = f.loadMonitoringStatus(), second = f.loadMonitoringStatus();
  pending[1]({ ok: true, json: async () => ({ scheduler: { running: true }, sourcePoller: { checkedTodayCount: 4, sourceCount: 5 } }) });
  await second;
  pending[0]({ ok: true, json: async () => ({ scheduler: {}, sourcePoller: { checkedTodayCount: 1, sourceCount: 5 } }) });
  await first;
  assert.match(f.node('monitoringStatus').innerHTML, /今日已检查 4 \/ 5/);
  assert.doesNotMatch(f.node('monitoringStatus').innerHTML, /今日已检查 1 \/ 5/);
});

test('classification filter defaults to system types while retaining a custom deep link', () => {
  const f = fixture({ url: 'https://matrix.example.test/?theme=tuantuan&classification=custom%3A%E9%95%BF%E6%A0%87%E7%AD%BE#accounts' });
  f.state.data.classificationSummary.items = [
    { key: 'all', label: '全部', count: 9 }, { key: 'slice', label: '切片', count: 5 }, { key: 'original', label: '原创', count: 0 },
    { key: 'custom:长标签', label: '长标签', count: 2 }, { key: 'custom:别的标签', label: '别的标签', count: 7 },
  ];
  f.renderCatalog();
  const value = f.node('classificationSelect').innerHTML;
  assert.match(value, /常用系统内容类型/);
  assert.match(value, /value="slice"/); assert.match(value, /value="original"/);
  assert.match(value, /当前已选表格标签/);
  assert.match(value, /value="custom:长标签"/);
  assert.doesNotMatch(value, /value="custom:别的标签"/);
  assert.equal(f.node('classificationSelect').value, 'custom:长标签');
  assert.equal(f.state.classification, 'custom:长标签');
  assert.equal(f.node('classificationMore').textContent, '更多表格标签（2）');
});

test('expanding and collapsing custom tags only changes disclosure, never selection or catalog', () => {
  const f = fixture();
  const items = f.state.data.classificationSummary.items;
  items.push({ key: 'custom:甲', label: '甲', count: 1 }, { key: 'custom:乙', label: '乙', count: 2 });
  const before = JSON.stringify(items);
  f.toggleCustomClassifications();
  assert.match(f.node('classificationSelect').innerHTML, /表格自定义标签/);
  assert.match(f.node('classificationSelect').innerHTML, /custom:甲/);
  assert.match(f.node('classificationSelect').innerHTML, /custom:乙/);
  assert.equal(f.state.classification, 'slice');
  assert.equal(f.node('classificationMore').attrs['aria-expanded'], 'true');
  f.state.classification = 'custom:乙';
  f.toggleCustomClassifications();
  assert.doesNotMatch(f.node('classificationSelect').innerHTML, /custom:甲/);
  assert.match(f.node('classificationSelect').innerHTML, /custom:乙/);
  assert.equal(f.node('classificationSelect').value, 'custom:乙');
  assert.equal(f.state.classification, 'custom:乙');
  assert.equal(JSON.stringify(items), before);
  assert.equal(f.node('classificationMore').attrs['aria-expanded'], 'false');
  assert.match(js, /allClassificationItems\.map\(item => `<button[^\n]*classification-source-tag/);
});

test('monitoring labels distinguish the eight-hour round and separate unchecked sources from stale ones', async () => {
  const f = fixture();
  const payload = { scheduler: { scheduledProfileCompletedTargetCount: 0, scheduledAccountTargetCount: 701, scheduledWorksCompleteTargetCount: 0 },
    updateSla: { works: { fresh8h: { total: 701, complete: 0,
      counts: { complete: 0, limited: 0, unavailable: 0, unknown: 0, missing: 701 } } } },
    sourcePoller: { sourceCount: 8, checkedTodayCount: 0, uncheckedCount: 8, staleCount: 8, failedCount: 0, blockedCount: 0,
      sources: [], businessPendingCount: 0 } };
  f.setFetch(async () => ({ ok: true, json: async () => payload }));
  await f.loadMonitoringStatus();
  let result = f.node('monitoringStatus').innerHTML;
  assert.match(result, /本轮主页 0 \/ 701 · 近 8 小时完整作品明细 0\/701/);
  assert.match(result, /有样本 0 \/ 701（完整 0） · 有限 0 · 未取得 0 · 未核验 0 · 无记录 701/);
  assert.match(result, /今日已检查 0 \/ 8/);
  assert.match(result, /成功读取 — · 未检查 8 · 失败 0 · 访问受限 0 · 过期 0/);
  assert.match(result, /历史回执含待审记录：0 个来源/);
  assert.match(result, /来源任务在途 — · 任务实时状态未确认/);
  assert.doesNotMatch(result, /全部已查|全部完成|过期 8/);
  payload.sourcePoller.uncheckedCount = 3; payload.sourcePoller.staleCount = 6;
  await f.loadMonitoringStatus();
  assert.match(f.node('monitoringStatus').innerHTML, /成功读取 — · 未检查 3 · 失败 0 · 访问受限 0 · 过期 3/);
  payload.sourcePoller.staleCount = 1;
  await f.loadMonitoringStatus();
  assert.match(f.node('monitoringStatus').innerHTML, /过期 0/);
  delete payload.sourcePoller.uncheckedCount;
  await f.loadMonitoringStatus();
  result = f.node('monitoringStatus').innerHTML;
  assert.match(result, /未检查 —/); assert.match(result, /过期 —/);
});
