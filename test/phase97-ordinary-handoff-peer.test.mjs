import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createPublisherProcessProbe,publisherProbePreload} from './helpers/publisher-process-probe.mjs';

const moduleRoot=process.env.PHASE97_CANDIDATE?pathToFileURL(realpathSync(resolve(process.env.PHASE97_CANDIDATE))+sep):new URL('../',import.meta.url);
const {MonitorDatabase}=await import(new URL('lib/database.mjs',moduleRoot));
const {MonitorScheduler}=await import(new URL('lib/scheduler.mjs',moduleRoot));
const {normalizeCollection}=await import(new URL('lib/providers/normalize.mjs',moduleRoot));
const {exportPublicReplica,writePublicReplica,PUBLIC_REPLICA_EXPORT_REVISION}=await import(new URL('lib/public-replica-export.mjs',moduleRoot));
const {buildPostIngestionReview}=await import(new URL('lib/post-ingestion-review.mjs',moduleRoot));
const {shouldStagePublicReplica,validatedReceipt}=await import(new URL('scripts/public-replica-publisher.mjs',moduleRoot));
const {readPublicSourceMarker}=await import(new URL('lib/public-source-marker.mjs',moduleRoot));
const publisherPath=fileURLToPath(new URL('scripts/public-replica-publisher.mjs',moduleRoot));
const bytesHash=value=>createHash('sha256').update(value).digest('hex');
const readJSON=path=>JSON.parse(readFileSync(path,'utf8'));
const syntheticSecret='d'.repeat(64);
const idlePreload=`process.channel?.unref();process.on('newListener',event=>{if(event==='SIGTERM')setImmediate(()=>publisherTestNotify({kind:'ready'}));});globalThis.fetch=async()=>{publisherTestNotify({kind:'forbidden-network'});throw Error('NO_NETWORK');};`;
const activePreload=`globalThis.fetch=async(_url,init={})=>{if(init.method!=='POST')return Response.json({}, {status:404});const body=publisherTestBody(init);if(body.action!=='upload')throw Error('NO_ACTIVATION');publisherTestNotify({kind:'upload',asOf:body.asOf});return await new Promise((resolve,reject)=>{const abort=()=>{publisherTestNotify({kind:'draining'});let timer,poll;const done=()=>{clearTimeout(timer);clearInterval(poll);publisherTestNotify({kind:'drained'});reject(Error('synthetic-private-error'));};if(publisherTestReleased())done();else{poll=setInterval(()=>{if(publisherTestReleased())done();},10);timer=setTimeout(done,5000);}};if(init.signal.aborted)abort();else init.signal.addEventListener('abort',abort,{once:true});});};`;
function launch(directory,preload=idlePreload){
 const probe=createPublisherProcessProbe(directory);
 const child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(publisherProbePreload+preload),publisherPath],{env:{...process.env,...probe.env,DATA_DIR:directory},stdio:['ignore','pipe','pipe','ipc']});
 const messages=[];const stopProbe=probe.watch(m=>messages.push(m));child.once('close',stopProbe);let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 const message=async kind=>{for(let i=0;i<500;i++){const found=messages.find(m=>m.kind===kind);if(found)return found;if(child.exitCode!==null||child.signalCode!==null)throw Error('child exited before '+kind+': '+output);await delay(10);}throw Error('child timeout '+kind);};
 return{child,probe,messages,closed,message,activeTransport:preload===activePreload,output:()=>output};
}
async function closeChild(owner){if(!owner)return;let timer;try{if(owner.child.exitCode===null&&owner.child.signalCode===null){owner.child.kill('SIGTERM');if(owner.activeTransport){await owner.message('draining');owner.probe.release();}}return await Promise.race([owner.closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('synthetic child did not drain')),3000);})]);}finally{clearTimeout(timer);if(owner.child.exitCode===null&&owner.child.signalCode===null){owner.child.kill('SIGKILL');await owner.closed;}}}
async function cleanupOwners(owners,directory){const results=await Promise.allSettled(owners.map(closeChild));rmSync(directory,{recursive:true,force:true});owners.filter(Boolean).forEach(owner=>owner.probe.close());const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;}
function publisherFixture(){
 const directory=mkdtempSync(join(tmpdir(),'phase97-publisher-')),home=join(directory,'public-replica-publisher');mkdirSync(home,{mode:0o700});
 const database=new MonitorDatabase(join(directory,'douyin-monitor.sqlite'));
 const runId=database.beginRun('scheduled',null,705);const dataMarker=readPublicSourceMarker(database.db,new Date().toISOString());database.close();
 const state={version:1,active:null,coveredMarker:bytesHash(JSON.stringify({events:[],source:null,dataMarker})),coveredSource:null,exportRevision:PUBLIC_REPLICA_EXPORT_REVISION,status:'success',publishedAsOf:'2026-09-25T01:00:00.000Z',lastConfirmedPublishedAt:'2026-09-25T01:01:00.000Z',sync:{status:'success'}};
 const checkpoint={version:1,asOf:state.publishedAsOf,activated:true,completedBatches:[0],readbackFiles:['catalog.json']};
 writeFileSync(join(home,'state.json'),JSON.stringify(state),{mode:0o600});writeFileSync(join(home,'checkpoint.json'),JSON.stringify(checkpoint),{mode:0o600});
 return{directory,home,runId,state};
}

