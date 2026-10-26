import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorDatabase } from "../lib/database.mjs";
import { getProductContinuity } from "../lib/product-continuity.mjs";

test("continuity exposes eight-hour slots without mislabelling them daily", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcn-cadence-contract-"));
  const database = new MonitorDatabase(join(dir, "test.sqlite"));
  try {
    const state = { scheduleTime: "10:00", scheduleIntervalHours: 8,
      slotTimes: ["02:00", "10:00", "18:00"], currentSlotKey: "2026-09-28T02:00",
      currentSlotStartedAt: "2026-09-27T18:00:00Z", currentSlotEndsAt: "2026-09-28T02:00:00Z",
      nextRunAt: "2026-09-28T02:00:00Z", lastTickAt: "2026-09-27T20:00:00Z", scheduleState: "waiting" };
    const result = getProductContinuity(database, state, { now: new Date("2026-09-27T20:00:00Z"), timeZone: "Asia/Shanghai" });
    assert.equal(result.nextRunKind, "eight-hour");
    assert.equal(result.scheduleIntervalHours, 8);
    assert.deepEqual(result.slotTimes, ["02:00", "10:00", "18:00"]);
    assert.equal(result.currentSlotStartedAt, "2026-09-27T18:00:00.000Z");
    assert.equal(result.todayPlan, null, "schedule configuration cannot manufacture a daily observation");
    const old = getProductContinuity(database, {}, { now: new Date("2026-09-27T20:00:00Z") });
    assert.equal(old.scheduleIntervalHours, 24);
    assert.equal(old.nextRunKind, "daily");
  } finally {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
