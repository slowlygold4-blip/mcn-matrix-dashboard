import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MonitorDatabase } from "../lib/database.mjs";
import { PublicWebProvider } from "../lib/providers/public-web.mjs";
import { normalizeCollection } from "../lib/providers/normalize.mjs";
import { getSourceWorkIdentityRequest, verifySourceWorkIdentity } from "../lib/source-work-identity.mjs";
import { checksum } from "../lib/utils.mjs";

const SEC_UID = "MS4wLjABAAAAsourceWorkIdentityCanonical12345";
const UID = "101115710974";
const VIDEO_ID = "7678272839845855921";
const ORIGINAL_ID = "1380535635";
const ENDPOINT = "https://www.douyin.com/aweme/v1/web/aweme/detail/";

function fixture(t, metadata = {}) {
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  const target = database.createTarget({ type: "account", provider: "public-web", locator: SEC_UID, label: "原表作者",
    metadata: { platform: "douyin", douyinId: ORIGINAL_ID, evidenceVideoId: VIDEO_ID,
      importSource: { type: "author-spreadsheet", fileName: "原始名单.xlsx", sheetName: "数据明细", sourceRow: 560 },
      resolution: { evidenceVideoId: VIDEO_ID, matchedBy: "douyin-id", publicDouyinId: "WKGD" }, ...metadata } });
  const raw = {
    capturedAt: "2026-09-13T12:00:00Z",
    profile: { user: { sec_uid: SEC_UID, uid: UID, unique_id: "WKGD", short_id: "0", nickname: "当前作者",
      follower_count: 278, total_favorited: 4922, aweme_count: 5 } },
    works: { aweme_list: [] },
    provenance: { mode: "guest-ttwid-unsigned-profile-a-bogus-posts", profileMode: "guest-ttwid-unsigned-profile",
      profileEndpoint: "https://www.douyin.com/aweme/v1/web/user/profile/other/", accountLocator: "sec_uid",
      cookiePersisted: false, runtimeAI: false, paidAPI: false },
  };
  const evidence = {
    capturedAt: "2026-09-13T12:00:01Z", requestedVideoId: VIDEO_ID,
    response: { status_code: 0, aweme_detail: { aweme_id: VIDEO_ID,
      author: { sec_uid: SEC_UID, uid: UID, unique_id: "WKGD", short_id: ORIGINAL_ID, nickname: "昵称不是依据" },
      statistics: { digg_count: 9999999 }, retainedOriginalField: { complete: true } } },
    provenance: { mode: "guest-ttwid-a-bogus-video-detail", endpoint: ENDPOINT,
      cookiePersisted: false, runtimeAI: false, paidAPI: false },
  };
  const request = getSourceWorkIdentityRequest(database, target, raw);
  const transport = { provider: "public-web", operation: "identity-work", requestedVideoId: VIDEO_ID,
    requestedAccountId: SEC_UID, sourceBindingChecksum: request?.sourceBindingChecksum, observedAt: "2026-09-13T12:00:02Z" };
  return { database, target, raw, evidence, transport };
}

function verified(fixture, changes = {}) {
  return verifySourceWorkIdentity(fixture.database, fixture.target,
    { ...fixture.raw, sourceIdentityEvidence: fixture.evidence }, { ...fixture.transport, ...changes });
}

function mockedProvider(fixture, { beforeEvidence, evidence = fixture.evidence } = {}) {
  const calls = [];
  const provider = new PublicWebProvider({}, { database: fixture.database,
    execFileImpl: (_file, args, _options, callback) => {
      const operation = args[args.indexOf("--operation") + 1];
      calls.push({ operation, locator: args[args.indexOf("--locator") + 1] });
      if (operation === "account") callback(null, JSON.stringify({ ok: true, data: fixture.raw }), "");
      else if (operation === "identity-work") {
        beforeEvidence?.();
        callback(null, JSON.stringify({ ok: true, data: evidence }), "");
      } else callback(new Error("Unexpected helper operation"));
    }, fetchImpl: () => { throw new Error("No external requests in fixture"); } });
  return { provider, calls };
}

