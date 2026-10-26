import assert from "node:assert/strict";
import test from "node:test";
import { WorksRequestPolicy, WORKS_ENDPOINT, projectWorksRequestPolicy, isOccludedNoBoundWorksFailure } from "../lib/works-request-policy.mjs";
import { sanitizeBrowserWorksDiagnostics } from "../lib/douyin-browser-diagnostics.mjs";
import { PublicWebProvider } from "../lib/providers/public-web.mjs";
import { MonitorDatabase } from "../lib/database.mjs";

const NOW = Date.parse("2026-09-26T07:00:00.000Z");
const UID = "MS4wLjABAAAAworksPolicyOfflineFixture";
const target = (id) => ({ id, type: "account", provider: "public-web", label: `Fixture ${id}`, locator: `${UID}${id}`, metadata: {} });
const fixture = (id, errorCode = "blocked") => ({
  capturedAt: new Date(NOW).toISOString(),
  profile: { user: { sec_uid: `${UID}${id}`, nickname: `Fixture ${id}`, follower_count: 10, total_favorited: 20, aweme_count: 5 } },
  worksCoverage: "unavailable", worksErrorCode: errorCode, worksError: "固定错误文本",
  works: { pagination: { requestCount: 1, pages: [] } }, warnings: ["作品暂不可用"],
});

function occludedFailure() {
  return { errorCode: "collector_error", failureStage: "browser-page", failureDiagnostics: sanitizeBrowserWorksDiagnostics({
    version: 1, stopReason: "no-bound-request", finalPageKind: "profile",
    navigation: { observed: true, committed: true, failed: false, timedOut: false },
    requests: { candidate: 0, matched: 0 }, responses: { matched: 0 },
    httpStatuses: [], businessStatusCodes: [],
    firstPageActivation: { state: "blocked", structure: { reason: "visible-gate", gates: {
      version: 1, candidateCount: 8, visibleCount: 7, excludedNavigationCount: 0,
      excludedDecorationCount: 0, decision: "unknown",
      detail: { version: 1, reason: "navigation-absent", worksRegion: "occluded" },
    } } },
  }) };
}

test("strict occluded no-request evidence does not trip browser transport cooldown", () => {
  const evidence = occludedFailure();
  assert.equal(isOccludedNoBoundWorksFailure(evidence), true);
  const policy = new WorksRequestPolicy({ now: () => NOW });
  for (const targetKey of ["a", "b", "c", "d"]) {
    const result = policy.record("authorised-browser", { targetKey, errorCode: "collector_error", failureEvidence: evidence });
    assert.equal(result.errorCode, "collector_error");
    assert.equal(policy.decision("authorised-browser").deferred, false);
  }
  assert.equal(policy.lane("authorised-browser").transientFailures.length, 0);
  // A no-request observation must not erase a preceding genuine failure.
  for (const targetKey of ["a", "b"]) policy.record("authorised-browser", { targetKey, errorCode: "network_error" });
  policy.record("authorised-browser", { targetKey: "occluded", errorCode: "collector_error", failureEvidence: evidence });
  assert.equal(policy.decision("authorised-browser").deferred, false);
  policy.record("authorised-browser", { targetKey: "c", errorCode: "network_error" });
  assert.equal(policy.decision("authorised-browser").deferred, true);
});

test("network errors, incomplete occlusion evidence and server waits keep ordinary cooldown policy", () => {
  const evidence = occludedFailure();
  const nearMiss = structuredClone(evidence);
  nearMiss.failureDiagnostics.firstPageActivation.structure.gates.detail.worksRegion = "confirmed";
  assert.equal(isOccludedNoBoundWorksFailure(nearMiss), false);
  const policy = new WorksRequestPolicy({ now: () => NOW });
  for (const targetKey of ["a", "b", "c"])
    policy.record("authorised-browser", { targetKey, errorCode: "network_error", failureEvidence: evidence });
  assert.equal(policy.decision("authorised-browser").deferred, true);
  const another = new WorksRequestPolicy({ now: () => NOW });
  for (const targetKey of ["a", "b", "c"])
    another.record("authorised-browser", { targetKey, errorCode: "collector_error", failureEvidence: nearMiss });
  assert.equal(another.decision("authorised-browser").deferred, true);
  const hinted = new WorksRequestPolicy({ now: () => NOW });
  hinted.record("authorised-browser", { targetKey: "a", errorCode: "collector_error", failureEvidence: evidence, retryAfterSeconds: 120 });
  assert.equal(hinted.decision("authorised-browser").nextEligibleAt, new Date(NOW + 120_000).toISOString());
});

