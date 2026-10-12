import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function respond(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

test("source poller submits only a changed Feishu revision and persists a safe manifest", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "douyin-source-poller-"));
  let revision = 11;
  let failPreview = false;
  let jobCount = 0;
  const submissions = [];
  const server = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/author-spreadsheet/lark-preview") {
      if (failPreview) return respond(response, 503, { error: "飞书暂时不可用" });
      return respond(response, 200, { source: {
        url: "https://tenant.feishu.cn/sheets/Abcdef123456?sheet=Sheet01",
        title: "作者名单",
        revision,
        selectedSheetId: "Sheet01",
        selectedSheet: "作者明细",
        contentSha256: revision === 11 ? "a".repeat(64) : "b".repeat(64),
        exportSha256: "c".repeat(64),
        readAt: `2026-09-20T00:${revision}:00.000Z`,
      } });
    }
    if (request.method === "POST" && request.url === "/api/author-spreadsheet/auto-monitor") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      submissions.push({ key: request.headers["idempotency-key"], body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      jobCount += 1;
      return respond(response, 202, { id: `job-${jobCount}` });
    }
    if (request.method === "GET" && request.url?.startsWith("/api/author-spreadsheet/jobs/")) return respond(response, 200, { status: "completed" });
    return respond(response, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  process.env.DATA_DIR = directory;
  process.env.SOURCE_POLL_BASE_URL = `http://127.0.0.1:${address.port}`;
  const { pollOnce } = await import(`../scripts/source-poller.mjs?test=${Date.now()}`);
  const session = {
    headers: {},
    bootstrap: { authorSources: [{
      sourceUrl: "https://tenant.feishu.cn/sheets/Abcdef123456?sheet=Sheet01",
      title: "作者名单",
      sheetId: "Sheet01",
      sheetName: "作者明细",
      defaultBoard: "小团团矩阵",
      revision: 10,
    }] },
  };
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });

  const first = await pollOnce({ session, now: new Date("2026-09-20T00:00:00Z") });
  assert.equal(first.status, "ok");
  assert.equal(first.changed, 1);
  assert.equal(jobCount, 1);
  assert.match(submissions[0].key, /^[0-9a-f-]{36}$/);
  assert.equal(submissions[0].body.uploadSha256, "a".repeat(64));
  const manifestPath = join(directory, "source-poll", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(Object.keys(manifest.sources).length, 1);
  assert.equal(manifest.sources[Object.keys(manifest.sources)[0]].sourceSha256, "a".repeat(64));
  assert.ok(Number.isFinite(Date.parse(manifest.sources[Object.keys(manifest.sources)[0]].lastJobSubmittedAt)));
  assert.ok(Number.isFinite(Date.parse(manifest.sources[Object.keys(manifest.sources)[0]].lastJobCheckedAt)));

  const unchanged = await pollOnce({ session, now: new Date("2026-09-20T01:00:00Z") });
  assert.equal(unchanged.changed, 0);
  assert.equal(unchanged.sources[0].status, "unchanged");
  assert.equal(jobCount, 1);

  revision = 12;
  const changed = await pollOnce({ session, now: new Date("2026-09-20T02:00:00Z") });
  assert.equal(changed.changed, 1);
  assert.equal(changed.sources[0].status, "submitted");
  assert.equal(jobCount, 2);
  assert.notEqual(submissions[0].key, submissions[1].key, "a new revision receives a new submission identity");

  revision = 13;
  failPreview = true;
  const failed = await pollOnce({ session, now: new Date("2026-09-20T03:00:00Z") });
  assert.equal(failed.sources[0].status, "failed");
  assert.equal(failed.status, "warning");
  assert.equal(failed.changed, 0, "failed reads must not be presented as new records");
  assert.equal(failed.failedCount, 1);
  assert.equal(failed.sources[0].lastError, "503: 飞书暂时不可用");
  const preserved = JSON.parse(readFileSync(manifestPath, "utf8")).sources[Object.keys(manifest.sources)[0]];
  assert.equal(preserved.sourceRevision, 12, "failed refresh must retain the last successful revision");
  assert.equal(preserved.lastStatus, "failed");
});

