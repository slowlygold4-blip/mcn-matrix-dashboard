import test from 'node:test';
import assert from 'node:assert/strict';
import {MonitorDatabase} from '../lib/database.mjs';
import {normalizeCollection} from '../lib/providers/normalize.mjs';
import {normalizeRemoteWorkPage,recordRemoteWorkPage} from '../lib/remote-work-observation.mjs';
import {collectionProgress} from '../lib/collection-progress.mjs';
import {readRemoteWorkCoverage} from '../lib/remote-work-coverage.mjs';

const SEC='MS4wLjABAAAARemoteWorkFixture1234567',UID='123456789';
const START='2026-11-02T15:59:57.000Z',END='2026-11-02T16:00:03.000Z';
function fixture(t){
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-02T15:59:00.000Z')});
 const database=new MonitorDatabase(':memory:');t.after(()=>database.close());
 const target=database.createTarget({type:'account',label:'fixture',provider:'public-web',locator:SEC});
 const at=new Date().toISOString(),raw={capturedAt:at,accountStatus:'validated',accountError:null,
  profile:{user:{sec_uid:SEC,uid:UID,follower_count:12,total_favorited:33,aweme_count:3}},
  worksCoverage:'unavailable',worksErrorCode:'deferred',works:{stopReason:'request-deferred',pagination:{requestCount:0,pages:[]}},
  provenance:{mode:'guest-ttwid-unsigned-profile',profileMode:'guest-ttwid-unsigned-profile',
   profileEndpoint:'https://www.douyin.com/aweme/v1/web/user/profile/other/',accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false}};
 database.saveCollection(target,null,normalizeCollection(target,raw,{capturedAt:at}));
 t.mock.timers.setTime(Date.parse(END));
 const item=(id,at,likes)=>({content_id:id,platform:'douyin',created_at:'2026-11-01T04:00:00Z',fetched_at:at,
  author:{sec_uid:SEC,uid:SEC,nickname:'fixture'},is_deleted:false,is_private:false,stats:{digg_count:likes,play_count:987654}});
 const receipt={source:'https://demo.douyin.wtf',httpStatus:200,requestStartedAt:START,requestFinishedAt:END,
  meta:{endpoint:'douyin.author_posts',cached:false,request_id:'fixture-request'},
  data:{has_more:false,cursor:null,items:[item('7300000000000000001','2026-11-02T15:59:59.123456Z',0),item('7300000000000000002','2026-11-02T16:00:01.000001Z',11)]}};
 const db=database.db,input={targetId:target.id,receipt};
 return {db,database,target,input,save:()=>recordRemoteWorkPage(db,input),anchor:{secUid:SEC,uid:UID}};
}
const protectedRows=db=>JSON.stringify(['targets','snapshots','audits'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()));

test('real SQL append preserves per-work observation days, true zero and profile totals; replay is idempotent',t=>{
 const f=fixture(t),before=protectedRows(f.db);
 assert.deepEqual(f.save(),{duplicate:false,postCount:2,observedAt:'2026-11-02T16:00:01.000Z',coverage:'limited'});
 assert.equal(f.save().duplicate,true);assert.equal(protectedRows(f.db),before);
 const rows=f.db.prepare('SELECT p.external_id,m.captured_at,m.likes,m.plays FROM posts p JOIN post_metrics m ON m.post_id=p.id ORDER BY p.external_id').all();
 assert.deepEqual(rows.map(r=>[r.external_id,r.captured_at,r.likes,r.plays]),[
  ['7300000000000000001','2026-11-02T15:59:59.123Z',0,null],['7300000000000000002','2026-11-02T16:00:01.000Z',11,null]]);
 const event=JSON.parse(f.db.prepare("SELECT event_json FROM account_events WHERE event_type='remote-work-observation'").get().event_json);
 assert.equal(event.reportedHasMore,false);assert.equal(event.coverage,'limited');
 assert.equal(event.dailyPublicationCountConfirmed,false);assert.equal(event.automaticCollectionEnabled,false);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM post_metrics').get().n,2);
});

