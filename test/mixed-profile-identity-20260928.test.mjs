import assert from "node:assert/strict";
import test from "node:test";
import { MonitorDatabase } from "../lib/database.mjs";
import { PublicWebProvider } from "../lib/providers/public-web.mjs";
import { normalizeCollection } from "../lib/providers/normalize.mjs";
import { verifyDouyinAliasContinuity } from "../lib/identity-continuity.mjs";
import { getSourceWorkIdentityRequest, verifySourceWorkIdentity } from "../lib/source-work-identity.mjs";
import { checksum } from "../lib/utils.mjs";
import { isOfficialMixedProfileEnvelope, isOfficialDeferredProfileEnvelope } from "../lib/official-profile-evidence.mjs";
import { normalizeBrowserWorks } from "../scripts/douyin_browser_collector.mjs";

const SEC = "MS4wLjABAAAAmixedProfileCanonicalAccount123456";
const UID = "101115710974";
const VIDEO = "7678272839845855921";
const OLD = "Original_Account";
const CURRENT = "Current_Account";
const NOW = "2026-09-28T12:00:00.700Z";
const REF = "2026-09-28T12:00:05.000Z";
const PROFILE = "https://www.douyin.com/aweme/v1/web/user/profile/other/";
const POSTS = "https://www.douyin.com/aweme/v1/web/aweme/post/";
const browserProvenance = () => ({ mode: "douyin-authorised-browser-post-response", sessionLoaded: true,
  authorisedSessionUsed: true, authenticated: null, authenticationStatus: "not-verified", paidAPI: false, runtimeAI: false, noChallengeBypass: true });
const deferred = (inventory = 1) => ({ capturedAt: NOW,
  profile: { user: { sec_uid: SEC, uid: UID, unique_id: CURRENT, short_id: "0", nickname: "只用于展示",
    follower_count: 0, total_favorited: 12, aweme_count: inventory } },
  accountStatus: "validated", accountError: null, worksCoverage: "unavailable", worksErrorCode: "deferred",
  works: { stopReason: "request-deferred", pagination: { requestCount: 0, pages: [] } },
  provenance: { mode: "guest-ttwid-unsigned-profile", profileMode: "guest-ttwid-unsigned-profile", profileEndpoint: PROFILE,
    accountLocator: "sec_uid", cookiePersisted: false, runtimeAI: false, paidAPI: false } });
const post = () => ({ aweme_id: VIDEO, author: { sec_uid: SEC, uid: UID }, create_time: 1790500000,
  desc: "隔离作品", statistics: { digg_count: 5 } });

function mixed({ complete = true, inventory = 1 } = {}) {
  const raw = deferred(inventory);
  raw.worksCoverage = complete ? "complete" : "latest-public-window";
  raw.worksErrorCode = null; raw.worksError = null;
  raw.provenance.worksFallback = browserProvenance();
  raw.worksRequestPolicy = { version: 1, endpoint: "douyin.author_posts", scope: "endpoint-transport",
    anonymous: { transport: "anonymous-http", attempted: false, deferred: true, errorCode: "blocked", cooldownErrorCode: "blocked", nextEligibleAt: "2026-09-28T12:15:00.000Z", reason: "transport-cooldown", retryAfterStatus: null },
    browser: { transport: "authorised-browser", attempted: true, deferred: false, errorCode: null, cooldownErrorCode: null, nextEligibleAt: null, reason: null, retryAfterStatus: null } };
  raw.works = { aweme_list: [post()], has_more: !complete, max_cursor: 123, public_window_limited: !complete,
    stopReason: complete ? "browser-end-of-list" : "browser-public-window",
    pagination: { evidenceScope: "browser-response-sanitized", requestedLimit: 30, requestCount: 1, collectedCount: 1,
      pages: [{ endpoint: POSTS, response: { source: "authorised-browser", has_more: !complete, max_cursor: 123 } }] } };
  return raw;
}