test("source submission identity stays stable across read times and changes with the source content", async () => {
  const { sourceSubmissionIdentity } = await import("../scripts/source-poller.mjs");
  const source = { sourceType: "lark-sheet", sourceUrl: "https://x.feishu.cn/sheets/A?sheet=B",
    sourceSheetId: "B", sheetName: "作者", sourceTitle: "团团矩阵", sourceRevision: 42,
    sourceSha256: "a".repeat(64), defaultBoard: "一条小团团切片矩阵", sourceReadAt: "2026-10-10T00:00:00Z" };
  const first = sourceSubmissionIdentity(source);
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(first, sourceSubmissionIdentity({ ...source, sourceReadAt: "2026-10-10T01:00:00Z" }));
  assert.notEqual(first, sourceSubmissionIdentity({ ...source, sourceSha256: "b".repeat(64) }));
  assert.notEqual(first, sourceSubmissionIdentity({ ...source, defaultBoard: "另一矩阵" }));
  assert.notEqual(first, sourceSubmissionIdentity({ ...source, sourceUrl: `${source.sourceUrl}&key=different` }));
  assert.throws(() => sourceSubmissionIdentity({ ...source, sourceSha256: "" }), /校验/);
});

test("a newly observed failed job does not resubmit its source in the same daily check", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "source-poller-failed-observation-"));
  const source = { sourceUrl: "https://tenant.feishu.cn/sheets/FailedJob?sheet=A",
    sourceType: "lark-sheet", title: "作者名单", sheetName: "作者", sheetId: "A", defaultBoard: "团团" };
  const { sourcePollKey } = await import("../lib/source-poller-status.mjs");
  const key = sourcePollKey(source);
  mkdirSync(join(directory, "source-poll"));
  writeFileSync(join(directory, "source-poll", "manifest.json"), JSON.stringify({ version: 2, sources: {
    [key]: { ...source, key, lastStatus: "pending", lastJobId: "job-existing", sourceRevision: 10,
      sourceSha256: "a".repeat(64) },
  } }));
  let submissions = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/author-spreadsheet/jobs/job-existing") {
      return respond(response, 200, { status: "failed", error: "旧任务未完成" });
    }
    if (request.method === "POST" && request.url === "/api/author-spreadsheet/lark-preview") {
      return respond(response, 200, { source: { url: source.sourceUrl, title: source.title,
        revision: 10, selectedSheetId: "A", selectedSheet: "作者",
        contentSha256: "a".repeat(64), readAt: "2026-10-10T00:00:00Z" } });
    }
    if (request.method === "POST" && request.url === "/api/author-spreadsheet/auto-monitor") {
      submissions += 1;
      return respond(response, 202, { id: `new-job-${submissions}` });
    }
    return respond(response, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  process.env.DATA_DIR = directory;
  process.env.SOURCE_POLL_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const { pollOnce } = await import(`../scripts/source-poller.mjs?failed-observation=${Date.now()}`);
  const result = await pollOnce({ session: { headers: {}, bootstrap: { authorSources: [source] } },
    now: new Date("2026-10-10T00:00:00Z"), failureRetryDelay: 30_000 });
  assert.equal(submissions, 0);
  assert.equal(result.sources[0].status, "failed");
  assert.ok(Date.parse(result.sources[0].nextRetryAt) > Date.parse("2026-10-10T00:00:00Z"));
});

