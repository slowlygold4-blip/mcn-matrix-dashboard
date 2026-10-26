import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspectSourcePollManifest, completedSourceJobSummary, MAX_SOURCE_JOB_READTHROUGH } from "../lib/source-poller-status.mjs";
import { completedSourceJobSummary as scriptSummary } from "../scripts/source-poller.mjs";

const observed = new Date("2026-09-28T11:45:00Z");
const binding = { sourceUrl: "https://example.feishu.cn/sheets/TEST", sourceSheetId: "sheet-a", sheetName: "Sheet1", defaultBoard: "团团" };
const job = (id, result = { createdCount: 0, reusedExistingCount: 12, reviewRequiredCount: 3, queuedEvidenceRequestCount: 2 }) => ({ id, status: "completed", finishedAt: "2026-09-27T20:00:00Z", result, request: { ...binding } });
function fixture(t, sources) {
  const dir = mkdtempSync(join(tmpdir(), "source-readthrough-"));
  const path = join(dir, "manifest.json");
  const sourceMap = Object.fromEntries(sources.map((s, i) => [String(i), { key: String(i), lastStatus: "submitted", lastCheckedAt: observed.toISOString(), ...binding, ...s }]));
  writeFileSync(path, JSON.stringify({ sources: sourceMap }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path, before: readFileSync(path, "utf8") };
}

test("legacy missing summary reads completed job through readonly SQLite without modifying manifest or rows", (t) => {
  const f = fixture(t, [{ lastJobId: "job-a" }]);
  const path = join(f.dir, "jobs.sqlite");
  const writer = new DatabaseSync(path);
  writer.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY, value TEXT)");
  writer.prepare("INSERT INTO jobs VALUES (?,?)").run("job-a", JSON.stringify({ ...job("job-a"), request: { ...binding, cookie: "PRIVATE" }, result: { ...job("job-a").result, skipped: [{ token: "PRIVATE" }] } }));
  writer.close();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const before = db.prepare("SELECT value FROM jobs WHERE id=?").get("job-a").value;
    const result = inspectSourcePollManifest(f.path, { now: observed, lookupCompletedJob: (id) => JSON.parse(db.prepare("SELECT value FROM jobs WHERE id=?").get(id).value) });
    const s = result.sources[0].sourceJobSummary;
    assert.equal(s.jobId, "job-a"); assert.equal(s.createdAccountCount, 0); assert.equal(s.reusedExistingRowCount, 12);
    assert.equal(s.reviewRequiredItemCount, 3); assert.equal(s.queuedEvidenceRequestCount, 2);
    assert.equal(s.businessStatus, "pending"); assert.equal(result.businessSummaryMissingCount, 0);
    assert.match(s.scope, /not-live/); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|"cookie"|"skipped"|"request"/);
    assert.equal(db.prepare("SELECT value FROM jobs WHERE id=?").get("job-a").value, before);
    assert.equal(readFileSync(f.path, "utf8"), f.before);
  } finally { db.close(); }
});

test("failed, running, missing, mismatched, future and incomplete completed jobs stay unknown", (t) => {
  const invalid = [null, { ...job("job-a"), status: "running" }, { ...job("job-a"), status: "failed" }, job("other"), { ...job("job-a"), id: undefined }, { ...job("job-a"), result: null }, { ...job("job-a"), finishedAt: undefined }, { ...job("job-a"), finishedAt: "2099-01-01T00:00:00Z" }, job("job-a", {})];
  const f = fixture(t, [{ lastJobId: "job-a" }]);
  for (const value of invalid) {
    const result = inspectSourcePollManifest(f.path, { now: observed, lookupCompletedJob: () => value });
    assert.equal(result.sources[0].sourceJobSummary, null); assert.equal(result.businessSummaryMissingCount, 1);
  }
  assert.equal(inspectSourcePollManifest(f.path, { now: observed, lookupCompletedJob: () => { throw new Error("PRIVATE"); } }).sources[0].sourceJobSummary, null);
  assert.equal(readFileSync(f.path, "utf8"), f.before);
});

test("zeros survive and unavailable counts remain null rather than fabricated zeros", (t) => {
  const f = fixture(t, [{ lastJobId: "job-a" }]);
  const result = inspectSourcePollManifest(f.path, { now: observed, lookupCompletedJob: () => job("job-a", { createdCount: 0, reusedExistingCount: 0 }) });
  const s = result.sources[0].sourceJobSummary;
  assert.equal(s.createdAccountCount, 0); assert.equal(s.reusedExistingRowCount, 0);
  assert.equal(s.reviewRequiredItemCount, null); assert.equal(s.queuedEvidenceRequestCount, null); assert.equal(s.businessStatus, "unknown");
});

