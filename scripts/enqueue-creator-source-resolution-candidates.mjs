import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildCreatorSourceResolutionCandidates } from './build-creator-source-resolution-candidates.mjs';
import { buildAuthorEvidenceRequests } from '../lib/author-resolution.mjs';

const root = resolve(import.meta.dirname, '..');
const SHA = /^[a-f0-9]{64}$/i;
const hash = value => createHash('sha256').update(value).digest('hex');
export const candidateBatchKey = ({ sourceSha, afterAuthorRow, limit, recoverFailed = false }) =>
  hash(`creator-source-resolution-queue-v1\n${sourceSha}\n${afterAuthorRow}\n${limit}${recoverFailed ? "\nnew-evidence-after-failure-v1" : ""}`);

export function parseEnqueueArguments(argv) {
  const options = { dbPath: resolve(root, 'data/douyin-monitor.sqlite'),
    sourceDbPath: resolve(root, 'data/creator-library.sqlite'), apply: false,
    afterAuthorRow: 0, limit: 20, sourceSha: '', backupPath: '' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw new Error(`重复参数：${flag}`);
    seen.add(flag);
    if (flag === '--apply') { options.apply = true; continue; }
    if (flag === '--recover-failed') { options.recoverFailed = true; continue; }
    if (flag === '--all') { options.all = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`参数 ${flag} 缺少值`);
    if (flag === '--db') options.dbPath = resolve(value);
    else if (flag === '--confirm-source-db') options.sourceDbPath = resolve(value);
    else if (flag === '--source-sha' && SHA.test(value)) options.sourceSha = value.toLowerCase();
    else if (flag === '--limit' && /^\d+$/.test(value)) options.limit = Number(value);
    else if (flag === '--after-author-row' && /^\d+$/.test(value)) options.afterAuthorRow = Number(value);
    else if (flag === '--confirm-db-backup') options.backupPath = resolve(value);
    else throw new Error(`无效参数 ${flag} 或参数值`);
  }
  if (options.all && (seen.has('--limit') || seen.has('--after-author-row'))) throw new Error('--all 不可与分页参数混用');
  if (options.all) options.limit = 5000;
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > (options.all ? 5000 : 50))
    throw new Error('每批仅允许 1–50 位作者');
  if (!Number.isSafeInteger(options.afterAuthorRow) || options.afterAuthorRow < 0)
    throw new Error('作者行游标必须为非负整数');
  if (options.apply && (!seen.has('--source-sha') || (!seen.has('--limit') && !options.all) || !seen.has('--confirm-db-backup')))
    throw new Error('入队必须明确 --apply、--source-sha、--limit、--confirm-db-backup；默认为只读预览');
  return options;
}

function assertSourceSha(plan, expected) {
  if (expected && plan.sourceSha256.toLowerCase() !== expected.toLowerCase())
    throw new Error('来源 SHA 已变化；拒绝使用旧表格证据入队');
}

function planBatch(db, options) {
  const plan = buildCreatorSourceResolutionCandidates(db, {
    previewLimit: options.limit, afterAuthorRow: options.afterAuthorRow, all: options.all === true, recoverFailed: options.recoverFailed === true,
  });
  assertSourceSha(plan, options.sourceSha);
  const selected = plan.preview;
  const batchKey = candidateBatchKey({ sourceSha: plan.sourceSha256,
    afterAuthorRow: options.afterAuthorRow, limit: options.limit, recoverFailed: options.recoverFailed });
  return { plan, selected, batchKey };
}

function sourceContentFingerprint(db, importId = null) {
  const digest = createHash('sha256');
  const stage = importId === null;
  const source = stage ? (() => {
    const meta = Object.fromEntries(db.prepare('SELECT key,value FROM metadata').all().map(row =>
      [row.key, JSON.parse(row.value)]));
    return { source_sha256: meta.sourceSha256, source_url: meta.sourceUrl,
      source_revision: String(meta.sourceRevision), source_modified_at: meta.sourceModifiedAt };
  })() : db.prepare(`SELECT source_sha256,source_url,source_revision,source_modified_at
    FROM creator_source_imports WHERE id=?`).get(importId);
  if (!source) throw new Error('来源导入记录已消失');
  digest.update(`import:${JSON.stringify(source)}\n`);
  const sheets = stage
    ? db.prepare('SELECT sheet_id,headers_json FROM source_sheets ORDER BY sheet_id').iterate()
    : db.prepare('SELECT sheet_id,headers_json FROM creator_source_sheets WHERE import_id=? ORDER BY sheet_id').iterate(importId);
  for (const sheet of sheets)
    digest.update(`sheet:${JSON.stringify(sheet)}\n`);
  const rows = stage
    ? db.prepare('SELECT sheet_id,row_number,values_json FROM source_rows ORDER BY sheet_id,row_number').iterate()
    : db.prepare('SELECT sheet_id,row_number,values_json FROM creator_source_rows WHERE import_id=? ORDER BY sheet_id,row_number').iterate(importId);
  for (const row of rows)
    digest.update(`row:${JSON.stringify(row)}\n`);
  const links = stage
    ? db.prepare('SELECT author_row,target_id,matched_id FROM account_links ORDER BY author_row,target_id,matched_id').iterate()
    : db.prepare('SELECT author_row,target_id,matched_id FROM creator_source_account_links WHERE import_id=? ORDER BY author_row,target_id,matched_id').iterate(importId);
  for (const link of links)
    digest.update(`link:${JSON.stringify(link)}\n`);
  return digest.digest('hex');
}