const NOW=Date.parse('2026-09-25T02:00:00.000Z');
const marker=events=>createHash('sha256').update(JSON.stringify({events,source:null})).digest('hex');
function fixture(t){
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const directory=mkdtempSync(join(tmpdir(),'phase97-handoff-'));
 const database=new MonitorDatabase(join(directory,'isolated.sqlite'));
 t.after(()=>{database.close();rmSync(directory,{recursive:true,force:true});});
 return database;
}

test('running batch profile rows are locally saved but publisher and finished-source coverage cannot be bypassed; terminal receipt opens next generation',t=>{
 const database=fixture(t),db=database.db;
 const account=database.createTarget({type:'account',provider:'public-web',label:'合成主页',locator:'MS4wLjABAAAAPhase97SyntheticAccount'});
 const topic=database.createTarget({type:'hashtag',provider:'public-web',label:'#一条小团团OvO',locator:'一条小团团OvO'});
 const runId=database.beginRun('scheduled',null,2);t.mock.timers.setTime(NOW+1000);
 const at=new Date().toISOString();
 const profile={capturedAt:at,accountStatus:'validated',accountError:null,profile:{user:{sec_uid:account.locator,uid:'123456789',follower_count:20,total_favorited:40,aweme_count:60}},worksCoverage:'unavailable',worksErrorCode:'deferred',works:{stopReason:'request-deferred',pagination:{requestCount:0,pages:[]}},provenance:{mode:'guest-ttwid-unsigned-profile',profileMode:'guest-ttwid-unsigned-profile',profileEndpoint:'https://www.douyin.com/aweme/v1/web/user/profile/other/',accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false}};
 const topicRaw={capturedAt:at,participant_count:10,view_count:50,participants:10,views:50,hashtag:topic.locator,officialName:topic.locator,challengeId:'123456789012345',scope:'douyin-official-challenge-detail',provenance:{mode:'douyin-official-anonymous-challenge-detail',runtimeAI:false,paidAPI:false}};
 database.saveCollection(account,runId,normalizeCollection(account,profile,{capturedAt:at}));database.saveCollection(topic,runId,normalizeCollection(topic,topicRaw,{capturedAt:at}));
 const read=()=>{db.exec('BEGIN');try{const before=db.prepare('SELECT total_changes() n').get().n;const result=exportPublicReplica(db,{asOf:new Date().toISOString()});assert.equal(db.prepare('SELECT total_changes() n').get().n,before);return result;}finally{db.exec('ROLLBACK');}};
 const active=read();assert.equal(active.catalog.accounts[0].latest.followers.value,20);assert.equal(active.catalog.accounts[0].coverage.profileObservedAt,null);assert.equal(active.topics.items[0].participants,null);assert.equal(active.topics.items[0].views,null);
 assert.throws(()=>buildPostIngestionReview({database,runId}),/finished/);
 const state={active:null,coveredMarker:marker([]),exportRevision:PUBLIC_REPLICA_EXPORT_REVISION,lastConfirmedPublishedAt:new Date(NOW-3600000).toISOString(),publishedAsOf:new Date(NOW-3600000).toISOString()};
 assert.equal(shouldStagePublicReplica(state,{running:true,marker:marker([{id:999,finishedAt:new Date(NOW-1000).toISOString()}])}),false,'even unrelated completed event cannot bypass active scheduled owner');
 t.mock.timers.setTime(NOW+2000);database.finishRun(runId,{status:'success',successCount:2,processedCount:2});
 const run=db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
 assert.equal(shouldStagePublicReplica(state,{running:false,marker:marker([])}),false,'mere terminal with no new reviewed marker does not trigger generation');
 const receipt=buildPostIngestionReview({database,runId});assert.equal(validatedReceipt(run,receipt),true);assert.equal(receipt.snapshotCount,2);
 assert.equal(shouldStagePublicReplica(state,{running:false,marker:marker([{id:runId,finishedAt:run.finished_at}])}),true);
 const complete=read();assert.equal(complete.catalog.accounts[0].latest.followers.value,20);assert.equal(complete.catalog.accounts[0].coverage.profileObservedAt,at);assert.equal(complete.topics.items[0].participants,10);assert.equal(complete.topics.items[0].views,50);
 assert.equal(shouldStagePublicReplica({...state,active:{asOf:at}},{running:false,marker:'new'}),false,'unfinished immutable publication is resumed, not replaced');
 console.log(JSON.stringify({running:{daily:20,profileCoverage:null,topicCounters:[null,null],staging:false},terminalReviewed:{profileCoverage:at,topicCounters:[10,50],staging:true},exportWrites:0,platformRequests:0}));
});

