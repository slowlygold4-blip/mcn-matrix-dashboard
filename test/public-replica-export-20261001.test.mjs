import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { exportPublicReplica, serializePublicReplica, writePublicReplica, readPublicAccountRoster } from '../lib/public-replica-export.mjs';
import { preparePublicReplicaPublication } from '../lib/public-replica-sync.mjs';
import { buildMasterRosterSnapshot, installMasterRoster } from '../lib/master-roster.mjs';

const SEC = 'MS4wLjABAAAAPublicReplicaSynthetic20261001';
const OTHER = 'MS4wLjABAAAAPublicReplicaOtherSynthetic20261001';
const SECRET = 'PRIVATE_SYNTHETIC_VALUE_MUST_NOT_ESCAPE';
const AS_OF = '2026-09-20T12:00:00.000Z';
const at = day => `2026-09-${String(day).padStart(2, '0')}T02:00:00.000Z`;
const external = index => String(7200000000000000000n + BigInt(index));

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(AS_OF) + 1 });
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const target = database.createTarget({ type: 'account', label: '公开合法昵称', locator: SEC, provider: 'public-web',
    metadata: { platform: 'douyin', cookie: SECRET, password: SECRET,
      importSource: { sourceName: '团团来源', sheetUrl: `https://private.feishu.cn/sheets/${SECRET}`, privateFile: SECRET } } });
  database.assignTargetsToBoard([target.id], '一条小团团切片矩阵');
  database.db.prepare('UPDATE target_boards SET category=?,source_file_name=? WHERE target_id=?')
    .run('原创', SECRET, target.id);
  const sample = (day, { followers = 10, likes = 100, posts = 1, works = [], author = SEC } = {}) => {
    const raw = { capturedAt: at(day), profile: { user: { sec_uid: SEC, uid: '123456789',
      follower_count: followers, total_favorited: likes, aweme_count: posts } },
    cookie: SECRET, settings: { secret: SECRET }, works: { aweme_list: works.map(item => ({
      aweme_id: external(item.index), author: { sec_uid: author, uid: '123456789' },
      desc: item.caption ?? `公开标题${item.index}`, create_time: Date.parse(item.publishedAt??at(1)) / 1000,
      share_url: item.url ?? `https://www.douyin.com/video/${external(item.index)}`,
      statistics: { digg_count: item.likes ?? 0, comment_count: null, share_count: 0, play_count: null },
    })) } };
    database.saveCollection(target, null, normalizeCollection(target, raw, { capturedAt: raw.capturedAt }));
  };
  const topic = database.createTarget({ type: 'hashtag', label: '#一条小团团OvO', locator: '一条小团团OvO', provider: 'public-web' });
  const topicSample = (day, participants, views, { rejected = false, tamper = false, foreign = false, challengeId = '123456789012345' } = {}) => {
    const raw = { capturedAt: at(day), participant_count: participants, view_count: views, participants, views,
      hashtag: foreign ? 'different-topic' : topic.locator, officialName: foreign ? 'different-topic' : topic.locator,
      challengeId, scope: 'douyin-official-challenge-detail', cookie: SECRET,
      provenance: { mode: 'douyin-official-anonymous-challenge-detail', runtimeAI: false, paidAPI: false } };
    const collection = normalizeCollection(topic, raw, { capturedAt: at(day) });
    if (rejected) collection.qualityStatus = 'rejected';
    t.mock.timers.setTime(Date.parse(at(day)) - 1000);
    const runId = database.beginRun('scheduled', topic.id, 1);
    t.mock.timers.setTime(Date.parse(at(day)));
    database.saveCollection(topic, runId, collection);
    t.mock.timers.setTime(Date.parse(at(day)) + 1000);
    database.finishRun(runId, { status: 'success', successCount: 1 });
    t.mock.timers.setTime(Date.parse(AS_OF) + 1);
    if (tamper) database.db.prepare('UPDATE snapshots SET hashtag_views=? WHERE target_id=? AND captured_at=?').run(999999, topic.id, at(day));
  };
  const read = () => exportPublicReplica(database, { asOf: AS_OF });
  return { database, target, sample, topic, topicSample, read };
}