test("single-account failures and cross-account non-transient business failures do not close a lane", () => {
  const policy = new WorksRequestPolicy({ now: () => NOW });
  for (let n = 0; n < 10; n++) policy.record("anonymous-http", { targetKey: "same", errorCode: "blocked" });
  assert.equal(policy.decision("anonymous-http").deferred, false);
  for (const errorCode of ["network_error", "collector_error"])
    for (let n = 0; n < 10; n++) policy.record("anonymous-http", { targetKey: "same", errorCode });
  for (const errorCode of ["business_error", "upstream_changed", "login_required", "unknown"])
    for (const targetKey of ["one", "two", "three"]) policy.record("anonymous-http", { targetKey, errorCode });
  assert.equal(policy.decision("anonymous-http").deferred, false);
});

test("distinct 403 evidence is windowed, transport-isolated, and cooldown expires without timers", () => {
  let now = NOW;
  const policy = new WorksRequestPolicy({ now: () => now });
  policy.record("anonymous-http", { targetKey: "old", errorCode: "blocked" });
  now += 5 * 60_000;
  for (const targetKey of ["a", "b"]) policy.record("anonymous-http", { targetKey, errorCode: "blocked" });
  assert.equal(policy.decision("anonymous-http").deferred, false);
  const attempted = policy.record("anonymous-http", { targetKey: "c", errorCode: "blocked" });
  assert.equal(attempted.attempted, true);
  assert.equal(attempted.deferred, false);
  assert.equal(policy.decision("anonymous-http").deferred, true);
  assert.equal(policy.decision("authorised-browser").deferred, false);
  now += 15 * 60_000;
  assert.equal(policy.decision("anonymous-http").deferred, false);
  policy.record("anonymous-http", { targetKey: "a" });
  assert.equal(policy.decision("anonymous-http").nextEligibleAt, null);
});

test("valid server wait cannot be shortened; hold and future deadlines survive validated restoration", () => {
  const first = new WorksRequestPolicy({ now: () => NOW });
  const anonymous = first.record("anonymous-http", { errorCode: "rate_limited", retryAfterSeconds: 7200 });
  assert.equal(anonymous.nextEligibleAt, new Date(NOW + 7200_000).toISOString());
  const second = new WorksRequestPolicy({ now: () => NOW + 1000 });
  second.restore({ version: 1, endpoint: WORKS_ENDPOINT, scope: "endpoint-transport", anonymous });
  assert.equal(second.decision("anonymous-http").nextEligibleAt, anonymous.nextEligibleAt);
  second.record("authorised-browser", { errorCode: "rate_limited", retryAfterStatus: "too-long" });
  const third = new WorksRequestPolicy({ now: () => NOW });
  third.restore({ version: 1, endpoint: WORKS_ENDPOINT, scope: "endpoint-transport", browser: second.decision("authorised-browser") });
  assert.equal(third.decision("authorised-browser").reason, "upstream-wait-exceeds-policy");
  assert.throws(() => third.decision("arbitrary-url"));
});

test("shorter new failures and late successes cannot clear an active upstream deadline or hold", () => {
  const policy = new WorksRequestPolicy({ now: () => NOW });
  const wait = policy.record("anonymous-http", { errorCode: "rate_limited", retryAfterSeconds: 7200 });
  for (const data of [{ errorCode: "rate_limited" }, { errorCode: "rate_limited", retryAfterSeconds: 60 }, { errorCode: null }]) {
    const observation = policy.record("anonymous-http", data);
    assert.equal(observation.nextEligibleAt, wait.nextEligibleAt);
    assert.equal(policy.decision("anonymous-http").deferred, true);
    const reopened = new WorksRequestPolicy({ now: () => NOW });
    reopened.restore({ version: 1, endpoint: WORKS_ENDPOINT, scope: "endpoint-transport", anonymous: observation });
    assert.equal(reopened.decision("anonymous-http").nextEligibleAt, wait.nextEligibleAt);
  }
  policy.record("authorised-browser", { errorCode: "rate_limited", retryAfterStatus: "too-long" });
  const lateSuccess = policy.record("authorised-browser", { errorCode: null });
  assert.equal(lateSuccess.errorCode, null, "the late request itself succeeded");
  assert.equal(lateSuccess.cooldownErrorCode, "rate_limited", "the earlier wait still applies");
  assert.equal(policy.decision("authorised-browser").deferred, true);
  const restored = new WorksRequestPolicy({ now: () => NOW });
  restored.restore({ version: 1, endpoint: WORKS_ENDPOINT, scope: "endpoint-transport", browser: lateSuccess });
  assert.equal(restored.decision("authorised-browser").deferred, true);
});

