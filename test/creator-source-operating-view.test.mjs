import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readCreatorOperatingView, readCreatorSourceWorksForTarget, registeredContentTypes, readUnifiedPublicationWorks } from '../lib/creator-source-operating-view.mjs';
import { buildAuthorEvidenceRequests, verifyQueuedAuthorEvidence } from '../lib/author-resolution.mjs';
import * as XLSX from '@e965/xlsx';
import { commitWorkSourceEdition } from '../lib/work-source-store.mjs';
import { publishingPartitions } from '../lib/replica-publishing.mjs';

const sec = 'MS4wLjABAAAA' + 'a'.repeat(40);
const locator = `https://www.douyin.com/user/${sec}`;
const targetMetadata = douyinId => JSON.stringify({ platform: 'douyin', douyinId,
  identityVerification: { accountId: locator } });

test('提交时间不冒充指标采样时间，列表和作者合计保留有效观测值',()=>{
 const db=fixture(),id='7300000000000000061';platformFixture(db);
 const source=[id,'同名作者','handle_a','2026-10-21','video','切片激励','切片激励',50,5,'','观测作品'];
 db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('09',7,JSON.stringify(source));
 addPlatformWork(db,{id,postId:661,metricAt:'2026-10-22T08:00:00Z',likes:7,plays:70});
 const obs=[];obs[2]='同名作者';obs[3]='handle_a';obs[5]=id;obs[8]=3;obs[9]=null;obs[13]='2026-10-23T08:00:00Z';
 db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('10',2,JSON.stringify(obs));
 try{
  const query={q:id,asOf:'2026-10-28T08:00:00.000Z'};
  const result=readCreatorOperatingView(db,{...query,view:'works'});assert.equal(result.total,1);
  assert.equal(result.items[0].latestLikes,7);assert.equal(result.items[0].latestPlays,70);
  assert.equal(result.items[0].cumulativeLikes,5,'原始累计证据不改写');
  assert.equal(result.summary.cumulativeLikes,7);assert.equal(result.summary.cumulativePlays,70);
  assert.equal(result.daily[0].cumulativeLikes,7);
  assert.equal(readCreatorOperatingView(db,{...query,view:'authors'}).items[0].cumulativeLikes,7);
  const previous=readCreatorOperatingView(db,{...query,view:'works',asOf:'2026-10-22T12:00:00.000Z'});
  assert.equal(previous.items[0].latestLikes,7);
 }finally{db.close();}
});

test('补充来源独有作品按ID进入统一发布台账；观测日期不伪造成发布日期',()=>{
 const db=fixture(),id='7300000000000000062',row=[];row[2]='同名作者';row[3]='handle_a';row[5]=id;row[8]=0;row[9]=20;row[13]='2026-10-23T08:00:00Z';
 db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('10',2,JSON.stringify(row));
 try{
  const asOf='2026-10-28T08:00:00.000Z',rows=readUnifiedPublicationWorks(db,asOf);
  assert.equal(rows.filter(work=>work.contentId===id).length,1);assert.equal(rows.find(work=>work.contentId===id).publishedOn,'');
  const view=readCreatorOperatingView(db,{asOf,view:'works',q:id});assert.equal(view.total,1);assert.equal(view.items[0].latestLikes,0);
  assert.equal(view.items[0].latestPlays,20);assert.equal(view.summary.works,1);
 }finally{db.close();}
});

test('补充观测重叠平台作品仍只计一次，保留平台真实发布日期而非丢到无日期',()=>{
 const db=fixture(),id='7300000000000000063';platformFixture(db);
 addPlatformWork(db,{id,postId:663});
 const row=[];row[2]='同名作者';row[3]='handle_a';row[5]=id;row[8]=20;row[13]='2026-10-23T08:00:00Z';
 db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('10',2,JSON.stringify(row));
 try{
  const works=readUnifiedPublicationWorks(db,'2026-10-28T08:00:00.000Z').filter(w=>w.contentId===id);
  assert.equal(works.length,1);assert.equal(works[0].publishedOn,'2026-10-22');assert.equal(works[0].targetId,10);
 }finally{db.close();}
});

