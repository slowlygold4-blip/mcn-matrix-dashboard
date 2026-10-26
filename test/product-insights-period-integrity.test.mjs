import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { MonitorDatabase } from "../lib/database.mjs";
import { getProductInsights, getAccountInsight } from "../lib/product-insights.mjs";
import { checksum } from "../lib/utils.mjs";

const reference = new Date("2026-09-26T07:00:00Z");
const timeZone = "Asia/Shanghai";
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "period-integrity-"));
  const database = new MonitorDatabase(join(directory, "test.sqlite"));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const account = (label, enabled = true) => {
    const target = database.createTarget({ type: "account", label, locator: `MS4wLjABAAAA${label}abcdefghijklmnop`, provider: "public-web", metadata: { platform: "douyin" } });
    database.db.prepare("UPDATE targets SET created_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", target.id);
    if (!enabled) database.db.prepare("UPDATE targets SET enabled=0, updated_at='2026-09-26T06:00:00.000Z' WHERE id=?").run(target.id);
    return target;
  };
  const insert = (target, capturedAt, values, quality = "validated") => {
    const normalizedAt = new Date(capturedAt).toISOString();
    const raw = { capturedAt: normalizedAt, profile: { user: { sec_uid: target.locator, uid: "222523170759696",
      follower_count: values[0] ?? null, total_favorited: values[1] ?? null, aweme_count: values[2] ?? null } },
      works: { aweme_list: [] } };
    return database.db.prepare(`INSERT INTO snapshots
      (target_id,captured_at,followers,total_likes,total_posts,quality_status,account_status,works_coverage,source_checksum,raw_json)
      VALUES(?,?,?,?,?,?,'available','complete',?,?)`).run(target.id, capturedAt, ...values, quality, checksum(raw), JSON.stringify(raw));
  };
  const sample = (target, date, values, quality = "validated") => insert(target, `${date}T02:00:00.000Z`, values, quality);
  const insights = (options = {}) => getProductInsights(database, { period: "day", reference, timeZone, ...options });
  const detail = (target, period = "day", options = {}) => getAccountInsight(database, target.id, { period, reference, timeZone, ...options }).account;
  return { database, databasePath: join(directory, "test.sqlite"), account, insert, sample, insights, detail };
}

test("month without August 31 baseline cannot manufacture monthly growth from September observations", (t) => {
  const { account, sample, insights, detail } = fixture(t);
  const target = account("month-late-start");
  sample(target, "2026-09-12", [100, 1000, 10]); sample(target, "2026-09-26", [120, 900, 12]);
  const result = insights({ period: "month" });
  const metric = detail(target, "month").metrics.followers;
  assert.equal(metric.delta, null); assert.equal(metric.comparable, false); assert.equal(metric.fullPeriodComparable, false);
  assert.equal(metric.observedWindow.delta, 20); assert.equal(metric.observedWindow.comparisonLabel, "已观察时段变化");
  assert.equal(metric.observedWindow.startAt, "2026-09-12T02:00:00.000Z");
  assert.equal(result.summary.metrics.followers.delta, null); assert.equal(result.summary.metrics.followers.comparableCount, 0);
  assert.equal(result.summary.metrics.followers.fullPeriodComparableCount, 0);
  assert.equal(detail(target, "month").metrics.estimatedPlays.observedWindow.delta, -10000);
  assert.equal(result.accounts[0].metrics.followers.observedWindow.delta, 20, "list preserves explicit observed-window provenance");
});

