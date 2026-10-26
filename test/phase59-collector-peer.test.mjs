import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';

// Pure event fixtures: no browser/session, network, DB, scheduler or credentials.
// They exercise the actual production collector and its original 45 s ceiling.
const SEC = 'MS4wLjABAAAAPhase59DocumentBudget';
const OTHER = 'MS4wLjABAAAAPhase59OtherDocument';
const profile = sec => `https://www.douyin.com/user/${sec}`;
const works = sec => `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${sec}&max_cursor=0`;
const drain = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

class Fixture extends EventEmitter {
  constructor() {
    super(); this.address = 'about:blank'; this.reads = 0; this.documents = 0;
    this.frame = { url: () => this.address };
  }
  mainFrame() { return this.frame; }
  url() { return this.address; }
  request(url, navigation = false) {
    return { url: () => url, frame: () => this.frame, method: () => 'GET', isNavigationRequest: () => navigation };
  }
  documentResponse(request = this.currentDocument, status = 200) {
    this.emit('response', { request: () => request, url: request.url, status: () => status });
  }
  history(address) { this.address = address; this.emit('framenavigated', this.frame); }
  commit({ sec = SEC, status = 200, sameDocument = false, emitCommit = true } = {}) {
    if (!sameDocument) {
      const request = this.request(profile(sec), true); this.documents++;
      this.initialDocument ??= request; this.currentDocument = request;
      this.emit('request', request);
      if (status !== null) this.documentResponse(request, status);
    }
    if (emitCommit) this.history(profile(sec));
  }
  respond({ sec = SEC, author = SEC, status = 200 } = {}) {
    const request = this.request(works(sec)); this.emit('request', request);
    this.emit('response', { request: () => request, url: request.url, status: () => status,
      json: async () => { this.reads++; return { status_code: 0, has_more: false, max_cursor: 0,
        aweme_list: [{ aweme_id: '7300000000000059059', author: { sec_uid: author }, statistics: { digg_count: 9 } }] }; } });
  }
  async goto() { this.commit(); }
}

async function run(t, { events = {}, ceiling = 46_000, timeoutMs } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const page = new Fixture(); let done = false;
  const pending = collectOne(page, { key: 'phase59-offline', secUid: SEC, limit: 30 },
    timeoutMs === undefined ? {} : { timeoutMs });
  void pending.then(() => { done = true; }); await drain();
  for (let elapsed = 1000; !done && elapsed <= ceiling; elapsed += 1000) {
    t.mock.timers.tick(1000); events[elapsed]?.(page); await drain();
  }
  assert.equal(done, true, 'absolute existing account deadline must terminate');
  const result = await pending;
  assert.ok(result.failureDiagnostics.elapsedMs <= (timeoutMs ?? 45_000));
  for (const name of ['request', 'response', 'framenavigated', 'requestfinished', 'requestfailed', 'load', 'domcontentloaded']) {
    assert.equal(page.listenerCount(name), 0, name);
  }
  return { page, result };
}

test('phase59: a verified replacement gets its response opportunity within original 45 s, not the retired document deadline', async t => {
  const { page, result } = await run(t, { events: { 20_000: p => p.commit(), 26_000: p => p.respond() } });
  assert.equal(result.status, 'ok'); assert.equal(page.reads, 1);
  assert.equal(result.posts.length, 1); assert.equal(result.worksCoverage, 'complete');
  assert.equal(result.failureDiagnostics.lifecycle.generation, 2);
  assert.ok(result.failureDiagnostics.elapsedMs >= 26_000 && result.failureDiagnostics.elapsedMs <= 27_000);
  assert.deepEqual(result.failureDiagnostics.httpStatuses, [200]);
});

test('phase59: a single fast document retains the original 25 s response limit', async t => {
  const { result, page } = await run(t);
  assert.equal(result.status, 'unavailable'); assert.equal(result.failureDiagnostics.elapsedMs, 25_000);
  assert.equal(page.documents, 1); assert.equal(page.reads, 0);
});

