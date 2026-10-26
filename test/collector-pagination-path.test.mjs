import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { collectOne, collectBrowserWorks } from "../scripts/douyin_browser_collector.mjs";
import { browserWorksCursor, sanitizeBrowserWorksPagination } from "../lib/browser-works-pagination.mjs";
import { evaluateQualifiedPagination } from "./helpers/qualified-pagination-page.mjs";

const SEC = "MS4wLjABAAAAabcdefghijklmnopqrstuvwx";
const OTHER = "MS4wLjABBBBBzyxwvutsrqponmlkjihgfedcba";
const profile = sec => `https://www.douyin.com/user/${sec}`;
const works = (cursor, sec = SEC) => `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${sec}&max_cursor=${cursor}&signature=PRIVATE_SECRET`;
const post = id => ({ aweme_id: String(12345678901234560n + BigInt(id)), author: { sec_uid: SEC }, statistics: { digg_count: id } });
const body = (ids, cursor, more = true) => ({ status_code: 0, aweme_list: ids.map(post), max_cursor: cursor, has_more: more });
const item = { key: "offline-pagination", secUid: SEC, limit: 30 };
const options = { timeoutMs: 250, pageWaitMs: 70, bodyTimeoutMs: 50, failureGraceMs: 1 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class Page extends EventEmitter {
  constructor(first, onScroll = () => {}) {
    super(); this.first = first; this.onScroll = onScroll; this.address = "about:blank";
    this.frame = { url: () => this.address }; this.wheels = 0; this.moves = 0; this.reads = 0;
    this.mouse = { move: async () => { this.moves++; }, wheel: async () => { this.wheels++; await this.onScroll(this); } };
  }
  mainFrame() { return this.frame; }
  url() { return this.address; }
  viewportSize() { return { width: 1280, height: 720 }; }
  request(cursor = 0, extra = {}) { return { url: () => works(cursor), frame: () => this.frame, method: () => "GET", isNavigationRequest: () => false, ...extra }; }
  navigate(url = profile(SEC)) {
    const documentRequest = this.request(0, { url: () => url, isNavigationRequest: () => true });
    this.emit("request", documentRequest); this.address = url;
    this.emit("response", { request: () => documentRequest, url: documentRequest.url, status: () => 200 });
    this.emit("framenavigated", this.frame);
  }
  async evaluate(fn, arg) { return evaluateQualifiedPagination(fn, arg, this.address); }
  respond(cursor, payload, extra = {}) {
    const request = extra.request || this.request(cursor); this.emit("request", request);
    this.emit("response", { request: () => request, url: () => extra.url || request.url(), status: () => extra.status || 200,
      json: async () => { this.reads++; return extra.json ? extra.json() : payload; } });
  }
  async goto(url) { this.navigate(url); if (typeof this.first === "function") return this.first(this); this.respond(0, this.first); }
}
const run = (page, extra = {}) => collectOne(page, { ...item, ...extra.item }, { ...options, ...extra.options });
function clean(page, result) {
  for (const event of ["request", "response", "framenavigated", "requestfailed", "pageerror", "domcontentloaded"]) assert.equal(page.listenerCount(event), 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET|signature=/);
}

test("pagination: actual collector uses normal wheel and continuous bound cursors to collect two pages", async () => {
  const page = new Page(body([1, 2], 10), p => p.respond(10, body([3], 0, false)));
  const result = await run(page);
  assert.equal(result.status, "ok"); assert.equal(result.worksCoverage, "complete");
  assert.deepEqual(result.posts.map(row => row.statistics.digg_count), [1, 2, 3]);
  assert.equal(page.wheels, 1); assert.equal(page.moves, 1); assert.equal(page.reads, 2);
  assert.equal(result.pagination.stopReason, "end-of-list");
  assert.equal(result.pagination.requestCount, 2); assert.equal(result.pagination.collectedCount, 3);
  assert.deepEqual(result.pagination.pages.map(row => row.requestCursor), [0, 10]);
  assert.ok(result.pagination.pages.every(row => typeof row.observedAt === "string" && row.filteredCount === 0 && row.duplicateCount === 0 && row.truncated === false));
  clean(page, result);
});

test("pagination: configured total item limit is respected and a truncated last page is never complete", async () => {
  const page = new Page(body([1, 2], 10), p => p.respond(10, body([3, 4], 0, false)));
  const result = await run(page, { item: { limit: 3 } });
  assert.deepEqual(result.posts.map(row => row.statistics.digg_count), [1, 2, 3]);
  assert.equal(result.worksCoverage, "latest-public-window");
  assert.equal(result.pagination.pages[1].truncated, true);
  assert.equal(result.pagination.pages[1].rawCount, 2); assert.equal(result.pagination.pages[1].acceptedCount, 1);
});

test("pagination: a full first-page quota never initiates a continuation", async () => {
  const page = new Page(body([1, 2], 10));
  const result = await run(page, { item: { limit: 2 } });
  assert.equal(page.wheels, 0); assert.equal(result.pagination.stopReason, "item-limit");
  assert.equal(result.worksCoverage, "latest-public-window");
});

test("pagination: default page ceiling is three even when the upstream still has more", async () => {
  const page = new Page(body([1], 10), p => p.respond(p.wheels * 10, body([p.wheels + 1], (p.wheels + 1) * 10)));
  const result = await run(page);
  assert.equal(page.wheels, 2); assert.equal(result.posts.length, 3);
  assert.equal(result.pagination.pages.length, 3); assert.equal(result.pagination.stopReason, "page-limit");
  assert.equal(result.worksCoverage, "latest-public-window");
});

test("pagination: repeated next cursor halts before any repeated scroll or invented end", async () => {
  const page = new Page(body([1], 10), p => p.respond(10, body([2], 10)));
  const result = await run(page);
  assert.equal(page.wheels, 1); assert.equal(result.pagination.stopReason, "cursor-not-progressing");
  assert.equal(result.hasMore, true); assert.equal(result.worksCoverage, "latest-public-window");
});

test("pagination: unknown has_more remains null and cannot trigger scrolling or completeness", async () => {
  const payload = body([1], 10); delete payload.has_more;
  const page = new Page(payload); const result = await run(page);
  assert.equal(page.wheels, 0); assert.equal(result.hasMore, null);
  assert.equal(result.pagination.pages[0].response.has_more, null);
  assert.equal(result.pagination.stopReason, "unknown-pagination");
});

test("pagination: cross-page duplicates are counted and deduplicated without a false complete claim", async () => {
  const page = new Page(body([1, 2], 10), p => p.respond(10, body([2, 3], 0, false)));
  const result = await run(page);
  assert.equal(result.posts.length, 3); assert.equal(result.pagination.pages[1].duplicateCount, 1);
  assert.equal(result.pagination.pages[1].acceptedCount, 1); assert.equal(result.worksCoverage, "latest-public-window");
});

test("pagination: bad continuation account/frame/cursor/response identity never reach JSON", async () => {
  const page = new Page(body([1], 10), p => {
    if (p.wheels !== 1) return;
    p.respond(11, body([7], 0, false));
    p.respond(10, body([8], 0, false), { request: p.request(10, { url: () => works(10, OTHER) }), status: 403 });
    p.respond(10, body([9], 0, false), { request: p.request(10, { frame: () => ({ url: () => profile(SEC) }) }), status: 403 });
    p.respond(10, body([10], 0, false), { url: works(20) });
    p.respond(10, body([2], 0, false));
  });
  const result = await run(page);
  assert.equal(result.status, "ok"); assert.equal(result.posts.length, 2); assert.equal(page.reads, 2);
  assert.equal(result.errorCode, undefined); assert.equal(result.worksCoverage, "complete");
});

test("pagination: all bound HTTP refusals stop scrolling and preserve only already verified pages", async t => {
  for (const [status, code] of [[401, "login_required"], [403, "blocked"], [429, "rate_limited"], [503, "network_error"]]) await t.test(String(status), async () => {
    const page = new Page(body([1], 10), p => {
      p.respond(10, null, { status, json: () => { throw new Error("PRIVATE_SECRET refused body"); } });
      p.respond(10, body([2], 0, false));
    });
    const result = await run(page);
    assert.equal(result.status, "ok"); assert.equal(result.worksCoverage, "latest-public-window");
    assert.equal(result.posts.length, 1); assert.equal(result.errorCode, code);
    assert.equal(result.pagination.errorCode, code); assert.equal(result.pagination.stopReason, "http-rejection");
    assert.equal(page.wheels, 1); assert.equal(page.reads, 1); clean(page, result);
  });
});

test("pagination: explicit login and verification fields stop even an HTTP200 status0 payload", async t => {
  for (const [field, code] of [["need_login", "login_required"], ["login_required", "login_required"], ["captcha_required", "blocked"], ["verify_required", "blocked"]]) await t.test(field, async () => {
    const page = new Page(body([1], 10), p => p.respond(10, { ...body([2], 0, false), [field]: true }));
    const result = await run(page);
    assert.equal(result.posts.length, 1); assert.equal(result.errorCode, code);
    assert.equal(page.wheels, 1); assert.equal(result.worksCoverage, "latest-public-window");
  });
});

test("pagination: navigation changes cannot combine rows across generations", async () => {
  const page = new Page(body([1], 10), p => { p.navigate(); p.respond(0, body([2], 0, false)); });
  const result = await run(page);
  assert.equal(result.status, "ok"); assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].statistics.digg_count, 1); assert.equal(result.worksCoverage, "latest-public-window");
  assert.equal(result.errorCode, "collector_error"); assert.equal(page.reads, 1); clean(page, result);
});

