import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';

const SOURCE_URL = 'https://my.feishu.cn/sheets/VQQ3sbwPlh5o39tdqyocXzTYnLg';
const requiredSheets = ['01_总览', '05_赛道总览', '08_作者总表', '09_去重作品', '16_账号别名合并', '18_口径说明', '19_播放叠加查重'];

export function cellValue(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;
  if (Array.isArray(value.richText)) return value.richText.map(part => part.text || '').join('');
  if ('text' in value && 'hyperlink' in value) return value.text || value.hyperlink || null;
  if ('formula' in value || 'sharedFormula' in value) return value.result ?? `=${value.formula || value.sharedFormula}`;
  if ('error' in value) return `#${value.error}`;
  return JSON.stringify(value);
}

const cleanId = value => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  return String(value ?? '').normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
};
const sumKnown = (rows, column) => rows.reduce((sum, row) => sum + (typeof row[column] === 'number' ? row[column] : 0), 0);
const fail = message => { throw new Error(`来源一致性校验失败：${message}`); };

export function auditWorkbook(workbook) {
  for (const name of requiredSheets) if (!workbook.getWorksheet(name)) fail(`缺少 ${name}`);
  const rows = name => {
    const sheet = workbook.getWorksheet(name);
    return Array.from({ length: sheet.rowCount - 1 }, (_, index) =>
      Array.from({ length: sheet.columnCount }, (_, column) => cellValue(sheet.getRow(index + 2).getCell(column + 1).value)));
  };
  const overview = new Map(rows('01_总览').map(row => [row[0], row[1]]));
  const authors = rows('08_作者总表');
  const works = rows('09_去重作品');
  const tracks = rows('05_赛道总览');
  const overlap = rows('19_播放叠加查重');
  const workIds = works.map(row => cleanId(row[0]));
  if (workIds.some(id => !id)) fail('存在空的作品 ID');
  if (new Set(workIds).size !== workIds.length) fail('09_去重作品仍有重复作品 ID');
  if (authors.length !== overview.get('覆盖作者账号')) fail('作者行数与总览不一致');
  if (works.length !== overview.get('去重作品')) fail('作品行数与总览不一致');
  if (sumKnown(works, 7) !== overview.get('作品累计播放')) fail('作品累计播放与总览不一致');
  if (sumKnown(authors, 11) !== overview.get('作品累计播放')) fail('作者累计播放与总览不一致');
  if (sumKnown(tracks, 1) !== works.length) fail('赛道归属作品数与去重作品数不一致');
  if (sumKnown(tracks, 3) !== overview.get('作品累计播放')) fail('赛道归属播放与总览不一致');
  const allTracks = overlap.find(row => row[0] === '四赛道相加');
  const global = overlap.find(row => row[0] === '全局去重');
  if (!allTracks || !global || allTracks[2] - allTracks[6] !== global[2] || global[2] !== overview.get('作品累计播放')) {
    fail('跨赛道播放去重对账不成立');
  }
  const missingPlays = works.filter(row => row[7] == null).length;
  const missingLikes = works.filter(row => row[8] == null).length;
  if (missingPlays !== overview.get('播放缺失作品') || missingLikes !== overview.get('点赞缺失作品')) fail('缺测作品数与总览不一致');
  return { authorCount: authors.length, workCount: works.length, knownCumulativePlays: overview.get('作品累计播放'),
    missingPlays, missingLikes, candidateBonus: overview.get('收集表候选金额'), announcedBonus: overview.get('公示明确金额'),
    sourceStart: overview.get('统计开始'), sourceEnd: overview.get('统计结束'), sourceRefreshedAt: overview.get('数据刷新'),
    overlapWorkCount: overview.get('跨赛道收录作品'), overlapExcessPlays: allTracks[6],
    trackCount: tracks.length, sheetCount: workbook.worksheets.length };
}

function indexAccountLinks(library, monitorPath) {
  if (!monitorPath || !existsSync(monitorPath)) return { matchedTargets: 0, matchedAuthors: 0, ambiguousKeys: 0 };
  const aliasRows = library.prepare("SELECT row_number,values_json FROM source_rows WHERE sheet_id='16'").all();
  const authorRows = library.prepare("SELECT row_number,values_json FROM source_rows WHERE sheet_id='08'").all();
  const main = new Map(), keys = new Map();
  for (const row of authorRows) {
    const id = cleanId(JSON.parse(row.values_json)[1]);
    if (id) { if (!main.has(id)) main.set(id, new Set()); main.get(id).add(row.row_number); }
  }
  const add = (key, authorRow) => {
    if (!key || !authorRow) return;
    if (!keys.has(key)) keys.set(key, new Set());
    keys.get(key).add(authorRow);
  };
  for (const [key, rowNumbers] of main) for (const row of rowNumbers) add(key, row);
  for (const row of aliasRows) {
    const values = JSON.parse(row.values_json);
    const mainRows = main.get(cleanId(values[0]));
    if (!mainRows || mainRows.size !== 1) continue;
    for (const alias of String(values[1] ?? '').split(/\s*\/\s*/)) add(cleanId(alias), [...mainRows][0]);
  }
  const monitor = new DatabaseSync(monitorPath, { readOnly: true });
  const matchedAuthors = new Set();
  let matchedTargets = 0;
  try {
    const insert = library.prepare('INSERT INTO account_links(author_row,target_id,matched_id,matched_at) VALUES(?,?,?,?)');
    for (const target of monitor.prepare("SELECT id,locator,metadata_json FROM targets WHERE type='account'").all()) {
      let metadata;
      try { metadata = JSON.parse(target.metadata_json || '{}'); } catch { continue; }
      if (metadata.identityVerification?.accountId !== target.locator) continue;
      const candidates = new Map();
      for (const original of [metadata.douyinId, metadata.submittedDouyinId]) {
        const key = cleanId(original), rows = keys.get(key);
        if (rows?.size === 1) candidates.set([...rows][0], key);
      }
      if (candidates.size !== 1) continue;
      const [authorRow, key] = [...candidates][0];
      insert.run(authorRow, target.id, key, new Date().toISOString());
      matchedTargets++;
      matchedAuthors.add(authorRow);
    }
  } finally { monitor.close(); }
  return { matchedTargets, matchedAuthors: matchedAuthors.size, ambiguousKeys: [...keys.values()].filter(rows => rows.size > 1).length };
}

