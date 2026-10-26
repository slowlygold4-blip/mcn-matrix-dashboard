import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';

const secUid = 'MS4wLjABAAAAActivationLifecyclePeer';
const profile = `https://www.douyin.com/user/${secUid}`;
const endpoint = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${secUid}&max_cursor=0`;
const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
class Page extends EventEmitter {
  constructor(regionAt = 0) {
    super(); this.address = profile; this.ready = 'loading'; this.regionAt = regionAt;
    this.moves = 0; this.wheels = 0; this.probes = []; this.screenReads = 0; this.requestCalls = 0;
    this.frame = { url: () => this.address };
    this.mouse = { move: async () => { this.moves++; }, wheel: async () => { this.wheels++; this.works(200); } };
  }
  mainFrame() { return this.frame; }
  url() { return this.address; }
  request(url, navigation = false) { return { url: () => url, method: () => 'GET', frame: () => this.frame, isNavigationRequest: () => navigation }; }
  async goto() {
    const doc = this.request(profile, true); this.emit('request', doc);
    this.emit('response', { request: () => doc, url: doc.url, status: () => 200 });
    this.emit('framenavigated', this.frame);
  }
  history() { this.address = `${profile}?normal=history`; this.emit('framenavigated', this.frame); }
  domReady() { this.ready = 'interactive'; this.emit('domcontentloaded'); }
  works(status) {
    const request = this.request(endpoint); this.emit('request', request);
    this.emit('response', { request: () => request, url: request.url, status: () => status,
      json: async () => ({ status_code: 0, has_more: false, max_cursor: 0,
        aweme_list: [{ aweme_id: '7300000000000000001', author: { sec_uid: secUid, uid: '1234567890' }, statistics: { digg_count: 9 } }] }) });
  }
  async evaluate(fn, arg) {
    if (fn.name === 'observeFirstPageActivation') this.probes.push(Date.now());
    else if (fn.name === 'requestBrowserFirstPage') this.requestCalls++;
    else this.screenReads++;
    const rect = { left: 100, top: 100, right: 900, bottom: 600, width: 800, height: 500 };
    const region = { scrollTop: 0, scrollHeight: 1800, clientHeight: 500, parentElement: null,
      contains(other) { return this === other; }, getBoundingClientRect: () => rect };
    const document = { readyState: this.ready, body: this.ready === 'loading' ? null : { childElementCount: 2 },
      scrollingElement: region, querySelector: () => null, elementFromPoint: () => region,
      querySelectorAll: selector => selector.includes('user-post-list') && Date.now() >= this.regionAt ? [region] : [] };
    Object.defineProperty(document, 'cookie', { get() { throw Error('Credential reads forbidden'); } });
    return runInNewContext(`(${fn.toString()})(arg)`, { arg, URL, location: new URL(this.address), document,
      window: { innerWidth: 1280, innerHeight: 720 }, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', overflowY: 'auto' }) });
  }
}
async function run(t, page, onTick = () => {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let done = false;
  const pending = collectOne(page, { key: 'fixture', secUid, limit: 30 },
    { timeoutMs: 10_000, enableUnverifiedFirstPageRequest: true });
  pending.finally(() => { done = true; }); await drain();
  for (let time = 20; !done && time <= 10_100; time += 20) {
    t.mock.timers.tick(20);
    if (time === 20 || time === 40) page.history();
    if (time === 100) page.domReady();
    onTick(time, page); await drain();
  }
  assert.equal(done, true);
  return pending;
}

test('independent lifecycle: readiness fix reaches one normal action and accepted response after ordinary history events', async t => {
  const page = new Page(); const result = await run(t, page);
  assert.equal(page.screenReads, 2);
  assert.equal(result.failureDiagnostics.firstScreen.readyState, 'interactive');
  assert.equal(page.moves, 1); assert.equal(page.wheels, 1);
  assert.equal(result.posts.length, 1); assert.equal(result.posts[0].statistics.digg_count, 9);
  assert.equal(result.status, 'ok'); assert.equal(result.pagination.stopReason, 'end-of-list');
  assert.equal(result.hasMore, false); assert.equal(result.worksCoverage, 'complete');
});

test('independent lifecycle: region-absent is a bounded probe observation, not a final-DOM assertion', async t => {
  const page = new Page(9000); const result = await run(t, page);
  assert.equal(page.screenReads, 2); assert.equal(page.probes.length, 8);
  assert.equal(page.requestCalls, 1, 'one explicit request opportunity is not a first-screen observation');
  assert.equal(result.failureDiagnostics.firstPageRequest.state, 'not-eligible', 'fixture has no window.fetch; no transport is invented');
  assert.equal(page.probes.at(-1), 8100);
  assert.ok(Date.now() >= page.regionAt, 'synthetic region exists when collection ends');
  assert.equal(result.failureDiagnostics.firstPageActivation.structure.reason, 'region-absent');
  assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
  assert.equal(result.worksCoverage, 'unavailable'); assert.deepEqual(result.posts, []);
});

test('independent lifecycle: refusal while region is absent cannot be revived by later ready content', async t => {
  const page = new Page(3000); const result = await run(t, page, (time, p) => { if (time === 1500) p.works(403); });
  assert.equal(page.probes.length, 1); assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
  assert.equal(result.errorCode, 'blocked'); assert.deepEqual(result.posts, []);
});