test('rejects wrong source, identity, unavailable stats, cached or invalid clocks without partial writes',async t=>{
 const cases=[
  ['unapproved source',r=>{r.source='https://unapproved.invalid';}],
  ['failed HTTP',r=>{r.httpStatus=503;}],
  ['wrong endpoint',r=>{r.meta.endpoint='douyin.author_likes';}],
  ['cached body',r=>{r.meta.cached=true;}],
  ['author mismatch',r=>{r.data.items[1].author.sec_uid='MS4wLjABAAAADifferentAuthor12345';}],
  ['numeric UID conflict',r=>{r.data.items[1].author.uid='999999999';}],
  ['missing likes',r=>{r.data.items[1].stats.digg_count=null;}],
  ['bad counter',r=>{r.data.items[1].stats.digg_count=true;}],
  ['future observation',r=>{r.data.items[1].fetched_at='2026-11-02T16:00:04Z';}],
  ['invented date',r=>{r.data.items[0].created_at='2026-02-30T00:00:00Z';}],
  ['future publication',r=>{r.data.items[0].created_at='2026-12-01T00:00:00Z';}],
  ['private content',r=>{r.data.items[1].is_private=true;}],
  ['no pagination evidence',r=>{delete r.data.has_more;}],
 ];
 for(const [name,mutate]of cases)await t.test(name,st=>{
  const f=fixture(st),before=protectedRows(f.db);mutate(f.input.receipt);
  assert.throws(f.save,{code:'REMOTE_WORK_OBSERVATION_INVALID'});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM posts').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM account_events').get().n,0);
  assert.equal(protectedRows(f.db),before);
 });
});

test('credentials and media fields are excluded; missing publication time is not replaced by fetch time',t=>{
 const f=fixture(t),r=f.input.receipt;r.Cookie='SECRET';r.meta.Authorization='SECRET';
 r.data.items[0].headers={cookie:'SECRET'};r.data.items[0].media={url:'SECRET'};r.data.items[0].created_at=null;
 const normalized=normalizeRemoteWorkPage(r,f.anchor);
 assert.equal(normalized.posts[0].publishedAt,null);
 f.save();
 assert.equal(JSON.stringify(f.db.prepare('SELECT raw_json FROM posts').all()).includes('SECRET'),false);
 assert.equal(JSON.stringify(f.db.prepare('SELECT raw_json,event_json FROM account_events').all()).includes('SECRET'),false);
});

test('exact duplicate rows collapse; conflicting duplicate metrics reject the whole page',t=>{
 const f=fixture(t),r=f.input.receipt;r.data.items.push(structuredClone(r.data.items[0]));
 assert.equal(normalizeRemoteWorkPage(r,f.anchor).posts.length,2);
 r.data.items.at(-1).stats.digg_count=99;
 assert.throws(f.save,{code:'REMOTE_WORK_OBSERVATION_INVALID'});
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM post_metrics').get().n,0);
});

test('paused target and an outer transaction cannot be silently overwritten',t=>{
 const f=fixture(t);f.db.prepare('UPDATE targets SET enabled=0').run();assert.throws(f.save);
 f.db.prepare('UPDATE targets SET enabled=1').run();f.db.exec('BEGIN');
 f.db.prepare("UPDATE targets SET label='retained' WHERE id=?").run(f.target.id);
 assert.throws(f.save);assert.equal(f.db.prepare('SELECT label FROM targets').get().label,'retained');f.db.exec('ROLLBACK');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM posts').get().n,0);
});

test('same receipt with different facts fails atomically and preserves the accepted history',t=>{
 const f=fixture(t);f.save();f.input.receipt.data.items[0].stats.digg_count=88;
 assert.throws(f.save,{code:'REMOTE_WORK_OBSERVATION_INVALID'});
 assert.equal(f.db.prepare('SELECT likes FROM post_metrics ORDER BY post_id').get().likes,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM account_events').get().n,1);
});

test('operator-approved HTTPS origin is required independently of receipt data and keeps transactional deduplication',t=>{
 const f=fixture(t),origin='https://reviewed-service.example';
 f.input.receipt.source=origin;
 // An uploaded receipt cannot approve its own source, including via extra keys.
 f.input.sourceOrigin=origin;f.input.receipt.sourceOrigin=origin;
 assert.throws(f.save,{code:'REMOTE_WORK_OBSERVATION_INVALID'});
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM post_metrics').get().n,0);
 const save=()=>recordRemoteWorkPage(f.db,f.input,{sourceOrigin:origin});
 assert.equal(save().duplicate,false);assert.equal(save().duplicate,true);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM post_metrics').get().n,2);
 const event=JSON.parse(f.db.prepare("SELECT raw_json FROM account_events WHERE event_type='remote-work-observation'").get().raw_json);
 assert.equal(event.source,origin);assert.equal(event.automaticCollectionEnabled,false);
 assert.equal(event.coverage,'limited');assert.equal(event.dailyPublicationCountConfirmed,false);
 f.input.receipt.source='https://another-service.example';
 assert.throws(save,{code:'REMOTE_WORK_OBSERVATION_INVALID'});
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM post_metrics').get().n,2);
});

test('approved source is a canonical HTTPS origin, never credentials, paths, query strings or normalized lookalikes',t=>{
 const f=fixture(t);
 for(const sourceOrigin of [null,7,'http://reviewed-service.example','https://user:password@reviewed-service.example',
  'https://reviewed-service.example/path','https://reviewed-service.example?token=SECRET',
  'https://reviewed-service.example#fragment','https://reviewed-service.example:8443',
  'https://reviewed-service.example:443','https://reviewed-service.example/',
  'https://REVIEWED-service.example',' https://reviewed-service.example']){
  assert.throws(()=>recordRemoteWorkPage(f.db,f.input,{sourceOrigin}),{code:'REMOTE_WORK_OBSERVATION_INVALID'});
 }
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM posts').get().n,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM account_events').get().n,0);
});