test('actual scheduler remains busy after terminal commit until completion hook finishes: DB-only idle is unsafe',{timeout:5000},async t=>{
 const database=fixture(t);database.createTarget({type:'account',provider:'manual',label:'合成手动来源',locator:'manual-fixture'});
 let entered,release;const hookEntered=new Promise(resolve=>entered=resolve),hookRelease=new Promise(resolve=>release=resolve);
 const scheduler=new MonitorScheduler(database,{onRunComplete:async()=>{entered();await hookRelease;},providerOptions:{fetchImpl:()=>{throw Error('NO_NETWORK');},execFileImpl:()=>{throw Error('NO_PROCESS');}}});
 let completion;
 try{
  completion=scheduler.runAll({triggerType:'scheduled'});await hookEntered;
  const run=database.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get();
  assert.equal(run.status,'success');assert.ok(run.finished_at);assert.equal(scheduler.getStatus().running,true);assert.ok(scheduler.currentPromise);
  release();await completion;assert.equal(scheduler.getStatus().running,false);assert.equal(scheduler.currentPromise,null);
  console.log(JSON.stringify({duringHook:{dbTerminal:true,schedulerRunning:true},afterHook:{schedulerRunning:false},platformRequests:0}));
 }finally{release?.();await completion?.catch(()=>{});await scheduler.stop();}
});

test('actual idle publisher reload alone preserves running Main-shaped DB and state/checkpoint; live lock prevents overlap without any credential file',{timeout:10000},async()=>{
 const f=publisherFixture();let first,contender,replacement;
 const stateBefore=bytesHash(readFileSync(join(f.home,'state.json'))),checkpointBefore=bytesHash(readFileSync(join(f.home,'checkpoint.json'))),databaseBefore=bytesHash(readFileSync(join(f.directory,'douyin-monitor.sqlite')));
 try{
  assert.equal(existsSync(join(f.home,'credential')),false);
  first=launch(f.directory);await first.message('ready');const oldLock=readJSON(join(f.home,'lock.json'));assert.equal(oldLock.pid,first.child.pid);
  contender=launch(f.directory);assert.equal((await contender.closed).code,1);assert.match(contender.output(),/publisher-already-running/);assert.equal(readJSON(join(f.home,'lock.json')).pid,first.child.pid);
  assert.equal((await closeChild(first)).code,0);assert.equal(readJSON(join(f.home,'lock.json')).pid,first.child.pid,'SIGTERM preserves lock until next owner proves ESRCH');
  replacement=launch(f.directory);await replacement.message('ready');const fresh=readJSON(join(f.home,'lock.json'));assert.equal(fresh.pid,replacement.child.pid);assert.notEqual(fresh.instance,oldLock.instance);assert.equal(readdirSync(f.home).filter(name=>name.startsWith('lock.json.stale-')).length,1);
  assert.equal((await closeChild(replacement)).code,0);
  assert.equal(bytesHash(readFileSync(join(f.home,'state.json'))),stateBefore);assert.equal(bytesHash(readFileSync(join(f.home,'checkpoint.json'))),checkpointBefore);assert.equal(bytesHash(readFileSync(join(f.directory,'douyin-monitor.sqlite'))),databaseBefore);
  assert.ok([first,contender,replacement].every(o=>!o.messages.some(m=>m.kind==='forbidden-network')));assert.equal(existsSync(join(f.home,'credential')),false);
  console.log(JSON.stringify({reload:'idle publisher only',runningSyntheticScheduledRunPreserved:true,overlapDenied:true,stateCheckpointBytesUnchanged:true,credentialReads:0,transportCalls:0,oldLockPreservedThenArchived:true}));
 }finally{await cleanupOwners([first,contender,replacement],f.directory);}
});

