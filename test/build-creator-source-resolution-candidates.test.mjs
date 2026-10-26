import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildCreatorSourceResolutionCandidates, parseArguments } from '../scripts/build-creator-source-resolution-candidates.mjs';

const authorHeaders = ['作者名', '主抖音号'];
const workHeaders = ['视频或图文ID', '作者名', '主抖音号', '', '', '', '', '', '', '', '', '作品链接'];

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE creator_source_imports(id INTEGER PRIMARY KEY,source_sha256 TEXT,source_url TEXT,
    source_revision TEXT,source_modified_at TEXT);
    CREATE TABLE creator_source_sheets(import_id INTEGER,sheet_id TEXT,headers_json TEXT);
    CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);
    CREATE TABLE creator_source_account_links(import_id INTEGER,author_row INTEGER,target_id INTEGER);
    CREATE TABLE targets(id INTEGER,type TEXT,metadata_json TEXT);
    CREATE TABLE author_resolution_queue(douyin_id TEXT);`);
  db.prepare('INSERT INTO creator_source_imports VALUES(1,?,?,?,?)').run('a'.repeat(64),
    'https://my.feishu.cn/sheets/source', 'revision-1', '2026-10-22T00:00:00Z');
  for (const [id, headers] of [['08', authorHeaders], ['09', workHeaders]]) {
    db.prepare('INSERT INTO creator_source_sheets VALUES(1,?,?)').run(id, JSON.stringify(headers));
  }
  const addAuthor = (row, name, id) => db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)')
    .run('08', row, JSON.stringify([name, id]));
  const addWork = (row, id, accountId, url) => {
    const values = Array(12).fill('');
    values[0] = id; values[2] = accountId; values[11] = url;
    db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('09', row, JSON.stringify(values));
  };
  addAuthor(2, 'Alice', 'Alice_1');
  addAuthor(3, 'Bob', 'bob_2');
  addAuthor(4, 'Duplicate A', 'dup');
  addAuthor(5, 'Duplicate B', 'DUP');
  addAuthor(6, 'Linked', 'linked');
  addAuthor(7, 'Queued', 'queued');
  addAuthor(8, 'No work', 'no_work');
  addAuthor(9, 'Invalid', '中文昵称');
  addAuthor(10, 'Known target', 'target_id');
  addAuthor(11, 'Unsafe URL', 'unsafe');
  addAuthor(12, 'Share path', 'share_path');
  addWork(2, '7300000000000000001', 'Alice_1', 'https://v.douyin.com/shortABC/');
  addWork(3, '7300000000000000002', 'Alice_1', 'https://www.douyin.com/video/7300000000000000002');
  addWork(4, '7300000000000000003', 'bob_2', 'https://v.douyin.com/shortXYZ/');
  addWork(5, '7300000000000000004', 'dup', 'https://www.douyin.com/video/7300000000000000004');
  addWork(6, '7300000000000000005', 'linked', 'https://www.douyin.com/video/7300000000000000005');
  addWork(7, '7300000000000000006', 'queued', 'https://www.douyin.com/video/7300000000000000006');
  addWork(8, '7300000000000000007', 'target_id', 'https://www.douyin.com/video/7300000000000000007');
  addWork(9, '7300000000000000008', 'unsafe', 'https://www.douyin.com.evil.example/video/7300000000000000008');
  addWork(10, '7300000000000000009', 'unsafe', 'https://www.douyin.com/video/7300000000000000000');
  addWork(11, '7300000000000000010', 'share_path', 'https://www.douyin.com/share/video/7300000000000000010');
  db.prepare('INSERT INTO creator_source_account_links VALUES(1,6,42)').run();
  db.prepare('INSERT INTO author_resolution_queue VALUES(?)').run('queued');
  db.prepare('INSERT INTO targets VALUES(1,?,?)').run('account', JSON.stringify({ platform: 'douyin', douyinId: 'target_id' }));
  return db;
}

test('one candidate per unique author, direct work beats short link, source provenance survives', () => {
  const db = fixture();
  try {
    const before = db.prepare('SELECT total_changes() changes').get().changes;
    const result = buildCreatorSourceResolutionCandidates(db, { previewLimit: 10 });
    assert.equal(db.prepare('SELECT total_changes() changes').get().changes, before);
    assert.equal(result.dryRun, true);
    assert.equal(result.productionDatabaseChanged, false);
    assert.equal(result.authorRows, 11);
    assert.equal(result.candidateCount, 3);
    assert.deepEqual(result.preview.map(row => row.submittedAccountId), ['Alice_1', 'bob_2', 'share_path']);
    assert.equal(result.preview[0].workRow, 3);
    assert.equal(result.preview[0].videoId, '7300000000000000002');
    assert.equal(result.preview[1].evidenceType, 'short-work-url-pending-redirect-verification');
    assert.equal(result.preview[2].shareUrl, 'https://www.douyin.com/video/7300000000000000010');
    assert.equal(result.preview[2].source.sha256, 'a'.repeat(64));
    assert.equal(result.preview[0].identityStatus, 'unverified-candidate');
    assert.match(result.preview[0].key, /^douyin:alice_1\|video:/);
    assert.deepEqual(result.excluded, { invalidAccountId: 1, duplicateAccountId: 2, alreadyStrictLinked: 1,
      alreadyKnownTargetId: 1, alreadyInResolutionQueue: 1, noEligibleWork: 2 });
    assert.deepEqual(result.evidenceTypes, { directWorkUrl: 2, shortWorkUrl: 1 });
  } finally { db.close(); }
});

test('repeated planning is byte-stable, bounded and does not change database contents', () => {
  const db = fixture();
  try {
    const before = db.prepare('SELECT total_changes() changes').get().changes;
    const first = buildCreatorSourceResolutionCandidates(db, { previewLimit: 2 });
    const second = buildCreatorSourceResolutionCandidates(db, { previewLimit: 2 });
    assert.deepEqual(second, first);
    assert.equal(first.preview.length, 2);
    assert.equal(first.candidateCount, 3);
    assert.equal(db.prepare('SELECT total_changes() changes').get().changes, before);
    assert.throws(() => buildCreatorSourceResolutionCandidates(db, { previewLimit: 101 }), /0–100/);
  } finally { db.close(); }
});

test('source schema drift fails closed rather than assigning the wrong work to an author', () => {
  const db = fixture();
  try {
    db.prepare('UPDATE creator_source_sheets SET headers_json=? WHERE sheet_id=?')
      .run(JSON.stringify(['作者名', '不再是抖音号']), '08');
    assert.throws(() => buildCreatorSourceResolutionCandidates(db), /列结构/);
  } finally { db.close(); }
});

test('CLI accepts only read-only database path and a bounded preview count', () => {
  assert.equal(parseArguments(['--limit', '0']).previewLimit, 0);
  assert.throws(() => parseArguments(['--execute']), /用法/);
  assert.throws(() => parseArguments(['--limit', '-1']), /用法/);
});

test('recovery uses a different saved work only for fully rejected identities without rewriting their evidence',()=>{
 const db=fixture();
 try {
  db.exec("ALTER TABLE author_resolution_queue ADD COLUMN status TEXT DEFAULT 'rejected'; ALTER TABLE author_resolution_queue ADD COLUMN identity_key TEXT DEFAULT 'old-proof'");
  const recovery=buildCreatorSourceResolutionCandidates(db,{recoverFailed:true,all:true});
  assert.deepEqual(recovery.preview.map(x=>x.submittedAccountId),['queued']);
  assert.equal(db.prepare('SELECT status FROM author_resolution_queue').get().status,'rejected');
  db.prepare('UPDATE author_resolution_queue SET identity_key=?').run(recovery.preview[0].key);
  assert.equal(buildCreatorSourceResolutionCandidates(db,{recoverFailed:true}).candidateCount,0);
  db.exec("UPDATE author_resolution_queue SET status='pending',identity_key='different'");
  assert.equal(buildCreatorSourceResolutionCandidates(db,{recoverFailed:true}).candidateCount,0);
 } finally {db.close();}
});
