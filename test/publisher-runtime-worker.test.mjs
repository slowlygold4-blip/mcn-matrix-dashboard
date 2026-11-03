import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {Worker} from 'node:worker_threads';import {createHash} from 'node:crypto';
import {MonitorDatabase} from '../lib/database.mjs';
import {exportPublicReplica,writePublicReplica,PUBLIC_REPLICA_EXPORT_REVISION} from '../lib/public-replica-export.mjs';
import {PUBLIC_REPLICA_VALIDATION_CONTRACT} from '../lib/public-replica-sync.mjs';
import {PUBLISHER_RUNTIME_REVISION} from '../lib/publisher-runtime.mjs';
import {privateWrite,privateRead,runPublisherCycleWorker} from '../scripts/public-replica-publisher.mjs';

test('a fresh real worker records loaded contracts and phase memory while a failed public preflight cannot publish',{timeout:20000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mcn-runtime-stamp-')),home=join(directory,'public-replica-publisher');
 const db=new MonitorDatabase(':memory:'),asOf='2026-09-20T12:00:00.000Z';const attemptedMethods=[];
 try{
  await mkdir(home,{mode:0o700});
  db.createTarget({type:'account',label:'Synthetic runtime stamp',locator:'MS4wLjABAAAARuntimeStampFixture',provider:'public-web',metadata:{platform:'douyin'}});
  const stage=join(directory,'public-replica-staging','synthetic-generation');
  const manifest=await writePublicReplica(stage,exportPublicReplica(db,{asOf}));
  const before=await readFile(join(stage,'manifest.json'),'utf8');
  const owner={pid:process.pid,instance:'synthetic-runtime-owner'};await privateWrite(join(home,'lock.json'),owner);
  await privateWrite(join(home,'state.json'),{version:1,status:'staged',publishedAsOf:null,active:{directory:stage,asOf,manifestHash:createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),exportRevision:PUBLIC_REPLICA_EXPORT_REVISION,dateIndex:true}});
  const noNetwork='data:text/javascript,'+encodeURIComponent("import {parentPort} from 'node:worker_threads';globalThis.fetch=async(_url,options)=>{parentPort.postMessage({kind:'blocked-fetch-attempt',method:options?.method??'GET'});throw Error('no-network-fixture');};");
  await runPublisherCycleWorker(owner,{dataDir:directory,workerFactory:options=>{
   const worker=new Worker(new URL('../scripts/public-replica-publisher.mjs',import.meta.url),{...options,execArgv:['--import',noNetwork]});
   worker.on('message',message=>{if(message?.kind==='blocked-fetch-attempt')attemptedMethods.push(message.method);});return worker;
  }});
  const state=await privateRead(join(home,'state.json'));assert.equal(state.status,'failed');assert.equal(state.publishedAsOf,null);
  assert.equal(state.publisherRuntime.revision,PUBLISHER_RUNTIME_REVISION);
  assert.equal(state.publisherRuntime.validationContract,PUBLIC_REPLICA_VALIDATION_CONTRACT);
  assert.equal(state.publisherRuntime.exportRevision,PUBLIC_REPLICA_EXPORT_REVISION);
  assert.deepEqual(state.publisherRuntime.samples.map(s=>s.phase),['source-sealed','sync-started','sync-finished','cycle-finished']);
  assert.ok(state.publisherRuntime.samples.every(s=>Number.isSafeInteger(s.rssBytes)&&s.rssBytes>0));
  assert.deepEqual(attemptedMethods,['GET'],'only the public preflight lookup is attempted; no upload/activation or real network is permitted');
  assert.equal(await readFile(join(stage,'manifest.json'),'utf8'),before);
  await assert.rejects(readFile(join(directory,'douyin-monitor.sqlite')),{code:'ENOENT'});
 }finally{db.close();await rm(directory,{recursive:true,force:true});}
});
