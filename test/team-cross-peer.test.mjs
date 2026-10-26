import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';
import { createLiveSync } from '../public/live-sync.js';

// Reuse the established DOM/network fixture, without registering its tests.
// It executes the complete current rebuild source and actual live-sync module.
const fixtureUrl = new URL('./rebuild-live-review.test.mjs', import.meta.url);
const fixtureSource = readFileSync(fixtureUrl, 'utf8').split('\ntest(')[0]
  .replace(/^import[^\n]+\n/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(fixtureUrl.href))
  .replace('return { ...subject, node,', 'return { navigator: context.navigator, ...subject, node,');
const fixtureContext = { assert, readFileSync, runInNewContext, model, createLiveSync, URL, URLSearchParams,
  structuredClone, AbortController, setImmediate };
runInNewContext(`${fixtureSource}\nthis.fixtures = { fixture, insight, response };`, fixtureContext);
const { fixture, insight, response } = fixtureContext.fixtures;
const monitoring = count => ({ scheduler: { currentRun: { runId: 79, completedCount: count } } });

async function queued() {
  const f = fixture(); f.state.session = { authenticated: true };
  f.setFetch(async path => response(path === '/api/monitoring-status' ? monitoring(1) : insight('saved')));
  await f.load();
  const reader = f.node('reader'); reader.matches = selector => selector === 'summary,a'; reader.focus();
  await f.startLiveSync();
  f.setFetch(async path => response(path === '/api/monitoring-status' ? monitoring(2) : insight('queued')));
  await f.runTimer(30_000);
  assert.equal(f.state.data.reviewLabel, 'saved');
  assert.equal(f.node('applyLiveUpdate').hidden, false);
  return f;
}

test('cross peer: explicit update can leave reading focus and keeps the replacement focus visible', async () => {
  const f = await queued();
  assert.equal(f.node('applyLiveUpdate').disabled, false);
  assert.equal(f.node('applyLiveUpdate').onclick(), true);
  assert.equal(f.state.data.reviewLabel, 'queued');
  assert.equal(f.document.activeElement.id, 'refreshBtn');
  assert.equal(f.node('applyLiveUpdate').hidden, true);
});

test('cross peer: direct explicit-update invocation cannot bypass state protections', async t => {
  for (const [name, block, unblock] of [
    ['offline', f => { f.navigator.onLine = false; }, f => { f.navigator.onLine = true; }],
    ['hidden', f => { f.document.hidden = true; }, f => { f.document.hidden = false; }],
    ['busy', f => { f.state.busy = true; }, f => { f.state.busy = false; }],
    ['expired session', f => { f.state.session.authenticated = false; }, f => { f.state.session.authenticated = true; }],
    ['detail', f => { f.node('accountDialog').open = true; }, f => { f.node('accountDialog').open = false; }],
    ['import preview', f => { f.node('importPreview').hidden = false; }, f => { f.node('importPreview').hidden = true; }],
    ['selected file', f => { f.node('fileInput').files = [{ name: 'draft.xlsx' }]; }, f => { f.node('fileInput').files = []; }],
    ['scope draft', f => { f.state.theme = 'draft-theme'; }, f => { f.state.theme = 'all'; }],
    ['import view', f => { f.state.view = 'import'; }, f => { f.state.view = 'overview'; }],
  ]) await t.test(name, async () => {
    const f = await queued(); block(f);
    assert.equal(f.node('applyLiveUpdate').onclick(), false);
    assert.equal(f.state.data.reviewLabel, 'saved');
    unblock(f);
    assert.equal(f.node('applyLiveUpdate').onclick(), true);
    assert.equal(f.state.data.reviewLabel, 'queued');
  });
});

test('cross peer: explicit click never resurrects pending data after a newer committed scope', async () => {
  const f = await queued();
  f.state.theme = 'new-theme';
  f.setFetch(async path => response(path === '/api/monitoring-status' ? monitoring(3) : insight('new-scope')));
  await f.load();
  assert.equal(f.state.data.reviewLabel, 'new-scope');
  assert.equal(f.node('applyLiveUpdate').onclick(), false);
  assert.equal(f.state.data.reviewLabel, 'new-scope');
  assert.equal(f.state.theme, 'new-theme');
});

