import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MonitorDatabase } from "../lib/database.mjs";
import { getProductInsights } from "../lib/product-insights.mjs";
import { buildMasterRosterSnapshot, installMasterRoster } from "../lib/master-roster.mjs";
import { checksum } from "../lib/utils.mjs";

const options = { period: "day", timeZone: "Asia/Shanghai", reference: new Date("2026-09-21T12:00:00Z") };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "product-theme-audit-"));
  const database = new MonitorDatabase(join(directory, "test.sqlite"));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  let ordinal = 0;
  const add = ({ label = `测试作者${++ordinal}`, metadata = {}, boards = [], category = "", enabled = true, base = 100 } = {}) => {
    const target = database.createTarget({ type: "account", label, locator: `MS4wLjABAAAAtheme${++ordinal}abcdefghijklmnop`,
      provider: "public-web", metadata: { platform: "douyin", ...metadata } });
    database.db.prepare("UPDATE targets SET created_at=? WHERE id=?").run("2026-06-01T00:00:00.000Z", target.id);
    if (!enabled) database.db.prepare("UPDATE targets SET enabled=0,updated_at=? WHERE id=?")
      .run("2026-06-01T00:00:00.000Z", target.id);
    for (const board of boards) database.assignTargetsToBoard([target.id], board);
    if (boards.length) database.db.prepare("UPDATE target_boards SET created_at=? WHERE target_id=?")
      .run("2026-06-01T00:00:00.000Z", target.id);
    if (category) database.db.prepare("UPDATE target_boards SET category=? WHERE target_id=?").run(category, target.id);
    for (const [date, value] of [["2026-09-20", base], ["2026-09-21", base + 10]]) {
      const capturedAt = `${date}T02:00:00.000Z`;
      const raw = { capturedAt, profile: { user: { sec_uid: target.locator, uid: "222523170759696",
        follower_count: value, total_favorited: value * 10, aweme_count: value / 10 } }, works: { aweme_list: [] } };
      database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,
        quality_status,account_status,works_coverage,source_checksum,raw_json) VALUES(?,?,?,?,?,'validated','available','complete',?,?)`)
        .run(target.id, capturedAt, value, value * 10, value / 10, checksum(raw), JSON.stringify(raw));
    }
    return target;
  };
  const read = (extra = {}) => getProductInsights(database, { ...options, ...extra });
  return { database, add, read };
}

test("theme filter combines confirmed Tuantuan boards and supplemental source lists", (t) => {
  const { database, add, read } = fixture(t);
  const boardMember = add({ boards: ["一条小团团切片矩阵"], category: "原创" });
  const listMember = add({ metadata: { importSource: { fileName: "团团后续补充账号名单.xlsx" } }, base: 200 });
  add({ boards: ["玉麒麟切片矩阵"], base: 500 });
  add({ label: "团团的昵称不能证明归属", base: 900 });
  const before = database.db.prepare("SELECT total_changes() AS count").get().count;
  const result = read({ theme: "tuantuan" });
  assert.deepEqual(result.accounts.map((a) => a.id).sort((a, b) => a - b), [boardMember.id, listMember.id]);
  assert.equal(result.summary.memberCount, 2);
  assert.equal(result.summary.metrics.followers.value, 320);
  assert.equal(result.summary.metrics.followers.delta, 20);
  assert.equal(result.summary.metrics.likes.delta, 200);
  assert.equal(result.summary.metrics.posts.delta, 2);
  assert.equal(result.summary.metrics.estimatedPlays.delta, 20_000);
  assert.equal(result.themeSummary.items.find((item) => item.key === "tuantuan").count, 2);
  assert.equal(result.classificationSummary.total, 2);
  assert.equal(database.db.prepare("SELECT total_changes() AS count").get().count, before);
});

test("latest imported roster supplies verified theme and explicit labels to operating filters without changing metric rows", (t) => {
  const { database, add, read } = fixture(t);
  const target = add({ base: 250 });
  const before = read();
  const snapshot = buildMasterRosterSnapshot({ exportedAt: "2026-10-02T19:01:23.853Z", entities: [{
    key: `target:${target.id}`, targetId: target.id, platform: "douyin", enabled: true,
    currentName: target.label, names: [target.label], ids: ["000123"], locators: [target.locator],
    sources: [{ url: "", title: "团团总表", file: "MCN总表.xlsx", sheet: "账号合并总表", rows: ["2"] }], boards: [],
    classification: { theme: { key: "tuantuan", label: "团团" }, labels: [
      { key: "original", label: "原创" }, { key: "remix", label: "二创" },
      { key: "custom:抖音主播", label: "抖音主播" }, { key: "custom:超头部", label: "超头部" },
      { key: "custom:未细分", label: "未细分" }, { key: "custom:未来可能ai", label: "未来可能AI" },
    ] },
  }] }, { fileName: "MCN总表.xlsx", sha256: "a".repeat(64) });
  installMasterRoster(database.db, snapshot);

  const writesBeforeRead = database.db.prepare("SELECT total_changes() count").get().count;
  const filtered = read({ theme: "tuantuan", classification: "original" });
  assert.deepEqual(filtered.accounts.map(account => account.id), [target.id]);
  assert.equal(filtered.accounts[0].classification.theme.confirmed, true);
  assert.equal(filtered.accounts[0].classification.theme.mode, "master-roster-source");
  assert.deepEqual(filtered.accounts[0].classification.labels.slice(0, 2).map(label => label.key), ["slice", "original"]);
  assert.ok(filtered.accounts[0].classification.labels.some(label => label.key === "remix"));
  assert.ok(!filtered.accounts[0].classification.labels.some(label => ["抖音主播", "超头部", "未细分", "未来可能AI"].includes(label.label)));
  assert.equal(filtered.accounts[0].classification.labels[0].sourceConfirmed, true);
  assert.equal(filtered.summary.metrics.followers.value, before.summary.metrics.followers.value);
  assert.equal(filtered.summary.metrics.likes.value, before.summary.metrics.likes.value);
  assert.equal(filtered.summary.metrics.posts.value, before.summary.metrics.posts.value);
  assert.equal(database.db.prepare("SELECT COUNT(*) n FROM snapshots").get().n, 2,
    "reading the roster must not create, backfill, or alter metric observations");
  assert.equal(database.db.prepare("SELECT total_changes() count").get().count, writesBeforeRead,
    "the live classification projection is strictly read-only");
});

test("roster classifications are not applied after a saved locator no longer matches the target", (t) => {
  const { database, add, read } = fixture(t);
  const target = add();
  installMasterRoster(database.db, buildMasterRosterSnapshot({ exportedAt: "2026-10-02T19:01:23.853Z", entities: [{
    key: `target:${target.id}`, targetId: target.id, platform: "douyin", enabled: true,
    currentName: target.label, names: [target.label], ids: ["000123"], locators: [target.locator],
    sources: [], boards: [], classification: { theme: { key: "tuantuan", label: "团团" }, labels: [{ key: "slice", label: "切片" }] },
  }] }, { fileName: "MCN总表.xlsx", sha256: "b".repeat(64) }));
  database.db.prepare("UPDATE targets SET locator=? WHERE id=?").run(`${target.locator}-changed`, target.id);
  const result = read({ theme: "tuantuan" });
  assert.deepEqual(result.accounts, []);
  assert.equal(read().accounts[0].classification.theme.key, "unassigned");
});

test("multiple same-theme memberships never double count an account or its metrics", (t) => {
  const { add, read } = fixture(t);
  const target = add({ boards: ["一条小团团切片矩阵", "团团AI二创计划", "抖音主播板块"],
    metadata: { importSource: { fileName: "团团账号名单.xlsx" } } });
  const result = read({ theme: "tuantuan" });
  assert.deepEqual(result.accounts.map((account) => account.id), [target.id]);
  assert.equal(result.themeSummary.total, 1);
  assert.equal(result.themeSummary.items.find((item) => item.key === "tuantuan").count, 1);
  assert.equal(result.themeSummary.items.filter((item) => item.key !== "all").reduce((sum, item) => sum + item.count, 0), 1);
  assert.equal(result.summary.metrics.followers.value, 110);
  assert.equal(result.summary.metrics.followers.delta, 10);
  assert.equal(result.summary.trend.find((point) => point.date === "2026-09-21").followersDelta, 10);
  assert.ok(!result.accounts[0].boards.some((board) => board.name === "抖音主播板块"),
    "the generic intake board must not compete with an explicit Tuantuan slice matrix in the operating view");
  assert.equal(result.boards.find((board) => board.name === "抖音主播板块")?.memberCount, 0);
});

test("theme, board and secondary content filters intersect without changing theme directory counts", (t) => {
  const { add, read } = fixture(t);
  const original = add({ boards: ["一条小团团切片矩阵"], category: "原创" });
  add({ boards: ["一条小团团切片矩阵"], category: "AI二创" });
  add({ metadata: { importSource: { fileName: "团团增量名单.xlsx" } } });
  add({ boards: ["玉麒麟切片矩阵"], category: "原创" });
  const result = read({ theme: "tuantuan", board: "一条小团团切片矩阵", classification: "original" });
  assert.deepEqual(result.accounts.map((account) => account.id), [original.id]);
  assert.equal(result.summary.memberCount, 1);
  assert.equal(result.classificationSummary.total, 2, "secondary facets summarize the selected theme before the content filter");
  assert.equal(result.themeSummary.total, 2, "theme directory respects the explicitly selected board");
  assert.equal(result.selectedBoard.memberCount, 1);
  assert.equal(result.selectedBoard.metrics.followers.value, 110);
});

test("paused theme members stay in the directory but do not inflate metric totals", (t) => {
  const { add, read } = fixture(t);
  add({ boards: ["一条小团团切片矩阵"] });
  const paused = add({ boards: ["团团AI二创计划"], enabled: false, base: 10_000 });
  const result = read({ theme: "tuantuan" });
  assert.equal(result.accounts.length, 2);
  assert.equal(result.accounts.find((account) => account.id === paused.id).enabled, false);
  assert.equal(result.themeSummary.items.find((item) => item.key === "tuantuan").count, 2);
  assert.equal(result.summary.enabledCount, 1);
  assert.equal(result.summary.pausedCount, 1);
  assert.equal(result.summary.metrics.followers.value, 110);
});

test("theme selection is retained in date comparisons and unknown themes cannot leak accounts", (t) => {
  const { add, read } = fixture(t);
  const tuantuan = add({ boards: ["一条小团团切片矩阵"] });
  add({ boards: ["玉麒麟切片矩阵"], base: 900 });
  const result = read({ theme: "tuantuan", comparisonStartDate: "2026-09-20", comparisonEndDate: "2026-09-20" });
  assert.equal(result.comparison.theme, "tuantuan");
  assert.deepEqual(result.comparison.accounts.map((account) => account.id), [tuantuan.id]);
  assert.equal(result.comparison.summary.metrics.followers.value, 100);
  assert.equal(read({ theme: "not-a-known-theme" }).accounts.length, 0);
});

test("mixed-IP source filename alone must not confirm Tuantuan ownership", (t) => {
  const { add, read } = fixture(t);
  const mixed = add({ metadata: { importSource: { fileName: "团团+玉麒麟账号汇总.xlsx" } } });
  assert.equal(read({ theme: "tuantuan" }).accounts.length, 0);
  const account = read().accounts.find((item) => item.id === mixed.id);
  assert.equal(account.classification.theme.confirmed, false);
  assert.equal(account.classification.theme.key, "unassigned");
  assert.ok(account.classification.theme.evidence.some((item) => item.value === "团团+玉麒麟账号汇总.xlsx"), "ambiguous raw evidence must remain inspectable");
});

test("explicit row board disambiguates a mixed-IP workbook without being overridden by keyword order", (t) => {
  const { add, read } = fixture(t);
  const target = add({ boards: ["玉麒麟切片矩阵"], metadata: { importSource: { fileName: "团团+玉麒麟账号汇总.xlsx" } } });
  assert.equal(read({ theme: "tuantuan" }).accounts.length, 0);
  const result = read({ theme: "yuqilin" });
  assert.deepEqual(result.accounts.map((account) => account.id), [target.id]);
  assert.equal(result.summary.metrics.followers.value, 110);
});

test("specific worksheet disambiguates a mixed-IP workbook when no row board exists", (t) => {
  const { add, read } = fixture(t);
  const target = add({ metadata: { importSource: { fileName: "团团+玉麒麟账号汇总.xlsx", sheetName: "玉麒麟作者名单" } } });
  assert.equal(read({ theme: "tuantuan" }).accounts.length, 0);
  assert.deepEqual(read({ theme: "yuqilin" }).accounts.map((account) => account.id), [target.id]);
});

test("different explicit IP memberships must not silently become the first theme in the rule list", (t) => {
  const { add, read } = fixture(t);
  const target = add({ boards: ["一条小团团切片矩阵", "玉麒麟切片矩阵"] });
  const account = read().accounts.find((item) => item.id === target.id);
  assert.equal(account.classification.theme.confirmed, false);
  assert.equal(account.classification.theme.key, "unassigned");
  assert.equal(read({ theme: "tuantuan" }).accounts.length, 0);
  assert.equal(read({ theme: "yuqilin" }).accounts.length, 0);
});

test("board counts returned with a theme filter describe the same filtered population as board metrics", (t) => {
  const { add, read } = fixture(t);
  add({ boards: ["共享登记板块", "一条小团团切片矩阵"] });
  add({ boards: ["共享登记板块", "玉麒麟切片矩阵"] });
  const result = read({ theme: "tuantuan" });
  const shared = result.boards.find((board) => board.name === "共享登记板块");
  assert.equal(shared.memberCount, 1);
  assert.equal(shared.enabledCount, 1);
  assert.equal(shared.targetCount, 1);
  assert.equal(shared.metrics.followers.value, 110);
});
