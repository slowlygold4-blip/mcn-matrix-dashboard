import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSubmittedAccountId } from '../lib/author-spreadsheet.mjs';
import { buildAuthorEvidenceRequests } from '../lib/author-resolution.mjs';
import { creatorSourceWorkEvidence } from '../lib/creator-source-work-evidence.mjs';

const root = resolve(import.meta.dirname, '..');
const normalize = value => String(value ?? '').normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
const parse = value => JSON.parse(value);

function requireSourceSchema(db, importId) {
  const sheets = new Map(db.prepare('SELECT sheet_id,headers_json FROM creator_source_sheets WHERE import_id=?').all(importId)
    .map(row => [row.sheet_id, parse(row.headers_json)]));
  const author = sheets.get('08'), work = sheets.get('09');
  if (author?.[0] !== '作者名' || author?.[1] !== '主抖音号'
    || work?.[0] !== '视频或图文ID' || work?.[2] !== '主抖音号' || work?.[11] !== '作品链接') {
    throw new Error('来源作者/作品列结构与已审查版本不同；拒绝生成可能错配的候选');
  }
}


function knownTargetIds(db) {
  const ids = new Set();
  for (const row of db.prepare("SELECT metadata_json FROM targets WHERE type='account'").all()) {
    let metadata;
    try { metadata = parse(row.metadata_json || '{}'); }
    catch { continue; }
    if ((metadata.platform || 'douyin') !== 'douyin') continue;
    for (const value of [metadata.douyinId, metadata.resolution?.publicDouyinId]) {
      const id = validateSubmittedAccountId(value, 'douyin').value;
      if (id) ids.add(normalize(id));
    }
  }
  return ids;
}

/** Strictly read-only planning. A work URL is a candidate for later author
 * verification, never proof that its source author owns a monitor target. */