test('public replica carries only verified per-work publisher overrides and preserves original author links',async t=>{
 const {database,target,sample,read}=fixture(t),db=database.db;
 db.prepare('UPDATE targets SET metadata_json=? WHERE id=?').run(JSON.stringify({platform:'douyin',douyinId:'handle_b',identityVerification:{accountId:SEC}}),target.id);
 sample(19,{works:[{index:900,likes:7,publishedAt:at(18)}]});
 db.exec(`CREATE TABLE creator_source_imports(id INTEGER PRIMARY KEY,source_sha256 TEXT,source_url TEXT,source_revision TEXT,source_modified_at TEXT,imported_at TEXT,metadata_json TEXT,source_row_count INTEGER);
 CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);
 CREATE TABLE creator_source_account_links(import_id INTEGER,author_row INTEGER,target_id INTEGER,matched_id TEXT,matched_at TEXT);
 CREATE TABLE creator_source_work_links(import_id INTEGER,work_row INTEGER,target_id INTEGER);`);
 db.prepare('INSERT INTO creator_source_imports VALUES(1,?,?,?,?,?,?,100)').run('a'.repeat(64),'https://private.feishu.cn/sheets/fixture','1','2026-09-18T01:00:00.000Z','2026-09-19T01:00:00.000Z','{}');
 const add=db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)');
 add.run('08',2,JSON.stringify(['原登记作者','handle_a']));add.run('08',3,JSON.stringify(['已核验发布者','handle_b']));
 add.run('09',7,JSON.stringify([external(900),'原登记作者','handle_a','2026-09-18','video','切片激励','切片激励',500,50,'','作品原声明']));
 db.prepare('INSERT INTO creator_source_account_links VALUES(1,3,?,?,?)').run(target.id,'handle_b','2026-09-19T01:00:00.000Z');
 const replica=read(),links=replica.catalog.creatorSourceLinks;
 assert.deepEqual(links.workOwners,[{workRow:7,contentId:external(900),targetId:target.id}]);
 assert.deepEqual(links.links,[{authorRow:3,targetId:target.id}]);
 const original=replica.partitions.find(p=>p.kind==='creatorWorks').items.find(w=>w.contentId===external(900));
 assert.equal(original.douyinId,'handle_a');assert.equal(original.likes,50);assert.equal(original.plays,500);
 await preparePublicReplicaPublication(serializePublicReplica(replica));
 const changed=structuredClone(replica);changed.catalog.creatorSourceLinks.workOwners.push({...links.workOwners[0]});
 assert.throws(()=>serializePublicReplica(changed),/已校验/,'复制和编辑导出不能伪造服务端来源证明');
});

