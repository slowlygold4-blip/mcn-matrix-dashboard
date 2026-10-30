import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, link, unlink, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { businessDateKey } from "./utils.mjs";
import { loadVerifiedWorksOnlyRows } from "./works-observation.mjs";
import {normalizePostIngestionSelection,selectPostIngestionFiles} from './post-ingestion-selection.mjs';

const VERSION = 1;
const COUNTERS = ["followers", "total_likes", "total_posts"];
const TOPIC_COUNTERS = ["hashtag_participants", "hashtag_views"];
const validCounter = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const usableQuality = (value) => ["validated", "warning"].includes(value);

function worksOnlyReview(db, run, now) {
  const rows = loadVerifiedWorksOnlyRows(db, now.toISOString(), null, { runId: run.id });
  const accepted = rows.filter(row => row.status === 'accepted');
  const complete = accepted.filter(row => row.works_coverage === 'complete');
  const limited = accepted.filter(row => row.works_coverage !== 'complete');
  let detail;
  try { detail = JSON.parse(db.prepare('SELECT details_json FROM runs WHERE id=?').get(run.id)?.details_json)?.[0]; } catch {}
  const attempted = rows.length ? rows.length : typeof detail?.attempted === 'boolean' ? Number(detail.attempted) : null;
  const findings = rows.length ? [
    ...limited.map(row => ({ code: 'works-only-limited-window', severity: 'warning', targetId: row.target_id })),
    ...rows.filter(row => row.status !== 'accepted').map(row => ({ code: 'works-only-unavailable', severity: 'warning', targetId: row.target_id })),
  ] : [{ code: 'no-run-bound-works-observation', severity: 'warning' }];
  return {
    version: VERSION, eventId: `collection-run-${run.id}`, runId: run.id, reviewedAt: now.toISOString(),
    businessDate: businessDateKey(run.finished_at), triggerType: run.trigger_type, runStatus: run.status,
    startedAt: run.started_at, finishedAt: run.finished_at, targetCount: run.target_count,
    snapshotCount: 0, worksObservationCount: rows.length, unattemptedCount: attempted === null ? null : Math.max(0, run.target_count - attempted),
    account: { attempted: 0, profileUsable: 0, missing: 0, worksComplete: complete.length,
      worksLimited: limited.length, worksUnavailable: rows.length - accepted.length },
    topics: { attempted: 0, usable: 0, missing: 0 },
    worksOnly: { attempted, persisted: rows.length, accepted: accepted.length, complete: complete.length,
      limited: limited.length, profileSampled: false },
    samples: rows.map(row => ({ targetId: row.target_id, type: 'works-only', snapshotId: null, auditId: null,
      observationId: row.observation_id, capturedAt: row.observed_at, attemptFinishedAt: row.request_finished_at,
      businessDate: row.observed_at ? businessDateKey(row.observed_at) : null, sourceChecksum: row.source_checksum,
      usable: row.status === 'accepted', worksCoverage: row.works_coverage, missingFields: [] })), findings,
    deterministicReview: { status: findings.length ? 'warning' : 'passed', checks: ['run-persisted', 'works-run-provenance',
      'null-not-zero', 'works-profile-separation', 'cursor-chain-inventory-match'] },
    metricPolicy: { missing: 'null-not-zero', accountPlays: 'estimated-only: net-like-change × 100', topicPlays: 'actual-hashtag-views-only', historyBackfill: 'forbidden' },
    productReview: { status: 'pending', tasks: ['backend-data-review', 'frontend-interaction-test'],
      note: '作品补采任务已完成规则审查，跨批完整度只来自通过校验的公开续页链与一致主页作品总量；没有新增主页快照，后续产品审查尚未执行。' },
  };
}

