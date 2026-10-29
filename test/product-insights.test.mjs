import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MonitorDatabase } from "../lib/database.mjs";
import { getProductInsights, getAccountInsight } from "../lib/product-insights.mjs";
import { checksum } from "../lib/utils.mjs";
import { ConsoleReader } from "../lib/console-reader.mjs";

const at = (date, hour = 12) => new Date(`${date}T${String(hour).padStart(2, "0")}:00:00`).toISOString();
const reference = new Date(at("2026-09-13", 18));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "product-insights-"));
  const database = new MonitorDatabase(join(directory, "test.sqlite"));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  let accountSequence = 0;
  const addAccount = (label, enabled = true, extra = {}) => {
    accountSequence += 1;
    const target = database.createTarget({ type: "account", label, locator: `MS4wLjABAAAAaccount${accountSequence}abcdefghijklmnop`,
      provider: "public-web", metadata: { platform: "douyin", ...extra } });
    database.db.prepare("UPDATE targets SET created_at=?,updated_at=? WHERE id=?")
      .run("2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z", target.id);
    if (!enabled) database.db.prepare("UPDATE targets SET enabled=0 WHERE id=?").run(target.id);
    return target;
  };
  const insert = (target, capturedAt, values, { quality = "validated", accountStatus = "available", worksCoverage = "complete" } = {}) => {
    const normalizedAt = new Date(capturedAt).toISOString();
    const raw = { capturedAt: normalizedAt, profile: { user: { sec_uid: target.locator,
      uid: "222523170759696", follower_count: values[0] ?? null,
      total_favorited: values[1] ?? null, aweme_count: values[2] ?? null } }, works: { aweme_list: [] } };
    database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,
      quality_status,account_status,works_coverage,source_checksum,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(target.id, capturedAt, values[0] ?? null, values[1] ?? null, values[2] ?? null,
        quality, accountStatus, worksCoverage, checksum(raw), JSON.stringify(raw));
  };
  const sample = (target, date, values, options = {}) => insert(target, at(date, options.hour ?? 12), values, options);
  const addPost = (target, id, publishedDate, seenDate, likes = 10) => {
    const result = database.db.prepare(`INSERT INTO posts(target_id,external_id,caption,published_at,
      first_seen_at,last_seen_at,url,likes) VALUES(?,?,?,?,?,?,?,?)`)
      .run(target.id, id, "公开作品", at(publishedDate), at(seenDate), at(seenDate), `https://www.douyin.com/video/${id}`, likes);
    database.db.prepare("INSERT INTO post_metrics(post_id,captured_at,likes) VALUES(?,?,?)")
      .run(Number(result.lastInsertRowid), at(seenDate), likes);
    return Number(result.lastInsertRowid);
  };
  return { database, addAccount, sample, insert, addPost };
}

test("product insights batch all accounts, deduplicate cross-board members and retain paused/empty boards", (t) => {
  const { database, addAccount, sample } = fixture(t);
  const first = addAccount("first"); const second = addAccount("second"); const paused = addAccount("paused", false);
  database.createBoard("空板块");
  database.assignTargetsToBoard([first.id, second.id, paused.id], "板块甲");
  database.assignTargetsToBoard([first.id], "板块乙");
  database.db.prepare("UPDATE target_boards SET created_at=? WHERE board_key IN (?,?)")
    .run("2026-06-01T00:00:00.000Z", "板块甲", "板块乙");
  sample(first, "2026-09-06", [100, 1000, 10]); sample(first, "2026-09-13", [125, 900, 9]);
  sample(second, "2026-09-06", [200, 0, 3]); sample(second, "2026-09-13", [190, 10, 4]);
  sample(paused, "2026-09-06", [300, 300, 5]); sample(paused, "2026-09-13", [900, 1000, 9]);
  const before = database.db.prepare("SELECT total_changes() AS count").get().count;
  const result = getProductInsights(database, { period: "week", reference });
  assert.equal(result.accounts.length, 3);
  assert.equal(result.summary.memberCount, 3);
  assert.equal(result.summary.enabledCount, 2);
  assert.equal(result.summary.pausedCount, 1);
  assert.equal(result.summary.metrics.followers.value, 315);
  assert.equal(result.summary.metrics.followers.delta, 15);
  assert.equal(result.summary.metrics.followers.percent, 5);
  assert.equal(result.summary.metrics.followers.gainedCount, 1);
  assert.equal(result.summary.metrics.followers.lostCount, 1);
  assert.equal(result.summary.metrics.followers.coveragePercent, 100);
  assert.equal(result.summary.metrics.likes.delta, -90);
  assert.equal(result.summary.metrics.estimatedPlays.delta, -9000);
  assert.equal(result.summary.metrics.estimatedPlays.value, 91000);
  assert.equal(result.boards.find((board) => board.name === "空板块").metrics.followers.value, null);
  assert.equal(result.boards.find((board) => board.name === "板块乙").metrics.followers.value, 125);
  assert.equal(result.accounts.find((account) => account.id === paused.id).status.key, "paused");
  assert.equal(database.db.prepare("SELECT total_changes() AS count").get().count, before, "insight reads must not mutate data");
  assert.equal(getProductInsights(database, { reference, board: "  板块乙  " }).accounts.length, 1);
});

