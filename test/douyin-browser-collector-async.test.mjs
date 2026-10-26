import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { collectOne, collectBrowserWorks, normalizeBrowserWorks } from "../scripts/douyin_browser_collector.mjs";
import { isExpectedDouyinFirstWorksResponseUrl } from "../lib/douyin-browser-response-identity.mjs";

const SEC = "MS4wLjABAAAAabcdefghijklmnopqrstuvwx";
const OTHER = "MS4wLjABBBBBzyxwvutsrqponmlkjihgfedcba";
const endpoint = "https://www.douyin.com/aweme/v1/web/aweme/post/";
const worksUrl = (sec = SEC) => `${endpoint}?sec_user_id=${sec}&max_cursor=0&count=30&a_bogus=[REDACTED]
const profileUrl = (sec = SEC) => `https://www.douyin.com/user/${sec}`;
const item = { key: "account-a", secUid: SEC, limit: 30 };
const options = { timeoutMs: 180, bodyTimeoutMs: 120, failureGraceMs: 1 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const post = (sec = SEC) => ({ aweme_id: "12345678901234567", author: { sec_uid: sec }, statistics: { digg_count: 7 } });
const good = (sec = SEC) => ({ status_code: 0, aweme_list: [post(sec)], has_more: 0, max_cursor: 0 });
const drainMicrotasks = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

// Real EventEmitter semantics: callbacks are synchronous notifications; emitter
// never awaits listener promises. Deferred bodies settle independently of goto.
class EventPage extends EventEmitter {
  constructor(scenario = () => {}) {
    super(); this.scenario = scenario; this.currentUrl = "about:blank"; this.reads = 0; this.closed = 0;
    this.frame = { url: () => this.currentUrl };
  }
  mainFrame() { return this.frame; }
  url() { return this.currentUrl; }
  request(url, { frame = this.frame, method = "GET", navigation = false } = {}) {
    return { url: () => url, frame: () => frame, method: () => method, isNavigationRequest: () => navigation };
  }
  navigate(url) {
    this.emit("request", this.request(url, { navigation: true }));
    this.currentUrl = url; this.emit("framenavigated", this.frame);
  }
  respond({ request = this.request(worksUrl()), requestEvent = true, url = request.url(), status = 200, body = good(), json } = {}) {
    if (requestEvent) this.emit("request", request);
    const response = { request: () => request, url: () => url, status: () => status, json: () => { this.reads += 1; return json ? json() : Promise.resolve(body); } };
    this.emit("response", response);
    return response;
  }
  async goto(url) { this.navigate(url); return this.scenario(this); }
  async close() { this.closed += 1; }
}
function assertClean(page) {
  for (const name of ["request", "response", "framenavigated"]) assert.equal(page.listenerCount(name), 0, name);
}

test("HTTP success alone and empty error bodies can never prove empty or complete works", () => {
  for (const status_code of [undefined, null, 8, 100, -1, "0", false]) {
    assert.throws(() => normalizeBrowserWorks({ status_code, aweme_list: [], has_more: 0 }, SEC), /业务成功/);
  }
  assert.equal(normalizeBrowserWorks({ status_code: 0, aweme_list: [], has_more: 0 }, SEC).coverage, "complete");
  assert.equal(normalizeBrowserWorks({ status_code: 0, aweme_list: [] }, SEC).coverage, "latest-public-window");
  assert.throws(() => normalizeBrowserWorks({ status_code: 0, aweme_list: [post(OTHER)], has_more: 0 }, SEC), /有效作品/);
});

test("a bound HTTP200 business failure stops before a deferred legitimate body can replace it", async () => {
  const body = deferred();
  const page = new EventPage((p) => {
    p.respond({ json: () => body.promise });
    p.respond({ body: { status_code: 8, status_msg: "PRIVATE", aweme_list: [], has_more: 0 } });
    setTimeout(() => body.resolve(good()), 35);
  });
  const result = await collectOne(page, item, options);
  assert.equal(result.status, "unavailable"); assert.equal(result.posts.length, 0); assert.equal(result.worksCoverage, "unavailable");
  assert.equal(result.errorCode, "upstream_changed");
  assert.equal(page.reads, 2); assertClean(page);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  const frozen = JSON.stringify(result); await sleep(45);
  assert.equal(JSON.stringify(result), frozen, "late successful JSON cannot erase a bound business rejection");
});

test("default budget retains a legitimate 12 s body after an 18 s navigation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date("2026-09-28T00:00:00.000Z") });
  const page = new EventPage();
  page.goto = async (url, navigationOptions) => {
    assert.equal(navigationOptions.timeout, 20_000);
    await sleep(18_000); page.navigate(url);
    page.respond({ json: async () => { await sleep(12_000); return good(); } });
  };
  const resultPromise = collectOne(page, item); let finished = false;
  void resultPromise.then(() => { finished = true; });
  await drainMicrotasks(); t.mock.timers.tick(18_000); await drainMicrotasks();
  t.mock.timers.tick(10_001); await drainMicrotasks();
  assert.equal(finished, false, "neither the previous 25 s total nor 10 s body candidate limit may end a valid wait");
  t.mock.timers.tick(1_999); await drainMicrotasks(); t.mock.timers.tick(20); await drainMicrotasks();
  const result = await resultPromise;
  assert.equal(result.status, "ok"); assert.equal(result.posts.length, 1); assertClean(page);
});