test('cross peer: late automatic response cannot replace a newer manual scope even if transport ignores abort', async () => {
  const f = await queued(); let finish;
  const oldData = new Promise(resolve => { finish = resolve; });
  f.setFetch(path => path === '/api/monitoring-status' ? Promise.resolve(response(monitoring(3))) : oldData);
  await f.runTimer(30_000);
  f.state.theme = 'new-theme';
  f.setFetch(async path => response(path === '/api/monitoring-status' ? monitoring(4) : insight('new-scope')));
  await f.load();
  finish(response(insight('stale-scope')));
  await new Promise(setImmediate);
  assert.equal(f.node('applyLiveUpdate').onclick(), false);
  assert.equal(f.state.data.reviewLabel, 'new-scope');
});

test('cross peer: stable period focus respects active-key delay and uncommitted native selection', async () => {
  const f = await queued();
  const select = f.node('periodSelect'); select.value = f.state.period;
  select.matches = selector => selector.includes('select'); select.focus();
  assert.equal(f.syncBlockedReason(), '');
  f.documentListeners.get('keydown')();
  assert.match(f.syncBlockedReason(), /操作完成/);
  f.advanceTime(1499); assert.match(f.syncBlockedReason(), /操作完成/);
  f.advanceTime(1); assert.equal(f.syncBlockedReason(), '');
  select.value = 'week';
  assert.match(f.syncBlockedReason(), /正在输入/, 'a native option not yet committed cannot be treated as stable focus');
  select.value = f.state.period; f.state.theme = 'draft';
  assert.match(f.syncBlockedReason(), /未应用/);
});

test('cross peer: topic subtitle keeps the applied historical range when account filters have drafts', async () => {
  const f = fixture('http://127.0.0.1:4188/?period=custom&start=2026-09-20&end=2026-09-22&theme=tuantuan');
  const data = insight('saved'); data.period = 'custom'; data.range = { startDate: '2026-09-20', endDate: '2026-09-22' };
  data.themeSummary.items.push({ key: 'tuantuan', label: '团团', count: 2 });
  f.setFetch(async path => response(path === '/api/monitoring-status' ? monitoring(1) : data)); await f.load();
  f.node('startDate').value = '2026-09-21';
  f.setFetch(async () => response({ topics: [] }));
  f.setView('topics');
  assert.match(f.node('pageSubtitle').textContent, /全部监控话题.*2026-09-20 至 2026-09-22/);
  assert.doesNotMatch(f.node('pageSubtitle').textContent, /团团/);
  f.setView('accounts');
  assert.match(f.node('pageSubtitle').textContent, /团团.*2026-09-20 至 2026-09-22/);
  assert.equal(f.node('startDate').value, '2026-09-21');
});

const decodeCell = value => value.slice(1, -1).replaceAll('""', '"');
test('cross peer: finite numeric negatives bypass text guarding without opening the text formula boundary', () => {
  for (const number of [-1, -0, -Number.MIN_VALUE, -1e30, Number.MAX_VALUE, 0, 3.5]) {
    assert.equal(decodeCell(model.csvCell(number)), String(number));
  }
  for (const whitespace of ['', ' ', '\t', '\n', '\r', '\ufeff', '\u00a0', ' \t\n']) {
    for (const formula of ['=1+1', '+1+1', '-1+1', '@SUM(A1:A2)']) {
      const value = `${whitespace}${formula}`;
      assert.equal(decodeCell(model.csvCell(value)), `'${value}`);
    }
  }
  for (const value of ['-1', new Number(-1), { toString: () => '=1+1' }, -1n]) {
    assert.equal(decodeCell(model.csvCell(value)), `'${String(value)}`);
  }
  assert.equal(decodeCell(model.csvCell('a,"b"\r\nc')), 'a,"b"\r\nc');
  for (const value of [null, undefined, NaN, Infinity, -Infinity]) assert.equal(decodeCell(model.csvCell(value)), '');
});
