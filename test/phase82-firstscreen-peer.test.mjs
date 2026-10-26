// Independent first-screen cause checks. Fixtures are synthetic, not captured
// Douyin markup. Import and serialize the actual production owner/helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';
import { observeFirstPageActivation, sanitizeFirstPageActivationStructure, sanitizeFirstPageControlsStructure } from '../lib/browser-first-page-activation.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';

const SEC = 'MS4wLjABAAAAphase82FirstScreenPeerFixture';
const OTHER = 'MS4wLjABAAAAphase82OtherFirstScreenFixture';
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const endpoint = (sec = SEC, cursor = 0) => `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${sec}&max_cursor=${cursor}`;
const body = { status_code: 0, has_more: false, max_cursor: 0,
  aweme_list: [{ aweme_id: '7234567890123456789', author: { sec_uid: SEC, uid: '123456789012345' }, statistics: { digg_count: 7 } }] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const rect = { left: 100, top: 100, right: 800, bottom: 600, width: 700, height: 500 };
const baseStyle = { display: 'block', visibility: 'visible', opacity: '1', overflowY: 'visible' };

function dom({ region = false, gate = false, href = PROFILE, readyState = 'interactive', tab = false, controls } = {}) {
  const pane = { scrollTop: 0, scrollHeight: 1500, clientHeight: 500, parentElement: null,
    style: { ...baseStyle, overflowY: 'auto' }, getBoundingClientRect: () => rect };
  const item = { style: baseStyle, getBoundingClientRect: () => rect };
  const list = { scrollHeight: 1500, clientHeight: 1500, parentElement: pane,
    style: baseStyle, getBoundingClientRect: () => rect, contains: child => child === item };
  const tabNode = { role: 'tab', textContent: '作品', ariaSelected: 'false', style: baseStyle, getBoundingClientRect: () => rect };
  const document = { readyState, body: { childElementCount: 149 }, scrollingElement: null,
    querySelectorAll: selector => selector.includes('user-post-list') ? (region ? [list] : [])
      : selector.includes('role="dialog"') ? (gate ? [item] : [])
      : selector.includes('role="tab"') ? (controls ?? (tab ? [tabNode] : [])) : [],
    createTreeWalker: node => { let index = 0; return { nextNode: () => node.parts?.[index++] ?? null }; },
    elementFromPoint: () => item };
  return { pane, document, context: vm.createContext({ URL, location: new URL(href), document,
    window: { innerWidth: 1280, innerHeight: 720 }, getComputedStyle: node => node.style }) };
}
function observe(fixture, args = {}) {
  fixture.context.args = { secUid: SEC, ...args };
  return JSON.parse(JSON.stringify(vm.runInContext(`(${observeFirstPageActivation.toString()})(args)`, fixture.context)));
}

test('phase82 actual helper: interactive body does not establish a works region', () => {
  const result = observe(dom());
  assert.equal(result.eligible, false); assert.equal(result.structure.reason, 'region-absent');
  assert.equal(result.structure.regionCount, 0); assert.equal(result.structure.ancestorCount, null);
});

const control = ({ label = '作品', selected = null, hidden = false, parts = null } = {}) => ({
  style: { ...baseStyle, display: hidden ? 'none' : 'block' }, getBoundingClientRect: () => rect,
  parts: parts?.map(nodeValue => ({ nodeValue })),
  getAttribute: name => name === 'aria-label' ? (parts ? null : label) : name === 'aria-selected' ? selected : null,
});
test('phase82 passive candidate: opt-in separates absent controls from a semantic works control without granting action', () => {
  const absent = observe(dom(), { observeControls: true });
  const present = observe(dom({ controls: [control({ selected: 'false' })] }), { observeControls: true });
  assert.equal(absent.eligible, false); assert.equal(present.eligible, false);
  assert.equal(absent.structure.controls.worksControlCount, 0);
  assert.equal(present.structure.controls.worksControlCount, 1);
  assert.equal(present.structure.controls.unselectedWorksControlCount, 1);
  assert.equal(present.structure.reason, 'region-absent');
  assert.equal('controls' in observe(dom({ controls: [control()] })).structure, false);
});
test('phase82 passive candidate: selection partitions all matched controls while visibility remains separate', () => {
  const value = observe(dom({ controls: [control({ selected: 'true' }), control({ selected: 'false', hidden: true }),
    control({ selected: 'TRUE' }), control({ label: '喜欢', selected: 'true' })] }), { observeControls: true }).structure.controls;
  assert.equal(value.candidateCount, 4); assert.equal(value.worksControlCount, 3);
  assert.equal(value.visibleWorksControlCount, 2); assert.equal(value.selectedWorksControlCount, 1);
  assert.equal(value.unselectedWorksControlCount, 1); assert.equal(value.unknownSelectionWorksControlCount, 1);
});
test('phase82 passive candidate: bounded split short label supports ordinary count but private labels stay out', () => {
  const value = observe(dom({ controls: [control({ parts: ['作品', '（23）'] }), control({ label: '我的作品' }),
    control({ label: 'private-peer-sentinel' }), control({ label: 'x'.repeat(97) }), control({ parts: Array(25).fill('作') })] }), { observeControls: true }).structure.controls;
  assert.equal(value.worksControlCount, 1); assert.equal(value.labelUnavailableCount, 2);
  assert.doesNotMatch(JSON.stringify(value), /private-peer-sentinel|我的作品|23/);
});
test('phase82 passive candidate: exactly80 is observed,81 is sentinel with no invented zeros', () => {
  const eighty = observe(dom({ controls: Array.from({ length: 80 }, () => control()) }), { observeControls: true }).structure.controls;
  assert.equal(eighty.observation, 'observed'); assert.equal(eighty.candidateCount, 80); assert.equal(eighty.worksControlCount, 80);
  const eightyOne = observe(dom({ controls: Array.from({ length: 81 }, () => control()) }), { observeControls: true }).structure.controls;
  assert.equal(eightyOne.observation, 'over-limit'); assert.equal(eightyOne.candidateCount, 81);
  assert.equal(eightyOne.worksControlCount, null); assert.equal(eightyOne.selectedWorksControlCount, null);
});
test('phase82 passive candidate: scan exception is unavailable but preserves existing eligible wheel point', () => {
  const fixture = dom({ region: true }); const original = fixture.document.querySelectorAll;
  fixture.document.querySelectorAll = selector => { if (selector.includes('role="tab"')) throw Error('private-peer-sentinel'); return original(selector); };
  const result = observe(fixture, { observeControls: true });
  assert.equal(result.eligible, true); assert.equal(result.structure.controls.observation, 'unavailable');
  assert.equal(result.x, 450); assert.equal(result.y, 350); assert.doesNotMatch(JSON.stringify(result), /private-peer-sentinel/);
});
for (const [name, options] of [['gate', { gate: true }], ['wrong author', { href: `https://www.douyin.com/user/${OTHER}` }], ['loading', { readyState: 'loading' }]])
  test(`phase82 passive candidate: ${name} returns before any semantic read`, () => {
    const fixture = dom(options); const original = fixture.document.querySelectorAll;
    fixture.document.querySelectorAll = selector => { assert.equal(selector.includes('role="tab"'), false); return original(selector); };
    const result = observe(fixture, { observeControls: true }); assert.equal(result.eligible, false); assert.equal('controls' in result.structure, false);
  });
test('phase82 passive boundary: wrong attribution cannot be laundered into a valid controls receipt', () => {
  assert.equal(sanitizeFirstPageControlsStructure({ version: 1, attribution: 'other-observation', observation: 'observed', candidateCount: 1 }), null);
});
test('phase82 passive boundary: egress strips extras, rejects bad ranges and keeps observed zeros', () => {
  const raw = { version: 1, attribution: 'controls-structure-not-works-evidence', observation: 'observed', candidateCount: 80,
    labelUnavailableCount: 0, worksControlCount: 1, visibleWorksControlCount: 1, selectedWorksControlCount: 1,
    unselectedWorksControlCount: 0, unknownSelectionWorksControlCount: 0, textContent: 'private-peer-sentinel', href: PROFILE };
  const value = sanitizeFirstPageControlsStructure(raw);
  assert.equal(value.candidateCount, 80); assert.equal(value.unselectedWorksControlCount, 0);
  for (const [key, invalid] of [['labelUnavailableCount', -1], ['worksControlCount', 80.5], ['visibleWorksControlCount', Infinity],
    ['selectedWorksControlCount', 81], ['unknownSelectionWorksControlCount', '1'], ['candidateCount', 0],
    ['visibleWorksControlCount', 2], ['unselectedWorksControlCount', 1]]) assert.equal(sanitizeFirstPageControlsStructure({ ...raw, [key]: invalid }), null, key);
  assert.equal(sanitizeFirstPageControlsStructure({ ...raw, observation: 'over-limit', candidateCount: 80 }), null);
  assert.doesNotMatch(JSON.stringify(value), /private-peer-sentinel|MS4w|https:/);
  const first = sanitizeBrowserWorksDiagnostics({ version: 1, firstPageActivation: { state: 'no-container', attemptCount: 1,
    structure: { reason: 'region-absent', regionCount: 0, visibleRegionCount: 0, leafRegionCount: 0, ancestorCount: null, controls: raw } } });
  assert.deepEqual(first.firstPageActivation.structure.controls, value);
  assert.deepEqual(sanitizeBrowserWorksDiagnostics(first), first);
});
test('phase82 actual helper: semantic works tab is unobserved evidence, not a granted action', () => {
  const result = observe(dom({ tab: true }));
  assert.equal(result.eligible, false); assert.equal(result.structure.reason, 'region-absent');
  assert.equal('x' in result, false);
});
test('phase82 actual helper: qualified known list permits an ordinary wheel point', () => {
  const result = observe(dom({ region: true }));
  assert.equal(result.eligible, true); assert.equal(result.structure.reason, 'eligible');
  assert.equal(result.x, 450); assert.equal(result.y, 350);
});
for (const [name, options, expected] of [
  ['visible gate', { region: true, gate: true }, 'visible-gate'],
  ['wrong author', { region: true, href: `https://www.douyin.com/user/${OTHER}` }, 'not-eligible'],
  ['wrong origin', { region: true, href: `https://example.test/user/${SEC}` }, 'not-eligible'],
  ['not ready', { region: true, readyState: 'loading' }, 'not-eligible'],
]) test(`phase82 actual helper: ${name} cannot grant first-screen action`, () => {
  const result = observe(dom(options)); assert.equal(result.eligible, false); assert.equal(result.structure.reason, expected);
});

class FirstPage extends EventEmitter {
  constructor({ region = false, natural = false, wrongFrame = false, wrongAuthor = false, status = 200 } = {}) {
    super(); this.fixture = dom({ region }); this.address = 'about:blank';
    this.options = { natural, wrongFrame, wrongAuthor, status }; this.actions = []; this.reads = 0; this.probes = 0;
    this.frame = { url: () => this.address }; this.timers = new Set();
    this.mouse = { move: async (...point) => this.actions.push({ action: 'move', point }),
      wheel: async (...delta) => { this.actions.push({ action: 'wheel', delta }); this.deliver(); },
      click: async () => { this.actions.push({ action: 'click' }); } };
  }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  later(fn, ms) { const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms); this.timers.add(timer); }
  close() { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
  deliver() {
    const request = { url: () => endpoint(this.options.wrongAuthor ? OTHER : SEC), isNavigationRequest: () => false,
      method: () => 'GET', frame: () => this.options.wrongFrame ? {} : this.frame };
    this.emit('request', request); this.emit('response', { request: () => request, url: request.url,
      status: () => this.options.status, json: async () => { this.reads++; return body; } });
  }
  async goto() {
    const request = { url: () => PROFILE, isNavigationRequest: () => true, method: () => 'GET', frame: () => this.frame };
    this.emit('request', request); this.address = PROFILE;
    this.emit('response', { request: () => request, url: request.url, status: () => 200 }); this.emit('framenavigated', this.frame);
    if (this.options.natural) this.later(() => this.deliver(), 40);
  }
  async evaluate(fn, args) {
    if (fn.name === 'observeBrowserFirstScreen') return { observation: 'observed', readyState: 'interactive', bodyPresent: true, bodyChildCount: 149, worksAnchorCount: 0 };
    if (fn.name === 'observeFirstPageActivation') { this.probes++; this.fixture.context.args = args;
      return vm.runInContext(`(${fn.toString()})(args)`, this.fixture.context); }
    return { observation: 'unavailable' };
  }
}
const collect = (page, options = {}) => collectOne(page, { key: 'phase82-isolated', secUid: SEC, limit: 30 },
  { timeoutMs: 1400, bodyTimeoutMs: 300, pageWaitMs: 300, failureGraceMs: 1, ...options });
const noListeners = page => { for (const name of ['request', 'response', 'framenavigated', 'domcontentloaded', 'load', 'requestfailed']) assert.equal(page.listenerCount(name), 0); };

test('phase82 actual boundary: old activation source remains byte-stable and extras cannot escape', () => {
  const legacy = { reason: 'region-absent', regionCount: 0, visibleRegionCount: 0, leafRegionCount: 0, ancestorCount: null };
  const expected = JSON.stringify(legacy);
  assert.equal(JSON.stringify(sanitizeFirstPageActivationStructure(legacy)), expected);
  const contaminated = { ...legacy, textContent: 'private-peer-sentinel', href: 'https://private.invalid', cookie: 'private-peer-sentinel' };
  const first = sanitizeBrowserWorksDiagnostics({ version: 1,
    firstPageActivation: { state: 'no-container', attemptCount: 1, probeCount: 4, actionCount: 0, structure: contaminated } });
  assert.equal(JSON.stringify(first.firstPageActivation.structure), expected);
  assert.doesNotMatch(JSON.stringify(first), /private-peer-sentinel|private\.invalid/);
  assert.equal(JSON.stringify(sanitizeBrowserWorksDiagnostics(first)), JSON.stringify(first));
});

test('phase82 actual owner: ready no-region document reproduces no-bound-request without a guessed action', async () => {
  const page = new FirstPage();
  try { const result = await collect(page); assert.deepEqual(result.posts, []);
    assert.equal(result.failureDiagnostics.firstPageActivation.structure.reason, 'region-absent');
    assert.equal(result.failureDiagnostics.stopReason, 'no-bound-request');
    assert.equal(page.probes, 1); assert.deepEqual(page.actions, []); assert.equal(page.reads, 0); noListeners(page);
  } finally { page.close(); }
});
test('phase82 actual owner: natural request succeeds even when first-screen region and anchors are absent', async () => {
  const page = new FirstPage({ natural: true });
  try { const result = await collect(page); assert.equal(result.posts.length, 1); assert.equal(page.reads, 1);
    assert.equal(result.posts[0].statistics.digg_count, 7); assert.deepEqual(page.actions, []); noListeners(page);
  } finally { page.close(); }
});
test('phase82 actual owner: eligible first list activates once then the bound response owns success', async () => {
  const page = new FirstPage({ region: true });
  try { const result = await collect(page); assert.equal(result.posts.length, 1); assert.equal(page.reads, 1);
    assert.deepEqual(page.actions.map(row => row.action), ['move', 'wheel']);
    assert.equal(result.failureDiagnostics.firstPageActivation.structure.controls.observation, 'observed'); noListeners(page);
  } finally { page.close(); }
});
for (const [name, options] of [['wrong frame', { wrongFrame: true }], ['wrong request author', { wrongAuthor: true }], ['HTTP403', { status: 403 }]])
  test(`phase82 actual owner: natural ${name} cannot exploit a ready no-region document`, async () => {
    const page = new FirstPage({ natural: true, ...options });
    try { const result = await collect(page, { timeoutMs: 120 }); assert.deepEqual(result.posts, []);
      assert.equal(page.reads, 0); assert.deepEqual(page.actions, []); noListeners(page);
      if (options.status === 403) assert.equal(result.errorCode, 'blocked');
    } finally { page.close(); }
  });

// Optional real Chrome uses fresh contexts and locally fulfills every request;
// it never imports cookies/storage or contacts a live source/platform.
if (process.env.PHASE82_LOCAL_CHROME === '1') test('phase82 actual headless Chrome: absent, tab-only, delayed-list, natural and refusal', async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    for (const scenario of ['absent', 'tab-only', 'delayed-list', 'natural', '403']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
      const trace = { scenario, platformRequests: 0, locallyFulfilled: 0, blockedOthers: 0 };
      try {
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin === 'https://www.douyin.com' && url.pathname === `/user/${SEC}`) {
            trace.locallyFulfilled++;
            return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}#pane{position:absolute;left:100px;top:100px;width:700px;height:500px;overflow-y:auto}#region{height:1500px;background:#eee}</style></head><body><h1>Isolated synthetic profile</h1>${scenario === 'tab-only' ? '<button role="tab" aria-selected="false">作品</button>' : ''}<script>
            window.wheels=0;window.clicks=0;window.positions=[];let delivered=false;
            document.addEventListener('click',()=>window.clicks++);window.addEventListener('wheel',()=>window.wheels++);
            const send=()=>{if(!delivered){delivered=true;fetch(${JSON.stringify(endpoint())});}};
            ${scenario === 'delayed-list' ? "setTimeout(()=>{const p=document.createElement('div');p.id='pane';p.innerHTML='<div id=\"region\" data-e2e=\"user-post-list\"></div>';document.body.append(p);p.addEventListener('scroll',()=>{window.positions.push(p.scrollTop);send();});},1250);" : ''}
            ${['natural', '403'].includes(scenario) ? 'setTimeout(send,150);' : ''}
            </script></body></html>` });
          }
          if (url.origin === 'https://www.douyin.com' && url.pathname === '/aweme/v1/web/aweme/post/') {
            trace.locallyFulfilled++; return route.fulfill({ status: scenario === '403' ? 403 : 200, contentType: 'application/json', body: JSON.stringify(body) });
          }
          trace.blockedOthers++; return route.abort('blockedbyclient');
        });
        const page = await context.newPage();
        const result = await collectOne(page, { key: 'phase82-isolated-real-chrome', secUid: SEC, limit: 30 },
          { timeoutMs: scenario === 'delayed-list' ? 3600 : 1800, bodyTimeoutMs: 500, pageWaitMs: 600, failureGraceMs: 1 });
        const observed = await page.evaluate(() => ({ readyState: document.readyState, bodyPresent: Boolean(document.body),
          wheels: window.wheels, clicks: window.clicks, positions: window.positions,
          regionCount: document.querySelectorAll('[data-e2e="user-post-list"],[data-e2e="user-post-item-list"]').length,
          semanticTabCount: document.querySelectorAll('[role="tab"]').length }));
        console.log(JSON.stringify({ ...trace, observed, posts: result.posts.length, errorCode: result.errorCode ?? null,
          activation: result.failureDiagnostics?.firstPageActivation ?? null, stopReason: result.failureDiagnostics?.stopReason ?? result.pagination?.stopReason }));
        assert.equal(observed.clicks, 0); assert.equal(trace.platformRequests, 0);
        if (['natural', 'delayed-list'].includes(scenario)) {
          assert.equal(result.posts.length, 1); assert.equal(result.posts[0].statistics.digg_count, 7);
          assert.equal(observed.wheels, scenario === 'delayed-list' ? 1 : 0);
          if (scenario === 'delayed-list') assert.ok(observed.positions.some(value => value > 0));
        } else {
          assert.equal(result.posts.length, 0); assert.equal(observed.wheels, 0);
          if (scenario === '403') assert.equal(result.errorCode, 'blocked');
          else { assert.equal(result.failureDiagnostics.firstPageActivation.structure.reason, 'region-absent');
            assert.equal(observed.regionCount, 0); assert.equal(observed.semanticTabCount, scenario === 'tab-only' ? 1 : 0);
            const controls = result.failureDiagnostics.firstPageActivation.structure.controls;
            assert.equal(controls.observation, 'observed'); assert.equal(controls.worksControlCount, scenario === 'tab-only' ? 1 : 0);
            assert.equal(controls.unselectedWorksControlCount, scenario === 'tab-only' ? 1 : 0);
            assert.doesNotMatch(JSON.stringify(controls), /作品|https:/); }
        }
        const before = observed.wheels; await pause(30); assert.equal(await page.evaluate(() => window.wheels), before);
      } finally { await context.close(); }
    }
    const semanticCases = [
      { name: 'selected', markup: '<button role="tab" aria-selected="true">作品<span>（23）</span></button>', check: value => { assert.equal(value.selectedWorksControlCount, 1); assert.equal(value.visibleWorksControlCount, 1); } },
      { name: 'hidden', markup: '<button role="tab" style="display:none" aria-selected="false">作品</button>', check: value => { assert.equal(value.unselectedWorksControlCount, 1); assert.equal(value.visibleWorksControlCount, 0); } },
      { name: 'unknown-selection', markup: '<button role="tab">作品</button>', check: value => assert.equal(value.unknownSelectionWorksControlCount, 1) },
      { name: 'label-not-works', markup: '<button aria-label="private-peer-sentinel">作品</button>', check: value => assert.equal(value.worksControlCount, 0) },
      { name: 'oversize-label', markup: `<button aria-label="${'x'.repeat(97)}">作品</button>`, check: value => assert.equal(value.labelUnavailableCount, 1) },
      { name: '81-controls', markup: '<button>作品</button>'.repeat(81), check: value => { assert.equal(value.observation, 'over-limit'); assert.equal(value.candidateCount, 81); assert.equal(value.worksControlCount, null); } },
      { name: 'visible-gate', markup: '<div role="dialog">Local gate</div><button>作品</button>', check: value => assert.equal(value, undefined) },
    ];
    for (const scenario of semanticCases) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      try {
        await context.route('**/*', route => route.request().url() === PROFILE
          ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"></head><body>${scenario.markup}</body></html>` })
          : route.abort('blockedbyclient'));
        const page = await context.newPage(); await page.goto(PROFILE, { waitUntil: 'domcontentloaded' });
        assert.equal(await page.evaluate(() => document.characterSet), 'UTF-8');
        const result = await page.evaluate(observeFirstPageActivation, { secUid: SEC, observeControls: true });
        scenario.check(result.structure.controls); assert.equal(result.eligible, false);
        assert.doesNotMatch(JSON.stringify(result.structure), /private-peer-sentinel|作品|https:/);
        console.log(JSON.stringify({ phase82PassiveChrome: true, scenario: scenario.name, controls: result.structure.controls ?? null, eligible: result.eligible }));
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
});