test('原表新版直接进入同一作品查询与账号详情，缓存按来源版本刷新，历史截止不漂移',()=>{
  const db=fixture();db.exec('PRAGMA foreign_keys=ON');
  const videoId='7300000000000000099',url='https://fixture.feishu.cn/sheets/FixtureWorkbook123456';
  const save=(revision,likes,at)=>{
    const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([
      ['视频ID','作者昵称','作者抖音号','发布时间','播放','点赞'],[videoId,'同名作者','handle_a','2026-10-21',null,likes]
    ]),'作品');
    const metadata={url,revision,title:'切片激励计划排名公示',modifiedAt:at,sheets:[{id:'works',name:'作品',region:'A1:F2'}]};
    commitWorkSourceEdition(db,{buffer:XLSX.write(book,{type:'buffer',bookType:'xlsx'}),before:metadata,after:metadata,readAt:at},{now:()=>Date.parse(at)});
  };
  try{
    const query={view:'works',q:videoId,asOf:'2026-10-28T00:00:00.000Z'};
    assert.equal(readCreatorOperatingView(db,query).total,0);
    save(1,4,'2026-10-22T08:00:00.000Z');
    const first=readCreatorOperatingView(db,query);assert.equal(first.total,1);
    assert.equal(first.items[0].targetId,10);assert.equal(first.items[0].latestLikes,4);assert.equal(first.items[0].latestPlays,null);
    assert.equal(readCreatorSourceWorksForTarget(db,10,{asOf:query.asOf}).items.some(w=>w.contentId===videoId),true);
    save(2,2,'2026-10-23T08:00:00.000Z');
    const second=readCreatorOperatingView(db,query);assert.equal(second.total,1);assert.equal(second.items[0].latestLikes,2);
    assert.equal(second.items[0].latestObservedAt,null,'来源版本更新时间不是平台观测时间');
    assert.equal(readCreatorOperatingView(db,{...query,asOf:'2026-10-22T12:00:00.000Z'}).items[0].latestLikes,4);
  }finally{db.close();}
});

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE creator_source_imports(id INTEGER PRIMARY KEY,source_sha256 TEXT,source_url TEXT,source_revision TEXT,
    source_modified_at TEXT,imported_at TEXT,metadata_json TEXT);
    CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);
    CREATE TABLE creator_source_account_links(import_id INTEGER,author_row INTEGER,target_id INTEGER,matched_id TEXT,matched_at TEXT);
    CREATE TABLE creator_source_work_links(import_id INTEGER,work_row INTEGER,target_id INTEGER);
    CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,provider TEXT,locator TEXT,metadata_json TEXT);
    INSERT INTO creator_source_imports VALUES(1,'sha1','https://feishu.cn/sheets/source','17','2026-10-20T04:00:00Z','2026-10-20T06:00:00Z',
      '{"audit":{"sourceRefreshedAt":"2026-10-20T04:00:00Z","sourceStart":"2026-09-12","sourceEnd":"2026-10-12"}}');
    INSERT INTO creator_source_account_links VALUES(1,2,10,'handle_a','2026-10-20T06:00:00Z');
    INSERT INTO creator_source_work_links VALUES(1,2,10),(1,3,10);`);
  db.prepare('INSERT INTO targets VALUES(10,?,?,?,?)').run('account', 'public-web', locator, targetMetadata('handle_a'));
  const add = (sheet, row, values) => db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run(sheet, row, JSON.stringify(values));
  add('02', 2, ['slice_topic', '切片表', 2, 2, '', 'https://feishu.cn/sheets/raw?sheet=slice']);
  add('02', 3, ['slice_registry', '登记表', 1, 1, '', 'https://feishu.cn/base/registry']);
  add('08', 2, ['同名作者', 'handle_a', 'OLD_A', '是', 0, 0, 2, 2, 0, 1, 0, 100, 4, 0, 999, '截图未标注日期', 'private-prize', 'private-bonus']);
  add('08', 3, ['同名作者', 'handle_b', '', '', 0, 0, 1, 0, 1, 0, 0]);
  add('08', 4, ['尚无作品', 'handle_c', '', '', 0, 0, 0, 1, 0, 0, 0]);
  add('08', 5, ['只有昵称', '', '', '', 0, 0, 0, 0, 0, 0, 0]);
  add('09', 2, ['111', '同名作者', 'HANDLE_A', '2026-09-12', 'video', '切片激励', '切片激励 / 即梦二创', 100, 4, '', '作品一', 'https://douyin.com/video/111', 2, 'slice_topic:2; slice_registry:rec_1']);
  add('09', 3, ['222', '同名作者', 'handle_a', '2026-10-12', 'video', '切片激励', '切片激励', null, 0, '', '作品二', 'https://douyin.com/video/222', 1, 'slice_topic:3']);
  add('09', 4, ['333', '同名作者', 'handle_b', '2026-10-12', 'video', '创作激励', '创作激励', 200, null, '', '作品三']);
  add('09', 5, ['111', '同名作者', 'handle_a', '2026-09-12', 'video', '切片激励', '切片激励', 9999999, 9999999]);
  add('09', 6, ['444', '只有昵称', '', '', 'video', '', '', null, null, '', '未关联作品']);
  return db;
}

function platformFixture(db) {
  db.exec(`CREATE TABLE posts(id INTEGER PRIMARY KEY,target_id INTEGER,external_id TEXT,author_id TEXT,
      first_seen_at TEXT,last_seen_at TEXT,raw_json TEXT,published_at TEXT,caption TEXT,url TEXT);
    CREATE INDEX post_external ON posts(external_id);
    CREATE TABLE post_metrics(id INTEGER PRIMARY KEY,post_id INTEGER,captured_at TEXT,likes INTEGER,plays INTEGER);`);
  db.prepare('INSERT INTO posts(id,target_id,external_id,author_id,first_seen_at,last_seen_at,raw_json) VALUES(101,10,?,?,?,?,?)').run('111', sec, '2020-01-01T00:00:00Z', '2020-01-03T00:00:00Z',
    JSON.stringify({ aweme_id: '111', author: { sec_uid: sec } }));
  db.exec(`INSERT INTO post_metrics VALUES(1,101,'2020-01-01T00:00:00Z',7,0),
    (2,101,'2020-01-02T00:00:00Z',9,0),(3,101,'invalid-time',50000,70000),
    (4,101,'2020-01-03T00:00:00Z',NULL,NULL);`);
  return sec;
}

function addPlatformWork(db, { id, postId, targetId = 10, authorId = sec,
  firstSeenAt = '2026-10-21T16:30:00Z', publishedAt = '2026-10-21T16:15:00Z',
  rawAuthor = authorId, caption = '新增平台作品', likes = 12, plays = 345,
  metricAt = '2026-10-21T17:00:00Z' }) {
  db.prepare(`INSERT INTO posts(id,target_id,external_id,author_id,first_seen_at,last_seen_at,raw_json,published_at,caption,url)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(postId, targetId, id, authorId, firstSeenAt, firstSeenAt,
    JSON.stringify({ aweme_id: id, author: { sec_uid: rawAuthor } }), publishedAt, caption,
    `https://www.douyin.com/video/${id}`);
  if (metricAt) db.prepare('INSERT INTO post_metrics(post_id,captured_at,likes,plays) VALUES(?,?,?,?)')
    .run(postId, metricAt, likes, plays);
}