test("malformed persistence cannot suppress requests", () => {
  for (const anonymous of [null, { transport: "anonymous-http", errorCode: "arbitrary-secret", nextEligibleAt: "9999-12-31T00:00:00.000Z" },
    { transport: "anonymous-http", errorCode: "blocked", nextEligibleAt: "2099-02-31T00:00:00.000Z" },
    { transport: "anonymous-http", errorCode: "blocked", nextEligibleAt: new Date(NOW - 1).toISOString() }]) {
    const policy = new WorksRequestPolicy({ now: () => NOW });
    policy.restore({ version: 1, endpoint: WORKS_ENDPOINT, scope: "endpoint-transport", anonymous });
    assert.equal(policy.decision("anonymous-http").deferred, false);
  }
});

test("public policy projection removes arbitrary payloads and validates action/date enums", () => {
  const policy = new WorksRequestPolicy({ now: () => NOW });
  const anonymous = policy.record("anonymous-http", { errorCode: "rate_limited", retryAfterSeconds: 7200 });
  const projected = projectWorksRequestPolicy({ version: 1, endpoint: WORKS_ENDPOINT, scope: "endpoint-transport", cookie: "PRIVATE_SECRET",
    anonymous: { ...anonymous, secret: "PRIVATE_SECRET" }, browser: { ...anonymous, transport: "authorised-browser", attempted: true, deferred: true } });
  assert.deepEqual(projected.anonymous, anonymous);
  assert.equal(projected.browser, undefined);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_SECRET/);
  assert.equal(projectWorksRequestPolicy({ version: 1, endpoint: "arbitrary" }), null);
});

test("three distinct browser failures defer only that lane while anonymous profile requests continue", async () => {
  const provider = new PublicWebProvider({}, { accountBrowserFallback: true, worksRequestPolicyOptions: { now: () => NOW } });
  let browserCalls = 0;
  let profileCalls = 0;
  provider.run = async (_operation, args) => { profileCalls++; return fixture(Number(args[1].slice(-1)), "business_error"); };
  provider.runBrowserWorks = async () => { browserCalls++; return { items: [{ status: "unavailable", errorCode: "blocked", error: "HTTP 403" }] }; };
  for (const id of [1, 2, 3]) await provider.collectAccount(target(id));
  const result = await provider.collectAccount(target(4));
  assert.equal(browserCalls, 3);
  assert.equal(profileCalls, 4);
  assert.equal(result.raw.worksRequestPolicy.anonymous.attempted, true);
  assert.equal(result.raw.worksRequestPolicy.browser.deferred, true);
  assert.equal(result.raw.worksRequestPolicy.browser.attempted, false);
  assert.equal(result.raw.worksFallbackErrorCode, "deferred");
});

test("provider requests only fresh profiles during anonymous cooldown and never manufactures works", async () => {
  const provider = new PublicWebProvider({}, { worksRequestPolicyOptions: { now: () => NOW } });
  const calls = [];
  provider.run = async (_operation, args) => {
    calls.push(args);
    const id = Number(args[1].slice(-1));
    const raw = fixture(id);
    if (args.includes("deferred")) {
      raw.worksErrorCode = "deferred";
      raw.works = { stopReason: "request-deferred", pagination: { requestCount: 0, pages: [] } };
    }
    return raw;
  };
  for (const id of [1, 2, 3]) await provider.collectAccount(target(id));
  const result = await provider.collectAccount(target(4));
  assert.equal(calls.length, 4);
  assert.equal(calls[2].includes("deferred"), false);
  assert.equal(calls[3].includes("deferred"), true);
  assert.equal(result.snapshot.followers, 10);
  assert.equal(result.worksCoverage, "unavailable");
  assert.equal(result.raw.worksErrorCode, "deferred");
  assert.equal(result.raw.works.aweme_list, undefined);
  assert.equal(result.raw.worksRequestPolicy.anonymous.attempted, false);
  assert.equal(result.raw.worksRequestPolicy.anonymous.deferred, true);
});

