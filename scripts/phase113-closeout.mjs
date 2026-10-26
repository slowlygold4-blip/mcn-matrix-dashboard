import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const startedAt='2026-10-02T09:44:32Z',hardStop='2026-10-02T10:14:32Z';
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse(hardStop));
const bindingsPath=join(root,'data/maintenance-journal/2026-10-02-phase113-reviewed-bindings.json');
const bindings=JSON.parse(await readFile(bindingsPath));
assert.deepEqual(bindings.fixedRunIds,Array.from({length:20},(_,i)=>2807+i));
assert.equal(bindings.completions.length,20);
for(const ref of bindings.evidence)assert.equal(sha(await readFile(ref.file)),ref.sha256);
for(const completion of bindings.completions){
  assert.equal(sha(await readFile(completion.file)),completion.sha256);
  assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${completion.runId}.json`))),completion.originalSHA256);
}
const tests=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase113-main-tests-result.json')));
assert.equal(tests.pass,4307);assert.equal(tests.fail,0);
for(const [file,hash] of Object.entries(tests.approvedSources))assert.equal(sha(await readFile(join(root,file))),hash);
const response=await fetch('http://127.0.0.1:4188/api/health',{signal:AbortSignal.timeout(8000)});
assert.equal(response.status,200);const health=await response.json();
assert.equal(health.status,'ready');assert.equal(health.runtimeAI,false);
const sourceManifestSHA256=sha(await readFile(join(root,'data/source-poll/manifest.json')));
assert.equal(sourceManifestSHA256,'184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5');
const site=join(root,'../mcn-public-site');
const siteHead=execFileSync('git',['rev-parse','HEAD'],{cwd:site,encoding:'utf8'}).trim();
assert.equal(siteHead,'4608e7dbf8595c5729a38f5690da4c9c1de13b32');
assert.equal(execFileSync('git',['status','--short'],{cwd:site,encoding:'utf8'}).trim(),'');
const finishedAt=new Date().toISOString();assert.ok(Date.parse(finishedAt)<Date.parse(hardStop));
const result={startedAt,finishedAt,elapsedSeconds:(Date.parse(finishedAt)-Date.parse(startedAt))/1000,hardStop,
  goalStatus:'active',fullTargetComplete:false,mainTests:{pass:tests.pass,fail:tests.fail,cancelled:tests.cancelled,skipped:tests.skipped},
  independentActualHTMLGates:48,nativeEvidenceImages:6,reviewedRunIds:bindings.fixedRunIds,
  reviewedBindingsSHA256:sha(await readFile(bindingsPath)),originalEventsUnchanged:true,evidenceBindings:bindings.evidence.length,
  health:{status:health.status,runtimeAI:health.runtimeAI},sourceManifestSHA256,siteHead,siteDeployment:false,
  mainBrowserOpenResult:'queued',manualCollection:false,newTimers:false,backgroundDevelopment:false,
  unresolved:['Mac-off ordinary new sampling not established','Full works coverage not achieved','Public UI parity not deployed in Phase113','Narrow SVG axis font and interval endpoint marker wording followups'],
  nextFixedRunId:2827};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase113-stop.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify(result));
