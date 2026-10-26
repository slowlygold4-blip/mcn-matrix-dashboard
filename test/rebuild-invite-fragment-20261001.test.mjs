import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

// A format-only placeholder, never issued as an invite or sent to a service.
const SYNTHETIC_CODE = Array(8).fill('0000').join('-');

function fixture(hash = `#invite=${SYNTHETIC_CODE}`) {
  const nodes = new Map(), requests = [], historyCalls = [], bootHashes = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', hidden: false, open: false, disabled: false, textContent: '',
      addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} },
      showModal() { this.open = true; }, close() { this.open = false; },
      querySelector: () => node('authSubmit') });
    return nodes.get(id);
  };
  node('authForm').elements = { displayName: node('displayName'), code: node('code') };
  const location = new URL(`https://public-audit.example/?theme=tuantuan&classification=slice&period=week${hash}`);
  const historyState = { keep: 'existing-page-history' };
  const context = { ...model, fmt: model.formatNumber, URL, URLSearchParams, Intl, Date, location,
    AbortController, setTimeout, clearTimeout,
    document: { getElementById: node, querySelector: node, querySelectorAll: () => [], addEventListener() {} },
    window: { addEventListener() {} },
    history: { state: historyState, replaceState(state, title, url) {
      historyCalls.push({ state, title, url: String(url) }); location.href = String(url);
    } },
    FormData: class { constructor(form) { this.form = form; } get(key) { return this.form.elements[key].value; } },
    fetch: async (path, options = {}) => {
      requests.push({ path, method: options.method || 'GET', body: options.body });
      if (path === '/api/auth/join' && context.joinFailure) return { ok: false, status: 401, json: async () => ({ error: '合成拒绝结果' }) };
      return { ok: true, status: 200, json: async () => path === '/api/auth/session'
        ? { authenticated: false } : { authenticated: true, user: { role: 'viewer', displayName: '合成验收' } } };
    }, bootHashes,
  };
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8')
    .replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  runInNewContext(`${source}\nthis.subject = {init,bind,readInviteCodeFromFragment,initializeInviteFromFragment,clearInviteFragment,initial,state};
    enhanceShell = () => {}; setupDates = () => {}; boot = async () => bootHashes.push(initial.hash);`, context);
  return { ...context.subject, node, requests, location, historyCalls, historyState, bootHashes,
    failJoin() { context.joinFailure = true; } };
}

test('real initialization prefills an official fragment but only requests the anonymous session gate', async () => {
  const f = fixture();
  await f.init();
  assert.equal(f.node('code').value, SYNTHETIC_CODE);
  assert.equal(f.node('authDialog').open, true);
  assert.deepEqual(f.requests.map(request => [request.path, request.method]), [['/api/auth/session', 'GET']]);
  assert.equal(f.historyCalls.length, 0);
  assert.ok(f.requests.every(request => !request.path.includes(SYNTHETIC_CODE) && !request.body));
});

test('format parsing accepts encoded official groups and rejects malformed, duplicated and unbounded values', () => {
  const f = fixture();
  const encoded = SYNTHETIC_CODE.replaceAll('-', '%2D');
  assert.equal(f.readInviteCodeFromFragment(`#accounts&invite=${encoded}`), SYNTHETIC_CODE);
  assert.equal(f.readInviteCodeFromFragment(`#invite=${Array(8).fill('abcd').join('-')}`), Array(8).fill('ABCD').join('-'));
  for (const hash of [
    '#invite=', '#invite=%', '#invite=%00', '#invite=0000-0000-0000-0000',
    `#invite=${SYNTHETIC_CODE.replaceAll('-', '')}`, `#invite=${SYNTHETIC_CODE}&invite=${SYNTHETIC_CODE}`,
    `#invite=${SYNTHETIC_CODE}%0A`, `#other=${SYNTHETIC_CODE}`, `#invite=${'0'.repeat(118)}`, `#invite=${'0'.repeat(513)}`,
    `#${'a'.repeat(513)}&invite=${SYNTHETIC_CODE}`,
  ]) assert.equal(f.readInviteCodeFromFragment(hash), null, 'reject a malformed synthetic fragment');
});

test('a deliberate successful submit removes only the invitation part and retains query scope and page', async () => {
  const f = fixture(`#accounts&invite=${SYNTHETIC_CODE}`);
  await f.init(); f.node('displayName').value = '合成验收';
  await f.node('authForm').onsubmit({ preventDefault() {}, currentTarget: f.node('authForm') });
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(f.requests.at(-1).path, '/api/auth/join');
  assert.equal(JSON.parse(f.requests.at(-1).body).code, SYNTHETIC_CODE);
  assert.equal(f.location.hash, '#accounts');
  assert.equal(f.initial.hash, '#accounts');
  assert.equal(f.location.search, '?theme=tuantuan&classification=slice&period=week');
  assert.equal(f.historyCalls.length, 1);
  assert.equal(f.historyCalls[0].state, f.historyState);
  assert.equal(f.node('authDialog').open, false);
  assert.deepEqual(f.bootHashes, ['#accounts']);
});

test('a rejected explicit submit keeps the invitation and draft for correction without booting', async () => {
  const f = fixture(); await f.init(); f.failJoin(); f.node('displayName').value = '合成验收';
  await f.node('authForm').onsubmit({ preventDefault() {}, currentTarget: f.node('authForm') });
  assert.equal(f.node('authDialog').open, true);
  assert.equal(f.node('code').value, SYNTHETIC_CODE);
  assert.equal(f.location.hash, `#invite=${SYNTHETIC_CODE}`);
  assert.equal(f.historyCalls.length, 0);
  assert.equal(f.bootHashes.length, 0);
  assert.equal(f.node('authSubmit').disabled, false);
});

test('cleanup preserves unrelated raw fragment parts and similarly named keys', () => {
  const f = fixture(`#topics&invite=${SYNTHETIC_CODE}&note=a%20b&inviteNote=keep`);
  f.clearInviteFragment();
  assert.equal(f.location.hash, '#topics&note=a%20b&inviteNote=keep');
  assert.equal(f.location.search, '?theme=tuantuan&classification=slice&period=week');
  f.clearInviteFragment();
  assert.equal(f.historyCalls.length, 1);
});

test('manual access without an invite fragment never rewrites page history', async () => {
  const f = fixture('#topics'); await f.init();
  assert.equal(f.node('code').value, '');
  f.node('displayName').value = '合成验收'; f.node('code').value = SYNTHETIC_CODE;
  await f.node('authForm').onsubmit({ preventDefault() {}, currentTarget: f.node('authForm') });
  assert.equal(f.historyCalls.length, 0);
  assert.equal(f.location.hash, '#topics');
  assert.deepEqual(f.bootHashes, ['#topics']);
});
