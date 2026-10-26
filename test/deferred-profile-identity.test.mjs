import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyDouyinAliasContinuity } from "../lib/identity-continuity.mjs";
import { getSourceWorkIdentityRequest, verifySourceWorkIdentity } from "../lib/source-work-identity.mjs";
import { checksum } from "../lib/utils.mjs";
import { isOfficialDeferredProfileEnvelope } from "../lib/official-profile-evidence.mjs";
import { MonitorDatabase } from "../lib/database.mjs";
import { PublicWebProvider } from "../lib/providers/public-web.mjs";
import { normalizeCollection } from "../lib/providers/normalize.mjs";

const SEC_UID = "MS4wLjABAAAAdeferredProfileIdentityCanonical12345";
const UID = "101115710974";
const VIDEO = "7678272839845855921";
const OLD = "Original_Account";
const PROFILE = "https://www.douyin.com/aweme/v1/web/user/profile/other/";
const REFERENCE = "2026-09-28T12:00:05.000Z";
const modes = ["guest-ttwid-unsigned-profile", "guest-ttwid-unsigned-profile-with-x-bogus-fallback"];

function rawProfile({ deferred = true, at = "2026-09-28T12:00:00.700Z", unique = "Current_Account", mode = modes[0] } = {}) {
  return {
    capturedAt: at,
    profile: { user: { sec_uid: SEC_UID, uid: UID, unique_id: unique, short_id: "0", nickname: "仅展示", follower_count: 0, total_favorited: 12, aweme_count: 3 } },
    accountStatus: "validated", accountError: null,
    worksCoverage: "unavailable", worksErrorCode: deferred ? "deferred" : "http_403",
    works: deferred ? { stopReason: "request-deferred", pagination: { requestCount: 0, pages: [] } } : { aweme_list: [] },
    provenance: { mode: deferred ? mode : `${mode}-a-bogus-posts`, profileMode: mode, profileEndpoint: PROFILE,
      accountLocator: "sec_uid", cookiePersisted: false, runtimeAI: false, paidAPI: false },
  };
}

