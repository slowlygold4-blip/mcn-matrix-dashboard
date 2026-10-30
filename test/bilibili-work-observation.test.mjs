import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {MonitorDatabase} from '../lib/database.mjs';
import {normalizeCollection} from '../lib/providers/normalize.mjs';
import {bilibiliWorkObservation} from '../lib/bilibili-work-observation.mjs';
import {dailyStoredWorkLikes} from '../lib/collection-platform-progress.mjs';
import {checksum} from '../lib/utils.mjs';

const target={id:1,type:'account',label:'时钟验收',provider:'public-web',locator:'525138167',metadata:{platform:'bilibili'}};
const before='2026-10-28T15:59:59.000Z',after='2026-10-28T16:00:01.000Z',completed='2026-10-28T16:00:02.000Z';
function fixture(){
 const works=['BV1fi416bEpi','BV1H5sf6NEP6'].map((aweme_id,i)=>({aweme_id,author:{uid:target.locator},create_time:1789250000,statistics:{digg_count:i?0:10}}));
 return {capturedAt:completed,profile:{user:{uid:target.locator,follower_count:2,total_favorited:15,aweme_count:2}},works:{aweme_list:works},
  provenance:{mode:'bilibili-public-card-relation-wbi-view'},workObservationTimes:{version:1,transport:'bilibili-official-http',startedAt:'2026-10-28T15:59:57.000Z',completedAt:completed,
   observations:works.map((w,i)=>({contentId:w.aweme_id,observedAt:i?after:before,source:'view'}))}};
}
const normalized=raw=>normalizeCollection(target,raw,{capturedAt:raw.capturedAt});
test('individual responses retain Beijing dates when an account collection crosses midnight',()=>{
 const x=bilibiliWorkObservation(target,normalized(fixture()),{reference:Date.parse(completed)});
 assert.deepEqual([...x.postTimes.values()],[before,after]);assert.equal(x.observedAt,after);
 assert.equal(bilibiliWorkObservation(target,{raw:{}}),null,'legacy is retained without invented per-work dates');
 assert.ok(bilibiliWorkObservation({...target,locator:'https://space.bilibili.com/525138167'},normalized(fixture())));
});
test('declared clocks, owner, source and metrics cannot silently fall back on invalid evidence',()=>{
 for(const mutate of [r=>r.workObservationTimes.observations.pop(),r=>r.workObservationTimes.observations[1].contentId=r.workObservationTimes.observations[0].contentId,
  r=>r.workObservationTimes.observations[0].observedAt='2026-10-28T15:59:59',r=>r.workObservationTimes.observations[0].observedAt='2026-10-28T15:59:56.000Z',
  r=>r.workObservationTimes.observations[0].observedAt='2026-10-28T16:00:03.000Z',r=>r.works.aweme_list[0].author.uid='99999',
  r=>r.workObservationTimes.observations[0].source='list',r=>r.workObservationTimes.transport='browser',r=>r.capturedAt='2026-10-28T16:00:03.000Z',
  r=>r.workObservationTimes.observations[0]=null,r=>r.works.aweme_list[0]=null,r=>r.codexObservation={source:'manual-import'}]){
  const raw=fixture();mutate(raw);assert.throws(()=>bilibiliWorkObservation(target,normalized(raw)),{code:'BILIBILI_WORK_OBSERVATION_INVALID'});
 }
 const x=normalized(fixture());x.posts[0].likes=999;assert.throws(()=>bilibiliWorkObservation(target,x));
 assert.throws(()=>bilibiliWorkObservation({...target,metadata:{platform:'douyin'}},normalized(fixture())));
 const y=normalized(fixture());y.sourceChecksum='stale';assert.throws(()=>bilibiliWorkObservation(target,y));
});
test('actual Python detail response must echo the exact requested work and author before adopting likes',()=>{
 const script=String.raw`
import importlib.util,json,sys
s=importlib.util.spec_from_file_location('collector',sys.argv[1]);c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
c.bili_opener=lambda:object();out=[]
for bvid,mid in [('BV1H5sf6NEP6','525138167'),(None,'525138167'),('BV1fi416bEpi','99999')]:
 def request(o,url):
  if '/card?' in url:return {'data':{'card':{'mid':'525138167','fans':2},'like_num':15}}
  if '/navnum?' in url:return {'data':{'video':3}}
  return {'data':{'bvid':bvid,'owner':{'mid':mid},'stat':{'like':999999}}}
 c.bili_json=request;c.bili_latest_videos=lambda *a,**k:[{'bvid':'BV1fi416bEpi'}]
 r=c.collect_bilibili_account('525138167',30);out.append(r)
print(json.dumps(out))
`;
 const child=spawnSync('/usr/bin/python3',['-B','-c',script,fileURLToPath(new URL('../scripts/douyin_public_collector.py',import.meta.url))],{encoding:'utf8',timeout:10000});
 assert.equal(child.status,0,child.stderr);
 for(const raw of JSON.parse(child.stdout)){
  assert.deepEqual(raw.works.aweme_list,[]);assert.deepEqual(raw.workObservationTimes.observations,[]);
  assert.match(raw.warnings.join(' '),/作品 ID 或作者 UID 不一致/);
  assert.equal(normalized(raw).snapshot.totalLikes,15,'profile total is independent');
 }
});
test('SQLite persistence and daily counters use per-work response times, leave old records unchanged and roll back malformed evidence',t=>{
 const database=new MonitorDatabase(':memory:');t.after(()=>database.close());
 const account=database.createTarget(target),run=database.beginRun('test',account.id,1),raw=fixture();
 database.saveCollection(account,run,normalizeCollection(account,raw,{capturedAt:raw.capturedAt}));
 const rows=database.db.prepare('SELECT p.external_id,m.captured_at,m.likes FROM posts p JOIN post_metrics m ON m.post_id=p.id ORDER BY m.captured_at').all();
 assert.deepEqual(rows.map(r=>[r.captured_at,r.likes]),[[before,10],[after,0]]);
 assert.equal(database.db.prepare('SELECT works_observed_at FROM snapshots').get().works_observed_at,after);
 const enabled=[{id:account.id,type:'account',platform:'bilibili'}];
 assert.equal(dailyStoredWorkLikes(database.db,enabled,completed).platforms[0].observedWorks,1);
 assert.equal(dailyStoredWorkLikes(database.db,enabled,before).platforms[0].observedWorks,1);
 const original=JSON.stringify(rows),bad=fixture();bad.workObservationTimes.observations[0].observedAt='2026-10-27T00:00:00.000Z';
 assert.throws(()=>database.saveCollection(account,run,normalizeCollection(account,bad,{capturedAt:bad.capturedAt})));
 assert.equal(JSON.stringify(database.db.prepare('SELECT p.external_id,m.captured_at,m.likes FROM posts p JOIN post_metrics m ON m.post_id=p.id ORDER BY m.captured_at').all()),original);
 assert.equal(database.db.prepare('SELECT COUNT(*) n FROM snapshots').get().n,1);
 assert.equal(database.db.prepare('SELECT source_checksum FROM snapshots').get().source_checksum,checksum(raw));
});
test('actual Python collector captures response clocks, deduplicates references and retains list-only missing likes without extra API calls',()=>{
 const script=String.raw`
import importlib.util,json,sys
s=importlib.util.spec_from_file_location('collector',sys.argv[1]);c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
clock=iter(['2026-10-28T15:59:57.000Z','2026-10-28T15:59:58.000Z','2026-10-28T15:59:59.000Z','2026-10-28T16:00:01.000Z','2026-10-28T16:00:02.000Z'])
c.observation_timestamp=lambda:next(clock);c.bili_opener=lambda:object();calls=[]
def request(o,url):
 calls.append(url)
 if '/card?' in url:return {'data':{'card':{'mid':'525138167','fans':2},'like_num':15}}
 if '/navnum?' in url:return {'data':{'video':3}}
 if 'BV1fi416bEpi' in url:return {'data':{'bvid':'BV1fi416bEpi','owner':{'mid':'525138167'},'stat':{'like':10}}}
 if 'BV1H5sf6NEP6' in url:return {'data':{'bvid':'BV1H5sf6NEP6','owner':{'mid':'525138167'},'stat':{'like':0}}}
 raise c.CollectorError('fixture')
c.bili_json=request
c.bili_latest_videos=lambda *a,**k:[{'bvid':b} for b in ['BV1fi416bEpi','BV1fi416bEpi','BV1H5sf6NEP6','BV1xx416bEpi']]
r=c.collect_bilibili_account('525138167',30);print(json.dumps({'raw':r,'calls':len(calls)}))
`;
 const child=spawnSync('/usr/bin/python3',['-B','-c',script,fileURLToPath(new URL('../scripts/douyin_public_collector.py',import.meta.url))],{encoding:'utf8',timeout:10000});
 assert.equal(child.status,0,child.stderr);const x=JSON.parse(child.stdout);
 assert.equal(x.calls,5,'card, inventory, and one detail per unique work');
 const observation=bilibiliWorkObservation(target,normalized(x.raw));
 assert.deepEqual([...observation.postTimes.values()],[before,after,'2026-10-28T15:59:58.000Z']);
 assert.equal(x.raw.works.aweme_list[2].statistics.digg_count,undefined);
});
