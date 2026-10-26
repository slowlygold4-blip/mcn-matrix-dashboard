import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8');
function fixture(url = 'https://matrix.test/?period=week&theme=tuantuan&classification=slice#accounts') {
  const nodes = new Map(), requests = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', hidden: true, innerHTML: '', textContent: '', dataset: {}, children: [],
      setAttribute() {}, addEventListener() {}, remove() {}, insertAdjacentHTML() {},
      append(...children) {
        for (const child of children) {
          if (child.parentElement?.children) {
            const oldSiblings = child.parentElement.children;
            const previous = oldSiblings.indexOf(child);
            if (previous >= 0) oldSiblings.splice(previous, 1);
          }
          child.parentElement = this;
          this.children.push(child);
        }
      },
      parentElement: { remove() {}, insertAdjacentHTML() {} } });
    return nodes.get(id);
  };
  const document = { getElementById: node, querySelector: node, querySelectorAll: () => [], addEventListener() {} };
  let today = '2026-09-28';
  const context = { ...model, fmt: model.formatNumber, URL, URLSearchParams, Date, Intl, AbortController,
    setTimeout, clearTimeout,
    location: { href: url, hash: '#accounts' }, document, window: { addEventListener() {} },
    beijingToday: () => today, rangeFor: (period, end = today) => model.rangeFor(period, end),
    fetch: async path => { requests.push(path); return { ok: true, json: async () => ({
      range: { startDate: '2026-09-23', endDate: '2026-09-29' }, accounts: [], summary: { metrics: {}, trend: [] },
    }) }; },
  };
  runInNewContext(`${source.replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '')}
    this.subject = { state, previousEqualPeriod, setupDates, enhanceShell, bind, fillPreviousComparison,
      restoreComparisonDraft, selectedDates, params, committedControls, automaticRead, coreUpdateCoverage, coreUpdateMarkup,
      commit() { appliedRequest = params().toString(); appliedContext = committedControls(); } };`, context);
  const f = { ...context.subject, node, requests, setToday(value) { today = value; } };
  f.enhanceShell(); f.setupDates(); f.bind(); return f;
}
const dates = f => [f.node('compareStart').value, f.node('compareEnd').value];

