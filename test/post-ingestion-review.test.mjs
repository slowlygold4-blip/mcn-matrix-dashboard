import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorDatabase } from "../lib/database.mjs";
import { buildPostIngestionReview, recordPostIngestionReview, inspectPostIngestionReviews, completePostIngestionProductReview, reconcilePostIngestionReviews, summarizePostIngestionReviewQueue } from "../lib/post-ingestion-review.mjs";

const now = new Date("2026-09-28T03:00:00Z");
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "post-ingestion-review-"));
  const database = new MonitorDatabase(join(directory, "fixture.sqlite"));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const target = database.createTarget({ type: options.type || "account", provider: "public-web", label: "测试", locator: "MS4wLjTEST" });
  const runId = database.beginRun("scheduled", null, options.count ?? 1);
  database.db.prepare("UPDATE runs SET started_at=?,finished_at=?,status=? WHERE id=?").run(
    "2026-09-28T02:00:00Z", options.running ? null : "2026-09-28T02:10:00Z", options.running ? "running" : "success", runId);
  const s = { at: "2026-09-28T02:01:00Z", checksum: "exact", quality: "warning", account: "available", works: "unavailable", followers: 0, likes: 0, posts: 0, participants: null, views: null, ...options.snapshot };
  if (options.snapshot !== false) database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,source_checksum,quality_status,account_status,works_coverage,followers,total_likes,total_posts,hashtag_participants,hashtag_views,raw_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'{"secret":"RAW-MUST-NOT-LEAK"}')`).run(target.id,s.at,s.checksum,s.quality,s.account,s.works,s.followers,s.likes,s.posts,s.participants,s.views);
  database.db.prepare(`INSERT INTO audits(target_id,run_id,created_at,provider,status,source_checksum,message)
    VALUES(?,?,?,'public-web',?,?,'token=SECRET')`).run(target.id,runId,options.auditAt || "2026-09-28T02:02:00Z",options.auditStatus || "warning",options.checksum ?? "exact");
  return { database, runId, directory, ledgerDir: join(directory, "review-ledger"), now };
}

test("post-ingestion review preserves zero versus missing and separates works from profile", t => {
  const f = fixture(t);
  const r = buildPostIngestionReview(f);
  assert.equal(r.snapshotCount, 1);
  assert.equal(r.account.profileUsable, 1);
  assert.equal(r.account.worksComplete, 0);
  assert.equal(r.account.worksUnavailable, 1);
  assert.equal(r.deterministicReview.status, "warning");
  assert.equal(r.productReview.status, "pending");
  assert.match(r.metricPolicy.accountPlays, /net-like-change × 100/);
  assert.doesNotMatch(JSON.stringify(r), /SECRET|RAW-MUST-NOT-LEAK/);
});

test("viewer review status returns run counts instead of enumerating thousands of run IDs", () => {
  const queue = {
    status: "ok", fromRunId: 1, scannedCount: 4565, attemptedCount: 1,
    createdRunIds: [5314], existingRunIds: Array.from({ length: 4564 }, (_, index) => index + 1),
    pendingRunIds: [], failedRunIds: [], pendingCount: 0, failedCount: 0, checkedAt: now.toISOString(),
  };
  const beforeBytes = Buffer.byteLength(JSON.stringify(queue));
  const summary = summarizePostIngestionReviewQueue(queue);
  const afterBytes = Buffer.byteLength(JSON.stringify(summary));
  assert.equal(summary.status, "ok");
  assert.equal(summary.createdCount, 1);
  assert.equal(summary.existingCount, 4564);
  assert.equal(summary.pendingCount, 0);
  assert.equal(summary.failedCount, 0);
  assert.deepEqual(Object.keys(summary).filter(key => key.endsWith("RunIds")), []);
  assert.ok(afterBytes < beforeBytes / 20, `summary should be much smaller (${beforeBytes} -> ${afterBytes} bytes)`);
  assert.equal(queue.existingRunIds.length, 4564, "summarizing must not mutate the admin queue state");
});

test("topic review accepts genuine zeros, not null or rejected counters", t => {
  for (const [snapshot, expected] of [[{ participants: 0, views: 0 },1],[{ participants: 0, views: null },0],[{ participants: 0, views: 0, quality: "rejected" },0]]) {
    const r = buildPostIngestionReview(fixture(t, { type: "hashtag", snapshot }));
    assert.equal(r.topics.usable, expected);
    assert.equal(r.account.attempted, 0);
    assert.equal(r.samples[0].worksCoverage, null);
  }
});

test("stale, absent or mismatched evidence cannot be counted as collected in this run", t => {
  for (const options of [{ checksum: "different" }, { checksum: "", snapshot: { checksum: "" } },
    { snapshot: { at: "2026-09-28T01:59:59Z" } }, { snapshot: false }, { snapshot: { followers: null } }, { auditStatus: "error" }]) {
    const r = buildPostIngestionReview(fixture(t, options));
    assert.equal(r.account.profileUsable, 0, JSON.stringify(options));
  }
});

test("missing evidence has no synthetic business date; partial valid profiles remain usable", t => {
  const missing = buildPostIngestionReview(fixture(t, { snapshot: false }));
  assert.equal(missing.samples[0].businessDate, null);
  const partial = buildPostIngestionReview(fixture(t, { snapshot: { account: "partial" } }));
  assert.equal(partial.account.profileUsable, 1);
});

test("a snapshot milliseconds before run start cannot be borrowed", t => {
  const f = fixture(t, { snapshot: { at: "2026-09-28T02:00:00Z" } });
  f.database.db.prepare("UPDATE runs SET started_at=? WHERE id=?").run("2026-09-28T02:00:00.500Z", f.runId);
  assert.equal(buildPostIngestionReview(f).snapshotCount, 0);
});

test("future audits cannot give a completed run false coverage", t => {
  const r = buildPostIngestionReview(fixture(t, { auditAt: "2026-09-28T02:11:00Z" }));
  assert.equal(r.snapshotCount, 0);
  assert.equal(r.unattemptedCount, 1);
});

test("unfinished runs and invalid identifiers cannot generate a durable event", async t => {
  const f = fixture(t, { running: true });
  await assert.rejects(recordPostIngestionReview(f), /before collection/);
  assert.throws(() => buildPostIngestionReview({ ...f, runId: "../../secret" }), /positive integer/);
});

test("parallel completion callbacks create exactly one immutable evidence receipt", async t => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => recordPostIngestionReview(f)));
  assert.equal(results.filter(r => r.status === "created").length, 1);
  assert.deepEqual(readdirSync(f.ledgerDir), [`run-${f.runId}.json`]);
  const before = readFileSync(results[0].path, "utf8");
  const retry = await recordPostIngestionReview({ ...f, now: new Date("2026-10-01T00:00:00Z") });
  assert.equal(retry.status, "existing");
  assert.equal(readFileSync(retry.path, "utf8"), before);
  const inspected = await inspectPostIngestionReviews({ ledgerDir: f.ledgerDir });
  assert.equal(inspected.reviews.length, 1);
  assert.equal(inspected.reviews[0].productReviewStatus, "pending");
  assert.equal(retry.summary.account.profileUsable, 1);
});

test("malformed existing receipts are preserved rather than silently replaced", async t => {
  const f = fixture(t);
  const first = await recordPostIngestionReview(f);
  writeFileSync(first.path, "{bad-json");
  await assert.rejects(recordPostIngestionReview(f));
  assert.equal(readFileSync(first.path, "utf8"), "{bad-json");
});

test("agent completion is a separate immutable evidence receipt, not a modified data audit", async t => {
  const f = fixture(t);
  const event = await recordPostIngestionReview(f);
  const before = readFileSync(event.path, "utf8");
  await assert.rejects(completePostIngestionProductReview({ ...f, evidence: [] }), /evidence/);
  const sparseEvidence = new Array(2);
  sparseEvidence[1] = "data/maintenance-journal/2026-09-28.md";
  await assert.rejects(completePostIngestionProductReview({ ...f, evidence: sparseEvidence }), /evidence/);
  const completed = await completePostIngestionProductReview({ ...f, evidence: ["data/maintenance-journal/2026-09-28.md"] });
  assert.equal(completed.status, "created");
  assert.equal(readFileSync(event.path, "utf8"), before);
  const inspected = await inspectPostIngestionReviews({ ledgerDir: f.ledgerDir });
  assert.equal(inspected.reviews[0].productReviewStatus, "completed");
  assert.equal((await completePostIngestionProductReview({ ...f, evidence: ["another-review.md"] })).status, "existing");
});

function addFinishedRun(f, { finished = true } = {}) {
  const id = f.database.beginRun("scheduled", null, 0);
  f.database.db.prepare("UPDATE runs SET started_at=?,finished_at=?,status=? WHERE id=?").run(
    "2026-09-28T02:01:00Z", finished ? "2026-09-28T02:02:00Z" : null, finished ? "success" : "running", id);
  return id;
}

test("reconciliation recovers an older missed callback even when a newer receipt exists", async t => {
  const f = fixture(t);
  const second = addFinishedRun(f);
  const stillRunning = addFinishedRun(f, { finished: false });
  await recordPostIngestionReview({ ...f, runId: second });
  const r = await reconcilePostIngestionReviews({ ...f, fromRunId: f.runId });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.createdRunIds, [f.runId]);
  assert.deepEqual(r.existingRunIds, [second]);
  assert.equal(readdirSync(f.ledgerDir).includes(`run-${stillRunning}.json`), false);
});

test("reconciliation is bounded, resumes with a cursor, and does not backfill before activation", async t => {
  const f = fixture(t);
  const second = addFinishedRun(f);
  const third = addFinishedRun(f);
  const first = await reconcilePostIngestionReviews({ ...f, fromRunId: second, limit: 1 });
  assert.equal(first.status, "pending");
  assert.deepEqual(first.createdRunIds, [second]);
  assert.deepEqual(first.pendingRunIds, [third]);
  assert.equal(first.nextFromRunId, third);
  const next = await reconcilePostIngestionReviews({ ...f, fromRunId: first.nextFromRunId, limit: 1 });
  assert.deepEqual(next.createdRunIds, [third]);
  assert.equal(readdirSync(f.ledgerDir).includes(`run-${f.runId}.json`), false);
});

test("reconciliation preserves a damaged event without blocking valid newer runs", async t => {
  const f = fixture(t);
  const original = await recordPostIngestionReview(f);
  writeFileSync(original.path, "broken evidence; do not replace");
  const second = addFinishedRun(f);
  const r = await reconcilePostIngestionReviews({ ...f, fromRunId: f.runId, limit: 1 });
  assert.equal(r.status, "warning");
  assert.deepEqual(r.failedRunIds, [f.runId]);
  assert.deepEqual(r.createdRunIds, [second]);
  assert.equal(readFileSync(original.path, "utf8"), "broken evidence; do not replace");
});

test("reconciliation isolates run validation failures and requires explicit safe boundaries", async t => {
  const f = fixture(t);
  f.database.db.prepare("UPDATE runs SET finished_at='2099-01-01T00:00:00Z' WHERE id=?").run(f.runId);
  const second = addFinishedRun(f);
  const r = await reconcilePostIngestionReviews({ ...f, fromRunId: f.runId });
  assert.deepEqual(r.failedRunIds, [f.runId]);
  assert.deepEqual(r.createdRunIds, [second]);
  await assert.rejects(reconcilePostIngestionReviews(f), /activation boundary/);
  await assert.rejects(reconcilePostIngestionReviews({ ...f, fromRunId: 1, limit: 1000 }), /between 1 and 100/);
});

test("pending reviews are oldest-first and cannot be hidden by newer completed runs", async t => {
  const f = fixture(t);
  await recordPostIngestionReview(f);
  for (let i = 0; i < 3; i += 1) {
    const runId = addFinishedRun(f);
    await recordPostIngestionReview({ ...f, runId });
    await completePostIngestionProductReview({ ...f, runId, evidence: ["review.md"] });
  }
  const result = await inspectPostIngestionReviews({ ledgerDir: f.ledgerDir, limit: 2 });
  assert.equal(result.totalPending, 1);
  assert.equal(result.totalCompleted, 3);
  assert.equal(result.reviews[0].runId, f.runId);
  assert.equal(result.reviews[0].productReviewStatus, "pending");
  assert.equal(result.completedReviews.length, 3);
  const pendingOnlyWindow = await inspectPostIngestionReviews({ ledgerDir: f.ledgerDir, limit: 1 });
  assert.equal(pendingOnlyWindow.reviews.length, 1);
  assert.equal(pendingOnlyWindow.completedReviews.length, 3, "recent completed reviews keep a separate display window");
});
