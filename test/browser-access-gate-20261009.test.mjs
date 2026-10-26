import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { observeFirstPageActivation, sanitizeFirstPageActivationStructure } from '../lib/browser-first-page-activation.mjs';
import { requestBrowserFirstPage } from '../lib/browser-first-works-request.mjs';
import { observeBrowserAccessGate, withBrowserAccessGate, sanitizeBrowserAccessGateObservation } from '../lib/browser-access-gate.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';

const SEC = 'MS4wLjABAAAAAccessGateOfflineFixture', PROFILE = `https://www.douyin.com/user/${SEC}`;
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const style = { display: 'block', visibility: 'visible', opacity: '1', overflowY: 'visible' };
function node({ tag = 'BUTTON', label = '登录', modal = false, captcha = false, form = false, header = true,
  ancestorGate = false, descendantGate = false, box = rect(1120, 20, 80, 32), hidden = false } = {}) {
  const navigation = { getBoundingClientRect: () => rect(0, 0, 1280, 100), style };
  const n = { tagName: tag, style: { ...style, ...(hidden ? { display: 'none' } : {}) },
    getBoundingClientRect: () => box, getAttribute: key => key === 'aria-label' ? label : null,
    contains: other => other === n,
    matches: selector => selector.split(',').some(raw => {
      const s = raw.trim();
      if (s === tag.toLowerCase()) return true;
      if (s === '[role="dialog"]' || s === '[aria-modal="true"]') return modal;
      if (s.includes('captcha')) return captcha;
      if (s.startsWith('input[') || s.startsWith('form[')) return form;
      if (s === '[role="img"]') return tag === 'SVG' || tag === 'IMG';
      return false;
    }),
    closest: selector => selector.includes('role="dialog"') ? (ancestorGate ? navigation : null) : header ? navigation : null,
    querySelectorAll: () => descendantGate ? [{}] : [],
  };
  return n;
}
function fixture(options = {}) {
  const region = { scrollTop: 0, scrollHeight: 1500, clientHeight: 520, parentElement: null,
    contains: n => n === region, getBoundingClientRect: () => rect(100, 220, 1000, 520), style: { ...style, overflowY: 'auto' } };
  const gates = options.noGate ? [] : options.many ? Array(101).fill(node()) : [node(options)];
  const document = { readyState: 'complete', scrollingElement: null,
    querySelectorAll: selector => selector.includes('user-post-list') ? (options.noRegion ? [] : [region]) : gates,
    elementFromPoint: () => options.occluded ? {} : region, createTreeWalker: () => ({ nextNode: () => null }) };
  for (const key of ['cookie', 'innerText', 'textContent', 'body']) Object.defineProperty(document, key, { get() { assert.fail(`broad read: ${key}`); } });
  const requests = [];
  const context = vm.createContext({ URL, URLSearchParams, Date, AbortController, document, location: new URL(PROFILE),
    window: { innerWidth: 1280, innerHeight: 800, fetch: (...args) => { requests.push(args); return Promise.resolve({}); } },
    getComputedStyle: n => n.style, setTimeout: () => 1, clearTimeout: () => {} });
  return { context, requests, gates, region, evaluate(fn, args = {}) { context.args = { secUid: SEC, ...args };
    return JSON.parse(JSON.stringify(vm.runInContext(`(${fn.toString()})(args)`, context))); } };
}

for (const [name, options, expected, decision] of [
  ['no candidate', { noGate: true }, true, 'clear'],
  ['top navigation login button', {}, true, 'clear'],
  ['top verified image decoration', { tag: 'SVG', label: '已认证', box: rect(1120,20,24,24) }, true, 'clear'],
  ['modal dialog', { modal: true }, false, 'modal'],
  ['captcha even with a friendly navigation label', { captcha: true }, false, 'challenge'],
  ['credential form', { form: true }, false, 'credential-form'],
  ['control inside modal ancestor', { ancestorGate: true }, false, 'gate-ancestor'],
  ['control containing credentials or challenge', { descendantGate: true }, false, 'gate-descendant'],
  ['ordinary login-looking element with no navigation semantics', { header: false }, false, 'unknown'],
  ['navigation button with unrelated label', { label: 'PRIVATE_SENTINEL' }, false, 'unknown'],
  ['login control overlapping works', { box: rect(400,300,80,32) }, false, 'unknown'],
  ['oversize login panel in header', { box: rect(0,0,400,64) }, false, 'unknown'],
  ['missing works region', { noRegion: true }, false, 'unknown'],
  ['occluded works region', { occluded: true }, false, 'unknown'],
  ['candidate cap', { many: true }, false, 'limit'],
  ['hidden gate', { modal: true, hidden: true }, true, 'clear'],
]) {
  test(`gate matrix: ${name}`, () => {
    const f = fixture(options), gate = f.evaluate(observeBrowserAccessGate), projected = f.evaluate(observeFirstPageActivation);
    assert.equal(gate.blocked, !expected); assert.equal(gate.observation.decision, decision);
    assert.equal(projected.eligible, expected);
    const requested = f.evaluate(requestBrowserFirstPage, { expiresAt: Date.now() + 5000 });
    assert.equal(requested.state, expected ? 'issued' : 'blocked');
    assert.equal(f.requests.length, expected ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(projected.structure), /PRIVATE_SENTINEL|登录|认证|1120|MS4wLj/);
  });
}