export function buildCreatorSourceResolutionCandidates(db, { previewLimit = 20, afterAuthorRow = 0, all = false, recoverFailed = false } = {}) {
  if (all) previewLimit = 5000;
  if (!Number.isSafeInteger(previewLimit) || previewLimit < 0 || previewLimit > (all ? 5000 : 100)) throw new Error('预览条数需为 0–100');
  if (!Number.isSafeInteger(afterAuthorRow) || afterAuthorRow < 0) throw new Error('作者行游标必须为非负整数');
  const source = db.prepare('SELECT id,source_sha256,source_url,source_revision,source_modified_at FROM creator_source_imports ORDER BY id DESC LIMIT 1').get();
  if (!source) throw new Error('尚未入库创作者来源；无法生成候选');
  requireSourceSchema(db, source.id);

  const authorRows = db.prepare("SELECT row_number,values_json FROM creator_source_rows WHERE import_id=? AND sheet_id='08' ORDER BY row_number").all(source.id);
  const workRows = db.prepare("SELECT row_number,values_json FROM creator_source_rows WHERE import_id=? AND sheet_id='09' ORDER BY row_number").all(source.id);
  const linked = new Set(db.prepare('SELECT author_row FROM creator_source_account_links WHERE import_id=?').all(source.id).map(row => row.author_row));
  const targets = knownTargetIds(db);
  const queued = new Set(db.prepare('SELECT douyin_id FROM author_resolution_queue').all()
    .map(row => validateSubmittedAccountId(row.douyin_id, 'douyin').value).filter(Boolean).map(normalize));

  const failedGroups = new Map();
  if (recoverFailed) for (const row of db.prepare('SELECT douyin_id,status,identity_key FROM author_resolution_queue').all()) {
    const key = normalize(validateSubmittedAccountId(row.douyin_id,'douyin').value);
    const items=failedGroups.get(key) ?? [];items.push(row);failedGroups.set(key,items);
  }
  const allQueueKeys = recoverFailed ? new Set(db.prepare('SELECT identity_key FROM author_resolution_queue').all().map(row=>row.identity_key)) : null;
  const authors = authorRows.map(row => {
    const values = parse(row.values_json);
    const id = validateSubmittedAccountId(values[1], 'douyin').value;
    return { row: row.row_number, name: String(values[0] ?? '').trim(), id, normalizedId: normalize(id) };
  });
  const byId = new Map();
  for (const author of authors) {
    if (!author.id) continue;
    if (!byId.has(author.normalizedId)) byId.set(author.normalizedId, []);
    byId.get(author.normalizedId).push(author);
  }

  const worksById = new Map();
  for (const row of workRows) {
    const values = parse(row.values_json);
    const id = validateSubmittedAccountId(values[2], 'douyin').value;
    if (!id) continue;
    const work = creatorSourceWorkEvidence(values, row.row_number);
    if (!work) continue;
    const key = normalize(id);
    if (!worksById.has(key)) worksById.set(key, []);
    worksById.get(key).push(work);
  }

  const excluded = { invalidAccountId: 0, duplicateAccountId: 0, alreadyStrictLinked: 0,
    alreadyKnownTargetId: 0, alreadyInResolutionQueue: 0, noEligibleWork: 0 };
  const candidates = [];
  for (const author of authors) {
    if (!author.id) { excluded.invalidAccountId++; continue; }
    if (byId.get(author.normalizedId).length !== 1) { excluded.duplicateAccountId++; continue; }
    if (linked.has(author.row)) { excluded.alreadyStrictLinked++; continue; }
    if (targets.has(author.normalizedId)) { excluded.alreadyKnownTargetId++; continue; }
    if (recoverFailed ? !failedGroups.get(author.normalizedId)?.every(row=>row.status==='rejected') : queued.has(author.normalizedId)) {
      excluded.alreadyInResolutionQueue++; continue;
    }
    const work = worksById.get(author.normalizedId)?.sort((a, b) => a.priority - b.priority || a.workRow - b.workRow)
      .find(work => !recoverFailed || !allQueueKeys.has(buildAuthorEvidenceRequests([{name:author.name,douyinId:author.id,
        videoId:work.videoId,shareUrl:work.shareUrl,sourceRow:author.row,boards:[{name:'一条小团团切片矩阵'}]}])[0]?.key));
    if (!work) { excluded.noEligibleWork++; continue; }
    const request = buildAuthorEvidenceRequests([{ name: author.name, douyinId: author.id,
      videoId: work.videoId, shareUrl: work.shareUrl, sourceRow: author.row,
      boards: [{ name: '一条小团团切片矩阵' }] }])[0];
    if (!request?.key) throw new Error(`作者来源第 ${author.row} 行候选证据无法形成稳定键`);
    candidates.push({ key: request.key, name: author.name, submittedAccountId: author.id,
      authorRow: author.row, workRow: work.workRow, videoId: work.videoId, shareUrl: work.shareUrl,
      evidenceType: work.evidenceType, identityStatus: 'unverified-candidate',
      source: { url: source.source_url, revision: source.source_revision, sha256: source.source_sha256,
        modifiedAt: source.source_modified_at, authorSheet: '08_作者总表', workSheet: '09_去重作品' } });
  }
  if (authors.length !== candidates.length + Object.values(excluded).reduce((a, b) => a + b, 0)) throw new Error('候选分桶未覆盖全部来源作者');
  return { dryRun: true, productionDatabaseChanged: false, sourceImportId: source.id,
    sourceSha256: source.source_sha256, sourceRevision: source.source_revision,
    authorRows: authors.length, workRows: workRows.length, excluded,
    candidateCount: candidates.length,
    evidenceTypes: { directWorkUrl: candidates.filter(row => row.evidenceType === 'direct-work-url').length,
      shortWorkUrl: candidates.filter(row => row.evidenceType !== 'direct-work-url').length },
    preview: candidates.filter(row => row.authorRow > afterAuthorRow).slice(0, previewLimit),
    note: '仅生成一人一作品的待核验候选；未入队、未采集、未创建监控目标或平台快照。' };
}

export function parseArguments(argv) {
  const options = { dbPath: resolve(root, 'data/douyin-monitor.sqlite'), previewLimit: 20 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db' && argv[i + 1]) { options.dbPath = resolve(argv[++i]); continue; }
    if (argv[i] === '--limit' && argv[i + 1] && /^\d+$/.test(argv[i + 1])) { options.previewLimit = Number(argv[++i]); continue; }
    throw new Error('用法：node scripts/build-creator-source-resolution-candidates.mjs [--db 只读数据库] [--limit 0..100]');
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { dbPath, previewLimit } = parseArguments(process.argv.slice(2));
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { db.exec('PRAGMA query_only=ON'); console.log(JSON.stringify(buildCreatorSourceResolutionCandidates(db, { previewLimit }), null, 2)); }
    finally { db.close(); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