test("browser fallback does not globally stop after one target 403, and exception text is redacted", async () => {
  const provider = new PublicWebProvider({}, { accountBrowserFallback: true, worksRequestPolicyOptions: { now: () => NOW } });
  provider.run = async (_operation, args) => fixture(Number(args[1].slice(-1)), "network_error");
  let count = 0;
  provider.runBrowserWorks = async () => {
    count++;
    if (count === 3) throw new Error("cookie=PRIVATE_SECRET&signature=PRIVATE_SECRET");
    return { items: [{ status: "unavailable", errorCode: "blocked", error: "HTTP 403" }] };
  };
  await provider.collectAccount(target(1));
  await provider.collectAccount(target(2));
  const result = await provider.collectAccount(target(3));
  assert.equal(count, 3);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET/);
});

test("new provider restores future wait across newer compatibility snapshots without policy", async (t) => {
  const db = new MonitorDatabase(":memory:");
  t.after(() => db.close());
  const author = db.createTarget({ type: "account", label: "Fixture 1", locator: `${UID}1`, provider: "public-web" });
  const first = new PublicWebProvider({}, { database: db, worksRequestPolicyOptions: { now: () => NOW } });
  first.run = async () => {
    const raw = fixture(1, "rate_limited");
    raw.works.pagination.pages = [{ transport: { retryAfterSeconds: 7200, retryAfterStatus: "valid" } }];
    return raw;
  };
  const result = await first.collectAccount(author);
  const runId = db.beginRun("manual", author.id, 1);
  db.saveCollection(author, runId, result);
  db.saveCollection(author, runId, { ...result, capturedAt: new Date(NOW + 500).toISOString(), raw: fixture(1) });
  const second = new PublicWebProvider({}, { database: db, worksRequestPolicyOptions: { now: () => NOW + 1000 } });
  assert.equal(second.worksRequestPolicy.decision("anonymous-http").nextEligibleAt, new Date(NOW + 7200_000).toISOString());
  assert.equal(second.worksRequestPolicy.decision("anonymous-http").deferred, true);
});

test("browser success requires a works array; incomplete inventory, invalid or duplicate rows cannot be complete", async () => {
  const post = (id = "12345678901234567") => ({ aweme_id: id, author: { sec_uid: `${UID}1` }, statistics: { digg_count: 3 } });
  for (const [posts, inventory, expected] of [[undefined, 5, "unavailable"], [[], 5, "limited"], [[post()], 5, "limited"],
    [[post(), post()], 2, "limited"], [[post(), null], 2, "limited"], [[post()], 1, "complete"], [[], 0, "complete"]]) {
    const provider = new PublicWebProvider({}, { accountBrowserFallback: true, worksRequestPolicyOptions: { now: () => NOW } });
    provider.run = async () => { const raw = fixture(1); raw.profile.user.aweme_count = inventory; return raw; };
    provider.runBrowserWorks = async () => ({ items: [{ status: "ok", worksCoverage: "complete", hasMore: false, ...(posts ? { posts } : {}) }] });
    const result = await provider.collectAccount(target(1));
    assert.equal(result.worksCoverage, expected);
    assert.equal(result.snapshot.followers, 10);
    if (posts === undefined) {
      assert.equal(result.raw.works.aweme_list, undefined);
      assert.equal(result.raw.worksRequestPolicy.browser.errorCode, "upstream_changed");
    } else if (expected !== "complete") assert.equal(result.raw.worksCoverage, "latest-public-window");
  }
});

test("three distinct consecutive transient failures pause only their transport for sixty seconds", () => {
  let now = NOW;
  const policy = new WorksRequestPolicy({ now: () => now });
  policy.record("authorised-browser", { targetKey: "a", errorCode: "network_error" });
  policy.record("authorised-browser", { targetKey: "b", errorCode: "collector_error" });
  assert.equal(policy.decision("authorised-browser").deferred, false);
  const third = policy.record("authorised-browser", { targetKey: "c", errorCode: "network_error" });
  assert.equal(third.attempted, true);
  assert.equal(third.deferred, false, "the third request happened; only future requests are deferred");
  assert.equal(policy.decision("authorised-browser").nextEligibleAt, new Date(NOW + 60_000).toISOString());
  assert.equal(policy.decision("anonymous-http").deferred, false);
  now += 59_999;
  assert.equal(policy.decision("authorised-browser").deferred, true);
  now += 1;
  assert.equal(policy.decision("authorised-browser").deferred, false);
});

