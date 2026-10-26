import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { verifyDouyinAliasContinuity } from "../lib/identity-continuity.mjs";
import { checksum } from "../lib/utils.mjs";

const SEC_UID = "MS4wLjABAAAAcontinuityKnownCanonicalId12345";
const OTHER_SEC_UID = "MS4wLjABAAAAcontinuityDifferentCanonicalId";
const UID = "222523170759696";
const reference = new Date("2026-09-13T13:00:00Z");

function profile({ unique = "New_Account", uid = UID, secUid = SEC_UID, at = "2026-09-13T12:00:00Z", short = "0" } = {}) {
  return {
    capturedAt: at,
    profile: { user: { sec_uid: secUid, uid, short_id: short, unique_id: unique, nickname: "昵称不作身份证据", follower_count: 100 } },
    works: { aweme_list: [] },
    provenance: { mode: "guest-ttwid-unsigned-profile-a-bogus-posts", accountLocator: "sec_uid", cookiePersisted: false, runtimeAI: false, paidAPI: false },
  };
}

function fixture(t, { original = "Old_Account", history, metadata = {} } = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,provider TEXT,locator TEXT,enabled INTEGER,metadata_json TEXT);
    CREATE TABLE snapshots(id INTEGER PRIMARY KEY,target_id INTEGER,captured_at TEXT,quality_status TEXT,account_status TEXT,source_checksum TEXT,raw_json TEXT);
  `);
  const values = { platform: "douyin", douyinId: original, ...metadata };
  db.prepare("INSERT INTO targets VALUES(1,'account','public-web',?,1,?)").run(SEC_UID, JSON.stringify(values));
  const target = { id: 1, type: "account", provider: "public-web", locator: SEC_UID, enabled: true, metadata: values };
  const insert = (raw, { id, quality = "validated", account = "available", at = raw.capturedAt, hash = checksum(raw) } = {}) => {
    db.prepare("INSERT INTO snapshots VALUES(?,1,?,?,?,?,?)")
      .run(id ?? null, at, quality, account, hash, JSON.stringify(raw));
  };
  for (const raw of history ?? [profile({ unique: original, at: "2026-09-01T12:00:00Z" })]) insert(raw);
  return { db, target, insert, raw: profile(), database: { db } };
}

test("persistent official original-ID proof accepts same dual-ID alias change without mutations", (t) => {
  const { db, database, target, raw } = fixture(t);
  const beforeDb = JSON.stringify(db.prepare("SELECT * FROM snapshots").all());
  const beforeInput = JSON.stringify({ target, raw });
  const event = verifyDouyinAliasContinuity(database, target, raw, { reference });
  assert.equal(event.mode, "verified-snapshot-dual-id-continuity");
  assert.equal(event.submittedAccountId, "Old_Account");
  assert.equal(event.previousPublicAccountId, "Old_Account");
  assert.equal(event.currentPublicAccountId, "New_Account");
  assert.equal(event.canonicalAccountId, SEC_UID);
  assert.equal(event.uid, UID);
  assert.equal(event.priorSnapshotId, 1);
  assert.equal(event.priorMatchField, "unique_id");
  assert.equal(event.currentRawSha256, checksum(raw));
  assert.equal(event.priorSourceChecksum, db.prepare("SELECT source_checksum FROM snapshots").get().source_checksum);
  assert.match(event.historyEvidenceSha256, /^[a-f0-9]{64}$/);
  assert.equal(event.observedAt, raw.capturedAt);
  assert.equal(JSON.stringify({ target, raw }), beforeInput);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM snapshots").all()), beforeDb);
  assert.equal(JSON.parse(db.prepare("SELECT metadata_json FROM targets").get().metadata_json).douyinId, "Old_Account");
});

test("finds original-ID evidence before later renamed snapshots, including warning-quality profiles", (t) => {
  const { database, target, raw, insert } = fixture(t, { original: "Aa11202759" });
  insert(profile({ unique: "Aa11202759", at: "2026-09-02T06:46:47Z" }), { quality: "warning" });
  insert(profile({ unique: "Zwj_1223", at: "2026-09-02T17:06:30Z" }));
  raw.profile.user.unique_id = "Zwj_1223";
  const event = verifyDouyinAliasContinuity(database, target, raw, { reference });
  assert.equal(event.priorSnapshotId, 2);
  assert.equal(event.historicalSnapshotCount, 3);
});

test("requires raw original-ID mapping and never trusts metadata primary or resolver assertions", (t) => {
  const { database, target, raw } = fixture(t, {
    original: "1380535635", history: [profile({ unique: "WKGD", at: "2026-09-01T12:00:00Z" })],
    metadata: { accountIdMode: "sec_uid-primary", resolution: { matchedBy: "douyin-id", publicDouyinId: "1380535635" } },
  });
  raw.profile.user.unique_id = "WKGD";
  assert.equal(verifyDouyinAliasContinuity(database, target, raw, { reference }), null);
});

test("matches textual IDs with normalization but never numeric coercion", (t) => {
  const { database, target, raw } = fixture(t, { original: " @ＯＬＤ_Account " });
  const event = verifyDouyinAliasContinuity(database, target, raw, { reference });
  assert.equal(event.submittedAccountId, " @ＯＬＤ_Account ");
  for (const original of ["00123", "1e3", "0", 123, true]) {
    target.metadata.douyinId = original;
    database.db.prepare("UPDATE targets SET metadata_json=?").run(JSON.stringify(target.metadata));
    database.db.prepare("DELETE FROM snapshots").run();
    const old = profile({ unique: "123", short: "1000", at: "2026-09-01T12:00:00Z" });
    database.db.prepare("INSERT INTO snapshots VALUES(1,1,?,'validated','available',?,?)")
      .run(old.capturedAt, checksum(old), JSON.stringify(old));
    assert.equal(verifyDouyinAliasContinuity(database, target, raw, { reference }), null);
  }
});

test("supports old numeric short-ID evidence without treating placeholder zero as an ID", (t) => {
  const { database, target, raw } = fixture(t, { original: "27274555030", history: [
    profile({ unique: "", short: "27274555030", at: "2026-09-01T12:00:00Z" }),
  ] });
  const event = verifyDouyinAliasContinuity(database, target, raw, { reference });
  assert.equal(event.priorMatchField, "short_id");
});

test("rejects current sec_uid or uid mismatch, missing stable IDs, deleted profiles and empty new IDs", (t) => {
  const { database, target, raw } = fixture(t);
  for (const changes of [
    { sec_uid: OTHER_SEC_UID }, { uid: "222523170759697" }, { uid: Number(UID) },
    { sec_uid: "" }, { uid: "" }, { user_deleted: true }, { unique_id: "" }, { unique_id: "0" },
    { unique_id: "Old_Account" },
  ]) {
    const current = structuredClone(raw);
    Object.assign(current.profile.user, changes);
    assert.equal(verifyDouyinAliasContinuity(database, target, current, { reference }), null);
  }
});

test("rejects any conflicting stable identity in history, not only the last original-ID match", (t) => {
  const { database, target, raw, insert } = fixture(t);
  insert(profile({ unique: "New_Account", uid: "222523170759697", at: "2026-09-02T12:00:00Z" }));
  assert.equal(verifyDouyinAliasContinuity(database, target, raw, { reference }), null);
});

test("refuses bad hashes, rejected or unusable historical samples and mismatched raw timestamps", (t) => {
  const { database, target, raw } = fixture(t);
  const row = database.db.prepare("SELECT * FROM snapshots").get();
  for (const [field, value] of [
    ["source_checksum", "0".repeat(64)], ["raw_json", "{}"], ["quality_status", "rejected"],
    ["account_status", "unknown"], ["captured_at", "2026-09-02T12:00:00Z"],
  ]) {
    database.db.prepare(`UPDATE snapshots SET ${field}=?`).run(value);
    assert.equal(verifyDouyinAliasContinuity(database, target, raw, { reference }), null);
    database.db.prepare(`UPDATE snapshots SET ${field}=?`).run(row[field]);
  }
});

test("does not cherry-pick valid history around malformed JSON or future samples", (t) => {
  const { database, target, raw, insert } = fixture(t);
  insert(profile({ unique: "New_Account", at: "2026-09-14T12:00:00Z" }));
  assert.equal(verifyDouyinAliasContinuity(database, target, raw, { reference }), null);
  database.db.prepare("DELETE FROM snapshots WHERE id=2").run();
  assert.equal(verifyDouyinAliasContinuity(database, target, { ...raw, capturedAt: "2026-09-14T12:00:00Z" }, { reference }), null);
  assert.equal(verifyDouyinAliasContinuity(database, target, raw, { reference: "invalid" }), null);
  database.db.prepare("UPDATE snapshots SET raw_json=?,source_checksum=?")
    .run("{", createHash("sha256").update("{").digest("hex"));
  assert.equal(verifyDouyinAliasContinuity(database, target, raw, { reference }), null);
});

test("strict UTC sample times reject impossible dates, replayed current data and unqualified dates", (t) => {
  const { database, target, raw } = fixture(t);
  for (const capturedAt of ["2026-02-30T12:00:00Z", "2026-09-13", "2026-09-13T12:00:00", "2026-09-01T12:00:00Z"]) {
    assert.equal(verifyDouyinAliasContinuity(database, target, { ...raw, capturedAt }, { reference }), null);
  }
  const invalid = profile({ unique: "Old_Account", at: "2026-02-30T12:00:00Z" });
  database.db.prepare("UPDATE snapshots SET raw_json=?,source_checksum=?,captured_at=?")
    .run(JSON.stringify(invalid), checksum(invalid), invalid.capturedAt);
  assert.equal(verifyDouyinAliasContinuity(database, target, raw, { reference }), null);
});

test("requires official collector provenance; Jixuan, manual and other platforms cannot prove aliases", (t) => {
  const { database, target, raw } = fixture(t);
  const original = JSON.parse(database.db.prepare("SELECT raw_json FROM snapshots").get().raw_json);
  for (const old of [
    { source: "jixuan-douyin-monitor", snapshot: original.profile.user, capturedAt: original.capturedAt },
    { ...original, provenance: { ...original.provenance, mode: "manual" } },
    { ...original, provenance: { ...original.provenance, mode: "bilibili-public-card-relation-wbi-view" } },
    { ...original, provenance: { ...original.provenance, paidAPI: true } },
  ]) {
    database.db.prepare("UPDATE snapshots SET raw_json=?,source_checksum=?").run(JSON.stringify(old), checksum(old));
    assert.equal(verifyDouyinAliasContinuity(database, target, raw, { reference }), null);
  }
  database.db.prepare("UPDATE snapshots SET raw_json=?,source_checksum=?").run(JSON.stringify(original), checksum(original));
  raw.provenance.mode = "manual";
  assert.equal(verifyDouyinAliasContinuity(database, target, raw, { reference }), null);
});

test("paused, deleted, stale-target or non-Douyin accounts never inherit an alias", (t) => {
  const { database, target, raw } = fixture(t);
  for (const sql of [
    "UPDATE targets SET enabled=0", "UPDATE targets SET provider='manual'",
    "UPDATE targets SET metadata_json='{\"platform\":\"bilibili\",\"douyinId\":\"Old_Account\"}'",
    "UPDATE targets SET metadata_json='{\"platform\":\"douyin\",\"douyinId\":\"Other_Account\"}'",
    "DELETE FROM targets",
  ]) {
    database.db.exec(sql);
    assert.equal(verifyDouyinAliasContinuity(database, target, raw, { reference }), null);
    database.db.prepare("INSERT OR REPLACE INTO targets VALUES(1,'account','public-web',?,1,?)")
      .run(SEC_UID, JSON.stringify(target.metadata));
  }
  target.enabled = false;
  assert.equal(verifyDouyinAliasContinuity(database, target, raw, { reference }), null);
});
