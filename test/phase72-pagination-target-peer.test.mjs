// Independent, offline-only evidence. Actual production is compared with the
// explicitly historical blind-pointer owner; no browser or user data is written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';

const sourceUrl = new URL('../scripts/douyin_browser_collector.mjs', import.meta.url);
const currentOwner = readFileSync(sourceUrl, 'utf8');
// Phase78 ships the previously hypothetical candidate. Preserve every old
// blind-pointer counterexample against an explicitly historical in-memory
// owner; all candidate assertions now exercise the actual production owner.
const qualifiedBlock = currentOwner.match(/          const scrollGeneration = generation;[\s\S]*?          finally \{ scrollExpired = true; \}\n          if \(madeScrollProgress && !scrollHeld && scrollAttempts < 8\) continue;/g);
assert.equal(qualifiedBlock?.length, 1, 'one exact qualified continuation owner');
const historicalBlock = `          const scrollGeneration = generation;
          scrollAttempts += 1;
          try {
            const scrolling = await bounded(Promise.resolve().then(async () => {
              if (!active || barrier || generation !== scrollGeneration || options.signal?.aborted) return;
              const viewport = page.viewportSize?.() || { width: 1280, height: 720 };
              await page.mouse.move(Math.floor(viewport.width * 0.75), Math.floor(viewport.height * 0.8));
              if (!active || barrier || generation !== scrollGeneration || options.signal?.aborted) return;
              await page.mouse.wheel(0, 1600);
            }), Math.max(1, Math.min(1_000, deadline - Date.now())), bodyController.signal);
            if (scrolling === timedOut && !barrier) { stopPaging("scroll-failed", "collector_error"); break; }
          } catch { stopPaging("scroll-failed", "collector_error"); break; }`;
const currentCondition = 'if (!awaitingCurrentBody && !requestedCurrentPage && !scrollHeld && scrollAttempts < 8) {';
assert.equal(currentOwner.split(currentCondition).length, 2);
const baseline = currentOwner.replace(qualifiedBlock[0], historicalBlock).replace(currentCondition,
  'if (!awaitingCurrentBody && scrollAttempts < 2 && (!scrollAttempts || Date.now() >= nextPageDeadline - pageWaitMs / 2)) {');
const originalAction = `              const viewport = page.viewportSize?.() || { width: 1280, height: 720 };
              await page.mouse.move(Math.floor(viewport.width * 0.75), Math.floor(viewport.height * 0.8));
              if (!active || barrier || generation !== scrollGeneration || options.signal?.aborted) return;
              await page.mouse.wheel(0, 1600);`;
assert.equal(baseline.split(originalAction).length, 2, 'historical owner has exactly one original action block');
let transformed = baseline.replaceAll('import.meta.url', JSON.stringify(sourceUrl.href));
transformed = transformed.replace(/from "([^"]+)"/g, (match, specifier) => specifier.startsWith('node:') ? match
  : `from ${JSON.stringify(specifier.startsWith('.') ? new URL(specifier, sourceUrl).href : import.meta.resolve(specifier))}`);
const historicalOwner = await import(`data:text/javascript;base64,${Buffer.from(transformed).toString('base64')}`);
const candidate = { collectOne };

