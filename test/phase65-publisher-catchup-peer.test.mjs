// Independent offline contracts. Imports do not execute the publisher entrypoint.
// No production/private state, credentials, filesystem writes, network, collector,
// process management or scheduler is used. Runtime tests execute real tick/run AST
// with only storage, database, clock and sync I/O supplied as in-memory doubles.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {shouldStagePublicReplica,shouldPreparePublicDateIndex,completedSourceMarker,validatedReceipt,canPreparePublicReplica} from '../scripts/public-replica-publisher.mjs';
import {PUBLIC_REPLICA_EXPORT_REVISION as REVISION} from '../lib/public-replica-export.mjs';

const source=await readFile(new URL('../scripts/public-replica-publisher.mjs',import.meta.url),'utf8');
const sitePackages=process.env.MCN_SITE_ROOT?[resolve(process.env.MCN_SITE_ROOT,'package.json')]
 :[fileURLToPath(new URL('../frontend/package.json',import.meta.url)),fileURLToPath(new URL('../../mcn-public-site/package.json',import.meta.url))];
const sitePackage=sitePackages.find(path=>existsSync(path));assert.ok(sitePackage,'Install frontend dependencies or configure MCN_SITE_ROOT');
const requireSite=createRequire(sitePackage),ts=requireSite('typescript');
const ast=ts.createSourceFile('public-replica-publisher.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
let tickExpression,parentTickExpression,runDeclaration;const cycleHelpers={};
function visit(n){
 if(ts.isFunctionDeclaration(n)&&n.name?.text==='runPublisherCycle'){
  const findTick=child=>{if(ts.isVariableDeclaration(child)&&child.name.getText(ast)==='tick')tickExpression=child.initializer.getText(ast);ts.forEachChild(child,findTick);};
  findTick(n);
 }
 if(ts.isFunctionDeclaration(n)&&n.name?.text==='run'){
  runDeclaration=n.getText(ast);
  const findParentTick=child=>{if(ts.isVariableDeclaration(child)&&child.name.getText(ast)==='tick')parentTickExpression=child.initializer.getText(ast);ts.forEachChild(child,findParentTick);};
  findParentTick(n);
 }
 if(ts.isFunctionDeclaration(n)&&['recordPublisherPreparation','recordPublisherSyncStart'].includes(n.name?.text))cycleHelpers[n.name.text]=n.getText(ast);
 ts.forEachChild(n,visit);
}visit(ast);
assert.ok(tickExpression&&runDeclaration,'Actual publisher tick/run must be found');
assert.match(tickExpression,/exportPublicReplica\(/,'exercise the real generation transaction, not the outer worker launcher');
assert.match(parentTickExpression,/runPublisherCycleWorker\(/,'parent admission executes the actual disposable worker launcher');
const MINUTE=60000,COOLDOWN=30*MINUTE,T=Date.parse('2026-10-01T12:00:00.000Z');
const iso=t=>new Date(t).toISOString(),clone=x=>structuredClone(x),hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const observed=(id=2)=>({running:false,events:[{id,finishedAt:iso(T+id*MINUTE)}],source:'synthetic-completed-source-'+id});
const marker=o=>hash({events:o.events,source:o.source});
const state=(overrides={})=>({version:1,active:null,coveredMarker:marker(observed(1)),coveredSource:observed(1).source,exportRevision:REVISION,publishedAsOf:iso(T),lastConfirmedPublishedAt:iso(T+120*MINUTE),status:'success',...overrides});

test('parent admits one cycle until actual worker exit and remains stopped after shutdown',async()=>{
 let release,calls=0;const owner={pid:123,instance:'synthetic-owner'},signal=new AbortController();
 const context=vm.createContext({busy:false,stopping:false,owner,signal,statePath:'synthetic-state',privateRead:async()=>({active:{}}),
  runPublisherCycleWorker:async(actual,options)=>{assert.equal(actual,owner);assert.equal(options.signal,signal.signal);calls++;await new Promise(resolve=>{release=resolve;});},
  console:{error:()=>assert.fail('successful cycle must not report failure')},
 });
 const tick=vm.runInContext('('+parentTickExpression+')',context),first=tick();await tick();assert.equal(calls,1);
 release();await first;const second=tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);release();await second;
 context.stopping=true;await tick();assert.equal(calls,2);assert.equal(context.busy,false);
});

test('parent worker failure releases admission without exposing private exceptions or faking success',async()=>{
 const logs=[],context=vm.createContext({busy:false,stopping:false,owner:{},signal:new AbortController(),statePath:'synthetic-state',privateRead:async()=>({active:{}}),
  runPublisherCycleWorker:async()=>{throw Error('private credential');},console:{error:line=>logs.push(JSON.parse(line))},
 });
 const tick=vm.runInContext('('+parentTickExpression+')',context);await tick();
 assert.equal(context.busy,false);assert.deepEqual(logs,[{status:'deferred',code:'publisher-worker-failed',runtimeAI:false}]);
});

test('a burst of cooldown events starts no export worker and still reads the latest durable state',async()=>{
 let reads=0,workers=0;const at=new Date().toISOString();
 const context=vm.createContext({busy:false,stopping:false,owner:{},signal:new AbortController(),statePath:'synthetic-state',
  privateRead:async()=>{reads++;return{active:null,lastConfirmedPublishedAt:at,publishedAsOf:at,exportRevision:REVISION};},
  canPreparePublicReplica,runPublisherCycleWorker:async()=>{workers++;},console:{error:()=>assert.fail('cooldown must not fail')},
 });
 const tick=vm.runInContext('('+parentTickExpression+')',context);
 for(let event=0;event<64;event++)await tick();
 assert.equal(reads,64);assert.equal(workers,0);assert.equal(context.busy,false);
});

test('phase65 a delayed confirmation of an old generation no longer imposes another 30-minute wait',()=>{
 const s=state(),o={running:false,marker:marker(observed())},now=T+121*MINUTE;
 const former=!s.lastConfirmedPublishedAt||(Number.isFinite(now)&&now-Date.parse(s.lastConfirmedPublishedAt)>=COOLDOWN);
 assert.equal(former,false,'negative control: the previous confirmation-clock formula blocks catchup');
 assert.equal(shouldStagePublicReplica(s,o,now),true);
 assert.equal(shouldStagePublicReplica(s,{...o,marker:s.coveredMarker},now+24*60*MINUTE),false,'same covered marker/revision never republishes just because time passed');
});

test('phase65 newly generated data keeps exact 30-minute spacing even with continuously changing markers',()=>{
 const s=state({publishedAsOf:iso(T),lastConfirmedPublishedAt:iso(T+MINUTE)});
 for(let minute=1;minute<30;minute++)assert.equal(shouldStagePublicReplica(s,{running:false,marker:hash({minute})},T+minute*MINUTE),false);
 assert.equal(shouldStagePublicReplica(s,{running:false,marker:'new'},T+COOLDOWN-1),false);
 assert.equal(shouldStagePublicReplica(s,{running:false,marker:'new'},T+COOLDOWN),true);
});

test('phase65 invalid, non-canonical, future and post-confirmation asOf fall back to the confirmation clock',()=>{
 const confirmed=T+MINUTE,o={running:false,marker:'new'};
 for(const publishedAsOf of [undefined,null,'','invalid',0,{},'2026-02-31T12:00:00.000Z','2026-10-01T12:00:00Z','2026-10-01T12:00:00+00:00',iso(confirmed+1),iso(confirmed+24*60*MINUTE)]){
  const s=state({publishedAsOf,lastConfirmedPublishedAt:iso(confirmed)});
  assert.equal(shouldStagePublicReplica(s,o,confirmed+COOLDOWN-1),false,String(publishedAsOf));
  assert.equal(shouldStagePublicReplica(s,o,confirmed+COOLDOWN),true,String(publishedAsOf));
 }
});

test('phase65 invalid confirmation or a clock behind confirmation stays closed despite a very old valid generation',()=>{
 const o={running:false,marker:'new'};
 for(const lastConfirmedPublishedAt of ['invalid','2026-10-01T15:00:00.000Z'])assert.equal(shouldStagePublicReplica(state({lastConfirmedPublishedAt}),o,T+121*MINUTE),false);
 for(const now of [T-1,T+119*MINUTE,NaN,Infinity,-Infinity])assert.equal(shouldStagePublicReplica(state(),o,now),false);
 for(const now of [NaN,Infinity,-Infinity])assert.equal(shouldStagePublicReplica(state({lastConfirmedPublishedAt:null,publishedAsOf:undefined}),o,now),false,'even a first publication requires a valid current clock');
});

test('phase65 active publication and full collection block fresh staging, including first publish and schema migration',()=>{
 const o={running:false,marker:'new'},now=T+180*MINUTE;
 for(const s of [state(),state({exportRevision:undefined}),state({lastConfirmedPublishedAt:null,publishedAsOf:undefined})]){
  assert.equal(shouldStagePublicReplica({...s,active:{asOf:iso(T)}},o,now),false);
  assert.equal(shouldStagePublicReplica(s,{...o,running:true},now),false);
 }
 assert.equal(shouldStagePublicReplica(state({lastConfirmedPublishedAt:null,publishedAsOf:undefined}),o,now),true);
});

test('phase65 old state schema and export-revision upgrades preserve once-only generation and original cooldown',()=>{
 const confirmed=T+MINUTE,s=state({exportRevision:undefined,publishedAsOf:undefined,lastConfirmedPublishedAt:iso(confirmed)}),o={running:false,marker:state().coveredMarker};
 assert.equal(shouldStagePublicReplica(s,o,confirmed+COOLDOWN-1),false);assert.equal(shouldStagePublicReplica(s,o,confirmed+COOLDOWN),true);
 assert.equal(shouldStagePublicReplica({...s,exportRevision:REVISION},o,confirmed+COOLDOWN),false);
 const delayed=state({exportRevision:'former-schema'});assert.equal(shouldStagePublicReplica(delayed,{running:false,marker:delayed.coveredMarker},T+121*MINUTE),true);
});

test('phase65 helper decisions never rewrite confirmation, publication, active identity or observation objects',()=>{
 const s=state(),o={running:false,marker:'new'},before=JSON.stringify({s,o});Object.freeze(s);Object.freeze(o);
 shouldStagePublicReplica(s,o,T+121*MINUTE);assert.equal(JSON.stringify({s,o}),before);
});

test('phase65 eligibility still requires completed source clocks and exact finished collection receipts',()=>{
 const now=T+121*MINUTE,m={lastFinishedAt:iso(T),lastPendingCheckedAt:iso(T+MINUTE),sources:{synthetic:{lastStatus:'success'}}};
 const done=completedSourceMarker(m,now);assert.match(done,/^[a-f0-9]{64}$/);
 for(const status of ['running','pending'])assert.equal(completedSourceMarker({...m,sources:{synthetic:{lastStatus:status}}},now),null);
 assert.equal(completedSourceMarker({...m,lastPendingCheckedAt:iso(now+1)},now),null);
 const run={id:1,status:'success',trigger_type:'scheduled',started_at:iso(T),finished_at:iso(T+MINUTE)},receipt={version:1,runId:1,eventId:'collection-run-1',triggerType:'scheduled',runStatus:'success',startedAt:run.started_at,finishedAt:run.finished_at,reviewedAt:iso(T+2*MINUTE)};
 assert.equal(validatedReceipt(run,receipt,now),true);assert.equal(validatedReceipt({...run,status:'running'},receipt,now),false);assert.equal(validatedReceipt(run,{...receipt,reviewedAt:iso(now+1)},now),false);
});

function harness(initial=state(),{initialObserved=observed(),now=T+121*MINUTE,publications=new Map()}={}){
 const control={now,observed:clone(initialObserved),result:{status:'success'},error:null,saveError:false,hold:null};
 // The real sync result has always carried the confirmed generation/hash.
 // Supply that I/O receipt and its immutable prior publication to the VM;
 // source-proof validation is tested separately, not invented by this fake DB.
 const rememberPublished=(asOf,publication={manifest:{version:1,asOf,originalObservedAt:'2026-09-12T03:00:00.000Z'},files:[{capturedAt:'2026-09-12T03:00:00.000Z',value:0}]})=>{
  publications.set(join('/in-memory-fixture-only','public-replica-staging','publisher-'+asOf.replace(/[:.]/g,'-')),clone(publication));return publication;
 };
 if(initial.publishedAsOf){const previous=rememberPublished(initial.publishedAsOf);initial.sync??={status:'success',asOf:initial.publishedAsOf,manifestSha256:hash(previous.manifest)};}
 const stages=[],syncs=[],writes=[],reads=[],dbOps=[],logs=[];let persisted=clone(initial);
 class Clock extends Date{constructor(...args){super(...(args.length?args:[control.now]));}static now(){return control.now;}}
 class ReadonlyDB{constructor(path,options){assert.equal(options.readOnly,true);dbOps.push({open:path});}exec(sql){assert.ok(['PRAGMA query_only=ON;BEGIN','ROLLBACK'].includes(sql));dbOps.push(sql);}prepare(sql){assert.equal(sql,'SELECT total_changes() n');return{get:()=>({n:0})};}close(){dbOps.push('close');}}
 const context=vm.createContext({state:clone(initial),busy:false,stopping:false,immutableStage:null,Date:Clock,join,data:'/in-memory-fixture-only',statePath:'in-memory-state',DatabaseSync:ReadonlyDB,PUBLIC_REPLICA_EXPORT_REVISION:REVISION,signal:{signal:new AbortController().signal},hash,
  iso:value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value,
  fail:code=>{throw Object.assign(Error(code),{code});},canPreparePublicReplica:s=>canPreparePublicReplica(s,control.now),
  // These are the same synthetic immutable bytes supplied by storage/export
  // doubles below. Real source validation runs in the separate sync suite.
  sealPublicReplicaSource:publication=>Object.freeze(publication),
  prunePublicReplicaStaging:async()=>({status:'synthetic-storage',removed:[]}),
  observe:async()=>clone(control.observed),shouldStagePublicReplica:(s,o)=>shouldStagePublicReplica(s,o,control.now),
  shouldPreparePublicDateIndex,
  COMMITTED_TARGET_PUBLICATION:'synthetic-no-committed-target-proof',
  readCommittedTargetPublication(){dbOps.push('read-committed-proof');return{runningSnapshotCount:0,marker:null};},
  async preparePublishedSnapshotBaseline(publication,options){dbOps.push({baseline:options.asOf,exportRevision:options.exportRevision});assert.equal(publication.manifest.asOf,options.asOf);assert.equal(hash(publication.manifest),options.manifestSha256);return{asOf:options.asOf};},
  attachPublishedSnapshotBaseline(){dbOps.push('attach-baseline');},
  releaseCommittedTargetPublication(){dbOps.push('release-committed-proof');},
  exportPublicReplica(_db,{asOf}){return{manifest:{version:1,asOf,originalObservedAt:'2026-09-12T03:00:00.000Z'},files:[{capturedAt:'2026-09-12T03:00:00.000Z',value:0}]};},
  async writePublicReplica(directory,publication){stages.push({directory,publication:clone(publication)});publications.set(directory,clone(publication));return clone(publication.manifest);},
  async readPublication(directory){reads.push(directory);assert.ok(publications.has(directory),'an active generation must reuse its exact staged directory');return clone(publications.get(directory));},
  sync:{async sync(publication,options){syncs.push({publication:clone(publication),dateIndex:options.dateIndex});if(control.hold)await control.hold;if(control.error)throw control.error;if(control.result.status==='success')rememberPublished(publication.manifest.asOf,publication);return{...clone(control.result),asOf:publication.manifest.asOf,manifestSha256:hash(publication.manifest)};}},
  async privateWrite(path,value){assert.equal(path,'in-memory-state');if(control.saveError)throw Error('synthetic-storage-failed');persisted=clone(value);writes.push(clone(value));},
  console:{log:line=>logs.push(JSON.parse(line))},
 });
 const tick=vm.runInContext(Object.values(cycleHelpers).map(source=>source.replace(/^export\s+/, '')).join('\n')+'\n('+tickExpression+')',context);
 return{control,stages,syncs,writes,reads,dbOps,logs,publications,tick,state:()=>clone(context.state),durable:()=>clone(persisted),setBusy:v=>context.busy=v,setStopping:v=>context.stopping=v};
}
function seededActive(options={}){
 const revision=Object.hasOwn(options,'revision')?options.revision:REVISION;
 const publication={manifest:{version:1,asOf:iso(T),originalObservedAt:'2026-09-12T03:00:00.000Z'},files:[{capturedAt:'2026-09-12T03:00:00.000Z',value:0}]},directory='/in-memory-fixture-only/old-generation';
 return{publication,publications:new Map([[directory,publication]]),active:{directory,asOf:iso(T),manifestHash:hash(publication.manifest),marker:marker(observed(1)),source:observed(1).source,exportRevision:revision}};
}

test('phase65 real tick resumes old failed active, confirms it, catches up exactly once and ignores the covered marker',async()=>{
 const seed=seededActive(),initial=state({active:seed.active,publishedAsOf:iso(T-MINUTE),lastConfirmedPublishedAt:iso(T-MINUTE),coveredMarker:'earlier'}),h=harness(initial,{publications:seed.publications});
 h.control.result={status:'failed',code:'network-failed'};await h.tick();assert.equal(h.stages.length,0);assert.deepEqual(h.state().active,seed.active);assert.equal(h.state().lastConfirmedPublishedAt,initial.lastConfirmedPublishedAt);assert.equal(h.state().coveredMarker,'earlier');
 h.control.result={status:'success'};await h.tick();assert.equal(h.state().active,null);assert.equal(h.state().publishedAsOf,iso(T));assert.equal(h.state().lastConfirmedPublishedAt,iso(h.control.now));assert.equal(h.state().coveredMarker,seed.active.marker);
 h.control.now+=MINUTE;await h.tick();assert.equal(h.stages.length,1);assert.equal(h.state().publishedAsOf,iso(h.control.now));assert.equal(h.state().coveredMarker,marker(observed()));
 for(let n=0;n<4;n++){h.control.now+=60*MINUTE;await h.tick();}assert.equal(h.stages.length,1);assert.equal(h.syncs.length,3);assert.equal(h.stages[0].publication.files[0].capturedAt,'2026-09-12T03:00:00.000Z');assert.equal(h.stages[0].publication.files[0].value,0);
});

test('phase65 real tick sees continuously changing data but stages no faster than one generation per 30 minutes',async()=>{
 const h=harness();for(let minute=0;minute<=90;minute++){h.control.now=T+(121+minute)*MINUTE;h.control.observed=observed(100+minute);await h.tick();}
 assert.equal(h.stages.length,4);assert.deepEqual(h.stages.map(s=>s.publication.manifest.asOf),[121,151,181,211].map(n=>iso(T+n*MINUTE)));
 assert.equal(h.syncs.length,4);assert.ok(h.syncs.every(x=>x.dateIndex===true));
});

test('phase65 completion arriving during upload cannot be marked covered by the earlier staged generation',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;}),h=harness();h.control.hold=gate;
 const started=h.tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.syncs.length,1);
 const active=clone(h.state().active);assert.equal(active.marker,marker(observed(2)));h.control.observed=observed(3);h.control.now+=MINUTE;await h.tick();assert.equal(h.stages.length,1);release();await started;
 assert.equal(h.state().coveredMarker,marker(observed(2)),'success must cover only the marker sealed before upload');assert.equal(h.state().publishedAsOf,active.asOf);
 h.control.hold=null;await h.tick();assert.equal(h.stages.length,1,'new completion does not bypass a fresh generation cooldown');
 h.control.now=Date.parse(active.asOf)+COOLDOWN;await h.tick();assert.equal(h.stages.length,2);assert.equal(h.state().coveredMarker,marker(observed(3)));
});

