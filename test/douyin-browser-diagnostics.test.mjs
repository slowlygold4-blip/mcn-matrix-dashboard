import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { collectOne, collectBrowserWorks } from "../scripts/douyin_browser_collector.mjs";
import { sanitizeBrowserWorksDiagnostics, unknownBrowserWorksDiagnostics } from "../lib/douyin-browser-diagnostics.mjs";

const SEC = "MS4wLjABAAAAabcdefghijklmnopqrstuvwx";
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const URL_WORKS = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0&signature=PRIVATE_SECRET`;
const item = { key: "fixture", secUid: SEC, limit: 30 };
const options = { timeoutMs: 80, bodyTimeoutMs: 25, failureGraceMs: 1 };
const good = { status_code: 0, aweme_list: [], has_more: 0 };
class Page extends EventEmitter {
  constructor(scenario = () => {}) { super(); this.scenario = scenario; this.address = "about:blank"; this.frame = { url: () => this.address }; }
  mainFrame() { return this.frame; }
  url() { return this.address; }
  request(url = URL_WORKS, extra = {}) { return { url: () => url, frame: () => this.frame, method: () => "GET", isNavigationRequest: () => false, ...extra }; }
  navigate(url = PROFILE) { this.emit("request", this.request(url, { isNavigationRequest: () => true })); this.address = url; this.emit("framenavigated", this.frame); }
  respond({ request = this.request(), status = 200, body = good, json } = {}) {
    this.emit("request", request); this.emit("response", { request: () => request, url: request.url, status: () => status, json: json || (() => Promise.resolve(body)) });
  }
  async goto(url) { this.navigate(url); return this.scenario(this); }
}
const run = (page) => collectOne(page, item, options);
function privateSafe(value) { assert.doesNotMatch(JSON.stringify(value), /PRIVATE_SECRET|signature|Cookie|https:|sec_user_id|status_msg/); }

test("diagnostics whitelist strips nested raw evidence and rejects invalid versions", () => {
  assert.equal(sanitizeBrowserWorksDiagnostics(null), null);
  assert.equal(sanitizeBrowserWorksDiagnostics({ version: 2 }), null);
  const result = sanitizeBrowserWorksDiagnostics({ version: 1, url: URL_WORKS, navigation: { observed: true, cookie: "PRIVATE_SECRET" },
    requests: { candidate: -1, matched: "4", rejected: { method: 0, raw: URL_WORKS } }, responses: { matched: Infinity },
    httpStatuses: [401, 401, 0, 700, "403"], businessStatusCodes: [2483, "0", -1], finalPageKind: URL_WORKS,
    stopReason: "PRIVATE_SECRET", elapsedMs: 900001 });
  assert.equal(result.navigation.observed, true); assert.equal(result.requests.matched, null); assert.equal(result.elapsedMs, null);
  assert.deepEqual(result.httpStatuses, [401]); assert.deepEqual(result.businessStatusCodes, [2483]); privateSafe(result);
});

test("no works request is distinguished from rejected official candidates", async () => {
  const noRequest = (await run(new Page())).failureDiagnostics;
  assert.equal(noRequest.requests.candidate, 0); assert.equal(noRequest.requests.matched, 0);
  const rejected = (await run(new Page((p) => {
    p.emit("request", p.request(URL_WORKS, { frame: () => ({ url: () => PROFILE }) }));
    p.emit("request", p.request(URL_WORKS, { method: () => "POST" }));
    p.emit("request", p.request(URL_WORKS.replace("max_cursor=0", "max_cursor=1")));
    p.emit("request", p.request(URL_WORKS.replace(SEC, "MS4wLjABBBBBzyxwvutsrqponmlkjihgfedcba")));
  }))).failureDiagnostics;
  assert.equal(rejected.requests.candidate, 4); assert.equal(rejected.requests.matched, 0);
  assert.deepEqual(rejected.requests.rejected, { nonMainFrame: 1, frameUnavailable: 0, beforeCommit: 0, accountIdentity: 1, firstCursor: 1, method: 1, capacity: 0 });
  assert.equal(rejected.stopReason, "no-bound-request"); privateSafe(rejected);
});

test("matched HTTP rejection is reported without reading its body", async () => {
  const result = await run(new Page((p) => p.respond({ status: 503, json: () => { throw new Error("must not read PRIVATE_SECRET"); } })));
  assert.equal(result.errorCode, "network_error"); assert.equal(result.failureDiagnostics.stopReason, "http-rejection");
  assert.deepEqual(result.failureDiagnostics.httpStatuses, [503]); assert.equal(result.failureDiagnostics.responses.matched, 1);
  assert.equal(result.failureDiagnostics.responses.invalidBodies, 0); privateSafe(result.failureDiagnostics);
});

test("bound author-posts code 2483 is an access requirement, never proof of successful authentication", async () => {
  const result = await run(new Page((p) => p.respond({ body: { status_code: 2483, status_msg: "PRIVATE_SECRET", aweme_list: [] } })));
  assert.equal(result.errorCode, "login_required"); assert.equal(result.failureDiagnostics.stopReason, "invalid-body");
  assert.deepEqual(result.failureDiagnostics.businessStatusCodes, [2483]); assert.equal(result.failureDiagnostics.responses.invalidBodies, 1);
  assert.equal(result.failureDiagnostics.finalPageKind, "profile"); privateSafe(result.failureDiagnostics);
});

test("body timeout records its stage and cannot turn into a fabricated empty success", async () => {
  const result = await run(new Page((p) => p.respond({ json: () => new Promise(() => {}) })));
  assert.equal(result.status, "unavailable"); assert.equal(result.failureDiagnostics.responses.bodyTimeouts, 1);
  assert.equal(result.failureDiagnostics.stopReason, "body-timeout"); assert.deepEqual(result.posts, []);
});

test("navigation throw and actual navigation timeout stay separate and private", async () => {
  const failed = await run(new Page(() => { throw new Error("Cookie=PRIVATE_SECRET"); }));
  assert.equal(failed.failureDiagnostics.navigation.failed, true); assert.equal(failed.failureDiagnostics.navigation.timedOut, false);
  assert.equal(failed.failureDiagnostics.stopReason, "navigation-failed");
  const hung = new Page(); hung.goto = () => new Promise(() => {});
  const timeout = await run(hung);
  assert.equal(timeout.failureDiagnostics.navigation.timedOut, true); assert.equal(timeout.failureDiagnostics.stopReason, "navigation-timeout");
  privateSafe(failed.failureDiagnostics); privateSafe(timeout.failureDiagnostics);
});

test("new navigation clears old diagnostic counters and ignores late rejected body", async () => {
  let rejectBody;
  const oldBody = new Promise((_, reject) => { rejectBody = reject; });
  const page = new Page((p) => {
    p.respond({ json: () => oldBody });
    p.navigate(); p.respond();
    setTimeout(() => rejectBody(new Error("PRIVATE_SECRET")), 5);
  });
  const result = await run(page); const frozen = JSON.stringify(result.failureDiagnostics);
  assert.equal(result.status, "ok"); assert.equal(result.failureDiagnostics.requests.matched, 1);
  assert.equal(result.failureDiagnostics.responses.matched, 1); assert.equal(result.failureDiagnostics.responses.invalidBodies, 0);
  await new Promise((resolve) => setTimeout(resolve, 15)); assert.equal(JSON.stringify(result.failureDiagnostics), frozen);
  assert.equal(page.listenerCount("response"), 0);
});

test("successful metrics and completeness are unchanged and get success diagnostics", async () => {
  const result = await run(new Page((p) => p.respond()));
  assert.equal(result.status, "ok"); assert.equal(result.worksCoverage, "complete"); assert.deepEqual(result.posts, []);
  assert.equal(result.failureDiagnostics.stopReason, "success"); assert.deepEqual(result.failureDiagnostics.businessStatusCodes, [0]);
});

test("per-item resource exceptions do not invent observed navigation or counters", async () => {
  const context = { newPage: async () => { throw new Error("PRIVATE_SECRET"); }, close: async () => {} };
  const browser = { newContext: async () => context, close: async () => {} };
  const result = await collectBrowserWorks({ items: [item] }, { runtime: { readState: async () => ({ cookies: [] }), access: async () => {}, launch: async () => browser } });
  const diagnostic = result.items[0].failureDiagnostics;
  assert.deepEqual(diagnostic, unknownBrowserWorksDiagnostics()); assert.equal(diagnostic.navigation.observed, null);
  assert.equal(diagnostic.requests.matched, null); privateSafe(diagnostic);
});
