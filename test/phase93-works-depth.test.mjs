import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MonitorDatabase } from '../lib/database.mjs';
import { MonitorScheduler } from '../lib/scheduler.mjs';
import { runNextWorksOnly } from '../lib/works-only-scheduler.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { BrowserWorksPagination } from '../lib/browser-works-pagination.mjs';
import { readTrustedWorksResume, loadVerifiedWorksOnlyRows } from '../lib/works-observation.mjs';
import { checksum } from '../lib/utils.mjs';

test('Phase93 real disk SQLite depth24 cost and forced head reset after24 safe hops', async t => {
  const NOW = Date.parse('2026-09-01T02:01:00.000Z');
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const directory = mkdtempSync(join(tmpdir(),'phase93-works-depth-sqlite-'));
  const path = join(directory,'isolated.sqlite');
  let database = new MonitorDatabase(path);
  t.after(()=>{database.close();rmSync(directory,{recursive:true,force:true});});
  const count = Number(process.env.PHASE93_TARGETS || 30);
  const targets = Array.from({length:count},(_,i)=>database.createTarget({type:'account',provider:'public-web',
    label:`isolated ${i}`,locator:`MS4wLjABAAAAPhase93ResumeAccount${String(i).padStart(6,'0')}`}));
  const requests=[];
  t.mock.method(PublicWebProvider.prototype,'runBrowserWorks', async item => {
    requests.push({key:item.key,startCursor:item.startCursor});
    const id=Number(item.key), cursor=item.startCursor??0;
    const posts=Array.from({length:30},(_,i)=>({aweme_id:String(7200000000000000000n+BigInt(id*100000+cursor+i)),
      author:{sec_uid:item.secUid,uid:String(10000000+id)},statistics:{digg_count:i}}));
    const ledger=new BrowserWorksPagination({limit:item.limit,startCursor:item.startCursor,requestThreshold:item.requestThreshold});
    t.mock.timers.setTime(Date.now()+20);
    ledger.accept({requestCursor:cursor,body:{aweme_list:posts,has_more:true},
      normalized:{posts,maxCursor:cursor+100,filteredCount:0,duplicateCount:0,locallyTruncated:false},observedAt:new Date().toISOString()});
    return {items:[{key:item.key,status:'ok',errorCode:null,...ledger.result(1)}]};
  });
  const scheduler=()=>new MonitorScheduler(database,{scheduleIntervalHours:8,worksOnlyEnabled:true,
    providerOptions:{accountBrowserFallback:true,execFileImpl:()=>{throw Error('NO_EXTERNAL_PROCESS');},fetchImpl:()=>{throw Error('NO_NETWORK');}}});
  function anchor(target) {
    const raw={capturedAt:new Date().toISOString(),accountStatus:'validated',accountError:null,
      profile:{user:{sec_uid:target.locator,uid:String(10000000+target.id),follower_count:20,total_favorited:40,aweme_count:10000}},
      worksCoverage:'unavailable',worksErrorCode:'deferred',works:{stopReason:'request-deferred',pagination:{requestCount:0,pages:[]}},
      provenance:{mode:'guest-ttwid-unsigned-profile',profileMode:'guest-ttwid-unsigned-profile',
        profileEndpoint:'https://www.douyin.com/aweme/v1/web/user/profile/other/',accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false}};
    const run=database.beginRun('scheduled',target.id,1);
    database.saveCollection(target,run,normalizeCollection(target,raw,{capturedAt:raw.capturedAt}));
    database.finishRun(run,{status:'success',successCount:1,processedCount:1});
    t.mock.timers.setTime(Date.now()+1000);
  }
  function measure(label,targetId=null) {
    let prepares=0,decodedRows=0;
    const proxy={prepare(sql){prepares++;const statement=database.db.prepare(sql);
      return {get(...args){return statement.get(...args);},all(...args){const rows=statement.all(...args);
        if(sql.startsWith('WITH'))decodedRows+=rows.length;return rows;}};}};
    const start=performance.now();
    const rows=loadVerifiedWorksOnlyRows(proxy,new Date().toISOString(),targetId);
    const elapsedMs=Number((performance.now()-start).toFixed(3));
    console.log(JSON.stringify({label,targets:count,targetId,elapsedMs,prepares,decodedRows,returnedRows:rows.length}));
    assert.equal(rows.length,targetId===null?count*2:2);
    return rows;
  }
  const buildStart=performance.now();
  for(let round=0;round<=24;round++) {
    t.mock.timers.setTime(NOW+round*8*3600_000);
    for(const target of targets) {
      anchor(target);
      const result=await runNextWorksOnly(scheduler(),{target});
      assert.equal(result?.successCount,1,JSON.stringify(result));
      assert.equal(requests.at(-1).startCursor,round===0?undefined:round*100);
    }
    database.close();database=new MonitorDatabase(path);
    if([1,12,24].includes(round)) { measure(`global-depth-${round}`);measure(`single-depth-${round}`,targets[0].id); }
  }
  console.log(JSON.stringify({label:'construction',elapsedMs:Number((performance.now()-buildStart).toFixed(3)),
    observations:database.db.prepare('SELECT count(*) n FROM works_observations').get().n,
    posts:database.db.prepare('SELECT count(*) n FROM posts').get().n}));
  assert.equal(database.db.prepare('SELECT count(*) n FROM works_observations').get().n,count*25);
  assert.equal(database.db.prepare('SELECT count(*) n FROM posts').get().n,count*750);
  const identity={secUid:targets[0].locator,uid:String(10000000+targets[0].id)};
  assert.equal(readTrustedWorksResume(database.db,targets[0].id,identity,new Date().toISOString()),null);
  const oldest=database.db.prepare('SELECT * FROM works_observations WHERE target_id=? ORDER BY id LIMIT 1').get(targets[0].id);
  const second=database.db.prepare('SELECT * FROM works_observations WHERE target_id=? ORDER BY id LIMIT 1 OFFSET 1').get(targets[0].id);
  const cutoff=new Date().toISOString();
  // Only this disposable fixture permits deliberate archival corruption.
  database.db.exec('DROP TRIGGER works_observations_no_update');
  const attacks=[
    ['raw-with-stale-checksum',()=>database.db.prepare('UPDATE works_observations SET raw_json=? WHERE id=?').run('{}',oldest.id)],
    ['checksum-only',()=>database.db.prepare('UPDATE works_observations SET source_checksum=? WHERE id=?').run('0'.repeat(64),oldest.id)],
    ['rehash-foreign-author',()=>{const raw=JSON.parse(oldest.raw_json);raw.identity.uid='88888888';
      database.db.prepare('UPDATE works_observations SET raw_json=?,source_checksum=? WHERE id=?').run(JSON.stringify(raw),checksum(raw),oldest.id);}],
    ['parent-run-after-child-start',()=>database.db.prepare('UPDATE runs SET finished_at=? WHERE id=?')
      .run(new Date(Date.parse(second.request_started_at)+1).toISOString(),oldest.run_id)],
    ['parent-anchor-source',()=>database.db.prepare('UPDATE snapshots SET raw_json=? WHERE id=?').run('{}',oldest.anchor_snapshot_id)],
    ['self-parent-cycle',()=>{const raw=JSON.parse(oldest.raw_json);raw.version=2;
      raw.continuation={version:1,observationId:oldest.id,runId:oldest.run_id,sourceChecksum:oldest.source_checksum,cursor:100,depth:1};
      database.db.prepare('UPDATE works_observations SET raw_json=?,source_checksum=? WHERE id=?').run(JSON.stringify(raw),checksum(raw),oldest.id);}],
  ];
  for(const [name,attack] of attacks) {
    assert.equal(loadVerifiedWorksOnlyRows(database.db,cutoff,targets[0].id).length,2);
    database.db.exec('SAVEPOINT corrupt_test');
    try {
      attack();
      assert.equal(loadVerifiedWorksOnlyRows(database.db,cutoff,targets[0].id).length,0,name);
      if(targets.length>1)assert.equal(loadVerifiedWorksOnlyRows(database.db,cutoff,targets[1].id).length,2,`${name}: other author`);
    }finally{database.db.exec('ROLLBACK TO corrupt_test; RELEASE corrupt_test');}
    assert.equal(loadVerifiedWorksOnlyRows(database.db,cutoff,targets[0].id).length,2,`${name}: re-read restored source`);
  }
  console.log(JSON.stringify({label:'mutable-parent-attacks',cases:attacks.map(([name])=>name),result:'all-rejected-no-cross-call-trust'}));
  const before=database.db.prepare('SELECT source_checksum,raw_json FROM works_observations ORDER BY id LIMIT 1').get();
  t.mock.timers.setTime(NOW+25*8*3600_000);anchor(targets[0]);
  assert.equal((await runNextWorksOnly(scheduler(),{target:targets[0]})).successCount,1);
  assert.equal(requests.at(-1).startCursor,undefined);
  assert.deepEqual(database.db.prepare('SELECT source_checksum,raw_json FROM works_observations ORDER BY id LIMIT 1').get(),before);
  assert.equal(database.db.prepare('SELECT count(*) n FROM posts').get().n,count*750);
});