test('exact work hashtags reach the same filtered operating query and publication ledger without inheriting author categories', () => {
  const db = fixture();
  try {
    platformFixture(db);
    const id = '7300000000000000088';
    addPlatformWork(db, { id, postId: 102, caption: '新作品 #一条小团团OvO切片激励计划' });
    const query = { view: 'works', classification: 'slice', q: id, asOf: '2026-10-22T00:00:00Z' };
    const result = readCreatorOperatingView(db, query);
    assert.equal(result.total, 1);
    assert.deepEqual(result.items[0].classifications, ['slice']);
    assert.equal(result.items[0].primaryTrack, '切片激励');
    assert.equal(result.items[0].classificationEvidence[0].kind, 'platform-caption-hashtag');
    assert.equal(result.items[0].classificationEvidence[0].observedAt, '2026-10-21T16:30:00.000Z');
    assert.equal(result.summary.platformOnlyWorks, 1);
    assert.equal(result.daily[0].works, 1);
    const ledger = readUnifiedPublicationWorks(db, query.asOf);
    assert.deepEqual(ledger.find(row => row.contentId === id).classifications, ['slice']);
    assert.equal(ledger.filter(row => row.contentId === id).length, 1);
    const partitions = publishingPartitions(ledger.filter(row => row.contentId === id).map(work => ({
      contentId: work.contentId, date: work.publishedOn, author: work.authorName, title: work.title,
      targetId: work.targetId, classifications: work.classifications, origin: 'platform',
    })));
    assert.equal(partitions[0].days[0].tracks.slice, 1);
    assert.equal(partitions[0].days[0].works, 1);
    assert.equal(readCreatorOperatingView(db, { ...query, classification: 'original' }).total, 0);
  } finally { db.close(); }
});

test('multiple work topics stay multi-category without assigning an arbitrary primary or duplicate work count', () => {
  const db = fixture();
  try {
    platformFixture(db);
    const id = '7300000000000000087';
    addPlatformWork(db, { id, postId: 102, caption: '#一条小团团OvO切片激励计划 #小团团即梦二创大赛' });
    const all = readCreatorOperatingView(db, { view: 'works', q: id });
    assert.equal(all.total, 1);
    assert.equal(all.items[0].primaryTrack, '多赛道');
    assert.deepEqual(all.items[0].classifications, ['slice', 'ai-remix']);
    assert.equal(readCreatorOperatingView(db, { view: 'works', q: id, classification: 'slice' }).total, 1);
    assert.equal(readCreatorOperatingView(db, { view: 'works', q: id, classification: 'ai-remix' }).total, 1);
    assert.equal(all.summary.works, 1);
  } finally { db.close(); }
});

test('a future caption observation cannot reclassify historical work queries', () => {
  const db = fixture();
  try {
    platformFixture(db);
    const id = '7300000000000000089';
    addPlatformWork(db, { id, postId: 102, caption: '#小团团即梦二创大赛', firstSeenAt: '2026-10-20T00:00:00Z', publishedAt: '2026-10-19T23:00:00Z' });
    db.prepare('UPDATE posts SET last_seen_at=? WHERE id=102').run('2026-10-22T00:00:00Z');
    assert.equal(readCreatorOperatingView(db, { view: 'works', q: id, classification: 'ai-remix', asOf: '2026-10-21T00:00:00Z' }).total, 0);
    assert.equal(readCreatorOperatingView(db, { view: 'works', q: id, classification: 'ai-remix', asOf: '2026-10-23T00:00:00Z' }).total, 1);
  } finally { db.close(); }
});

test('source labels remain primary and a matched platform tag supplements rather than duplicates or overwrites the work', () => {
  const db = fixture();
  try {
    platformFixture(db);
    db.prepare('UPDATE posts SET caption=? WHERE id=101').run('作品 #一条小团团OvO创作激励计划');
    const result = readCreatorOperatingView(db, { view: 'works', classification: 'original', q: '111' });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].primaryTrack, '切片激励');
    assert.ok(result.items[0].classifications.includes('slice'));
    assert.ok(result.items[0].classifications.includes('original'));
    assert.equal(result.items[0].sourceRow, 2);
    assert.equal(readUnifiedPublicationWorks(db, '2026-10-23T00:00:00Z').filter(row => row.contentId === '111').length, 1);
    assert.equal(readCreatorOperatingView(db, { view: 'works', q: '111' }).items[0].sourceCumulativePlays, 100);
  } finally { db.close(); }
});

