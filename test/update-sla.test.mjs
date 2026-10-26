import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUpdateSla, inspectUpdateSla, compactUpdateSla, readUpdateSla } from "../lib/update-sla.mjs";

const now = new Date("2026-09-28T12:00:00Z");
const target = (id, extra = {}) => ({ id, type: "account", provider: "public-web", enabled: 1, ...extra });
const snapshot = (target_id, extra = {}) => ({ id: target_id, target_id, captured_at: "2026-09-28T10:00:00Z",
  followers: 0, total_likes: 0, total_posts: 0, quality_status: "warning", account_status: "partial", works_coverage: "unavailable",
  source_checksum: `sha-${target_id}`, collectionEvidence: { auditId: target_id, runId: 1, targetId: target_id, provider: "public-web", status: "warning", sourceChecksum: `sha-${target_id}`,
    runStartedAt: "2026-09-01T00:00:00Z", runFinishedAt: null, auditAt: extra.captured_at || "2026-09-28T10:00:00Z" }, ...extra });
const build = (targets, snapshots, extra = {}) => buildUpdateSla({ targets, snapshots, now, ...extra });

test("80% uses every enabled account including manual and failed, not topics or disabled accounts", () => {
  const targets = [1, 2, 3, 4, 5].map((id) => target(id)); targets[4].provider = "manual";
  targets.push(target(6, { enabled: 0 }), target(7, { type: "hashtag" }));
  const result = build(targets, [1, 2, 3, 4].map((id) => snapshot(id)));
  assert.deepEqual(result.coreAccounts.daily, { total: 5, complete: 4, missing: 1, ratioPercent: 80, requiredPercent: 80, requiredCount: 4, status: "met" });
  assert.equal(result.coreAccounts.fresh8h.status, "met");
  assert.equal(result.disabledTargetCount, 1); assert.equal(result.enabledTopicCount, 1);
  assert.equal(result.status, "incomplete"); assert.equal(result.works.daily.complete, 0);
});

test("core metrics must be safe nonnegative integers on the same validated snapshot, not stitched", () => {
  for (const invalid of [null, undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "100"]) {
    const result = build([target(1)], [snapshot(1, { total_likes: invalid })]);
    assert.equal(result.coreAccounts.daily.complete, 0);
  }
  assert.equal(build([target(1)], [snapshot(1, { total_likes: null }), snapshot(1, { id: 2, followers: null })]).coreAccounts.daily.complete, 0);
  for (const change of [{ quality_status: "rejected" }, { account_status: "unknown" }]) assert.equal(build([target(1)], [snapshot(1, change)]).coreAccounts.daily.complete, 0);
  assert.equal(build([target(1)], [snapshot(1)]).coreAccounts.daily.complete, 1);
});

test("Beijing day and rolling 8h are independent and exact boundaries are inclusive", () => {
  const result = build([target(1), target(2), target(3), target(4)], [
    snapshot(1, { captured_at: "2026-09-27T16:00:00Z" }),
    snapshot(2, { captured_at: "2026-09-27T15:59:59.999Z" }),
    snapshot(3, { captured_at: "2026-09-28T04:00:00Z" }),
    snapshot(4, { captured_at: "2026-09-28T03:59:59.999Z" }),
  ]);
  assert.equal(result.businessDate, "2026-09-28"); assert.equal(result.coreAccounts.daily.complete, 3); assert.equal(result.coreAccounts.fresh8h.complete, 1);
  const midnight = build([target(1)], [snapshot(1, { captured_at: "2026-09-28T15:59:59Z" })], { now: new Date("2026-09-28T16:00:00Z") });
  assert.equal(midnight.coreAccounts.daily.complete, 0); assert.equal(midnight.coreAccounts.fresh8h.complete, 1);
});

test("future, malformed and null timestamps cannot count as fresh or day observations", () => {
  for (const captured_at of ["2026-09-28T12:00:00.001Z", null, "2026-09-28", "invalid", "2026-02-30T01:00:00Z"]) {
    const result = build([target(1)], [snapshot(1, { captured_at })]);
    assert.equal(result.coreAccounts.daily.complete, 0); assert.equal(result.coreAccounts.fresh8h.complete, 0);
  }
  assert.equal(build([target(1)], [snapshot(1, { captured_at: "2026-09-28T20:00:00+08:00" })]).coreAccounts.fresh8h.complete, 1);
});