test("day and week do not accept older nonadjacent baselines or missing ending day", (t) => {
  const { account, sample, insights, detail } = fixture(t);
  const target = account("nonadjacent");
  sample(target, "2026-09-19", [100, 100, 1]); sample(target, "2026-09-24", [120, 120, 2]);
  sample(target, "2026-09-26", [150, 150, 3]);
  for (const period of ["day", "week"]) {
    const metric = detail(target, period).metrics.followers;
    assert.equal(metric.delta, null, period); assert.equal(metric.comparable, false, period);
    assert.ok(metric.observedWindow.delta > 0); assert.equal(insights({ period }).summary.metrics.followers.delta, null);
  }
  const absentEnd = account("missing-ending-day");
  sample(absentEnd, "2026-09-20", [100, 100, 1]); sample(absentEnd, "2026-09-25", [110, 110, 2]);
  assert.equal(detail(absentEnd, "week").metrics.followers.delta, null);
  assert.equal(detail(absentEnd, "week").metrics.followers.observedOnEndDate, false);
});

test("known and end-day aggregates are period-independent without counting carried values as new observations", (t) => {
  const { account, sample, insights } = fixture(t);
  const current = account("current"); const yesterday = account("yesterday"); const earlier = account("earlier"); const paused = account("paused", false);
  sample(current, "2026-09-26", [100, 1000, 10]); sample(yesterday, "2026-09-25", [200, 2000, 20]);
  sample(earlier, "2026-09-12", [300, 3000, 30]); sample(paused, "2026-09-26", [900, 9000, 90]);
  for (const period of ["day", "week", "month"]) {
    const metric = insights({ period }).summary.metrics.followers;
    assert.equal(metric.value, 100, period); assert.equal(metric.observedCount, 1, period);
    assert.equal(metric.knownValue, 600, period); assert.equal(metric.knownCount, 3, period); assert.equal(metric.carriedCount, 2, period);
    assert.equal(metric.endObservedCount, 1, period); assert.equal(metric.terminalRetainedCount, 0, period);
    assert.equal(insights({ period }).summary.metrics.estimatedPlays.knownValue, 600000);
  }
});

test("strict endpoint changes preserve real zero, negative deltas and exact per-metric cohorts", (t) => {
  const { database, account, sample, insights, detail } = fixture(t);
  const full = account("full"); const partial = account("partial");
  sample(full, "2026-08-31", [100, 100, 10]); sample(full, "2026-09-26", [0, 80, 9]);
  sample(partial, "2026-08-31", [200, null, 20]); sample(partial, "2026-09-26", [210, 200, null]);
  const before = database.db.prepare("SELECT * FROM snapshots ORDER BY id").all();
  const changes = database.db.prepare("SELECT total_changes() n").get().n;
  const result = insights({ period: "month" });
  assert.equal(result.summary.metrics.followers.delta, -90); assert.equal(result.summary.metrics.followers.comparableCount, 2);
  assert.equal(result.summary.metrics.likes.delta, -20); assert.equal(result.summary.metrics.likes.comparableCount, 1);
  assert.equal(result.summary.metrics.posts.delta, -1); assert.equal(result.summary.metrics.posts.comparableCount, 1);
  assert.equal(result.summary.metrics.estimatedPlays.delta, -2000);
  assert.equal(detail(full, "month").metrics.followers.fullPeriodComparable, true);
  assert.equal(detail(full, "month").metrics.followers.observedWindow, null);
  assert.deepEqual(database.db.prepare("SELECT * FROM snapshots ORDER BY id").all(), before);
  assert.equal(database.db.prepare("SELECT total_changes() n").get().n, changes);
});

test("comparison range applies its own endpoints and never borrows future samples", (t) => {
  const { account, sample, insights } = fixture(t); const target = account("comparison");
  sample(target, "2026-09-20", [100, 100, 1]); sample(target, "2026-09-23", [110, 110, 2]); sample(target, "2026-09-26", [140, 140, 3]);
  const result = insights({ period: "custom", startDate: "2026-09-21", endDate: "2026-09-26", comparisonStartDate: "2026-09-21", comparisonEndDate: "2026-09-24" });
  assert.equal(result.summary.metrics.followers.delta, 40); assert.equal(result.comparison.summary.metrics.followers.delta, null);
  assert.equal(result.comparison.summary.metrics.followers.value, null); assert.equal(result.comparison.summary.metrics.followers.knownValue, 110);
  assert.equal(result.comparison.accounts[0].metrics.followers.currentAt, "2026-09-23T02:00:00.000Z");
});