test('supplementary publisher overrides have their own source namespace and pass complete preparation',async t=>{
 const {database,target,sample,read}=fixture(t),db=database.db;
 db.prepare('UPDATE targets SET metadata_json=? WHERE id=?').run(JSON.stringify({platform:'douyin',douyinId:'handle_b',identityVerification:{accountId:SEC}}),target.id);
 sample(19,{works:[{index:900,likes:7,publishedAt:at(18)}]});
 db.exec(`CREATE TABLE creator_source_imports(id INTEGER PRIMARY KEY,source_sha256 TEXT,source_url TEXT,source_revision TEXT,source_modified_at TEXT,imported_at TEXT,metadata_json TEXT,source_row_count INTEGER);
 CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);
 CREATE TABLE creator_source_account_links(import_id INTEGER,author_row INTEGER,target_id INTEGER,matched_id TEXT,matched_at TEXT);
 CREATE TABLE creator_source_work_links(import_id INTEGER,work_row INTEGER,target_id INTEGER);`);
 db.prepare('INSERT INTO creator_source_imports VALUES(1,?,?,?,?,?,?,100)').run('a'.repeat(64),'https://private.feishu.cn/sheets/fixture','1','2026-09-18T01:00:00.000Z','2026-09-19T01:00:00.000Z','{}');
 const add=db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)');
 add.run('08',2,JSON.stringify(['原登记作者','handle_a']));add.run('08',3,JSON.stringify(['已核验发布者','handle_b']));
 add.run('09',7,JSON.stringify([external(901),'原登记作者','handle_a','2026-09-18','video','切片激励','切片激励',500,50,'','另一作品']));
 const observed=Array(14).fill(null);observed[2]='原登记作者';observed[3]='handle_a';observed[5]=external(900);observed[8]=50;observed[9]=500;observed[13]='2026-09-18T01:00:00Z';add.run('10',2,JSON.stringify(observed));
 db.prepare('INSERT INTO creator_source_account_links VALUES(1,3,?,?,?)').run(target.id,'handle_b','2026-09-19T01:00:00.000Z');
 const replica=read(),links=replica.catalog.creatorSourceLinks;
 assert.deepEqual(links.foundationWorkOwners,[{contentId:external(900),targetId:target.id}]);
 assert.equal(links.workOwners,undefined);assert.deepEqual(links.links,[{authorRow:3,targetId:target.id}]);
 const supplemental=replica.partitions.find(p=>p.kind==='foundationWorks').items.find(w=>w.contentId===external(900));assert.equal(supplemental.douyinId,'handle_a');assert.equal(supplemental.row,undefined);
 const record=replica.partitions.find(p=>p.kind==='foundationObservations').items.find(w=>w.contentId===external(900));assert.equal(record.likes,50);assert.equal(record.timeBasis,'unknown','no original header proves this fixture timestamp is a measurement or submission time');assert.equal(record.observedAt,null);
 await preparePublicReplicaPublication(serializePublicReplica(replica));
});

test('native publishers are exported without a source-author binding even when the public handle matches',async t=>{
 const {database,target,sample,read}=fixture(t),db=database.db;
 db.prepare('UPDATE targets SET metadata_json=? WHERE id=?').run(JSON.stringify({platform:'douyin',douyinId:'handle_b',identityVerification:{accountId:SEC}}),target.id);
 sample(19,{works:[{index:900,likes:7,publishedAt:at(18)},{index:901,likes:8,publishedAt:at(18)}]});
 db.exec(`CREATE TABLE creator_source_imports(id INTEGER PRIMARY KEY,source_sha256 TEXT,source_url TEXT,source_revision TEXT,source_modified_at TEXT,imported_at TEXT,metadata_json TEXT,source_row_count INTEGER);
 CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);
 CREATE TABLE creator_source_account_links(import_id INTEGER,author_row INTEGER,target_id INTEGER,matched_id TEXT,matched_at TEXT);
 CREATE TABLE creator_source_work_links(import_id INTEGER,work_row INTEGER,target_id INTEGER);`);
 db.prepare('INSERT INTO creator_source_imports VALUES(1,?,?,?,?,?,?,100)').run('a'.repeat(64),'https://private.feishu.cn/sheets/fixture','1','2026-09-18T01:00:00.000Z','2026-09-19T01:00:00.000Z','{}');
 const add=db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)');
 add.run('08',2,JSON.stringify(['未关联的来源作者','handle_b']));
 add.run('09',7,JSON.stringify([external(900),'未关联的来源作者','handle_b','2026-09-18','video','切片激励','切片激励',500,50,'','原文']));
 const observed=Array(14).fill(null);observed[2]='未关联的来源作者';observed[3]='handle_b';observed[5]=external(901);observed[8]=60;observed[9]=600;add.run('10',2,JSON.stringify(observed));
 const replica=read(),links=replica.catalog.creatorSourceLinks;
 assert.deepEqual(links.links,[],'原生作品证明不能伪造作者身份链接');
 assert.deepEqual(links.workOwners,[{workRow:7,contentId:external(900),targetId:target.id,sourceClaimMatches:true}]);
 assert.deepEqual(links.foundationWorkOwners,[{contentId:external(901),targetId:target.id,sourceClaimMatches:true}]);
 assert.equal(replica.partitions.find(p=>p.kind==='creatorAuthors').items[0].targetIds.length,0);
 await preparePublicReplicaPublication(serializePublicReplica(replica));
});

