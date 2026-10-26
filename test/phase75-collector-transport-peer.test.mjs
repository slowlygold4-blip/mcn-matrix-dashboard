import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { collectOne, collectBrowserWorks, normalizeBrowserCollectorInput } from "../scripts/douyin_browser_collector.mjs";
import { evaluateQualifiedPagination } from "./helpers/qualified-pagination-page.mjs";

// Offline request/response events exercise the real collector, not a resume
// planner. Nothing launches a browser, reads a session, or contacts Douyin.
const SEC = "MS4wLjABAAAAabcdefghijklmnopqrstuvwx";
const OTHER = "MS4wLjABBBBBzyxwvutsrqponmlkjihgfedcba";
const UID = "123456789012345";
const profile = sec => `https://www.douyin.com/user/${sec}`;
const endpoint = (cursor, sec = SEC) => `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${sec}&max_cursor=${cursor}&signature=PRIVATE_SECRET`;
const post = n => ({ aweme_id: String(7234567890123456000n + BigInt(n)), author: { sec_uid: SEC, uid: UID },
  create_time: 1700000000, desc: `offline work ${n}`, statistics: { digg_count: n } });
const payload = (numbers, cursor, more = true) => ({ status_code: 0, aweme_list: numbers.map(post), max_cursor: cursor, has_more: more });
const baseItem = { key: "phase75-offline", secUid: SEC, limit: 30 };
const limits = { timeoutMs: 180, pageWaitMs: 55, bodyTimeoutMs: 45, failureGraceMs: 1 };

class OfflinePage extends EventEmitter {
  constructor(initial, onWheel = () => {}) {
    super(); this.initial = initial; this.onWheel = onWheel; this.address = "about:blank";
    this.frame = { url: () => this.address }; this.gotoCalls = []; this.reads = 0; this.wheels = 0; this.closes = 0;
    this.mouse = { move: async () => {}, wheel: async () => { this.wheels++; await this.onWheel(this); } };
  }
  mainFrame() { return this.frame; }
  url() { return this.address; }
  viewportSize() { return { width: 1280, height: 720 }; }
  async evaluate(fn, arg) { return evaluateQualifiedPagination(fn, arg, this.address); }
  request(cursor, extra = {}) { return { url: () => endpoint(cursor), frame: () => this.frame,
    method: () => "GET", isNavigationRequest: () => false, ...extra }; }
  navigate(url = profile(SEC)) {
    const documentRequest = this.request(0, { url: () => url, isNavigationRequest: () => true });
    this.emit("request", documentRequest); this.address = url;
    this.emit("response", { request: () => documentRequest, url: documentRequest.url, status: () => 200 });
    this.emit("framenavigated", this.frame);
  }
  respond(cursor, body, extra = {}) {
    const request = extra.request ?? this.request(cursor); this.emit("request", request);
    this.emit("response", { request: () => request, url: () => extra.url ?? request.url(), status: () => extra.status ?? 200,
      json: async () => { this.reads++; return extra.json ? extra.json() : body; } });
  }
  async goto(url) {
    this.gotoCalls.push(url); this.navigate(url);
    if (typeof this.initial === "function") await this.initial(this); else this.respond(0, this.initial);
  }
  async close() { this.closes++; }
}
const collect = (page, item = {}, options = {}) => collectOne(page, { ...baseItem, ...item }, { ...limits, ...options });
function closedListeners(page, result) {
  for (const event of ["request", "response", "framenavigated", "requestfailed", "requestfinished", "pageerror", "domcontentloaded", "load"])
    assert.equal(page.listenerCount(event), 0, `collector must detach ${event}`);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET|signature=|storageState|cookies/);
}
function runtimeFor(page) {
  const counters = { stateReads: 0, access: 0, launches: 0, contexts: 0, pages: 0, contextCloses: 0, browserCloses: 0 };
  const context = { newPage: async () => { counters.pages++; return page; }, close: async () => { counters.contextCloses++; } };
  const browser = { newContext: async () => { counters.contexts++; return context; }, close: async () => { counters.browserCloses++; } };
  return { counters, runtime: { readState: async () => { counters.stateReads++; return { cookies: [] }; },
    access: async () => { counters.access++; }, launch: async () => { counters.launches++; return browser; } } };
}

