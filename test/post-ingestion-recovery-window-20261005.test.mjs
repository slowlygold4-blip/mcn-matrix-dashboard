import test from "node:test";
import assert from "node:assert/strict";
import { nextPostIngestionRecoveryCursor, recoverPostIngestionReviewWindow } from "../lib/post-ingestion-recovery.mjs";

const page = (nextFromRunId, extra = {}) => ({ scannedCount: 1000, attemptedCount: 0,
  createdRunIds: [], existingRunIds: [], pendingRunIds: [], failedRunIds: [], openRunIds: [], nextFromRunId, ...extra });
const cursorPage = (nextFromRunId, extra = {}) => {
  const result = page(nextFromRunId, extra);
  result.scannedCount = ["createdRunIds", "existingRunIds", "pendingRunIds", "failedRunIds", "openRunIds"]
    .reduce((count, key) => count + result[key].length, 0);
  return result;
};

test("durable cursor preserves the earliest failed, pending, or open run and advances only completed work", () => {
  const activationRunId = 755;
  assert.equal(nextPostIngestionRecoveryCursor({ activationRunId, currentRunId: 755,
    result: cursorPage(760, { failedRunIds: [760], pendingRunIds: [761], openRunIds: [762] }) }), 760);
  assert.equal(nextPostIngestionRecoveryCursor({ activationRunId, currentRunId: 760,
    result: cursorPage(760, { failedRunIds: [760] }) }), 760, "an unresolved cursor remains at its original ID");
  assert.equal(nextPostIngestionRecoveryCursor({ activationRunId, currentRunId: 755,
    result: cursorPage(1001, { createdRunIds: [755, 999], existingRunIds: [756, 1000] }) }), 1001,
  "a completed page continuation is retained until the window reaches its end");
  assert.equal(nextPostIngestionRecoveryCursor({ activationRunId, currentRunId: 755,
    result: cursorPage(null, { createdRunIds: [755, 757], existingRunIds: [756, 758] }) }), 759,
  "completion advances exactly one past the greatest durably reviewed run");
  assert.equal(nextPostIngestionRecoveryCursor({ activationRunId, currentRunId: 900,
    result: cursorPage(null) }), 900, "an empty completed window retains the safe current cursor");
  assert.equal(nextPostIngestionRecoveryCursor({ activationRunId, currentRunId: 900,
    result: cursorPage(900) }), 900, "shutdown before the first page retains, but does not advance, the cursor");
});

test("durable cursor rejects backward, unsafe, skipped, or falsely completed results", () => {
  const activationRunId = 755;
  const cursor = args => () => nextPostIngestionRecoveryCursor({ activationRunId, currentRunId: 760, ...args });
  assert.throws(cursor({ result: cursorPage(759) }), /backward|activation/i);
  assert.throws(cursor({ result: cursorPage(-1) }), /next recovery run ID/i);
  assert.throws(cursor({ result: cursorPage(Number.MAX_SAFE_INTEGER + 1) }), /next recovery run ID/i);
  assert.throws(cursor({ result: cursorPage(762, { failedRunIds: [760], pendingRunIds: [761] }) }), /earliest failed/i);
  assert.throws(cursor({ result: cursorPage(9999, { createdRunIds: [755], existingRunIds: [756] }) }), /without skipping IDs/i);
  assert.throws(cursor({ result: cursorPage(null, { openRunIds: [760] }) }), /cannot complete/i);
  assert.throws(cursor({ result: cursorPage(null, { createdRunIds: [755] }) }), /backward/i);
  assert.throws(cursor({ result: cursorPage(1000) }), /cannot advance without examining/i);
  assert.throws(cursor({ result: { nextFromRunId: null } }), /createdRunIds/i);
  assert.throws(cursor({ result: { ...cursorPage(null), scannedCount: 1 } }), /classify every scanned/i);
  assert.throws(() => nextPostIngestionRecoveryCursor({ activationRunId: 760, currentRunId: 759, result: cursorPage(null) }), /activation boundary/i);
});

test("startup history work stops at its total page budget without claiming a complete recovery", async () => {
  const calls = [];
  const result = await recoverPostIngestionReviewWindow({ fromRunId: 1, maxPages: 3,
    reconcile: async opts => { calls.push(opts); return page(opts.fromRunId + 1000); } });
  assert.equal(calls.length, 3); assert.equal(result.scannedCount, 3000);
  assert.equal(result.status, "pending"); assert.equal(result.recoveryIncomplete, true);
  assert.equal(result.nextFromRunId, 3001);
  assert.ok(calls.every(call => call.scanLimit === 1000 && call.limit === 50));
});

test("startup creation budget is shared across pages and never multiplied by the page count", async () => {
  const limits = [];
  const result = await recoverPostIngestionReviewWindow({ fromRunId: 1, creationLimit: 5,
    reconcile: async opts => {
      limits.push(opts.limit);
      return limits.length === 1 ? page(1001, { attemptedCount: 3, createdRunIds: [1, 2, 3] })
        : page(1004, { attemptedCount: 2, createdRunIds: [1001, 1002], pendingRunIds: [1004] });
    } });
  assert.deepEqual(limits, [5, 2]); assert.equal(result.attemptedCount, 5);
  assert.equal(result.nextFromRunId, 1004); assert.equal(result.status, "pending");
});

test("preserved failed/open receipts stop the startup loop at the exact unresolved cursor", async () => {
  for (const [key, status] of [["failedRunIds", "warning"], ["openRunIds", "pending"]]) {
    let calls = 0;
    const result = await recoverPostIngestionReviewWindow({ fromRunId: 100,
      reconcile: async () => { calls += 1; return page(123, { [key]: [123] }); } });
    assert.equal(calls, 1); assert.equal(result.nextFromRunId, 123); assert.equal(result.status, status);
  }
});

test("shutdown prevents new recovery pages and terminal recovery preserves created/existing IDs", async () => {
  let calls = 0;
  const stopped = await recoverPostIngestionReviewWindow({ fromRunId: 100, shouldStop: () => calls > 0,
    reconcile: async () => { calls += 1; return page(1100); } });
  assert.equal(calls, 1); assert.equal(stopped.recoveryIncomplete, true);
  const done = await recoverPostIngestionReviewWindow({ fromRunId: 100,
    reconcile: async () => page(null, { scannedCount: 2, attemptedCount: 1, createdRunIds: [101], existingRunIds: [100] }) });
  assert.equal(done.status, "ok"); assert.equal(done.recoveryIncomplete, false);
  assert.deepEqual(done.createdRunIds, [101]); assert.deepEqual(done.existingRunIds, [100]);
});
