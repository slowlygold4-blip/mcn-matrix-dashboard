import { reconcilePostIngestionReviews } from "./post-ingestion-review.mjs";

function checkedRecoveryRunId(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${field} recovery run ID`);
  return value;
}

/** Validate and calculate the durable startup-recovery cursor without I/O. */
export function nextPostIngestionRecoveryCursor({ activationRunId, currentRunId, result } = {}) {
  const activation = checkedRecoveryRunId(activationRunId, "activation");
  const current = checkedRecoveryRunId(currentRunId, "current");
  if (current < activation) throw new Error("Recovery cursor cannot precede its activation boundary");
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid recovery page result");

  const runIdLists = ["createdRunIds", "existingRunIds", "pendingRunIds", "failedRunIds", "openRunIds"];
  const lists = Object.fromEntries(runIdLists.map(key => {
    if (!Array.isArray(result[key])) throw new Error(`Invalid ${key} recovery IDs`);
    const ids = result[key].map((value, index) => checkedRecoveryRunId(value, `${key}[${index}]`));
    if (ids.some(id => id < activation)) throw new Error(`${key} contains a run before the activation boundary`);
    return [key, ids];
  }));
  if (!Number.isSafeInteger(result.scannedCount) || result.scannedCount < 0) throw new Error("Invalid scanned recovery row count");
  if (!Object.hasOwn(result, "nextFromRunId")) throw new Error("Recovery page is missing its next cursor");

  const blockers = [...lists.failedRunIds, ...lists.pendingRunIds, ...lists.openRunIds];
  const earliestBlocker = blockers.length ? Math.min(...blockers) : null;
  const classifiedIds = [...lists.createdRunIds, ...lists.existingRunIds, ...blockers];
  if (new Set(classifiedIds).size !== classifiedIds.length) throw new Error("Recovery result classifies a run more than once");
  if (result.scannedCount < classifiedIds.length
    || (!lists.openRunIds.length && result.scannedCount !== classifiedIds.length)) {
    throw new Error("Recovery result does not classify every scanned run without an open-run barrier");
  }
  if (lists.openRunIds.length > 1) throw new Error("Recovery result crossed more than one open-run barrier");
  const rawNext = result.nextFromRunId;
  if (rawNext !== null) {
    const next = checkedRecoveryRunId(rawNext, "next");
    if (next < activation || next < current) throw new Error("Recovery cursor cannot move backward or skip its activation boundary");
    if (earliestBlocker !== null && next !== earliestBlocker) {
      throw new Error("Recovery cursor must preserve the earliest failed, pending, or open run");
    }
    const processed = [...lists.createdRunIds, ...lists.existingRunIds];
    if (earliestBlocker === null && processed.length) {
      if (next !== Math.max(...processed) + 1) {
        throw new Error("Recovery continuation must immediately follow all processed runs without skipping IDs");
      }
    } else if (earliestBlocker === null && next !== current) {
      throw new Error("Recovery cannot advance without examining any runs");
    }
    return next;
  }

  if (earliestBlocker !== null) throw new Error("Recovery cannot complete while failed, pending, or open runs remain");
  const processed = [...lists.createdRunIds, ...lists.existingRunIds];
  if (!processed.length) return current;
  const next = Math.max(...processed) + 1;
  checkedRecoveryRunId(next, "completed");
  if (next < current) throw new Error("Completed recovery cursor cannot move backward");
  return next;
}

// Startup recovery has separate total scan/creation budgets. Normal run
// completion uses recordPostIngestionReview, never this historical sweep.
export async function recoverPostIngestionReviewWindow({ database, ledgerDir, fromRunId,
  creationLimit = 50, scanLimit = 1000, maxPages = 8, now = new Date(),
  shouldStop = () => false, reconcile = reconcilePostIngestionReviews }) {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20) throw new Error("Invalid recovery page budget");
  if (!Number.isSafeInteger(creationLimit) || creationLimit < 1 || creationLimit > 100) throw new Error("Invalid recovery creation budget");
  const keys = ["createdRunIds", "existingRunIds", "pendingRunIds", "failedRunIds", "openRunIds"];
  const collected = Object.fromEntries(keys.map(key => [key, new Set()]));
  let cursor = fromRunId, scannedCount = 0, attemptedCount = 0, pageCount = 0;
  while (cursor !== null && pageCount < maxPages && attemptedCount < creationLimit && !shouldStop()) {
    const page = await reconcile({ database, ledgerDir, fromRunId: cursor,
      limit: creationLimit - attemptedCount, scanLimit, now });
    pageCount += 1;
    scannedCount += page.scannedCount;
    attemptedCount += page.attemptedCount;
    for (const key of keys) for (const runId of page[key] || []) collected[key].add(runId);
    const next = page.nextFromRunId;
    const blocked = page.failedRunIds.length || page.pendingRunIds.length || page.openRunIds?.length;
    // A bad immutable receipt, exhausted creation budget or active run must
    // remain visible, not become an unbounded retry loop during startup.
    if (next !== null && (blocked || next <= cursor)) { cursor = next; break; }
    cursor = next;
  }
  const ids = Object.fromEntries(keys.map(key => [key, [...collected[key]]]));
  return { status: ids.failedRunIds.length ? "warning" : cursor !== null ? "pending" : "ok",
    fromRunId, scanLimit, maxPages, pageCount, scannedCount, attemptedCount, ...ids,
    recoveryIncomplete: cursor !== null, nextFromRunId: cursor };
}
