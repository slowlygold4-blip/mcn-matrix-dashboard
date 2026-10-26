import assert from "node:assert/strict";
import test from "node:test";
import { MonitorDatabase } from "../lib/database.mjs";
import { getProductInsights } from "../lib/product-insights.mjs";
import { checksum } from "../lib/utils.mjs";

const reference = new Date("2026-09-28T14:49:00.000Z");
const options = { period: "custom", startDate: "2026-09-22", endDate: "2026-09-28", reference, timeZone: "Asia/Shanghai" };
const priorAt = "2026-09-21T06:00:00.000Z";
const currentAt = "2026-09-28T10:00:00.000Z";

function fixture(t) {
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  let n = 0;
  const add = (label, boards = [], { platform = "douyin", enabled = true, type = "account" } = {}) => {
    const target = database.createTarget({ type, label, provider: "public-web", enabled,
      locator: platform === "bilibili" ? String(900000 + ++n) : `MS4wLjABAAAAmetricContributionFixture${++n}`,
      metadata: { platform } });
    database.db.prepare("UPDATE targets SET created_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", target.id);
    for (const board of boards) database.assignTargetsToBoard([target.id], board);
    if (boards.length) database.db.prepare("UPDATE target_boards SET created_at=? WHERE target_id=?")
      .run("2020-01-01T00:00:00.000Z", target.id);
    return target;
  };
  const sample = (target, capturedAt, likes, { quality = "validated", views = null } = {}) => {
    const raw = { capturedAt, profile: { user: { uid: String(target.id), sec_uid: target.locator,
      follower_count: 10, total_favorited: likes, aweme_count: 1 } },
    provenance: { mode: "isolated-metric-regression-fixture", runtimeAI: false, paidAPI: false } };
    database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,hashtag_views,
      quality_status,account_status,works_coverage,source_checksum,raw_json)
      VALUES(?,?,10,?,1,?,?,'available','unavailable',?,?)`).run(target.id, capturedAt, likes, views, quality, checksum(raw), JSON.stringify(raw));
  };
  return { database, add, sample };
}

test("large proxy is same-account net likes times 100, never cumulative likes or sum of overlapping boards", t => {
  const { database, add, sample } = fixture(t);
  const accounts = [
    [add("主播合成样本", ["抖音主播板块"]), 4_000_000_000, 31_461_454],
    [add("跨板块团团样本", ["一条小团团切片矩阵", "抖音主播板块"]), 1_000_000, 220_162],
    [add("团团单板块样本", ["一条小团团切片矩阵"]), 1_000_000, 108_297],
    [add("未分类负变化样本"), 1_000_000, -347_277],
    [add("B站老飞宇样本", ["老飞宇切片矩阵"], { platform: "bilibili" }), 1_000_000, 34_254],
    [add("玉麒麟样本", ["玉麒麟切片矩阵"]), 1_000_000, 107],
  ];
  for (const [target, baseline, delta] of accounts) {
    sample(target, priorAt, baseline);
    sample(target, currentAt, baseline + delta);
  }
  const before = database.db.prepare("SELECT total_changes() n").get().n;
  const result = getProductInsights(database, options);
  assert.equal(result.summary.metrics.likes.delta, 31_476_997);
  assert.equal(result.summary.metrics.estimatedPlays.delta, 3_147_699_700);
  assert.notEqual(result.summary.metrics.estimatedPlays.delta, result.summary.metrics.estimatedPlays.value);
  assert.equal(result.accounts.reduce((n, a) => n + a.metrics.likes.delta, 0), result.summary.metrics.likes.delta);
  assert.equal(new Set(result.accounts.map(a => a.id)).size, 6);
  const boardSum = result.boards.reduce((n, b) => n + (b.metrics.likes.delta ?? 0), 0);
  assert.equal(boardSum, 31_697_159);
  assert.equal(boardSum - result.summary.metrics.likes.delta, 220_162);
  assert.equal(result.boards.find(b => b.name === "抖音主播板块").metrics.likes.delta, 31_681_616);
  assert.equal(result.boards.find(b => b.name === "一条小团团切片矩阵").metrics.likes.delta, 328_459);
  assert.equal(result.summary.metrics.estimatedPlays.proxy, true);
  assert.equal(result.summary.metrics.estimatedPlays.multiplier, 100);
  assert.equal(database.db.prepare("SELECT total_changes() n").get().n, before);
});

test("mutually exclusive primary themes reconcile to all enabled accounts while board membership is not exclusive", t => {
  const { database, add, sample } = fixture(t);
  const shared = add("团团两板块", ["一条小团团切片矩阵", "抖音主播板块"]);
  const streamer = add("纯主播", ["抖音主播板块"]);
  const unassigned = add("未知归属");
  for (const [target, delta] of [[shared, 20], [streamer, 1000], [unassigned, -3]]) {
    sample(target, priorAt, 100);
    sample(target, currentAt, 100 + delta);
  }
  const all = getProductInsights(database, options);
  const themes = new Map();
  for (const a of all.accounts.filter(a => a.enabled)) themes.set(a.classification.theme.key,
    (themes.get(a.classification.theme.key) ?? 0) + a.metrics.likes.delta);
  assert.deepEqual(Object.fromEntries(themes), { tuantuan: 20, "douyin-streamers": 1000, unassigned: -3 });
  assert.equal([...themes.values()].reduce((a, b) => a + b, 0), 1017);
  assert.equal(getProductInsights(database, { ...options, theme: "tuantuan" }).summary.metrics.likes.delta, 20);
  assert.equal(getProductInsights(database, { ...options, board: "抖音主播板块" }).summary.metrics.likes.delta, 1020);
});

test("period net may use true endpoints despite a missing interior day, but daily changes do not fill that day", t => {
  const { database, add, sample } = fixture(t);
  const account = add("缺日样本");
  sample(account, priorAt, 100);
  for (let day = 22; day <= 26; day++) sample(account, `2026-09-${day}T10:00:00.000Z`, 100 + day - 21);
  sample(account, currentAt, 120);
  const result = getProductInsights(database, options);
  assert.equal(result.summary.metrics.likes.delta, 20);
  assert.equal(result.summary.metrics.likes.comparableCount, 1);
  assert.equal(result.summary.trend.find(p => p.date === "2026-09-27").likesDelta, null);
  assert.equal(result.summary.trend.find(p => p.date === "2026-09-28").likesDelta, null);
  assert.equal(result.summary.trend.reduce((n, p) => n + (p.likesDelta ?? 0), 0), 5);
  assert.notEqual(result.summary.metrics.likes.delta, 5, "do not silently drop cross-gap endpoint change");
});

test("missing preceding-day baseline, carried current and future/rejected samples cannot create period growth", t => {
  const { database, add, sample } = fixture(t);
  const noBaseline = add("区间内首采");
  sample(noBaseline, "2026-09-22T10:00:00.000Z", 50);
  sample(noBaseline, currentAt, 100);
  const carried = add("结束日缺测");
  sample(carried, priorAt, 10);
  sample(carried, "2026-09-27T10:00:00.000Z", 30);
  const good = add("真实可比");
  sample(good, priorAt, 100);
  sample(good, currentAt, 120);
  sample(good, "2026-09-28T11:00:00.000Z", 1_000_000, { quality: "rejected" });
  sample(good, "2026-09-29T10:00:00.000Z", 9_000_000);
  const result = getProductInsights(database, options);
  assert.equal(result.summary.metrics.likes.delta, 20);
  assert.equal(result.summary.metrics.likes.comparableCount, 1);
  assert.equal(result.summary.metrics.likes.comparisonMissingCount, 2);
  assert.equal(result.accounts.find(a => a.id === noBaseline.id).metrics.likes.delta, null);
  assert.equal(result.accounts.find(a => a.id === carried.id).metrics.likes.delta, null);
  assert.equal(result.accounts.find(a => a.id === good.id).metrics.likes.value, 120);
});

test("paused accounts and topic actual views stay outside account proxy totals; negative likes are retained", t => {
  const { database, add, sample } = fixture(t);
  const active = add("有效负变化");
  const paused = add("暂停", [], { enabled: false });
  const topic = add("话题实际播放", [], { type: "hashtag" });
  sample(active, priorAt, 1000); sample(active, currentAt, 900);
  sample(paused, priorAt, 1); sample(paused, currentAt, 100_000_000);
  sample(topic, priorAt, null, { views: 5_000_000_000 }); sample(topic, currentAt, null, { views: 9_000_000_000 });
  const result = getProductInsights(database, options);
  assert.equal(result.summary.enabledCount, 1);
  assert.equal(result.summary.pausedCount, 1);
  assert.equal(result.summary.metrics.likes.delta, -100);
  assert.equal(result.summary.metrics.estimatedPlays.delta, -10_000);
  assert.equal(result.accounts.some(a => a.id === topic.id), false);
});

test("natural week is not rolling seven days on a Monday; custom UI dates define the latter", t => {
  const { database, add, sample } = fixture(t);
  const account = add("周期样本");
  sample(account, priorAt, 100);
  sample(account, "2026-09-27T10:00:00.000Z", 150);
  sample(account, currentAt, 170);
  const week = getProductInsights(database, { period: "week", reference, timeZone: "Asia/Shanghai" });
  const rolling = getProductInsights(database, options);
  assert.equal(week.range.startDate, "2026-09-28");
  assert.equal(week.summary.metrics.likes.delta, 20);
  assert.equal(rolling.range.startDate, "2026-09-22");
  assert.equal(rolling.summary.metrics.likes.delta, 70);
});
