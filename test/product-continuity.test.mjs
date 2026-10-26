import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { MonitorDatabase } from "../lib/database.mjs";
import { getAuthorSources, getProductContinuity, safeAuthorSourceUrl } from "../lib/product-continuity.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "product-continuity-test-"));
  const file = join(directory, "fixture.sqlite");
  const database = new MonitorDatabase(file);
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  return { database, file };
}

const now = new Date("2026-09-13T12:00:00Z");
const scheduler = { scheduleTime: "10:00", nextRunAt: "2026-09-13T17:00:00Z", lastTickAt: "2026-09-13T11:59:45Z", scheduleState: "waiting", running: false };

function target(database, label, enabled = true) {
  return database.createTarget({ type: "account", provider: "public-web", label, locator: `MS4wLj${label}`, enabled });
}

function snapshot(database, account, capturedAt, values = {}) {
  database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,quality_status,account_status,works_coverage,warnings_json,source_checksum,raw_json)
    VALUES(?,?,?,?,?,'validated','available','complete','[]','test','{}')`)
    .run(account.id, capturedAt, values.followers ?? null, values.likes ?? null, values.posts ?? null);
}

function run(database, startedAt, details, { count = details.length, status = "success", targetId = null } = {}) {
  const id = database.beginRun("scheduled", targetId, count);
  if (status !== "running") database.finishRun(id, { status, processedCount: details.length, successCount: details.filter((item) => item.profileUsable).length, details });
  database.db.prepare("UPDATE runs SET started_at=?,finished_at=?,details_json=? WHERE id=?")
    .run(startedAt, status === "running" ? null : startedAt, JSON.stringify(details), id);
  return id;
}

test("continuity groups real daily roster IDs, retains yesterday, and never promotes latest 1/1 into full coverage", (t) => {
  const { database } = fixture(t);
  const a = target(database, "A");
  const b = target(database, "B");
  target(database, "new-today");
  const first = run(database, new Date("2026-09-12T10:00:00").toISOString(), [
    { targetId: a.id, status: "validated", accountStatus: "available", worksCoverage: "complete", reviewState: "complete", profileUsable: true },
    { targetId: b.id, status: "error", message: "公开主页账号不一致" },
  ], { status: "partial" });
  const last = run(database, new Date("2026-09-12T11:00:00").toISOString(), [{ targetId: a.id, status: "validated", accountStatus: "available", worksCoverage: "complete", reviewState: "complete", profileUsable: true }]);
  database.updateTarget(b.id, { enabled: false });
  const result = getProductContinuity(database, scheduler, { now });
  assert.equal(result.todayPlan, null);
  assert.equal(result.latestPlan.targetCount, 2, "paused old / newly added targets cannot change historical denominator");
  assert.equal(result.latestPlan.runCount, 2);
  assert.equal(result.latestPlan.attemptCount, 3);
  assert.equal(result.latestPlan.completedTargetCount, 1);
  assert.equal(result.latestPlan.manualTargetCount, 1);
  assert.equal(result.latestPlan.latestRunId, last);
  assert.equal(result.latestPlan.latestRunTargetCount, 1);
  assert.equal(result.latestPlan.coveragePercent, 50);
  assert.equal(result.latestPlan.status, "partial");
  assert.ok(last > first);
});

test("business-timezone continuity groups scheduled runs by Beijing calendar day", (t) => {
  const { database } = fixture(t);
  const account = target(database, "北京计划");
  run(database, "2026-09-21T02:00:00Z", [{ targetId: account.id, status: "validated", accountStatus: "available", worksCoverage: "complete", reviewState: "complete", profileUsable: true }]);
  const result = getProductContinuity(database, scheduler, {
    now: new Date("2026-09-21T15:00:00Z"), timeZone: "Asia/Shanghai",
  });
  assert.equal(result.todayPlan?.date, "2026-09-21");
  assert.equal(result.latestPlan?.date, "2026-09-21");
});

test("continuity distinguishes usable profiles from works retries and fails closed for unknown interrupted roster", (t) => {
  const { database } = fixture(t);
  const a = target(database, "A");
  run(database, "2026-09-13T11:00:00Z", [{ targetId: a.id, status: "warning", reviewState: "retry", profileUsable: true }], { count: 4, status: "running" });
  const result = getProductContinuity(database, scheduler, { now });
  assert.equal(result.latestPlan.denominatorComplete, false);
  assert.equal(result.latestPlan.targetCount, 4);
  assert.equal(result.latestPlan.recordedTargetCount, 1);
  assert.equal(result.latestPlan.unknownTargetCount, 3);
  assert.equal(result.latestPlan.profileSuccessfulTargetCount, 1);
  assert.equal(result.latestPlan.completedTargetCount, 0);
  assert.equal(result.latestPlan.coveragePercent, null);
});

test("validated identity audit without a matching metric snapshot is not reported as complete", (t) => {
  const { database } = fixture(t);
  const a = target(database, "A");
  const b = target(database, "B");
  const id = run(database, "2026-09-13T11:00:00Z", [], { count: 2, status: "partial" });
  const insert = database.db.prepare("INSERT INTO audits(target_id,run_id,created_at,provider,status,warnings_json,message) VALUES(?,?,?,'public-web',?,'[]',?)");
  insert.run(a.id, id, "2026-09-13T11:01:00Z", "validated", "完成");
  insert.run(b.id, id, "2026-09-13T11:01:00Z", "rejected", "HTTP 503 timeout");
  const plan = getProductContinuity(database, scheduler, { now }).latestPlan;
  assert.equal(plan.targetCount, 2);
  assert.equal(plan.denominatorComplete, true);
  assert.equal(plan.completedTargetCount, 0);
  assert.equal(plan.retryTargetCount, 2);
  assert.equal(plan.manualTargetCount, 0, "transient failure is not an identity conflict");
});

test("saved complete reviewState cannot override missing, null, or unknown works coverage", (t) => {
  for (const worksCoverage of [undefined, null, "unknown", "future-value"]) {
    const { database } = fixture(t);
    const account = target(database, `无作品证据-${worksCoverage ?? "missing"}`);
    run(database, "2026-09-13T11:00:00Z", [{
      targetId: account.id,
      status: "validated",
      accountStatus: "available",
      ...(worksCoverage === undefined ? {} : { worksCoverage }),
      reviewState: "complete",
      profileUsable: true,
    }]);
    const plan = getProductContinuity(database, scheduler, { now }).latestPlan;
    assert.equal(plan.completedTargetCount, 0, String(worksCoverage));
    assert.equal(plan.retryTargetCount, 1, String(worksCoverage));
    assert.equal(plan.profileSuccessfulTargetCount, 1, "profile metric evidence stays separate from works completeness");
  }
});

test("freshness is per metric, includes zero, excludes future/paused samples and never fills missing likes", (t) => {
  const { database } = fixture(t);
  const a = target(database, "A");
  const b = target(database, "B");
  const c = target(database, "C");
  const paused = target(database, "paused", false);
  snapshot(database, a, "2026-09-09T11:00:00Z", { followers: 2, likes: 5, posts: 10 });
  snapshot(database, a, "2026-09-13T11:00:00Z", { followers: 0, posts: 0 });
  snapshot(database, b, "2026-09-12T11:00:00Z", { followers: 3, likes: 0, posts: 1 });
  snapshot(database, c, "2026-09-14T11:00:00Z", { followers: 999, likes: 999, posts: 999 });
  snapshot(database, paused, "2026-09-13T11:00:00Z", { followers: 10, likes: 10, posts: 10 });
  const result = getProductContinuity(database, scheduler, { now }).freshness;
  assert.equal(result.total, 3);
  assert.equal(result.metrics.followers.freshCount, 1);
  assert.equal(result.metrics.followers.agingCount, 1);
  assert.equal(result.metrics.followers.missingCount, 1);
  assert.equal(result.metrics.likes.freshCount, 0);
  assert.equal(result.metrics.likes.staleCount, 1);
  assert.equal(result.metrics.likes.agingCount, 1);
  assert.deepEqual(result.metrics.likes.staleTargetIds, [a.id]);
  assert.deepEqual(result.metrics.likes.missingTargetIds, [c.id]);
  assert.equal(result.metrics.estimatedPlays.proxy, true);
  assert.equal(result.metrics.estimatedPlays.staleCount, 1);
});

test("source URL sanitizer rejects lookalikes/credentials/ports/non-sheet paths and strips tokens", () => {
  assert.equal(safeAuthorSourceUrl("https://tenant.feishu.cn/sheets/Abcdef123456?token=[REDACTED]&sheet=abc#x"), "https://tenant.feishu.cn/sheets/Abcdef123456?sheet=abc");
  for (const url of ["https://feishu.cn.evil.test/sheets/Abcdef123456", "https://u:p@tenant.feishu.cn/sheets/Abcdef123456", "http://tenant.feishu.cn/sheets/Abcdef123456", "https://tenant.feishu.cn:8443/sheets/Abcdef123456", "https://tenant.feishu.cn/wiki/Abcdef123456", "javascript:alert(1)"]) {
    assert.equal(safeAuthorSourceUrl(url), null, url);
  }
});

test("source cards are owner-scoped, deduped by sheet and board, and cannot leak raw requests", (t) => {
  const { database } = fixture(t);
  const userInsert = database.db.prepare("INSERT INTO users(display_name,role,enabled,auth_source,created_at,updated_at) VALUES(?,'editor',1,'test',?,?)");
  const firstUser = Number(userInsert.run("one", now.toISOString(), now.toISOString()).lastInsertRowid);
  const secondUser = Number(userInsert.run("two", now.toISOString(), now.toISOString()).lastInsertRowid);
  const create = (id, userId, revision, extra = {}) => database.createAuthorResolutionJob({
    id, userId, actorName: "PRIVATE ACTOR", clientIp: "PRIVATE IP", fileName: "/private/input.xlsx", sheetName: "作者",
    request: { sourceType: "lark-sheet", sourceUrl: "https://tenant.feishu.cn/sheets/Abcdef123456?token=[REDACTED]", sourceSheetId: "aaa", sourceTitle: "云来源", sourceRevision: revision, sourceReadAt: now.toISOString(), defaultBoard: "团团", rows: [{ private: "DO NOT EXPOSE" }], cookie: "SECRET", ...extra },
  });
  create("1", firstUser, 1);
  create("2", firstUser, 2);
  create("3", secondUser, 3, { sourceTitle: "OTHER USER SOURCE" });
  create("4", firstUser, 4, { defaultBoard: "其他板块" });
  create("5", firstUser, 5, { sourceUrl: "https://evil.test/sheets/Abcdef123456" });
  assert.deepEqual(getAuthorSources(database), []);
  assert.deepEqual(getAuthorSources(database, { userId: true }), []);
  const cards = getAuthorSources(database, { userId: firstUser });
  assert.equal(cards.length, 2);
  assert.equal(cards.find((item) => item.defaultBoard === "团团").revision, 2);
  assert.equal(cards[0].fileName, "input.xlsx");
  assert.match(cards[0].sourceUrl, /\?sheet=aaa$/);
  const text = JSON.stringify(cards);
  assert.doesNotMatch(text, /SECRET|PRIVATE|DO NOT EXPOSE|OTHER USER|\/private/);
  assert.equal(getAuthorSources(database, { userId: secondUser }).length, 1);
});

test("continuity exposes timezone conversion and sanitized backup level, with no database changes", (t) => {
  const { database, file } = fixture(t);
  target(database, "A");
  const readOnly = new DatabaseSync(file, { readOnly: true });
  t.after(() => readOnly.close());
  const before = readOnly.prepare("SELECT total_changes() AS n").get().n;
  const result = getProductContinuity({ db: readOnly }, scheduler, { now, backup: {
    status: "ok", createdAt: now.toISOString(), checkedAt: now.toISOString(), fileName: "/private/backup.sqlite", source: "/PRIVATE DB", error: "SECRET", verification: "manifest", validation: { quickCheck: "ok", integrityCheck: "ok", foreignKeyViolations: 0, counts: { private: 999 } },
  } });
  assert.equal(result.nextRunBeijing, "2026/09/14 01:00:00");
  assert.equal(result.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(result.schedulerReady, true);
  assert.equal(result.backup.verification, "manifest");
  assert.doesNotMatch(JSON.stringify(result.backup), /private|PRIVATE|SECRET/);
  assert.equal(readOnly.prepare("SELECT total_changes() AS n").get().n, before);
});
