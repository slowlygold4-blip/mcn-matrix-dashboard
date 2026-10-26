import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { collectOne } from "../scripts/douyin_browser_collector.mjs";
import { projectRenderEvidence } from "../scripts/probes/douyin-profile-render-probe.mjs";

// Synthetic public-document shape only. No browser, HTTP, state or DB access.
const identity = { secUid: "MS4wLjABAAAARenderedEvidenceFixture123", uid: "1234567890" };
const profile = `https://www.douyin.com/user/${identity.secUid}`;
const authorInfo = { ...identity };
function installDocument(render) {
  const before = Object.fromEntries(["document", "location", "getComputedStyle"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let reads = 0;
  const node = { get textContent() { reads++; return encodeURIComponent(JSON.stringify(render)); } };
  globalThis.location = new URL(profile);
  globalThis.document = {
    readyState: "complete", body: { childElementCount: 2 },
    querySelector: selector => selector.includes("RENDER_DATA") ? node : null,
    querySelectorAll: selector => selector === "script" || selector === 'script[type="application/json"]' ? [node] : [],
  };
  globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  return { reads: () => reads, restore() {
    for (const [key, descriptor] of Object.entries(before)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  } };
}
class Page extends EventEmitter {
  address = "about:blank";
  frame = { url: () => this.address };
  mainFrame() { return this.frame; }
  url() { return this.address; }
  async evaluate(fn, arg) { return fn(arg); }
  async goto() {
    this.emit("request", { isNavigationRequest: () => true, frame: () => this.frame, url: () => profile });
    this.address = profile;
    this.emit("framenavigated", this.frame);
  }
}
test("same synthetic legacy document is recognized by diagnostic projection but never becomes XHR works", async () => {
  const document = installDocument({ 41: { user: { user: { ...identity } }, post: { data: [
    { id: "7000000000000000001", authorInfo }, { id: "7000000000000000002", authorInfo },
  ] } } });
  try {
    const result = await collectOne(new Page(), { key: "offline", secUid: identity.secUid, limit: 30 }, { timeoutMs: 30 });
    assert.equal(document.reads(), 0, "actual structural observer never reads embedded JSON");
    assert.equal(result.failureDiagnostics.firstScreen.renderDataPresent, true);
    assert.equal(result.failureDiagnostics.stopReason, "no-bound-request");
    assert.deepEqual(result.posts, []); assert.equal(result.worksCoverage, "unavailable");
    const projection = projectRenderEvidence(identity);
    assert.equal(document.reads(), 1); assert.equal(projection.schema, "legacy-user-post");
    assert.equal(projection.profileIdentityMatches, true); assert.equal(projection.postIdentityMatches, 2);
    assert.equal(projection.postCount, 2);
  } finally { document.restore(); }
});
test("projection identity counts do not validate work IDs or metrics and cannot be reused as accepted works", () => {
  const document = installDocument({ 41: { user: { user: { ...identity } }, post: { data: [
    { authorInfo, id: "not-a-work-id", statistics: { digg_count: -1 } },
    { authorInfo },
  ] } } });
  try {
    const projection = projectRenderEvidence(identity);
    assert.equal(projection.postIdentityMatches, 2); assert.equal(projection.postIdentityConflicts, 0);
    assert.equal(projection.postCount, 2);
    assert.equal(Object.hasOwn(projection, "posts"), false);
    assert.equal(Object.hasOwn(projection, "worksCoverage"), false);
    assert.doesNotMatch(JSON.stringify(projection), /not-a-work-id|digg_count|1234567890/);
  } finally { document.restore(); }
});
