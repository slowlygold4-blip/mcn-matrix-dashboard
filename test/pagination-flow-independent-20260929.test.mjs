import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { collectOne } from "../scripts/douyin_browser_collector.mjs";
import { evaluateQualifiedPagination } from "./helpers/qualified-pagination-page.mjs";

const SEC = "MS4wLjABAAAAIndependentPaginationFixture123";
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const url = cursor => `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=${cursor}`;
const payload = (ids, next, hasMore) => ({ status_code: 0, max_cursor: next, has_more: hasMore,
  aweme_list: ids.map(id => ({ aweme_id: String(7200000000000000000n + BigInt(id)), author: { sec_uid: SEC, uid: "1234567890" }, statistics: { digg_count: id } })) });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

class OfflinePage extends EventEmitter {
  constructor(onWheel) {
    super(); this.address = "about:blank"; this.frame = { url: () => this.address };
    this.wheels = 0; this.reads = 0; this.onWheel = onWheel;
    this.mouse = { move: async () => {}, wheel: async () => { this.wheels++; this.onWheel?.(this); } };
  }
  mainFrame() { return this.frame; }
  url() { return this.address; }
  viewportSize() { return { width: 1280, height: 720 }; }
  async evaluate(fn, arg) { return evaluateQualifiedPagination(fn, arg, this.address); }
  navigateProfile() {
    const documentRequest = { url: () => PROFILE, frame: () => this.frame, method: () => "GET", isNavigationRequest: () => true };
    this.emit("request", documentRequest); this.address = PROFILE;
    this.emit("response", { request: () => documentRequest, url: documentRequest.url, status: () => 200 });
    this.emit("framenavigated", this.frame);
  }
  request(cursor) {
    const request = { url: () => url(cursor), frame: () => this.frame, method: () => "GET", isNavigationRequest: () => false };
    this.emit("request", request); return request;
  }
  respond(request, json, status = 200) {
    this.emit("response", { request: () => request, url: request.url, status: () => status,
      json: async () => { this.reads++; return json(); } });
  }
  async goto() {
    this.navigateProfile();
    this.respond(this.request(0), () => payload([1, 2], 100, true));
  }
}
const options = { timeoutMs: 700, pageWaitMs: 100, bodyTimeoutMs: 350, failureGraceMs: 1 };
const run = (page, changes = {}) => collectOne(page, { key: "offline-only", secUid: SEC, limit: 30 }, { ...options, ...changes });
const cleaned = page => {
  for (const name of ["request", "response", "requestfailed", "framenavigated", "domcontentloaded", "pageerror"]) assert.equal(page.listenerCount(name), 0, name);
};
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test("independent: production defaults keep a normal four-second continuation body after the three-second request wait", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date("2026-09-28T00:00:00.000Z") });
  const page = new OfflinePage(p => {
    if (p.wheels === 1) p.respond(p.request(100), async () => { await pause(4_000); return payload([3], 0, false); });
  });
  let finished = false;
  const promise = collectOne(page, { key: "offline-default-budget", secUid: SEC, limit: 30 });
  void promise.then(() => { finished = true; });
  await drain(); assert.equal(page.wheels, 1);
  t.mock.timers.tick(3_001); await drain();
  assert.equal(finished, false, "HTTP200 current-cursor body remains under its existing 25s/45s limits");
  assert.equal(page.wheels, 1);
  t.mock.timers.tick(999); await drain(); t.mock.timers.tick(20); await drain();
  const result = await promise;
  assert.equal(result.pagination.pages.length, 2); assert.equal(result.posts.length, 3);
  assert.equal(result.worksCoverage, "complete"); cleaned(page);
});

test("independent: normal bound second-page body may finish after request-wait budget but within its body and total budgets", async () => {
  const page = new OfflinePage(p => {
    if (p.wheels !== 1) return;
    p.respond(p.request(100), async () => { await pause(180); return payload([3, 4], 0, false); });
  });
  const result = await run(page);
  assert.equal(result.worksCoverage, "complete", "a timely bound HTTP200 must not be discarded while its existing body budget is active");
  assert.deepEqual(result.posts.map(post => post.statistics.digg_count), [1, 2, 3, 4]);
  assert.equal(result.pagination.pages.length, 2);
  assert.equal(result.pagination.stopReason, "end-of-list");
  assert.equal(page.wheels, 1, "do not scroll again while current continuation body is pending");
  assert.equal(page.reads, 2); cleaned(page);
});