test("daily poll cadence stays on the Beijing business-day anchor across restarts", async () => {
  const { nextSourcePollDelay, sourcePollBusinessDate, DEFAULT_SOURCE_POLL_INTERVAL_MS,
    SOURCE_POLL_BEIJING_ANCHOR_HOUR } = await import("../scripts/source-poller.mjs");
  assert.equal(DEFAULT_SOURCE_POLL_INTERVAL_MS, 86_400_000);
  assert.equal(SOURCE_POLL_BEIJING_ANCHOR_HOUR, 0);
  const now = new Date("2026-09-28T02:00:00Z");
  assert.equal(sourcePollBusinessDate("2026-09-27T15:59:59Z"), "2026-09-27");
  assert.equal(sourcePollBusinessDate("2026-09-27T16:00:00Z"), "2026-09-28");
  assert.equal(nextSourcePollDelay({ lastFinishedAt: "2026-09-27T22:00:00Z" }, { now }), 14 * 3_600_000);
  assert.equal(nextSourcePollDelay({ lastFinishedAt: "2026-09-27T22:00:00Z", lastFullBusinessDate: "2026-09-28" }, { now }), 14 * 3_600_000);
  assert.equal(nextSourcePollDelay({ lastFinishedAt: "2026-09-27T02:00:00Z", lastFullBusinessDate: "2026-09-28" }, { now }), 0,
    "a forged or inconsistent business-day receipt cannot suppress a check");
  assert.equal(nextSourcePollDelay({ updatedAt: "2026-09-27T02:00:00Z" }, { now }), 0);
  assert.equal(nextSourcePollDelay({ lastFinishedAt: "2026-09-29T02:00:00Z" }, { now }), 0);
  assert.equal(nextSourcePollDelay({}, { now }), 0);
  assert.equal(nextSourcePollDelay({ lastFinishedAt: "2026-09-28T05:00:00Z", lastFullBusinessDate: "2026-09-28" },
    { now: new Date("2026-09-29T05:00:00Z") }), 0, "offline recovery is due once on the new Beijing business day");
  assert.equal(nextSourcePollDelay({ lastFinishedAt: "2026-09-29T05:00:00Z", lastFullBusinessDate: "2026-09-29" },
    { now: new Date("2026-09-29T05:00:00Z") }), 11 * 3_600_000, "the same business day cannot drift into a second full check");
});

test("stuck pending jobs cannot suppress other sources' due daily check", async () => {
  const { sourcePollLoopPlan } = await import("../scripts/source-poller.mjs");
  const manifest = { lastFinishedAt: "2026-09-27T02:00:00Z", sources: {
    stuck: { lastStatus: "pending", lastJobId: "unreachable-job" }, other: { lastStatus: "unchanged" },
  } };
  const before = sourcePollLoopPlan(manifest, { now: new Date("2026-09-27T15:59:00Z") });
  assert.equal(before.resumePendingOnly, true);
  assert.equal(before.nextDelayMs, 0, "a never-observed pending job can be resumed immediately");
  const cooling = sourcePollLoopPlan({ ...manifest, lastPendingCheckedAt: "2026-09-27T15:59:00Z" }, { now: new Date("2026-09-27T15:59:00Z") });
  assert.equal(cooling.mode, "idle");
  assert.equal(cooling.nextDelayMs, 60_000, "wake at the daily deadline even if retry delay is longer");
  for (const at of ["2026-09-27T16:00:00Z", "2026-09-29T03:00:00Z"]) {
    const plan = sourcePollLoopPlan(manifest, { now: new Date(at) });
    assert.equal(plan.hasPending, true);
    assert.equal(plan.resumePendingOnly, false, "full iteration must include the other sources");
    assert.equal(plan.nextDelayMs, 0);
  }
});

