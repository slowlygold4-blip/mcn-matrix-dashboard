import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { MonitorDatabase } from "../lib/database.mjs";
import { getProductContinuity } from "../lib/product-continuity.mjs";

const now = new Date("2026-09-13T12:00:00Z");
const scheduler = { scheduleTime: "10:00", nextRunAt: "2026-09-13T17:00:00Z", lastTickAt: "2026-09-13T11:59:45Z", scheduleState: "waiting", running: false };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "product-continuity-lifecycle-test-"));
  const file = join(directory, "fixture.sqlite");
  const database = new MonitorDatabase(file);
  // Compatible both before and after the production migration is integrated.
  database.db.exec(`CREATE TABLE IF NOT EXISTS account_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,target_id INTEGER NOT NULL,run_id INTEGER,
    event_type TEXT NOT NULL,event_key TEXT NOT NULL,observed_at TEXT NOT NULL,
    source_checksum TEXT NOT NULL,event_json TEXT NOT NULL,raw_json TEXT NOT NULL,created_at TEXT NOT NULL
  )`);
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  return { database, file };
}

function target(database, label, enabled = true, metadata = {}) {
  return database.createTarget({ type: "account", provider: "public-web", label, locator: `MS4wLjABAAAA_${label}_fixture_identity`, enabled, metadata });
}