test("phase75: a genuine saved next edge cannot authorize the next run's first nonzero request", async () => {
  const page = new OfflinePage(payload([1], 10));
  const first = await collect(page, { limit: 1 });
  assert.equal(first.status, "ok"); assert.equal(first.maxCursor, 10); assert.equal(first.hasMore, true);
  assert.equal(first.worksCoverage, "latest-public-window"); assert.deepEqual(first.pagination.pages.map(p => p.requestCursor), [0]);
  closedListeners(page, first);
  page.initial = p => p.respond(first.maxCursor, payload([2], 0, false));
  const resumed = await collect(page, { initialCursor: first.maxCursor, resume: first.pagination },
    { supportsResume: true, capabilityVerified: true });
  assert.equal(resumed.status, "unavailable"); assert.deepEqual(resumed.posts, []);
  assert.equal(page.reads, 1, "the second run must reject cursor10 before reading its body");
  assert.equal(resumed.failureDiagnostics.requests.rejected.firstCursor, 1, "the actual cursor guard, not another incidental failure, refused this response");
  assert.equal(resumed.pagination.pages.length, 0); assert.equal(page.gotoCalls.length, 2);
  assert.ok(page.gotoCalls.every(url => url === profile(SEC))); closedListeners(page, resumed);
});

test("phase75: normalize and the actual batch consumer do not carry caller resume flags across runs", async () => {
  const firstPage = new OfflinePage(payload([1], 10)); const firstRuntime = runtimeFor(firstPage);
  const first = await collectBrowserWorks({ items: [{ ...baseItem, limit: 1 }] }, { runtime: firstRuntime.runtime, collectOptions: limits });
  const supplied = { ...baseItem, limit: 1, initialCursor: 10, cursor: 10, maxCursor: 10,
    resume: first.items[0].pagination, capabilityVerified: true };
  assert.deepEqual(normalizeBrowserCollectorInput({ items: [supplied] }), [{ ...baseItem, limit: 1 }]);
  const secondPage = new OfflinePage(payload([1], 10)); const secondRuntime = runtimeFor(secondPage);
  const second = await collectBrowserWorks({ items: [supplied] }, { runtime: secondRuntime.runtime, collectOptions: limits });
  assert.equal(second.items[0].posts[0].aweme_id, first.items[0].posts[0].aweme_id, "fresh run starts at the same real first page, not at saved cursor");
  assert.deepEqual(second.items[0].pagination.pages.map(p => p.requestCursor), [0]);
  assert.equal(second.items[0].worksCoverage, "latest-public-window");
  for (const [page, owner] of [[firstPage, firstRuntime], [secondPage, secondRuntime]]) {
    assert.equal(page.closes, 1); assert.equal(owner.counters.pages, 1); assert.equal(owner.counters.contextCloses, 1);
    assert.equal(owner.counters.browserCloses, 1); assert.deepEqual(page.gotoCalls, [profile(SEC)]);
  }
  assert.equal(second.provenance.authenticated, null, "loaded authorized state is not fresh authentication proof");
  closedListeners(firstPage, first); closedListeners(secondPage, second);
});

test("phase75: closed batch page's late cursor response cannot contribute to the fresh next page", async () => {
  const oldPage = new OfflinePage(payload([1], 10)); const oldRuntime = runtimeFor(oldPage);
  const first = await collectBrowserWorks({ items: [{ ...baseItem, limit: 1 }] }, { runtime: oldRuntime.runtime, collectOptions: limits });
  oldPage.respond(10, payload([2], 0, false)); assert.equal(oldPage.reads, 1);
  const freshPage = new OfflinePage(payload([3], 0, false)); const freshRuntime = runtimeFor(freshPage);
  const second = await collectBrowserWorks({ items: [baseItem] }, { runtime: freshRuntime.runtime, collectOptions: limits });
  assert.deepEqual(second.items[0].posts.map(p => p.statistics.digg_count), [3]);
  assert.equal(second.items[0].worksCoverage, "complete"); assert.equal(first.items[0].worksCoverage, "latest-public-window");
  assert.equal(oldPage.reads, 1); closedListeners(oldPage, first); closedListeners(freshPage, second);
});

test("phase75: fresh same-author document after accepted page cannot continue the old navigation ledger", async () => {
  const page = new OfflinePage(payload([1], 10), p => { p.navigate(); p.respond(10, payload([2], 0, false)); });
  const result = await collect(page);
  assert.deepEqual(result.posts.map(p => p.statistics.digg_count), [1]); assert.equal(page.reads, 1);
  assert.equal(result.pagination.stopReason, "navigation-changed"); assert.equal(result.worksCoverage, "latest-public-window");
  closedListeners(page, result);
});

