import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { MonitorDatabase } from "../lib/database.mjs";
import { applyAuthorEvidence } from "../lib/author-resolution.mjs";

test("historical target identity cannot be replaced after a snapshot", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-identity-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const target = database.createTarget({ type: "account", label: "A", locator: "account-a", provider: "manual", metadata: { platform: "douyin" } });
  database.db.prepare("INSERT INTO snapshots(target_id,captured_at,quality_status,source_checksum) VALUES(?,?,?,?)")
    .run(target.id, "2026-09-28T12:00:00.000Z", "validated", "fixture");
  assert.throws(() => database.updateTarget(target.id, { locator: "account-b", label: "B" }), (error) => error.status === 409);
  assert.equal(database.getTarget(target.id).locator, "account-a");
  assert.equal(database.updateTarget(target.id, { label: "A corrected" }).label, "A corrected");
});

test("target identity cannot change while a single-target or matrix collection is running", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-identity-inflight-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const target = database.createTarget({ type: "account", label: "A", locator: "account-a", provider: "public-web", metadata: { platform: "douyin" } });

  const assertIdentityConflict = (locator) => assert.throws(
    () => database.updateTarget(target.id, { locator, metadata: { platform: "douyin" } }),
    (error) => error.status === 409 && error.code === "target_identity_in_progress",
  );

  const singleRun = database.beginRun("manual", target.id, 1);
  assertIdentityConflict("account-b");
  assert.equal(database.updateTarget(target.id, { label: "A display-name correction" }).label, "A display-name correction",
    "non-identity edits may continue while collection is in progress");
  database.finishRun(singleRun, { status: "success", successCount: 1 });
  assert.equal(database.updateTarget(target.id, { locator: "account-b", metadata: { platform: "douyin" } }).locator, "account-b",
    "identity change is permitted again after the run ends when no history exists");

  const matrixTarget = database.createTarget({ type: "account", label: "B", locator: "account-c", provider: "public-web", metadata: { platform: "douyin" } });
  const matrixRun = database.beginRun("scheduled", null, 1);
  assertIdentityConflictFor(matrixTarget, "account-d");
  database.updateRunProgress(matrixRun, { currentTargetId: matrixTarget.id });
  assertIdentityConflictFor(matrixTarget, "account-d");
  database.finishRun(matrixRun, { status: "success", successCount: 1 });

  function assertIdentityConflictFor(item, locator) {
    assert.throws(
      () => database.updateTarget(item.id, { locator, metadata: { platform: "douyin" } }),
      (error) => error.status === 409 && error.code === "target_identity_in_progress",
    );
    assert.equal(database.getTarget(item.id).locator, item.locator);
  }
});

test("historical post likes are bounded by report reference time", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-asof-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const target = database.createTarget({ type: "account", label: "A", locator: "account-a", provider: "manual", metadata: {} });
  database.db.prepare("UPDATE targets SET created_at=? WHERE id=?").run("2026-09-01T00:00:00.000Z", target.id);
  database.db.prepare("INSERT INTO posts(target_id,external_id,caption,published_at,likes,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?)")
    .run(target.id, "post-a", "作品", "2026-09-28T08:00:00.000Z", 500, "2026-09-28T09:00:00.000Z", "2026-09-29T09:00:00.000Z");
  const postId = database.db.prepare("SELECT id FROM posts WHERE external_id='post-a'").get().id;
  database.db.prepare("INSERT INTO post_metrics(post_id,captured_at,likes) VALUES(?,?,?)").run(postId, "2026-09-28T09:00:00.000Z", 100);
  database.db.prepare("INSERT INTO post_metrics(post_id,captured_at,likes) VALUES(?,?,?)").run(postId, "2026-09-29T09:00:00.000Z", 500);
  const old = database.getReport("day", new Date("2026-09-28T12:00:00.000Z"));
  assert.equal(old.posts[0].likes, 100);
  assert.equal(old.summary.likesCurrent, 100, "historical summary must use the same as-of post metric as its detail rows");
  const oldAgain = database.getReport("day", new Date("2026-09-28T12:00:00.000Z"));
  assert.equal(oldAgain.posts[0].likes, 100, "a later post metric must not rewrite an already elapsed report window");
  assert.equal(oldAgain.summary.likesCurrent, 100, "historical summary remains stable after future observations are stored");
  assert.equal(database.getReport("day", new Date("2026-09-29T12:00:00.000Z")).posts.length, 0);
});

test("report work identity is platform-scoped when different platforms reuse an external id", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-platform-post-id-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const targets = [
    database.createTarget({ type: "account", label: "抖音作者", locator: "douyin-author", provider: "manual", metadata: { platform: "douyin" } }),
    database.createTarget({ type: "account", label: "B站作者", locator: "bilibili-author", provider: "manual", metadata: { platform: "bilibili" } }),
    database.createTarget({ type: "account", label: "抖音同作者镜像", locator: "douyin-author-copy", provider: "manual", metadata: { platform: "douyin" } }),
  ];
  database.db.prepare("UPDATE targets SET created_at=? WHERE id IN (?,?,?)")
    .run("2026-09-01T00:00:00.000Z", ...targets.map((target) => target.id));
  const insertPost = database.db.prepare("INSERT INTO posts(target_id,external_id,caption,published_at,likes,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?)");
  const insertMetric = database.db.prepare("INSERT INTO post_metrics(post_id,captured_at,likes) VALUES(?,?,?)");
  targets.forEach((target, index) => {
    insertPost.run(target.id, "12345678901234567", `${target.label}作品`, "2026-09-28T08:00:00.000Z", null,
      "2026-09-28T08:00:00.000Z", "2026-09-28T10:00:00.000Z");
    const postId = database.db.prepare("SELECT id FROM posts WHERE target_id=? AND external_id=?").get(target.id, "12345678901234567").id;
    insertMetric.run(postId, "2026-09-28T09:00:00.000Z", 100 + index * 100);
    insertMetric.run(postId, "2026-09-28T10:00:00.000Z", 110 + index * 100);
  });
  const report = database.getReport("day", new Date("2026-09-28T11:00:00.000Z"), { timeZone: "Asia/Shanghai" });
  assert.equal(report.posts.length, 2, "platform-local IDs must not collapse unrelated public works");
  assert.equal(report.summary.postCount, 2);
  assert.equal(report.summary.sampledPostCount, 2);
  assert.equal(report.summary.likesDelta, 20);
  assert.equal(database.getOverview().recentPosts.length, 2, "overview also keeps platform-local identity while deduplicating same-platform mirrors");
});

test("database stores idempotent posts, metric history, reports and audits", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-db-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const target = database.createTarget({ type: "account", label: "账号A", locator: "account-a", provider: "manual", metadata: {} });
  database.db.prepare("UPDATE targets SET created_at=? WHERE id=?").run("2026-08-01T00:00:00.000Z", target.id);
  const runId = database.beginRun("test", target.id, 1);
  const base = {
    snapshot: { followers: 100, totalLikes: 1000, totalPosts: 1, authorCount: 1 },
    warnings: [], qualityStatus: "validated", accountStatus: "available", worksCoverage: "complete", raw: { source: "fixture", works: { aweme_list: [] } },
  };
  database.saveCollection(target, runId, {
    ...base,
    capturedAt: "2026-08-30T09:00:00.000Z",
    snapshot: { followers: 90, totalLikes: 900, totalPosts: 1, authorCount: 1 },
    posts: [{ externalId: "p1", authorId: "u1", authorName: "作者", caption: "作品", publishedAt: "2026-08-31T07:30:00.000Z", likes: 90, comments: 1, shares: 2, plays: 900, url: null }],
  });
  database.saveCollection(target, runId, {
    ...base,
    capturedAt: "2026-08-31T08:00:00.000Z",
    posts: [{ externalId: "p1", authorId: "u1", authorName: "作者", caption: "作品", publishedAt: "2026-08-31T07:30:00.000Z", likes: 100, comments: 1, shares: 2, plays: 1000, url: null }],
  });
  database.saveCollection(target, runId, {
    ...base,
    capturedAt: "2026-08-31T09:00:00.000Z",
    posts: [{ externalId: "p1", authorId: "u1", authorName: "作者", caption: "作品", publishedAt: "2026-08-31T07:30:00.000Z", likes: 150, comments: 2, shares: 3, plays: 1300, url: null }],
  });
  database.finishRun(runId, { status: "success", successCount: 1 });
  const overview = database.getOverview();
  assert.equal(overview.targets[0].known_posts, 1);
  assert.equal(overview.audits.length, 3);
  const report = database.getReport("day", new Date("2026-08-31T12:00:00.000Z"));
  assert.equal(report.summary.postCount, 1);
  assert.equal(report.summary.likesDelta, 50);
  assert.equal(report.summary.followersDelta, 10);
  assert.equal(report.summary.accountLikesDelta, 100);
  assert.equal(report.summary.estimatedPlaysDelta, 10_000);
  assert.equal(report.summary.followersComparableTargetCount, 1);
  assert.equal(report.summary.validatedTargetCount, 1);
  assert.equal(report.summary.profileSnapshotTargetCount, 1);
  assert.equal(report.summary.sampledPostCount, 1);
  assert.equal(report.summary.newlyObservedPostCount, 0);
  assert.match(report.contributors[0].followersBaselineChecksum, /^[a-f0-9]{64}$/);
  assert.match(report.contributors[0].followersCurrentChecksum, /^[a-f0-9]{64}$/);
  const nextDayReport = database.getReport("day", new Date("2026-09-01T12:00:00.000Z"));
  assert.equal(nextDayReport.summary.validatedTargetCount, 1, "data coverage must use the latest valid snapshot instead of resetting at midnight");
});

test("同一作者可幂等归属同一 IP 的多个板块，且报告仅统计选定板块", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-boards-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const locator = "MS4wLjABAAAAboardMembershipEvidence123456";
  const baseInput = {
    label: "跨板块作者",
    locator,
    metadata: { platform: "douyin", importSource: { type: "author-spreadsheet", fileName: "名单.xlsx", sheetName: "作者名单", sourceRow: 2 } },
  };
  const first = database.importAuthorTargets([
    { ...baseInput, boards: ["一条小团团AI二创计划"] },
    { ...baseInput, boards: ["一条小团团切片矩阵"] },
  ], { fileName: "名单.xlsx", sheetName: "作者名单", reviewedRows: 2 });
  const repeated = database.importAuthorTargets([
    { ...baseInput, boards: ["  一条小团团AI二创计划  "] },
    { ...baseInput, boards: ["一条小团团切片矩阵"] },
  ], { fileName: "重复名单.xlsx", sheetName: "作者名单", reviewedRows: 2 });

  assert.equal(first.created.length, 1);
  assert.equal(first.boardMembershipsAdded, 2);
  assert.equal(repeated.created.length, 0);
  assert.equal(repeated.boardMembershipsAdded, 0);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM targets").get().count, 1, "多板块不得复制监控目标");
  assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM target_boards").get().count, 2, "重复导入不得复制归属");
  const target = database.listTargets()[0];
  assert.deepEqual(target.boards.map((board) => board.name), ["一条小团团AI二创计划", "一条小团团切片矩阵"]);
  assert.deepEqual(database.listBoards().map((board) => [board.name, board.targetCount]), [
    ["一条小团团AI二创计划", 1],
    ["一条小团团切片矩阵", 1],
  ]);

  const ungrouped = database.createTarget({ type: "account", label: "旧库无板块作者", locator: "legacy-account", provider: "manual", metadata: {} });
  assert.deepEqual(ungrouped.boards, [], "旧目标在迁移后应保持可读，不伪造板块");
  database.db.prepare("UPDATE targets SET created_at=? WHERE id IN (?,?)")
    .run("2026-09-01T00:00:00.000Z", target.id, ungrouped.id);
  const runId = database.beginRun("test", null, 2);
  // This membership test requires publication and report cutoff on the same
  // business day; fixed UTC evening cutoffs become the next day in Shanghai.
  const capturedAt = new Date("2026-09-08T12:00:00").toISOString();
  const reportReference = new Date("2026-09-08T18:00:00");
  database.db.prepare("UPDATE target_boards SET created_at=? WHERE target_id=?")
    .run("2026-09-08T00:00:00.000Z", target.id);
  const collection = (externalId, authorId) => ({
    capturedAt,
    snapshot: { followers: null, totalLikes: null, totalPosts: 1 },
    posts: [{ externalId, authorId, authorName: authorId, caption: "作品", publishedAt: capturedAt, likes: 10 }],
    warnings: [], qualityStatus: "validated", raw: { source: "fixture" },
  });
  database.saveCollection(target, runId, collection("board-post", "board-author"));
  database.saveCollection(ungrouped, runId, collection("legacy-post", "legacy-author"));
  const report = database.getReport("day", reportReference, { board: "  一条小团团AI二创计划  " });
  assert.equal(report.selectedBoard.name, "一条小团团AI二创计划");
  assert.equal(report.summary.targetCount, 1);
  assert.equal(report.summary.postCount, 1);
  assert.equal(report.posts[0].external_id, "board-post");
  assert.equal(report.summary.followersDelta, null, "缺少基线时不得把涨粉伪造为 0");
  assert.equal(report.summary.accountLikesDelta, null, "缺少点赞数时不得把新增点赞伪造为 0");
  const overview = database.getOverview({ board: "一条小团团AI二创计划" });
  assert.equal(overview.targets.length, 1);
  assert.equal(overview.recentPosts.length, 1);
  assert.equal(overview.boards.length, 2);
  assert.equal(overview.selectedBoard.name, "一条小团团AI二创计划");

  const unassignedShared = { ...collection("shared-post", "shared-author"), capturedAt: new Date(Date.parse(capturedAt) + 60_000).toISOString() };
  const assignedShared = { ...collection("shared-post", "shared-author"), capturedAt: new Date(Date.parse(capturedAt) + 120_000).toISOString() };
  database.saveCollection(ungrouped, runId, unassignedShared);
  database.saveCollection(target, runId, assignedShared);
  const unassignedTargets = database.listTargets({ board: "__unassigned__" });
  assert.deepEqual(unassignedTargets.map((item) => item.id), [ungrouped.id]);
  const unassignedReport = database.getReport("day", reportReference, { board: "__unassigned__" });
  assert.equal(unassignedReport.selectedBoard.name, "未分板块");
  assert.equal(unassignedReport.summary.targetCount, 1);
  assert.deepEqual(unassignedReport.posts.map((post) => post.external_id).sort(), ["legacy-post", "shared-post"], "未分板块必须先限定目标再按作品去重");

  database.db.prepare("UPDATE targets SET enabled=0 WHERE id=?").run(target.id);
  assert.deepEqual(database.listBoards().map((board) => [board.name, board.targetCount]), [
    ["一条小团团AI二创计划", 0],
    ["一条小团团切片矩阵", 0],
  ], "只剩停用作者的板块仍需保留在目录中，启用作者数应为 0");
  const disabledReport = database.getReport("day", reportReference, { board: "一条小团团AI二创计划" });
  assert.equal(disabledReport.summary.targetCount, 1, "后来停用的作者在停用日期之前仍应出现在历史报告");
  assert.equal(disabledReport.summary.postCount, 2);
  assert.equal(disabledReport.posts.length, 2, "后来停用不得抹去停用前的历史作品");
});

