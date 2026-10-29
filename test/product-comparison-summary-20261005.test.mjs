import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MonitorDatabase } from "../lib/database.mjs";
import { getAccountInsight, getProductInsights } from "../lib/product-insights.mjs";
import { buildMasterRosterSnapshot, installMasterRoster } from "../lib/master-roster.mjs";
import { checksum } from "../lib/utils.mjs";

const reference = new Date("2026-09-20T12:00:00Z");
const capturedAt = date => new Date(`${date}T12:00:00+08:00`).toISOString();

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "product-comparison-summary-"));
  const database = new MonitorDatabase(join(directory, "test.sqlite"));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  let sequence = 0;
  const accounts = [];
  const addAccount = ({ name, boardName, category, enabled = true }) => {
    const ordinal = ++sequence;
    const locator = `MS4wLjABAAABcompare${ordinal}abcdefghijklmnop`;
    const target = database.createTarget({ type: "account", label: name, locator,
      provider: "public-web", metadata: { platform: "douyin" } });
    database.db.prepare("UPDATE targets SET created_at=?,updated_at=? WHERE id=?")
      .run("2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z", target.id);
    database.assignTargetsToBoard([target.id], boardName);
    database.db.prepare("UPDATE target_boards SET created_at=?,category=? WHERE target_id=?")
      .run("2026-06-01T00:00:00.000Z", category, target.id);
    if (!enabled) database.db.prepare("UPDATE targets SET enabled=0 WHERE id=?").run(target.id);
    const result = { ...target, locator, name, boardName, category };
    accounts.push(result);
    return result;
  };
  const sample = (target, date, values) => {
    const time = capturedAt(date);
    const raw = { capturedAt: time, profile: { user: { sec_uid: target.locator, uid: "222523170759696",
      follower_count: values[0] ?? null, total_favorited: values[1] ?? null, aweme_count: values[2] ?? null } },
    works: { aweme_list: [] } };
    database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,
      quality_status,account_status,works_coverage,source_checksum,raw_json) VALUES(?,?,?,?,?,'validated','available','complete',?,?)`)
      .run(target.id, time, values[0] ?? null, values[1] ?? null, values[2] ?? null,
        checksum(raw), JSON.stringify(raw));
  };
  const pauseAt = (target, at) => {
    database.db.prepare("UPDATE targets SET enabled=0,updated_at=? WHERE id=?").run(at, target.id);
    database.db.prepare(`INSERT INTO activity_log(actor_name,action,resource_type,resource_id,created_at,details_json)
      VALUES('fixture','target.update','target',?,?,'{"enabled":false}')`).run(String(target.id), at);
  };
  const installClassifications = () => {
    const snapshot = buildMasterRosterSnapshot({ exportedAt: "2026-09-20T12:00:00.000Z", entities: accounts.map(account => ({
      key: `target:${account.id}`, targetId: account.id, platform: "douyin", enabled: true,
      currentName: account.name, names: [account.name], ids: [], locators: [account.locator],
      sources: [], boards: [{ name: account.boardName, category: account.category }],
      classification: { theme: account.boardName.includes("玉麒麟") ? { key: "yuqilin", label: "玉麒麟" } : { key: "tuantuan", label: "团团" }, labels: [
        { key: account.category === "切片" ? "slice" : "original", label: account.category },
      ] },
    })) }, { fileName: "MCN总表.xlsx", sha256: "c".repeat(64) });
    installMasterRoster(database.db, snapshot, { now: "2026-09-20T12:00:00.000Z" });
  };
  return { database, accounts, addAccount, sample, pauseAt, installClassifications };
}

const comparisonOptions = {
  period: "custom", timeZone: "Asia/Shanghai", reference,
  startDate: "2026-09-10", endDate: "2026-09-14",
  comparisonStartDate: "2026-09-01", comparisonEndDate: "2026-09-03",
  theme: "tuantuan", classification: "slice",
};

test("summary comparison projection preserves the full B range, header, and aggregate while skipping B-only directory work", (t) => {
  const { database, addAccount, sample, pauseAt, installClassifications } = fixture(t);
  const active = addAccount({ name: "切片持续采样", boardName: "一条小团团切片矩阵", category: "切片" });
  const pausedAfterB = addAccount({ name: "区间后暂停切片", boardName: "一条小团团切片矩阵", category: "切片" });
  const missingBEnd = addAccount({ name: "缺少B期末采样", boardName: "一条小团团切片矩阵", category: "切片" });
  const original = addAccount({ name: "其他主题原创作者", boardName: "玉麒麟原创矩阵", category: "原创" });

  for (const [target, rows] of [
    [active, [["2026-08-31", [50, 100, 2]], ["2026-09-03", [60, 0, 3]],
      ["2026-09-09", [60, 0, 3]], ["2026-09-14", [70, 10, 4]]]],
    [pausedAfterB, [["2026-08-31", [100, 100, 10]], ["2026-09-03", [0, null, 12]],
      ["2026-09-09", [0, null, 12]], ["2026-09-14", [10, 50, 14]]]],
    [missingBEnd, [["2026-08-31", [500, 500, 20]], ["2026-09-09", [550, 500, 21]],
      ["2026-09-14", [600, null, 22]]]],
    [original, [["2026-08-31", [10000, 20000, 1000]], ["2026-09-03", [11000, 21000, 1100]],
      ["2026-09-09", [12000, 22000, 1200]], ["2026-09-14", [13000, 23000, 1300]]]],
  ]) for (const [date, values] of rows) sample(target, date, values);
  // This author is enabled at B's end, but disabled by A's end.
  pauseAt(pausedAfterB, "2026-09-10T00:00:00.000Z");
  installClassifications();

  const full = getProductInsights(database, comparisonOptions);
  assert.ok(Array.isArray(full.comparison.accounts), "the default full comparison API retains account projections");
  assert.equal(full.comparison.summary.memberCount, 3, "B applies the selected theme/classification to its own historical cohort");
  assert.equal(full.summary.memberCount, 3);
  assert.equal(full.comparison.summary.enabledCount, 3, "the account paused after B remains enabled at B's end");
  assert.equal(full.summary.enabledCount, 2, "the same account is paused at A's end");
  assert.equal(full.comparison.summary.metrics.followers.value, 60, "a real zero contributes to observed count without changing the sum");
  assert.equal(full.comparison.summary.metrics.followers.observedCount, 2);
  assert.equal(full.comparison.summary.metrics.followers.delta, -90);
  assert.equal(full.comparison.summary.metrics.followers.comparableCount, 2, "the account without a B end observation is not treated as zero");
  assert.equal(full.comparison.summary.metrics.likes.value, 0, "a real zero remains an observed value");
  assert.equal(full.comparison.summary.metrics.likes.observedCount, 1);
  assert.equal(full.comparison.summary.metrics.likes.delta, -100);
  assert.equal(full.comparison.summary.metrics.likes.comparableCount, 1, "missing likes endpoints do not become zero deltas");
  assert.equal(full.summary.trend.length, 5, "A's longer period keeps its own daily timeline");
  assert.equal(full.comparison.summary.trend.length, 3, "B's shorter period keeps its own daily timeline");

  const originalListBoards = database.listBoards.bind(database);
  let listBoardsCalls = 0;
  database.listBoards = (...args) => { listBoardsCalls += 1; return originalListBoards(...args); };
  const projected = getProductInsights(database, { ...comparisonOptions, comparisonProjection: "summary" });

  assert.equal(listBoardsCalls, 1, "only the full A response reads/materializes its directory; B summary projection skips it");
  assert.deepEqual(projected.comparison.summary, full.comparison.summary);
  for (const key of ["range", "period", "start", "end", "referenceAt", "timeZone", "methodology"]) {
    assert.deepEqual(projected.comparison[key], full.comparison[key], `B header field ${key} stays identical`);
  }
  assert.equal(projected.comparison.projection, "comparison-summary");
  assert.equal(projected.comparison.comparison, null);
  for (const key of ["accounts", "boards", "selectedBoard", "classificationCatalog", "classificationSummary",
    "classificationSources", "themeSummary", "scopeBasis"]) {
    assert.equal(Object.hasOwn(projected.comparison, key), false, `B's unused ${key} projection is omitted`);
  }
  assert.equal(projected.accounts.length, 3, "the primary A response remains complete");
  assert.ok(Array.isArray(projected.boards));
  assert.ok(Array.isArray(projected.accounts[0].trend), "the primary A response retains compact account trend data");
});