export async function importCreatorLibrary({ sourcePath, outputPath, monitorPath, revision = null, modifiedAt = null }) {
  const sourceBytes = readFileSync(sourcePath);
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(sourceBytes);
  const audit = auditWorkbook(workbook);
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}`;
  if (existsSync(temporary)) fail('临时数据库已存在');
  const library = new DatabaseSync(temporary);
  try {
    library.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE source_sheets(sheet_id TEXT PRIMARY KEY,sheet_name TEXT UNIQUE NOT NULL,ordinal INTEGER NOT NULL,row_count INTEGER NOT NULL,headers_json TEXT NOT NULL,restricted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE source_rows(sheet_id TEXT NOT NULL,row_number INTEGER NOT NULL,values_json TEXT NOT NULL,search_text TEXT NOT NULL,public_search_text TEXT NOT NULL,PRIMARY KEY(sheet_id,row_number));
      CREATE INDEX source_rows_search_sheet ON source_rows(sheet_id,row_number);
      CREATE TABLE account_links(author_row INTEGER NOT NULL,target_id INTEGER NOT NULL,matched_id TEXT NOT NULL,matched_at TEXT NOT NULL,PRIMARY KEY(author_row,target_id));
      CREATE INDEX account_links_target ON account_links(target_id);`);
    library.exec('BEGIN IMMEDIATE');
    const addSheet = library.prepare('INSERT INTO source_sheets VALUES(?,?,?,?,?,?)');
    const addRow = library.prepare('INSERT INTO source_rows VALUES(?,?,?,?,?)');
    for (const [ordinal, sheet] of workbook.worksheets.entries()) {
      const sheetId = sheet.name.slice(0, 2);
      const headers = Array.from({ length: sheet.columnCount }, (_, column) => cellValue(sheet.getRow(1).getCell(column + 1).value));
      const restricted = Number(sheetId) >= 10 && !['18', '19', '20'].includes(sheetId);
      addSheet.run(sheetId, sheet.name, ordinal, sheet.rowCount - 1, JSON.stringify(headers), restricted ? 1 : 0);
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
        const values = Array.from({ length: sheet.columnCount }, (_, column) => cellValue(sheet.getRow(rowNumber).getCell(column + 1).value));
        const searchable = items => items.filter(value => value != null).join(' ').normalize('NFKC').toLowerCase();
        const publicValues = sheetId === '08' ? values.map((value, index) => [16, 17].includes(index) ? null : value) : values;
        addRow.run(sheetId, rowNumber, JSON.stringify(values), searchable(values), searchable(publicValues));
      }
    }
    const links = indexAccountLinks(library, monitorPath);
    const metadata = { sourceUrl: SOURCE_URL, sourcePath: resolve(sourcePath), sourceSha256, sourceRevision: revision,
      sourceModifiedAt: modifiedAt, importedAt: new Date().toISOString(), audit: { ...audit, ...links },
      note: '飞书来源快照，非实时平台采样；累计播放不是区间新增播放，候选与公示不是实付。' };
    const addMeta = library.prepare('INSERT INTO metadata VALUES(?,?)');
    for (const [key, value] of Object.entries(metadata)) addMeta.run(key, JSON.stringify(value));
    library.exec('COMMIT');
    const integrity = library.prepare('PRAGMA integrity_check').get();
    if (integrity?.integrity_check !== 'ok') fail('导入库完整性检查失败');
    const stored = library.prepare('SELECT count(*) AS count FROM source_rows').get().count;
    const expected = workbook.worksheets.reduce((sum, sheet) => sum + sheet.rowCount - 1, 0);
    if (stored !== expected) fail(`入库行数 ${stored} != 来源行数 ${expected}`);
    library.close();
    chmodSync(temporary, 0o600);
    if (existsSync(outputPath)) copyFileSync(outputPath, `${outputPath}.before-${Date.now()}`);
    renameSync(temporary, outputPath);
    return { ...metadata, totalRows: stored };
  } catch (error) {
    try { library.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
    try { library.close(); } catch { /* closed */ }
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const sourcePath = resolve(process.argv[2] || 'data/feishu-vqq-20261022/source.xlsx');
  const outputPath = resolve(process.argv[3] || 'data/creator-library.sqlite');
  const monitorPath = resolve(process.argv[4] || 'data/douyin-monitor.sqlite');
  importCreatorLibrary({ sourcePath, outputPath, monitorPath, revision: process.argv[5] || null, modifiedAt: process.argv[6] || null })
    .then(result => console.log(JSON.stringify({ sourceSha256: result.sourceSha256, audit: result.audit, totalRows: result.totalRows, outputPath })))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
