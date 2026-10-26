import { readFile, writeFile } from "node:fs/promises";
import * as XLSX from "@e965/xlsx";
import { parseAuthorSpreadsheet, authorPreviewContentSha256 } from "../lib/author-spreadsheet.mjs";

const directory = "data/tuantuan-import-5BDbxd";
const sourceAuditPath = "data/tuantuan-import-9PTMDQ/source-audit.json";
const source = JSON.parse(await readFile(sourceAuditPath, "utf8"));
const base = "http://127.0.0.1:4188";
const board = "一条小团团切片矩阵";
const action = process.argv[2];
if (!["submit", "status"].includes(action)) throw new Error("Expected submit or status");
const response = await fetch(`${base}/api/bootstrap`);
const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
const { auth } = await response.json();
if (!response.ok || !auth?.csrfToken) throw new Error("Local authentication failed");
const headers = { "content-type": "application/json", cookie, "x-csrf-token": auth.csrfToken, origin: base };
const request = async (path, body) => {
  const result = await fetch(`${base}${path}`, { headers, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  const value = await result.json();
  if (!result.ok) throw new Error(`${result.status}: ${value.error || "Request failed"}`);
  return value;
};
if (action === "submit") {
  await readFile(`${directory}/before.sqlite`);
  try { await readFile(`${directory}/submitted-job.json`); throw new Error("Audited snapshot already submitted; inspect status instead"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const fileName = `一条小团团名单核对快照-修订${source.revision}.xlsx`;
  const matrix = [["作者名称", "抖音号", "作品链接", "作者主页", "板块", "备注"]];
  const mappings = [];
  for (const sheet of source.sheets) {
    const cloud = JSON.parse(await readFile(`${source.directory}/cloud-${sheet.id}.json`, "utf8"));
    for (const row of source.rows.filter(item => item.sheetId === sheet.id)) {
      const raw = cloud.data.rows.find(item => item.row_number === row.sourceRow);
      if (!raw || String(raw.values.A ?? "").trim() !== row.name || String(raw.values.B ?? "") !== row.douyinId) throw new Error("Raw source identity mismatch");
      const url = new URL(source.url);
      url.searchParams.set("sheet", sheet.id);
      const note = `原表「${sheet.title}」第${row.sourceRow}行；修订${source.revision}；读取${source.readAt}；原表未修改。${url.href}`;
      matrix.push([row.name, row.douyinId, sheet.id === "6Nt0HU" ? "" : raw.values.C || "", "", board, note]);
      mappings.push({ derivedSourceRow: matrix.length, sheetId: sheet.id, sheetName: sheet.title,
        sourceRow: row.sourceRow, name: row.name, submittedId: row.douyinId, original: row });
    }
  }
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(matrix), "全工作簿账号与作品证据");
  const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx", compression: true });
  const preview = await parseAuthorSpreadsheet({ buffer, fileName });
  if (preview.rows.length !== source.rowCount) throw new Error("Snapshot lost source rows");
  for (const row of preview.rows) {
    const original = mappings.find(item => item.derivedSourceRow === row.sourceRow)?.original;
    if (!original || ["name", "douyinId", "videoId", "shareUrl", "locator"].some(key => String(row[key] || "") !== String(original[key] || ""))) {
      throw new Error(`Snapshot evidence differs at derived row ${row.sourceRow}`);
    }
  }
  await writeFile(`${directory}/${fileName}`, buffer);
  await writeFile(`${directory}/snapshot-import.json`, JSON.stringify({ sourceAuditPath, sourceUrl: source.url,
    sourceRevision: source.revision, sourceReadAt: source.readAt, sourceValuesSha256: source.sourceValuesSha256,
    fileName, sourcePreserved: true, mappings, contentSha256: authorPreviewContentSha256(preview), preview }, null, 2));
  const job = await request("/api/author-spreadsheet/auto-monitor", { fileName, sheetName: preview.selectedSheet, rows: preview.rows, defaultBoard: board });
  await writeFile(`${directory}/submitted-job.json`, JSON.stringify(job, null, 2));
  console.log(JSON.stringify({ job, sourceRevision: source.revision, verifiedRows: preview.rows.length }));
} else {
  const submitted = JSON.parse(await readFile(`${directory}/submitted-job.json`, "utf8"));
  const jobs = [await request(`/api/author-spreadsheet/jobs/${submitted.id}`)];
  const [queue, all] = await Promise.all([
    request(`/api/author-resolution-queue?board=${encodeURIComponent(board)}&status=all&limit=500`),
    request("/api/targets"),
  ]);
  const targets = all.targets.filter(target => target.boards?.some(item => item.name === board));
  const result = { readAt: new Date().toISOString(), jobs, queue, targets, board: all.boards.find(item => item.name === board) };
  await writeFile(`${directory}/app-status.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ jobs: jobs.map(({ result, ...job }) => ({ ...job, result: result && Object.fromEntries(Object.entries(result).filter(([key]) => !["created", "skipped"].includes(key))) })),
    targetCount: targets.length, enabledCount: targets.filter(target => target.enabled).length, board: result.board, queueSummary: queue.summary }));
}
