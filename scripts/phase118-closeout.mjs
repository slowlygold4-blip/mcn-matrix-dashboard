import assert from 'node:assert/strict';
import {readFile,writeFile,copyFile,mkdir,chmod,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),deadline=Date.parse('2026-10-02T12:32:21Z');
const prefix='data/maintenance-journal/2026-10-02-phase118-';
const hash=b=>createHash('sha256').update(b).digest('hex');
const json=async f=>JSON.parse(await readFile(join(root,f),'utf8'));
function time(){assert.ok(Date.now()<deadline,'Phase118 hard stop');}
async function save(name,data){time();await writeFile(join(root,prefix+name+'.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o400});}
async function get(path){const r=await fetch('http://127.0.0.1:4188'+path,{signal:AbortSignal.timeout(8000)});assert.equal(r.status,200);return r.json();}
async function archiveEntry(group,from,row){const file=row.file??row.path;assert.ok(file&&!file.startsWith('/')&&!file.split('/').includes('..'));const src=join(from,file),bytes=await readFile(src);assert.equal(hash(bytes),row.sha256,file);if(row.bytes!==undefined)assert.equal(bytes.length,row.bytes);const dst=join(root,'docs/phase118-evidence',group,file);await mkdir(dirname(dst),{recursive:true});try{await copyFile(src,dst,constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST')throw e;assert.equal(hash(await readFile(dst)),row.sha256,'Existing evidence must match without overwrite');}await chmod(dst,0o400);assert.equal(hash(await readFile(dst)),row.sha256);return{file:dst,sha256:row.sha256,bytes:bytes.length};}
const mode=process.argv[2];time();
if(mode==='archive'){
 const groups=[{group:'integrity',from:'/tmp/phase118-integrity-gygA1q',seal:'signed-receipt.json',sha:'013514d4aa18f9c02cd8fd187814af417fee4d06ee1d6d70c8b71500b965640d'},{group:'ux',from:'/tmp/phase118-ux-OStCrI',seal:'evidence-seal.json',sha:'36c5fb1abe26a269d0198a4d3e43b57befc8f7130d36e3729ae8f786f67b31bf'}];
 const files=[];
 async function archive(group,from,row){files.push(await archiveEntry(group,from,row));}
 for(const g of groups){const b=await readFile(join(g.from,g.seal));assert.equal(hash(b),g.sha);const seal=JSON.parse(b);for(const row of [...seal.files,{file:g.seal,bytes:b.length,sha256:g.sha}])await archive(g.group,g.from,row);}
 for(const [file,sha256]of Object.entries({'review.md':'e48783aa02d5a01180ff5eda6844cd7681619c143ae021f08784310b87aa3110','approval.json':'c9b041ebfdfb60d1f51c8b43802419d99630e024d4417bc76b8f4caee6063b9a','shutdown-test.log':'bf78b5adec2c2ba9ee7463e2c3a2a6681f8c8974da4c6af2a15d05edc63b7776','source-hashes.json':'220e33a4ed4ad6ec8c5de75e71d7a539be26fce10f65fd1c3b3bd43a86e66c72'}))await archive('runtime','/tmp/phase118-runtime-guard-8G96RR',{file,sha256});
 await save('evidence-archive',{at:new Date().toISOString(),files});console.log(JSON.stringify({archived:files.length}));
}else if(mode==='extra'){
 const g=JSON.parse(process.argv[3]);assert.match(g.group,/^[a-z0-9-]+$/);assert.ok(g.from.startsWith('/tmp/phase118-'));const b=await readFile(join(g.from,g.seal));assert.equal(hash(b),g.sha);const seal=JSON.parse(b),files=[];
 for(const row of [...seal.files,{file:g.seal,bytes:b.length,sha256:g.sha}])files.push(await archiveEntry(g.group,g.from,row));await save(g.group+'-archive',{at:new Date().toISOString(),files});console.log(JSON.stringify({group:g.group,archived:files.length}));
}else if(mode==='boundary'){
 const loaded=await json(prefix+'runtime-loaded.json'),tests=await json(prefix+'tests.json'),archive=await json(prefix+'evidence-archive.json');
 assert.equal(loaded.runtimeReaderLoadedByNormalNodeStartup,true);assert.equal(tests.tests,35);assert.equal(tests.pass,35);assert.equal(hash(await readFile(tests.file)),tests.sha256);
 for(const row of archive.files)assert.equal(hash(await readFile(row.file)),row.sha256,row.file);
 const base=await json('data/maintenance-journal/2026-10-02-phase117-code-baseline.json'),approved=await json('data/maintenance-journal/2026-10-02-phase117-approved.json');
 for(const row of base.entries)assert.equal(hash(await readFile(join(root,row.file))),approved.product[row.file]||approved.auxiliary[row.file]||row.sha256,row.file);
 const site=join(root,'../mcn-public-site');for(const row of base.siteRows)assert.equal(hash(await readFile(join(site,row.file))),row.sha256,row.file);
 assert.equal(execFileSync('git',['status','--short'],{cwd:site,encoding:'utf8'}).trim(),'');assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:site,encoding:'utf8'}).trim(),base.siteHead);
 const sourceSha=hash(await readFile(join(root,'data/source-poll/manifest.json')));assert.equal(sourceSha,base.sourceSHA256);
 const health=await get('/api/health'),monitoring=await get('/api/monitoring-status'),queue=await get('/api/ingestion-reviews'),settings=await get('/api/settings');assert.equal(health.status,'ready');assert.equal(health.runtimeAI,false);assert.deepEqual(settings,base.settings);assert.equal(monitoring.scheduler.scheduleIntervalHours,8);assert.deepEqual(monitoring.scheduler.slotTimes,['02:00','10:00','18:00']);
 const pids=execFileSync('/bin/ps',['-p',String(loaded.newPid)+',26001,79274','-o','pid=,ppid='],{encoding:'utf8'});for(const p of [loaded.newPid,26001,79274])assert.match(pids,new RegExp('(?:^|\n)\\s*'+p+'\\s+1\\s*'));
 const signed=await json('docs/phase118-evidence/integrity/signed-receipt.json');assert.deepEqual(signed.fixedRunIds,Array.from({length:20},(_,i)=>2887+i));for(const row of signed.originals)assert.equal(hash(await readFile(row.path)),row.sha256);
 const http=[];for(const file of ['rebuild.js','rebuild.css','rebuild.html','console-model.js']){const r=await fetch('http://127.0.0.1:4188/'+file,{signal:AbortSignal.timeout(8000)});assert.equal(r.status,200);const sha=hash(Buffer.from(await r.arrayBuffer()));assert.equal(sha,hash(await readFile(join(root,'public',file))));http.push({file,status:200,sha256:sha});}
 await save('boundary',{at:new Date().toISOString(),health,monitoring,queue,settings,sourceSha,tests,loadedPid:loaded.newPid,pids,http,oldFiles:base.entries.length,siteFiles:base.siteRows.length,originalEventsUnchanged:true,archiveCount:archive.files.length,goalComplete:false,newFrontendFix:false});console.log(JSON.stringify({ready:true,newPid:loaded.newPid,originals:20,siteUnchanged:true,tests:35}));
}else if(mode==='review'){
 const b=await json(prefix+'boundary.json');assert.equal(b.originalEventsUnchanged,true);assert.equal(b.health.status,'ready');
 const evidence=['docs/phase118-product-review.md',prefix+'run.md',prefix+'boundary.json',prefix+'runtime-loaded.json',prefix+'preserved-backup.json',prefix+'tests.json',prefix+'resume-tests.log',prefix+'evidence-archive.json',prefix+'site-safe.json','docs/phase118-evidence/integrity/review.md','docs/phase118-evidence/integrity/data-audit-final.json','docs/phase118-evidence/integrity/scheduled-audit-v3.json','docs/phase118-evidence/integrity/signed-receipt.json','docs/phase118-evidence/runtime/review.md','docs/phase118-evidence/ux/review.md',...JSON.parse(process.argv[3]||'[]')].map(f=>join(root,f));assert.ok(evidence.length<=20);
 const refs=[];for(const file of evidence){assert.ok((await stat(file)).size>0);await chmod(file,0o400);refs.push({file,sha256:hash(await readFile(file))});}
 const {completePostIngestionProductReview}=await import('../lib/post-ingestion-review.mjs');const signed=await json('docs/phase118-evidence/integrity/signed-receipt.json'),completions=[];
 for(const row of signed.originals){time();assert.equal(hash(await readFile(row.path)),row.sha256);const r=await completePostIngestionProductReview({ledgerDir:join(root,'data/ingestion-reviews'),runId:row.runId,evidence,now:new Date()});assert.equal(r.status,'created');assert.deepEqual(r.completion.evidence,evidence);assert.equal(hash(await readFile(row.path)),row.sha256);completions.push({runId:row.runId,file:r.path,sha256:hash(await readFile(r.path)),originalSHA256:row.sha256});}
 for(const ref of refs)assert.equal(hash(await readFile(ref.file)),ref.sha256);await save('reviewed-bindings',{at:new Date().toISOString(),fixedRunIds:signed.fixedRunIds,completions,evidence:refs,originalsUnchanged:true,nextFixedRunId:2907,goalComplete:false});console.log(JSON.stringify({reviewed:20,next:2907}));
}else if(mode==='stop'){
 const bindings=await json(prefix+'reviewed-bindings.json');assert.equal(bindings.completions.length,20);assert.equal(bindings.evidence.length,17);
 for(const row of bindings.completions){assert.equal(hash(await readFile(row.file)),row.sha256);assert.equal(hash(await readFile(join(root,'data/ingestion-reviews/run-'+row.runId+'.json'))),row.originalSHA256);}
 for(const row of bindings.evidence)assert.equal(hash(await readFile(row.file)),row.sha256);
 let archived=0;for(const name of ['evidence-archive','natural-archive','completion-archive']){const a=await json(prefix+name+'.json');for(const row of a.files)assert.equal(hash(await readFile(row.file)),row.sha256);archived+=a.files.length;}
 const loaded=await json(prefix+'runtime-loaded.json'),base=await json('data/maintenance-journal/2026-10-02-phase117-code-baseline.json'),approved=await json('data/maintenance-journal/2026-10-02-phase117-approved.json');
 for(const row of base.entries)assert.equal(hash(await readFile(join(root,row.file))),approved.product[row.file]||approved.auxiliary[row.file]||row.sha256,row.file);
 const site=join(root,'../mcn-public-site');for(const row of base.siteRows)assert.equal(hash(await readFile(join(site,row.file))),row.sha256,row.file);assert.equal(execFileSync('git',['status','--short'],{cwd:site,encoding:'utf8'}).trim(),'');assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:site,encoding:'utf8'}).trim(),base.siteHead);
 const sourceSha=hash(await readFile(join(root,'data/source-poll/manifest.json')));assert.equal(sourceSha,base.sourceSHA256);const health=await get('/api/health'),monitoring=await get('/api/monitoring-status'),queue=await get('/api/ingestion-reviews');assert.equal(health.status,'ready');assert.equal(health.runtimeAI,false);assert.deepEqual(monitoring.scheduler.slotTimes,['02:00','10:00','18:00']);assert.equal(monitoring.scheduler.scheduleIntervalHours,8);
 const pids=execFileSync('/bin/ps',['-p',String(loaded.newPid)+',26001,79274','-o','pid=,ppid='],{encoding:'utf8'});for(const p of [loaded.newPid,26001,79274])assert.match(pids,new RegExp('(?:^|\n)\\s*'+p+'\\s+1\\s*'));
 const runners=execFileSync('/bin/ps',['-ax','-o','pid=,command='],{encoding:'utf8'}).split('\n').filter(s=>s.includes('phase118-')&&(/node/.test(s))&&!s.includes('phase118-closeout.mjs stop'));assert.deepEqual(runners,[],'No bounded Phase118 developer/test runner may remain');
 const stoppedAt=new Date().toISOString(),elapsedSeconds=(Date.parse(stoppedAt)-Date.parse('2026-10-02T12:02:21Z'))/1000;assert.ok(elapsedSeconds<1800);
 const code={};for(const file of ['scripts/phase118-guarded-load.mjs','scripts/phase118-closeout.mjs'])code[file]=hash(await readFile(join(root,file)));
 await save('handoff',{startedAt:'2026-10-02T12:02:21Z',stoppedAt,elapsedSeconds,health,monitoring,queue,newPid:loaded.newPid,sourceAndPublisherPids:[26001,79274],sourceSha,oldMainInputs:base.entries.length,siteInputs:base.siteRows.length,siteHead:base.siteHead,archived,completions:20,evidenceRefs:17,independentCompletionVerified:true,originalsUnchanged:true,code,noDeveloperRunners:true,checkpointBenefitObserved:true,continuationSamples:9,newWorksFromThoseSamples:0,continuationValuesCompared:45,worksFullCoverage:false,anonymousAllNetwork:false,macOffNewSampling:false,goalComplete:false,nextFixedRunId:2907,nextProductIssue:'Site pager boundary focus loss; preserve ownership and data contracts'});console.log(JSON.stringify({stoppedAt,elapsedSeconds,archived,reviewed:20,ready:true,newPid:loaded.newPid,noDeveloperRunners:true,goalComplete:false}));
}else throw new Error('unknown mode');
