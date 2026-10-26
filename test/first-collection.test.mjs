import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MonitorDatabase } from "../lib/database.mjs";
import { MonitorScheduler } from "../lib/scheduler.mjs";
import { PublicWebProvider } from "../lib/providers/public-web.mjs";
import { getNextFirstCollectionTarget, runFirstCollectionTick } from "../lib/first-collection.mjs";

const morning = new Date("2026-09-13T08:00:00");
const stamp = "2026-09-12T12:00:00.000Z";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "first-collection-"));
  const database = new MonitorDatabase(join(directory, "test.sqlite"));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  database.setSettings({ scheduleTime: "10:00" });
  const addTarget = (label, options = {}) => database.createTarget({ type: "account", label,
    locator: `MS4wLjABAAAA${label}abcdefghijklmnop`, provider: "public-web", metadata: { platform: "douyin" }, ...options });
  const calls = [];
  const scheduler = { running: false, scheduledDueTargetIds: () => [],
    async runAll(input) {
      calls.push(input);
      const runId = database.beginRun(input.triggerType, input.targetId, 1);
      database.recordFailure(database.getTarget(input.targetId), runId, new Error("模拟来源暂时不可用"));
      database.finishRun(runId, { status: "error", errorCount: 1 });
      return { runId, status: "error" };
    } };
  return { database, addTarget, scheduler, calls };
}

test("first collection serially tries one never-attempted public account and leaves failures to daily retry", async (t) => {
  const { database, addTarget, scheduler, calls } = fixture(t);
  const first = addTarget("one"); const second = addTarget("two");
  const result = await runFirstCollectionTick(database, scheduler, { now: morning });
  assert.equal(result.targetId, first.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].triggerType, "first-collection");
  assert.equal(database.getTarget(first.id).last_status, "error");
  assert.equal(getNextFirstCollectionTarget(database).id, second.id);
  await runFirstCollectionTick(database, scheduler, { now: morning });
  assert.equal(calls.length, 2);
  assert.equal((await runFirstCollectionTick(database, scheduler, { now: morning })).reason, "no-candidate");
});

