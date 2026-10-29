/** Authorized Feishu whole-workbook sync. Called by an existing scheduler. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { normalizeLarkSheetUrl, resolveLarkCliCommand, larkWorkbookInfoArguments,
  larkExportArguments, larkSheetRowsArguments } from './lark-sheet-source.mjs';
import { commitWorkSourceEdition, readWorkSourceEditions, verifyWorkSourceEdition } from './work-source-store.mjs';

const exec = promisify(execFile);
const isoNow = now => new Date(now()).toISOString();
const checkedRevision = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('work-source-invalid-revision');
  return value;
};

function workbookInfo(data, url) {
  if (!Array.isArray(data?.sheets) || !data.sheets.length || !data.modified_time) throw new Error('work-source-incomplete-metadata');
  if(data.token!==new URL(url).pathname.split('/').at(-1))throw new Error('work-source-object-identity-mismatch');
  return { url,revision:checkedRevision(data.revision),modifiedAt:data.modified_time,title:data.title || '',
    sheets:data.sheets.map(sheet=>({id:sheet.sheet_id,name:sheet.sheet_name})) };
}

export async function syncWorkSourceWorkbook({ sourceUrl,databasePath,mode='preview',beforeCommit,
  command=null,commandRunner=exec,now=Date.now,maxFileBytes=8_000_000 }={}) {
  if (!['check','preview','commit'].includes(mode)) throw new Error('invalid-work-source-sync-mode');
  if (mode==='commit' && typeof beforeCommit!=='function') throw new Error('work-source-verified-backup-required');
  const canonical=new URL(normalizeLarkSheetUrl(sourceUrl));canonical.search='';
  const url=canonical.toString();
  const cli=command || await resolveLarkCliCommand();
  async function call(args,options={}) {
    let output;
    try{output=await commandRunner(cli,args,{timeout:90_000,maxBuffer:2*1024*1024,
      env:{...process.env,LARK_CLI_NO_PROXY:'1'},...options});}
    catch(error){throw new Error(error?.code==='ETIMEDOUT' || error?.killed ? 'work-source-cli-timeout' : 'work-source-authorized-read-failed');}
    let result;try{result=JSON.parse(output.stdout);}catch{throw new Error('work-source-cli-invalid-json');}
    if(result?.ok!==true)throw new Error('work-source-authorized-read-failed');
    return result.data;
  }
  const before=workbookInfo(await call(larkWorkbookInfoArguments(url)),url);
  let db=new DatabaseSync(databasePath,{readOnly:true});
  let previous;
  try{
    db.exec('PRAGMA query_only=ON; BEGIN');
    previous=readWorkSourceEditions(db,{asOf:isoNow(now)}).find(row=>row.sourceUrl===url);
    if(previous)verifyWorkSourceEdition(db,previous.id);
    db.exec('COMMIT');
  }finally{db.close();}
  if(previous && (before.revision<previous.revision || Date.parse(before.modifiedAt)<Date.parse(previous.sourceModifiedAt)))
    throw new Error('work-source-version-regression');
  if(previous?.revision===before.revision && previous.sourceModifiedAt===before.modifiedAt){
    const saved=previous.report.source;
    if(saved.title!==before.title || JSON.stringify(saved.sheets.map(({id,name})=>({id,name})))!==JSON.stringify(before.sheets))
      throw new Error('work-source-same-revision-metadata-drift');
    return {status:'unchanged',sourceUrl:url,sourceRevision:before.revision,versionId:previous.id,
      factCount:previous.factCount,sourceReadAt:previous.readAt,checkedAt:isoNow(now),sourceSha256:previous.sourceSha256,
      contentImported:true,metadataOnlyCheck:true,runtimeAI:false};
  }
  if(mode==='check')return {status:'would-read',sourceUrl:url,sourceRevision:before.revision,checkedAt:isoNow(now),contentImported:false,runtimeAI:false};
  const directory=await mkdtemp(join(tmpdir(),'mcn-work-source-'));
  try{
    const sheets=[];
    for(const sheet of before.sheets){
      if(!sheet.id || !sheet.name)throw new Error('work-source-invalid-sheet');
      // Read one cell solely for the server's full used-region descriptor.
      // This is never treated as a full data read; the export follows below.
      const region=await call(larkSheetRowsArguments(url,sheet.id,'A1:A1'));
      if(checkedRevision(region.revision)!==before.revision || !Object.hasOwn(region,'current_region'))
        throw new Error('work-source-changed-during-region-read');
      sheets.push({...sheet,region:region.current_region});
    }
    await call(larkExportArguments(url,'source.xlsx'),{cwd:directory,timeout:180_000});
    const file=join(directory,'source.xlsx'),info=await stat(file);
    if(!info.isFile() || info.size<=0 || info.size>maxFileBytes)throw new Error('work-source-export-size-invalid');
    const after=workbookInfo(await call(larkWorkbookInfoArguments(url)),url);
    // The region probes belonged to before.revision. Any later object/edition
    // drift invalidates the whole export, not just the changed worksheet.
    if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('work-source-changed-during-export');
    const input={buffer:await readFile(file),before:{...before,sheets},after:{...after,sheets},readAt:isoNow(now)};
    db=new DatabaseSync(databasePath,{readOnly:true});
    let preflight;
    try{preflight=commitWorkSourceEdition(db,input,{now,dryRun:true});}finally{db.close();}
    if(mode!=='commit' || preflight.status==='unchanged')return {...preflight,contentImported:preflight.status==='unchanged',runtimeAI:false};
    const backup=await beforeCommit({sourceUrl:url,sourceRevision:before.revision,factCount:preflight.factCount});
    if(backup?.validated!==true)throw new Error('work-source-verified-backup-required');
    db=new DatabaseSync(databasePath);
    try{
      db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000');
      const saved=commitWorkSourceEdition(db,input,{now});
      return {...saved,sourceReadAt:input.readAt,sourceSha256:createHash('sha256').update(input.buffer).digest('hex'),
        checkedAt:isoNow(now),contentImported:true,backupValidated:true,runtimeAI:false};
    }finally{db.close();}
  }finally{
    // Only this invocation's temporary export is removed. Successful commits
    // retain its exact original bytes inside work_source_artifacts atomically.
    await rm(directory,{recursive:true,force:true});
  }
}