test('phase65 restored legacy active finishes unchanged before a once-only schema catchup of the same marker',async()=>{
 const seed=seededActive({revision:undefined}),h=harness(state({active:seed.active,exportRevision:undefined}),{publications:seed.publications,initialObserved:observed(1)});
 await h.tick();assert.equal(h.stages.length,0);assert.equal(h.syncs[0].dateIndex,false);assert.equal(h.state().exportRevision,null);assert.equal(h.state().publishedAsOf,seed.active.asOf);
 await h.tick();assert.equal(h.stages.length,1);assert.equal(h.syncs[1].dateIndex,true);assert.equal(h.state().exportRevision,REVISION);assert.equal(h.state().coveredMarker,seed.active.marker);
 assert.ok(h.dbOps.some(op=>op?.baseline===seed.active.asOf&&op.exportRevision===null),
   'the saved prior revision is passed to the baseline validator before schema catchup');
 h.control.now+=60*MINUTE;await h.tick();assert.equal(h.stages.length,1);assert.equal(h.syncs.length,2);
});

test('phase65 full-run blocks a new export while an existing immutable active may still finish',async()=>{
 const waiting=harness(state(),{initialObserved:{...observed(),running:true}});await waiting.tick();assert.equal(waiting.stages.length,0);assert.equal(waiting.syncs.length,0);assert.equal(waiting.writes.length,0);
 const seed=seededActive({revision:undefined}),resuming=harness(state({active:seed.active}),{initialObserved:{...observed(),running:true},publications:seed.publications});await resuming.tick();assert.equal(resuming.stages.length,0);assert.equal(resuming.syncs.length,1);assert.equal(resuming.syncs[0].dateIndex,false);assert.equal(resuming.syncs[0].publication.manifest.asOf,iso(T));
});

