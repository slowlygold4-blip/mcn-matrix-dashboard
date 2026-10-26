import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { collectOne } from "../scripts/douyin_browser_collector.mjs";

const SEC = "MS4wLjABAAAAIndependentLifecycle12345678";
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const WORKS = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const body = id => ({ status_code: 0, has_more: false, max_cursor: 0,
  aweme_list: [{ aweme_id: String(7300000000000000000n + BigInt(id)), author: { sec_uid: SEC, uid: "1234567890" }, statistics: { digg_count: id } }] });

class Page extends EventEmitter {
  constructor(scenario) { super(); this.address = "about:blank"; this.frame = { url: () => this.address }; this.scenario = scenario; this.reads = 0; }
  mainFrame() { return this.frame; }
  url() { return this.address; }
  request(url = WORKS, navigation = false) { return { url: () => url, frame: () => this.frame, method: () => "GET", isNavigationRequest: () => navigation }; }
  navigate(url = PROFILE) { this.emit("request", this.request(url, true)); this.sameDocument(url); }
  // History API navigation emits framenavigated but creates no document request.
  sameDocument(url) { this.address = url; this.emit("framenavigated", this.frame); }
  respond(value, { status = 200 } = {}) {
    const request = this.request(); this.emit("request", request);
    this.emit("response", { request: () => request, url: request.url, status: () => status,
      json: async () => { this.reads++; return typeof value === "function" ? value() : value; } });
  }
  async goto() { this.navigate(); await this.scenario(this); }
}
const collect = (page, options = {}) => collectOne(page, { key: "offline-lifecycle", secUid: SEC, limit: 30 }, { timeoutMs: 120, bodyTimeoutMs: 80, failureGraceMs: 1, ...options });
function success(result, id) {
  assert.equal(result.status, "ok"); assert.equal(result.worksCoverage, "complete");
  assert.deepEqual(result.posts.map(post => post.statistics.digg_count), [id]);
  assert.equal(result.pagination.pages.length, 1);
}
function clean(page) { for (const event of ["request", "response", "framenavigated", "requestfailed", "pageerror", "domcontentloaded"]) assert.equal(page.listenerCount(event), 0); }

test("lifecycle peer: ordinary initial committed profile can collect current works", async () => {
  const page = new Page(p => p.respond(body(1)));
  success(await collect(page), 1); clean(page);
});

test("lifecycle peer: same-document route roundtrip must not leave future current-profile bodies permanently aborted", async () => {
  const page = new Page(p => {
    p.sameDocument("https://www.douyin.com/discover");
    p.sameDocument(PROFILE);
    p.respond(body(2));
  });
  const result = await collect(page);
  assert.equal(result.failureDiagnostics.requests.matched, 1);
  success(result, 2); clean(page);
});

test("lifecycle peer: returning same-document profile accepts only a new body and rejects the prior generation body", async () => {
  let finishOld;
  const page = new Page(async p => {
    p.respond(() => new Promise(resolve => { finishOld = resolve; }));
    await pause(1);
    p.sameDocument("https://www.douyin.com/discover");
    p.sameDocument(PROFILE);
    p.respond(body(2));
    finishOld(body(99));
  });
  success(await collect(page), 2); assert.equal(page.reads, 2); clean(page);
});

test("lifecycle peer: a new document already renews its body lifecycle without accepting old body", async () => {
  let finishOld;
  const page = new Page(async p => {
    p.respond(() => new Promise(resolve => { finishOld = resolve; }));
    await pause(1); p.navigate(); p.respond(body(2)); finishOld(body(99));
  });
  success(await collect(page), 2); assert.equal(page.reads, 2); clean(page);
});

test("lifecycle peer: bound refusals remain closed across a same-document route roundtrip", async t => {
  for (const [status, code] of [[401, "login_required"], [403, "blocked"], [429, "rate_limited"]]) await t.test(String(status), async () => {
    const page = new Page(p => {
      p.respond(null, { status });
      p.sameDocument("https://www.douyin.com/discover"); p.sameDocument(PROFILE); p.respond(body(2));
    });
    const result = await collect(page);
    assert.equal(result.status, "unavailable"); assert.equal(result.errorCode, code);
    assert.deepEqual(result.posts, []); assert.equal(page.reads, 0); clean(page);
  });
});

test("lifecycle peer: verification route is a permanent barrier, not a renewable body lifecycle", async () => {
  const page = new Page(p => {
    p.sameDocument("https://www.douyin.com/verify/"); p.sameDocument(PROFILE); p.respond(body(2));
  });
  const result = await collect(page);
  assert.equal(result.status, "unavailable"); assert.equal(result.errorCode, "blocked");
  assert.deepEqual(result.posts, []); assert.equal(page.reads, 0); clean(page);
});

test("lifecycle peer: explicit login routes cannot resume collection through a later ordinary route", async t => {
  for (const address of ["https://www.douyin.com/passport/login", "https://www.douyin.com/login/", "https://passport.douyin.com/"]) await t.test(address, async () => {
    const page = new Page(p => {
      if (new URL(address).origin === new URL(PROFILE).origin) p.sameDocument(address);
      else p.navigate(address);
      p.navigate("https://www.douyin.com/discover"); p.navigate(PROFILE); p.respond(body(2));
    });
    const result = await collect(page);
    assert.equal(result.status, "unavailable"); assert.equal(result.errorCode, "login_required");
    assert.deepEqual(result.posts, []); assert.equal(page.reads, 0); clean(page);
  });
});

test("lifecycle peer: externally cancelled collection cannot revive on a same-document return", async () => {
  const controller = new AbortController();
  const page = new Page(p => {
    p.sameDocument("https://www.douyin.com/discover"); controller.abort();
    p.sameDocument(PROFILE); p.respond(body(2));
  });
  const result = await collect(page, { signal: controller.signal });
  assert.equal(result.status, "unavailable"); assert.equal(result.pagination.stopReason, "cancelled");
  assert.deepEqual(result.posts, []); assert.equal(page.reads, 0); clean(page);
});

test("lifecycle peer: old pending generation cannot keep the return page alive beyond the unchanged total deadline", async () => {
  let finishOld;
  const page = new Page(async p => {
    p.respond(() => new Promise(resolve => { finishOld = resolve; }));
    await pause(1); p.sameDocument("https://www.douyin.com/discover"); p.sameDocument(PROFILE);
  });
  const start = Date.now(); const result = await collect(page, { timeoutMs: 50, bodyTimeoutMs: 500 });
  assert.ok(Date.now() - start < 200);
  assert.equal(result.status, "unavailable"); assert.equal(result.failureDiagnostics.requests.matched, 0);
  assert.equal(result.failureDiagnostics.responses.bodyTimeouts, 0, "old aborted body must not poison the new generation diagnostics");
  const frozen = JSON.stringify(result); finishOld(body(99)); await pause(1);
  assert.equal(JSON.stringify(result), frozen); clean(page);
});
