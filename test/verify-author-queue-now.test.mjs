import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MonitorDatabase } from "../lib/database.mjs";
import {
  explicitAccountLocatorFromIdentityKey,
  queuedAuthorAccountLocator,
} from "../lib/author-queue-identity.mjs";
import {
  processClaimedAuthorResolutionBatch,
  queuedAuthorEvidenceRequest,
  parseArgs,
  runAuthorQueueVerification,
} from "../scripts/verify-author-queue-now.mjs";

const SEC_A = "MS4wLjABAAAAstrictManualAuthorAAAAAAAA";
const SEC_B = "MS4wLjABAAAAstrictManualAuthorBBBBBBBB";
const VIDEO_A = "7679000000000000301";
const VIDEO_B = "7679000000000000302";
const SHARE_A = "https://v.douyin.com/StrictManualShare/";
const BVID_A = "BV1xx411c7mD";
const BVID_B = "BV1Q5411c7mX";

test("queue account identity parsing accepts only explicit strong keys and preserves identifier case", () => {
  assert.deepEqual(explicitAccountLocatorFromIdentityKey(`douyin:account:${SEC_A}|video:${VIDEO_A}`), {
    platform: "douyin",
    locator: SEC_A,
  });
  assert.deepEqual(explicitAccountLocatorFromIdentityKey("bilibili:account:1809444890|video:BV1xx411c7mD"), {
    platform: "bilibili",
    locator: "1809444890",
  });
  for (const key of [
    "douyin:account:not-a-sec-uid",
    "douyin:name:MS4wLjABAAAAlooksStrongButIsAName",
    "bilibili:account:not-numeric",
    "bilibili:name:1809444890",
  ]) assert.equal(explicitAccountLocatorFromIdentityKey(key), null);
  assert.equal(queuedAuthorAccountLocator({ key: `douyin:account:${SEC_A}|share-sha256:abc`, accountLocator: "" }), SEC_A);
});

function createSuspendedQueue(t, item, locator, sourceMetadata = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-manual-strict-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const target = database.createTarget({
    type: "account",
    label: item.name,
    locator,
    provider: "public-web",
    metadata: { platform: item.key.startsWith("bilibili:") ? "bilibili" : "douyin" },
  });
  database.enqueueAuthorResolutions([item], { fileName: "历史作者.xlsx", sheetName: "作者名单", sourceMetadata });
  const queued = database.listDueAuthorResolutions(1)[0];
  database.db.prepare("UPDATE targets SET enabled=0 WHERE id=?").run(target.id);
  database.db.prepare(`
    UPDATE author_resolution_queue
    SET resolved_target_id=?, suspended_target_enabled=1, status='pending',
        next_attempt_at=?, lease_owner=NULL, lease_until=NULL
    WHERE id=?
  `).run(target.id, new Date(Date.now() - 1_000).toISOString(), queued.id);
  const workerId = "manual-strict-test";
  const claimed = database.claimDueAuthorResolutions(1, { owner: workerId })[0];
  return { database, target, claimed, workerId };
}

