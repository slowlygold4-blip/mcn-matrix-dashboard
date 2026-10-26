import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { collectOne } from "../scripts/douyin_browser_collector.mjs";
import { WorksRequestPolicy } from "../lib/works-request-policy.mjs";
import { PublicWebProvider } from "../lib/providers/public-web.mjs";
import { checksum } from "../lib/utils.mjs";
import { sanitizeBrowserWorksDiagnostics } from "../lib/douyin-browser-diagnostics.mjs";

const SEC = "MS4wLjABAAAAabcdefghijklmnopqrstuvwx";
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const WORKS = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0&signature=PRIVATE_SECRET`;
const item = { key: "fixture", secUid: SEC, limit: 30 };
const options = { timeoutMs: 50, bodyTimeoutMs: 10, failureGraceMs: 1 };
class Page extends EventEmitter {
  constructor(scenario = () => {}) { super(); this.scenario = scenario; this.address = "about:blank"; this.frame = { url: () => this.address }; }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  request(url = WORKS, extra = {}) { return { url: () => url, frame: () => this.frame, method: () => "GET", isNavigationRequest: () => false, ...extra }; }
  navigate(url = PROFILE) { this.emit("request", this.request(url, { isNavigationRequest: () => true })); this.address = url; this.emit("framenavigated", this.frame); }
  async goto(url) { this.navigate(url); return this.scenario(this); }
}
const run = page => collectOne(page, item, options);

test("real collector: a committed profile with no works request is not a network failure", async () => {
  const result = await run(new Page());
  assert.equal(result.errorCode, "collector_error");
  assert.match(result.error, /未观察到/);
  assert.equal(result.failureDiagnostics.stopReason, "no-bound-request");
  assert.equal(result.failureDiagnostics.requests.candidate, 0);
  assert.equal(result.status, "unavailable");
  assert.equal(result.worksCoverage, "unavailable");
  assert.deepEqual(result.posts, []);
});

test("real collector: rejected candidate requests are an attribution failure, not a network failure", async () => {
  const result = await run(new Page(p => p.emit("request", p.request(WORKS, { method: () => "POST" }))));
  assert.equal(result.errorCode, "collector_error");
  assert.match(result.error, /未通过/);
  assert.equal(result.failureDiagnostics.requests.candidate, 1);
  assert.equal(result.failureDiagnostics.requests.rejected.method, 1);
});

test("real collector: no-request failures retain existing distinct-account backpressure", async () => {
  const policy = new WorksRequestPolicy({ now: () => 1000 });
  for (const key of ["one", "two", "three"]) {
    const result = await run(new Page());
    policy.record("authorised-browser", { targetKey: key, errorCode: result.errorCode });
  }
  const decision = policy.decision("authorised-browser");
  assert.equal(decision.deferred, true);
  assert.equal(Date.parse(decision.nextEligibleAt), 61_000);
});

function withDom(page, { readyState = "complete", bodyChildCount = 2, scriptCount = 7, jsonScriptCount = 1,
  renderDataPresent = true, nextDataPresent = false, worksAnchorCount = 3 } = {}) {
  const document = { readyState, body: { childElementCount: bodyChildCount },
    querySelectorAll(selector) {
      if (selector === "script") return { length: scriptCount };
      if (selector === 'script[type="application/json"]') return { length: jsonScriptCount };
      assert.equal(selector, 'a[href^="/video/"], a[href^="/note/"], a[href^="https://www.douyin.com/video/"], a[href^="https://www.douyin.com/note/"]');
      return { length: worksAnchorCount };
    },
    querySelector(selector) {
      assert.ok(['script[id="RENDER_DATA"]', 'script[id="__NEXT_DATA__"]'].includes(selector));
      const present = selector.includes("RENDER_DATA") ? renderDataPresent : nextDataPresent;
      return present ? new Proxy({}, { get() { throw new Error("PRIVATE_SECRET script content must not be read"); } }) : null;
    },
  };
  for (const object of [document, document.body]) {
    for (const key of ["cookie", "textContent", "innerText", "innerHTML"]) {
      Object.defineProperty(object, key, { get() { throw new Error("PRIVATE_SECRET content must not be read"); } });
    }
  }
  page.evaluateCalls = 0;
  page.evaluate = async (fn, arg) => {
    page.evaluateCalls += 1;
    const location = new URL(page.url());
    // Run the exact browser callback from collectOne, not a replacement helper.
    return runInNewContext(`(${fn.toString()})(arg)`, { document, location, arg });
  };
  return document;
}

test("real collector: first-screen markers are structure only and never prove works success", async () => {
  const page = new Page(); withDom(page);
  const result = await run(page);
  assert.deepEqual(result.failureDiagnostics.firstScreen, {
    observation: "observed", readyState: "complete", bodyPresent: true, bodyChildCount: 2,
    scriptCount: 7, jsonScriptCount: 1, renderDataPresent: true, nextDataPresent: false, worksAnchorCount: 3,
    render: { version: 1, parseState: "deferred", encoding: "none", identityBasis: "sec-uid-only",
      profileIdentity: "unknown", candidateCount: null, postCount: null, authorMatchCount: null,
      authorConflictCount: null, validIdCount: null, duplicateIdCount: null, workCandidateCount: null },
  });
  assert.equal(result.errorCode, "collector_error");
  assert.equal(result.status, "unavailable");
  assert.equal(result.worksCoverage, "unavailable");
  assert.deepEqual(result.posts, []);
  assert.equal(result.hasMore, undefined);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET|signature|https:|sec_user_id/);
  assert.equal(page.listenerCount("domcontentloaded"), 0);
});

test("real collector: DOM-ready observation replaces the early loading screen within the same budget", async () => {
  let document;
  const page = new Page(p => setTimeout(() => {
    document.readyState = "interactive";
    document.body.childElementCount = 4;
    p.emit("domcontentloaded");
  }, 5));
  document = withDom(page, { readyState: "loading", bodyChildCount: 0 });
  const result = await run(page);
  assert.equal(result.failureDiagnostics.firstScreen.readyState, "interactive");
  assert.equal(result.failureDiagnostics.firstScreen.bodyChildCount, 4);
  assert.equal(page.evaluateCalls, 2);
  page.emit("domcontentloaded");
  assert.equal(page.evaluateCalls, 2, "cleanup must prevent later sampling");
});

test("real collector: a page-evaluation exception stays private and cannot become a network failure", async () => {
  const page = new Page();
  page.evaluate = async () => { throw new Error("PRIVATE_SECRET Cookie=PRIVATE_SECRET"); };
  const result = await run(page);
  assert.equal(result.failureDiagnostics.firstScreen.observation, "unavailable");
  assert.equal(result.failureDiagnostics.firstScreen.scriptCount, null);
  assert.equal(result.errorCode, "collector_error");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET|Cookie/);
});

test("real collector: a hung structural probe cannot extend the deadline or mutate returned evidence", async () => {
  let finish;
  const page = new Page(); page.evaluate = () => new Promise(resolve => { finish = resolve; });
  const start = Date.now();
  const result = await run(page);
  const frozen = JSON.stringify(result);
  assert.ok(Date.now() - start < 500);
  assert.equal(result.errorCode, "collector_error");
  finish({ observation: "observed", readyState: "complete", scriptCount: 999 });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(JSON.stringify(result), frozen);
  assert.equal(page.listenerCount("domcontentloaded"), 0);
});

test("real collector: delayed first-screen evidence from an old navigation is discarded", async () => {
  let finishOld;
  const page = new Page(p => {
    setTimeout(() => { p.navigate(); p.emit("domcontentloaded"); }, 5);
    setTimeout(() => finishOld?.({ observation: "observed", readyState: "complete", scriptCount: 999 }), 15);
  });
  let calls = 0;
  page.evaluate = async () => ++calls === 1 ? new Promise(resolve => { finishOld = resolve; })
    : { observation: "observed", readyState: "interactive", scriptCount: 3 };
  const result = await run(page);
  assert.equal(result.failureDiagnostics.firstScreen.scriptCount, 3);
  assert.equal(result.failureDiagnostics.firstScreen.readyState, "interactive");
});

test("real collector: a bound request without a response retains network classification", async () => {
  const result = await run(new Page(p => {
    const request = p.request(); p.emit("request", request); p.emit("requestfailed", request);
  }));
  assert.equal(result.errorCode, "network_error");
  assert.equal(result.failureDiagnostics.requests.matched, 1);
  assert.equal(result.failureDiagnostics.runtime.boundRequestFailedCount, 1);
});

test("real collector: official login and bound HTTP rejection retain their higher precedence", async () => {
  const login = await run(new Page(p => p.navigate("https://www.douyin.com/passport/login")));
  assert.equal(login.errorCode, "login_required");
  const blocked = await run(new Page(p => {
    const request = p.request(); p.emit("request", request);
    p.emit("response", { request: () => request, url: request.url, status: () => 403,
      json: () => { throw new Error("PRIVATE_SECRET rejected body must not be read"); } });
  }));
  assert.equal(blocked.errorCode, "blocked");
  assert.doesNotMatch(JSON.stringify(blocked), /PRIVATE_SECRET/);
});

test("real collector: snapshot shape is filtered a second time by the provider without fabricated metrics", async () => {
  const page = new Page(); withDom(page);
  const browserItem = await collectOne(page, { ...item, key: "1" }, options);
  browserItem.failureDiagnostics.firstScreen.raw = "PRIVATE_SECRET";
  const upstream = { capturedAt: "2026-09-28T12:53:34.700Z", profile: { user: {
    sec_uid: SEC, nickname: "offline", follower_count: 10, total_favorited: 20, aweme_count: 2,
  } }, worksCoverage: "unavailable", worksErrorCode: "blocked", works: { aweme_list: [] }, warnings: [] };
  const execFileImpl = (file, _args, _options, callback) => callback(null, JSON.stringify({ ok: true,
    data: file === process.execPath ? { items: [browserItem] } : upstream }), "");
  const provider = new PublicWebProvider({ publicPostsPerAccount: 30 }, { execFileImpl, accountBrowserFallback: true });
  const result = await provider.collect({ id: 1, type: "account", label: "offline", locator: SEC, metadata: {} });
  assert.equal(result.raw.worksFallbackErrorCode, "collector_error");
  assert.deepEqual(result.raw.worksFallbackDiagnostics, sanitizeBrowserWorksDiagnostics(browserItem.failureDiagnostics));
  assert.equal(result.raw.worksFallbackDiagnostics.firstScreen.scriptCount, 7);
  assert.equal(result.snapshot.followers, 10);
  assert.equal(result.snapshot.totalLikes, 20);
  assert.equal(result.snapshot.totalPosts, 2);
  assert.deepEqual(result.posts, []);
  assert.equal(result.worksCoverage, "unavailable");
  assert.equal(result.sourceChecksum, checksum(result.raw));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET/);
});

test("real collector: legitimate first-page works retain exact metrics, ownership and completeness", async () => {
  const page = new Page(p => {
    const request = p.request(); p.emit("request", request);
    p.emit("response", { request: () => request, url: request.url, status: () => 200,
      json: async () => ({ status_code: 0, has_more: 0, max_cursor: 0, aweme_list: [{
        aweme_id: "12345678901234567", author: { sec_uid: SEC }, statistics: { digg_count: 17 },
      }] }),
    });
  });
  withDom(page);
  const result = await run(page);
  assert.equal(result.status, "ok");
  assert.equal(result.worksCoverage, "complete");
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].author.sec_uid, SEC);
  assert.equal(result.posts[0].statistics.digg_count, 17);
  assert.equal(result.posts[0].statistics.play_count, undefined);
  assert.equal(result.failureDiagnostics.stopReason, "success");
  assert.equal(result.errorCode, undefined);
});

test("first-screen sanitizer rejects unrecognized strings, malformed counts and raw content", () => {
  const result = sanitizeBrowserWorksDiagnostics({ version: 1, firstScreen: {
    observation: "PRIVATE_SECRET", readyState: "PRIVATE_SECRET", scriptCount: "1", bodyChildCount: -1,
    jsonScriptCount: Infinity, worksAnchorCount: 1000001, bodyPresent: "yes", renderDataPresent: "true",
    nextDataPresent: {}, html: "PRIVATE_SECRET", cookie: "PRIVATE_SECRET", url: WORKS,
  } });
  assert.deepEqual(result.firstScreen, { observation: "unavailable", readyState: "unknown", bodyPresent: null,
    bodyChildCount: null, scriptCount: null, jsonScriptCount: null, renderDataPresent: null,
    nextDataPresent: null, worksAnchorCount: null });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET|signature|cookie|https:/);
});
