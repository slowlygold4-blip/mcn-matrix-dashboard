import {createHash} from 'node:crypto';
import {validateSubmittedAccountId} from './author-spreadsheet.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const norm = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();
const identifier = value => typeof value === 'string' || Number.isSafeInteger(value) && value > 0
  ? validateSubmittedAccountId(value,'douyin').value : '';
const supported = [['10','作者名','填报账号'],['12','作者名','公示账号'],['14','作者名','填报账号']];

/** Derive identities from explicit, matching source field roles. Never guess
 * from a nickname or rewrite original rows/hashes. Existing valid IDs retain
 * their exact meaning, and ambiguous evidence remains untouched. */
export function projectCreatorAuthorFieldOrder({imported,authors,sheets,evidenceRows}) {
  const rows = authors.map(row => ({...row,values:parse(row.values_json)}));
  const repairs = [], rejected = [];
  const source = sheets.find(row => row.sheet_id === '08');
  const sourceHeaders = parse(source?.headers_json);
  if (!Array.isArray(sourceHeaders) || sourceHeaders[0] !== '作者名' || sourceHeaders[1] !== '主抖音号') {
    return {rows,repairs,rejected,fingerprint:hash('[]')};
  }
  const claims = new Map();
  for (const [sheetId,nameHeader,idHeader] of supported) {
    const sheet = sheets.find(row => row.sheet_id === sheetId), headers = parse(sheet?.headers_json);
    if (!Array.isArray(headers) || headers.filter(v => v === nameHeader).length !== 1
      || headers.filter(v => v === idHeader).length !== 1) continue;
    const nameColumn = headers.indexOf(nameHeader), idColumn = headers.indexOf(idHeader);
    for (const evidence of evidenceRows.filter(row => row.sheet_id === sheetId)) {
      const values = parse(evidence.values_json), accountId = identifier(values?.[idColumn]);
      const name = values?.[nameColumn];
      if (!accountId || typeof name !== 'string' || !norm(name)) continue;
      const group = claims.get(norm(accountId)) ?? [];
      group.push({sheetId,row:evidence.row_number,name,accountId,
        rowSha256:hash(evidence.values_json),headersSha256:hash(sheet.headers_json)});
      claims.set(norm(accountId),group);
    }
  }
  const originalById = new Map();
  for (const row of rows) {
    const id = identifier(row.values?.[1]); if (!id) continue;
    const group = originalById.get(norm(id)) ?? [];group.push(row);originalById.set(norm(id),group);
  }
  const changed = [];
  for (const row of rows) {
    const values = row.values;
    if (!Array.isArray(values) || identifier(values[1])) continue;
    const accountId = identifier(values[0]), name = values[1], evidence = claims.get(norm(accountId)) ?? [];
    const names = new Set(evidence.map(item => norm(item.name)));
    const existing = originalById.get(norm(accountId)) ?? [];
    let reason;
    if (!accountId || typeof name !== 'string' || !norm(name)) reason = 'invalid-proposed-identity';
    else if (!evidence.length) reason = 'no-explicit-source-pair';
    else if (names.size !== 1 || !names.has(norm(name))) reason = 'conflicting-source-pair';
    // Display names can change. Only a zero-work/zero-metric displaced alias
    // folds into an existing exact account ID. Measurements (even under the
    // same name) need their own time/provenance-aware adoption, never deletion.
    else if (existing.length > 1 || existing.length && ![6,11,12].every(index=>values[index]===0)) reason = 'conflicting-original-identity';
    if (reason) { rejected.push({authorRow:row.row_number,reason});continue; }
    const repair = {version:1,type:'source-author-field-order',source:{importId:imported.id,sha256:imported.source_sha256},
      authorRow:row.row_number,authorRowSha256:hash(row.values_json),
      original:{name:values[0],accountId:values[1]},corrected:{name,accountId},evidence};
    row.values = [...values];row.values[0] = name;row.values[1] = accountId;
    // All other cells, including submitted aliases and metrics, stay intact.
    row.identityFieldRepair = repair;changed.push(row);repairs.push(repair);
  }
  const groups = new Map();
  for (const row of changed) {
    const key = norm(row.values[1]), group = groups.get(key) ?? [];group.push(row);groups.set(key,group);
  }
  for (const [id,group] of groups) {
    const primary = originalById.get(id)?.[0] ?? [...group].sort((a,b) => a.row_number-b.row_number)[0];
    for (const row of group) row.canonicalAuthorRow = primary.row_number;
  }
  return {rows,repairs,rejected,fingerprint:hash(JSON.stringify(repairs))};
}

/** One immutable imported workbook; no external requests, writes or model. */
export function readCreatorAuthorRows(db,imported) {
  const authors = db.prepare("SELECT row_number,values_json FROM creator_source_rows WHERE import_id=? AND sheet_id='08' ORDER BY row_number").all(imported.id);
  const sheetColumns = new Set(db.prepare('PRAGMA table_info(creator_source_sheets)').all().map(row => row.name));
  const hasSheets = ['import_id','sheet_id','headers_json'].every(name => sheetColumns.has(name));
  const sheets = hasSheets ? db.prepare('SELECT sheet_id,headers_json FROM creator_source_sheets WHERE import_id=?').all(imported.id) : [];
  const evidenceRows = sheets.some(row => supported.some(([id]) => id === row.sheet_id))
    ? db.prepare("SELECT sheet_id,row_number,values_json FROM creator_source_rows WHERE import_id=? AND sheet_id IN('10','12','14') ORDER BY sheet_id,row_number").all(imported.id) : [];
  return projectCreatorAuthorFieldOrder({imported,authors,sheets,evidenceRows});
}
