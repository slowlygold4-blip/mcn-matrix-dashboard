import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';

const SEC = 'MS4wLjABAAAAIndependentFirstPage1234567';
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const WORKS = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const validBody = () => ({ status_code: 0, max_cursor: 0, has_more: false,
  aweme_list: [{ aweme_id: '7300000000000000001', author: { sec_uid: SEC, uid: '1234567890' }, statistics: { digg_count: 1 } }] });

class IndependentPage extends EventEmitter {
  constructor({ status = 200, scenario = () => {}, onMove, onWheel, evaluate } = {}) {
    super(); this.status = status; this.scenario = scenario; this.address = 'about:blank';
    this.frame = { url: () => this.address }; this.moves = 0; this.wheels = 0; this.reads = 0;
    this.evaluateImpl = evaluate;
    this.mouse = { move: async () => { this.moves++; await onMove?.(this); },
      wheel: async () => { this.wheels++; await onWheel?.(this); } };
  }
  mainFrame() { return this.frame; }
  url() { return this.address; }
  viewportSize() { return { width: 1280, height: 720 }; }
  request(url = WORKS, navigation = false, frame = this.frame) {
    return { url: () => url, method: () => 'GET', frame: () => frame, isNavigationRequest: () => navigation };
  }
  navigate(url = PROFILE, status = this.status) {
    const request = this.request(url, true); this.emit('request', request); this.address = url;
    this.emit('framenavigated', this.frame);
    if (status !== null) this.documentResponse(request, status);
    return request;
  }
  documentResponse(request, status = 200) {
    this.emit('response', { request: () => request, url: request.url, status: () => status });
  }
  beginWorks() { const request = this.request(); this.emit('request', request); return request; }
  respond(body = validBody(), status = 200, request = this.beginWorks()) {
    this.emit('response', { request: () => request, url: request.url, status: () => status,
      json: async () => { this.reads++; return typeof body === 'function' ? body() : body; } });
  }
  async evaluate(fn, arg) { return this.evaluateImpl?.(fn, arg, this); }
  async goto() { this.initialDocument = this.navigate(); await this.scenario(this); this.emit('domcontentloaded'); }
}

const collect = (page, options = {}) => collectOne(page, { key: 'independent-first-page', secUid: SEC, limit: 30 },
  { timeoutMs: 90, bodyTimeoutMs: 70, failureGraceMs: 1, ...options });
function untouched(page) { assert.equal(page.moves, 0); assert.equal(page.wheels, 0); }
function cleaned(page) { for (const name of ['request', 'response', 'framenavigated', 'domcontentloaded', 'pageerror', 'requestfailed']) assert.equal(page.listenerCount(name), 0); }