function verifiedSourceReceiptFixture() {
  const db = fixture();
  platformFixture(db);
  const videoId = '7300000000000000001';
  const at = '2026-10-20T07:00:00Z', observed = '2026-10-20T04:00:00Z';
  const sha = value => createHash('sha256').update(value).digest('hex');
  db.exec(`DELETE FROM creator_source_account_links;
    DELETE FROM creator_source_work_links;
    DELETE FROM creator_source_rows WHERE sheet_id='09';
    CREATE TABLE author_resolution_queue(id INTEGER,identity_key TEXT,name TEXT,douyin_id TEXT,account_locator TEXT,
      video_ids_json TEXT,share_urls_json TEXT,status TEXT,evidence_version INTEGER,verification_policy_version INTEGER,
      resolved_target_id INTEGER,lease_owner TEXT,lease_until TEXT,suspended_target_enabled INTEGER,source_metadata_json TEXT);
    CREATE TABLE author_resolution_import_sources(queue_id INTEGER,queue_identity_key TEXT,payload_json TEXT,receipt_sha256 TEXT,observed_at TEXT);
    CREATE TABLE author_resolution_success_receipts(queue_id INTEGER,evidence_version INTEGER,identity_key TEXT,target_id INTEGER,
      platform TEXT,canonical_account_id TEXT,verified_at TEXT,payload_json TEXT,receipt_sha256 TEXT);`);
  db.prepare('UPDATE targets SET locator=?,metadata_json=? WHERE id=10').run(sec,
    JSON.stringify({ platform: 'douyin', douyinId: 'handle_a', identityVerification: { accountId: sec } }));
  const workValues = [videoId, '同名作者', 'handle_a', '2026-10-12', 'video',
    '切片激励', '切片激励', 100, 4, '', '作品', `https://www.douyin.com/video/${videoId}`, 1, 'slice_topic:2'];
  const workJson = JSON.stringify(workValues);
  db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('09', 2, workJson);
  db.prepare('UPDATE posts SET external_id=?,raw_json=? WHERE id=101').run(videoId,
    JSON.stringify({ aweme_id: videoId, author: { sec_uid: sec } }));
  const authorJson = db.prepare("SELECT values_json FROM creator_source_rows WHERE import_id=1 AND sheet_id='08' AND row_number=2").get().values_json;
  const imported = db.prepare('SELECT * FROM creator_source_imports WHERE id=1').get();
  const request = buildAuthorEvidenceRequests([{ name: '同名作者', douyinId: 'handle_a',
    videoId, shareUrl: `https://www.douyin.com/video/${videoId}` }])[0];
  const verified = verifyQueuedAuthorEvidence(request, { key: request.key, errors: [], candidates: [{
    videoId, sourceEvidenceUrl: request.shareUrls[0], secUid: sec, uniqueId: 'handle_a', nickname: '公开昵称',
  }] });
  assert.equal(verified.status, 'ready');
  const sourceMetadata = { sourceType: 'creator-source-sheet', sourceUrl: imported.source_url,
    sourceRevision: imported.source_revision, sourceSha256: imported.source_sha256,
    sourceModifiedAt: imported.source_modified_at, authorRow: 2, workRow: 2,
    authorRowSha256: sha(authorJson), workRowSha256: sha(workJson) };
  const sourcePayload = JSON.stringify({ sourceRows: [2], sourceMetadata });
  db.prepare('INSERT INTO author_resolution_queue VALUES(1,?,?,?,?,?,?,?,1,2,10,NULL,NULL,NULL,?)')
    .run(request.key, '同名作者', 'handle_a', '', JSON.stringify(request.videoIds),
      JSON.stringify(request.shareUrls), 'resolved', JSON.stringify(sourceMetadata));
  db.prepare('INSERT INTO author_resolution_import_sources VALUES(1,?,?,?,?)')
    .run(request.key, sourcePayload, sha(sourcePayload), observed);
  const proof = { format: 'mcn-author-resolution-success-v1', queueId: 1, evidenceVersion: 1,
    identityKey: request.key, verificationPolicyVersion: 2, targetId: 10, platform: 'douyin',
    canonicalAccountId: sec, verifiedAt: at, committedAt: at,
    evidence: { name: '同名作者', douyinId: 'handle_a', accountLocator: '',
      videoIds: request.videoIds, shareUrls: request.shareUrls },
    resolution: { ...verified.row.resolution, resolvedAt: at,
      authorisedDetailReceipt: {format:'mcn-creator-source-authorised-detail-v1',identityOnly:true,equivalentLocatorsForOneWork:true,
        source:{importId:1,sourceReceiptSha256:sha(sourcePayload),...sourceMetadata,videoId,shareUrl:request.shareUrls[0]},
        queue:{id:1,identityKey:request.key,evidenceVersion:1}} } };
  const serialized = JSON.stringify(proof);
  db.prepare('INSERT INTO author_resolution_success_receipts VALUES(1,1,?,10,?,?,?, ?,?)')
    .run(request.key, 'douyin', sec, at, serialized, sha(serialized));
  return { db, videoId };
}

test('成功凭据按稳定账号与作品作者关联：抖音号改名后经营视图和账号详情一致', () => {
  const { db, videoId } = verifiedSourceReceiptFixture();
  try {
    const before = readCreatorOperatingView(db, { view: 'works', q: videoId }).items[0];
    assert.equal(before.postId, 101);
    assert.equal(before.latestLikes, 9);
    db.prepare('UPDATE targets SET metadata_json=? WHERE id=10').run(JSON.stringify({
      platform: 'douyin', douyinId: 'renamed_handle', identityVerification: { accountId: sec },
    }));
    const after = readCreatorOperatingView(db, { view: 'works', q: videoId }).items[0];
    const detail = readCreatorSourceWorksForTarget(db, 10);
    assert.equal(after.targetId, 10);
    assert.equal(after.postId, 101);
    assert.equal(after.latestLikes, 9);
    assert.equal(after.metricProvenance.platform.identity, 'strict-source-link-canonical-post-author');
    assert.deepEqual(detail.items.map(item => item.contentId), [videoId]);
  } finally { db.close(); }
});

test('成功凭据不能把作品 ID 相同但原始作者 canonical 不符的平台指标合入', () => {
  const { db, videoId } = verifiedSourceReceiptFixture();
  try {
    db.prepare('UPDATE targets SET metadata_json=? WHERE id=10').run(JSON.stringify({
      platform: 'douyin', douyinId: 'renamed_handle', identityVerification: { accountId: sec },
    }));
    db.prepare('UPDATE posts SET raw_json=? WHERE id=101').run(JSON.stringify({
      aweme_id: videoId, author: { sec_uid: 'MS4wLjABAAAAOtherAccountFixture0002' },
    }));
    const result = readCreatorOperatingView(db, { view: 'works', q: videoId });
    assert.equal(result.items[0].targetId, 10, 'valid source receipt still links the author');
    assert.equal(result.items[0].postId, null);
    assert.equal(result.items[0].latestLikes, 4);
    assert.equal(result.reconciliation.identityMatchedWorkOverlap, 0);
    assert.deepEqual(readCreatorSourceWorksForTarget(db, 10).items.map(item => item.contentId), [videoId]);
  } finally { db.close(); }
});

