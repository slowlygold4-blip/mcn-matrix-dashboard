import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)), site=join(root,'../mcn-public-site');
const sha=b=>createHash('sha256').update(b).digest('hex');
const hashFile=async p=>{const h=createHash('sha256');for await(const b of createReadStream(p))h.update(b);return h.digest('hex');};
const receipt={phase:96,startedAt:'2026-10-02T02:53:27.000Z',developmentFreeze:'2026-10-02T03:18:27.000Z',hardStop:'2026-10-02T03:23:27.000Z',originalRequirements:'U01-U47/full goal retained',reviewedRunIds:[],newTerminalRunsReviewed:0,manualCollection:false,newSchedules:false,backendCandidatePromoted:false};
receipt.site={version:40,projectId:'appgprj_6abdb56f89fc81919cdcf47e8b7c578e',versionId:'appgprj_6abdb56f89fc81919cdcf47e8b7c578e~appgver_a6abca337a5c8191835dbbdee00e411d',deploymentId:'appgdep_6abf21eb39b08191b6f69b745adffe10',deploymentStatus:'succeeded',publishedAt:'2026-10-02T03:16:04.689144+00:00',url:'https://mcn-matrix-observatory.slowlygold4.chatgpt.site',commit:'f6261b6b91a66af1011a84b1900f41243b5dce70',pageSha:sha(await readFile(join(site,'app/page.tsx'))),cssSha:sha(await readFile(join(site,'app/replica.css')))};
assert.equal(receipt.site.pageSha,'0572e7e04a7041fe4bb3cdd9799aafbef27a3547563edecad00fe75d11a0c178');
assert.equal(receipt.site.cssSha,'8f2fe645bc8ba323eaffaea6e65717f145bdabc2694d89d79dd6e4d3dbcd8b0c');
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:site,encoding:'utf8'}).trim(),receipt.site.commit);
assert.equal(execFileSync('git',['status','--short'],{cwd:site,encoding:'utf8'}).trim(),'');
const preimages=JSON.parse(await readFile(join(root,'docs/phase95-profile-first-manifest.json')));
for(const e of preimages)assert.equal(sha(await readFile(join(root,e.file))),e.main);
receipt.backendOriginalPreimagesMatched=preimages.length;
const sourceBytes=await readFile(join(root,'data/source-poll/manifest.json')),source=JSON.parse(sourceBytes);
receipt.source={sha256:sha(sourceBytes),lastFinishedAt:source.lastFinishedAt,jobId:source.jobId??null};
receipt.source.newSincePrevious=receipt.source.sha256!=='184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5';
const backup=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase93-backup.json')));
assert.equal(await hashFile(backup.backupPath??backup.databasePath??backup.path),backup.sha256);
assert.equal(await hashFile(backup.restoredPath),backup.sha256);
const restored=new DatabaseSync(backup.restoredPath,{readOnly:true});
try{restored.exec('PRAGMA query_only=ON; BEGIN');assert.equal(restored.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.equal(restored.prepare('PRAGMA foreign_key_check').all().length,0);for(const [table,count] of Object.entries(backup.validation.counts)){assert.match(table,/^[a-z_]+$/);assert.equal(restored.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count,count);}assert.equal(restored.prepare('SELECT total_changes() count').get().count,0);restored.exec('ROLLBACK');}finally{restored.close();}
receipt.backup={sha256:backup.sha256,restoredReadable:true,tablesMatched:Object.keys(backup.validation.counts).length,cutoff:backup.cutoff,includesRun2578:false,totalChanges:0};
const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});
try{db.exec('PRAGMA query_only=ON; BEGIN');receipt.run=db.prepare('SELECT id,trigger_type,status,started_at,finished_at,processed_count,target_count FROM runs ORDER BY id DESC LIMIT 1').get();receipt.lastTerminalRun=db.prepare("SELECT MAX(id) id FROM runs WHERE status!='running'").get().id;assert.equal(db.prepare('SELECT total_changes() count').get().count,0);db.exec('ROLLBACK');}finally{db.close();}
const get=async p=>{const r=await fetch('http://127.0.0.1:4188'+p,{signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);return r.json();};
const [monitor,queue,health]=await Promise.all([get('/api/monitoring-status'),get('/api/ingestion-reviews'),get('/api/health')]);
receipt.coverage={checkedAt:monitor.checkedAt,coreDaily:monitor.updateSla?.coreAccounts?.daily,core8h:monitor.updateSla?.coreAccounts?.fresh8h,worksDaily:monitor.updateSla?.works?.daily,works8h:monitor.updateSla?.works?.fresh8h,topicsDaily:monitor.updateSla?.topics?.daily,topics8h:monitor.updateSla?.topics?.fresh8h};
receipt.queue={pending:queue.totalPending??queue.summary?.totalPending??null,completed:queue.totalCompleted??queue.summary?.totalCompleted??null,generator:queue.queue?{status:queue.queue.status,scanned:queue.queue.scannedCount,pending:queue.queue.pendingCount,failed:queue.queue.failedCount,checkedAt:queue.queue.checkedAt}:null};
receipt.health={status:health.status,runtimeAI:health.runtimeAI,http200:true};
receipt.pids=execFileSync('ps',['-p','22870,26001,92296','-o','pid=,ppid=,etime=,stat='],{encoding:'utf8'}).trim();
const dir=join(root,'data/code-candidates/phase96');await mkdir(dir,{recursive:true});
for(const [from,to] of [['/tmp/phase96-site-preimage-ff44R6/page.tsx',join(dir,'preimage-page.tsx')],['/tmp/phase96-site-preimage-ff44R6/replica.css',join(dir,'preimage-replica.css')],['/tmp/phase96-site-release.tar.gz',join(dir,'site-v40-release.tar.gz')]]){await copyFile(from,to,constants.COPYFILE_EXCL);}
receipt.savedCodeArtifacts=await Promise.all(['preimage-page.tsx','preimage-replica.css','site-v40-release.tar.gz'].map(async f=>({file:'data/code-candidates/phase96/'+f,sha256:await hashFile(join(dir,f)),bytes:(await stat(join(dir,f))).size})));
const logs=[['/tmp/phase96-main-full-release.log','main-full-release.log',4049],['/tmp/phase96-site-full-final.log','site-full-final.log',47],['data/maintenance-journal/2026-10-02-phase96-history-return-final-frozen-green83.log','history-green83.log',83]];
receipt.tests=[];for(const [src,name,expected] of logs){const path=src.startsWith('/')?src:join(root,src),bytes=await readFile(path),text=bytes.toString();assert.match(text,new RegExp('(?:ℹ|#)\\s*pass\\s+'+expected+'(?:\\s|$)'));assert.match(text,/(?:ℹ|#)\s*fail\s+0(?:\s|$)/);const dest=join(root,'data/maintenance-journal/2026-10-02-phase96-'+name);await copyFile(path,dest,constants.COPYFILE_EXCL);receipt.tests.push({file:dest,sha256:sha(bytes),pass:expected,fail:0,tail:text.split('\n').slice(-10).join('\n')});}
receipt.actualBrowser={nativeChrome:true,desktopPixels:[1200,1366],phoneCss:[390,844],sealedPublicGeneration:'2026-10-02T01:45:02.024Z',page3Return:true,focusReturn:true,closeReopenDailyPage1:true,phoneBackVisible:true,inlineScreenshots:'CUA session captures, no invented durable screenshot path',productionRouteOpened:true};
receipt.failuresPreserved=['Initial Main full launched before new exact fixture existed; red retained','Old phase61 fake HTMLElement missing querySelector; old expected reset-to-page1 conflicts with approved retained-page2 contract; exactly two reviewed test changes','Local preview HMR fallback warning only, not production data failure','Source credential expired and build helper given unsupported argument; both retried safely before source save'];
receipt.limits=['This UI fix is not complete works collection or a guarantee for every network','Phase95 backend candidate not promoted while run2578 is running','Mac-off new collection and binding proof remain missing','Independent hook tests are not real users or retention trials','No original ingestion event or source record modified'];
receipt.finishedAt=new Date().toISOString();receipt.elapsedMinutes=(Date.parse(receipt.finishedAt)-Date.parse(receipt.startedAt))/60000;
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase96-closeout.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({finishedAt:receipt.finishedAt,elapsedMinutes:receipt.elapsedMinutes,run:receipt.run,sourceChanged:receipt.source.newSincePrevious,backup:receipt.backup,site:receipt.site,tests:receipt.tests.map(t=>({pass:t.pass,fail:t.fail})),health:receipt.health}));