function syntheticDOM(page, { overlay = false, dialog = false, noContainer = false, ambiguous = false,
  readyState = 'complete', wrongProfile = false, hidden = false } = {}) {
  const rect = { left: 100, top: 150, right: 900, bottom: 650, width: 800, height: 500, x: 100, y: 150 };
  const node = { isConnected: true, scrollTop: 0, scrollHeight: 1600, clientHeight: 500, scrollWidth: 800, clientWidth: 800,
    getClientRects: () => hidden ? [] : [rect], getBoundingClientRect: () => hidden ? { ...rect, width: 0, height: 0 } : rect,
    getAttribute: () => null, contains(other) { return other === this; } };
  const blocker = { getClientRects: () => [rect], getBoundingClientRect: () => rect, getAttribute: () => null };
  const body = { childElementCount: 2, scrollTop: 0, scrollHeight: 1600, clientHeight: 720,
    getClientRects: () => [rect], getBoundingClientRect: () => rect, contains: () => true };
  node.parentElement = body; body.parentElement = null;
  const document = { readyState, body, documentElement: { clientWidth: 1280, clientHeight: 720 }, scrollingElement: body,
    querySelectorAll(selector) {
      if (selector.includes('user-post-list')) return noContainer ? [] : ambiguous ? [node, { ...node }] : [node];
      if (dialog && (selector.includes('dialog') || selector.includes('aria-modal'))) return [blocker];
      return [];
    }, querySelector: () => null, elementFromPoint: () => overlay ? blocker : node };
  for (const key of ['cookie', 'innerHTML', 'innerText']) Object.defineProperty(document, key, { get() { throw Error('private data must not be read'); } });
  const context = { URL, document, location: new URL(wrongProfile ? PROFILE + '/foreign' : page.url()),
    innerWidth: 1280, innerHeight: 720, getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1', overflowY: 'auto', overflow: 'auto' }) };
  context.window = context; context.top = context; context.self = context;
  return context;
}
const domEvaluation = options => (fn, arg, page) => runInNewContext(`(${fn.toString()})(arg)`, { ...syntheticDOM(page, options), arg });
const activationOptions = { timeoutMs: 1250 };

test('first-page independent: one legitimate current visible works region can trigger one ordinary first request', async () => {
  const page = new IndependentPage({ evaluate: domEvaluation(), onWheel: p => p.respond() });
  const result = await collect(page, activationOptions);
  assert.equal(page.moves, 1); assert.equal(page.wheels, 1);
  assert.equal(result.status, 'ok'); assert.equal(result.worksCoverage, 'complete');
  assert.equal(result.posts.length, 1); cleaned(page);
});

test('first-page independent: actual DOM predicate forbids overlays, any dialog, missing and ambiguous regions', async t => {
  for (const options of [{ overlay: true }, { dialog: true }, { noContainer: true }, { ambiguous: true }, { hidden: true }, { wrongProfile: true }]) {
    await t.test(JSON.stringify(options), async () => {
      const page = new IndependentPage({ evaluate: domEvaluation(options) });
      const result = await collect(page, activationOptions);
      assert.equal(result.status, 'unavailable'); untouched(page); cleaned(page);
    });
  }
});

test('first-page independent: document status missing or stale previous-generation 200 never authorizes action', async t => {
  for (const status of [null, 302, 500]) await t.test(String(status), async () => {
    const page = new IndependentPage({ status, evaluate: domEvaluation() });
    await collect(page, activationOptions); untouched(page); cleaned(page);
  });
  await t.test('old late 200', async () => {
    const page = new IndependentPage({ evaluate: domEvaluation(), scenario: p => {
      const prior = p.initialDocument ?? p.request(PROFILE, true);
      p.navigate(PROFILE, null); p.documentResponse(prior, 200);
    } });
    await collect(page, activationOptions); untouched(page); cleaned(page);
  });
});

test('first-page independent: a bound first request waiting for response or body prevents activation', async t => {
  await t.test('request outstanding', async () => {
    const page = new IndependentPage({ evaluate: domEvaluation(), scenario: p => p.beginWorks() });
    await collect(page, activationOptions); untouched(page); cleaned(page);
  });
  await t.test('body outstanding', async () => {
    let finish;
    const page = new IndependentPage({ evaluate: domEvaluation(), scenario: p => p.respond(() => new Promise(resolve => { finish = resolve; })) });
    const result = await collect(page, { ...activationOptions, bodyTimeoutMs: 1800 });
    untouched(page); cleaned(page); const frozen = JSON.stringify(result); finish(validBody()); await pause(5);
    assert.equal(JSON.stringify(result), frozen);
  });
});

test('first-page independent: a late move resolution after the action deadline cannot cause a wheel', async () => {
  let finishMove;
  const page = new IndependentPage({ evaluate: domEvaluation(), onMove: () => new Promise(resolve => { finishMove = resolve; }) });
  const result = await collect(page, { timeoutMs: 2250 });
  assert.equal(page.moves, 1); assert.equal(page.wheels, 0); cleaned(page);
  const frozen = JSON.stringify(result); finishMove(); await pause(20);
  assert.equal(page.wheels, 0); assert.equal(JSON.stringify(result), frozen);
});

test('first-page independent: cancellation, refusal, new request or navigation during move forbids subsequent wheel', async t => {
  for (const kind of ['cancel', 'refusal', 'request', 'navigation']) await t.test(kind, async () => {
    const controller = new AbortController();
    const page = new IndependentPage({ evaluate: domEvaluation(), onMove: async p => {
      if (kind === 'cancel') controller.abort();
      if (kind === 'refusal') p.respond(null, 403);
      if (kind === 'request') p.beginWorks();
      if (kind === 'navigation') p.navigate();
    } });
    await collect(page, { ...activationOptions, signal: controller.signal });
    assert.equal(page.moves, 1); assert.equal(page.wheels, 0); cleaned(page);
  });
});

test('first-page independent: a newly appearing dialog between move and wheel is not ignored', async () => {
  const state = {};
  const page = new IndependentPage({ evaluate: domEvaluation(state), onMove: async () => { state.dialog = true; } });
  await collect(page, activationOptions); assert.equal(page.moves, 1); assert.equal(page.wheels, 0); cleaned(page);
});

test('first-page independent: login or challenge navigation cannot be revived by returning to the profile', async t => {
  for (const route of ['/passport/login', '/verify/']) await t.test(route, async () => {
    const page = new IndependentPage({ evaluate: domEvaluation(), scenario: p => {
      p.navigate('https://www.douyin.com' + route); p.navigate();
    } });
    const result = await collect(page, activationOptions);
    assert.equal(result.status, 'unavailable'); untouched(page); cleaned(page);
  });
});

test('first-page independent: late activation projection cannot start an action after return', async () => {
  let finishProjection;
  const evaluate = domEvaluation();
  const page = new IndependentPage({ evaluate: (fn, arg, p) => fn.name === 'observeFirstPageActivation'
    ? new Promise(resolve => { finishProjection = () => resolve(evaluate(fn, arg, p)); }) : evaluate(fn, arg, p) });
  const result = await collect(page, { timeoutMs: 2250 });
  assert.equal(typeof finishProjection, 'function'); untouched(page); cleaned(page);
  const frozen = JSON.stringify(result); finishProjection(); await pause(20);
  untouched(page); assert.equal(JSON.stringify(result), frozen);
});

test('first-page independent: the one first-page action budget is not renewed by another navigation', async () => {
  const page = new IndependentPage({ evaluate: domEvaluation(), onWheel: p => p.navigate() });
  const result = await collect(page, { timeoutMs: 2500 });
  assert.equal(result.status, 'unavailable'); assert.equal(page.moves, 1); assert.equal(page.wheels, 1);
  assert.equal(result.failureDiagnostics.firstPageActivation.attemptCount, 1);
  assert.doesNotMatch(JSON.stringify(result.failureDiagnostics), /MS4wLj|sec_user_id|7300000000000000001/);
  cleaned(page);
});

test('first-page independent: iframe document 200 cannot authorize current main document without its own response', async () => {
  const page = new IndependentPage({ status: null, evaluate: domEvaluation(), scenario: p => {
    const request = p.request(PROFILE, true, { url: () => PROFILE });
    p.emit('request', request); p.documentResponse(request, 200);
  } });
  await collect(page, activationOptions); untouched(page); cleaned(page);
});

test('first-page independent: bound document refusals never issue a body read or action', async t => {
  for (const status of [401, 403, 429]) await t.test(String(status), async () => {
    const page = new IndependentPage({ status }); const result = await collect(page);
    assert.equal(result.status, 'unavailable'); assert.equal(page.reads, 0); untouched(page); cleaned(page);
  });
});

test('first-page independent: invalid response ownership and unknown pagination cannot become complete', async t => {
  await t.test('missing author', async () => {
    const bad = validBody(); delete bad.aweme_list[0].author;
    const page = new IndependentPage({ scenario: p => p.respond(bad) }); const result = await collect(page);
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.posts, []); untouched(page); cleaned(page);
  });
  await t.test('missing has_more', async () => {
    const bad = validBody(); delete bad.has_more;
    const page = new IndependentPage({ scenario: p => p.respond(bad) }); const result = await collect(page);
    assert.notEqual(result.worksCoverage, 'complete');
    assert.equal(result.pagination.stopReason, 'unknown-pagination'); untouched(page); cleaned(page);
  });
});