test("historical insights scope targets and retained board memberships at the period end", (t) => {
  const { database, addAccount, sample } = fixture(t);
  const alreadyAssigned = addAccount("期末前已入板块");
  const assignedLater = addAccount("期末后才入板块");
  const createdLater = addAccount("期末后才创建");
  database.db.prepare("UPDATE targets SET created_at=? WHERE id IN (?,?)")
    .run("2026-09-01T00:00:00.000Z", alreadyAssigned.id, assignedLater.id);
  database.db.prepare("UPDATE targets SET created_at=? WHERE id=?")
    .run("2026-10-01T00:00:00.000Z", createdLater.id);
  database.assignTargetsToBoard([alreadyAssigned.id], "历史切片板块");
  database.assignTargetsToBoard([assignedLater.id], "历史切片板块");
  database.db.prepare("UPDATE target_boards SET created_at=? WHERE target_id=?")
    .run("2026-09-01T00:00:00.000Z", alreadyAssigned.id);
  for (const target of [alreadyAssigned, assignedLater, createdLater]) {
    sample(target, "2026-09-23", [100, 1_000, 10], { hour: 8 });
    sample(target, "2026-09-30", [110, 1_100, 11], { hour: 8 });
  }
  const options = { period: "custom", timeZone: "Asia/Shanghai", reference: new Date("2026-10-02T12:00:00Z"),
    startDate: "2026-09-24", endDate: "2026-09-30" };
  const all = getProductInsights(database, options);
  const board = getProductInsights(database, { ...options, board: "历史切片板块" });
  const unassigned = getProductInsights(database, { ...options, board: "__unassigned__" });
  assert.deepEqual(all.accounts.map(account => account.id).sort((a, b) => a - b), [alreadyAssigned.id, assignedLater.id]);
  assert.deepEqual(board.accounts.map(account => account.id), [alreadyAssigned.id]);
  assert.deepEqual(unassigned.accounts.map(account => account.id), [assignedLater.id]);
  assert.equal(all.summary.metrics.followers.delta, 20);
  assert.equal(board.summary.metrics.followers.delta, 10);
  assert.equal(unassigned.summary.metrics.followers.delta, 10);
  assert.equal(getAccountInsight(database, createdLater.id, options), null);
  assert.equal(all.scopeBasis.targetCreated, "period-end");
  assert.equal(all.scopeBasis.boardMembership, "retained-relationship-created-by-period-end");
  assert.equal(all.scopeBasis.boardMembershipRemoval, "not-historized");
  assert.equal(all.scopeBasis.boardCatalog, "current-catalog");
  assert.equal(all.scopeBasis.enabledStatus, "period-end-recorded-state");
  assert.equal(Object.hasOwn(board.boards.find(item => item.key === "历史切片板块"), "catalogTargetCount"), false,
    "historical insight must not leak a current board-member count");
});

test("历史产品总览按区间末已留痕的启停状态统计账号贡献", (t) => {
  const { database, addAccount, sample } = fixture(t);
  const target = addAccount("区间后停用的作者");
  sample(target, "2026-09-28", [100, 1_000, 10], { hour: 7 });
  sample(target, "2026-09-29", [120, 1_200, 12], { hour: 7 });
  database.db.prepare("UPDATE targets SET enabled=0,updated_at=? WHERE id=?")
    .run("2026-09-29T00:00:00.000Z", target.id);
  database.db.prepare(`
    INSERT INTO activity_log(actor_name,action,resource_type,resource_id,created_at,details_json)
    VALUES('fixture','target.update','target',?,'2026-09-29T00:00:00.000Z','{"enabled":false}')
  `).run(String(target.id));

  const common = { period: "custom", timeZone: "Asia/Shanghai", reference: new Date("2026-10-02T12:00:00Z"),
    startDate: "2026-09-28" };
  const beforePause = getProductInsights(database, { ...common, endDate: "2026-09-28" });
  const afterPause = getProductInsights(database, { ...common, endDate: "2026-09-29" });
  assert.equal(beforePause.summary.enabledCount, 1);
  assert.equal(beforePause.summary.metrics.followers.value, 100);
  assert.equal(beforePause.accounts.find((account) => account.id === target.id).enabled, true);
  assert.equal(afterPause.summary.enabledCount, 0);
  assert.equal(afterPause.accounts.find((account) => account.id === target.id).enabled, false);
  assert.equal(beforePause.scopeBasis.enabledStatus, "period-end-recorded-state");
  assert.match(beforePause.scopeBasis.description, /未留痕的旧启停变更无法完整还原/);
});

test("explicit business timezone keeps Beijing collection batches on the correct calendar date", (t) => {
  const { database, addAccount, insert } = fixture(t);
  const first = addAccount("北京批次甲");
  const second = addAccount("北京批次乙");
  const insertAt = (target, capturedAt, followers, likes, posts) => insert(target, capturedAt, [followers, likes, posts]);
  // 02:00Z is 10:00 Beijing but still the previous day in Los Angeles.
  insertAt(first, "2026-09-20T02:00:00Z", 100, 1_000, 10);
  insertAt(second, "2026-09-20T02:00:00Z", 200, 2_000, 20);
  insertAt(first, "2026-09-21T02:00:00Z", 110, 1_100, 11);
  insertAt(second, "2026-09-21T02:00:00Z", 210, 2_100, 21);
  const result = getProductInsights(database, {
    period: "day", timeZone: "Asia/Shanghai", reference: new Date("2026-09-21T15:00:00Z"),
  });
  const point = result.summary.trend.find((item) => item.date === "2026-09-21");
  assert.deepEqual(result.range, {
    startDate: "2026-09-21", endDate: "2026-09-21", start: "2026-09-20T16:00:00.000Z",
    end: "2026-09-21T15:00:00.000Z", inclusive: true, partialEndDay: true,
  });
  assert.equal(point.followers, 320);
  assert.equal(point.followersDelta, 20);
  assert.equal(point.likes, 3_200);
  assert.equal(point.likesDelta, 200);
  assert.equal(point.posts, 32);
  assert.equal(point.postsDelta, 2);
  assert.equal(point.followersObservedCount, 2);
  assert.equal(point.followersComparableCount, 2);
});