test("failed source retries back off independently without rereading successful blocked or pending sources", async t => {
  const directory = mkdtempSync(join(tmpdir(), "source-poller-failed-retry-"));
  process.env.DATA_DIR = directory;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const module = await import(`../scripts/source-poller.mjs?failed-retry=${Date.now()}`);
  const { sourcePollKey } = await import("../lib/source-poller-status.mjs");
  const sources = Object.fromEntries(["failed", "successful", "blocked", "pending"].map((name) => [name, {
    sourceUrl: `https://x.feishu.cn/sheets/${name}`,
    sourceType: "lark-sheet",
    title: name,
    monitorOnly: true,
  }]));
  const keys = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, sourcePollKey(source)]));
  const now = new Date("2026-09-28T02:00:00Z");
  const folder = join(directory, "source-poll");
  mkdirSync(folder);
  writeFileSync(join(folder, "manifest.json"), JSON.stringify({
    version: 2,
    updatedAt: "2026-09-28T01:00:00Z",
    lastFinishedAt: "2026-09-28T01:00:00Z",
    lastFullBusinessDate: "2026-09-28",
    lastPendingCheckedAt: now.toISOString(),
    sources: {
      [keys.failed]: { ...sources.failed, key: keys.failed, sourceTitle: "failed", sourceRevision: 7,
        lastStatus: "failed", consecutiveFailureCount: 1, nextRetryAt: now.toISOString() },
      [keys.successful]: { ...sources.successful, key: keys.successful, sourceTitle: "successful", sourceRevision: 7,
        lastStatus: "unchanged", lastCheckedAt: "2026-09-28T01:00:00Z" },
      [keys.blocked]: { ...sources.blocked, key: keys.blocked, sourceTitle: "blocked", sourceRevision: 7,
        lastStatus: "blocked", lastCheckedAt: "2026-09-28T01:00:00Z" },
      [keys.pending]: { ...sources.pending, key: keys.pending, sourceTitle: "pending", sourceRevision: 7,
        lastStatus: "pending", lastJobId: "existing-job", lastCheckedAt: "2026-09-28T01:00:00Z" },
    },
  }));
  const reads = [];
  const session = { headers: {}, bootstrap: { authorSources: Object.values(sources) } };
  const failed = await module.pollOnce({ session, now, retryFailedOnly: true, retrySourceKeys: [keys.failed],
    failureRetryDelay: 30_000, monitorMetadataReader: async (source) => {
      reads.push(source.title);
      throw new Error("temporary source outage");
    } });
  assert.equal(failed.mode, "failed");
  assert.equal(failed.checkedCount, 1);
  assert.deepEqual(reads, ["failed"]);
  let manifest = JSON.parse(readFileSync(join(folder, "manifest.json")));
  assert.equal(manifest.lastFinishedAt, "2026-09-28T01:00:00Z", "a partial retry cannot move the daily receipt");
  assert.equal(manifest.sources[keys.failed].consecutiveFailureCount, 2);
  assert.equal(manifest.sources[keys.failed].nextRetryAt, "2026-09-28T02:01:00.000Z");
  assert.equal(manifest.sources[keys.successful].lastStatus, "unchanged");
  assert.equal(manifest.sources[keys.blocked].lastStatus, "blocked");
  assert.equal(manifest.sources[keys.pending].lastStatus, "pending");

  const cooling = module.sourcePollLoopPlan(manifest, { now: new Date("2026-09-28T02:00:59Z"),
    registry: Object.values(sources), retryDelay: 5 * 60_000 });
  assert.equal(cooling.mode, "idle");
  assert.equal(cooling.failedRetryDelayMs, 1_000);
  const due = module.sourcePollLoopPlan(manifest, { now: new Date("2026-09-28T02:01:00Z"),
    registry: Object.values(sources), retryDelay: 5 * 60_000 });
  assert.equal(due.mode, "failed");
  assert.deepEqual(due.failedKeys, [keys.failed]);

  const recovered = await module.pollOnce({ session, now: new Date("2026-09-28T02:01:00Z"), retryFailedOnly: true,
    retrySourceKeys: due.failedKeys, failureRetryDelay: 30_000, monitorMetadataReader: async (source) => {
      reads.push(source.title);
      return { revision: 7, title: source.title, sheetCount: 1, readMode: "workbook-metadata" };
    } });
  assert.equal(recovered.successfulCount, 1);
  assert.deepEqual(reads, ["failed", "failed"]);
  manifest = JSON.parse(readFileSync(join(folder, "manifest.json")));
  assert.equal(manifest.sources[keys.failed].lastStatus, "unchanged");
  assert.equal(manifest.sources[keys.failed].consecutiveFailureCount, 0);
  assert.equal(manifest.sources[keys.failed].nextRetryAt, null);
  assert.equal(manifest.sources[keys.successful].lastCheckedAt, "2026-09-28T01:00:00Z");
  assert.equal(manifest.sources[keys.blocked].lastCheckedAt, "2026-09-28T01:00:00Z");
  assert.equal(manifest.sources[keys.pending].lastCheckedAt, "2026-09-28T01:00:00Z");
});