test('public replica: private source/config/locator fields are absent while legitimate names and confirmed classes remain', t => {
  const { sample, read } = fixture(t); sample(2, { works: [{ index: 1 }] });
  const replica = read(), { manifest, files } = serializePublicReplica(replica);
  const text = JSON.stringify(manifest) + files.map(file => file.content).join('');
  assert.equal(text.includes(SECRET), false); assert.equal(text.includes(SEC), false);
  for (const key of ['raw_json', 'metadata_json', 'locator', 'cookie', 'settings', 'credentials', 'sources', 'evidence']) {
    assert.equal(text.includes(`"${key}"`), false);
  }
  assert.equal(text.includes('feishu.cn'), false);
  assert.equal(replica.catalog.accounts[0].label, '公开合法昵称');
  assert.equal(replica.catalog.accounts[0].classification.theme.key, 'tuantuan');
  assert.equal(replica.catalog.accounts[0].classification.theme.confirmed, true);
  assert.ok(replica.catalog.accounts[0].classification.labels.some(item => item.key === 'original'));
  assert.equal(replica.policy.worksMetricEvidence, 'saved-record-not-independently-verified');
});

test('lightweight current account roster matches the public export catalog without sampling or writes', t => {
  const { database, sample, read } = fixture(t); sample(2);
  const fields = ['id', 'label', 'platform', 'enabled', 'boardKeys', 'classification'];
  const before = database.db.prepare('SELECT total_changes() n').get().n;
  const roster = readPublicAccountRoster(database);
  const projected = read().catalog.accounts.filter(account => account.sourceOnly !== true)
    .map(account => Object.fromEntries(fields.map(key => [key, account[key]])));
  assert.deepEqual(roster, projected);
  assert.equal(database.db.prepare('SELECT total_changes() n').get().n, before);
  assert.ok(!Object.hasOwn(roster[0], 'latest'));
  assert.ok(!Object.hasOwn(roster[0], 'historyRevision'));
});

test('publication export includes verified account works before any creator table import and records account scope',t=>{
 const{sample,read,target}=fixture(t);sample(16,{works:[{index:1,likes:13,publishedAt:at(15)}]});
 const replica=read(),index=replica.partitions.find(p=>p.path==='publishing.json');
 assert.equal(index.scope,'matrix');assert.equal(index.count,1);assert.equal(index.metrics.all.likes.value,13);
 const row=replica.partitions.find(p=>p.kind==='publishingShard').items[0];
 assert.equal(row.targetId,target.id);assert.equal(row.platform,'douyin');
 assert.equal(index.scopes[row.scopeId].theme,'tuantuan');assert.ok(index.scopes[row.scopeId].labels.includes('original'));
 assert.equal(row.metrics.plays.value,null);assert.equal(index.days[0].scopeGroups[0].works,1);
});

test('creator catalog and full source corpus use the same historical import cutoff',async t=>{
 const {database,read}=fixture(t),db=database.db;
 db.exec(`CREATE TABLE creator_source_imports(id INTEGER PRIMARY KEY,source_sha256 TEXT,source_url TEXT,source_revision TEXT,source_modified_at TEXT,imported_at TEXT,metadata_json TEXT,source_row_count INTEGER);
 CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);
 CREATE TABLE creator_source_account_links(import_id INTEGER,author_row INTEGER,target_id INTEGER,matched_id TEXT,matched_at TEXT);
 CREATE TABLE creator_source_work_links(import_id INTEGER,work_row INTEGER,target_id INTEGER);`);
 for(const [id,offset]of [[1,-86400000],[2,86400000]]){
  const at=new Date(Date.parse(AS_OF)+offset).toISOString();
  db.prepare('INSERT INTO creator_source_imports VALUES(?,?,?,?,?,?,?,0)').run(id,'a'.repeat(64),'https://private.feishu.cn/sheets/fixture',String(id),at,at,'{}');
 }
 const replica=read();assert.equal(replica.catalog.creatorSourceLinks.revision,'1');
 assert.equal(replica.partitions.find(p=>p.kind==='creatorIndex').revision,'1');
 await preparePublicReplicaPublication(serializePublicReplica(replica));
});

