import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MonitorDatabase } from "../lib/database.mjs";
import { MonitorScheduler } from "../lib/scheduler.mjs";
import { beijingCollectionSlot } from "../lib/collection-cadence.mjs";

const TEN = Date.parse("2026-09-28T02:00:00.000Z");
const EIGHT_HOURS = 8 * 3600_000;

function fixture(t) {
  t.mock.timers.enable({ apis: ["Date"], now: TEN });
  const directory = mkdtempSync(join(tmpdir(), "scheduler-eight-hour-"));
  const db = new MonitorDatabase(join(directory, "fixture.sqlite"));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.setSettings({ scheduleTime: "10:00" });
  const target = db.createTarget({ type: "account", provider: "public-web", label: "时隙测试作者", locator: "MS4wLjABslot" });
  const makeScheduler = () => new MonitorScheduler(db, {
    scheduleIntervalHours: 8, scheduleTimeZone: "Asia/Shanghai", scheduledRetryDelaysMs: [1000, 2000],
    providerOptions: { cooldownMs: 0, execFileImpl: (_file, _args, _options, callback) => callback(null, JSON.stringify({
      ok: true, data: { profile: { user: { follower_count: 8, total_favorited: 100, aweme_count: 1 } },
        works: { aweme_list: [{ aweme_id: "SLOT_POST", desc: "作品", statistics: { digg_count: 5 } }] } },
    }), "") },
  });
  const save = ({ followers = 8, worksCoverage = "complete", code = null, startedAt = null } = {}) => {
    const run = db.beginRun("scheduled", null, 1);
    if (startedAt) db.db.prepare("UPDATE runs SET started_at=? WHERE id=?").run(startedAt, run);
    db.saveCollection(target, run, { capturedAt: new Date().toISOString(), snapshot: { followers, totalLikes: 100, totalPosts: 1 },
      posts: [], qualityStatus: "warning", warnings: worksCoverage === "complete" ? [] : ["作品暂未取得"],
      accountStatus: "available", worksCoverage, raw: { source: "offline-fixture", worksErrorCode: code } });
    db.finishRun(run, { status: "success", successCount: 1, processedCount: 1 });
    return run;
  };
  return { db, target, makeScheduler, scheduler: makeScheduler(), save };
}

test("Beijing slots keep 02/10/18 boundaries independent of the host timezone", () => {
  for (const [instant, start, end] of [
    ["2026-09-28T01:59:59Z", "2026-09-27T18:00:00.000Z", "2026-09-28T02:00:00.000Z"],
    ["2026-09-28T02:00:00Z", "2026-09-28T02:00:00.000Z", "2026-09-28T10:00:00.000Z"],
    ["2026-09-28T10:00:00Z", "2026-09-28T10:00:00.000Z", "2026-09-28T18:00:00.000Z"],
    ["2026-09-28T16:00:00Z", "2026-09-28T10:00:00.000Z", "2026-09-28T18:00:00.000Z"],
  ]) {
    const slot = beijingCollectionSlot({ now: instant });
    assert.equal(slot.startsAt, start); assert.equal(slot.endsAt, end);
    assert.deepEqual(slot.slotTimes, ["02:00", "10:00", "18:00"]);
  }
});

test("slot helper preserves configured anchor minutes and rejects invalid timestamps", () => {
  const slot = beijingCollectionSlot({ now: "2026-09-28T02:29:59Z", anchorTime: "10:30" });
  assert.equal(slot.startsAt, "2026-09-27T18:30:00.000Z");
  assert.deepEqual(slot.slotTimes, ["02:30", "10:30", "18:30"]);
  assert.throws(() => beijingCollectionSlot({ now: "invalid" }), /有效时间/);
});

test("same-day later slot refreshes completed accounts, but restart never replays the same slot", async (t) => {
  const f = fixture(t);
  await f.scheduler.tick();
  const count = () => f.db.db.prepare("SELECT COUNT(*) AS n FROM snapshots").get().n;
  assert.equal(count(), 1);
  await f.makeScheduler().tick();
  assert.equal(count(), 1, "restart reuses persisted audits");
  t.mock.timers.setTime(TEN + EIGHT_HOURS);
  await f.makeScheduler().tick();
  assert.equal(count(), 2, "18:00 is a new observation, not the completed 10:00 plan");
  assert.equal(f.scheduler.getStatus().nextRunAt, "2026-09-28T18:00:00.000Z");
});