test('phase65 crash/restart reuses durable active bytes and retries rather than staging from the newer marker',async()=>{
 const h=harness();h.control.error=Error('synthetic-request-threw');await h.tick();assert.equal(h.stages.length,1);const saved=h.durable(),active=clone(saved.active);assert.ok(active);assert.equal(saved.status,'failed');
 const restart=harness(saved,{now:h.control.now+MINUTE,initialObserved:observed(3),publications:h.publications});await restart.tick();assert.equal(restart.stages.length,0);assert.equal(restart.reads[0],active.directory);assert.equal(restart.state().publishedAsOf,active.asOf);assert.equal(restart.state().coveredMarker,active.marker);
 await restart.tick();assert.equal(restart.stages.length,0,'fresh restored generation still owes its normal 30-minute cooldown');
 restart.control.now=Date.parse(active.asOf)+COOLDOWN;await restart.tick();assert.equal(restart.stages.length,1);assert.equal(restart.state().coveredMarker,marker(observed(3)));
});

test('phase65 lost confirmation persistence replays the old active and does not falsely advance durable coverage',async()=>{
 const seed=seededActive(),initial=state({active:seed.active,coveredMarker:'earlier'}),h=harness(initial,{publications:seed.publications});h.control.saveError=true;await h.tick();assert.deepEqual(h.durable(),initial);
 const restart=harness(h.durable(),{now:h.control.now+MINUTE,publications:seed.publications});await restart.tick();assert.equal(restart.stages.length,0);assert.equal(restart.syncs[0].publication.manifest.asOf,seed.active.asOf);assert.equal(restart.state().coveredMarker,seed.active.marker);
 await restart.tick();assert.equal(restart.stages.length,1,'only a confirmed old active may release one new catchup');
});