function fixture(t, { history = true } = {}) {
  const database = new MonitorDatabase(":memory:");t.after(() => database.close());
  const target = database.createTarget({ type: "account", provider: "public-web", label: "混合封套隔离测试", locator: SEC,
    metadata: { platform: "douyin", douyinId: OLD, evidenceVideoId: VIDEO,
      importSource: { type: "author-spreadsheet", fileName: "原表.xlsx", sheetName: "数据明细", sourceRow: 560 } } });
  if (history) {
    const raw = deferred();raw.capturedAt = "2026-09-27T12:00:00Z";raw.profile.user.unique_id = OLD;
    raw.provenance.mode += "-a-bogus-posts";raw.works = { aweme_list: [] };
    const collection = normalizeCollection(target, raw, { capturedAt: raw.capturedAt });
    Object.assign(collection, { accountStatus: "available", worksCoverage: "unavailable", qualityStatus: "validated" });
    database.saveCollection(target, null, collection);
  }
  return { database, target };
}
const alias = (f, raw) => verifyDouyinAliasContinuity(f.database, f.target, raw, { reference: REF });

test("actual provider mixed success retains original profile identity and persists only verified works coverage", async t => {
  const f = fixture(t);
  const calls = [];let browserCalls = 0;
  const provider = new PublicWebProvider({ publicPostsPerAccount: 30 }, { database: f.database, accountBrowserFallback: true,
    worksRequestPolicyOptions: { now: () => Date.parse(NOW) },
    fetchImpl: () => { throw new Error("No network in fixture"); },
    execFileImpl: (_file, args, _options, callback) => {
      const operation = args[args.indexOf("--operation") + 1];calls.push(operation);
      if (operation !== "account") return callback(new Error("Unexpected identity-work fallback"));
      assert.equal(args[args.indexOf("--works-mode") + 1], "deferred");
      callback(null, JSON.stringify({ ok: true, data: deferred() }), "");
    } });
  for (const targetKey of ["a", "b", "c"]) provider.worksRequestPolicy.record("anonymous-http", { targetKey, errorCode: "blocked" });
  provider.runBrowserWorks = async () => { browserCalls++;return { items: [{ status: "ok", posts: [post()],
    worksCoverage: "complete", hasMore: false, maxCursor: 123 }], provenance: browserProvenance() }; };
  const old = f.database.db.prepare("SELECT * FROM snapshots").all();
  const metadata = f.database.db.prepare("SELECT metadata_json FROM targets WHERE id=?").get(f.target.id).metadata_json;
  const result = await provider.collect(f.target);
  assert.deepEqual(calls, ["account"]);assert.equal(browserCalls, 1);
  assert.equal(result.verifiedIdentity.aliasEvent.mode, "verified-snapshot-dual-id-continuity");
  assert.equal(result.verifiedIdentity.aliasEvent.currentRawSha256, checksum(result.raw));
  assert.equal(result.snapshot.totalLikes, 12);
  assert.equal(result.worksCoverage, "complete");assert.equal(result.posts.length, 1);
  assert.equal(result.raw.provenance.mode, "guest-ttwid-unsigned-profile");
  assert.equal(result.raw.worksRequestPolicy.anonymous.attempted, false);
  assert.equal(result.raw.worksRequestPolicy.browser.attempted, true);
  const run = f.database.beginRun("offline-mixed-fixture", f.target.id, 1);
  f.database.saveCollection(f.target, run, result);
  assert.deepEqual(f.database.db.prepare("SELECT * FROM snapshots ORDER BY id LIMIT 1").all(), old);
  assert.equal(f.database.db.prepare("SELECT source_checksum FROM audits WHERE run_id=?").get(run).source_checksum, checksum(result.raw));
  assert.equal(f.database.db.prepare("SELECT metadata_json FROM targets WHERE id=?").get(f.target.id).metadata_json, metadata);
});