test("registry additions bypass a recent daily receipt and idle discovery is bounded without cloud reads", async () => {
  const { sourcePollLoopPlan } = await import("../scripts/source-poller.mjs");
  const { sourcePollKey } = await import("../lib/source-poller-status.mjs");
  const old = { sourceUrl: "https://x.feishu.cn/sheets/OldSource", sourceType: "lark-sheet" };
  const fresh = { sourceUrl: "https://x.feishu.cn/sheets/FreshSource", sourceType: "lark-sheet" };
  const manifest = { lastFinishedAt: "2026-09-28T01:00:00Z", sources: { [sourcePollKey(old)]: { lastStatus: "unchanged" } } };
  const options = { now: new Date("2026-09-28T02:00:00Z"), registry: [old] };
  assert.equal(sourcePollLoopPlan(manifest, options).mode, "idle");
  assert.equal(sourcePollLoopPlan(manifest, options).nextDelayMs, 60_000);
  const plan = sourcePollLoopPlan(manifest, { ...options, registry: [old, fresh, fresh] });
  assert.equal(plan.mode, "unchecked");
  assert.equal(plan.nextDelayMs, 0);
  assert.deepEqual(plan.uncheckedKeys, [sourcePollKey(fresh)]);
  assert.equal(sourcePollLoopPlan(manifest, { ...options, now: new Date("2026-09-29T01:00:00Z"), registry: [old, fresh] }).mode, "full");
});

test("partial receipts cannot reset a legacy or absent full-check deadline", async () => {
  const { nextSourcePollDelay } = await import("../scripts/source-poller.mjs");
  const now = new Date("2026-09-28T02:00:00Z");
  assert.equal(nextSourcePollDelay({ lastFinishedAt: null, updatedAt: now.toISOString() }, { now }), 0);
  assert.equal(nextSourcePollDelay({ lastFinishedAt: "2026-09-27T02:00:00Z", updatedAt: now.toISOString() }, { now }), 0);
});

test("submission forms and unsupported sources cannot masquerade as successful table reads", async () => {
  const { sourceReadBlockReason } = await import("../scripts/source-poller.mjs");
  const sourceUrl = "https://x.feishu.cn/share/base/form/shrPublicForm";
  assert.match(sourceReadBlockReason({ sourceUrl }), /表单/);
  assert.match(sourceReadBlockReason({ sourceUrl: "https://evil.example/sheets/123" }), /不属于/);
  assert.match(sourceReadBlockReason({ sourceUrl: "https://x.feishu.cn/base/123", sourceType: "lark-bitable" }), /缺少/);
  assert.equal(sourceReadBlockReason({ sourceUrl, sourceType: "lark-bitable", baseToken: "authorized", tableId: "known-table" }), null);
  assert.equal(sourceReadBlockReason({ sourceUrl: "https://x.larkoffice.com/wiki/123" }), null);
});

test("blocked form gets a durable explicit failure reason without submitting a job", async t => {
  const directory = mkdtempSync(join(tmpdir(), "douyin-source-form-"));
  process.env.DATA_DIR = directory;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { pollOnce } = await import(`../scripts/source-poller.mjs?form=${Date.now()}`);
  const result = await pollOnce({ session: { headers: {}, bootstrap: { authorSources: [
    { sourceUrl: "https://x.feishu.cn/share/base/form/shrPublicForm", title: "填写表单" },
  ] } } });
  assert.equal(result.status, "warning");
  assert.equal(result.blockedCount, 1);
  assert.equal(result.successfulCount, 0);
  assert.equal(result.changed, 0);
  const source = Object.values(JSON.parse(readFileSync(join(directory, "source-poll", "manifest.json"))).sources)[0];
  assert.equal(source.lastStatus, "blocked");
  assert.match(source.lastError, /无法读取提交记录/);
});

