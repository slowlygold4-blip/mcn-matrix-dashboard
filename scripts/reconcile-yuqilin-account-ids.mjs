import { readFile, writeFile } from "node:fs/promises";
import * as XLSX from "@e965/xlsx";
import { parseAuthorSpreadsheet, authorPreviewContentSha256 } from "../lib/author-spreadsheet.mjs";

const directory = "data/yuqilin-import-Nl4JQn";
const fileName = "玉麒麟作者信息复核-20260913.xlsx";
const source = JSON.parse(await readFile(`${directory}/cloud-rows.json`, "utf8"));
const audit = JSON.parse(await readFile(`${directory}/mismatch-candidates-13-14-23-24.json`, "utf8"));
const normalize = value => String(value).normalize("NFKC").trim();
const corrections = [];
for (const name of ["沐旬（玉麒麟切片）", "枕川（玉麒麟切片）"]) {
  const rows = audit.rows.filter(row => normalize(row.submittedName) === normalize(name));
  const candidates = rows.flatMap(row => row.candidates || []);
  if (rows.length !== 2 || candidates.length !== 2 || rows.some(row => row.errors.length || row.candidates.length !== 1)
    || candidates.some(candidate => normalize(candidate.nickname) !== normalize(name) || candidate.provenance !== "public-video-detail")
    || new Set(candidates.map(candidate => candidate.videoId)).size !== 2
    || new Set(candidates.map(candidate => candidate.secUid)).size !== 1
    || new Set(candidates.map(candidate => candidate.publicDouyinId)).size !== 1
    || rows.some(row => row.candidates[0].sourceEvidenceUrl !== row.submittedShareUrl)) throw new Error(`Independent public evidence is insufficient for ${name}`);
  corrections.push({ name, originalId: rows[0].submittedDouyinId, publicId: candidates[0].publicDouyinId,
    secUid: candidates[0].secUid, verificationRows: rows.map(row => row.sourceRow),
    evidenceVideoIds: candidates.map(candidate => candidate.videoId) });
}
const matrix = [["作者名称", "抖音号", "作品链接", "板块", "备注"]];
for (const row of source.data.rows.slice(1)) {
  const correction = corrections.find(item => normalize(item.name) === normalize(row.values.A));
  if (!correction) { matrix.push([]); continue; }
  if (row.values.B !== correction.originalId) throw new Error("Unexpected original source ID");
  matrix.push([row.values.A, correction.publicId, row.values.C, "玉麒麟切片矩阵",
    `原表8月第${row.row_number}行；原填抖音号${correction.originalId}，两条公开作品核对当前号码${correction.publicId}；原表未修改。来源：https://my.feishu.cn/wiki/C1uqwXn0Xiu7Kzk6cpCcEG6nn8f；修订2；核对原行${correction.verificationRows.join("、")}。`]);
}
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(matrix), "8月账号信息复核");
const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx", compression: true });
const preview = await parseAuthorSpreadsheet({ buffer, fileName });
if (preview.rows.length !== 17 || preview.summary.needsLocatorRows) throw new Error("Correction artifact lost original work evidence");
await writeFile(`${directory}/${fileName}`, buffer);
await writeFile(`${directory}/account-id-reconciliation.json`, JSON.stringify({ sourceWikiUrl: audit.sourceUrl,
  sourceRevision: 2, checkedAt: audit.checkedAt, corrections, preservedOriginalSource: true,
  originalJobId: "d946f5d0-b0b6-4a96-9cdc-3864e1b53e7f", correctedEvidenceRows: preview.rows.length,
  contentSha256: authorPreviewContentSha256(preview), preview }, null, 2));
if (process.argv[2] !== "--submit") {
  console.log(JSON.stringify({ prepared: true, corrections, evidenceRows: preview.rows.length }));
} else {
  try { await readFile(`${directory}/reconciliation-job.json`); throw new Error("Reconciliation already submitted"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const base = "http://127.0.0.1:4188";
  const response = await fetch(`${base}/api/bootstrap`);
  const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  const { auth } = await response.json();
  if (!response.ok || !auth?.csrfToken) throw new Error("Local authentication failed");
  const result = await fetch(`${base}/api/author-spreadsheet/auto-monitor`, {
    method: "POST", headers: { "content-type": "application/json", cookie, "x-csrf-token": auth.csrfToken, origin: base },
    body: JSON.stringify({ fileName, sheetName: preview.selectedSheet, rows: preview.rows, defaultBoard: "玉麒麟切片矩阵" }),
  });
  const job = await result.json();
  if (!result.ok) throw new Error(job.error || "Reconciliation submission failed");
  await writeFile(`${directory}/reconciliation-job.json`, JSON.stringify(job, null, 2));
  console.log(JSON.stringify(job));
}
