import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MonitorDatabase } from "../lib/database.mjs";
import { uniqueRoutineAuthorEvidence, authorEvidenceSourceFingerprint } from "../lib/author-evidence-reuse.mjs";

const SEC = "MS4wLjABAAAAabcdefghijklmnopqrstuvwx";
const OTHER = "MS4wLjABBBBBzyxwvutsrqponmlkjihgfedcba";
const VIDEO = "7684617087687331118";
const SHARE = "https://v.douyin.com/ExactCase/?key=Case";
const VERIFIED = "2026-09-13T08:00:00.000Z";
const context = { fileName: "新来源.xlsx", sheetName: "团团", sourceMetadata: {
  sourceType: "lark-sheet", sourceUrl: "https://fixture.feishu.cn/sheets/Book?sheet=A",
  sourceRevision: 42, sourceSha256: "a".repeat(64), sourceSheetId: "A", sourceRange: "A1:F5",
  sourceReadAt: "2026-09-27T20:00:00.000Z",
} };
const item = { key: `douyin:account:${SEC}|new-proof`, name: "提交名", douyinId: "public_id", accountLocator: SEC,
  videoIds: [VIDEO], shareUrls: [SHARE], sourceRows: [2, 3], boards: ["团团"] };

function fixture(t, enabled = 0) {
  const directory = mkdtempSync(join(tmpdir(), "mcn-routine-evidence-"));
  const path = join(directory, "fixture.sqlite");
  const database = new MonitorDatabase(path);
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const target = database.createTarget({ type: "account", provider: "public-web", label: "用户别名", locator: SEC,
    metadata: { platform: "douyin", resolution: { platform: "douyin", mode: "public-video-detail",
      canonicalAccountId: SEC, publicDouyinId: "public_id" } } });
  database.db.prepare("UPDATE targets SET enabled=? WHERE id=?").run(enabled, target.id);
  database.assignTargetsToBoard([target.id], "团团", { sourceType: "user-confirmed", sourceFileName: "用户原始名单.xlsx" });
  database.enqueueAuthorResolutions([{ ...item, key: "douyin:legacy-proof", boards: [] }]);
  const prior = database.db.prepare("SELECT * FROM author_resolution_queue").get();
  database.markAuthorResolutionResolved(prior.id, target.id);
  database.db.prepare("UPDATE author_resolution_queue SET updated_at=? WHERE id=?").run(VERIFIED, prior.id);
  return { database, path, targetId: target.id, priorId: prior.id,
    get: (key = item.key) => database.db.prepare("SELECT * FROM author_resolution_queue WHERE identity_key=?").get(key),
    preserved: () => ({ target: database.db.prepare("SELECT * FROM targets").all(),
      boards: database.db.prepare("SELECT * FROM target_boards").all(),
      boardCatalog: database.db.prepare("SELECT * FROM board_catalog").all(),
      snapshots: database.db.prepare("SELECT * FROM snapshots").all(),
      prior: database.db.prepare("SELECT * FROM author_resolution_queue WHERE id=?").get(prior.id) }) };
}

test("routine import reuses exact old proof atomically without enabling paused authors or manufacturing metrics", (t) => {
  const f = fixture(t), before = f.preserved();
  const result = f.database.enqueueAuthorResolutions([item, item], context);
  assert.equal(result.evidenceReusedCount, 1);
  assert.deepEqual(result.evidenceReusedKeys, [item.key]);
  assert.equal(result.pendingEvidenceRequestCount, 0);
  assert.deepEqual(result.resolvedEvidenceRequestKeys, [item.key]);
  assert.equal(result.alreadyResolvedEvidenceRequestCount, 0);
  const row = f.get(), provenance = JSON.parse(row.source_metadata_json);
  assert.equal(row.resolved_target_id, f.targetId);
  assert.equal(row.status, "resolved");
  assert.deepEqual(JSON.parse(row.source_rows_json), [2, 3]);
  assert.deepEqual(JSON.parse(row.video_ids_json), [VIDEO]);
  assert.deepEqual(JSON.parse(row.share_urls_json), [SHARE]);
  assert.equal(provenance.evidenceReuse.verifiedAt, VERIFIED);
  assert.equal(provenance.evidenceReuse.newPublicCollection, false);
  assert.equal(provenance.evidenceReuse.sourceQueueId, f.priorId);
  assert.equal(provenance.evidenceReuse.sourceFingerprint, authorEvidenceSourceFingerprint(context.sourceMetadata));
  for (const [key, value] of Object.entries(context.sourceMetadata)) assert.deepEqual(provenance[key], value);
  assert.deepEqual(f.preserved(), before);
});

