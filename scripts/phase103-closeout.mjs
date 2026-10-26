import assert from 'node:assert/strict';
import { readFile, writeFile, stat, mkdir, copyFile, constants } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { validateSQLiteSnapshot, validationCountsMatch } from '../lib/backup-manager.mjs';
import { completePostIngestionProductReview } from '../lib/post-ingestion-review.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const startedAt='2026-10-02T05:54:04Z', deadline=Date.parse('2026-10-02T06:24:04Z');
const guard=()=>assert.ok(Date.now()<deadline,'Phase103 hard stop');
const hash=value=>createHash('sha256').update(value).digest('hex');
const sha=async path=>{const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');};
const json=async file=>JSON.parse(await readFile(join(root,file),'utf8'));
const evidenceOf=async file=>({file,sha256:await sha(join(root,file)),bytes:(await stat(join(root,file))).size});
const logCounts=async file=>{const text=await readFile(join(root,file),'utf8'),result={};for(const key of ['tests','pass','fail','cancelled','skipped']){const m=text.match(new RegExp(`^ℹ ${key} (\\d+)$`,'m'));assert.ok(m,`${file}: ${key}`);result[key]=Number(m[1]);}return {file,...result,sha256:hash(text)};};
guard();
const full=await logCounts('data/maintenance-journal/2026-10-02-phase103-main-full-bounded.log');
assert.deepEqual([full.tests,full.pass,full.fail,full.cancelled,full.skipped],[4255,4255,0,0,0]);
const initial=await logCounts('data/maintenance-journal/2026-10-02-phase103-main-full.log');
assert.deepEqual([initial.tests,initial.pass,initial.fail,initial.cancelled,initial.skipped],[4255,4254,1,0,0]);
assert.equal(initial.sha256,'9b80d58623ff53fcbced73c2ba905ec13d0cc539e12b6c690ce29a9b8b19209c');
const targeted=await logCounts('data/maintenance-journal/2026-10-02-phase103-contrast-green.log');
assert.deepEqual([targeted.tests,targeted.pass,targeted.fail,targeted.skipped],[14,14,0,0]);
const backup=await json('data/maintenance-journal/2026-10-02-phase103-backup.json');
const cssPath=join(root,'public/rebuild.css'),css=await readFile(cssPath,'utf8');
const cssBefore=await readFile(join(backup.codeDir,'public/rebuild.css'),'utf8');
const from='.metric{color:#293a54;font-size:12px;font-weight:650}',to='.metric{color:var(--ink);font-size:12px;font-weight:650}';
assert.equal(cssBefore.split(from).length,2);assert.equal(css.split(to).length,2);
assert.equal(css.replace(to,from),cssBefore);
assert.equal(hash(css),'29602438521321bc9c75ba18d6bf8a50e4b859ab5edd577859b794bb175a1dad');
for(const item of backup.code){assert.equal(await sha(item.destination),item.beforeSha256);if(item.file!=='public/rebuild.css')assert.equal(await sha(join(root,item.file)),item.beforeSha256,item.file);}
const code=await json('docs/phase103-integrity-backup-and-code.json');assert.equal(code.sourceCount,88);
for(const item of code.sourceFiles)assert.equal(await sha(join(root,item.file)),item.sha256,item.file);
const approved=await json('docs/phase102-installation-manifest.json');
for(const item of approved.installationFiles)assert.equal(await sha(join(root,item.file)),item.postSha256,item.file);
const previous=await json('docs/phase100-candidate-manifest.json');
assert.equal(await sha(join(root,'docs/phase100-candidate-manifest.json')),approved.preservation.phase100ManifestSha256);
const approvedChanges=new Map(approved.installationFiles.map(item=>[item.file,item.postSha256]));
approvedChanges.set('lib/utils.mjs',approved.preservation.phase101UtilsSha256);
let preservationChecks=0;
for(const item of [...previous.files,...previous.preserved]){
 const expected=approvedChanges.get(item.file)??item.candidate??item.sha256;
 if(item.file==='public/rebuild.css')assert.equal(hash(cssBefore),expected);
 else assert.equal(await sha(join(root,item.file)),expected,item.file);
 preservationChecks++;
}
assert.equal(preservationChecks,624);
for(const file of [backup.backupPath,backup.restoredPath]){assert.equal(await sha(file),backup.sha256);assert.equal((await stat(file)).size,backup.bytes);}
assert.equal((await stat(backup.restoredPath)).mode&0o777,0o400);
const restored=validateSQLiteSnapshot(backup.restoredPath);assert.ok(validationCountsMatch(backup.validation.counts,restored.counts));
assert.equal(restored.quickCheck,'ok');assert.equal(restored.integrityCheck,'ok');assert.equal(restored.foreignKeyViolations,0);

const candidate=await json('docs/phase103-works-final.json');
assert.equal(await sha(candidate.package.path),candidate.package.sha256);
assert.equal(await sha(join(root,candidate.sourceChanges[0].file)),candidate.sourceChanges[0].beforeSha256);
assert.equal(await sha(join(root,candidate.patch.path)),candidate.patch.sha256);
assert.equal(await sha(join(root,candidate.report.path)),candidate.report.sha256);
assert.equal(await sha(join(root,candidate.newTest.readableCopy)),candidate.newTest.sha256);
const entries=execFileSync('/usr/bin/tar',['-tzf',candidate.package.path],{encoding:'utf8'}).trim().split('\n');
assert.deepEqual(entries.sort(),[...candidate.package.files].sort());
const storedCandidate=join(root,'data/code-candidates/phase103/phase103-works-candidate.tar.gz');
await mkdir(join(storedCandidate,'..'),{recursive:true,mode:0o700});
try{await copyFile(candidate.package.path,storedCandidate,constants.COPYFILE_EXCL);}catch(error){if(error.code!=='EEXIST')throw error;}
assert.equal(await sha(storedCandidate),candidate.package.sha256);
assert.equal(await sha(join(root,'docs/phase103-works-candidate-independent-review.md')),'9cf03aa814e55359c57dca744ce6b20ff78e0d87957e5c11b6c17d8452d3938a');
assert.equal(await sha(join(root,'docs/phase103-runtime-review.md')),'5d956e8803915d9a696abee6eeda99ab106628110a41caa0e74ed7caf5223121');
assert.equal(await sha(join(root,'docs/phase103-runtime-lock-diagnostic.md')),'1d2ee86076206e62cd2f45761f38ed0acea24a94c11004c66ea7d363347c0db8');
const visual=await json('docs/phase103-runtime-contrast-results.json');assert.equal(visual.passed,true);assert.equal(visual.cssSha256,hash(css));assert.deepEqual(visual.privateBrowserSurvivors,[]);
const terminal=await json('docs/phase103-integrity-terminal-2615-2635.json');
assert.deepEqual(terminal.fixedRunIds,Array.from({length:21},(_,i)=>2615+i));
assert.equal(terminal.queryOnly,1);assert.equal(terminal.changesBefore,0);assert.equal(terminal.changesAfter,0);assert.equal(terminal.originalEventsByteUnchanged,true);
assert.deepEqual(terminal.strict403RunIds,[2631,2634]);assert.equal(terminal.proofs.length,21);
for(const proof of terminal.proofs){assert.equal(proof.originalEventFieldCount,21);assert.equal(proof.independentExactEventRebuild,true);assert.equal(proof.independentIdentityTimeAndPageChecks,true);assert.equal(await sha(join(root,`data/ingestion-reviews/run-${proof.runId}.json`)),proof.originalEventSHA256);}

const endpoints={};
for(const [key,path,ms]of [['health','api/health',10000],['monitoring','api/monitoring-status',15000],['intake','api/ingestion-reviews',10000]]){
 guard();const before=performance.now(),response=await fetch(`http://127.0.0.1:4188/${path}`,{signal:AbortSignal.timeout(ms)});assert.equal(response.status,200);endpoints[key]={status:response.status,milliseconds:performance.now()-before,data:await response.json()};
}
assert.equal(endpoints.health.data.status,'ready');assert.equal(endpoints.health.data.runtimeAI,false);
assert.deepEqual(endpoints.monitoring.data.scheduler.slotTimes,['02:00','10:00','18:00']);assert.equal(endpoints.monitoring.data.scheduler.scheduleIntervalHours,8);
const served=await fetch('http://127.0.0.1:4188/rebuild.css',{signal:AbortSignal.timeout(10000)});assert.equal(served.status,200);assert.equal(hash(Buffer.from(await served.arrayBuffer())),hash(css));
const sourceFile='data/source-poll/manifest.json',source=await json(sourceFile),sourceSha=await sha(join(root,sourceFile));
assert.equal(sourceSha,'184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5');
const publisher=await json('data/public-replica-publisher/state.json');
const processes=execFileSync('/bin/ps',['-o','pid=,ppid=,comm=','-p','90988,26001,79274'],{encoding:'utf8'}).trim().split('\n').map(line=>{const m=/^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);assert.ok(m);return{pid:Number(m[1]),ppid:Number(m[2]),executable:m[3]};});
assert.deepEqual(processes.map(p=>p.pid).sort((a,b)=>a-b),[26001,79274,90988]);assert.ok(processes.every(p=>p.ppid===1));
const site=join(root,'../mcn-public-site');
const siteHead=execFileSync('/usr/bin/git',['rev-parse','HEAD'],{cwd:site,encoding:'utf8'}).trim();assert.equal(siteHead,'f8589092b3f2a947bede2a48d64ddabc709fb2f6');assert.equal(execFileSync('/usr/bin/git',['status','--short'],{cwd:site,encoding:'utf8'}).trim(),'');
const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});let current;
try{db.exec('PRAGMA query_only=ON;BEGIN');const counts={},appendedSinceBackup={};for(const table of Object.keys(backup.validation.counts)){counts[table]=db.prepare(`SELECT count(*) n FROM ${table}`).get().n;appendedSinceBackup[table]=counts[table]-backup.validation.counts[table];assert.ok(appendedSinceBackup[table]>=0,`${table}: original rows retained`);}current={checkedAt:new Date().toISOString(),counts,appendedSinceBackup,latestRun:db.prepare('SELECT id,trigger_type,status,started_at,finished_at FROM runs ORDER BY id DESC LIMIT 1').get(),latestSnapshotAt:db.prepare('SELECT MAX(captured_at) at FROM snapshots').get().at,newInterrupted:db.prepare("SELECT count(*) n FROM runs WHERE id>2648 AND status='interrupted'").get().n,queryOnly:db.prepare('PRAGMA query_only').get().query_only,changes:db.prepare('SELECT total_changes() n').get().n};assert.equal(current.changes,0);assert.equal(current.newInterrupted,0);db.exec('ROLLBACK');}finally{db.close();}