test("manual queue verifier keeps a suspended target disabled when any submitted proof is missing", async (t) => {
  const boards = [{ name: "杨齐家切片矩阵", owner: "负责人甲", sourceRow: 2 }];
  const { database, target, claimed, workerId } = createSuspendedQueue(t, {
    key: `douyin:account:${SEC_A}`,
    name: "严格作者",
    accountLocator: SEC_A,
    videoIds: [VIDEO_A, VIDEO_B],
    shareUrls: [SHARE_A],
    sourceRows: [2, 3, 4],
    boards,
  }, SEC_A);
  let submitted = null;
  const provider = {
    async resolveAuthors(requests) {
      submitted = requests;
      return {
        items: [{
          key: requests[0].key,
          candidates: [{ videoId: VIDEO_A, secUid: SEC_A, nickname: "严格作者" }],
          errors: [{ videoId: VIDEO_B, error: "第二项公开详情暂时读取失败" }],
        }],
      };
    },
  };

  const result = await processClaimedAuthorResolutionBatch({ database, provider, batch: [claimed], workerId });

  assert.deepEqual(result, { resolved: 0, retry: 1, rejected: 0 });
  assert.equal(database.getTarget(target.id).enabled, false);
  const queue = database.listAuthorResolutionQueue(1)[0];
  assert.equal(queue.status, "retry");
  assert.equal(queue.resolvedTargetId, target.id);
  assert.equal(queue.suspendedTargetEnabled, true);
  assert.deepEqual(submitted, [{
    key: claimed.identity_key,
    platform: "douyin",
    name: "严格作者",
    accountLocator: SEC_A,
    douyinId: "",
    bilibiliId: "",
    organization: "",
    tier: "",
    category: "",
    boards: claimed.boards,
    videoIds: [VIDEO_A, VIDEO_B],
    shareUrls: [SHARE_A],
    sourceRows: [2, 3, 4],
  }]);
});

test("manual queue verifier rejects cross-author Bilibili works without restoring the old target", async (t) => {
  const uid = "1809444890";
  const { database, target, claimed, workerId } = createSuspendedQueue(t, {
    key: `bilibili:account:${uid}`,
    name: "B站严格作者",
    accountLocator: uid,
    videoIds: [BVID_A, BVID_B],
    shareUrls: [],
    sourceRows: [8, 9],
    boards: [{ name: "老飞宇切片矩阵", sourceRow: 8 }],
  }, uid);
  const candidate = (videoId, canonicalId) => ({
    platform: "bilibili",
    canonicalId,
    nickname: "B站严格作者",
    videoId,
    sourceEvidenceUrl: `https://www.bilibili.com/video/${videoId}`,
    endpoint: `https://api.bilibili.com/x/web-interface/view?bvid=${videoId}`,
    provenance: "bilibili-official-anonymous-view",
  });
  let submitted = null;
  const provider = {
    async resolveAuthors(requests) {
      submitted = requests;
      return {
        items: [{
          key: requests[0].key,
          candidates: [candidate(BVID_A, uid), candidate(BVID_B, "946974")],
          errors: [],
        }],
      };
    },
  };

  const result = await processClaimedAuthorResolutionBatch({ database, provider, batch: [claimed], workerId });

  assert.deepEqual(result, { resolved: 0, retry: 0, rejected: 1 });
  assert.equal(database.getTarget(target.id).enabled, false);
  const queue = database.listAuthorResolutionQueue(1)[0];
  assert.equal(queue.status, "rejected");
  assert.equal(queue.resolvedTargetId, target.id);
  assert.equal(queue.suspendedTargetEnabled, true);
  assert.equal(submitted[0].platform, "bilibili");
  assert.equal(submitted[0].accountLocator, uid);
  assert.equal(submitted[0].bilibiliId, uid);
  assert.deepEqual(submitted[0].videoIds, [BVID_A, BVID_B]);
  assert.deepEqual(queuedAuthorEvidenceRequest(claimed), submitted[0]);
});