test("success, non-transient outcomes and unverifiable targets break the transient sequence", () => {
  for (const middle of [{ errorCode: null, targetKey: "success" }, { errorCode: "business_error", targetKey: "business" },
    { errorCode: "blocked", targetKey: "denied" }, { errorCode: "network_error" }]) {
    const policy = new WorksRequestPolicy({ now: () => NOW });
    for (const targetKey of ["a", "b"]) policy.record("authorised-browser", { targetKey, errorCode: "network_error" });
    policy.record("authorised-browser", middle);
    policy.record("authorised-browser", { targetKey: "c", errorCode: "network_error" });
    assert.equal(policy.decision("authorised-browser").deferred, false, JSON.stringify(middle));
  }
});

test("transient evidence expires with the configured window and is not shared across transports", () => {
  let now = NOW;
  const policy = new WorksRequestPolicy({ now: () => now });
  for (const targetKey of ["a", "b"]) policy.record("authorised-browser", { targetKey, errorCode: "network_error" });
  now += 5 * 60_000;
  policy.record("authorised-browser", { targetKey: "c", errorCode: "network_error" });
  for (const targetKey of ["x", "y"]) policy.record("anonymous-http", { targetKey, errorCode: "collector_error" });
  assert.equal(policy.decision("authorised-browser").deferred, false);
  assert.equal(policy.decision("anonymous-http").deferred, false);
});

test("short transient backoff preserves the deadline and reason of longer upstream waits", () => {
  for (const wait of [{ errorCode: "rate_limited", retryAfterSeconds: 7200, retryAfterStatus: "valid" },
    { errorCode: "rate_limited", retryAfterStatus: "too-long" }]) {
    const policy = new WorksRequestPolicy({ now: () => NOW });
    policy.record("authorised-browser", wait);
    const before = policy.decision("authorised-browser");
    for (const targetKey of ["a", "b", "c"]) policy.record("authorised-browser", { targetKey, errorCode: "network_error" });
    const after = policy.decision("authorised-browser");
    assert.equal(after.nextEligibleAt, before.nextEligibleAt);
    assert.equal(after.cooldownErrorCode, "rate_limited");
    assert.equal(after.retryAfterStatus, before.retryAfterStatus);
  }
});

test("transient deadlines restore through the existing safe projection and expire without timers", () => {
  const policy = new WorksRequestPolicy({ now: () => NOW });
  let browser;
  for (const targetKey of ["a", "b", "c"]) browser = policy.record("authorised-browser", { targetKey, errorCode: "collector_error" });
  const projected = projectWorksRequestPolicy({ version: 1, endpoint: WORKS_ENDPOINT, scope: "endpoint-transport", browser });
  assert.equal(projected.browser.cooldownErrorCode, "collector_error");
  const restored = new WorksRequestPolicy({ now: () => NOW + 1000 });
  restored.restore(projected);
  assert.equal(restored.decision("authorised-browser").nextEligibleAt, new Date(NOW + 60_000).toISOString());
  assert.equal(restored.decision("anonymous-http").deferred, false);
  const expired = new WorksRequestPolicy({ now: () => NOW + 60_000 });
  expired.restore(projected);
  assert.equal(expired.decision("authorised-browser").deferred, false);
  assert.doesNotMatch(JSON.stringify(projected), /transientFailures|targetKey/);
});

test("provider transient browser backoff keeps profiles fresh without manufacturing works", async () => {
  const provider = new PublicWebProvider({}, { accountBrowserFallback: true, worksRequestPolicyOptions: { now: () => NOW } });
  let profileCalls = 0, browserCalls = 0;
  provider.run = async (_operation, args) => { profileCalls++; return fixture(Number(args[1].slice(-1)), "business_error"); };
  provider.runBrowserWorks = async () => { browserCalls++; return { items: [{ status: "unavailable", errorCode: "network_error" }] }; };
  for (const id of [1, 2, 3]) await provider.collectAccount(target(id));
  const fourth = await provider.collectAccount(target(4));
  assert.equal(profileCalls, 4);
  assert.equal(browserCalls, 3);
  assert.equal(fourth.snapshot.followers, 10);
  assert.equal(fourth.worksCoverage, "unavailable");
  assert.equal(fourth.raw.works.aweme_list, undefined);
  assert.equal(fourth.raw.worksRequestPolicy.browser.deferred, true);
  assert.equal(fourth.raw.worksRequestPolicy.anonymous.attempted, true);
});
