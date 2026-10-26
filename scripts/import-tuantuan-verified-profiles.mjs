import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import * as XLSX from "@e965/xlsx";
import { parseAuthorSpreadsheet } from "../lib/author-spreadsheet.mjs";

const directory = "data/tuantuan-import-5BDbxd";
const fileName = "一条小团团公开主页补全-20260913.xlsx";
const source = JSON.parse(await readFile(`${directory}/identity-candidates.json`, "utf8"));
const db = new DatabaseSync("data/douyin-monitor.sqlite", { readOnly: true });
const accounts = new Map();
for (const id of ["59011095324", "28202534588", "20280311233"]) {
  const rows = source.evidence.filter(item => item.submittedId === id && item.strictStatus === "ready");
  if (!rows.length || rows.some(item => item.rawPublicResult.errors.length || item.rawPublicResult.candidates.length !== 1)) throw new Error("Missing strict public evidence");
  const candidates = rows.map(item => item.rawPublicResult.candidates[0]);
  if (new Set(candidates.map(item => item.secUid)).size !== 1
    || rows.some((item, index) => candidates[index].provenance !== "public-video-detail"
      || candidates[index].uniqueId !== id || candidates[index].nickname !== item.name
      || candidates[index].sourceEvidenceUrl !== item.shareUrl)) throw new Error("Inconsistent public identity");
  const candidate = candidates[0];
  const existing = db.prepare("SELECT id,enabled FROM targets WHERE locator=?").get(candidate.secUid);
  accounts.set(id, { id, name: candidate.nickname, secUid: candidate.secUid, existing,
    sourceEvidence: rows.map(row => ({ sheetId: row.sheetId, sheetName: row.sheetName, sourceRow: row.sourceRow,
      sourceVideoUrl: row.sourceVideoUrl, shareUrl: row.shareUrl, candidate: row.rawPublicResult.candidates[0] })) });
}
db.close();
const matrix = [["作者名称", "抖音号", "作者主页", "板块", "备注"], ...[...accounts.values()].map(account => [
  account.name, account.id, `https://www.douyin.com/user/${account.secUid}`, "一条小团团切片矩阵",
  `来自原表修订${source.sourceRevision}，公开作品返回账号ID与名称一致后补全主页。原作品队列保留并独立核验，不以本补全记录替代作品通过状态。来源${account.sourceEvidence.map(item => `${item.sheetName}第${item.sourceRow}行`).join("、")}；${source.sourceUrl}`,
])];
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), "公开作品已确认的作者主页");
const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true });
const preview = await parseAuthorSpreadsheet({ buffer, fileName });
if (preview.rows.length !== 3 || preview.rows.some(row => !row.locator || row.videoId || row.shareUrl)) throw new Error("Unexpected verified-profile supplement");
await writeFile(`${directory}/${fileName}`, buffer);
await writeFile(`${directory}/verified-profile-supplement.json`, JSON.stringify({ fileName, readAt: source.checkedAt,
  sourceUrl: source.sourceUrl, sourceRevision: source.sourceRevision, sourcePreserved: true,
  doesNotChangeOriginalEvidenceStatus: true, accounts: [...accounts.values()], preview }, null, 2));
try { await readFile(`${directory}/profile-supplement-job.json`); throw new Error("Supplement already submitted"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const base = "http://127.0.0.1:4188";
const authResponse = await fetch(`${base}/api/bootstrap`);
const cookie = authResponse.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
const { auth } = await authResponse.json();
if (!authResponse.ok || !auth?.csrfToken) throw new Error("Local authentication failed");
const result = await fetch(`${base}/api/author-spreadsheet/auto-monitor`, {
  method: "POST", headers: { "content-type": "application/json", cookie, "x-csrf-token": auth.csrfToken, origin: base },
  body: JSON.stringify({ fileName, sheetName: preview.selectedSheet, rows: preview.rows, defaultBoard: "一条小团团切片矩阵" }),
});
const job = await result.json();
if (!result.ok) throw new Error(job.error || "Verified profile supplement failed");
await writeFile(`${directory}/profile-supplement-job.json`, JSON.stringify(job, null, 2));
console.log(JSON.stringify({ accounts: [...accounts.values()].map(({ name, id }) => ({ name, id })), job }));