function verifyFrozenSource(sourceDbPath, sourceSha) {
  const db = new DatabaseSync(realpathSync(sourceDbPath), { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const meta = Object.fromEntries(db.prepare('SELECT key,value FROM metadata').all()
      .map(row => [row.key, JSON.parse(row.value)]));
    if (meta.sourceSha256 !== sourceSha || !meta.sourcePath)
      throw new Error('冻结来源的原始文件 SHA 或路径与本批不一致');
    const originalPath = realpathSync(meta.sourcePath);
    if (!statSync(originalPath).isFile() || hash(readFileSync(originalPath)) !== sourceSha)
      throw new Error('原始 XLSX 文件哈希与冻结来源 SHA 不一致');
    return { path: realpathSync(sourceDbPath), originalPath,
      sourceSha256: sourceSha, sourceContentSha256: sourceContentFingerprint(db) };
  } finally { db.close(); }
}

function tableCounts(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  return Object.fromEntries([
    'targets', 'posts', 'post_metrics', 'snapshots', 'runs', 'audits', 'source_probes',
    'author_resolution_queue', 'author_resolution_import_sources',
    'creator_source_imports', 'creator_source_sheets', 'creator_source_rows',
    'creator_source_account_links', 'creator_source_work_links',
  ].filter(table => tables.has(table)).map(table => [table,
    db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
}

function verifyBackup(dbPath, backupPath, sourceSha) {
  if (!backupPath) throw new Error('缺少已验证数据库备份路径');
  const current = realpathSync(dbPath), backup = realpathSync(backupPath);
  const currentStat = statSync(current), backupStat = statSync(backup);
  if (current === backup || currentStat.dev === backupStat.dev && currentStat.ino === backupStat.ino
    || !backupStat.isFile()) throw new Error('备份必须是另一份独立可读取的 SQLite 文件，不可使用硬链接');
  const db = new DatabaseSync(backup, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('备份 SQLite 完整性检查未通过');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('备份包含 SQLite 外键冲突');
    const source = db.prepare('SELECT id,source_sha256 FROM creator_source_imports ORDER BY id DESC LIMIT 1').get();
    if (source?.source_sha256?.toLowerCase() !== sourceSha.toLowerCase())
      throw new Error('备份中的最新来源与将要入队的来源 SHA 不一致');
    for (const sheet of ['08', '09']) {
      if (!db.prepare('SELECT 1 FROM creator_source_rows WHERE sheet_id=? LIMIT 1').get(sheet))
        throw new Error(`备份缺少来源 ${sheet} 表内容`);
    }
    const counts = tableCounts(db);
    const verifiedStat = statSync(backup);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => verifiedStat[key] !== backupStat[key]))
      throw new Error('备份在读取校验期间发生变化；拒绝入队');
    return { path: backup, quickCheck: 'ok', foreignKeyCheck: 'ok',
      fileIdentity: { dev: verifiedStat.dev, ino: verifiedStat.ino, size: verifiedStat.size,
        mtimeMs: verifiedStat.mtimeMs, ctimeMs: verifiedStat.ctimeMs },
      sourceSha256: source.source_sha256, sourceContentSha256: sourceContentFingerprint(db, source.id), counts };
  } finally { db.close(); }
}

const findBatchReceipts = db => db.prepare(`SELECT queue_id,queue_identity_key,receipt_sha256,payload_json
  FROM author_resolution_import_sources
  WHERE json_valid(payload_json)
    AND json_extract(payload_json,'$.sourceMetadata.batchKey')=?`);

export function previousBatch(db, batchKey, sourceSha) {
  const rows = findBatchReceipts(db).all(batchKey);
  if (!rows.length) return null;
  const values = rows.map(row => JSON.parse(row.payload_json));
  const first = values[0]?.sourceMetadata;
  if (!first || first.sourceSha256 !== sourceSha || !Number.isSafeInteger(first.batchSize)
    || first.batchSize !== rows.length
    || new Set(rows.map(row => row.queue_identity_key)).size !== rows.length
    || new Set(values.map(value => value.sourceMetadata?.authorRow)).size !== rows.length
    || rows.some((row, index) => hash(row.payload_json) !== row.receipt_sha256
      || values[index].sourceMetadata?.sourceSha256 !== sourceSha
      || values[index].sourceMetadata?.batchKey !== batchKey
      || values[index].sourceMetadata?.batchSize !== first.batchSize
      || values[index].sourceMetadata?.lastAuthorRow !== first.lastAuthorRow
      || !db.prepare('SELECT 1 FROM author_resolution_queue WHERE identity_key=? AND id=?')
        .get(row.queue_identity_key, row.queue_id)))
    throw new Error('已有同批来源收据不完整或队列缺失，拒绝自动补写');
  return { status: 'already-applied', applied: false, inserted: 0, batchKey,
    existingReceipts: rows.length, lastAuthorRow: first.lastAuthorRow };
}

function queueRow(candidate, batchKey, batchSize, lastAuthorRow, timestamp, sourceProof) {
  const request = buildAuthorEvidenceRequests([{ name: candidate.name, douyinId: candidate.submittedAccountId,
    videoId: candidate.videoId, shareUrl: candidate.shareUrl, sourceRow: candidate.authorRow,
    boards: [{ name: '一条小团团切片矩阵' }] }])[0];
  if (!request || request.key !== candidate.key || request.videoIds.length !== 1
    || request.shareUrls.length !== 1 || request.douyinId !== candidate.submittedAccountId)
    throw new Error(`作者来源第 ${candidate.authorRow} 行的身份或作品证据已冲突`);
  const sourceMetadata = { sourceType: 'creator-source-sheet', sourceUrl: candidate.source.url,
    sourceRevision: candidate.source.revision, sourceSha256: candidate.source.sha256,
    sourceModifiedAt: candidate.source.modifiedAt, authorSheet: candidate.source.authorSheet,
    authorRow: candidate.authorRow, workSheet: candidate.source.workSheet, workRow: candidate.workRow,
    authorRowSha256: sourceProof.authorRowSha256, workRowSha256: sourceProof.workRowSha256,
    frozenSourceDigest: sourceProof.frozenSourceDigest,
    evidenceType: candidate.evidenceType, identityStatus: 'unverified-candidate',
    batchKey, batchSize, lastAuthorRow };
  const fileName = '一条小团团切片作品登记表-来源数据集';
  const sheetName = candidate.source.authorSheet;
  const source = { fileName, sheetName, sourceRows: [candidate.authorRow], sourceMetadata,
    boards: request.boards };
  const payload = JSON.stringify(source);
  return { request, sourceMetadata, source, payload, receiptSha: hash(payload), timestamp, fileName, sheetName };
}

/** The transaction deliberately writes only the queue and its immutable source
 * receipts. The generic enqueueAuthorResolutions method also edits board
 * memberships and can resolve via evidence reuse, so it is unsafe here. */
export function enqueueCreatorSourceResolutionCandidates(db, options) {
  if (!options.apply) {
    db.exec('PRAGMA query_only=ON');
    const { plan, selected, batchKey } = planBatch(db, options);
    return { status: 'dry-run', applied: false, productionDatabaseChanged: false,
      sourceSha256: plan.sourceSha256, sourceRevision: plan.sourceRevision,
      authorRows: plan.authorRows, candidateCount: plan.candidateCount,
      excluded: plan.excluded, afterAuthorRow: options.afterAuthorRow,
      selectedCount: selected.length, lastAuthorRow: selected.at(-1)?.authorRow ?? null,
      evidenceTypes: { direct: selected.filter(row => row.evidenceType === 'direct-work-url').length,
        short: selected.filter(row => row.evidenceType !== 'direct-work-url').length },
      batchKey, note: '未入队、未采集；作品 URL 仅作为待核验证据，不代表主页已核验。' };
  }
  if (!SHA.test(options.sourceSha || '')) throw new Error('必须提供有效的来源 SHA');
  const precheckDataVersion = db.prepare('PRAGMA data_version').get().data_version;
  const frozenSource = verifyFrozenSource(options.sourceDbPath, options.sourceSha);
  // This is a gate, not a backup creator: the operator must separately make
  // and retain a consistent SQLite backup before requesting any live write.
  const backup = verifyBackup(options.dbPath, options.backupPath, options.sourceSha);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; BEGIN IMMEDIATE');
  try {
    if (db.prepare('PRAGMA data_version').get().data_version !== precheckDataVersion)
      throw new Error('备份核对期间主库被其他连接更新；请重新创建并验证备份');
    const source = db.prepare('SELECT id,source_sha256 FROM creator_source_imports ORDER BY id DESC LIMIT 1').get();
    if (source?.source_sha256?.toLowerCase() !== options.sourceSha) throw new Error('事务内来源 SHA 不匹配');
    const currentSourceDigest = sourceContentFingerprint(db, source.id);
    if (currentSourceDigest !== backup.sourceContentSha256
      || currentSourceDigest !== frozenSource.sourceContentSha256)
      throw new Error('当前库、备份与冻结来源的行内容不一致；拒绝入队');
    const batchKey = candidateBatchKey({ sourceSha: options.sourceSha,
      afterAuthorRow: options.afterAuthorRow, limit: options.limit, recoverFailed: options.recoverFailed });
    const previous = previousBatch(db, batchKey, options.sourceSha);
    if (previous) { db.exec('COMMIT'); return { ...previous, backup }; }
    const backupStat = statSync(backup.path);
    if (Object.entries(backup.fileIdentity).some(([key, value]) => backupStat[key] !== value))
      throw new Error('备份在校验与事务锁定之间发生变化；拒绝入队');
    for (const [table, backedUpCount] of Object.entries(backup.counts)) {
      if (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n !== backedUpCount)
        throw new Error(`备份创建后 ${table} 已变化；请先创建并验证新的数据库备份`);
    }
    const { plan, selected } = planBatch(db, options); // Recompute after write lock.
    if (!selected.length) { db.exec('COMMIT'); return { status: 'no-candidates', applied: false,
      inserted: 0, batchKey, backup, sourceSha256: plan.sourceSha256 }; }
    // A caller may impose a live queue-pressure gate. Recheck it under the
    // same write lock as the insert so a prior read cannot become stale.
    if (options.beforeInsert) options.beforeInsert(db, { plan, selected });
    const timestamp = new Date().toISOString();
    const lastAuthorRow = selected.at(-1).authorRow;
    const readSourceRow = db.prepare(`SELECT values_json FROM creator_source_rows
      WHERE import_id=? AND sheet_id=? AND row_number=?`);
    const insertQueue = db.prepare(`INSERT INTO author_resolution_queue
      (identity_key,name,douyin_id,account_locator,video_ids_json,share_urls_json,
       boards_json,source_rows_json,file_name,sheet_name,source_metadata_json,
       status,attempts,next_attempt_at,created_at,updated_at,verification_policy_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',0,?,?,?,2)`);
    const insertReceipt = db.prepare(`INSERT INTO author_resolution_import_sources
      (queue_id,queue_identity_key,receipt_sha256,observed_at,payload_json) VALUES (?,?,?,?,?)`);
    for (const candidate of selected) {
      if (candidate.source.sha256 !== options.sourceSha || !candidate.videoId || !candidate.shareUrl)
        throw new Error(`作者来源第 ${candidate.authorRow} 行缺少原始证据`);
      const author = readSourceRow.get(plan.sourceImportId, '08', candidate.authorRow);
      const work = readSourceRow.get(plan.sourceImportId, '09', candidate.workRow);
      if (!author || !work) throw new Error(`作者来源第 ${candidate.authorRow} 行的冻结行已缺失`);
      const row = queueRow(candidate, batchKey, selected.length, lastAuthorRow, timestamp, {
        authorRowSha256: hash(author.values_json), workRowSha256: hash(work.values_json),
        frozenSourceDigest: frozenSource.sourceContentSha256,
      });
      const written = insertQueue.run(row.request.key, row.request.name, row.request.douyinId,
        row.request.accountLocator || '', JSON.stringify(row.request.videoIds), JSON.stringify(row.request.shareUrls),
        JSON.stringify(row.request.boards), JSON.stringify([candidate.authorRow]), row.fileName, row.sheetName,
        JSON.stringify(row.sourceMetadata), timestamp, timestamp, timestamp);
      const queueId = Number(written.lastInsertRowid);
      if (!Number.isSafeInteger(queueId) || queueId < 1) throw new Error('队列入库未产生有效行 ID');
      insertReceipt.run(queueId, row.request.key, row.receiptSha, timestamp, row.payload);
    }
    db.exec('COMMIT');
    return { status: 'queued', applied: true, inserted: selected.length,
      batchKey, backup, sourceSha256: plan.sourceSha256, afterAuthorRow: options.afterAuthorRow,
      lastAuthorRow, note: '只增加待核验队列与来源收据；未创建监控目标或采样快照。' };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseEnqueueArguments(process.argv.slice(2));
    const db = new DatabaseSync(options.dbPath, { readOnly: !options.apply });
    try { console.log(JSON.stringify(enqueueCreatorSourceResolutionCandidates(db, options), null, 2)); }
    finally { db.close(); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