test("same-key reimport preserves the original verification timestamp and cannot upgrade changed evidence", (t) => {
  const f = fixture(t);
  f.database.enqueueAuthorResolutions([item], context);
  const before = f.get();
  const preservedBefore = f.preserved();
  const again = f.database.enqueueAuthorResolutions([item], { ...context, sourceMetadata: { ...context.sourceMetadata, sourceRevision: 43 } });
  assert.equal(again.evidenceReusedCount, 0);
  assert.equal(again.alreadyResolvedEvidenceRequestCount, 1);
  assert.deepEqual(again.verifiedExistingEvidenceRequestKeys, [item.key]);
  assert.equal(again.verifiedExistingEvidenceRequestCount, 1);
  assert.equal(f.get().updated_at, before.updated_at);
  assert.equal(f.get().source_metadata_json, before.source_metadata_json);
  assert.equal(f.get().evidence_version, before.evidence_version);
  assert.deepEqual(f.get(), before, "same evidence must leave every queue field unchanged");
  assert.deepEqual(f.preserved(), preservedBefore, "repeat import cannot refresh catalog, membership, target or original receipt");
  const beforeConflict = f.get();
  assert.throws(() => f.database.enqueueAuthorResolutions([{ ...item, videoIds: ["7684617087687331119"] }], context), /内容冲突/);
  assert.deepEqual(f.get(), beforeConflict);
});

test("same-key resolved reimports still apply genuinely new membership and preserve conflicting fields", (t) => {
  const f = fixture(t);
  f.database.enqueueAuthorResolutions([item], context);
  const savedMembership = f.database.enqueueAuthorResolutions([{ ...item, boards: ["团团", { name: "新主题", owner: "负责人甲" }] }], context);
  const membership = f.database.db.prepare("SELECT * FROM target_boards WHERE target_id=? AND board_key=?").get(f.targetId, "新主题");
  assert.equal(membership.owner, "负责人甲");
  assert.equal(savedMembership.verifiedExistingEvidenceRequestCount, 1, "new membership may be acknowledged only after actually retained");
  const conflicted = f.database.enqueueAuthorResolutions([{ ...item, boards: [{ name: "新主题", owner: "负责人乙" }] }], context);
  assert.equal(conflicted.verifiedExistingEvidenceRequestCount, 0, "incoming owner conflict must remain a review item");
  assert.deepEqual(conflicted.verifiedExistingEvidenceRequestKeys, []);
  const afterConflict = f.database.db.prepare("SELECT * FROM target_boards WHERE target_id=? AND board_key=?").get(f.targetId, "新主题");
  assert.equal(afterConflict.owner, "负责人甲");
  assert.ok(JSON.parse(afterConflict.conflicts_json).some((entry) => entry.field === "owner" && entry.incomingValue === "负责人乙"));
  assert.equal(f.database.db.prepare("SELECT enabled FROM targets WHERE id=?").get(f.targetId).enabled, 0);
});

test("strict existing acknowledgement checks this import even when persistence leaves old board JSON intact", (t) => {
  const f = fixture(t);
  f.database.enqueueAuthorResolutions([item], context);
  const oldBoards = f.get().boards_json;
  f.database.db.prepare("UPDATE target_boards SET owner='用户负责人' WHERE target_id=? AND board_key='团团'").run(f.targetId);
  f.database.db.exec(`CREATE TRIGGER keep_original_board_json AFTER UPDATE OF boards_json ON author_resolution_queue
    WHEN NEW.identity_key='${item.key}' BEGIN UPDATE author_resolution_queue SET boards_json=${JSON.stringify(oldBoards).replace(/^"|"$/g, "'").replaceAll('\\"', '"')} WHERE id=NEW.id; END`);
  const result = f.database.enqueueAuthorResolutions([{ ...item, boards: [{ name: "团团", owner: "不同负责人" }] }], context);
  assert.equal(f.get().boards_json, oldBoards, "fixture retains old queue boards to exercise current-request guard");
  assert.equal(result.verifiedExistingEvidenceRequestCount, 0);
  assert.equal(result.evidenceReusedCount, 0);
  assert.equal(f.database.db.prepare("SELECT owner FROM target_boards WHERE target_id=?").get(f.targetId).owner, "用户负责人");
});