/** A deterministic audit receipt, not a claim that AI code review/development ran. */
export function buildPostIngestionReview({ database, runId, now = new Date() }) {
  if (!Number.isSafeInteger(Number(runId)) || Number(runId) <= 0) throw new Error("runId must be a positive integer");
  const db = database?.db || database;
  const run = db.prepare("SELECT id,trigger_type,started_at,finished_at,status,target_count FROM runs WHERE id=?").get(Number(runId));
  if (!run) throw new Error("Cannot review a missing collection run");
  if (!run.finished_at || run.status === "running") throw new Error("Cannot review before collection is persisted and finished");
  const reviewedAt = now.toISOString();
  if (!Number.isFinite(Date.parse(run.started_at)) || !Number.isFinite(Date.parse(run.finished_at))
    || Date.parse(run.finished_at) < Date.parse(run.started_at) || Date.parse(run.finished_at) > now.getTime()) {
    throw new Error("Collection run timestamps are invalid or in the future");
  }
  if (run.trigger_type === 'works-only') return worksOnlyReview(db, run, now);
  // Bind only evidence from this run's audit, target and checksum. A recent
  // historical snapshot alone is never proof that this run collected it.
  // Fail closed when a seconds-only timestamp predates a millisecond run start;
  // sharing a checksum with older history must never establish new coverage.
  const earliest = run.started_at;
  const rows = db.prepare(`
    SELECT a.id AS audit_id,a.target_id,a.status AS audit_status,a.created_at AS audited_at,
      t.type AS target_type,s.id AS snapshot_id,s.captured_at,s.quality_status,s.account_status,s.works_coverage,
      s.followers,s.total_likes,s.total_posts,s.hashtag_participants,s.hashtag_views,s.source_checksum
    FROM audits a LEFT JOIN targets t ON t.id=a.target_id
    LEFT JOIN snapshots s ON s.id=(SELECT candidate.id FROM snapshots candidate
      WHERE candidate.target_id=a.target_id AND candidate.source_checksum=a.source_checksum
        AND a.source_checksum IS NOT NULL AND a.source_checksum<>''
        AND julianday(candidate.captured_at)>=julianday(?)
        AND julianday(candidate.captured_at)<=julianday(a.created_at)
        AND julianday(candidate.captured_at)<=julianday(?)
      ORDER BY candidate.captured_at DESC,candidate.id DESC LIMIT 1)
    WHERE a.run_id=? AND julianday(a.created_at)>=julianday(?) AND julianday(a.created_at)<=julianday(?)
      AND a.id=(SELECT MAX(latest.id) FROM audits latest WHERE latest.run_id=a.run_id AND latest.target_id=a.target_id)
    ORDER BY a.target_id
  `).all(earliest, run.finished_at, run.id, earliest, run.finished_at);

  const account = { attempted: 0, profileUsable: 0, missing: 0, worksComplete: 0, worksLimited: 0, worksUnavailable: 0 };
  const topics = { attempted: 0, usable: 0, missing: 0 };
  const findings = [];
  const samples = [];
  for (const row of rows) {
    const isTopic = ["hashtag", "topic"].includes(row.target_type);
    const counters = isTopic ? TOPIC_COUNTERS : COUNTERS;
    const snapshotBound = row.snapshot_id !== null && row.snapshot_id !== undefined;
    const valid = snapshotBound && usableQuality(row.quality_status) && usableQuality(row.audit_status)
      && counters.every((field) => validCounter(row[field])) && (isTopic || ["available", "partial"].includes(row.account_status));
    const target = isTopic ? topics : account;
    target.attempted += 1;
    if (isTopic) target.usable += Number(valid);
    else target.profileUsable += Number(valid);
    target.missing += Number(!valid);
    if (!isTopic) {
      if (valid && row.works_coverage === "complete") account.worksComplete += 1;
      else if (valid && row.works_coverage === "limited") account.worksLimited += 1;
      else account.worksUnavailable += 1;
    }
    if (!valid) findings.push({ code: snapshotBound ? "incomplete-or-rejected-metrics" : "no-run-bound-snapshot", severity: "warning", targetId: row.target_id });
    if (!isTopic && valid && !["complete", "limited"].includes(row.works_coverage)) {
      findings.push({ code: "profile-only-works-unavailable", severity: "warning", targetId: row.target_id });
    }
    samples.push({ targetId: row.target_id, type: isTopic ? "topic" : "account", auditId: row.audit_id,
      snapshotId: row.snapshot_id ?? null, capturedAt: row.captured_at ?? null, businessDate: row.captured_at ? businessDateKey(row.captured_at) : null,
      sourceChecksum: row.source_checksum || null, usable: valid,
      worksCoverage: isTopic ? null : row.works_coverage || "unknown",
      missingFields: snapshotBound ? counters.filter((field) => !validCounter(row[field])) : [...counters],
    });
  }
  const unattemptedCount = Math.max(0, Number(run.target_count) - rows.length);
  if (unattemptedCount) findings.push({ code: "targets-without-run-audit", severity: "warning", count: unattemptedCount });
  if (!rows.length) findings.push({ code: "no-persisted-samples", severity: "warning" });
  return {
    version: VERSION, eventId: `collection-run-${run.id}`, runId: run.id, reviewedAt,
    businessDate: businessDateKey(run.finished_at), triggerType: run.trigger_type, runStatus: run.status,
    startedAt: run.started_at, finishedAt: run.finished_at, targetCount: run.target_count,
    snapshotCount: new Set(samples.map((sample) => sample.snapshotId).filter((id) => id !== null)).size,
    unattemptedCount, account, topics, samples, findings,
    deterministicReview: { status: findings.length ? "warning" : "passed", checks: ["run-persisted", "snapshot-provenance", "null-not-zero", "account-topic-separation", "works-profile-separation"] },
    metricPolicy: { missing: "null-not-zero", accountPlays: "estimated-only: net-like-change × 100", topicPlays: "actual-hashtag-views-only", historyBackfill: "forbidden" },
    productReview: { status: "pending", tasks: ["backend-data-review", "frontend-interaction-test", "visual-and-motion-review", "simulated-retention-review"],
      note: "数据审查已留档；产品与代码审查仍待 agent 执行，不代表真实用户留存测试完成。" },
  };
}