test('同作品来源a1与平台a1.1合成一条，平台新值优先且缺失字段不覆盖来源', () => {
  const db = fixture();
  try {
    platformFixture(db);
    const result = readCreatorOperatingView(db, { view: 'works', q: '111' });
    assert.equal(result.summary.works, 1);
    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.equal(item.postId, 101);
    assert.equal(item.sourceCumulativeLikes, 4);
    assert.equal(item.latestLikes, 9);
    assert.equal(item.sourceCumulativePlays, 100);
    assert.equal(item.latestPlays, 100);
    assert.equal(item.platformLatest.plays, null);
    assert.deepEqual(item.metricOrigin, { likes: 'platform', plays: 'source' });
    assert.equal(item.latestObservedAt, '2020-01-02T00:00:00.000Z');
    assert.equal(item.comparison.likes.delta, 2);
    assert.equal(item.comparison.likes.dailyGrowth, false);
    assert.equal(item.comparison.plays, null);
    assert.equal(item.sourceComparison.likes.difference, 5);
    assert.equal(item.sourceComparison.likes.chronologicalOrderVerified, false);
    assert.equal(item.sourceComparison.notDailyGrowth, true);
    assert.equal(result.summary.cumulativeLikes, 9,'合计与列表采用同一观测值，原始累计4保留在sourceCumulativeLikes');
    assert.equal(result.reconciliation.knownWorkOverlap, 1);
    assert.equal(result.reconciliation.identityMatchedWorkOverlap, 1);
    assert.equal(result.reconciliation.newSourceWorks, 0);
  } finally { db.close(); }
});

test('严格关联的新平台作品进入同一作品视图，原表累计与平台观测分开且可按真实发布日期筛选', () => {
  const db = fixture();
  try {
    platformFixture(db);
    const id = '7300000000000000002';
    const before = readCreatorOperatingView(db, { view: 'works' });
    assert.equal(before.summary.works, 4);
    addPlatformWork(db, { id, postId: 102 });
    const result = readCreatorOperatingView(db, { view: 'works', q: id });
    assert.equal(result.summary.works, 1);
    assert.equal(result.total, 1);
    assert.equal(result.items[0].contentId, id);
    assert.equal(result.items[0].sourceRow, null);
    assert.equal(result.items[0].authorKey, 'source-author:1:2');
    assert.equal(result.items[0].targetId, 10);
    assert.equal(result.items[0].publishedOn, '2026-10-22', 'UTC 晚间对应北京时间次日');
    assert.equal(result.items[0].publishedAt, '2026-10-21T16:15:00.000Z');
    assert.equal(result.items[0].firstSeenAt, '2026-10-21T16:30:00.000Z');
    assert.equal(result.items[0].dateSource, 'platform-published-at');
    assert.equal(result.items[0].cumulativePlays, null, '不能把平台值伪装为原表累计');
    assert.equal(result.items[0].cumulativeLikes, null);
    assert.equal(result.items[0].latestPlays, 345);
    assert.equal(result.items[0].latestLikes, 12);
    assert.equal(result.items[0].metricOrigin.plays, 'platform');
    assert.equal(result.items[0].platformLatest.capturedAt, '2026-10-21T17:00:00.000Z');
    assert.deepEqual(result.items[0].classifications, [], '未知分类不能按作者昵称或赛道猜测');
    const all = readCreatorOperatingView(db, { view: 'works' });
    assert.equal(all.summary.works, 5);
    assert.equal(all.globalSummary.works, 5);
    assert.equal(all.summary.sourceWorks, 4);
    assert.equal(all.summary.platformOnlyWorks, 1);
    assert.equal(all.summary.cumulativePlays, 645, '四条原作品与一条平台独有作品按ID合计，采用列表值');
    assert.equal(all.reconciliation.newPlatformWorks, 1);
    const day = readCreatorOperatingView(db, { view: 'works', start: '2026-10-22', end: '2026-10-22' });
    assert.deepEqual(day.daily.map(row => row.day), ['2026-10-22']);
    assert.equal(day.summary.works, 1);
    assert.equal(day.summary.cumulativePlays, 345);
    assert.match(day.semantics.date, /不代表该日/);
    assert.equal('dailyGrowth' in day, false);
    assert.equal(readCreatorOperatingView(db, { view: 'works', authorKey: 'source-author:1:2', q: id }).total, 1);
    assert.equal(readCreatorOperatingView(db, { view: 'works', classification: 'slice', q: id }).total, 0,
      '仅凭作者所属类别不替新作品推断内容类别');
    assert.deepEqual(readCreatorSourceWorksForTarget(db, 10).items.map(item => item.contentId), ['111', '222'],
      'source-only helper 继续供账号详情自行合并，不能重复加平台作品');
  } finally { db.close(); }
});

test('播放和点赞排序使用列表采用值，平台独有作品不再永远排在来源作品之后', () => {
  const db = fixture();
  try {
    platformFixture(db);
    const id = '7300000000000000008';
    addPlatformWork(db, { id, postId: 102, likes: 25, plays: 345 });
    const plays = readCreatorOperatingView(db, { view: 'works', sort: 'plays', direction: 'desc', pageSize: 1 });
    assert.equal(plays.items[0].contentId, id);
    assert.equal(plays.items[0].latestPlays, 345);
    assert.equal(plays.items[0].cumulativePlays, null);
    const likes = readCreatorOperatingView(db, { view: 'works', sort: 'likes', direction: 'desc', pageSize: 1 });
    assert.equal(likes.items[0].contentId, id);
    assert.equal(likes.items[0].latestLikes, 25);
    assert.equal(likes.items[0].cumulativeLikes, null);
    const sourceOnly = readCreatorOperatingView(db, { view: 'works', q: '333', sort: 'plays' });
    assert.equal(sourceOnly.items[0].latestPlays, 200);
    assert.match(plays.semantics.sorting, /列表采用值/);
  } finally { db.close(); }
});