test("new board membership or nonempty changed board fields cannot be silently dropped by reuse", (t) => {
  for (const boards of [["新大主题"], ["团团", "新大主题"], [{ name: "团团", category: "新的二级标签" }],
    [{ name: "团团", owner: "新负责人" }]]) {
    const f = fixture(t), before = f.preserved();
    const result = f.database.enqueueAuthorResolutions([{ ...item, boards }], context);
    assert.equal(result.evidenceReusedCount, 0);
    assert.equal(result.pendingEvidenceRequestCount, 1);
    assert.deepEqual(f.preserved(), before);
  }
});

test("resolved reimport retains original source fields and appends distinct source receipts without losing source rows", (t) => {
  const f = fixture(t);
  f.database.enqueueAuthorResolutions([item], context);
  const original = f.get();
  const source = { ...context, fileName: "补充账号.xlsx", sheetName: "新工作表", sourceMetadata: { ...context.sourceMetadata, sourceRevision: 43 } };
  f.database.enqueueAuthorResolutions([{ ...item, name: "新提交昵称", sourceRows: [45] }], source);
  const result = f.get();
  for (const key of ["name", "file_name", "sheet_name", "source_rows_json", "source_metadata_json", "updated_at", "evidence_version"]) {
    assert.equal(result[key], original[key], key);
  }
  const receipts = f.database.db.prepare("SELECT * FROM author_resolution_import_sources WHERE queue_id=?").all(result.id);
  const payloads = receipts.map((row) => JSON.parse(row.payload_json));
  assert.ok(payloads.some((row) => row.fileName === context.fileName && row.sourceMetadata.sourceRevision === 42));
  assert.ok(payloads.some((row) => row.fileName === source.fileName && row.sheetName === source.sheetName
    && row.sourceMetadata.sourceRevision === 43 && row.sourceRows[0] === 45));
  f.database.enqueueAuthorResolutions([{ ...item, name: "新提交昵称", sourceRows: [45] }], source);
  assert.equal(f.database.db.prepare("SELECT COUNT(*) AS count FROM author_resolution_import_sources WHERE queue_id=?").get(result.id).count, receipts.length);
});

test("archived import provenance survives an explicitly deleted queue instead of cascading away", (t) => {
  const f = fixture(t);
  f.database.enqueueAuthorResolutions([item], context);
  const row = f.get();
  const before = f.database.db.prepare("SELECT * FROM author_resolution_import_sources WHERE queue_id=?").all(row.id);
  assert.ok(before.length);
  f.database.db.prepare("DELETE FROM author_resolution_queue WHERE id=?").run(row.id);
  const after = f.database.db.prepare("SELECT * FROM author_resolution_import_sources WHERE queue_identity_key=?").all(item.key);
  assert.equal(after.length, before.length);
  for (let index = 0; index < after.length; index++) {
    assert.equal(after[index].queue_id, null);
    assert.equal(after[index].payload_json, before[index].payload_json);
    assert.equal(after[index].receipt_sha256, before[index].receipt_sha256);
  }
});

test("new key reuses the original root date; a reused receipt alone cannot become a new proof root", (t) => {
  const f = fixture(t);
  f.database.enqueueAuthorResolutions([item], context);
  const second = { ...item, key: item.key + "-second" };
  assert.equal(f.database.enqueueAuthorResolutions([second], context).evidenceReusedCount, 1);
  const evidence = JSON.parse(f.get(second.key).source_metadata_json).evidenceReuse;
  assert.equal(evidence.sourceQueueId, f.priorId);
  assert.equal(evidence.verifiedAt, VERIFIED);
  f.database.db.prepare("UPDATE author_resolution_queue SET status='rejected' WHERE id=?").run(f.priorId);
  assert.equal(f.database.enqueueAuthorResolutions([{ ...item, key: item.key + "-third" }], context).evidenceReusedCount, 0);
});