function fixture(t, { history } = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,provider TEXT,locator TEXT,enabled INTEGER,metadata_json TEXT);
    CREATE TABLE snapshots(id INTEGER PRIMARY KEY,target_id INTEGER,captured_at TEXT,quality_status TEXT,account_status TEXT,source_checksum TEXT,raw_json TEXT);
    CREATE TABLE author_resolution_queue(resolved_target_id INTEGER,suspended_target_enabled INTEGER,status TEXT);`);
  const metadata = { platform: "douyin", douyinId: OLD, evidenceVideoId: VIDEO,
    importSource: { type: "author-spreadsheet", fileName: "原始名单.xlsx", sheetName: "数据明细", sourceRow: 560 } };
  const target = { id: 1, type: "account", provider: "public-web", locator: SEC_UID, enabled: true, metadata };
  db.prepare("INSERT INTO targets VALUES(1,'account','public-web',?,1,?)").run(SEC_UID, JSON.stringify(metadata));
  const insert = raw => db.prepare("INSERT INTO snapshots VALUES(NULL,1,?,'validated','available',?,?)").run(raw.capturedAt, checksum(raw), JSON.stringify(raw));
  for (const raw of history ?? [rawProfile({ deferred: false, at: "2026-09-27T12:00:00Z", unique: OLD })]) insert(raw);
  const raw = rawProfile();
  const evidence = { capturedAt: "2026-09-28T12:00:01.000Z", requestedVideoId: VIDEO,
    response: { status_code: 0, aweme_detail: { aweme_id: VIDEO, author: { sec_uid: SEC_UID, uid: UID, unique_id: OLD, short_id: "0" } } },
    provenance: { mode: "guest-ttwid-a-bogus-video-detail", endpoint: "https://www.douyin.com/aweme/v1/web/aweme/detail/",
      cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  return { db, database: { db }, target, raw, evidence, insert };
}
const continuity = (f, raw = f.raw) => verifyDouyinAliasContinuity(f.database, f.target, raw, { reference: REFERENCE });
const request = (f, raw = f.raw) => getSourceWorkIdentityRequest(f.database, f.target, raw);
const sourceEvent = (f, raw = f.raw, evidence = f.evidence, overrides = {}) => verifySourceWorkIdentity(f.database, f.target,
  { ...raw, sourceIdentityEvidence: evidence }, { provider: "public-web", operation: "identity-work", requestedVideoId: VIDEO,
    requestedAccountId: SEC_UID, sourceBindingChecksum: request(f, raw)?.sourceBindingChecksum, observedAt: REFERENCE, ...overrides });

test("deferred works do not invalidate an official same-dual-ID profile or mutate evidence", t => {
  const f = fixture(t);
  const before = JSON.stringify({ target: f.target, raw: f.raw, rows: f.db.prepare("SELECT * FROM snapshots").all() });
  const changes = f.db.prepare("SELECT total_changes() n").get().n;
  for (const mode of modes) {
    const raw = rawProfile({ mode });
    const event = continuity(f, raw);
    assert.equal(event?.mode, "verified-snapshot-dual-id-continuity");
    assert.equal(event.currentRawSha256, checksum(raw));
    assert.equal(event.submittedAccountId, OLD);
    assert.equal(raw.worksCoverage, "unavailable");
    assert.equal(raw.works.pagination.requestCount, 0);
    assert.equal(raw.profile.user.follower_count, 0);
  }
  assert.equal(f.db.prepare("SELECT total_changes() n").get().n, changes);
  assert.equal(JSON.stringify({ target: f.target, raw: f.raw, rows: f.db.prepare("SELECT * FROM snapshots").all() }), before);
});

test("deferred current profile still requires a fresh original-work dual-ID response", t => {
  const f = fixture(t, { history: [] });
  assert.equal(continuity(f), null, "no historical original ID cannot become alias evidence");
  assert.equal(request(f)?.sourceVideoId, VIDEO);
  assert.equal(verifySourceWorkIdentity(f.database, f.target, f.raw), null);
  const event = sourceEvent(f);
  assert.equal(event?.mode, "official-source-work-profile-cross-check");
  assert.equal(event.sourceAccountId, OLD);
  assert.equal(event.detailResponseChecksum, checksum(f.evidence.response));
  assert.equal(event.currentRawSha256, checksum({ ...f.raw, sourceIdentityEvidence: f.evidence }));
});

test("properly hashed historical deferred profiles remain valid continuity evidence", t => {
  const f = fixture(t, { history: [rawProfile({ at: "2026-09-27T12:00:00.001Z", unique: OLD })] });
  assert.equal(continuity(f)?.priorMatchField, "unique_id");
  assert.equal(continuity(f, rawProfile({ deferred: false }))?.priorMatchField, "unique_id");
});

test("actual Python deferred branch supports identity without making a works request", t => {
  const f = fixture(t);
  const python = String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("collector",sys.argv[1]);c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
user=json.loads(sys.argv[2]); modes=json.loads(sys.argv[3])
c.register_guest=lambda:"isolated-test-value-never-output"
c.observation_timestamp=lambda:"2026-09-28T12:00:00.700Z"
def unexpected(*a,**k): raise AssertionError("deferred branch must not request works")
c.request_json=unexpected
out=[]
for mode in modes:
 c.fetch_public_profile=lambda *a:({"status_code":0,"user":user},mode)
 out.append(c.collect_account(user["sec_uid"],30,works_mode="deferred"))
print(json.dumps(out))
`;
  const child = spawnSync("/usr/bin/python3", ["-B", "-c", python,
    fileURLToPath(new URL("../scripts/douyin_public_collector.py", import.meta.url)), JSON.stringify(f.raw.profile.user), JSON.stringify(modes)],
  { encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.includes("isolated-test-value-never-output"), false);
  for (const raw of JSON.parse(child.stdout)) {
    assert.equal(isOfficialDeferredProfileEnvelope(raw), true);
    assert.equal(continuity(f, raw)?.mode, "verified-snapshot-dual-id-continuity");
    assert.equal(request(f, raw)?.sourceVideoId, VIDEO);
    assert.equal(raw.worksCoverage, "unavailable");
    assert.equal(raw.works.aweme_list, undefined);
  }
});