test('phase59: same-document history cannot renew an expired opportunity', async t => {
  const { result, page } = await run(t, { events: { 20_000: p => p.commit({ sameDocument: true }), 26_000: p => p.respond() } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.failureDiagnostics.elapsedMs, 25_000);
  assert.equal(page.documents, 1); assert.equal(page.reads, 0);
});

test('phase59: a replacement lacking document HTTP success cannot renew the deadline', async t => {
  const { result, page } = await run(t, { events: { 20_000: p => p.commit({ status: null }), 26_000: p => p.respond() } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.failureDiagnostics.elapsedMs, 25_000);
  assert.equal(page.reads, 0);
});

test('phase59: document 2xx without a matching commit cannot renew the deadline', async t => {
  const { result, page } = await run(t, { events: { 20_000: p => p.commit({ emitCommit: false }), 26_000: p => p.respond() } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.failureDiagnostics.elapsedMs, 25_000);
  assert.equal(page.reads, 0);
});

test('phase59: a matching commit before document 2xx still joins the same current request', async t => {
  const { result, page } = await run(t, { events: { 20_000: p => p.commit({ status: null }),
    21_000: p => p.documentResponse(), 26_000: p => p.respond() } });
  assert.equal(result.status, 'ok'); assert.equal(result.worksCoverage, 'complete');
  assert.equal(page.reads, 1); assert.equal(result.posts.length, 1);
});

test('phase59: a delayed prior-document 2xx cannot verify the current replacement', async t => {
  const { result, page } = await run(t, { events: { 20_000: p => p.commit({ status: null }),
    21_000: p => p.documentResponse(p.initialDocument), 26_000: p => p.respond() } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.failureDiagnostics.elapsedMs, 25_000);
  assert.equal(page.reads, 0);
});

test('phase59: duplicate commit and response events cannot repeatedly renew the same document', async t => {
  const { result, page } = await run(t, { events: { 1000: p => p.commit(),
    20_000: p => { p.documentResponse(); p.commit({ sameDocument: true }); }, 30_000: p => p.respond() } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.failureDiagnostics.elapsedMs, 26_000);
  assert.equal(page.reads, 0); assert.equal(page.documents, 2);
});

test('phase59: replaying a prior actual document Request cannot grant a second opportunity in a later generation', async t => {
  const { result, page } = await run(t, { events: { 1000: p => p.commit(), 20_000: p => {
    p.emit('request', p.initialDocument); p.documentResponse(p.initialDocument); p.history(profile(SEC));
  }, 30_000: p => p.respond() } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.failureDiagnostics.elapsedMs, 26_000);
  assert.equal(page.reads, 0); assert.equal(page.documents, 2);
});

test('phase59: same-profile hash/history changes cannot renew the original document', async t => {
  const { result, page } = await run(t, { events: { 20_000: p => p.history(`${profile(SEC)}#works`),
    26_000: p => p.respond() } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.failureDiagnostics.elapsedMs, 25_000);
  assert.equal(page.documents, 1); assert.equal(page.reads, 0);
});

test('phase59: history away and back cannot promote an old document generation into a new opportunity', async t => {
  const { result, page } = await run(t, { events: { 20_000: p => p.history('https://www.douyin.com/discover'),
    21_000: p => p.history(profile(SEC)), 26_000: p => p.respond() } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.failureDiagnostics.elapsedMs, 25_000);
  assert.equal(page.documents, 1); assert.equal(page.reads, 0);
});

test('phase59: a current document 403 remains a hard stop without later reading', async t => {
  const { result, page } = await run(t, { events: { 20_000: p => p.commit({ status: 403 }), 26_000: p => p.respond() } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.errorCode, 'blocked');
  assert.equal(result.failureDiagnostics.elapsedMs, 20_000); assert.equal(page.reads, 0);
});

test('phase59: verified replacements never extend the original absolute 45 s ceiling', async t => {
  const { result, page } = await run(t, { events: { 20_000: p => p.commit(), 40_000: p => p.commit(), 46_000: p => p.respond() } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.failureDiagnostics.elapsedMs, 45_000);
  assert.equal(page.reads, 0); assert.deepEqual(result.posts, []);
});

test('phase59: different-profile replacement cannot renew the target opportunity', async t => {
  const { result, page } = await run(t, { events: { 20_000: p => p.commit({ sec: OTHER }), 26_000: p => p.respond() } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.failureDiagnostics.elapsedMs, 25_000);
  assert.equal(page.reads, 0); assert.deepEqual(result.posts, []);
});

test('phase59: a caller smaller budget remains absolute across replacements', async t => {
  const { result, page } = await run(t, { timeoutMs: 24_000,
    events: { 20_000: p => p.commit(), 26_000: p => p.respond() } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.failureDiagnostics.elapsedMs, 24_000);
  assert.equal(page.reads, 0);
});

test('phase59: renewed opportunity never changes exact response author validation', async t => {
  const { result, page } = await run(t, { events: { 20_000: p => p.commit(), 26_000: p => p.respond({ author: OTHER }) } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.errorCode, 'upstream_changed');
  assert.equal(page.reads, 1); assert.deepEqual(result.posts, []);
});
