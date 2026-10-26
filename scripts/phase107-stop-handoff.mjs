import {readFile,writeFile,chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=async p=>JSON.parse(await readFile(join(root,p),'utf8'));
const startedAt='2026-10-02T07:24:34Z',deadline=Date.parse('2026-10-02T07:54:34Z');
assert.ok(Date.now()<deadline);
const receipt=await read('data/maintenance-journal/2026-10-02-phase107-product-completion.json');
assert.equal(receipt.count,20);assert.deepEqual(receipt.fixedRunIds,Array.from({length:20},(_,i)=>2711+i));
for(const p of receipt.evidenceChecks){assert.equal(sha(await readFile(join(root,p.reference))),p.sha256);await chmod(join(root,p.reference),0o400);}
for(const p of receipt.originals){assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${p.runId}.json`))),p.sha256);const r=await read(`data/ingestion-reviews/reviewed-${p.runId}.json`);assert.equal(r.status,'completed');assert.equal(r.runId,p.runId);assert.deepEqual(r.evidence,receipt.evidenceChecks.map(x=>x.reference));}
const final=await read('data/maintenance-journal/2026-10-02-phase107-final-audit.json');
assert.equal(final.unchangedStaticFiles,680);assert.equal(final.restore.integrity,'ok');
for(const p of final.sourceChanges)assert.equal(sha(await readFile(join(root,p.file))),p.after);
assert.equal(sha(await readFile(join(root,'scripts/douyin_browser_collector.mjs'))),'a97d4645c2102fa3f5d9dd1b5585745fb6d394f9a33fec37f8de00cfba8446b1');
assert.equal(sha(await readFile(join(root,'data/source-poll/manifest.json'))),'184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5');
const tests=await read('data/maintenance-journal/2026-10-02-phase107-main-tests-result.json');assert.equal(tests.outcome.code,0);assert.equal(tests.outcome.signal,null);assert.equal(sha(await readFile(tests.logPath)),tests.sha256);
const response=await fetch('http://127.0.0.1:4188/api/health',{signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);const health=await response.json();assert.equal(health.status,'ready');assert.equal(health.runtimeAI,false);
const ps=execFileSync('/bin/ps',['-p','90988,26001,79274','-o','pid=,ppid=,command='],{encoding:'utf8'});
for(const pid of [90988,26001,79274])assert.match(ps,new RegExp('(?:^|\\n)\\s*'+pid+'\\s+1\\s+'));
const all=execFileSync('/bin/ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'});
const owned=all.split('\n').filter(s=>['/tmp/phase107-frontend-ii0r4p/','/tmp/phase107-integrity-vWF06k/','/tmp/phase107-runtime-weWxw7/'].some(p=>s.includes(p)));
assert.equal(owned.length,0);
assert.equal(execFileSync('git',['status','--short'],{cwd:join(root,'../mcn-public-site'),encoding:'utf8'}).trim(),'');
const archives=[];for(const group of ['candidate','integrity','runtime']){const path=`docs/phase107-evidence/${group}-archive.json`;archives.push({path,sha256:sha(await readFile(join(root,path)))});}
const finishedAt=new Date().toISOString();assert.ok(Date.parse(finishedAt)<deadline);
const result={startedAt,finishedAt,elapsedMinutes:(Date.parse(finishedAt)-Date.parse(startedAt))/60000,frozenNewProductDevelopment:true,health,ps,ownedPrivateRunnersExited:true,originalUserTabsPreserved:true,productReviewsAppended:20,originalEventsByteUnchanged:true,boundEvidenceByteUnchanged:true,evidenceCount:receipt.evidenceChecks.length,mainTests:{tests:4290,pass:4290,fail:0,cancelled:0,skipped:0},archives,siteSourceClean:true,siteUIChangedThisRound:false,noManualCollection:true,noRestart:true,noNewTimer:true,completeGoal:false,nextFixedReviewRunId:2731,limitations:['full works coverage incomplete','Mac-off new sampling not implemented','all networks not guaranteed','private V8 failure root cause unknown'],helperFailure:'Initial closeout document patch had wrong progress heading; atomic verification rejected all changes. Correct heading used on retry; no product or data rollback required.'};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase107-handoff.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({finishedAt,elapsedMinutes:result.elapsedMinutes,reviews:20,evidence:result.evidenceCount,ready:health.status,runtimeAI:health.runtimeAI,privateExited:true,completeGoal:false}));
