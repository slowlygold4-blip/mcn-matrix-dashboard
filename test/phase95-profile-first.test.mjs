import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.PHASE95_BASE || new URL('../',import.meta.url).pathname;
const {MonitorDatabase}=await import(pathToFileURL(join(root,'lib/database.mjs')));
const {MonitorScheduler}=await import(pathToFileURL(join(root,'lib/scheduler.mjs')));
const {PublicWebProvider}=await import(pathToFileURL(join(root,'lib/providers/public-web.mjs')));
const {BrowserWorksPagination}=await import(pathToFileURL(join(root,'lib/browser-works-pagination.mjs')));
const {readWorksOnlyAnchor}=await import(pathToFileURL(join(root,'lib/works-only-observation.mjs')));
const {loadVerifiedWorksOnlyRows}=await import(pathToFileURL(join(root,'lib/works-observation.mjs')));
const {checksum}=await import(pathToFileURL(join(root,'lib/utils.mjs')));
const {readCommittedTargetPublication,releaseCommittedTargetPublication}=await import(pathToFileURL(join(root,'lib/committed-target-publication.mjs')));
const {exportPublicReplica}=await import(pathToFileURL(join(root,'lib/public-replica-export.mjs')));
const NOW=Date.parse('2026-10-02T02:01:00.000Z');

function setup(t,{count=3,...options}={}) {
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const directory=mkdtempSync(join(tmpdir(),'phase95-owner-'));
  const database=new MonitorDatabase(join(directory,'isolated.sqlite'));
  const scheduler=new MonitorScheduler(database,{scheduleIntervalHours:8,worksOnlyEnabled:true,asyncPlanning:true,
    providerOptions:{accountBrowserFallback:true,cooldownMs:0,execFileImpl:()=>{throw Error('NO_PROCESS');},fetchImpl:()=>{throw Error('NO_NETWORK');}},...options});
  t.after(async()=>{await scheduler.stop();database.close();rmSync(directory,{recursive:true,force:true});});
  const targets=Array.from({length:count},(_,i)=>database.createTarget({type:'account',provider:'public-web',label:`isolated ${i+1}`,locator:`MS4wLjABAAAAPhase95ProfileFirstAuthor${i+1}`}));
  const events=[],requests=[];
  const rawFor=(target,{accepted=false,deferred=false}={})=>({capturedAt:new Date().toISOString(),accountStatus:'validated',accountError:null,
    profile:{user:{sec_uid:target.locator,uid:String(12000000+target.id),follower_count:20,total_favorited:40,aweme_count:1000}},
    worksCoverage:accepted?'latest-public-window':'unavailable',worksErrorCode:accepted?null:'blocked',worksError:accepted?null:'HTTP403',
    works:{aweme_list:accepted?[post(target,901)]:[],has_more:true,max_cursor:100,public_window_limited:true,stopReason:accepted?'item-limit':'request-failed',pagination:{evidenceScope:'sanitized-pagination-fields-not-full-response',requestedLimit:30,collectedCount:accepted?1:0,requestCount:1,pages:[{endpoint:'https://www.douyin.com/aweme/v1/web/aweme/post/'}]}},
    provenance:{mode:'guest-ttwid-unsigned-profile-a-bogus-posts',profileMode:'guest-ttwid-unsigned-profile',profileEndpoint:'https://www.douyin.com/aweme/v1/web/user/profile/other/',accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false},
    ...(deferred?{worksCoverage:'unavailable',worksErrorCode:'deferred',works:{stopReason:'request-deferred',pagination:{requestCount:0,pages:[]}},provenance:{mode:'guest-ttwid-unsigned-profile',profileMode:'guest-ttwid-unsigned-profile',profileEndpoint:'https://www.douyin.com/aweme/v1/web/user/profile/other/',accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false}}:{})});
  const post=(target,n)=>({aweme_id:String(7200000000000000000n+BigInt(target.id*10000+n)),author:{sec_uid:target.locator,uid:String(12000000+target.id)},statistics:{digg_count:n}});
  let anonymousAccepted=false,browserCode=null,legacySource=false;
  t.mock.method(PublicWebProvider.prototype,'run',async function(operation,args){
    assert.equal(operation,'account');const target=targets.find(x=>x.locator===args[args.indexOf('--locator')+1]);assert.ok(target);
    events.push(`profile:${target.id}`);t.mock.timers.setTime(Date.now()+5);
    const raw=rawFor(target,{accepted:anonymousAccepted,deferred:args.includes('--works-mode')});
    if(legacySource)delete raw.provenance.profileEndpoint;
    return raw;
  });
  t.mock.method(PublicWebProvider.prototype,'runBrowserWorks',async item=>{
    const target=targets.find(x=>x.locator===item.secUid);assert.ok(target);events.push(`browser:${target.id}`);requests.push({...item});
    t.mock.timers.setTime(Date.now()+45000);
    if(browserCode)return{items:[{key:item.key,secUid:item.secUid,status:'unavailable',errorCode:browserCode,posts:[]}]};
    const cursor=item.startCursor??0,posts=Array.from({length:30},(_,i)=>post(target,cursor+i));
    const ledger=new BrowserWorksPagination({limit:item.limit,startCursor:item.startCursor});
    ledger.accept({requestCursor:cursor,body:{aweme_list:posts,has_more:true},normalized:{posts,maxCursor:cursor+100,filteredCount:0,duplicateCount:0,locallyTruncated:false},observedAt:new Date().toISOString()});
    return{items:[{key:item.key,secUid:item.secUid,status:'ok',errorCode:null,...ledger.result(1)}],provenance:{mode:'douyin-authorised-browser-post-response'}};
  });
  return{database,scheduler,targets,events,requests,rawFor,setAnonymousAccepted(v){anonymousAccepted=v;},setBrowserCode(v){browserCode=v;},setLegacySource(v){legacySource=v;}};
}