test("历史报表按区间末板块归属筛选并保留状态口径说明", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-report-board-asof-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const target = database.createTarget({ type: "account", label: "后加入板块的作者", locator: "late-board-author", provider: "manual", metadata: {} });
  database.db.prepare("UPDATE targets SET created_at=? WHERE id=?")
    .run("2026-09-01T00:00:00.000Z", target.id);
  const runId = database.beginRun("test", target.id, 1);
  database.saveCollection(target, runId, {
    capturedAt: "2026-09-28T09:00:00.000Z",
    snapshot: { followers: 100, totalLikes: 200, totalPosts: 1 },
    posts: [{ externalId: "late-board-post", authorId: "late-board-author", authorName: "后加入板块的作者",
      caption: "历史作品", publishedAt: "2026-09-28T08:00:00.000Z", likes: 30 }],
    warnings: [], qualityStatus: "validated", accountStatus: "available", worksCoverage: "complete", raw: { source: "fixture" },
  });
  database.finishRun(runId, { status: "success", successCount: 1 });
  database.assignTargetsToBoard([target.id], "后来加入的板块");
  database.createTarget({ type: "account", label: "区间之后创建", locator: "future-target", provider: "manual", metadata: {} });

  const reference = new Date("2026-09-28T12:00:00.000Z");
  const historicalAll = database.getReport("day", reference, { timeZone: "Asia/Shanghai" });
  assert.equal(historicalAll.summary.targetCount, 1, "区间之后创建的账号不得进入旧区间的统计分母");
  assert.equal(historicalAll.summary.postCount, 1);
  const historicalBoard = database.getReport("day", reference, { board: "后来加入的板块", timeZone: "Asia/Shanghai" });
  assert.equal(historicalBoard.summary.targetCount, 0, "区间末尚未建立的板块关系不得回写旧报告");
  assert.equal(historicalBoard.summary.postCount, 0);
  assert.equal(historicalBoard.selectedBoard.targetCount, 0);
  const historicalUnassigned = database.getReport("day", reference, { board: "__unassigned__", timeZone: "Asia/Shanghai" });
  assert.equal(historicalUnassigned.summary.targetCount, 1, "后来才分板块的账号在旧区间末仍属于未分板块");
  assert.equal(historicalUnassigned.summary.postCount, 1);
  assert.equal(historicalUnassigned.posts[0].external_id, "late-board-post");
  assert.equal(historicalUnassigned.scopeBasis.boardMembership, "retained-relationship-created-by-period-end");
  assert.equal(historicalUnassigned.scopeBasis.boardMembershipRemoval, "not-historized");
  assert.equal(historicalUnassigned.scopeBasis.enabledStatus, "period-end-recorded-state");
  assert.equal(historicalUnassigned.scopeBasis.targetCreated, "period-end");
  assert.match(historicalUnassigned.scopeBasis.description, /作者\/板块显示名称没有完整历史版本/);
});

test("历史报表按截止日已记录的停用状态，不让后续停用抹掉过去的账号贡献", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-report-enabled-asof-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const target = database.createTarget({ type: "account", label: "后来停用的作者", locator: "later-disabled", provider: "manual", metadata: {} });
  database.db.prepare("UPDATE targets SET created_at=? WHERE id=?").run("2026-09-01T00:00:00.000Z", target.id);
  const runId = database.beginRun("fixture", target.id, 1);
  database.saveCollection(target, runId, {
    capturedAt: "2026-09-28T09:00:00.000Z",
    snapshot: { followers: 100, totalLikes: 200, totalPosts: 5 },
    posts: [{ externalId: "before-pause", authorId: "later-disabled", authorName: "后来停用的作者",
      caption: "暂停前发布", publishedAt: "2026-09-28T08:00:00.000Z", likes: 20 }],
    warnings: [], qualityStatus: "validated", accountStatus: "available", worksCoverage: "complete", raw: { fixture: true },
  });
  database.finishRun(runId, { status: "success", successCount: 1 });
  database.db.prepare("UPDATE targets SET enabled=0,updated_at=? WHERE id=?").run("2026-09-29T00:00:00.000Z", target.id);
  database.db.prepare(`
    INSERT INTO activity_log(actor_name,action,resource_type,resource_id,created_at,details_json)
    VALUES('fixture','target.update','target',?,'2026-09-29T00:00:00.000Z','{"enabled":false}')
  `).run(String(target.id));

  const beforePause = database.getReport("day", new Date("2026-09-28T23:59:59.999+08:00"), { timeZone: "Asia/Shanghai" });
  assert.equal(beforePause.summary.targetCount, 1);
  assert.equal(beforePause.summary.postCount, 1);
  const afterPause = database.getReport("day", new Date("2026-09-29T23:59:59.999+08:00"), { timeZone: "Asia/Shanghai" });
  assert.equal(afterPause.summary.targetCount, 0);
  assert.equal(afterPause.summary.postCount, 0);
  assert.equal(beforePause.scopeBasis.enabledStatus, "period-end-recorded-state");
});

test("空板块可独立创建并幂等保留，名称严格验证且不自动生成示例分类", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-board-catalog-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  assert.deepEqual(database.listBoards(), []);

  const first = database.createBoard("  ＩＰ  作者名单  ", { sourceType: "user-defined" });
  assert.deepEqual(first, { key: "ip 作者名单", name: "IP 作者名单", targetCount: 0, queuedCount: 0, pendingCount: 0, rejectedCount: 0 });
  const stored = database.db.prepare("SELECT * FROM board_catalog").get();
  assert.equal(stored.source_type, "user-defined");
  assert.deepEqual(database.createBoard("ip 作者名单", { sourceType: "repeat" }), first);
  assert.deepEqual(database.db.prepare("SELECT * FROM board_catalog").get(), stored, "重复创建不得改写原名、来源或时间");
  assert.equal(database.listTargets().length, 0);
  const report = database.getReport("day", new Date("2026-09-13T12:00:00Z"), { board: first.key });
  assert.equal(report.selectedBoard.name, "IP 作者名单");
  assert.equal(report.summary.targetCount, 0);
  assert.deepEqual(report.posts, []);

  for (const name of ["", " \n ", "__all__", " __UNASSIGNED__ ", "＿_all__", "名".repeat(121), 7, null, {}]) {
    assert.throws(() => database.createBoard(name));
  }
  assert.deepEqual(database.db.prepare("SELECT * FROM board_catalog").get(), stored);

  database.db.prepare("UPDATE board_catalog SET enabled=0 WHERE board_key=?").run(first.key);
  assert.deepEqual(database.listBoards(), []);
  assert.deepEqual(database.createBoard("ip 作者名单"), first, "显式创建已有停用目录可恢复目录，但不创建或恢复作者");
  assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM targets").get().count, 0);
});

test("批量板块归属只追加关系，去重并保留作者启用状态、既有来源和全部历史", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-board-assignment-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const active = database.createTarget({
    type: "account", label: "原有作者", locator: "board-active-author", provider: "manual",
    boards: ["原板块", { name: "复合 板块", note: "原有备注", owner: "原负责人" }],
    metadata: { identityVerified: true, importSource: { type: "author-spreadsheet", fileName: "原表.xlsx", sourceRow: 2 } },
  });
  const paused = database.createTarget({ type: "account", label: "暂停作者", locator: "board-paused-author", provider: "manual", enabled: false, metadata: { identityVerified: false } });
  const runId = database.beginRun("test", active.id, 1);
  database.saveCollection(active, runId, {
    capturedAt: "2026-09-12T12:00:00Z",
    snapshot: { followers: 120, totalLikes: 300, totalPosts: 1, authorCount: 1 },
    posts: [{ externalId: "board-preserved-post", authorId: "board-active-author", authorName: "原有作者", caption: "原作品", publishedAt: "2026-09-11T12:00:00Z", likes: 20 }],
    warnings: [], qualityStatus: "validated", accountStatus: "available", worksCoverage: "complete", raw: { source: "fixture" },
  });
  database.finishRun(runId, { status: "success", successCount: 1 });
  const immutableTables = database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('board_catalog','target_boards','sqlite_sequence') ORDER BY name").all().map((row) => row.name);
  const captureUnchangedTables = () => Object.fromEntries(immutableTables.map((table) => [table, database.db.prepare(`SELECT * FROM ${table}`).all()]));
  const before = captureUnchangedTables();
  const originalMemberships = database.db.prepare("SELECT * FROM target_boards WHERE target_id=? ORDER BY board_key").all(active.id);

  const result = database.assignTargetsToBoard([active.id, paused.id, active.id], "  复合   板块 ", {
    sourceType: "confirmed-roster", sourceFileName: "确认名单.tsv", note: "用户确认的批次归属",
  });
  assert.deepEqual(result, {
    board: { key: "复合 板块", name: "复合 板块", targetCount: 1, queuedCount: 0, pendingCount: 0, rejectedCount: 0 },
    requestedCount: 3, uniqueTargetCount: 2, added: 1, existing: 1, targetIds: [active.id, paused.id],
  });
  assert.deepEqual(captureUnchangedTables(), before, "添加板块不得改变任何目标身份、启用状态、采集快照、作品、指标和审查历史");
  assert.deepEqual(database.db.prepare("SELECT * FROM target_boards WHERE target_id=? ORDER BY board_key").all(active.id), originalMemberships);
  const membership = database.getTarget(paused.id).boards[0];
  assert.equal(membership.name, "复合 板块");
  assert.equal(membership.note, "用户确认的批次归属");
  assert.equal(membership.source.type, "confirmed-roster");
  assert.equal(membership.source.fileName, "确认名单.tsv");
  assert.equal(database.getTarget(paused.id).enabled, false);
  const allMemberships = database.db.prepare("SELECT * FROM target_boards ORDER BY target_id,board_key").all();
  const repeated = database.assignTargetsToBoard([active.id, paused.id], "复合 板块", { sourceFileName: "不应覆盖.tsv", note: "不应覆盖" });
  assert.equal(repeated.added, 0);
  assert.equal(repeated.existing, 2);
  assert.deepEqual(database.db.prepare("SELECT * FROM target_boards ORDER BY target_id,board_key").all(), allMemberships);
  assert.deepEqual(captureUnchangedTables(), before);
});

test("批量板块归属先严格验证全部作者，任何无效 ID 或写入失败都整批回滚", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-board-rollback-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const first = database.createTarget({ type: "account", label: "作者一", locator: "board-valid-first", provider: "manual" });
  const second = database.createTarget({ type: "account", label: "作者二", locator: "board-valid-second", provider: "manual" });
  const topic = database.createTarget({ type: "hashtag", label: "非作者目标", locator: "board-topic", provider: "manual" });
  for (const ids of [null, [], [String(first.id)], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1], [first.id, 999_999]]) {
    assert.throws(() => database.assignTargetsToBoard(ids, "不应创建的板块"));
    assert.deepEqual(database.listBoards(), []);
    assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM target_boards").get().count, 0);
  }
  assert.throws(() => database.assignTargetsToBoard([first.id], "__all__"));
  assert.throws(() => database.assignTargetsToBoard([first.id], "名".repeat(121)));
  database.db.exec(`
    CREATE TRIGGER fail_second_board_insert BEFORE INSERT ON target_boards
    WHEN NEW.target_id=${second.id}
    BEGIN SELECT RAISE(ABORT, 'simulated membership write failure'); END;
  `);
  assert.throws(() => database.assignTargetsToBoard([first.id, second.id], "事务板块"), /simulated membership write failure/);
  assert.deepEqual(database.listBoards(), [], "写入失败必须连新建目录一起回滚");
  assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM target_boards").get().count, 0, "前面的已写作者归属也必须回滚");
  const topicAssignment = database.assignTargetsToBoard([topic.id], "话题板块");
  assert.equal(topicAssignment.added, 1);
  assert.equal(database.getTarget(topic.id).boards[0].name, "话题板块");
});

