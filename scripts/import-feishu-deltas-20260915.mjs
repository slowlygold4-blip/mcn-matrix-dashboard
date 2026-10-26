import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const base = "http://127.0.0.1:4188";
const inputPath = "/tmp/feishu-delta-rows.json";
const receiptPath = resolve(fileURLToPath(new URL("../data/feishu-delta-20260915/receipt.json", import.meta.url)));
const input = JSON.parse(await readFile(inputPath, "utf8"));

try {
  await readFile(receiptPath, "utf8");
  throw new Error(`增量写入回执已存在：${receiptPath}。为避免重复写入，请先确认上次回执后再换新的日期/快照运行。`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const bootstrapResponse = await fetch(`${base}/api/bootstrap`);
const cookies = typeof bootstrapResponse.headers.getSetCookie === "function"
  ? bootstrapResponse.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ")
  : (bootstrapResponse.headers.get("set-cookie") ?? "").split(";")[0];
const bootstrap = await bootstrapResponse.json();
if (!bootstrapResponse.ok || !bootstrap.auth?.csrfToken || !bootstrap.auth?.permissions?.edit) {
  throw new Error("本机指挥台没有可用的编辑权限");
}
const headers = {
  "content-type": "application/json",
  cookie: cookies,
  "x-csrf-token": bootstrap.auth.csrfToken,
  origin: base,
};

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${payload.error ?? "请求失败"}`);
  return payload;
}

async function waitForJob(id, timeoutMs = 8 * 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = await request(`/api/author-spreadsheet/jobs/${id}`);
    if (["completed", "failed"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`任务 ${id} 超过等待时限，已提交但尚未结束`);
}

const before = await request("/api/targets");
const jobs = [];
for (const source of input.sources) {
  if (!Array.isArray(source.rows) || !source.rows.length) continue;
  const submitted = await request("/api/author-spreadsheet/auto-monitor", {
    method: "POST",
    body: JSON.stringify({
      // This is an audited delta payload, not a second live read. Use the
      // upload path so the server does not re-export a moving multi-sheet
      // workbook between preview and commit; the row notes retain the exact
      // Feishu URL, revision, sheet and source row.
      sourceType: "author-spreadsheet",
      fileName: source.fileName,
      sheetName: source.sheetName,
      defaultBoard: "一条小团团切片矩阵",
      rows: source.rows,
    }),
  });
  const completed = await waitForJob(submitted.id);
  if (completed.status !== "completed") throw new Error(`来源 ${source.kind} 的增量写入失败：${completed.error ?? "未知错误"}`);
  jobs.push({
    kind: source.kind,
    sourceUrl: source.sourceUrl,
    sourceRevision: source.sourceRevision,
    submittedRows: source.rows.length,
    job: completed,
  });
}

const after = await request("/api/targets");
const queue = await request("/api/author-resolution-queue?board=%E4%B8%80%E6%9D%A1%E5%B0%8F%E5%9B%A2%E5%9B%A2%E5%88%87%E7%89%87%E7%9F%A9%E9%98%B5&status=all&limit=500");
const result = {
  importedAt: new Date().toISOString(),
  beforeTargetCount: before.targets.length,
  afterTargetCount: after.targets.length,
  targetDelta: after.targets.length - before.targets.length,
  beforeBoard: before.boards?.find((item) => item.name === "一条小团团切片矩阵") ?? null,
  afterBoard: after.boards?.find((item) => item.name === "一条小团团切片矩阵") ?? null,
  jobs,
  queueSummary: queue.summary ?? null,
};
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