test("wake after several missed slots collects only the current slot without invented history", async (t) => {
  const f = fixture(t); await f.scheduler.tick();
  t.mock.timers.setTime(TEN + 7 * EIGHT_HOURS + 5000);
  await f.makeScheduler().tick();
  assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 2);
  const snapshots = f.db.db.prepare("SELECT captured_at FROM snapshots ORDER BY id").all();
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].captured_at, new Date().toISOString());
});

test("cross-midnight slot retains successful observations and a long run uses actual sample time", (t) => {
  const f = fixture(t);
  t.mock.timers.setTime(Date.parse("2026-09-28T15:59:00Z"));
  f.save({ startedAt: "2026-09-28T09:59:00.000Z" });
  t.mock.timers.setTime(Date.parse("2026-09-28T16:01:00Z"));
  const slot = f.scheduler.collectionSlot();
  assert.deepEqual(f.scheduler.scheduledDueTargetIds("2026-09-29", new Date(), slot), []);
  assert.equal(f.scheduler.scheduledPlanSummary("2026-09-29", slot).profileCompletedCount, 1);
});

test("8h profile success cannot trigger thousands of full refreshes just for missing works", async (t) => {
  const f = fixture(t); f.save({ worksCoverage: "unavailable", code: "network_error" });
  for (let step = 1; step < 16; step++) {
    t.mock.timers.setTime(TEN + step * 30 * 60_000);
    await f.scheduler.tick();
  }
  assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 1);
  const status = f.scheduler.getStatus();
  assert.equal(status.scheduledProfileCompletedTargetCount, 1);
  assert.equal(status.scheduledWorksCompleteTargetCount, 0);
  assert.equal(status.scheduledWorksRetryTargetCount, 1);
  assert.equal(status.scheduledWorksAwaitingNextSlotTargetCount, 1);
  assert.equal(status.scheduleState, "partial");
  t.mock.timers.setTime(TEN + EIGHT_HOURS);
  await f.scheduler.tick();
  assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 2);
});

test("missing profile metrics retain finite backoff and restart does not reset retry budget", (t) => {
  const f = fixture(t);
  for (let attempt = 0; attempt < 3; attempt++) {
    t.mock.timers.setTime(TEN + attempt * 5000);
    f.save({ followers: null, worksCoverage: "unavailable", code: "blocked" });
  }
  t.mock.timers.setTime(TEN + 60_000);
  const resumed = f.makeScheduler();
  assert.deepEqual(resumed.scheduledDueTargetIds("2026-09-28", new Date(), resumed.collectionSlot()), []);
  assert.equal(resumed.getStatus().scheduledExhaustedTargetCount, 1);
  t.mock.timers.setTime(TEN + EIGHT_HOURS);
  assert.deepEqual(resumed.scheduledDueTargetIds("2026-09-28", new Date(), resumed.collectionSlot()), [f.target.id]);
});

test("manual identity conflicts remain held within a slot, never promoted to completed", (t) => {
  const f = fixture(t);
  const run = f.db.beginRun("scheduled", null, 1);
  f.db.recordFailure(f.target, run, new Error("公开主页回显身份不一致"));
  f.db.finishRun(run, { status: "error", errorCount: 1, processedCount: 1 });
  assert.deepEqual(f.scheduler.scheduledDueTargetIds("2026-09-28", new Date(), f.scheduler.collectionSlot()), []);
  const status = f.scheduler.getStatus();
  assert.equal(status.scheduledManualTargetCount, 1); assert.equal(status.scheduledProfileCompletedTargetCount, 0);
});

test("simultaneous ticks share the running batch instead of starting duplicate collection", async (t) => {
  const f = fixture(t); let resolveProvider;
  f.scheduler.providerOptions.execFileImpl = (_file, _args, _options, callback) => { resolveProvider = callback; };
  const first = f.scheduler.tick();
  while (!resolveProvider) await Promise.resolve();
  await f.scheduler.tick();
  assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 1);
  resolveProvider(new Error("fixture network failure"), "", "");
  await first;
});