test("deferred source recognition fails closed on contradictory provenance, lifecycle or works fields", t => {
  const f = fixture(t);
  const changes = [
    raw => { raw.provenance.mode = "manual"; },
    raw => { raw.provenance.profileMode = "guest-ttwid-x-bogus-profile"; raw.provenance.mode = raw.provenance.profileMode; },
    raw => { delete raw.provenance.profileMode; },
    raw => { raw.provenance.profileEndpoint += "?other=account"; },
    raw => { delete raw.provenance.profileEndpoint; },
    raw => { raw.provenance.accountLocator = "nickname"; },
    raw => { raw.provenance.cookiePersisted = true; },
    raw => { raw.provenance.paidAPI = true; },
    raw => { raw.provenance.runtimeAI = true; },
    raw => { raw.provenance.platform = "kuaishou"; },
    raw => { raw.accountStatus = "unavailable"; },
    raw => { raw.accountError = "failed"; },
    raw => { raw.profile.user.user_deleted = true; },
    raw => { raw.status_code = false; },
    raw => { raw.snapshot = {}; },
    raw => { raw.source = {}; },
    raw => { raw.roster = {}; },
    raw => { raw.worksCoverage = "complete"; },
    raw => { raw.worksErrorCode = "http_403"; },
    raw => { raw.works.stopReason = "end-of-list"; },
    raw => { raw.works.pagination.requestCount = "0"; },
    raw => { raw.works.pagination.requestCount = 1; },
    raw => { raw.works.pagination.pages = [{}]; },
    raw => { raw.works.pagination.pages = null; },
    raw => { raw.works.aweme_list = []; },
  ];
  for (const change of changes) {
    const raw = structuredClone(f.raw); change(raw);
    assert.equal(isOfficialDeferredProfileEnvelope(raw), false, change.toString());
    assert.equal(continuity(f, raw), null, change.toString());
    assert.equal(request(f, raw), null, change.toString());
  }
});

test("optional full profile response cannot contradict deferred profile or hide a challenge", t => {
  const f = fixture(t);
  const good = { ...f.raw, profileResponse: { status_code: 0, user: { ...f.raw.profile.user } } };
  assert.ok(continuity(f, good));
  assert.ok(request(f, good));
  for (const patch of [
    response => { response.status_code = 8; },
    response => { response.status_code = false; },
    response => { delete response.status_code; },
    response => { response.user.uid = "1"; },
    response => { response.user.sec_uid += "other"; },
    response => { response.user.user_deleted = true; },
    response => { response.user_info = { ...response.user }; },
    ...["need_login", "login_required", "captcha_required", "verify_required"].map(key => response => { response[key] = true; }),
  ]) {
    const raw = structuredClone(good); patch(raw.profileResponse);
    assert.equal(continuity(f, raw), null);
    assert.equal(request(f, raw), null);
  }
});

test("legacy normal envelopes tolerate missing additions but reject explicit conflicts", t => {
  const f = fixture(t);
  const legacy = rawProfile({ deferred: false });
  delete legacy.provenance.profileEndpoint;
  delete legacy.provenance.profileMode;
  assert.ok(continuity(f, legacy));
  for (const mode of ["guest-ttwid-x-bogus-profile", ...modes]) {
    const raw = rawProfile({ deferred: false, mode });
    assert.ok(continuity(f, raw));
    raw.provenance.profileEndpoint = "https://example.invalid/profile";
    assert.equal(continuity(f, raw), null);
    raw.provenance.profileEndpoint = PROFILE;
    raw.provenance.profileMode = "other";
    assert.equal(continuity(f, raw), null);
  }
});

test("deferred acceptance never relaxes stable identity, raw hash, original ID or time", t => {
  const f = fixture(t);
  for (const change of [
    raw => { raw.profile.user.uid = Number(UID); },
    raw => { raw.profile.user.uid = "99999999999"; },
    raw => { raw.profile.user.sec_uid += "other"; },
    raw => { raw.capturedAt = "2026-09-28T12:00:06.000Z"; },
    raw => { raw.capturedAt = "2026-09-27T12:00:00Z"; },
    raw => { raw.capturedAt = "2026-02-30T12:00:00Z"; },
  ]) {
    const raw = structuredClone(f.raw); change(raw);
    assert.equal(continuity(f, raw), null, change.toString());
  }
  f.db.prepare("UPDATE snapshots SET source_checksum=?").run("f".repeat(64));
  assert.equal(continuity(f), null);
  const noOriginal = fixture(t, { history: [rawProfile({ at: "2026-09-27T12:00:00Z", unique: "Current_Account" })] });
  noOriginal.target.metadata.accountIdMode = "sec_uid-primary";
  assert.equal(continuity(noOriginal), null);
});

test("source work still rejects old, changed or unbound evidence and suspended identities", t => {
  const f = fixture(t);
  for (const change of [
    value => { value.capturedAt = "2026-09-27T12:00:01Z"; },
    value => { value.capturedAt = "2026-09-28T12:00:06Z"; },
    value => { value.response.aweme_detail.author.uid = "2"; },
    value => { value.response.aweme_detail.author.sec_uid += "other"; },
    value => { value.response.aweme_detail.author.unique_id = "Current_Account"; },
    value => { value.response.aweme_detail.aweme_id = "7999999999999999999"; },
    value => { value.response.status_code = 8; },
  ]) {
    const evidence = structuredClone(f.evidence); change(evidence);
    assert.equal(sourceEvent(f, f.raw, evidence), null, change.toString());
  }
  assert.equal(sourceEvent(f, f.raw, f.evidence, { sourceBindingChecksum: "f".repeat(64) }), null);
  f.db.exec("INSERT INTO author_resolution_queue VALUES(1,1,'pending')");
  assert.equal(request(f), null);
  assert.equal(sourceEvent(f), null);
  f.db.exec("UPDATE targets SET enabled=0 WHERE id=1");
  assert.equal(continuity(f), null);
});

