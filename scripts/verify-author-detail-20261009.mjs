import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, mkdtemp, copyFile, constants } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteBackupManager, validateSQLiteSnapshot, validationCountsMatch } from '../lib/backup-manager.mjs';

const root = new URL('../', import.meta.url).pathname;
const phase=process.env.MCN_AUTHOR_DETAIL_STAGE || 'initial';
assert.ok(['initial','onboarding','atomic','repair','final','final2'].includes(phase));
const out = root + 'data/maintenance-journal/20261009-author-detail-investigation/' + (phase==='initial'?'':phase+'/');
const mode = process.argv[2];
assert.ok(['test', 'backup', 'load', 'probe','monitor'].includes(mode));
const save = async (name, value) => writeFile(out + name + '.json', JSON.stringify(value, null, 2) + '\n', {flag:'wx', mode:0o600});
const pause = ms => new Promise(r => setTimeout(r, ms));
await mkdir(out, { recursive:true, mode:0o700 });
const origin = 'http://127.0.0.1:4188', jobId = 'c9895a58-14ef-4f1f-8c88-428fb3ce8d6f';
async function session() {
  const response = await fetch(origin + '/api/auth/session', {signal:AbortSignal.timeout(3000)});
  assert.equal(response.status,200);
  const auth = await response.json();
  assert.equal(auth.user.role,'admin');
  return {Cookie:(response.headers.get('set-cookie') || '').split(';')[0], 'X-CSRF-Token':auth.csrfToken, Origin:origin};
}
if (mode === 'test') {
  const files = ['douyin-authorised-detail','douyin-authorised-detail-peer-20261009','public-web-authorised-detail',
    'import-authorised-detail','import-authorised-detail-http-peer-20261009','board-ingestion-http',
    'author-spreadsheet','author-spreadsheet-official-video-20261009','author-resolution','author-evidence-reuse',
    'public-web-works-only','public-web-cancellation','public-web-works-only-diagnostics','graceful-shutdown-drain',
    'collection-shutdown-admission','scheduler-shutdown-admission','collector-process-ownership',
    'post-ingestion-shutdown-20261005','server-collection-shutdown','author-board-import'];
  if(phase!=='initial') files.push('authorised-detail-admission','authorised-import-service-peer','import-authorised-detail-share','database','author-queue-leased-board-update-20261009','import-review-current-20261009');
  if(['atomic','repair','final','final2'].includes(phase)) files.push('authorised-retry-eligibility','author-resolution-nested-commit','master-roster-existing-authorised-binding','master-roster-live-sources-20261009','master-roster-strong-identity-name-20261009','master-roster-supplement-20261009');
  if(['repair','final','final2'].includes(phase)) files.push('import-authorised-detail-source-compat','douyin-authorised-detail-ownership-regression','scheduled-backup-throttle','backup-manager');
  if(['final','final2'].includes(phase)) {
    const extra=process.argv.slice(3);
    assert.ok(extra.length<=8 && extra.every(name=>/^[a-z0-9-]+$/.test(name)));
    files.push(...extra.filter(name=>!files.includes(name)));
  }
  const start = new Date().toISOString();
  const child = spawn(process.execPath,['--test','--test-concurrency=1',...files.map(f=>'test/'+f+'.test.mjs')],{cwd:root,stdio:['ignore','pipe','pipe']});
  let output=''; child.stdout.on('data',c=>output+=c); child.stderr.on('data',c=>output+=c);
  const exitCode = await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)});
  await writeFile(out+'tests.txt',output,{flag:'wx',mode:0o600});
  const result={startedAt:start,finishedAt:new Date().toISOString(),files,exitCode,summary:output.split('\n').filter(l=>/^ℹ /.test(l))};
  await save('tests',result); console.log(JSON.stringify(result)); assert.equal(exitCode,0);
} else if (mode === 'backup') {
  const tests=JSON.parse(await readFile(out+'tests.json','utf8')); assert.equal(tests.exitCode,0);
  const backupDir=root+'data/backups/20261009-author-detail/';
  const manager=new SQLiteBackupManager({databasePath:root+'data/douyin-monitor.sqlite',backupDir,retention:60});
  const backup=await manager.createBackup('before-author-detail'); assert.equal(backup.status,'created');
  const temp=await mkdtemp(join(tmpdir(),'mcn-author-detail-backup-')), clone=join(temp,'readback.sqlite');
  await copyFile(backup.path,clone,constants.COPYFILE_FICLONE);
  const validation=validateSQLiteSnapshot(clone);
  assert.ok(validationCountsMatch(backup.manifest.validation.counts,validation.counts));
  await save('backup',{checkedAt:new Date().toISOString(),backup,clone,validation,readableCloneVerified:true,existingBackupsDeleted:false});
  console.log(JSON.stringify({path:backup.path,sha256:backup.manifest.sha256,validation}));
} else if (mode === 'load') {
  assert.equal(JSON.parse(await readFile(out+'backup.json','utf8')).readableCloneVerified,true);
  const oldPid=Number(process.argv[3]); assert.equal(oldPid,phase==='initial'?75200:phase==='onboarding'?79166:phase==='atomic'?80788:phase==='repair'?83413:85844);
  if(['repair','final','final2'].includes(phase)) {
    const rows=execFileSync('/bin/ps',['-ax','-o','pid=,ppid=,pgid=,lstart=,command='],{encoding:'utf8',env:{...process.env,TZ:'UTC'}})
      .split('\n').flatMap(line=>{
        const match=/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/.exec(line);
        return match?[{pid:Number(match[1]),parent:Number(match[2]),group:Number(match[3]),startedAt:new Date(Date.parse(match[4]+' UTC')).toISOString(),command:match[5]}]:[];
      });
    const chrome=rows.filter(row=>row.command.startsWith('/Applications/Google Chrome.app/'));
    assert.ok(chrome.every(row=>Date.parse(row.startedAt)<Date.parse('2026-10-09T15:57:21Z')),'A new Chrome group remains; no restart permitted');
    assert.ok(!rows.some(row=>row.command.startsWith(process.execPath+' '+root+'scripts/douyin_authorised_detail.mjs')),'Author detail collector remains');
    await save('browser-cleanup-preload',{at:new Date().toISOString(),newChromeGroupsRemaining:0,authorDetailCollectorsRemaining:0,
      priorChromeProcessesUntouched:chrome.map(({command,...safe})=>safe),
      protocolFixVerified:true,parentOwnershipProtocolUnchanged:true,reason:'Reload tested lifecycle fix only after no turn-created browser group remains'});
  }
  const idle=()=>{
    assert.equal(execFileSync('/bin/ps',['-p',String(oldPid),'-o','command='],{encoding:'utf8'}).trim(),process.execPath+' '+root+'server.mjs');
    assert.equal(execFileSync('/bin/ps',['-p',String(oldPid),'-o','ppid='],{encoding:'utf8'}).trim(),'1');
    const db=new DatabaseSync(root+'data/douyin-monitor.sqlite',{readOnly:true});
    try {return {
      runs:db.prepare("SELECT count(*) n FROM runs WHERE status IN ('running','queued')").get().n,
      jobs:db.prepare("SELECT count(*) n FROM author_resolution_jobs WHERE status IN ('queued','running')").get().n,
      leases:db.prepare('SELECT count(*) n FROM author_resolution_queue WHERE lease_owner IS NOT NULL').get().n,
    };}finally{db.close()}
  };
  let found=false;
  for(let i=0;i<12;i++) {
    if(!Object.values(idle()).some(Boolean)){await pause(500);if(!Object.values(idle()).some(Boolean)){found=true;break}}
    await pause(2500);
  }
  assert.ok(found,'No idle window; no signal sent');
  process.kill(oldPid,'SIGTERM');
  await save('runtime-signal',{at:new Date().toISOString(),oldPid,idleVerified:true,existingKeepAlive:true,forcedExit:false,sourceAndPublisherUntouched:true});
  let loaded;
  for(let i=0;i<120;i++) {
    try {
      const headers=await session();
      const response=await fetch(origin+`/api/author-spreadsheet/jobs/${jobId}/authorised-detail`,{
        method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(2000)});
      const data=await response.json();
      if(response.status===400 && /唯一作品 ID/.test(data.error)){
        const pid=Number(execFileSync('/usr/sbin/lsof',['-t','-iTCP:4188','-sTCP:LISTEN'],{encoding:'utf8'}).trim());
        assert.notEqual(pid,oldPid); loaded={at:new Date().toISOString(),oldPid,newPid:pid,health:(await fetch(origin+'/healthz')).status,routeStatus:response.status};break;
      }
    }catch{}
    await pause(500);
  }
  assert.ok(loaded,'Restart not verified'); await save('runtime-load',loaded);console.log(JSON.stringify(loaded));
} else {
  assert.equal(JSON.parse(await readFile(out+'runtime-load.json','utf8')).health,200);
  const headers=await session(),startedAt=new Date().toISOString();
  const sourceRow=Number(process.argv[3] || 682); assert.ok(Number.isSafeInteger(sourceRow)&&sourceRow>0);
  const response=await fetch(origin+`/api/author-spreadsheet/jobs/${jobId}/${mode==='monitor'?'authorised-monitor':'authorised-detail'}`,{
    method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({sourceRow}),signal:AbortSignal.timeout(55000)});
  const result={startedAt,finishedAt:new Date().toISOString(),status:response.status,data:await response.json(),
    healthAfter:(await fetch(origin+'/healthz')).status};
  await save(mode==='monitor'?'real-monitor-row'+sourceRow+'-'+Date.now():'real-probe',result);
  console.log(JSON.stringify({...result,data:{...result.data,admission:result.data.admission?{
    monitoringChanged:result.data.admission.monitoringChanged,status:result.data.admission.status,
    targetId:result.data.admission.target?.id,enabled:result.data.admission.target?.enabled,
    created:result.data.admission.created}:undefined}}));
}