test("legacy empty account_locator is restored from an explicit account key before owner verification", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-legacy-account-key-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const filePath = join(tempDir, "test.sqlite");
  const legacy = new MonitorDatabase(filePath);
  const target = legacy.createTarget({
    type: "account",
    label: "历史强身份作者",
    locator: SEC_A,
    provider: "public-web",
    metadata: { platform: "douyin" },
  });
  legacy.enqueueAuthorResolutions([{
    key: `douyin:account:${SEC_A}|video:${VIDEO_A}`,
    name: "历史强身份作者",
    accountLocator: SEC_A,
    videoIds: [VIDEO_A, VIDEO_B],
    shareUrls: [],
    sourceRows: [2, 3],
  }], { fileName: "旧版本.xlsx", sheetName: "作者名单" });
  const queued = legacy.listDueAuthorResolutions(1)[0];
  assert.equal(legacy.markAuthorResolutionResolved(queued.id, target.id), true);
  legacy.db.prepare(`
    UPDATE author_resolution_queue
    SET account_locator='', verification_policy_version=1
    WHERE id=?
  `).run(queued.id);
  legacy.close();

  const database = new MonitorDatabase(filePath);
  t.after(() => database.close());
  assert.equal(database.db.prepare("SELECT account_locator FROM author_resolution_queue WHERE id=?").get(queued.id).account_locator, SEC_A);
  assert.equal(database.countLegacyPartialEvidenceVerifications(), 1);
  database.requeueLegacyPartialEvidenceVerifications(new Date(Date.now() - 1_000).toISOString());
  assert.equal(database.getTarget(target.id).enabled, false);
  const workerId = "legacy-account-key-worker";
  const claimed = database.claimDueAuthorResolutions(1, { owner: workerId })[0];
  let submitted = null;
  const provider = {
    async resolveAuthors(requests) {
      submitted = requests;
      return {
        items: [{
          key: requests[0].key,
          candidates: [
            { videoId: VIDEO_A, secUid: SEC_B, nickname: "另一作者" },
            { videoId: VIDEO_B, secUid: SEC_B, nickname: "另一作者" },
          ],
          errors: [],
        }],
      };
    },
  };

  const result = await processClaimedAuthorResolutionBatch({ database, provider, batch: [claimed], workerId });

  assert.deepEqual(result, { resolved: 0, retry: 0, rejected: 1 });
  assert.equal(submitted[0].accountLocator, SEC_A);
  assert.equal(database.getTarget(target.id).enabled, false);
  assert.equal(database.getTarget(target.id).strictIdentityStatus, "rejected");
  assert.equal(database.listTargets().length, 1, "a conflicting owner must not be created as a replacement target");
});

test("manual early retries require an explicit exact filename before opening a database", async () => {
  assert.throws(() => parseArgs(["--db", "test.sqlite", "--retry-now"]), /必须同时指定/);
  assert.throws(() => parseArgs(["--db", "test.sqlite", "--file-name"]), /非空精确文件名/);
  assert.throws(() => parseArgs(["--db", "test.sqlite", "--file-name", "", "--retry-now"]), /非空精确文件名/);
  const options = parseArgs(["--db", "test.sqlite", "--file-name", "玉麒麟寒川8月结算表.xlsx", "--retry-now"]);
  assert.equal(options.fileName, "玉麒麟寒川8月结算表.xlsx");
  assert.equal(options.retryNow, true);
  await assert.rejects(runAuthorQueueVerification({ retryNow: true }, {
    databaseFactory() { throw new Error("must not open database"); },
  }), /必须同时指定/);
});