test("matrix totals do not count a carried prior value as a historical-day observation", (t) => {
  const { database, addAccount, insert } = fixture(t);
  const target = addAccount("历史缺采");
  insert(target, "2026-09-17T04:00:00Z", [100, 1_000, 10]);
  const result = getProductInsights(database, {
    period: "custom", timeZone: "Asia/Shanghai", reference: new Date("2026-09-22T01:00:00Z"),
    startDate: "2026-09-18", endDate: "2026-09-18",
  });
  const followers = result.summary.metrics.followers;
  assert.equal(followers.value, null);
  assert.equal(followers.delta, null);
  assert.equal(followers.observedCount, 0);
  assert.equal(followers.valueQuality.status, "missing");
  assert.equal(result.accounts[0].metrics.followers.value, 100, "account detail may retain the last trusted value");
  assert.equal(result.accounts[0].metrics.followers.observedInPeriod, false);
});

test("hashtag views stay out of account board totals and estimated playback", (t) => {
  const { database, addAccount, sample } = fixture(t);
  const account = addAccount("account-only");
  const hashtag = database.createTarget({ type: "hashtag", label: "#账号隔离话题", locator: "账号隔离话题",
    provider: "public-web", metadata: { platform: "douyin" } });
  database.assignTargetsToBoard([account.id, hashtag.id], "账号与话题混合板块");
  database.db.prepare("UPDATE target_boards SET created_at=? WHERE target_id=?")
    .run("2026-06-01T00:00:00.000Z", account.id);
  sample(account, "2026-09-12", [100, 1_000, 10]);
  sample(account, "2026-09-13", [110, 1_200, 11]);
  database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,hashtag_participants,hashtag_views,hashtag_posts,
    quality_status,account_status,works_coverage,source_checksum,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(hashtag.id, at("2026-09-13"), 9_999, 9_000_000_000, 1_234, "validated", "unknown", "complete",
      "hashtag-isolation", JSON.stringify({ scope: "douyin-official-challenge-detail", views: 9_000_000_000 }));

  const result = getProductInsights(database, { reference, board: "账号与话题混合板块", period: "day" });
  assert.equal(result.summary.memberCount, 1, "account board totals must exclude hashtag targets");
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].id, account.id);
  assert.equal(result.summary.metrics.likes.value, 1_200);
  assert.equal(result.summary.metrics.estimatedPlays.value, 120_000);
  assert.equal(result.accounts.some((item) => item.id === hashtag.id), false);
  const boardTargets = database.listTargets({ board: "账号与话题混合板块" });
  assert.equal(boardTargets.some((item) => item.id === hashtag.id && item.type === "hashtag"), true,
    "topic remains visible through target/topic management APIs");
});

test("account directory keeps the submitted identifier in its own platform namespace", (t) => {
  const { database, sample } = fixture(t);
  const target = database.createTarget({ type: "account", label: "B站作者", locator: "1809444890",
    provider: "public-web", metadata: { platform: "bilibili", bilibiliId: "1809444890", douyinId: "误导抖音号" } });
  database.db.prepare("UPDATE targets SET created_at=? WHERE id=?").run("2026-06-01T00:00:00.000Z", target.id);
  sample(target, "2026-09-13", [100, 200, 3]);
  const account = getProductInsights(database, { reference }).accounts[0];
  assert.equal(account.platform, "bilibili");
  assert.equal(account.submittedAccountId, "1809444890");
});

test("per-metric comparisons match report snapshots, but never turn missing values/zero baseline into percentages", (t) => {
  const { database, addAccount, sample } = fixture(t);
  const target = addAccount("metric");
  sample(target, "2026-09-12", [100, 0, 2]);
  sample(target, "2026-09-13", [90, null, null], { hour: 9 });
  sample(target, "2026-09-13", [null, 30, 1], { hour: 14, quality: "warning", worksCoverage: "limited" });
  const detail = getAccountInsight(database, target.id, { reference, period: "day" });
  const report = database.getReport("day", reference).contributors[0];
  assert.equal(detail.account.metrics.followers.delta, report.followersDelta);
  assert.equal(detail.account.metrics.likes.delta, report.accountLikesDelta);
  assert.equal(detail.account.metrics.followers.delta, -10);
  assert.equal(detail.account.metrics.followers.percent, -10);
  assert.equal(detail.account.metrics.followers.dailyComparable, true);
  assert.equal(detail.account.metrics.followers.currentAt, at("2026-09-13", 9));
  assert.equal(detail.account.metrics.likes.currentAt, at("2026-09-13", 14));
  assert.equal(detail.account.metrics.likes.percent, null);
  assert.match(detail.account.metrics.likes.percentReason, /基准为 0/);
  assert.equal(detail.account.metrics.posts.delta, -1);
  assert.match(detail.account.metrics.posts.definition, /不等于新增发布量/);
  assert.equal(detail.account.status.worksCoverage, "limited");
  assert.equal(detail.account.status.key, "updated");
});