test("default/invalid projection and account detail keep the existing full comparison contract", (t) => {
  const { database, addAccount, sample } = fixture(t);
  const target = addAccount({ name: "切片作者", boardName: "一条小团团切片矩阵", category: "切片" });
  for (const [date, values] of [["2026-08-31", [10, 100, 1]], ["2026-09-03", [20, 200, 2]],
    ["2026-09-09", [20, 200, 2]], ["2026-09-14", [30, 300, 3]]]) sample(target, date, values);
  const options = { ...comparisonOptions, theme: "all", classification: "all" };

  const defaultResult = getProductInsights(database, options);
  const invalidProjection = getProductInsights(database, { ...options, comparisonProjection: "accounts=false" });
  assert.ok(Array.isArray(defaultResult.comparison.accounts));
  assert.ok(Array.isArray(invalidProjection.comparison.accounts), "unrecognized projection values safely retain the full legacy shape");
  assert.deepEqual(invalidProjection.comparison.summary, defaultResult.comparison.summary);

  const detail = getAccountInsight(database, target.id, { ...options, comparisonProjection: "summary" });
  assert.equal(detail.account.id, target.id);
  assert.equal(detail.comparison.account.id, target.id);
  assert.ok(Array.isArray(detail.comparison.account.trend), "summary projection does not alter account-detail comparison behavior");
});