test("fast navigation keeps the original 25 s response window rather than waiting the full 45 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date("2026-09-28T00:00:00.000Z") });
  const page = new EventPage(); const resultPromise = collectOne(page, item); let finished = false;
  void resultPromise.then(() => { finished = true; }); await drainMicrotasks();
  t.mock.timers.tick(24_999); await drainMicrotasks(); assert.equal(finished, false);
  t.mock.timers.tick(1); await drainMicrotasks();
  assert.equal((await resultPromise).status, "unavailable"); assertClean(page);
});

test("a body still pending after the total 45 s ceiling cannot turn into late success", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date("2026-09-28T00:00:00.000Z") });
  const body = deferred(); const page = new EventPage();
  page.goto = async (url) => { await sleep(19_000); page.navigate(url); page.respond({ json: () => body.promise }); };
  const resultPromise = collectOne(page, item); await drainMicrotasks();
  t.mock.timers.tick(19_000); await drainMicrotasks();
  t.mock.timers.tick(25_000); await drainMicrotasks();
  // This is44s, not45s. A received2xx body now owns the original25s
  // body timeout plus the existing failure grace, never past45s in total.
  t.mock.timers.tick(1_000); await drainMicrotasks();
  const result = await resultPromise; assert.equal(result.status, "unavailable"); assertClean(page);
  assert.equal(result.failureDiagnostics.responses.bodyTimeouts, 1);
  assert.ok(result.failureDiagnostics.elapsedMs <= 45_000);
  assert.deepEqual(result.posts, []);
  body.resolve(good()); await drainMicrotasks(); assert.equal(result.status, "unavailable");
});

test("bound 401, 403, or 429 stops collection and cannot be replaced by a pending legitimate body", async (t) => {
  for (const status of [401, 403, 429]) await t.test(String(status), async () => {
    const body = deferred();
    const page = new EventPage((p) => {
      p.respond({ json: () => body.promise }); p.respond({ status });
      setTimeout(() => body.resolve(good()), 30);
    });
    const result = await collectOne(page, item, options);
    assert.equal(result.status, "unavailable"); assert.equal(page.reads, 1); assertClean(page);
    assert.equal(result.errorCode, { 401: "login_required", 403: "blocked", 429: "rate_limited" }[status]);
    assert.deepEqual(result.posts, []); assert.equal(result.worksCoverage, "unavailable");
    const frozen = JSON.stringify(result); await sleep(40);
    assert.equal(JSON.stringify(result), frozen, "late JSON cannot override the refusal");
  });
});

