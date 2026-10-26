import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const candidate=process.env.PHASE91_CANDIDATE_ROOT;
assert.ok(candidate?.startsWith('/tmp/'),'explicit isolated candidate required; never defaults to Main');
const load=p=>import(pathToFileURL(join(candidate,p)).href);
const {MonitorDatabase}=await load('lib/database.mjs');
const {PublicWebProvider}=await load('lib/providers/public-web.mjs');
const {MonitorScheduler}=await load('lib/scheduler.mjs');
const {normalizeCollection}=await load('lib/providers/normalize.mjs');
const {BrowserWorksPagination}=await load('lib/browser-works-pagination.mjs');
const {normalizeBrowserCollectorInput}=await load('scripts/douyin_browser_collector.mjs');
const {readBrowserWorksSettings,validateBrowserWorksSettingsUpdate}=await load('lib/browser-works-settings.mjs');
const whole={publicWorksPageMode:'whole-page-v2',publicWorksPageHardLimit:100,publicWorksRequestThreshold:30};
const sec='MS4wLjABAAAAphase91IndependentSynthetic',uid='1234567890',now=Date.parse('2026-09-29T02:01:00.000Z');
const rows=d=>JSON.stringify(d.db.prepare('SELECT * FROM settings ORDER BY key').all());
function db(t){const d=new MonitorDatabase(':memory:');t.after(()=>d.close());return d;}
function raw(locator=sec){return {capturedAt:new Date().toISOString(),accountStatus:'validated',accountError:null,
 profile:{user:{sec_uid:locator,uid,follower_count:20,total_favorited:40,aweme_count:70}},worksCoverage:'unavailable',worksErrorCode:'deferred',
 works:{stopReason:'request-deferred',pagination:{requestCount:0,pages:[]}},provenance:{mode:'guest-ttwid-unsigned-profile',profileMode:'guest-ttwid-unsigned-profile',profileEndpoint:'https://www.douyin.com/aweme/v1/web/user/profile/other/',accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false}};}

test('independent legacy projection never persists defaults; activation/re-activation requires explicit complete tuple',t=>{
 const d=db(t),before=rows(d),original={...d.db.prepare("SELECT * FROM settings WHERE key='publicPostsPerAccount'").get()};
 assert.equal(d.getSettings().publicWorksPageMode,'legacy');assert.equal(rows(d),before);
 for(const p of [{publicWorksPageMode:'whole-page-v2'}, {publicWorksPageMode:'whole-page-v2',publicWorksPageHardLimit:100}, {publicWorksPageMode:'whole-page-v2',publicWorksRequestThreshold:30}]){assert.throws(()=>d.setSettings(p));assert.equal(rows(d),before);}
 d.setSettings(whole);d.setSettings({publicWorksPageMode:'legacy'});assert.throws(()=>d.setSettings({publicWorksPageMode:'whole-page-v2'}));
 assert.deepEqual({...d.db.prepare("SELECT * FROM settings WHERE key='publicPostsPerAccount'").get()},original);
});

test('independent both numeric keys reject coercion and cross-field failures atomically with unrelated changes',t=>{
 const d=db(t);d.setSettings(whole);
 for(const key of ['publicWorksPageHardLimit','publicWorksRequestThreshold'])for(const value of [undefined,null,true,false,'',' 30','30 ','030','3e1','30.0',0,-1,101,1.2,Infinity,NaN,[],{},Number.MAX_SAFE_INTEGER+1]){
  const before=rows(d);assert.throws(()=>d.setSettings({viralLikeThreshold:234,[key]:value}),key+':'+String(value));assert.equal(rows(d),before);
 }
 for(const p of [{publicWorksPageHardLimit:29},{publicWorksRequestThreshold:101},{publicWorksPageMode:'v2'}]){const before=rows(d);assert.throws(()=>d.setSettings({...p,publicPostsPerAccount:17}));assert.equal(rows(d),before);}
 assert.deepEqual(readBrowserWorksSettings(d.setSettings({publicWorksPageHardLimit:'1',publicWorksRequestThreshold:'1'})),{mode:'whole-page-v2',hardLimit:1,requestThreshold:1});
 assert.ok(Object.isFrozen(readBrowserWorksSettings({})));
 assert.deepEqual(validateBrowserWorksSettingsUpdate(Object.create(whole),{}),{});
});