test("real browser normalizer absent UID survives provider and isolated persistence as a limited window", async t => {
  const f = fixture(t);
  const upstreamPost = post();delete upstreamPost.author.uid;
  const browser = normalizeBrowserWorks({ status_code: 0, aweme_list: [upstreamPost], has_more: 1 }, SEC);
  assert.equal(browser.posts[0].author.uid, "", "this is the collector's real missing UID representation");
  assert.equal(browser.maxCursor, null);
  let requests = 0;
  const provider = new PublicWebProvider({ publicPostsPerAccount: 30 }, { database: f.database, accountBrowserFallback: true,
    worksRequestPolicyOptions: { now: () => Date.parse(NOW) },
    fetchImpl: () => { throw new Error("No network in fixture"); },
    execFileImpl: (_file, args, _options, callback) => {
      requests++;
      assert.equal(args[args.indexOf("--operation") + 1], "account");
      assert.equal(args[args.indexOf("--works-mode") + 1], "deferred");
      callback(null, JSON.stringify({ ok: true, data: deferred(200) }), "");
    } });
  for (const targetKey of ["a", "b", "c"]) provider.worksRequestPolicy.record("anonymous-http", { targetKey, errorCode: "blocked" });
  provider.runBrowserWorks = async () => ({ provenance: browserProvenance(),
    items: [{ status: "ok", ...browser, worksCoverage: browser.coverage }] });
  const old = f.database.db.prepare("SELECT * FROM snapshots").all();
  const result = await provider.collect(f.target);
  assert.equal(requests, 1, "no extra source work request substitutes for missing post UID");
  assert.equal(result.verifiedIdentity.aliasEvent.uid, UID, "profile dual ID is still required");
  assert.equal(result.raw.works.aweme_list[0].author.uid, "");
  assert.equal(result.raw.worksCoverage, "latest-public-window");
  assert.equal(result.worksCoverage, "limited");
  assert.equal(result.posts.length, 1);assert.equal(result.snapshot.totalPosts, 200);
  assert.equal(result.snapshot.totalLikes, 12);assert.equal(result.snapshot.followers, 0);
  const run = f.database.beginRun("offline-sanitized-mixed-fixture", f.target.id, 1);
  f.database.saveCollection(f.target, run, result);
  assert.deepEqual(f.database.db.prepare("SELECT * FROM snapshots ORDER BY id LIMIT 1").all(), old);
  const saved = f.database.db.prepare("SELECT works_coverage,source_checksum FROM snapshots ORDER BY id DESC LIMIT 1").get();
  assert.equal(saved.works_coverage, "limited");assert.equal(saved.source_checksum, checksum(result.raw));
  assert.equal(f.database.db.prepare("SELECT source_checksum FROM audits WHERE run_id=?").get(run).source_checksum, checksum(result.raw));
});

test("normalizer missing post UID is distinct from an explicit contradiction and never replaces profile UID", t => {
  const f = fixture(t);
  for (const value of [undefined, null, "", UID]) {
    const input = post();input.author.uid = value;
    const browser = normalizeBrowserWorks({ status_code: 0, aweme_list: [input], has_more: 0, max_cursor: 0 }, SEC);
    const raw = mixed();raw.works.aweme_list = browser.posts;
    assert.equal(isOfficialMixedProfileEnvelope(raw), true);
    assert.ok(alias(f, raw));
    delete raw.profile.user.uid;
    assert.equal(alias(f, raw), null, "works without UID cannot fill a missing stable profile ID");
  }
  const contradictory = post();contradictory.author.uid = "999999999999";
  const browser = normalizeBrowserWorks({ status_code: 0, aweme_list: [contradictory], has_more: 0 }, SEC);
  const raw = mixed();raw.works.aweme_list = browser.posts;
  assert.equal(isOfficialMixedProfileEnvelope(raw), false);
  assert.equal(alias(f, raw), null);
  for (const value of [null, false, 0, " ", Number(UID)]) {
    const invalid = mixed();invalid.works.aweme_list[0].author.uid = value;
    assert.equal(isOfficialMixedProfileEnvelope(invalid), false, "un-normalized explicit UID is not missing");
  }
});

