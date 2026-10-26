import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const TIME_ZONES = ["UTC", "America/Los_Angeles", "Asia/Shanghai"];
const imports = [
  ["{ MonitorDatabase }", "../lib/database.mjs"],
  ["{ MonitorScheduler }", "../lib/scheduler.mjs"],
  ["{ localDateKey, nextDailyRun }", "../lib/utils.mjs"],
  ["{ getProductInsights, getAccountInsight }", "../lib/product-insights.mjs"],
].map(([binding, path]) => `import ${binding} from ${JSON.stringify(new URL(path, import.meta.url).href)};`).join("\n");

function inTimeZone(timeZone, body) {
  const originalTimeZone = process.env.TZ;
  const script = `import assert from "node:assert/strict";\n${imports}\n${body}`;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, TZ: timeZone }, encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(process.env.TZ, originalTimeZone, "a timezone fixture must never alter the parent test environment");
  return JSON.parse(output);
}

for (const timeZone of TIME_ZONES) {
  test(`${timeZone}: JavaScript and SQLite share local-day boundaries and summer/winter daily schedule`, () => {
    const result = inTimeZone(timeZone, String.raw`
      const database = new MonitorDatabase(":memory:");
      try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const instants = [
          "2026-09-13T15:59:59.999Z", "2026-09-13T16:00:00.000Z",
          "2026-09-13T23:59:59.999Z", "2026-09-14T00:00:00.000Z",
          "2026-09-14T06:59:59.999Z", "2026-09-14T07:00:00.000Z",
          "2026-12-13T07:59:59.999Z", "2026-12-13T08:00:00.000Z",
        ];
        const dates = instants.map((instant) => {
          const date = localDateKey(new Date(instant));
          assert.equal(database.db.prepare("SELECT date(?, 'localtime') AS date").get(instant).date, date);
          return date;
        });
        const expected = {
          UTC: ["2026-09-13", "2026-09-13", "2026-09-13", "2026-09-14", "2026-09-14", "2026-09-14", "2026-12-13", "2026-12-13"],
          "America/Los_Angeles": ["2026-09-13", "2026-09-13", "2026-09-13", "2026-09-13", "2026-09-13", "2026-09-14", "2026-12-12", "2026-12-13"],
          "Asia/Shanghai": ["2026-09-13", "2026-09-14", "2026-09-14", "2026-09-14", "2026-09-14", "2026-09-14", "2026-12-13", "2026-12-13"],
        };
        assert.deepEqual(dates, expected[zone]);
        const hours = { UTC: ["10", "10"], "America/Los_Angeles": ["17", "18"], "Asia/Shanghai": ["02", "02"] };
        ["09", "12"].forEach((month, index) => {
          const prefix = "2026-" + month + "-";
          const expectedHour = hours[zone][index];
          assert.equal(nextDailyRun("10:00", new Date(prefix + "13T09:59:59.999")).toISOString(), prefix + "13T" + expectedHour + ":00:00.000Z");
          assert.equal(nextDailyRun("10:00", new Date(prefix + "13T10:00:00.000")).toISOString(), prefix + "14T" + expectedHour + ":00:00.000Z");
          assert.equal(nextDailyRun("10:00", new Date(prefix + "13T23:59:59.999")).toISOString(), prefix + "14T" + expectedHour + ":00:00.000Z");
          assert.equal(localDateKey(new Date(prefix + "13T23:59:59.999")), prefix + "13");
          assert.equal(localDateKey(new Date(new Date(prefix + "13T23:59:59.999").getTime() + 1)), prefix + "14");
        });
        console.log(JSON.stringify({ zone, matchedDays: dates.length }));
      } finally { database.close(); }
    `);
    assert.equal(result.zone, timeZone);
    assert.equal(result.matchedDays, 8);
  });

  test(`${timeZone}: insight periods and inclusive custom ranges use the same business-day snapshot boundaries`, () => {
    const result = inTimeZone(timeZone, String.raw`
      const database = new MonitorDatabase(":memory:");
      try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const target = database.createTarget({ type: "account", provider: "public-web",
          locator: "MS4wLjABAAAAtimezoneTestCanonicalIdentity12345", label: "时区隔离作者", metadata: { platform: "douyin" } });
        database.db.prepare("UPDATE targets SET created_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", target.id);
        const sample = (localTime, value) => database.db.prepare(
          "INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,quality_status,account_status,works_coverage,source_checksum) VALUES(?,?,?,?,?,'validated','available','complete',?)"
        ).run(target.id, new Date(localTime).toISOString(), value, value * 2, Math.floor(value / 5), "timezone-fixture-" + localTime);
        sample("2026-09-11T23:59:59.999", 80);
        sample("2026-09-12T23:59:59.999", 100);
        sample("2026-09-13T00:00:00.000", 110);
        sample("2026-09-13T23:59:59.999", 125);
        sample("2026-09-14T00:00:00.000", 999);
        const reference = new Date("2026-09-14T12:00:00.000");
        const starts = {
          UTC: { day: "2026-09-14T00:00:00.000Z", week: "2026-09-14T00:00:00.000Z", month: "2026-09-01T00:00:00.000Z" },
          "America/Los_Angeles": { day: "2026-09-14T07:00:00.000Z", week: "2026-09-14T07:00:00.000Z", month: "2026-09-01T07:00:00.000Z" },
          "Asia/Shanghai": { day: "2026-09-13T16:00:00.000Z", week: "2026-09-13T16:00:00.000Z", month: "2026-08-31T16:00:00.000Z" },
        };
        for (const period of ["day", "week", "month", "30d"]) {
          const insight = getProductInsights(database, { period, reference });
          assert.equal(insight.timeZone, zone);
          assert.equal(insight.start, period === "30d" ? new Date("2026-08-16T00:00:00.000").toISOString() : starts[zone][period]);
          if (period === "30d") assert.equal(insight.summary.trend.length, 30, "30d includes exactly thirty calendar days, not 31 partial days");
          assert.equal(insight.end, reference.toISOString());
          assert.equal(insight.range.endDate, "2026-09-14");
          assert.equal(insight.summary.trend.at(-1).date, "2026-09-14");
          assert.equal(insight.summary.trend.at(-1).followers, 999);
        }
        const options = { period: "custom", reference, startDate: "2026-09-13", endDate: "2026-09-13",
          comparisonStartDate: "2026-09-12", comparisonEndDate: "2026-09-12" };
        const list = getProductInsights(database, options);
        const detail = getAccountInsight(database, target.id, options);
        assert.equal(list.start, new Date("2026-09-13T00:00:00.000").toISOString());
        assert.equal(list.end, new Date("2026-09-13T23:59:59.999").toISOString());
        assert.deepEqual(list.range, detail.range);
        assert.equal(list.range.inclusive, true);
        assert.equal(list.range.partialEndDay, false);
        assert.equal(detail.account.metrics.followers.value, 125, "next local day's 999 cannot leak into the range");
        assert.equal(detail.account.metrics.followers.baseline, 100);
        assert.equal(detail.account.metrics.followers.delta, 25);
        assert.equal(detail.account.metrics.followers.fullPeriodComparable, true);
        assert.equal(detail.account.trend.length, 1);
        assert.equal(detail.account.trend[0].date, "2026-09-13");
        assert.equal(detail.account.trend[0].followersDelta, 25);
        assert.equal(detail.account.trend[0].likesDelta, 50);
        assert.equal(detail.account.trend[0].estimatedPlaysDelta, 5000);
        assert.equal(list.summary.metrics.followers.delta, detail.account.metrics.followers.delta);
        assert.equal(list.comparison.summary.metrics.followers.value, 100);
        assert.equal(list.comparison.summary.metrics.followers.delta, 20);
        assert.deepEqual(list.comparison.range, detail.comparison.range);
        assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE date(captured_at,'localtime')=?").get("2026-09-13").n, 2);
        console.log(JSON.stringify({ zone, rangeStart: list.start, rangeEnd: list.end, delta: 25 }));
      } finally { database.close(); }
    `);
    assert.equal(result.zone, timeZone);
    assert.equal(result.delta, 25);
  });

  test(`${timeZone}: repeated ticks and restarts cannot repeat completed daily collection; wake catches up once`, () => {
    const result = inTimeZone(timeZone, String.raw`
      const NativeDate = Date;
      let clock = new NativeDate("2026-09-13T09:59:59.999").getTime();
      globalThis.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [clock])); }
        static now() { return clock; }
      };
      const database = new MonitorDatabase(":memory:");
      try {
        database.setSettings({ scheduleTime: "10:00" });
        const target = database.createTarget({ type: "account", provider: "public-web",
          locator: "MS4wLjABAAAAtimezoneSchedulerCanonical12345", label: "隔离调度作者", metadata: { platform: "douyin" } });
        let calls = 0;
        const options = { providerOptions: { cooldownMs: 0, execFileImpl(_file, args, _options, callback) {
          assert.equal(args[args.indexOf("--operation") + 1], "account");
          calls += 1;
          callback(null, JSON.stringify({ ok: true, data: {
            capturedAt: new Date().toISOString(),
            profile: { user: { sec_uid: target.locator, uid: "1234567890", unique_id: "timezone_fixture",
              nickname: target.label, follower_count: 100 + calls, total_favorited: 200 + calls, aweme_count: 0 } },
            works: { aweme_list: [], has_more: 0 },
          } }), "");
        } } };
        let scheduler = new MonitorScheduler(database, options);
        const at = async (time) => { clock = new NativeDate(time).getTime(); await scheduler.tick(new Date()); };
        await at("2026-09-13T09:59:59.999");
        assert.equal(calls, 0);
        assert.equal(scheduler.getStatus().scheduleState, "waiting");
        await at("2026-09-13T10:00:00.000");
        assert.equal(calls, 1);
        assert.equal(scheduler.getStatus().scheduleState, "completed");
        assert.equal(scheduler.getStatus().timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
        assert.equal(scheduler.getStatus().scheduleDueAt, new NativeDate("2026-09-13T10:00:00.000").toISOString());
        await at("2026-09-13T10:01:00.000");
        await at("2026-09-13T23:59:59.999");
        scheduler = new MonitorScheduler(database, options);
        await scheduler.tick(new Date());
        assert.equal(calls, 1, "completed evidence survives scheduler recreation and late same-day ticks");
        await at("2026-09-14T00:00:00.000");
        assert.equal(scheduler.getStatus().scheduleState, "waiting");
        assert.equal(calls, 1);
        await at("2026-09-14T14:30:00.000");
        assert.equal(calls, 2, "wake after the scheduled time performs only today's missed collection");
        assert.equal(scheduler.getStatus().scheduleState, "completed");
        await at("2026-09-14T14:31:00.000");
        assert.equal(calls, 2);
        assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 2);
        assert.deepEqual(database.db.prepare("SELECT date(started_at,'localtime') AS day FROM runs ORDER BY id").all().map(row => row.day), ["2026-09-13", "2026-09-14"]);
        assert.deepEqual(database.db.prepare("SELECT date(captured_at,'localtime') AS day FROM snapshots ORDER BY id").all().map(row => row.day), ["2026-09-13", "2026-09-14"]);
        assert.equal(scheduler.scheduledDueTargetIds("2026-09-14", new Date()).length, 0);
        console.log(JSON.stringify({ zone: scheduler.getStatus().timeZone, calls, runs: 2 }));
      } finally { database.close(); globalThis.Date = NativeDate; }
    `);
    assert.equal(result.zone, timeZone);
    assert.equal(result.calls, 2);
  });
}
