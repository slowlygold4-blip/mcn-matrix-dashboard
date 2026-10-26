import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { buildUpdateSla, inspectUpdateSla } from "../lib/update-sla.mjs";

const targets = [{ id: 1, type: "account", provider: "public-web", enabled: 1 },
  { id: 2, type: "hashtag", provider: "public-web", enabled: 1 }];
const row = (id, targetId, captured, works, audit, coverage = "complete") => ({
  id, target_id: targetId, captured_at: captured, works_observed_at: works,
  followers: 1, total_likes: 2, total_posts: 3, hashtag_participants: 4, hashtag_views: 5,
  quality_status: "validated", account_status: "available", works_coverage: coverage, source_checksum: `source-${id}`,
  collectionEvidence: { auditId: id, runId: 1, targetId, provider: "public-web", status: "validated", sourceChecksum: `source-${id}`,
    runStartedAt: "2026-09-01T00:00:00.000Z", runFinishedAt: null, auditAt: audit },
});
const compute = (rows, now) => buildUpdateSla({ targets, snapshots: rows, now });

function database(rows, { legacy = false } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE targets(id INTEGER,type TEXT,provider TEXT,enabled INTEGER);
    CREATE TABLE snapshots(id INTEGER,target_id INTEGER,captured_at TEXT,followers INTEGER,total_likes INTEGER,total_posts INTEGER,
      hashtag_participants INTEGER,hashtag_views INTEGER,quality_status TEXT,account_status TEXT,works_coverage TEXT,source_checksum TEXT${legacy ? "" : ",works_observed_at TEXT"});
    CREATE TABLE audits(id INTEGER,target_id INTEGER,created_at TEXT,status TEXT,provider TEXT,run_id INTEGER,source_checksum TEXT);
    CREATE TABLE runs(id INTEGER,started_at TEXT,finished_at TEXT);
    INSERT INTO runs VALUES (1,'2026-09-01T00:00:00.000Z',NULL);`);
  for (const target of targets) db.prepare("INSERT INTO targets VALUES (?,?,?,?)").run(target.id, target.type, target.provider, target.enabled);
  for (const item of rows) {
    const values = [item.id, item.target_id, item.captured_at, item.followers, item.total_likes, item.total_posts,
      item.hashtag_participants, item.hashtag_views, item.quality_status, item.account_status, item.works_coverage, item.source_checksum];
    if (!legacy) values.push(item.works_observed_at ?? null);
    db.prepare(`INSERT INTO snapshots VALUES (${values.map(() => "?").join(",")})`).run(...values);
    db.prepare("INSERT INTO audits VALUES (?,?,?,?,?,?,?)").run(item.id, item.target_id, item.collectionEvidence.auditAt, "validated", "public-web", 1, item.source_checksum);
  }
  db.exec("PRAGMA query_only=ON");
  return db;
}

test("works cross Beijing midnight independently; profile and topic keep their original observation day", () => {
  const rows = targets.map(({ id }) => row(id, id, "2026-09-29T15:59:59.000Z", "2026-09-29T16:00:01.000Z", "2026-09-29T16:00:02.000Z"));
  const result = compute(rows, "2026-09-29T16:00:03.000Z");
  assert.equal(result.works.daily.complete, 1);
  assert.equal(result.works.daily.targets[0].capturedAt, rows[0].works_observed_at);
  assert.equal(result.coreAccounts.daily.complete, 0);
  assert.equal(result.topics.daily.complete, 0);
  assert.equal(result.coreAccounts.targets[0].capturedAt, rows[0].captured_at);
});

test("works 8h boundary is inclusive independently of stale profile; do not fall back from invalid, future or unbound works time", () => {
  const now = "2026-09-29T12:00:00.000Z";
  const base = row(1, 1, "2026-09-29T03:59:59.000Z", "2026-09-29T04:00:00.000Z", now);
  assert.equal(compute([base], now).works.fresh8h.complete, 1);
  assert.equal(compute([base], now).coreAccounts.fresh8h.complete, 0);
  assert.equal(compute([{ ...base, works_observed_at: "2026-09-29T03:59:59.999Z" }], now).works.fresh8h.complete, 0);
  const fresh = row(1, 1, "2026-09-29T10:00:00.000Z", null, "2026-09-29T11:00:00.000Z");
  for (const value of ["invalid", "", "2026-09-29T12:00:00.001Z", "2026-09-29T11:00:00.001Z", "2026-09-29T09:59:59.999Z"]) {
    const result = compute([{ ...fresh, works_observed_at: value }], now);
    assert.equal(result.works.fresh8h.counts.missing, 1, value);
    assert.equal(result.coreAccounts.fresh8h.complete, 1, value);
  }
});

test("latest works selection follows works time and cannot be displaced by later profile with earlier works", () => {
  const rows = [row(1, 1, "2026-09-29T15:59:59.000Z", "2026-09-29T16:00:03.000Z", "2026-09-29T16:00:04.000Z"),
    row(2, 1, "2026-09-29T16:00:01.000Z", null, "2026-09-29T16:00:02.000Z", "unavailable")];
  const result = compute(rows, "2026-09-29T16:00:05.000Z");
  assert.equal(result.works.daily.targets[0].snapshotId, 1);
  assert.equal(result.works.daily.complete, 1);
  assert.equal(result.coreAccounts.targets[0].snapshotId, 2);
});

test("SQL retains works-window candidates even when profile is before both windows and not latest/usable", () => {
  const now = "2026-09-30T00:00:05.000Z";
  const rows = [row(1, 1, "2026-09-29T15:59:59.000Z", "2026-09-29T16:00:06.000Z", "2026-09-29T16:00:07.000Z"),
    row(2, 1, "2026-09-29T16:00:01.000Z", null, "2026-09-29T16:00:02.000Z", "unavailable")];
  const db = database(rows);
  try {
    const before = db.prepare("SELECT total_changes() AS n").get().n;
    const result = inspectUpdateSla(db, { now, includeTargets: true });
    assert.deepEqual(result.works, compute(rows, now).works);
    assert.equal(result.works.fresh8h.complete, 1);
    assert.equal(result.works.fresh8h.targets[0].snapshotId, 1);
    assert.equal(result.coreAccounts.fresh8h.complete, 0);
    assert.equal(db.prepare("SELECT total_changes() AS n").get().n, before);
  } finally { db.close(); }
});

test("SQL does not credit work after the as-of boundary or after its audit", () => {
  const now = "2026-09-29T12:00:00.000Z";
  for (const works of ["2026-09-29T12:00:00.001Z", "2026-09-29T11:00:00.001Z"]) {
    const rows = [row(1, 1, "2026-09-29T10:00:00.000Z", works, "2026-09-29T11:00:00.000Z")];
    const db = database(rows);
    try {
      const result = inspectUpdateSla(db, { now, includeTargets: true });
      assert.equal(result.works.daily.counts.missing, 1);
      assert.equal(result.coreAccounts.daily.complete, 1);
    } finally { db.close(); }
  }
});

test("NULL and absent legacy works timestamps retain captured_at and old schema stays readonly", () => {
  const now = "2026-09-29T12:00:00.000Z";
  const rows = [row(1, 1, "2026-09-29T10:00:00.000Z", null, "2026-09-29T10:00:00.000Z")];
  for (const legacy of [false, true]) {
    const db = database(rows, { legacy });
    try {
      const result = inspectUpdateSla(db, { now, includeTargets: true });
      assert.deepEqual(result.works, compute(rows, now).works);
      assert.equal(result.works.daily.complete, 1);
      assert.equal(result.works.daily.targets[0].capturedAt, rows[0].captured_at);
      assert.equal(db.prepare("PRAGMA table_info(snapshots)").all().some(({ name }) => name === "works_observed_at"), !legacy);
    } finally { db.close(); }
  }
});
