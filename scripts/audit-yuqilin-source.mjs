import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as XLSX from "@e965/xlsx";

const url = "https://my.feishu.cn/sheets/U0FIsi9nMh2dAqtBlZ4cOtI6nIg?sheet=a058df";
const wikiUrl = "https://my.feishu.cn/wiki/C1uqwXn0Xiu7Kzk6cpCcEG6nn8f";
const directory = process.argv[2] || await mkdtemp("data/yuqilin-import-");
const run = promisify(execFile);
const { stdout } = process.argv[2] ? { stdout: await readFile(`${directory}/cloud-rows.json`, "utf8") } : await run("lark-cli", ["sheets", "+csv-get", "--url", url, "--sheet-id", "a058df", "--range", "A1:T514", "--rows-json", "--as", "user", "--json"], { maxBuffer: 8_000_000, timeout: 90_000 });
const cloud = JSON.parse(stdout);
if (!cloud.ok) throw new Error("Cloud source read failed");
if (cloud.data?.has_more || cloud.data?.data_not_fully_read || cloud.data?.actual_range !== "A1:T514" || cloud.data?.rows?.length !== 514) throw new Error("Cloud source completeness failed");
await writeFile(`${directory}/cloud-rows.json`, JSON.stringify(cloud, null, 2));
const matrix = cloud.data.rows.map(row => Array.from({ length: 20 }, (_, index) => String(row.values[String.fromCharCode(65 + index)] ?? "")));
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(matrix), "8月");
const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
await writeFile(`${directory}/source-cells.xlsx`, buffer);
const authors = new Map();
const errors = [];
let dataRows = 0;
matrix.slice(1).forEach((row, index) => {
  if (!row.some(value => String(value).trim())) return;
  dataRows += 1;
  const [name, accountId, shareText] = row.map(String);
  const urls = shareText.match(/https?:\/\/[^\s，。；;,<>"']+/gi) || [];
  if (!name || !/^\d+$/.test(accountId) || urls.length !== 1) errors.push({ row: index + 2, name, accountId, urlCount: urls.length });
  const author = authors.get(accountId) || { accountId, names: [], rows: [], urls: [], profileSecUids: [] };
  if (!author.names.includes(name)) author.names.push(name);
  author.rows.push(index + 2);
  for (const rawUrl of urls) {
    author.urls.push(rawUrl);
    const secUid = new URL(rawUrl).pathname.match(/^\/user\/([^/]+)/)?.[1];
    if (secUid && !author.profileSecUids.includes(secUid)) author.profileSecUids.push(secUid);
  }
  authors.set(accountId, author);
});
const { rows, ...cloudMeta } = cloud.data;
const authorNameCount = new Set([...authors.values()].flatMap(author => author.names)).size;
const audit = { wikiUrl, url, title: "玉麒麟寒川8月结算表", revision: cloud.data.revision, sheet: "8月", sheetId: "a058df", cloudMeta, header: matrix[0], physicalExportRows: matrix.length, dataRows, submittedAccountIdCount: authors.size, authorNameCount, errors, authors: [...authors.values()], sourceSha256: createHash("sha256").update(stdout).digest("hex") };
await writeFile(`${directory}/source-audit.json`, JSON.stringify(audit, null, 2));
console.log(JSON.stringify({ directory, cloudMeta: audit.cloudMeta, header: audit.header, physicalExportRows: audit.physicalExportRows, dataRows, submittedAccountIdCount: authors.size, authorNameCount, errors }, null, 2));
