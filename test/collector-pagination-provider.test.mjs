import test from "node:test";
import assert from "node:assert/strict";
import { PublicWebProvider } from "../lib/providers/public-web.mjs";
import { BrowserWorksPagination } from "../lib/browser-works-pagination.mjs";
import { normalizeBrowserWorks } from "../scripts/douyin_browser_collector.mjs";
import { isOfficialMixedProfileEnvelope } from "../lib/official-profile-evidence.mjs";
import { checksum } from "../lib/utils.mjs";

const SEC = "MS4wLjABAAAAPaginationProviderAccount123456";
const UID = "101115710974";
const AT = "2026-09-29T02:00:00.000Z";
const provenance = { mode: "douyin-authorised-browser-post-response", sessionLoaded: true,
  authorisedSessionUsed: true, authenticated: null, authenticationStatus: "not-verified", paidAPI: false, runtimeAI: false, noChallengeBypass: true };
const post = id => ({ aweme_id: String(7000000000000000000n + BigInt(id)), author: { sec_uid: SEC, uid: UID },
  statistics: { digg_count: id } });
function upstream(inventory) {
  return { capturedAt: AT, accountStatus: "validated", accountError: null,
    profile: { user: { sec_uid: SEC, uid: UID, nickname: "offline", follower_count: 12, total_favorited: 33, aweme_count: inventory } },
    worksCoverage: "unavailable", worksErrorCode: "deferred", works: { stopReason: "request-deferred", pagination: { requestCount: 0, pages: [] } },
    provenance: { mode: "guest-ttwid-unsigned-profile", profileMode: "guest-ttwid-unsigned-profile",
      profileEndpoint: "https://www.douyin.com/aweme/v1/web/user/profile/other/",
      accountLocator: "sec_uid", cookiePersisted: false, runtimeAI: false, paidAPI: false } };
}
function browserItem({ partial = false, unknown = false } = {}) {
  const paging = new BrowserWorksPagination({ limit: 30 });
  const pages = partial || unknown ? [[0, [1], 10, unknown ? undefined : true]] : [[0, [1], 10, true], [10, [2], 0, false]];
  for (const [requestCursor, ids, max_cursor, has_more] of pages) {
    const body = { status_code: 0, aweme_list: ids.map(post), max_cursor, has_more };
    paging.accept({ requestCursor, body, normalized: normalizeBrowserWorks(body, SEC, 30), observedAt: AT });
  }
  if (partial) paging.stop("http-rejection", "blocked");
  const result = paging.result(partial ? 2 : pages.length);
  return { key: "1", status: "ok", posts: result.posts, hasMore: result.hasMore,
    maxCursor: result.maxCursor, worksCoverage: result.coverage, pagination: result.pagination,
    ...(paging.errorCode ? { errorCode: paging.errorCode } : {}) };
}
async function collect(item, { inventory = item.posts.length } = {}) {
  let browserCalls = 0;
  const provider = new PublicWebProvider({ publicPostsPerAccount: 30 }, { accountBrowserFallback: true,
    now: () => Date.parse(AT),
    worksRequestPolicyOptions: { now: () => Date.parse(AT) },
    fetchImpl: () => { throw new Error("Unexpected external request"); },
    execFileImpl: (_file, args, _options, callback) => {
      assert.equal(args[args.indexOf("--operation") + 1], "account");
      assert.equal(args[args.indexOf("--works-mode") + 1], "deferred");
      callback(null, JSON.stringify({ ok: true, data: upstream(inventory) }), "");
    } });
  for (const targetKey of ["one", "two", "three"]) provider.worksRequestPolicy.record("anonymous-http", { targetKey, errorCode: "blocked" });
  provider.runBrowserWorks = async () => { browserCalls++; return { items: [item], provenance }; };
  const result = await provider.collect({ id: 1, type: "account", provider: "public-web", locator: SEC, metadata: {} });
  assert.equal(browserCalls, 1);
  assert.equal(result.snapshot.followers, 12); assert.equal(result.snapshot.totalLikes, 33);
  assert.equal(result.sourceChecksum, checksum(result.raw));
  return { result, provider };
}