test("same-day first observations are labelled observed-window change, not daily growth", (t) => {
  const { database, addAccount, sample } = fixture(t);
  const target = addAccount("intraday");
  sample(target, "2026-09-13", [100, 1000, 1], { hour: 9 });
  sample(target, "2026-09-13", [120, 1200, 2], { hour: 15 });
  const detail = getAccountInsight(database, target.id, { reference, period: "day" });
  assert.equal(detail.account.metrics.followers.delta, null, "same-day observations are not a complete daily interval");
  assert.equal(detail.account.metrics.followers.comparable, false);
  assert.equal(detail.account.metrics.followers.observedWindow.delta, 20);
  assert.equal(detail.account.metrics.followers.baselineMode, "first-in-period");
  assert.equal(detail.account.metrics.followers.dailyComparable, false);
  assert.equal(detail.account.metrics.followers.fullPeriodComparable, false);
  assert.equal(detail.account.metrics.followers.comparisonLabel, "暂无完整区间可比数据");
  assert.equal(detail.account.metrics.followers.observedWindow.comparisonLabel, "已观察时段变化");
  assert.equal(detail.account.trend.at(-1).followersDelta, null);
  assert.equal(detail.account.trend.at(-1).estimatedPlays, 120000);
});

test("trend preserves each local date, independent metric nulls and only adjacent-day deltas", (t) => {
  const { database, addAccount, sample } = fixture(t);
  const target = addAccount("trend");
  sample(target, "2026-09-10", [100, 100, 1]);
  sample(target, "2026-09-12", [110, null, 2]);
  sample(target, "2026-09-13", [105, 120, 3]);
  const { account } = getAccountInsight(database, target.id, { reference });
  assert.equal(account.trend.length, 30);
  assert.equal(new Set(account.trend.map((point) => point.date)).size, 30);
  const gap = account.trend.find((point) => point.date === "2026-09-11");
  assert.equal(gap.followers, null); assert.equal(gap.estimatedPlays, null); assert.equal(gap.missing, true);
  assert.equal(account.trend.find((point) => point.date === "2026-09-12").followersDelta, null);
  assert.equal(account.trend.at(-1).followersDelta, -5);
  assert.equal(account.trend.at(-1).likesDelta, null);
  assert.equal(account.trend.at(-1).estimatedPlaysDelta, null);
});

test("future and rejected samples are excluded; failed attempts keep old trusted metrics with stale status", (t) => {
  const { database, addAccount, sample } = fixture(t);
  const target = addAccount("stale");
  sample(target, "2026-09-01", [99, null, 2]);
  sample(target, "2026-09-12", [9999, 9999, 99], { quality: "rejected" });
  sample(target, "2026-09-14", [99999, 99999, 999]);
  database.db.prepare("UPDATE targets SET last_checked_at=?,last_status='error',last_error='本次连接失败' WHERE id=?")
    .run(at("2026-09-13", 16), target.id);
  const { account } = getAccountInsight(database, target.id, { reference, period: "day" });
  assert.equal(account.metrics.followers.value, 99);
  assert.equal(account.metrics.followers.delta, null);
  assert.equal(account.metrics.likes.value, null);
  assert.match(account.metrics.followers.reason, /沿用此前/);
  assert.equal(account.status.stale, true);
  assert.equal(account.status.key, "retry");
  assert.equal(account.status.lastSuccessAt, at("2026-09-01"));
  assert.equal(account.status.lastAttemptAt, at("2026-09-13", 16));
  assert.equal(account.trend.at(-1).followers, null);
});

test("batch loads older per-metric baselines beyond the trend window without filling missing dates", (t) => {
  const { database, addAccount, sample } = fixture(t);
  const target = addAccount("old");
  sample(target, "2026-04-01", [50, null, 1]);
  sample(target, "2026-07-01", [null, 400, null]);
  sample(target, "2026-09-13", [70, 500, 2]);
  const { account } = getAccountInsight(database, target.id, { reference, period: "day" });
  assert.equal(account.metrics.followers.baseline, 50);
  assert.equal(account.metrics.followers.baselineAt, at("2026-04-01"));
  assert.equal(account.metrics.likes.baselineAt, at("2026-07-01"));
  assert.equal(account.metrics.followers.dailyComparable, false);
  assert.match(account.metrics.followers.reason, /跨缺采日期/);
  assert.equal(account.trend.filter((point) => !point.missing).length, 1);
});

test("custom ranges compare independently with strict endpoint evidence and no first-in-period substitution", (t) => {
  const { database, addAccount, sample } = fixture(t);
  const target = addAccount("ranges");
  sample(target, "2026-07-31", [100, 200, 10]);
  sample(target, "2026-08-01", [110, 210, 11]);
  sample(target, "2026-08-05", [150, 300, 15]);
  sample(target, "2026-08-30", [180, 400, 18]);
  sample(target, "2026-08-31", [200, 500, 20]);
  const options = { reference, period: "custom", startDate: "2026-08-01", endDate: "2026-08-31",
    comparisonStartDate: "2026-08-02", comparisonEndDate: "2026-08-30" };
  const detail = getAccountInsight(database, target.id, options);
  assert.equal(detail.account.metrics.followers.delta, 100);
  assert.equal(detail.account.metrics.followers.percent, 100);
  assert.equal(detail.account.metrics.followers.fullPeriodComparable, true);
  assert.equal(detail.account.trend.length, 31);
  assert.equal(detail.comparison.account.trend.length, 29);
  assert.equal(detail.comparison.account.metrics.followers.delta, 70);
  assert.equal(detail.comparison.account.metrics.followers.baselineAt, at("2026-08-01"));
  assert.equal(detail.comparison.account.metrics.followers.currentAt, at("2026-08-30"));
  assert.equal(detail.comparison.comparison, null);
  const missingEnd = getAccountInsight(database, target.id, { ...options, endDate: "2026-08-29" });
  assert.equal(missingEnd.account.metrics.followers.delta, null);
  assert.match(missingEnd.account.metrics.followers.reason, /结束日观测/);
  const missingStart = getAccountInsight(database, target.id, { reference, startDate: "2026-08-05", endDate: "2026-08-31" });
  assert.equal(missingStart.account.metrics.followers.delta, null);
  assert.equal(missingStart.period, "custom");
  const product = getProductInsights(database, options);
  assert.equal(product.comparison.summary.metrics.followers.delta, 70);
});

