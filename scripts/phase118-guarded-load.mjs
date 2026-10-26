// Root-owned bounded normal-service handoff; never starts a collector.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync,copyFileSync,chmodSync,statSync,readdirSync} from 'node:fs';
import {constants,createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {getNextFirstCollectionTarget} from '../lib/first-collection.mjs';
import {validateSQLiteSnapshot} from '../lib/backup-manager.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const journal=join(root,'data/maintenance-journal');
const deadline=Date.parse('2026-10-02T12:32:21Z');
const hash=b=>createHash('sha256').update(b).digest('hex');
const j=f=>JSON.parse(readFileSync(join(root,f),'utf8'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function time(){assert.ok(Date.now()<deadline,'Phase118 bounded window expired');}
function save(name,data){time();writeFileSync(join(journal,'2026-10-02-phase118-'+name+'.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o400});}
async function hashFile(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
async function get(path){const r=await fetch('http://127.0.0.1:4188'+path,{signal:AbortSignal.timeout(6000)});assert.equal(r.status,200,path);return r.json();}
function inputs(){
 const base=j('data/maintenance-journal/2026-10-02-phase117-code-baseline.json');
 const approved=j('data/maintenance-journal/2026-10-02-phase117-approved.json');
 for(const row of base.entries)assert.equal(hash(readFileSync(join(root,row.file))),approved.product[row.file]||approved.auxiliary[row.file]||row.sha256,row.file);
 for(const [file,sha]of Object.entries(approved.product))assert.equal(hash(readFileSync(join(root,file))),sha,file);
 const tests=j('data/maintenance-journal/2026-10-02-phase117-main-tests-result.json');
 assert.equal(tests.tests,4342);assert.equal(tests.pass,4342);assert.equal(tests.outcome.code,0);
 for(const key of ['fail','cancelled','skipped'])assert.equal(tests[key],0);
 assert.equal(hash(readFileSync(tests.logPath)),tests.sha256);
 const site=join(root,'../mcn-public-site');
 for(const row of base.siteRows)assert.equal(hash(readFileSync(join(site,row.file))),row.sha256,row.file);
 assert.equal(execFileSync('git',['status','--short'],{cwd:site,encoding:'utf8'}).trim(),'');
 assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:site,encoding:'utf8'}).trim(),base.siteHead);
 const sourceSha=hash(readFileSync(join(root,'data/source-poll/manifest.json')));assert.equal(sourceSha,base.sourceSHA256);
 return{mainFiles:base.entries.length,siteFiles:base.siteRows.length,siteHead:base.siteHead,sourceSha,reusedUnchangedFullRegression:{tests:4342,sha256:tests.sha256},readerSha:approved.product['lib/works-observation.mjs']};
}
function identity(pid){
 const command=execFileSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8'}).trim();
 assert.equal(command,'/Users/tyke/.local/node-v24.16.0-darwin-arm64/bin/node '+join(root,'server.mjs'));
 assert.equal(execFileSync('/bin/ps',['-p',String(pid),'-o','ppid='],{encoding:'utf8'}).trim(),'1');
 assert.equal(Number(execFileSync('/bin/ps',['-p',String(pid),'-o','uid='],{encoding:'utf8'}).trim()),process.getuid());
 let children=[];try{children=execFileSync('/usr/bin/pgrep',['-P',String(pid)],{encoding:'utf8'}).trim().split('\n').filter(Boolean);}catch(e){if(e.status!==1)throw e;}
 assert.deepEqual(children,[]);return{pid,command,startedAt:execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8'}).trim(),children};
}
function databaseIdle(){
 const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});
 try{db.exec('PRAGMA query_only=ON;BEGIN');const now=new Date().toISOString();
  const idle={runs:db.prepare("SELECT count(*) n FROM runs WHERE status='running'").get().n,jobs:db.prepare("SELECT count(*) n FROM author_resolution_jobs WHERE status IN ('queued','running')").get().n,leases:db.prepare('SELECT count(*) n FROM author_resolution_queue WHERE lease_owner IS NOT NULL').get().n,due:db.prepare("SELECT count(*) n FROM author_resolution_queue WHERE status IN ('pending','retry') AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?)").get(now,now).n,firstCollection:getNextFirstCollectionTarget({db})?.id??null};
  assert.deepEqual(idle,{runs:0,jobs:0,leases:0,due:0,firstCollection:null});
  const maxRun=db.prepare('SELECT max(id) n FROM runs').get().n;
  const settingsSha256=hash(JSON.stringify(db.prepare('SELECT key,value,updated_at FROM settings ORDER BY key').all()));
  assert.equal(db.prepare('SELECT total_changes() n').get().n,0);
  return{idle,maxRun,settingsSha256};
 }finally{try{db.exec('ROLLBACK');}catch{}db.close();}
}
async function observe(){
 const proc=identity(90988);const s=(await get('/api/monitoring-status')).scheduler;
 assert.equal(s.running,false);assert.equal(s.currentRun,null);assert.equal(s.lastSuccessfulTickAt,s.lastTickAt);assert.equal(s.lastError,null);
 assert.equal(s.scheduleIntervalHours,8);assert.deepEqual(s.slotTimes,['02:00','10:00','18:00']);assert.ok(Date.parse(s.nextRunAt)-Date.now()>60000);
 const tickAgeMs=Date.now()-Date.parse(s.lastTickAt);assert.ok(tickAgeMs>=0&&tickAgeMs<10000,'fresh idle tick margin absent');
 return{checkedAt:new Date().toISOString(),proc,database:databaseIdle(),sourceSha:hash(readFileSync(join(root,'data/source-poll/manifest.json'))),tick:s.lastTickAt,tickAgeMs};
}
const mode=process.argv[2];time();
if(mode==='preserve'){
 const checks=inputs();const dir=join(root,'data/backups/automatic');
 const rows=readdirSync(dir).filter(f=>/^douyin-monitor-auto-.*\.sqlite$/.test(f)).map(file=>({file,mtime:statSync(join(dir,file)).mtimeMs})).sort((a,b)=>b.mtime-a.mtime||b.file.localeCompare(a.file));
 assert.equal(rows.length,14);const oldest=rows.at(-1);assert.equal(oldest.file,'douyin-monitor-auto-20261001T161557333Z-startup-cfe8caeb.sqlite');
 const preserved=join(root,'data/code-candidates/phase118/preserved-startup-retention');mkdirSync(preserved,{recursive:true,mode:0o700});const files=[];
 for(const name of [oldest.file,oldest.file+'.manifest.json']){const src=join(dir,name),dst=join(preserved,name);assert.ok(!existsSync(dst));copyFileSync(src,dst,constants.COPYFILE_EXCL);chmodSync(dst,0o400);const sha=await hashFile(src);assert.equal(await hashFile(dst),sha);files.push({source:src,preserved:dst,bytes:statSync(dst).size,sha256:sha});}
 save('preserved-backup',{at:new Date().toISOString(),checks,files,reason:'Preserve exactly the oldest automatic snapshot before existing startup retention prunes it.'});console.log(JSON.stringify({preserved:files.length,checks}));
}else if(mode==='load'){
 assert.ok(Date.now()<Date.parse('2026-10-02T12:27:21Z'),'no new handoff after freeze');const label=process.argv[3];assert.match(label||'',/^[a-z0-9-]+$/);
 const result={startedAt:new Date().toISOString(),atomicDrain:false,manualSampling:false,publisherAndSourceUntouched:true};
 try{
  result.inputs=inputs();const preserved=j('data/maintenance-journal/2026-10-02-phase118-preserved-backup.json');for(const f of preserved.files)assert.equal(await hashFile(f.preserved),f.sha256);
  result.first=await observe();await delay(500);result.second=await observe();assert.deepEqual(result.second.proc,result.first.proc);assert.deepEqual(result.second.database,result.first.database);assert.equal(result.second.tick,result.first.tick);assert.equal(result.second.sourceSha,result.inputs.sourceSha);assert.equal(result.first.sourceSha,result.second.sourceSha);
  assert.deepEqual(databaseIdle(),result.second.database);assert.deepEqual(identity(90988),result.second.proc);for(const pid of [26001,79274])process.kill(pid,0);
  assert.ok(Date.now()-Date.parse(result.second.tick)<10000);save('main-'+label+'-gate',result);
  assert.ok(Date.now()<Date.parse('2026-10-02T12:27:21Z'),'handoff freeze reached');assert.equal(hash(readFileSync(join(root,'data/source-poll/manifest.json'))),result.second.sourceSha);
  assert.ok(Date.now()-Date.parse(result.second.tick)<10000);process.kill(90988,'SIGTERM');result.signalledAt=new Date().toISOString();save('main-'+label+'-signal',result);console.log(JSON.stringify({signalledAt:result.signalledAt,pid:90988,atomicDrain:false}));
 }catch(error){result.refusedAt=new Date().toISOString();result.reason=error.message;save('main-'+label+'-refused',result);console.log(JSON.stringify({refused:true,reason:error.message}));process.exitCode=2;}
}else if(mode==='tests'){
 const verified=inputs();const startedAt=new Date().toISOString();const log=execFileSync(process.execPath,['--test','test/phase117-works-timeout-resume.test.mjs'],{cwd:root,encoding:'utf8',timeout:30000});
 for(const key of ['tests','pass'])assert.match(log,new RegExp('(?:#|ℹ) '+key+' 35\\b'));for(const key of ['fail','cancelled','skipped'])assert.match(log,new RegExp('(?:#|ℹ) '+key+' 0\\b'));
 const file=join(journal,'2026-10-02-phase118-resume-tests.log');writeFileSync(file,log,{flag:'wx',mode:0o400});save('tests',{startedAt,finishedAt:new Date().toISOString(),tests:35,pass:35,fail:0,cancelled:0,skipped:0,file,sha256:hash(log),verified,full4342ReusedNotRerun:true});console.log(JSON.stringify({tests:35,pass:35,full4342:'unchanged-inputs reverified; not rerun this phase'}));
}else if(mode==='verify'){
 const startedAt=new Date().toISOString();const signal=j('data/maintenance-journal/2026-10-02-phase118-main-third-signal.json');
 assert.ok(signal.signalledAt);let health;
 for(let attempt=0;attempt<15;attempt++){time();try{health=await get('/api/health');if(health.status==='ready')break;}catch{}await delay(2000);}
 assert.equal(health?.status,'ready');assert.equal(health.runtimeAI,false);
 const printed=execFileSync('/bin/launchctl',['print','gui/501/com.codex.douyin-monitor-workbench'],{encoding:'utf8'});const pid=Number(/\bpid = (\d+)/.exec(printed)?.[1]);assert.ok(pid>0&&pid!==90988);
 const command=execFileSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8'}).trim();assert.equal(command,'/Users/tyke/.local/node-v24.16.0-darwin-arm64/bin/node '+join(root,'server.mjs'));
 assert.equal(execFileSync('/bin/ps',['-p',String(pid),'-o','ppid='],{encoding:'utf8'}).trim(),'1');assert.equal(Number(execFileSync('/bin/ps',['-p',String(pid),'-o','uid='],{encoding:'utf8'}).trim()),501);
 let oldAlive=true;try{process.kill(90988,0);}catch(e){assert.equal(e.code,'ESRCH');oldAlive=false;}assert.equal(oldAlive,false);
 for(const p of [26001,79274])process.kill(p,0);const checks=inputs();const preserved=j('data/maintenance-journal/2026-10-02-phase118-preserved-backup.json');for(const f of preserved.files)assert.equal(await hashFile(f.preserved),f.sha256);
 const monitoring=await get('/api/monitoring-status');assert.equal(monitoring.scheduler.scheduleIntervalHours,8);assert.deepEqual(monitoring.scheduler.slotTimes,['02:00','10:00','18:00']);
 const dir=join(root,'data/backups/automatic');const rows=readdirSync(dir).filter(f=>/^douyin-monitor-auto-.*\.sqlite$/.test(f)).map(file=>({file,mtime:statSync(join(dir,file)).mtimeMs})).sort((a,b)=>b.mtime-a.mtime||b.file.localeCompare(a.file));assert.equal(rows.length,14);
 const backupPath=join(dir,rows[0].file),manifest=JSON.parse(readFileSync(backupPath+'.manifest.json','utf8'));assert.equal(manifest.reason,'startup');assert.ok(Date.parse(manifest.createdAt)>Date.parse(signal.signalledAt));assert.equal(await hashFile(backupPath),manifest.sha256);const validation=validateSQLiteSnapshot(backupPath);assert.equal(validation.integrityCheck,'ok');assert.equal(validation.foreignKeyViolations,0);
 const oldBackupRotated=!existsSync(preserved.files[0].source);const result={startedAt,verifiedAt:new Date().toISOString(),newPid:pid,oldPid:90988,oldExited:!oldAlive,health,monitoring,checks,backup:{path:backupPath,bytes:statSync(backupPath).size,sha256:manifest.sha256,validation},oldBackupRotated,oldBackupStillRecoverable:true,sourceAndPublisherPids:[26001,79274],runtimeReaderLoadedByNormalNodeStartup:true,naturalCheckpointBenefitObserved:false,manualCollection:false,newTimers:false,goalComplete:false};save('runtime-loaded',result);console.log(JSON.stringify({newPid:pid,ready:true,runtimeAI:false,backupTables:Object.keys(validation.counts).length,oldBackupRotated,checkpointBenefitObserved:false}));
}else throw new Error('unknown mode');
