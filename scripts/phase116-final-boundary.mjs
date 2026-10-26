import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),site=join(root,'../mcn-public-site');
const sha=b=>createHash('sha256').update(b).digest('hex'),json=async f=>JSON.parse(await readFile(join(root,f)));
const deadline=Date.parse('2026-10-02T11:36:55Z');assert.ok(Date.now()<deadline);
const base=await json('data/maintenance-journal/2026-10-02-phase116-code-baseline.json');
for(const row of base.entries)assert.equal(sha(await readFile(join(root,row.file))),row.sha256,row.file);
const checks=await json('data/maintenance-journal/2026-10-02-phase116-site-checks.json');
for(const row of base.siteRows)assert.equal(sha(await readFile(join(site,row.file))),checks.approved[row.file]||row.sha256,row.file);
for(const [file,hash]of Object.entries(checks.approved))assert.equal(sha(await readFile(join(site,file))),hash,file);
const tests=await json('data/maintenance-journal/2026-10-02-phase116-main-tests-result.json');
assert.equal(tests.tests,4307);assert.equal(tests.pass,4307);assert.equal(tests.outcome.code,0);assert.equal(tests.outcome.signal,null);
for(const k of ['fail','cancelled','skipped'])assert.equal(tests[k],0);assert.equal(sha(await readFile(tests.logPath)),tests.sha256);
for(const command of checks.commands){assert.equal(command.outcome.code,0);assert.equal(command.outcome.signal,null);assert.equal(sha(await readFile(command.logPath)),command.sha256);}
assert.equal(checks.commands[0].pass,62);assert.equal(checks.commands[0].fail,0);
const published=await json('data/maintenance-journal/2026-10-02-phase116-site-published.json');
assert.equal(published.saved.version_number,44);assert.equal(published.deployment.status,'succeeded');
assert.equal(published.saved.source.commit_sha,'d2a9e6257bfc1c16026ef4c1677bd023f703ea72');
assert.equal(execFileSync('git',['status','--short'],{cwd:site,encoding:'utf8'}).trim(),'');
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:site,encoding:'utf8'}).trim(),published.saved.source.commit_sha);
const built=await json('data/maintenance-journal/2026-10-02-phase116-site-built.json');
assert.equal(built.assets.length,28);for(const row of built.assets){for(const folder of ['dist/client','build/retained-client-assets'])assert.equal(sha(await readFile(join(site,folder,row.path))),row.sha256,row.path);}
const archive=await json('data/maintenance-journal/2026-10-02-phase116-evidence-archive.json');
for(const row of archive.archived)assert.equal(sha(await readFile(row.file)),row.sha256,row.file);
assert.equal(archive.archived.length,65);
const signed=await json('docs/phase116-evidence/integrity/signed-receipt.json');
assert.deepEqual(signed.fixedRunIds,Array.from({length:20},(_,i)=>2847+i));
for(const row of signed.originals)assert.equal(sha(await readFile(row.path)),row.sha256);
const previous=await json('data/maintenance-journal/2026-10-02-phase115-reviewed-bindings.json');
for(const row of previous.completions){assert.equal(sha(await readFile(row.file)),row.sha256);assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${row.runId}.json`))),row.originalSHA256);}
for(const row of previous.evidence)assert.equal(sha(await readFile(row.file)),row.sha256);
const sourceManifestSHA256=sha(await readFile(join(root,'data/source-poll/manifest.json')));
assert.equal(sourceManifestSHA256,'184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5');
const http=[];for(const file of ['rebuild.js','rebuild.css','rebuild.html','console-model.js']){
 const r=await fetch('http://127.0.0.1:4188/'+file,{signal:AbortSignal.timeout(8000)});assert.equal(r.status,200);
 const hash=sha(Buffer.from(await r.arrayBuffer()));assert.equal(hash,sha(await readFile(join(root,'public',file))));http.push({file,status:200,sha256:hash});}
const get=async p=>{const r=await fetch('http://127.0.0.1:4188'+p,{signal:AbortSignal.timeout(8000)});assert.equal(r.status,200);return r.json();};
const health=await get('/api/health'),monitoring=await get('/api/monitoring-status'),queue=await get('/api/ingestion-reviews'),settings=await get('/api/settings');
assert.equal(health.status,'ready');assert.equal(health.runtimeAI,false);assert.equal(monitoring.scheduler.scheduleIntervalHours,8);assert.deepEqual(monitoring.scheduler.slotTimes,['02:00','10:00','18:00']);
assert.deepEqual(settings,{publicPostsPerAccount:'30',publicWorksPageMode:'whole-page-v2',publicWorksPageHardLimit:'100',publicWorksRequestThreshold:'30'});
const servicePIDs=execFileSync('/bin/ps',['-p','90988,26001,79274','-o','pid=,ppid='],{encoding:'utf8'});
for(const p of [90988,26001,79274])assert.match(servicePIDs,new RegExp(`(?:^|\n)\\s*${p}\\s+1\\s*`));
const native=[];for(const file of await readdir(join(root,'docs/phase116-evidence/ui'))){const path=join(root,'docs/phase116-evidence/ui',file),b=await readFile(path);if(file.endsWith('.jpg')){assert.equal(b[0],255);assert.equal(b[1],216);assert.equal(b.at(-2),255);assert.equal(b.at(-1),217);}native.push({file:path,bytes:b.length,sha256:sha(b)});}
assert.equal(native.length,7);const ax=await readFile(join(root,'docs/phase116-evidence/ui/native-return-ax.txt'),'utf8');assert.match(ax,/2026-09-13/);assert.match(ax,/focused|焦点/);
const old=await readFile(join(root,'docs/phase116-evidence/ui/native-old-asset-ax.txt'),'utf8');assert.match(old,/growth-chart-BqbGTSgl/);assert.match(old,/rolldown-runtime-C60lm6uB/);
const nativeProof={checkedAt:new Date().toISOString(),native,meaning:'Actual Google Chrome public fresh load, 200% selected date/account detail/return focus, old asset forced reload; not all-network HTTP/SHA proof. Own validation tabs closed; original tabs retained.'};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase116-native-proof.json'),JSON.stringify(nativeProof,null,2)+'\n',{flag:'wx',mode:0o400});
const publicProbe=await json('data/maintenance-journal/2026-10-02-phase116-public-proof.json');assert.equal(publicProbe.archiveMembersVerified,86);assert.ok(publicProbe.rows.every(r=>r.status===403));
const result={checkedAt:new Date().toISOString(),mainOldChecked:base.entries.length,mainProductChanges:[],siteOldChecked:base.siteRows.length,siteOldUnchanged:168,approved:checks.approved,tests,siteChecks:checks.commands,http,health,monitoring,queue,settings,servicePIDs,sourceManifestSHA256,archivedEvidenceChecked:65,nativeFiles:native.length,sitePublicVersion:44,sourceCommit:published.saved.source.commit_sha,publicProbePassed:false,publicProbeFailure:'Anonymous Node resource reads returned403; preserved, not bypassed. Normal native browser actual first load and old resource rendered.',backupVerification:'Two existing 850284544B copies SHA/14 tables/quick/integrity/FK checks and four old full-row conservation checks are sealed in independent current-state.json; no new DB copy.',manualCollection:false,restart:false,newTimers:false,goalComplete:false};
assert.ok(Date.now()<deadline);await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase116-boundary-finish.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify({checkedAt:result.checkedAt,mainFiles:base.entries.length,siteUnchanged:168,tests:4307,siteTests:62,health:health.status,nativeFiles:7,version:44,publicProbePassed:false}));
