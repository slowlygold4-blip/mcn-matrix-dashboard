/** One serial ordinary HTTP data job. No browser, token/signature service or model. */
import {DatabaseSync} from 'node:sqlite';
import {mkdir,readFile,writeFile,open,unlink,realpath} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {SQLiteBackupManager} from '../lib/backup-manager.mjs';
import {shortWorkLink,readWorkLinkReceipts,resolveWorkSourceLink,commitWorkLinkReceipt} from '../lib/work-source-link-receipts.mjs';

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

export function pendingWorkSourceLinks(db,{versionId,limit=500,now=Date.now}={}){
  if(!Number.isSafeInteger(versionId)||versionId<1||!Number.isSafeInteger(limit)||limit<1||limit>500)
    throw Error('invalid-work-link-plan');
  const prior=readWorkLinkReceipts(db,{asOf:new Date(now()).toISOString()});const resolved=new Set(prior.filter(r=>r.status==='resolved').map(r=>r.requestedUrl));
  const recent=new Set(prior.filter(r=>now()-Date.parse(r.observedAt)<24*3600000).map(r=>r.requestedUrl));
  const groups=new Map();
  if(!db.prepare('SELECT 1 FROM work_source_versions WHERE id=?').get(versionId))throw Error('work-link-source-version-missing');
  for(const r of db.prepare(`SELECT b.sha256,b.fact_json FROM work_source_version_facts m
    JOIN work_source_fact_blobs b ON b.sha256=m.fact_sha256 WHERE m.version_id=? AND b.content_id IS NULL ORDER BY m.ordinal`).iterate(versionId)){
    if(createHash('sha256').update(r.fact_json).digest('hex')!==r.sha256)throw Error('work-link-source-fact-corrupt');
    const fact=JSON.parse(r.fact_json),url=shortWorkLink(fact.url);
    if(!url||resolved.has(url)||recent.has(url))continue;
    if(groups.has(url)){groups.get(url).factCount++;continue;}
    groups.set(url,{url,sourceVersionId:versionId,sourceFactSha256:r.sha256,factCount:1});
  }
  return [...groups.values()].slice(0,limit);
}

async function main(){
  const flags=new Map(),args=process.argv.slice(2);let execute=false;
  const allowed=new Set(['--database','--version-id','--report-directory','--backup-path','--limit','--delay-ms']);
  for(let i=0;i<args.length;i++){
    if(args[i]==='--execute'&&!execute){execute=true;continue;}
    if(!allowed.has(args[i])||!args[i+1]||args[i+1].startsWith('--')||flags.has(args[i]))throw Error('invalid-work-link-arguments');
    flags.set(args[i],args[++i]);
  }
  if(!flags.has('--database')||!flags.has('--version-id')||!flags.has('--report-directory'))throw Error('work-link-arguments-required');
  const databasePath=await realpath(flags.get('--database')),versionId=Number(flags.get('--version-id'));
  const limit=Number(flags.get('--limit')||500),delayMs=Number(flags.get('--delay-ms')||700);
  if(!Number.isSafeInteger(delayMs)||delayMs<500||delayMs>10000)throw Error('invalid-work-link-delay');
  const reportDir=resolve(flags.get('--report-directory'));await mkdir(reportDir,{recursive:false,mode:0o700});
  const lockPath=join(dirname(databasePath),'.work-link-resolver.lock'),token=randomUUID();let acquired=false,db;
  const control=new AbortController();process.once('SIGINT',()=>control.abort());process.once('SIGTERM',()=>control.abort());
  const result={version:1,startedAt:new Date().toISOString(),mode:execute?'execute':'preview',runtimeAI:false,
    sourceVersionId:versionId,planned:0,processed:0,resolved:0,failures:0,status:'planning',counts:{}};
  const save=()=>writeFile(join(reportDir,'result.json'),JSON.stringify({...result,updatedAt:new Date().toISOString()},null,2)+'\n',{mode:0o600});
  try{
    // A separate resolver invocation cannot race this batch. Never remove an existing owner's lock.
    if(execute){const lock=await open(lockPath,'wx',0o600);acquired=true;await lock.writeFile(JSON.stringify({pid:process.pid,token}));await lock.close();}
    db=new DatabaseSync(databasePath,{readOnly:true});const planned=pendingWorkSourceLinks(db,{versionId,limit});db.close();db=null;
    result.planned=planned.length;await writeFile(join(reportDir,'plan.json'),JSON.stringify(planned,null,2),{flag:'wx',mode:0o600});
    if(!execute){result.status='preview';await save();return;}
    if(!flags.has('--backup-path'))throw Error('work-link-backup-required');
    const backup=await realpath(flags.get('--backup-path'));
    if(backup===databasePath)throw Error('work-link-backup-is-live-database');
    const yieldBackup=()=>waitForWorkSourceBackup({backupDirectory:dirname(backup),signal:control.signal,
      onWaiting:async()=>{result.phase='waiting-backup';await save();}});
    await yieldBackup();
    const verified=await new SQLiteBackupManager({databasePath,backupDir:dirname(backup)}).verifySnapshot(backup);
    if(await realpath(verified.manifest.source)!==databasePath||!Number.isFinite(Date.parse(verified.manifest.createdAt))
      ||Date.now()-Date.parse(verified.manifest.createdAt)>6*3600000
      ||Date.parse(verified.manifest.createdAt)>Date.now())throw Error('work-link-backup-source-or-age-invalid');
    await writeFile(join(reportDir,'backup-validation.json'),JSON.stringify(verified,null,2),{flag:'wx',mode:0o600});
    db=new DatabaseSync(databasePath);db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');
    result.status='running';await save();let empty=0;
    for(const item of planned){
      if(control.signal.aborted){result.status='cancelled';break;}
      await yieldBackup();result.phase='resolving';
      const receipt=await resolveWorkSourceLink({...item,signal:control.signal});
      const saved=commitWorkLinkReceipt(db,receipt,{backupValidated:true});
      result.processed++;result.counts[receipt.status]=(result.counts[receipt.status]||0)+1;
      if(receipt.status==='resolved'){result.resolved++;empty=0;}else{result.failures++;empty++;}
      await writeFile(join(reportDir,saved.sha256+'.json'),JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
      if(['http_401','http_403','http_429','network_error','timeout'].includes(receipt.status)||empty>=5){
        result.status='stopped-upstream';await save();break;
      }
      await save();if(result.processed<planned.length)await delay(delayMs,undefined,{signal:control.signal});
    }
    if(result.status==='running')result.status='completed';result.finishedAt=new Date().toISOString();await save();
    if(result.status!=='completed')process.exitCode=2;
    console.log(JSON.stringify(result));
  }catch(error){
    result.status=control.signal.aborted?'cancelled':'failed';result.code=/^[a-z][a-z0-9-]{1,100}$/.test(error.message)?error.message:'work-link-job-failed';
    result.finishedAt=new Date().toISOString();await save();process.exitCode=1;console.error(JSON.stringify(result));
  }finally{
    db?.close();if(acquired){try{const owner=JSON.parse(await readFile(lockPath,'utf8'));if(owner.token===token)await unlink(lockPath);}catch{}}
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{
  console.error('work-link-job-not-started');process.exitCode=1;
});
