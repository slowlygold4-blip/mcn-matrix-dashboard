import test from "node:test";
import assert from "node:assert/strict";
import { MonitorDatabase } from "../lib/database.mjs";
import { MonitorScheduler } from "../lib/scheduler.mjs";
import { buildPostIngestionReview } from "../lib/post-ingestion-review.mjs";

const NOW = Date.parse("2026-09-28T02:01:00.000Z");
const payload = () => JSON.stringify({ ok: true, data: {
  capturedAt: new Date().toISOString(),
  profile: { user: { follower_count: 8, total_favorited: 100, aweme_count: 1 } },
  works: { aweme_list: [{ aweme_id: "offline-post", desc: "fixture", statistics: { digg_count: 5 } }] },
} });

function fixture(t, count = 3) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  database.setSettings({ scheduleTime: "10:00" });
  for (let index = 0; index < count; index += 1) database.createTarget({
    type: "account", provider: "public-web", label: `offline-${index}`, locator: `MS4wLjABoffline${index}`,
  });
  return database;
}

test("cancelled in-flight target is not a failure and same-slot restart resumes only missing observations", async (t) => {
  const database = fixture(t);
  const controller = new AbortController();
  const calls = [];
  const completions = [];
  const scheduler = new MonitorScheduler(database, {
    scheduleIntervalHours: 8, onRunComplete: async (result) => completions.push(result),
    providerOptions: { signal: controller.signal, cooldownMs: 0, execFileImpl(_file, args, _options, callback) {
      calls.push(args[args.indexOf("--locator") + 1]);
      if (calls.length === 2) { controller.abort(); callback(Object.assign(new Error("cancelled"), { name: "AbortError" }), "", ""); }
      else callback(null, payload(), "");
    } },
  });
  await scheduler.tick();
  assert.equal(calls.length, 2, "the third account must never reach the provider");
  const run = database.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 1").get();
  assert.equal(run.status, "interrupted");
  assert.equal(run.processed_count, 1);
  assert.equal(run.success_count, 1);
  assert.equal(run.error_count, 0);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM snapshots").get().n, 1);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM audits").get().n, 1);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].status, "interrupted");
  assert.equal(completions[0].details.length, 1, "there is no invented cancelled-target audit");
  const review = buildPostIngestionReview({ database, runId: run.id });
  assert.equal(review.runStatus, "interrupted");
  assert.equal(review.targetCount, 3);
  assert.equal(review.snapshotCount, 1);
  assert.equal(review.account.profileUsable, 1);
  assert.equal(review.unattemptedCount, 2);
  assert.equal(review.deterministicReview.status, "warning");

  const resumedCalls = [];
  const resumed = new MonitorScheduler(database, { scheduleIntervalHours: 8,
    providerOptions: { cooldownMs: 0, execFileImpl(_file, args, _options, callback) {
      resumedCalls.push(args[args.indexOf("--locator") + 1]); callback(null, payload(), "");
    } },
  });
  await resumed.tick();
  await resumed.tick();
  assert.equal(resumedCalls.length, 2);
  assert.equal(resumedCalls.includes(calls[0]), false, "the committed account must not be collected twice");
  assert.deepEqual(database.db.prepare("SELECT COUNT(*) AS n FROM snapshots GROUP BY target_id").all().map((row) => row.n), [1, 1, 1]);
});

test("pre-aborted batch has zero requests, zero failures, and an honest interrupted receipt", async (t) => {
  const database = fixture(t);
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const scheduler = new MonitorScheduler(database, { providerOptions: {
    signal: controller.signal, cooldownMs: 0, execFileImpl() { calls += 1; },
  } });
  const result = await scheduler.runAll({ triggerType: "scheduled" });
  assert.equal(result.status, "interrupted"); assert.equal(result.errorCount, 0);
  assert.equal(calls, 0);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM audits").get().n, 0);
  assert.equal(database.db.prepare("SELECT processed_count FROM runs").get().processed_count, 0);
});

test("cancellation during an anonymous source probe never records platform failure or starts accounts", async (t) => {
  const database = fixture(t, 1);
  const controller = new AbortController();
  let calls = 0;
  const scheduler = new MonitorScheduler(database, { scheduledSourceProbe: true, providerOptions: {
    signal: controller.signal, cooldownMs: 0, execFileImpl(_file, _args, _options, callback) {
      calls += 1; controller.abort(); callback(Object.assign(new Error("cancelled"), { name: "AbortError" }), "", "");
    },
  } });
  const result = await scheduler.runAll({ triggerType: "scheduled" });
  assert.equal(result.status, "interrupted"); assert.equal(result.errorCount, 0); assert.equal(calls, 1);
  assert.equal(database.getLatestSourceProbe("douyin-public"), null);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM audits").get().n, 0);
});