test('actual SQLite write fault rolls back earlier unrelated and policy writes, preserving original30 timestamp',t=>{
 const d=db(t),before=rows(d);
 d.db.exec("CREATE TEMP TRIGGER fail_policy BEFORE INSERT ON settings WHEN NEW.key='publicWorksRequestThreshold' BEGIN SELECT RAISE(ABORT,'synthetic fault'); END");
 assert.throws(()=>d.setSettings({viralLikeThreshold:123,...whole}),/synthetic fault/);assert.equal(rows(d),before);
 d.db.exec('DROP TRIGGER fail_policy');d.setSettings(whole);assert.equal(d.getSettings().publicPostsPerAccount,'30');
});

test('cross-field reads occur under SQLite write transaction and explicit v2 hard limits never clamp in collector or ledger',t=>{
 const d=db(t),original=d.getSettings.bind(d),states=[];t.mock.method(d,'getSettings',()=>{states.push(d.db.isTransaction);return original();});
 d.setSettings(whole);assert.equal(states[0],true);assert.equal(states.at(-1),false);
 for(const limit of [0,101,1.5,'30',null,NaN,Infinity]){assert.throws(()=>new BrowserWorksPagination({limit,requestThreshold:1}));assert.throws(()=>normalizeBrowserCollectorInput({items:[{key:'offline',secUid:sec,limit,requestThreshold:1}]}));}
});

test('actual provider binds source version/threshold/hardcap to explicit immutable settings, not option bypass',async()=>{
 const target={id:1,enabled:1,type:'account',provider:'public-web',locator:sec,metadata:{platform:'douyin'}},anchor={snapshotId:1,sourceChecksum:'a'.repeat(64),secUid:sec,uid,capturedAt:new Date(now).toISOString()};
 const post={aweme_id:'7000000000000000001',author:{sec_uid:sec,uid},statistics:{digg_count:1},create_time:1700000000};
 function item(policy){const ledger=new BrowserWorksPagination(policy);ledger.accept({requestCursor:0,body:{aweme_list:[post],has_more:false},normalized:{posts:[post],maxCursor:10,filteredCount:0,duplicateCount:0,locallyTruncated:false},observedAt:new Date(now+10).toISOString()});const r=ledger.result(1);return {key:'1',status:'ok',...r,worksCoverage:r.coverage};}
 for(const [settings,policy,accepted] of [[whole,{limit:100,requestThreshold:30},true],[whole,{limit:100,requestThreshold:20},false],[whole,{limit:90,requestThreshold:30},false],[whole,{limit:30},false],[{}, {limit:30},true],[{}, {limit:100,requestThreshold:30},false]]){
  const values={publicPostsPerAccount:30,...settings};let n=0;
  const p=new PublicWebProvider(values,{accountBrowserFallback:true,browserRequestThreshold:1,now:()=>now+(n++?20:0),execFileImpl:()=>assert.fail('no child process')});
  values.publicWorksPageMode='legacy';values.publicPostsPerAccount=1;assert.ok(Object.isFrozen(p.settings));
  p.runBrowserWorks=async()=>({items:[item(policy)]});const r=await p.collectWorksOnly(target,anchor);
  assert.equal(r.result.status,accepted?'ok':'unavailable');if(accepted)assert.equal(r.result.worksCoverage,'limited');else assert.equal(r.result.errorCode,'upstream_changed');
 }
});

test('v2 cannot expand anonymous or Bilibili request limits',async()=>{
 const p=new PublicWebProvider({publicPostsPerAccount:30,...whole},{accountBrowserFallback:true});const seen=[];
 p.run=async(kind,args)=>{seen.push([kind,args[args.indexOf('--limit')+1]]);throw Error('offline boundary');};
 await assert.rejects(p.collectAccount({id:1,locator:sec}),/offline boundary/);await assert.rejects(p.collectBilibiliAccount({id:2,locator:'123456'}),/offline boundary/);
 assert.deepEqual(seen.map(x=>x[1]),['30','30']);
});

