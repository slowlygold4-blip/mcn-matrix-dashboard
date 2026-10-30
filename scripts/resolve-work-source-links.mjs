/** Explicit one-off entry point; the same data job is used by the daily source worker. */
import {realpath} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SQLiteBackupManager} from '../lib/backup-manager.mjs';
import {runWorkSourceLinkBatch} from '../lib/work-source-link-batch.mjs';
export {pendingWorkSourceLinks,waitForWorkSourceBackup} from '../lib/work-source-link-batch.mjs';

async function main(){
  const flags=new Map(),args=process.argv.slice(2);let execute=false;
  const allowed=new Set(['--database','--version-id','--report-directory','--backup-path','--limit','--delay-ms']);
  for(let i=0;i<args.length;i++){
    if(args[i]==='--execute'&&!execute){execute=true;continue;}
    if(!allowed.has(args[i])||!args[i+1]||args[i+1].startsWith('--')||flags.has(args[i]))throw Error('invalid-work-link-arguments');
    flags.set(args[i],args[++i]);
  }
  if(!flags.has('--database')||!flags.has('--version-id')||!flags.has('--report-directory'))throw Error('work-link-arguments-required');
  if(execute&&!flags.has('--backup-path'))throw Error('work-link-backup-required');
  const databasePath=await realpath(flags.get('--database')),control=new AbortController();
  process.once('SIGINT',()=>control.abort());process.once('SIGTERM',()=>control.abort());
  const beforeCommit=async()=>{
    const backup=await realpath(flags.get('--backup-path'));
    if(backup===databasePath)throw Error('work-link-backup-is-live-database');
    const verified=await new SQLiteBackupManager({databasePath,backupDir:dirname(backup)}).verifySnapshot(backup);
    if(await realpath(verified.manifest.source)!==databasePath||!Number.isFinite(Date.parse(verified.manifest.createdAt))
      ||Date.now()-Date.parse(verified.manifest.createdAt)>6*3600000||Date.parse(verified.manifest.createdAt)>Date.now())
      throw Error('work-link-backup-source-or-age-invalid');
    return {validated:true,...verified};
  };
  const result=await runWorkSourceLinkBatch({databasePath,versionId:Number(flags.get('--version-id')),
    reportDirectory:flags.get('--report-directory'),execute,limit:Number(flags.get('--limit')||500),
    delayMs:Number(flags.get('--delay-ms')||700),beforeCommit,signal:control.signal});
  console.log(JSON.stringify(result));if(!['preview','completed'].includes(result.status))process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{
  console.error('work-link-job-not-started');process.exitCode=1;
});