test("板块目录区分启用作者和未接入名单，队列按板块先过滤再分页并使用同口径汇总", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-board-queue-scope-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.createBoard("IP 甲");
  database.createBoard("乙板块");
  database.createBoard("空板块");
  const active = database.createTarget({ type: "account", label: "已接入", locator: "scoped-active", provider: "manual", boards: ["IP 甲"] });
  const paused = database.createTarget({ type: "account", label: "暂停接入", locator: "scoped-paused", provider: "manual", boards: ["IP 甲"], enabled: false });
  const inputs = [
    { key: "scoped:pending", name: "待核验", boards: ["IP 甲"] },
    { key: "scoped:retry", name: "待重试", boards: ["IP 甲"] },
    { key: "scoped:rejected", name: "未通过", boards: ["IP 甲"] },
    { key: "scoped:resolved", name: "已接入", boards: ["IP 甲"] },
    { key: "scoped:paused", name: "已有暂停账号", boards: ["IP 甲"] },
    { key: "scoped:unassigned", name: "未分板块", boards: [] },
    { key: "scoped:malformed", name: "旧损坏归属", boards: [] },
    ...Array.from({ length: 505 }, (_, index) => ({ key: `scoped:other:${index}`, name: `其他板块 ${index}`, boards: ["乙板块"] })),
  ];
  database.enqueueAuthorResolutions(inputs, { fileName: "真实名单.xlsx" });
  const queueId = (key) => Number(database.db.prepare("SELECT id FROM author_resolution_queue WHERE identity_key=?").get(key).id);
  database.db.prepare("UPDATE author_resolution_queue SET boards_json=?,updated_at=? WHERE id=?").run(
    JSON.stringify(["  ＩＰ   甲 ", { name: "ip 甲" }, { name: "乙板块" }]), "2026-01-01T00:00:00Z", queueId("scoped:pending"),
  );
  database.markAuthorResolutionRetry(queueId("scoped:retry"), "临时失败", "2026-09-13T00:00:00Z");
  database.markAuthorResolutionRejected(queueId("scoped:rejected"), "证据不一致");
  database.markAuthorResolutionResolved(queueId("scoped:resolved"), active.id);
  database.db.prepare("UPDATE author_resolution_queue SET status='rejected',resolved_target_id=? WHERE id=?").run(paused.id, queueId("scoped:paused"));
  database.db.prepare("UPDATE author_resolution_queue SET boards_json='not-json' WHERE id=?").run(queueId("scoped:malformed"));

  const board = database.listBoards().find((item) => item.key === "ip 甲");
  assert.deepEqual(board, { key: "ip 甲", name: "IP 甲", targetCount: 1, queuedCount: 3, pendingCount: 2, rejectedCount: 1 }, "一个队列条目重复出现板块名只计一次；已有目标不计入未接入数量");
  assert.equal(database.listBoards().find((item) => item.key === "空板块").queuedCount, 0);
  assert.deepEqual(database.getAuthorResolutionQueueSummary(" ＩＰ  甲 "), { pending: 2, resolved: 1, rejected: 2, total: 5 });
  assert.deepEqual(database.getOverview({ board: "ip 甲" }).authorResolutionQueue, { pending: 2, resolved: 1, rejected: 2, total: 5 });
  assert.equal(database.listAuthorResolutionQueue(1, "pending", "ip 甲")[0].id, queueId("scoped:pending"), "所选板块的旧条目不能被其他板块的前 500 条挤掉");
  assert.equal(database.listAuthorResolutionQueue(500, "all", "ip 甲").length, 5);
  assert.equal(database.listAuthorResolutionQueue(500, "rejected", "ip 甲").length, 2);
  assert.equal(database.getAuthorResolutionQueueSummary("乙板块").total, 506, "跨板块队列必须在各自范围内可见");
  assert.deepEqual(database.getAuthorResolutionQueueSummary("__unassigned__"), { pending: 2, resolved: 0, rejected: 0, total: 2 });
  assert.deepEqual(database.listAuthorResolutionQueue(500, "all", "__unassigned__").map((row) => row.name).sort(), ["旧损坏归属", "未分板块"].sort());
  assert.deepEqual(database.getAuthorResolutionQueueSummary("__all__"), database.getAuthorResolutionQueueSummary());
  assert.deepEqual(database.getAuthorResolutionQueueSummary("不存在的板块"), { pending: 0, resolved: 0, rejected: 0, total: 0 });
  assert.deepEqual(database.listAuthorResolutionQueue(1, "all", "不存在的板块"), []);
  database.db.prepare("UPDATE author_resolution_queue SET boards_json=? WHERE id=?").run(JSON.stringify({ name: "IP 甲" }), queueId("scoped:malformed"));
  assert.equal(database.getAuthorResolutionQueueSummary("__unassigned__").total, 2, "损坏的对象型 boards_json 不得误作有效的归属数组");
  assert.equal(database.listBoards().find((item) => item.key === "ip 甲").queuedCount, 3);
  assert.deepEqual(database.listAuthorResolutionQueue(500, "all", "__unassigned__").find((row) => row.name === "旧损坏归属").boards, []);
});

test("板块关系独立保存六项资料，空值可补齐且非空冲突保留原值并幂等留痕", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-board-metadata-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const base = {
    label: "关系资料作者",
    locator: "MS4wLjABAAAAboardMetadataEvidence123456",
    metadata: { platform: "douyin", importSource: { type: "author-spreadsheet", fileName: "首次.xlsx", sheetName: "作者名单", sourceRow: 2 } },
  };
  const created = database.importAuthorTargets([{
    ...base,
    boards: [
      { name: "杨齐家切片矩阵", organization: "机构甲", tier: "核心", owner: "负责人甲", note: "首批名单", sourceRow: 2 },
      { name: "杨齐家AI二创计划", organization: "机构乙", tier: "成长", category: "娱乐", owner: "负责人乙", filledDate: "2026-09-07", note: "独立资料", sourceRow: 3 },
    ],
  }]);
  assert.equal(created.boardMembershipsAdded, 2);
  const initial = database.listTargets()[0];
  assert.equal(initial.boards.find((board) => board.name === "杨齐家切片矩阵").organization, "机构甲");
  assert.equal(initial.boards.find((board) => board.name === "杨齐家AI二创计划").organization, "机构乙");

  const update = database.importAuthorTargets([{
    ...base,
    metadata: { ...base.metadata, importSource: { type: "author-spreadsheet", fileName: "复核.xlsx", sheetName: "作者名单", sourceRow: 9 } },
    boards: [{
      name: "杨齐家切片矩阵",
      organization: "机构丙",
      tier: "核心",
      category: "游戏",
      owner: "负责人甲",
      filledDate: "2026-09-08",
      note: "二次名单",
      sourceRow: 9,
    }],
  }]);
  assert.equal(update.boardMembershipsAdded, 0);
  assert.equal(update.boardMembershipsUpdated, 1);
  assert.deepEqual(update.boardFieldConflicts.map((item) => item.field).sort(), ["note", "organization"]);
  const membership = database.getTarget(initial.id).boards.find((board) => board.name === "杨齐家切片矩阵");
  assert.deepEqual({
    organization: membership.organization,
    tier: membership.tier,
    category: membership.category,
    owner: membership.owner,
    filledDate: membership.filledDate,
    note: membership.note,
  }, {
    organization: "机构甲",
    tier: "核心",
    category: "游戏",
    owner: "负责人甲",
    filledDate: "2026-09-08",
    note: "首批名单",
  });
  assert.equal(membership.conflicts.length, 2);
  assert.equal(membership.source.fileName, "复核.xlsx", "补齐关系字段时来源更新为贡献该字段的表格");

  const repeated = database.importAuthorTargets([{
    ...base,
    metadata: { ...base.metadata, importSource: { type: "author-spreadsheet", fileName: "复核.xlsx", sheetName: "作者名单", sourceRow: 9 } },
    boards: [{ name: "杨齐家切片矩阵", organization: "机构丙", category: "游戏", filledDate: "2026-09-08", note: "二次名单", sourceRow: 9 }],
  }]);
  assert.equal(repeated.boardMembershipsUpdated, 0);
  assert.equal(repeated.boardFieldConflicts.length, 0, "重复导入同一冲突不得重复记账");
  assert.equal(database.getTarget(initial.id).boards.find((board) => board.name === "杨齐家切片矩阵").conflicts.length, 2);
});

test("legacy target_boards rows migrate without data loss and inherit prior target metadata", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-board-migration-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const filePath = join(tempDir, "test.sqlite");
  const legacy = new DatabaseSync(filePath);
  legacy.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('account','hashtag')),
      label TEXT NOT NULL, locator TEXT NOT NULL, provider TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_checked_at TEXT,
      next_check_at TEXT, last_status TEXT NOT NULL DEFAULT 'pending', last_error TEXT,
      UNIQUE(type,locator,provider)
    );
    CREATE TABLE target_boards (
      target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
      board_key TEXT NOT NULL, board_name TEXT NOT NULL, source_type TEXT NOT NULL DEFAULT '',
      source_file_name TEXT NOT NULL DEFAULT '', source_sheet_name TEXT NOT NULL DEFAULT '',
      source_row INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(target_id,board_key)
    );
  `);
  const timestamp = "2026-09-07T00:00:00.000Z";
  legacy.prepare(`
    INSERT INTO targets(type,label,locator,provider,metadata_json,created_at,updated_at)
    VALUES('account','旧作者','legacy-board-author','public-web',?,?,?)
  `).run(JSON.stringify({ organization: "旧机构", tier: "旧分层", category: "旧赛道" }), timestamp, timestamp);
  legacy.prepare(`
    INSERT INTO target_boards(target_id,board_key,board_name,source_type,source_file_name,source_sheet_name,source_row,created_at,updated_at)
    VALUES(1,'旧板块','旧板块','author-spreadsheet','旧名单.xlsx','作者名单',2,?,?)
  `).run(timestamp, timestamp);
  legacy.close();

  const database = new MonitorDatabase(filePath);
  t.after(() => database.close());
  const columns = new Set(database.db.prepare("PRAGMA table_info(target_boards)").all().map((column) => column.name));
  for (const column of ["organization", "tier", "category", "owner", "filled_date", "note", "conflicts_json"]) assert.ok(columns.has(column));
  const board = database.getTarget(1).boards[0];
  assert.deepEqual({ organization: board.organization, tier: board.tier, category: board.category }, {
    organization: "旧机构", tier: "旧分层", category: "旧赛道",
  });
  assert.deepEqual(board.conflicts, []);
  assert.equal(board.source.fileName, "旧名单.xlsx");
});

test("week and month reports fall back to the first in-period snapshot and expose contribution evidence", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-period-baseline-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const target = database.createTarget({ type: "account", label: "增长作者", locator: "account-growth", provider: "manual", metadata: { platform: "douyin" } });
  database.db.prepare("UPDATE targets SET created_at=? WHERE id=?").run("2026-08-01T00:00:00.000Z", target.id);
  const runId = database.beginRun("test", target.id, 1);
  const base = { posts: [], warnings: [], qualityStatus: "validated", raw: { source: "fixture" } };
  database.saveCollection(target, runId, { ...base, capturedAt: "2026-09-01T16:00:00.000Z", snapshot: { followers: 100, totalLikes: 1_000, totalPosts: 1 } });
  database.saveCollection(target, runId, { ...base, capturedAt: "2026-09-02T17:00:00.000Z", snapshot: { followers: 112, totalLikes: 1_250, totalPosts: 1 } });
  const report = database.getReport("month", new Date("2026-09-03T14:00:00.000Z"));
  assert.equal(report.summary.followersDelta, 12);
  assert.equal(report.summary.accountLikesDelta, 250);
  assert.equal(report.summary.estimatedPlaysDelta, 25_000);
  assert.equal(report.summary.followersFallbackBaselineTargetCount, 1);
  assert.equal(report.contributors[0].label, "增长作者");
  assert.equal(report.contributors[0].followersBaselineMode, "first-in-period");
  assert.equal(report.contributors[0].followersDelta, 12);
});

test("overview exposes the latest completed automatic daily report after midnight", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-latest-day-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const target = database.createTarget({ type: "account", label: "日报作者", locator: "account-latest-day", provider: "manual", metadata: { platform: "douyin" } });
  database.db.prepare("UPDATE targets SET created_at=? WHERE id=?").run("2026-09-01T00:00:00.000Z", target.id);
  const runId = database.beginRun("scheduled", null, 2);
  const base = { posts: [], warnings: [], qualityStatus: "validated", raw: { source: "fixture" } };
  database.saveCollection(target, runId, { ...base, capturedAt: "2026-09-02T12:00:00.000Z", snapshot: { followers: 100, totalLikes: 1_000, totalPosts: 1 } });
  database.saveCollection(target, runId, { ...base, capturedAt: "2026-09-03T12:00:00.000Z", snapshot: { followers: 105, totalLikes: 1_100, totalPosts: 1 } });
  database.finishRun(runId, { status: "success", successCount: 1 });
  database.db.prepare("UPDATE runs SET started_at=?, finished_at=? WHERE id=?").run("2026-09-03T12:00:00.000Z", "2026-09-03T13:00:00.000Z", runId);
  const retryRunId = database.beginRun("scheduled", target.id, 1);
  database.finishRun(retryRunId, { status: "error", successCount: 0, errorCount: 1 });
  database.db.prepare("UPDATE runs SET started_at=?, finished_at=? WHERE id=?").run("2026-09-03T14:00:00.000Z", "2026-09-03T14:01:00.000Z", retryRunId);
  const overview = database.getOverview();
  assert.equal(overview.reports.latestCompletedDay.summary.followersDelta, 5);
  assert.equal(overview.reports.latestCompletedDay.summary.accountLikesDelta, 100);
  assert.equal(overview.reports.latestCompletedDay.summary.estimatedPlaysDelta, 10_000);
  assert.equal(overview.automation.latest.id, retryRunId);
  assert.equal(overview.automation.latestBatch.id, runId);
  assert.equal(overview.automation.latestRetry.id, retryRunId);
});

test("overview keeps last successful snapshot time separate from a failed attempt", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-freshness-boundary-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const target = database.createTarget({ type: "account", label: "历史作者", locator: "account-freshness-boundary", provider: "manual", metadata: { platform: "douyin" } });
  const snapshotRun = database.beginRun("test", target.id, 1);
  database.saveCollection(target, snapshotRun, {
    capturedAt: "2026-09-01T12:00:00.000Z",
    snapshot: { followers: 100, totalLikes: 1_000, totalPosts: 1 },
    posts: [], warnings: [], qualityStatus: "validated", raw: { source: "fixture" },
  });
  const failedRun = database.beginRun("scheduled", target.id, 1);
  database.recordFailure(target, failedRun, new Error("公开端点暂时不可用"));
  const overviewTarget = database.getOverview().targets.find((item) => Number(item.id) === Number(target.id));
  assert.equal(overviewTarget.latestSnapshotAt, "2026-09-01T12:00:00.000Z");
  assert.notEqual(overviewTarget.last_checked_at, overviewTarget.latestSnapshotAt);
  assert.equal(overviewTarget.last_status, "error");
});

test("compact overview keeps deterministic identity evidence errors actionable", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-overview-evidence-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const target = database.createTarget({ type: "account", label: "需补证据作者", locator: "account-evidence-boundary", provider: "public-web", metadata: { platform: "douyin" } });
  const runId = database.beginRun("scheduled", target.id, 1);
  database.recordFailure(target, runId, new Error("公开主页回显的抖音号与表格提交值不一致；本次未写入"));
  const overviewTarget = database.getOverview().targets.find((item) => Number(item.id) === Number(target.id));
  assert.equal(overviewTarget.last_status, "error");
  assert.equal(overviewTarget.last_error, "公开主页回显的抖音号与表格提交值不一致；本次未写入");
});

test("重开数据库与板块操作不重新判定历史作品覆盖，零值、缺失值及 HTTP 403 证据均保持原样", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-coverage-repair-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const databasePath = join(tempDir, "test.sqlite");
  const database = new MonitorDatabase(databasePath);
  const target = database.createTarget({ type: "account", label: "覆盖修复作者", locator: "account-coverage-repair", provider: "public-web", metadata: { platform: "douyin" } });
  const insertSnapshot = database.db.prepare(`
    INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,quality_status,account_status,works_coverage,warnings_json,source_checksum,raw_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const [index, totalPosts] of [0, null, 100].entries()) {
    insertSnapshot.run(
      target.id, `2026-09-09T10:0${index}:00.000Z`, 10, 20, totalPosts, "warning", "available", "retry",
      JSON.stringify(index ? ["作品列表接口未通过：HTTP 403", "未用 0 覆盖历史数据"] : ["本次响应未识别到作品列表；未用 0 覆盖历史数据"]), `unchanged-${index}`,
      JSON.stringify({ profile: { user: { aweme_count: totalPosts } }, works: { aweme_list: [] }, provenance: { worksScope: "latest-public-window" } }),
    );
  }
  const originalSnapshots = database.db.prepare("SELECT * FROM snapshots ORDER BY id").all();
  const originalTarget = database.db.prepare("SELECT * FROM targets WHERE id=?").get(target.id);
  database.close();
  const reopened = new MonitorDatabase(databasePath);
  assert.deepEqual(reopened.db.prepare("SELECT * FROM snapshots ORDER BY id").all(), originalSnapshots);
  reopened.createBoard("历史数据保留板块");
  reopened.assignTargetsToBoard([target.id], "历史数据保留板块");
  assert.deepEqual(reopened.db.prepare("SELECT * FROM snapshots ORDER BY id").all(), originalSnapshots);
  assert.deepEqual(reopened.db.prepare("SELECT * FROM targets WHERE id=?").get(target.id), originalTarget);
  reopened.close();
  const reopenedAgain = new MonitorDatabase(databasePath);
  t.after(() => reopenedAgain.close());
  assert.deepEqual(reopenedAgain.db.prepare("SELECT * FROM snapshots ORDER BY id").all(), originalSnapshots);
});