test('explicit original origin is byte-identical to legacy evidence and replays the accepted receipt',t=>{
 const f=fixture(t);
 const legacy=normalizeRemoteWorkPage(f.input.receipt,f.anchor);
 const explicit=normalizeRemoteWorkPage(f.input.receipt,f.anchor,{sourceOrigin:'https://demo.douyin.wtf'});
 assert.deepEqual(explicit,legacy);
 f.save();
 assert.equal(recordRemoteWorkPage(f.db,f.input,{sourceOrigin:'https://demo.douyin.wtf'}).duplicate,true);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM account_events').get().n,1);
});

test('committed standalone HTTP samples count as limited coverage without fabricating a profile run',t=>{
 const f=fixture(t);f.save();
 const before=f.db.prepare('SELECT total_changes() n').get().n;
 const progress=collectionProgress(f.db,{now:END});
 assert.equal(progress.rolling.worksLimited,1);
 assert.equal(progress.rolling.worksComplete,0);
 assert.equal(progress.rolling.profiles,0);
 assert.equal(progress.rolling.attempted,1);
 assert.equal(progress.rolling.platforms[0].worksLimited,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM runs').get().n,0);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
});

test('rolling HTTP coverage requires committed source, anchor, current identity and every stored metric vector',async t=>{
 const cases=[
  ['invalid source digest',db=>db.prepare("UPDATE account_events SET source_checksum='wrong' WHERE event_type='remote-work-observation'").run()],
  ['missing metric',db=>db.prepare('DELETE FROM post_metrics WHERE id=(SELECT MAX(id) FROM post_metrics)').run()],
  ['changed metric',db=>db.prepare('UPDATE post_metrics SET likes=likes+1').run()],
  ['changed metric scope',db=>db.prepare('UPDATE post_metrics SET comments=123').run()],
  ['future commit',db=>db.prepare("UPDATE account_events SET created_at='2026-11-02T16:00:04.000Z' WHERE event_type='remote-work-observation'").run()],
  ['paused target',db=>db.prepare('UPDATE targets SET enabled=0').run()],
  ['changed author',db=>db.prepare("UPDATE posts SET author_id='different'").run()],
  ['changed target locator',db=>db.prepare("UPDATE targets SET locator='MS4wLjABAAAADifferentAuthor12345'").run()],
  ['changed platform',db=>db.prepare('UPDATE targets SET metadata_json=?').run(JSON.stringify({platform:'bilibili'}))],
  ['anchor proof changed',db=>db.prepare("UPDATE snapshots SET raw_json='{}'").run()],
  ['anchor audit rejected',db=>db.prepare("UPDATE audits SET status='rejected'").run()],
  ['invalid event container',db=>db.prepare("UPDATE account_events SET event_json='null' WHERE event_type='remote-work-observation'").run()],
 ];
 for(const [name,mutate]of cases)await t.test(name,st=>{
  const f=fixture(st);f.save();
  const window={since:'2026-11-01T16:00:03.000Z',now:END};
  assert.equal(readRemoteWorkCoverage(f.db,window).length,1);mutate(f.db);
  assert.deepEqual(readRemoteWorkCoverage(f.db,window),[]);
 });
});

test('HTTP coverage is windowed, deduplicates a replay and never upgrades complete evidence',t=>{
 const f=fixture(t);f.save();f.save();
 assert.equal(readRemoteWorkCoverage(f.db,{since:'2026-11-01T16:00:03.000Z',now:END}).length,1);
 assert.deepEqual(readRemoteWorkCoverage(f.db,{since:'2026-11-03T16:00:03.000Z',now:'2026-11-04T16:00:03.000Z'}),[]);
 const run=f.database.beginRun('scheduled',f.target.id,1);
 f.database.finishRun(run,{status:'success',processedCount:1,successCount:1,errorCount:0,warningCount:0,
  details:[{targetId:f.target.id,worksCoverage:'complete'}]});
 const progress=collectionProgress(f.db,{now:END});
 assert.equal(progress.rolling.worksComplete,1);assert.equal(progress.rolling.worksLimited,0);
});
