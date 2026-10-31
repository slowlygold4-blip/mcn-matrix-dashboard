import { constants, watch } from 'node:fs';
import {ensureBackgroundPriority as ensurePublisherBackgroundPriority} from '../lib/background-priority.mjs';
export {ensurePublisherBackgroundPriority};
import { prunePublicReplicaStaging } from '../lib/public-replica-retention.mjs';
import { open, mkdir, readFile, rename, lstat, link, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { exportPublicReplica, writePublicReplica, PUBLIC_REPLICA_EXPORT_REVISION } from '../lib/public-replica-export.mjs';
import { createPublicReplicaSync, preparePublicReplicaPublication, sealPublicReplicaSource, PUBLIC_REPLICA_OPERATION_MAX_MS } from '../lib/public-replica-sync.mjs';
import { readCommittedTargetPublication, isCommittedTargetPublication, COMMITTED_TARGET_PUBLICATION,
  preparePublishedSnapshotBaseline, attachPublishedSnapshotBaseline, releaseCommittedTargetPublication } from '../lib/committed-target-publication.mjs';
import {readPublicSourceMarker} from '../lib/public-source-marker.mjs';
import {inspectPublicDelivery,publicDeliveryFromSyncFailure} from '../lib/public-delivery-health.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const data=resolve(process.env.DATA_DIR||join(root,'data'));
const home=join(data,'public-replica-publisher');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const fail=code=>{throw Object.assign(new Error(code),{code});};
// A staged generation is immutable. Its preparation features must not change
// merely because a newer executable uses a different export revision.
const legacyDateIndexRevisions=new Set(['catalog-date-range-v1','catalog-date-range-v2-roster-classification','catalog-date-range-v13-publication-scope','catalog-date-range-v14-independent-work-publishers','catalog-date-range-v15-source-field-order','catalog-date-range-v16-source-work-classification','catalog-date-range-v17-publication-date-basis',PUBLIC_REPLICA_EXPORT_REVISION]);
export function shouldPreparePublicDateIndex(active){
  return typeof active?.dateIndex==='boolean' ? active.dateIndex
    : legacyDateIndexRevisions.has(active?.exportRevision);
}

export async function privateRead(path,{credential=false}={}){
  const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const s=await fd.stat();if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||(credential&&s.size>128))fail('unsafe-private-file');
    const text=await fd.readFile('utf8');if(credential){if(!/^[a-f0-9]{64}$/.test(text))fail('invalid-credential');return text;}return JSON.parse(text);
  }finally{await fd.close();}
}
export async function privateWrite(path,value){
  const temp=path+'.partial-'+randomUUID();const fd=await open(temp,'wx',0o600);
  try{await fd.writeFile(JSON.stringify(value)+'\n');await fd.sync();}finally{await fd.close();}
  await rename(temp,path);
}
async function privateDirectory(path){await mkdir(path,{recursive:true,mode:0o700});const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)fail('unsafe-private-directory');}
const recoveryLocker = `import errno, fcntl, sys
try:
    fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError as error:
    print("busy" if error.errno in (errno.EACCES, errno.EAGAIN) else "unavailable", flush=True)
    sys.exit(1)
print("locked", flush=True)
sys.stdin.buffer.read()
`;

/** OS-managed short-lived mutex. The inode stays in place; its lock cannot
 * become an orphan directory after a crash. This never reads a credential. */
