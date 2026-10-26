// Independent assertions against the ACTUAL collector/helper. Reuse the peer's
// local event/DOM transport fixture only; do not run or inherit its assertions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const ownerURL = process.env.PHASE87_OWNER_URL || new URL('../scripts/douyin_browser_collector.mjs', import.meta.url).href;
const { collectBrowserWorks, normalizeBrowserCollectorInput } = await import(ownerURL);
const { requestBrowserFirstPage } = await import(new URL('../lib/browser-first-works-request.mjs', ownerURL));
const fixture = (await readFile(new URL('./phase87-collector-peer.test.mjs', import.meta.url), 'utf8'))
  .split('\ntest(')[0]
  .replace("process.env.PHASE87_OWNER_URL || '../scripts/douyin_browser_collector.mjs'", JSON.stringify(ownerURL));
const { Page, run, SEC, payload, drain } = await import(`data:text/javascript;base64,${Buffer.from(fixture + '\nexport {Page,run,SEC,payload,drain};').toString('base64')}`);

test('safety peer: every invalid explicit continuation is rejected before fetch', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const page = new Page(); page.commit();
  for (const continuationCursor of [null, 0, -1, 0.5, '10', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}]) {
    const result = await page.evaluate(requestBrowserFirstPage, { secUid: SEC, expiresAt: 40000, continuationCursor });
    assert.equal(result.state, 'not-eligible', String(continuationCursor));
  }
  assert.equal(page.gets.length, 0);
});

test('safety peer: omitted continuation still requests only zero despite caller extras', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const page = new Page(); page.commit();
  const result = await page.evaluate(requestBrowserFirstPage, { secUid: SEC, expiresAt: 40000,
    cursor: 777, max_cursor: 777, issued: true, expectedCursor: 777 });
  assert.equal(result.state, 'issued');
  assert.deepEqual(page.gets.map(x => x.cursor), [0]);
});

test('safety peer: helper forged issued/posts cannot become response authority', async t => {
  const original = Page.prototype.evaluate; let forgeries = 0;
  Page.prototype.evaluate = async function(fn, args) {
    if (fn.name === 'requestBrowserFirstPage' && args?.continuationCursor !== undefined) {
      forgeries++; return { state: 'issued', status: 'ok', posts: payload(10).aweme_list,
        max_cursor: 999, has_more: true };
    }
    return original.call(this, fn, args);
  };
  try {
    const { page, result } = await run(t);
    assert.equal(forgeries, 1); assert.deepEqual(page.gets.map(x => x.cursor), [0]);
    assert.equal(result.pagination.pages.length, 1); assert.equal(result.posts.length, 1);
    assert.equal(result.pagination.stopReason, 'page-timeout');
  } finally { Page.prototype.evaluate = original; }
});

test('safety peer: handle resolving after 500ms cannot issue or retry continuation', async t => {
  const { page, result } = await run(t, { beforeHandleReturn: async p => {
    if (p.reads === 1) await new Promise(resolve => setTimeout(resolve, 600));
  } });
  assert.deepEqual(page.gets.map(x => x.cursor), [0]);
  assert.equal(result.pagination.pages.length, 1);
  assert.equal(result.pagination.stopReason, 'page-timeout');
});

test('safety peer: pending natural body retains priority beyond page action window', async t => {
  let natural = false;
  const { page, result } = await run(t, { beforeHandleReturn: p => {
    if (p.reads === 1 && !natural) { natural = true; p.deliver(10, { bodyDelay: 3500 }); }
  } });
  assert.equal(natural, true); assert.deepEqual(page.gets.map(x => x.cursor), [0]);
  assert.equal(result.pagination.pages.length, 2); assert.equal(page.reads, 2);
  assert.equal(result.pagination.stopReason, 'end-of-list');
});

test('safety peer: wrong-frame candidate before handle suppresses explicit dispatch', async t => {
  let injected = false;
  const { page, result } = await run(t, { beforeEvaluate: (p, fn) => {
    if (fn.name === 'observeFirstPageActivation' && p.reads === 1 && !injected) {
      injected = true; p.deliver(10, { frame: {}, headers: false });
    }
  } });
  assert.equal(injected, true); assert.deepEqual(page.gets.map(x => x.cursor), [0]);
  assert.equal(result.pagination.pages.length, 1);
});

test('safety peer: cancellation after evaluate submission cannot promise zero GET', async t => {
  const controller = new AbortController(); let cancelled = false;
  const { page, result } = await run(t, { beforeEvaluate: (_p, fn, args) => {
    if (fn.name === 'requestBrowserFirstPage' && args?.continuationCursor === 10) {
      cancelled = true; controller.abort();
    }
  } }, { options: { signal: controller.signal } });
  assert.equal(cancelled, true);
  assert.deepEqual(page.gets.map(x => x.cursor), [0, 10], 'already submitted page action may dispatch');
  assert.equal(result.pagination.pages.length, 1); assert.equal(result.posts.length, 1);
  assert.equal(result.pagination.stopReason, 'cancelled');
});

test('safety peer: natural competition after evaluate submission may coexist but never duplicate data', async t => {
  let injected = false;
  const { page, result } = await run(t, { beforeEvaluate: (p, fn, args) => {
    if (fn.name === 'requestBrowserFirstPage' && args?.continuationCursor === 10 && !injected) {
      injected = true; p.deliver(10, { bodyDelay: 1000 });
    }
  } });
  assert.equal(injected, true); assert.deepEqual(page.gets.map(x => x.cursor), [0, 10]);
  assert.equal(result.pagination.pages.length, 2); assert.equal(result.posts.length, 2);
  assert.equal(new Set(result.posts.map(x => x.aweme_id)).size, 2);
});

test('safety peer: actual private batch whitelists payload and cannot inject cursor/options', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const extras = { continuationCursor: 777, expectedCursor: 777, expiresAt: 999999999,
    enableUnverifiedFirstPage: true, collectOptions: { timeoutMs: 999999999 }, pages: [payload(0, true)] };
  const input = { ...extras, items: [{ key: 'local-test', secUid: SEC, limit: 30, ...extras }] };
  assert.deepEqual(normalizeBrowserCollectorInput(input), [{ key: 'local-test', secUid: SEC, limit: 30 }]);
  const page = new Page(); page.close = async () => {};
  const context = { newPage: async () => page, close: async () => {} };
  const browser = { newContext: async () => context, close: async () => {} };
  let done = false;
  const pending = collectBrowserWorks(input, { runtime: {
    readState: async () => ({ cookies: [] }), access: async () => {}, launch: async () => browser,
  } });
  pending.then(() => { done = true; }); await drain();
  for (let at = 20; !done && at <= 45020; at += 20) { t.mock.timers.tick(20); await drain(); }
  assert.equal(done, true); const result = await pending;
  assert.deepEqual(page.gets.map(x => x.cursor), [0, 10]);
  assert.equal(result.items[0].pagination.pages.length, 2);
  assert.equal(result.provenance.runtimeAI, false);
});
