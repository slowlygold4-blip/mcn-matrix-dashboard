/** Shared bounded source-index job; no scheduler, browser, model or subprocess. */
import {DatabaseSync} from 'node:sqlite';
import {mkdir,readFile,writeFile,unlink,realpath,readdir,rename} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {shortWorkLink,readWorkLinkReceipts,resolveWorkSourceLink,commitWorkLinkReceipt} from './work-source-link-receipts.mjs';
import {recoveredWorkSourceRows} from './work-source-row-projection.mjs';

export async function waitForWorkSourceBackup({backupDirectory,signal,now=Date.now,pause=delay,
  readOwner=async()=>{try{return JSON.parse(await readFile(join(backupDirectory,'.automatic-backup.lock'),'utf8'));}
    catch(error){if(error.code==='ENOENT')return null;throw Error('work-link-backup-lock-invalid');}},
  isAlive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}},onWaiting=async()=>{},maxWaitMs=12*60000}={}){
  const started=now();let notified=false;
  for(;;){
    if(signal?.aborted)throw Error('work-link-cancelled');
    const owner=await readOwner();if(!owner)return;
    if(!Number.isSafeInteger(owner.pid)||owner.pid<1)throw Error('work-link-backup-lock-invalid');
    if(!isAlive(owner.pid))return;
    if(now()-started>=maxWaitMs)throw Error('work-link-backup-busy');
    if(!notified){await onWaiting();notified=true;}
    await pause(1000,undefined,{signal});
  }
}

export function workSourceLinkPlan(db,{versionId,limit=500,now=Date.now}={}){
  if(!Number.isSafeInteger(versionId)||versionId<1||!Number.isSafeInteger(limit)||limit<1||limit>500)
    throw Error('invalid-work-link-plan');
  const prior=readWorkLinkReceipts(db,{asOf:new Date(now()).toISOString()});const resolved=new Set(prior.filter(r=>r.status==='resolved').map(r=>r.requestedUrl));
  const retryTimes=new Map();
  for(const r of prior)if(r.status!=='resolved')retryTimes.set(r.requestedUrl,
    Math.max(retryTimes.get(r.requestedUrl)||0,Date.parse(r.observedAt)+24*3600000));
  const groups=new Map();
  if(!db.prepare('SELECT 1 FROM work_source_versions WHERE id=?').get(versionId))throw Error('work-link-source-version-missing');
  const rows=db.prepare(`SELECT b.sha256,b.fact_json FROM work_source_version_facts m
    JOIN work_source_fact_blobs b ON b.sha256=m.fact_sha256 WHERE m.version_id=? AND b.content_id IS NULL ORDER BY m.ordinal`).all(versionId);
  rows.push(...recoveredWorkSourceRows(db,versionId).filter(row=>!row.fact.contentId).map(row=>({sha256:row.sha256,fact_json:row.json})));
  for(const r of rows){
    if(createHash('sha256').update(r.fact_json).digest('hex')!==r.sha256)throw Error('work-link-source-fact-corrupt');
    const fact=JSON.parse(r.fact_json),url=shortWorkLink(fact.url);
    if(!url||resolved.has(url))continue;
    if(groups.has(url)){groups.get(url).factCount++;continue;}
    groups.set(url,{url,sourceVersionId:versionId,sourceFactSha256:r.sha256,factCount:1});
  }
  const eligible=[...groups.values()].filter(item=>(retryTimes.get(item.url)||0)<=now());
  const cold=[...groups.keys()].map(url=>retryTimes.get(url)||0).filter(ms=>ms>now());
  const upstream=prior.filter(r=>['http_401','http_403','http_429','network_error','timeout'].includes(r.status))
    .map(r=>({until:Date.parse(r.observedAt)+(['network_error','timeout'].includes(r.status)?5*60000:24*3600000),status:r.status}))
    .filter(r=>r.until>now()).sort((a,b)=>b.until-a.until)[0];
  if(upstream&&groups.size)return {items:[],eligibleTotal:0,unresolvedTotal:groups.size,coolingDownTotal:groups.size,
    nextEligibleAt:new Date(upstream.until).toISOString(),upstreamCode:upstream.status.replaceAll('_','-')};
  return {items:eligible.slice(0,limit),eligibleTotal:eligible.length,unresolvedTotal:groups.size,
    coolingDownTotal:cold.length,nextEligibleAt:cold.length?new Date(Math.min(...cold)).toISOString():null};
}
export const pendingWorkSourceLinks=(db,options)=>workSourceLinkPlan(db,options).items;

const livePid=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
async function sourceLinkLease(directory){
  // Unique atomic lease files allow a crashed process to stop blocking the
  // next worker without ever unlinking another contender's lock.
  const home=join(directory,'.work-link-leases');await mkdir(home,{recursive:true,mode:0o700});
  const name=randomUUID()+'.json',file=join(home,name),temp=file+'.partial';
  await writeFile(temp,JSON.stringify({pid:process.pid,instance:name}),{flag:'wx',mode:0o600});await rename(temp,file);
  const release=()=>unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});
  try{
    // Respect an older CLI that is still holding the former fixed lock.
    try{const old=JSON.parse(await readFile(join(directory,'.work-link-resolver.lock'),'utf8'));
      if(!Number.isSafeInteger(old.pid)||old.pid<1||livePid(old.pid)){await release();return null;}
    }catch(error){if(error.code!=='ENOENT')throw Error('work-link-legacy-lock-uncertain');}
    for(const other of await readdir(home)){
      if(other===name||!other.endsWith('.json'))continue;
      let owner;try{owner=JSON.parse(await readFile(join(home,other),'utf8'));}
      catch(error){if(error.code==='ENOENT')continue;throw Error('work-link-lease-uncertain');}
      if(!Number.isSafeInteger(owner.pid)||owner.pid<1||livePid(owner.pid)){await release();return null;}
    }
    return release;
  }catch(error){await release();throw error;}
}

