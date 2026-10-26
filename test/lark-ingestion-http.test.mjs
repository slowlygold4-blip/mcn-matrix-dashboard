import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { DatabaseSync } from "node:sqlite";

const SHEET_URL = "https://example.feishu.cn/sheets/AbCdEfGhIjKlMnOp?sheet=sheet_authors&utm_source=copy#range=A1";
const NORMALIZED_SHEET_URL = "https://example.feishu.cn/sheets/AbCdEfGhIjKlMnOp?sheet=sheet_authors";
const AUXILIARY_SHEET_URL = "https://example.feishu.cn/sheets/AbCdEfGhIjKlMnOp?sheet=sheet_intro";
const NORMALIZED_AUXILIARY_SHEET_URL = "https://example.feishu.cn/sheets/AbCdEfGhIjKlMnOp?sheet=sheet_intro";
const PROFILE_SEC_UID = "MS4wLjABAAAAlarkE2EProfileEvidence1234567890";

async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function cookieFrom(response) {
  return String(response.headers.get("set-cookie") ?? "").split(";")[0];
}

async function request(origin, path, { method = "GET", cookie, csrf, body } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await response.json().catch(() => null) };
}

async function writeWorkbook(path, profileName) {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("说明").addRow(["请选择作者监控页"]);
  const sheet = workbook.addWorksheet("作者监控");
  sheet.addRow(["作者昵称", "抖音号", "作者主页", "内容ID", "视频链接", "所属机构", "量级", "内容类型"]);
  sheet.addRow([
    profileName,
    "",
    `https://www.douyin.com/user/${PROFILE_SEC_UID}`,
    "",
    "",
    "机构直连",
    "A级",
    "游戏",
  ]);
  sheet.addRow(["分享线索作者", "", "https://v.douyin.com/E2EShare01/", "", "", "机构分享", "B级", "泛娱乐"]);
  sheet.getCell("E3").value = { text: "作品链接", hyperlink: "https://v.douyin.com/E2EShare01/" };
  for (let index = 0; index < 36; index += 1) {
    sheet.addRow([
      `ID线索作者${index + 1}`,
      `douyin-e2e-${index + 1}`,
      "",
      String(7_670_000_000_000_000_000n + BigInt(index)),
      "",
      `机构${index + 1}`,
      "C级",
      "游戏",
    ]);
  }
  sheet.addRow(["仅名称待核验", "", "", "", "", "机构名称", "D级", "其他"]);
  await workbook.xlsx.writeFile(path);
}