test('public replica preserves source-only publication day without fabricating a platform timestamp', async t => {
  const { database, target, sample, read } = fixture(t);
  const db = database.db;
  db.prepare('UPDATE targets SET metadata_json=? WHERE id=?')
    .run(JSON.stringify({ platform: 'douyin', douyinId: 'Handle_A', identityVerification:{accountId:SEC} }), target.id);
  db.exec(`CREATE TABLE creator_source_imports(id INTEGER PRIMARY KEY,source_sha256 TEXT,source_url TEXT,
    source_revision TEXT,source_modified_at TEXT,imported_at TEXT,metadata_json TEXT,source_row_count INTEGER);
    CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);
    CREATE TABLE creator_source_account_links(import_id INTEGER,author_row INTEGER,target_id INTEGER,matched_id TEXT,matched_at TEXT);
    CREATE TABLE creator_source_work_links(import_id INTEGER,work_row INTEGER,target_id INTEGER);`);
  db.prepare(`INSERT INTO creator_source_imports(id,source_sha256,source_url,source_revision,
    source_modified_at,imported_at,metadata_json,source_row_count) VALUES(?,?,?,?,?,?,?,?)`)
    .run(1, 'source-hash', `https://private.feishu.cn/sheets/${SECRET}`, '1',
      '2026-09-18T12:00:00.000Z', '2026-09-19T12:00:00.000Z',
      JSON.stringify({ audit: { sourceRefreshedAt: '2026-09-18T12:00:00.000Z' } }), 2);
  db.prepare('INSERT INTO creator_source_rows VALUES(?,?,?,?)').run(1,'08',2,JSON.stringify(['来源作者','handle_a']));
  db.prepare('INSERT INTO creator_source_account_links VALUES(?,?,?,?,?)').run(1,2,target.id,'handle_a','2026-09-19T12:00:00.000Z');
  const sourceRow = (row, day) => {
    const contentId = external(900 + row);
    const values = [contentId, '来源作者', 'handle_a', day, '视频', '切片激励', '切片激励',
      300, 20, '', `来源标题${row}`, `https://www.douyin.com/video/${contentId}`, 1, `slice_topic:${row}`];
    db.prepare('INSERT INTO creator_source_rows VALUES(?,?,?,?)').run(1, '09', row, JSON.stringify(values));
    db.prepare('INSERT INTO creator_source_work_links VALUES(?,?,?)').run(1, row, target.id);
    return contentId;
  };
  // Live projection is derived from the same strict source identity links.
  const liveProjection = read().catalog.creatorSourceLinks;
  assert.equal(liveProjection.revision, '1');
  assert.deepEqual(liveProjection.links, [{ authorRow: 2, targetId: target.id }]);
  const datedId = sourceRow(2, '2026-09-12');
  const invalidDateId = sourceRow(3, '2026-02-30');
  sample(2, { works: [{ index: 1 }] });

  const replica = read();
  const works = replica.partitions.find(part => part.kind === 'works' && part.targetId === target.id).items;
  const dated = works.find(item => item.externalId === datedId);
  const invalid = works.find(item => item.externalId === invalidDateId);
  const platform = works.find(item => item.externalId === external(1));
  assert.ok(dated); assert.equal(dated.publishedAt, null);
  assert.equal(dated.publishedOn, '2026-09-12');
  assert.equal(dated.publicationDateBasis, 'creator-source-date-only');
  assert.equal(dated.lastObservedAt, null, 'source refresh is not a platform observation');
  assert.equal(dated.source, 'creator-source');
  assert.equal(dated.sourceCumulativeLikes, 20);
  assert.equal(dated.sourceCumulativePlays, 300);
  assert.equal(dated.sourceRefreshedAt, '2026-09-18T12:00:00.000Z');
  assert.equal(dated.sourceRow, 2);
  assert.equal(JSON.stringify(dated).includes(SECRET), false, 'source details never export private source URLs');
  assert.ok(invalid); assert.equal(invalid.publishedAt, null);
  assert.equal(invalid.publishedOn, null, 'invalid source dates must not escape');
  assert.equal(invalid.publicationDateBasis, 'missing');
  assert.ok(platform); assert.equal(platform.publishedAt, at(1));
  assert.equal(platform.publishedOn, null);
  assert.equal(platform.publicationDateBasis, 'platform-timestamp');
  const serialized = serializePublicReplica(replica);
  const exportedWorks = JSON.parse(serialized.files.find(file => file.path === `works/${target.id}.json`).content).items;
  assert.deepEqual(exportedWorks, works);
  assert.equal(JSON.stringify(serialized).includes(SECRET), false);
  assert.equal(JSON.stringify(exportedWorks).includes('2026-09-12T00:00:00'), false);
  const sealed = await preparePublicReplicaPublication(serialized);
  const published = JSON.parse(sealed.files.find(file => file.path === `works/${target.id}.json`).content).items;
  assert.equal(published.find(item => item.externalId === datedId).sourceCumulativeLikes,20);
});

