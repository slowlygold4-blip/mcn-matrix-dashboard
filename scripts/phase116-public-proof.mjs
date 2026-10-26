import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),site=join(root,'../mcn-public-site'),journal=join(root,'data/maintenance-journal');
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse('2026-10-02T11:31:55Z'));
const input=await new Promise((resolve,reject)=>{
  let value='';const terminal=process.stdin.isTTY;
  const finish=()=>{process.stdin.removeListener('data',onData);if(terminal)process.stdin.setRawMode(false);process.stdin.pause();resolve(value.trim());};
  const onData=chunk=>{value+=chunk;if(value.length>65536)reject(new Error('Public metadata input too large'));else if(/[\r\n]/.test(value))finish();};
  if(terminal)process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.on('data',onData);process.stdin.resume();
  console.log('Ready for public metadata JSON on stdin.');
});
const native=JSON.parse(input);
assert.equal(native.saved.version_number,44);assert.equal(native.deployment.status,'succeeded');assert.equal(native.deployment.url,'https://mcn-matrix-observatory.slowlygold4.chatgpt.site');assert.equal(native.saved.source.commit_sha,'d2a9e6257bfc1c16026ef4c1677bd023f703ea72');
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:site,encoding:'utf8'}).trim(),native.saved.source.commit_sha);assert.equal(execFileSync('git',['status','--short'],{cwd:site,encoding:'utf8'}).trim(),'');
const publishedPath=join(journal,'2026-10-02-phase116-site-published.json');
try{await writeFile(publishedPath,JSON.stringify({recordedAt:new Date().toISOString(),...native},null,2)+'\n',{flag:'wx',mode:0o400});}
catch(e){if(e.code!=='EEXIST')throw e;const prior=JSON.parse(await readFile(publishedPath));assert.deepEqual(prior.saved,native.saved);assert.deepEqual(prior.deployment,native.deployment);}
const manifest=JSON.parse(await readFile(join(site,'build/retained-client-assets/manifest.json'))),startedAt=new Date().toISOString(),rows=[],failures=[];
const listed=execFileSync('/usr/bin/tar',['-tf',join(root,'data/code-candidates/phase116/site-deployment.tar.gz')],{encoding:'utf8'}).trim().split('\n');
const members=listed.filter(p=>!p.endsWith('/'));assert.equal(members.length,native.saved.archive_storage.file_count);
for(const member of members){assert.ok(member.startsWith('dist/')&&!member.includes('..'));const actual=execFileSync('/usr/bin/tar',['-xOf',join(root,'data/code-candidates/phase116/site-deployment.tar.gz'),member],{maxBuffer:20*1024*1024});assert.equal(sha(actual),sha(await readFile(join(site,member))),member);}
const tasks=[...manifest.assets];
await Promise.all(Array.from({length:4},async()=>{while(tasks.length){const row=tasks.shift();try{const url=native.deployment.url+'/'+row.path,r=await fetch(url,{signal:AbortSignal.timeout(20000)}),body=Buffer.from(await r.arrayBuffer()),mime=r.headers.get('content-type')||'';rows.push({path:row.path,status:r.status,mime,bytes:body.length,sha256:sha(body),expectedSHA256:row.sha256,exactBytes:sha(body)===row.sha256});assert.equal(r.status,200,row.path);assert.match(mime,row.path.endsWith('.css')?/text\/css/:/(?:text|application)\/javascript/);assert.equal(sha(body),row.sha256,row.path);}catch(e){failures.push({path:row.path,error:e.message});}}}));
let html;
try{const r=await fetch(native.deployment.url+'/?period=since&start=2026-09-12&end=2026-10-02',{signal:AbortSignal.timeout(20000)}),body=Buffer.from(await r.arrayBuffer());html={status:r.status,mime:r.headers.get('content-type'),bytes:body.length,sha256:sha(body),mentionsMCN:/MCN/.test(body.toString('utf8'))};assert.equal(r.status,200);assert.match(html.mime,/text\/html/);assert.equal(html.mentionsMCN,true);}catch(e){failures.push({path:'/',error:e.message});}
const result={startedAt,finishedAt:new Date().toISOString(),meaning:'Actual anonymous public resource readback for the specific cross-deployment defect on this network; not universal networks, browser interaction, platform completeness or Mac-off sampling',savedVersion:44,commit:native.saved.source.commit_sha,archiveMembersVerified:members.length,rows:rows.sort((a,b)=>a.path.localeCompare(b.path)),html,failures,noAuthenticationHeaderOrCookies:true};
await writeFile(join(journal,'2026-10-02-phase116-public-proof.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify({startedAt,finishedAt:result.finishedAt,version:44,assets:rows.length,archiveMembers:members.length,failures:failures.length,html}));assert.equal(failures.length,0);assert.equal(rows.length,manifest.assets.length);
