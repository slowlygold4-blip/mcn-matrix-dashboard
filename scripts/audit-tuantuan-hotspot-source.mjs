import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as XLSX from '@e965/xlsx';
import { parseAuthorSpreadsheet, authorPreviewContentSha256 } from '../lib/author-spreadsheet.mjs';

const wikiUrl = 'https://dawgasqmco.feishu.cn/wiki/RQq6ws8K9iK7mYkkUxYcZK0InTc';
const url = 'https://dawgasqmco.feishu.cn/sheets/YR58sxWa0hyIW6tqGPCcoxhGnYd';
const formUrl = 'https://ccnmwvgvsr3v.feishu.cn/share/base/form/shrcnpxtmZOnE8VRs1k15H89zhh';
const directory = await mkdtemp('data/tuantuan-hotspot-');
const run = promisify(execFile);
const cli = async args => {
  const { stdout } = await run('lark-cli', args, { timeout: 90_000, maxBuffer: 8_000_000,
    env: { ...process.env, LARK_CLI_NO_PROXY: '1' } });
  const result = JSON.parse(stdout);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result;
};
const before = await cli(['sheets', '+workbook-info', '--url', url, '--as', 'user', '--json']);
await writeFile(`${directory}/workbook-before.json`, JSON.stringify(before, null, 2));
const book = XLSX.utils.book_new();
const sheets = [];
const allRows = [];
for (const sheet of before.data.sheets) {
  if (sheet.row_count > 5000 || sheet.column_count > 100) throw new Error('Unexpected source size');
  const columns = XLSX.utils.encode_col(sheet.column_count - 1);
  const rows = [];
  const reads = [];
  for (let start = 1; start <= sheet.row_count; start += 300) {
    const end = Math.min(start + 299, sheet.row_count);
    const range = `A${start}:${columns}${end}`;
    const cloud = await cli(['sheets', '+csv-get', '--url', url, '--sheet-id', sheet.sheet_id,
      '--range', range, '--rows-json', '--as', 'user', '--json']);
    const data = cloud.data;
    if (data.has_more || data.actual_range !== range || data.rows.length !== end - start + 1
      || data.revision !== before.data.revision
      || data.rows.some((row, index) => row.row_number !== start + index)) throw new Error('Source changed or read incomplete');
    await writeFile(`${directory}/cloud-${sheet.sheet_id}-${start}-${end}.json`, JSON.stringify(cloud, null, 2));
    const { rows: returnedRows, ...meta } = data;
    reads.push(meta);
    rows.push(...returnedRows);
  }
  if (reads.some(read => read.data_not_fully_read?.data_extends_through_row > sheet.row_count)) throw new Error('Grid grew during read');
  const matrix = rows.map(row => Array.from({ length: sheet.column_count }, (_, index) => row.values[XLSX.utils.encode_col(index)] ?? ''));
  const title = sheet.title || sheet.sheet_name;
  const workbookSheet = XLSX.utils.aoa_to_sheet(matrix);
  XLSX.utils.book_append_sheet(book, workbookSheet, title);
  const single = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(single, workbookSheet, title);
  const preview = await parseAuthorSpreadsheet({ buffer: XLSX.write(single, { type: 'buffer', bookType: 'xlsx', compression: true }),
    fileName: `${before.data.title}.xlsx`, sheetName: title });
  const rawDataRows = rows.filter(row => row.row_number > preview.headerRow
    && ['A', 'B', 'C'].some(column => String(row.values[column] ?? '').trim()));
  if (rawDataRows.length !== preview.rows.length) throw new Error('Parser omitted nonempty source rows');
  await writeFile(`${directory}/cloud-${sheet.sheet_id}.json`, JSON.stringify({ ok: true, data: {
    revision: before.data.revision, actual_range: `A1:${columns}${sheet.row_count}`, rows, has_more: false,
  } }, null, 2));
  await writeFile(`${directory}/preview-${sheet.sheet_id}.json`, JSON.stringify(preview, null, 2));
  sheets.push({ id: sheet.sheet_id, title, physicalRange: `A1:${columns}${sheet.row_count}`, reads,
    dataRange: preview.dataRange, mapping: preview.mapping, summary: preview.summary,
    contentSha256: authorPreviewContentSha256(preview), recognizedRows: preview.rows.length });
  allRows.push(...preview.rows.map(row => ({ ...row, sheetId: sheet.sheet_id, sheetName: title,
    unlabelledColumnD: rows.find(raw => raw.row_number === row.sourceRow).values.D || '' })));
}
const after = await cli(['sheets', '+workbook-info', '--url', url, '--as', 'user', '--json']);
await writeFile(`${directory}/workbook-after.json`, JSON.stringify(after, null, 2));
if (before.data.revision !== after.data.revision || JSON.stringify(before.data.sheets) !== JSON.stringify(after.data.sheets)) throw new Error('Workbook changed during complete read');
await writeFile(`${directory}/source-cells.xlsx`, XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true }));
const groups = new Map();
for (const row of allRows) {
  const key = row.douyinId || `name:${row.name}`;
  const group = groups.get(key) || { submittedId: row.douyinId, names: [], sourceRows: [] };
  if (!group.names.includes(row.name)) group.names.push(row.name);
  group.sourceRows.push(row.sourceRow);
  groups.set(key, group);
}
const audit = { directory, wikiUrl, url, title: before.data.title, revision: before.data.revision,
  readAt: new Date().toISOString(), sheets, rows: allRows, groups: [...groups.values()], rowCount: allRows.length,
  authorNameCount: new Set(allRows.map(row => row.name).filter(Boolean)).size,
  submittedIdCount: new Set(allRows.map(row => row.douyinId).filter(Boolean)).size,
  sourceValuesSha256: createHash('sha256').update(JSON.stringify(allRows)).digest('hex'),
  additionalForm: { url: formUrl, name: '授权作者登记表', baseToken: 'VMdZbsT6uajUg4s9wtNcRjZtnEh',
    status: 'records_not_accessible', questionsRead: true, recordsRead: false, userResourceError: 91403 } };
await writeFile(`${directory}/source-audit.json`, JSON.stringify(audit, null, 2));
console.log(JSON.stringify({ directory, revision: audit.revision, rowCount: audit.rowCount,
  authorNameCount: audit.authorNameCount, submittedIdCount: audit.submittedIdCount, sheets }));