test("invalid account, origin and first-cursor requests never reach response.json", async () => {
  const rejected = [
    worksUrl(OTHER), worksUrl().replace("www.douyin.com", "evil.example"),
    worksUrl().replace("https://", "https://user:secret@"), worksUrl().replace(".com/", ".com:444/"),
    worksUrl().replace(`sec_user_id=${SEC}`, `sec_uid=${SEC}`),
    `${worksUrl()}&sec_user_id=${SEC}`, `${worksUrl()}&sec_user_id=${OTHER}`,
    worksUrl().replace("max_cursor=0", "max_cursor=900"), worksUrl().replace("&max_cursor=0", ""),
    worksUrl().replace("max_cursor=0", "max_cursor=00"), `${worksUrl()}&max_cursor=0`,
  ];
  const page = new EventPage((p) => {
    for (const url of rejected) p.respond({ request: p.request(url) });
    p.respond();
  });
  const result = await collectOne(page, item, options);
  assert.equal(result.status, "ok"); assert.equal(page.reads, 1); assertClean(page);
  for (const url of rejected) assert.equal(isExpectedDouyinFirstWorksResponseUrl(url, SEC), false, url);
});

test("response identity is checked independently of the request identity", async () => {
  const page = new EventPage((p) => { p.respond({ url: worksUrl(OTHER) }); p.respond(); });
  assert.equal((await collectOne(page, item, options)).status, "ok"); assert.equal(page.reads, 1); assertClean(page);
});

test("requests absent from current listener, wrong frame, pre-commit, and non-GET are ignored", async () => {
  const page = new EventPage((p) => {
    p.respond({ requestEvent: false });
    p.respond({ request: p.request(worksUrl(), { frame: { url: () => profileUrl() } }) });
    p.respond({ request: p.request(worksUrl(), { method: "POST" }) });
    p.respond({ request: { ...p.request(worksUrl()), frame: () => { throw new Error("service worker"); } } });
    p.emit("request", p.request(profileUrl(), { navigation: true }));
    p.respond(); // A request after navigation started but before commit is not proof.
    p.emit("framenavigated", p.frame);
    p.respond();
  });
  const result = await collectOne(page, item, options);
  assert.equal(result.status, "ok"); assert.equal(page.reads, 1); assertClean(page);
});

test("same-account stale response from before a new navigation is invalidated", async () => {
  const stale = deferred();
  const page = new EventPage((p) => {
    p.respond({ json: () => stale.promise });
    p.navigate(profileUrl());
    p.respond({ body: { status_code: 8, aweme_list: [], has_more: 0 } });
    setTimeout(() => stale.resolve(good()), 5);
  });
  const result = await collectOne(page, item, options);
  assert.equal(result.status, "unavailable"); assert.equal(result.errorCode, "upstream_changed"); assertClean(page);
});

test("navigation to login keeps only already verified original works as partial and rejects new bodies", async () => {
  const page = new EventPage(async (p) => {
    p.respond(); await sleep(1); p.navigate("https://www.douyin.com/passport/web/login/"); p.respond();
  });
  const result = await collectOne(page, item, { ...options, timeoutMs: 45 });
  assert.equal(result.status, "ok"); assert.equal(result.errorCode, "login_required"); assertClean(page);
  assert.equal(result.worksCoverage, "latest-public-window"); assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].author.sec_uid, SEC); assert.equal(page.reads, 1, "the post-login body is never read");
  assert.equal(result.pagination.stopReason, "login-required");
});

test("business-only failures preserve unavailable rather than a fabricated zero inventory", async () => {
  const page = new EventPage((p) => p.respond({ body: { status_code: 8, aweme_list: [], has_more: 0 } }));
  const result = await collectOne(page, item, options);
  assert.equal(result.status, "unavailable"); assert.equal(result.worksCoverage, "unavailable");
  assert.equal(result.errorCode, "upstream_changed"); assert.equal(result.hasMore, undefined); assertClean(page);
});

