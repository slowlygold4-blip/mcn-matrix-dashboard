import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, linkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { enqueueCreatorSourceResolutionCandidates, parseEnqueueArguments } from '../scripts/enqueue-creator-source-resolution-candidates.mjs';
import { runAuthorisedQueueCycle } from '../lib/authorised-queue-cycle.mjs';

const sourceBytes = 'fixture-source-export-bytes';
const sha = createHash('sha256').update(sourceBytes).digest('hex');
function fixture(t, count = 3) {
  const dir = mkdtempSync(join(tmpdir(), 'creator-source-queue-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'live.sqlite'), backupPath = join(dir, 'backup.sqlite');
  const sourceDbPath = join(dir, 'frozen-source.sqlite'), originalPath = join(dir, 'source.xlsx');
  writeFileSync(originalPath, sourceBytes);
  const stage = new DatabaseSync(sourceDbPath);
  stage.exec(`CREATE TABLE metadata(key TEXT,value TEXT);
    CREATE TABLE source_sheets(sheet_id TEXT,headers_json TEXT);
    CREATE TABLE source_rows(sheet_id TEXT,row_number INTEGER,values_json TEXT);
    CREATE TABLE account_links(author_row INTEGER,target_id INTEGER,matched_id TEXT);`);
  for (const [key, value] of Object.entries({ sourceSha256: sha, sourcePath: originalPath,
    sourceUrl: 'https://my.feishu.cn/sheets/VQQ3', sourceRevision: '1697',
    sourceModifiedAt: '2026-10-22T00:00:00Z' }))
    stage.prepare('INSERT INTO metadata VALUES(?,?)').run(key, JSON.stringify(value));
  let db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE creator_source_imports(id INTEGER PRIMARY KEY,source_sha256 TEXT,source_url TEXT,
    source_revision TEXT,source_modified_at TEXT,imported_at TEXT);
    CREATE TABLE creator_source_sheets(import_id INTEGER,sheet_id TEXT,headers_json TEXT);
    CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);
    CREATE TABLE creator_source_account_links(import_id INTEGER,author_row INTEGER,target_id INTEGER,matched_id TEXT);
    CREATE TABLE snapshots(id INTEGER PRIMARY KEY);
    CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,metadata_json TEXT);
    CREATE TABLE author_resolution_queue(
      id INTEGER PRIMARY KEY AUTOINCREMENT,identity_key TEXT NOT NULL UNIQUE,name TEXT NOT NULL,
      douyin_id TEXT NOT NULL,account_locator TEXT NOT NULL DEFAULT '',video_ids_json TEXT NOT NULL,
      share_urls_json TEXT NOT NULL,boards_json TEXT NOT NULL,source_rows_json TEXT NOT NULL,
      file_name TEXT NOT NULL,sheet_name TEXT NOT NULL,source_metadata_json TEXT NOT NULL,
      status TEXT NOT NULL,attempts INTEGER NOT NULL,next_attempt_at TEXT NOT NULL,last_error TEXT,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,verification_policy_version INTEGER NOT NULL,
      evidence_version INTEGER NOT NULL DEFAULT 1,lease_owner TEXT,lease_until TEXT,
      resolved_target_id INTEGER,suspended_target_enabled INTEGER);
    CREATE TABLE author_resolution_jobs(id TEXT PRIMARY KEY,status TEXT,file_name TEXT);
    CREATE TABLE author_resolution_import_sources(id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_id INTEGER,queue_identity_key TEXT NOT NULL,receipt_sha256 TEXT NOT NULL,
      observed_at TEXT NOT NULL,payload_json TEXT NOT NULL,UNIQUE(queue_identity_key,receipt_sha256));`);
  db.prepare('INSERT INTO creator_source_imports VALUES(1,?,?,?,?,?)').run(sha,
    'https://my.feishu.cn/sheets/VQQ3', '1697', '2026-10-22T00:00:00Z', new Date(Date.now()-60_000).toISOString());
  db.prepare('INSERT INTO creator_source_sheets VALUES(1,?,?)').run('08', JSON.stringify(['作者名', '主抖音号']));
  db.prepare('INSERT INTO creator_source_sheets VALUES(1,?,?)').run('09', JSON.stringify([
    '视频或图文ID', '作者名', '主抖音号', '', '', '', '', '', '', '', '', '作品链接']));
  for (const sheet of db.prepare('SELECT sheet_id,headers_json FROM creator_source_sheets').all())
    stage.prepare('INSERT INTO source_sheets VALUES(?,?)').run(sheet.sheet_id, sheet.headers_json);
  for (let i = 0; i < count; i++) {
    const authorRow = i + 2, videoId = `730000000000000000${i + 1}`;
    db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('08', authorRow,
      JSON.stringify([`Author ${i}`, `creator_${i}`]));
    const work = Array(12).fill('');
    work[0] = videoId; work[2] = `creator_${i}`; work[11] = `https://www.douyin.com/video/${videoId}`;
    db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('09', authorRow, JSON.stringify(work));
  }
  for (const row of db.prepare('SELECT sheet_id,row_number,values_json FROM creator_source_rows').all())
    stage.prepare('INSERT INTO source_rows VALUES(?,?,?)').run(row.sheet_id, row.row_number, row.values_json);
  stage.close();
  db.close();
  copyFileSync(dbPath, backupPath);
  db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  return { db, dbPath, backupPath, sourceDbPath, originalPath };
}
const applyOptions = f => ({ apply: true, dbPath: f.dbPath, backupPath: f.backupPath,
  sourceDbPath: f.sourceDbPath, sourceSha: sha, limit: 2, afterAuthorRow: 0 });