test("board overview selects the latest full board batch instead of a smaller retry", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-board-automation-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const first = database.importAuthorTargets([
    { label: "板块作者一", locator: "MS4wLjABAAAABoardAutomation001", boards: ["抖音主播板块"], metadata: { platform: "douyin" } },
    { label: "板块作者二", locator: "MS4wLjABAAAABoardAutomation002", boards: ["抖音主播板块"], metadata: { platform: "douyin" } },
  ]);
  const targets = database.listTargets({ board: "抖音主播板块" });
  assert.equal(targets.length, 2);
  const details = targets.map((target) => ({ targetId: target.id, label: target.label, status: "warning", reviewState: "limited", profileUsable: true, worksCoverage: "limited", warnings: ["范围窗口"] }));
  const insertRun = database.db.prepare(`
    INSERT INTO runs(trigger_type,target_id,started_at,finished_at,status,target_count,success_count,error_count,details_json,processed_count,skipped_count,warning_count,heartbeat_at,current_target_id)
    VALUES('scheduled',NULL,?,?,?, ?,?,?,?, ?,0,?, ?,NULL)
  `);
  const fullStart = "2026-09-09T17:00:00.000Z";
  const fullFinish = "2026-09-09T17:02:00.000Z";
  database.db.prepare("UPDATE targets SET created_at=? WHERE id IN (?,?)")
    .run("2026-09-01T00:00:00.000Z", targets[0].id, targets[1].id);
  database.db.prepare("UPDATE target_boards SET created_at=? WHERE target_id IN (?,?)")
    .run("2026-09-01T00:00:00.000Z", targets[0].id, targets[1].id);
  insertRun.run(fullStart, fullFinish, "partial", 2, 2, 0, JSON.stringify(details), 2, 2, fullFinish);
  const retryDetails = [details[0]];
  const retryStart = "2026-09-09T17:03:00.000Z";
  const retryFinish = "2026-09-09T17:03:30.000Z";
  insertRun.run(retryStart, retryFinish, "success", 1, 1, 0, JSON.stringify(retryDetails), 1, 1, retryFinish);
  const overview = database.getOverview({ board: "抖音主播板块" });
  assert.equal(overview.automation.latest.id, 2);
  assert.equal(overview.automation.latest.target_count, 1);
  assert.equal(overview.automation.latestBatch.id, 1, "a retry must not replace the full board batch");
  assert.equal(overview.automation.latestBatch.target_count, 2);
  assert.equal(overview.automation.latestRetry.id, 2);
  assert.equal(overview.reports.latestCompletedDay.summary.targetCount, 2);
  assert.equal(first.created.length, 2);
});

test("overview recalculates account and topic completion instead of trusting stale saved labels", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-overview-review-state-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const account = database.createTarget({ type: "account", label: "作品待核验", locator: "account-missing-works", provider: "manual" });
  const topic = database.createTarget({ type: "hashtag", label: "#话题指标待核验", locator: "#话题指标待核验", provider: "public-web" });
  const runId = database.beginRun("scheduled", null, 2);
  const finishedAt = "2026-09-13T12:00:00.000Z";
  database.finishRun(runId, {
    status: "partial", processedCount: 2, successCount: 1,
    details: [
      { targetId: account.id, status: "validated", accountStatus: "available", worksCoverage: "unknown", profileUsable: true, reviewState: "complete" },
      { targetId: topic.id, status: "validated", accountStatus: "unknown", worksCoverage: "unknown", profileUsable: false, topicMetricsUsable: false, reviewState: "complete" },
    ],
  });
  database.db.prepare("UPDATE runs SET started_at=?,finished_at=? WHERE id=?").run(finishedAt, finishedAt, runId);
  const overview = database.getOverview();
  const recent = overview.recentRuns.find((run) => Number(run.id) === runId);
  const byTarget = new Map(recent.details.map((item) => [Number(item.targetId), item]));
  assert.equal(byTarget.get(account.id).reviewState, "pending");
  assert.equal(byTarget.get(account.id).profileUsable, true, "homepage metric usability remains independent of full works coverage");
  assert.equal(byTarget.get(topic.id).reviewState, "retry", "a stale topic complete label cannot replace missing real counters");
  assert.equal(overview.automation.latestBatch.scopeRetryCount, 2);
});

test("397-target overview stays below 500KB while retaining daily runs and actionable evidence", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-overview-size-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());

  const dayStart = new Date();
  dayStart.setHours(0, 0, 1, 0);
  const baselineAt = new Date(dayStart.getTime() - 60_000).toISOString();
  const currentAt = dayStart.toISOString();
  const targetIds = [];
  const insertTarget = database.db.prepare(`
    INSERT INTO targets(type,label,locator,provider,enabled,metadata_json,created_at,updated_at,last_checked_at,last_status,last_error)
    VALUES('account',?,?, 'public-web',1,?,?,?,?,?,NULL)
  `);
  const insertSnapshot = database.db.prepare(`
    INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,hashtag_views,hashtag_posts,author_count,quality_status,warnings_json,source_checksum,raw_json)
    VALUES(?,?,?,?,?,NULL,NULL,NULL,?,?,?,?)
  `);
  const insertPost = database.db.prepare(`
    INSERT INTO posts(target_id,external_id,author_id,author_name,caption,published_at,likes,comments,shares,collects,plays,url,first_seen_at,last_seen_at,raw_json)
    VALUES(?,?,?,?,?,?,?,0,0,0,NULL,?,?,?,?)
  `);
  database.db.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 397; index += 1) {
      const retry = index % 3 === 0;
      const limited = index % 3 === 1;
      const status = retry || limited ? "warning" : "validated";
      const warnings = retry
        ? [`作品列表接口未通过：HTTP 403；${"公开读取重试证据".repeat(35)}`]
        : limited ? [`仅覆盖最新公开作品窗口；${"公开范围说明".repeat(35)}`] : [];
      const metadata = {
        platform: "douyin",
        douyinId: `author-${index}`,
        importSource: { fileName: `作者监控名单-${"来源".repeat(60)}.xlsx`, sourceRow: index + 2 },
        resolution: { method: "public-video-evidence", evidence: "严格核验".repeat(80) },
      };
      const result = insertTarget.run(
        `作者 ${String(index + 1).padStart(3, "0")}`,
        `MS4wLjABAAAAoverview${String(index).padStart(4, "0")}`,
        JSON.stringify(metadata),
        baselineAt,
        currentAt,
        currentAt,
        status,
      );
      const targetId = Number(result.lastInsertRowid);
      targetIds.push(targetId);
      const baselineFollowers = 100_000 + index * 100;
      const followerDelta = index % 17 === 0 ? -(index + 1) : index + 1;
      const baselineLikes = 1_000_000 + index * 1_000;
      insertSnapshot.run(
        targetId,
        baselineAt,
        baselineFollowers,
        baselineLikes,
        30,
        "validated",
        "[]",
        index.toString(16).padStart(64, "0"),
        JSON.stringify({ evidence: "baseline", raw: "基线".repeat(120) }),
      );
      insertSnapshot.run(
        targetId,
        currentAt,
        baselineFollowers + followerDelta,
        baselineLikes + index + 10,
        31,
        status,
        JSON.stringify(warnings),
        (index + 1_000).toString(16).padStart(64, "0"),
        JSON.stringify({ evidence: "current", raw: "当前".repeat(120) }),
      );
      if (index < 30) {
        insertPost.run(
          targetId,
          `overview-post-${index}`,
          `author-${index}`,
          `作者 ${index + 1}`,
          `公开作品 ${index + 1} ${"标题证据".repeat(40)}`,
          currentAt,
          20_000 + index,
          `https://www.douyin.com/video/overview-${index}`,
          currentAt,
          currentAt,
          JSON.stringify({ provider: "fixture", payload: "原始作品字段".repeat(120) }),
        );
      }
    }
    database.db.exec("COMMIT");
  } catch (error) {
    database.db.exec("ROLLBACK");
    throw error;
  }

  const verboseDetails = targetIds.map((targetId, index) => ({
    targetId,
    label: `作者 ${String(index + 1).padStart(3, "0")}`,
    status: "warning",
    reviewState: index % 2 ? "limited" : "retry",
    postCount: 30,
    warnings: [index % 2 ? `仅覆盖最新公开作品窗口；${"范围证据".repeat(35)}` : `作品列表接口未通过；${"重试证据".repeat(35)}`],
  }));
  const insertRun = database.db.prepare(`
    INSERT INTO runs(trigger_type,target_id,started_at,finished_at,status,target_count,success_count,error_count,details_json,
      processed_count,skipped_count,warning_count,heartbeat_at,current_target_id)
    VALUES(?,NULL,?,?, 'success',397,397,0,?,397,0,397,?,NULL)
  `);
  const olderStart = new Date(dayStart.getTime() - 120_000).toISOString();
  const olderFinish = new Date(dayStart.getTime() - 90_000).toISOString();
  const scheduledStart = new Date(dayStart.getTime() + 1_000).toISOString();
  const scheduledFinish = new Date(dayStart.getTime() + 2_000).toISOString();
  const manualStart = new Date(dayStart.getTime() + 3_000).toISOString();
  const manualFinish = new Date(dayStart.getTime() + 4_000).toISOString();
  insertRun.run("scheduled", olderStart, olderFinish, JSON.stringify(verboseDetails), olderFinish);
  insertRun.run("scheduled", scheduledStart, scheduledFinish, JSON.stringify(verboseDetails), scheduledFinish);
  insertRun.run("manual", manualStart, manualFinish, JSON.stringify(verboseDetails), manualFinish);

  const overview = database.getOverview();
  const payloadBytes = Buffer.byteLength(JSON.stringify(overview));
  t.diagnostic(`397-target overview payload: ${payloadBytes} bytes`);
  assert.ok(payloadBytes < 500_000, `overview payload must stay below 500KB, received ${payloadBytes} bytes`);
  assert.equal(overview.targets.length, 397);
  assert.equal(overview.targets[0].metadata.importSource, undefined);
  assert.equal(overview.recentPosts.length, 30);
  assert.equal(overview.recentPosts[0].raw_json, undefined);
  assert.ok(overview.recentRuns.every((run) => !Object.hasOwn(run, "details_json")));
  assert.equal(overview.recentRuns[0].trigger_type, "manual");
  assert.equal(overview.recentRuns[0].details.length, 397, "latest overall run keeps compact details");
  assert.equal(overview.recentRuns[1].trigger_type, "scheduled");
  assert.equal(overview.recentRuns[1].details.length, 397, "latest scheduled run keeps compact details");
  assert.equal(overview.recentRuns[2].details.length, 0, "older runs retain summaries without duplicate details");
  assert.equal(overview.recentRuns.filter((run) => run.trigger_type === "scheduled" && run.finished_at && ["success", "partial"].includes(run.status)).length, 2);
  assert.deepEqual(overview.recentRuns[0].details[0].warnings, ["作品列表接口未通过"]);
  assert.equal(overview.reports.latestCompletedDay.summary.targetCount, 397);
  assert.equal(overview.reports.latestCompletedDay.contributors.length, 397);
  assert.deepEqual(overview.reports.day.posts, []);
  assert.ok(overview.reports.day.contributors.some((item) => item.label && item.followersCurrentChecksum), "rendered top contributors retain full evidence");
  assert.ok(overview.reports.day.contributors.some((item) => !item.label && item.followersDelta !== undefined), "non-rendered contributors retain denominator deltas only");

  const fullReport = database.getReport("day");
  assert.equal(fullReport.posts.length, 30, "standalone report and export data remain complete");
  assert.ok(fullReport.posts[0].raw_json);
  assert.equal(fullReport.contributors.length, 397);
  assert.ok(fullReport.contributors.every((item) => item.label));
});

