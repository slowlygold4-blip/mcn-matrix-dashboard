import assert from 'node:assert/strict';
import {readFile,writeFile,chmod,stat,rename,readdir,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,basename} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),candidate='/tmp/phase107-frontend-ii0r4p';
const approvedLog=process.argv[2];assert.match(basename(approvedLog||''),/^full-[a-zA-Z0-9-]+\.log$/);
assert.equal(approvedLog,join(candidate,basename(approvedLog)));
assert.ok(Date.now()<Date.parse('2026-10-02T07:44:45Z'));
const sha=b=>createHash('sha256').update(b).digest('hex');
const log=await readFile(approvedLog,'utf8');
for(const [key,count] of [['tests',4290],['pass',4290],['fail',0],['cancelled',0],['skipped',0]])assert.match(log,new RegExp('(?:#|ℹ) '+key+' '+count+'\\b'));
const runtime=JSON.parse(await readFile(join(root,'docs/phase107-evidence/runtime/candidate-record-final.json'),'utf8'));
assert.equal(runtime.checks.length,17);assert.ok(runtime.checks.every(c=>c.pass));
assert.equal(runtime.shas['rebuild.js'],'c901db75ef2c16a0e00bc02008094a421d0e069635bb035e221b2c2ce7855181');
const independent=await readFile(join(root,'docs/phase107-evidence/integrity/frontend-review.md'),'utf8');assert.ok(independent.includes('c901'));
const changes=[['rebuild.css','aa149ba75883d897292d8c6241be63ec0bcc547e2c4e553518ce8a541c3232d3','c4908e7829b811a018bb05e483f0475a069110d88ca370f7c19e50cd6af1af14'],['rebuild.js','954cea94f937f02c6199c7c9f0242cfcdcf9782f476d458fb5fc36f2d174fd8a','c901db75ef2c16a0e00bc02008094a421d0e069635bb035e221b2c2ce7855181']];
for(const [file,before,after] of changes){
 const source=join(root,'public',file),staged=join(root,'public','.phase107-approved-'+file);
 assert.equal(sha(await readFile(source)),before);assert.equal(sha(await readFile(staged)),after);
 assert.equal(sha(await readFile(join(root,'data/code-candidates/phase107/preimage/public',file))),before);
}
const health=await fetch('http://127.0.0.1:4188/api/health',{signal:AbortSignal.timeout(8000)}).then(r=>r.json());assert.equal(health.status,'ready');assert.equal(health.runtimeAI,false);
for(const [file,,after] of changes){const source=join(root,'public',file),staged=join(root,'public','.phase107-approved-'+file);await chmod(staged,(await stat(source)).mode&0o777);await rename(staged,source);assert.equal(sha(await readFile(source)),after);}
const installedAt=new Date().toISOString();
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase107-install.json'),JSON.stringify({installedAt,changes:changes.map(([file,before,after])=>({file,before,after})),approvedCandidateFullLog:approvedLog,candidateLogSHA256:sha(Buffer.from(log)),noRestart:true,noManualCollection:true,siteUIChangedThisRound:false,mode:'two individually atomic same-directory source replacements; existing sampling process untouched'},null,2)+'\n',{flag:'wx',mode:0o400});
const files=(await readdir(join(root,'test'))).filter(f=>f.endsWith('.test.mjs')).sort().map(f=>'test/'+f);
const logPath=join(root,'data/maintenance-journal/2026-10-02-phase107-main-full-tests.log'),fd=await open(logPath,'wx',0o600),startedAt=new Date().toISOString();
console.log(JSON.stringify({installedAt,startedAt,files:files.length,logPath}));
const child=spawn(process.execPath,['--test','--test-concurrency=2',...files],{cwd:root,env:{...process.env,PHASE84_REAL45:'1'},stdio:['ignore',fd.fd,fd.fd]});
const guard=setTimeout(()=>child.kill('SIGTERM'),Math.max(1,Date.parse('2026-10-02T07:49:15Z')-Date.now()));
const outcome=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});clearTimeout(guard);await fd.close();
const bytes=await readFile(logPath),text=bytes.toString('utf8'),result={startedAt,finishedAt:new Date().toISOString(),outcome,logPath,sha256:sha(bytes),candidateFullLog:approvedLog,sourceSHA256:changes.map(([file])=>({file,sha256:null}))};
for(const row of result.sourceSHA256)row.sha256=sha(await readFile(join(root,'public',row.file)));
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase107-main-tests-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify(result));
assert.equal(outcome.code,0);assert.equal(outcome.signal,null);
for(const [key,count] of [['tests',4290],['pass',4290],['fail',0],['cancelled',0],['skipped',0]])assert.match(text,new RegExp('(?:#|ℹ) '+key+' '+count+'\\b'));