test("HTTP rejection is typed without reading or leaking its response body", async () => {
  const page = new EventPage((p) => p.respond({ status: 403, json: () => { throw new Error("PRIVATE_BODY"); } }));
  const result = await collectOne(page, item, options);
  assert.equal(result.status, "unavailable"); assert.equal(result.errorCode, "blocked"); assert.equal(page.reads, 0);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false); assertClean(page);
});

test("body rejection and synchronous JSON error are contained and sanitized", async (t) => {
  for (const json of [() => { throw new Error("PRIVATE_COOKIE"); }, () => Promise.reject(new Error("PRIVATE_SIGNATURE"))]) await t.test("contained", async () => {
    const page = new EventPage((p) => p.respond({ json }));
    const result = await collectOne(page, item, options);
    assert.equal(result.status, "unavailable"); assert.equal(result.errorCode, "upstream_changed");
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false); assertClean(page);
  });
});

test("hung JSON is bounded, cleaned up and cannot later mutate the returned result", async () => {
  const body = deferred(); const start = Date.now();
  const page = new EventPage((p) => p.respond({ json: () => body.promise }));
  const result = await collectOne(page, item, { ...options, timeoutMs: 80, bodyTimeoutMs: 30 });
  const frozen = JSON.stringify(result);
  assert.equal(result.status, "unavailable"); assert.ok(Date.now() - start < 500); assertClean(page);
  body.resolve(good()); await sleep(10);
  assert.equal(JSON.stringify(result), frozen); assert.equal(result.worksCoverage, "unavailable");
});

test("hung navigation is bounded and detached even with no response events", async () => {
  const page = new EventPage(() => new Promise(() => {})); const start = Date.now();
  const result = await collectOne(page, item, { ...options, timeoutMs: 30 });
  assert.equal(result.status, "unavailable"); assert.ok(Date.now() - start < 500); assertClean(page);
});

test("one Request can only be consumed once and event flood has a finite body-read budget", async () => {
  const page = new EventPage((p) => {
    const request = p.request(worksUrl()); p.respond({ request }); p.respond({ request, requestEvent: false });
    for (let i = 0; i < 40; i += 1) p.respond();
  });
  const result = await collectOne(page, item, options);
  assert.equal(result.status, "ok"); assert.equal(page.reads, 32); assertClean(page);
});

function mockRuntime(scenario) {
  const pages = []; let contextsClosed = 0, browsersClosed = 0;
  const context = {
    newPage: async () => { const page = new EventPage(scenario); pages.push(page); return page; },
    close: async () => { contextsClosed += 1; },
  };
  const browser = { newContext: async () => context, close: async () => { browsersClosed += 1; } };
  return {
    pages, context, browser, closed: () => ({ contextsClosed, browsersClosed }),
    runtime: { readState: async () => ({ cookies: [{ name: "fixture", value: "not-a-credential" }] }), access: async () => {}, launch: async () => browser },
  };
}

test("each account gets a separate page and a stored session never proves authentication", async () => {
  const fixture = mockRuntime((p) => {
    const sec = p.url().split("/").at(-1);
    p.respond({ request: p.request(worksUrl(sec)), status: 401 });
  });
  const result = await collectBrowserWorks({ items: [item, { key: "b", secUid: OTHER }] }, { runtime: fixture.runtime, collectOptions: options });
  assert.equal(fixture.pages.length, 2); assert.notEqual(fixture.pages[0], fixture.pages[1]);
  assert.deepEqual(result.items.map((row) => row.errorCode), ["login_required", "login_required"]);
  assert.equal(result.provenance.sessionLoaded, true); assert.equal(result.provenance.authenticated, null);
  assert.equal(result.provenance.authenticationStatus, "not-verified");
  for (const page of fixture.pages) { assertClean(page); assert.equal(page.closed, 1); }
  assert.deepEqual(fixture.closed(), { contextsClosed: 1, browsersClosed: 1 });
});