test('actual scheduled owner saves entire fresh profile roster before browser work; ordinary ticks persist and resume every eligible author',async t=>{
  const f=setup(t);await f.scheduler.tick();
  assert.deepEqual(f.events,f.targets.map(x=>`profile:${x.id}`),'all three profiles must precede any 45-second browser budget');
  assert.equal(Date.now()-NOW,15);assert.equal(f.database.db.prepare('SELECT count(*) n FROM snapshots').get().n,3);
  const initial=f.database.db.prepare('SELECT id,source_checksum,raw_json FROM snapshots ORDER BY id').all();
  for(const row of initial){const raw=JSON.parse(row.raw_json);assert.equal(raw.worksCoverage,'unavailable');assert.equal(raw.worksErrorCode,'blocked');assert.deepEqual(raw.worksFallbackDeferred,{version:1,reason:'scheduled-profile-priority',mode:'works-only'});assert.equal(raw.worksRequestPolicy.browser.attempted,false);assert.equal(raw.worksRequestPolicy.browser.errorCode,null);}
  for(let i=0;i<3;i++)await f.scheduler.tick();
  assert.deepEqual(f.events,[...f.targets.map(x=>`profile:${x.id}`),...f.targets.map(x=>`browser:${x.id}`)]);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM posts').get().n,90);
  assert.equal(f.database.db.prepare("SELECT count(*) n FROM works_observations WHERE status='accepted' AND coverage='limited'").get().n,3);
  assert.deepEqual(f.database.db.prepare('SELECT id,source_checksum,raw_json FROM snapshots ORDER BY id').all(),initial);
  for(let i=0;i<3;i++)await f.scheduler.tick();
  assert.deepEqual(f.requests.map(x=>x.startCursor),[undefined,undefined,undefined,100,100,100]);
  t.mock.timers.setTime(NOW+8*3600_000+4*60_000);await f.scheduler.tick();
  assert.equal(f.events.slice(-3).every(x=>x.startsWith('profile:')),true,'prior-slot limited evidence must not skip fresh profiles');
  for(let i=0;i<3;i++)await f.scheduler.tick();
  assert.deepEqual(f.requests.map(x=>x.startCursor),[undefined,undefined,undefined,100,100,100,undefined,undefined,undefined]);
  for(let i=0;i<3;i++)await f.scheduler.tick();
  assert.deepEqual(f.requests.map(x=>x.startCursor),[undefined,undefined,undefined,100,100,100,undefined,undefined,undefined,200,200,200]);
  assert.ok(f.requests.every(x=>x.limit===30&&x.requestThreshold===undefined));
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM posts').get().n,270);
  const rows=f.database.db.prepare('SELECT anchor_snapshot_id,coverage FROM works_observations ORDER BY id').all();
  assert.equal(new Set(rows.map(x=>x.anchor_snapshot_id)).size,6);assert.ok(rows.every(x=>x.coverage==='limited'));
  assert.equal(f.database.getSettings().publicWorksPageMode,'legacy');
});

for(const scope of ['manual','works-only-disabled','daily'])test(`${scope} keeps original inline works behavior`,async t=>{
  const f=setup(t,{count:1,...(scope==='works-only-disabled'?{worksOnlyEnabled:false}:{}),...(scope==='daily'?{scheduleIntervalHours:24}:{})});
  await f.scheduler.runAll({triggerType:scope==='manual'?'manual':'scheduled'});
  assert.deepEqual(f.events,[`profile:${f.targets[0].id}`,`browser:${f.targets[0].id}`]);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM posts').get().n,30);
  assert.equal(JSON.parse(f.database.db.prepare('SELECT raw_json FROM snapshots').get().raw_json).worksFallbackDeferred,undefined);
});

