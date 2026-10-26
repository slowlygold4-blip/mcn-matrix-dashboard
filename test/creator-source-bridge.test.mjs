import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readCreatorSourceBridge, extendMasterRosterWithCreatorSource } from '../lib/creator-source-bridge.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE creator_source_imports(id INTEGER PRIMARY KEY,source_sha256 TEXT,source_url TEXT,
    source_revision TEXT,source_modified_at TEXT,imported_at TEXT,metadata_json TEXT,source_row_count INTEGER);
    CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);
    CREATE TABLE creator_source_account_links(import_id INTEGER,author_row INTEGER,target_id INTEGER,matched_id TEXT,matched_at TEXT);
    CREATE TABLE creator_source_work_links(import_id INTEGER,work_row INTEGER,target_id INTEGER);
    CREATE TABLE posts(target_id INTEGER,external_id TEXT,author_id TEXT,raw_json TEXT);
    CREATE TABLE targets(id INTEGER,label TEXT,enabled INTEGER,type TEXT,provider TEXT,locator TEXT,metadata_json TEXT);
    INSERT INTO creator_source_imports VALUES(1,'abc','https://my.feishu.cn/sheets/example','1',
      '2026-10-22T00:00:00Z','2026-10-22T01:00:00Z','{"audit":{"knownCumulativePlays":150}}',4);
    INSERT INTO targets VALUES(10,'已监控作者',1,'account','public-web','MS4wLjABAAAACreatorSourceFixture0001',
      '{"platform":"douyin","douyinId":"handle_a","identityVerification":{"accountId":"MS4wLjABAAAACreatorSourceFixture0001"}}');
    INSERT INTO posts VALUES(10,'111','MS4wLjABAAAACreatorSourceFixture0001',
      '{"aweme_id":"111","author":{"sec_uid":"MS4wLjABAAAACreatorSourceFixture0001"}}');
    INSERT INTO creator_source_account_links VALUES(1,2,10,'handle_a','2026-10-22T01:00:00Z');
    INSERT INTO creator_source_work_links VALUES(1,4,10);`);
  const add = db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)');
  add.run('08', 2, JSON.stringify(['作者 A', 'handle_a', '', '', 0, 0, 1, 1, 0, 0, 0]));
  add.run('08', 3, JSON.stringify(['作者 B', 'handle_b', '', '', 0, 0, 1, 0, 0, 1, 0]));
  add.run('09', 4, JSON.stringify(['111', '作者 A', 'handle_a', '2026-10-20', 'video', '切片激励', '', 100, 5]));
  add.run('09', 5, JSON.stringify(['222', '作者 B', 'handle_b', '2026-10-21', 'video', '即梦二创', '', null, 7]));
  return db;
}

test('来源作品按 ID 与严格账号交集核对，来源累计播放不进入监控指标', () => {
  const db = fixture();
  try {
    const result = readCreatorSourceBridge(db);
    assert.equal(result.authors, 2);
    assert.equal(result.works, 2);
    assert.equal(result.exactWorkIdOverlap, 1);
    assert.equal(result.identityAndWorkOverlap, 1);
    assert.equal(result.sourceOnlyWorkIds, 1);
    assert.equal(result.knownCumulativePlays, 150);
    assert.deepEqual(result.daily.map(day => day.works), [1, 1]);
    assert.deepEqual(result.daily.map(day => day.cumulativePlays), [null, 100]);
    assert.deepEqual(result.daily.map(day => day.cumulativeLikes), [7, 5]);
    assert.deepEqual(result.daily.map(day => day.playsKnown), [0, 1]);
    assert.match(result.semantics.sourceDates, /不是当日播放采样/);
  } finally { db.close(); }
});

test('作品 ID 重合但原始作者或作品身份不符，不计入身份和作品严格重合', () => {
  const db = fixture();
  try {
    for (const raw of ['invalid-json', JSON.stringify({aweme_id:'other',author:{sec_uid:'MS4wLjABAAAACreatorSourceFixture0001'}}),
      JSON.stringify({aweme_id:'111',author:{sec_uid:'MS4wLjABAAAAOtherAccountFixture0002'}})]) {
      db.prepare('UPDATE posts SET raw_json=?').run(raw);
      const result = readCreatorSourceBridge(db);
      assert.equal(result.exactWorkIdOverlap, 1);
      assert.equal(result.identityAndWorkOverlap, 0);
    }
    db.prepare('UPDATE posts SET author_id=?').run('MS4wLjABAAAAOtherAccountFixture0002');
    assert.equal(readCreatorSourceBridge(db).identityAndWorkOverlap, 0);
  } finally { db.close(); }
});

test('新增授权记录作为独立来源证据展示，不增加去重作者数', () => {
  const db = fixture();
  try {
    db.exec(`CREATE TABLE creator_source_registry_additions(
      author_name TEXT,account_id TEXT,classification_json TEXT,source_url TEXT,
      source_modified_at TEXT,observed_at TEXT,record_id TEXT);
      INSERT INTO creator_source_registry_additions VALUES
      ('作者 A','handle_a','["切片"]','https://feishu.cn/wiki/example',
       '2026-10-22T02:00:00Z','2026-10-22T03:00:00Z','rec_1');`);
    const result = readCreatorSourceBridge(db);
    assert.equal(result.authors, 2);
    assert.equal(result.registryAdditions, 1);
    assert.deepEqual(result.registryAdditionRows[0].classifications, ['切片']);
  } finally { db.close(); }
});

test('排名公示遗漏与账号文本差异作为独立证据展示，不污染实时指标', () => {
  const db = fixture();
  try {
    db.exec(`CREATE TABLE creator_source_external_deltas(
      source_url TEXT,source_revision TEXT,kind TEXT,origin_key TEXT,
      observed_at TEXT,payload_json TEXT);
      INSERT INTO creator_source_external_deltas VALUES
      ('https://feishu.cn/wiki/award','105','award_missing_from_import','292f5f:150',
       '2026-10-22T01:00:00Z','{"author_name":"作者 A","likes_in_announcement":132,"announced_amount_yuan":50}'),
      ('https://feishu.cn/wiki/registry','2904','registry_account_text_difference','rec_a',
       '2026-10-22T01:00:00Z','{"previous_account_id":"","current_source_account_id":"handle_a"}');`);
    const result = readCreatorSourceBridge(db);
    assert.equal(result.awardDeltaRows.length, 1);
    assert.equal(result.awardDeltaRows[0].payload.likes_in_announcement, 132);
    assert.equal(result.registryCorrectionRows.length, 1);
    assert.equal(result.works, 2);
    assert.equal(result.knownCumulativePlays, 150);
  } finally { db.close(); }
});

test('作者来源并入现有名册，严格链接只丰富来源，未链接作者不进入经营统计', () => {
  const db = fixture();
  try {
    const existing = { key: 'target:10', targetId: 10, name: '已监控作者', platform: 'douyin',
      originalNames: [], accountIds: [], theme: { key: 'tuantuan', label: '团团' }, classifications: [],
      monitorStatus: 'enabled', identityStatus: '既有已定位账号', profileLinks: [], sourceLinks: [],
      sourceTitles: [], sources: [], reviewReasons: [] };
    const result = extendMasterRosterWithCreatorSource(db, [existing]);
    assert.equal(result.summary.added, 1);
    assert.equal(result.summary.enriched, 1);
    assert.equal(result.items[0].monitorStatus, 'enabled');
    assert.deepEqual(result.items[0].accountIds, []);
    assert.deepEqual(result.items[0].creatorSourceAccountIds, ['handle_a']);
    assert.equal(result.items[1].monitorStatus, 'pending');
    assert.equal(result.items[1].targetId, null);
    assert.equal(result.items[1].readOnly, true);
    assert.equal(result.items[1].theme.key, 'tuantuan');
    assert.deepEqual(result.items[1].classifications.map(x => x.key), ['ai-remix']);
  } finally { db.close(); }
});

test('同一团团来源账号 ID 仅合并来源证据，不自动核验或启用监控', () => {
  const db = fixture();
  try {
    const pending = { key: 'submitted:b', targetId: null, platform: 'douyin', name: '旧登记名',
      originalNames: [], accountIds: ['handle_b'], theme: { key: 'tuantuan', label: '团团' }, classifications: [],
      monitorStatus: 'pending', identityStatus: '尚未定位', profileLinks: [], sourceLinks: [],
      sourceTitles: [], sources: [], reviewReasons: [] };
    const result = extendMasterRosterWithCreatorSource(db, [pending]);
    assert.equal(result.summary.pendingIdMerged, 1);
    assert.equal(result.items.filter(x => x.accountIds.includes('handle_b')).length, 1);
    assert.equal(result.items[0].name, '旧登记名');
    assert.equal(result.items[0].targetId, null);
    assert.equal(result.items[0].monitorStatus, 'pending');
    assert.deepEqual(result.items[0].creatorSourceRows, [3]);
  } finally { db.close(); }
});
