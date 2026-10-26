import test from "node:test";
import assert from "node:assert/strict";
import { PublicWebProvider } from "../lib/providers/public-web.mjs";
import { checksum } from "../lib/utils.mjs";

const SEC_UID = "MS4wLjABAAAAdiagnosticsFixtureSafeAccount";
const SECRET = "DIAGNOSTICS_PRIVATE_SENTINEL";
const target = { id: 1, type: "account", label: "离线诊断测试", locator: SEC_UID, metadata: {} };
const base = () => ({
  capturedAt: "2026-09-28T12:53:34.700Z",
  profile: { user: { sec_uid: SEC_UID, nickname: "离线账号", follower_count: 10, total_favorited: 20, aweme_count: 2 } },
  worksCoverage: "unavailable", worksErrorCode: "blocked", works: { aweme_list: [] }, warnings: ["作品接口 HTTP 403"],
});
const diagnostics = () => ({
  version: 1,
  navigation: { observed: true, committed: true, failed: false, timedOut: false },
  requests: { candidate: 3, matched: 1, rejected: { frameUnavailable: 0, nonMainFrame: 0, beforeCommit: 1, accountIdentity: 0, firstCursor: 1, method: 0, capacity: 0 } },
  responses: { matched: 1, invalidBodies: 0, bodyTimeouts: 0 },
  runtime: { pageErrorCount: null, pageErrorKinds: [], boundRequestFailedCount: null, navigationErrorKind: "unknown" },
  httpStatuses: [403], businessStatusCodes: [], finalPageKind: "profile", elapsedMs: 123,
  stopReason: "http-rejection",
});
async function collect(item, upstream = base()) {
  let browserCalls = 0;
  const execFileImpl = (file, _args, _options, callback) => {
    const browser = file === process.execPath;
    if (browser) browserCalls += 1;
    callback(null, JSON.stringify({ ok: true, data: browser ? { items: [item] } : upstream }), "");
  };
  const provider = new PublicWebProvider({ publicPostsPerAccount: 30 }, { execFileImpl, accountBrowserFallback: true });
  const result = await provider.collect(target);
  assert.equal(browserCalls, 1, "offline fixture must exercise the actual browser fallback path");
  return { result, provider };
}
const failed = extra => ({ key: "1", status: "unavailable", errorCode: "blocked", error: "固定失败提示", ...extra });
const succeeded = extra => ({
  key: "1", status: "ok", worksCoverage: "latest-public-window", hasMore: true, maxCursor: 10,
  posts: [{ aweme_id: "12345678901234567", author: { sec_uid: SEC_UID }, statistics: { digg_count: 7 } }],
  ...extra,
});

test("browser diagnostics persist allowlisted failed-item observations, never raw URL/header/cookie/errors", async () => {
  const incoming = diagnostics();
  incoming.extra = { cookie: SECRET };
  incoming.headers = { authorization: SECRET };
  incoming.url = `https://www.douyin.com/?signature=${SECRET}`;
  incoming.rawError = `Cookie=${SECRET}`;
  incoming.navigation.url = incoming.url;
  incoming.requests.headers = incoming.headers;
  incoming.requests.rejected.exception = SECRET;
  incoming.responses.cookie = SECRET;
  const { result } = await collect(failed({ failureDiagnostics: incoming, error: `private error ${SECRET}` }));
  assert.deepEqual(result.raw.worksFallbackDiagnostics, diagnostics());
  assert.doesNotMatch(JSON.stringify(result), /DIAGNOSTICS_PRIVATE_SENTINEL|signature=|authorization|rawError/);
  assert.equal(result.snapshot.followers, 10);
  assert.equal(result.snapshot.totalLikes, 20);
  assert.equal(result.snapshot.totalPosts, 2);
  assert.equal(result.worksCoverage, "unavailable");
  assert.equal(result.posts.length, 0);
  assert.equal(result.raw.worksFallbackErrorCode, "blocked");
  assert.equal(result.sourceChecksum, checksum(result.raw), "persisted raw checksum must cover the sanitized diagnostic evidence");
});

test("browser diagnostics also persist on successful items without changing metrics, identity or limited coverage", async () => {
  const incoming = diagnostics(); incoming.httpStatuses = [200]; incoming.businessStatusCodes = [0]; incoming.stopReason = "success";
  const { result } = await collect(succeeded({ failureDiagnostics: incoming }));
  const { result: legacy } = await collect(succeeded());
  assert.deepEqual(result.raw.worksFallbackDiagnostics, incoming);
  assert.deepEqual(result.snapshot, legacy.snapshot);
  assert.deepEqual(result.posts, legacy.posts);
  const { verifiedAt: observedAt, ...identity } = result.verifiedIdentity;
  const { verifiedAt: legacyObservedAt, ...legacyIdentity } = legacy.verifiedIdentity;
  assert.deepEqual(identity, legacyIdentity);
  assert.ok(Number.isFinite(Date.parse(observedAt)) && Number.isFinite(Date.parse(legacyObservedAt)), "each ordinary verification retains its actual observation timestamp");
  assert.equal(result.worksCoverage, legacy.worksCoverage);
  assert.equal(result.worksCoverage, "limited");
  assert.equal(result.posts[0].likes, 7);
  assert.equal(result.posts[0].plays, null, "diagnostics must not fabricate missing play metrics");
});