const secUid = 'MS4wLjABAAAAPhase72PaginationOfflineFixture';
const profile = `https://www.douyin.com/user/${secUid}`;
const cursor = 1749305973000;
const works = value => `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${secUid}&max_cursor=${value}`;
const posts = (from, count) => Array.from({ length: count }, (_, i) => ({
  aweme_id: String(7300000000000000000n + BigInt(from + i)), author: { sec_uid: secUid }, statistics: { digg_count: from + i },
}));
class Page extends EventEmitter {
  constructor() {
    super(); this.address = 'about:blank'; this.frame = { url: () => this.address };
    this.moves = []; this.wheels = 0; this.probes = 0; this.reads = 0;
    this.mouse = { move: async (x, y) => { this.moves.push([x, y]); this.afterMove?.(); },
      wheel: async () => { this.wheels++; if (this.moves.at(-1)?.join(',') === '350,300') this.respond(cursor, posts(20, 1), false); } };
  }
  mainFrame() { return this.frame; }
  url() { return this.address; }
  viewportSize() { return { width: 1280, height: 720 }; }
  request(url, navigation = false) {
    return { url: () => url, method: () => navigation ? (this.documentMethod ?? 'GET') : 'GET', frame: () => this.frame, isNavigationRequest: () => navigation };
  }
  respond(value, awemeList, hasMore) {
    const req = this.request(works(value)); this.emit('request', req);
    this.emit('response', { request: () => req, url: req.url, status: () => 200,
      json: async () => { this.reads++; return { status_code: 0, aweme_list: awemeList, has_more: hasMore, max_cursor: hasMore ? cursor : 0 }; } });
  }
  async goto() {
    this.document = this.request(profile, true); this.emit('request', this.document); this.address = profile;
    this.emit('response', { request: () => this.document, url: this.document.url, status: () => this.documentStatus ?? 200 });
    this.emit('framenavigated', this.frame); this.respond(0, posts(1, 19), true);
  }
  async evaluate(fn, arg) {
    if (fn.name !== 'observeFirstPageActivation') return { observation: 'observed', readyState: 'interactive' };
    this.probes++;
    if (this.pointOverride) return this.pointOverride(this.probes);
    const rect = { left: 100, top: 100, right: 600, bottom: 500, width: 500, height: 400 };
    const region = { scrollTop: 0, clientHeight: 400, scrollHeight: 2400, parentElement: null,
      contains: node => node === region, getBoundingClientRect: () => rect };
    const document = { readyState: 'interactive', scrollingElement: region,
      querySelectorAll: selector => selector.includes('user-post-list') && !this.absent ? [region] : [],
      elementFromPoint: () => this.occluded ? {} : region };
    return runInNewContext(`(${fn.toString()})(arg)`, { arg, document, URL, location: new URL(this.address),
      window: { innerWidth: 1280, innerHeight: 720 }, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', overflowY: 'auto' }) });
  }
}
const run = (fn, page, extra = {}) => fn(page, { key: 'offline-phase72', secUid, limit: 30 }, {
  timeoutMs: 230, pageWaitMs: 60, bodyTimeoutMs: 50, ...extra,
});
const clean = page => {
  for (const event of ['request', 'response', 'framenavigated', 'requestfailed', 'requestfinished', 'pageerror', 'domcontentloaded', 'load']) {
    assert.equal(page.listenerCount(event), 0, event);
  }
};

test('historical blind-pointer owner retains nineteen verified works when its pointer misses an offset scroller', async () => {
  const page = new Page(); const result = await run(historicalOwner.collectOne, page);
  assert.equal(result.posts.length, 19); assert.equal(result.worksCoverage, 'latest-public-window');
  assert.equal(result.pagination.stopReason, 'page-timeout'); assert.equal(result.pagination.requestCount, 1);
  assert.equal(page.wheels, 2); assert.deepEqual(page.moves, [[960, 576], [960, 576]]);
  assert.equal(page.probes, 0); clean(page);
});
test('actual production targeted continuation reaches the next response with unchanged evidence and limits', async () => {
  const page = new Page(); const result = await run(candidate.collectOne, page);
  assert.equal(result.posts.length, 20); assert.equal(result.worksCoverage, 'complete');
  assert.equal(result.pagination.stopReason, 'end-of-list'); assert.equal(result.pagination.requestCount, 2);
  assert.deepEqual(result.pagination.pages.map(p => p.requestCursor), [0, cursor]);
  assert.equal(page.wheels, 1); assert.deepEqual(page.moves, [[350, 300]]); assert.equal(page.probes, 2);
  clean(page);
});
for (const [name, setup] of [
  ['region absent', p => { p.absent = true; }],
  ['region occluded', p => { p.occluded = true; }],
  ['visible access gate', p => { p.pointOverride = () => ({ eligible: false, reason: 'blocked' }); }],
  ['unknown projection', p => { p.pointOverride = () => null; }],
  ['malformed point', p => { p.pointOverride = () => ({ eligible: true, x: 0.5, y: 300, deltaY: 540 }); }],
  ['hover changes target', p => { p.pointOverride = n => ({ eligible: true, x: n % 2 ? 350 : 351, y: 300, deltaY: 540 }); }],
  ['hover reveals gate', p => { p.pointOverride = n => n % 2 ? ({ eligible: true, x: 350, y: 300, deltaY: 540 }) : ({ eligible: false, reason: 'blocked' }); }],
  ['hover starts bound request', p => { p.afterMove = () => p.emit('request', p.request(works(cursor))); }],
  ['hover invalidates document owner', p => { p.afterMove = () => p.emit('request', p.request(profile, true)); }],
  ['hover invalidates GET method', p => { p.afterMove = () => { p.documentMethod = 'POST'; }; }],
  ['no DOM qualification support', p => { p.evaluate = undefined; }],
]) test(`actual qualified owner ${name} cannot create a next-page work or wheel`, async () => {
  const page = new Page(); setup(page); const result = await run(candidate.collectOne, page);
  assert.equal(result.posts.length, 19); assert.equal(result.worksCoverage, 'latest-public-window');
  assert.equal(page.wheels, 0); assert.equal(page.reads, 1); clean(page);
});
test('a non2xx current document cannot even authorize the supplied first-page fixture', async () => {
  const page = new Page(); page.documentStatus = 403; const result = await run(candidate.collectOne, page);
  assert.deepEqual(result.posts, []); assert.equal(result.worksCoverage, 'unavailable');
  assert.equal(page.wheels, 0); assert.equal(page.reads, 0); clean(page);
});
test('actual qualified owner cancellation during hover stops without further probing or wheel', async () => {
  const abort = new AbortController(); const page = new Page(); page.afterMove = () => abort.abort();
  const result = await run(candidate.collectOne, page, { signal: abort.signal });
  assert.equal(result.posts.length, 19); assert.equal(page.wheels, 0); assert.equal(page.probes, 1);
  assert.equal(result.pagination.stopReason, 'cancelled'); clean(page);
});