test("reimport never upgrades an old policy receipt into strict verified evidence", (t) => {
  const f = fixture(t);
  f.database.db.prepare("UPDATE author_resolution_queue SET verification_policy_version=1 WHERE id=?").run(f.priorId);
  const repeat = f.database.enqueueAuthorResolutions([{ ...item, key: "douyin:legacy-proof", boards: [] }], context);
  assert.equal(repeat.verifiedExistingEvidenceRequestCount, 0);
  assert.equal(f.preserved().prior.verification_policy_version, 1);
  assert.equal(f.preserved().prior.updated_at, VERIFIED);
  assert.equal(f.database.enqueueAuthorResolutions([item], context).evidenceReusedCount, 0);
});

test("repeat acknowledgements fail closed when roots, canonical identity, dates or board evidence are no longer strict", (t) => {
  for (const mutate of [
    (f) => f.database.db.prepare("UPDATE author_resolution_queue SET status='rejected' WHERE id=?").run(f.priorId),
    (f) => f.database.db.prepare("UPDATE author_resolution_queue SET account_locator='' WHERE id=?").run(f.priorId),
    (f) => f.database.db.prepare("UPDATE author_resolution_queue SET verification_policy_version=1 WHERE id=?").run(f.priorId),
    (f) => f.database.db.prepare("UPDATE author_resolution_queue SET updated_at='2026-09-20T08:00:00.000Z' WHERE id=?").run(f.priorId),
    (f) => f.database.db.prepare("UPDATE targets SET locator=? WHERE id=?").run(OTHER, f.targetId),
    (f) => f.database.db.prepare("UPDATE targets SET metadata_json='{}' WHERE id=?").run(f.targetId),
  ]) {
    const f = fixture(t);
    assert.equal(f.database.enqueueAuthorResolutions([item], context).evidenceReusedCount, 1);
    mutate(f);
    const summary = f.database.enqueueAuthorResolutions([item], context);
    assert.equal(summary.evidenceReusedCount, 0);
    assert.equal(summary.verifiedExistingEvidenceRequestCount, 0);
    assert.equal(summary.alreadyResolvedEvidenceRequestCount, 1, "raw legacy status is transparent but not strict");
  }
  const f = fixture(t);
  const original = f.database.enqueueAuthorResolutions([{ ...item, key: "douyin:legacy-proof", boards: [] }], context);
  assert.equal(original.verifiedExistingEvidenceRequestCount, 1);
  assert.equal(original.evidenceReusedCount, 0);
});

test("partial, conflicting, malicious and identity-drifted evidence remain queued", (t) => {
  const mutations = [
    (f) => f.database.db.prepare("UPDATE author_resolution_queue SET account_locator='' WHERE id=?").run(f.priorId),
    (f) => f.database.db.prepare("UPDATE author_resolution_queue SET account_locator=? WHERE id=?").run(OTHER, f.priorId),
    (f) => f.database.db.prepare("UPDATE author_resolution_queue SET video_ids_json='[]' WHERE id=?").run(f.priorId),
    (f) => f.database.db.prepare("UPDATE author_resolution_queue SET verification_policy_version=1 WHERE id=?").run(f.priorId),
    (f) => f.database.db.prepare("UPDATE author_resolution_queue SET updated_at='2999-01-01T00:00:00.000Z' WHERE id=?").run(f.priorId),
    (f) => f.database.db.prepare("UPDATE targets SET locator=? WHERE id=?").run(OTHER, f.targetId),
    (f) => f.database.db.prepare("UPDATE targets SET metadata_json='{}' WHERE id=?").run(f.targetId),
  ];
  for (const mutate of mutations) {
    const f = fixture(t); mutate(f);
    const summary = f.database.enqueueAuthorResolutions([item], context);
    assert.equal(summary.evidenceReusedCount, 0);
    assert.equal(summary.pendingEvidenceRequestCount, 1);
  }
  for (const patch of [{ douyinId: "conflict" }, { accountLocator: OTHER },
    { shareUrls: [SHARE, "https://v.douyin.com/Unverified/"] },
    { shareUrls: ["https://user:secret@v.douyin.com/ExactCase/"] }, { shareUrls: ["https://evil.example/ExactCase/"] },
    { shareUrls: [SHARE.toLowerCase()] }]) {
    const f = fixture(t);
    assert.equal(f.database.enqueueAuthorResolutions([{ ...item, ...patch }], context).evidenceReusedCount, 0);
  }
});

