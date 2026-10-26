import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorDatabase } from "../lib/database.mjs";
import { auditCollectionRuntime, latencyDistribution } from "../lib/collection-runtime-audit.mjs";

test("runtime distributions retain zero and exclude missing/non-finite/negative durations", () => {
  assert.deepEqual(latencyDistribution([0, 10, 20, 30, null, -1, Infinity]), { count: 4, minMs: 0, p50Ms: 10, p90Ms: 30, p95Ms: 30, maxMs: 30, meanMs: 15 });
  assert.equal(latencyDistribution([]).p50Ms, null);
});

test("runtime audit separates profiles from works, has no source mutation, and labels stage inference", t => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-audit-"));
  const database = new MonitorDatabase(join(directory, "fixture.sqlite"));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const target = database.createTarget({ type: "account", provider: "public-web", label: "测试", locator: "MS4wLjTEST" });
  database.createTarget({ type: "account", provider: "public-web", label: "缺测", locator: "MS4wLjMISSING" });
  const run = database.beginRun("scheduled", null, 2);
  database.db.prepare("UPDATE runs SET started_at='2026-09-28T00:00:00Z',processed_count=1 WHERE id=?").run(run);
  database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,quality_status,account_status,works_coverage,source_checksum,raw_json)
    VALUES(?,'2026-09-28T00:00:02Z',0,0,0,'warning','available','unavailable','exact',?)`).run(target.id, JSON.stringify({ secret: "MUST-NOT-APPEAR", worksRequestPolicy: {
      anonymous: { attempted: false, deferred: true, errorCode: "blocked" }, browser: { attempted: true, deferred: false, errorCode: "network_error" },
    } }));
  database.db.prepare(`INSERT INTO audits(target_id,run_id,created_at,provider,status,source_checksum)
    VALUES(?,?,'2026-09-28T00:00:30Z','public-web','warning','exact')`).run(target.id,run);
  const before = database.db.prepare("SELECT COUNT(*) n FROM snapshots").get().n;
  const r = auditCollectionRuntime({ database, runId: run, now: new Date("2026-09-28T00:01:00Z") });
  assert.equal(r.runCoverage.accounts.profileUsable, 1);
  assert.equal(r.runCoverage.accounts.worksComplete, 0);
  assert.equal(r.runCoverage.accounts.worksUnavailable, 1);
  assert.equal(r.timings.captureToAudit.meanMs, 28000);
  assert.equal(r.transports.browser.errors.network_error, 1);
  assert.equal(r.capacity.remainingTargets, 1);
  assert.equal(r.capacity.estimateIsGuarantee, false);
  assert.equal(r.capacity.nextSlotStartsAt, "2026-09-28T02:00:00.000Z");
  assert.equal(r.dailySavedSnapshotCoverage.accounts.profileUsable, 1);
  const daily = r.dailySavedSnapshotCoverage.accounts;
  assert.equal(r.version, 3);
  assert.equal(daily.missingSnapshot, 1);
  assert.equal(daily.worksUnknown, 0);
  assert.equal(daily.worksComplete + daily.worksLimited + daily.worksUnavailable + daily.worksUnknown + daily.missingSnapshot, daily.total);
  assert.match(r.coverageDefinitions.profileOverlap, /independent/);
  assert.equal(r.accountFreshness.withinEightHours, 1);
  assert.equal(r.accountFreshness.olderThanEightHours, 0);
  assert.equal(database.db.prepare("SELECT COUNT(*) n FROM snapshots").get().n, before);
  assert.doesNotMatch(JSON.stringify(r), /MUST-NOT-APPEAR/);
  assert.match(r.limitations.join(" "), /not a pure network timer/);
});

test("runtime daily audit uses distinct profile and work dates across Beijing midnight", t => {
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  const target = database.createTarget({ type: "account", provider: "public-web", label: "offline", locator: "MS4wLjClockFixture" });
  const runId = database.beginRun("scheduled", null, 1);
  database.db.prepare("UPDATE runs SET started_at='2026-09-27T15:59:50.000Z' WHERE id=?").run(runId);
  database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,works_observed_at,followers,total_likes,total_posts,quality_status,account_status,works_coverage,source_checksum,raw_json)
    VALUES(?,'2026-09-27T15:59:59.000Z','2026-09-27T16:00:01.000Z',10,20,1,'validated','available','complete','offline','{}')`).run(target.id);
  database.db.prepare("INSERT INTO audits(target_id,run_id,created_at,provider,status,source_checksum) VALUES(?,?,'2026-09-27T16:00:02.000Z','public-web','validated','offline')").run(target.id, runId);
  const before = auditCollectionRuntime({ database, runId, now: new Date('2026-09-27T15:59:59.500Z') }).dailySavedSnapshotCoverage.accounts;
  assert.equal(before.profileUsable, 1); assert.equal(before.worksComplete, 0); assert.equal(before.missingSnapshot, 1);
  const after = auditCollectionRuntime({ database, runId, now: new Date('2026-09-27T16:00:03.000Z') }).dailySavedSnapshotCoverage.accounts;
  assert.equal(after.profileUsable, 0); assert.equal(after.worksComplete, 1); assert.equal(after.missingSnapshot, 0);
  for (const row of [before, after]) assert.equal(row.worksComplete + row.worksLimited + row.worksUnavailable + row.worksUnknown + row.missingSnapshot, row.total);
});
