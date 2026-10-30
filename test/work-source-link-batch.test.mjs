import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';import * as XLSX from '@e965/xlsx';
import {commitWorkSourceEdition} from '../lib/work-source-store.mjs';
import {resolveWorkSourceLink,readWorkLinkReceipts} from '../lib/work-source-link-receipts.mjs';
import {runWorkSourceLinkBatch,workSourceLinkPlan} from '../lib/work-source-link-batch.mjs';
const now=()=>Date.parse('2026-10-30T23:00:00.000Z');
const id='7684947825248082873';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'mcn-source-batch-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'monitor.sqlite'),db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON');
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([
  ['发布链接','点赞'],['https://v.douyin.com/one/',0],['https://v.douyin.com/one/',0],['https://v.douyin.com/two/',4]]),'登记');
 const meta={url:'https://fixture.feishu.cn/sheets/FixtureWorkbook123456',revision:1,title:'登记',modifiedAt:'2026-10-30T22:00:00.000Z',sheets:[{id:'sheet1',name:'登记',region:'A1:B4'}]};
 commitWorkSourceEdition(db,{buffer:XLSX.write(wb,{type:'buffer',bookType:'xlsx'}),before:meta,after:meta,readAt:'2026-10-30T22:01:00.000Z'},
  {now:()=>Date.parse('2026-10-30T22:02:00.000Z')});db.close();
 return {dir,path,options:{databasePath:path,versionId:1,now,limit:1,delayMs:500,waitBackup:async()=>{},beforeCommit:async()=>({validated:true})}};
}
const resolved=options=>resolveWorkSourceLink({...options,fetchImpl:async()=>new Response(null,{status:302,headers:{location:`https://www.iesdouyin.com/share/video/${id}/`}})});

test('shared batch deduplicates, continues the next bounded pass, then does no HTTP or backup on unchanged inputs',async t=>{
 const f=await fixture(t);let calls=0,backups=0;
 const options={...f.options,resolveLink:async o=>{calls++;return resolved(o);},beforeCommit:async()=>{backups++;return {validated:true};}};
 const first=await runWorkSourceLinkBatch({...options,reportDirectory:join(f.dir,'first')});
 assert.equal(first.status,'completed');assert.equal(first.processed,1);assert.equal(first.remaining,1);assert.equal(first.unresolved,1);
 assert.equal(first.retryAt,'2026-10-30T23:05:00.000Z');
 const second=await runWorkSourceLinkBatch({...options,reportDirectory:join(f.dir,'second')});assert.equal(second.remaining,0);assert.equal(second.unresolved,0);
 const third=await runWorkSourceLinkBatch({...options,reportDirectory:join(f.dir,'third')});assert.equal(third.planned,0);assert.equal(third.retryAt,null);
 assert.equal(calls,2);assert.equal(backups,2);assert.deepEqual(await readdir(join(f.dir,'.work-link-leases')),[]);
 const db=new DatabaseSync(f.path,{readOnly:true});assert.equal(readWorkLinkReceipts(db,{asOf:new Date(now()).toISOString()}).length,2);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM work_source_fact_blobs').get().n,3);db.close();
});

test('upstream denial stops the batch and prevents another URL from bypassing its cooldown',async t=>{
 const f=await fixture(t);let calls=0;
 const options={...f.options,limit:10,resolveLink:async o=>{calls++;return resolveWorkSourceLink({...o,fetchImpl:async()=>new Response(null,{status:403})});}};
 const first=await runWorkSourceLinkBatch({...options,reportDirectory:join(f.dir,'first')});
 assert.equal(first.status,'stopped-upstream');assert.equal(first.processed,1);assert.equal(first.code,'http-403');
 assert.equal(first.retryAt,'2026-10-31T23:00:00.000Z');assert.equal(first.unresolved,2);
 const second=await runWorkSourceLinkBatch({...options,reportDirectory:join(f.dir,'second'),beforeCommit:async()=>{throw Error('should-not-backup');}});
 assert.equal(second.processed,0);assert.equal(second.unresolved,2);assert.equal(second.phase,'upstream-cooldown');assert.equal(calls,1);
});

test('an active batch excludes another caller, and a crashed lease does not block future work',async t=>{
 const f=await fixture(t);let entered,finish;const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{finish=r;});
 const first=runWorkSourceLinkBatch({...f.options,reportDirectory:join(f.dir,'first'),resolveLink:async o=>{entered();await gate;return resolved(o);}});
 await started;
 try{const other=await runWorkSourceLinkBatch({...f.options,reportDirectory:join(f.dir,'other'),resolveLink:async()=>{throw Error('duplicate-request');}});
 assert.equal(other.status,'deferred');assert.equal(other.processed,0);}finally{finish();}
 assert.equal((await first).status,'completed');
 await writeFile(join(f.dir,'.work-link-leases','dead.json'),JSON.stringify({pid:2147483647,instance:'dead'}));
 const next=await runWorkSourceLinkBatch({...f.options,reportDirectory:join(f.dir,'next'),resolveLink:resolved});assert.equal(next.status,'completed');
 assert.equal(JSON.parse(await readFile(join(f.dir,'.work-link-leases','dead.json'),'utf8')).pid,2147483647);
});

test('missing backup or cancellation cannot start network requests or rewrite source facts',async t=>{
 const f=await fixture(t);let calls=0;
 const failed=await runWorkSourceLinkBatch({...f.options,reportDirectory:join(f.dir,'failed'),beforeCommit:async()=>({validated:false}),resolveLink:async()=>{calls++;}});
 assert.equal(failed.status,'failed');assert.equal(failed.processed,0);assert.equal(calls,0);
 const c=new AbortController();c.abort();const cancelled=await runWorkSourceLinkBatch({...f.options,reportDirectory:join(f.dir,'cancelled'),signal:c.signal,
  waitBackup:async({signal})=>{if(signal.aborted)throw Error('work-link-cancelled');},resolveLink:async()=>{calls++;}});
 assert.equal(cancelled.status,'cancelled');assert.equal(calls,0);
 const db=new DatabaseSync(f.path,{readOnly:true});assert.equal(workSourceLinkPlan(db,{versionId:1,now}).unresolvedTotal,2);db.close();
});
