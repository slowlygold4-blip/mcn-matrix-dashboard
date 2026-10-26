import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse('2026-10-02T10:14:32Z'));
const approved=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase113-approved-files.json')));
const baseline=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase113-code-baseline.json')));
const byFile=Object.fromEntries(approved.rows.map(r=>[r.file,r.afterSHA256])),changes=[];
for(const row of baseline.entries){const h=sha(await readFile(join(root,row.file)));assert.equal(h,byFile[row.file]||row.sha256,row.file);if(h!==row.sha256)changes.push(row.file);}
assert.deepEqual(changes.sort(),['public/rebuild.css','public/rebuild.js']);
for(const row of approved.rows)assert.equal(sha(await readFile(join(root,row.file))),row.afterSHA256,row.file);
const tests=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase113-main-tests-result.json')));
assert.equal(tests.pass,tests.tests);assert.ok(tests.tests>=4307);assert.equal(tests.fail,0);assert.equal(tests.cancelled,0);assert.equal(tests.skipped,0);assert.equal(tests.outcome.code,0);
assert.equal(sha(await readFile(tests.logPath)),tests.sha256);
const runtime=JSON.parse(await readFile(join(root,'docs/phase113-evidence/runtime/final/result.json')));
assert.equal(runtime.pass,true);assert.equal(runtime.checks.length,48);assert.equal(runtime.errors.length,0);assert.equal(runtime.connectedAfterClose,false);
for(const file of ['rebuild.js','rebuild.css'])assert.equal(runtime.shas[file],byFile['public/'+file]);
const http=[];for(const file of ['public/rebuild.js','public/rebuild.css','public/rebuild.html','public/console-model.js']){
 const r=await fetch('http://127.0.0.1:4188/'+file.slice(7),{signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);
 const h=sha(Buffer.from(await r.arrayBuffer()));assert.equal(h,sha(await readFile(join(root,file))));http.push({file,status:200,sha256:h});
}
const get=async p=>{const r=await fetch('http://127.0.0.1:4188'+p,{signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);return r.json();};
const health=await get('/api/health'),monitoring=await get('/api/monitoring-status'),queue=await get('/api/ingestion-reviews');
assert.equal(health.status,'ready');assert.equal(health.runtimeAI,false);assert.equal(monitoring.scheduler.scheduleIntervalHours,8);assert.deepEqual(monitoring.scheduler.slotTimes,['02:00','10:00','18:00']);
const servicePIDs=execFileSync('/bin/ps',['-p','90988,26001,79274','-o','pid=,ppid='],{encoding:'utf8'});
for(const p of [90988,26001,79274])assert.match(servicePIDs,new RegExp(`(?:^|\\n)\\s*${p}\\s+1\\s*`));
const site=join(root,'../mcn-public-site'),siteHead=execFileSync('git',['rev-parse','HEAD'],{cwd:site,encoding:'utf8'}).trim();
assert.equal(siteHead,baseline.siteHead);assert.equal(execFileSync('git',['status','--short'],{cwd:site,encoding:'utf8'}).trim(),'');
const signed=JSON.parse(await readFile(join(root,'docs/phase113-evidence/integrity/signed-receipt.json')));
for(const r of signed.originals)assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${r.runId}.json`))),r.sha256);
const screenshots=[];for(const name of await readdir(join(root,'docs/phase113-evidence/ui'))){
 const file=join(root,'docs/phase113-evidence/ui',name),b=await readFile(file);assert.equal(b[0],255);assert.equal(b[1],216);await chmod(file,0o400);screenshots.push({file,sha256:sha(b),mime:'image/jpeg'});
}
assert.ok(screenshots.length>=2);
const result={checkedAt:new Date().toISOString(),oldFilesChecked:baseline.entries.length,unchangedOldFiles:baseline.entries.length-changes.length,changes,
 http,health,monitoring,queue,servicePIDs,siteHead,sourceManifestSHA256:sha(await readFile(join(root,'data/source-poll/manifest.json'))),screenshots,
 manualCollection:false,mainDatabaseWrites:false,siteDeployment:false,originalEventsEdited:false};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase113-boundary-finish.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({checkedAt:result.checkedAt,oldFilesChecked:result.oldFilesChecked,unchangedOldFiles:result.unchangedOldFiles,changes,httpFiles:http.length,health:health.status,runtimeAI:health.runtimeAI,screenshots:screenshots.length,siteHead}));
