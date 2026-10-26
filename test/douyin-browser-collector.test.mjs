import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { collectOne, normalizeBrowserCollectorInput, normalizeBrowserWorks } from "../scripts/douyin_browser_collector.mjs";
import { PublicWebProvider } from "../lib/providers/public-web.mjs";

const SEC_UID = "MS4wLjABAAAAabcdefghijklmnopqrstuvwx";

test("browser collector input enforces sec_uid and bounded batch", () => {
  assert.deepEqual(normalizeBrowserCollectorInput({ items: [{ key: "a", secUid: SEC_UID, limit: 200 }] }), [{ key: "a", secUid: SEC_UID, limit: 100 }]);
  assert.throws(() => normalizeBrowserCollectorInput({ items: [{ key: "a", secUid: "nickname" }] }), /合法 sec_uid/);
  assert.throws(() => normalizeBrowserCollectorInput({ items: Array.from({ length: 33 }, () => ({ secUid: SEC_UID })) }), /不能超过 32/);
});

test("browser works normalizer drops mixed authors and never fabricates zeros", () => {
  const result = normalizeBrowserWorks({ status_code: 0,
    aweme_list: [
      { aweme_id: "12345678901234567", desc: "公开作品", create_time: 1, author: { sec_uid: SEC_UID }, statistics: { digg_count: 9 } },
      { aweme_id: "12345678901234568", author: { sec_uid: "other" }, statistics: { digg_count: 999 } },
    ],
    has_more: false,
    max_cursor: 0,
  }, SEC_UID, 30);
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].statistics.digg_count, 9);
  assert.equal(result.posts[0].statistics.play_count, undefined);
  assert.equal(result.coverage, "latest-public-window", "discarding another author cannot prove a complete page");
});

test("browser works requires an explicit end-of-list value to claim completeness", () => {
  const post = { aweme_id: "12345678901234567", author: { sec_uid: SEC_UID }, statistics: { digg_count: 7 } };
  for (const hasMore of [false, 0, "0"]) {
    const result = normalizeBrowserWorks({ status_code: 0, aweme_list: [post], has_more: hasMore, max_cursor: 0 }, SEC_UID, 1);
    assert.equal(result.coverage, "complete", "exactly filling the local limit is not truncation when no extra rows exist");
    assert.equal(result.posts[0].statistics.digg_count, 7);
    assert.equal(result.hasMore, false);
  }
  for (const hasMore of [undefined, null, "", "false", "garbage", 2, -1, {}, []]) {
    const payload = { status_code: 0, aweme_list: [post], max_cursor: 0 };
    if (hasMore !== undefined) payload.has_more = hasMore;
    const result = normalizeBrowserWorks(payload, SEC_UID, 30);
    assert.equal(result.coverage, "latest-public-window", `invalid end evidence: ${JSON.stringify(hasMore)}`);
    assert.equal(result.posts.length, 1, "uncertain pagination must retain the verified work");
  }
});

test("browser works empty arrays need explicit completion evidence too", () => {
  assert.equal(normalizeBrowserWorks({ status_code: 0, aweme_list: [], has_more: false }, SEC_UID).coverage, "complete");
  assert.equal(normalizeBrowserWorks({ status_code: 0, aweme_list: [] }, SEC_UID).coverage, "latest-public-window");
});

test("browser works truncation and discarded rows cannot claim complete coverage", () => {
  const post = { aweme_id: "12345678901234567", author: { sec_uid: SEC_UID }, statistics: { digg_count: 7 } };
  const anotherPost = { ...post, aweme_id: "12345678901234568" };
  const truncated = normalizeBrowserWorks({ status_code: 0, aweme_list: [post, anotherPost], has_more: false }, SEC_UID, 1);
  assert.equal(truncated.coverage, "latest-public-window");
  assert.equal(truncated.posts.length, 1);
  for (const badRow of [null, {}, { ...post, aweme_id: "bad-id" }, { ...post, aweme_id: "12345678901234569", author: { sec_uid: "another-author" } }, post]) {
    const result = normalizeBrowserWorks({ status_code: 0, aweme_list: [post, badRow], has_more: false }, SEC_UID, 30);
    assert.equal(result.coverage, "latest-public-window");
    assert.equal(result.posts.length, 1);
    assert.equal(result.posts[0].statistics.digg_count, 7);
  }
});

