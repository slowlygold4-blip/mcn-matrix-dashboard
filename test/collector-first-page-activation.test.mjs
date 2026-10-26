import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { collectOne } from "../scripts/douyin_browser_collector.mjs";
import { sanitizeBrowserWorksDiagnostics } from "../lib/douyin-browser-diagnostics.mjs";

const SEC = "MS4wLjABAAAAFirstActivationOffline12345";
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const WORKS = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0`;
const drain = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
class Page extends EventEmitter {
  constructor() {
    super(); this.address = "about:blank"; this.frame = { url: () => this.address }; this.wheels = 0; this.probes = 0;
    this.mouse = { move: async () => {}, wheel: async () => { this.wheels++; this.onWheel?.(); } };
  }
  mainFrame() { return this.frame; }
  url() { return this.address; }
  request(url = WORKS, navigation = false) {
    const req = { url: () => url, frame: () => this.frame, method: () => "GET", isNavigationRequest: () => navigation };
    this.emit("request", req); return req;
  }
  response(req, status = 200) {
    this.emit("response", { request: () => req, url: req.url, status: () => status, json: async () => ({ status_code: 0,
      has_more: false, max_cursor: 0, aweme_list: [{ aweme_id: "7200000000000000001", author: { sec_uid: SEC }, statistics: {} }] }) });
  }
  async goto() {
    const doc = this.request(PROFILE, true); this.address = PROFILE;
    this.response(doc, this.documentStatus ?? 200); this.emit("framenavigated", this.frame);
    this.afterGoto?.();
  }
  async evaluate(fn) {
    if (fn.name === "observeFirstPageActivation") { this.probes++; return this.projection ?? { eligible: true, x: 640, y: 500, deltaY: 540 }; }
    return { observation: "observed", readyState: "interactive" };
  }
}
async function run(t, page, options = {}, atReady) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const promise = collectOne(page, { key: "offline", secUid: SEC, limit: 30 }, { timeoutMs: 2500, ...options });
  await drain(); t.mock.timers.tick(1000); await drain(); await atReady?.();
  t.mock.timers.tick(1500); await drain(); t.mock.timers.tick(1); await drain(); return promise;
}
test("normal first-page lazy loading is activated once and only its strict response supplies works", async t => {
  const page = new Page(); page.onWheel = () => page.response(page.request());
  const result = await run(t, page);
  assert.equal(page.wheels, 1); assert.equal(result.posts.length, 1); assert.equal(result.worksCoverage, "complete");
  assert.deepEqual(result.failureDiagnostics.firstPageActivation, { state: "attempted", attemptCount: 1, probeCount: 2, actionCount: 1 });
});
test("a wheel without a bound response does not invent works or completion", async t => {
  const page = new Page(); const result = await run(t, page);
  assert.equal(page.wheels, 1); assert.equal(result.posts.length, 0); assert.equal(result.worksCoverage, "unavailable");
});
test("a naturally bound request without response prevents the activation", async t => {
  const page = new Page(); page.afterGoto = () => page.request();
  const result = await run(t, page); assert.equal(page.wheels, 0); assert.equal(page.probes, 0); assert.equal(result.posts.length, 0);
});
test("move completing after its local budget cannot emit a late wheel", async t => {
  const page = new Page(); let release;
  page.mouse.move = () => new Promise(resolve => { release = resolve; });
  const result = await run(t, page, {}, async () => { assert.equal(page.probes, 1); });
  assert.equal(result.failureDiagnostics.firstPageActivation.state, "timeout");
  release(); await drain(); assert.equal(page.wheels, 0); assert.equal(result.posts.length, 0);
});
test("navigation invalidation during movement is not misreported as an elapsed action timeout", async t => {
  const page = new Page(); let release;
  page.mouse.move = () => new Promise(resolve => { release = resolve; });
  const result = await run(t, page, {}, async () => {
    assert.equal(page.probes, 1);
    const doc = page.request(PROFILE, true);
    page.response(doc); page.emit("framenavigated", page.frame);
    await drain(); release(); await drain();
  });
  assert.deepEqual(result.failureDiagnostics.firstPageActivation, { state: "not-eligible", attemptCount: 1, probeCount: 1, actionCount: 1 });
  assert.equal(page.wheels, 0); assert.equal(result.posts.length, 0); assert.equal(result.worksCoverage, "unavailable");
});
test("a visible gate stops before movement and remains unavailable", async t => {
  const page = new Page(); page.projection = { eligible: false, reason: "blocked" };
  const result = await run(t, page);
  assert.equal(page.wheels, 0); assert.equal(page.probes, 1);
  assert.deepEqual(result.failureDiagnostics.firstPageActivation, { state: "blocked", attemptCount: 1, probeCount: 1, actionCount: 0 });
});
test("activation diagnostic serializer strips coordinates, arbitrary strings and malformed counts", () => {
  const clean = sanitizeBrowserWorksDiagnostics({ version: 1, firstPageActivation: {
    state: "private text", attemptCount: 2, x: 400, y: 300, text: "SECRET", secUid: SEC,
  } });
  assert.deepEqual(clean.firstPageActivation, { state: "unavailable", attemptCount: null });
  assert.ok(!JSON.stringify(clean).includes("SECRET")); assert.ok(!JSON.stringify(clean).includes(SEC));
});