test("a verified public manual or first collection satisfies freshness but ingested values never do", async (t) => {
  for (const trigger of ["manual", "manual-refresh", "first-collection", "ingest"]) {
    await t.test(trigger, async (st) => {
      const f = fixture(st); const run = f.save();
      f.db.db.prepare("UPDATE runs SET trigger_type=? WHERE id=?").run(trigger, run);
      const status = f.scheduler.getStatus();
      assert.equal(status.scheduleState, trigger === "ingest" ? "due" : "completed");
      await f.scheduler.tick();
      assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, trigger === "ingest" ? 2 : 1);
    });
  }
});

test("partial manual evidence does not consume the automatic retry budget", (t) => {
  const f = fixture(t); const run = f.save({ followers: null, worksCoverage: "unavailable", code: "blocked" });
  f.db.db.prepare("UPDATE runs SET trigger_type='manual' WHERE id=?").run(run);
  const plan = f.scheduler.scheduledPlanSummary("2026-09-28", f.scheduler.collectionSlot());
  assert.equal(plan.attempts.size, 0);
  assert.deepEqual(f.scheduler.scheduledDueTargetIds("2026-09-28", new Date(), f.scheduler.collectionSlot()), [f.target.id]);
});

test("new roster entries join the current slot while paused and manual targets stay excluded", async (t) => {
  const f = fixture(t); f.save();
  const fresh = f.db.createTarget({ type: "account", provider: "public-web", label: "新作者", locator: "MS4wLjABnew" });
  f.db.createTarget({ type: "account", provider: "public-web", label: "暂停作者", locator: "MS4wLjABpaused", enabled: false });
  f.db.createTarget({ type: "account", provider: "manual", label: "手填作者", locator: "offline" });
  assert.deepEqual(f.scheduler.scheduledDueTargetIds("2026-09-28", new Date(), f.scheduler.collectionSlot()), [fresh.id]);
  await f.scheduler.tick();
  assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM snapshots").get().n, 2);
});

test("profile success is not borrowed through a wrong checksum or future timestamp", (t) => {
  const f = fixture(t); f.save({ worksCoverage: "unavailable", code: "blocked" });
  f.db.db.prepare("UPDATE snapshots SET source_checksum='different'").run();
  let plan = f.scheduler.scheduledPlanSummary("2026-09-28", f.scheduler.collectionSlot());
  assert.equal(plan.profileCompletedCount, 0); assert.equal(plan.worksAwaitingNextSlotCount, 0);
  assert.deepEqual(f.scheduler.scheduledDueTargetIds("2026-09-28", new Date(TEN + 5000), f.scheduler.collectionSlot()), [f.target.id]);
  f.db.db.prepare("UPDATE snapshots SET source_checksum=(SELECT source_checksum FROM audits LIMIT 1), captured_at=?").run(new Date(TEN + 5000).toISOString());
  plan = f.scheduler.scheduledPlanSummary("2026-09-28", f.scheduler.collectionSlot());
  assert.equal(plan.profileCompletedCount, 0);
  f.db.db.prepare("UPDATE audits SET created_at=?").run(new Date(TEN + 6000).toISOString());
  plan = f.scheduler.scheduledPlanSummary("2026-09-28", f.scheduler.collectionSlot());
  assert.equal(plan.attempts.size, 0, "future audit plus matching future snapshot cannot satisfy current freshness");
});

test("audit evidence outside its run lifetime cannot suppress a slot refresh", async (t) => {
  for (const offset of [-1000, 1000]) {
    await t.test(String(offset), (st) => {
      const f = fixture(st); f.save();
      f.db.db.prepare("UPDATE audits SET created_at=?").run(new Date(TEN + offset).toISOString());
      st.mock.timers.setTime(TEN + 2000);
      const slot = f.scheduler.collectionSlot();
      assert.equal(f.scheduler.scheduledPlanSummary("2026-09-28", slot).attempts.size, 0);
      assert.deepEqual(f.scheduler.scheduledDueTargetIds("2026-09-28", new Date(), slot), [f.target.id]);
    });
  }
});
