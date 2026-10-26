import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse('2026-10-02T09:36:08Z'));
const approved=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase111-approved-files.json'))),baseline=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase111-code-baseline.json')));
const byFile=Object.fromEntries(approved.rows.map(row=>[row.file,row.afterSHA256]));
const changes=[];for(const row of baseline.entries){const hash=sha(await readFile(join(root,row.file)));assert.equal(hash,byFile[row.file]||row.sha256,row.file);if(hash!==row.sha256)changes.push(row.file);}
assert.equal(changes.length,5);
const adaptations=[];
for(const file of ['test/phase105-reading-browser.test.mjs','test/phase107-account-metric-browser.test.mjs','test/rebuild-refresh-focus.test.mjs']){
 const old=await readFile(join(root,'data/code-candidates/phase111/preimage',file),'utf8'),next=await readFile(join(root,file),'utf8');
 const inverse=file.includes('refresh-focus')?next.replace("window: { matchMedia: query => ({ matches: query.includes('prefers-reduced-motion') }), addEventListener() {} }","window: { matchMedia: () => ({ matches: true }), addEventListener() {} }"):next.replace(String.raw`if(typeof ledgerMode!==\'undefined\')ledgerMode=\'full\';`,'');
 assert.equal(inverse,old,file+' exact reversible fixture adapter');adaptations.push({file,allOriginalBytesExceptFixturePreserved:true});
}
const result=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase111-main-tests-result.json')));assert.equal(result.tests,4299);assert.equal(result.pass,4299);assert.equal(result.fail,0);assert.equal(result.cancelled,0);assert.equal(result.skipped,0);assert.equal(sha(await readFile(result.logPath)),result.sha256);
const sourceManifestSHA256=sha(await readFile(join(root,'data/source-poll/manifest.json')));assert.equal(sourceManifestSHA256,'184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5');
const http=[];for(const file of ['public/rebuild.js','public/rebuild.css','public/rebuild.html','public/console-model.js']){const response=await fetch('http://127.0.0.1:4188/'+file.slice(7),{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);const hash=sha(Buffer.from(await response.arrayBuffer()));assert.equal(hash,sha(await readFile(join(root,file))));http.push({file,status:200,sha256:hash});}
const get=async path=>{const response=await fetch('http://127.0.0.1:4188'+path,{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);return response.json();};
const health=await get('/api/health'),monitoring=await get('/api/monitoring-status'),queue=await get('/api/ingestion-reviews');assert.equal(health.status,'ready');assert.equal(health.runtimeAI,false);assert.equal(monitoring.scheduler.scheduleIntervalHours,8);assert.deepEqual(monitoring.scheduler.slotTimes,['02:00','10:00','18:00']);
const servicePIDs=execFileSync('/bin/ps',['-p','90988,26001,79274','-o','pid=,ppid='],{encoding:'utf8'});for(const pid of [90988,26001,79274])assert.match(servicePIDs,new RegExp(`(?:^|\\n)\\s*${pid}\\s+1\\s*`));
const site=join(root,'../mcn-public-site'),siteHead=execFileSync('git',['rev-parse','HEAD'],{cwd:site,encoding:'utf8'}).trim();assert.equal(siteHead,baseline.siteHead);assert.equal(execFileSync('git',['status','--short'],{cwd:site,encoding:'utf8'}).trim(),'');
const archive=join(root,'docs/phase111-evidence/runtime');await mkdir(archive,{recursive:true});const archived=[];
for(const entry of await readdir('/tmp/phase111-runtime-dmfhYK',{withFileTypes:true})){assert.ok(entry.isFile(),entry.name);const bytes=await readFile(join('/tmp/phase111-runtime-dmfhYK',entry.name));await writeFile(join(archive,entry.name),bytes,{flag:'wx',mode:0o400});assert.equal(sha(await readFile(join(archive,entry.name))),sha(bytes));archived.push({file:join(archive,entry.name),sha256:sha(bytes),bytes:bytes.length});}
for(const [sourcePath,name,expected]of [['/tmp/phase111-runtime-dmfhYK-evidence.tar.gz','runtime-evidence.tar.gz','b520da4784f6605313bfedf3feb7d865a370eaf4a2eeb1bc5f7a95a64af2d956'],['/tmp/phase111-reading-D61sD2/phase111-candidate.tar.gz','candidate-evidence.tar.gz','5d63fa20119661d118702a729a057a945ce90b4ad9fd31c4dfac947d37ec5e68']]){const bytes=await readFile(sourcePath);assert.equal(sha(bytes),expected);await writeFile(join(root,'docs/phase111-evidence',name),bytes,{flag:'wx',mode:0o400});assert.equal(sha(await readFile(join(root,'docs/phase111-evidence',name))),expected);}
for(const name of ['review.md','completion.json']){const bytes=await readFile(join('/tmp/phase111-reading-D61sD2',name));await writeFile(join(root,'docs/phase111-evidence/candidate',name),bytes,{flag:'wx',mode:0o400});}
const signed=JSON.parse(await readFile(join(root,'docs/phase111-evidence/integrity/signed-receipt.json')));for(const original of signed.originals)assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${original.runId}.json`))),original.sha256);
const screenshots=[];for(const name of await readdir(join(root,'docs/phase111-evidence/ui'))){const file=join(root,'docs/phase111-evidence/ui',name),bytes=await readFile(file);assert.equal(bytes[0],255);assert.equal(bytes[1],216);await chmod(file,0o400);screenshots.push({file,sha256:sha(bytes),mime:'image/jpeg'});}
const final={checkedAt:new Date().toISOString(),oldFilesChecked:baseline.entries.length,unchangedOldFiles:baseline.entries.length-changes.length,changes,adaptations,http,health,monitoring,queue,servicePIDs,siteHead,siteDeployment:false,sourceManifestSHA256,archived,screenshots,manualCollection:false,mainDatabaseWrites:false,originalEventsEdited:false};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase111-boundary-finish.json'),JSON.stringify(final,null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({checkedAt:final.checkedAt,oldFilesChecked:final.oldFilesChecked,unchangedOldFiles:final.unchangedOldFiles,changes,httpFiles:http.length,health:health.status,runtimeAI:health.runtimeAI,siteHead,sourceManifestSHA256,screenshots:screenshots.length,archived:archived.length,monitoringKeys:Object.keys(monitoring),queue}));