async function waitForJob(origin, jobId, session, logs) {
  let job = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(origin, `/api/author-spreadsheet/jobs/${jobId}`, { cookie: session.cookie });
    assert.equal(response.response.status, 200);
    job = response.payload;
    if (["completed", "failed"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`author job did not finish (last=${JSON.stringify(job)}): ${logs()}`);
}

function submissionFromPreview(preview, extra = {}) {
  return {
    sourceType: "lark-sheet",
    sourceUrl: SHEET_URL,
    sheetName: preview.selectedSheet,
    sourceRevision: preview.source.revision,
    sourceSha256: preview.source.contentSha256,
    sourceExportSha256: preview.source.exportSha256,
    rows: [{ sourceRow: 2, name: "客户端伪造行", locator: "MS4wLjABAAAAclientPayloadMustBeIgnored1234567890" }],
    ...extra,
  };
}

test("Lark URL ingestion re-reads before commit, rejects TOCTOU changes, preserves provenance and stays idempotent", { timeout: 20_000 }, async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "douyin-monitor-lark-http-"));
  const dataDir = join(tempDir, "data");
  const firstWorkbook = join(tempDir, "authors-v1.xlsx");
  const secondWorkbook = join(tempDir, "authors-v2.xlsx");
  const statePath = join(tempDir, "lark-state.json");
  const callsPath = join(tempDir, "lark-calls.jsonl");
  const fakeCliPath = join(tempDir, "lark-cli-fixture.mjs");
  await writeWorkbook(firstWorkbook, "主页作者旧版");
  await writeWorkbook(secondWorkbook, "主页作者最新版");
  await writeFile(fakeCliPath, `#!/usr/bin/env node
import { appendFileSync, copyFileSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.FAKE_LARK_STATE, "utf8"));
appendFileSync(process.env.FAKE_LARK_CALLS, JSON.stringify(args) + "\\n");
if (args[0] !== "sheets") process.exit(2);
if (args[1] === "+workbook-info") {
  console.log(JSON.stringify({ ok: true, identity: "user", data: {
    title: "隔离飞书作者源", revision: state.revision,
    sheets: [
      { sheet_id: "sheet_intro", sheet_name: "说明", row_count: 1, column_count: 1, is_hidden: false },
      { sheet_id: "sheet_authors", sheet_name: "作者监控", row_count: 40, column_count: 8, is_hidden: false }
    ]
  } }));
} else if (args[1] === "+workbook-export") {
  const output = args[args.indexOf("--output-path") + 1];
  const destination = resolve(process.cwd(), output);
  copyFileSync(state.workbook, destination);
  console.log(JSON.stringify({ ok: true, identity: "user", data: {
    file_name: "隔离飞书作者源", file_size: statSync(destination).size
  } }));
} else process.exit(3);
`);
  await chmod(fakeCliPath, 0o755);
  const writeState = async (workbook, revision) => writeFile(statePath, JSON.stringify({ workbook, revision }));
  await writeState(firstWorkbook, 41);

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let logs = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "test",
      LARK_CLI_BIN: fakeCliPath,
      FAKE_LARK_STATE: statePath,
      FAKE_LARK_CALLS: callsPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => child.exitCode === null ? child.once("exit", resolve) : resolve());
    await rm(tempDir, { recursive: true, force: true });
  });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch {}
    if (attempt === 99) assert.fail(`server did not start: ${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const auth = await request(origin, "/api/auth/session");
  assert.equal(auth.response.status, 200);
  assert.equal(auth.payload.user.role, "admin");
  const session = { cookie: cookieFrom(auth.response), csrf: auth.payload.csrfToken };

  const auxiliaryPreviewResponse = await request(origin, "/api/author-spreadsheet/lark-preview", {
    method: "POST", cookie: session.cookie, csrf: session.csrf, body: { url: AUXILIARY_SHEET_URL },
  });
  assert.equal(auxiliaryPreviewResponse.response.status, 200, JSON.stringify(auxiliaryPreviewResponse.payload));
  assert.equal(auxiliaryPreviewResponse.payload.selectedSheet, "作者监控", "辅助说明页 URL 必须回退自动选择作者数据页");
  assert.equal(auxiliaryPreviewResponse.payload.source.selectedSheetId, "sheet_authors");
  const auxiliaryReread = await request(origin, "/api/author-spreadsheet/auto-monitor", {
    method: "POST", cookie: session.cookie, csrf: session.csrf, body: {
      sourceType: "lark-sheet",
      sourceUrl: AUXILIARY_SHEET_URL,
      sourceRevision: auxiliaryPreviewResponse.payload.source.revision,
      sourceSha256: "",
      rows: [],
    },
  });
  assert.equal(auxiliaryReread.response.status, 400);
  assert.match(auxiliaryReread.payload.error, /预览凭证缺失/, "自动提交复读也必须先成功避开辅助说明页");

  const previewV1Response = await request(origin, "/api/author-spreadsheet/lark-preview", {
    method: "POST", cookie: session.cookie, csrf: session.csrf, body: { url: SHEET_URL },
  });
  assert.equal(previewV1Response.response.status, 200);
  const previewV1 = previewV1Response.payload;
  assert.equal(previewV1.source.url, NORMALIZED_SHEET_URL);
  assert.equal(previewV1.source.revision, 41);
  assert.equal(previewV1.source.selectedSheetId, "sheet_authors");
  assert.equal(previewV1.selectedSheet, "作者监控");
  assert.equal(previewV1.dataRange, "A1:H40");
  assert.equal(previewV1.summary.totalRows, 39);
  assert.equal(previewV1.summary.importableRows, 1);
  assert.equal(previewV1.summary.resolvableRows, 37);
  assert.equal(previewV1.summary.needsLocatorRows, 1);
  assert.match(previewV1.source.contentSha256, /^[a-f0-9]{64}$/);
  assert.match(previewV1.source.exportSha256, /^[a-f0-9]{64}$/);
  assert.equal(previewV1.mapping.name.header, "作者昵称");
  assert.equal(previewV1.mapping.douyinId.header, "抖音号");
  assert.equal(previewV1.mapping.locator.header, "作者主页");
  assert.equal(previewV1.mapping.videoLink.header, "视频链接");

  await writeState(secondWorkbook, 41);
  const changedContent = await request(origin, "/api/author-spreadsheet/auto-monitor", {
    method: "POST", cookie: session.cookie, csrf: session.csrf, body: submissionFromPreview(previewV1),
  });
  assert.equal(changedContent.response.status, 409);
  assert.match(changedContent.payload.error, /预览后发生变化/);

  const previewV2Response = await request(origin, "/api/author-spreadsheet/lark-preview", {
    method: "POST", cookie: session.cookie, csrf: session.csrf, body: { url: SHEET_URL },
  });
  assert.equal(previewV2Response.response.status, 200);
  const previewV2 = previewV2Response.payload;
  assert.notEqual(previewV2.source.contentSha256, previewV1.source.contentSha256);
  await writeState(secondWorkbook, 42);
  const changedRevision = await request(origin, "/api/author-spreadsheet/auto-monitor", {
    method: "POST", cookie: session.cookie, csrf: session.csrf, body: submissionFromPreview(previewV2),
  });
  assert.equal(changedRevision.response.status, 409);
  assert.match(changedRevision.payload.error, /预览后发生变化/);

  const beforeSuccess = await request(origin, "/api/bootstrap", { cookie: session.cookie });
  assert.equal(beforeSuccess.payload.targets.length, 0);
  assert.equal(beforeSuccess.payload.authorResolutionJobs.length, 0);
  const beforeQueue = await request(origin, "/api/author-resolution-queue?status=all", { cookie: session.cookie });
  assert.equal(beforeQueue.payload.summary.total, 0);

  const acceptedPreviewResponse = await request(origin, "/api/author-spreadsheet/lark-preview", {
    method: "POST", cookie: session.cookie, csrf: session.csrf, body: { url: SHEET_URL },
  });
  assert.equal(acceptedPreviewResponse.response.status, 200);
  const acceptedPreview = acceptedPreviewResponse.payload;
  assert.equal(acceptedPreview.source.revision, 42);
  const accepted = await request(origin, "/api/author-spreadsheet/auto-monitor", {
    method: "POST", cookie: session.cookie, csrf: session.csrf, body: submissionFromPreview(acceptedPreview),
  });
  assert.equal(accepted.response.status, 202);
  const completed = await waitForJob(origin, accepted.payload.id, session, () => logs);
  assert.equal(completed.status, "completed", completed.error || logs);
  assert.equal(completed.result.createdCount, 1);
  assert.equal(completed.result.queuedAuthors, 37);
  assert.equal(completed.result.resolution.requestedAuthors, 37);
  assert.equal(completed.result.created[0].label, "主页作者最新版", "the server-side re-read must replace untrusted submitted rows");
  const storedDatabase = new DatabaseSync(join(dataDir, "douyin-monitor.sqlite"), { readOnly: true });
  const storedRequest = JSON.parse(storedDatabase.prepare("SELECT request_json FROM author_resolution_jobs WHERE id=?").get(completed.id).request_json);
  storedDatabase.close();
  assert.equal(storedRequest.rows.find((row) => row.sourceRow === 3).videoHyperlink, "https://v.douyin.com/E2EShare01/", "embedded public link provenance must survive job sanitization");
  const targetMetadata = completed.result.created[0].metadata;
  assert.equal(targetMetadata.organization, "机构直连");
  assert.equal(targetMetadata.tier, "A级");
  assert.equal(targetMetadata.category, "游戏");
  assert.equal(targetMetadata.importSource.type, "lark-sheet");
  assert.equal(targetMetadata.importSource.sourceUrl, NORMALIZED_SHEET_URL);
  assert.equal(targetMetadata.importSource.sourceRevision, 42);
  assert.equal(targetMetadata.importSource.sourceSheetId, "sheet_authors");
  assert.equal(targetMetadata.importSource.sourceRange, "A1:H40");
  assert.equal(targetMetadata.importSource.sourceSha256, acceptedPreview.source.contentSha256);
  assert.equal(targetMetadata.importSource.sourceExportSha256, acceptedPreview.source.exportSha256);
  assert.ok(!Number.isNaN(new Date(targetMetadata.importSource.sourceReadAt).getTime()));

  const queue = await request(origin, "/api/author-resolution-queue?status=all&limit=100", { cookie: session.cookie });
  assert.equal(queue.response.status, 200);
  assert.equal(queue.payload.summary.total, 37);
  assert.equal(queue.payload.summary.pending, 37);
  assert.equal(queue.payload.items.length, 37);
  const shareItem = queue.payload.items.find((item) => item.name === "分享线索作者");
  assert.deepEqual(shareItem.shareUrls, ["https://v.douyin.com/E2EShare01/"]);
  assert.equal(shareItem.organization, "机构分享");
  assert.equal(shareItem.tier, "B级");
  assert.equal(shareItem.category, "泛娱乐");
  assert.equal(shareItem.sourceMetadata.sourceType, "lark-sheet");
  assert.equal(shareItem.sourceMetadata.sourceUrl, NORMALIZED_SHEET_URL);
  assert.equal(shareItem.sourceMetadata.sourceRevision, 42);
  assert.equal(shareItem.sourceMetadata.sourceSheetId, "sheet_authors");
  assert.equal(shareItem.sourceMetadata.sourceRange, "A1:H40");
  assert.equal(shareItem.sourceMetadata.sourceSha256, acceptedPreview.source.contentSha256);
  assert.equal(shareItem.sourceMetadata.sourceExportSha256, acceptedPreview.source.exportSha256);

  const duplicatePreviewResponse = await request(origin, "/api/author-spreadsheet/lark-preview", {
    method: "POST", cookie: session.cookie, csrf: session.csrf, body: { url: SHEET_URL },
  });
  assert.equal(duplicatePreviewResponse.response.status, 200);
  assert.equal(duplicatePreviewResponse.payload.summary.existingRows, 1);
  const duplicate = await request(origin, "/api/author-spreadsheet/auto-monitor", {
    method: "POST", cookie: session.cookie, csrf: session.csrf, body: submissionFromPreview(duplicatePreviewResponse.payload),
  });
  assert.equal(duplicate.response.status, 202);
  const duplicateCompleted = await waitForJob(origin, duplicate.payload.id, session, () => logs);
  assert.equal(duplicateCompleted.status, "completed", duplicateCompleted.error || logs);
  assert.equal(duplicateCompleted.result.createdCount, 0);
  assert.equal(duplicateCompleted.result.queuedAuthors, 37);
  const afterDuplicate = await request(origin, "/api/bootstrap", { cookie: session.cookie });
  assert.equal(afterDuplicate.payload.targets.length, 1);
  assert.equal(afterDuplicate.payload.targets[0].label, "主页作者最新版");
  const duplicateQueue = await request(origin, "/api/author-resolution-queue?status=all&limit=100", { cookie: session.cookie });
  assert.equal(duplicateQueue.payload.summary.total, 37, "queue upserts must not multiply the same author evidence");

  const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls.length, 20);
  for (const args of calls) {
    assert.ok([NORMALIZED_SHEET_URL, NORMALIZED_AUXILIARY_SHEET_URL].includes(args[args.indexOf("--url") + 1]));
    assert.equal(args.includes("--as") && args[args.indexOf("--as") + 1], "user");
    assert.equal(args.includes("--json"), true);
  }
});