test("original work short ID proves current dual-ID identity without inventing an alias or mutating inputs", (t) => {
  const f = fixture(t);
  const before = JSON.stringify({ target: f.target, raw: f.raw, evidence: f.evidence });
  const changes = f.database.db.prepare("SELECT total_changes() n").get().n;
  const event = verified(f);
  assert.equal(event.type, "source-id-verification");
  assert.equal(event.submittedAccountId, ORIGINAL_ID);
  assert.equal(event.currentPublicAccountId, "WKGD");
  assert.equal(event.sourceVideoId, VIDEO_ID);
  assert.equal(event.sourceMatchField, "short_id");
  assert.equal(event.sourceAccountId, ORIGINAL_ID);
  assert.equal(event.canonicalAccountId, SEC_UID);
  assert.equal(event.uid, UID);
  assert.equal(event.targetId, f.target.id);
  assert.equal(event.detailResponseChecksum, checksum(f.evidence.response));
  assert.equal(event.currentRawSha256, checksum({ ...f.raw, sourceIdentityEvidence: f.evidence }));
  assert.equal(event.observedAt, f.evidence.capturedAt);
  assert.equal(JSON.stringify({ target: f.target, raw: f.raw, evidence: f.evidence }), before);
  assert.equal(f.database.db.prepare("SELECT total_changes() n").get().n, changes);
});

test("provider fallback performs exactly one original-work helper call before normalization and preserves full response", async (t) => {
  const f = fixture(t);
  // A detail response is not a works feed and must not inject any metrics.
  f.evidence.response.aweme_list = [{ aweme_id: "7999999999999999999", statistics: { digg_count: 99999999 } }];
  const { provider, calls } = mockedProvider(f);
  const result = await provider.collect(f.target);
  assert.deepEqual(calls, [{ operation: "account", locator: SEC_UID }, { operation: "identity-work", locator: VIDEO_ID }]);
  assert.equal(result.verifiedIdentity.aliasEvent, undefined);
  assert.equal(result.verifiedIdentity.sourceEvidenceEvent.type, "source-id-verification");
  assert.equal(result.snapshot.followers, 278);
  assert.equal(result.snapshot.totalLikes, 4922);
  assert.equal(result.posts.length, 0);
  assert.deepEqual(result.raw.sourceIdentityEvidence.response, f.evidence.response);
  assert.equal(result.sourceChecksum, checksum(result.raw));
  assert.equal(result.verifiedIdentity.sourceEvidenceEvent.currentRawSha256, result.sourceChecksum);
  assert.equal(f.raw.sourceIdentityEvidence, undefined);
  const originalMetadata = f.database.db.prepare("SELECT metadata_json FROM targets WHERE id=?").get(f.target.id).metadata_json;
  const runId = f.database.beginRun("fixture", f.target.id, 1);
  f.database.saveCollection(f.target, runId, result);
  const events = f.database.db.prepare("SELECT * FROM account_events WHERE target_id=?").all(f.target.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, "identity");
  assert.equal(events[0].run_id, runId);
  assert.equal(events[0].target_id, f.target.id);
  assert.equal(events[0].source_checksum, result.sourceChecksum);
  assert.equal(checksum(JSON.parse(events[0].raw_json)), result.sourceChecksum);
  assert.deepEqual(JSON.parse(events[0].raw_json), result.raw);
  assert.deepEqual(JSON.parse(events[0].event_json), result.verifiedIdentity.sourceEvidenceEvent);
  assert.equal(f.database.db.prepare("SELECT COUNT(*) n FROM account_events WHERE event_type='alias'").get().n, 0);
  assert.equal(f.database.db.prepare("SELECT metadata_json FROM targets WHERE id=?").get(f.target.id).metadata_json, originalMetadata);
  assert.equal(f.database.getTarget(f.target.id).metadata.douyinId, ORIGINAL_ID);
  const snapshot = f.database.db.prepare("SELECT * FROM snapshots WHERE target_id=?").get(f.target.id);
  assert.equal(snapshot.total_likes, 4922);
  assert.equal(snapshot.source_checksum, result.sourceChecksum);
  assert.deepEqual(JSON.parse(snapshot.raw_json), result.raw);
});

