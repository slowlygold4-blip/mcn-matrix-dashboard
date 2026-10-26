// One-shot local verification/release. No platform requests, timers or daemons.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, copyFile, constants, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteBackupManager, validateSQLiteSnapshot, validationCountsMatch } from '../lib/backup-manager.mjs';
import { recordImportAuthorisedAttempt, readImportAuthorisedAttempts } from '../lib/import-authorised-attempts.mjs';
import { inspectAttempt } from './audit-authorised-import-20261009.mjs';
import { validateImportMonitoring } from '../public/import-monitoring.js';

const root=fileURLToPath(new URL('../',import.meta.url)), out=join(root,'data/maintenance-journal/20261009-remaining-onboarding');
const mode=process.argv[2], origin='http://127.0.0.1:4188', jobId='c9895a58-14ef-4f1f-8c88-428fb3ce8d6f';
assert.ok(['test','backup','backup-final','attempts','load','readback'].includes(mode));
await mkdir(out,{recursive:true,mode:0o700});
const save=(name,value)=>writeFile(join(out,name+'.json'),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const sha=value=>createHash('sha256').update(value).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const dbPath=join(root,'data/douyin-monitor.sqlite');
const jobFrom=row=>({id:row.id,status:row.status,fileName:row.file_name,sheetName:row.sheet_name,
  createdAt:row.created_at,finishedAt:row.finished_at,request:JSON.parse(row.request_json),result:JSON.parse(row.result_json)});
async function session(){const r=await fetch(origin+'/api/auth/session',{signal:AbortSignal.timeout(3000)});assert.equal(r.status,200);
  const auth=await r.json();assert.equal(auth.user.role,'admin');return{Cookie:(r.headers.get('set-cookie')||'').split(';')[0]};}
if(mode==='test'){
  const prior=await json(join(root,'data/maintenance-journal/20261009-author-detail-investigation/final2/tests.json'));
  const extra=['import-monitoring-status-20261009','import-monitoring-ui-20261009','import-authorised-attempts',
    'authorised-queue-cycle','authorised-import-queue','authorised-import-queue-async-peer','authorised-import-queue-supplement-peer',
    'import-monitoring-supplement-bridge-20261009','import-monitoring-shell-capability-peer-20261009',
    'import-authorised-queue-http-20261009', ...process.argv.slice(3)];
  assert.ok(extra.every(x=>/^[a-z0-9-]+$/.test(x)));
  const files=[...new Set([...prior.files,...extra])];
  for(const file of files)await lstat(join(root,'test',file+'.test.mjs'));
  const startedAt=new Date().toISOString();
  const child=spawn(process.execPath,['--test','--test-concurrency=1',...files.map(f=>'test/'+f+'.test.mjs')],{cwd:root,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);
  const exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)});
  const stamp=Date.now(),report={startedAt,finishedAt:new Date().toISOString(),files,exitCode,
    summary:output.split('\n').filter(l=>/^ℹ /.test(l)),productionCollection:false};
  await writeFile(join(out,'tests-'+stamp+'.txt'),output,{flag:'wx',mode:0o600});
  await save('tests-'+stamp,report);console.log(JSON.stringify({stamp,...report}));assert.equal(exitCode,0);
}else if(mode==='backup'||mode==='backup-final'){
  const stamp=process.argv[3];assert.match(stamp||'',/^\d+$/);assert.equal((await json(join(out,'tests-'+stamp+'.json'))).exitCode,0);
  const manager=new SQLiteBackupManager({databasePath:dbPath,backupDir:join(root,'data/backups/20261009-remaining-onboarding'),retention:60});
  const backup=await manager.createBackup(mode==='backup'?'before-automatic-onboarding':'after-automatic-onboarding');assert.equal(backup.status,'created');
  const temp=await mkdtemp(join(tmpdir(),'mcn-auto-onboarding-')),clone=join(temp,'readback.sqlite');
  await copyFile(backup.path,clone,constants.COPYFILE_FICLONE);
  const validation=validateSQLiteSnapshot(clone);assert.ok(validationCountsMatch(backup.manifest.validation.counts,validation.counts));
  const report={at:new Date().toISOString(),tests:'tests-'+stamp+'.json',backup,clone,validation,readableCloneVerified:true};
  await save(mode,report);console.log(JSON.stringify({path:backup.path,clone,sha256:backup.manifest.sha256,validation}));
}else if(mode==='attempts'){
  const backup=await json(join(out,'backup.json'));assert.equal(backup.readableCloneVerified,true);
  const report=await json(join(root,'data/maintenance-journal/20261009-author-detail-investigation/closeout-2026-10-09T17-49-36-570Z-e7c2472e/audit.json'));
  const auditText=await readFile(join(root,'data/maintenance-journal/20261009-author-detail-investigation/closeout-2026-10-09T17-49-36-570Z-e7c2472e/audit.json'));
  assert.equal(sha(auditText),'21b788669db355f51773c9b4f77b972d74f4bbe00bc669787494d44068bfe7a1');
  const fixture=new DatabaseSync(backup.clone);let job,attempts=[];
  try{
    const row=fixture.prepare('SELECT * FROM author_resolution_jobs WHERE id=?').get(jobId);job=jobFrom(row);
    assert.equal(sha(row.request_json),'17732e521fba518599b2d4f85046ff045b5d4846e8bc8c5553e9f14b102e8fa2');
    for(const item of report.notEnabled){
      const attempt=item.latestAttempt;if(!attempt||!['invalid_evidence','identity_mismatch','navigation_error'].includes(attempt.code))continue;
      const path=resolve(root,attempt.file);assert.ok(path.startsWith(join(root,'data/maintenance-journal/20261009-author-detail-investigation')+'/'));
      const stat=await lstat(path);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<2*1024*1024);
      const bytes=await readFile(path);assert.equal(sha(bytes),attempt.fileSha256);const saved=JSON.parse(bytes);
      const checked=inspectAttempt(saved,job,{file:attempt.file,fileSha256:attempt.fileSha256,fileSourceRow:attempt.sourceRow});
      assert.equal(checked?.code,attempt.code);assert.equal(checked.submittedId,attempt.submittedId);
      const input={sourceRow:attempt.sourceRow,result:saved.data.result,startedAt:saved.at??saved.startedAt,
        finishedAt:saved.finishedAt,recordingMode:'retained-local-response'};
      recordImportAuthorisedAttempt(fixture,job,input);attempts.push(input);
    }
    assert.equal(attempts.length,29);assert.equal(readImportAuthorisedAttempts(fixture,job).size,29);
  }finally{fixture.close();}
  // Production append is atomic and only affects the dedicated activity action.
  const db=new DatabaseSync(dbPath);db.exec('PRAGMA busy_timeout=3000; BEGIN IMMEDIATE');
  let inserted=0;
  try{const start=db.prepare('SELECT total_changes() n').get().n;
    for(const input of attempts)if(recordImportAuthorisedAttempt(db,job,input))inserted++;
    assert.equal(db.prepare('SELECT total_changes() n').get().n-start,inserted);
    assert.equal(readImportAuthorisedAttempts(db,job).size,29);db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}finally{db.close();}
  const result={at:new Date().toISOString(),retainedAttempts:attempts.length,inserted,
    originalTimesPreserved:true,sourceJobsUnchanged:true,identityAdmissions:0,platformRequests:0,changesOnly:'activity_log'};
  await save('retained-attempts',result);console.log(JSON.stringify(result));
}else if(mode==='load'){
  assert.equal((await json(join(out,'backup.json'))).readableCloneVerified,true);
  const testStamp=process.argv[3];assert.match(testStamp||'',/^\d+$/);
  const releaseTests=await json(join(out,'tests-'+testStamp+'.json'));assert.equal(releaseTests.exitCode,0);
  assert.ok(releaseTests.files.includes('roster-alias-running-20261009'));
  const oldPid=96553,expected=process.execPath+' '+root+'server.mjs';
  const idle=()=>{assert.equal(execFileSync('/bin/ps',['-p',String(oldPid),'-o','command='],{encoding:'utf8'}).trim(),expected);
    assert.equal(execFileSync('/bin/ps',['-p',String(oldPid),'-o','ppid='],{encoding:'utf8'}).trim(),'1');
    const db=new DatabaseSync(dbPath,{readOnly:true});try{return{
      runs:db.prepare("SELECT count(*) n FROM runs WHERE status IN ('running','queued')").get().n,
      jobs:db.prepare("SELECT count(*) n FROM author_resolution_jobs WHERE status IN ('queued','running')").get().n,
      leases:db.prepare('SELECT count(*) n FROM author_resolution_queue WHERE lease_owner IS NOT NULL').get().n,
    };}finally{db.close();}};
  let found=false;for(let i=0;i<12;i++){if(!Object.values(idle()).some(Boolean)){await pause(500);if(!Object.values(idle()).some(Boolean)){found=true;break;}}await pause(2000);}
  assert.ok(found,'Active collection: no service signal sent');
  process.kill(oldPid,'SIGTERM');await save('runtime-signal',{at:new Date().toISOString(),oldPid,idleVerified:true,forcedExit:false,otherServicesUntouched:true});
  let loaded;
  for(let i=0;i<110;i++){try{const r=await fetch(origin+'/healthz',{signal:AbortSignal.timeout(1500)});if(r.ok){const pid=Number(execFileSync('/usr/sbin/lsof',['-t','-iTCP:4188','-sTCP:LISTEN'],{encoding:'utf8'}).trim());
      if(pid!==oldPid){loaded={at:new Date().toISOString(),oldPid,newPid:pid,health:await r.json()};break;}}}catch{}await pause(500);}
  assert.ok(loaded);loaded.tests='tests-'+testStamp+'.json';await save('runtime-load',loaded);console.log(JSON.stringify(loaded));
}else{
  // Explicit post-batch expectations come from the independent read-only audit,
  // not from this endpoint's own returned counts.
  const expectedEnabled=Number(process.argv[3]??357),expectedAttempts=Number(process.argv[4]??29);
  assert.ok(Number.isSafeInteger(expectedEnabled)&&expectedEnabled>=357&&expectedEnabled<=394);
  assert.ok(Number.isSafeInteger(expectedAttempts)&&expectedAttempts>=0&&expectedAttempts<=394-expectedEnabled);
  const headers=await session(),pages=[],items=[];
  for(let offset=0;offset<100;offset+=20){
    const response=await fetch(origin+`/api/author-spreadsheet/jobs/${jobId}/monitoring?status=pending&limit=20&offset=${offset}`,{headers,signal:AbortSignal.timeout(20000)});
    assert.equal(response.status,200);const page=await response.json();validateImportMonitoring(page,jobId,'pending');
    if(pages.length)assert.deepEqual(page.counts,pages[0].counts);pages.push(page);items.push(...page.items);
    if(!page.pagination.hasMore)break;
  }
  const monitoring=pages[0];assert.equal(items.length,monitoring.pagination.total);assert.equal(new Set(items.map(x=>x.key)).size,items.length);
  assert.equal(monitoring.counts.submittedIdentities,394);assert.equal(monitoring.counts.enabled,expectedEnabled);assert.equal(monitoring.counts.pending,394-expectedEnabled);
  assert.equal(monitoring.counts.paused,0);assert.equal(monitoring.counts.conflict,0);assert.equal(monitoring.counts.unknown,0);
  assert.equal(items.filter(x=>x.resolutionAttempt).length,expectedAttempts);
  const statusResponse=await fetch(origin+'/api/monitoring-status',{headers,signal:AbortSignal.timeout(20000)});assert.equal(statusResponse.status,200);
  const status=await statusResponse.json();
  const result={at:new Date().toISOString(),health:(await fetch(origin+'/healthz')).status,monitoringPages:pages,status,
    authorisedAttemptsShown:expectedAttempts,supplementLinks:items.filter(x=>x.rosterEntryKey).length,
    allAuthorsConnected:false,allWorksComplete:false};
  await save('runtime-readback-'+Date.now(),result);console.log(JSON.stringify({at:result.at,health:result.health,counts:monitoring.counts,
    authorisedAttemptsShown:expectedAttempts,supplementLinks:result.supplementLinks}));
}