test("candidate selection excludes paused, rejected, previously sampled and other-provider targets", (t) => {
  const { database, addTarget } = fixture(t);
  const paused = addTarget("paused"); database.updateTarget(paused.id, { enabled: false });
  const rejected = addTarget("rejected"); database.db.prepare("UPDATE targets SET last_status='rejected' WHERE id=?").run(rejected.id);
  addTarget("manual", { provider: "manual" });
  addTarget("hashtag", { type: "hashtag" });
  const sampled = addTarget("sampled");
  database.db.prepare("INSERT INTO snapshots(target_id,captured_at,quality_status,source_checksum) VALUES(?,?,?,?)")
    .run(sampled.id, stamp, "warning", "unknown-metrics-still-an-attempt");
  const strict = addTarget("strict");
  database.db.prepare(`INSERT INTO author_resolution_queue(identity_key,name,status,resolved_target_id,
    suspended_target_enabled,created_at,updated_at,next_attempt_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run("blocked", "blocked", "rejected", strict.id, 1, stamp, stamp, stamp);
  assert.equal(getNextFirstCollectionTarget(database), null);
  assert.equal(database.getTarget(paused.id).enabled, false);
});

test("identity-import audit is not confused with an attempted collection", (t) => {
  const { database, addTarget } = fixture(t);
  const target = addTarget("imported");
  database.db.prepare("INSERT INTO audits(target_id,created_at,provider,status,message) VALUES(?,?,?,?,?)")
    .run(target.id, stamp, "author-resolution", "validated", "严格身份已确认");
  assert.equal(getNextFirstCollectionTarget(database).id, target.id);
  const runId = database.beginRun("manual", null, 1);
  database.db.prepare("INSERT INTO audits(target_id,run_id,created_at,provider,status,message) VALUES(?,?,?,?,?,?)")
    .run(target.id, runId, stamp, "public-web", "rejected", "来源失败");
  assert.equal(getNextFirstCollectionTarget(database), null);
});

test("durable first run prevents re-entry after a crash even before last_checked_at was written", (t) => {
  const { database, addTarget } = fixture(t);
  const target = addTarget("interrupted");
  database.beginRun("first-collection", target.id, 1);
  assert.equal(database.getTarget(target.id).last_checked_at, null);
  assert.equal(getNextFirstCollectionTarget(database), null);
});

test("busy, aborted and caller-blocked ticks do not begin collection or alter target state", async (t) => {
  const { database, addTarget, scheduler, calls } = fixture(t);
  const target = addTarget("gated");
  scheduler.running = true;
  assert.equal((await runFirstCollectionTick(database, scheduler, { now: morning })).reason, "scheduler-busy");
  scheduler.running = false;
  assert.equal((await runFirstCollectionTick(database, scheduler, { now: morning, canRun: () => false })).reason, "caller-busy");
  assert.equal((await runFirstCollectionTick(database, scheduler, { now: morning, signal: AbortSignal.abort() })).reason, "aborted");
  assert.equal(calls.length, 0);
  assert.equal(database.getTarget(target.id).last_checked_at, null);
});

test("first collection yields the imminent/due daily schedule and incomplete daily batch", async (t) => {
  const { database, addTarget, scheduler, calls } = fixture(t);
  addTarget("daily-priority");
  assert.equal((await runFirstCollectionTick(database, scheduler, { now: new Date("2026-09-13T09:59:30") })).reason, "daily-window");
  assert.equal((await runFirstCollectionTick(database, scheduler, { now: new Date("2026-09-13T10:00:00") })).reason, "daily-due");
  const runId = database.beginRun("scheduled", null, 1);
  database.db.prepare("UPDATE runs SET started_at=? WHERE id=?").run(new Date("2026-09-13T10:00:00").toISOString(), runId);
  assert.equal((await runFirstCollectionTick(database, scheduler, { now: new Date("2026-09-13T11:00:00") })).reason, "daily-incomplete");
  database.finishRun(runId, { status: "success", successCount: 1 });
  scheduler.scheduledDueTargetIds = () => [1];
  assert.equal((await runFirstCollectionTick(database, scheduler, { now: new Date("2026-09-13T11:00:00") })).reason, "daily-due");
  assert.equal(calls.length, 0);
  scheduler.scheduledDueTargetIds = () => [];
  assert.equal((await runFirstCollectionTick(database, scheduler, { now: new Date("2026-09-13T11:00:00") })).status, "attempted");
});

test("two overlapping server ticks share a scheduler lock and cannot start different accounts concurrently", async (t) => {
  const { database, addTarget, scheduler } = fixture(t);
  addTarget("parallel-one"); addTarget("parallel-two");
  let release;
  let calls = 0;
  scheduler.runAll = async ({ triggerType, targetId }) => {
    calls += 1;
    const runId = database.beginRun(triggerType, targetId, 1);
    await new Promise((resolve) => { release = resolve; });
    database.finishRun(runId, { status: "error", errorCount: 1 });
    return { runId, status: "error" };
  };
  const first = runFirstCollectionTick(database, scheduler, { now: morning });
  const second = await runFirstCollectionTick(database, scheduler, { now: morning });
  assert.equal(second.reason, "scheduler-busy");
  assert.equal(calls, 1);
  release(); await first;
  assert.ok(getNextFirstCollectionTarget(database));
});

test("real scheduler integration stores one first snapshot without a browser, network probe or private queue", async (t) => {
  const { database, addTarget } = fixture(t);
  const first = addTarget("real-first"); const second = addTarget("real-second");
  const providerCalls = [];
  t.mock.method(PublicWebProvider.prototype, "collect", async (target) => {
    providerCalls.push(target.id);
    return { capturedAt: stamp, snapshot: { followers: 10, totalLikes: 20, totalPosts: 0 },
      posts: [], qualityStatus: "validated", warnings: [], accountStatus: "available", worksCoverage: "complete",
      raw: { profile: { user: { sec_uid: target.locator } }, works: { aweme_list: [] } } };
  });
  const scheduler = new MonitorScheduler(database, { scheduledSourceProbe: true, providerOptions: { cooldownMs: 0 } });
  t.mock.method(scheduler, "runScheduledSourceProbe", async () => { throw new Error("first collection must not start a scheduled probe"); });
  const result = await runFirstCollectionTick(database, scheduler, { now: morning });
  assert.equal(result.runStatus, "success");
  assert.deepEqual(providerCalls, [first.id]);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM snapshots").get().count, 1);
  assert.equal(database.db.prepare("SELECT trigger_type FROM runs WHERE id=?").get(result.runId).trigger_type, "first-collection");
  assert.equal(getNextFirstCollectionTarget(database).id, second.id);
});

test("eight-hour priority uses each Beijing slot instead of the host's local daily schedule", async (t) => {
  const { database, addTarget, calls, scheduler: runner } = fixture(t);
  const target = addTarget("eight-hour-new");
  const scheduler = new MonitorScheduler(database, { scheduleIntervalHours: 8 });
  t.mock.method(scheduler, "runAll", runner.runAll);
  const dueChecks = [];
  t.mock.method(scheduler, "scheduledDueTargetIds", (dateKey, now, slot) => {
    dueChecks.push({ dateKey, now: now.toISOString(), slot });
    return [target.id];
  });
  for (const stamp of ["2026-09-12T18:00:00Z", "2026-09-13T02:00:00Z", "2026-09-13T10:00:00Z", "2026-09-13T16:00:00Z"]) {
    assert.equal((await runFirstCollectionTick(database, scheduler, { now: new Date(stamp) })).reason, "slot-due");
  }
  assert.deepEqual(dueChecks.map((entry) => entry.dateKey), ["2026-09-13", "2026-09-13", "2026-09-13", "2026-09-14"]);
  assert.deepEqual(dueChecks.map((entry) => entry.slot.startsAt), ["2026-09-12T18:00:00.000Z", "2026-09-13T02:00:00.000Z", "2026-09-13T10:00:00.000Z", "2026-09-13T10:00:00.000Z"]);
  assert.equal(calls.length, 0);
});

test("eight-hour first collection yields imminent slots and unfinished current batches, but not an old completed batch", async (t) => {
  const { database, addTarget, calls, scheduler: runner } = fixture(t);
  addTarget("eight-hour-window");
  const scheduler = new MonitorScheduler(database, { scheduleIntervalHours: 8 });
  t.mock.method(scheduler, "runAll", runner.runAll);
  t.mock.method(scheduler, "scheduledDueTargetIds", () => []);
  for (const stamp of ["2026-09-12T17:59:30Z", "2026-09-13T01:59:30Z", "2026-09-13T09:59:30Z"]) {
    assert.equal((await runFirstCollectionTick(database, scheduler, { now: new Date(stamp) })).reason, "slot-window");
  }
  const runId = database.beginRun("scheduled", null, 1);
  database.db.prepare("UPDATE runs SET started_at=? WHERE id=?").run("2026-09-13T02:00:00.000Z", runId);
  assert.equal((await runFirstCollectionTick(database, scheduler, { now: new Date("2026-09-13T03:00:00Z") })).reason, "slot-incomplete");
  database.finishRun(runId, { status: "success", successCount: 1 });
  assert.equal((await runFirstCollectionTick(database, scheduler, { now: new Date("2026-09-13T16:00:00Z") })).status, "attempted");
  assert.equal(calls.length, 1);
});

test("eight-hour scheduler with unavailable slot metadata fails closed without a network attempt", async (t) => {
  const { database, addTarget, scheduler, calls } = fixture(t);
  addTarget("eight-hour-unknown");
  scheduler.scheduleIntervalHours = 8;
  assert.equal((await runFirstCollectionTick(database, scheduler, { now: morning })).reason, "slot-state-unknown");
  scheduler.scheduledDateKey = () => "2026-09-13";
  scheduler.collectionSlot = () => ({ startsAt: "invalid", endsAt: "invalid" });
  assert.equal((await runFirstCollectionTick(database, scheduler, { now: morning })).reason, "slot-state-unknown");
  assert.equal(calls.length, 0);
});
