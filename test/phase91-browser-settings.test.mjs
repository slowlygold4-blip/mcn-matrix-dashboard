import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { MonitorScheduler } from '../lib/scheduler.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { readBrowserWorksSettings } from '../lib/browser-works-settings.mjs';
import { readFile } from 'node:fs/promises';

const whole = {publicWorksPageMode:'whole-page-v2',publicWorksPageHardLimit:100,publicWorksRequestThreshold:30};
const sec = 'MS4wLjABAAAAphase91SettingsAccountFixture';
const uid = '1234567890';
const NOW=Date.parse('2026-09-29T02:01:00.000Z');
function raw(locator=sec){return {capturedAt:new Date().toISOString(),accountStatus:'validated',accountError:null,
  profile:{user:{sec_uid:locator,uid,follower_count:20,total_favorited:40,aweme_count:701}},
  worksCoverage:'unavailable',worksErrorCode:'deferred',works:{stopReason:'request-deferred',pagination:{requestCount:0,pages:[]}},
  provenance:{mode:'guest-ttwid-unsigned-profile',profileMode:'guest-ttwid-unsigned-profile',profileEndpoint:'https://www.douyin.com/aweme/v1/web/user/profile/other/',accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false}};}
function fixture(t){t.mock.timers.enable({apis:['Date'],now:NOW});const database=new MonitorDatabase(':memory:');t.after(()=>database.close());
  const target=database.createTarget({type:'account',provider:'public-web',label:'offline fixture',locator:sec});
  return {database,target};}
test('phase91 setting defaults are read-only legacy projection and old30 row is unchanged',t=>{
  const {database}=fixture(t);const before=JSON.stringify(database.db.prepare('SELECT * FROM settings ORDER BY key').all());
  assert.equal(database.getSettings().publicWorksPageMode,'legacy');assert.equal(database.getSettings().publicPostsPerAccount,'30');
  assert.equal(JSON.stringify(database.db.prepare('SELECT * FROM settings ORDER BY key').all()),before);
  assert.throws(()=>database.setSettings({publicWorksPageMode:'whole-page-v2'}));
  assert.equal(JSON.stringify(database.db.prepare('SELECT * FROM settings ORDER BY key').all()),before);
  const settings=database.setSettings(whole);assert.equal(settings.publicPostsPerAccount,'30');
  assert.equal(settings.publicWorksPageHardLimit,'100');assert.equal(settings.publicWorksRequestThreshold,'30');
  database.setSettings({publicWorksPageMode:'legacy'});assert.equal(database.getSettings().publicPostsPerAccount,'30');
  assert.throws(()=>database.setSettings({publicWorksPageMode:'whole-page-v2'}),'reactivation requires explicit fields again');
});
test('phase91 malformed mode/number/cross-field changes atomically reject without clamping or partial unrelated writes',t=>{
  const {database}=fixture(t);database.setSettings(whole);
  for(const patch of [{publicWorksPageMode:null},{publicWorksPageMode:'whole'},...['',null,true,0,-1,101,1.5,'3e1','030',' 30','30.0',{},[]].map(value=>({publicWorksPageHardLimit:value})),{publicWorksPageHardLimit:20},{publicWorksRequestThreshold:101}]){
    const before=JSON.stringify(database.db.prepare('SELECT * FROM settings ORDER BY key').all());
    assert.throws(()=>database.setSettings({viralLikeThreshold:123,...patch}),JSON.stringify(patch));
    assert.equal(JSON.stringify(database.db.prepare('SELECT * FROM settings ORDER BY key').all()),before);
  }
  assert.deepEqual(readBrowserWorksSettings(database.setSettings({publicWorksPageHardLimit:'20',publicWorksRequestThreshold:'10'})),{mode:'whole-page-v2',hardLimit:20,requestThreshold:10});
});
test('phase91 cross-field validation reads under write lock; explicit collector v2 hard limit never clamps',async t=>{
  const {database}=fixture(t);const original=database.getSettings.bind(database);const states=[];
  t.mock.method(database,'getSettings',()=>{states.push(database.db.isTransaction);return original();});
  database.setSettings(whole);assert.equal(states[0],true);assert.equal(states.at(-1),false);
  const {normalizeBrowserCollectorInput}=await import('../scripts/douyin_browser_collector.mjs');
  const {BrowserWorksPagination}=await import('../lib/browser-works-pagination.mjs');
  for(const limit of [0,101,1.5,null,'100']){
    assert.throws(()=>normalizeBrowserCollectorInput({items:[{key:'offline',secUid:sec,limit,requestThreshold:1}]}));
    assert.throws(()=>new BrowserWorksPagination({limit,requestThreshold:1}));
  }
});
test('phase91 actual provider snapshots settings; legacy option cannot bypass mode; both browser entrances use explicit settings',async t=>{
  const {database,target}=fixture(t);database.setSettings(whole);
  const settings=database.getSettings();const provider=new PublicWebProvider(settings,{accountBrowserFallback:true});
  settings.publicWorksPageHardLimit='1';settings.publicWorksPageMode='legacy';
  const calls=[];provider.run=async(_kind,args)=>{assert.equal(args[args.indexOf('--limit')+1],'30','anonymous limit unchanged');return raw();};
  provider.runBrowserWorks=async item=>{calls.push(item);return {items:[{key:item.key,status:'unavailable',posts:[],errorCode:'network_error'}]};};
  await provider.collectAccount(target);
  const anchor={snapshotId:1,sourceChecksum:'a'.repeat(64),secUid:sec,uid,capturedAt:new Date().toISOString()};
  await provider.collectWorksOnly(target,anchor);
  assert.equal(calls.length,2);assert.ok(calls.every(item=>item.limit===100&&item.requestThreshold===30));
  const legacy=new PublicWebProvider({publicPostsPerAccount:30},{accountBrowserFallback:true,browserRequestThreshold:1});
  legacy.runBrowserWorks=async item=>{assert.equal(item.limit,30);assert.equal(Object.hasOwn(item,'requestThreshold'),false);return {items:[{key:item.key,status:'unavailable',posts:[],errorCode:'network_error'}]};};
  await legacy.collectWorksOnly(target,anchor);
});
test('phase91 actual normal scheduler freezes settings across two accounts and next run adopts new explicit policy',async t=>{
  const {database,target}=fixture(t);database.setSettings(whole);
  database.createTarget({type:'account',provider:'public-web',label:'offline second',locator:sec+'Second'});
  const seen=[];
  t.mock.method(PublicWebProvider.prototype,'run',async function(_kind,args){return raw(args[args.indexOf('--locator')+1]);});
  t.mock.method(PublicWebProvider.prototype,'runBrowserWorks',async function(item){seen.push([item.limit,item.requestThreshold]);if(seen.length===1)database.setSettings({publicWorksPageMode:'legacy'});return {items:[{key:item.key,status:'unavailable',posts:[],errorCode:'network_error'}]};});
  const scheduler=new MonitorScheduler(database,{providerOptions:{accountBrowserFallback:true,cooldownMs:0,execFileImpl:()=>assert.fail('no process')}});
  await scheduler.runAll({triggerType:'manual'});assert.deepEqual(seen,[[100,30],[100,30]]);
  await scheduler.runAll({triggerType:'manual',targetId:target.id});assert.deepEqual(seen.at(-1),[30,undefined]);
  assert.equal(database.getSettings().publicPostsPerAccount,'30');
});
test('phase91 actual works-only scheduler recreates cached provider when mode changes without another profile or extra retry',async t=>{
  const {database,target}=fixture(t);database.setSettings(whole);
  const source=raw();const first=database.beginRun('scheduled',target.id,1);database.saveCollection(target,first,normalizeCollection(target,source,{capturedAt:source.capturedAt}));
  database.finishRun(first,{status:'success',successCount:1,processedCount:1});t.mock.timers.setTime(NOW+1000);
  const seen=[],instances=[];t.mock.method(PublicWebProvider.prototype,'collectAccount',async()=>assert.fail('no profile request'));
  t.mock.method(PublicWebProvider.prototype,'runBrowserWorks',async function(item){seen.push([item.limit,item.requestThreshold]);instances.push(this);return {items:[{key:item.key,status:'unavailable',posts:[],errorCode:'network_error'}]};});
  const scheduler=new MonitorScheduler(database,{scheduleIntervalHours:8,worksOnlyEnabled:true,providerOptions:{accountBrowserFallback:true,execFileImpl:()=>assert.fail('no process')}});
  await scheduler.tick();assert.deepEqual(seen,[[100,30]]);const cached=scheduler.worksOnlyProvider;
  database.setSettings({publicWorksPageMode:'legacy'});await scheduler.tick();assert.equal(seen.length,1,'settings cannot bypass 15-minute retry');
  t.mock.timers.setTime(Date.now()+15*60_000);await scheduler.tick();assert.deepEqual(seen,[[100,30],[30,undefined]]);
  assert.notEqual(scheduler.worksOnlyProvider,cached);assert.notEqual(instances[0],instances[1]);
  assert.equal(database.db.prepare('SELECT COUNT(*) n FROM snapshots').get().n,1);
  t.mock.timers.setTime(Date.now()+15*60_000);await scheduler.tick();assert.equal(seen.length,2,'original two-attempt budget unchanged');
});