const evidenceFiles=['docs/phase103-product-review.md','data/maintenance-journal/2026-10-02-phase103.md','docs/phase103-integrity-review.md','docs/phase103-integrity-terminal-2615-2635.json','docs/phase103-integrity-backup-and-code.json','docs/phase103-runtime-review.md','docs/phase103-runtime-contrast-results.json','docs/phase103-runtime-readback.json','docs/phase103-runtime-main-targeted.log','docs/phase103-runtime-lock-diagnostic.md','data/maintenance-journal/2026-10-02-phase103-contrast-red.log','data/maintenance-journal/2026-10-02-phase103-contrast-green.log',initial.file,full.file,'data/maintenance-journal/2026-10-02-phase103-backup.json','docs/phase103-works-research.md','docs/phase103-works-final.json','docs/phase103-works-candidate-independent-review.md','docs/phase103-works-review-addendum.md'];
const evidence=await Promise.all(evidenceFiles.map(evidenceOf));assert.ok(evidence.length<=20);
const sourceLock={at:new Date().toISOString(),onlyProductMutation:'public/rebuild.css:.metric color',css:{before:hash(cssBefore),after:hash(css),exactInverse:true,servedBytesMatch:true},eightOtherPreimagesUnchanged:true,runtimeJavaScriptUnchanged:88,previousFilesAccountedFor:preservationChecks,previousPhase102InstallationPreserved:true,collectorCandidateNotInstalled:true,publisherLockCodeNotModified:true,siteNotModified:true,fullRegression:full,retainedFailedFullRegression:initial};
await writeFile(join(root,'docs/phase103-source-lock.json'),JSON.stringify(sourceLock,null,2)+'\n',{flag:'wx',mode:0o600});
const completions=[];
for(const runId of terminal.fixedRunIds){guard();const result=await completePostIngestionProductReview({ledgerDir:join(root,'data/ingestion-reviews'),runId,evidence:evidenceFiles,now:new Date()});completions.push({runId,status:result.status,completedAt:result.completion.completedAt});}
for(const proof of terminal.proofs)assert.equal(await sha(join(root,`data/ingestion-reviews/run-${proof.runId}.json`)),proof.originalEventSHA256);
for(const item of evidence)assert.equal(await sha(join(root,item.file)),item.sha256);
const afterResponse=await fetch('http://127.0.0.1:4188/api/ingestion-reviews',{signal:AbortSignal.timeout(10000)});assert.equal(afterResponse.status,200);const afterIntake=await afterResponse.json();
guard();const finishedAt=new Date().toISOString();
const receipt={phase:103,startedAt,finishedAt,elapsedMinutes:(Date.parse(finishedAt)-Date.parse(startedAt))/60000,classification:'progress',fullGoal:'U01-U47 remains active',sourceLock,evidence,backup:{path:backup.backupPath,restoredPath:backup.restoredPath,bytes:backup.bytes,sha256:backup.sha256,restoredReadable:true,cutoff:backup.cutoff,all14TableCountsMatch:true},current,runtime:{processes,health:endpoints.health,monitoring:endpoints.monitoring,samplingUsesAI:false,newTimer:false,restart:false,productionSignals:0,manualCollection:false},source:{sha256:sourceSha,lastFinishedAt:source.lastFinishedAt,unchanged:true},publisher:{status:publisher.status,activeAsOf:publisher.active?.asOf??null,publishedAsOf:publisher.publishedAsOf,lastConfirmedPublishedAt:publisher.lastConfirmedPublishedAt},site:{head:siteHead,clean:true,uiDeployment:false,url:'https://mcn-matrix-observatory.slowlygold4.chatgpt.site'},reviews:{fixedRunIds:terminal.fixedRunIds,completions,originalEventsByteUnchanged:true,independentRebuildFields:20,originalReviewedAtOrderChecked:true,notClaiming21IndependentTimeSources:true,nextUnaudited:2636,pending:afterIntake.totalPending,completed:afterIntake.totalCompleted,queueStatus:afterIntake.queue?.status,queueFailed:afterIntake.queue?.failedCount},candidate:{storedPath:storedCandidate,sha256:candidate.package.sha256,status:'isolated-not-approved-for-production',knownP2:'replayed finished response increments passive untrackedEvents',bodyClock:'25s starts at promotion JSON read; absolute45s remains',naturalProductionBenefitUnproven:true},ui:{nativeDesktopActualReadback:true,tuantuanSliceAccounts:276,pageCount:14,bothSortDirections:true,page2:true,escapeReturnsScopeSortPageFocus:true,nativeMobileClaim:false,independentPrivate390px:true,ownNewTabClosed:true,originalPublicTabPreserved:true},privateExecSessionsCompleted:[60676,58599,16814,64719,75896],knownUnfixed:['six auxiliary-reading selectors','full print palette and interaction backgrounds','publisher recovery loser classification','collector isolated passive diagnostics P2','shared audit cancellation','legacy bootstrap query cost','full works coverage','Mac-off new sampling','all network accessibility','complete automated classification']};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase103-final-handoff.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({finishedAt,elapsedMinutes:receipt.elapsedMinutes,tests:full,retainedFailure:initial,reviewed:completions.length,backupReadable:true,newSnapshots:current.appendedSinceBackup.snapshots,newObservedWorks:current.appendedSinceBackup.posts,newMetricRows:current.appendedSinceBackup.post_metrics,newWorksWindows:current.appendedSinceBackup.works_observations,coverage:{profile:endpoints.monitoring.data.updateSla.coreAccounts.fresh8h,works:endpoints.monitoring.data.updateSla.works.fresh8h,topics:endpoints.monitoring.data.updateSla.topics.fresh8h},publisher:receipt.publisher,intake:receipt.reviews,fullGoalActive:true},null,2));