test("date ranges reject invalid, future, reversed, incomplete and overlong dates", (t) => {
  const { database } = fixture(t);
  for (const options of [
    { startDate: "2026-02-30", endDate: "2026-03-03" },
    { startDate: "2026-09-12", endDate: "2026-09-14" },
    { startDate: "2026-09-12", endDate: "2026-09-11" },
    { startDate: "2026-09-01" },
    { endDate: "2026-09-01" },
    { period: "custom" },
    { startDate: "2025-09-11", endDate: "2026-09-13" },
    { comparisonStartDate: "2026-09-01" },
  ]) assert.throws(() => getProductInsights(database, { reference, ...options }));
  const leap = getProductInsights(database, { reference, startDate: "2023-03-01", endDate: "2024-02-29" });
  assert.equal(leap.range.days, 366);
  assert.equal(leap.summary.trend.length, 366);
  const today = getProductInsights(database, { reference, startDate: "2026-09-13", endDate: "2026-09-13" });
  assert.equal(today.range.partialEndDay, true);
  assert.equal(today.end, reference.toISOString());
});

test("four metrics retain nulls and proxy provenance, with real zero distinguished from missing", (t) => {
  const { database, addAccount, sample } = fixture(t);
  const zero = addAccount("zero"); const empty = addAccount("empty");
  sample(zero, "2026-09-13", [0, 0, 0]);
  const result = getProductInsights(database, { reference });
  const zeroAccount = result.accounts.find((account) => account.id === zero.id);
  const emptyAccount = result.accounts.find((account) => account.id === empty.id);
  assert.equal(zeroAccount.metrics.followers.value, 0);
  assert.equal(zeroAccount.metrics.estimatedPlays.value, 0);
  assert.equal(zeroAccount.metrics.estimatedPlays.proxy, true);
  assert.equal(emptyAccount.metrics.estimatedPlays.value, null);
  assert.equal(result.summary.metrics.followers.value, 0);
  assert.equal(result.summary.metrics.followers.missingCount, 1);
  assert.equal(result.summary.metrics.followers.delta, null);
  assert.equal(result.summary.metrics.followers.comparableCount, 0);
});

test("published sample counts use observed work publication time, not changes in account inventory", (t) => {
  const { database, addAccount, sample, addPost } = fixture(t);
  const target = addAccount("posts");
  sample(target, "2026-09-12", [10, 20, 7]); sample(target, "2026-09-13", [11, 21, 6]);
  addPost(target, "7684617087687331118", "2026-09-13", "2026-09-13", 10);
  addPost(target, "7684617087687331119", "2026-09-12", "2026-09-13", 20);
  addPost(target, "7684617087687331120", "2026-09-13", "2026-09-14", 30);
  const detail = getAccountInsight(database, target.id, { reference, period: "day" });
  assert.equal(detail.account.metrics.posts.delta, -1);
  assert.equal(detail.account.publishedSamples.value, 1);
  assert.equal(detail.account.trend.at(-1).publishedSamples, 1);
  assert.equal(detail.recentWorks.length, 2);
  assert.equal(getProductInsights(database, { reference, period: "day" }).summary.publishedSamples.value, 1);
});

test("published samples retain each range-end discovery cutoff and publication-date basis without backfilling", (t) => {
  const { database, addAccount, addPost } = fixture(t);
  const target = addAccount("late-discovery");
  database.assignTargetsToBoard([target.id], "发布时间核对");
  database.db.prepare("UPDATE target_boards SET created_at=? WHERE target_id=?")
    .run("2026-06-01T00:00:00.000Z", target.id);
  database.createBoard("空来源板块");
  addPost(target, "7684617087687331121", "2026-09-11", "2026-09-13");
  const options = { reference, startDate: "2026-09-10", endDate: "2026-09-12",
    comparisonStartDate: "2026-09-10", comparisonEndDate: "2026-09-13" };
  const before = database.db.prepare("SELECT total_changes() AS count").get().count;
  const detail = getAccountInsight(database, target.id, options);
  const result = getProductInsights(database, options);
  const earlier = detail.account.publishedSamples;
  const later = detail.comparison.account.publishedSamples;
  assert.equal(earlier.value, 0, "the work was not yet discovered at the earlier range end");
  assert.equal(later.value, 1, "extending the end to the discovery day includes the old work");
  assert.equal(earlier.basis, "published_at");
  assert.equal(earlier.asOfBasis, "first_seen_at");
  assert.equal(earlier.scope, "observed-public-posts");
  assert.equal(earlier.asOf, new Date("2026-09-12T23:59:59.999").toISOString());
  assert.equal(later.asOf, reference.toISOString(), "today's cutoff is the observed reference time, not a future end of day");
  assert.match(earlier.reason, /截至区间结束已收录，按发布时间统计/);
  assert.match(earlier.reason, /结束后才发现的旧作品不计入/);
  assert.match(earlier.reason, /不代表全部发布量/);
  assert.equal(detail.account.trend.find((point) => point.date === "2026-09-11").publishedSamples, 0);
  assert.equal(detail.comparison.account.trend.find((point) => point.date === "2026-09-11").publishedSamples, 1);
  assert.equal(detail.comparison.account.trend.find((point) => point.date === "2026-09-13").publishedSamples, 0,
    "the discovery day must not replace the actual publication date");
  assert.deepEqual(result.accounts[0].publishedSamples, earlier);
  assert.deepEqual(result.summary.publishedSamples, earlier);
  assert.deepEqual(result.boards.find((board) => board.name === "发布时间核对").publishedSamples, earlier);
  assert.deepEqual(result.boards.find((board) => board.name === "空来源板块").publishedSamples, earlier);
  assert.deepEqual(result.comparison.summary.publishedSamples, later);
  assert.deepEqual(result.comparison.accounts[0].publishedSamples, later);
  assert.equal(database.db.prepare("SELECT total_changes() AS count").get().count, before);
});