test("Beijing day endpoints use adjacent business dates across UTC midnight and reject invalid quality", (t) => {
  const { database, account, insert, insights } = fixture(t); const target = account("utc-crossing");
  insert(target, "2026-09-24T16:01:00Z", [100, 0, 1], "validated");
  insert(target, "2026-09-25T16:01:00Z", [110, 10, 2], "validated");
  insert(target, "2026-09-26T01:00:00Z", [999, 999, 9], "rejected");
  assert.equal(insights().summary.metrics.followers.delta, 10);
  assert.equal(insights().summary.metrics.likes.percent, null);
  assert.equal(insights().summary.metrics.likes.delta, 10);
});

for (const [name, corrupt] of [
  ["checksum mismatch", (database, snapshotId) => {
    database.db.prepare("UPDATE snapshots SET source_checksum='not-the-source-checksum' WHERE id=?").run(snapshotId);
  }],
  ["identity mismatch with a matching checksum", (database, snapshotId) => {
    const row = database.db.prepare("SELECT raw_json FROM snapshots WHERE id=?").get(snapshotId);
    const raw = JSON.parse(row.raw_json);
    raw.profile.user.sec_uid = "MS4wLjABAAAAforeignidentityabcdefghijklmnop";
    database.db.prepare("UPDATE snapshots SET source_checksum=?,raw_json=? WHERE id=?")
      .run(checksum(raw), JSON.stringify(raw), snapshotId);
  }],
  ["stored metric vector mismatch with a matching checksum", (database, snapshotId) => {
    const row = database.db.prepare("SELECT raw_json FROM snapshots WHERE id=?").get(snapshotId);
    const raw = JSON.parse(row.raw_json);
    raw.profile.user.follower_count = 999_999;
    database.db.prepare("UPDATE snapshots SET source_checksum=?,raw_json=? WHERE id=?")
      .run(checksum(raw), JSON.stringify(raw), snapshotId);
  }],
]) test(`main account insights exclude snapshots with ${name} from values, deltas and coverage`, (t) => {
  const { database, account, sample, insights } = fixture(t);
  const target = account(`bad-source-${name.replaceAll(" ", "-")}`);
  const baselineId = Number(sample(target, "2026-09-25", [100, 1_000, 10]).lastInsertRowid);
  const currentId = Number(sample(target, "2026-09-26", [120, 1_200, 12]).lastInsertRowid);
  corrupt(database, currentId);

  const result = insights({ period: "day" });
  const metric = result.summary.metrics.followers;
  assert.equal(metric.value, null);
  assert.equal(metric.observedCount, 0);
  assert.equal(metric.delta, null);
  assert.equal(metric.comparableCount, 0);
  assert.equal(metric.coveragePercent, 0);
  assert.equal(metric.valueQuality.status, "missing");
  assert.equal(metric.deltaQuality.status, "missing");
  assert.equal(result.summary.metrics.estimatedPlays.delta, null);

  const point = result.summary.trend.find(item => item.date === "2026-09-26");
  assert.equal(point.followers, null);
  assert.equal(point.followersDelta, null);
  assert.equal(point.followersObservedCount, 0);
  assert.equal(point.followersComparableCount, 0);
  assert.equal(point.followersQuality, "missing");
  assert.equal(point.estimatedPlaysDelta, null);

  const accountRow = result.accounts.find(item => item.id === target.id);
  assert.equal(accountRow.metrics.followers.value, 100, "only the earlier trusted observation remains as the last-known value");
  assert.equal(accountRow.metrics.followers.currentAt, "2026-09-25T02:00:00.000Z");
  assert.equal(accountRow.metrics.followers.delta, null);
  assert.equal(accountRow.status.sourceExcludedCount, 1);
  assert.equal(database.db.prepare("SELECT 1 FROM snapshots WHERE id=?").get(baselineId) !== undefined, true);
});

