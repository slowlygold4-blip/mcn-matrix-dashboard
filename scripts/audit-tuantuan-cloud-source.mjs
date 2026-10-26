import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as XLSX from "@e965/xlsx";
import { parseAuthorSpreadsheet, authorPreviewContentSha256 } from "../lib/author-spreadsheet.mjs";

const url = "https://tcnr35i27578.feishu.cn/sheets/UbeEsThm3h1fsktWiEaclM1enOe?sheet=fa676d";
const directory = await mkdtemp("data/tuantuan-import-");
const run = promisify(execFile);
const cli = async args => {
  const { stdout } = await run("lark-cli", args, { timeout: 90_000, maxBuffer: 8_000_000,
    env: { ...process.env, LARK_CLI_NO_PROXY: "1" } });
  const envelope = JSON.parse(stdout);
  if (!envelope.ok) throw new Error(JSON.stringify(envelope.error));
  return envelope;
};
const before = await cli(["sheets", "+workbook-info", "--url", url, "--as", "user", "--json"]);
await writeFile(`${directory}/workbook-before.json`, JSON.stringify(before, null, 2));
const workbook = XLSX.utils.book_new();
const sheets = [];
const allRows = [];
for (const sheet of before.data.sheets) {
  if (sheet.row_count > 5000 || sheet.column_count > 100) throw new Error("Unexpected source grid size");
  const range = `A1:${XLSX.utils.encode_col(sheet.column_count - 1)}${sheet.row_count}`;
  const cloud = await cli(["sheets", "+csv-get", "--url", url, "--sheet-id", sheet.sheet_id,
    "--range", range, "--rows-json", "--as", "user", "--json"]);
  if (cloud.data.has_more || cloud.data.data_not_fully_read || cloud.data.actual_range !== range
    || cloud.data.rows.length !== sheet.row_count || cloud.data.revision !== before.data.revision
    || cloud.data.rows.some((row, index) => row.row_number !== index + 1)) throw new Error("Source completeness or version changed");
  await writeFile(`${directory}/cloud-${sheet.sheet_id}.json`, JSON.stringify(cloud, null, 2));
  const matrix = cloud.data.rows.map(row => Array.from({ length: sheet.column_count }, (_, index) => row.values[XLSX.utils.encode_col(index)] ?? ""));
  const title = sheet.title || sheet.sheet_name;
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), title);
  const single = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(single, XLSX.utils.aoa_to_sheet(matrix), title);
  const buffer = XLSX.write(single, { type: "buffer", bookType: "xlsx", compression: true });
  const preview = await parseAuthorSpreadsheet({ buffer, fileName: `${before.data.title}.xlsx`, sheetName: title });
  await writeFile(`${directory}/preview-${sheet.sheet_id}.json`, JSON.stringify(preview, null, 2));
  const { rows, ...meta } = cloud.data;
  const record = { id: sheet.sheet_id, title, physicalRange: range, cloudMeta: meta,
    contentSha256: authorPreviewContentSha256(preview), dataRange: preview.dataRange, mapping: preview.mapping,
    summary: preview.summary, recognizedRows: preview.rows.length, authorNameCount: new Set(preview.rows.map(row => row.name).filter(Boolean)).size,
    submittedIdCount: new Set(preview.rows.map(row => row.douyinId).filter(Boolean)).size };
  sheets.push(record);
  allRows.push(...preview.rows.map(row => ({ ...row, sheetId: sheet.sheet_id, sheetName: title })));
}
const after = await cli(["sheets", "+workbook-info", "--url", url, "--as", "user", "--json"]);
await writeFile(`${directory}/workbook-after.json`, JSON.stringify(after, null, 2));
if (before.data.revision !== after.data.revision || JSON.stringify(before.data.sheets) !== JSON.stringify(after.data.sheets)) throw new Error("Workbook changed during complete read");
await writeFile(`${directory}/source-cells.xlsx`, XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true }));
const groups = new Map();
for (const row of allRows) {
  const key = row.douyinId || `name:${row.name}`;
  const group = groups.get(key) || { submittedId: row.douyinId, names: [], sourceRows: [], locators: [], evidenceCount: 0 };
  if (!group.names.includes(row.name)) group.names.push(row.name);
  if (row.locator && !group.locators.includes(row.locator)) group.locators.push(row.locator);
  group.sourceRows.push({ sheetId: row.sheetId, sheetName: row.sheetName, row: row.sourceRow });
  if (row.videoId || row.shareUrl) group.evidenceCount += 1;
  groups.set(key, group);
}
const audit = { url, title: before.data.title, revision: before.data.revision, readAt: new Date().toISOString(),
  directory, sheets, rowCount: allRows.length, authorNameCount: new Set(allRows.map(row => row.name).filter(Boolean)).size,
  submittedIdCount: new Set(allRows.map(row => row.douyinId).filter(Boolean)).size,
  groups: [...groups.values()], rows: allRows, sourceValuesSha256: createHash("sha256").update(JSON.stringify(allRows)).digest("hex") };
await writeFile(`${directory}/source-audit.json`, JSON.stringify(audit, null, 2));
console.log(JSON.stringify({ directory, title: audit.title, revision: audit.revision, sheets,
  rowCount: audit.rowCount, authorNameCount: audit.authorNameCount, submittedIdCount: audit.submittedIdCount,
  identities: audit.groups.map(({ sourceRows, ...group }) => ({ ...group, rowCount: sourceRows.length })) }, null, 2));
