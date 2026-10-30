/** Existing daily source worker adapter, with one lazy backup check per pass. */
import { join, resolve } from 'node:path';
import { realpath,mkdir } from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import { inspectLatestBackup } from './backup-audit.mjs';
import { SQLiteBackupManager } from './backup-manager.mjs';
import { syncWorkSourceWorkbook } from './work-source-sync.mjs';
import {runWorkSourceLinkBatch} from './work-source-link-batch.mjs';

export function createWorkSourcePollReader({ dataDirectory, now=Date.now, sync=syncWorkSourceWorkbook,
  verifyBackup,resolveLinks=runWorkSourceLinkBatch,signal }={}) {
  const databasePath=resolve(dataDirectory,'douyin-monitor.sqlite');
  let backupPromise;
  const beforeCommit=()=>backupPromise ??= (async()=>{
    if(verifyBackup)return verifyBackup();
    const backupDir=join(dataDirectory,'backups','automatic');
    const recent=inspectLatestBackup(backupDir);
    if(recent.status!=='ok' || !Number.isFinite(Date.parse(recent.createdAt))
      || Date.parse(recent.createdAt)>now() || now()-Date.parse(recent.createdAt)>6*60*60_000)
      throw new Error('work-source-recent-backup-required');
    const manager=new SQLiteBackupManager({databasePath,backupDir});
    const {manifest}=await manager.verifySnapshot(join(backupDir,recent.fileName));
    if(await realpath(manifest.source)!==await realpath(databasePath))throw new Error('work-source-backup-source-mismatch');
    return {validated:true,sha256:manifest.sha256,createdAt:manifest.createdAt};
  })().catch(()=>{throw new Error('work-source-backup-validation-failed');});
  return async source=>{
    if(source.sourceType!=='lark-work-source' || source.readPolicy!=='authorized-work-facts'
      || source.monitorOnly===true || source.kind!=='work-statistics')throw new Error('work-source-read-policy-invalid');
    // Most workbooks stay within 8 MB. A reviewed screenshot-bearing source
    // may opt in to a larger export without removing the size bound globally.
    const maxFileBytes=source.maxExportBytes===undefined ? 8_000_000 : source.maxExportBytes;
    if(!Number.isSafeInteger(maxFileBytes) || maxFileBytes<1 || maxFileBytes>32_000_000)
      throw new Error('work-source-export-limit-invalid');
    if(source.resolveWorkLinks!==undefined&&typeof source.resolveWorkLinks!=='boolean')throw Error('work-source-link-policy-invalid');
    const linkLimit=source.workLinkBatchLimit??50,linkDelay=source.workLinkDelayMs??700;
    if(source.resolveWorkLinks===true&&(!Number.isSafeInteger(linkLimit)||linkLimit<1||linkLimit>100
      ||!Number.isSafeInteger(linkDelay)||linkDelay<500||linkDelay>10000))throw Error('work-source-link-batch-policy-invalid');
    const result=await sync({sourceUrl:source.sourceUrl,databasePath,mode:'commit',beforeCommit,now,maxFileBytes});
    if(!['imported','unchanged'].includes(result.status) || result.contentImported!==true
      || !Number.isSafeInteger(result.versionId) || result.versionId<1
      || !Number.isSafeInteger(result.sourceRevision) || result.sourceRevision<0
      || !Number.isSafeInteger(result.factCount) || result.factCount<0
      || !/^[a-f0-9]{64}$/.test(result.sourceSha256 || ''))throw new Error('work-source-import-receipt-invalid');
    if(source.resolveWorkLinks!==true)return result;
    const home=join(dataDirectory,'source-poll','work-links');await mkdir(home,{recursive:true,mode:0o700});
    const batch=await resolveLinks({databasePath,versionId:result.versionId,reportDirectory:join(home,randomUUID()),
      execute:true,limit:linkLimit,delayMs:linkDelay,beforeCommit,signal,now});
    const states=new Set(['completed','deferred','cancelled','failed','stopped-upstream']);
    if(!states.has(batch?.status)||['planned','processed','resolved','failures','remaining','unresolved','coolingDown'].some(key=>
      !Number.isSafeInteger(batch[key])||batch[key]<0)||batch.processed>batch.planned
      ||batch.planned>linkLimit||batch.coolingDown>batch.unresolved||batch.remaining>batch.unresolved
      ||batch.resolved+batch.failures!==batch.processed)throw Error('work-source-link-receipt-invalid');
    if(['deferred','failed','cancelled'].includes(batch.status))throw Error('work-source-link-job-'+batch.status);
    if(batch.retryAt!==null&&(!Number.isFinite(Date.parse(batch.retryAt))||Date.parse(batch.retryAt)<=now()))
      throw Error('work-source-link-retry-clock-invalid');
    return {...result,workLinkResolution:{version:1,status:batch.status,checkedAt:new Date(now()).toISOString(),
      planned:batch.planned,processed:batch.processed,resolved:batch.resolved,failures:batch.failures,batchLimit:linkLimit,
      remaining:batch.remaining,unresolved:batch.unresolved,coolingDown:batch.coolingDown,retryAt:batch.retryAt,
      code:/^[a-z][a-z0-9-]{1,100}$/.test(batch.code||'')?batch.code:null,runtimeAI:false}};
  };
}
