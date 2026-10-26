import { readFile, writeFile } from "node:fs/promises";
import { parseAuthorSpreadsheet, authorPreviewContentSha256 } from "../lib/author-spreadsheet.mjs";

const directory = "data/yuqilin-import-Nl4JQn";
const base = "http://127.0.0.1:4188";
const sourceUrl = "https://my.feishu.cn/sheets/U0FIsi9nMh2dAqtBlZ4cOtI6nIg?sheet=a058df";
const action = process.argv[2];
if (!["preview", "submit", "status"].includes(action)) throw new Error("Expected preview, submit, or status");
const authResponse = await fetch(`${base}/api/bootstrap`);
const cookie = authResponse.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
const auth = await authResponse.json();
if (!authResponse.ok || !auth.auth?.csrfToken) throw new Error("Local authentication failed");
const headers = { "content-type": "application/json", cookie, "x-csrf-token": auth.auth.csrfToken, origin: base };
const request = async (path, body) => {
  const response = await fetch(`${base}${path}`, { headers, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${value.error || "Request failed"}`);
  return value;
};
if (action === "preview") {
  const preview = await request("/api/author-spreadsheet/lark-preview", { url: sourceUrl });
  const local = await parseAuthorSpreadsheet({ buffer: await readFile(`${directory}/source-cells.xlsx`), fileName: preview.fileName, sheetName: "8月" });
  if (preview.summary.totalRows !== 174 || preview.source.revision !== 2 || preview.dataRange !== "A1:H175") throw new Error("Unexpected cloud source version or coverage");
  if (preview.source.contentSha256 !== authorPreviewContentSha256(local)) throw new Error("Cloud and independently audited source differ");
  if (Object.keys(preview.mapping).some(field => !["name", "douyinId", "videoLink"].includes(field))) throw new Error("Unexpected metric or identity mapping");
  await writeFile(`${directory}/app-preview.json`, JSON.stringify(preview, null, 2));
  console.log(JSON.stringify({ verified: true, source: preview.source, summary: preview.summary, mapping: preview.mapping }));
} else if (action === "submit") {
  try { await readFile(`${directory}/submitted-job.json`); throw new Error("This audited batch has already been submitted; inspect status instead"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const preview = JSON.parse(await readFile(`${directory}/app-preview.json`, "utf8"));
  const job = await request("/api/author-spreadsheet/auto-monitor", {
    sourceType: "lark-sheet", sourceUrl, sourceSha256: preview.source.contentSha256,
    sourceRevision: preview.source.revision, sheetName: "8月", defaultBoard: "玉麒麟切片矩阵",
  });
  await writeFile(`${directory}/submitted-job.json`, JSON.stringify(job, null, 2));
  console.log(JSON.stringify(job));
} else {
  const submitted = JSON.parse(await readFile(`${directory}/submitted-job.json`, "utf8"));
  const job = await request(`/api/author-spreadsheet/jobs/${submitted.id}`);
  const queue = await request(`/api/author-resolution-queue?board=${encodeURIComponent("玉麒麟切片矩阵")}&status=all&limit=500`);
  const targets = await request("/api/targets");
  await writeFile(`${directory}/app-status.json`, JSON.stringify({ readAt: new Date().toISOString(), job, queue, targets: targets.targets.filter(target => target.boards?.some(board => board.name === "玉麒麟切片矩阵")), board: targets.boards.find(board => board.name === "玉麒麟切片矩阵") }, null, 2));
  const { skipped, created, ...result } = job.result || {};
  console.log(JSON.stringify({ job: { ...job, result }, board: targets.boards.find(board => board.name === "玉麒麟切片矩阵"), queueSummary: queue.summary, queueKeys: Object.keys(queue) }));
}
