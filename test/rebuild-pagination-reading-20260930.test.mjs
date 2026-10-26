import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

function fixture(count = 45) {
  const nodes = new Map();
  const document = { activeElement: null, querySelectorAll: () => [] };
  const node = id => {
    if (nodes.has(id)) return nodes.get(id);
    const item = { id, dataset: {}, value: '', _html: '', textContent: '', controls: [], scrollCalls: [], focusCalls: [],
      focus(options) { this.focusCalls.push(options); document.activeElement = this; },
      scrollIntoView(options) { this.scrollCalls.push(options); },
      closest(selector) { return this.rootId && selector.includes(`#${this.rootId}`) ? node(this.rootId) : null; },
      querySelector(selector) {
        if (selector === 'button:not(:disabled)') return this.controls.find(control => !control.disabled) || null;
        const direction = /\[data-page="([^"]+)"\]/.exec(selector)?.[1];
        return this.controls.find(control => control.dataset.page === direction) || null;
      } };
    Object.defineProperty(item, 'innerHTML', { get() { return this._html; }, set(html) {
      this._html = html;
      this.controls = [...html.matchAll(/<button data-page="(prev|next)" ([^>]*)>/g)].map(match => ({
        dataset: { page: match[1] }, rootId: this.id, disabled: /\bdisabled\b/.test(match[2]),
        closest: item.closest,
        focus(options) { this.focusOptions = options; document.activeElement = this; },
      }));
    } });
    nodes.set(id, item); return item;
  };
  document.getElementById = node;
  document.activeElement = node('body');
  const location = new URL('http://127.0.0.1:4188/?theme=tuantuan&classification=slice&sort=followers.value&direction=desc#accounts');
  const context = { ...model, fmt: model.formatNumber, document, URL, URLSearchParams, Intl, Date, location,
    history: { replaceState(_state, _title, url) { location.href = String(url); } } };
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8')
    .replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  runInNewContext(`${source}\nthis.subject = {state,renderAccounts,changeAccountPage};`, context);
  const subject = context.subject;
  Object.assign(subject.state, { view: 'accounts', sort: 'followers.value', direction: 'desc',
    data: { period: 'custom', range: { startDate: '2026-09-25', endDate: '2026-09-30' },
      accounts: Array.from({ length: count }, (_, index) => ({ id: index + 1, label: `作者${index + 1}`,
        enabled: true, platform: 'douyin', boards: [], status: {}, collection: {},
        metrics: Object.fromEntries(Object.keys(model.METRICS).map(key => [key, { value: index + 1, delta: index + 1 }])) })) } });
  subject.renderAccounts();
  return { ...subject, node, document, location };
}

test('bottom navigation presents the new page from its top and retains the manager scope and sort', () => {
  const f = fixture();
  f.document.activeElement = f.node('pager').querySelector('[data-page="next"]');
  f.changeAccountPage('next');
  assert.equal(f.state.page, 2);
  assert.equal(f.node('accountsPagerTop').innerHTML, f.node('pager').innerHTML);
  assert.match(f.node('accountsPagerTop').innerHTML, /21–40 \/ 45 个账号/);
  assert.equal(f.document.activeElement.rootId, 'accountsPagerTop');
  assert.equal(f.document.activeElement.dataset.page, 'next');
  assert.equal(f.document.activeElement.focusOptions.preventScroll, true);
  assert.equal(f.node('accountsPagerTop').scrollCalls.at(-1).block, 'start');
  assert.match(f.node('accountsTable').innerHTML, /作者25/);
  assert.equal(f.state.sort, 'followers.value');
  assert.equal(f.state.direction, 'desc');
  assert.equal(f.state.theme, 'tuantuan');
  assert.equal(f.state.classification, 'slice');
  assert.equal(f.location.searchParams.get('page'), '2');
});

test('last and first page boundaries leave a usable keyboard navigation control', () => {
  const f = fixture();
  f.changeAccountPage('next'); f.changeAccountPage('next');
  assert.equal(f.state.page, 3);
  assert.equal(f.document.activeElement.dataset.page, 'prev');
  assert.equal(f.document.activeElement.disabled, false);
  assert.match(f.node('accountsPagerTop').innerHTML, /41–45 \/ 45 个账号/);
  f.changeAccountPage('prev'); f.changeAccountPage('prev');
  assert.equal(f.state.page, 1);
  assert.equal(f.document.activeElement.dataset.page, 'next');
  assert.equal(f.document.activeElement.disabled, false);
});

test('re-render preserves the top pager focus without scrolling saved data refreshes', () => {
  const f = fixture();
  f.document.activeElement = f.node('accountsPagerTop').querySelector('[data-page="next"]');
  const previous = f.document.activeElement;
  f.renderAccounts();
  assert.notEqual(f.document.activeElement, previous);
  assert.equal(f.document.activeElement.rootId, 'accountsPagerTop');
  assert.equal(f.document.activeElement.dataset.page, 'next');
  assert.equal(f.node('accountsPagerTop').scrollCalls.length, 0);
});

test('an empty filtered page cannot advance or force a reading-position change', () => {
  const f = fixture(0);
  f.changeAccountPage('next');
  assert.equal(f.state.page, 1);
  assert.match(f.node('accountsPagerTop').innerHTML, /0–0 \/ 0 个账号/);
  assert.match(f.node('accountsPagerTop').innerHTML, /data-page="prev" disabled/);
  assert.match(f.node('accountsPagerTop').innerHTML, /data-page="next" disabled/);
  assert.equal(f.node('accountsPagerTop').scrollCalls.length, 0);
});
