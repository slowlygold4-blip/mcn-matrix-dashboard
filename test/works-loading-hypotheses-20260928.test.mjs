import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { collectOne } from "../scripts/douyin_browser_collector.mjs";

// Mechanism-only counterexamples, not claims about any real Douyin page.
// No browser, network, saved session, user data or database is accessed.
const SEC = "MS4wLjABAAAALoadingHypothesisAccount1234";
const PROFILE = `https://www.douyin.com/user/${SEC}`;
class DocumentOnlyPage extends EventEmitter {
  current = "about:blank";
  frame = { url: () => this.current };
  documentReads = 0;
  userActions = 0;
  mainFrame() { return this.frame; }
  url() { return this.current; }
  async goto(_url, options) {
    this.waitUntil = options.waitUntil;
    this.emit("request", { isNavigationRequest: () => true, url: () => PROFILE, frame: () => this.frame });
    this.current = PROFILE;
    this.emit("framenavigated", this.frame);
  }
  async evaluate() { this.documentReads += 1; return { renderDataPresent: true, postCount: 20 }; }
  locator() {
    return { textContent: async () => { this.documentReads += 1; return "fixture only"; },
      scrollIntoViewIfNeeded: async () => { this.userActions += 1; } };
  }
}

test("first-screen structural markers cannot establish an embedded works window when no XHR is emitted", async () => {
  const page = new DocumentOnlyPage();
  const result = await collectOne(page, { key: "offline-mechanism", secUid: SEC, limit: 30 }, { timeoutMs: 35 });
  assert.equal(page.waitUntil, "commit");
  assert.equal(page.documentReads, 1, "only one bounded structural probe occurs without DOM-ready events");
  assert.equal(page.userActions, 0);
  assert.equal(result.failureDiagnostics.navigation.committed, true);
  assert.equal(result.failureDiagnostics.requests.candidate, 0);
  assert.equal(result.failureDiagnostics.stopReason, "no-bound-request");
  assert.equal(result.errorCode, "collector_error");
  assert.equal(result.failureDiagnostics.firstScreen.renderDataPresent, true);
  assert.equal(Object.hasOwn(result.failureDiagnostics.firstScreen, "postCount"), false);
  assert.equal(JSON.stringify(result).includes('"postCount"'), false, "untrusted embedded counts never become works evidence");
  assert.equal(result.worksCoverage, "unavailable");
  assert.deepEqual(result.posts, []);
  assert.equal(JSON.stringify(result).includes("fixture only"), false);
});