test("matching profiles and valid historical aliases never trigger source-work fallback", async (t) => {
  const f = fixture(t);
  f.raw.profile.user.unique_id = ORIGINAL_ID;
  let mocked = mockedProvider(f);
  assert.equal((await mocked.provider.collect(f.target)).verifiedIdentity.sourceEvidenceEvent, undefined);
  assert.equal(mocked.calls.length, 1);
  const old = structuredClone(f.raw);
  old.capturedAt = "2026-09-01T12:00:00Z";
  f.database.saveCollection(f.target, null, normalizeCollection(f.target, old, { capturedAt: old.capturedAt }));
  f.raw.profile.user.unique_id = "New_Alias";
  mocked = mockedProvider(f);
  const result = await mocked.provider.collect(f.target);
  assert.equal(result.verifiedIdentity.aliasEvent.type, "douyin-account-alias-change");
  assert.equal(result.verifiedIdentity.sourceEvidenceEvent, undefined);
  assert.equal(mocked.calls.length, 1);
});

test("no stored original source, conflicting source IDs or unverified profile identity cause no detail fetch", async (t) => {
  const f = fixture(t);
  const original = structuredClone(f.target.metadata);
  for (const mutation of [
    (data) => { delete data.evidenceVideoId; },
    (data) => { data.resolution.evidenceVideoId = "7999999999999999999"; },
    (data) => { data.resolution.evidenceVideoId = 0; },
    (data) => { data.resolution.evidenceVideoId = ""; },
    (data) => { data.resolution.evidenceVideoId = null; },
    (data) => { data.importSource.type = "guessed-nickname"; },
  ]) {
    f.target.metadata = structuredClone(original);
    mutation(f.target.metadata);
    f.database.db.prepare("UPDATE targets SET metadata_json=? WHERE id=?").run(JSON.stringify(f.target.metadata), f.target.id);
    const { provider, calls } = mockedProvider(f);
    await assert.rejects(provider.collect(f.target), /缺少完整改号连续性证据/);
    assert.equal(calls.length, 1);
  }
  f.target.metadata = original;
  f.database.db.prepare("UPDATE targets SET metadata_json=? WHERE id=?").run(JSON.stringify(original), f.target.id);
  f.raw.profile.user.sec_uid = "MS4wLjABAAAADifferentCanonicalIdentity12345";
  const { provider, calls } = mockedProvider(f);
  await assert.rejects(provider.collect(f.target), /账号 ID 与提交目标不一致/);
  assert.equal(calls.length, 1);
});

test("wrong video, either stable ID, source submitted ID, unsuccessful or malformed response all fail closed", (t) => {
  const f = fixture(t);
  const original = structuredClone(f.evidence);
  for (const mutate of [
    (value) => { value.response.status_code = 4; }, (value) => { value.response.status_code = "0"; },
    (value) => { value.response.aweme_detail.aweme_id = "7999999999999999999"; },
    (value) => { value.response.aweme_detail.aweme_id = Number(VIDEO_ID); },
    (value) => { value.response.aweme_detail.author.sec_uid = "MS4wLjABAAAADifferentCanonicalIdentity12345"; },
    (value) => { delete value.response.aweme_detail.author.sec_uid; },
    (value) => { value.response.aweme_detail.author.uid = "101115710975"; },
    (value) => { value.response.aweme_detail.author.uid = Number(UID); },
    (value) => { delete value.response.aweme_detail.author.uid; },
    (value) => { value.response.aweme_detail.author.short_id = "0"; },
    (value) => { value.response.aweme_detail.author.short_id = Number(ORIGINAL_ID); },
    (value) => { value.response.need_login = true; },
    (value) => { delete value.response.aweme_detail; },
  ]) {
    f.evidence = structuredClone(original); mutate(f.evidence);
    assert.equal(verified(f), null);
  }
});

test("source transport, endpoint, timestamps and exact database source binding cannot be self-asserted", (t) => {
  const f = fixture(t);
  const augmented = { ...f.raw, sourceIdentityEvidence: f.evidence };
  assert.equal(verifySourceWorkIdentity(f.database, f.target, augmented), null);
  for (const changes of [{ provider: "manual" }, { operation: "account" }, { requestedVideoId: "7999999999999999999" },
    { sourceBindingChecksum: "forged" }, { observedAt: "2026-09-13T11:59:00Z" }]) assert.equal(verified(f, changes), null);
  const original = structuredClone(f.evidence);
  for (const change of [
    (evidence) => { evidence.provenance.endpoint = "https://example.com/"; },
    (evidence) => { evidence.provenance.paidAPI = true; },
    (evidence) => { evidence.provenance.mode = "user-supplied-response"; },
    (evidence) => { evidence.capturedAt = "2026-09-14T12:00:00Z"; },
    (evidence) => { evidence.capturedAt = "2026-02-30T12:00:00Z"; },
    (evidence) => { evidence.capturedAt = "2026-09-13T11:59:00Z"; },
  ]) {
    f.evidence = structuredClone(original); change(f.evidence); assert.equal(verified(f), null);
  }
  assert.equal(getSourceWorkIdentityRequest(f.database, f.target, augmented), null, "never reuse a caller-injected raw proof");
});