test("pagination: navigation to another account or login preserves only the already validated original page", async t => {
  for (const [url, code] of [[profile(OTHER), "collector_error"], ["https://www.douyin.com/passport/login", "login_required"], ["https://www.douyin.com/verify/", "blocked"]]) await t.test(code, async () => {
    const page = new Page(body([1], 10), p => { p.navigate(url); p.respond(10, body([2], 0, false)); });
    const result = await run(page);
    assert.equal(result.status, "ok"); assert.equal(result.posts.length, 1);
    assert.equal(result.posts[0].author.sec_uid, SEC); assert.equal(result.pagination.pages.length, 1);
    assert.equal(result.errorCode, code); assert.equal(result.worksCoverage, "latest-public-window");
    assert.equal(page.reads, 1); assert.equal(page.wheels, 1); clean(page, result);
  });
});

test("pagination: no physical progress stops after one ordinary scroll, bounded and not an empty archive", async () => {
  const page = new Page(body([1], 10)); const start = Date.now();
  const result = await run(page);
  assert.ok(Date.now() - start < 500); assert.equal(page.wheels, 1);
  assert.equal(result.posts.length, 1); assert.equal(result.pagination.stopReason, "page-timeout");
  assert.equal(result.errorCode, "collector_error", "no continuation request is not evidence of network failure");
  assert.equal(result.worksCoverage, "latest-public-window"); clean(page, result);
});

