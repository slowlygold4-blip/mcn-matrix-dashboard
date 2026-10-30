import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createWorkSourcePollReader} from '../lib/work-source-poll.mjs';import {sourceReadContract,sourcePollKey,projectWorkLinkResolution} from '../lib/source-poller-status.mjs';
const source={sourceType:'lark-work-source',sourceUrl:'https://fixture.feishu.cn/sheets/FixtureWorkbook123456',readPolicy:'authorized-work-facts',kind:'work-statistics',defaultBoard:'矩阵'};
const edition={status:'unchanged',contentImported:true,versionId:1,sourceRevision:4,factCount:3,sourceSha256:'a'.repeat(64),sourceReadAt:'2026-10-30T22:00:00.000Z'};
const now=()=>Date.parse('2026-10-30T23:00:00.000Z');
const batch={status:'completed',planned:0,processed:0,resolved:0,failures:0,remaining:0,unresolved:0,coolingDown:0,retryAt:null};
function directory(t){const d=mkdtempSync(join(tmpdir(),'source-auto-links-'));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;}

test('explicit daily opt-in reuses one backup gate and projects only safe batch counters',async t=>{
 const d=directory(t);let backups=0,calls=0;
 const read=createWorkSourcePollReader({dataDirectory:d,now,verifyBackup:async()=>{backups++;return {validated:true};},
  sync:async options=>{await options.beforeCommit();return {...edition,status:'imported'};},
  resolveLinks:async options=>{calls++;assert.equal(options.versionId,1);assert.equal(options.limit,12);await options.beforeCommit();
   return {...batch,planned:1,processed:1,resolved:1,cookie:'must-not-leave-private-adapter'};}});
 const result=await read({...source,resolveWorkLinks:true,workLinkBatchLimit:12});assert.equal(calls,1);assert.equal(backups,1);
 assert.equal(result.workLinkResolution.resolved,1);assert.equal(JSON.stringify(result).includes('must-not'),false);
 assert.equal(result.sourceReadAt,edition.sourceReadAt,'link checking cannot fabricate a new workbook read timestamp');
});

test('unchanged/no pending source does not require a backup, and non-opted sources never resolve links',async t=>{
 const d=directory(t);let calls=0;
 const read=createWorkSourcePollReader({dataDirectory:d,now,sync:async()=>edition,verifyBackup:async()=>{throw Error('unexpected');},
  resolveLinks:async()=>{calls++;return batch;}});
 assert.equal((await read(source)).workLinkResolution,undefined);assert.equal(calls,0);
 assert.equal((await read({...source,resolveWorkLinks:true})).workLinkResolution.processed,0);assert.equal(calls,1);
});

test('invalid policy stops before reading a source; deferred or malformed resolution never looks successful',async t=>{
 const d=directory(t);let reads=0;
 const read=createWorkSourcePollReader({dataDirectory:d,now,sync:async()=>{reads++;return edition;},resolveLinks:async()=>batch});
 for(const extra of [{resolveWorkLinks:'true'},{resolveWorkLinks:true,workLinkBatchLimit:101},{resolveWorkLinks:true,workLinkDelayMs:10}])
  await assert.rejects(read({...source,...extra}),/policy-invalid/);
 assert.equal(reads,0);
 const busy=createWorkSourcePollReader({dataDirectory:d,now,sync:async()=>edition,resolveLinks:async()=>({...batch,status:'deferred'})});
 await assert.rejects(busy({...source,resolveWorkLinks:true}),/job-deferred/);
 const bad=createWorkSourcePollReader({dataDirectory:d,now,sync:async()=>edition,resolveLinks:async()=>({...batch,resolved:1})});
 await assert.rejects(bad({...source,resolveWorkLinks:true}),/receipt-invalid/);
});