test("latest valid profile stays usable but later failed attempt stays visible and works never carries old complete forward", () => {
  const result = build([target(1)], [snapshot(1, { works_coverage: "complete" }), snapshot(1, { id: 2, captured_at: "2026-09-28T11:00:00Z", works_coverage: "retry", total_likes: null })], {
    attempts: [{ id: 1, target_id: 1, created_at: "2026-09-28T11:00:01Z", status: "rejected", provider: "public-web" },
      { id: 2, target_id: 1, created_at: "2099-01-01T00:00:00Z", status: "validated" }],
  });
  assert.equal(result.coreAccounts.daily.complete, 1); assert.equal(result.coreAccounts.targets[0].snapshotId, 1);
  assert.equal(result.coreAccounts.targets[0].latestAttempt.status, "rejected"); assert.equal(result.coreAccounts.targets[0].latestAttemptAfterUsableSnapshot, true);
  assert.equal(result.works.daily.counts.complete, 0); assert.equal(result.works.daily.counts.unavailable, 1);
});

test("works buckets are mutually exclusive and topic dual real counters do not inherit profile success", () => {
  const targets = [1, 2, 3, 4, 5].map((id) => target(id)); targets.push(target(6, { type: "hashtag" }), target(7, { type: "hashtag" }));
  const rows = [snapshot(1, { works_coverage: "complete" }), snapshot(2, { works_coverage: "latest-public-window" }), snapshot(3), snapshot(4, { works_coverage: "unknown" }),
    snapshot(6, { hashtag_participants: 0, hashtag_views: 0 }), snapshot(7, { hashtag_participants: 1, hashtag_views: null })];
  const result = build(targets, rows);
  assert.deepEqual(result.works.daily.counts, { complete: 1, limited: 1, unavailable: 1, unknown: 1, missing: 1 });
  assert.equal(result.works.daily.missing, 1, "missing means no valid detail observation, not every incomplete state");
  assert.equal(result.works.daily.incomplete, 4, "limited/unavailable/unknown/missing are all incomplete but remain distinct");
  assert.equal(Object.values(result.works.daily.counts).reduce((a, b) => a + b), result.enabledAccountCount);
  const compact = compactUpdateSla(result).works.daily;
  assert.deepEqual(compact.missingTargetIds, [5]);
  assert.deepEqual(compact.incompleteTargetIds, [2, 3, 4, 5]);
  assert.equal(result.topics.daily.complete, 1); assert.equal(result.topics.daily.total, 2); assert.equal(result.topics.daily.status, "incomplete");
});

test("zero denominator and missing inputs are unknown, never 100%", () => {
  const result = build([], []);
  assert.equal(result.status, "unknown"); assert.equal(result.coreAccounts.daily.ratioPercent, null); assert.equal(result.coreAccounts.daily.status, "unknown");
  assert.equal(result.topics.daily.ratioPercent, null);
  assert.equal(buildUpdateSla({ now }).coreAccounts, null);
  assert.throws(() => buildUpdateSla({ now: null }), /reference time/);
});