test('平台独有作品必须严格身份匹配；未来作品和未来指标不得混入截止时间视图', () => {
  const db = fixture();
  try {
    platformFixture(db);
    const valid = '7300000000000000003', wrong = '7300000000000000004';
    const future = '7300000000000000005', unlinked = '7300000000000000006';
    addPlatformWork(db, { id: valid, postId: 102, firstSeenAt: '2026-10-20T07:00:00Z',
      publishedAt: '2026-10-20T06:00:00Z', metricAt: '2026-10-20T07:30:00Z', likes: 8, plays: 200 });
    db.prepare('INSERT INTO post_metrics(post_id,captured_at,likes,plays) VALUES(?,?,?,?)')
      .run(102, '2026-10-20T09:00:00Z', 10, 300);
    addPlatformWork(db, { id: wrong, postId: 103, rawAuthor: 'wrong-canonical-author' });
    addPlatformWork(db, { id: future, postId: 104, firstSeenAt: '2026-10-20T09:00:00Z',
      publishedAt: '2026-10-20T09:00:00Z', metricAt: '2026-10-20T09:10:00Z' });
    db.prepare('INSERT INTO targets VALUES(20,?,?,?,?)')
      .run('account', 'public-web', 'https://www.douyin.com/user/MS4wLjABAAAA' + 'b'.repeat(40),
        targetMetadata('unlinked_handle'));
    addPlatformWork(db, { id: unlinked, postId: 105, targetId: 20, authorId: 'MS4wLjABAAAA' + 'b'.repeat(40) });
    const at = readCreatorOperatingView(db, { view: 'works', asOf: '2026-10-20T08:00:00Z' });
    assert.equal(at.summary.platformOnlyWorks, 1);
    const item = at.items.find(row => row.contentId === valid);
    assert.ok(item);
    assert.equal(item.latestLikes, 8);
    assert.equal(item.latestPlays, 200);
    assert.equal(item.comparison.likes, null);
    assert.equal(at.items.some(row => [wrong, future, unlinked].includes(row.contentId)), false);
    const later = readCreatorOperatingView(db, { view: 'works', asOf: '2026-10-20T10:00:00Z' });
    assert.equal(later.summary.platformOnlyWorks, 2);
    assert.equal(later.items.find(row => row.contentId === valid).latestLikes, 10);
    assert.equal(later.items.find(row => row.contentId === valid).comparison.likes.delta, 2);
    assert.equal(readCreatorOperatingView(db, { asOf: 'invalid' }).statusCode, 400);
  } finally { db.close(); }
});

test('新作品没有已存观测时保持空值；相同作品ID跨两个严格作者冲突则不自动归属', () => {
  const db = fixture();
  try {
    platformFixture(db);
    const emptyMetrics = '7300000000000000007';
    addPlatformWork(db, { id: emptyMetrics, postId: 102, metricAt: null, publishedAt: null });
    let row = readCreatorOperatingView(db, { view: 'works', q: emptyMetrics }).items[0];
    assert.equal(row.recordOrigin, 'platform-only');
    assert.equal(row.publishedOn, '');
    assert.equal(row.dateSource, 'unknown');
    assert.equal(row.latestPlays, null);
    assert.equal(row.latestLikes, null);
    assert.equal(row.platformLatest, null);
    assert.deepEqual(row.metricOrigin, { likes: 'unavailable', plays: 'unavailable' });
    assert.equal(row.metricProvenance.source, null);
    assert.equal(row.metricProvenance.platform, null);
    const secondSec = 'MS4wLjABAAAA' + 'b'.repeat(40);
    db.prepare('INSERT INTO creator_source_account_links VALUES(1,3,20,?,?)').run('handle_b', '2026-10-20T06:00:00Z');
    db.prepare('INSERT INTO targets VALUES(20,?,?,?,?)').run('account', 'public-web',
      `https://www.douyin.com/user/${secondSec}`, JSON.stringify({ platform: 'douyin', douyinId: 'handle_b',
        identityVerification: { accountId: `https://www.douyin.com/user/${secondSec}` } }));
    addPlatformWork(db, { id: emptyMetrics, postId: 103, targetId: 20, authorId: secondSec,
      rawAuthor: secondSec, metricAt: null });
    assert.equal(readCreatorOperatingView(db, { view: 'works', q: emptyMetrics }).total, 0);
  } finally { db.close(); }
});

test('作品ID相同但作者身份不符不得混入平台值，无时间样本不能形成变化', () => {
  const db = fixture();
  try {
    platformFixture(db);
    db.exec("DELETE FROM post_metrics WHERE id=1");
    let item = readCreatorOperatingView(db, { view: 'works', q: '111' }).items[0];
    assert.equal(item.latestLikes, 9);
    assert.equal(item.comparison.likes, null);
    db.exec("UPDATE posts SET raw_json='{}' WHERE id=101");
    const result = readCreatorOperatingView(db, { view: 'works', q: '111' });
    item = result.items[0];
    assert.equal(item.postId, null);
    assert.equal(item.latestLikes, 4);
    assert.equal(item.latestObservedAt, null);
    assert.equal(item.comparison.likes, null);
    assert.equal(result.reconciliation.knownWorkOverlap, 1);
    assert.equal(result.reconciliation.unconfirmedWorkOverlap, 1);
  } finally { db.close(); }
});

test('已核验账号别名链关联同一作品，不按昵称猜身份', () => {
  const db = fixture();
  try {
    platformFixture(db);
    db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('16', 2, JSON.stringify(['handle_a', 'verified_alias']));
    db.exec("UPDATE creator_source_account_links SET matched_id='verified_alias';");
    db.prepare('UPDATE targets SET metadata_json=? WHERE id=10').run(targetMetadata('verified_alias'));
    const result = readCreatorOperatingView(db, { view: 'works', q: '111' });
    assert.equal(result.items[0].postId, 101);
    assert.equal(result.items[0].latestLikes, 9);
    db.exec("UPDATE creator_source_account_links SET matched_id='unrelated_alias'");
    assert.equal(readCreatorOperatingView(db, { view: 'works', q: '111' }).items[0].postId, null);
  } finally { db.close(); }
});

