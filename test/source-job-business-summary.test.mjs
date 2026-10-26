import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { projectSourceJobSummary, inspectSourcePollManifest } from "../lib/source-poller-status.mjs";
import { completedSourceJobSummary } from "../scripts/source-poller.mjs";

test("business summary separates completed jobs from pending rows and keeps only safe counts", () => {
  const summary = completedSourceJobSummary({ id: "job-1", status: "completed", finishedAt: "2026-09-28T02:00:00Z", result: {
    createdCount: 0, reusedExistingCount: 47, reviewRequiredCount: 2, queuedEvidenceRequestCount: 1,
    skipped: [{ name: "PRIVATE-NAME", access_token: "SECRET" }], cookie: "SECRET", raw: "SECRET",
  } }, "job-1", "2026-09-28T02:01:00Z");
  assert.equal(summary.createdAccountCount, 0);
  assert.equal(summary.reusedExistingRowCount, 47);
  assert.equal(summary.reviewRequiredItemCount, 2);
  assert.equal(summary.queuedEvidenceRequestCount, 1);
  assert.equal(summary.businessStatus, "pending");
  assert.match(summary.units.queuedEvidenceRequestCount, /not-distinct-authors/);
  assert.doesNotMatch(JSON.stringify(summary), /SECRET|PRIVATE-NAME/);
  assert.deepEqual(projectSourceJobSummary({ ...summary, secret: "SECRET", skipped: ["PRIVATE"] }), summary);
});

test("unavailable, invalid or mismatched job summaries never manufacture historical zeros", () => {
  assert.equal(completedSourceJobSummary({ status: "running", result: { createdCount: 0 } }, "j"), null);
  assert.equal(completedSourceJobSummary({ status: "completed" }, "j"), null);
  assert.equal(completedSourceJobSummary({ id: "other", status: "completed", result: { createdCount: 1 } }, "j"), null);
  assert.equal(completedSourceJobSummary({ status: "completed", result: { createdCount: "0", reusedExistingCount: -1 } }, "j"), null);
  const partial = completedSourceJobSummary({ status: "completed", result: { createdCount: 0 } }, "j");
  assert.equal(partial.createdAccountCount, 0); assert.equal(partial.reviewRequiredItemCount, null);
  assert.equal(partial.queuedEvidenceRequestCount, null); assert.equal(partial.businessStatus, "unknown");
  const noPending = completedSourceJobSummary({ status: "completed", result: { createdCount: 0, reusedExistingCount: 0, reviewRequiredCount: 0, queuedEvidenceRequestCount: 0 } }, "j");
  assert.equal(noPending.businessStatus, "no-pending-reported");
  assert.match(noPending.note, /不证明已取得首次采样/);
});

test("a real completed GET persists business summary without rereading cloud or reposting the job", async t => {
  const directory = await mkdtemp(join(tmpdir(), "source-business-summary-"));
  const folder = join(directory, "source-poll"); await mkdir(folder);
  const manifestPath = join(folder, "manifest.json");
  const finished = "2026-09-27T16:00:00.000Z";
  await writeFile(manifestPath, JSON.stringify({ lastFinishedAt: finished, sources: {
    old: { key: "old", sourceUrl: "https://fixture.feishu.cn/sheets/Old", lastStatus: "submitted", lastJobId: "historical-job", lastCheckedAt: finished },
    pending: { key: "pending", sourceUrl: "https://fixture.feishu.cn/sheets/New", lastStatus: "pending", lastJobId: "job-1",
      sourceSha256: "a".repeat(64), lastCheckedAt: finished },
  } }));
  let gets = 0;
  const server = createServer((request, response) => {
    assert.equal(request.method, "GET"); assert.equal(request.url, "/api/author-spreadsheet/jobs/job-1"); gets++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "job-1", status: "completed", result: {
      createdCount: 0, reusedExistingCount: 48, reviewRequiredCount: 468, queuedEvidenceRequestCount: 466,
      skipped: [{ name: "PRIVATE" }], cookie: "SECRET",
    } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const oldData = process.env.DATA_DIR, oldBase = process.env.SOURCE_POLL_BASE_URL;
  process.env.DATA_DIR = directory; process.env.SOURCE_POLL_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const { pollOnce } = await import(`../scripts/source-poller.mjs?business=${randomUUID()}`);
  if (oldData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldData;
  if (oldBase === undefined) delete process.env.SOURCE_POLL_BASE_URL; else process.env.SOURCE_POLL_BASE_URL = oldBase;
  const result = await pollOnce({ session: { headers: {}, bootstrap: { authorSources: [] } }, resumePendingOnly: true });
  assert.equal(gets, 1);
  assert.equal(result.processedSourceCount, 1);
  assert.equal(result.importedSourceCount, 1); assert.equal(result.importedSourceCountDeprecated, true);
  assert.equal(result.pendingCount, 0); assert.equal(result.businessPendingCount, 1); assert.equal(result.status, "warning");
  assert.equal(result.sources[0].sourceJobSummary.queuedEvidenceRequestCount, 466);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.lastFinishedAt, finished);
  assert.equal(manifest.sources.old.sourceJobSummary, undefined, "never invent old completed job results");
  assert.equal(manifest.sources.pending.lastStatus, "submitted");
  assert.equal(manifest.sources.pending.sourceSha256, "a".repeat(64));
  assert.equal(manifest.sources.pending.sourceJobSummary.createdAccountCount, 0);
  const status = inspectSourcePollManifest(manifestPath);
  assert.equal(status.businessPendingCount, 1); assert.equal(status.businessSummaryMissingCount, 1);
  assert.doesNotMatch(JSON.stringify(manifest), /PRIVATE|SECRET/);
});