async function readReceipt(path, runId) {
  const receipt = JSON.parse(await readFile(path, "utf8"));
  if (receipt?.version !== VERSION || receipt?.runId !== Number(runId) || receipt?.eventId !== `collection-run-${runId}`) {
    throw new Error("Existing post-ingestion review is invalid; preserved without overwrite");
  }
  return receipt;
}

function receiptSummary(review) {
  return { runId: review.runId, businessDate: review.businessDate, reviewedAt: review.reviewedAt,
    snapshotCount: review.snapshotCount, dataReviewStatus: review.deterministicReview.status,
    productReviewStatus: review.productReview.status, account: review.account, topics: review.topics,
    findingCount: review.findings.length };
}

function receiptResult(status, path, review) { return { status, path, review, summary: receiptSummary(review) }; }

/** Atomic, first-writer-wins, immutable per-run receipt; never mutates source DB. */
export async function recordPostIngestionReview({ database, ledgerDir, runId, now = new Date() }) {
  if (!Number.isSafeInteger(Number(runId)) || Number(runId) <= 0) throw new Error("runId must be a positive integer");
  const directory = resolve(ledgerDir);
  const path = join(directory, `run-${Number(runId)}.json`);
  try { return receiptResult("existing", path, await readReceipt(path, runId)); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const review = buildPostIngestionReview({ database, runId, now });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.run-${Number(runId)}-${randomUUID()}.partial`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(review, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await link(temporary, path);
    return receiptResult("created", path, review);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return receiptResult("existing", path, await readReceipt(path, runId));
  } finally { await unlink(temporary); }
}

/** Bounded summary for a maintenance agent; receipts themselves retain detail. */
export async function inspectPostIngestionReviews({ ledgerDir, limit = 20, selection:inputSelection }) {
  const selection=normalizePostIngestionSelection(inputSelection);
  let files;
  try { files = await readdir(ledgerDir); }
  catch (error) { if (error?.code === "ENOENT") return { status: "empty", totalPending: 0, totalCompleted: 0, reviews: [], completedReviews: [],
    ...(selection?{pagination:selectPostIngestionFiles([],[],selection).pagination}:{}) }; throw error; }
  const events = files.filter((file) => /^run-\d+\.json$/.test(file));
  const completions = new Map();
  for (const file of files.filter((file) => /^reviewed-\d+\.json$/.test(file))) {
    const runId = Number(file.match(/\d+/)[0]);
    const completion = JSON.parse(await readFile(join(ledgerDir, file), "utf8"));
    if (completion.version !== VERSION || completion.runId !== runId || completion.status !== "completed"
      || !Array.isArray(completion.evidence) || !completion.evidence.length || !Number.isFinite(Date.parse(completion.completedAt))) {
      throw new Error("Invalid product-review completion receipt");
    }
    completions.set(runId, completion);
  }
  const eventId = (file) => Number(file.match(/\d+/)[0]);
  const pending = events.filter((file) => !completions.has(eventId(file))).sort((a, b) => eventId(a) - eventId(b));
  const completed = events.filter((file) => completions.has(eventId(file))).sort((a, b) => eventId(b) - eventId(a));
  const page=selection?selectPostIngestionFiles(pending,completed,selection):null;
  const selected = page?.selected??[...pending, ...completed].slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
  const reviews = [];
  for (const file of selected) {
    const value = await readReceipt(join(ledgerDir, file), Number(file.match(/\d+/)[0]));
    const summary = receiptSummary(value);
    const completion = completions.get(value.runId);
    if (completion) {
      summary.productReviewStatus = "completed";
      summary.productReviewedAt = completion.completedAt;
      summary.productReviewEvidence = completion.evidence;
    }
    reviews.push(summary);
  }
  const completedReviews = [];
  for (const file of completed.slice(0, 5)) {
    const runId = eventId(file);
    const existing = reviews.find((review) => review.runId === runId);
    if (existing) { completedReviews.push(existing); continue; }
    const completion = completions.get(runId);
    const summary = receiptSummary(await readReceipt(join(ledgerDir, file), runId));
    completedReviews.push({ ...summary, productReviewStatus: "completed", productReviewedAt: completion.completedAt,
      productReviewEvidence: completion.evidence });
  }
  return { status: reviews.length ? "ok" : "empty", totalPending: pending.length, totalCompleted: completed.length,
    reviews, completedReviews,...(page?{pagination:page.pagination}:{}) };
}

/** Record actual agent review evidence separately; never edits the input event. */
export async function completePostIngestionProductReview({ ledgerDir, runId, evidence, now = new Date() }) {
  if (!Number.isSafeInteger(Number(runId)) || Number(runId) <= 0) throw new Error("runId must be a positive integer");
  if (!Array.isArray(evidence) || !evidence.length || evidence.length > 20) {
    throw new Error("Product review requires 1–20 explicit evidence references");
  }
  for (let index = 0; index < evidence.length; index += 1) {
    // Array.prototype.some/map skip sparse slots. Check ownership explicitly
    // so a sparse array cannot produce a completion receipt containing nulls.
    if (!Object.prototype.hasOwnProperty.call(evidence, index)) {
      throw new Error("Product review requires 1–20 explicit evidence references");
    }
    const item = evidence[index];
    if (typeof item !== "string" || !item.trim() || item.length > 500 || /[\u0000-\u001f]/.test(item)) {
      throw new Error("Product review requires 1–20 explicit evidence references");
    }
  }
  const original = await readReceipt(join(ledgerDir, `run-${Number(runId)}.json`), runId);
  if (now.getTime() < Date.parse(original.reviewedAt)) throw new Error("Product review cannot precede the ingestion review");
  const completion = { version: VERSION, runId: Number(runId), status: "completed", completedAt: now.toISOString(),
    evidence: evidence.map((item) => item.trim()), meaning: "Agent review performed; not a claim that all findings were fixed or real-user retention was measured" };
  const path = join(ledgerDir, `reviewed-${Number(runId)}.json`);
  const temporary = join(ledgerDir, `.reviewed-${Number(runId)}-${randomUUID()}.partial`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(completion, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try { await link(temporary, path); return { status: "created", path, completion }; }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = JSON.parse(await readFile(path, "utf8"));
    if (existing.version !== VERSION || existing.runId !== Number(runId) || existing.status !== "completed") throw new Error("Existing review completion is invalid; preserved");
    return { status: "existing", path, completion: existing };
  } finally { await unlink(temporary); }
}

/** Recover missed callbacks from an explicit activation boundary, never all old history by accident. */
export async function reconcilePostIngestionReviews({ database, ledgerDir, fromRunId, limit = 50, scanLimit, now = new Date() }) {
  if (!Number.isSafeInteger(Number(fromRunId)) || Number(fromRunId) <= 0) throw new Error("fromRunId must be an explicit positive activation boundary");
  if (!Number.isSafeInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 100) throw new Error("Review reconciliation limit must be between 1 and 100");
  const db = database?.db || database;
  if (scanLimit !== undefined) {
    if (!Number.isSafeInteger(scanLimit) || scanLimit < 1 || scanLimit > 1000) {
      throw new Error("Review reconciliation scanLimit must be an integer between 1 and 1000");
    }
    return reconcilePostIngestionReviewPage({ database, db, ledgerDir, fromRunId: Number(fromRunId), limit: Number(limit), scanLimit, now });
  }

  // Preserve the original unpaged behavior for existing callers. Startup
  // recovery can opt into bounded pages without silently changing legacy
  // response fields or its historical scan semantics.
  const runs = db.prepare("SELECT id FROM runs WHERE id>=? AND finished_at IS NOT NULL AND status<>'running' ORDER BY id ASC").all(Number(fromRunId));
  const createdRunIds = [], existingRunIds = [], pendingRunIds = [], failedRunIds = [];
  let attemptedCount = 0;
  for (const run of runs) {
    try {
      await readReceipt(join(ledgerDir, `run-${run.id}.json`), run.id);
      existingRunIds.push(run.id);
      continue;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // Preserve bad receipts and keep checking other runs. An invalid
        // receipt does not consume the creation budget or starve newer runs.
        failedRunIds.push(run.id);
        continue;
      }
    }
    if (attemptedCount >= Number(limit)) { pendingRunIds.push(run.id); continue; }
    attemptedCount += 1;
    try {
      const result = await recordPostIngestionReview({ database, ledgerDir, runId: run.id, now });
      (result.status === "created" ? createdRunIds : existingRunIds).push(run.id);
    } catch {
      // Errors may include provider/DB details; expose IDs only. The caller
      // can diagnose locally without publishing credentials in status APIs.
      failedRunIds.push(run.id);
    }
  }
  return { status: failedRunIds.length ? "warning" : pendingRunIds.length ? "pending" : "ok",
    fromRunId: Number(fromRunId), scannedCount: runs.length, attemptedCount,
    createdRunIds, existingRunIds, pendingRunIds, failedRunIds,
    nextFromRunId: pendingRunIds[0] ?? null };
}

/**
 * Scan at most `scanLimit` indexed run rows. Open rows form a barrier: return
 * their cursor instead of skipping ahead, so recovery can resume once the
 * collection has durably reached a terminal state. Failed or creation-limited
 * rows likewise remain the earliest resume cursor. The caller owns pagination
 * and must stop if the cursor does not advance (for example, a preserved bad
 * receipt or an open run).
 */
async function reconcilePostIngestionReviewPage({ database, db, ledgerDir, fromRunId, limit, scanLimit, now }) {
  const runs = db.prepare("SELECT id,status,finished_at FROM runs WHERE id>=? ORDER BY id ASC LIMIT ?")
    .all(fromRunId, scanLimit);
  const createdRunIds = [], existingRunIds = [], pendingRunIds = [], failedRunIds = [], openRunIds = [];
  let attemptedCount = 0;

  for (const run of runs) {
    if (run.status === "running" || !run.finished_at) {
      openRunIds.push(run.id);
      break;
    }
    try {
      await readReceipt(join(ledgerDir, `run-${run.id}.json`), run.id);
      existingRunIds.push(run.id);
      continue;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // Invalid receipts are immutable evidence: report and retain their
        // cursor, but continue examining this bounded page for independent
        // runs. The caller stops when retrying would not advance the cursor.
        failedRunIds.push(run.id);
        continue;
      }
    }
    if (attemptedCount >= limit) {
      pendingRunIds.push(run.id);
      continue;
    }
    attemptedCount += 1;
    try {
      const result = await recordPostIngestionReview({ database, ledgerDir, runId: run.id, now });
      (result.status === "created" ? createdRunIds : existingRunIds).push(run.id);
    } catch {
      // Do not expose DB/provider details (which may contain credentials) in
      // queue status; preserve just the failed run's retry cursor.
      failedRunIds.push(run.id);
    }
  }

  const unresolvedRunIds = [...failedRunIds, ...pendingRunIds, ...openRunIds].sort((a, b) => a - b);
  let nextFromRunId = unresolvedRunIds[0] ?? null;
  if (nextFromRunId === null && runs.length === scanLimit) {
    // The primary-key cursor makes the next call seek directly to the next
    // page. If IDs have gaps this remains correct; an empty next page returns
    // null without scanning older rows.
    nextFromRunId = Number(runs.at(-1).id) + 1;
  }
  return {
    status: failedRunIds.length ? "warning" : nextFromRunId !== null ? "pending" : "ok",
    fromRunId, scanLimit, scannedCount: runs.length, attemptedCount,
    createdRunIds, existingRunIds, pendingRunIds, failedRunIds, openRunIds, nextFromRunId,
  };
}

/** Viewer status needs operational counts, not thousands of per-run identifiers. */
export function summarizePostIngestionReviewQueue(queueStatus) {
  if (!queueStatus || typeof queueStatus !== "object" || Array.isArray(queueStatus)) return null;
  const summary = {};
  for (const [key, value] of Object.entries(queueStatus)) {
    if (!key.endsWith("RunIds")) {
      summary[key] = value;
      continue;
    }
    const countKey = `${key.slice(0, -"RunIds".length)}Count`;
    if (!Object.hasOwn(summary, countKey)) summary[countKey] = Array.isArray(value) ? value.length : null;
  }
  return summary;
}