test("independent: a continuation request without response still stops at the original bounded page wait", async () => {
  const page = new OfflinePage(p => { if (p.wheels === 1) p.request(100); });
  const start = Date.now(); const result = await run(page);
  assert.ok(Date.now() - start < 400);
  assert.equal(result.posts.length, 2);
  assert.equal(result.worksCoverage, "latest-public-window");
  assert.equal(result.pagination.stopReason, "page-timeout");
  assert.equal(result.errorCode, "network_error"); cleaned(page);
});

test("independent: an old first-page duplicate body cannot extend the next-cursor request wait", async () => {
  const page = new OfflinePage();
  page.goto = async () => {
    page.navigateProfile();
    page.respond(page.request(0), () => new Promise(() => {}));
    page.respond(page.request(0), () => payload([1, 2], 100, true));
  };
  const start = Date.now(); const result = await run(page);
  assert.ok(Date.now() - start < 300, "old-cursor body must not hold the 350ms body budget for cursor 100");
  assert.equal(result.posts.length, 2); assert.equal(result.pagination.pages.length, 1);
  assert.equal(result.pagination.stopReason, "page-timeout"); assert.equal(result.errorCode, "collector_error");
  assert.equal(page.wheels, 1, "no physical movement must not authorize a repeated wheel"); assert.equal(page.reads, 2); cleaned(page);
});

test("independent: pending continuation cannot exceed body timeout or become an invented empty/end page", async () => {
  const page = new OfflinePage(p => { if (p.wheels === 1) p.respond(p.request(100), () => new Promise(() => {})); });
  const start = Date.now(); const result = await run(page, { bodyTimeoutMs: 60 });
  assert.ok(Date.now() - start < 400);
  assert.equal(result.posts.length, 2); assert.equal(result.pagination.pages.length, 1);
  assert.equal(result.errorCode, "network_error"); assert.equal(result.hasMore, true);
  assert.equal(result.worksCoverage, "latest-public-window"); cleaned(page);
});

test("independent: refusal invalidates a pending success body and no third wheel occurs", async () => {
  const page = new OfflinePage(p => {
    if (p.wheels !== 1) return;
    p.respond(p.request(100), async () => { await pause(180); return payload([3, 4], 0, false); });
    setTimeout(() => p.respond(p.request(100), () => { throw new Error("refusal body must never be read"); }, 403), 20);
  });
  const result = await run(page);
  assert.equal(result.posts.length, 2); assert.equal(result.pagination.pages.length, 1);
  assert.equal(result.errorCode, "blocked"); assert.equal(page.reads, 2);
  assert.equal(page.wheels, 1); assert.equal(result.worksCoverage, "latest-public-window"); cleaned(page);
});

test("independent: a pending continuation still cannot extend the overall collection deadline", async () => {
  const page = new OfflinePage(p => {
    if (p.wheels === 1) p.respond(p.request(100), async () => { await pause(180); return payload([3], 0, false); });
  });
  const start = Date.now(); const result = await run(page, { timeoutMs: 80, pageWaitMs: 30 });
  assert.ok(Date.now() - start < 250);
  assert.equal(result.posts.length, 2); assert.equal(result.pagination.pages.length, 1);
  assert.equal(result.worksCoverage, "latest-public-window"); assert.equal(page.wheels, 1);
  assert.ok(["deadline", "page-timeout"].includes(result.pagination.stopReason));
  cleaned(page);
});

test("independent: cancellation or replacement navigation invalidates an in-flight continuation", async t => {
  for (const operation of ["cancel", "navigate"]) await t.test(operation, async () => {
    const controller = new AbortController();
    const page = new OfflinePage(p => {
      if (p.wheels !== 1) return;
      p.respond(p.request(100), async () => { await pause(180); return payload([3], 0, false); });
      setTimeout(() => {
        if (operation === "cancel") controller.abort();
        else {
          const address = "https://www.douyin.com/user/MS4wLjABAAAAAnotherAccount1234567";
          p.emit("request", { url: () => address, frame: () => p.frame, isNavigationRequest: () => true });
          p.address = address; p.emit("framenavigated", p.frame);
          p.respond(p.request(100), () => payload([4], 0, false));
        }
      }, 20);
    });
    const result = await run(page, { signal: controller.signal });
    assert.equal(result.posts.length, 2); assert.equal(result.pagination.pages.length, 1);
    assert.equal(result.pagination.stopReason, operation === "cancel" ? "cancelled" : "navigation-changed");
    assert.equal(result.worksCoverage, "latest-public-window"); assert.equal(page.wheels, 1);
    assert.equal(page.reads, 2); cleaned(page);
  });
});