test('public replica includes only linked source-roster categories and does not expose roster provenance or pending rows', t => {
  const { database, target, sample, read } = fixture(t);
  sample(2, { works: [{ index: 1 }] });
  const snapshot = buildMasterRosterSnapshot({ exportedAt: AS_OF, entities: [
    { key: `target:${target.id}`, targetId: target.id, platform: 'douyin', enabled: true,
      currentName: '公开合法昵称', names: ['公开合法昵称'], ids: ['000123'], locators: [target.locator],
      sources: [{ url: '', title: '内部来源', file: '不可外发.xlsx', sheet: '账号表', rows: ['2'] }], boards: [],
      classification: { theme: { key: 'tuantuan', label: '团团' }, labels: [
        { key: 'ai-remix', label: 'AI二创' }, { key: 'original', label: '原创' },
      ] } },
    { key: 'submitted:douyin:pending', targetId: null, platform: 'douyin', enabled: null,
      currentName: '绝不公开的待核验账号', names: ['绝不公开的待核验账号'], ids: ['999999'], locators: [],
      sources: [], boards: [], classification: { theme: { key: 'tuantuan', label: '团团' }, labels: [] } },
  ] }, { fileName: '私有内部文件.xlsx', sha256: 'c'.repeat(64) });
  installMasterRoster(database.db, snapshot);
  const replica = read(), serialized = serializePublicReplica(replica);
  const contents = serialized.manifest + serialized.files.map(file => file.content).join('');
  const account = replica.catalog.accounts.find(item => item.id === target.id);
  assert.equal(account.classification.theme.key, 'tuantuan');
  assert.ok(account.classification.labels.some(item => item.key === 'ai-remix'));
  assert.ok(account.classification.labels.some(item => item.key === 'original'));
  assert.equal(contents.includes('绝不公开的待核验账号'), false);
  assert.equal(contents.includes('不可外发.xlsx'), false);
  assert.equal(contents.includes('内部来源'), false);
  assert.equal(contents.includes('sourceConfirmed'), false);
  assert.equal(contents.includes('master_roster_entries'), false);
});

test('public replica: correctly hashed foreign topic identity cannot authorize this topic counters', t => {
  const { topicSample, read } = fixture(t);
  topicSample(1, 123, 456, { foreign: true });
  const row = read().topics.items[0];
  assert.equal(row.participants, null); assert.equal(row.views, null);
  assert.equal(row.metricsEvidence, 'saved-unverified-closing-observation');
  assert.equal(row.capturedAt, at(1));
});

test('public replica: witnessed partial topic counters stay independent, never promote foreign partial counters', t => {
  const { topicSample, read } = fixture(t);
  topicSample(1, 123, null); topicSample(2, 120, null); topicSample(3, null, 456);
  topicSample(4, 999, null, { foreign: true });
  const rows = read().topics.items;
  assert.equal(rows[0].participants, 123); assert.equal(rows[0].views, null);
  assert.equal(rows[1].participantsDelta, -3); assert.equal(rows[1].viewsDelta, null);
  assert.equal(rows[2].participants, null); assert.equal(rows[2].views, 456);
  assert.equal(rows[3].participants, null); assert.equal(rows[3].views, null);
});