test("browser diagnostics survive malformed ok-item rejection without manufacturing successful coverage", async () => {
  const { result } = await collect(succeeded({ posts: null, failureDiagnostics: diagnostics() }));
  assert.deepEqual(result.raw.worksFallbackDiagnostics, diagnostics());
  assert.equal(result.raw.worksFallbackErrorCode, "upstream_changed");
  assert.equal(result.worksCoverage, "unavailable");
  assert.deepEqual(result.posts, []);
  assert.equal(result.snapshot.totalPosts, 2);
});

test("browser diagnostics do not require raw error text and missing legacy diagnostics remain absent", async () => {
  const { result } = await collect({ key: "1", status: "unavailable", errorCode: "network_error", failureDiagnostics: diagnostics() });
  assert.deepEqual(result.raw.worksFallbackDiagnostics, diagnostics());
  const { result: legacy } = await collect(failed());
  assert.equal(Object.hasOwn(legacy.raw, "worksFallbackDiagnostics"), false);
  assert.equal(legacy.worksCoverage, "unavailable");
  assert.equal(legacy.snapshot.followers, 10);
});

test("browser diagnostics reject malformed and unsupported versions instead of preserving arbitrary payloads", async () => {
  for (const value of [undefined, null, false, SECRET, [], { version: 2, cookie: SECRET }, { cookie: SECRET }]) {
    const { result } = await collect(failed({ failureDiagnostics: value }));
    assert.equal(Object.hasOwn(result.raw, "worksFallbackDiagnostics"), false, `unsupported diagnostics ${JSON.stringify(value)}`);
    assert.doesNotMatch(JSON.stringify(result), /DIAGNOSTICS_PRIVATE_SENTINEL/);
  }
});

test("browser diagnostics cannot alter existing login-required request-policy gate", async () => {
  const { result, provider } = await collect(failed({ errorCode: "login_required", failureDiagnostics: diagnostics() }));
  assert.equal(provider.accountBrowserGate, false);
  assert.equal(provider.accountBrowserGateError, "login_required");
  assert.equal(result.raw.worksFallbackErrorCode, "login_required");
  assert.deepEqual(result.raw.worksFallbackDiagnostics, diagnostics());
});

test("browser diagnostics invalid types and enums remain unknown and numeric arrays are bounded", async () => {
  const incoming = diagnostics();
  incoming.navigation = { observed: SECRET, committed: 1, failed: null, timedOut: [] };
  incoming.requests.candidate = -1;
  incoming.requests.matched = "0";
  incoming.requests.rejected.beforeCommit = 1_000_001;
  incoming.responses = { matched: 1.5, invalidBodies: false, bodyTimeouts: 0 };
  incoming.elapsedMs = 900_001;
  incoming.finalPageKind = `https://www.douyin.com/?cookie=${SECRET}`;
  incoming.stopReason = `upstream failure ${SECRET}`;
  incoming.httpStatuses = ["403", 99, 600, 403, 403, ...Array.from({ length: 1000 }, (_, i) => 200 + i)];
  incoming.businessStatusCodes = [SECRET, -1, 0, 0, 1.5, Number.MAX_SAFE_INTEGER + 1];
  const { result } = await collect(failed({ failureDiagnostics: incoming }));
  const safe = result.raw.worksFallbackDiagnostics;
  assert.deepEqual(safe.navigation, { observed: null, committed: null, failed: null, timedOut: null });
  assert.equal(safe.requests.candidate, null);
  assert.equal(safe.requests.matched, null);
  assert.equal(safe.requests.rejected.beforeCommit, null);
  assert.deepEqual(safe.responses, { matched: null, invalidBodies: null, bodyTimeouts: 0 });
  assert.equal(safe.elapsedMs, null);
  assert.equal(safe.finalPageKind, "unknown");
  assert.equal(safe.stopReason, "unknown");
  assert.equal(safe.httpStatuses.length, 10);
  assert.equal(new Set(safe.httpStatuses).size, safe.httpStatuses.length);
  assert.ok(safe.httpStatuses.every(value => Number.isInteger(value) && value >= 100 && value <= 599));
  assert.deepEqual(safe.businessStatusCodes, [0]);
  assert.doesNotMatch(JSON.stringify(result), /DIAGNOSTICS_PRIVATE_SENTINEL/);
});