test("legacy mixed-unit queuedAuthors is not promoted to evidence-request counts", (t) => {
  const f = fixture(t, [{ lastJobId: "job-a" }]);
  for (const queuedAuthors of [0, 790]) {
    const result = inspectSourcePollManifest(f.path, { now: observed, lookupCompletedJob: () => job("job-a", { createdCount: 0, reviewRequiredCount: 0, queuedAuthors }) });
    const summary = result.sources[0].sourceJobSummary;
    assert.equal(summary.queuedEvidenceRequestCount, null);
    assert.equal(summary.businessStatus, "unknown");
  }
  const explicit = completedSourceJobSummary(job("job-a", { createdCount: 0, reviewRequiredCount: 0, queuedAuthors: 790, queuedEvidenceRequestCount: 0 }), "job-a", observed.toISOString());
  assert.equal(explicit.queuedEvidenceRequestCount, 0);
  assert.equal(explicit.businessStatus, "no-pending-reported");
  assert.equal(readFileSync(f.path, "utf8"), f.before);
});

test("valid or damaged stored summaries are preserved, never silently replaced by readthrough", (t) => {
  const stored = completedSourceJobSummary(job("old"), "old", "2026-09-27T20:01:00Z");
  const f = fixture(t, [{ lastJobId: "old", sourceJobSummary: stored }, { lastJobId: "new", sourceJobSummary: stored }]);
  let calls = 0;
  const result = inspectSourcePollManifest(f.path, { now: observed, lookupCompletedJob: () => { calls++; return job("new"); } });
  assert.equal(calls, 0); assert.deepEqual(result.sources[0].sourceJobSummary, stored); assert.equal(result.sources[1].sourceJobSummary, null);
  assert.equal(readFileSync(f.path, "utf8"), f.before);
});

test("unmarked persisted legacy queue count remains unknown without replacing other history", (t) => {
  const stored = completedSourceJobSummary(job("old"), "old", "2026-09-27T20:01:00Z");
  delete stored.queuedEvidenceRequestCountContract;
  stored.queuedEvidenceRequestCount = 790;
  const f = fixture(t, [{ lastJobId: "old", sourceJobSummary: stored }]);
  const result = inspectSourcePollManifest(f.path, { now: observed, lookupCompletedJob: () => { throw new Error("must not replace stored history"); } });
  const summary = result.sources[0].sourceJobSummary;
  assert.equal(summary.queuedEvidenceRequestCount, null);
  assert.equal(summary.createdAccountCount, 0);
  assert.equal(summary.reusedExistingRowCount, 12);
  assert.equal(summary.reviewRequiredItemCount, 3);
  assert.equal(readFileSync(f.path, "utf8"), f.before);
});

test("lookup is deduplicated and bounded to 50 unique safe job IDs", (t) => {
  const sources = [{ lastJobId: "same" }, { lastJobId: "same" }, { lastJobId: "token=PRIVATE&bad" }, ...Array.from({ length: 55 }, (_, i) => ({ lastJobId: `job-${i}` }))];
  const f = fixture(t, sources); const calls = [];
  const result = inspectSourcePollManifest(f.path, { now: observed, lookupCompletedJob: (id) => { calls.push(id); return job(id); } });
  assert.equal(calls.length, MAX_SOURCE_JOB_READTHROUGH); assert.equal(new Set(calls).size, calls.length);
  assert.equal(calls.includes("token=PRIVATE&bad"), false); assert.equal(result.sources[0].sourceJobSummary, result.sources[1].sourceJobSummary);
  assert.ok(result.businessSummaryMissingCount > 0);
});

test("script compatibility export and server wiring do not weaken job detail role checks", () => {
  assert.equal(scriptSummary, completedSourceJobSummary);
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.equal((server.match(/lookupCompletedJob: \(id\) => database\.getAuthorResolutionJob\(id\)/g) || []).length, 2);
  const route = server.slice(server.indexOf('const authorResolveJobMatch ='), server.indexOf('if (request.method === "POST" && pathname === "/api/author-spreadsheet/commit")'));
  assert.match(route, /access\.requireRole\(request, "editor"\)/);
  assert.match(route, /job\.userId !== request\.auth\.user\.id && request\.auth\.user\.role !== "admin"/);
});

test("same job id cannot lend a different URL, sheet or board its historical summary", (t) => {
  const f = fixture(t, [{ lastJobId: "job-a" }, { lastJobId: "job-a", sourceUrl: "https://wrong.feishu.cn/sheets/OTHER" }, { lastJobId: "job-a", sourceSheetId: "WRONG" }, { lastJobId: "job-a", defaultBoard: "WRONG" }, { lastJobId: "job-a", defaultBoard: "" }]);
  let calls = 0;
  const result = inspectSourcePollManifest(f.path, { now: observed, lookupCompletedJob: () => { calls++; return job("job-a"); } });
  assert.equal(calls, 1); assert.ok(result.sources[0].sourceJobSummary);
  assert.ok(result.sources.slice(1).every((source) => source.sourceJobSummary === null));
  for (const request of [{}, { ...binding, sourceUrl: undefined }, { ...binding, sheetName: "WRONG" }]) {
    assert.ok(inspectSourcePollManifest(f.path, { now: observed, lookupCompletedJob: () => ({ ...job("job-a"), request }) }).sources.every((source) => source.sourceJobSummary === null));
  }
  assert.equal(readFileSync(f.path, "utf8"), f.before);
});
