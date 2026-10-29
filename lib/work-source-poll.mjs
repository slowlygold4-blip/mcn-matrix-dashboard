/** Existing daily source worker adapter, with one lazy backup check per pass. */
import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { inspectLatestBackup } from './backup-audit.mjs';
import { SQLiteBackupManager } from './backup-manager.mjs';
import { syncWorkSourceWorkbook } from './work-source-sync.mjs';

export function createWorkSourcePollReader({ dataDirectory, now=Date.now, sync=syncWorkSourceWorkbook,
  verifyBackup }={}) {
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
    const result=await sync({sourceUrl:source.sourceUrl,databasePath,mode:'commit',beforeCommit,now});
    if(!['imported','unchanged'].includes(result.status) || result.contentImported!==true
      || !Number.isSafeInteger(result.versionId) || result.versionId<1
      || !Number.isSafeInteger(result.sourceRevision) || result.sourceRevision<0
      || !Number.isSafeInteger(result.factCount) || result.factCount<0
      || !/^[a-f0-9]{64}$/.test(result.sourceSha256 || ''))throw new Error('work-source-import-receipt-invalid');
    return result;
  };
}
