import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { collectOne } from "../scripts/douyin_browser_collector.mjs";

// Frozen counterexamples: no browser, network, credentials or DB.
const SEC = "MS4wLjABAAAATestClassificationAccount123456";
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const WORKS = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0`;
const PRIVATE = "PRIVATE_DO_NOT_PERSIST";
class Page extends EventEmitter {
  constructor(scenario) { super();this.scenario = scenario;this.current = "about:blank";this.frame = { url: () => this.current };this.reads = 0; }
  mainFrame() { return this.frame; }
  url() { return this.current; }
  request(url = WORKS, navigation = false) { return { url: () => url, frame: () => this.frame,
    method: () => "GET", isNavigationRequest: () => navigation, failure: () => { throw new Error("must not read failure text"); } }; }
  async goto() {
    if (this.scenario === "goto-TypeError") throw new TypeError(PRIVATE);
    this.emit("request", this.request(PROFILE, true));this.current = PROFILE;this.emit("framenavigated", this.frame);
    if (this.scenario === "page-TypeError") { this.pageErrorListeners = this.listenerCount("pageerror");this.emit("pageerror", new TypeError(PRIVATE)); }
    if (this.scenario === "bound-failed") { const request = this.request();this.emit("request", request);
      this.failedListeners = this.listenerCount("requestfailed");this.emit("requestfailed", request); }
    if (["403", "401", "2483"].includes(this.scenario)) {
      const request = this.request();this.emit("request", request);
      this.emit("response", { request: () => request, url: () => WORKS,
        status: () => this.scenario === "2483" ? 200 : Number(this.scenario),
        json: async () => { this.reads++;return { status_code: 2483, status_msg: PRIVATE, aweme_list: [], has_more: 0 }; } });
    }
  }
}
async function observe(scenario) {
  const page = new Page(scenario);
  const result = await collectOne(page, { key: "fixture", secUid: SEC, limit: 30 },
    { timeoutMs: 80, bodyTimeoutMs: 30, failureGraceMs: 1 });
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  assert.equal(result.status, "unavailable");assert.equal(result.worksCoverage, "unavailable");assert.deepEqual(result.posts, []);
  for (const event of ["request", "response", "framenavigated", "pageerror", "requestfailed"]) assert.equal(page.listenerCount(event), 0);
  return { page, result };
}

test("audit baseline: no observed work request is not evidence of an HTTP or authentication rejection", async () => {
  const { result } = await observe("idle");
  assert.equal(result.errorCode, "collector_error", "no observed request cannot establish a network failure");
  assert.equal(result.failureDiagnostics.stopReason, "no-bound-request");
  assert.equal(result.failureDiagnostics.requests.candidate, 0);
  assert.deepEqual(result.failureDiagnostics.httpStatuses, []);assert.deepEqual(result.failureDiagnostics.businessStatusCodes, []);
  assert.equal(result.failureDiagnostics.navigation.committed, true);
});

test("page runtime TypeError with no request is counted without claiming a network cause", async () => {
  const { page, result } = await observe("page-TypeError");
  assert.equal(page.pageErrorListeners, 1);
  assert.equal(result.errorCode, "collector_error");assert.equal(result.failureDiagnostics.stopReason, "no-bound-request");
  assert.equal(result.failureDiagnostics.runtime.pageErrorCount, 1);
  assert.deepEqual(result.failureDiagnostics.runtime.pageErrorKinds, ["type-error"]);
});

test("navigation TypeError retains its finite kind without changing the legacy network category", async () => {
  const { result } = await observe("goto-TypeError");
  assert.equal(result.errorCode, "network_error");assert.equal(result.failureDiagnostics.stopReason, "navigation-failed");
  assert.equal(result.failureDiagnostics.navigation.failed, true);assert.equal(result.failureDiagnostics.navigation.timedOut, false);
  assert.equal(result.failureDiagnostics.runtime.navigationErrorKind, "type-error");
});

test("a bound requestfailed event is counted without reading its error text or changing retry classification", async () => {
  const { page, result } = await observe("bound-failed");
  assert.equal(page.failedListeners, 1);assert.equal(result.errorCode, "network_error");
  assert.equal(result.failureDiagnostics.requests.matched, 1);assert.equal(result.failureDiagnostics.responses.matched, 0);
  assert.equal(result.failureDiagnostics.stopReason, "deadline");
  assert.equal(result.failureDiagnostics.runtime.boundRequestFailedCount, 1);
});

test("audit baseline: actual bound HTTP rejection remains distinct without reading its body", async () => {
  for (const [status, expected] of [["403", "blocked"], ["401", "login_required"]]) {
    const { page, result } = await observe(status);
    assert.equal(result.errorCode, expected);assert.equal(result.failureDiagnostics.stopReason, "http-rejection");
    assert.deepEqual(result.failureDiagnostics.httpStatuses, [Number(status)]);assert.equal(page.reads, 0);
  }
});

test("audit baseline: strictly bound author-posts code 2483 requires login but never proves empty works", async () => {
  const { result } = await observe("2483");
  assert.equal(result.errorCode, "login_required");assert.equal(result.failureDiagnostics.stopReason, "invalid-body");
  assert.deepEqual(result.failureDiagnostics.httpStatuses, [200]);assert.deepEqual(result.failureDiagnostics.businessStatusCodes, [2483]);
});