test('同一来源版本内身份撤销会使缓存失效，冻结链接不再混入平台指标', () => {
  const db = fixture();
  try {
    platformFixture(db);
    assert.equal(readCreatorOperatingView(db, { view: 'works', q: '111' }).items[0].postId, 101);
    db.prepare('UPDATE targets SET metadata_json=? WHERE id=10').run(targetMetadata('different_handle'));
    const revoked = readCreatorOperatingView(db, { view: 'works', q: '111' });
    assert.equal(revoked.items[0].targetId, null);
    assert.equal(revoked.items[0].postId, null);
    assert.equal(revoked.items[0].latestLikes, 4);
    assert.equal(revoked.reconciliation.identityMatchedWorkOverlap, 0);
    assert.equal(readCreatorSourceWorksForTarget(db, 10).items.length, 0);
    db.prepare('UPDATE targets SET metadata_json=? WHERE id=10').run(targetMetadata('handle_a'));
    assert.equal(readCreatorOperatingView(db, { view: 'works', q: '111' }).items[0].postId, 101);
  } finally { db.close(); }
});

test('历史账号详情不会读取截止时间之后才核验的来源关联', () => {
  const db = fixture();
  try {
    db.exec("UPDATE creator_source_account_links SET matched_at='2026-10-20T07:00:00Z'");
    const before = readCreatorSourceWorksForTarget(db, 10, { asOf: '2026-10-20T06:30:00Z' });
    assert.equal(before.available, true);
    assert.deepEqual(before.items, []);
    const after = readCreatorSourceWorksForTarget(db, 10, { asOf: '2026-10-20T07:30:00Z' });
    assert.deepEqual(after.items.map(item => item.contentId), ['111', '222']);
  } finally { db.close(); }
});

test('全量作者和作品进入经营读模型，累计指标按作品ID去重且缺失不补零', () => {
  const db = fixture();
  try {
    const result = readCreatorOperatingView(db);
    assert.equal(result.summary.authors, 4);
    assert.equal(result.summary.works, 4);
    assert.equal(result.summary.cumulativePlays, 300);
    assert.equal(result.summary.cumulativeLikes, 4);
    assert.equal(result.summary.playsKnown, 2);
    assert.equal(result.summary.likesKnown, 2);
    assert.equal(result.summary.duplicateWorkRowsExcluded, 1);
    assert.equal(result.summary.unassignedWorks, 1);
    assert.deepEqual(result.classificationCoverage, { authors: 4, withWorkCategory: 3,
      registrationOnly: 0, withoutExplicitCategory: 1 });
    assert.equal(result.source.refreshedAt, '2026-10-20T04:00:00Z');
    assert.equal(result.items.find(item => item.accountId === 'handle_c').cumulativePlays, null);
    assert.equal(JSON.stringify(result).includes('private-prize'), false);
    assert.equal(JSON.stringify(result).includes('private-bonus'), false);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM creator_source_rows').get().count, 11);
  } finally { db.close(); }
});

test('跨赛道筛选保留成员但作品不重复求和，切片零作品作者也可找到', () => {
  const db = fixture();
  try {
    const slice = readCreatorOperatingView(db, { classification: 'slice' });
    assert.equal(slice.summary.authors, 2);
    assert.equal(slice.summary.works, 2);
    assert.equal(slice.summary.cumulativePlays, 100);
    const ai = readCreatorOperatingView(db, { classification: 'ai-remix' });
    assert.equal(ai.summary.works, 1);
    assert.equal(ai.summary.cumulativePlays, 100);
    const empty = readCreatorOperatingView(db, { theme: 'laofeiyu' });
    assert.equal(empty.summary.works, 0);
    assert.equal(empty.summary.cumulativePlays, null);
    assert.equal(empty.globalSummary.works, 4);
    for (const board of ['__unassigned__', '玉麒麟切片矩阵', '抖音主播板块']) {
      const result = readCreatorOperatingView(db, { board });
      assert.equal(result.summary.works, 0);
      assert.equal(result.query.board, board);
    }
    assert.equal(readCreatorOperatingView(db, { board: '一条小团团切片矩阵' }).summary.works, 4);
  } finally { db.close(); }
});

test('作者登记字段自动索引零作品作者，但不把登记类型当成已有作品', () => {
  const db = fixture();
  try {
    db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('08', 6,
      JSON.stringify(['登记作者', 'handle_d', '', '', 0, 0, 0, 0, 0, 0, 0]));
    db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('11', 2,
      JSON.stringify(['rec_d', 'slice_registry', '登记作者', 'handle_d', null, null, '切片、创作（手书）、AI']));
    const ai = readCreatorOperatingView(db, { classification: 'ai-remix', view: 'authors' });
    const author = ai.items.find(item => item.accountId === 'handle_d');
    assert.ok(author);
    assert.equal(author.works, 0);
    assert.deepEqual(author.workClassifications, []);
    assert.deepEqual(author.registeredClassifications, ['slice', 'original', 'ai-remix']);
    assert.deepEqual(author.registrationEvidence.map(item => item.recordId), ['rec_d']);
    assert.deepEqual(ai.classificationCoverage, { authors: 5, withWorkCategory: 3,
      registrationOnly: 1, withoutExplicitCategory: 1 });
    assert.equal(ai.summary.works, 1, '登记类型不能增加已有作品的数量');
    const slice = readCreatorOperatingView(db, { classification: 'slice', view: 'authors' });
    assert.equal(slice.items.some(item => item.accountId === 'handle_d'), true);
  } finally { db.close(); }
  assert.deepEqual(registeredContentTypes('ai_registry', null), ['ai-remix']);
  assert.deepEqual(registeredContentTypes('slice_registry', '切片二创 ai原创'), ['slice', 'ai-remix']);
  assert.deepEqual(registeredContentTypes('unknown', '切片'), []);
});