test("manual queue success preserves complete cloud provenance, submitted identity, boards and all verified works", async (t) => {
  const sourceMetadata = {
    sourceType: "lark-sheet",
    sourceUrl: "https://my.feishu.cn/sheets/U0FIsi9nMh2dAqtBlZ4cOtI6nIg?sheet=a058df",
    sourceTitle: "玉麒麟寒川8月结算表",
    sourceRevision: 2,
    sourceSheetId: "a058df",
    sourceRange: "A1:H175",
    sourceSha256: "a".repeat(64),
    sourceExportSha256: "b".repeat(64),
    sourceReadAt: "2026-09-13T10:00:00.000Z",
  };
  const { database, target, claimed, workerId } = createSuspendedQueue(t, {
    key: `douyin:account:${SEC_A}`,
    name: "玉麒麟切片作者",
    accountLocator: SEC_A,
    douyinId: "52733715193",
    videoIds: [VIDEO_A, VIDEO_B],
    shareUrls: [], sourceRows: [2, 3],
    organization: "寒川", tier: "切片", category: "游戏",
    boards: [{ name: "玉麒麟切片矩阵", owner: "负责人甲", note: "原始备注", sourceRow: 2 }],
  }, SEC_A, sourceMetadata);
  const result = await processClaimedAuthorResolutionBatch({ database, batch: [claimed], workerId, provider: {
    async resolveAuthors(requests) {
      return { items: [{ key: requests[0].key, candidates: [VIDEO_A, VIDEO_B].map((videoId) => ({
        videoId, secUid: SEC_A, nickname: "玉麒麟切片作者", uniqueId: "52733715193",
      })), errors: [] }] };
    },
  } });
  assert.deepEqual(result, { resolved: 1, retry: 0, rejected: 0 });
  const stored = database.getTarget(target.id);
  assert.equal(stored.metadata.platform, "douyin");
  assert.equal(stored.metadata.submittedName, "玉麒麟切片作者");
  assert.equal(stored.metadata.douyinId, "52733715193");
  assert.equal(stored.metadata.evidenceVideoId, VIDEO_A);
  assert.equal(stored.metadata.organization, "寒川");
  const { type, importedAt, fileName, sheetName, sourceRow, ...provenance } = stored.metadata.importSource;
  assert.equal(type, "lark-sheet");
  assert.equal(fileName, "历史作者.xlsx");
  assert.equal(sheetName, "作者名单");
  assert.equal(sourceRow, 2);
  assert.ok(importedAt);
  const { sourceType, ...expectedProvenance } = sourceMetadata;
  assert.deepEqual(provenance, expectedProvenance);
  assert.equal(stored.metadata.resolution.verificationPolicy, "all-submitted-evidence-v2");
  assert.equal(stored.metadata.resolution.verifiedEvidenceCount, 2);
  assert.deepEqual(stored.metadata.resolution.verifiedEvidence.map((item) => item.videoId), [VIDEO_A, VIDEO_B]);
  assert.ok(database.listBoards().some((board) => board.name === "玉麒麟切片矩阵" && board.targetCount === 1));
  const queued = database.listAuthorResolutionQueue(10).find((item) => item.id === claimed.id);
  assert.deepEqual(queued.sourceMetadata, sourceMetadata);
  assert.deepEqual(queued.videoIds, [VIDEO_A, VIDEO_B]);
  assert.equal(queued.boardDetails[0].owner, "负责人甲");
});

test("one retry-now invocation visits only the exact file and attempts each eligible queue item once", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-file-once-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const filePath = join(tempDir, "test.sqlite");
  const database = new MonitorDatabase(filePath);
  t.after(() => database.close());
  const fileName = "玉麒麟寒川8月结算表.xlsx";
  for (const [key, file] of [["a", fileName], ["b", fileName], ["other", "别的名单.xlsx"]]) {
    database.enqueueAuthorResolutions([{ key: `douyin:${key}`, name: key, videoIds: [VIDEO_A], sourceRows: [2] }], { fileName: file });
  }
  const future = new Date(Date.now() + 86_400_000).toISOString();
  database.db.prepare("UPDATE author_resolution_queue SET status='retry',next_attempt_at=?").run(future);
  const visited = [];
  const totals = await runAuthorQueueVerification({ db: filePath, fileName, retryNow: true, batchSize: 1, resolver: "signed-only" }, {
    emitEvent() {},
    providerFactory: () => ({ async resolveAuthors(requests) {
      visited.push(...requests.map((request) => request.key));
      return { items: requests.map((request) => ({ key: request.key, candidates: [], errors: [{ error: "临时不可读" }] })) };
    } }),
  });
  assert.equal(totals.requested, 2);
  assert.equal(totals.batches, 2);
  assert.equal(totals.retry, 2);
  assert.deepEqual(visited, ["douyin:a", "douyin:b"]);
  const statuses = database.db.prepare("SELECT identity_key,attempts,lease_owner FROM author_resolution_queue ORDER BY id").all();
  assert.deepEqual(statuses.map((row) => row.attempts), [1, 1, 0]);
  assert.ok(statuses.every((row) => row.lease_owner === null));
});