test('7-day initial comparison is the preceding full 7 days and preserves scope', () => {
  const f = fixture();
  const primary = f.node('primaryScope');
  assert.equal(primary.children.length, 4, 'the shell moves existing controls rather than cloning them');
  assert.equal(primary.children[0], f.node('themeSelect').parentElement);
  assert.equal(primary.children[1], f.node('classificationSelect').parentElement);
  assert.equal(primary.children[2], f.node('classificationMore'));
  assert.equal(primary.children[3], f.node('clearScopeBtn'));
  assert.ok(primary.children.every(child => child.parentElement === primary));
  assert.deepEqual(dates(f), ['2026-09-15', '2026-09-21']);
  assert.equal(f.state.theme, 'tuantuan'); assert.equal(f.state.classification, 'slice');
  assert.equal(f.state.compare, false); assert.equal(f.requests.length, 0);
});
test('30-day initial comparison crosses months using exactly 30 inclusive days', () => {
  const f = fixture('https://matrix.test/?period=30d');
  assert.deepEqual(dates(f), ['2026-07-31', '2026-08-29']);
});
test('custom dates use equal inclusive length, including leap day', () => {
  const f = fixture();
  assert.equal(JSON.stringify(f.previousEqualPeriod('2024-03-01', '2024-03-03')), JSON.stringify({ start: '2024-02-27', end: '2024-02-29', days: 3 }));
  assert.equal(f.previousEqualPeriod('2026-02-30', '2026-03-02'), null);
  assert.equal(f.previousEqualPeriod('2026-03-03', '2026-03-01'), null);
});
test('explicit comparison deeplink is not overwritten by initialization or period changes', () => {
  const f = fixture('https://matrix.test/?period=week&compare=1&compareStart=2026-09-01&compareEnd=2026-09-03');
  assert.deepEqual(dates(f), ['2026-09-01', '2026-09-03']);
  f.state.period = '30d'; f.setupDates();
  assert.deepEqual(dates(f), ['2026-09-01', '2026-09-03']);
});
test('manual input survives current-range changes and toggling comparison on', () => {
  const f = fixture();
  f.node('compareStart').value = '2026-09-05'; f.node('compareStart').oninput();
  f.node('compareEnd').value = '2026-09-09'; f.node('compareEnd').oninput();
  f.state.period = '30d'; f.setupDates();
  f.node('compareToggle').checked = true; f.node('compareToggle').onchange();
  assert.deepEqual(dates(f), ['2026-09-05', '2026-09-09']);
  assert.match(f.node('comparisonHint').textContent, /手工/);
});
test('equal-period shortcut only changes a draft and undo restores manual dates without requests', () => {
  const f = fixture('https://matrix.test/?period=week&compare=1&compareStart=2026-09-01&compareEnd=2026-09-03');
  f.node('previousEqualPeriod').onclick();
  assert.deepEqual(dates(f), ['2026-09-15', '2026-09-21']);
  assert.equal(f.node('restoreComparison').hidden, false);
  f.node('restoreComparison').onclick();
  assert.deepEqual(dates(f), ['2026-09-01', '2026-09-03']);
  assert.equal(f.node('restoreComparison').hidden, true); assert.equal(f.requests.length, 0);
});
test('custom range drafts update automatic default, invalid input leaves existing comparison intact', () => {
  const f = fixture(); f.state.period = 'custom'; f.setupDates();
  f.node('startDate').value = '2026-09-10'; f.node('endDate').value = '2026-09-14'; f.node('endDate').oninput();
  assert.deepEqual(dates(f), ['2026-09-05', '2026-09-09']);
  f.node('startDate').value = ''; f.node('startDate').oninput();
  assert.deepEqual(dates(f), ['2026-09-05', '2026-09-09']);
  assert.match(f.node('comparisonHint').textContent, /有效/);
});
test('applied automatic comparison advances equally at Beijing midnight', async () => {
  const f = fixture(); f.state.compare = true; f.selectedDates(); f.commit(); f.setToday('2026-09-29');
  await f.automaticRead({});
  const query = new URL(f.requests[0], 'https://matrix.test').searchParams;
  assert.equal(query.get('startDate'), '2026-09-23');
  assert.equal(query.get('comparisonProjection'), 'summary', 'automatic overview updates request only the B summary consumed by the page');
  assert.equal(query.get('comparisonStartDate'), '2026-09-16'); assert.equal(query.get('comparisonEndDate'), '2026-09-22');
});
test('manual comparison remains fixed across automatic midnight updates', async () => {
  const f = fixture('https://matrix.test/?period=week&compare=1&compareStart=2026-09-01&compareEnd=2026-09-03');
  f.selectedDates(); f.commit(); f.setToday('2026-09-29'); await f.automaticRead({});
  const query = new URL(f.requests[0], 'https://matrix.test').searchParams;
  assert.equal(query.get('comparisonStartDate'), '2026-09-01'); assert.equal(query.get('comparisonEndDate'), '2026-09-03');
});
test('overview summary projection is opt-in only when comparison is applied', () => {
  const f = fixture(); f.selectedDates();
  assert.equal(f.params().has('comparisonProjection'), false);
  f.state.compare = true;
  assert.equal(f.params().get('comparisonProjection'), 'summary');
  f.state.compare = false;
  assert.equal(f.params().has('comparisonProjection'), false);
});
test('core SLA uses explicit numerators and denominators without implying all-data success', () => {
  const f = fixture(), daily = { total: 701, complete: 687, missing: 14, ratioPercent: 687 / 701 * 100, requiredPercent: 80, status: 'met' };
  assert.match(f.coreUpdateCoverage(daily), /98\.0% · 687 \/ 701 · 核心三项达标/);
  assert.match(f.coreUpdateMarkup({ coreAccounts: { daily, fresh8h: daily } }), /不代表作品明细或话题完整/);
  assert.doesNotMatch(f.coreUpdateMarkup({ coreAccounts: { daily } }), /全部成功|全数据达标/);
});
test('unknown, malformed, zero denominator and below-threshold SLA stay honest', () => {
  const f = fixture();
  assert.match(f.coreUpdateCoverage(undefined), /未知/);
  assert.match(f.coreUpdateCoverage({ total: 10, complete: 12, missing: -2, ratioPercent: 120, requiredPercent: 80, status: 'met' }), /未知/);
  assert.match(f.coreUpdateCoverage({ total: 0, complete: 0, missing: 0, ratioPercent: null, requiredPercent: 80, status: 'unknown' }), /0 \/ 0.*未知/);
  assert.match(f.coreUpdateCoverage({ total: 10000, complete: 7999, missing: 2001, ratioPercent: 79.99, requiredPercent: 80, status: 'below-target' }), /79\.9%.*未达标/);
  assert.match(f.coreUpdateCoverage({ total: 10, complete: 8, missing: 2, ratioPercent: 80, requiredPercent: 80, status: 'below-target' }), /未知/);
});
