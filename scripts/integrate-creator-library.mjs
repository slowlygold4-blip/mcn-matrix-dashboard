import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const normalId = value => String(value ?? '').normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
const validCount = value => Number.isSafeInteger(value) && value >= 0;

// XLSX exports can have different ZIP bytes for identical cells. Idempotence
// must therefore compare the audited rows and classifications, not only the
// archive SHA. Link timestamps are excluded; their identities are retained.
function canonicalSourceDigest(db, importId = null) {
  const hash = createHash('sha256');
  const stage = importId == null;
  const sheets = stage
    ? db.prepare('SELECT sheet_id,sheet_name,ordinal,row_count,headers_json,restricted FROM source_sheets ORDER BY ordinal').iterate()
    : db.prepare('SELECT sheet_id,sheet_name,ordinal,row_count,headers_json,restricted FROM creator_source_sheets WHERE import_id=? ORDER BY ordinal').iterate(importId);
  for (const sheet of sheets) hash.update(`sheet:${JSON.stringify(sheet)}\n`);
  const rows = stage
    ? db.prepare('SELECT sheet_id,row_number,values_json FROM source_rows ORDER BY sheet_id,row_number').iterate()
    : db.prepare('SELECT sheet_id,row_number,values_json FROM creator_source_rows WHERE import_id=? ORDER BY sheet_id,row_number').iterate(importId);
  for (const row of rows) hash.update(`row:${row.sheet_id}:${row.row_number}:${row.values_json}\n`);
  const links = stage
    ? db.prepare('SELECT author_row,target_id,matched_id FROM account_links ORDER BY author_row,target_id').iterate()
    : db.prepare('SELECT author_row,target_id,matched_id FROM creator_source_account_links WHERE import_id=? ORDER BY author_row,target_id').iterate(importId);
  for (const link of links) hash.update(`link:${link.author_row}:${link.target_id}:${link.matched_id}\n`);
  return hash.digest('hex');
}
export function integrateCreatorLibrary({ sourcePath = resolve(root, 'data/creator-library.sqlite'), targetPath = resolve(root, 'data/douyin-monitor.sqlite'), dryRun = false } = {}) {
sourcePath = resolve(sourcePath); targetPath = resolve(targetPath);
if (!existsSync(sourcePath) || !existsSync(targetPath)) throw new Error('来源或目标数据库不存在；不会创建空的生产库');
if (realpathSync(sourcePath) === realpathSync(targetPath)) throw new Error('来源和目标数据库不能相同');
const source = new DatabaseSync(sourcePath, { readOnly: true });
let target;
try {
source.exec('PRAGMA query_only=ON; BEGIN');
target = new DatabaseSync(targetPath, { readOnly: dryRun });
target.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON');
if (dryRun) target.exec('PRAGMA query_only=ON; BEGIN');
const metadata = Object.fromEntries(source.prepare('SELECT key,value FROM metadata').all().map(row => [row.key, JSON.parse(row.value)]));
const audit = metadata.audit;
if (!audit || !['sheetCount', 'authorCount', 'workCount'].every(key => validCount(audit[key])) || !audit.sheetCount)
  throw new Error('缺少已审查的工作表、作者或作品数量');
if (!metadata.sourcePath || !metadata.sourceUrl || metadata.sourceRevision == null || !String(metadata.sourceRevision).trim()
  || !metadata.sourceModifiedAt || !Number.isFinite(Date.parse(metadata.sourceModifiedAt))) throw new Error('来源路径、链接、版本或修改时间不完整');
const sha = createHash('sha256').update(readFileSync(metadata.sourcePath)).digest('hex');
if (sha !== metadata.sourceSha256) throw new Error('原始 XLSX 校验值与待入库来源不一致');
const sheets = source.prepare('SELECT * FROM source_sheets ORDER BY ordinal').all();
const sourceCount = source.prepare('SELECT COUNT(*) n FROM source_rows').get().n;
if (sheets.length !== audit.sheetCount || sheets.some(row => !validCount(row.row_count))
  || sheets.reduce((sum, row) => sum + row.row_count, 0) !== sourceCount) throw new Error('来源工作表/行数审计失败');
const actualSheets = new Map(source.prepare('SELECT sheet_id,COUNT(*) n,MIN(row_number) first,MAX(row_number) last FROM source_rows GROUP BY sheet_id').all().map(row => [row.sheet_id, row]));
for (const sheet of sheets) {
  const actual = actualSheets.get(sheet.sheet_id);
  if ((actual?.n || 0) !== sheet.row_count || actual && (actual.first !== 2 || actual.last !== sheet.row_count + 1))
    throw new Error(`工作表 ${sheet.sheet_id} 的数量或来源行号不一致`);
  actualSheets.delete(sheet.sheet_id);
}
if (actualSheets.size) throw new Error('存在没有工作表目录的来源行');
const authorCount = source.prepare("SELECT COUNT(*) n FROM source_rows WHERE sheet_id='08'").get().n;
const workCount = source.prepare("SELECT COUNT(*) n FROM source_rows WHERE sheet_id='09'").get().n;
if (authorCount !== audit.authorCount || workCount !== audit.workCount
  || !sheets.some(s => s.sheet_id === '08') || !sheets.some(s => s.sheet_id === '09')) throw new Error('作者/作品数量与已审查来源不一致');
const authorIds = new Map(), authorKeys = new Map();
for (const row of source.prepare("SELECT row_number,values_json FROM source_rows WHERE sheet_id='08'").all()) {
  const values = JSON.parse(row.values_json);
  if (!Array.isArray(values)) throw new Error(`作者第 ${row.row_number} 行格式错误`);
  const id = normalId(values[1]);
  authorKeys.set(row.row_number, new Set(id ? [id] : []));
  if (id) { if (!authorIds.has(id)) authorIds.set(id, []); authorIds.get(id).push(row.row_number); }
}
for (const row of source.prepare("SELECT values_json FROM source_rows WHERE sheet_id='16'").all()) {
  const values = JSON.parse(row.values_json), authors = authorIds.get(normalId(values[0]));
  if (authors?.length !== 1) continue;
  for (const alias of String(values[1] ?? '').split(/\s*\/\s*/)) {
    const id = normalId(alias); if (id) authorKeys.get(authors[0]).add(id);
  }
}
const contentIds = new Set();
for (const row of source.prepare("SELECT row_number,values_json FROM source_rows WHERE sheet_id='09'").all()) {
  const values = JSON.parse(row.values_json);
  if (!Array.isArray(values) || typeof values[0] === 'number' && !Number.isSafeInteger(values[0])) throw new Error(`作品第 ${row.row_number} 行 ID 格式错误`);
  const id = normalId(values[0]);
  if (!id || contentIds.has(id)) throw new Error('去重作品存在空或重复的作品 ID');
  contentIds.add(id);
}
const sourceLinks = source.prepare('SELECT * FROM account_links ORDER BY author_row,target_id').all();
if (validCount(audit.matchedTargets) && audit.matchedTargets !== sourceLinks.length
  || validCount(audit.matchedAuthors) && audit.matchedAuthors !== new Set(sourceLinks.map(link => link.author_row)).size)
  throw new Error('严格账号关联数量与审查不一致');
// Real integration holds a write reservation while rechecking identities and
// writing all versioned tables/views. Dry runs use only a read transaction.
if (!dryRun) target.exec('BEGIN IMMEDIATE');
for (const link of sourceLinks) {
  if (!authorKeys.get(link.author_row)?.has(normalId(link.matched_id))) throw new Error(`严格账号关联没有对应来源 ID：${link.author_row}`);
  const current = target.prepare("SELECT id,type,locator,metadata_json FROM targets WHERE id=?").get(link.target_id);
  if (!current || current.type !== 'account') throw new Error(`严格账号关联已失效：${link.target_id}`);
  const metadata = JSON.parse(current.metadata_json || '{}');
  const observedIds = [metadata.douyinId, metadata.resolution?.publicDouyinId].filter(Boolean)
    .map(normalId);
  if (!observedIds.includes(normalId(link.matched_id)) || metadata.identityVerification?.accountId !== current.locator)
    throw new Error(`严格账号关联的公开账号 ID 已变化：${link.target_id}`);
}
const linksByAuthor = new Map();
for (const link of sourceLinks) {
  if (!linksByAuthor.has(link.author_row)) linksByAuthor.set(link.author_row, new Set());
  linksByAuthor.get(link.author_row).add(link.target_id);
}
const workLinks = [];
for (const row of source.prepare("SELECT row_number,values_json FROM source_rows WHERE sheet_id='09'").all()) {
  const authors = authorIds.get(normalId(JSON.parse(row.values_json)[2])) || [];
  const targets = authors.length === 1 ? linksByAuthor.get(authors[0]) : null;
  if (targets?.size === 1) workLinks.push({ workRow: row.row_number, targetId: [...targets][0] });
}
const exists = target.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='creator_source_imports'").get();
let existing = exists ? target.prepare('SELECT id,source_row_count FROM creator_source_imports WHERE source_sha256=?').get(sha) : null;
if (!existing && exists) {
  const latest = target.prepare('SELECT id,source_row_count FROM creator_source_imports ORDER BY id DESC LIMIT 1').get();
  if (latest && canonicalSourceDigest(source) === canonicalSourceDigest(target, latest.id)) existing = latest;
}
if (existing) {
  const storedRows = target.prepare('SELECT COUNT(*) n FROM creator_source_rows WHERE import_id=?').get(existing.id).n;
  const storedSheets = target.prepare('SELECT COUNT(*) n FROM creator_source_sheets WHERE import_id=?').get(existing.id).n;
  if (existing.source_row_count !== sourceCount || storedRows !== sourceCount || storedSheets !== sheets.length)
    throw new Error('相同来源哈希已有不一致入库记录');
}
const summary = { rows: sourceCount, sheets: sheets.length, authors: authorCount, works: workCount,
  strictAccountLinks: sourceLinks.length, identityLinkedWorks: workLinks.length, sha256: sha };
if (dryRun) {
  target.exec('ROLLBACK');
  return { status: 'dry-run', action: existing ? 'unchanged' : 'would-import', importId: existing?.id ?? null,
    ...summary, sourcePath, targetPath, productionDatabaseChanged: false };
}
let result;
try {
  target.exec(`CREATE TABLE IF NOT EXISTS creator_source_imports(
      id INTEGER PRIMARY KEY, source_sha256 TEXT NOT NULL UNIQUE, source_url TEXT NOT NULL,
      source_revision TEXT NOT NULL, source_modified_at TEXT NOT NULL, imported_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL, source_row_count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS creator_source_sheets(
      import_id INTEGER NOT NULL REFERENCES creator_source_imports(id), sheet_id TEXT NOT NULL,
      sheet_name TEXT NOT NULL, ordinal INTEGER NOT NULL, row_count INTEGER NOT NULL,
      headers_json TEXT NOT NULL, restricted INTEGER NOT NULL, PRIMARY KEY(import_id,sheet_id));
    CREATE TABLE IF NOT EXISTS creator_source_rows(
      import_id INTEGER NOT NULL REFERENCES creator_source_imports(id), sheet_id TEXT NOT NULL,
      row_number INTEGER NOT NULL, values_json TEXT NOT NULL, search_text TEXT NOT NULL,
      public_search_text TEXT NOT NULL, PRIMARY KEY(import_id,sheet_id,row_number));
    CREATE TABLE IF NOT EXISTS creator_source_account_links(
      import_id INTEGER NOT NULL REFERENCES creator_source_imports(id), author_row INTEGER NOT NULL,
      target_id INTEGER NOT NULL, matched_id TEXT NOT NULL, matched_at TEXT NOT NULL,
      PRIMARY KEY(import_id,author_row,target_id));
    CREATE TABLE IF NOT EXISTS creator_source_work_links(
      import_id INTEGER NOT NULL REFERENCES creator_source_imports(id), work_row INTEGER NOT NULL,
      target_id INTEGER NOT NULL, PRIMARY KEY(import_id,work_row));
    CREATE INDEX IF NOT EXISTS idx_creator_source_account_target ON creator_source_account_links(import_id,target_id);
    CREATE INDEX IF NOT EXISTS idx_creator_source_rows_search ON creator_source_rows(import_id,sheet_id,row_number);
    CREATE INDEX IF NOT EXISTS idx_posts_external_id_for_creator_source ON posts(external_id);`);
  if (existing) {
    result = { status: 'unchanged', importId: existing.id, ...summary };
  } else {
    const importedAt = new Date().toISOString();
    const metadataJson = JSON.stringify(metadata);
    const importId = Number(target.prepare(`INSERT INTO creator_source_imports
      (source_sha256,source_url,source_revision,source_modified_at,imported_at,metadata_json,source_row_count)
      VALUES(?,?,?,?,?,?,?)`).run(sha, metadata.sourceUrl, metadata.sourceRevision,
      metadata.sourceModifiedAt, importedAt, metadataJson, sourceCount).lastInsertRowid);
    const insertSheet = target.prepare(`INSERT INTO creator_source_sheets
      (import_id,sheet_id,sheet_name,ordinal,row_count,headers_json,restricted) VALUES(?,?,?,?,?,?,?)`);
    const insertRow = target.prepare(`INSERT INTO creator_source_rows
      (import_id,sheet_id,row_number,values_json,search_text,public_search_text) VALUES(?,?,?,?,?,?)`);
    const insertAccount = target.prepare(`INSERT INTO creator_source_account_links
      (import_id,author_row,target_id,matched_id,matched_at) VALUES(?,?,?,?,?)`);
    const insertWork = target.prepare(`INSERT INTO creator_source_work_links(import_id,work_row,target_id) VALUES(?,?,?)`);
    for (const sheet of sheets) insertSheet.run(importId, sheet.sheet_id, sheet.sheet_name, sheet.ordinal, sheet.row_count, sheet.headers_json, sheet.restricted);
    for (const row of source.prepare('SELECT sheet_id,row_number,values_json,search_text,public_search_text FROM source_rows ORDER BY sheet_id,row_number').iterate()) {
      insertRow.run(importId, row.sheet_id, row.row_number, row.values_json, row.search_text, row.public_search_text);
    }
    for (const link of sourceLinks) {
      insertAccount.run(importId, link.author_row, link.target_id, link.matched_id, link.matched_at);
    }
    for (const link of workLinks) insertWork.run(importId, link.workRow, link.targetId);
    result = { status: 'imported', importId, ...summary };
  }
  // Versioned immutable tables are the source of truth. Compatibility views
  // let the existing read-only drilldown query the integrated main database.
  target.exec(`CREATE VIEW IF NOT EXISTS metadata AS SELECT j.key,
      CASE WHEN j.type IN ('object','array') THEN j.value ELSE json_quote(j.value) END AS value FROM creator_source_imports i,
    json_each(i.metadata_json) j WHERE i.id=(SELECT MAX(id) FROM creator_source_imports);
    CREATE VIEW IF NOT EXISTS source_sheets AS SELECT sheet_id,sheet_name,ordinal,row_count,headers_json,restricted
      FROM creator_source_sheets WHERE import_id=(SELECT MAX(id) FROM creator_source_imports);
    CREATE VIEW IF NOT EXISTS source_rows AS SELECT sheet_id,row_number,values_json,search_text,public_search_text
      FROM creator_source_rows WHERE import_id=(SELECT MAX(id) FROM creator_source_imports);
    CREATE VIEW IF NOT EXISTS account_links AS SELECT author_row,target_id,matched_id,matched_at
      FROM creator_source_account_links WHERE import_id=(SELECT MAX(id) FROM creator_source_imports);`);
  target.exec('COMMIT');
  return result;
} catch (error) { try { target.exec('ROLLBACK'); } catch {} throw error; }
} catch (error) { try { target?.exec('ROLLBACK'); } catch {} throw error; }
finally { source.close(); target?.close(); }
}

export function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') { options.dryRun = true; continue; }
    if (['--source', '--target'].includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      options[argv[i] === '--source' ? 'sourcePath' : 'targetPath'] = argv[++i]; continue;
    }
    throw new Error('用法：node scripts/integrate-creator-library.mjs [--source 待入库.sqlite] [--target 主库.sqlite] [--dry-run]');
  }
  return options;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(integrateCreatorLibrary(parseArguments(process.argv.slice(2))))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