test('actual anonymous accepted works remain in source and durable history, with no invented browser deferral',async t=>{
  const f=setup(t,{count:1});f.setAnonymousAccepted(true);await f.scheduler.tick();await f.scheduler.tick();
  assert.equal(f.requests.length,0);assert.equal(f.database.db.prepare('SELECT count(*) n FROM posts').get().n,1);
  const raw=JSON.parse(f.database.db.prepare('SELECT raw_json FROM snapshots').get().raw_json);
  assert.equal(raw.works.aweme_list.length,1);assert.equal(raw.worksFallbackDeferred,undefined);assert.equal(raw.worksErrorCode,null);
});

test('later browser refusal is persisted only as works evidence, leaves profile history intact and is not retried',async t=>{
  const f=setup(t,{count:1});await f.scheduler.tick();const before=f.database.db.prepare('SELECT * FROM snapshots').all();
  f.setBrowserCode('blocked');await f.scheduler.tick();await f.scheduler.tick();
  assert.equal(f.requests.length,1);assert.deepEqual(f.database.db.prepare('SELECT * FROM snapshots').all(),before);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM posts').get().n,0);
  assert.equal(f.database.db.prepare('SELECT status FROM works_observations').get().status,'unavailable');
});

test('persisted browser Retry-After is retained through scheduled deferral, never reset as available',async t=>{
  const f=setup(t,{count:1});
  t.mock.method(PublicWebProvider.prototype,'restoreWorksRequestPolicy',function(){this.worksRequestPolicy.restore({version:1,endpoint:'douyin.author_posts',scope:'endpoint-transport',browser:{transport:'authorised-browser',attempted:false,deferred:true,errorCode:'rate_limited',nextEligibleAt:new Date(NOW+3600_000).toISOString()}});});
  await f.scheduler.tick();await f.scheduler.tick();assert.equal(f.requests.length,0);
  const raw=JSON.parse(f.database.db.prepare('SELECT raw_json FROM snapshots').get().raw_json);
  assert.equal(raw.worksRequestPolicy.browser.errorCode,'rate_limited');assert.equal(raw.worksRequestPolicy.browser.nextEligibleAt,new Date(NOW+3600_000).toISOString());
  assert.equal(raw.worksFallbackDeferred,undefined);
});

test('cross-slot ordering serves previously unattempted tail first using fresh anchors, while expired anchors remain rejected',async t=>{
  const f=setup(t);await f.scheduler.tick();await f.scheduler.tick();
  assert.equal(f.requests[0].secUid,f.targets[0].locator);
  t.mock.timers.setTime(NOW+8*3600_000+1000);
  assert.throws(()=>readWorksOnlyAnchor(f.database.db,f.targets[2].id));
  await f.scheduler.tick();await f.scheduler.tick();await f.scheduler.tick();
  assert.deepEqual(f.requests.map(x=>x.secUid),f.targets.map(x=>x.locator));
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM posts').get().n,90);
});

test('anonymous cooldown can defer the fourth profile source without losing its later browser eligibility',async t=>{
  const f=setup(t,{count:4});await f.scheduler.tick();
  const raw=JSON.parse(f.database.db.prepare('SELECT raw_json FROM snapshots WHERE target_id=?').get(f.targets[3].id).raw_json);
  assert.equal(raw.worksErrorCode,'deferred');assert.equal(raw.worksRequestPolicy.anonymous.attempted,false);
  for(let i=0;i<4;i++)await f.scheduler.tick();assert.equal(f.requests.length,4);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM posts').get().n,120);
});

test('new profile anchor rejects legacy/malformed/rehashed foreign source shapes through actual writer and historical reader',async t=>{
  const f=setup(t,{count:1});await f.scheduler.tick();await f.scheduler.tick();
  const row=f.database.db.prepare('SELECT * FROM snapshots').get(),original=JSON.parse(row.raw_json),at=new Date().toISOString();
  assert.equal(loadVerifiedWorksOnlyRows(f.database.db,at).length,1);
  for(const mutate of [raw=>delete raw.worksFallbackDeferred,raw=>raw.worksFallbackDeferred.version=2,
    raw=>raw.provenance.profileEndpoint='https://other.invalid/',raw=>raw.provenance.mode='arbitrary-profile',
    raw=>raw.profile.user.sec_uid+='foreign',raw=>raw.accountStatus='unavailable',raw=>raw.worksRequestPolicy.browser.attempted=true,
    raw=>raw.worksRequestPolicy.anonymous.attempted=false,raw=>raw.worksErrorCode='deferred',
    raw=>raw.need_login=true,raw=>raw.login_required=true,raw=>raw.captcha_required=true,raw=>raw.verify_required=true,
    raw=>raw.works.pagination.pages[0].endpoint='https://other.invalid/',raw=>raw.status_code=2483]) {
    const raw=structuredClone(original);mutate(raw);const hash=checksum(raw);
    f.database.db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=? WHERE id=?').run(JSON.stringify(raw),hash,row.id);
    f.database.db.prepare('UPDATE audits SET source_checksum=? WHERE target_id=?').run(hash,row.target_id);
    assert.throws(()=>readWorksOnlyAnchor(f.database.db,row.target_id));
    assert.equal(loadVerifiedWorksOnlyRows(f.database.db,at).length,0);
  }
  f.database.db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=? WHERE id=?').run(row.raw_json,row.source_checksum,row.id);
  f.database.db.prepare('UPDATE audits SET source_checksum=? WHERE target_id=?').run(row.source_checksum,row.target_id);
  assert.equal(loadVerifiedWorksOnlyRows(f.database.db,at).length,1);
});

