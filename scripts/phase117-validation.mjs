import assert from 'node:assert/strict';
import {readdir,readFile,writeFile,mkdir,copyFile,chmod,open,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),site=join(root,'../mcn-public-site');
const prefix='data/maintenance-journal/2026-10-02-phase117-',deadline=Date.parse('2026-10-02T12:05:21Z');
const sha=b=>createHash('sha256').update(b).digest('hex'),json=async f=>JSON.parse(await readFile(join(root,f)));
function time(){assert.ok(Date.now()<deadline,'Phase117 hard deadline');}
async function save(name,value){time();await writeFile(join(root,prefix+name+'.json'),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o400});}
async function get(path){const r=await fetch('http://127.0.0.1:4188'+path,{signal:AbortSignal.timeout(8000)});assert.equal(r.status,200,path);return r.json();}
async function scan(dir,entries){for(const item of await readdir(join(root,dir),{withFileTypes:true})){const file=join(dir,item.name);if(item.isDirectory())await scan(file,entries);else if(item.isFile()&&/\.(mjs|js|json|html|css|ts|tsx)$/.test(file)){const bytes=await readFile(join(root,file));entries.push({file,sha256:sha(bytes),bytes:bytes.length});}}}
const mode=process.argv[2];time();
if(mode==='baseline'){
 const entries=[];for(const dir of ['lib','public','test','scripts'])await scan(dir,entries);
 for(const file of ['server.mjs','package.json','package-lock.json']){const b=await readFile(join(root,file));entries.push({file,sha256:sha(b),bytes:b.length});}
 const preimage=join(root,'data/code-candidates/phase117/preimage/lib/works-observation.mjs');await mkdir(dirname(preimage),{recursive:true});
 await copyFile(join(root,'lib/works-observation.mjs'),preimage,constants.COPYFILE_EXCL);await chmod(preimage,0o400);
 const siteRows=[];const siteFiles=execFileSync('git',['ls-files','-z'],{cwd:site}).toString().split('\0').filter(Boolean);
 for(const file of siteFiles){const b=await readFile(join(site,file));siteRows.push({file,sha256:sha(b),bytes:b.length});}
 const health=await get('/api/health'),monitoring=await get('/api/monitoring-status'),queue=await get('/api/ingestion-reviews'),settings=await get('/api/settings');
 assert.equal(health.status,'ready');assert.equal(health.runtimeAI,false);assert.equal(monitoring.scheduler.scheduleIntervalHours,8);assert.deepEqual(monitoring.scheduler.slotTimes,['02:00','10:00','18:00']);
 assert.equal(execFileSync('git',['status','--short'],{cwd:site,encoding:'utf8'}).trim(),'');
 const result={createdAt:new Date().toISOString(),entries,siteRows,siteHead:execFileSync('git',['rev-parse','HEAD'],{cwd:site,encoding:'utf8'}).trim(),preimage,preimageSHA256:sha(await readFile(preimage)),sourceSHA256:sha(await readFile(join(root,'data/source-poll/manifest.json'))),health,monitoring,queue,settings};
 await save('code-baseline',result);console.log(JSON.stringify({files:entries.length,oldTests:entries.filter(r=>r.file.startsWith('test/')).length,siteFiles:siteRows.length,health:health.status}));
}else if(mode==='tests'){
 assert.equal(sha(await readFile(join(root,'lib/works-observation.mjs'))),'1be43889106adda740dd44a8fc2de9dfc97048bc8bfc9faf204292fc37153359');
 assert.equal(sha(await readFile(join(root,'test/phase117-works-timeout-resume.test.mjs'))),'b40795b5a733b206fdbe9e345f3d52eeefd503ef682e5ca359804c4e787665c5');
 const files=(await readdir(join(root,'test'))).filter(f=>f.endsWith('.test.mjs')).sort().map(f=>'test/'+f);
 const logPath=join(root,prefix+'main-full-tests.log'),log=await open(logPath,'wx',0o600),startedAt=new Date().toISOString();
 const child=spawn(process.execPath,['--test','--test-concurrency=4',...files],{cwd:root,env:{...process.env,PHASE84_REAL45:'1'},stdio:['ignore',log.fd,log.fd]});
 console.log(JSON.stringify({startedAt,pid:child.pid,testFiles:files.length}));
 const timer=setTimeout(()=>child.kill('SIGTERM'),Math.max(1,Date.parse('2026-10-02T12:00:21Z')-Date.now()));
 const outcome=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});clearTimeout(timer);await log.close();
 const b=await readFile(logPath),out=b.toString(),result={startedAt,finishedAt:new Date().toISOString(),outcome,logPath,sha256:sha(b),testFiles:files.length};
 for(const key of ['tests','pass','fail','cancelled','skipped'])result[key]=Number(out.match(new RegExp('(?:#|ℹ) '+key+' (\\d+)'))?.[1]);
 await save('main-tests-result',result);await chmod(logPath,0o400);console.log(JSON.stringify(result));
 assert.equal(outcome.code,0);assert.equal(outcome.signal,null);assert.ok(result.tests>=4307);assert.equal(result.pass,result.tests);for(const key of ['fail','cancelled','skipped'])assert.equal(result[key],0);
}else if(mode==='archive'){
 const receipts=JSON.parse(process.argv[3]),archived=[];
 for(const item of receipts){const seal=await readFile(join(item.from,item.name));assert.equal(sha(seal),item.expected);const parsed=JSON.parse(seal);
  const listing=parsed.files??parsed.entries;
  const rows=Array.isArray(listing)?listing:Object.entries(listing).map(([file,value])=>({file,...value}));
  for(const row of [...rows,{file:item.name,bytes:seal.length,sha256:sha(seal)}]){const file=row.file||row.path||row.name;assert.ok(file&&!file.startsWith('/')&&!file.split('/').includes('..'));const b=await readFile(join(item.from,file));assert.equal(b.length,row.bytes);assert.equal(sha(b),row.sha256,file);const destination=join(root,'docs/phase117-evidence',item.group,file);await mkdir(dirname(destination),{recursive:true});let existing;try{existing=await readFile(destination);}catch(e){if(e.code!=='ENOENT')throw e;}if(existing)assert.equal(sha(existing),row.sha256,'Already archived evidence must match');else await copyFile(join(item.from,file),destination,constants.COPYFILE_EXCL);await chmod(destination,0o400);assert.equal(sha(await readFile(destination)),row.sha256);archived.push({file:destination,sha256:row.sha256,bytes:row.bytes});}
 }
 await save('evidence-archive', {createdAt:new Date().toISOString(),archived});console.log(JSON.stringify({archived:archived.length}));
}else if(mode==='boundary'){
 const base=await json(prefix+'code-baseline.json'),approved=await json(prefix+'approved.json');
 for(const row of base.entries)assert.equal(sha(await readFile(join(root,row.file))),approved.product[row.file]||approved.auxiliary?.[row.file]||row.sha256,row.file);
 for(const row of base.siteRows)assert.equal(sha(await readFile(join(site,row.file))),row.sha256,row.file);
 for(const [file,hash]of Object.entries(approved.product))assert.equal(sha(await readFile(join(root,file))),hash,file);
 assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:site,encoding:'utf8'}).trim(),base.siteHead);assert.equal(execFileSync('git',['status','--short'],{cwd:site,encoding:'utf8'}).trim(),'');
 const tests=await json(prefix+'main-tests-result.json');assert.equal(tests.outcome.code,0);assert.equal(tests.pass,tests.tests);assert.equal(tests.fail,0);assert.equal(sha(await readFile(tests.logPath)),tests.sha256);
 const archive=await json(prefix+'evidence-archive.json');for(const row of archive.archived)assert.equal(sha(await readFile(row.file)),row.sha256,row.file);
 const health=await get('/api/health'),monitoring=await get('/api/monitoring-status'),queue=await get('/api/ingestion-reviews'),settings=await get('/api/settings');assert.equal(health.status,'ready');assert.equal(health.runtimeAI,false);assert.deepEqual(settings,base.settings);assert.deepEqual(monitoring.scheduler.slotTimes,['02:00','10:00','18:00']);assert.equal(monitoring.scheduler.scheduleIntervalHours,8);
 assert.equal(sha(await readFile(join(root,'data/source-poll/manifest.json'))),base.sourceSHA256);
 const pids=execFileSync('/bin/ps',['-p','90988,26001,79274','-o','pid=,ppid='],{encoding:'utf8'});for(const p of [90988,26001,79274])assert.match(pids,new RegExp('(?:^|\n)\\s*'+p+'\\s+1\\s*'));
 const http=[];for(const file of ['rebuild.js','rebuild.css','rebuild.html','console-model.js']){const r=await fetch('http://127.0.0.1:4188/'+file,{signal:AbortSignal.timeout(8000)});assert.equal(r.status,200);const hash=sha(Buffer.from(await r.arrayBuffer()));assert.equal(hash,sha(await readFile(join(root,'public',file))));http.push({file,status:200,sha256:hash});}
 const signed=await json('docs/phase117-evidence/integrity/signed-receipt.json');assert.deepEqual(signed.fixedRunIds,Array.from({length:20},(_,i)=>2867+i));for(const row of signed.originals)assert.equal(sha(await readFile(row.path)),row.sha256);
 const result={checkedAt:new Date().toISOString(),oldMainFiles:base.entries.length,siteFiles:base.siteRows.length,siteHead:base.siteHead,tests,approved,archived:archive.archived.length,health,monitoring,queue,settings,sourceSHA256:base.sourceSHA256,pids,http,originalEventsUnchanged:true,restart:false,manualCollection:false,newTimers:false,runtimeNewResumeObserved:false,goalComplete:false,publicAnonymousPass:false};await save('boundary',result);console.log(JSON.stringify({at:result.checkedAt,mainTests:tests.tests,originals:20,siteUnchanged:true,ready:true}));
}else if(mode==='review'){
 const boundary=await json(prefix+'boundary.json');assert.equal(boundary.health.status,'ready');assert.equal(boundary.tests.pass,boundary.tests.tests);assert.equal(boundary.originalEventsUnchanged,true);assert.equal(boundary.goalComplete,false);
 const evidence=['docs/phase117-product-review.md',prefix+'run.md',prefix+'boundary.json',prefix+'main-tests-result.json',prefix+'main-full-tests.log',prefix+'evidence-archive.json',prefix+'worker-logs-corrected.json','docs/phase117-evidence/integrity/review.md','docs/phase117-evidence/integrity/data-audit.json','docs/phase117-evidence/integrity/current-state.json','docs/phase117-evidence/integrity/signed-receipt.json','docs/phase117-evidence/public/report.md','docs/phase117-evidence/public/evidence-seal.json',...JSON.parse(process.argv[3]||'[]')].map(f=>join(root,f));assert.ok(evidence.length<=20);
 const refs=[];for(const file of evidence){assert.ok((await stat(file)).size>0);await chmod(file,0o400);refs.push({file,sha256:sha(await readFile(file))});}
 const signed=await json('docs/phase117-evidence/integrity/signed-receipt.json'),completions=[];const {completePostIngestionProductReview}=await import('../lib/post-ingestion-review.mjs');
 for(const row of signed.originals){time();assert.equal(sha(await readFile(row.path)),row.sha256);const done=await completePostIngestionProductReview({ledgerDir:join(root,'data/ingestion-reviews'),runId:row.runId,evidence,now:new Date()});assert.equal(done.status,'created');assert.deepEqual(done.completion.evidence,evidence);assert.equal(sha(await readFile(row.path)),row.sha256);completions.push({runId:row.runId,file:done.path,sha256:sha(await readFile(done.path)),originalSHA256:row.sha256});}
 for(const ref of refs)assert.equal(sha(await readFile(ref.file)),ref.sha256);
 await save('reviewed-bindings',{completedAt:new Date().toISOString(),fixedRunIds:signed.fixedRunIds,evidence:refs,completions,originalsUnchanged:true,nextFixedRunId:2887,goalComplete:false});console.log(JSON.stringify({reviewed:completions.length,next:2887}));
}else throw new Error('unknown Phase117 validation mode');