test("a failed job status GET resumes the durable original job without another POST", async t => {
  const directory = mkdtempSync(join(tmpdir(), "source-poller-pending-"));
  let posts = 0, previews = 0, failGet = true, pendingWasDurable = false;
  const manifestPath = join(directory, "source-poll", "manifest.json");
  const server = createServer((request, response) => {
    if (request.url === "/api/author-spreadsheet/lark-preview") {
      previews += 1;
      return respond(response, 200, { source: { url: "https://x.feishu.cn/sheets/Source01", revision: 1, contentSha256: "a".repeat(64) } });
    }
    if (request.url === "/api/author-spreadsheet/auto-monitor") { posts += 1; return respond(response, 202, { id: "original-job" }); }
    if (request.url === "/api/author-spreadsheet/jobs/original-job") {
      pendingWasDurable = Object.values(JSON.parse(readFileSync(manifestPath)).sources).some(s => s.lastJobId === "original-job" && s.lastStatus === "pending" && s.sourceSha256 === "a".repeat(64));
      return respond(response, failGet ? 503 : 200, failGet ? { error: "temporary network error" } : { status: "completed" });
    }
    return respond(response, 404, {});
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  process.env.DATA_DIR = directory;
  process.env.SOURCE_POLL_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const { pollOnce } = await import(`../scripts/source-poller.mjs?pending=${Date.now()}`);
  const session = { headers: {}, bootstrap: { authorSources: [{ sourceUrl: "https://x.feishu.cn/sheets/Source01", title: "作者" }] } };
  const first = await pollOnce({ session });
  assert.equal(first.pendingCount, 1);
  assert.equal(first.successfulCount, 0);
  assert.equal(posts, 1);
  assert.equal(pendingWasDurable, true);
  const checkedAt = JSON.parse(readFileSync(manifestPath)).lastFinishedAt;
  failGet = false;
  // Even if source discovery temporarily omits the source, its accepted job
  // must still be recoverable from the durable receipt.
  const resumed = await pollOnce({ session: { ...session, bootstrap: { authorSources: [] } }, resumePendingOnly: true });
  assert.equal(resumed.pendingCount, 0);
  assert.equal(resumed.sources[0].status, "submitted");
  assert.equal(posts, 1);
  assert.equal(previews, 1, "pending-only recovery must not re-read every source");
  assert.equal(JSON.parse(readFileSync(manifestPath)).lastFinishedAt, checkedAt);
});

test("fresh incomplete locks are not stolen, and release only removes the owning token/inode", async t => {
  const directory = mkdtempSync(join(tmpdir(), "source-poller-lock-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  process.env.DATA_DIR = directory;
  const { acquireSourcePollLock, releaseSourcePollLock } = await import(`../scripts/source-poller.mjs?lock=${Date.now()}`);
  const folder = join(directory, "source-poll");
  const path = join(folder, ".poll.lock");
  mkdirSync(folder);
  writeFileSync(path, "");
  assert.equal(await acquireSourcePollLock(), false);
  assert.equal(existsSync(path), true);
  unlinkSync(path);
  const owner = await acquireSourcePollLock();
  assert.ok(owner.token);
  assert.equal(await acquireSourcePollLock(), false);
  await releaseSourcePollLock({ ...owner, token: "not-the-owner" });
  assert.equal(existsSync(path), true);
  await releaseSourcePollLock(owner);
  assert.equal(existsSync(path), false);
  const replacement = await acquireSourcePollLock();
  await releaseSourcePollLock(owner);
  assert.equal(existsSync(path), true, "stale owner must not remove replacement lock");
  await releaseSourcePollLock(replacement);
});

test("two processes cannot both replace one stale source-poll lock", async t => {
  const directory = mkdtempSync(join(tmpdir(), "source-poller-stale-race-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const folder = join(directory, "source-poll"); mkdirSync(folder);
  writeFileSync(join(folder, ".poll.lock"), JSON.stringify({ pid: 2147483647, token: "old", createdAt: "2020-01-01T00:00:00Z" }));
  const moduleUrl = new URL("../scripts/source-poller.mjs", import.meta.url).href;
  const script = `import { acquireSourcePollLock, releaseSourcePollLock } from ${JSON.stringify(moduleUrl)};
    const owner = await acquireSourcePollLock();
    if (owner) { console.log('owner'); await new Promise(resolve => setTimeout(resolve, 250)); await releaseSourcePollLock(owner); }
    else console.log('busy');`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, DATA_DIR: directory }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`child ${code}: ${error}`)));
  });
  const results = await Promise.all([run(), run()]);
  assert.equal(results.filter((value) => value === "owner").length, 1, JSON.stringify(results));
  assert.equal(results.filter((value) => value === "busy").length, 1, JSON.stringify(results));
  assert.equal(existsSync(join(folder, ".poll.lock")), false);
});

