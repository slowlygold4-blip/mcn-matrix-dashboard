import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import { observeFirstPageActivation, sanitizeFirstPageActivationStructure } from "../lib/browser-first-page-activation.mjs";
import { sanitizeBrowserWorksDiagnostics } from "../lib/douyin-browser-diagnostics.mjs";
import { collectOne } from "../scripts/douyin_browser_collector.mjs";
const SEC = "MS4wLjABAAAAActivationReasonsOffline12345";
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const drain = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
function project(kind = "eligible") {
  const rect = { left: 10, top: 10, right: 510, bottom: 410, width: 500, height: 400 };
  const node = { scrollTop: kind === "at-bottom" ? 800 : 0, scrollHeight: kind === "not-scrollable" ? 400 : 1200,
    clientHeight: 400, parentElement: null, contains(other) { return this === other; },
    getBoundingClientRect: () => ({ ...rect, ...(kind === "region-not-visible" ? { width: 0 } : {}),
      ...(kind === "small-area" ? { right: 14, width: 4 } : {}) }) };
  const regions = kind === "region-absent" ? [] : kind === "region-ambiguous" ? [node, { ...node }]
    : kind === "region-limit" ? Array(9).fill(node) : kind === "eight-regions" ? Array.from({ length: 8 }, () => ({ ...node })) : [node];
  const document = { readyState: "complete", scrollingElement: null,
    querySelectorAll: selector => selector.includes("user-post-list") ? regions : kind === "visible-gate" ? [node] : [],
    elementFromPoint: () => kind === "occluded" ? {} : node };
  for (const property of ["cookie", "body", "innerText", "textContent"]) Object.defineProperty(document, property, { get() { throw new Error("private read"); } });
  return JSON.parse(JSON.stringify(runInNewContext(`(${observeFirstPageActivation.toString()})({secUid})`, {
    URL, secUid: SEC, location: new URL(PROFILE), document, window: { innerWidth: 1000, innerHeight: 800 },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", overflowY: "auto" }),
  })));
}
for (const kind of ["region-absent", "region-not-visible", "region-ambiguous", "region-limit", "not-scrollable", "at-bottom", "small-area", "visible-gate", "occluded", "eligible"]) {
  test(`fixed structural projection distinguishes ${kind} without reading content`, () => {
    const result = project(kind);
    assert.equal(result.structure?.reason, kind);
    assert.equal(result.eligible, kind === "eligible");
    if (!["visible-gate"].includes(kind)) assert.equal(result.structure.regionCount, kind === "region-absent" ? 0 : kind === "region-ambiguous" ? 2 : kind === "region-limit" ? 9 : 1);
    assert.ok(!JSON.stringify(result.structure).includes(SEC));
    assert.ok(!JSON.stringify(result.structure).includes("x\":"));
  });
}
class OfflinePage extends EventEmitter {
  constructor(kind) { super(); this.kind = kind; this.address = "about:blank"; this.frame = { url: () => this.address }; this.wheels = 0;
    this.mouse = { move: async () => {}, wheel: async () => { this.wheels++; } }; }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  async goto() {
    const request = { url: () => PROFILE, frame: () => this.frame, isNavigationRequest: () => true };
    this.emit("request", request); this.address = PROFILE;
    this.emit("response", { request: () => request, url: request.url, status: () => 200 }); this.emit("framenavigated", this.frame);
  }
  async evaluate(fn) {
    if (fn.name !== "observeFirstPageActivation") return { observation: "observed", readyState: "complete" };
    const result = this.projectionOverride ?? project(this.kind);
    if (result.structure) Object.assign(result.structure, { text: "PRIVATE", url: PROFILE, x: 300 });
    return result;
  }
}
test("actual collector preserves a missing-region reason twice sanitized without accepting works", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const page = new OfflinePage("region-absent");
  const pending = collectOne(page, { key: "offline", secUid: SEC, limit: 30 }, { timeoutMs: 1300 });
  await drain(); t.mock.timers.tick(1000); await drain(); t.mock.timers.tick(300); await drain();
  const result = await pending;
  assert.equal(result.failureDiagnostics.firstPageActivation.structure?.reason, "region-absent");
  assert.equal(result.failureDiagnostics.firstPageActivation.attemptCount, 1);
  assert.equal(page.wheels, 0); assert.equal(result.posts.length, 0); assert.equal(result.worksCoverage, "unavailable");
  assert.ok(!JSON.stringify(result.failureDiagnostics).includes("PRIVATE")); assert.ok(!JSON.stringify(result.failureDiagnostics).includes(SEC));
  const outer = sanitizeBrowserWorksDiagnostics(result.failureDiagnostics);
  assert.deepEqual(outer, result.failureDiagnostics);
});
test("both sanitizer boundaries reject arbitrary strings, unsafe counts and unsolicited private fields", () => {
  const value = { reason: PROFILE, regionCount: 10, visibleRegionCount: -1, leafRegionCount: "1", ancestorCount: 13,
    cookie: "PRIVATE", text: "PRIVATE", x: 400, nodes: [{ id: SEC }] };
  const expected = { reason: "not-eligible", regionCount: null, visibleRegionCount: null, leafRegionCount: null, ancestorCount: null };
  assert.deepEqual(sanitizeFirstPageActivationStructure(value), expected);
  const outer = sanitizeBrowserWorksDiagnostics({ version: 1, firstPageActivation: { state: "no-container", attemptCount: 1, structure: value } });
  assert.deepEqual(outer.firstPageActivation.structure, expected);
  assert.ok(!JSON.stringify(outer).includes("PRIVATE")); assert.ok(!JSON.stringify(outer).includes(SEC));
  for (const invalid of [null, [], "PRIVATE", 1]) assert.equal(sanitizeFirstPageActivationStructure(invalid), null);
  assert.deepEqual(sanitizeFirstPageActivationStructure({ reason: "region-limit", regionCount: 9, visibleRegionCount: 8, leafRegionCount: 8, ancestorCount: 12 }),
    { reason: "region-limit", regionCount: 9, visibleRegionCount: 8, leafRegionCount: 8, ancestorCount: 12 });
});
test("an initially missing container can be read again within the single action opportunity", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const page = new OfflinePage("region-absent");
  const pending = collectOne(page, { key: "offline", secUid: SEC, limit: 30 }, { timeoutMs: 2500 });
  await drain(); t.mock.timers.tick(1000); await drain(); page.kind = "eligible";
  t.mock.timers.tick(1000); await drain(); t.mock.timers.tick(500); await drain();
  const result = await pending;
  assert.equal(result.failureDiagnostics.firstPageActivation.structure.reason, "eligible");
  assert.equal(result.failureDiagnostics.firstPageActivation.attemptCount, 1); assert.equal(page.wheels, 1);
  assert.equal(result.failureDiagnostics.firstPageActivation.probeCount, 3);
  assert.equal(result.failureDiagnostics.firstPageActivation.actionCount, 1);
  assert.equal(result.worksCoverage, "unavailable");
});
test("region cap differentiates eight examined regions from nine-or-more without guessing unexamined visibility", () => {
  assert.deepEqual(project("eight-regions").structure, { reason: "region-ambiguous", regionCount: 8,
    visibleRegionCount: 8, leafRegionCount: 8, ancestorCount: null });
  assert.deepEqual(project("region-limit").structure, { reason: "region-limit", regionCount: 9,
    visibleRegionCount: null, leafRegionCount: null, ancestorCount: null });
});
for (const change of [{ x: -1 }, { x: 20_001 }, { x: NaN }, { deltaY: 801 }, { eligible: false }]) {
  test(`a structural eligible reason cannot authorize an invalid action point ${JSON.stringify(change)}`, async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    const page = new OfflinePage("eligible"); page.projectionOverride = { ...project("eligible"), ...change };
    const pending = collectOne(page, { key: "offline", secUid: SEC, limit: 30 }, { timeoutMs: 1300 });
    await drain(); t.mock.timers.tick(1000); await drain(); t.mock.timers.tick(300); await drain();
    const result = await pending;
    assert.equal(page.wheels, 0); assert.equal(result.worksCoverage, "unavailable"); assert.equal(result.posts.length, 0);
    assert.equal(result.failureDiagnostics.firstPageActivation.state, "not-eligible");
    assert.equal(result.failureDiagnostics.firstPageActivation.structure.reason, "eligible", "structure alone is not action permission");
  });
}