test('phase65 actual busy/stopping guards and original active manifest identity stop duplicate work',async()=>{
 const busy=harness();busy.setBusy(true);await busy.tick();assert.equal(busy.stages.length,0);busy.setBusy(false);busy.setStopping(true);await busy.tick();assert.equal(busy.syncs.length,0);
 const seed=seededActive(),h=harness(state({active:{...seed.active,manifestHash:'mismatch'}}),{publications:seed.publications});await h.tick();assert.equal(h.stages.length,0);assert.equal(h.syncs.length,0);assert.equal(h.state().status,'failed');assert.equal(h.state().active.manifestHash,'mismatch');
 let release;const gate=new Promise(resolve=>{release=resolve;}),single=harness();single.control.hold=gate;const first=single.tick();await Promise.resolve();await Promise.resolve();await single.tick();release();await first;assert.equal(single.stages.length,1);assert.equal(single.syncs.length,1);
});

test('phase65 actual run acquires its ownership lock before any state read, watcher, timer or export',async()=>{
 const calls=[],context=vm.createContext({home:'/in-memory-fixture-only',join,privateDirectory:async()=>calls.push('directory'),acquirePublisherLock:async()=>{calls.push('lock');throw Object.assign(Error('publisher-already-running'),{code:'publisher-already-running'});},privateRead:async()=>assert.fail('state must not be read without lock'),setInterval:()=>assert.fail('no timer without lock'),watch:()=>assert.fail('no watcher without lock')});
 const run=vm.runInContext('('+runDeclaration+')',context);await assert.rejects(run(),{code:'publisher-already-running'});assert.deepEqual(calls,['directory','lock']);
});