test("paid API settings are not accepted or retained", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-settings-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.setSettings({ tikhubApiKey: "secret", socialdataxApiKey: "secret2", publicPostsPerAccount: 50 });
  const settings = database.getSettings();
  assert.equal(settings.tikhubApiKey, undefined);
  assert.equal(settings.socialdataxApiKey, undefined);
  assert.equal(settings.publicPostsPerAccount, "50");
});

test("runtime settings reject non-finite or fractional collector limits without partial writes", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-settings-validation-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const original = database.getSettings();

  assert.throws(
    () => database.setSettings({ viralLikeThreshold: 20_000, publicPostsPerAccount: "not-a-number" }),
    /必须是有效数字/,
  );
  assert.deepEqual(database.getSettings(), original, "a rejected update must not partially change another setting");
  assert.throws(() => database.setSettings({ viralRelativeMultiplier: Number.POSITIVE_INFINITY }), /必须是有效数字/);
  assert.throws(() => database.setSettings({ publicPostsPerAccount: 2.5 }), /1–100 之间的整数/);
  assert.throws(() => database.setSettings({ scheduleTime: "25:90" }), /00:00–23:59/);
});

test("source probe evidence survives refresh and keeps the latest status readable", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-source-probe-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());

  const saved = database.recordSourceProbe("douyin-public", {
    ok: true,
    trigger: "scheduled",
    durationMs: 1234.7,
    result: { profileEndpoint: true, postsEndpoint: false, hotEndpoint: true, nickname: "林树", followerCount: 13_845_678 },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.trigger, "scheduled");
  assert.equal(saved.durationMs, 1235);
  assert.equal(database.getLatestSourceProbe().result.nickname, "林树");
  assert.equal(database.getLatestSourceProbe().result.postsEndpoint, false);

  const failed = database.recordSourceProbe("douyin-public", { ok: false, error: "作品窗口受限", trigger: "manual" });
  assert.equal(failed.ok, false);
  assert.equal(failed.trigger, "manual");
  assert.equal(database.getLatestSourceProbe().error, "作品窗口受限");
  assert.equal(database.getLatestSourceProbe().result, undefined);

  database.recordSourceProbe("bilibili-public", { ok: true, trigger: "scheduled", result: { profileEndpoint: true } });
  assert.deepEqual(database.getLatestSourceProbes().map((probe) => probe.provider), ["bilibili-public", "douyin-public"]);
  assert.deepEqual(database.getRecentSourceProbes(2).map((probe) => probe.provider), ["bilibili-public", "douyin-public"]);
  assert.equal(database.getRecentSourceProbes(1)[0].trigger, "scheduled");
});

test("author resolution queue persists evidence, retries, and resolves to a target", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-author-queue-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const item = {
    key: "douyin:test-id",
    name: "作者",
    douyinId: "test-id",
    videoIds: ["7679097628281376036"],
    shareUrls: ["https://v.douyin.com/AbCdEfG/"],
    organization: "  机构　A  ",
    tier: "核心",
    category: "游戏",
    boards: ["杨齐家切片矩阵"],
    sourceRows: [2],
  };
  database.enqueueAuthorResolutions([item], {
    fileName: "作者.xlsx",
    sheetName: "数据明细",
    sourceMetadata: {
      sourceType: "lark-sheet",
      sourceUrl: "https://bytedance.larkoffice.com/sheets/ExampleToken",
      sourceRevision: 18,
      sourceRange: "A1:F981",
      sourceSha256: "a".repeat(64),
    },
  });
  assert.equal(database.getAuthorResolutionQueueSummary().pending, 1);
  const visibleQueue = database.listAuthorResolutionQueue(10, "pending");
  assert.equal(visibleQueue.length, 1);
  assert.equal(visibleQueue[0].fileName, "作者.xlsx");
  assert.deepEqual(visibleQueue[0].sourceRows, [2]);
  assert.deepEqual(visibleQueue[0].shareUrls, ["https://v.douyin.com/AbCdEfG/"]);
  assert.equal(visibleQueue[0].organization, "机构 A");
  assert.equal(visibleQueue[0].tier, "核心");
  assert.equal(visibleQueue[0].category, "游戏");
  assert.deepEqual(visibleQueue[0].boards, ["杨齐家切片矩阵"]);
  assert.equal(visibleQueue[0].sourceMetadata.sourceRevision, 18);
  assert.equal(visibleQueue[0].sourceMetadata.sourceSha256, "a".repeat(64));
  assert.equal(visibleQueue[0].lastError, "");
  const due = database.listDueAuthorResolutions(12);
  assert.equal(due[0].videoIds[0], "7679097628281376036");
  assert.deepEqual(due[0].shareUrls, ["https://v.douyin.com/AbCdEfG/"]);
  assert.equal(due[0].organization, "机构 A");
  assert.equal(due[0].tier, "核心");
  assert.equal(due[0].category, "游戏");
  assert.deepEqual(due[0].boards.map((board) => board.name), ["杨齐家切片矩阵"]);
  assert.deepEqual({
    organization: due[0].boards[0].organization,
    tier: due[0].boards[0].tier,
    category: due[0].boards[0].category,
    sourceRow: due[0].boards[0].sourceRow,
    fileName: due[0].boards[0].source.fileName,
  }, { organization: "机构 A", tier: "核心", category: "游戏", sourceRow: 2, fileName: "作者.xlsx" });
  assert.equal(due[0].sourceMetadata.sourceRange, "A1:F981");
  database.markAuthorResolutionRetry(due[0].id, "临时限流", new Date(Date.now() - 1_000).toISOString());
  assert.equal(database.listDueAuthorResolutions(12)[0].attempts, 1);
  const target = database.createTarget({ type: "account", label: "作者", locator: "MS4wLjABAAAAqueueEvidence123456", provider: "public-web", metadata: {} });
  database.markAuthorResolutionResolved(due[0].id, target.id);
  database.enqueueAuthorResolutions([{ ...item, boards: ["杨齐家AI二创计划"] }], {
    fileName: "新板块.xlsx",
    sheetName: "作者名单",
    sourceMetadata: { sourceType: "lark-sheet" },
  });
  const summary = database.getAuthorResolutionQueueSummary();
  assert.equal(summary.pending, 0);
  assert.equal(summary.resolved, 1);
  assert.equal(database.listAuthorResolutionQueue(10, "resolved")[0].resolvedTargetId, target.id);
  assert.deepEqual(database.listAuthorResolutionQueue(10, "resolved")[0].boards, ["杨齐家切片矩阵", "杨齐家AI二创计划"]);
  assert.deepEqual(database.getTarget(target.id).boards.map((board) => board.name), ["杨齐家AI二创计划", "杨齐家切片矩阵"]);
});

test("reimport reopens a resolved author queue after its target was deleted", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-author-reopen-deleted-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const item = {
    key: "douyin:account:MS4wLjABAAAAdeletedResolvedQueue123456",
    name: "待恢复作者",
    accountLocator: "MS4wLjABAAAAdeletedResolvedQueue123456",
    videoIds: ["7679097628281376036"],
    boards: [{ name: "杨齐家切片矩阵", organization: "机构甲", owner: "负责人甲", sourceRow: 2 }],
    sourceRows: [2],
  };
  database.enqueueAuthorResolutions([item], { fileName: "首次.xlsx", sheetName: "作者名单" });
  const queue = database.listDueAuthorResolutions(1)[0];
  assert.equal(queue.accountLocator, item.accountLocator);
  const target = database.createTarget({ type: "account", label: "待恢复作者", locator: item.accountLocator, provider: "public-web", metadata: { platform: "douyin" } });
  assert.equal(database.markAuthorResolutionResolved(queue.id, target.id), true);
  database.db.prepare("UPDATE author_resolution_queue SET attempts=4,last_error='旧错误' WHERE id=?").run(queue.id);
  assert.equal(database.deleteTarget(target.id), true);
  assert.equal(database.listAuthorResolutionQueue(1, "resolved")[0].resolvedTargetId, null, "外键删除应清空目标引用");

  database.enqueueAuthorResolutions([item], { fileName: "重导.xlsx", sheetName: "作者名单" });
  const reopened = database.db.prepare("SELECT status,attempts,last_error,resolved_target_id FROM author_resolution_queue WHERE id=?").get(queue.id);
  assert.deepEqual({ ...reopened }, { status: "pending", attempts: 0, last_error: null, resolved_target_id: null });
  assert.equal(database.listDueAuthorResolutions(1).length, 1, "目标不存在时同证据必须重新进入待核验队列");
});

test("legacy multi-evidence targets are backed up for strict replay, paused, and restored only after all-evidence verification", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-strict-replay-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const locator = "MS4wLjABAAAAstrictReplayTarget1234567890";
  const target = database.createTarget({ type: "account", label: "历史多作品作者", locator, provider: "public-web", metadata: { platform: "douyin" } });
  const videoIds = [
    "7679000000000000101", "7679000000000000102", "7679000000000000103", "7679000000000000104",
  ];
  const shareUrls = [
    "https://v.douyin.com/StrictA/", "https://v.douyin.com/StrictB/", "https://v.douyin.com/StrictC/", "https://v.douyin.com/StrictD/",
  ];
  database.enqueueAuthorResolutions([{
    key: "douyin:legacy-multi",
    name: "历史多作品作者",
    douyinId: "legacy-multi",
    accountLocator: locator,
    videoIds,
    shareUrls,
    sourceRows: [2, 3, 4, 5],
  }], { fileName: "历史名单.xlsx", sheetName: "作者名单" });
  const queued = database.listDueAuthorResolutions(1)[0];
  assert.deepEqual(queued.videoIds, videoIds, "all submitted work IDs must persist beyond the former three-item limit");
  assert.deepEqual(queued.shareUrls, shareUrls, "all submitted share URLs must persist beyond the former three-item limit");
  assert.equal(database.markAuthorResolutionResolved(queued.id, target.id), true);
  database.db.prepare("UPDATE author_resolution_queue SET verification_policy_version=1 WHERE id=?").run(queued.id);

  assert.equal(database.countLegacyPartialEvidenceVerifications(), 1);
  const migrated = database.requeueLegacyPartialEvidenceVerifications("2026-09-08T12:00:00.000Z");
  assert.deepEqual(migrated, { reviewed: 1, requeued: 1, suspendedTargets: 1, legacyUnverifiable: 0 });
  assert.equal(database.getTarget(target.id).enabled, false);
  assert.equal(database.getTarget(target.id).strictIdentityStatus, "pending");
  assert.equal(database.isTargetAwaitingStrictAuthorVerification(target.id), true);
  assert.match(database.listTargetAudits(target.id)[0].message, /全部证据确认同一作者后才会自动恢复/);

  const claimed = database.claimDueAuthorResolutions(1, { owner: "strict-worker" })[0];
  const committed = database.commitAuthorResolutionTarget(claimed.id, {
    label: "历史多作品作者",
    locator,
    metadata: { platform: "douyin", resolution: { verificationPolicy: "all-submitted-evidence-v2", verifiedEvidenceCount: 8 } },
    boards: [],
  }, { fileName: claimed.file_name, sheetName: claimed.sheet_name }, {
    owner: "strict-worker",
    evidenceVersion: claimed.evidence_version,
  });
  assert.equal(committed.created, false);
  assert.equal(database.getTarget(target.id).enabled, true);
  assert.equal(database.getTarget(target.id).strictIdentityStatus, null);
  assert.equal(database.getTarget(target.id).metadata.resolution.verifiedEvidenceCount, 8);
  assert.equal(database.isTargetAwaitingStrictAuthorVerification(target.id), false);
});