test("browser works normalizer labels a truncated window as limited evidence", () => {
  const result = normalizeBrowserWorks({ status_code: 0,
    aweme_list: [{ aweme_id: "12345678901234567", author: { sec_uid: SEC_UID }, statistics: {} }],
    has_more: true,
    max_cursor: 18,
  }, SEC_UID, 1);
  assert.equal(result.coverage, "latest-public-window");
  assert.equal(result.hasMore, true);
  assert.equal(result.maxCursor, 18);
});

test("a single account's browser 403 does not close a global platform gate", async () => {
  const calls = [];
  const helper = (file, args, options, callback) => {
    calls.push({ file, args });
    const browser = file === process.execPath;
    callback(null, JSON.stringify({ ok: true, data: browser
      ? { items: [{ key: "1", status: "unavailable", errorCode: "blocked", error: "HTTP 403" }] }
      : { profile: { user: { sec_uid: SEC_UID, nickname: "作者", follower_count: 10, total_favorited: 20, aweme_count: 2 } }, worksCoverage: "unavailable", works: { aweme_list: [] }, warnings: ["HTTP 403"] } }), "");
  };
  const provider = new PublicWebProvider({ publicPostsPerAccount: 1 }, { execFileImpl: helper, accountBrowserFallback: true });
  await provider.collect({ id: 1, type: "account", label: "一", locator: SEC_UID, metadata: {} });
  await provider.collect({ id: 2, type: "account", label: "二", locator: SEC_UID, metadata: {} });
  assert.equal(calls.filter((call) => call.file === process.execPath).length, 2);
});

test("provider preserves uncertain browser pagination as limited while retaining metrics", async () => {
  const normalized = normalizeBrowserWorks({ status_code: 0, aweme_list: [{ aweme_id: "12345678901234567", author: { sec_uid: SEC_UID }, statistics: { digg_count: 7 } }] }, SEC_UID, 30);
  const helper = (file, args, options, callback) => {
    const browser = file === process.execPath;
    callback(null, JSON.stringify({ ok: true, data: browser
      ? { items: [{ key: "1", status: "ok", worksCoverage: normalized.coverage, posts: normalized.posts, hasMore: normalized.hasMore, maxCursor: normalized.maxCursor }] }
      : { profile: { user: { sec_uid: SEC_UID, nickname: "作者", follower_count: 10, total_favorited: 20, aweme_count: 2 } }, worksCoverage: "unavailable", works: { aweme_list: [] }, warnings: ["HTTP 403"] } }), "");
  };
  const provider = new PublicWebProvider({ publicPostsPerAccount: 30 }, { execFileImpl: helper, accountBrowserFallback: true });
  const result = await provider.collect({ id: 1, type: "account", label: "fixture", locator: SEC_UID, metadata: {} });
  assert.equal(result.worksCoverage, "limited");
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].likes, 7);
  assert.equal(result.snapshot.followers, 10);
  assert.equal(result.snapshot.totalPosts, 2, "partial work window must not replace the official profile total");
});

function mockPage({ httpStatus, pageUrl = `https://www.douyin.com/user/${SEC_UID}`, navigationError = false, waitError = false, payload } = {}) {
  const handlers = new Map();
  let bodyReads = 0;
  let frameUrl = "about:blank";
  const frame = { url: () => frameUrl };
  const emit = (event, value) => { handlers.get(event)?.(value); }; // Deliberately NOT awaited.
  return {
    handlers, bodyReads: () => bodyReads,
    on: (event, callback) => handlers.set(event, callback),
    off: (event, callback) => { assert.equal(handlers.get(event), callback); handlers.delete(event); },
    mainFrame: () => frame,
    url: () => { if (waitError) throw new Error("browser disconnected signature=TEST_PRIVATE_SECRET"); return pageUrl; },
    goto: async () => {
      const nav = { url: () => `https://www.douyin.com/user/${SEC_UID}`, frame: () => frame, isNavigationRequest: () => true, method: () => "GET" };
      emit("request", nav); frameUrl = nav.url(); emit("framenavigated", frame);
      if (httpStatus) {
        const request = { url: () => `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC_UID}&max_cursor=0&signature=TEST_PRIVATE_SECRET`,
          frame: () => frame, isNavigationRequest: () => false, method: () => "GET" };
        emit("request", request);
        emit("response", { request: () => request, url: request.url, status: () => httpStatus,
          json: async () => { bodyReads += 1; return { status_code: 0, ...payload }; } });
      }
      if (navigationError) throw new Error("navigation failed Cookie=TEST_PRIVATE_SECRET");
    },
  };
}