test('same-mode threshold/hardcap change rebuilds actual works-only cached provider for next eligible target',async t=>{
 t.mock.timers.enable({apis:['Date'],now});const d=db(t);d.setSettings(whole);
 for(let i=0;i<2;i++){const target=d.createTarget({type:'account',provider:'public-web',label:'synthetic '+i,locator:sec+i});const source=raw(sec+i),r=d.beginRun('scheduled',target.id,1);d.saveCollection(target,r,normalizeCollection(target,source,{capturedAt:source.capturedAt}));d.finishRun(r,{status:'success',successCount:1,processedCount:1});}
 t.mock.timers.setTime(now+1000);const calls=[],instances=[];
 t.mock.method(PublicWebProvider.prototype,'collectAccount',async()=>assert.fail('no new profile'));
 t.mock.method(PublicWebProvider.prototype,'runBrowserWorks',async function(item){calls.push([item.limit,item.requestThreshold]);instances.push(this);return {items:[{key:item.key,status:'unavailable',posts:[],errorCode:'network_error'}]};});
 const scheduler=new MonitorScheduler(d,{scheduleIntervalHours:8,worksOnlyEnabled:true,providerOptions:{accountBrowserFallback:true,execFileImpl:()=>assert.fail('no child process')}});
 await scheduler.tick();d.setSettings({publicWorksPageHardLimit:60,publicWorksRequestThreshold:20});await scheduler.tick();
 assert.deepEqual(calls,[[100,30],[60,20]]);assert.notEqual(instances[0],instances[1]);assert.equal(d.db.prepare('SELECT count(*) n FROM snapshots').get().n,2);
 assert.equal(d.getSettings().publicPostsPerAccount,'30');
});

test('actual API route requires admin before narrow projection; global authentication and POST role checks remain present',async()=>{
 const source=readFileSync(join(candidate,'server.mjs'),'utf8');const marker='  if (request.method === "GET" && pathname === "/api/settings") {';
 const start=source.indexOf(marker),end=source.indexOf('  if (request.method === "POST" && pathname === "/api/settings")',start);assert.ok(start>0&&end>start);
 const branch=source.slice(start,end),execute=new Function('request','pathname','response','access','database','json',branch);
 let reads=0;const database={getSettings(){reads++;return {publicPostsPerAccount:'30',publicWorksPageMode:'legacy',publicWorksPageHardLimit:'100',publicWorksRequestThreshold:'30',privateSentinel:'MUST_NOT_LEAK'};}};
 assert.throws(()=>execute({method:'GET'},'/api/settings',{}, {requireRole(){throw Error('DENIED');}},database,()=>{}),/DENIED/);assert.equal(reads,0);
 const result=execute({method:'GET'},'/api/settings',{}, {requireRole(_req,role){assert.equal(role,'admin');}},database,(_r,status,payload)=>({status,payload}));
 assert.equal(result.status,200);assert.deepEqual(Object.keys(result.payload).sort(),['publicPostsPerAccount','publicWorksPageMode','publicWorksPageHardLimit','publicWorksRequestThreshold'].sort());assert.ok(!JSON.stringify(result).includes('MUST_NOT_LEAK'));
 const before=source.slice(0,start);assert.ok(before.includes('access.authenticate(request, response)'));assert.match(source.slice(end,end+180),/access.requireRole\(request, "admin"\)/);
});

console.info('PHASE91_CANDIDATE_REVIEW_SHA '+JSON.stringify(Object.fromEntries(['lib/browser-works-settings.mjs','lib/database.mjs','lib/providers/public-web.mjs','lib/scheduler.mjs','lib/works-only-scheduler.mjs','server.mjs'].map(p=>[p,createHash('sha256').update(readFileSync(join(candidate,p))).digest('hex')]))));