test("a shared target resumes only after every strict queue resolves and never while one is rejected", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-strict-aggregate-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());

  const prepareStrictQueues = (target, prefix, locator) => {
    database.enqueueAuthorResolutions([1, 2].map((number) => ({
      key: `${prefix}:${number}`,
      name: target.label,
      accountLocator: locator,
      videoIds: [`7679000000000001${number}01`, `7679000000000001${number}02`],
      sourceRows: [number * 2, number * 2 + 1],
    })), { fileName: "历史多行作者.xlsx", sheetName: "作者名单" });
    // Migration fixture must enumerate all evidence rows, not a fair worker
    // batch (which deliberately selects at most one row per identity).
    const queued = database.db.prepare("SELECT id FROM author_resolution_queue WHERE status='pending' ORDER BY id").all();
    for (const item of queued) {
      assert.equal(database.markAuthorResolutionResolved(item.id, target.id), true);
      database.db.prepare("UPDATE author_resolution_queue SET verification_policy_version=1 WHERE id=?").run(item.id);
    }
    const migration = database.requeueLegacyPartialEvidenceVerifications("2026-09-08T13:00:00.000Z");
    assert.equal(migration.requeued, 2);
    assert.equal(database.getTarget(target.id).enabled, false);
  };
  const commitClaim = (claim, owner, locator) => database.commitAuthorResolutionTarget(claim.id, {
    label: "严格复核作者",
    locator,
    metadata: { platform: "douyin", resolution: { verificationPolicy: "all-submitted-evidence-v2" } },
    boards: [],
  }, {}, { owner, evidenceVersion: claim.evidence_version });

  const completeLocator = "MS4wLjABAAAAaggregateComplete123456789";
  const completeTarget = database.createTarget({
    type: "account", label: "严格复核作者", locator: completeLocator, provider: "public-web", metadata: { platform: "douyin" },
  });
  prepareStrictQueues(completeTarget, "legacy:aggregate-complete", completeLocator);
  const first = database.claimDueAuthorResolutions(1, { owner: "aggregate-first" })[0];
  assert.ok(commitClaim(first, "aggregate-first", completeLocator));
  assert.equal(database.getTarget(completeTarget.id).enabled, false, "one successful proof must not resume a target with another pending strict proof");
  assert.equal(database.getTarget(completeTarget.id).strictIdentityStatus, "pending");
  const second = database.claimDueAuthorResolutions(1, { owner: "aggregate-second" })[0];
  assert.ok(commitClaim(second, "aggregate-second", completeLocator));
  assert.equal(database.getTarget(completeTarget.id).enabled, true, "the original enabled state may return only after every strict proof resolves");
  assert.equal(database.getTarget(completeTarget.id).strictIdentityStatus, null);

  const rejectedLocator = "MS4wLjABAAAAaggregateRejected123456789";
  const rejectedTarget = database.createTarget({
    type: "account", label: "严格复核作者", locator: rejectedLocator, provider: "public-web", metadata: { platform: "douyin" },
  });
  prepareStrictQueues(rejectedTarget, "legacy:aggregate-rejected", rejectedLocator);
  const rejected = database.claimDueAuthorResolutions(1, { owner: "aggregate-rejected" })[0];
  assert.equal(database.markAuthorResolutionRejected(rejected.id, "第二项归属其他作者", {
    owner: "aggregate-rejected",
    evidenceVersion: rejected.evidence_version,
  }), true);
  const remaining = database.claimDueAuthorResolutions(1, { owner: "aggregate-last" })[0];
  assert.ok(commitClaim(remaining, "aggregate-last", rejectedLocator));
  assert.equal(database.getTarget(rejectedTarget.id).enabled, false, "a rejected strict proof must block automatic resume permanently");
  assert.equal(database.getTarget(rejectedTarget.id).strictIdentityStatus, "rejected");
  assert.equal(database.getReport("day", new Date()).summary.targetCount, 1, "the blocked target must remain outside reports");
});

test("a resolved legacy short-link target with lost path case is paused and cannot remain reportable", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-lost-share-target-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const target = database.createTarget({
    type: "account",
    label: "旧短链作者",
    locator: "MS4wLjABAAAAlostShareTarget1234567890",
    provider: "public-web",
    metadata: { platform: "douyin" },
  });
  database.enqueueAuthorResolutions([{
    key: "share:https://v.douyin.com/abcdefg/",
    name: "旧短链作者",
    videoIds: [],
    shareUrls: [],
    sourceRows: [8],
  }], { fileName: "旧表.xlsx", sheetName: "作者名单" });
  const queued = database.listDueAuthorResolutions(1)[0];
  assert.equal(database.markAuthorResolutionResolved(queued.id, target.id), true);
  database.db.prepare("UPDATE author_resolution_queue SET verification_policy_version=1 WHERE id=?").run(queued.id);

  assert.equal(database.countLegacyPartialEvidenceVerifications(), 1);
  const migration = database.requeueLegacyPartialEvidenceVerifications("2026-09-08T12:30:00.000Z");
  assert.deepEqual(migration, { reviewed: 1, requeued: 0, suspendedTargets: 1, legacyUnverifiable: 1 });
  const blockedTarget = database.getTarget(target.id);
  assert.equal(blockedTarget.enabled, false);
  assert.equal(blockedTarget.strictIdentityStatus, "rejected");
  assert.equal(database.isTargetAwaitingStrictAuthorVerification(target.id), true);
  assert.match(blockedTarget.latestWarnings[0], /原始路径大小写不可恢复|重新提交原始分享链接/);
  assert.equal(database.listAuthorResolutionQueue(1, "rejected")[0].suspendedTargetEnabled, true);
  assert.equal(database.listTargetAudits(target.id)[0].status, "rejected");
});

test("delayed resolution preserves distinct per-board metadata and source rows through commit", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-board-queue-chain-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const filePath = join(tempDir, "test.sqlite");
  const database = new MonitorDatabase(filePath);
  database.enqueueAuthorResolutions([{
    key: "douyin:delayed-board-author",
    name: "延迟核验作者",
    douyinId: "delayed-board-author",
    videoIds: ["7679097628281376036"],
    sourceRows: [2, 3],
    boards: [
      { name: "杨齐家切片矩阵", organization: "机构甲", tier: "核心", category: "游戏", owner: "负责人甲", filledDate: "2026-09-08", note: "甲板块", sourceRow: 2 },
      { name: "杨齐家AI二创计划", organization: "机构乙", tier: "成长", category: "娱乐", owner: "负责人乙", filledDate: "2026-09-09", note: "乙板块", sourceRow: 3 },
    ],
  }], {
    fileName: "多板块.xlsx",
    sheetName: "作者名单",
    sourceMetadata: { sourceType: "lark-sheet" },
  });
  database.close();

  const reopened = new MonitorDatabase(filePath);
  t.after(() => reopened.close());
  const claimed = reopened.claimDueAuthorResolutions(1, { owner: "board-worker" })[0];
  assert.deepEqual(claimed.boards.map((board) => [board.name, board.organization, board.owner, board.sourceRow, board.source.fileName]), [
    ["杨齐家切片矩阵", "机构甲", "负责人甲", 2, "多板块.xlsx"],
    ["杨齐家AI二创计划", "机构乙", "负责人乙", 3, "多板块.xlsx"],
  ]);
  const committed = reopened.commitAuthorResolutionTarget(claimed.id, {
    label: "延迟核验作者",
    locator: "MS4wLjABAAAAdelayedBoardAuthor123456",
    metadata: { platform: "douyin", importSource: { type: "lark-sheet", fileName: claimed.file_name, sheetName: claimed.sheet_name } },
    boards: claimed.boards,
  }, { fileName: claimed.file_name, sheetName: claimed.sheet_name }, {
    owner: "board-worker",
    evidenceVersion: claimed.evidence_version,
  });
  assert.equal(committed.created, true);
  assert.deepEqual(committed.target.boards.map((board) => [board.name, board.organization, board.owner, board.source.sourceRow]), [
    ["杨齐家AI二创计划", "机构乙", "负责人乙", 3],
    ["杨齐家切片矩阵", "机构甲", "负责人甲", 2],
  ]);
});

test("legacy lowercased share queues fail closed while case-preserved evidence survives restart and commit", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-author-share-migration-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const filePath = join(tempDir, "test.sqlite");
  const legacy = new DatabaseSync(filePath);
  legacy.exec(`
    CREATE TABLE author_resolution_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identity_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      douyin_id TEXT NOT NULL DEFAULT '',
      video_ids_json TEXT NOT NULL DEFAULT '[]',
      source_rows_json TEXT NOT NULL DEFAULT '[]',
      file_name TEXT NOT NULL DEFAULT '',
      sheet_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      resolved_target_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_until TEXT,
      evidence_version INTEGER NOT NULL DEFAULT 1
    );
  `);
  const timestamp = new Date(Date.now() - 1_000).toISOString();
  legacy.prepare(`
    INSERT INTO author_resolution_queue(
      identity_key,name,video_ids_json,source_rows_json,status,attempts,next_attempt_at,created_at,updated_at
    ) VALUES(?,?,'[]','[8]','pending',0,?,?,?)
  `).run("share:https://v.douyin.com/abcdefg/", "", timestamp, timestamp, timestamp);
  legacy.close();

  const migrated = new MonitorDatabase(filePath);
  assert.ok(migrated.db.prepare("PRAGMA table_info(author_resolution_queue)").all().some((column) => column.name === "share_urls_json"));
  assert.ok(migrated.db.prepare("PRAGMA table_info(author_resolution_queue)").all().some((column) => column.name === "account_locator"));
  assert.ok(migrated.db.prepare("PRAGMA table_info(author_resolution_queue)").all().some((column) => column.name === "source_metadata_json"));
  assert.ok(migrated.db.prepare("PRAGMA table_info(author_resolution_queue)").all().some((column) => column.name === "boards_json"));
  for (const column of ["organization", "tier", "category"]) {
    assert.ok(migrated.db.prepare("PRAGMA table_info(author_resolution_queue)").all().some((entry) => entry.name === column));
  }
  const migration = migrated.requeueLegacyPartialEvidenceVerifications(timestamp);
  assert.deepEqual(migration, { reviewed: 1, requeued: 0, suspendedTargets: 0, legacyUnverifiable: 1 });
  assert.deepEqual(migrated.listDueAuthorResolutions(1), [], "a legacy share key without its original case-preserved URL must not be resolved");
  const migratedLegacyRow = migrated.db.prepare("SELECT status,last_error,share_urls_json FROM author_resolution_queue WHERE identity_key=?").get("share:https://v.douyin.com/abcdefg/");
  assert.equal(migratedLegacyRow.status, "rejected");
  assert.ok(migratedLegacyRow.last_error);
  assert.equal(migratedLegacyRow.share_urls_json, "[]");
  migrated.enqueueAuthorResolutions([{
    key: "share:https://v.douyin.com/AbCdEfG/",
    name: "",
    videoIds: [],
    shareUrls: ["https://v.douyin.com/AbCdEfG/"],
    organization: "极炫联盟",
    tier: "S级",
    category: "三角洲行动",
    boards: ["老飞宇切片矩阵"],
    sourceRows: [8],
  }], { fileName: "飞书作者表.xlsx", sheetName: "明细" });
  migrated.close();

  const reopened = new MonitorDatabase(filePath);
  t.after(() => reopened.close());
  const claimed = reopened.claimDueAuthorResolutions(1, { owner: "restart-worker" });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].identity_key, "share:https://v.douyin.com/AbCdEfG/");
  assert.deepEqual(claimed[0].shareUrls, ["https://v.douyin.com/AbCdEfG/"]);
  assert.deepEqual(claimed[0].sourceRows, [8]);
  assert.equal(claimed[0].organization, "极炫联盟");
  assert.equal(claimed[0].tier, "S级");
  assert.equal(claimed[0].category, "三角洲行动");
  assert.deepEqual(claimed[0].boards.map((board) => board.name), ["老飞宇切片矩阵"]);
  assert.equal(claimed[0].boards[0].sourceRow, 8);
  assert.equal(claimed[0].boards[0].source.fileName, "飞书作者表.xlsx");
  const reconstructed = applyAuthorEvidence([{
    sourceRow: claimed[0].sourceRows[0],
    name: claimed[0].name,
    douyinId: claimed[0].douyin_id,
    organization: claimed[0].organization,
    tier: claimed[0].tier,
    category: claimed[0].category,
    boards: claimed[0].boards,
    videoId: claimed[0].videoIds[0] ?? "",
    shareUrl: claimed[0].shareUrls[0] ?? "",
    locator: null,
    status: "resolvable",
  }], { items: [{
    key: claimed[0].identity_key,
    candidates: [{
      videoId: "7679270829082823972",
      secUid: "MS4wLjABAAAAqueueShareEvidence1234567890",
      nickname: "短链作者",
      sourceEvidenceUrl: "https://v.douyin.com/AbCdEfG/",
    }],
    errors: [],
  }] });
  assert.equal(reconstructed.summary.resolvedAuthors, 1, "a restored share-only item must still match its resolver result");
  assert.match(reconstructed.rows[0].locator, /^MS4wLj/);
  const resolvedRow = reconstructed.rows[0];
  const committed = reopened.commitAuthorResolutionTarget(claimed[0].id, {
    label: resolvedRow.name,
    locator: resolvedRow.locator,
    metadata: {
      platform: "douyin",
      organization: resolvedRow.organization,
      tier: resolvedRow.tier,
      category: resolvedRow.category,
      importSource: { type: "author-spreadsheet", fileName: claimed[0].file_name, sheetName: claimed[0].sheet_name, sourceRow: resolvedRow.sourceRow },
      resolution: resolvedRow.resolution,
    },
    boards: resolvedRow.boards,
  }, { fileName: claimed[0].file_name, sheetName: claimed[0].sheet_name }, {
    owner: "restart-worker",
    evidenceVersion: claimed[0].evidence_version,
  });
  assert.equal(committed.created, true);
  assert.equal(committed.target.metadata.organization, "极炫联盟");
  assert.equal(committed.target.metadata.tier, "S级");
  assert.equal(committed.target.metadata.category, "三角洲行动");
  assert.deepEqual(committed.target.boards.map((board) => board.name), ["老飞宇切片矩阵"]);
  assert.equal(reopened.listAuthorResolutionQueue(1, "resolved")[0].resolvedTargetId, committed.target.id);
});

