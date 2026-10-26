import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MonitorDatabase } from "../lib/database.mjs";
import { inspectDatabase, schedulerReadiness, schedulerScheduleHealthy } from "../lib/runtime-audit.mjs";

test("runtime audit proves the local evidence database is structurally sound", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-runtime-audit-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const result = inspectDatabase(database);
  assert.equal(result.status, "ok");
  assert.equal(result.quickCheck, "ok");
  assert.equal(result.integrityCheck, "ok");
  assert.equal(result.foreignKeyViolations, 0);
  assert.deepEqual(result.missingTables, []);
  assert.equal(result.counts.targets, 0);
  assert.equal(result.dataQuality.status, "ok");
  assert.equal(result.dataQuality.violationCount, 0);
  assert.equal(result.dataQuality.checkCount, 5);
});

test("runtime audit rejects contradictory snapshot and run states", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-runtime-quality-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const target = database.createTarget({ type: "account", label: "质量契约作者", locator: "MS4wLjQuality", provider: "public-web", metadata: {} });
  database.db.prepare(`
    INSERT INTO snapshots(target_id,captured_at,quality_status,account_status,works_coverage,warnings_json,source_checksum,raw_json)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(target.id, new Date().toISOString(), "validated", "available", "complete", "[]", "quality-check", "{}");
  const runId = database.beginRun("scheduled", target.id, 1);
  database.db.prepare("UPDATE runs SET finished_at=? WHERE id=?").run(new Date().toISOString(), runId);
  const result = inspectDatabase(database);
  assert.equal(result.status, "error");
  assert.equal(result.dataQuality.status, "error");
  assert.equal(result.dataQuality.checks.snapshotMetricContract.count, 1);
  assert.equal(result.dataQuality.checks.runLifecycleContract.count, 1);
  assert.equal(result.dataQuality.checks.sourceProbeContract.count, 0);
});

test("idle scheduler is ready when it has a heartbeat and a next run", () => {
  const now = new Date("2026-09-10T02:00:30Z");
  assert.equal(schedulerReadiness({ running: false, lastTickAt: "2026-09-10T02:00:00Z", nextRunAt: "2026-09-10T10:00:00Z" }, { now }), true);
  assert.equal(schedulerReadiness({ running: true, lastTickAt: "2026-09-10T02:00:00Z", nextRunAt: "2026-09-10T10:00:00Z" }, { now }), true);
  assert.equal(schedulerReadiness({ running: false, lastTickAt: null, nextRunAt: "2026-09-10T10:00:00Z" }), false);
});

test("scheduler readiness remains independent from the current automatic run state", () => {
  assert.equal(schedulerReadiness({ running: false, scheduleState: "due", lastTickAt: "2026-09-10T17:00:00Z", nextRunAt: "2026-09-11T17:00:00Z" }, { now: new Date("2026-09-10T17:00:30Z") }), true);
});

test("scheduler readiness rejects stale, missing, invalid and implausibly future ticks", () => {
  const now = new Date("2026-09-10T17:00:00Z");
  const state = { nextRunAt: "2026-09-11T17:00:00Z", lastTickAt: "2026-09-10T16:58:30Z" };
  assert.equal(schedulerReadiness(state, { now }), true);
  assert.equal(schedulerReadiness({ ...state, lastTickAt: "2026-09-10T16:58:29Z" }, { now }), false);
  assert.equal(schedulerReadiness({ ...state, lastTickAt: "2026-09-09T17:00:00Z", running: true }, { now }), false);
  assert.equal(schedulerReadiness({ ...state, lastTickAt: "2026-09-10T17:00:06Z" }, { now }), false);
  assert.equal(schedulerReadiness({ ...state, lastTickAt: "bad" }, { now }), false);
  assert.equal(schedulerReadiness({ ...state, nextRunAt: "bad" }, { now }), false);
  assert.equal(schedulerReadiness(state, { now: "bad" }), false);
});

test("scheduler readiness rejects a recent tick error even when the interval heartbeat is fresh", () => {
  const now = new Date("2026-09-10T17:00:00Z");
  const state = {
    lastTickAt: "2026-09-10T16:59:50Z",
    nextRunAt: "2026-09-11T17:00:00Z",
    lastErrorAt: "2026-09-10T16:59:55Z",
    lastError: "公开源超时",
  };
  assert.equal(schedulerReadiness(state, { now }), false);
  assert.equal(schedulerReadiness({ ...state, lastErrorAt: "2026-09-10T16:00:00Z" }, { now }), true);
  assert.equal(schedulerReadiness({ ...state, lastErrorAt: "invalid" }, { now }), false);
});

test("scheduler plan health rejects incomplete or missed automatic batches", () => {
  for (const scheduleState of ["waiting", "running", "completed"]) {
    assert.equal(schedulerScheduleHealthy({ scheduleState }), true, scheduleState);
  }
  for (const scheduleState of ["partial", "failed", "interrupted", "due", "unknown", null]) {
    assert.equal(schedulerScheduleHealthy({ scheduleState }), false, String(scheduleState));
  }
});