test("30d means exactly 30 inclusive business calendar days with previous-day baseline", (t) => {
  const { account, sample, insights } = fixture(t); const target = account("calendar-30d");
  sample(target, "2026-08-27", [100, 100, 1]); sample(target, "2026-09-26", [160, 160, 2]);
  const result = insights({ period: "30d" });
  assert.equal(result.period, "30d"); assert.equal(result.range.startDate, "2026-08-28");
  assert.equal(result.range.endDate, "2026-09-26"); assert.equal(result.summary.trend.length, 30);
  assert.equal(result.start, "2026-08-27T16:00:00.000Z"); assert.equal(result.summary.metrics.followers.delta, 60);
});

test("same aggregate cohort counts cannot hide different account identities across comparisons", (t) => {
  const { account, sample, insights } = fixture(t); const first = account("first-cohort"); const second = account("second-cohort");
  sample(first, "2026-09-22", [100, 100, 1]); sample(first, "2026-09-23", [110, 110, 2]);
  sample(second, "2026-09-25", [100, 100, 1]); sample(second, "2026-09-26", [110, 110, 2]);
  const result = insights({ comparisonStartDate: "2026-09-23", comparisonEndDate: "2026-09-23" });
  const current = result.summary.metrics.followers; const previous = result.comparison.summary.metrics.followers;
  assert.equal(current.delta, previous.delta); assert.equal(current.comparableCount, previous.comparableCount);
  assert.notEqual(current.deltaCohortKey, previous.deltaCohortKey); assert.notEqual(current.valueCohortKey, previous.valueCohortKey);
});

test("worker preserves strict and observed-window contracts and rolls back failed read transactions", async (t) => {
  const { databasePath, account, sample } = fixture(t); const target = account("worker-window");
  sample(target, "2026-09-12", [100, 100, 1]); sample(target, "2026-09-26", [120, 120, 2]);
  const worker = new Worker(new URL("../lib/console-reader-worker.mjs", import.meta.url), { workerData: { databasePath } });
  let sequence = 0;
  const request = (kind, options) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { cleanup(); reject(new Error("worker timeout")); }, 10000);
    const cleanup = () => { clearTimeout(timeout); worker.off("message", receive); worker.off("error", fail); };
    const receive = (value) => { if (value.id === id) { cleanup(); resolve(value); } };
    const fail = (error) => { cleanup(); reject(error); };
    worker.on("message", receive); worker.on("error", fail);
    worker.postMessage({ id, kind, targetId: target.id, options: { reference: reference.toISOString(), timeZone, ...options } });
  });
  try {
    assert.equal((await request("insights", { period: "invalid" })).ok, false);
    const response = await request("insights", { period: "month" });
    assert.equal(response.ok, true); assert.equal(response.result.summary.metrics.followers.delta, null);
    assert.equal(response.result.summary.metrics.followers.knownValue, 120);
    assert.equal(response.result.accounts[0].metrics.followers.observedWindow.delta, 20);
    assert.equal(response.result.accounts[0].metrics.followers.fullPeriodComparable, false);
    const endingDay = response.result.summary.trend.at(-1);
    assert.equal(endingDay.followersDeltaReliable, false);
    assert.equal(endingDay.followersDeltaCoveragePercent, 0);
    assert.equal(typeof endingDay.followersCohortKey, "string");
    assert.equal(endingDay.followersDeltaCohortKey, null);
    assert.equal(endingDay.estimatedPlaysDeltaReliable, false);
    const detail = await request("account", { period: "month" });
    assert.equal(detail.ok, true); assert.equal(detail.result.account.metrics.followers.delta, null);
    assert.equal(detail.result.account.metrics.followers.observedWindow.delta, 20);
  } finally { await worker.terminate(); }
});
