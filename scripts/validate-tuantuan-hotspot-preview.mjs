import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import * as XLSX from '@e965/xlsx';

const directory = 'data/tuantuan-hotspot-onikEQ';
const audit = JSON.parse(await readFile(`${directory}/source-audit.json`, 'utf8'));
const exportPath = `${directory}/source-original-export.xlsx`;
const workbook = XLSX.read(await readFile(exportPath), { type: 'buffer', cellHTML: false });
const rawSheet = workbook.Sheets.Sheet1;
const base = 'http://127.0.0.1:4188';
const session = await fetch(`${base}/api/bootstrap`);
const cookie = session.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const { auth } = await session.json();
assert.ok(session.ok && auth?.csrfToken, 'Local session unavailable');
const response = await fetch(`${base}/api/author-spreadsheet/lark-preview`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': auth.csrfToken, origin: base },
  body: JSON.stringify({ url: `${audit.url}?sheet=d8a44f` }),
});
const preview = await response.json();
assert.ok(response.ok, preview.error || 'Cloud preview failed');
await writeFile(`${directory}/app-preview-verified.json`, JSON.stringify(preview, null, 2));
const differences = [];
const compact = value => String(value ?? '').replace(/\u0000/g, '').trim();
const rawByRow = new Map(audit.rows.map(row => [row.sourceRow, row]));
for (const row of preview.rows) {
  const raw = rawByRow.get(row.sourceRow);
  if (!raw) { differences.push({ sourceRow: row.sourceRow, error: 'Unexpected source row' }); continue; }
  for (const field of ['name', 'douyinId', 'videoLink', 'shareUrl']) {
    if (compact(row[field]) !== compact(raw[field])) differences.push({ sourceRow: row.sourceRow, field,
      source: raw[field], preview: row[field] });
  }
  const hyperlink = compact(rawSheet[`C${row.sourceRow}`]?.l?.Target);
  if (compact(row.videoHyperlink) !== hyperlink) differences.push({ sourceRow: row.sourceRow,
    field: 'videoHyperlink', expected: hyperlink, preview: row.videoHyperlink });
  if (row.identityConflict) differences.push({ sourceRow: row.sourceRow, error: row.identityConflict });
}
const validation = { accepted: false, checkedAt: new Date().toISOString(),
  revision: preview.source.revision, contentSha256: preview.source.contentSha256,
  sourceValuesSha256: audit.sourceValuesSha256, originalExportForHyperlinkAudit: exportPath,
  expectedRowCount: audit.rowCount, actualRowCount: preview.rows.length, differences,
  explanation: 'All visible names, account IDs and source links are compared against the complete cloud cell read. Every embedded video hyperlink is independently compared with the original XLSX relationships. The two additional modal IDs remain independent evidence, not replacements for the visible source links.',
};
try {
  assert.equal(preview.source.revision, audit.revision);
  assert.equal(preview.source.selectedSheetId, 'd8a44f');
  assert.equal(preview.rows.length, 405);
  assert.equal(new Set(preview.rows.map(row => row.sourceRow)).size, 405);
  assert.equal(differences.length, 0, JSON.stringify(differences));
  const rowAt = number => preview.rows.find(row => row.sourceRow === number);
  for (const number of [283, 313, 316]) assert.equal(rowAt(number).douyinId, 'Ni.De.GIRL_LMZW');
  assert.equal(rowAt(16).videoId, '7684617087687331118');
  assert.equal(rowAt(16).shareUrl, 'https://v.douyin.com/Cu0tbcEzFXY/');
  assert.ok(rowAt(16).locator?.includes('MS4wLjABAAAAE77hYf0JQ_OOzESLRMyxgfJ9OWL_GckD31DDeo7OA5itH5JTkquq2h5ftYVKOTYB'));
  assert.equal(rowAt(237).videoId, '7684675001341005096');
  assert.equal(rowAt(237).shareUrl, 'https://v.douyin.com/MK98D_46tFc/');
  assert.ok(!rowAt(237).locator, 'self is not an author identity');
  assert.ok(!rowAt(343).douyinId && !rowAt(343).locator && !rowAt(343).shareUrl);
  validation.accepted = true;
} catch (error) {
  validation.error = error.message;
} finally {
  await writeFile(`${directory}/preview-validation.json`, JSON.stringify(validation, null, 2));
}
console.log(JSON.stringify({ ...validation, differences: differences.slice(0, 10) }));
if (!validation.accepted) process.exitCode = 1;
