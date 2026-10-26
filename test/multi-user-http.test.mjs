import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ExcelJS from "exceljs";

function privateIp() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (/^10\./.test(entry.address) || /^192\.168\./.test(entry.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(entry.address)) return entry.address;
    }
  }
  return null;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "0.0.0.0", () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function cookieFrom(response) {
  return String(response.headers.get("set-cookie") ?? "").split(";")[0];
}

async function request(origin, path, { method = "GET", cookie, csrf, body, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Origin: origin,
      ...headers,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { response, payload: await response.json().catch(() => null) };
}

test("LAN sessions enforce invites, CSRF, roles, durable author jobs and concurrent writes", { timeout: 30_000 }, async (t) => {
  const ip = privateIp();
  if (!ip) return t.skip("No private IPv4 interface available");
  const port = await freePort();
  const dataDir = await mkdtemp(join(tmpdir(), "douyin-monitor-access-"));
  let logs = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, DATA_DIR: dataDir, HOST: "0.0.0.0", PORT: String(port), NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => child.exitCode === null ? child.once("exit", resolve) : resolve());
    await rm(dataDir, { recursive: true, force: true });
  });

  const localOrigin = `http://127.0.0.1:${port}`;
  const lanOrigin = `http://${ip}:${port}`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`${localOrigin}/api/health`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (attempt === 79) assert.fail(`server did not start: ${logs}`);
  }

  const remoteWithoutInvite = await request(lanOrigin, "/api/auth/session");
  assert.equal(remoteWithoutInvite.response.status, 200);
  assert.equal(remoteWithoutInvite.payload.authenticated, false);

  const ownerSession = await request(localOrigin, "/api/auth/session");
  assert.equal(ownerSession.response.status, 200);
  assert.equal(ownerSession.payload.user.role, "admin");
  const ownerCookie = cookieFrom(ownerSession.response);
  const ownerCsrf = ownerSession.payload.csrfToken;

  const invalidSchedule = await request(localOrigin, "/api/settings", {
    method: "POST", cookie: ownerCookie, csrf: ownerCsrf, body: { scheduleTime: "25:90" },
  });
  assert.equal(invalidSchedule.response.status, 400);
  assert.match(invalidSchedule.payload.error, /00:00–23:59/);
  const invalidCollectorLimit = await request(localOrigin, "/api/settings", {
    method: "POST", cookie: ownerCookie, csrf: ownerCsrf, body: { viralLikeThreshold: 20_000, publicPostsPerAccount: "not-a-number" },
  });
  assert.equal(invalidCollectorLimit.response.status, 400);
  const settingsAfterRejectedUpdates = await request(localOrigin, "/api/bootstrap", { cookie: ownerCookie });
  assert.equal(settingsAfterRejectedUpdates.payload.settings.scheduleTime, "10:00");
  assert.equal(settingsAfterRejectedUpdates.payload.settings.viralLikeThreshold, "10000", "a rejected settings request must not partially write valid fields");

  async function inviteAndJoin(role, displayName) {
    const created = await request(localOrigin, "/api/access/invites", {
      method: "POST", cookie: ownerCookie, csrf: ownerCsrf, body: { role, hours: 1, maxUses: 1, label: `${role} test` },
    });
    assert.equal(created.response.status, 201);
    const joined = await request(lanOrigin, "/api/auth/join", { method: "POST", body: { code: created.payload.code, displayName } });
    assert.equal(joined.response.status, 200);
    return { cookie: cookieFrom(joined.response), csrf: joined.payload.csrfToken, session: joined.payload };
  }

  const viewer = await inviteAndJoin("viewer", "只读测试员");
  const editor = await inviteAndJoin("editor", "编辑测试员");
  assert.equal(viewer.session.permissions.edit, false);
  assert.equal(editor.session.permissions.edit, true);

  const importBytes = Buffer.from("作者名称,抖音号,板块\n幂等集成作者,MS4wLjABAAAAidempotencyHttpTest12345678901234567890,幂等集成测试\n", "utf8");
  const importPreview = await request(lanOrigin, "/api/author-spreadsheet/preview", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf,
    body: { fileName: "幂等集成测试.csv", contentBase64: importBytes.toString("base64") },
  });
  assert.equal(importPreview.response.status, 200);
  assert.equal(importPreview.payload.uploadSha256, createHash("sha256").update(importBytes).digest("hex"));

  const batchPreview = await request(lanOrigin, "/api/author-spreadsheet/batch-preview", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf,
    body: { fileName: "幂等集成测试.csv", contentBase64: importBytes.toString("base64") },
  });
  assert.equal(batchPreview.response.status, 200);
  assert.equal(batchPreview.payload.sheets.length, 1);
  assert.equal(batchPreview.payload.sheets[0].name, "CSV");
  assert.equal(batchPreview.payload.sheets[0].sampleRows.length, 1);
  assert.equal(batchPreview.payload.totalAuthorRows, 1);
  const forbiddenBatchPreview = await request(lanOrigin, "/api/author-spreadsheet/batch-preview", {
    method: "POST", cookie: viewer.cookie, csrf: viewer.csrf,
    body: { fileName: "幂等集成测试.csv", contentBase64: importBytes.toString("base64") },
  });
  assert.equal(forbiddenBatchPreview.response.status, 403, "viewer cannot read batch author details");

  const batchIdempotencyKey = "88888888-2222-4333-8444-555555555555";
  const batchImportBody = {
    fileName: "幂等集成测试.csv", contentBase64: importBytes.toString("base64"),
    uploadSha256: batchPreview.payload.uploadSha256,
    assignments: [{ sheetName: "CSV", defaultBoard: "批量回退测试板块", idempotencyKey: batchIdempotencyKey }],
  };
  const changedBatchFile = await request(lanOrigin, "/api/author-spreadsheet/auto-monitor-batch", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf,
    body: { ...batchImportBody, uploadSha256: "0".repeat(64) },
  });
  assert.equal(changedBatchFile.response.status, 409, "batch submit must bind to the exact bytes reviewed in preview");
  const batchJob = await request(lanOrigin, "/api/author-spreadsheet/auto-monitor-batch", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: batchImportBody,
  });
  assert.equal(batchJob.response.status, 200);
  assert.equal(batchJob.payload.acceptedCount, 1);
  assert.equal(batchJob.payload.results[0].status, "accepted");
  const batchReplay = await request(lanOrigin, "/api/author-spreadsheet/auto-monitor-batch", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: batchImportBody,
  });
  assert.equal(batchReplay.response.status, 200);
  assert.equal(batchReplay.payload.replayedCount, 1);
  assert.equal(batchReplay.payload.results[0].job.id, batchJob.payload.results[0].job.id);

  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("团团切片名单").addRows([
    ["作者名称", "sec_uid"],
    ["批量作者甲", "MS4wLjABAAAAbatchSheetAuthorA12345678901234567890"],
  ]);
  workbook.addWorksheet("杨齐家原创名单").addRows([
    ["作者名称", "sec_uid", "板块"],
    ["批量作者乙", "MS4wLjABAAAAbatchSheetAuthorB12345678901234567890", "杨齐家矩阵"],
  ]);
  const workbookBytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const multiPreview = await request(lanOrigin, "/api/author-spreadsheet/batch-preview", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf,
    body: { fileName: "多板块作者.xlsx", contentBase64: workbookBytes.toString("base64") },
  });
  assert.equal(multiPreview.response.status, 200);
  assert.deepEqual(multiPreview.payload.sheets.map(sheet => sheet.name), ["团团切片名单", "杨齐家原创名单"]);
  assert.deepEqual(multiPreview.payload.sheets.map(sheet => sheet.rowCount), [1, 1]);
  const multiBatchBody = {
    fileName: "多板块作者.xlsx", contentBase64: workbookBytes.toString("base64"), uploadSha256: multiPreview.payload.uploadSha256,
    assignments: [
      { sheetName: "团团切片名单", defaultBoard: "团团切片矩阵", idempotencyKey: "77777777-2222-4333-8444-555555555551" },
      { sheetName: "杨齐家原创名单", defaultBoard: "其他默认值", idempotencyKey: "77777777-2222-4333-8444-555555555552" },
    ],
  };
  const multiBatch = await request(lanOrigin, "/api/author-spreadsheet/auto-monitor-batch", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: multiBatchBody,
  });
  assert.equal(multiBatch.response.status, 200);
  assert.equal(multiBatch.payload.acceptedCount, 2);
  assert.deepEqual(multiBatch.payload.results.map(item => item.sheetName), ["团团切片名单", "杨齐家原创名单"]);
  const multiBatchReplay = await request(lanOrigin, "/api/author-spreadsheet/auto-monitor-batch", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: multiBatchBody,
  });
  assert.equal(multiBatchReplay.payload.replayedCount, 2, "each worksheet reuses its own durable idempotency key");
  assert.deepEqual(multiBatchReplay.payload.results.map(item => item.job.id), multiBatch.payload.results.map(item => item.job.id));
  const batchRows = new DatabaseSync(join(dataDir, "douyin-monitor.sqlite"), { readOnly: true });
  const queuedBatchRequests = multiBatch.payload.results.map(({ job }) => JSON.parse(batchRows.prepare("SELECT request_json FROM author_resolution_jobs WHERE id=?").get(job.id).request_json));
  assert.equal(queuedBatchRequests[0].defaultBoard, "团团切片矩阵");
  assert.equal(queuedBatchRequests[1].defaultBoard, "其他默认值");
  assert.equal(queuedBatchRequests[1].rows[0].board, "杨齐家矩阵", "an explicit board column overrides the per-sheet blank-board fallback");
  batchRows.close();

  const retiredDirectCommit = await request(lanOrigin, "/api/author-spreadsheet/commit", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: {
      fileName: "伪造.xlsx",
      rows: [{ sourceRow: 2, name: "伪造作者", platform: "douyin", locator: "MS4wLjABAAAAlegacyBypassMustNotWrite1234567890" }],
    },
  });
  assert.equal(retiredDirectCommit.response.status, 410);
  assert.match(retiredDirectCommit.payload.error, /旧版直接写入接口已停用/);

  const missingCsrf = await request(lanOrigin, "/api/targets", {
    method: "POST", cookie: editor.cookie, body: { type: "hashtag", label: "no csrf", locator: "no-csrf", provider: "manual" },
  });
  assert.equal(missingCsrf.response.status, 403);
  assert.equal(missingCsrf.payload.code, "csrf_failed");

  const viewerWrite = await request(lanOrigin, "/api/targets", {
    method: "POST", cookie: viewer.cookie, csrf: viewer.csrf, body: { type: "hashtag", label: "viewer write", locator: "viewer-write", provider: "manual" },
  });
  assert.equal(viewerWrite.response.status, 403);
  assert.equal(viewerWrite.payload.code, "insufficient_role");

  const createPayload = { type: "hashtag", label: "并发目标", locator: "concurrent-target", provider: "manual" };
  const concurrentCreates = await Promise.all([
    request(lanOrigin, "/api/targets", { method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: createPayload }),
    request(lanOrigin, "/api/targets", { method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: createPayload }),
  ]);
  assert.deepEqual(concurrentCreates.map((item) => item.response.status).sort(), [201, 409]);
  const targetId = concurrentCreates.find((item) => item.response.status === 201).payload.id;

  const blockedFullSync = await request(lanOrigin, "/api/sync", { method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: {} });
  assert.equal(blockedFullSync.response.status, 400);
  assert.match(blockedFullSync.payload.error, /只允许重试单个异常对象/);
  assert.equal(blockedFullSync.payload.code, "INVALID_COLLECTION_SCOPE");

  const editorDelete = await request(lanOrigin, `/api/targets/${targetId}`, { method: "DELETE", cookie: editor.cookie, csrf: editor.csrf });
  assert.equal(editorDelete.response.status, 403);

  const reads = await Promise.all(Array.from({ length: 12 }, () => request(lanOrigin, "/api/bootstrap", { cookie: viewer.cookie })));
  assert.ok(reads.every((item) => item.response.status === 200));
  assert.ok(reads.every((item) => item.payload.targets.length === 1));

  const queueDetails = await request(lanOrigin, "/api/author-resolution-queue?status=all", { cookie: viewer.cookie });
  assert.equal(queueDetails.response.status, 200);
  assert.deepEqual(queueDetails.payload.items, []);
  assert.equal(queueDetails.payload.summary.total, 0);

  const ownerDelete = await request(localOrigin, `/api/targets/${targetId}`, { method: "DELETE", cookie: ownerCookie, csrf: ownerCsrf });
  assert.equal(ownerDelete.response.status, 200);

  const authorJob = await request(lanOrigin, "/api/author-spreadsheet/auto-monitor", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: {
      fileName: "author-test.xlsx",
      sheetName: "名单",
      rows: [{ sourceRow: 2, board: "HTTP验收板块", name: "测试作者", platform: "douyin", status: "ready", locator: "MS4wLjABAAAAdurableJobTest123456789012345678901234567890" }],
    },
  });
  assert.equal(authorJob.response.status, 202);
  let durableJob = authorJob.payload;
  for (let attempt = 0; attempt < 80 && !["completed", "failed"].includes(durableJob.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const readJob = await request(lanOrigin, `/api/author-spreadsheet/jobs/${durableJob.id}`, { cookie: editor.cookie });
    assert.equal(readJob.response.status, 200);
    durableJob = readJob.payload;
  }
  assert.equal(durableJob.status, "completed");
  assert.equal(durableJob.result.createdCount, 1);

  const idempotencyKey = "99999999-2222-4333-8444-555555555555";
  const idempotentImportBody = {
    fileName: "幂等集成测试.csv", sheetName: importPreview.payload.selectedSheet,
    uploadSha256: importPreview.payload.uploadSha256, rows: importPreview.payload.rows,
    boardCatalog: importPreview.payload.boardCatalog || [], defaultBoard: "",
  };
  const concurrentIdempotentImports = await Promise.all(Array.from({ length: 2 }, () => request(lanOrigin, "/api/author-spreadsheet/auto-monitor", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf,
    headers: { "Idempotency-Key": idempotencyKey }, body: idempotentImportBody,
  })));
  assert.deepEqual(concurrentIdempotentImports.map((item) => item.response.status).sort(), [200, 202]);
  assert.equal(concurrentIdempotentImports[0].payload.id, concurrentIdempotentImports[1].payload.id);
  const acceptedIdempotentImport = concurrentIdempotentImports.find((item) => item.response.status === 202);
  const replayedIdempotentImport = concurrentIdempotentImports.find((item) => item.response.status === 200);
  assert.equal(replayedIdempotentImport.payload.id, acceptedIdempotentImport.payload.id);
  assert.equal(replayedIdempotentImport.payload.idempotencyReplay, true);
  const changedSourceRetry = await request(lanOrigin, "/api/author-spreadsheet/auto-monitor", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf,
    headers: { "Idempotency-Key": idempotencyKey },
    body: { ...idempotentImportBody, defaultBoard: "不同板块" },
  });
  assert.equal(changedSourceRetry.response.status, 409);
  const changedCatalogRetry = await request(lanOrigin, "/api/author-spreadsheet/auto-monitor", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf,
    headers: { "Idempotency-Key": idempotencyKey },
    body: { ...idempotentImportBody, boardCatalog: [{ name: "冲突重试不得创建的目录" }] },
  });
  assert.equal(changedCatalogRetry.response.status, 409, "same file hash cannot silently replay changed board catalog");
  const changedRowsRetry = await request(lanOrigin, "/api/author-spreadsheet/auto-monitor", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf,
    headers: { "Idempotency-Key": idempotencyKey },
    body: { ...idempotentImportBody, rows: idempotentImportBody.rows.map(row => ({ ...row, owner: "更改后的负责人" })) },
  });
  assert.equal(changedRowsRetry.response.status, 409, "same upload hash must not swallow changed author information");
  const idempotencyRows = new DatabaseSync(join(dataDir, "douyin-monitor.sqlite"), { readOnly: true });
  assert.equal(idempotencyRows.prepare("SELECT COUNT(*) AS count FROM board_catalog WHERE board_name IN (?,?)").get("不同板块", "冲突重试不得创建的目录").count, 0, "409 requests must not create empty boards");
  assert.equal(idempotencyRows.prepare("SELECT COUNT(*) AS count FROM author_resolution_idempotency WHERE user_id=? AND idempotency_key=?").get(editor.session.user.id, idempotencyKey).count, 1);
  assert.equal(idempotencyRows.prepare("SELECT COUNT(*) AS count FROM author_resolution_jobs WHERE id=?").get(acceptedIdempotentImport.payload.id).count, 1);
  idempotencyRows.close();
  const viewerBootstrap = await request(lanOrigin, "/api/bootstrap", { cookie: viewer.cookie });
  assert.deepEqual(viewerBootstrap.payload.authorResolutionJobs, []);
  const editorBootstrap = await request(lanOrigin, "/api/bootstrap", { cookie: editor.cookie });
  const editorDurableJob = editorBootstrap.payload.authorResolutionJobs.find((job) => job.id === durableJob.id);
  assert.equal(editorDurableJob.id, durableJob.id);
  assert.equal(editorDurableJob.status, "completed");
  const adminBootstrap = await request(localOrigin, "/api/bootstrap", { cookie: ownerCookie });
  assert.ok(adminBootstrap.payload.authorResolutionJobs.some((job) => job.id === durableJob.id));
  const editorRecentJobs = await request(lanOrigin, "/api/author-spreadsheet/jobs/recent?limit=8", { cookie: editor.cookie });
  assert.equal(editorRecentJobs.response.status, 200);
  const compactDurableJob = editorRecentJobs.payload.jobs.find((job) => job.id === durableJob.id);
  assert.equal(compactDurableJob.id, durableJob.id);
  assert.equal("result" in compactDurableJob, false, "recent-job lookup omits potentially large row-level outcomes");
  const ownerMine = await request(localOrigin, "/api/author-spreadsheet/jobs/recent?scope=mine&limit=20", { cookie: ownerCookie });
  assert.equal(ownerMine.response.status, 200);
  assert.equal(ownerMine.payload.scope, "mine");
  assert.ok(!ownerMine.payload.jobs.some(job => job.id === durableJob.id), "admin mine excludes editor jobs");
  const ownerAll = await request(localOrigin, "/api/author-spreadsheet/jobs/recent?limit=20", { cookie: ownerCookie });
  assert.ok(ownerAll.payload.jobs.some(job => job.id === durableJob.id), "legacy admin all remains available");
  const editorMine = await request(lanOrigin, "/api/author-spreadsheet/jobs/recent?scope=mine&limit=1", { cookie: editor.cookie });
  assert.equal(editorMine.payload.scope, "mine");
  assert.equal(editorMine.payload.jobs.length, 1, "explicit mine remains bounded");
  const viewerRecentJobs = await request(lanOrigin, "/api/author-spreadsheet/jobs/recent", { cookie: viewer.cookie });
  assert.equal(viewerRecentJobs.response.status, 403, "read-only users cannot use the import task lookup");

  const exportCases = [
    ["", "全部板块", /-all-report\.md/, /filename\*=UTF-8''content-platform-day-all-report\.md/],
    ["&board=HTTP%E9%AA%8C%E6%94%B6%E6%9D%BF%E5%9D%97", "HTTP验收板块", /-board-[a-f0-9]{8}-report\.md/, /filename\*=UTF-8''content-platform-day-HTTP%E9%AA%8C%E6%94%B6%E6%9D%BF%E5%9D%97-[a-f0-9]{8}-report\.md/],
    ["&board=__unassigned__", "未分板块", /-unassigned-report\.md/, /filename\*=UTF-8''content-platform-day-unassigned-report\.md/],
  ];
  for (const [scopeQuery, scopeName, filenamePattern, readableFilenamePattern] of exportCases) {
    const response = await fetch(`${lanOrigin}/api/export?period=day&format=md${scopeQuery}`, { headers: { Origin: lanOrigin, Cookie: viewer.cookie } });
    assert.equal(response.status, 200);
    const disposition = response.headers.get("content-disposition") || "";
    assert.match(disposition, filenamePattern);
    assert.match(disposition, readableFilenamePattern);
    const markdown = await response.text();
    assert.match(markdown, new RegExp(`板块：${scopeName}`));
    assert.doesNotMatch(markdown, /\bnull\b/);
    assert.match(markdown, /本期没有已采集发布作品/);
  }
  const reportCsvResponse = await fetch(`${lanOrigin}/api/export?period=day&format=csv&board=HTTP%E9%AA%8C%E6%94%B6%E6%9D%BF%E5%9D%97`, { headers: { Origin: lanOrigin, Cookie: viewer.cookie } });
  assert.match(await reportCsvResponse.text(), /^\uFEFF?报告筛选范围（HTTP验收板块）[^,]*,作品ID/);
  const growthCsvResponse = await fetch(`${lanOrigin}/api/export?period=day&format=csv&scope=growth&board=__unassigned__`, { headers: { Origin: lanOrigin, Cookie: viewer.cookie } });
  assert.match(await growthCsvResponse.text(), /^\uFEFF?报告周期,区间开始,区间结束,报告筛选范围（未分板块）[^,]*,全部归属/);

  const unsafeUrl = "https://alice:secret@www.douyin.com/user/MS4wLjABAAAAcredentialMustNeverPersist1234567890";
  const reviewJobResponse = await request(lanOrigin, "/api/author-spreadsheet/auto-monitor", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: {
      fileName: "205-conflicts.xlsx",
      sheetName: "作者名单",
      rows: Array.from({ length: 205 }, (_, index) => ({
        sourceRow: index + 2,
        board: "严格审查板块",
        name: `冲突作者${index + 1}`,
        platform: "douyin",
        locator: unsafeUrl,
        videoLink: unsafeUrl,
        videoHyperlink: unsafeUrl,
        status: "identity_conflict",
        identityConflict: "强身份不一致",
        reason: "身份冲突，需修正原表后重新提交",
      })),
    },
  });
  assert.equal(reviewJobResponse.response.status, 202);
  let reviewJob = reviewJobResponse.payload;
  for (let attempt = 0; attempt < 100 && !["completed", "failed"].includes(reviewJob.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    reviewJob = (await request(lanOrigin, `/api/author-spreadsheet/jobs/${reviewJob.id}`, { cookie: editor.cookie })).payload;
  }
  assert.equal(reviewJob.status, "completed");
  assert.equal(reviewJob.result.skippedTotal, 205);
  assert.equal(reviewJob.result.skipped.length, 200, "job detail stays compact while the durable result remains complete");
  assert.equal(reviewJob.result.reviewRequiredCount, 205);
  assert.ok(reviewJob.result.skipped.every((item) => !JSON.stringify(item).includes("alice:secret")));
  const compactReviewJob = (await request(lanOrigin, "/api/bootstrap", { cookie: editor.cookie })).payload.authorResolutionJobs[0];
  assert.equal(compactReviewJob.result.skipped.length, 20);
  assert.equal(compactReviewJob.result.skippedTotal, 205);
  const lastPage = await request(lanOrigin, `/api/author-spreadsheet/jobs/${reviewJob.id}/skipped?offset=200&limit=20`, { cookie: editor.cookie });
  assert.equal(lastPage.payload.total, 205);
  assert.equal(lastPage.payload.items.length, 5);
  const reviewCsvResponse = await fetch(`${lanOrigin}/api/author-spreadsheet/jobs/${reviewJob.id}/skipped?format=csv`, { headers: { Origin: lanOrigin, Cookie: editor.cookie } });
  const reviewCsv = await reviewCsvResponse.text();
  assert.equal(reviewCsvResponse.status, 200);
  assert.match(reviewCsv, /链接安全处理/);
  assert.doesNotMatch(reviewCsv, /alice:secret/);
  assert.match(reviewCsv, /冲突作者205/);
  const stored = new DatabaseSync(join(dataDir, "douyin-monitor.sqlite"), { readOnly: true });
  const storedJob = stored.prepare("SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?").get(reviewJob.id);
  stored.close();
  assert.doesNotMatch(`${storedJob.request_json}\n${storedJob.result_json}`, /alice:secret/);
  assert.match(storedJob.request_json, /含凭据|链接已移除|rejectedLink/);

  const emptyReviewResponse = await request(lanOrigin, "/api/author-spreadsheet/auto-monitor", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: {
      fileName: "empty-review.xlsx",
      rows: [{ sourceRow: 2, board: "空行", status: "needs_locator", reason: "没有任何作者线索" }],
    },
  });
  assert.equal(emptyReviewResponse.response.status, 400, "a review job still requires an actual author clue");

  const targetsBeforeNameOnlyReview = await request(lanOrigin, "/api/targets", { cookie: editor.cookie });
  assert.equal(targetsBeforeNameOnlyReview.response.status, 200);
  const targetIdsBeforeNameOnlyReview = targetsBeforeNameOnlyReview.payload.targets.map((target) => target.id);
  const boardsBeforeNameOnlyReview = targetsBeforeNameOnlyReview.payload.boards.map((board) => board.key);
  const nameOnlyJobResponse = await request(lanOrigin, "/api/author-spreadsheet/auto-monitor", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: {
      fileName: "205-name-only.xlsx",
      sheetName: "作者名单",
      rows: Array.from({ length: 205 }, (_, index) => ({
        sourceRow: index + 2,
        board: "仅名称待核验",
        name: `纯名称作者${index + 1}`,
        platform: index % 3 === 0 ? "bilibili" : index % 3 === 1 ? "xiaohongshu" : "douyin",
        status: "needs_locator",
        reason: "只有作者名称，缺少可唯一确认的公开强身份证据",
      })),
    },
  });
  assert.equal(nameOnlyJobResponse.response.status, 202, "name-only rows must be accepted into the durable review workflow");
  assert.equal(nameOnlyJobResponse.payload.totalAuthors, 205);
  let nameOnlyJob = nameOnlyJobResponse.payload;
  for (let attempt = 0; attempt < 100 && !["completed", "failed"].includes(nameOnlyJob.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    nameOnlyJob = (await request(lanOrigin, `/api/author-spreadsheet/jobs/${nameOnlyJob.id}`, { cookie: editor.cookie })).payload;
  }
  assert.equal(nameOnlyJob.status, "completed");
  assert.equal(nameOnlyJob.result.createdCount, 0);
  assert.equal(nameOnlyJob.result.monitoringEnabled, 0);
  assert.equal(nameOnlyJob.result.queuedAuthors, 0);
  assert.equal(nameOnlyJob.result.needsLocatorReviewCount, 205);
  assert.equal(nameOnlyJob.result.reviewRequiredCount, 205);
  assert.equal(nameOnlyJob.result.skippedTotal, 205);
  assert.equal(nameOnlyJob.result.resolution.requestedAuthors, 0, "name-only rows must never reach public author resolution");
  const targetsAfterNameOnlyReview = await request(lanOrigin, "/api/targets", { cookie: editor.cookie });
  assert.deepEqual(targetsAfterNameOnlyReview.payload.targets.map((target) => target.id), targetIdsBeforeNameOnlyReview, "name-only review must never add a monitoring target");
  assert.deepEqual(targetsAfterNameOnlyReview.payload.boards.map((board) => board.key).sort(), [...boardsBeforeNameOnlyReview, "仅名称待核验"].sort(), "explicit source board remains visible even before a monitor exists");
  assert.equal(targetsAfterNameOnlyReview.payload.boards.find((board) => board.key === "仅名称待核验").targetCount, 0, "a saved directory is not a verified monitoring account");
  const nameOnlyCsvResponse = await fetch(`${lanOrigin}/api/author-spreadsheet/jobs/${nameOnlyJob.id}/skipped?format=csv`, { headers: { Origin: lanOrigin, Cookie: editor.cookie } });
  const nameOnlyCsv = await nameOnlyCsvResponse.text();
  assert.equal(nameOnlyCsvResponse.status, 200);
  assert.equal(nameOnlyCsv.trim().split("\n").length, 206, "the CSV must contain its header and every review row");
  assert.equal((nameOnlyCsv.match(/needs_locator/g) || []).length, 205);
  assert.match(nameOnlyCsv, /纯名称作者1/);
  assert.match(nameOnlyCsv, /纯名称作者205/);
  const persistedNameOnly = new DatabaseSync(join(dataDir, "douyin-monitor.sqlite"), { readOnly: true });
  const storedNameOnlyJob = persistedNameOnly.prepare("SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?").get(nameOnlyJob.id);
  persistedNameOnly.close();
  assert.match(storedNameOnlyJob.request_json, /纯名称作者205/);
  assert.match(storedNameOnlyJob.result_json, /纯名称作者205/);

  // Re-parse the same bytes after import has completed: ready -> existing is
  // a live lookup change, not a different upload (including no board at all).
  const noBoardBytes = Buffer.from("作者名称,sec_uid\n无板块安全重试,MS4wLjABAAAAnoboardReplay202610091234567890123456\n");
  const noBoardBody = {
    fileName: "无板块安全重试.csv", contentBase64: noBoardBytes.toString("base64"),
    uploadSha256: createHash("sha256").update(noBoardBytes).digest("hex"),
    assignments: [{ sheetName: "CSV", defaultBoard: "", idempotencyKey: "99999999-2222-4333-8444-555555555559" }],
  };
  const noBoardFirst = await request(lanOrigin, "/api/author-spreadsheet/auto-monitor-batch", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: noBoardBody,
  });
  assert.equal(noBoardFirst.payload.acceptedCount, 1);
  let noBoardJob = noBoardFirst.payload.results[0].job;
  for (let attempt = 0; attempt < 80 && !["completed", "failed"].includes(noBoardJob.status); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 30));
    noBoardJob = (await request(lanOrigin, `/api/author-spreadsheet/jobs/${noBoardJob.id}`, { cookie: editor.cookie })).payload;
  }
  assert.equal(noBoardJob.status, "completed");
  const noBoardPreview = await request(lanOrigin, "/api/author-spreadsheet/preview", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: noBoardBody,
  });
  assert.equal(noBoardPreview.payload.rows[0].status, "existing");
  const noBoardReplay = await request(lanOrigin, "/api/author-spreadsheet/auto-monitor-batch", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf, body: noBoardBody,
  });
  assert.equal(noBoardReplay.payload.replayedCount, 1, JSON.stringify(noBoardReplay.payload));
  assert.equal(noBoardReplay.payload.results[0].job.id, noBoardJob.id);
  const knownAgain = await request(lanOrigin, "/api/author-spreadsheet/auto-monitor-batch", {
    method: "POST", cookie: editor.cookie, csrf: editor.csrf,
    body: { ...noBoardBody, assignments: [{ ...noBoardBody.assignments[0], idempotencyKey: "99999999-2222-4333-8444-555555555558" }] },
  });
  assert.equal(knownAgain.payload.acceptedCount, 1);
  let knownJob = knownAgain.payload.results[0].job;
  for (let attempt = 0; attempt < 80 && !["completed", "failed"].includes(knownJob.status); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 30));
    knownJob = (await request(lanOrigin, `/api/author-spreadsheet/jobs/${knownJob.id}`, { cookie: editor.cookie })).payload;
  }
  assert.equal(knownJob.status, "completed");
  assert.equal(knownJob.result.createdCount, 0);
  assert.equal(knownJob.result.reusedExistingCount, 1);
  assert.equal(knownJob.result.reviewRequiredCount, 0, "known accounts without new boards need no identity review");
  assert.equal(knownJob.result.skipped[0].status, "existing");

  const automaticBackups = await readdir(join(dataDir, "backups", "automatic"));
  assert.ok(automaticBackups.some((name) => /^douyin-monitor-auto-.*-startup-.*\.sqlite$/.test(name)));
  assert.ok(automaticBackups.some((name) => name.endsWith(".sqlite.manifest.json")));
});
