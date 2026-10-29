/** Batch existing source editions; no timer, Douyin browser, or model calls. */
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { resolve,dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQLiteBackupManager } from '../lib/backup-manager.mjs';
import { syncWorkSourceWorkbook } from '../lib/work-source-sync.mjs';

export async function syncWorkSourceBatch({sources,databasePath,mode='preview',beforeCommit,sync=syncWorkSourceWorkbook}={}){
  if(!Array.isArray(sources) || !sources.length || sources.length>30)throw new Error('invalid-work-source-catalog');
  if(new Set(sources.map(row=>row.url)).size!==sources.length)throw new Error('duplicate-work-source-catalog-url');
  const results=[];let backupBlocked=false;
  for(const source of sources){
    if(backupBlocked){results.push({title:source.title || '',status:'deferred',errorCode:'work-source-backup-validation-failed'});continue;}
    try{results.push({title:source.title || '',...await sync({sourceUrl:source.url,databasePath,mode,beforeCommit})});}
    catch(error){
      if(mode==='commit' && ['work-source-backup-validation-failed','work-source-verified-backup-required'].includes(error.message))backupBlocked=true;
      results.push({title:source.title || '',status:'failed',errorCode:/^[a-z][a-z0-9-]{1,120}$/.test(error.message)
        ? error.message : 'work-source-sync-failed'});
    }
  }
  return {mode,checkedAt:new Date().toISOString(),runtimeAI:false,results,
    imported:results.filter(row=>row.status==='imported').length,
    unchanged:results.filter(row=>row.status==='unchanged').length,
    failed:results.filter(row=>row.status==='failed').length,deferred:results.filter(row=>row.status==='deferred').length};
}

async function main(){
  const args=process.argv.slice(2),flags=new Map();
  const allowed=new Set(['--config','--database','--mode','--backup-path','--report-directory']);
  for(let i=0;i<args.length;i+=2){
    if(!allowed.has(args[i]) || !args[i+1] || args[i+1].startsWith('--') || flags.has(args[i]))throw new Error('invalid-work-source-sync-arguments');
    flags.set(args[i],args[i+1]);
  }
  if(!flags.has('--config') || !flags.has('--database') || !flags.has('--report-directory'))throw new Error('work-source-config-database-report-required');
  const mode=flags.get('--mode') || 'preview';
  if(!['check','preview','commit'].includes(mode))throw new Error('invalid-work-source-sync-mode');
  if(mode==='commit' && !flags.has('--backup-path'))throw new Error('work-source-verified-backup-path-required');
  const databasePath=await realpath(flags.get('--database'));
  const directory=resolve(flags.get('--report-directory'));await mkdir(directory,{recursive:false,mode:0o700});
  const config=JSON.parse(await readFile(flags.get('--config'),'utf8'));
  let verifiedBackupPromise;
  const beforeCommit=()=>verifiedBackupPromise ??= (async()=>{
    const path=await realpath(flags.get('--backup-path'));
    if(path===databasePath)throw new Error('work-source-backup-is-production-database');
    const manager=new SQLiteBackupManager({databasePath,backupDir:dirname(path)});
    const verified=await manager.verifySnapshot(path);
    const manifest=verified.manifest;
    if(await realpath(manifest.source)!==databasePath || !Number.isFinite(Date.parse(manifest.createdAt))
      || Date.parse(manifest.createdAt)>Date.now() || Date.now()-Date.parse(manifest.createdAt)>6*60*60_000)
      throw new Error('work-source-backup-source-or-age-invalid');
    const receipt={validated:true,path,createdAt:manifest.createdAt,sha256:manifest.sha256,validation:verified.validation};
    await writeFile(join(directory,'backup-validation.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});
    return receipt;
  })().catch(()=>{throw new Error('work-source-backup-validation-failed');});
  const result=await syncWorkSourceBatch({sources:config.sources,databasePath,mode,beforeCommit});
  await writeFile(join(directory,'result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({...result,results:result.results.map(({title,status,versionId,sourceRevision,factCount,errorCode})=>
    ({title,status,versionId,sourceRevision,factCount,errorCode}))}));
  if(result.failed || result.deferred)process.exitCode=1;
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{
  console.error('work-source-batch-not-completed');process.exitCode=1;
});
