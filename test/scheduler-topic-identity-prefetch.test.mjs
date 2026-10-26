import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MonitorDatabase } from '../lib/database.mjs';
import { MonitorScheduler } from '../lib/scheduler.mjs';
import { checksum } from '../lib/utils.mjs';

function fixture(t, mode='browser-first') {
 const dir=mkdtempSync(join(tmpdir(),'topic-identity-prefetch-'));
 const database=new MonitorDatabase(join(dir,'fixture.sqlite'));
 t.after(()=>{database.close();rmSync(dir,{recursive:true,force:true});});
 const calls=[];
 const scheduler=new MonitorScheduler(database,{providerOptions:{topicResolverMode:mode,
  execFileImpl(_file,_args,_options,callback){return {stdin:{end(input){calls.push(JSON.parse(input).labels);queueMicrotask(()=>callback(null,JSON.stringify({ok:true,data:{items:[]}}),''));}}};}
 }});
 function topic(name,cid=null) {
  const target=database.createTarget({type:'hashtag',provider:'public-web',label:'#'+name,locator:'#'+name});
  if(cid)seed(target,cid);return target;
 }
 function seed(target,cid,sampledAt='2026-09-21T02:01:00.000Z') {
  const raw={scope:'douyin-official-challenge-detail',challengeId:cid,label:target.locator.slice(1),officialName:target.locator.slice(1),participants:10,views:100,
   provenance:{mode:'douyin-official-anonymous-challenge-detail',endpoint:'https://www.douyin.com/aweme/v1/web/challenge/detail/',authenticated:false,runtimeAI:false,paidAPI:false}};
  const sum=checksum(raw),runId=database.beginRun('scheduled',target.id,1);
  database.db.prepare("UPDATE runs SET started_at='2026-09-21T02:00:00.000Z',finished_at='2026-09-21T02:02:00.000Z',status='success' WHERE id=?").run(runId);
  database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,hashtag_participants,hashtag_views,quality_status,source_checksum,raw_json)
   VALUES(?,?,10,100,'validated',?,?)`).run(target.id,sampledAt,sum,JSON.stringify(raw));
  database.db.prepare(`INSERT INTO audits(target_id,run_id,created_at,provider,status,source_checksum,message)
   VALUES(?,?,'2026-09-21T02:01:30.000Z','public-web','validated',?,'fixture')`).run(target.id,runId,sum);
 }
 return {database,scheduler,calls,topic,seed};
}

test('verified topic identity bypasses browser prefetch without claiming a fresh sample',async t=>{
 const f=fixture(t),known=f.topic('已核验话题','7682403649834485803');
 const before=f.database.db.prepare('SELECT count(*) n FROM snapshots').get().n;
 assert.equal(await f.scheduler.prepareTopicBrowserBatch([known],{}),null);
 assert.deepEqual(f.calls,[]);assert.equal(f.database.db.prepare('SELECT count(*) n FROM snapshots').get().n,before);
});

test('mixed topic batch searches only unverified labels and never accounts',async t=>{
 const f=fixture(t),known=f.topic('已核验话题','7682403649834485803'),unknown=f.topic('新话题');
 const account=f.database.createTarget({type:'account',provider:'public-web',label:'账号',locator:'MS4wLjABtestPrefetch'});
 const result=await f.scheduler.prepareTopicBrowserBatch([known,unknown,account],{});
 assert.deepEqual(f.calls,[['新话题']]);assert.deepEqual([...result.keys()],['新话题']);
});

test('tampered historical identity is not allowed to suppress normal discovery',async t=>{
 const f=fixture(t),target=f.topic('校验话题','7682403649834485803');
 f.database.db.prepare("UPDATE snapshots SET raw_json=json_set(raw_json,'$.challengeId','8888888888888888888') WHERE target_id=?").run(target.id);
 await f.scheduler.prepareTopicBrowserBatch([target],{});assert.deepEqual(f.calls,[['校验话题']]);
});

test('public mode never starts browser prefetch even without identity history',async t=>{
 const f=fixture(t,'public'),target=f.topic('公开话题');assert.equal(await f.scheduler.prepareTopicBrowserBatch([target],{}),null);assert.deepEqual(f.calls,[]);
});

test('conflicting verified topic identities also stop browser prefetch',async t=>{
 const f=fixture(t),target=f.topic('冲突话题','7682403649834485803');
 f.seed(target,'8888888888888888888','2026-09-21T02:01:01.000Z');
 assert.equal(await f.scheduler.prepareTopicBrowserBatch([target],{}),null);
 assert.deepEqual(f.calls,[]);
});
