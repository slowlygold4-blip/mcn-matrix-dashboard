import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { collectOne } from "../scripts/douyin_browser_collector.mjs";

const SEC = "MS4wLjABAAAAabcdefghijklmnopqrstuvwx";
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const WORKS = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
class Page extends EventEmitter {
  constructor(scenario = () => {}) {
    super(); this.scenario = scenario; this.address = "about:blank"; this.generation = 0;
    this.frame = { url: () => this.address }; this.probes = []; this.bodyReads = 0;
  }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  request(url = WORKS, navigation = false) {
    return { url: () => url, frame: () => this.frame, method: () => "GET", isNavigationRequest: () => navigation };
  }
  navigate() {
    this.generation++; this.emit("request", this.request(PROFILE, true)); this.address = PROFILE;
    this.emit("framenavigated", this.frame);
  }
  async goto() { this.navigate(); return this.scenario(this); }
  async evaluate() {
    this.probes.push(this.generation);
    return { observation: "observed", readyState: "complete", scriptCount: this.generation, worksAnchorCount: 20 };
  }
}
const run = (page, options = {}) => collectOne(page, { key: "generation-fixture", secUid: SEC, limit: 30 },
  { timeoutMs: 85, bodyTimeoutMs: 60, failureGraceMs: 1, ...options });
function unavailable(result) {
  assert.equal(result.status, "unavailable"); assert.equal(result.errorCode, "collector_error");
  assert.equal(result.worksCoverage, "unavailable"); assert.deepEqual(result.posts, []);
}

test("generation diagnostics: committed replacement profile is observed without another DOM-ready event", async () => {
  const page = new Page(p => setTimeout(() => { p.emit("request", p.request()); p.navigate(); }, 10));
  const result = await run(page);
  unavailable(result);
  assert.equal(result.failureDiagnostics.navigation.committed, true);
  assert.equal(result.failureDiagnostics.requests.matched, 0, "old requests cannot become current proof");
  assert.equal(result.failureDiagnostics.firstScreen?.scriptCount, 2);
  assert.equal(result.failureDiagnostics.firstScreen?.worksAnchorCount, 20, "markers are diagnostic, never posts");
  assert.deepEqual(page.probes, [1, 2]);
});

test("generation diagnostics: delayed old structural result cannot replace the committed generation", async () => {
  let finishOld;
  const page = new Page(p => {
    setTimeout(() => p.navigate(), 10);
    setTimeout(() => finishOld?.({ observation: "observed", scriptCount: 999 }), 20);
  });
  page.evaluate = async () => {
    page.probes.push(page.generation);
    return page.generation === 1 ? new Promise(resolve => { finishOld = resolve; })
      : { observation: "observed", readyState: "complete", scriptCount: 2 };
  };
  const result = await run(page);
  unavailable(result); assert.equal(result.failureDiagnostics.firstScreen?.scriptCount, 2);
  assert.deepEqual(page.probes, [1, 2]);
});

test("generation diagnostics: a delayed old body is never admitted after replacement profile commit", async () => {
  let finishBody;
  const page = new Page(p => {
    const request = p.request(); p.emit("request", request);
    p.emit("response", { request: () => request, url: () => WORKS, status: () => 200,
      json: () => { p.bodyReads++; return new Promise(resolve => { finishBody = resolve; }); } });
    setTimeout(() => p.navigate(), 10);
    setTimeout(() => finishBody?.({ status_code: 0, has_more: false, max_cursor: 0,
      aweme_list: [{ aweme_id: "12345678901234567", author: { sec_uid: SEC }, statistics: {} }] }), 20);
  });
  const result = await run(page);
  unavailable(result); assert.equal(page.bodyReads, 1);
  assert.equal(result.failureDiagnostics.firstScreen?.scriptCount, 2);
  assert.equal(result.failureDiagnostics.responses.matched, 0);
});

test("generation diagnostics: commit and goto do not exhaust the two-probe budget before DOM-ready", async () => {
  const page = new Page(p => {
    setTimeout(() => { for (let i = 0; i < 4; i++) p.emit("domcontentloaded"); }, 5);
    setTimeout(() => { p.navigate(); for (let i = 0; i < 4; i++) p.emit("domcontentloaded"); }, 15);
  });
  const result = await run(page);
  unavailable(result); assert.deepEqual(page.probes, [1, 1, 2, 2]);
  for (const event of ["request", "response", "framenavigated", "domcontentloaded"]) assert.equal(page.listenerCount(event), 0);
});

test("generation diagnostics: hanging probes cannot extend deadline or mutate returned evidence", async () => {
  const finishes = [];
  const page = new Page(p => setTimeout(() => p.navigate(), 5));
  page.evaluate = () => new Promise(resolve => finishes.push(resolve));
  const started = Date.now(), result = await run(page, { timeoutMs: 40 });
  assert.ok(Date.now() - started < 350);
  unavailable(result);
  const frozen = JSON.stringify(result);
  for (const finish of finishes) finish({ observation: "observed", scriptCount: 999 });
  await pause(10);
  assert.equal(JSON.stringify(result), frozen);
});