test("batch deadline bounds stalled page creation and late resources are closed", async () => {
  const fixture = mockRuntime(); const creation = deferred(); const latePage = new EventPage();
  fixture.context.newPage = () => creation.promise;
  const start = Date.now();
  const result = await collectBrowserWorks({ items: [item, { key: "b", secUid: OTHER }] }, {
    runtime: fixture.runtime, collectOptions: { ...options, batchTimeoutMs: 35 },
  });
  assert.ok(Date.now() - start < 500); assert.deepEqual(result.items.map((row) => row.status), ["unavailable", "unavailable"]);
  creation.resolve(latePage); await sleep(10); assert.equal(latePage.closed, 1);
  assert.deepEqual(fixture.closed(), { contextsClosed: 1, browsersClosed: 1 });
});

test("stalled context creation closes the browser and does not create any account page", async () => {
  const fixture = mockRuntime(); const creation = deferred(); fixture.browser.newContext = () => creation.promise;
  await assert.rejects(collectBrowserWorks({ items: [item] }, { runtime: fixture.runtime, collectOptions: { batchTimeoutMs: 30 } }), /超时/);
  assert.equal(fixture.pages.length, 0); assert.deepEqual(fixture.closed(), { contextsClosed: 0, browsersClosed: 1 });
  creation.resolve(fixture.context); await sleep(10); assert.deepEqual(fixture.closed(), { contextsClosed: 1, browsersClosed: 1 });
});

test("stalled browser launch is bounded and a late browser is closed", async () => {
  const fixture = mockRuntime(); const launch = deferred(); fixture.runtime.launch = () => launch.promise;
  await assert.rejects(collectBrowserWorks({ items: [item] }, { runtime: fixture.runtime, collectOptions: { batchTimeoutMs: 30 } }), /超时/);
  assert.equal(fixture.pages.length, 0); launch.resolve(fixture.browser); await sleep(10);
  assert.deepEqual(fixture.closed(), { contextsClosed: 0, browsersClosed: 1 });
});

test("stalled session or executable checks never launch a browser", async (t) => {
  for (const step of ["readState", "access"]) await t.test(step, async () => {
    const fixture = mockRuntime(); let launches = 0;
    fixture.runtime[step] = () => new Promise(() => {});
    fixture.runtime.launch = () => { launches += 1; return fixture.browser; };
    await assert.rejects(collectBrowserWorks({ items: [item] }, { runtime: fixture.runtime, collectOptions: { batchTimeoutMs: 30 } }), /超时/);
    assert.equal(launches, 0);
  });
});

test("hanging page, context and browser close operations cannot block delivery forever", async () => {
  const fixture = mockRuntime((p) => p.respond());
  const originalCreate = fixture.context.newPage;
  let pageCloseStarted = 0, contextCloseStarted = 0, browserCloseStarted = 0;
  fixture.context.newPage = async () => {
    const page = await originalCreate(); page.close = () => { pageCloseStarted += 1; return new Promise(() => {}); }; return page;
  };
  fixture.context.close = () => { contextCloseStarted += 1; return new Promise(() => {}); };
  fixture.browser.close = () => { browserCloseStarted += 1; return new Promise(() => {}); };
  const start = Date.now();
  const result = await collectBrowserWorks({ items: [item] }, { runtime: fixture.runtime, collectOptions: options });
  assert.equal(result.items[0].status, "ok"); assert.ok(Date.now() - start < 8_000);
  assert.equal(pageCloseStarted, 1); assert.equal(contextCloseStarted, 1); assert.equal(browserCloseStarted, 1);
  assertClean(fixture.pages[0]);
});
