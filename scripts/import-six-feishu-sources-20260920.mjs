import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const base = "http://127.0.0.1:4188";
const boardName = "一条小团团切片矩阵";
const inputPath = resolve(fileURLToPath(new URL("../data/feishu-six-sources-20260920/normalized-dedup.json", import.meta.url)));
const receiptPath = resolve(fileURLToPath(new URL("../data/feishu-six-sources-20260920/import-receipt.json", import.meta.url)));
const input = JSON.parse(await readFile(inputPath, "utf8"));

try {
  await readFile(receiptPath, "utf8");
  throw new Error(`导入回执已存在：${receiptPath}。为避免重复提交，请保留现有回执并新建日期快照。`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const bootstrapResponse = await fetch(`${base}/api/bootstrap`);
const cookies = typeof bootstrapResponse.headers.getSetCookie === "function"
  ? bootstrapResponse.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ")
  : (bootstrapResponse.headers.get("set-cookie") ?? "").split(";")[0];
const bootstrap = await bootstrapResponse.json();
if (!bootstrapResponse.ok || !bootstrap.auth?.csrfToken || !bootstrap.auth?.permissions?.edit) throw new Error("本机指挥台没有可用的编辑权限");
const headers = { "content-type": "application/json", cookie: cookies, "x-csrf-token": bootstrap.auth.csrfToken, origin: base };

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${payload.error ?? "请求失败"}`);
  return payload;
}
async function waitForJob(id, timeoutMs = 12 * 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await request(`/api/author-spreadsheet/jobs/${id}`);
    if (["completed", "failed"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`任务 ${id} 超过等待时限，已提交但尚未结束`);
}

const before = await request("/api/bootstrap");
const submittedJobs = [];
for (const source of input.sources) {
  if (!Array.isArray(source.rows) || !source.rows.length) continue;
  const submitted = await request("/api/author-spreadsheet/auto-monitor", {
    method: "POST",
    body: JSON.stringify({
      sourceType: "author-spreadsheet",
      fileName: source.fileName,
      sheetName: source.sheetName,
      defaultBoard: boardName,
      rows: source.rows,
    }),
  });
  const completed = await waitForJob(submitted.id);
  if (completed.status !== "completed") throw new Error(`来源 ${source.kind}/${source.sheetName} 导入失败：${completed.error ?? "未知错误"}`);
  submittedJobs.push({
    kind: source.kind,
    title: source.title,
    wikiUrl: source.wikiUrl,
    sourceUrl: source.sourceUrl,
    sourceRevision: source.sourceRevision,
    sheetId: source.sheetId,
    sheetName: source.sheetName,
    submittedRows: source.rows.length,
    jobId: completed.id,
    job: completed,
  });
}

const after = await request("/api/bootstrap");
const queue = await request(`/api/author-resolution-queue?board=${encodeURIComponent(boardName)}&status=all&limit=500`);
const result = {
  importedAt: new Date().toISOString(),
  boardName,
  sourceSummary: input.sourceCount,
  normalizedInput: {
    totalRawRows: input.totalRawRows,
    totalSelectedRows: input.totalSelectedRows,
    perSource: input.perSource,
  },
  before: {
    targetCount: before.targets?.length ?? null,
    board: before.boards?.find((item) => item.name === boardName) ?? null,
  },
  after: {
    targetCount: after.targets?.length ?? null,
    board: after.boards?.find((item) => item.name === boardName) ?? null,
  },
  targetDelta: (after.targets?.length ?? 0) - (before.targets?.length ?? 0),
  queueSummary: queue.summary ?? null,
  jobs: submittedJobs,
};
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
