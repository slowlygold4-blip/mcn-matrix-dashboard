import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildMasterRosterSnapshot, installMasterRoster, readMasterRoster } from '../lib/master-roster.mjs';
import { validateMasterRoster, filterMasterRoster } from '../public/master-roster.js';

function setup(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE targets(id INTEGER PRIMARY KEY, type TEXT, metadata_json TEXT, locator TEXT, label TEXT, enabled INTEGER);
    CREATE TABLE author_resolution_jobs(id TEXT PRIMARY KEY,file_name TEXT,sheet_name TEXT,status TEXT,created_at TEXT,finished_at TEXT,request_json TEXT,result_json TEXT);
    INSERT INTO targets VALUES(1,'account','{"platform":"douyin"}','MS4wLjABAAAAabcdefghijklmnop','已监控原名',0);`);
  installMasterRoster(db, buildMasterRosterSnapshot({ exportedAt: '2026-10-02T19:00:00Z', entities: [
    { key: 'target:1', targetId: 1, platform: 'douyin', currentName: '已监控原名', names: ['已监控原名'], ids: ['123'], locators: ['MS4wLjABAAAAabcdefghijklmnop'], enabled: false },
    { key: 'submitted:tomato', platform: 'douyin', names: ['一个西红柿OVO'], ids: ['77344146652'], sources: [] },
  ] }, { fileName: 'frozen.xlsx', sha256: 'a'.repeat(64) }));
  return db;
}
function job(db, id, rows, options = {}) {
  const { created = '2026-10-08T17:00:00Z', url = 'https://example.feishu.cn/wiki/source', type = 'lark-bitable', status = 'completed' } = options;
  db.prepare('INSERT INTO author_resolution_jobs(id,file_name,sheet_name,status,created_at,finished_at,request_json) VALUES(?,?,?,?,?,?,?)').run(id, 'source.json', '数据表', status, created, created, JSON.stringify({
    sourceType: type, sourceUrl: url, sourceSheetId: 'table1', sourceReadAt: created, sourceTitle: '团团授权名单', sheetName: '数据表',
    ...(options.uploadSha256 ? { uploadSha256: options.uploadSha256, fileName: options.fileName || '上传.xlsx' } : {}),
    sourceRevision: 1, defaultBoard: '一条小团团切片矩阵', rows,
  }));
}
test('latest source aliases appear in search without changing the frozen workbook or monitor state', t => {
  const db = setup(t);
  job(db, 'latest', [
    { sourceRow: 1, platform: 'douyin', name: '一条西红柿OVO', douyinId: '77344146652' },
    { sourceRow: 2, platform: 'douyin', name: '新作者', douyinId: '00456' },
    { sourceRow: 3, platform: 'douyin', name: '新作者别名', douyinId: '00456' },
    { sourceRow: 4, platform: 'douyin', name: '已监控新别名', douyinId: '123' },
  ]);
  const before = db.prepare('SELECT total_changes() n').get().n;
  const original = db.prepare('SELECT * FROM master_roster_entries ORDER BY entry_key').all();
  const result = readMasterRoster(db); validateMasterRoster(result);
  assert.deepEqual(result.summary, { total: 3, registered: 1, enabled: 0, paused: 1, pending: 2 });
  assert.equal(filterMasterRoster(result.items, { query: '一条西红柿OVO' }).length, 1);
  assert.equal(result.items[0].name, '已监控原名'); assert.equal(result.items[0].monitorStatus, 'paused');
  const added = result.items.find(item => item.liveSource);
  assert.equal(added.readOnly, true); assert.equal(added.targetId, null); assert.equal(added.monitorStatus, 'pending');
  assert.match(added.key, /^live-source:douyin:[a-f0-9]{64}$/); assert.equal(added.theme.key, 'tuantuan');
  assert.deepEqual(added.originalNames, ['新作者', '新作者别名']); assert.deepEqual(added.sources[0].rows, ['2', '3']);
  assert.equal(result.liveSources.sourceRowCount, 4); assert.equal(result.liveSources.addedEntryCount, 1);
  assert.equal(result.liveSources.aliasedEntryCount, 2);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
  assert.deepEqual(db.prepare('SELECT * FROM master_roster_entries ORDER BY entry_key').all(), original);
});
test('completed local XLSX tasks retain hash and every submitted row without pretending to be cloud sources', t => {
  const db = setup(t), digest = 'd'.repeat(64);
  job(db, '11111111-1111-4111-8111-111111111111', [{ sourceRow: 1, name: '本地新增', douyinId: '999' },
    { sourceRow: 2, name: '本地别名', douyinId: '999' }], { type: 'author-spreadsheet', url: '', uploadSha256: digest });
  job(db, '22222222-2222-4222-8222-222222222222', [{ sourceRow: 1, name: '无hash不得自动恢复', douyinId: 'bad' }], { type: 'author-spreadsheet', url: '' });
  const result = readMasterRoster(db); validateMasterRoster(result);
  assert.equal(result.liveSources.sourceJobCount, 1); assert.equal(result.liveSources.sourceRowCount, 2);
  const item = result.items.find(item => item.liveSource);
  assert.deepEqual(item.originalNames, ['本地新增', '本地别名']); assert.deepEqual(item.sourceLinks, []);
  assert.equal(item.sources[0].fileName, '上传.xlsx'); assert.equal(item.sources[0].uploadSha256, digest);
  assert.equal(item.sources[0].sourceType, 'author-spreadsheet'); assert.deepEqual(item.sources[0].rows, ['1', '2']);
});
test('local canonical-only successful target receipt follows current pause state without promoting unrelated submitted IDs', t => {
  const db = setup(t), locator = 'MS4wLjABAAAAsecondauthorprofile';
  db.prepare('INSERT INTO targets VALUES(?,?,?,?,?,?)').run(2, 'account', '{"platform":"douyin","douyinId":"999"}', locator, '当前名称', 0);
  const id = '33333333-3333-4333-8333-333333333333';
  job(db, id, [{ sourceRow: 1, platform: 'douyin', name: '原提交名', locator, status: 'ready' },
    { sourceRow: 2, platform: 'douyin', name: '当前名称', douyinId: '999', status: 'resolvable' }], { type: 'author-spreadsheet', url: '', uploadSha256: 'e'.repeat(64) });
  db.prepare('UPDATE author_resolution_jobs SET result_json=? WHERE id=?').run(JSON.stringify({ ok: true, created: [{ id: 2, locator, metadata: { platform: 'douyin' } }] }), id);
  const before = db.prepare('SELECT total_changes() n').get().n;
  const result = readMasterRoster(db); validateMasterRoster(result);
  const live = result.items.filter(item => item.liveSource);
  const bound = live.find(item => item.targetId === 2), pending = live.find(item => item.accountIds.includes('999'));
  assert.equal(bound.monitorStatus, 'paused'); assert.equal(bound.name, '当前名称');
  assert.deepEqual(bound.liveSourceBinding, { kind: 'completed-job-canonical-target', targetId: 2, jobId: id });
  assert.equal(pending.targetId, null); assert.equal(pending.monitorStatus, 'pending');
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
});
test('latest replay of the same local file and sheet does not duplicate source rows; failed or unverified formats are excluded', t => {
  const db = setup(t), upload = { type: 'author-spreadsheet', url: '', uploadSha256: 'f'.repeat(64) };
  job(db, 'old', [{ name: '旧任务', douyinId: '777' }], { ...upload, created: '2026-10-07T00:00:00Z' });
  job(db, 'latest', [{ name: '同一原文件回执', douyinId: '777' }], upload);
  job(db, 'failed', [{ name: '失败', douyinId: '778' }], { ...upload, status: 'failed', created: '2026-10-09T00:00:00Z' });
  job(db, 'not-sheet', [{ name: '非表格', douyinId: '779' }], { ...upload, fileName: '数据.exe' });
  const result = readMasterRoster(db);
  assert.equal(result.liveSources.sourceJobCount, 1); assert.equal(result.liveSources.sourceRowCount, 1);
  assert.equal(result.items.find(item => item.liveSource).name, '同一原文件回执');
});
test('source projection uses latest completed source only, never unrelated upload, old history or failed work', t => {
  const db = setup(t);
  job(db, 'old', [{ name: '删除的旧行', douyinId: 'old' }], { created: '2026-10-03T00:00:00Z' });
  job(db, 'new', [{ name: '当前行', douyinId: 'current' }]);
  job(db, 'before-snapshot', [{ name: '旧历史', douyinId: 'history' }], { created: '2026-10-01T00:00:00Z', url: 'https://example.feishu.cn/wiki/history' });
  job(db, 'upload', [{ name: '普通上传', douyinId: 'upload' }], { type: 'author-spreadsheet' });
  job(db, 'failed', [{ name: '未完成', douyinId: 'failed' }], { status: 'failed', created: '2026-10-09T00:00:00Z' });
  job(db, 'foreign-url', [{ name: '其他站点', douyinId: 'foreign' }], { url: 'https://example.com/list' });
  const result = readMasterRoster(db);
  assert.equal(result.liveSources.sourceJobCount, 1); assert.equal(result.liveSources.addedEntryCount, 1);
  assert.deepEqual(result.items.filter(item => item.liveSource).map(item => item.name), ['当前行']);
});
test('same nickname never binds different IDs; missing IDs remain separate source records; blank rows are counted not authors', t => {
  const db = setup(t);
  job(db, 'new', [{ sourceRow: 1, name: '一个西红柿OVO', douyinId: 'another' },
    { sourceRow: 2, name: '一个西红柿OVO' }, { sourceRow: 3, name: '一个西红柿OVO' },
    { sourceRow: 4, name: '', douyinId: '' }]);
  const result = readMasterRoster(db);
  assert.equal(result.liveSources.addedEntryCount, 3); assert.equal(result.liveSources.noIdentityRowCount, 1);
  assert.equal(new Set(result.items.map(item => item.key)).size, result.items.length);
  assert.ok(result.items.filter(item => item.liveSource).every(item => item.targetId === null));
});
test('duplicate frozen IDs keep separate anchors and flag conflicts instead of silently merging', t => {
  const db = setup(t);
  // Same ID in two frozen source records is deliberately not authoritative ownership.
  const snap = buildMasterRosterSnapshot({ exportedAt: '2026-10-02T19:00:00Z', entities: [
    { key: 'submitted:a', platform: 'douyin', names: ['甲'], ids: ['789'] },
    { key: 'submitted:b', platform: 'douyin', names: ['乙'], ids: ['789'] },
  ] }, { fileName: 'second.xlsx', sha256: 'b'.repeat(64) });
  installMasterRoster(db, snap); job(db, 'new', [{ name: '共同别名', douyinId: '789' }]);
  const result = readMasterRoster(db);
  assert.equal(result.items.length, 2); assert.equal(result.liveSources.addedEntryCount, 0);
  assert.ok(result.items.every(item => item.targetId === null && item.reviewReasons.some(reason => reason.includes('多条原始资料'))));
});
test('row insertion or sorting never uses a physical row number to bind an unidentified author', t => {
  const db = setup(t);
  const snap = buildMasterRosterSnapshot({ exportedAt: '2026-10-02T19:00:00Z', entities: [
    { key: 'submitted:row2', platform: 'douyin', names: ['旧作者'], ids: [],
      sources: [{ url: 'https://example.feishu.cn/wiki/source', sheet: '数据表', rows: ['2'] }] },
  ] }, { fileName: 'rows.xlsx', sha256: 'c'.repeat(64) });
  installMasterRoster(db, snap);
  job(db, 'new', [{ sourceRow: 2, name: '插入的新作者' }]);
  const result = readMasterRoster(db);
  assert.equal(result.liveSources.addedEntryCount, 1);
  assert.deepEqual(result.items[0].originalNames, ['旧作者']);
  assert.equal(result.items[1].name, '插入的新作者');
});