test("mixed profile still needs a current original-work response when historical original ID is absent", t => {
  const f = fixture(t, { history: false });const raw = mixed();
  assert.equal(alias(f, raw), null);
  const request = getSourceWorkIdentityRequest(f.database, f.target, raw);
  assert.equal(request?.sourceVideoId, VIDEO);
  const evidence = { capturedAt: "2026-09-28T12:00:01.000Z", requestedVideoId: VIDEO,
    response: { status_code: 0, aweme_detail: { aweme_id: VIDEO, author: { sec_uid: SEC, uid: UID, unique_id: OLD } } },
    provenance: { mode: "guest-ttwid-a-bogus-video-detail", endpoint: "https://www.douyin.com/aweme/v1/web/aweme/detail/", cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  const event = verifySourceWorkIdentity(f.database, f.target, { ...raw, sourceIdentityEvidence: evidence },
    { provider: "public-web", operation: "identity-work", requestedVideoId: VIDEO, requestedAccountId: SEC,
      sourceBindingChecksum: request.sourceBindingChecksum, observedAt: REF });
  assert.equal(event?.mode, "official-source-work-profile-cross-check");
});

test("bounded mixed windows preserve partial status and legacy evidence without claiming current login", t => {
  const f = fixture(t);
  for (const complete of [true, false]) {
    const raw = mixed({ complete, inventory: complete ? 1 : 200 });
    assert.equal(isOfficialMixedProfileEnvelope(raw), true);
    assert.equal(isOfficialDeferredProfileEnvelope(raw), false, "browser works did occur");
    assert.ok(alias(f, raw));
    raw.provenance.worksFallback = { mode: "douyin-authorised-browser-post-response", authenticated: true,
      paidAPI: false, runtimeAI: false, noChallengeBypass: true };
    assert.ok(alias(f, raw));
    assert.equal(raw.worksCoverage, complete ? "complete" : "latest-public-window");
  }
  const empty = mixed({ complete: true, inventory: 0 });
  empty.works.aweme_list = [];empty.works.pagination.collectedCount = 0;
  assert.ok(alias(f, empty), "strict empty inventory is not missing metrics");
});

test("mixed source recognition rejects contradictory profile, policy, page and per-work identity", t => {
  const f = fixture(t);
  const mutations = [
    raw => { raw.provenance.profileEndpoint += "?other=1"; },
    raw => { raw.provenance.profileMode = "unknown-profile"; raw.provenance.mode = raw.provenance.profileMode; },
    raw => { raw.provenance.cookiePersisted = true; },
    raw => { raw.accountStatus = "unavailable"; },
    raw => { raw.accountError = "failed"; },
    raw => { raw.profile.user.user_deleted = true; },
    raw => { raw.profileResponse = { status_code: 1, user: raw.profile.user }; },
    raw => { raw.roster = {}; },
    raw => { raw.worksErrorCode = "network_error"; },
    raw => { raw.worksError = "failed"; },
    raw => { raw.worksFallbackErrorCode = "blocked"; },
    raw => { raw.provenance.worksFallback.mode = "browser-anything"; },
    raw => { raw.provenance.worksFallback.noChallengeBypass = false; },
    raw => { raw.provenance.worksFallback.paidAPI = true; },
    raw => { raw.provenance.worksFallback.runtimeAI = true; },
    raw => { raw.provenance.worksFallback.sessionLoaded = false; },
    raw => { raw.provenance.worksFallback.authorisedSessionUsed = false; },
    raw => { raw.provenance.worksFallback.authenticationStatus = "verified"; },
    raw => { delete raw.worksRequestPolicy; },
    raw => { raw.worksRequestPolicy.version = 2; },
    raw => { raw.worksRequestPolicy.endpoint = "another-endpoint"; },
    raw => { raw.worksRequestPolicy.anonymous.attempted = true; },
    raw => { raw.worksRequestPolicy.anonymous.deferred = false; },
    raw => { raw.worksRequestPolicy.browser.attempted = false; },
    raw => { raw.worksRequestPolicy.browser.deferred = true; },
    raw => { raw.worksRequestPolicy.browser.errorCode = "blocked"; },
    raw => { raw.works.pagination.evidenceScope = "manual"; },
    raw => { raw.works.pagination.requestCount = 2; },
    raw => { raw.works.pagination.collectedCount = 0; },
    raw => { raw.works.pagination.requestedLimit = 101; },
    raw => { raw.works.pagination.pages = []; },
    raw => { raw.works.pagination.pages[0].endpoint += "?other=1"; },
    raw => { raw.works.pagination.pages[0].response.source = "imported"; },
    raw => { raw.works.pagination.pages[0].response.has_more = true; },
    raw => { raw.works.pagination.pages[0].response.max_cursor = "124"; },
    raw => { raw.works.max_cursor = {}; },
    raw => { raw.works.aweme_list[0].author.sec_uid += "other"; },
    raw => { raw.works.aweme_list[0].author.uid = "2"; },
    raw => { raw.works.aweme_list[0].aweme_id = Number(VIDEO); },
    raw => { raw.works.aweme_list[0].statistics = []; },
    raw => { raw.works.aweme_list.push(post());raw.works.pagination.collectedCount = 2;raw.profile.user.aweme_count = 2; },
    raw => { raw.profile.user.aweme_count = 2; },
    raw => { raw.works.has_more = true;raw.works.pagination.pages[0].response.has_more = true; },
    raw => { raw.works.public_window_limited = true; },
    raw => { raw.works.stopReason = "browser-public-window"; },
  ];
  for (const mutation of mutations) {
    const raw = mixed();mutation(raw);
    assert.equal(isOfficialMixedProfileEnvelope(raw), false, mutation.toString());
    assert.equal(alias(f, raw), null, mutation.toString());
    assert.equal(getSourceWorkIdentityRequest(f.database, f.target, raw), null, mutation.toString());
  }
});

test("mixed historical evidence keeps its raw hash, real timestamp and original submitted ID binding", t => {
  const f = fixture(t, { history: false });
  const prior = mixed({ complete: false, inventory: 100 });
  prior.capturedAt = "2026-09-27T12:00:00Z";prior.profile.user.unique_id = OLD;
  const collection = normalizeCollection(f.target, prior, { capturedAt: prior.capturedAt });
  Object.assign(collection, { accountStatus: "available", worksCoverage: "limited", qualityStatus: "warning" });
  f.database.saveCollection(f.target, null, collection);
  const raw = mixed();
  assert.ok(alias(f, raw));
  const before = f.database.db.prepare("SELECT total_changes() n").get().n;
  const changes = [
    value => { value.profile.user.uid = "2";value.works.aweme_list[0].author.uid = "2"; },
    value => { value.profile.user.uid = Number(UID); },
    value => { value.capturedAt = "2026-09-27T12:00:00Z"; },
    value => { value.capturedAt = "2026-09-28T12:00:06.000Z"; },
    value => { value.capturedAt = "2026-02-30T12:00:00Z"; },
  ];
  for (const change of changes) { const value = structuredClone(raw);change(value);assert.equal(alias(f, value), null); }
  assert.equal(f.database.db.prepare("SELECT total_changes() n").get().n, before);
  f.database.db.prepare("UPDATE snapshots SET source_checksum=?").run("f".repeat(64));
  assert.equal(alias(f, raw), null, "old raw cannot be edited into a mixed shape without its checksum");
});

test("paused identity, original source changes and missing current detail proof stay blocked for mixed profiles", t => {
  const f = fixture(t);const raw = mixed();
  assert.ok(getSourceWorkIdentityRequest(f.database, f.target, raw));
  assert.equal(verifySourceWorkIdentity(f.database, f.target, raw), null);
  f.database.db.prepare("UPDATE targets SET enabled=0 WHERE id=?").run(f.target.id);
  assert.equal(alias(f, raw), null);
  assert.equal(getSourceWorkIdentityRequest(f.database, f.target, raw), null);
  f.database.db.prepare("UPDATE targets SET enabled=1,metadata_json=? WHERE id=?").run(
    JSON.stringify({ ...f.target.metadata, evidenceVideoId: "7999999999999999999" }), f.target.id);
  assert.equal(getSourceWorkIdentityRequest(f.database, f.target, raw), null);
});