test('来源主赛道筛选与跨赛道包含筛选分开，卡片数量与钻取结果一致', () => {
  const db = fixture();
  try {
    const inclusiveAi = readCreatorOperatingView(db, { classification: 'ai-remix', view: 'works' });
    assert.equal(inclusiveAi.summary.works, 1, '跨赛道收录可查到切片主归属作品');
    const primaryAi = readCreatorOperatingView(db, { classification: 'ai-remix', primaryTrack: 'ai-remix', view: 'works' });
    assert.equal(primaryAi.summary.works, 0, '主赛道统计不能把跨赛道收录重复算入');
    const primarySlice = readCreatorOperatingView(db, { classification: 'slice', primaryTrack: 'slice', view: 'works' });
    assert.equal(primarySlice.summary.works, 2);
    assert.deepEqual(primarySlice.items.map(item => item.contentId).sort(), ['111', '222']);
  } finally { db.close(); }
});

test('作品日期筛选只得到该批作品累计值，没有伪造观测日或每日增长', () => {
  const db = fixture();
  try {
    const result = readCreatorOperatingView(db, { start: '2026-10-12', end: '2026-10-12', view: 'works' });
    assert.equal(result.summary.works, 2);
    assert.equal(result.summary.authors, 2);
    assert.equal(result.summary.cumulativePlays, 200);
    assert.deepEqual(result.daily.map(day => day.day), ['2026-10-12']);
    assert.equal(result.items[0].publishedOn, '2026-10-12');
    assert.equal(result.items[0].dateSource, 'source_inferred_publication_date');
    assert.equal('dailyGrowth' in result, false);
    assert.match(result.semantics.date, /不代表该日/);
    for (const start of ['2026-99-99', '2026-02-30', 'x']) assert.equal(readCreatorOperatingView(db, { start }).statusCode, 400);
    assert.equal(readCreatorOperatingView(db, { start: '2026-10-12', end: '2026-09-12' }).statusCode, 400);
  } finally { db.close(); }
});

test('作者搜索与精确作者跳转、排序分页保持正确身份，缺测排最后', () => {
  const db = fixture();
  try {
    const author = readCreatorOperatingView(db, { q: 'old_a' });
    assert.equal(author.summary.authors, 1);
    assert.equal(author.summary.works, 2);
    const works = readCreatorOperatingView(db, { view: 'works', authorKey: author.items[0].key, sort: 'plays', direction: 'asc', pageSize: 1 });
    assert.equal(works.items[0].contentId, '111');
    assert.equal(works.total, 2);
    const next = readCreatorOperatingView(db, { view: 'works', authorKey: author.items[0].key, sort: 'plays', direction: 'asc', pageSize: 1, page: 2 });
    assert.equal(next.items[0].contentId, '222');
    assert.equal(next.items[0].cumulativePlays, null);
    const none = readCreatorOperatingView(db, { q: "%' OR 1=1 --" });
    assert.equal(none.total, 0);
  } finally { db.close(); }
});

test('账号详情只取得严格作品关联，返回行号/原来源且缓存不可被调用方篡改', () => {
  const db = fixture();
  try {
    const result = readCreatorSourceWorksForTarget(db, 10);
    assert.deepEqual(result.items.map(item => item.contentId), ['111', '222']);
    assert.equal(result.items[0].sourceReferences[0].row, 2);
    assert.equal(result.items[0].sourceReferences[1].recordId, 'rec_1');
    assert.equal(result.items[0].sourceReferences[1].url, 'https://feishu.cn/base/registry');
    result.items[0].tracks.push('污染');
    result.items[0].sourceReferences[0].url = '污染';
    const repeated = readCreatorSourceWorksForTarget(db, 10);
    assert.equal(repeated.items[0].tracks.includes('污染'), false);
    assert.equal(repeated.items[0].sourceReferences[0].url.includes('污染'), false);
    assert.equal(readCreatorSourceWorksForTarget(db, 999).items.length, 0);
    assert.equal(readCreatorSourceWorksForTarget(db, 10, { asOf: '2026-10-20T05:00:00Z' }).available, false);
  } finally { db.close(); }
});

test('固定历史asOf只读取当时已入库版本，后续导入不会使历史页漂移', () => {
  const db = fixture();
  try {
    db.exec(`INSERT INTO creator_source_imports VALUES(2,'sha2','https://feishu.cn/sheets/source','18','2026-10-22T04:00:00Z','2026-10-22T06:00:00Z',
      '{"audit":{"sourceRefreshedAt":"2026-10-22T04:00:00Z"}}');
      INSERT INTO creator_source_rows VALUES(2,'08',2,'["作者","handle_a"]');
      INSERT INTO creator_source_rows VALUES(2,'09',2,'["999","作者","handle_a","2026-10-12","video","切片激励","切片激励",800,20]');
      INSERT INTO creator_source_account_links VALUES(2,2,10,'handle_a','2026-10-22T06:00:00Z');
      INSERT INTO creator_source_work_links VALUES(2,2,10);`);
    const latest = readCreatorSourceWorksForTarget(db, 10);
    assert.equal(latest.source.importId, 2);
    assert.deepEqual(latest.items.map(item => item.contentId), ['999']);
    assert.deepEqual(latest.source.period, { start: '2026-10-12', end: '2026-10-12' });
    const old = readCreatorSourceWorksForTarget(db, 10, { asOf: '2026-10-21T00:00:00Z' });
    assert.equal(old.source.importId, 1);
    assert.deepEqual(old.items.map(item => item.contentId), ['111', '222']);
  } finally { db.close(); }
});