test('phase91 real owner receives settings-derived v2 then actual works-only canonical keeps38 limited',async t=>{
  const ownerURL=new URL('../scripts/douyin_browser_collector.mjs',import.meta.url).href;
  let source=(await readFile(new URL('./phase90-collection-path-peer.test.mjs',import.meta.url),'utf8')).split('\ntest(')[0];
  source=source.replace(/const ownerURL = .*;\n/,`const ownerURL = ${JSON.stringify(ownerURL)};\n`)
    .replace("new URL('./phase87-collector-peer.test.mjs', import.meta.url)",JSON.stringify(new URL('./phase87-collector-peer.test.mjs',import.meta.url).pathname));
  const {run,responses,SEC}=await import(`data:text/javascript;base64,${Buffer.from(source+'\nexport {run,responses,SEC};').toString('base64')}`);
  const provider=new PublicWebProvider({publicPostsPerAccount:30,...whole},{accountBrowserFallback:true,now:()=>Date.now()});
  let observedItem;provider.runBrowserWorks=async item=>{observedItem=item;return {items:[(await run(t,{responses:responses(29,9)},{limit:item.limit,requestThreshold:item.requestThreshold})).result]};};
  // Start is evaluated before fixture installs virtual Date, so pin provider
  // clock's first read to0 and subsequent reads to the actual virtual finish.
  let reads=0;provider.now=()=>reads++===0?0:Date.now();
  const result=await provider.collectWorksOnly({id:1,enabled:1,type:'account',provider:'public-web',locator:SEC,metadata:{platform:'douyin'}},
    {snapshotId:1,sourceChecksum:'a'.repeat(64),secUid:SEC,uid,capturedAt:new Date(0).toISOString()});
  assert.equal(observedItem.limit,100);assert.equal(observedItem.requestThreshold,30);assert.equal(result.result.posts.length,38);assert.equal(result.result.worksCoverage,'limited');
  assert.equal(result.requestedLimit,100);assert.equal(result.result.pagination.version,2);
});
