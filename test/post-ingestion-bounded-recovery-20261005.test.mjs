import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorDatabase } from "../lib/database.mjs";
import { recordPostIngestionReview, reconcilePostIngestionReviews } from "../lib/post-ingestion-review.mjs";

const NOW = new Date("2026-10-05T12:00:00.000Z");

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "post-ingestion-bounded-"));
  const database = new MonitorDatabase(join(directory, "fixture.sqlite"));
  const ledgerDir = join(directory, "review-ledger");
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  return { database, ledgerDir, directory, now: NOW };
}

function addRun(database, { running = false, status = running ? "running" : "success" } = {}) {
  const id = database.beginRun("scheduled", null, 0);
  const startedAt = new Date(NOW.getTime() - 60_000).toISOString();
  const finishedAt = running ? null : new Date(NOW.getTime() - 30_000).toISOString();
  database.db.prepare("UPDATE runs SET started_at=?,finished_at=?,status=? WHERE id=?")
    .run(startedAt, finishedAt, status, id);
  return id;
}

async function addReceipt(f, runId) {
  return recordPostIngestionReview({ ...f, runId });
}

test("opt-in recovery scans a bounded indexed page and resumes across old receipts and pending reviews", async t => {
  const f = fixture(t);
  const oldRunIds = [];
  for (let index = 0; index < 47; index += 1) oldRunIds.push(addRun(f.database));
  const oldReceiptBytes = new Map();
  for (const runId of oldRunIds) {
    const receipt = await addReceipt(f, runId);
    oldReceiptBytes.set(runId, readFileSync(receipt.path, "utf8"));
  }

  const pendingRunIds = [];
  for (let index = 0; index < 13; index += 1) pendingRunIds.push(addRun(f.database));

  const scanLimit = 8;
  const created = [];
  const pageStarts = [];
  let cursor = oldRunIds[0];
  let pages = 0;
  while (cursor !== null) {
    assert.ok(pages < 20, "recovery cursor must advance or stop rather than loop forever");
    pageStarts.push(cursor);
    const page = await reconcilePostIngestionReviews({
      ...f, fromRunId: cursor, limit: 3, scanLimit,
    });
    pages += 1;
    assert.ok(page.scannedCount <= scanLimit, `page scanned ${page.scannedCount} rows with scanLimit=${scanLimit}`);
    assert.equal(page.scanLimit, scanLimit);
    created.push(...page.createdRunIds);
    if (page.nextFromRunId !== null && page.nextFromRunId <= cursor) {
      assert.ok(page.failedRunIds.length || page.pendingRunIds.length || page.openRunIds?.length,
        "a non-advancing cursor must identify an unresolved row");
      break;
    }
    cursor = page.nextFromRunId;
  }

  assert.deepEqual(created, pendingRunIds);
  assert.ok(pages > 1, "the existing-receipt backlog must be split across SQL pages");
  assert.ok(pageStarts.every((start, index) => index === 0 || start > pageStarts[index - 1]));
  for (const [runId, bytes] of oldReceiptBytes) {
    assert.equal(readFileSync(join(f.ledgerDir, `run-${runId}.json`), "utf8"), bytes,
      "reconciliation must not rewrite existing evidence receipts");
  }

  const queryPlan = f.database.db.prepare(`EXPLAIN QUERY PLAN
    SELECT id,status,finished_at FROM runs WHERE id>=? ORDER BY id ASC LIMIT ?`).all(oldRunIds[0], scanLimit);
  assert.match(queryPlan.map(row => row.detail).join(" "), /INTEGER PRIMARY KEY|rowid/i,
    "bounded recovery should seek by the runs primary key, not rescan the whole history");
});

test("failed receipts remain the resume cursor, and an open run is an explicit barrier", async t => {
  const f = fixture(t);
  const first = addRun(f.database);
  const second = addRun(f.database);
  const damaged = addRun(f.database);
  const afterDamaged = addRun(f.database);
  const open = addRun(f.database, { running: true });
  const afterOpen = addRun(f.database);

  await addReceipt(f, first);
  await addReceipt(f, second);
  const damagedReceipt = await addReceipt(f, damaged);
  writeFileSync(damagedReceipt.path, "broken receipt must be preserved");
  const damagedBytes = readFileSync(damagedReceipt.path, "utf8");

  const page = await reconcilePostIngestionReviews({
    ...f, fromRunId: first, limit: 10, scanLimit: 10,
  });
  assert.equal(page.scannedCount, 6, "the SQL page is bounded even though a later candidate is fetched after the barrier");
  assert.deepEqual(page.failedRunIds, [damaged]);
  assert.deepEqual(page.createdRunIds, [afterDamaged], "a bad receipt does not prevent independent later evidence from being inspected in this page");
  assert.deepEqual(page.openRunIds, [open]);
  assert.equal(page.nextFromRunId, damaged, "pagination must not jump over the earliest failed receipt");
  assert.equal(readFileSync(damagedReceipt.path, "utf8"), damagedBytes);
  assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM runs WHERE id=? AND status<>'running' AND finished_at IS NOT NULL").get(afterOpen).n, 1);
  assert.throws(() => readFileSync(join(f.ledgerDir, `run-${open}.json`), "utf8"), { code: "ENOENT" });
  assert.throws(() => readFileSync(join(f.ledgerDir, `run-${afterOpen}.json`), "utf8"), { code: "ENOENT" },
    "rows after an open run must wait rather than being skipped by the resume cursor");
});

test("a queue containing only an open run returns promptly at that run instead of skipping or looping", async t => {
  const f = fixture(t);
  const open = addRun(f.database, { running: true });
  const result = await reconcilePostIngestionReviews({
    ...f, fromRunId: open, limit: 50, scanLimit: 1,
  });
  assert.equal(result.status, "pending");
  assert.equal(result.scannedCount, 1);
  assert.equal(result.attemptedCount, 0);
  assert.deepEqual(result.openRunIds, [open]);
  assert.equal(result.nextFromRunId, open);
});

test("scanLimit is opt-in and range-checked without changing legacy reconciliation results", async t => {
  const f = fixture(t);
  const first = addRun(f.database);
  const second = addRun(f.database);
  const legacy = await reconcilePostIngestionReviews({ ...f, fromRunId: first });
  assert.equal(legacy.scannedCount, 2);
  assert.equal(Object.hasOwn(legacy, "scanLimit"), false);
  assert.equal(Object.hasOwn(legacy, "openRunIds"), false);
  for (const scanLimit of [0, -1, 1.5, 1001, "8"]) {
    await assert.rejects(reconcilePostIngestionReviews({ ...f, fromRunId: first, scanLimit }), /scanLimit.*1.*1000/i);
  }
  const bounded = await reconcilePostIngestionReviews({ ...f, fromRunId: first, scanLimit: 1 });
  assert.deepEqual(bounded.existingRunIds, [first], "legacy reconciliation already created the first receipt");
  assert.deepEqual(bounded.pendingRunIds, []);
  assert.equal(bounded.nextFromRunId, second);
});
