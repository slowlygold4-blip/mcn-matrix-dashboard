import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorDatabase } from "../lib/database.mjs";
import { MonitorScheduler } from "../lib/scheduler.mjs";

test("a stopped scheduler rejects a late collection before it creates a durable run", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "scheduler-shutdown-admission-"));
  const database = new MonitorDatabase(join(directory, "monitor.sqlite"));
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const target = database.createTarget({ type: "account", provider: "manual", label: "关机窗口测试", locator: "manual://shutdown-admission" });
  const scheduler = new MonitorScheduler(database);
  await scheduler.drain();
  const before = database.db.prepare("SELECT COUNT(*) AS n FROM runs").get().n;

  await assert.rejects(scheduler.runAll({ triggerType: "manual", targetId: target.id }), (error) =>
    error?.status === 503 && error?.code === "SCHEDULER_STOPPED");

  assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, before,
    "a rejected shutdown-time request must not reserve a run");
});