test('public replica: partial topic identity requires an exact string ID, not a coerced numeric identifier', t => {
  const { topicSample, read } = fixture(t);
  topicSample(1, 0, null, { challengeId: 123456789012345 });
  const row = read().topics.items[0];
  assert.equal(row.participants, null); assert.equal(row.metricsEvidence, 'saved-unverified-closing-observation');
});

test('public replica: null, true zero, negative delta, exact times and hashes are retained without missing-date fillers', t => {
  const { sample, target, read } = fixture(t);
  sample(1, { followers: 10, likes: 100, posts: 2 });
  sample(2, { followers: 0, likes: 90, posts: null });
  sample(4, { followers: 1, likes: null, posts: 0 });
  const replica = read(), daily = replica.partitions.find(part => part.kind === 'daily' && part.targetId === target.id).items;
  assert.equal(daily.length, 3); assert.equal(daily[1].followers, 0); assert.equal(daily[1].followersDelta, -10);
  assert.equal(daily[1].likesDelta, -10); assert.equal(daily[1].estimatedPlaysDelta, -1000);
  assert.equal(daily[1].posts, null); assert.equal(daily[2].followersDelta, null);
  assert.equal(daily[1].followersAt, at(2)); assert.equal(daily[1].followersBaselineAt, at(1));
  assert.match(daily[1].followersChecksum, /^[a-f\d]{64}$/);
  assert.equal(daily[1].followersBaselineChecksum, daily[0].followersChecksum);
});

test('public replica: all 247 works and batch metrics survive paging without a query for each work', t => {
  const { database, target, sample } = fixture(t);
  sample(2, { works: Array.from({ length: 247 }, (_, index) => ({ index: index + 1, likes: index })) });
  let queries = 0;
  const db = new Proxy(database.db, { get(native, key) {
    if (key === 'prepare') return sql => { queries++; return native.prepare(sql); };
    const value = Reflect.get(native, key, native); return typeof value === 'function' ? value.bind(native) : value;
  } });
  const before = database.db.prepare('SELECT total_changes() n').get().n;
  const replica = exportPublicReplica(db, { asOf: AS_OF });
  assert.equal(replica.counts.works, 247); assert.equal(replica.counts.workMetrics, 247);
  assert.equal(new Set(replica.partitions.find(part => part.kind === 'works').items.map(item => item.id)).size, 247);
  assert.equal(replica.partitions.find(part => part.kind === 'workMetrics').targetId, target.id);
  assert.ok(queries < 70, `query count ${queries} must not grow a query per metric/work`);
  assert.equal(database.db.prepare('SELECT total_changes() n').get().n, before);
});

test('public replica: future first discovery/metrics and foreign-author records cannot enter the snapshot', t => {
  const { database, target, sample, read } = fixture(t);
  sample(2, { works: [{ index: 1, likes: 1 }, { index: 2, likes: 2 }] });
  sample(21, { works: [{ index: 1, likes: 99999 }, { index: 3, likes: 99999 }] });
  database.db.prepare('UPDATE posts SET author_id=? WHERE external_id=?').run(OTHER, external(2));
  const replica = read(); assert.equal(replica.counts.works, 1); assert.equal(replica.counts.workMetrics, 1);
  const metrics = replica.partitions.find(part => part.kind === 'workMetrics' && part.targetId === target.id).items;
  assert.equal(metrics[0].likes, 1); assert.equal(metrics[0].plays, null);
  assert.equal(metrics[0].playsEvidence.actualCountVerified, false);
});

test('public replica: labels/captions cannot carry markup, embedded URLs, credentials or raw locator text', t => {
  const { database, target, sample, read } = fixture(t);
  database.db.prepare('UPDATE targets SET label=? WHERE id=?').run(`正常昵称 <img src=x onerror=alert(1)> cookie=${SECRET} https://private.feishu.cn/${SECRET} ${SEC}`, target.id);
  sample(2, { works: [{ index: 1, caption: `<script>alert(1)</script> token=${SECRET} ${SEC} https://private.feishu.cn/${SECRET}`,
    url: `https://www.douyin.com/video/${external(1)}?modal_id=${SECRET}` }] });
  const encoded = JSON.stringify(serializePublicReplica(read()));
  for (const value of [SECRET, SEC, '<script>', '<img', 'feishu.cn']) assert.equal(encoded.includes(value), false);
  assert.ok(encoded.includes('正常昵称'));
});