test("pagination provider: two normal pages pass actual merge and official mixed-envelope contract", async () => {
  const { result } = await collect(browserItem());
  assert.equal(result.posts.length, 2); assert.equal(result.worksCoverage, "complete");
  assert.equal(result.raw.works.pagination.requestCount, 2); assert.equal(result.raw.works.pagination.pages.length, 2);
  assert.equal(isOfficialMixedProfileEnvelope(result.raw), true);
  assert.equal(result.raw.worksRequestPolicy.browser.errorCode, null);
});

test("pagination provider: partial HTTP403 retains verified works but records endpoint failure", async () => {
  const { result } = await collect(browserItem({ partial: true }), { inventory: 5 });
  assert.equal(result.posts.length, 1); assert.equal(result.worksCoverage, "limited");
  assert.equal(result.raw.worksFallbackErrorCode, "blocked");
  assert.equal(result.raw.worksRequestPolicy.browser.errorCode, "blocked");
  assert.equal(result.raw.works.pagination.stopReason, "http-rejection");
  assert.equal(isOfficialMixedProfileEnvelope(result.raw), true);
});

test("pagination provider: unknown has_more remains null through source normalization", async () => {
  const { result } = await collect(browserItem({ unknown: true }));
  assert.equal(result.worksCoverage, "limited"); assert.equal(result.raw.works.has_more, null);
  assert.equal(result.raw.works.pagination.pages[0].response.has_more, null);
  assert.equal(isOfficialMixedProfileEnvelope(result.raw), true);
});

test("pagination provider: forged counts and cursors are rejected before source evidence is admitted", async t => {
  for (const [name, mutate] of [
    ["collected count", item => { item.pagination.collectedCount++; }],
    ["impossible request budget", item => { item.pagination.requestCount = 33; }],
    ["accepted count", item => { item.pagination.pages[1].acceptedCount++; }],
    ["wrong first cursor", item => { item.pagination.pages[0].requestCursor = 9; }],
    ["discontinuous cursor", item => { item.pagination.pages[1].requestCursor = 11; }],
    ["duplicate cursor", item => { item.pagination.pages[1].requestCursor = 0; }],
    ["raw count", item => { item.pagination.pages[0].rawCount = 0; }],
    ["false earlier end", item => { item.pagination.pages[0].response.has_more = false; }],
    ["mixed account", item => { item.posts[1].author.sec_uid = "MS4wLjABAAAADifferentAccount123456"; }],
    ["error erased", item => { item.pagination.errorCode = "blocked"; }],
  ]) await t.test(name, async () => {
    const item = browserItem(); mutate(item);
    const { result } = await collect(item);
    assert.equal(result.posts.length, 0); assert.equal(result.worksCoverage, "unavailable");
    assert.equal(result.raw.worksFallbackErrorCode, "upstream_changed");
    assert.equal(isOfficialMixedProfileEnvelope(result.raw), false);
  });
});

test("pagination provider: explicit end cannot override conflicting profile inventories", async () => {
  for (const inventory of [1, 3]) {
    const { result } = await collect(browserItem(), { inventory });
    assert.equal(result.posts.length, 2); assert.equal(result.snapshot.totalPosts, inventory);
    assert.equal(result.worksCoverage, "limited"); assert.equal(isOfficialMixedProfileEnvelope(result.raw), true);
  }
});

test("pagination provider: historical single-page browser shape remains accepted", async () => {
  const item = browserItem(); delete item.pagination;
  const { result } = await collect(item);
  assert.equal(result.posts.length, 2); assert.equal(result.worksCoverage, "complete");
  assert.equal(result.raw.works.pagination.requestCount, 1); assert.equal(isOfficialMixedProfileEnvelope(result.raw), true);
});