test("pause, source changes or locator changes during the extra request reject the entire result", async (t) => {
  const f = fixture(t);
  const original = f.database.db.prepare("SELECT * FROM targets WHERE id=?").get(f.target.id);
  for (const beforeEvidence of [
    () => f.database.db.prepare("UPDATE targets SET enabled=0 WHERE id=?").run(f.target.id),
    () => f.database.db.prepare("UPDATE targets SET locator=? WHERE id=?").run("MS4wLjABAAAAChangedCanonicalIdentity12345", f.target.id),
    () => f.database.db.prepare("UPDATE targets SET metadata_json=? WHERE id=?")
      .run(JSON.stringify({ ...f.target.metadata, evidenceVideoId: "7999999999999999999" }), f.target.id),
    () => f.database.db.prepare("UPDATE targets SET metadata_json=? WHERE id=?")
      .run(JSON.stringify({ ...f.target.metadata, douyinId: "New_Submission" }), f.target.id),
  ]) {
    const { provider } = mockedProvider(f, { beforeEvidence });
    await assert.rejects(provider.collect(f.target), /未能.*严格双 ID 证明/);
    assert.equal(f.database.db.prepare("SELECT COUNT(*) n FROM snapshots").get().n, 0);
    f.database.db.prepare("UPDATE targets SET enabled=1,locator=?,metadata_json=? WHERE id=?")
      .run(original.locator, original.metadata_json, f.target.id);
  }
});

test("source short IDs are exact strings and preserve original leading zeros without numeric coercion", (t) => {
  const f = fixture(t, { douyinId: "001380535635" });
  assert.equal(verified(f), null);
  f.evidence.response.aweme_detail.author.unique_id = "001380535635";
  assert.equal(verified(f).sourceMatchField, "unique_id");
  assert.equal(verified(f).submittedAccountId, "001380535635");
});

test("identity-work Python helper retains full official JSON and fails on nonzero status or wrong video", () => {
  const collectorPath = fileURLToPath(new URL("../scripts/douyin_public_collector.py", import.meta.url));
  const python = String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("collector",sys.argv[1])
c=importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
c.register_guest=lambda:"ephemeral-guest-never-output"
c.a_bogus_signed_url=lambda endpoint,params:endpoint+"?aweme_id="+params["aweme_id"]
results=[]
for code,video in [(0,"7678272839845855921"),(5,"7678272839845855921"),("0","7678272839845855921"),(0,"7999999999999999999")]:
    payload={"status_code":code,"aweme_detail":{"aweme_id":video,"author":{"short_id":"1380535635"},"unmodified":{"nested":[1,2,3]}}}
    def request(url,**kwargs):
        assert url.startswith(c.DETAIL_URL)
        assert kwargs["cookie"]=="ephemeral-guest-never-output"
        return payload
    c.request_json=request
    try: results.append({"result":c.collect_identity_work("7678272839845855921")})
    except c.CollectorError as error: results.append({"error":str(error)})
print(json.dumps(results))
`;
  const child = spawnSync("/usr/bin/python3", ["-B", "-c", python, collectorPath], { encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  const results = JSON.parse(child.stdout);
  assert.deepEqual(results[0].result.response.aweme_detail.unmodified, { nested: [1, 2, 3] });
  assert.equal(results[0].result.provenance.endpoint, ENDPOINT);
  assert.equal(results[0].result.requestedVideoId, VIDEO_ID);
  assert.equal(child.stdout.includes("ephemeral-guest-never-output"), false);
  for (const result of results.slice(1)) assert.match(result.error, /未返回成功状态|未严格回显/);
});
