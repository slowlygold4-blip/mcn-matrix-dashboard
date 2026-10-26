import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checksum } from "../lib/utils.mjs";
import { selectVerifiedTopicIdentity, readVerifiedTopicIdentity } from "../lib/topic-identity-reuse.mjs";
import { PublicWebProvider } from "../lib/providers/public-web.mjs";

const CID = "7682403649834485803";
const target = { id: 2363, type: "hashtag", provider: "public-web", locator: "一条小团团OvO创作激励计划" };
const now = Date.parse("2026-09-28T14:00:00.000Z");
function evidence(cid = CID) {
  const raw = { challengeId: cid, officialName: "一条小团团ovo创作激励计划", searchKeyword: `#${target.locator}`, hashtag: target.locator,
    capturedAt: "2026-09-21T02:34:38.807Z", provenance: { mode: "douyin-authenticated-browser-search-and-detail", authenticated: true, paidAPI: false, runtimeAI: false } };
  const snapshot = { followers: null, totalLikes: null, totalPosts: null, hashtagParticipants: 309, hashtagViews: 2250643, hashtagPosts: null, authorCount: null };
  const hash = checksum({ tag: raw.hashtag, snapshot, raw: { challengeId: cid, officialName: raw.officialName, searchKeyword: raw.searchKeyword } });
  return { id: 30536, target_id: 2363, captured_at: raw.capturedAt, hashtag_participants: 309, hashtag_views: 2250643,
    quality_status: "validated", source_checksum: hash, raw_json: JSON.stringify(raw), audit_id: 18361, audit_target_id: 2363,
    audit_provider: "public-web", audit_status: "validated", audit_checksum: hash, audit_created_at: "2026-09-21T02:34:38.808Z",
    run_id: 656, started_at: "2026-09-21T02:00:03.504Z", finished_at: "2026-09-21T02:34:38.813Z" };
}
const choose = rows => selectVerifiedTopicIdentity(target, rows, { now });
test("historical official topic identity verifies its original browser checksum and never returns counters", () => {
  const row = evidence(); assert.equal(row.source_checksum, "1666440d0c1db46cb2e31d14747b993c3a4d923870d7a2c75bc73fe5fc185c2f");
  const result = choose([row]); assert.equal(result.challengeId, CID); assert.equal(result.status, "verified");
  assert.equal(result.evidence.snapshotId, 30536); assert.doesNotMatch(JSON.stringify(result), /2250643|hashtagParticipants|hashtagViews/);
});
test("historical topic identity rejects source, checksum, target, time and counter mutation", () => {
  for (const patch of [{ id: 0 }, { audit_id: 0 }, { target_id: 2364 }, { audit_target_id: 2364 }, { audit_provider: "manual" },
    { audit_checksum: "f".repeat(64) }, { source_checksum: "f".repeat(64), audit_checksum: "f".repeat(64) },
    { started_at: "2026-09-21T02:34:38.808Z" }, { finished_at: "2026-09-29T00:00:00.000Z" },
    { captured_at: "2026-02-30T00:00:00.000Z" }, { hashtag_participants: null }, { hashtag_views: 0 }]) {
    assert.equal(choose([{ ...evidence(), ...patch }]).status, "missing", JSON.stringify(patch));
  }
  for (const patch of [{ challengeId: "8888888888888888888" }, { officialName: "别的话题" },
    { capturedAt: "2026-09-21T02:34:38.806Z" },
    { provenance: { mode: "manual", paidAPI: false, runtimeAI: false } }]) {
    const row = evidence(); row.raw_json = JSON.stringify({ ...JSON.parse(row.raw_json), ...patch }); assert.equal(choose([row]).status, "missing");
  }
});
test("conflicting proven IDs and changed locators are never guessed", () => {
  assert.equal(choose([evidence(), evidence("8888888888888888888")]).status, "conflict");
  assert.equal(selectVerifiedTopicIdentity({ ...target, locator: "一条 小团团OvO创作激励计划" }, [evidence()], { now }).status, "missing");
});
const database = rows => ({ db: { prepare(sql) {
  assert.match(sql.trim(), /^SELECT /);
  if (sql.includes("sqlite_master")) {
    assert.match(sql, /name='works_observations'/);
    return { get() { return undefined; } }; // Legacy fixture has no works ledger.
  }
  if (sql.includes("FROM runs")) {
    assert.match(sql, /trigger_type='works-only'/);
    return { all() { return []; } }; // No independent works attempts in this topic fixture.
  }
  return { all() { return sql.includes("SELECT s.id") ? rows : []; } };
} }, listAccountPostsForPool() { return []; } });
test("read-through selector issues only a parameterized SELECT", () => assert.equal(readVerifiedTopicIdentity(database([evidence()]), target, { now }).challengeId, CID));
function provider(rows = [evidence()]) { return new PublicWebProvider({}, { database: database(rows), topicResolverMode: "browser-first" }); }
function current(participants = 7, views = 99) { return { capturedAt: new Date().toISOString(), snapshot: { hashtagParticipants: participants, hashtagViews: views }, raw: {
  scope: "douyin-official-challenge-detail", businessStatusCode: 0, challengeId: CID, officialName: target.locator, participants, views,
  provenance: { mode: "douyin-official-anonymous-challenge-detail", paidAPI: false, runtimeAI: false } }, warnings: [] }; }