export async function withPublisherRecoveryLock(path, callback, {
  pythonPath = process.env.PYTHON_BIN || '/usr/bin/python3', timeoutMs = 5000,
} = {}) {
  if (typeof callback !== 'function' || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 5000) fail('invalid-recovery-configuration');
  const fd = await open(path + '.recovery-lock', constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  let child;
  try {
    const s = await fd.stat();
    if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600
      || s.nlink !== 1 || s.size !== 0) fail('unsafe-publisher-recovery');
    child = spawn(pythonPath, ['-I', '-c', recoveryLocker], {
      stdio: ['pipe', 'pipe', 'ignore', fd.fd], shell: false,
    });
    child.stdin.on('error', () => {});
    await new Promise((ok, no) => {
      let output = '', settled = false;
      const finish = code => {
        if (settled) return; settled = true; clearTimeout(timer);
        code ? no(Object.assign(new Error(code), { code })) : ok();
      };
      const timer = setTimeout(() => finish('publisher-recovery-unavailable'), timeoutMs);
      child.on('error', () => finish('publisher-recovery-unavailable'));
      child.once('exit', () => finish('publisher-recovery-unavailable'));
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output === 'locked\n') finish();
        else if (output === 'busy\n') finish('publisher-recovery-busy');
        else if (output.length > 64 || output.includes('\n')) finish('publisher-recovery-unavailable');
      });
    });
    // Keep the inherited open-file description alive until callback finishes,
    // even if the helper exits unexpectedly. Never unlink the mutex inode.
    return await callback();
  } finally {
    child?.stdin.end();
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise(ok => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); ok(); }, 1000);
        child.once('close', () => { clearTimeout(timer); ok(); });
      });
    }
    await fd.close();
  }
}