test("readonly SQLite projection agrees with pure contract and does not modify rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE targets(id INTEGER,type TEXT,provider TEXT,enabled INTEGER);
    CREATE TABLE snapshots(id INTEGER,target_id INTEGER,captured_at TEXT,followers INTEGER,total_likes INTEGER,total_posts INTEGER,
      hashtag_participants INTEGER,hashtag_views INTEGER,quality_status TEXT,account_status TEXT,works_coverage TEXT,source_checksum TEXT);
    CREATE TABLE audits(id INTEGER,target_id INTEGER,created_at TEXT,status TEXT,provider TEXT,run_id INTEGER,source_checksum TEXT);
    CREATE TABLE runs(id INTEGER,started_at TEXT,finished_at TEXT);
    INSERT INTO runs VALUES (1,'2026-09-01T00:00:00Z',NULL);`);
  const targets = [target(1), target(2, { provider: "manual" })], snapshots = [snapshot(1), snapshot(1, { id: 3, captured_at: "2099-01-01T00:00:00Z" })];
  for (const row of targets) db.prepare("INSERT INTO targets VALUES (?,?,?,?)").run(row.id, row.type, row.provider, row.enabled);
  for (const row of snapshots) {
    db.prepare("INSERT INTO snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(row.id, row.target_id, row.captured_at, row.followers, row.total_likes, row.total_posts, null, null, row.quality_status, row.account_status, row.works_coverage, row.source_checksum);
    db.prepare("INSERT INTO audits VALUES (?,?,?,?,?,?,?)").run(row.id, row.target_id, row.captured_at, "warning", "public-web", 1, row.source_checksum);
  }
  const before = db.prepare("SELECT total_changes() n").get().n; db.exec("PRAGMA query_only=ON");
  const attempts = snapshots.map((row) => ({ id: row.id, target_id: row.target_id, created_at: row.captured_at, status: "warning", provider: "public-web" }));
  assert.deepEqual(inspectUpdateSla(db, { now, includeTargets: true }), build(targets, snapshots, { attempts }));
  assert.deepEqual(inspectUpdateSla(db, { now }), compactUpdateSla(build(targets, snapshots, { attempts })));
  assert.equal(db.prepare("SELECT total_changes() n").get().n, before); db.close();
});

test("manual, missing or misbound source evidence cannot count as automatic updates", () => {
  const valid = snapshot(1);
  for (const change of [{ collectionEvidence: null }, { source_checksum: "" },
    { collectionEvidence: { ...valid.collectionEvidence, provider: "manual" } },
    { collectionEvidence: { ...valid.collectionEvidence, sourceChecksum: "different" } },
    { collectionEvidence: { ...valid.collectionEvidence, runStartedAt: "2026-09-28T10:00:00.001Z" } },
    { collectionEvidence: { ...valid.collectionEvidence, auditAt: "2026-09-28T09:59:59Z" } },
    { collectionEvidence: { ...valid.collectionEvidence, runFinishedAt: "2026-09-28T09:59:59Z" } },
    { collectionEvidence: { ...valid.collectionEvidence, runFinishedAt: "2099-01-01T00:00:00Z" } }]) {
    const result = build([target(1, { provider: "manual" })], [{ ...valid, ...change }]);
    assert.equal(result.coreAccounts.daily.total, 1); assert.equal(result.coreAccounts.daily.complete, 0);
    assert.equal(result.enabledManualAccountCount, 1); assert.equal(result.works.daily.counts.missing, 1);
  }
});

test("monitoring-status publishes one reference-time SLA and keeps viewer guard", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const route = server.slice(server.indexOf('pathname === "/api/monitoring-status"'), server.indexOf('pathname === "/api/rebuild/insights"'));
  assert.match(route, /requireRole\(request, "viewer"\)/);
  assert.match(route, /const \[updateSla, schedulerStatus\] = await Promise\.all\(/);
  assert.match(route, /readUpdateSla\(database.filePath, \{ now: checkedAt \}\)/);
  assert.match(route, /readSchedulerStatus\(request, response, checkedAt\)/);
  assert.match(route, /updateSla,\s*scheduler: schedulerStatus/);
});

test("worker shares overlapping reads, exits after a read and fails unknown without creating a missing database", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sla-worker-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "fixture.sqlite"), db = new DatabaseSync(path);
  db.exec(`CREATE TABLE targets(id INTEGER,type TEXT,provider TEXT,enabled INTEGER);
    CREATE TABLE snapshots(id INTEGER,target_id INTEGER,captured_at TEXT,followers INTEGER,total_likes INTEGER,total_posts INTEGER,
      hashtag_participants INTEGER,hashtag_views INTEGER,quality_status TEXT,account_status TEXT,works_coverage TEXT,source_checksum TEXT);
    CREATE TABLE audits(id INTEGER,target_id INTEGER,created_at TEXT,status TEXT,provider TEXT,run_id INTEGER,source_checksum TEXT);
    CREATE TABLE runs(id INTEGER,started_at TEXT,finished_at TEXT);
    INSERT INTO targets VALUES (1,'account','manual',1);`);
  db.close(); const before = readFileSync(path);
  const first = readUpdateSla(path, { now }), second = readUpdateSla(path, { now });
  assert.equal(first, second);
  const result = await first;
  assert.equal(result.coreAccounts.daily.total, 1); assert.equal(result.coreAccounts.daily.complete, 0); assert.equal(result.targetStatus, "below-target");
  assert.deepEqual(readFileSync(path), before);
  const third = readUpdateSla(path, { now }); assert.notEqual(third, first); await third;
  const missing = await readUpdateSla(join(dir, "must-not-create.sqlite"), { now });
  assert.equal(missing.status, "unknown"); assert.equal(missing.coreAccounts, null);
  assert.doesNotMatch(JSON.stringify(missing), /sla-worker|SQLITE|fixture.sqlite/);
});

test("compact status caps gaps and separates 80% target from full coverage", () => {
  const targets = Array.from({ length: 100 }, (_, i) => target(i + 1)); targets.push(target(101, { type: "hashtag" }));
  const result = compactUpdateSla(build(targets, []));
  assert.equal(result.coreAccounts.missingTargets.length, 20); assert.equal(result.coreAccounts.missingListTruncated, true);
  assert.equal(result.works.daily.missingTargetIds.length, 20); assert.equal(result.works.daily.missingListTruncated, true);
  assert.equal(result.works.daily.incompleteTargetIds.length, 20); assert.equal(result.works.daily.incompleteListTruncated, true);
  assert.equal(result.targetStatus, "below-target");
  const partial = build([1, 2, 3, 4, 5].map((id) => target(id)).concat(target(6, { type: "hashtag" })),
    [1, 2, 3, 4, 5].map((id) => snapshot(id, { works_coverage: "complete", total_likes: id === 5 ? null : 0 })).concat(snapshot(6, { hashtag_participants: 0, hashtag_views: 0 })));
  assert.equal(partial.targetStatus, "met"); assert.equal(partial.status, "incomplete");
});