function snapshot(database, account, capturedAt, values = { followers: 1, likes: 2, posts: 3 }) {
  database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,quality_status,account_status,works_coverage,warnings_json,source_checksum,raw_json)
    VALUES(?,?,?,?,?,'validated','available','complete','[]','test','{}')`)
    .run(account.id, capturedAt, values.followers ?? null, values.likes ?? null, values.posts ?? null);
}

function event(database, account, state, observedAt, { runId = null, type = "lifecycle", json } = {}) {
  const current = database.db.prepare("SELECT COALESCE(MAX(id),0)+1 AS next FROM account_events").get().next;
  database.db.prepare(`INSERT INTO account_events(target_id,run_id,event_type,event_key,observed_at,source_checksum,event_json,raw_json,created_at)
    VALUES(?,?,?,?,?,'fixture-checksum',?,'{"privateResponse":"DO NOT EXPOSE"}',?)`)
    .run(account.id, runId, type, `fixture-${current}`, observedAt, json ?? JSON.stringify({ state }), observedAt);
}

function run(database, startedAt, details, { count = details.length, targetId = null } = {}) {
  const id = database.beginRun("scheduled", targetId, count);
  database.db.prepare("UPDATE runs SET started_at=?,finished_at=?,status='partial',processed_count=?,details_json=? WHERE id=?")
    .run(startedAt, startedAt, details.length, JSON.stringify(details), id);
  return id;
}

const inactiveDetail = (account) => ({ targetId: account.id, status: "inactive", reviewState: "inactive", lifecycleState: "deleted", profileUsable: true });

test("freshness has exclusive inactive bins while preserving each metric's original historical date", (t) => {
  const { database } = fixture(t);
  const fresh = target(database, "fresh");
  const aging = target(database, "aging");
  const stale = target(database, "stale");
  target(database, "missing");
  const forged = target(database, "metadata-is-not-evidence", true, { lifecycle: { state: "deleted" }, accountLifecycle: { state: "deleted" } });
  const deleted = target(database, "deleted-history");
  const deletedMissing = target(database, "deleted-missing");
  const paused = target(database, "paused-deleted", false);
  snapshot(database, fresh, "2026-09-13T11:00:00Z", { followers: 0, likes: 0, posts: 0 });
  snapshot(database, aging, "2026-09-12T10:00:00Z");
  snapshot(database, stale, "2026-09-09T10:00:00Z");
  snapshot(database, forged, "2026-09-09T10:00:00Z");
  snapshot(database, deleted, "2026-09-01T10:00:00Z", { followers: 17, posts: 1 });
  snapshot(database, deleted, "2026-09-02T10:00:00Z", { likes: 130 });
  event(database, deleted, "deleted", "2026-09-13T11:00:00Z");
  event(database, deletedMissing, "deleted", "2026-09-13T11:00:00Z");
  event(database, paused, "deleted", "2026-09-13T11:00:00Z");
  const freshness = getProductContinuity(database, scheduler, { now }).freshness;
  assert.equal(freshness.total, 7);
  assert.equal(freshness.activeCount, 5);
  assert.equal(freshness.inactiveCount, 2);
  assert.deepEqual(freshness.inactiveTargetIds, [deleted.id, deletedMissing.id]);
  for (const metric of Object.values(freshness.metrics)) {
    assert.equal(metric.freshCount, 1);
    assert.equal(metric.agingCount, 1);
    assert.equal(metric.staleCount, 2);
    assert.equal(metric.missingCount, 1);
    assert.equal(metric.inactiveCount, 2);
    assert.equal(metric.freshCount + metric.agingCount + metric.staleCount + metric.missingCount + metric.inactiveCount, metric.total);
    assert.equal(metric.observedCount, 5, "retained inactive historical observations are not erased");
    assert.equal(metric.activeObservedCount, 4);
    assert.equal(metric.inactiveObservedCount, 1);
    assert.equal(metric.inactiveMissingCount, 1);
    assert.equal(metric.observedCount + metric.missingCount + metric.inactiveMissingCount, metric.total);
    assert.equal(metric.over24HoursCount, 3, "inactive metrics are not listed as active retries");
    assert.equal(metric.inactiveLastObservedAtByTarget[deletedMissing.id], null);
    assert.ok(metric.staleTargetIds.includes(forged.id));
    assert.ok(!metric.staleTargetIds.includes(deleted.id));
  }
  assert.equal(freshness.metrics.followers.inactiveLastObservedAtByTarget[deleted.id], "2026-09-01T10:00:00.000Z");
  assert.equal(freshness.metrics.followers.oldestAt, "2026-09-01T10:00:00.000Z");
  assert.equal(freshness.metrics.likes.inactiveLastObservedAtByTarget[deleted.id], "2026-09-02T10:00:00.000Z");
  assert.equal(freshness.metrics.estimatedPlays.inactiveLastObservedAtByTarget[deleted.id], "2026-09-02T10:00:00.000Z");
});

test("latest trusted lifecycle at or before reference wins, active restores bins and future events do not leak back", (t) => {
  const { database } = fixture(t);
  const restored = target(database, "restored");
  const futureDeleted = target(database, "future-deleted");
  const deleted = target(database, "latest-deleted");
  for (const account of [restored, futureDeleted, deleted]) snapshot(database, account, "2026-09-09T10:00:00Z");
  event(database, restored, "deleted", "2026-09-10T10:00:00Z");
  event(database, restored, "active", "2026-09-11T10:00:00Z");
  event(database, restored, "deleted", "2026-09-14T10:00:00Z");
  event(database, futureDeleted, "deleted", "2026-09-14T10:00:00Z");
  event(database, deleted, "active", "2026-09-10T10:00:00Z");
  event(database, deleted, "deleted", "2026-09-11T10:00:00Z");
  event(database, deleted, "active", "2026-09-14T10:00:00Z");
  event(database, deleted, "active", "2026-09-12T10:00:00Z", { type: "alias-change" });
  event(database, deleted, "unknown", "2026-09-12T11:00:00Z");
  event(database, deleted, "active", "2026-09-12T11:01:00Z", { json: "invalid-json" });
  const freshness = getProductContinuity(database, scheduler, { now }).freshness;
  assert.deepEqual(freshness.inactiveTargetIds, [deleted.id]);
  assert.deepEqual(freshness.metrics.followers.staleTargetIds, [restored.id, futureDeleted.id]);
  assert.equal(freshness.metrics.followers.inactiveLastObservedAtByTarget[deleted.id], "2026-09-09T10:00:00.000Z");
});

test("daily plan is settled with trusted inactive targets but never claims 100 percent fresh metrics", (t) => {
  const { database } = fixture(t);
  const success = target(database, "success");
  const deleted = target(database, "daily-deleted");
  const id = run(database, "2026-09-13T10:00:00Z", [
    { targetId: success.id, status: "validated", accountStatus: "available", worksCoverage: "complete", reviewState: "complete", profileUsable: true },
    inactiveDetail(deleted),
  ]);
  event(database, deleted, "deleted", "2026-09-13T10:02:00Z", { runId: id });
  const plan = getProductContinuity(database, scheduler, { now }).latestPlan;
  assert.equal(plan.targetCount, 2);
  assert.equal(plan.completedTargetCount, 1);
  assert.equal(plan.profileSuccessfulTargetCount, 1, "a false usable flag in an inactive detail cannot promote profile success");
  assert.equal(plan.inactiveTargetCount, 1);
  assert.equal(plan.settledTargetCount, 2);
  assert.equal(plan.status, "settled");
  assert.equal(plan.coveragePercent, 50);
  assert.equal(plan.profileCoveragePercent, 50);
  assert.equal(plan.settledCoveragePercent, 100);
  assert.equal(plan.retryTargetCount, 0);
  assert.equal(plan.manualTargetCount, 0);
});

test("run-bound snapshot with missing profile metric cannot be upgraded by cached positive detail", (t) => {
  const { database } = fixture(t);
  const account = target(database, "bound-snapshot-missing-metric");
  const runId = run(database, "2026-09-13T10:00:00Z", [{
    targetId: account.id, status: "validated", accountStatus: "available", worksCoverage: "complete",
    reviewState: "complete", profileUsable: true,
  }]);
  const finishedAt = "2026-09-13T10:02:00Z";
  database.db.prepare("UPDATE runs SET finished_at=? WHERE id=?").run(finishedAt, runId);
  snapshot(database, account, "2026-09-13T10:00:30Z", { followers: 12, likes: null, posts: 3 });
  database.db.prepare(`INSERT INTO audits(target_id,run_id,created_at,provider,status,warnings_json,source_checksum,message)
    VALUES(?, ?, ?, 'public-web', 'validated', '[]', 'test', '旧详情夹具')`)
    .run(account.id, runId, "2026-09-13T10:01:00Z");

  const plan = getProductContinuity(database, scheduler, { now }).latestPlan;
  assert.equal(plan.profileSuccessfulTargetCount, 0, "run-bound snapshot lacks total_likes despite cached profileUsable=true");
  assert.equal(plan.completedTargetCount, 0, "a profile gap cannot be reported as a complete daily observation");
  assert.equal(plan.retryTargetCount, 1);
});

test("same-day retries use the latest per-target observation, not prior-run lifecycle evidence", (t) => {
  const { database } = fixture(t);
  const account = target(database, "retry");
  const first = run(database, "2026-09-13T10:00:00Z", [inactiveDetail(account)]);
  event(database, account, "deleted", "2026-09-13T10:01:00Z", { runId: first });
  run(database, "2026-09-13T11:00:00Z", [inactiveDetail(account)]);
  const plan = getProductContinuity(database, scheduler, { now }).latestPlan;
  assert.equal(plan.targetCount, 1);
  assert.equal(plan.runCount, 2);
  assert.equal(plan.inactiveTargetCount, 0, "a prior observation is not proof of a new request");
  assert.equal(plan.retryTargetCount, 1);
  assert.equal(plan.profileSuccessfulTargetCount, 0);
  assert.equal(plan.status, "partial");
});

test("daily inactive evidence must match run and target, occur within the run, and not be in the future", (t) => {
  const { database } = fixture(t);
  const wrongRun = target(database, "wrong-run");
  const future = target(database, "future");
  const beforeRun = target(database, "before-run");
  const active = target(database, "active-event");
  const id = run(database, "2026-09-13T10:00:00Z", [wrongRun, future, beforeRun, active].map(inactiveDetail));
  event(database, wrongRun, "deleted", "2026-09-13T10:01:00Z");
  event(database, future, "deleted", "2026-09-14T10:01:00Z", { runId: id });
  event(database, beforeRun, "deleted", "2026-09-13T09:59:00Z", { runId: id });
  event(database, active, "active", "2026-09-13T10:01:00Z", { runId: id });
  const plan = getProductContinuity(database, scheduler, { now }).latestPlan;
  assert.equal(plan.inactiveTargetCount, 0);
  assert.equal(plan.retryTargetCount, 4);
  assert.equal(plan.settledTargetCount, 0);
});

test("trusted lifecycle alone recovers interrupted detail evidence but unknown denominator remains incomplete", (t) => {
  const { database } = fixture(t);
  const account = target(database, "event-only");
  const id = run(database, "2026-09-13T10:00:00Z", [], { count: 2 });
  event(database, account, "deleted", "2026-09-13T10:01:00Z", { runId: id });
  const plan = getProductContinuity(database, scheduler, { now }).latestPlan;
  assert.equal(plan.targetCount, 2);
  assert.equal(plan.recordedTargetCount, 1);
  assert.equal(plan.inactiveTargetCount, 1);
  assert.equal(plan.settledTargetCount, 1);
  assert.equal(plan.completedTargetCount, 0);
  assert.equal(plan.denominatorComplete, false);
  assert.equal(plan.settledCoveragePercent, null);
  assert.equal(plan.status, "partial");
});

test("single-target scheduled runs cannot borrow a lifecycle event from a different account", (t) => {
  const { database } = fixture(t);
  const account = target(database, "single-target");
  const other = target(database, "not-this-run");
  const id = run(database, "2026-09-13T10:00:00Z", [inactiveDetail(account)], { targetId: account.id });
  event(database, other, "deleted", "2026-09-13T10:01:00Z", { runId: id });
  const plan = getProductContinuity(database, scheduler, { now }).latestPlan;
  assert.equal(plan.targetCount, 1);
  assert.equal(plan.inactiveTargetCount, 0);
  assert.equal(plan.retryTargetCount, 1);
});

test("same timestamp lifecycle ties use event ID and later active event restores normal daily completion", (t) => {
  const { database } = fixture(t);
  const account = target(database, "same-time");
  const id = run(database, "2026-09-13T10:00:00Z", [{ targetId: account.id, status: "validated", accountStatus: "available", worksCoverage: "complete", reviewState: "complete" }]);
  event(database, account, "deleted", "2026-09-13T10:01:00Z", { runId: id });
  event(database, account, "active", "2026-09-13T10:01:00Z", { runId: id });
  const report = getProductContinuity(database, scheduler, { now });
  assert.equal(report.latestPlan.status, "completed");
  assert.equal(report.latestPlan.inactiveTargetCount, 0);
  assert.equal(report.latestPlan.completedTargetCount, 1);
  assert.equal(report.freshness.inactiveCount, 0);
});

test("read-only continuity neither changes data nor exposes stored event response payloads", (t) => {
  const { database, file } = fixture(t);
  const account = target(database, "read-only");
  event(database, account, "deleted", "2026-09-13T10:00:00Z");
  const readOnly = new DatabaseSync(file, { readOnly: true });
  t.after(() => readOnly.close());
  const before = readOnly.prepare("SELECT total_changes() AS count").get().count;
  const report = getProductContinuity({ db: readOnly }, scheduler, { now });
  assert.equal(report.freshness.inactiveCount, 1);
  assert.equal(readOnly.prepare("SELECT total_changes() AS count").get().count, before);
  assert.doesNotMatch(JSON.stringify(report), /privateResponse|DO NOT EXPOSE|fixture-checksum/);
});

test("legacy databases without account_events remain readable and do not trust metadata deletion", (t) => {
  const { database } = fixture(t);
  database.db.exec("DROP TABLE account_events");
  const account = target(database, "legacy", true, { lifecycle: { state: "deleted" } });
  snapshot(database, account, "2026-09-09T10:00:00Z");
  run(database, "2026-09-13T10:00:00Z", [inactiveDetail(account)]);
  const report = getProductContinuity(database, scheduler, { now });
  assert.equal(report.freshness.inactiveCount, 0);
  assert.equal(report.freshness.metrics.followers.staleCount, 1);
  assert.equal(report.latestPlan.inactiveTargetCount, 0);
  assert.equal(report.latestPlan.retryTargetCount, 1);
});
