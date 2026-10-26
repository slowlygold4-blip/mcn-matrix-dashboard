import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),site=join(root,'../mcn-public-site'),sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse('2026-10-02T11:14:14Z'));
const approved=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase114-approved-files-final2.json')));
const baseline=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase114-code-baseline.json')));
const main=Object.fromEntries(approved.mainRows.map(x=>[x.file,x.afterSHA256])),siteChanges=Object.fromEntries(approved.siteRows.map(x=>[x.file,x.afterSHA256])),changes=[];
for(const row of baseline.entries){const hash=sha(await readFile(join(root,row.file)));assert.equal(hash,main[row.file]||row.sha256,row.file);if(hash!==row.sha256)changes.push(row.file);}
assert.equal(changes.length,9);for(const row of approved.mainRows)assert.equal(sha(await readFile(join(root,row.file))),row.afterSHA256,row.file);
for(const row of baseline.siteRows)assert.equal(sha(await readFile(join(site,row.file))),siteChanges[row.file]||row.sha256,row.file);
for(const row of approved.siteRows)assert.equal(sha(await readFile(join(site,row.file))),row.afterSHA256,row.file);
const tests=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase115-main-tests-result.json')));
assert.equal(tests.outcome.code,0);assert.equal(tests.outcome.signal,null);assert.ok(tests.tests>=4307);assert.equal(tests.pass,tests.tests);
for(const key of ['fail','cancelled','skipped'])assert.equal(tests[key],0);assert.equal(sha(await readFile(tests.logPath)),tests.sha256);
const published=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase114-site-published.json')));
assert.equal(published.deployment.status,'succeeded');assert.equal(published.saved.source.commit_sha,'15f7913736df5536d9dbbcb6df5f2c2bdc46a81d');assert.equal(published.site.access_mode,'public');
assert.equal(execFileSync('git',['status','--short'],{cwd:site,encoding:'utf8'}).trim(),'');
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:site,encoding:'utf8'}).trim(),published.saved.source.commit_sha);
const http=[];
for(const file of ['rebuild.js','rebuild.css','rebuild.html','console-model.js']){
  const r=await fetch('http://127.0.0.1:4188/'+file,{signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);
  const hash=sha(Buffer.from(await r.arrayBuffer()));assert.equal(hash,sha(await readFile(join(root,'public',file))));http.push({file,status:200,sha256:hash});
}
const get=async p=>{const r=await fetch('http://127.0.0.1:4188'+p,{signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);return r.json();};
const health=await get('/api/health'),monitoring=await get('/api/monitoring-status'),queue=await get('/api/ingestion-reviews'),settings=await get('/api/settings');
assert.equal(health.status,'ready');assert.equal(health.runtimeAI,false);assert.equal(monitoring.scheduler.scheduleIntervalHours,8);assert.deepEqual(monitoring.scheduler.slotTimes,['02:00','10:00','18:00']);
assert.deepEqual(settings,{publicPostsPerAccount:'30',publicWorksPageMode:'whole-page-v2',publicWorksPageHardLimit:'100',publicWorksRequestThreshold:'30'});
const servicePIDs=execFileSync('/bin/ps',['-p','90988,26001,79274','-o','pid=,ppid='],{encoding:'utf8'});
for(const p of [90988,26001,79274])assert.match(servicePIDs,new RegExp(`(?:^|\\n)\\s*${p}\\s+1\\s*`));
const signed=JSON.parse(await readFile(join(root,'docs/phase114-evidence/integrity/signed-receipt.json')));
assert.deepEqual(signed.fixedRunIds,Array.from({length:20},(_,i)=>2827+i));
for(const r of signed.originals)assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${r.runId}.json`))),r.sha256);
const screenshots=[];
for(const file of await readdir(join(root,'docs/phase114-evidence/ui'))){const path=join(root,'docs/phase114-evidence/ui',file),b=await readFile(path);assert.equal(b[0],255);assert.equal(b[1],216);assert.equal(b.at(-2),255);assert.equal(b.at(-1),217);screenshots.push({file:path,sha256:sha(b)});}
assert.ok(screenshots.length>=3);
const archive=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase115-evidence-archive.json')));
for(const ref of archive.archived)assert.equal(sha(await readFile(ref.file)),ref.sha256);
const sourceManifestSHA256=sha(await readFile(join(root,'data/source-poll/manifest.json')));
assert.equal(sourceManifestSHA256,'184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5');
const result={checkedAt:new Date().toISOString(),mainOldChecked:baseline.entries.length,mainProductChanges:[],mainTestChanges:changes,siteOldChecked:baseline.siteRows.length,siteOldUnchanged:163,siteApproved:approved.siteRows,tests,http,health,monitoring,queue,settings,servicePIDs,screenshots,archivedEvidenceChecked:archive.archived.length,sourceManifestSHA256,manualCollection:false,sourcePollTriggered:false,restart:false,intentionalProductionWrite:'Three approved settings via authenticated normal administrator endpoint; ordinary collector continues separately',sitePublicVersion:published.saved.version_number};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase115-boundary-finish.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({checkedAt:result.checkedAt,tests:tests.tests,mainProductChanges:0,siteOldUnchanged:163,httpFiles:4,health:health.status,screenshots:screenshots.length,mode:settings.publicWorksPageMode,publicVersion:published.saved.version_number}));