export async function runWorkSourceLinkBatch({databasePath,versionId,reportDirectory,execute=true,limit=500,delayMs=700,
  beforeCommit,signal,now=Date.now,resolveLink=resolveWorkSourceLink,waitBackup=waitForWorkSourceBackup}={}){
  if(!Number.isSafeInteger(delayMs)||delayMs<500||delayMs>10000)throw Error('invalid-work-link-delay');
  const path=await realpath(databasePath),reportDir=resolve(reportDirectory);
  await mkdir(reportDir,{recursive:false,mode:0o700});
  let release,db;
  const result={version:1,startedAt:new Date(now()).toISOString(),mode:execute?'execute':'preview',runtimeAI:false,
    sourceVersionId:versionId,batchLimit:limit,planned:0,processed:0,resolved:0,failures:0,
    remaining:0,unresolved:0,coolingDown:0,retryAt:null,status:'planning',counts:{}};
  const save=()=>writeFile(join(reportDir,'result.json'),JSON.stringify({...result,updatedAt:new Date(now()).toISOString()},null,2)+'\n',{mode:0o600});
  try{
    if(execute){
      release=await sourceLinkLease(dirname(path));
      if(!release){
        result.status='deferred';result.code='work-link-job-busy';await save();return result;
      }
    }
    db=new DatabaseSync(path,{readOnly:true});const plan=workSourceLinkPlan(db,{versionId,limit,now});db.close();db=null;
    const planned=plan.items;result.remaining=plan.eligibleTotal;result.unresolved=plan.unresolvedTotal;result.coolingDown=plan.coolingDownTotal;
    if(plan.upstreamCode){result.phase='upstream-cooldown';result.code=plan.upstreamCode;}
    result.planned=planned.length;await writeFile(join(reportDir,'plan.json'),JSON.stringify(planned,null,2),{flag:'wx',mode:0o600});
    if(!execute){result.status='preview';await save();return result;}
    if(planned.length){
      const yieldBackup=()=>waitBackup({backupDirectory:join(dirname(path),'backups','automatic'),signal,now,
        onWaiting:async()=>{result.phase='waiting-backup';await save();}});
      await yieldBackup();
      if(typeof beforeCommit!=='function')throw Error('work-link-backup-required');
      const backup=await beforeCommit();if(backup?.validated!==true)throw Error('work-link-verified-backup-required');
      await writeFile(join(reportDir,'backup-validation.json'),JSON.stringify(backup,null,2),{flag:'wx',mode:0o600});
      db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');
      result.status='running';await save();let empty=0;
      for(const item of planned){
        if(signal?.aborted){result.status='cancelled';break;}
        await yieldBackup();result.phase='resolving';
        const receipt=await resolveLink({...item,signal,now});
        const saved=commitWorkLinkReceipt(db,receipt,{backupValidated:true,now});
        result.processed++;result.counts[receipt.status]=(result.counts[receipt.status]||0)+1;
        if(receipt.status==='resolved'){result.resolved++;empty=0;}else{result.failures++;empty++;}
        result.remaining=plan.eligibleTotal-result.processed;result.unresolved=plan.unresolvedTotal-result.resolved;
        result.coolingDown=plan.coolingDownTotal+result.failures;
        await writeFile(join(reportDir,saved.sha256+'.json'),JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
        if(['http_401','http_403','http_429','network_error','timeout'].includes(receipt.status)||empty>=5){
          result.status='stopped-upstream';result.code=receipt.status.replaceAll('_','-');await save();break;
        }
        await save();if(result.processed<planned.length)await delay(delayMs,undefined,{signal});
      }
    }
    if(['running','planning'].includes(result.status))result.status='completed';
    if(result.status==='stopped-upstream')result.retryAt=new Date(now()+(['network-error','timeout'].includes(result.code)?5*60000:24*3600000)).toISOString();
    // A successful page is continuation, not a failed request. Retain the
    // per-request delay and single-flight lease; failures keep their cooldown.
    else if(result.remaining>0)result.retryAt=new Date(now()+(result.status==='completed'&&result.failures===0?15_000:5*60000)).toISOString();
    else if(result.unresolved>0){
      const candidates=[plan.nextEligibleAt,...(result.failures?[new Date(now()+24*3600000).toISOString()]:[])].filter(Boolean);
      result.retryAt=candidates.sort()[0]||null;
    }
    if(result.retryAt&&Date.parse(result.retryAt)<=now())result.retryAt=new Date(now()+1000).toISOString();
    result.finishedAt=new Date(now()).toISOString();await save();return result;
  }catch(error){
    result.status=signal?.aborted?'cancelled':'failed';
    result.code=/^[a-z][a-z0-9-]{1,100}$/.test(error.message)?error.message:'work-link-job-failed';
    result.finishedAt=new Date(now()).toISOString();await save();return result;
  }finally{
    db?.close();if(release)await release();
  }
}
