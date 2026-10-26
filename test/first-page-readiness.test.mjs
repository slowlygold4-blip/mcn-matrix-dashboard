import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { collectOne } from "../scripts/douyin_browser_collector.mjs";
import { sanitizeBrowserWorksDiagnostics } from "../lib/douyin-browser-diagnostics.mjs";
const SEC = "MS4wLjABAAAAReadinessOnlyOffline12345";
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const WORKS = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0`;
const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const projection = reason => ({ eligible: reason === "eligible", reason: reason === "eligible" ? undefined : "no-container",
  ...(reason === "eligible" ? { x: 400, y: 300, deltaY: 600 } : {}),
  structure: { reason, regionCount: reason === "region-absent" ? 0 : 1, visibleRegionCount: reason === "eligible" ? 1 : 0,
    leafRegionCount: reason === "eligible" ? 1 : 0, ancestorCount: reason === "eligible" ? 1 : null } });
class Page extends EventEmitter {
  constructor(readyAt = Infinity, initialReason = "region-absent") {
    super(); this.readyAt = readyAt; this.initialReason = initialReason; this.address = "about:blank";
    this.frame = { url: () => this.address }; this.probes = 0; this.moves = 0; this.wheels = 0; this.evaluateOverride = null;
    this.mouse = { move: async () => { this.moves++; }, wheel: async () => { this.wheels++; this.onWheel?.(); } };
  }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  request(url = WORKS, navigation = false) {
    const req = { url: () => url, frame: () => this.frame, method: () => "GET", isNavigationRequest: () => navigation };
    this.emit("request", req); return req;
  }
  respond(req, status = 200) {
    this.emit("response", { request: () => req, url: req.url, status: () => status, json: async () => ({ status_code: 0,
      aweme_list: [{ aweme_id: "7200000000000000001", author: { sec_uid: SEC }, statistics: {} }], has_more: false, max_cursor: 0 }) });
  }
  async goto() { this.navigate(); }
  navigate() {
    const doc = this.request(PROFILE, true); this.address = PROFILE; this.respond(doc); this.emit("framenavigated", this.frame);
  }
  async evaluate(fn) {
    if (fn.name !== "observeFirstPageActivation") return { observation: "observed", readyState: "complete" };
    this.probes++; return this.evaluateOverride ? this.evaluateOverride() : projection(Date.now() >= this.readyAt ? "eligible" : this.initialReason);
  }
}
async function run(t, page, { timeoutMs = 10_000, signal, onTick } = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let done = false;
  const result = collectOne(page, { key: "offline-readiness", secUid: SEC, limit: 30 }, { timeoutMs, signal });
  result.finally(() => { done = true; }); await drain();
  for (let now = 20; !done && now <= timeoutMs + 40; now += 20) {
    t.mock.timers.tick(20); onTick?.(now); await drain();
  }
  assert.equal(done, true, "readiness cannot extend the existing collection deadline");
  return result;
}
for (const initialReason of ["region-absent", "region-not-visible"]) test(`five-second ${initialReason} becomes one real accepted first page`, async t => {
  const page = new Page(5_000, initialReason); page.onWheel = () => page.respond(page.request());
  const result = await run(t, page);
  assert.equal(result.posts.length, 1); assert.equal(result.worksCoverage, "complete");
  assert.equal(page.moves, 1); assert.equal(page.wheels, 1); assert.equal(page.probes, 6);
  assert.equal(result.failureDiagnostics.firstPageActivation.probeCount, 6);
  assert.equal(result.failureDiagnostics.firstPageActivation.actionCount, 1);
  assert.equal(result.failureDiagnostics.firstPageActivation.attemptCount, 1);
});
test("never appearing content gets exactly eight read-only qualifications and no mouse action", async t => {
  const page = new Page(); const result = await run(t, page);
  assert.equal(page.probes, 8); assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
  assert.equal(result.failureDiagnostics.firstPageActivation.probeCount, 8);
  assert.equal(result.failureDiagnostics.firstPageActivation.actionCount, 0);
  assert.equal(result.posts.length, 0); assert.equal(result.worksCoverage, "unavailable");
});
test("the eighth eligible qualification still permits at most one final check and one action", async t => {
  const page = new Page(8_000); page.onWheel = () => page.respond(page.request());
  const result = await run(t, page);
  assert.equal(page.probes, 9); assert.equal(page.moves, 1); assert.equal(page.wheels, 1);
  assert.equal(result.posts.length, 1); assert.equal(result.failureDiagnostics.firstPageActivation.probeCount, 9);
});
test("qualification pending at the unchanged short overall deadline does not get more time", async t => {
  const page = new Page(5_000); const result = await run(t, page, { timeoutMs: 2_500 });
  assert.equal(page.probes, 2); assert.equal(page.wheels, 0); assert.equal(result.worksCoverage, "unavailable");
});
for (const cause of ["request", "cancel", "refusal"]) test(`${cause} after the first qualification closes the opportunity permanently`, async t => {
  const page = new Page(3_000); const controller = new AbortController();
  const result = await run(t, page, { signal: controller.signal, onTick: now => {
    if (now !== 1_200) return;
    if (cause === "request") page.request();
    if (cause === "cancel") controller.abort();
    if (cause === "refusal") page.respond(page.request(), 403);
  } });
  assert.equal(page.probes, 1); assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
  assert.equal(result.worksCoverage, "unavailable");
});
test("genuine verified navigation transfers only the remaining unspent qualification budget", async t => {
  const page = new Page(3_000); page.onWheel = () => page.respond(page.request());
  const result = await run(t, page, { onTick: now => { if (now === 1_200) page.navigate(); } });
  assert.equal(page.probes, 4); assert.equal(page.moves, 1); assert.equal(page.wheels, 1);
  assert.equal(result.status, "ok"); assert.equal(result.posts.length, 1); assert.equal(result.worksCoverage, "complete");
  assert.equal(result.failureDiagnostics.lifecycle.generation, 2);
  assert.equal(result.failureDiagnostics.firstPageActivation.probeCount, 4);
  assert.equal(result.failureDiagnostics.firstPageActivation.actionCount, 1);
});
for (const reason of ["visible-gate", "occluded", "region-ambiguous", "projection-error"]) test(`${reason} cannot become a retry even when content later appears`, async t => {
  const page = new Page(3_000, reason); const result = await run(t, page);
  assert.equal(page.probes, 1); assert.equal(page.wheels, 0); assert.equal(result.worksCoverage, "unavailable");
});
test("a hung qualification terminates the opportunity and late resolution cannot revive it", async t => {
  const page = new Page(); let release;
  page.evaluateOverride = () => new Promise(resolve => { release = resolve; });
  const result = await run(t, page);
  assert.equal(page.probes, 1); assert.equal(result.failureDiagnostics.firstPageActivation.state, "timeout");
  release(projection("region-absent")); await drain(); assert.equal(page.probes, 1); assert.equal(page.wheels, 0);
});
test("new counters are bounded without redefining legacy attemptCount or exposing raw fields", () => {
  const clean = sanitizeBrowserWorksDiagnostics({ version: 1, firstPageActivation: { state: "no-container", attemptCount: 1,
    probeCount: 10, actionCount: 2, private: "SECRET" } });
  assert.deepEqual(clean.firstPageActivation, { state: "no-container", attemptCount: 1, probeCount: null, actionCount: null });
  assert.deepEqual(sanitizeBrowserWorksDiagnostics({ version: 1, firstPageActivation: { state: "no-container", attemptCount: 1 } }).firstPageActivation,
    { state: "no-container", attemptCount: 1 });
});