test("known identity requests one current detail without browser/search and preserves only new counters", async () => {
  const p = provider(); const calls = []; p.run = async (op, args) => { calls.push({ op, args }); return current(); };
  p.runTopicBrowser = () => assert.fail("must not search");
  const result = await p.collectHashtag(target); assert.deepEqual(calls.map(x => x.op), ["hashtag-detail"]);
  assert.equal(result.snapshot.hashtagParticipants, 7); assert.equal(result.snapshot.hashtagViews, 99);
  assert.equal(result.raw.identityReuse.scope, "historical-identity-only");
});
test("current detail failure, wrong identity, source or time never triggers fallback requests or old-value reuse", async () => {
  for (const mutate of [() => { throw new Error("HTTP403 PRIVATE"); }, v => ({ ...v, raw: { ...v.raw, challengeId: "8888888888888888888" } }),
    v => ({ ...v, raw: { ...v.raw, officialName: "别的话题" } }), v => ({ ...v, raw: { ...v.raw, businessStatusCode: 2483 } }),
    v => ({ ...v, raw: { ...v.raw, scope: "manual" } }), v => ({ ...v, capturedAt: evidence().captured_at }),
    v => ({ ...v, raw: { ...v.raw, participants: 999 } }),
    v => ({ ...v, capturedAt: "2099-01-01T00:00:00.000Z" })]) {
    const p = provider(); let calls = 0; p.run = async () => { calls++; return mutate(current()); };
    const result = await p.collectHashtag(target); assert.equal(calls, 1); assert.equal(result.snapshot.hashtagParticipants, null); assert.equal(result.snapshot.hashtagViews, null);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|2250643|登录/);
  }
});
test("current zero counters stay zero and missing counters stay null with warning", async () => {
  for (const [a,b] of [[0,0],[null,2],[2,null],[null,null]]) { const p = provider(); p.run = async () => current(a,b); const result=await p.collectHashtag(target);
    assert.equal(result.snapshot.hashtagParticipants,a);assert.equal(result.snapshot.hashtagViews,b); assert.equal(result.qualityStatus,a===null||b===null?"warning":"validated"); }
});
test("conflicting history sends no current request", async () => { const p=provider([evidence(),evidence("8888888888888888888")]);p.run=()=>assert.fail("conflict");const r=await p.collectHashtag(target);assert.equal(r.snapshot.hashtagViews,null);assert.doesNotMatch(JSON.stringify(r.warnings),/登录/); });

test("Python topic detail requires explicit success, exact identity and integer/null counters", () => {
  const script = fileURLToPath(new URL("../scripts/douyin_public_collector.py", import.meta.url));
  const code = `import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('c',sys.argv[1]);c=importlib.util.module_from_spec(s);s.loader.exec_module(c)\nc.register_guest=lambda:'fixture'\nc.a_bogus_signed_url=lambda *a:'offline'\nresults=[]\nfor p in json.loads(sys.argv[2]):\n c.request_json=lambda *a,**k:p\n try: results.append({'ok':True,'result':c.collect_hashtag_detail('${CID}','${target.locator}')})\n except c.CollectorError: results.append({'ok':False})\nprint(json.dumps(results))`;
  const base = { status_code: 0, ch_info: { cid: CID, cha_name: target.locator, user_count: 0, view_count: 0 } };
  const bad = [{ ...base, status_code: false }, { ...base, status_code: "0" }, { ch_info: base.ch_info },
    { ...base, ch_info: { ...base.ch_info, cid: "8888888888888888888" } }, { ...base, ch_info: { ...base.ch_info, cha_name: "别的话题" } }];
  const inputs = [...bad, base, { ...base, ch_info: { ...base.ch_info, user_count: null, view_count: 1.5 } },
    { ...base, ch_info: { ...base.ch_info, user_count: false, view_count: 9007199254740992 } }];
  const result = spawnSync("/usr/bin/python3", ["-B", "-c", code, script, JSON.stringify(inputs)], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); const rows=JSON.parse(result.stdout);
  assert.ok(rows.slice(0,bad.length).every(r=>r.ok===false)); assert.equal(rows[5].result.snapshot.hashtagParticipants,0);
  for(const r of rows.slice(6)){assert.equal(r.result.snapshot.hashtagParticipants,null);assert.equal(r.result.snapshot.hashtagViews,null);}
});