test("three observed new publications remain three when two deletions leave inventory net growth of one", (t) => {
  const { database, addAccount, sample, addPost } = fixture(t);
  const target = addAccount("publish-versus-stock");
  sample(target, "2026-09-12", [100, 1000, 10]);
  sample(target, "2026-09-13", [100, 1000, 11], { worksCoverage: "limited" });
  // Historical works remain archived even when no longer visible publicly.
  addPost(target, "7684617087687331122", "2026-09-11", "2026-09-11");
  addPost(target, "7684617087687331123", "2026-09-11", "2026-09-11");
  for (const id of ["7684617087687331124", "7684617087687331125", "7684617087687331126"]) {
    addPost(target, id, "2026-09-13", "2026-09-13");
  }
  const detail = getAccountInsight(database, target.id, { reference, period: "day" });
  const result = getProductInsights(database, { reference, period: "day" });
  assert.equal(detail.account.metrics.posts.delta, 1);
  assert.equal(detail.account.publishedSamples.value, 3);
  assert.equal(detail.account.trend.at(-1).postsDelta, 1);
  assert.equal(detail.account.trend.at(-1).publishedSamples, 3);
  assert.equal(result.summary.metrics.posts.delta, 1);
  assert.equal(result.summary.publishedSamples.value, 3);
  assert.equal(result.summary.trend.at(-1).publishedSamples, 3);
  assert.equal(detail.account.status.worksCoverage, "limited");
  assert.match(detail.account.metrics.posts.definition, /不等于新增发布量/);
  assert.match(detail.account.publishedSamples.reason, /不代表全部发布量/);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM posts WHERE target_id=?").get(target.id).count, 5);
});