test("offline page failures preserve contract without reading rejected response bodies", async () => {
  for (const [httpStatus, expected] of [[401, "login_required"], [403, "blocked"], [429, "rate_limited"], [503, "network_error"]]) {
    const page = mockPage({ httpStatus });
    const result = await collectOne(page, { key: "fixture", secUid: SEC_UID, limit: 30 }, { timeoutMs: 60, failureGraceMs: 1, bodyTimeoutMs: 40 });
    assert.equal(result.status, "unavailable");
    assert.equal(result.worksCoverage, "unavailable");
    assert.equal(result.errorCode, expected);
    assert.deepEqual(result.posts, []);
    assert.equal(page.bodyReads(), 0);
    assert.equal(page.handlers.size, 0);
    assert.doesNotMatch(JSON.stringify(result), /TEST_PRIVATE_SECRET|signature=/);
  }
});

test("offline navigation and unexpected browser failures never echo exception text", async () => {
  for (const [options, expected] of [[{ navigationError: true }, "network_error"], [{ waitError: true }, "collector_error"], [{ navigationError: true, pageUrl: "https://www.douyin.com/passport/login" }, "login_required"]]) {
    const page = mockPage(options);
    const result = await collectOne(page, { key: "fixture", secUid: SEC_UID, limit: 30 }, { timeoutMs: 60, failureGraceMs: 1, bodyTimeoutMs: 40 });
    assert.equal(result.errorCode, expected);
    assert.equal(result.status, "unavailable");
    assert.equal(page.handlers.size, 0);
    assert.doesNotMatch(JSON.stringify(result), /TEST_PRIVATE_SECRET|Cookie=|signature=/);
  }
});

test("offline successful page responses preserve metrics and coverage", async () => {
  const page = mockPage({ httpStatus: 200, payload: { aweme_list: [{ aweme_id: "12345678901234567", author: { sec_uid: SEC_UID }, statistics: { digg_count: 18 } }], has_more: true, max_cursor: 18 } });
  const result = await collectOne(page, { key: "fixture", secUid: SEC_UID, limit: 30 }, { timeoutMs: 60, failureGraceMs: 1, bodyTimeoutMs: 40 });
  assert.equal(result.status, "ok");
  assert.equal(result.posts[0].statistics.digg_count, 18);
  assert.equal(result.posts[0].statistics.play_count, undefined);
  assert.equal(result.worksCoverage, "latest-public-window");
  assert.equal(page.handlers.size, 0);
});

test("login and rate-limit failure enums still close the existing provider gate", async () => {
  for (const errorCode of ["login_required", "rate_limited"]) {
    let browserCalls = 0;
    const helper = (file, args, options, callback) => {
      const browser = file === process.execPath;
      if (browser) browserCalls += 1;
      callback(null, JSON.stringify({ ok: true, data: browser
        ? { items: [{ key: "1", status: "unavailable", errorCode, error: "fixed fixture failure" }] }
        : { profile: { user: { sec_uid: SEC_UID, nickname: "作者", follower_count: 10, total_favorited: 20, aweme_count: 2 } }, worksCoverage: "unavailable", works: { aweme_list: [] }, warnings: ["HTTP 403"] } }), "");
    };
    const provider = new PublicWebProvider({ publicPostsPerAccount: 1 }, { execFileImpl: helper, accountBrowserFallback: true });
    for (const id of [1, 2]) await provider.collect({ id, type: "account", label: "fixture", locator: SEC_UID, metadata: {} });
    assert.equal(browserCalls, 1, errorCode);
    assert.equal(provider.accountBrowserGateError, errorCode);
  }
});

test("CLI rejects malformed input without printing parser text or reading browser state", () => {
  // Invalid JSON fails before collectBrowserWorks is called: no state file is
  // read, browser launched or network request made by this subprocess.
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/douyin_browser_collector.mjs", import.meta.url))], {
    input: '{"cookie":"TEST_PRIVATE_SECRET", signature=TEST_PRIVATE_SECRET',
    encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.errorCode, "collector_error");
  assert.doesNotMatch(result.stdout, /TEST_PRIVATE_SECRET|SyntaxError|signature=|cookie/);
});