test("pagination: cancellation during mouse movement prevents the wheel and all later results", async () => {
  const controller = new AbortController(); const page = new Page(body([1], 10));
  page.mouse.move = async () => controller.abort();
  const result = await run(page, { options: { signal: controller.signal } });
  assert.equal(page.wheels, 0); assert.equal(result.posts.length, 1);
  assert.equal(result.pagination.stopReason, "cancelled"); assert.equal(result.worksCoverage, "latest-public-window");
  clean(page, result);
});

test("pagination: cancellation also interrupts a stalled initial navigation", async () => {
  const controller = new AbortController(); const page = new Page();
  page.goto = () => { setTimeout(() => controller.abort(), 5); return new Promise(() => {}); };
  const start = Date.now(); const result = await run(page, { options: { signal: controller.signal, timeoutMs: 2000 } });
  assert.ok(Date.now() - start < 200); assert.equal(result.status, "unavailable");
  assert.equal(result.pagination.stopReason, "cancelled"); assert.equal(page.wheels, 0);
  assert.equal(result.failureDiagnostics.navigation.timedOut, false); clean(page, result);
});

test("pagination: a hanging wheel cannot consume beyond the total budget", async () => {
  const page = new Page(body([1], 10)); page.mouse.wheel = () => new Promise(() => {});
  const start = Date.now(); const result = await run(page, { options: { timeoutMs: 45 } });
  assert.ok(Date.now() - start < 250); assert.equal(result.posts.length, 1);
  assert.equal(result.worksCoverage, "latest-public-window"); clean(page, result);
});

test("pagination: missing, duplicate, noncanonical and unsafe cursors remain unbound", () => {
  for (const value of [works("00"), works("1e2"), works(-1), works("9007199254740992"), `${works(10)}&max_cursor=10`, works(10).replace("max_cursor=10&", "")]) {
    assert.equal(browserWorksCursor(value, SEC), null);
  }
  assert.equal(browserWorksCursor(works(10), SEC), 10);
});

test("pagination: provider-facing page evidence is credential-free and strips unsolicited fields", async () => {
  const page = new Page(body([1], 10), p => p.respond(10, body([2], 0, false)));
  const result = await run(page);
  result.pagination.cookie = "PRIVATE_SECRET"; result.pagination.pages[0].url = works(0);
  result.pagination.pages[0].response.body = "PRIVATE_SECRET";
  const safe = sanitizeBrowserWorksPagination(result.pagination);
  assert.equal(safe.pages.length, 2); assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_SECRET|signature|cookie|https:/);
});

test("pagination: collectBrowserWorks public path preserves multi-page evidence without a real browser or state read", async () => {
  const page = new Page(body([1], 10), p => p.respond(10, body([2], 0, false))); page.close = async () => {};
  const context = { newPage: async () => page, close: async () => {} };
  const browser = { newContext: async () => context, close: async () => {} };
  const result = await collectBrowserWorks({ items: [item] }, { runtime: { readState: async () => ({ cookies: [] }),
    access: async () => {}, launch: async () => browser }, collectOptions: options });
  assert.equal(result.items[0].pagination.pages.length, 2); assert.equal(result.items[0].posts.length, 2);
});