test("account sources and profile URLs never expose imported secrets or raw response objects", (t) => {
  const { database, addAccount } = fixture(t);
  const target = addAccount("safe", true, {
    cookie: "never-return-secret", authorization: "never-return-auth",
    importSource: { type: "lark-sheet", fileName: "名单", sourceRow: 2,
      sourceUrl: "https://tenant.feishu.cn/sheets/abc?sheet=one&token=never-return-token" },
    sourceMetadata: { sourceUrl: "https://user:never-return-password@tenant.feishu.cn/sheets/abc" },
  });
  const detail = getAccountInsight(database, target.id, { reference });
  assert.match(detail.account.profileUrl, /^https:\/\/www\.douyin\.com\/user\//);
  assert.equal(detail.account.sources[0].url, "https://tenant.feishu.cn/sheets/abc?sheet=one");
  assert.doesNotMatch(JSON.stringify(detail), /never-return|metadata_json|raw_json/);
  assert.equal(getAccountInsight(database, "1 OR 1=1", { reference }), null);
  assert.equal(getAccountInsight(database, 9999, { reference }), null);
});

test("list payload bounds account sparklines while detail and aggregate retain complete custom daily histories", (t) => {
  const { database, addAccount } = fixture(t);
  const target = addAccount("compact");
  const options = { reference, startDate: "2026-07-01", endDate: "2026-08-31" };
  const result = getProductInsights(database, options);
  const detail = getAccountInsight(database, target.id, options);
  assert.equal(result.summary.trend.length, 62);
  assert.equal(detail.account.trend.length, 62);
  assert.equal(result.accounts[0].trend.length, 30);
  assert.deepEqual(Object.keys(result.accounts[0].trend[0]), ["date", "followers"]);
  assert.ok(detail.account.metrics.followers.hasOwnProperty("baselineChecksum"));
  assert.ok(detail.account.hasOwnProperty("sources"));
});

test("batch query count remains fixed as the account catalog grows", (t) => {
  const { database, addAccount } = fixture(t);
  let count = 0;
  const integrationQueries = [
    /^PRAGMA table_info\(snapshots\)$/,
    /^SELECT 1 FROM sqlite_master WHERE type='table' AND name='works_observations'$/,
    /^PRAGMA table_info\(works_observations\)$/,
    /^WITH scoped_targets AS \(SELECT id FROM targets\), selected AS \(\s+SELECT latest\.id FROM scoped_targets t JOIN works_observations latest ON latest\.id=\(/,
    /^SELECT total_changes\(\) AS changes$/,
  ];
  let integrationCounts = integrationQueries.map(() => 0), transactionCalls = [];
  const adapter = { db: { exec(sql) { transactionCalls.push(sql); return database.db.exec(sql); }, prepare(sql) {
    count += 1;
    const category = integrationQueries.findIndex(pattern => pattern.test(sql));
    if (category >= 0) integrationCounts[category]++;
    return database.db.prepare(sql);
  } },
    listBoards() { return MonitorDatabase.prototype.listBoards.call(this); } };
  addAccount("batch-first");
  getProductInsights(adapter, { reference });
  const small = count;
  assert.deepEqual(integrationCounts, [2, 1, 1, 1, 1], 'snapshot schema has two pre-existing bounded checks; ledger read and mutation guard remain once');
  assert.deepEqual(transactionCalls, ['SAVEPOINT works_observation_read', 'RELEASE works_observation_read']);
  for (let index = 0; index < 40; index += 1) addAccount(`batch-${index}`);
  count = 0;
  integrationCounts = integrationQueries.map(() => 0); transactionCalls = [];
  const result = getProductInsights(adapter, { reference });
  assert.equal(result.accounts.length, 41);
  assert.equal(count, small);
  assert.deepEqual(integrationCounts, [2, 1, 1, 1, 1], 'schema checks and mutation guard must never become per-account reads');
  assert.deepEqual(transactionCalls, ['SAVEPOINT works_observation_read', 'RELEASE works_observation_read']);
  assert.equal(count, 25, 'bounded baseline reads plus two unified-source presence checks remain fixed as account count grows');
  assert.ok(count - integrationCounts.reduce((sum, value) => sum + value, 0) <= 19, `${count} queries remain batch reads rather than per-account reads`);
});

test("unassigned evidence counts remain distinct from account waiting-for-first-snapshot counts", (t) => {
  const { database, addAccount } = fixture(t);
  addAccount("unassigned");
  for (const [key, status] of [["a", "pending"], ["b", "retry"], ["c", "rejected"]]) {
    database.db.prepare("INSERT INTO author_resolution_queue(identity_key,name,status,created_at,updated_at,next_attempt_at) VALUES(?,?,?,?,?,?)")
      .run(key, key, status, at("2026-09-12"), at("2026-09-12"), at("2026-09-12"));
  }
  const board = getProductInsights(database, { reference, board: "__unassigned__" }).selectedBoard;
  assert.equal(board.memberCount, 1);
  assert.equal(board.waitingForFirstSnapshotCount, 1);
  assert.equal(board.queuedCount, 3);
  assert.equal(board.pendingCount, 2);
  assert.equal(board.rejectedCount, 1);
});

test("each metric retains independent freshness even when another metric was just refreshed", (t) => {
  const { database, addAccount, sample } = fixture(t);
  const target = addAccount("mixed-age");
  sample(target, "2026-08-01", [10, 100, 2]);
  sample(target, "2026-09-13", [20, null, 3]);
  const { account } = getAccountInsight(database, target.id, { reference });
  assert.equal(account.status.key, "updated");
  assert.equal(account.metrics.followers.stale, false);
  assert.equal(account.metrics.likes.stale, true);
  assert.equal(account.metrics.estimatedPlays.stale, true);
  const summary = getProductInsights(database, { reference }).summary;
  assert.equal(summary.metrics.likes.staleCount, 1);
  assert.equal(summary.metrics.likes.oldestObservedAt, at("2026-08-01"));
});

test("offset timestamps are normalized before comparison and cannot sneak future samples into history", (t) => {
  const { database, addAccount, sample, insert } = fixture(t);
  const target = addAccount("offset");
  sample(target, "2026-09-12", [50, 60, 2]);
  const cutoff = new Date("2026-09-13T12:00:00Z");
  const futureAt = "2026-09-13T08:00:00-12:00";
  insert(target, futureAt, [999, null, null]);
  const result = getAccountInsight(database, target.id, { reference: cutoff });
  assert.equal(result.account.metrics.followers.value, 50);
  assert.ok(result.account.metrics.followers.currentAt < cutoff.toISOString());
});

test("historical recent works use their observed metric at cutoff, not a future overwrite in posts", (t) => {
  const { database, addAccount, addPost } = fixture(t);
  const target = addAccount("work-history");
  const id = addPost(target, "7684617087687331188", "2026-09-12", "2026-09-12", 10);
  database.db.prepare("UPDATE posts SET likes=999,last_seen_at=? WHERE id=?").run(at("2026-09-14"), id);
  database.db.prepare("INSERT INTO post_metrics(post_id,captured_at,likes) VALUES(?,?,?)").run(id, at("2026-09-14"), 999);
  const result = getAccountInsight(database, target.id, { reference });
  assert.equal(result.recentWorks[0].likes, 10);
  assert.equal(result.recentWorks[0].lastObservedAt, at("2026-09-12"));
});

test("aggregate trend cohorts identify actual account sets per metric, not merely equal counts or totals", (t) => {
  const { database, addAccount, sample } = fixture(t);
  const first = addAccount("cohort-first"); const second = addAccount("cohort-second");
  const paused = addAccount("cohort-paused", false);
  database.assignTargetsToBoard([first.id, second.id, paused.id], "cohort-board");
  database.db.prepare("UPDATE target_boards SET created_at=? WHERE board_key=?")
    .run("2026-06-01T00:00:00.000Z", "cohort-board");
  sample(first, "2026-09-10", [100, 50, 0]);
  sample(second, "2026-09-11", [100, null, 0]);
  sample(second, "2026-09-12", [120, 50, 1]);
  sample(second, "2026-09-13", [125, 60, 1]);
  sample(paused, "2026-09-12", [9000, 9000, 9000]);
  const result = getProductInsights(database, { reference });
  const points = result.summary.trend.slice(-4);
  assert.equal(points[0].followers, points[1].followers);
  assert.equal(points[0].followersObservedCount, points[1].followersObservedCount);
  assert.match(points[0].followersCohortKey, /^[a-f0-9]{64}$/);
  assert.notEqual(points[0].followersCohortKey, points[1].followersCohortKey, "identical totals/counts but different authors must not be connected");
  assert.equal(points[1].followersCohortKey, points[2].followersCohortKey);
  assert.equal(points[2].followersCohortKey, points[3].followersCohortKey);
  assert.equal(points[1].followersDeltaCohortKey, null);
  assert.equal(points[2].followersDeltaCohortKey, points[3].followersDeltaCohortKey);
  assert.equal(points[1].likesCohortKey, null);
  assert.notEqual(points[0].likesCohortKey, points[2].likesCohortKey);
  assert.equal(points[2].estimatedPlaysCohortKey, points[2].likesCohortKey);
  assert.equal(points[3].estimatedPlaysDeltaCohortKey, points[3].likesDeltaCohortKey);
  assert.equal(points[2].postsCohortKey, points[2].followersCohortKey);
  const board = result.boards.find((item) => item.name === "cohort-board");
  assert.deepEqual(board.trend.map((point) => point.followersCohortKey), result.summary.trend.map((point) => point.followersCohortKey));
});

test("aggregate totals expose coverage quality and do not present a partial cohort as a reliable matrix total", (t) => {
  const { database, addAccount, sample } = fixture(t);
  const accounts = Array.from({ length: 10 }, (_, index) => addAccount(`coverage-${index}`));
  // Only two authors are observed on the first day; all ten are observed on
  // the second day. The raw sum remains available for audit, while quality
  // explicitly prevents the first day being read as the matrix total.
  sample(accounts[0], "2026-09-12", [100, 1000, 10]);
  sample(accounts[1], "2026-09-12", [100, 2000, 20]);
  accounts.forEach((account, index) => sample(account, "2026-09-13", [110, 1000 + index, 10 + index]));
  const result = getProductInsights(database, { reference, period: "custom", startDate: "2026-09-12", endDate: "2026-09-13" });
  const first = result.summary.trend.find((point) => point.date === "2026-09-12");
  const second = result.summary.trend.find((point) => point.date === "2026-09-13");
  assert.equal(first.likesObservedCount, 2);
  assert.equal(first.likesQuality, "partial");
  assert.equal(first.likesReliable, false);
  assert.match(first.likesQualityReason, /2\/10/);
  assert.equal(second.likesObservedCount, 10);
  assert.equal(second.likesReliable, true);
  assert.equal(second.estimatedPlaysReliable, true);
  assert.equal(result.summary.metrics.estimatedPlays.valueMeaning.includes("不是区间新增播放"), true);
  assert.match(result.methodology.dailyQuality, /100%/);
});

test("90 percent observed cohorts stay partial while their real totals and comparable changes remain visible", async (t) => {
  const { database, addAccount, sample } = fixture(t);
  const accounts = Array.from({ length: 10 }, (_, i) => addAccount(`near-full-${i}`));
  for (const account of accounts.slice(0, 9)) {
    sample(account, "2026-09-11", [100, 1000, 10]);
    sample(account, "2026-09-12", [100, 1000, 10]);
    sample(account, "2026-09-13", [110, 990, 11]);
  }
  const result = getProductInsights(database, { reference, period: "custom", startDate: "2026-09-12", endDate: "2026-09-13" });
  for (const name of ["followers", "likes", "posts", "estimatedPlays"]) {
    const metric = result.summary.metrics[name];
    assert.equal(metric.valueQuality.status, "partial");
    assert.equal(metric.deltaQuality.status, "partial");
    assert.equal(metric.valueQuality.complete, false);
    assert.equal(metric.valueQuality.missingCount, 1);
    assert.equal(metric.deltaQuality.complete, false);
    assert.equal(metric.reliable, true, "90% remains a comparable observed cohort, never a complete matrix");
    assert.equal(metric.observedCount, 9); assert.equal(metric.comparableCount, 9);
    assert.match(metric.valueQuality.reason, /9\/10/);
    const point = result.summary.trend.find(p => p.date === "2026-09-13");
    assert.equal(point[`${name}Quality`], "partial");
    assert.equal(point[`${name}Complete`], false);
    assert.equal(point[`${name}DeltaQuality`], "partial");
  }
  assert.equal(result.summary.metrics.followers.value, 990);
  assert.equal(result.summary.metrics.followers.delta, 90);
  assert.equal(result.summary.metrics.likes.delta, -90);
  assert.equal(result.summary.metrics.posts.delta, 9);
  assert.equal(result.summary.metrics.estimatedPlays.delta, -9000);
  const reader = new ConsoleReader({ databasePath: database.filePath });
  try {
    const wire = await reader.overview({ reference: reference.toISOString(), period: "custom", startDate: "2026-09-12", endDate: "2026-09-13" });
    const point = wire.summary.trend.find(p => p.date === "2026-09-13");
    assert.equal(point.followersQuality, "partial"); assert.equal(point.followersComplete, false);
    assert.equal(point.likesDeltaQuality, "partial"); assert.equal(point.likesDeltaComplete, false);
    assert.equal(point.likesDelta, -90); assert.equal(point.likesDeltaReliable, true);
    assert.equal(point.estimatedPlaysReliable, true, "proxy curve retains the same availability flags as likes");
  } finally { await reader.close(); }
});