test('legacy source that cannot prove a later anchor retains the original inline browser opportunity',async t=>{
  const f=setup(t,{count:1});f.setLegacySource(true);await f.scheduler.tick();
  assert.equal(f.requests.length,1);assert.equal(f.database.db.prepare('SELECT count(*) n FROM posts').get().n,30);
  assert.equal(JSON.parse(f.database.db.prepare('SELECT raw_json FROM snapshots').get().raw_json).worksFallbackDeferred,undefined);
});

for(const mutation of ['pause','identity'])test(`after profile handoff ${mutation} cannot issue a browser request`,async t=>{
  const f=setup(t,{count:1});await f.scheduler.tick();const row=f.database.db.prepare('SELECT * FROM snapshots').get();
  if(mutation==='pause')f.database.db.prepare('UPDATE targets SET enabled=0 WHERE id=?').run(f.targets[0].id);
  else f.database.db.prepare('UPDATE targets SET locator=? WHERE id=?').run(f.targets[0].locator+'other',f.targets[0].id);
  await f.scheduler.tick();assert.equal(f.requests.length,0);
  assert.deepEqual(f.database.db.prepare('SELECT * FROM snapshots').get(),row);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM works_observations').get().n,0);
});

test('actual profile-first commit remains publicly eligible while the scheduled roster is running; contradictory handoffs fail closed',async t=>{
  const f=setup(t,{count:1});let observed=false;
  const save=f.database.saveCollection.bind(f.database);
  t.mock.method(f.database,'saveCollection',function(...args){
    const result=save(...args),row=this.db.prepare('SELECT * FROM snapshots ORDER BY id DESC LIMIT 1').get();
    const original=JSON.parse(row.raw_json);
    assert.ok(original.worksFallbackDeferred);
    const run=this.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get();
    assert.equal(run.status,'running');assert.equal(run.finished_at,null);
    const read=()=>{
      this.db.exec('BEGIN');let receipt;
      try{receipt=readCommittedTargetPublication(this,{asOf:new Date().toISOString()});
        const replica=exportPublicReplica(this.db,{asOf:new Date().toISOString(),committedPublication:receipt});
        return{count:receipt.runningProfileCount,account:replica.catalog.accounts.find(x=>x.id===row.target_id)};
      }finally{if(receipt)releaseCommittedTargetPublication(receipt);this.db.exec('ROLLBACK');}
    };
    const positive=read();assert.equal(positive.count,1);assert.equal(positive.account.latest.followers.value,20);
    assert.notEqual(positive.account.coverage.works.status,'complete');
    for(const mutate of [r=>delete r.worksFallbackDeferred,r=>r.worksFallbackDeferred.version=2,
      r=>r.worksRequestPolicy.browser.attempted=true,r=>r.worksRequestPolicy.anonymous.attempted=false,
      r=>r.need_login=true,r=>r.login_required=true,r=>r.captcha_required=true,r=>r.verify_required=true]){
      const raw=structuredClone(original);mutate(raw);const digest=checksum(raw);
      this.db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=? WHERE id=?').run(JSON.stringify(raw),digest,row.id);
      this.db.prepare('UPDATE audits SET source_checksum=? WHERE run_id=?').run(digest,run.id);
      assert.equal(read().count,0,'new scheduled source cannot bypass the shared strict contract');
    }
    this.db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=? WHERE id=?').run(row.raw_json,row.source_checksum,row.id);
    this.db.prepare('UPDATE audits SET source_checksum=? WHERE run_id=?').run(row.source_checksum,run.id);
    assert.equal(read().count,1);observed=true;return result;
  });
  await f.scheduler.tick();assert.equal(observed,true);assert.equal(f.requests.length,0);
});
