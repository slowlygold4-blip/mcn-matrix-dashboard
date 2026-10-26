import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectSourcePollManifest, sourcePollKey } from "../lib/source-poller-status.mjs";

test("source poll status exposes durable failures without source credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "source-poller-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "manifest.json");
  assert.equal(inspectSourcePollManifest(path).status, "not-installed");
  await writeFile(path, JSON.stringify({ version: 1, updatedAt: "2026-09-20T00:00:00.000Z", sources: {
    a: { key: "a", sourceTitle: "名单", defaultBoard: "团团", sourceRevision: 3, lastStatus: "failed", lastCheckedAt: "2026-09-20T00:00:00.000Z", lastError: 'token=SECRET https://x.feishu.cn/sheets/Abc?token=[REDACTED] {"access_token":"SECRET","cookie":"SECRET"} access_token=SECRET' },
  }}));
  const status = inspectSourcePollManifest(path, { now: new Date("2026-09-20T01:00:00.000Z") });
  assert.equal(status.status, "warning");
  assert.equal(status.failedCount, 1);
  assert.doesNotMatch(JSON.stringify(status), /SECRET/);
  assert.match(status.sources[0].lastError, /REDACTED/);
});

test("status separates today's successful source checks from blocked, stale and future receipts", async t => {
  const directory = await mkdtemp(join(tmpdir(), "source-poller-freshness-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "manifest.json");
  await writeFile(path, JSON.stringify({ intervalMs: 86_400_000, updatedAt: "2026-09-27T17:00:00Z", sources: {
    a: { key: "a", lastStatus: "unchanged", lastCheckedAt: "2026-09-27T17:00:00Z" },
    b: { key: "b", lastStatus: "submitted", lastCheckedAt: "2026-09-27T15:00:00Z" },
    c: { key: "c", lastStatus: "blocked", lastCheckedAt: "2026-09-27T17:00:00Z", lastError: "公开表单无读取权限" },
    d: { key: "d", lastStatus: "unchanged", lastCheckedAt: "2026-09-28T04:00:00Z" },
  } }));
  const result = inspectSourcePollManifest(path, { now: new Date("2026-09-28T02:00:00Z") });
  assert.equal(result.businessDate, "2026-09-28");
  assert.equal(result.checkedTodayCount, 2);
  assert.equal(result.successfulTodayCount, 1);
  assert.equal(result.blockedCount, 1);
  assert.equal(result.staleCount, 2);
  assert.equal(result.status, "warning");
  assert.equal(result.intervalMs, 86_400_000);
});

test("an empty manifest is not all-sources-success", async t => {
  const directory = await mkdtemp(join(tmpdir(), "source-poller-empty-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "manifest.json");
  await writeFile(path, JSON.stringify({ sources: {} }));
  assert.equal(inspectSourcePollManifest(path).status, "warning");
});

test("a business summary from another job is not attached to the current import receipt", async t => {
  const directory = await mkdtemp(join(tmpdir(), "source-poller-job-mismatch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "manifest.json");
  await writeFile(path, JSON.stringify({ sources: { a: { key: "a", lastJobId: "new-job", lastStatus: "pending",
    sourceJobSummary: { version: 1, jobStatus: "completed", jobId: "old-job", observedAt: "2026-09-28T02:00:00Z",
      createdAccountCount: 4, reusedExistingRowCount: 0, reviewRequiredItemCount: 0, queuedEvidenceRequestCount: 0 } } } }));
  const result = inspectSourcePollManifest(path);
  assert.equal(result.sources[0].sourceJobSummary, null);
  assert.equal(result.businessSummaryMissingCount, 1);
});

test("new catalog entries join the coverage denominator before their first cloud check", async t => {
  const directory = await mkdtemp(join(tmpdir(), "source-poller-inventory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "manifest.json"), registryPath = join(directory, "registry.json");
  const known = { sourceUrl: "https://x.feishu.cn/sheets/KnownSource", title: "旧来源", sourceType: "lark-sheet" };
  const fresh = { sourceUrl: "https://x.feishu.cn/wiki/UnknownSource", title: "原始wiki", sourceType: "lark-wiki-alias", readPolicy: "unresolved-alias" };
  await writeFile(registryPath, JSON.stringify({ sources: [known, fresh] }));
  await writeFile(path, JSON.stringify({ sources: { [sourcePollKey(known)]: { ...known, key: sourcePollKey(known), lastStatus: "unchanged", lastCheckedAt: "2026-09-28T02:00:00Z" } } }));
  const r = inspectSourcePollManifest(path, { registryPath, now: new Date("2026-09-28T03:00:00Z") });
  assert.equal(r.sourceCount, 2);
  assert.equal(r.uncheckedCount, 1);
  assert.equal(r.successfulTodayCount, 1);
  assert.equal(r.status, "warning");
  assert.equal(r.sources.find(s => s.title === fresh.title).lastStatus, "unchecked");
});

test("missing manifest still reports the untested registry and registry read errors fail closed", async t => {
  const directory = await mkdtemp(join(tmpdir(), "source-poller-no-receipt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "manifest.json"), registryPath = join(directory, "registry.json");
  await writeFile(registryPath, JSON.stringify({ sources: [{ sourceUrl: "https://x.feishu.cn/sheets/NewSource" }] }));
  assert.equal(inspectSourcePollManifest(path, { registryPath }).uncheckedCount, 1);
  await writeFile(registryPath, "broken");
  assert.equal(inspectSourcePollManifest(path, { registryPath }).status, "error");
});

test("catalog read-only policy survives an old failure receipt without rewriting its outcome", async t => {
  const directory = await mkdtemp(join(tmpdir(), "source-poller-failed-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "manifest.json"), registryPath = join(directory, "registry.json");
  const source = { sourceUrl: "https://x.feishu.cn/sheets/StatsSource", sourceType: "lark-sheet", monitorOnly: true, kind: "content-statistics" };
  const key = sourcePollKey(source);
  await writeFile(registryPath, JSON.stringify({ sources: [source] }));
  await writeFile(path, JSON.stringify({ sources: { [key]: { key, monitorOnly: true, lastStatus: "failed", lastError: "读取权限不足", lastCheckedAt: "2026-09-28T02:00:00Z" } } }));
  const r = inspectSourcePollManifest(path, { registryPath, now: new Date("2026-09-28T03:00:00Z") });
  assert.equal(r.sources[0].monitorOnly, true);
  assert.equal(r.sources[0].readMode, "workbook-metadata");
  assert.equal(r.sources[0].kind, "content-statistics");
  assert.equal(r.sources[0].lastStatus, "failed");
  assert.equal(r.sources[0].lastError, "读取权限不足");
  assert.equal(r.successfulTodayCount, 0);
  assert.equal(r.failedCount, 1);
});

test("never-read monitor-only sources expose metadata mode, and an old policy success is not reused", async t => {
  const directory = await mkdtemp(join(tmpdir(), "source-poller-policy-change-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "manifest.json"), registryPath = join(directory, "registry.json");
  const source = { sourceUrl: "https://x.feishu.cn/sheets/PolicyChange", sourceType: "lark-sheet", monitorOnly: true };
  const key = sourcePollKey(source);
  await writeFile(registryPath, JSON.stringify({ sources: [source] }));
  await writeFile(path, JSON.stringify({ sources: {} }));
  assert.equal(inspectSourcePollManifest(path, { registryPath }).sources[0].readMode, "workbook-metadata");
  await writeFile(path, JSON.stringify({ sources: { [key]: { key, monitorOnly: true, readMode: "workbook-metadata", lastStatus: "changed", lastCheckedAt: "2026-09-28T02:00:00Z" } } }));
  await writeFile(registryPath, JSON.stringify({ sources: [{ ...source, monitorOnly: false }] }));
  const result = inspectSourcePollManifest(path, { registryPath, now: new Date("2026-09-28T03:00:00Z") });
  assert.equal(result.uncheckedCount, 1);
  assert.equal(result.sources[0].readMode, "author-table");
  assert.equal(result.successfulTodayCount, 0);
  assert.equal(result.checkedTodayCount, 0);
  assert.equal(result.registrySourceCount, 1);
  assert.equal(result.manifestOnlyCount, 0);
});