test("author resolution retries stop after the bounded limit and rejected evidence stays rejected", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-author-limit-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const item = { key: "douyin:unverifiable", name: "无法公开核验作者", douyinId: "unverifiable", videoIds: ["1"], sourceRows: [2] };
  database.enqueueAuthorResolutions([item], { fileName: "作者.xlsx", sheetName: "数据" });
  const id = database.listDueAuthorResolutions(1)[0].id;
  database.db.prepare("UPDATE author_resolution_queue SET attempts=4 WHERE id=?").run(id);
  database.markAuthorResolutionRetry(id, "持续返回空内容", new Date().toISOString());
  assert.equal(database.getAuthorResolutionQueueSummary().rejected, 1);
  database.enqueueAuthorResolutions([item], { fileName: "作者.xlsx", sheetName: "数据" });
  const row = database.db.prepare("SELECT status,attempts,last_error FROM author_resolution_queue WHERE id=?").get(id);
  assert.equal(row.status, "rejected");
  assert.equal(row.attempts, 5);
  assert.match(row.last_error, /达到公开核验重试上限/);
});

test("rejected author evidence reopens only when a later sheet supplies new evidence", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-author-reopen-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const original = {
    key: "video:7679097628281376036",
    name: "同名作者",
    douyinId: "",
    videoIds: ["7679097628281376036"],
    shareUrls: [],
    sourceRows: [2],
  };
  database.enqueueAuthorResolutions([original], { fileName: "旧表.xlsx", sheetName: "名单" });
  const queued = database.listDueAuthorResolutions(1)[0];
  database.markAuthorResolutionRejected(queued.id, "旧证据无法公开核验");
  database.enqueueAuthorResolutions([original], { fileName: "重复旧表.xlsx", sheetName: "名单" });
  assert.equal(database.listAuthorResolutionQueue(1, "rejected")[0].lastError, "旧证据无法公开核验");
  database.enqueueAuthorResolutions([{ ...original, shareUrls: ["https://v.douyin.com/NewEvidence/"] }], { fileName: "新表.xlsx", sheetName: "名单" });
  const reopened = database.listAuthorResolutionQueue(1, "pending")[0];
  assert.equal(reopened.attempts, 0);
  assert.equal(reopened.lastError, "");
  assert.deepEqual(reopened.shareUrls, ["https://v.douyin.com/NewEvidence/"]);
});

test("author resolution leases prevent duplicate workers and stale writers", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-author-lease-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const filePath = join(tempDir, "test.sqlite");
  const first = new MonitorDatabase(filePath);
  const second = new MonitorDatabase(filePath);
  t.after(() => { first.close(); second.close(); });
  first.enqueueAuthorResolutions([
    { key: "douyin:lease-a", name: "作者A", douyinId: "lease-a", videoIds: ["1"], sourceRows: [2] },
    { key: "douyin:lease-b", name: "作者B", douyinId: "lease-b", videoIds: ["2"], sourceRows: [3] },
  ], { fileName: "作者.xlsx", sheetName: "数据" });
  const reference = new Date("2026-09-02T08:00:00.000Z");
  first.db.prepare("UPDATE author_resolution_queue SET next_attempt_at=?").run(reference.toISOString());
  const claimedByA = first.claimDueAuthorResolutions(2, { owner: "worker-a", leaseMs: 60_000, reference });
  assert.equal(claimedByA.length, 2);
  assert.equal(second.claimDueAuthorResolutions(2, { owner: "worker-b", leaseMs: 60_000, reference }).length, 0);
  assert.equal(first.markAuthorResolutionRejected(claimedByA[0].id, "stale result", { owner: "worker-b", evidenceVersion: claimedByA[0].evidence_version }), false);
  const afterExpiry = new Date(reference.getTime() + 61_000);
  const reclaimedByB = second.claimDueAuthorResolutions(1, { owner: "worker-b", leaseMs: 60_000, reference: afterExpiry });
  assert.equal(reclaimedByB.length, 1);
  assert.equal(reclaimedByB[0].id, claimedByA[0].id);
  assert.equal(first.markAuthorResolutionRejected(claimedByA[0].id, "late worker result", { owner: "worker-a", evidenceVersion: claimedByA[0].evidence_version }), false);
  assert.equal(second.markAuthorResolutionRejected(reclaimedByB[0].id, "identity mismatch", { owner: "worker-b", evidenceVersion: reclaimedByB[0].evidence_version }), true);
});

test("exact-file forced retries preserve due scheduling, terminal statuses, exclusions and active leases", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-scoped-retry-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const fileName = "精确%名单.xlsx";
  const names = ["pending", "retry", "future-pending", "rejected", "resolved", "leased", "excluded", "expired", "other"];
  for (const name of names) database.enqueueAuthorResolutions([{
    key: `douyin:${name}`, name, videoIds: ["7679000000000000301"], sourceRows: [2],
  }], { fileName: name === "other" ? "精确X名单.xlsx" : fileName });
  const reference = new Date("2026-09-13T10:00:00.000Z");
  const past = new Date(reference.getTime() - 60_000).toISOString();
  const future = new Date(reference.getTime() + 60_000).toISOString();
  database.db.prepare("UPDATE author_resolution_queue SET status='retry',next_attempt_at=?").run(future);
  for (const status of ["pending", "rejected", "resolved"]) {
    database.db.prepare("UPDATE author_resolution_queue SET status=?,next_attempt_at=? WHERE name=?").run(status, past, status);
  }
  database.db.prepare("UPDATE author_resolution_queue SET status='pending' WHERE name='future-pending'").run();
  database.db.prepare("UPDATE author_resolution_queue SET lease_owner='another-worker',lease_until=? WHERE name='leased'").run(future);
  database.db.prepare("UPDATE author_resolution_queue SET lease_owner='expired-worker',lease_until=? WHERE name='expired'").run(past);
  const excludedId = Number(database.db.prepare("SELECT id FROM author_resolution_queue WHERE name='excluded'").get().id);
  assert.throws(() => database.claimDueAuthorResolutions(10, { owner: "test", includeNotDueRetries: true }), /指定精确文件名/);
  assert.deepEqual(database.claimDueAuthorResolutions(10, { owner: "normal", fileName, reference }).map((item) => item.name), ["pending"]);
  const forced = database.claimDueAuthorResolutions(10, {
    owner: "forced", fileName, reference, includeNotDueRetries: true, excludeIds: [excludedId],
  });
  assert.deepEqual(forced.map((item) => item.name), ["retry", "expired"]);
  assert.deepEqual(database.claimDueAuthorResolutions(10, { owner: "competing", fileName, reference,
    includeNotDueRetries: true, excludeIds: [excludedId] }), []);
  const rows = database.db.prepare("SELECT name,status,lease_owner FROM author_resolution_queue").all();
  assert.equal(rows.find((row) => row.name === "rejected").status, "rejected");
  assert.equal(rows.find((row) => row.name === "resolved").status, "resolved");
  assert.equal(rows.find((row) => row.name === "leased").lease_owner, "another-worker");
  assert.equal(rows.find((row) => row.name === "other").lease_owner, null);
});

test("a worker releases only its own author resolution queue leases during graceful handoff", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-author-queue-release-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.enqueueAuthorResolutions([
    { key: "douyin:release-a", name: "作者A", douyinId: "release-a", videoIds: ["1"], sourceRows: [2] },
    { key: "douyin:release-b", name: "作者B", douyinId: "release-b", videoIds: ["2"], sourceRows: [3] },
  ]);
  const reference = new Date("2026-09-07T08:00:00.000Z");
  database.db.prepare("UPDATE author_resolution_queue SET next_attempt_at=?").run(reference.toISOString());
  const claimedA = database.claimDueAuthorResolutions(1, { owner: "worker-a", leaseMs: 60_000, reference })[0];
  const claimedB = database.claimDueAuthorResolutions(1, { owner: "worker-b", leaseMs: 60_000, reference })[0];

  assert.equal(database.releaseAuthorResolutionQueue("worker-a", reference.toISOString()), 1);
  const leases = database.db.prepare("SELECT identity_key,lease_owner,lease_until FROM author_resolution_queue ORDER BY identity_key").all();
  assert.deepEqual({ ...leases[0] }, { identity_key: "douyin:release-a", lease_owner: null, lease_until: null });
  assert.equal(leases[1].lease_owner, "worker-b");
  assert.ok(leases[1].lease_until);
  assert.equal(database.markAuthorResolutionRejected(claimedA.id, "stale result", {
    owner: "worker-a",
    evidenceVersion: claimedA.evidence_version,
  }), false);
  assert.equal(database.markAuthorResolutionRejected(claimedB.id, "other worker result", {
    owner: "worker-b",
    evidenceVersion: claimedB.evidence_version,
  }), true);
  const resumed = database.claimDueAuthorResolutions(1, { owner: "worker-c", leaseMs: 60_000, reference })[0];
  assert.equal(resumed.id, claimedA.id);
});

test("new author evidence invalidates the active worker before its stale result can commit", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-author-evidence-cas-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const filePath = join(tempDir, "test.sqlite");
  const first = new MonitorDatabase(filePath);
  const second = new MonitorDatabase(filePath);
  t.after(() => { first.close(); second.close(); });
  first.enqueueAuthorResolutions([
    { key: "douyin:same", name: "原始作者", douyinId: "old-id", videoIds: ["old-video"], sourceRows: [2] },
  ], { fileName: "old.xlsx", sheetName: "名单" });
  const claimedOld = first.claimDueAuthorResolutions(1, { owner: "worker-old", leaseMs: 60_000 })[0];
  second.enqueueAuthorResolutions([
    { key: "douyin:same", name: "新提交作者", douyinId: "new-id", videoIds: ["new-video"], sourceRows: [9] },
  ], { fileName: "new.xlsx", sheetName: "名单" });

  assert.equal(first.commitAuthorResolutionTarget(claimedOld.id, {
    label: "原始作者",
    locator: "MS4wLjOldTarget",
    metadata: {},
  }, { fileName: "old.xlsx" }, {
    owner: "worker-old",
    evidenceVersion: claimedOld.evidence_version,
  }), null);
  assert.equal(first.db.prepare("SELECT COUNT(*) AS count FROM targets").get().count, 0, "stale evidence must not create a target as a side effect");
  const claimedNew = second.claimDueAuthorResolutions(1, { owner: "worker-new", leaseMs: 60_000, reference: new Date(Date.now() + 1_000) })[0];
  assert.equal(claimedNew.name, "新提交作者");
  assert.equal(claimedNew.douyin_id, "new-id");
  assert.ok(claimedNew.evidence_version > claimedOld.evidence_version);
  const committed = second.commitAuthorResolutionTarget(claimedNew.id, {
    label: "新提交作者",
    locator: "MS4wLjNewTarget",
    metadata: {},
  }, { fileName: "new.xlsx" }, {
    owner: "worker-new",
    evidenceVersion: claimedNew.evidence_version,
  });
  assert.equal(committed.created, true);
  const final = second.db.prepare("SELECT name,douyin_id,status,resolved_target_id FROM author_resolution_queue WHERE id=?").get(claimedNew.id);
  assert.deepEqual({ ...final }, { name: "新提交作者", douyin_id: "new-id", status: "resolved", resolved_target_id: committed.target.id });
});

test("author resolution jobs survive restart and resume explicitly", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-author-job-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const filePath = join(tempDir, "test.sqlite");
  const first = new MonitorDatabase(filePath);
  const owner = first.ensureLocalOwner();
  first.createAuthorResolutionJob({
    id: "11111111-1111-4111-8111-111111111111",
    userId: owner.id,
    actorName: owner.displayName,
    fileName: "作者.xlsx",
    sheetName: "名单",
    totalAuthors: 2,
    request: { rows: [{ name: "作者A" }] },
  });
  const reference = new Date();
  const running = first.claimNextAuthorResolutionJob({ owner: "worker-a", leaseMs: 30_000, reference });
  assert.equal(running.status, "running");
  first.updateAuthorResolutionJob(running.id, { phase: "importing", owner: "worker-a", version: running.version, leaseMs: 30_000 });
  first.close();

  const reopened = new MonitorDatabase(filePath);
  t.after(() => reopened.close());
  assert.equal(reopened.getAuthorResolutionJob(running.id).status, "running", "read-only database opens must not interrupt another process");
  assert.equal(reopened.requeueInterruptedAuthorJobs(reference.toISOString()), 0, "an active lease must not be requeued");
  const afterExpiry = new Date(Date.now() + 31_000);
  assert.equal(reopened.requeueInterruptedAuthorJobs(afterExpiry.toISOString()), 1);
  const resumed = reopened.claimNextAuthorResolutionJob({ owner: "worker-b", leaseMs: 30_000, reference: afterExpiry });
  assert.equal(resumed.id, running.id);
  const completed = reopened.completeAuthorResolutionJob(resumed.id, { createdCount: 1 }, { owner: "worker-b", version: resumed.version });
  assert.equal(completed.status, "completed");
  assert.equal(completed.result.createdCount, 1);
  assert.equal(reopened.listAuthorResolutionJobs(1)[0].fileName, "作者.xlsx");
});