test('CLI is dry-run by default and requires all four explicit apply gates', () => {
  const plain = parseEnqueueArguments([]);
  assert.equal(plain.apply, false);
  assert.throws(() => parseEnqueueArguments(['--apply']), /必须明确/);
  assert.throws(() => parseEnqueueArguments(['--apply', '--source-sha', sha, '--limit', '51',
    '--confirm-db-backup', '/tmp/backup.sqlite']), /1–50/);
  assert.throws(() => parseEnqueueArguments(['--limit', '2', '--limit', '3']), /重复参数/);
  const parsed = parseEnqueueArguments(['--apply', '--source-sha', sha, '--limit', '2',
    '--confirm-db-backup', '/tmp/backup.sqlite', '--after-author-row', '3']);
  assert.equal(parsed.afterAuthorRow, 3);
});

test('dry run is read-only, exposes stable provenance and never creates targets', t => {
  const f = fixture(t), options = { ...applyOptions(f), apply: false };
  const before = f.db.prepare('SELECT total_changes() count').get().count;
  const first = enqueueCreatorSourceResolutionCandidates(f.db, options);
  const again = enqueueCreatorSourceResolutionCandidates(f.db, options);
  assert.deepEqual(first, again);
  assert.equal(first.selectedCount, 2);
  assert.equal(first.lastAuthorRow, 3);
  assert.equal(f.db.prepare('SELECT total_changes() count').get().count, before);
  assert.equal(f.db.prepare('SELECT count(*) n FROM author_resolution_queue').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM targets').get().n, 0);
});

test('verified backup gates small transactional queue batch; repeat is a no-op', t => {
  const f = fixture(t), options = applyOptions(f);
  const first = enqueueCreatorSourceResolutionCandidates(f.db, options);
  assert.equal(first.status, 'queued');
  assert.equal(first.inserted, 2);
  assert.equal(first.lastAuthorRow, 3);
  assert.equal(f.db.prepare('SELECT count(*) n FROM author_resolution_queue').get().n, 2);
  const rows = f.db.prepare(`SELECT queue.*,receipt.payload_json,receipt.receipt_sha256
    FROM author_resolution_queue queue JOIN author_resolution_import_sources receipt
      ON receipt.queue_id=queue.id ORDER BY queue.id`).all();
  for (const row of rows) {
    const source = JSON.parse(row.payload_json);
    assert.equal(row.receipt_sha256, createHash('sha256').update(row.payload_json).digest('hex'));
    assert.equal(source.sourceMetadata.sourceSha256, sha);
    assert.equal(source.sourceMetadata.sourceRevision, '1697');
    assert.equal(source.sourceMetadata.identityStatus, 'unverified-candidate');
    assert.equal(source.sourceMetadata.batchKey, first.batchKey);
    assert.equal(source.sourceMetadata.authorRow, JSON.parse(row.source_rows_json)[0]);
    const authorValue = f.db.prepare('SELECT values_json FROM creator_source_rows WHERE sheet_id=? AND row_number=?')
      .get('08', source.sourceMetadata.authorRow).values_json;
    const workValue = f.db.prepare('SELECT values_json FROM creator_source_rows WHERE sheet_id=? AND row_number=?')
      .get('09', source.sourceMetadata.workRow).values_json;
    assert.equal(source.sourceMetadata.authorRowSha256, createHash('sha256').update(authorValue).digest('hex'));
    assert.equal(source.sourceMetadata.workRowSha256, createHash('sha256').update(workValue).digest('hex'));
    assert.match(source.sourceMetadata.frozenSourceDigest, /^[a-f0-9]{64}$/);
    assert.equal(JSON.parse(row.video_ids_json).length, 1);
    assert.equal(JSON.parse(row.share_urls_json).length, 1);
    assert.equal(row.status, 'pending');
  }
  const second = enqueueCreatorSourceResolutionCandidates(f.db, options);
  assert.equal(second.status, 'already-applied');
  assert.equal(second.inserted, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM author_resolution_queue').get().n, 2);
  const originalReceipt = f.db.prepare('SELECT id,receipt_sha256 FROM author_resolution_import_sources ORDER BY id LIMIT 1').get();
  f.db.prepare('UPDATE author_resolution_import_sources SET receipt_sha256=? WHERE id=?')
    .run('0'.repeat(64), originalReceipt.id);
  assert.throws(() => enqueueCreatorSourceResolutionCandidates(f.db, options), /收据不完整/);
  f.db.prepare('UPDATE author_resolution_import_sources SET receipt_sha256=? WHERE id=?')
    .run(originalReceipt.receipt_sha256, originalReceipt.id);
  assert.throws(() => enqueueCreatorSourceResolutionCandidates(f.db,
    { ...options, afterAuthorRow: 3 }), /备份创建后/);
  copyFileSync(f.dbPath, f.backupPath);
  const third = enqueueCreatorSourceResolutionCandidates(f.db, { ...options, afterAuthorRow: 3 });
  assert.equal(third.inserted, 1);
  assert.equal(third.lastAuthorRow, 4);
  assert.equal(f.db.prepare('SELECT count(*) n FROM author_resolution_queue').get().n, 3);
  assert.equal(f.db.prepare('SELECT count(*) n FROM targets').get().n, 0);
});

test('queue-pressure hook is checked under transaction and aborts all writes', t => {
  const f = fixture(t), options = applyOptions(f);
  assert.throws(() => enqueueCreatorSourceResolutionCandidates(f.db, {
    ...options,
    beforeInsert(lockedDb, { selected }) {
      assert.equal(lockedDb.prepare('SELECT COUNT(*) n FROM author_resolution_queue').get().n, 0);
      assert.equal(selected.length, 2);
      throw new Error('queue pressure changed');
    },
  }), /queue pressure changed/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM author_resolution_queue').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM author_resolution_import_sources').get().n, 0);
});

test('stale source SHA, invalid backup and source structure drift fail closed', t => {
  const f = fixture(t), options = applyOptions(f);
  assert.throws(() => enqueueCreatorSourceResolutionCandidates(f.db,
    { ...options, sourceSha: 'b'.repeat(64) }), /冻结来源|备份中的最新来源/);
  assert.throws(() => enqueueCreatorSourceResolutionCandidates(f.db,
    { ...options, backupPath: f.dbPath }), /另一份/);
  const badBackup = join(f.dbPath, '..', 'bad.sqlite');
  writeFileSync(badBackup, 'not sqlite');
  assert.throws(() => enqueueCreatorSourceResolutionCandidates(f.db,
    { ...options, backupPath: badBackup }), /SQLite|database/);
  f.db.prepare('UPDATE creator_source_sheets SET headers_json=? WHERE sheet_id=?')
    .run(JSON.stringify(['作者名', '错列']), '08');
  assert.throws(() => enqueueCreatorSourceResolutionCandidates(f.db, options), /来源的行内容不一致|列结构/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM author_resolution_queue').get().n, 0);
});

test('same-row-count source edits, new snapshots and hard-link backups fail closed', t => {
  const f = fixture(t), options = applyOptions(f);
  const hardLink = join(f.dbPath, '..', 'hardlink.sqlite');
  linkSync(f.dbPath, hardLink);
  assert.throws(() => enqueueCreatorSourceResolutionCandidates(f.db,
    { ...options, backupPath: hardLink }), /硬链接/);
  f.db.prepare('UPDATE creator_source_rows SET values_json=? WHERE sheet_id=? AND row_number=?')
    .run(JSON.stringify(['Mutated but count unchanged', 'creator_0']), '08', 2);
  assert.throws(() => enqueueCreatorSourceResolutionCandidates(f.db, options), /来源的行内容不一致/);
  f.db.prepare('UPDATE creator_source_rows SET values_json=? WHERE sheet_id=? AND row_number=?')
    .run(JSON.stringify(['Author 0', 'creator_0']), '08', 2);
  f.db.prepare('INSERT INTO snapshots VALUES(1)').run();
  assert.throws(() => enqueueCreatorSourceResolutionCandidates(f.db, options), /snapshots 已变化/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM author_resolution_queue').get().n, 0);
});

test('frozen stage row drift and original XLSX hash drift also block enqueue', t => {
  const f = fixture(t), options = applyOptions(f);
  const stage = new DatabaseSync(f.sourceDbPath);
  stage.prepare('UPDATE source_rows SET values_json=? WHERE sheet_id=? AND row_number=?')
    .run(JSON.stringify(['changed stage row', 'creator_0']), '08', 2);
  stage.close();
  assert.throws(() => enqueueCreatorSourceResolutionCandidates(f.db, options), /冻结来源的行内容不一致/);
  writeFileSync(f.originalPath, 'tampered-export-bytes');
  assert.throws(() => enqueueCreatorSourceResolutionCandidates(f.db, options), /原始 XLSX 文件哈希/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM author_resolution_queue').get().n, 0);
});

test('already queued account identity is excluded rather than silently replaced', t => {
  const f = fixture(t);
  f.db.prepare(`INSERT INTO author_resolution_queue(identity_key,name,douyin_id,
    video_ids_json,share_urls_json,boards_json,source_rows_json,file_name,sheet_name,
    source_metadata_json,status,attempts,next_attempt_at,created_at,updated_at,verification_policy_version)
    VALUES(?,?,?,?,?,?,?,?,?,?,'rejected',0,?,?,?,2)`)
    .run('old-evidence', 'Old author', 'creator_0', '[]', '[]', '[]', '[]', '', '', '{}',
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  const result = enqueueCreatorSourceResolutionCandidates(f.db, { ...applyOptions(f), apply: false });
  assert.equal(result.excluded.alreadyInResolutionQueue, 1);
  assert.equal(result.selectedCount, 2);
  assert.equal(f.db.prepare('SELECT count(*) n FROM author_resolution_queue').get().n, 1);
});

test('temporary DB: complete frozen source reaches authorised natural-page lane without anonymous fallback', async t => {
  const f = fixture(t);
  assert.equal(enqueueCreatorSourceResolutionCandidates(f.db, { ...applyOptions(f), limit: 1 }).inserted, 1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM author_resolution_jobs WHERE status='completed'").get().n, 0);
  const owner = 'fixture-authorised-worker';
  f.db.prepare('UPDATE author_resolution_queue SET lease_owner=?,lease_until=?')
    .run(owner, new Date(Date.now() + 60_000).toISOString());
  const stored = f.db.prepare('SELECT * FROM author_resolution_queue').get();
  const due = { ...stored, videoIds: JSON.parse(stored.video_ids_json),
    shareUrls: JSON.parse(stored.share_urls_json), sourceRows: JSON.parse(stored.source_rows_json),
    boards: JSON.parse(stored.boards_json) };
  const cycle = await runAuthorisedQueueCycle({ db: f.db }, [due], {
    owner, retryAt: () => new Date(Date.now() + 3600_000).toISOString(),
    provider: { resolveAuthorisedDetail: async ({ items }) => {
      assert.equal(items.length, 1);
      assert.equal(items[0].videoId, JSON.parse(stored.video_ids_json)[0]);
      assert.equal(items[0].submittedId, stored.douyin_id);
      const now = new Date().toISOString();
      return { status: 'unavailable', key: items[0].key, videoId: items[0].videoId,
        submittedId: items[0].submittedId, requestStartedAt: now, requestFinishedAt: now,
        errorCode: 'session_required' };
    }, resolveAuthors: () => assert.fail('不得回落匿名公开解析器') },
    createInput: () => assert.fail('未核验不得创建目标'),
  });
  assert.equal(cycle.stopped, true);
  assert.equal(cycle.outcomes[0].code, 'session_required');
  assert.deepEqual(cycle.legacy, []);
  assert.match(f.db.prepare('SELECT last_error FROM author_resolution_queue').get().last_error,
    /\[session_required\]/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM targets').get().n, 0,
    '没有已验证的自然作品页响应时绝不入库');
});


test('explicit all enrolls more than fifty authors, is idempotent, and never samples', t => {
  const f=fixture(t,125);
  const options={...applyOptions(f),...parseEnqueueArguments(['--all','--apply','--source-sha',sha,'--confirm-db-backup',f.backupPath]), dbPath:f.dbPath,sourceDbPath:f.sourceDbPath};
  const first=enqueueCreatorSourceResolutionCandidates(f.db,options);
  assert.equal(first.inserted,125);
  assert.equal(enqueueCreatorSourceResolutionCandidates(f.db,options).status,'already-applied');
  assert.equal(f.db.prepare('SELECT count(*) n FROM targets').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM snapshots').get().n,0);
  assert.throws(()=>parseEnqueueArguments(['--all','--limit','50']),/混用/);
});
