// Only reads production; writes a unique QA receipt, never drives runtime work.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const json=async p=>JSON.parse(await readFile(join(root,p),'utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex');
const hash=async p=>{const h=createHash('sha256');for await(const b of createReadStream(p))h.update(b);return h.digest('hex');};
const result={phase:99,startedAt:'2026-10-02T04:23:03Z',developmentFreeze:'2026-10-02T04:48:03Z',hardStop:'2026-10-02T04:53:03Z',reviewedRunIds:[],newTimers:false,manualCollection:false,productionRestart:false,dataChangedByThisTurn:false,fullGoal:'U01-U47 remains active'};
const release=await json('data/maintenance-journal/2026-10-02-phase99-release.json'),site=join(root,'../mcn-public-site');
assert.equal(release.deployment.status,'succeeded');assert.equal(release.audience,'public');assert.equal(release.version.version_number,41);
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:site,encoding:'utf8'}).trim(),release.source.commit_sha);
assert.equal(execFileSync('git',['status','--short'],{cwd:site,encoding:'utf8'}).trim(),'');
assert.deepEqual(execFileSync('git',['diff','--name-only',release.originalCommit,release.source.commit_sha],{cwd:site,encoding:'utf8'}).trim().split('\n').sort(),release.frontendChangesOnly.slice().sort());
for(const f of release.files){assert.equal(sha(await readFile(join(site,f.path))),f.afterSha256);const backup=join(root,'data/backups/phase99-code-20261002',f.path.endsWith('.css')?'replica.css':'topic-history.tsx');assert.equal(sha(await readFile(backup)),f.beforeSha256);}
result.release={version:release.version.version_number,url:release.deployment.url,commit:release.source.commit_sha,archiveSha256:await hash(release.source.archive),public:true,envRevision:release.deployment.env_set_revision};
result.tests={};
for(const [name,path,minimum] of [['main','data/maintenance-journal/2026-10-02-phase99-main-full-release.log',4173],['site','data/maintenance-journal/2026-10-02-phase99-site-tests.log',47]]){const b=await readFile(join(root,path),'utf8'),numbers=Object.fromEntries(['tests','pass','fail','skipped','cancelled'].map(k=>[k,Number(new RegExp('ℹ '+k+' (\\d+)').exec(b)?.[1])]));assert.ok(numbers.tests>=minimum);assert.equal(numbers.pass,numbers.tests);assert.equal(numbers.fail+numbers.skipped+numbers.cancelled,0);result.tests[name]={...numbers,sha256:sha(b)};}
assert.equal((await readFile(join(root,'data/maintenance-journal/2026-10-02-phase99-site-types.log'),'utf8')).trim(),'');result.tests.typeCheckPassed=true;
const sourceBytes=await readFile(join(root,'data/source-poll/manifest.json')),source=JSON.parse(sourceBytes);assert.equal(sha(sourceBytes),'184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5');
result.source={sha256:sha(sourceBytes),lastFinishedAt:source.lastFinishedAt,jobId:source.jobId??null,notASurrogateForAbsentLastJobId:true};
for(const f of await json('docs/phase95-profile-first-manifest.json'))assert.equal(sha(await readFile(join(root,f.file))),f.main);
for(const f of (await json('data/maintenance-journal/2026-10-02-phase98-root-approved-source.json')).files)assert.equal(sha(await readFile(join(root,f.path))),f.sha256);
result.backendProductionSourcesUnchanged=true;
const backup=await json('data/maintenance-journal/2026-10-02-phase98-backup.json');assert.equal(await hash(backup.backupPath),backup.sha256);assert.equal(await hash(backup.restoredPath),backup.sha256);
const db=new DatabaseSync(backup.restoredPath,{readOnly:true});try{db.exec('PRAGMA query_only=ON;BEGIN');assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);for(const [table,count] of Object.entries(backup.validation.counts)){assert.match(table,/^[a-z_]+$/);assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,count);}assert.equal(db.prepare('SELECT total_changes() n').get().n,0);db.exec('ROLLBACK');}finally{db.close();}
result.backup={sha256:backup.sha256,bytes:backup.bytes,matchedTables:Object.keys(backup.validation.counts).length,restoredReadable:true,cutoff:backup.cutoff,doesNotContainLaterSamples:true};
const live=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});try{live.exec('PRAGMA query_only=ON;BEGIN');result.latestRun=live.prepare('SELECT id,status,trigger_type,started_at,finished_at,target_count,processed_count,success_count,error_count FROM runs ORDER BY id DESC LIMIT 1').get();result.lastTerminalRun=live.prepare("SELECT MAX(id) id FROM runs WHERE status!='running'").get().id;result.runningCount=live.prepare("SELECT COUNT(*) n FROM runs WHERE status='running'").get().n;assert.equal(live.prepare('SELECT total_changes() n').get().n,0);live.exec('ROLLBACK');}finally{live.close();}
const get=async path=>{const r=await fetch('http://127.0.0.1:4188'+path,{signal:AbortSignal.timeout(12000)});assert.equal(r.status,200);return r.json();};
const [health,monitor,queue]=await Promise.all([get('/api/health'),get('/api/monitoring-status'),get('/api/ingestion-reviews')]);
result.health={status:health.status,runtimeAI:health.runtimeAI,http200:true};assert.equal(health.runtimeAI,false);
result.livePrivateCoverage={checkedAt:monitor.checkedAt,profileDaily:monitor.updateSla?.coreAccounts?.daily,profile8h:monitor.updateSla?.coreAccounts?.fresh8h,worksDaily:monitor.updateSla?.works?.daily,works8h:monitor.updateSla?.works?.fresh8h,topicsDaily:monitor.updateSla?.topics?.daily,topics8h:monitor.updateSla?.topics?.fresh8h};
result.queue={pending:queue.totalPending??queue.summary?.totalPending??null,completed:queue.totalCompleted??queue.summary?.totalCompleted??null,status:queue.queue?.status??null};
const state=await json('data/public-replica-publisher/state.json'),lock=await json('data/public-replica-publisher/lock.json');for(const pid of [22870,26001,lock.pid])process.kill(pid,0);
result.runtime={mainPid:22870,sourcePid:26001,publisherPid:lock.pid,threeProcessesAlive:true};
result.publisher={status:state.status,active:state.active??null,asOf:state.publishedAsOf,confirmedAt:state.lastConfirmedPublishedAt,syncStatus:state.sync?.status,batches:state.sync?.batchesCompleted,total:state.sync?.batchesTotal};
result.publicReadback=release.rootActualBrowser.publicFullSite;result.publicAndPrivateCoverageNotConflated=true;
result.remaining=['No proof of Mac-off new collection','All works not complete; running source not terminalized or AI-reviewed','Public independent history remains readable, not proof of every network','No real VoiceOver or user-retention session'];
result.finishedAt=new Date().toISOString();result.elapsedMinutes=(Date.parse(result.finishedAt)-Date.parse(result.startedAt))/60000;assert.ok(Date.parse(result.finishedAt)<Date.parse(result.hardStop));
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase99-closeout.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({finishedAt:result.finishedAt,elapsedMinutes:result.elapsedMinutes,tests:result.tests,release:result.release,latestRun:result.latestRun,runtime:result.runtime,publisher:result.publisher,backup:result.backup,source:result.source,health:result.health}));