test("author import idempotency replays one job per user and rejects key reuse for different content", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-author-idempotency-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const filePath = join(tempDir, "test.sqlite");
  const first = new MonitorDatabase(filePath);
  const owner = first.ensureLocalOwner();
  const key = "11111111-2222-4333-8444-555555555555";
  const base = {
    id: "aaaaaaaa-2222-4333-8444-555555555555", userId: owner.id, actorName: owner.displayName,
    fileName: "作者.xlsx", sheetName: "名单", totalAuthors: 1, request: { rows: [{ name: "作者A" }] },
  };
  const created = first.createIdempotentAuthorResolutionJob({ ...base, idempotencyKey: key, fingerprint: "a".repeat(64) });
  assert.equal(created.conflict, false); assert.equal(created.replayed, false);
  const replay = first.createIdempotentAuthorResolutionJob({ ...base, id: "bbbbbbbb-2222-4333-8444-555555555555", idempotencyKey: key, fingerprint: "a".repeat(64) });
  assert.equal(replay.conflict, false); assert.equal(replay.replayed, true); assert.equal(replay.job.id, created.job.id);
  const conflict = first.createIdempotentAuthorResolutionJob({ ...base, id: "cccccccc-2222-4333-8444-555555555555", idempotencyKey: key, fingerprint: "b".repeat(64) });
  assert.equal(conflict.conflict, true); assert.equal(conflict.job, null);
  assert.equal(first.db.prepare("SELECT COUNT(*) AS count FROM author_resolution_jobs").get().count, 1);

  const timestamp = new Date().toISOString();
  const secondUser = first.db.prepare(`
    INSERT INTO users(display_name,role,enabled,auth_source,created_at,updated_at)
    VALUES('另一个导入用户','editor',1,'test',?,?)
  `).run(timestamp, timestamp);
  const otherUserJob = first.createIdempotentAuthorResolutionJob({
    ...base, id: "eeeeeeee-2222-4333-8444-555555555555", userId: Number(secondUser.lastInsertRowid),
    idempotencyKey: key, fingerprint: "a".repeat(64),
  });
  assert.equal(otherUserJob.conflict, false);
  assert.equal(otherUserJob.replayed, false, "idempotency keys are scoped to the authenticated user");
  assert.notEqual(otherUserJob.job.id, created.job.id);
  first.close();

  const reopened = new MonitorDatabase(filePath);
  t.after(() => reopened.close());
  const durableReplay = reopened.createIdempotentAuthorResolutionJob({ ...base, id: "dddddddd-2222-4333-8444-555555555555", idempotencyKey: key, fingerprint: "a".repeat(64) });
  assert.equal(durableReplay.replayed, true); assert.equal(durableReplay.job.id, created.job.id);
});

test("a worker releases only its own author job during graceful handoff", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-author-job-release-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const owner = database.ensureLocalOwner();
  for (const [id, name] of [
    ["33333333-3333-4333-8333-333333333331", "任务A"],
    ["33333333-3333-4333-8333-333333333332", "任务B"],
  ]) {
    database.createAuthorResolutionJob({
      id,
      userId: owner.id,
      actorName: owner.displayName,
      fileName: `${name}.xlsx`,
      sheetName: "名单",
      totalAuthors: 1,
      request: { rows: [{ name }] },
    });
  }
  const claimedA = database.claimNextAuthorResolutionJob({ owner: "worker-a" });
  const claimedB = database.claimNextAuthorResolutionJob({ owner: "worker-b" });
  assert.equal(database.releaseAuthorResolutionJobs("worker-a"), 1);
  assert.equal(database.getAuthorResolutionJob(claimedA.id).status, "queued");
  assert.equal(database.getAuthorResolutionJob(claimedB.id).status, "running");
  assert.equal(database.completeAuthorResolutionJob(claimedA.id, { stale: true }, {
    owner: "worker-a",
    version: claimedA.version,
  }), null);
  const resumed = database.claimNextAuthorResolutionJob({ owner: "worker-c" });
  assert.equal(resumed.id, claimedA.id);
  assert.ok(resumed.version > claimedA.version);
});

test("queued author jobs are detected even when newer history fills the public list window", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-author-job-backlog-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const owner = database.ensureLocalOwner();
  const oldQueuedId = "44444444-4444-4444-8444-444444444444";
  database.createAuthorResolutionJob({
    id: oldQueuedId,
    userId: owner.id,
    actorName: owner.displayName,
    fileName: "旧待处理.xlsx",
    sheetName: "名单",
    totalAuthors: 1,
    request: { rows: [{ name: "旧待处理" }] },
  });
  for (let index = 0; index < 50; index += 1) {
    database.createAuthorResolutionJob({
      id: `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
      userId: owner.id,
      actorName: owner.displayName,
      fileName: `已完成${index}.xlsx`,
      sheetName: "名单",
      totalAuthors: 1,
      request: { rows: [{ name: `已完成${index}` }] },
    });
  }
  database.db.prepare(`
    UPDATE author_resolution_jobs
    SET status='completed',phase='completed',created_at='2026-09-08T00:00:00.000Z'
    WHERE id<>?
  `).run(oldQueuedId);
  database.db.prepare("UPDATE author_resolution_jobs SET created_at='2026-09-07T00:00:00.000Z' WHERE id=?").run(oldQueuedId);

  assert.equal(database.listAuthorResolutionJobs(50).some((job) => job.status === "queued"), false);
  assert.equal(database.hasQueuedAuthorResolutionJobs(), true);
});

test("author resolution job leases reject stale completion after another worker reclaims", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-author-job-cas-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const filePath = join(tempDir, "test.sqlite");
  const first = new MonitorDatabase(filePath);
  const second = new MonitorDatabase(filePath);
  t.after(() => { first.close(); second.close(); });
  const owner = first.ensureLocalOwner();
  first.createAuthorResolutionJob({
    id: "22222222-2222-4222-8222-222222222222",
    userId: owner.id,
    actorName: owner.displayName,
    fileName: "任务.xlsx",
    sheetName: "名单",
    totalAuthors: 1,
    request: { rows: [{ name: "作者" }] },
  });
  const reference = new Date();
  const claimedA = first.claimNextAuthorResolutionJob({ owner: "worker-a", leaseMs: 30_000, reference });
  assert.equal(second.requeueInterruptedAuthorJobs(reference.toISOString()), 0);
  assert.equal(second.claimNextAuthorResolutionJob({ owner: "worker-b", leaseMs: 30_000, reference }), null);
  const afterExpiry = new Date(reference.getTime() + 31_000);
  const claimedB = second.claimNextAuthorResolutionJob({ owner: "worker-b", leaseMs: 30_000, reference: afterExpiry });
  assert.ok(claimedB.version > claimedA.version);
  assert.equal(second.completeAuthorResolutionJob(claimedB.id, { worker: "B", createdCount: 1 }, {
    owner: "worker-b",
    version: claimedB.version,
  }).status, "completed");
  assert.equal(first.completeAuthorResolutionJob(claimedA.id, { worker: "A-stale", createdCount: 0 }, {
    owner: "worker-a",
    version: claimedA.version,
  }), null);
  assert.deepEqual(second.getAuthorResolutionJob(claimedB.id).result, { worker: "B", createdCount: 1 });
});

test("missing metrics never overwrite prior non-null values", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-null-protect-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const target = database.createTarget({ type: "account", label: "账号", locator: "SEC", provider: "manual", metadata: {} });
  database.db.prepare("UPDATE targets SET created_at=? WHERE id=?").run("2026-08-01T00:00:00.000Z", target.id);
  const runId = database.beginRun("test", target.id, 1);
  const base = { snapshot: {}, warnings: [], qualityStatus: "validated", raw: {} };
  database.saveCollection(target, runId, { ...base, capturedAt: "2026-08-31T08:00:00Z", posts: [{ externalId: "P", caption: "作品", likes: 10, comments: 2, shares: 1, collects: 4, plays: 100 }] });
  database.saveCollection(target, runId, { ...base, capturedAt: "2026-08-31T09:00:00Z", posts: [{ externalId: "P", caption: "作品", likes: null, comments: null, shares: null, collects: null, plays: null }] });
  const row = database.listAccountPostsForPool(10)[0];
  assert.deepEqual([row.likes, row.comments, row.shares, row.collects, row.plays], [10, 2, 1, 4, 100]);
  const report = database.getReport("day", new Date("2026-08-31T12:00:00Z"));
  assert.equal(report.summary.likesDelta, null, "one valid like sample must not be compared with a missing value or reported as zero growth");
});

test("missing post identity, caption and raw evidence never overwrite trusted values", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-post-null-protect-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const target = database.createTarget({ type: "account", label: "账号", locator: "SEC", provider: "manual", metadata: {} });
  const runId = database.beginRun("test", target.id, 1);
  const base = { snapshot: {}, warnings: [], qualityStatus: "validated", raw: {} };
  database.saveCollection(target, runId, {
    ...base,
    capturedAt: "2026-09-03T08:00:00Z",
    posts: [{ externalId: "P", authorId: "AUTHOR", authorName: "可信作者", caption: "可信标题", likes: 10, raw: { id: "P", source: "full" } }],
  });
  database.saveCollection(target, runId, {
    ...base,
    capturedAt: "2026-09-03T09:00:00Z",
    posts: [{ externalId: "P", authorId: null, authorName: "", caption: "  ", likes: null, raw: {} }],
  });
  const row = database.db.prepare("SELECT author_id,author_name,caption,likes,raw_json FROM posts WHERE target_id=? AND external_id='P'").get(target.id);
  assert.deepEqual({ ...row }, {
    author_id: "AUTHOR",
    author_name: "可信作者",
    caption: "可信标题",
    likes: 10,
    raw_json: JSON.stringify({ id: "P", source: "full" }),
  });
});

test("post like deltas use first and last valid samples and preserve negative corrections", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-valid-delta-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const target = database.createTarget({ type: "account", label: "账号", locator: "SEC", provider: "manual", metadata: {} });
  database.db.prepare("UPDATE targets SET created_at=? WHERE id=?").run("2026-08-01T00:00:00.000Z", target.id);
  const runId = database.beginRun("test", target.id, 1);
  const base = { snapshot: {}, warnings: [], qualityStatus: "validated", raw: {} };
  database.saveCollection(target, runId, { ...base, capturedAt: "2026-08-31T08:00:00Z", posts: [{ externalId: "P", caption: "作品", likes: 100 }] });
  database.saveCollection(target, runId, { ...base, capturedAt: "2026-08-31T09:00:00Z", posts: [{ externalId: "P", caption: "作品", likes: null }] });
  database.saveCollection(target, runId, { ...base, capturedAt: "2026-08-31T10:00:00Z", posts: [{ externalId: "P", caption: "作品", likes: 80 }] });
  const report = database.getReport("day", new Date("2026-08-31T12:00:00Z"));
  assert.equal(report.summary.likesDelta, -20);
});

test("stale running collection jobs are closed only by explicit server recovery", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-interrupted-run-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const filePath = join(tempDir, "test.sqlite");
  const first = new MonitorDatabase(filePath);
  first.beginRun("scheduled", null, 3);
  first.close();
  const reopened = new MonitorDatabase(filePath);
  t.after(() => reopened.close());
  assert.equal(reopened.getOverview().recentRuns[0].status, "running", "opening the database from a utility must not interrupt a live server run");
  assert.equal(reopened.recoverInterruptedRuns(), 1);
  const run = reopened.getOverview().recentRuns[0];
  assert.equal(run.status, "interrupted");
  assert.ok(run.finished_at);
});

test("target audit history exposes concrete warning details", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-warning-detail-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const target = database.createTarget({ type: "account", label: "警告账号", locator: "SEC", provider: "public-web", metadata: {} });
  const runId = database.beginRun("test", target.id, 1);
  database.saveCollection(target, runId, {
    capturedAt: "2026-08-31T09:00:00Z",
    snapshot: { followers: 100 },
    posts: [],
    warnings: ["匿名公开接口仅返回账号最新公开作品窗口", "公开作品页混入 1 条非目标作者推荐，已剔除"],
    qualityStatus: "warning",
    raw: { source: "fixture" },
  });
  const audits = database.listTargetAudits(target.id);
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0].warnings, ["匿名公开接口仅返回账号最新公开作品窗口", "公开作品页混入 1 条非目标作者推荐，已剔除"]);
  assert.equal(audits[0].status, "warning");
  assert.ok(audits[0].source_checksum);
});

test("account collections purge non-target author recommendations", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-author-guard-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const target = database.createTarget({ type: "account", label: "账号", locator: "SEC", provider: "public-web", metadata: {} });
  const runId = database.beginRun("test", target.id, 1);
  database.saveCollection(target, runId, {
    capturedAt: "2026-08-31T08:00:00Z",
    snapshot: {}, warnings: [], qualityStatus: "validated",
    raw: { profile: { user: { sec_uid: "EXPECTED" } } },
    posts: [
      { externalId: "GOOD", authorId: "EXPECTED", caption: "目标作品" },
      { externalId: "BAD", authorId: "OTHER", caption: "推荐作品" },
    ],
  });
  database.saveCollection(target, runId, {
    capturedAt: "2026-08-31T09:00:00Z",
    snapshot: {}, warnings: [], qualityStatus: "validated",
    raw: { profile: { user: { sec_uid: "EXPECTED" } } },
    posts: [{ externalId: "GOOD", authorId: "EXPECTED", caption: "目标作品" }],
  });
  assert.deepEqual(database.listAccountPostsForPool(10).map((row) => row.external_id), ["GOOD"]);
});

test("global reports do not double count account posts copied into hashtag targets", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-report-dedupe-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const account = database.createTarget({ type: "account", label: "账号", locator: "A", provider: "manual", metadata: {} });
  const duplicateAccount = database.createTarget({ type: "account", label: "重复账号", locator: "A2", provider: "manual", metadata: {} });
  const hashtag = database.createTarget({ type: "hashtag", label: "#话题", locator: "话题", provider: "manual", metadata: {} });
  database.db.prepare("UPDATE targets SET created_at=? WHERE id IN (?,?,?)")
    .run("2026-08-01T00:00:00.000Z", account.id, duplicateAccount.id, hashtag.id);
  const runId = database.beginRun("test", null, 3);
  const sharedPost = { externalId: "SAME", authorId: "AUTHOR", caption: "#话题", publishedAt: "2026-08-31T08:00:00Z", likes: 100 };
  const base = { capturedAt: "2026-08-31T09:00:00Z", snapshot: {}, warnings: [], qualityStatus: "validated", raw: {} };
  database.saveCollection(account, runId, { ...base, posts: [sharedPost] });
  database.saveCollection(duplicateAccount, runId, { ...base, posts: [sharedPost] });
  database.saveCollection(hashtag, runId, { ...base, posts: [sharedPost] });
  const report = database.getReport("day", new Date("2026-08-31T12:00:00Z"));
  assert.equal(report.summary.postCount, 1);
  assert.equal(report.summary.authorCount, 1);
  assert.equal(report.summary.likesCurrent, 100);
});