test("missing or invalid source provenance never causes unattended evidence reuse", (t) => {
  for (const patch of [{ sourceUrl: "https://evil.example/sheets/Book" }, { sourceUrl: "http://fixture.feishu.cn/sheets/Book" },
    { sourceRevision: null }, { sourceRevision: "42" }, { sourceSha256: "" }, { sourceSha256: "a".repeat(63) }]) {
    const f = fixture(t);
    const result = f.database.enqueueAuthorResolutions([item], { ...context, sourceMetadata: { ...context.sourceMetadata, ...patch } });
    assert.equal(result.evidenceReusedCount, 0);
    assert.equal(result.pendingEvidenceRequestCount, 1);
  }
});

test("duplicate imports cannot steal active/dangling leases and changed evidence invalidates stale workers without auto-reuse", (t) => {
  for (const dangling of [false, true]) {
    const f = fixture(t);
    f.database.enqueueAuthorResolutions([item]);
    f.database.db.prepare("UPDATE author_resolution_queue SET lease_owner=?,lease_until=? WHERE identity_key=?")
      .run(dangling ? null : "worker", "2026-09-28T00:00:00.000Z", item.key);
    const before = f.get();
    const result = f.database.enqueueAuthorResolutions([item], context);
    assert.equal(result.evidenceReusedCount, 0);
    assert.equal(result.leaseDeferredEvidenceRequestCount, 1);
    assert.deepEqual(f.get(), before);
    const changed = f.database.enqueueAuthorResolutions([{ ...item, shareUrls: [SHARE, "https://v.douyin.com/New/"] }], context);
    assert.equal(changed.evidenceReusedCount, 0);
    assert.ok(f.get().evidence_version > before.evidence_version);
    assert.equal(f.database.markAuthorResolutionResolved(before.id, f.targetId, { owner: "worker", evidenceVersion: before.evidence_version }), false);
  }
});

test("normal two-connection imports are idempotent and in-transaction source drift rolls back the entire import", (t) => {
  const f = fixture(t), other = new MonitorDatabase(f.path);
  t.after(() => other.close());
  assert.equal(f.database.enqueueAuthorResolutions([item], context).evidenceReusedCount, 1);
  assert.equal(other.enqueueAuthorResolutions([item], context).evidenceReusedCount, 0);
  assert.equal(other.db.prepare("SELECT COUNT(*) AS count FROM author_resolution_queue").get().count, 2);
  const g = fixture(t), before = g.preserved();
  g.database.db.exec(`CREATE TRIGGER corrupt_source AFTER UPDATE OF status ON author_resolution_queue
    WHEN NEW.identity_key='${item.key}' AND NEW.status='resolved'
    BEGIN UPDATE author_resolution_queue SET source_metadata_json='{}' WHERE id=NEW.id; END`);
  assert.throws(() => g.database.enqueueAuthorResolutions([item], context), /来源或身份已变化/);
  assert.equal(g.get(), undefined);
  assert.deepEqual(g.preserved(), before);
});

test("routine matcher rejects ambiguous same-canonical target claims and reimport-created future or malformed receipt dates", (t) => {
  const f = fixture(t);
  f.database.enqueueAuthorResolutions([item]);
  const incoming = f.get(), prior = f.preserved().prior, target = f.preserved().target[0];
  const otherTarget = { ...target, id: target.id + 999 };
  const otherPrior = { ...prior, id: prior.id + 999, resolved_target_id: otherTarget.id };
  assert.equal(uniqueRoutineAuthorEvidence(incoming, [prior, otherPrior], new Map([[target.id, target], [otherTarget.id, otherTarget]])), null);
  for (const updated_at of ["2026-02-30T00:00:00.000Z", "2999-01-01T00:00:00.000Z", "2026-09-13 08:00:00"]) {
    assert.equal(uniqueRoutineAuthorEvidence(incoming, [{ ...prior, updated_at }], new Map([[target.id, target]])), null);
  }
});