test("browser diagnostic counters cannot become missing account metrics through recursive normalization", async () => {
  const upstream = base();
  for (const field of ["follower_count", "total_favorited", "aweme_count"]) delete upstream.profile.user[field];
  const incoming = { ...diagnostics(), follower_count: 999, total_favorited: 888, aweme_count: 777,
    works: { aweme_list: [{ aweme_id: "12345678901234567", author: { sec_uid: SEC_UID } }] } };
  const { result } = await collect(failed({ failureDiagnostics: incoming }), upstream);
  assert.equal(result.snapshot.followers, null);
  assert.equal(result.snapshot.totalLikes, null);
  assert.equal(result.snapshot.totalPosts, null);
  assert.deepEqual(result.posts, []);
  assert.deepEqual(result.raw.worksFallbackDiagnostics, diagnostics());
});

test("single-item browser subprocess has a 150s parent budget without changing its input or abort signal", async () => {
  const controller = new AbortController();
  let capturedOptions, capturedArgs, input;
  const provider = new PublicWebProvider({}, { execFileImpl: (file, args, options, callback) => {
    assert.equal(file, process.execPath);
    capturedOptions = options; capturedArgs = args;
    return { stdin: { end(value) { input = JSON.parse(value); queueMicrotask(() => callback(null, JSON.stringify({ ok: true, data: { items: [] } }), "")); } } };
  } });
  provider.signal = controller.signal;
  const item = { key: "fixture", secUid: SEC_UID, limit: 30 };
  await provider.runBrowserWorks(item);
  assert.deepEqual(input, { items: [item] });
  assert.equal(capturedArgs.length, 1);
  assert.match(capturedArgs[0], /douyin_browser_collector\.mjs$/);
  assert.equal(capturedOptions.timeout, 150_000);
  assert.equal(capturedOptions.signal, controller.signal);
  assert.equal(capturedOptions.maxBuffer, 24 * 1024 * 1024);
});

test("pre-aborted browser subprocess never starts and in-flight abort is propagated unchanged", async () => {
  const before = new AbortController(); before.abort(); let starts = 0;
  const provider = new PublicWebProvider({}, { execFileImpl() { starts += 1; } });
  provider.signal = before.signal;
  await assert.rejects(provider.runBrowserWorks({ key: "fixture", secUid: SEC_UID }), { name: "AbortError" });
  assert.equal(starts, 0);
  const during = new AbortController();
  const active = new PublicWebProvider({}, { execFileImpl: (_file, _args, options, callback) => ({ stdin: { end() {
    queueMicrotask(() => { during.abort(); callback(during.signal.reason, "", ""); });
    assert.equal(options.signal, during.signal);
  } } }) });
  active.signal = during.signal;
  await assert.rejects(active.runBrowserWorks({ key: "fixture", secUid: SEC_UID }), { name: "AbortError" });
});

test("browser subprocess timeout preserves the successful profile without publishing fabricated works", async () => {
  const provider = new PublicWebProvider({}, { accountBrowserFallback: true, execFileImpl: (file, _args, options, callback) => {
    if (file === process.execPath) {
      assert.equal(options.timeout, 150_000);
      callback(Object.assign(new Error(`private process failure ${SECRET}`), { killed: true, signal: "SIGTERM" }), "", `private stderr ${SECRET}`);
    } else callback(null, JSON.stringify({ ok: true, data: base() }), "");
  } });
  const result = await provider.collect(target);
  assert.equal(result.snapshot.followers, 10);
  assert.equal(result.snapshot.totalLikes, 20);
  assert.equal(result.snapshot.totalPosts, 2);
  assert.equal(result.worksCoverage, "unavailable");
  assert.deepEqual(result.posts, []);
  assert.equal(result.raw.worksFallbackErrorCode, "collector_error");
  assert.doesNotMatch(JSON.stringify(result), /DIAGNOSTICS_PRIVATE_SENTINEL/);
});

test("the single-account timeout does not shorten topic or author-evidence process budgets", async () => {
  const budgets = [];
  const provider = new PublicWebProvider({}, { execFileImpl: (_file, _args, options, callback) => {
    budgets.push(options.timeout);
    return { stdin: { end() { queueMicrotask(() => callback(null, JSON.stringify({ ok: true, data: { items: [] } }), "")); } } };
  } });
  await provider.runTopicBrowser(["离线话题"]);
  await provider.run("resolve-authors", ["--workers", "4"], JSON.stringify({ items: [] }));
  assert.deepEqual(budgets, [120_000, 900_000]);
});