test('actual publisher SIGTERM drains in-flight upload before exit, retains immutable active generation/checkpoint, and replacement resumes same asOf',{timeout:15000},async()=>{
 const f=publisherFixture();let first,contender,replacement;
 try{
  const db=new MonitorDatabase(join(f.directory,'douyin-monitor.sqlite'));let publication;try{publication=exportPublicReplica(db,{asOf:'2026-09-25T01:30:00.000Z'});}finally{db.close();}
  const directory=join(f.directory,'public-replica-staging','old-generation');const manifest=await writePublicReplica(directory,publication);
  const active={directory,asOf:manifest.asOf,manifestHash:bytesHash(JSON.stringify(manifest)),marker:'original-marker',source:null,exportRevision:PUBLIC_REPLICA_EXPORT_REVISION};
  writeFileSync(join(f.home,'state.json'),JSON.stringify({...f.state,status:'staged',active}),{mode:0o600});writeFileSync(join(f.home,'credential'),syntheticSecret,{mode:0o600});
  first=launch(f.directory,activePreload);await first.message('upload');first.child.kill('SIGTERM');await first.message('draining');
  contender=launch(f.directory);assert.equal((await contender.closed).code,1);assert.match(contender.output(),/publisher-already-running/);
  assert.equal(first.messages.some(m=>m.kind==='drained'),false,'the in-flight Worker cannot finish before the synthetic server releases its response');
  assert.ok(first.messages.some(m=>m.kind==='request-body'&&m.gzip===true),'actual production request used gzip');
  first.probe.release();assert.equal((await first.closed).code,0);assert.ok(first.messages.some(m=>m.kind==='drained'));const stopped=readJSON(join(f.home,'state.json'));assert.equal(stopped.code,'aborted');assert.deepEqual(stopped.active,active);assert.equal(stopped.publishedAsOf,f.state.publishedAsOf);
  const checkpoint=readJSON(join(f.home,'checkpoint.json'));assert.equal(checkpoint.asOf,active.asOf);assert.equal(checkpoint.activated,false);assert.deepEqual(checkpoint.completedBatches,[]);
  replacement=launch(f.directory,activePreload);assert.equal((await replacement.message('upload')).asOf,active.asOf);assert.equal((await closeChild(replacement)).code,0);
  assert.deepEqual(readJSON(join(f.home,'state.json')).active,active);assert.equal(readJSON(join(f.home,'checkpoint.json')).manifestSha256,checkpoint.manifestSha256);
  const output=[first,contender,replacement].map(o=>o.output()).join('');assert.equal(output.includes(syntheticSecret),false);assert.equal(output.includes('synthetic-private-error'),false);
  console.log(JSON.stringify({reload:'inflight synthetic abort only',abortDrainedBeforeExit:true,concurrentOwnerDenied:true,sameImmutableGeneration:true,sameCheckpointManifest:true,realCredentialReads:0,credentialOrPrivateErrorInOutput:false}));
 }finally{await cleanupOwners([first,contender,replacement],f.directory);}
});
