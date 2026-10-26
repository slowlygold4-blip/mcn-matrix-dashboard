import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildMasterRosterSnapshot, installMasterRoster } from '../lib/master-roster.mjs';
import { prepareMasterRosterSupplement, assertMasterRosterSupplementJob } from '../lib/master-roster-supplement.mjs';
import { prepareImportAuthorisedDetail } from '../lib/import-authorised-detail.mjs';
import { parseAuthorSpreadsheet } from '../lib/author-spreadsheet.mjs';

const WORK = 'https://www.douyin.com/video/7690702905876096104';
const HASH = 'a'.repeat(64);
const gaps = [
  [85, '没有后悔药', 'https://v.douyin.com/xglrKXGaNFU/'],
  [294, '一条小猪团ovo', 'https://v.douyin.com/w7PkEBeO9vM/'],
  [336, '一条小团团OwO', 'https://v.douyin.com/Rjjoiqlikvc/'],
  [1532, '?!', 'https://v.douyin.com/AD5WOZ9en1Q/'],
  [1724, '奶团速报', 'https://v.douyin.com/rQ6Rs4dmNKE'],
  [2045, '圆小欧OvO', 'https://v.douyin.com/SH1mNTOg4oE/'],
];

function fixture(t, id, sourceRow) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,provider TEXT,metadata_json TEXT,locator TEXT,label TEXT,enabled INTEGER);
    CREATE TABLE author_resolution_jobs(id TEXT PRIMARY KEY,status TEXT,request_json TEXT,result_json TEXT,created_at TEXT,finished_at TEXT,error TEXT);`);
  const snapshot = buildMasterRosterSnapshot({ exportedAt: '2026-10-02T19:01:23.853Z', entities: [{
    key: `submitted:douyin:source-gap-${sourceRow}`, targetId: null, platform: 'douyin', names: ['原始填写名称'], ids: [id], locators: [],
    sources: [{ title: '离线来源夹具', file: 'fixture.xlsx', rows: [String(sourceRow)] }], boards: [{ name: '一条小团团切片矩阵' }],
  }] }, { sha256: HASH, fileName: 'fixture.xlsx' });
  installMasterRoster(db, snapshot);
  return { db, input: evidence => ({ workbookSha256: HASH, entryKey: snapshot.items[0].key, evidence }) };
}
const job = rows => ({ id: 'offline-source-gap', status: 'completed', request: { rows } });

// The observed gap was preview=true followed by unavoidable strict rejection.
// After the fix, unchanged malformed IDs cannot be queued through preview.
for (const [sourceRow, id, evidence] of gaps) {
  test(`source gap ${sourceRow}: invalid original ID needs explicit correction before submission`, async t => {
    const f = fixture(t, id, sourceRow), before = f.db.prepare('SELECT * FROM master_roster_entries').all();
    const p = await prepareMasterRosterSupplement(f.db, f.input(evidence));
    assert.equal(p.preview.review.canSubmit, false);
    assert.match(p.preview.review.reason, /更正抖音号/);
    assert.equal(p.rows[0].douyinId, '');
    assert.equal(p.rows[0].submittedIdRaw.normalize('NFKC'), id.normalize('NFKC'));
    assert.match(p.rows[0].submittedIdIssue, /格式异常.*不计为独立账号/);
    assert.throws(() => prepareImportAuthorisedDetail(job(p.rows), { sourceRow: p.rows[0].sourceRow }), /账号 ID 格式无效/);
    assert.deepEqual(f.db.prepare('SELECT * FROM master_roster_entries').all(), before);
    assert.equal(f.db.prepare('SELECT count(*) n FROM targets').get().n, 0);
  });
}

test('source gap: adding a correctedId property does not silently replace the original submitted identity', async t => {
  const f = fixture(t, '没有后悔药', 85);
  const p = await prepareMasterRosterSupplement(f.db, { ...f.input(WORK), correctedId: '51058454595' });
  assert.equal(p.rows[0].douyinId, '');
  assert.equal(p.rows[0].submittedIdRaw, '没有后悔药');
  assert.throws(() => prepareImportAuthorisedDetail(job(p.rows), { sourceRow: p.rows[0].sourceRow }), /账号 ID 格式无效/);
});

test('source gap: explicit correction prepares only one fresh work request and binds its preview hash', async t => {
  const f = fixture(t, '没有后悔药', 85), before = f.db.prepare('SELECT * FROM master_roster_entries').all();
  const p = await prepareMasterRosterSupplement(f.db, { ...f.input(WORK), correctedAccountId: ' @Correct_123 ' });
  assert.equal(p.masterRosterSupplement.version, 2);
  assert.equal(p.preview.requiresCorrectionConfirmation, true);
  assert.deepEqual(p.preview.correction, { originalAccountId: '没有后悔药', correctedAccountId: 'correct_123' });
  assert.equal(p.rows[0].douyinId, 'correct_123');
  assert.equal(prepareImportAuthorisedDetail(job(p.rows), { sourceRow: 2 }).submittedId, 'correct_123');
  const changed = await prepareMasterRosterSupplement(f.db, { ...f.input(WORK), correctedAccountId: 'different_123' });
  assert.notEqual(p.preview.previewSha256, changed.preview.previewSha256);
  assert.deepEqual(f.db.prepare('SELECT * FROM master_roster_entries').all(), before);
});

test('source gap: correction cannot use a profile, bare ID, unsafe authority or contradictory work URL', async t => {
  const f = fixture(t, '没有后悔药', 85);
  for (const evidence of ['correct_123', '7690702905876096104',
    'https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrstuvwx',
    'https://www.douyin.com:443/video/7690702905876096104',
    'https://www.douyin.com.evil.test/video/7690702905876096104',
    `${WORK}?aweme_id=7690702905876096105`]) {
    await assert.rejects(prepareMasterRosterSupplement(f.db, { ...f.input(evidence), correctedAccountId: 'correct_123' }));
  }
});

test('source gap: a correction cannot reuse a terminal or suspended evidence queue at preview or worker recheck', async t => {
  for (const [status, suspended] of [['resolved', null], ['rejected', null], ['retry', 0], ['pending', 1]]) {
    const f = fixture(t, '原填错昵称', 85);
    const p = await prepareMasterRosterSupplement(f.db, { ...f.input(WORK), correctedAccountId: 'correct_123' });
    const request = { rows: p.rows, fileName: p.fileName, sheetName: p.sheetName, masterRosterSupplement: p.masterRosterSupplement };
    const input = prepareImportAuthorisedDetail(job(p.rows), { sourceRow: 2 });
    f.db.exec('CREATE TABLE author_resolution_queue(identity_key TEXT,status TEXT,suspended_target_enabled INTEGER)');
    f.db.prepare('INSERT INTO author_resolution_queue VALUES(?,?,?)').run(input.key, status, suspended);
    await assert.rejects(prepareMasterRosterSupplement(f.db, { ...f.input(WORK), correctedAccountId: 'correct_123' }), /另一条尚未核验/);
    assert.throws(() => assertMasterRosterSupplementJob(f.db, { id: 'test-correction', request }), /另一条尚未核验/);
  }
});

test('source gap: an immutable old success cannot be reused even if its queue was reset externally', async t => {
  const f = fixture(t, '原填错昵称', 85);
  const p = await prepareMasterRosterSupplement(f.db, { ...f.input(WORK), correctedAccountId: 'correct_123' });
  const input = prepareImportAuthorisedDetail(job(p.rows), { sourceRow: 2 });
  f.db.exec('CREATE TABLE author_resolution_success_receipts(identity_key TEXT)');
  f.db.prepare('INSERT INTO author_resolution_success_receipts VALUES(?)').run(input.key);
  await assert.rejects(prepareMasterRosterSupplement(f.db, { ...f.input(WORK), correctedAccountId: 'correct_123' }), /历史身份凭据/);
});

for (const id of ['dy1hkeknsjon.', '21272043099']) {
  test(`source gap ${id}: a newly supplied work can prepare, without claiming any live identity proof`, async t => {
    const f = fixture(t, id, 314);
    const p = await prepareMasterRosterSupplement(f.db, f.input(WORK));
    assert.equal(p.preview.review.canSubmit, true);
    const input = prepareImportAuthorisedDetail(job(p.rows), { sourceRow: p.rows[0].sourceRow });
    assert.equal(input.submittedId, id);
    assert.equal(input.videoId, '7690702905876096104');
    assert.equal(f.db.prepare('SELECT count(*) n FROM targets').get().n, 0);
  });
}

test('source gap: prose and a Jimeng story URL cannot become Douyin work evidence', async () => {
  for (const [id, text] of [
    ['dy1hkeknsjon.', '变速箱，掌管车辆的进退变速。 @一条小团团OvO #小团团即梦二创大赛'],
    ['21272043099', '快来看 鸿雁 创作的故事《月宫小团奇遇》！ https://jimeng.jianying.com/s/srIIoyHtTus/?t=8011 AC1141'],
  ]) {
    const csv = `作者,抖音号,作品链接\n测试作者,${id},"${text}"\n`;
    const parsed = await parseAuthorSpreadsheet({ fileName: 'fixture.csv', buffer: Buffer.from(csv) });
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].videoId || '', '');
    assert.equal(parsed.rows[0].shareUrl || '', '');
    assert.throws(() => prepareImportAuthorisedDetail(job(parsed.rows), { sourceRow: parsed.rows[0].sourceRow }));
  }
});
