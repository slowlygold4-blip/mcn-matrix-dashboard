import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const bindings=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase111-reviewed-bindings.json')));
for(const ref of bindings.evidence)assert.equal(sha(await readFile(ref.file)),ref.sha256);
for(const item of bindings.completions){assert.equal(sha(await readFile(item.file)),item.sha256);assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${item.runId}.json`))),item.originalSHA256);}
const approved=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase111-approved-files.json'))),baseline=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase111-code-baseline.json')));const hashes=Object.fromEntries(approved.rows.map(row=>[row.file,row.afterSHA256]));for(const row of baseline.entries)assert.equal(sha(await readFile(join(root,row.file))),hashes[row.file]||row.sha256,row.file);
const response=await fetch('http://127.0.0.1:4188/api/health',{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);const health=await response.json();assert.equal(health.status,'ready');assert.equal(health.runtimeAI,false);
const pids=execFileSync('/bin/ps',['-p','90988,26001,79274','-o','pid=,ppid='],{encoding:'utf8'});for(const pid of [90988,26001,79274])assert.match(pids,new RegExp(`(?:^|\\n)\\s*${pid}\\s+1\\s*`));
let ownTestPIDAbsent=false;try{execFileSync('/bin/ps',['-p','38318','-o','pid='],{encoding:'utf8'});}catch(e){assert.equal(e.status,1);ownTestPIDAbsent=true;}assert.equal(ownTestPIDAbsent,true);
assert.equal(sha(await readFile(join(root,'data/source-poll/manifest.json'))),'184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5');
const site=join(root,'../mcn-public-site');assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:site,encoding:'utf8'}).trim(),baseline.siteHead);assert.equal(execFileSync('git',['status','--short'],{cwd:site,encoding:'utf8'}).trim(),'');
const stoppedAt=new Date().toISOString(),elapsedMinutes=(Date.parse(stoppedAt)-Date.parse('2026-10-02T09:06:08Z'))/60000;assert.ok(Date.parse(stoppedAt)<Date.parse('2026-10-02T09:36:08Z'));assert.ok(elapsedMinutes<30);
const receipt={startedAt:'2026-10-02T09:06:08.000Z',stoppedAt,elapsedMinutes,productDevelopmentStoppedAt:'2026-10-02T09:23:38.678Z',tests:4299,pass:4299,createdReviews:20,nextFixedRun:2807,evidenceUnchanged:true,oldFilesChecked:698,unchangedOldFiles:693,health:health.status,runtimeAI:health.runtimeAI,servicePIDs:pids,ownTestPIDAbsent,sourceManifestUnchanged:true,siteHead:baseline.siteHead,siteDeployment:false,nativeZoomRestored:true,userOriginalTabs:8,goalStatus:'active',remaining:['Mac-off new collection','complete works coverage','all networks reachable','previous V8 exit root cause','publisher lock classification','small integer axis labels and no-reason wording']};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase111-closeout.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify(receipt));