export async function acquirePublisherLock(path) {
  // Read-only fast denial is safe: it never grants ownership or removes a
  // lock. It also preserves the existing live-owner error under contention.
  try {
    const current = await privateRead(path);
    if (Number.isSafeInteger(current.pid) && current.pid > 0) {
      try { process.kill(current.pid, 0); fail('publisher-already-running'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return withPublisherRecoveryLock(path, async () => {
    // An old, ownerless guard may still belong to an older executable. Do not
    // guess from age or delete it; preserve the previous fail-closed contract.
    try { await lstat(path + '.recovery'); fail('EEXIST'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let current;
    try { current = await privateRead(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current) {
      if (!Number.isSafeInteger(current.pid) || current.pid <= 0 || typeof current.instance !== 'string')
        fail('uncertain-publisher-lock');
      try { process.kill(current.pid, 0); fail('publisher-already-running'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      await rename(path, path + '.stale-' + randomUUID());
    }
    const owner = { pid: process.pid, instance: randomUUID(), startedAt: new Date().toISOString() };
    const temporary = path + '.claim-' + owner.instance;
    const fd = await open(temporary, 'wx', 0o600);
    try { await fd.writeFile(JSON.stringify(owner)); await fd.sync(); }
    finally { await fd.close(); }
    try { await link(temporary, path); }
    finally { await unlink(temporary); }
    return owner;
  });
}
/** Expose preparation before any slow source/baseline reads. A previous
 * successful publication does not mean the daemon is currently idle. */
export async function recordPublisherPreparation(path, state, at) {
  if (state.active || !iso(at)) fail('invalid-preparation');
  const next = { ...state, status: 'preparing', code: null, checkedAt: at };
  await privateWrite(path, next);
  Object.assign(state, next);
}
export async function recordPublisherSyncStart(path,state,at){
  if(!iso(at)||!iso(state.active?.asOf)||Date.parse(state.active.asOf)>Date.parse(at))fail('invalid-sync-start');
  const next={...state,status:'syncing',code:null,checkedAt:at,
    lastSync:state.sync?.status==='running'?(state.lastSync??null):(state.sync??state.lastSync??null),
    sync:{status:'running',phase:'sync',asOf:state.active.asOf,requestEncoding:'gzip',reuseUnchanged:true}};
  await privateWrite(path,next);Object.assign(state,next);
}
export function validatedReceipt(run,receipt,now=Date.now()){
  return Number.isSafeInteger(run.id)&&run.id>0&&run.status!=='running'&&iso(run.started_at)&&iso(run.finished_at)
    &&Date.parse(run.started_at)<=Date.parse(run.finished_at)&&Date.parse(run.finished_at)<=now
    &&receipt?.version===1&&receipt.runId===run.id&&receipt.eventId===`collection-run-${run.id}`
    &&receipt.startedAt===run.started_at&&receipt.finishedAt===run.finished_at&&receipt.triggerType===run.trigger_type
    &&receipt.runStatus===run.status&&iso(receipt.reviewedAt)&&Date.parse(receipt.reviewedAt)>=Date.parse(run.finished_at)
    &&Date.parse(receipt.reviewedAt)<=now;
}
export function completedSourceMarker(manifest,now=Date.now()){
  if(!iso(manifest?.lastFinishedAt)||Date.parse(manifest.lastFinishedAt)>now)return null;
  if(Object.values(manifest.sources||{}).some(v=>['pending','running'].includes(v.lastStatus)))return null;
  const finished=[manifest.lastFinishedAt,manifest.lastIncrementalFinishedAt,manifest.lastPendingCheckedAt].filter(iso);if(finished.some(time=>Date.parse(time)>now))return null;
  // Intermediate job/status writes preserve these completion timestamps.
  // Do not treat those unfinished writes as a new completed source check.
  return hash({finished});
}
/** Cheap admission before reading receipts/source rows from the business DB. */
export function canPreparePublicReplica(state, now = Date.now()) {
  if (state.active || !Number.isFinite(now)) return false;
  if (!state.lastConfirmedPublishedAt) return true;
  const confirmedAt = Date.parse(state.lastConfirmedPublishedAt);
  // A rolled-back clock or invalid confirmation cannot grant publication.
  if (!Number.isFinite(confirmedAt) || confirmedAt > now) return false;
  // A schema upgrade must publish its new read model without waiting for a
  // collection change or another cadence interval. Active generations above
  // still resume unchanged, and ordinary updates retain the 30-minute limit.
  if (state.exportRevision && state.exportRevision !== PUBLIC_REPLICA_EXPORT_REVISION) return true;
  // Retry the saved immutable generation until confirmed, then catch up to
  // changed data on the next ordinary tick if that generation is already old.
  // A fresh generation still resets the 30-minute export cadence. Legacy or
  // invalid generation timestamps retain the confirmation-time fallback.
  const publishedAt = iso(state.publishedAsOf) ? Date.parse(state.publishedAsOf) : NaN;
  const cadenceAt = Number.isFinite(publishedAt) && publishedAt <= confirmedAt
    ? publishedAt : confirmedAt;
  return now - cadenceAt >= 1800000;
}
export function shouldStagePublicReplica(state, observed, now = Date.now()) {
  if ((observed.running && !isCommittedTargetPublication(observed.committedPublication))
    || (observed.marker === state.coveredMarker && state.exportRevision === PUBLIC_REPLICA_EXPORT_REVISION)) return false;
  return canPreparePublicReplica(state, now);
}
async function readPublication(directory){
  const allowed=join(data,'public-replica-staging')+'/';if(!resolve(directory).startsWith(allowed))fail('invalid-staging-directory');
  const readPart=async relative=>{for(const part of [dirname(directory),directory,...(relative.includes('/')?[join(directory,dirname(relative))]:[])]){const s=await lstat(part);if(!s.isDirectory()||s.isSymbolicLink())fail('unsafe-staging-path');}
    const fd=await open(join(directory,relative),constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await fd.stat();if(!s.isFile())fail('unsafe-staging-path');return await fd.readFile('utf8');}finally{await fd.close();}};
  const manifest=JSON.parse(await readPart('manifest.json'));
  const files=[];for(const meta of manifest.files){if(!/^(catalog|topics|summary|publishing)\.json$|^publishing\/\d{6}\.json$|^creator\/(index|authors|insights|works-\d{3})\.json$|^foundation\/(index|authors|works|sources|observations|other-authors|other-works|pending-authors)\.json$|^(daily|works|work-metrics)\/[1-9]\d{0,7}\.json$/.test(meta.path))fail('invalid-partition-path');files.push({...meta,content:await readPart(meta.path)});}
  return {manifest,files};
}
async function observe(db,asOf){
  const now=Date.parse(asOf);let runs,running;
  running=Boolean(db.prepare("SELECT 1 FROM runs WHERE status='running' AND trigger_type='scheduled' LIMIT 1").get());
    // Finish-time order remains correct when a lower run ID completes later.
  runs=db.prepare("SELECT id,trigger_type,started_at,finished_at,status FROM runs WHERE finished_at IS NOT NULL AND status<>'running' ORDER BY finished_at DESC,id DESC LIMIT 128").all();
  const events=[];for(const run of runs){let receipt;try{receipt=JSON.parse(await readFile(join(data,'ingestion-reviews',`run-${run.id}.json`),'utf8'));}catch{continue;}
    if(validatedReceipt(run,receipt,now)&&(receipt.snapshotCount>0||receipt.worksOnly?.accepted>0))events.push({id:run.id,finishedAt:run.finished_at});}
  let source=null;try{source=completedSourceMarker(JSON.parse(await readFile(join(data,'source-poll','manifest.json'),'utf8')),now);}catch{}
  const dataMarker=readPublicSourceMarker(db,asOf);
  return {running,events,source,dataMarker,marker:hash({events,source,dataMarker})};
}
async function configure(){
  await privateDirectory(home);if(process.stdin.isTTY)process.stdin.setRawMode(true);
  console.log('Ready for private configuration JSON; terminal echo disabled.');
  let raw;try{raw=await new Promise((ok,no)=>{let text='';const receive=chunk=>{text+=chunk;if(text.length>10000){process.stdin.off('data',receive);no(Error('configuration-too-large'));}else if(text.includes('\n')){process.stdin.off('data',receive);ok(text.slice(0,text.indexOf('\n')));}};process.stdin.on('data',receive);process.stdin.resume();});}
  finally{if(process.stdin.isTTY)process.stdin.setRawMode(false);process.stdin.pause();}const input=JSON.parse(raw);
  if(!/^[a-f0-9]{64}$/.test(input.secret))fail('invalid-credential');
  const publication=await readPublication(input.initialDirectory);await preparePublicReplicaPublication(publication);
  const credentialPath=join(home,'credential');const fd=await open(credentialPath,'wx',0o600);try{await fd.writeFile(input.secret);await fd.sync();}finally{await fd.close();}
  await privateWrite(join(home,'state.json'),{version:1,active:{directory:input.initialDirectory,asOf:publication.manifest.asOf,manifestHash:hash(publication.manifest),marker:null,source:null},coveredMarker:null,coveredSource:null,lastConfirmedPublishedAt:null,status:'configured'});
  console.log(JSON.stringify({configured:true,credentialMode:'0600',runtimeAI:false}));
}
/** A disposable V8 isolate owns each export/sync cycle. Once its final state
 * is durable, termination releases the large source/validation heap instead of
 * retaining it in the idle daemon. The parent alone owns the process lock. */
export function runPublisherCycleWorker(owner, {signal,dataDir=data,workerFactory=options=>new Worker(new URL(import.meta.url),options)}={}){
  if(!isMainThread||owner?.pid!==process.pid||typeof owner?.instance!=='string'||!owner.instance) return Promise.reject(Object.assign(new Error('invalid-publisher-worker-owner'),{code:'invalid-publisher-worker-owner'}));
  if(signal?.aborted)return Promise.reject(Object.assign(new Error('publisher-worker-aborted'),{code:'publisher-worker-aborted'}));
  return new Promise((ok,no)=>{
    let worker,completed=false,failed=false;
    const stop=()=>{try{worker?.postMessage('stop');}catch{}};
    const cleanup=()=>signal?.removeEventListener('abort',stop);
    try{worker=workerFactory({workerData:{kind:'publisher-cycle',ownerInstance:owner.instance},env:{...process.env,DATA_DIR:resolve(dataDir)}});}
    catch{no(Object.assign(new Error('publisher-worker-failed'),{code:'publisher-worker-failed'}));return;}
    worker.on('message',message=>{
      if(message!=='publisher-cycle-complete')return;
      completed=true;
      // The cycle includes state persistence and retention. No generation
      // writes remain in flight when this completion message is emitted.
      Promise.resolve(worker.terminate()).catch(()=>{});
    });
    worker.once('error',()=>{failed=true;});
    worker.once('exit',()=>{
      cleanup();
      if(completed&&!failed)ok({status:'completed'});
      else no(Object.assign(new Error('publisher-worker-failed'),{code:'publisher-worker-failed'}));
    });
    signal?.addEventListener('abort',stop,{once:true});
    if(signal?.aborted)stop();
  });
}
async function runPublisherCycle(ownerInstance){
  await privateDirectory(home);
  const owner=await privateRead(join(home,'lock.json'));
  if(isMainThread||owner.pid!==process.pid||owner.instance!==ownerInstance)fail('invalid-publisher-worker-owner');
  const statePath=join(home,'state.json');let state=await privateRead(statePath);if(state.version!==1)fail('invalid-state');
  let busy=false,stopping=false,immutableStage=null;const signal=new AbortController();
  // Full uploads plus seventeen bounded source audits exceed the legacy
  // eight-minute window. Keep one finite operation, request deadlines and the
  // caller's cancellation; never discard checkpoints to force a restart.
  const sync=createPublicReplicaSync({operationTimeoutMs:PUBLIC_REPLICA_OPERATION_MAX_MS,activationTimeoutMs:300_000,compressRequests:true,reuseUnchanged:true,chunkedDateAudit:true,getCredential:()=>privateRead(join(home,'credential'),{credential:true}),
    loadCheckpoint:async()=>{try{return await privateRead(join(home,'checkpoint.json'));}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    saveCheckpoint:value=>privateWrite(join(home,'checkpoint.json'),value)});
  const tick=async()=>{
    if(busy||stopping)return;busy=true;
    try{
      if(!state.active){
        if(!canPreparePublicReplica(state))return;
        const asOf=new Date().toISOString(),directory=join(data,'public-replica-staging','publisher-'+asOf.replace(/[:.]/g,'-'));
        const db=new DatabaseSync(join(data,'douyin-monitor.sqlite'),{readOnly:true});let replica,observed;
        try{db.exec('PRAGMA query_only=ON;BEGIN');
          observed=await observe(db,asOf);observed.source??=state.coveredSource;
          observed.committedPublication=readCommittedTargetPublication(db,{asOf});
          observed.marker=hash({events:observed.events,source:observed.source,dataMarker:observed.dataMarker,
            ...(observed.committedPublication.runningSnapshotCount>0 ? {contract:COMMITTED_TARGET_PUBLICATION,
              committedTargets:observed.committedPublication.marker} : {})});
          if(!shouldStagePublicReplica(state, observed,Date.parse(asOf)))return;
          await recordPublisherPreparation(statePath,state,asOf);
          if(state.publishedAsOf){
            if(state.sync?.status!=='success'||state.sync.asOf!==state.publishedAsOf)fail('invalid-published-baseline');
            const previous=await readPublication(join(data,'public-replica-staging','publisher-'+state.publishedAsOf.replace(/[:.]/g,'-')));
            const baseline=await preparePublishedSnapshotBaseline(previous,{asOf:state.publishedAsOf,manifestSha256:state.sync.manifestSha256,exportRevision:state.exportRevision});
            attachPublishedSnapshotBaseline(observed.committedPublication,baseline);
          }
          replica=exportPublicReplica(db,{asOf,committedPublication:observed.committedPublication});
          if(db.prepare('SELECT total_changes() n').get().n!==0)fail('unexpected-write');}
        finally{releaseCommittedTargetPublication(observed?.committedPublication);try{db.exec('ROLLBACK');}catch{}db.close();}
        const manifest=await writePublicReplica(directory,replica);
        state.active={directory,asOf,manifestHash:hash(manifest),marker:observed.marker,source:observed.source,exportRevision:PUBLIC_REPLICA_EXPORT_REVISION,dateIndex:true,publicationContract:COMMITTED_TARGET_PUBLICATION};state.status='staged';await privateWrite(statePath,state);
      }
      if(!immutableStage||immutableStage.directory!==state.active.directory||immutableStage.manifestHash!==state.active.manifestHash){
        const publication=await readPublication(state.active.directory);if(publication.manifest.asOf!==state.active.asOf||hash(publication.manifest)!==state.active.manifestHash)fail('staging-version-conflict');
        immutableStage={directory:state.active.directory,manifestHash:state.active.manifestHash,source:sealPublicReplicaSource(publication)};
      }
      await recordPublisherSyncStart(statePath,state,new Date().toISOString());
      const result=await sync.sync(immutableStage.source,{signal:signal.signal,dateIndex:shouldPreparePublicDateIndex(state.active)});
      state.status=result.status;state.code=result.code??null;state.checkedAt=new Date().toISOString();state.sync=result;
      const accessFailure=publicDeliveryFromSyncFailure(result,state.checkedAt);
      if(accessFailure)state.publicAccess=accessFailure;
      if(result.status==='success'){
        // Publication is already verified. Visitor failures are independent
        // and must not force duplicate exports/uploads of this generation.
        state.publicAccess=await inspectPublicDelivery({asOf:result.asOf,manifestSha256:result.manifestSha256},{signal:signal.signal});
        state.lastConfirmedPublishedAt=state.checkedAt;state.publishedAsOf=state.active.asOf;
        // The seed has no event watermark: finished data newer than it still triggers the next publication.
        state.coveredMarker=state.active.marker;state.coveredSource=state.active.source;state.exportRevision=state.active.exportRevision??null;
        state.publicationContract=state.active.publicationContract??null;state.active=null;immutableStage=null;
      }
      await privateWrite(statePath,state);console.log(JSON.stringify({status:state.status,code:state.code,asOf:state.active?.asOf??state.publishedAsOf,publicAccessStatus:state.publicAccess&&state.publicAccess.asOf===(state.active?.asOf??state.publishedAsOf)?state.publicAccess.status:'not-checked',publicAccessAsOf:state.publicAccess?.asOf??null,runtimeAI:false}));
      if(result.status==='success')try{const retention=await prunePublicReplicaStaging({dataDir:data,dryRun:false});console.log(JSON.stringify({cacheRetention:retention.status,removed:retention.removed.length,runtimeAI:false}));}catch(error){console.error('cache-retention-deferred',error.code||error.name);}
    }catch(e){state.status='failed';state.code=['invalid-source','invalid-summary','unsafe-private-file','invalid-staging-directory'].includes(e.code)?e.code:'publisher-check-failed';state.checkedAt=new Date().toISOString();await privateWrite(statePath,state).catch(()=>{});console.log(JSON.stringify({status:'failed',code:state.code,runtimeAI:false}));}
    finally{busy=false;}
  };
  const stop=message=>{if(message==='stop'){stopping=true;signal.abort();}};
  parentPort.on('message',stop);
  try{await tick();}finally{parentPort.off('message',stop);}
}
async function run(){
  await privateDirectory(home);const owner=await acquirePublisherLock(join(home,'lock.json'));
  const statePath=join(home,'state.json');
  let busy=false,stopping=false;const signal=new AbortController();
  const tick=async()=>{
    if(busy||stopping)return;busy=true;
    try{
      // Source/receipt watchers may fire in bursts. Retain the cheap cooldown
      // gate in the parent so an ineligible event never starts a heavy isolate.
      const state=await privateRead(statePath);
      if(!state.active&&!canPreparePublicReplica(state))return;
      await runPublisherCycleWorker(owner,{signal:signal.signal});
    }
    catch{console.error(JSON.stringify({status:'deferred',code:'publisher-worker-failed',runtimeAI:false}));}
    finally{busy=false;}
  };
  // Keep the existing reconciliation timer/watchers; there is at most one
  // cycle worker. It never collects platform data or invokes AI.
  const timer=setInterval(()=>void tick(),60000);const watchers=[];
  for(const directory of [join(data,'ingestion-reviews'),join(data,'source-poll')]){try{const w=watch(directory,()=>void tick());w.on('error',()=>{});watchers.push(w);}catch{}}
  process.once('SIGTERM',()=>{stopping=true;signal.abort();clearInterval(timer);watchers.forEach(w=>w.close());});
  process.once('SIGINT',()=>process.emit('SIGTERM'));
  await tick();
}
if(!isMainThread&&workerData?.kind==='publisher-cycle'){
  try{await runPublisherCycle(workerData.ownerInstance);parentPort.postMessage('publisher-cycle-complete');}
  catch{process.exitCode=1;parentPort.close();}
}else if(isMainThread&&process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(ensurePublisherBackgroundPriority().status==='deferred')console.error(JSON.stringify({code:'publisher-background-priority-deferred',runtimeAI:false}));
  try{if(process.argv.includes('--configure'))await configure();else await run();}
  catch(e){console.error(JSON.stringify({status:'stopped',code:['publisher-already-running','uncertain-publisher-lock','unsafe-private-file','unsafe-private-directory'].includes(e.code)?e.code:'publisher-start-failed',runtimeAI:false}));process.exitCode=1;}
}