test("provider cooldown deferred profile persists a new alias snapshot and audit without changing old evidence or original ID", async t => {
  // Deliberately isolated in-memory schema: never opens the production DB.
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  const target = database.createTarget({ type: "account", provider: "public-web", locator: SEC_UID, label: "隔离身份回归",
    metadata: { platform: "douyin", douyinId: OLD } });
  const old = rawProfile({ deferred: false, unique: OLD, at: "2026-09-27T12:00:00.000Z" });
  const prior = normalizeCollection(target, old, { capturedAt: old.capturedAt });
  prior.accountStatus = "available";
  prior.worksCoverage = "unavailable";
  database.saveCollection(target, null, prior);
  const oldSnapshot = database.db.prepare("SELECT * FROM snapshots WHERE target_id=?").get(target.id);
  const originalMetadata = database.db.prepare("SELECT metadata_json FROM targets WHERE id=?").get(target.id).metadata_json;
  const calls = [];
  const policyNow = Date.parse("2026-09-28T12:00:00.000Z");
  const provider = new PublicWebProvider({}, { database, accountBrowserFallback: true,
    worksRequestPolicyOptions: { now: () => policyNow },
    fetchImpl: () => { throw new Error("network disabled in fixture"); },
    execFileImpl: (_file, args, _options, callback) => {
      const operation = args[args.indexOf("--operation") + 1];
      calls.push({ operation, args });
      assert.equal(operation, "account", "alias proof must not need a video-detail request");
      assert.equal(args[args.indexOf("--works-mode") + 1], "deferred");
      callback(null, JSON.stringify({ ok: true, data: rawProfile({ at: new Date().toISOString() }) }), "");
    } });
  for (const lane of ["anonymous-http", "authorised-browser"])
    for (const targetKey of ["fixture-a", "fixture-b", "fixture-c"])
      provider.worksRequestPolicy.record(lane, { targetKey, errorCode: "blocked" });
  provider.runBrowserWorks = async () => { throw new Error("browser must not start during cooldown"); };
  const runId = database.beginRun("deferred-fixture", target.id, 1);
  const result = await provider.collect(target);
  assert.equal(calls.length, 1);
  assert.equal(result.verifiedIdentity.aliasEvent.mode, "verified-snapshot-dual-id-continuity");
  assert.equal(result.verifiedIdentity.aliasEvent.currentRawSha256, checksum(result.raw));
  assert.equal(result.sourceChecksum, checksum(result.raw));
  assert.equal(result.accountStatus, "available");
  assert.equal(result.worksCoverage, "unavailable");
  assert.equal(result.raw.works.pagination.requestCount, 0);
  assert.equal(result.raw.worksRequestPolicy.anonymous.attempted, false);
  assert.equal(result.raw.worksRequestPolicy.browser.attempted, false);
  assert.deepEqual(result.posts, []);
  assert.deepEqual([result.snapshot.followers, result.snapshot.totalLikes, result.snapshot.totalPosts], [0, 12, 3]);
  database.saveCollection(target, runId, result);
  const snapshots = database.db.prepare("SELECT * FROM snapshots WHERE target_id=? ORDER BY id").all(target.id);
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots[0], oldSnapshot);
  assert.equal(snapshots[1].works_coverage, "unavailable");
  assert.equal(snapshots[1].source_checksum, checksum(result.raw));
  assert.equal(snapshots[1].captured_at, result.raw.capturedAt);
  const audit = database.db.prepare("SELECT * FROM audits WHERE run_id=? AND target_id=?").get(runId, target.id);
  assert.equal(audit.source_checksum, snapshots[1].source_checksum);
  assert.equal(audit.normalized_post_count, 0);
  const event = database.db.prepare("SELECT * FROM account_events WHERE target_id=?").get(target.id);
  assert.equal(event.event_type, "alias");
  assert.equal(event.run_id, runId);
  assert.equal(event.source_checksum, snapshots[1].source_checksum);
  assert.equal(database.getTarget(target.id).metadata.douyinId, OLD);
  assert.equal(database.db.prepare("SELECT metadata_json FROM targets WHERE id=?").get(target.id).metadata_json, originalMetadata);
  assert.equal(database.db.prepare("SELECT COUNT(*) n FROM posts").get().n, 0);
});
