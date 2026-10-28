import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('source maintenance authenticates without dashboard aggregation and preserves service errors',async t=>{
 let broken=false;const paths=[];
 const server=createServer((req,res)=>{
  paths.push(req.url);
  assert.equal(req.url,'/api/source-poll/bootstrap');
  res.writeHead(broken?503:200,{'content-type':'application/json','set-cookie':'mcn_session=test; HttpOnly'});
  res.end(JSON.stringify(broken?{error:'读取超时'}:{auth:{csrfToken:'test-csrf',permissions:{edit:true}},authorSources:[{sourceUrl:'https://tenant.feishu.cn/sheets/abc'}]}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>server.close(r)));
 process.env.SOURCE_POLL_BASE_URL=`http://127.0.0.1:${server.address().port}`;
 const {readSession}=await import('../scripts/source-poller.mjs?bootstrap-test');
 const session=await readSession();
 assert.equal(session.headers['x-csrf-token'],'test-csrf');
 assert.match(session.headers.cookie,/mcn_session=test/);
 assert.equal(session.bootstrap.authorSources.length,1);
 broken=true;await assert.rejects(readSession(),/503: 读取超时/);
 assert.equal(paths.length,2);
});

test('source bootstrap keeps local authentication and denies anonymous proxy access',{timeout:30000},async t=>{
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
 const port=probe.address().port;await new Promise(r=>probe.close(r));
 const dir=await mkdtemp(join(tmpdir(),'mcn-source-bootstrap-'));
 const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',NODE_ENV:'test'},stdio:'ignore'});
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}await rm(dir,{recursive:true,force:true});});
 const url=`http://127.0.0.1:${port}/api/source-poll/bootstrap`;
 let response;
 for(let i=0;i<100;i++){
  try{response=await fetch(url);if(response.ok)break;}catch{}
  await new Promise(r=>setTimeout(r,50));
 }
 assert.equal(response?.status,200);
 const payload=await response.json();
 assert.deepEqual(Object.keys(payload).sort(),['auth','authorSources']);
 assert.equal(payload.auth.permissions.edit,true);
 assert.ok(payload.auth.csrfToken);
 assert.ok(Array.isArray(payload.authorSources));
 const external=await fetch(url,{headers:{'x-forwarded-for':'203.0.113.9'}});
 assert.equal(external.status,401);
});