test("monitor-only content tables check revision metadata without posting author imports", async t => {
  const directory = mkdtempSync(join(tmpdir(), "source-poller-metadata-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  process.env.DATA_DIR = directory;
  const { pollOnce, readMonitorOnlyMetadata } = await import(`../scripts/source-poller.mjs?metadata=${Date.now()}`);
  const sourceUrl = "https://x.feishu.cn/sheets/Abcdef123456";
  const metadata = await readMonitorOnlyMetadata({ sourceUrl }, { command: "/fixture/lark-cli", commandRunner: async (_command, args) => {
    assert.ok(args.includes("+workbook-info"));
    assert.equal(args.includes("+export"), false);
    return { stdout: JSON.stringify({ ok: true, data: { revision: 27, title: "内容统计表", sheets: [{}] } }) };
  } });
  const source = { sourceUrl, sourceType: "lark-sheet", monitorOnly: true, kind: "content-statistics" };
  const session = { headers: {}, bootstrap: { authorSources: [source] } };
  const first = await pollOnce({ session, monitorMetadataReader: async () => metadata });
  assert.equal(first.sources[0].status, "changed");
  assert.equal(first.sources[0].readMode, "workbook-metadata");
  assert.equal(first.sources[0].contentImported, false);
  assert.equal(first.importedSourceCount, 0);
  const next = await pollOnce({ session, monitorMetadataReader: async () => metadata });
  assert.equal(next.changed, 0);
  assert.equal(next.sources[0].status, "unchanged");
});

test("unresolved aliases stay explicit blocked entries and never call a reader", async t => {
  const directory = mkdtempSync(join(tmpdir(), "source-poller-alias-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  process.env.DATA_DIR = directory;
  const { pollOnce } = await import(`../scripts/source-poller.mjs?alias=${Date.now()}`);
  const r = await pollOnce({ session: { headers: {}, bootstrap: { authorSources: [{ sourceUrl: "https://x.feishu.cn/wiki/UnknownSource", monitorOnly: true,
    sourceType: "lark-wiki-alias", readPolicy: "unresolved-alias", blockedReason: "未确认原始表映射" }] } },
    monitorMetadataReader: async () => { throw new Error("must not call a reader"); } });
  assert.equal(r.blockedCount, 1);
  assert.equal(r.sources[0].lastError, "未确认原始表映射");
  assert.equal(r.successfulCount, 0);
});

test("an invalid registry shape fails closed without recording a completed source check", async t => {
  const directory = mkdtempSync(join(tmpdir(), "source-poller-invalid-registry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  process.env.DATA_DIR = directory;
  const { pollOnce } = await import(`../scripts/source-poller.mjs?invalid-registry=${Date.now()}`);
  const folder = join(directory, "source-poll"); mkdirSync(folder);
  writeFileSync(join(folder, "registry.json"), JSON.stringify({ sources: "not-an-array" }));
  await assert.rejects(pollOnce({ session: { headers: {}, bootstrap: { authorSources: [] } }, uncheckedOnly: true }), /sources 数组/);
  assert.equal(existsSync(join(folder, "manifest.json")), false);
  assert.equal(existsSync(join(folder, ".poll.lock")), false);
});