test('public replica: quoted credential objects and arbitrary metadata platform strings cannot escape the catalog', t => {
  const { database, target, read } = fixture(t);
  database.db.prepare('UPDATE targets SET label=?,metadata_json=? WHERE id=?')
    .run(JSON.stringify({ cookie: SECRET }), JSON.stringify({ platform: SECRET }), target.id);
  const replica = read(), encoded = JSON.stringify(serializePublicReplica(replica));
  assert.equal(encoded.includes(SECRET), false);
  assert.equal(replica.catalog.accounts[0].platform, 'unknown');
});

test('public replica: nickname-only category is not promoted to confirmed classification', t => {
  const { database, read } = fixture(t);
  const weak = database.createTarget({ type: 'account', label: '游戏切片昵称', locator: OTHER, provider: 'public-web' });
  const account = read().catalog.accounts.find(item => item.id === weak.id);
  assert.deepEqual(account.classification.labels, []);
  assert.equal(account.classification.needsReview, true); assert.equal(account.classification.theme.confirmed, false);
});

test('public replica: four-topic allowlist, source-vector guard, closing unknowns and adjacent negative/zero changes', t => {
  const { database, topicSample, read } = fixture(t);
  database.createTarget({ type: 'hashtag', label: '#非用户确认的话题', locator: 'another-topic', provider: 'public-web' });
  topicSample(1, 5, 100); topicSample(2, 0, 90); topicSample(4, 0, 0); topicSample(5, 1, 1, { tamper: true });
  const replica = read(), rows = replica.topics.items;
  assert.equal(replica.counts.topics, 1); assert.equal(rows.length, 4);
  assert.equal(rows[1].participants, 0); assert.equal(rows[1].participantsDelta, -5); assert.equal(rows[1].viewsDelta, -10);
  assert.equal(rows[2].participantsDelta, null); assert.equal(rows[3].views, null);
  assert.equal(rows[3].qualityStatus, 'unverified');
  assert.equal(rows[3].capturedAt, at(5)); assert.match(rows[0].sourceChecksum, /^[a-f\d]{64}$/);
});

test('public replica: deterministic file bytes/hash/counts and generated disk readback are exact', async t => {
  const { sample, read } = fixture(t); sample(2, { works: [{ index: 1 }] });
  const replica = read(), serialized = serializePublicReplica(replica);
  assert.deepEqual(serializePublicReplica(replica), serialized);
  const directory = await mkdtemp(join(tmpdir(), 'public-replica-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = await writePublicReplica(directory, replica);
  for (const file of manifest.files) {
    const bytes = await readFile(join(directory, file.path));
    assert.equal(bytes.length, file.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    const body = JSON.parse(bytes); assert.equal(body.asOf, AS_OF); assert.equal(body.version, 1);
    if (body.items) assert.equal(body.items.length, file.count);
  }
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), manifest);
  await assert.rejects(writePublicReplica(directory, replica), error => error.code === 'EEXIST', 'must never overwrite existing exports');
});

test('public replica: invalid cutoff and forged/mutable serialization fail closed', t => {
  const { database, read } = fixture(t);
  for (const asOf of ['2099-01-01T00:00:00.000Z', '2026-02-30T00:00:00.000Z', 'not-a-date']) {
    assert.throws(() => exportPublicReplica(database, { asOf }));
  }
  const replica = read(); assert.ok(Object.isFrozen(replica)); assert.ok(Object.isFrozen(replica.catalog.accounts));
  assert.throws(() => { replica.partitions.push({ path: '../private.json' }); });
  assert.throws(() => serializePublicReplica({ ...replica, partitions: [{ path: '../private.json', items: [] }] }));
});