test('a class-only unknown candidate with no DOM semantic methods stays blocked', () => {
  const f = fixture(); delete f.gates[0].closest;
  assert.equal(f.evaluate(observeBrowserAccessGate).observation.decision, 'unknown');
  assert.equal(f.evaluate(observeFirstPageActivation).eligible, false);
  assert.equal(f.evaluate(requestBrowserFirstPage, { expiresAt: Date.now() + 5000 }).state, 'blocked');
});

test('an exempt navigation control cannot hide a later real gate in the same document', () => {
  const f = fixture(); f.gates.push(node({ captcha: true }));
  const gate = f.evaluate(observeBrowserAccessGate);
  assert.equal(gate.blocked, true); assert.equal(gate.observation.decision, 'challenge');
  assert.equal(gate.observation.excludedNavigationCount, 1);
  assert.equal(f.evaluate(requestBrowserFirstPage, { expiresAt: Date.now() + 5000 }).state, 'blocked');
  assert.equal(f.requests.length, 0);
});

test('a missing DOM operation fails closed and its uncertainty remains observable', () => {
  const f = fixture(); f.context.document.querySelectorAll = () => { throw new Error('PRIVATE_SENTINEL'); };
  const projected = f.evaluate(observeFirstPageActivation);
  assert.equal(projected.eligible, false); assert.equal(projected.structure.gates.decision, 'unknown');
  assert.equal(projected.structure.gates.candidateCount, 0);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_SENTINEL/);
});

test('both exported functions contain the same fixed local gate code and no closure dependency', () => {
  const helper = Function.prototype.toString.call(observeBrowserAccessGate);
  for (const fn of [observeFirstPageActivation, requestBrowserFirstPage]) {
    assert.ok(fn.toString().includes(helper)); assert.equal(fn.toString().includes('MCN_FIXED_ACCESS_GATE'), false);
    assert.equal(vm.runInNewContext(`(${fn.toString()}).name`), fn.name);
  }
  assert.throws(() => withBrowserAccessGate(function arbitrary() {}), /Unknown/);
  assert.throws(() => withBrowserAccessGate(function observeFirstPageActivation() {}), /marker/);
});

test('new optional gate diagnostics whitelist safe enums and counts without rewriting legacy shape', () => {
  const old = { reason: 'eligible', regionCount: 1, visibleRegionCount: 1, leafRegionCount: 1, ancestorCount: 1 };
  assert.deepEqual(sanitizeFirstPageActivationStructure(old), old);
  const valid = fixture().evaluate(observeFirstPageActivation).structure;
  valid.gates.cookie = 'PRIVATE_SENTINEL'; valid.gates.x = 1120; valid.gates.label = '登录';
  const projected = sanitizeFirstPageActivationStructure(valid);
  assert.equal(projected.gates.excludedNavigationCount, 1);
  assert.deepEqual(sanitizeFirstPageActivationStructure(projected), projected);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_SENTINEL|cookie|1120|登录/);
  const outer = sanitizeBrowserWorksDiagnostics({ version: 1, continuationActivation: { version: 1, probeCount: 1, renderRecheckCount: 0,
    actionCount: 0, lastBranch: 'blocked', structure: projected } });
  assert.deepEqual(outer.continuationActivation.structure.gates, projected.gates);
  for (const change of [{ decision: 'PRIVATE' }, { candidateCount: 102 }, { visibleCount: 2 }, { excludedNavigationCount: 2 }])
    assert.equal(sanitizeBrowserAccessGateObservation({ ...projected.gates, ...change }), null);
});

const ownerURL = new URL('../scripts/douyin_browser_collector.mjs', import.meta.url).href;
const ownerFixture = (await readFile(new URL('./phase87-collector-peer.test.mjs', import.meta.url), 'utf8')).split('\ntest(')[0]
  .replace("process.env.PHASE87_OWNER_URL || '../scripts/douyin_browser_collector.mjs'", JSON.stringify(ownerURL))
  .replace('args, URL, URLSearchParams, Date, AbortController,', 'args, URL, URLSearchParams, Date, AbortController, WeakMap,');
const { run } = await import(`data:text/javascript;base64,${Buffer.from(ownerFixture + '\nexport {run};').toString('base64')}`);

for (const [name, gateOptions, allowed] of [['normal navigation', {}, true], ['real modal', { modal: true }, false], ['unknown control', { header: false }, false]]) {
  test(`actual collector continuation: ${name} ${allowed ? 'can complete next page' : 'never issues an action'}`, async t => {
    let wired = false;
    const { result, page } = await run(t, { regionMode: 'visible', beforeEvaluate: (p, fn) => {
      if (fn.name !== 'observeFirstPageActivation' || p.reads !== 1 || wired) return;
      wired = true;
      const login = node({ ...gateOptions, box: rect(1120,20,80,32) }), previous = p.document.querySelectorAll;
      p.document.querySelectorAll = selector => selector.includes('role="dialog"') ? [login] : previous(selector);
      p.mouse.wheel = async () => { p.wheels++; p.deliver(10); };
    } }, { events: { 1000: p => p.deliver(0) } });
    assert.equal(wired, true); assert.equal(page.gets.length, 0);
    assert.equal(page.wheels, allowed ? 1 : 0); assert.equal(result.posts.length, allowed ? 2 : 1);
    assert.equal(result.pagination.stopReason, allowed ? 'end-of-list' : 'page-timeout');
    assert.equal(result.failureDiagnostics.continuationActivation.structure.gates.decision, allowed ? 'clear' : gateOptions.modal ? 'modal' : 'unknown');
  });
}