test('opt-in changes only its own read contract, keeping its source key and other source contracts',()=>{
 assert.equal(sourcePollKey(source),sourcePollKey({...source,resolveWorkLinks:true}));
 assert.equal(sourceReadContract(source),sourceReadContract({...source,resolveWorkLinks:false}));
 assert.notEqual(sourceReadContract(source),sourceReadContract({...source,resolveWorkLinks:true}));
 assert.notEqual(sourceReadContract({...source,resolveWorkLinks:true}),sourceReadContract({...source,resolveWorkLinks:true,workLinkBatchLimit:12}));
});

test('public status projects source-reference counters without exposing request material or pretending full collection',()=>{
 const good={...batch,version:1,runtimeAI:false,batchLimit:50,checkedAt:new Date(now()).toISOString(),unresolved:1,coolingDown:1,
  retryAt:'2026-10-31T23:00:00.000Z',cookie:'private',url:'https://private.invalid',code:'Bearer private'};
 const result=projectWorkLinkResolution(good);assert.equal(result.unresolved,1);assert.equal(result.code,null);
 assert.equal(JSON.stringify(result).includes('private'),false);
 assert.equal(projectWorkLinkResolution({...good,checkedAt:'2026-02-30T23:00:00.000Z'}),null);
 assert.equal(projectWorkLinkResolution({...good,planned:1,processed:2}),null);
});

test('existing source loop schedules bounded remainder without a new timer or promoting a partial pass to daily success',async t=>{
 const d=directory(t);process.env.DATA_DIR=d;mkdirSync(join(d,'source-poll'));
 const opted={...source,resolveWorkLinks:true};const key=sourcePollKey(opted);
 writeFileSync(join(d,'source-poll','registry.json'),JSON.stringify({sources:[opted]}));
 const previous={key,sourceType:'lark-work-source',sourceUrl:source.sourceUrl,lastStatus:'unchanged',readContract:sourceReadContract(opted),
  workLinkResolution:{...batch,remaining:3,unresolved:3,retryAt:'2026-10-30T22:59:00.000Z'}};
 const manifest={version:2,lastFinishedAt:'2026-10-30T22:00:00.000Z',lastFullBusinessDate:'2026-10-31',sources:{[key]:previous}};
 writeFileSync(join(d,'source-poll','manifest.json'),JSON.stringify(manifest));
 const {sourcePollLoopPlan,pollOnce}=await import(`../scripts/source-poller.mjs?auto-links=${d}`);
 const plan=sourcePollLoopPlan(manifest,{now:new Date(now()),registry:[opted]});assert.equal(plan.mode,'work-links');assert.deepEqual(plan.workLinkKeys,[key]);
 let reads=0;const result=await pollOnce({session:{headers:{},bootstrap:{authorSources:[]}},now:new Date(now()),workLinksOnly:true,workLinkSourceKeys:[key],
  workSourceReader:async()=>{reads++;return {...edition,workLinkResolution:{...batch,unresolved:1,coolingDown:1,retryAt:'2026-10-31T23:00:00.000Z'}};}});
 assert.equal(reads,1);assert.equal(result.mode,'work-links');assert.equal(result.status,'warning');assert.equal(result.workLinkIncompleteCount,1);
 const saved=JSON.parse(readFileSync(join(d,'source-poll','manifest.json'),'utf8'));
 assert.equal(saved.lastFinishedAt,manifest.lastFinishedAt);assert.equal(saved.lastFullBusinessDate,manifest.lastFullBusinessDate);
 assert.equal(saved.sources[key].workLinkResolution.unresolved,1);
 const cooling=sourcePollLoopPlan(saved,{now:new Date(now()),registry:[opted]});assert.equal(cooling.mode,'idle');assert.ok(cooling.workLinkDelayMs>0);
 const removed=sourcePollLoopPlan(manifest,{now:new Date(now()),registry:[]});assert.equal(removed.mode,'idle','retired sources cannot create a busy loop');
 const dueFull=sourcePollLoopPlan({...manifest,lastFullBusinessDate:'2026-10-30',lastFinishedAt:'2026-10-29T22:00:00.000Z'},{now:new Date(now()),registry:[opted]});
 assert.equal(dueFull.mode,'full','a link backlog never suppresses a due daily source check');
});
