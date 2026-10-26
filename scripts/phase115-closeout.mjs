import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile,chmod} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse('2026-10-02T11:14:14Z'));
const from='/tmp/phase115-integrity-pUZZsw',sealName='completion-signed-receipt.json',seal=await readFile(join(from,sealName));
assert.equal(sha(seal),'f2851d8cd7d1c776e6eea8cc0026aad59fd8f548f6f289cc13584ba19051df82');
const peer=JSON.parse(seal),archived=[];
for(const [file,row]of Object.entries(peer.files)){
  assert.ok(!file.startsWith('/')&&!file.split('/').includes('..'));const bytes=await readFile(join(from,file));assert.equal(sha(bytes),row.sha256);assert.equal(bytes.length,row.bytes);
  const dest=join(root,'docs/phase115-evidence/completion',file);await mkdir(dirname(dest),{recursive:true});await copyFile(join(from,file),dest,constants.COPYFILE_EXCL);await chmod(dest,0o400);assert.equal(sha(await readFile(dest)),row.sha256);archived.push({file:dest,sha256:row.sha256});
}
const sealDest=join(root,'docs/phase115-evidence/completion',sealName);await copyFile(join(from,sealName),sealDest,constants.COPYFILE_EXCL);await chmod(sealDest,0o400);assert.equal(sha(await readFile(sealDest)),sha(seal));archived.push({file:sealDest,sha256:sha(seal)});
const bindingPath=join(root,'data/maintenance-journal/2026-10-02-phase115-reviewed-bindings.json'),bindingBytes=await readFile(bindingPath),bindings=JSON.parse(bindingBytes);
assert.equal(sha(bindingBytes),peer.rootBindingsSHA256);assert.equal(bindings.completions.length,20);assert.equal(bindings.evidence.length,20);assert.deepEqual(bindings.fixedRunIds,peer.fixedRunIds);
for(const row of bindings.completions){assert.equal(sha(await readFile(row.file)),row.sha256);assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${row.runId}.json`))),row.originalSHA256);}
for(const row of bindings.evidence)assert.equal(sha(await readFile(row.file)),row.sha256);
for(const receiptFile of ['2026-10-02-phase115-evidence-archive.json','2026-10-02-phase115-addenda-archive.json']){const proof=JSON.parse(await readFile(join(root,'data/maintenance-journal',receiptFile)));for(const row of proof.archived||proof.refs)assert.equal(sha(await readFile(row.file)),row.sha256);}
const before=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase115-settings-before.json'))),promoted=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase115-settings-promoted.json')));
const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});const live={};
try{
  db.exec('PRAGMA query_only=ON;BEGIN');const rows=db.prepare('SELECT key,value,updated_at FROM settings ORDER BY key').all(),changed=new Set(['publicWorksPageMode','publicWorksPageHardLimit','publicWorksRequestThreshold']);
  assert.equal(sha(JSON.stringify(rows.filter(row=>!changed.has(row.key)))),before.otherRowsSHA256);
  for(const row of promoted.afterRows)assert.deepEqual({...rows.find(x=>x.key===row.key)},row);
  live.settingRows=promoted.afterRows;live.latestNaturalRuns=db.prepare('SELECT id,trigger_type,status,started_at,finished_at FROM runs ORDER BY id DESC LIMIT 5').all();
  live.queryOnly=db.prepare('PRAGMA query_only').get().query_only;live.totalChanges=db.prepare('SELECT total_changes() n').get().n;assert.equal(live.queryOnly,1);assert.equal(live.totalChanges,0);db.exec('ROLLBACK');
}finally{db.close();}
const get=async path=>{const response=await fetch('http://127.0.0.1:4188'+path,{signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);return response.json();};
const health=await get('/api/health'),monitoring=await get('/api/monitoring-status'),queue=await get('/api/ingestion-reviews');
assert.equal(health.status,'ready');assert.equal(health.runtimeAI,false);assert.equal(monitoring.scheduler.scheduleIntervalHours,8);assert.deepEqual(monitoring.scheduler.slotTimes,['02:00','10:00','18:00']);
const servicePIDs=execFileSync('/bin/ps',['-p','90988,26001,79274','-o','pid=,ppid='],{encoding:'utf8'});for(const pid of [90988,26001,79274])assert.match(servicePIDs,new RegExp(`(?:^|\\n)\\s*${pid}\\s+1\\s*`));
assert.equal(execFileSync('git',['status','--short'],{cwd:join(root,'../mcn-public-site'),encoding:'utf8'}).trim(),'');
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:join(root,'../mcn-public-site'),encoding:'utf8'}).trim(),'15f7913736df5536d9dbbcb6df5f2c2bdc46a81d');
const sourceManifestSHA256=sha(await readFile(join(root,'data/source-poll/manifest.json')));assert.equal(sourceManifestSHA256,'184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5');
const finishedAt=new Date().toISOString(),startedAt='2026-10-02T10:44:14Z',actualElapsedSeconds=(Date.parse(finishedAt)-Date.parse(startedAt))/1000;
assert.ok(actualElapsedSeconds<1800);
const result={startedAt,finishedAt,actualElapsedSeconds,withinThirtyMinutes:true,archived,bindingsSHA256:sha(bindingBytes),fixedReviewed:20,nextFixedAudit:2847,originalsUnchanged:true,live,health,monitoring,queue,servicePIDs,sourceManifestSHA256,productSourceEdits:0,settingsChange:'whole-page-v2/100/30; old30 and others preserved',manualCollection:false,restart:false,sourcePollTriggered:false,newModelAutomation:false,newDeployment:false,allOwnedTestHandlesTerminal:true,threePeersFinal:true,scopeUnchanged:'U01-U47',goalComplete:false,remaining:['allworks coverage and 403','Mac-off new sampling','all-network availability','mixed-build public chart asset failure']};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase115-stop.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({finishedAt,actualElapsedSeconds,withinThirtyMinutes:true,reviewed:20,next:2847,health:health.status,runtimeAI:false,settingsMode:'whole-page-v2',pending:queue.totalPending,completed:queue.totalCompleted,latestNaturalRuns:live.latestNaturalRuns}));