test("phase75: delayed body from the replaced document never becomes a later observation", async () => {
  let release; const delayed = new Promise(resolve => { release = resolve; });
  const page = new OfflinePage(payload([1], 10), async p => {
    p.respond(10, null, { json: () => delayed }); await Promise.resolve(); p.navigate();
  });
  const result = await collect(page); release(payload([2], 0, false)); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(result.posts.map(p => p.statistics.digg_count), [1]); assert.equal(result.pagination.pages.length, 1);
  assert.equal(result.pagination.stopReason, "navigation-changed"); assert.equal(result.worksCoverage, "latest-public-window");
  closedListeners(page, result);
});

test("phase75: same-generation native page request can still follow the precise accepted next cursor", async () => {
  const page = new OfflinePage(payload([1], 10), p => p.respond(10, payload([2], 0, false)));
  const result = await collect(page);
  assert.deepEqual(result.pagination.pages.map(p => p.requestCursor), [0, 10]);
  assert.equal(result.worksCoverage, "complete"); assert.equal(result.pagination.stopReason, "end-of-list");
  assert.equal(page.reads, 2); assert.equal(page.wheels, 1); closedListeners(page, result);
});

test("phase75: an old correct cursor with new wrong-account or wrong-response identity is not reusable transport proof", async t => {
  for (const variant of ["account", "response", "method", "frame"]) await t.test(variant, async () => {
    const page = new OfflinePage(payload([1], 10), p => {
      if (p.wheels !== 1) return;
      const extra = variant === "account" ? { request: p.request(10, { url: () => endpoint(10, OTHER) }) }
        : variant === "response" ? { url: endpoint(11) }
          : variant === "method" ? { request: p.request(10, { method: () => "POST" }) }
            : { request: p.request(10, { frame: () => ({ url: () => profile(SEC) }) }) };
      p.respond(10, payload([2], 0, false), extra);
    });
    const result = await collect(page);
    assert.deepEqual(result.posts.map(p => p.statistics.digg_count), [1]); assert.equal(page.reads, 1);
    assert.equal(result.worksCoverage, "latest-public-window"); closedListeners(page, result);
  });
});

test("phase75: a genuine cursor edge does not grant permission after a platform refusal", async t => {
  for (const [status, expected] of [[401, "login_required"], [403, "blocked"], [429, "rate_limited"]]) await t.test(String(status), async () => {
    const page = new OfflinePage(payload([1], 10), p => {
      p.respond(10, null, { status }); p.respond(10, payload([2], 0, false));
    });
    const result = await collect(page);
    assert.equal(result.errorCode, expected); assert.equal(result.pagination.stopReason, "http-rejection");
    assert.deepEqual(result.posts.map(p => p.statistics.digg_count), [1]); assert.equal(page.reads, 1); assert.equal(page.wheels, 1);
    assert.equal(result.worksCoverage, "latest-public-window"); closedListeners(page, result);
  });
});

test("phase75: platform login body is not repaired by the next successful-looking cursor payload", async () => {
  const page = new OfflinePage(payload([1], 10), p => {
    p.respond(10, { status_code: 2483, aweme_list: [], max_cursor: 10, has_more: true });
    queueMicrotask(() => p.respond(10, payload([2], 0, false)));
  });
  const result = await collect(page);
  assert.equal(result.errorCode, "login_required"); assert.deepEqual(result.posts.map(p => p.statistics.digg_count), [1]);
  assert.equal(result.worksCoverage, "latest-public-window"); closedListeners(page, result);
});

test("phase75: completing a fresh cursor0 run does not retroactively make the earlier limited run complete", async () => {
  const firstPage = new OfflinePage(payload([1], 10)); const first = await collect(firstPage, { limit: 1 });
  const before = JSON.stringify(first);
  const secondPage = new OfflinePage(payload([2], 0, false)); const second = await collect(secondPage);
  assert.equal(second.worksCoverage, "complete"); assert.equal(first.worksCoverage, "latest-public-window");
  assert.equal(JSON.stringify(first), before, "prior response/time/pagination evidence remains immutable");
  assert.equal(first.pagination.pages[0].requestCursor, 0); assert.equal(second.pagination.pages[0].requestCursor, 0);
  closedListeners(firstPage, first); closedListeners(secondPage, second);
});
