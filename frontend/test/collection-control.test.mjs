import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';import {handleCollection,safeProgress} from '../lib/collection-control.mjs';
const origin='https://example.test',secret='a'.repeat(64),hash=s=>createHash('sha256').update(s).digest('hex');
function fixture(t){const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());const db={prepare(sql){return {bind(...args){this.args=args;return this;},args:[],async run(){return sqlite.prepare(sql).run(...this.args)},async first(){return sqlite.prepare(sql).get(...this.args)??null}}},async batch(xs){return Promise.all(xs.map(x=>x.run()))}};let cookie='',now=Date.now();
 const req=(body,{producer=false,session=true,same=true,method='POST'}={})=>handleCollection(new Request(origin+'/api/collection',{method,headers:{...(same?{Origin:origin}:{}),...(producer?{Authorization:'Bearer '+secret}:{}),...(session&&cookie?{Cookie:cookie}:{}),'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})}),{db,secret,now});
 return {req,db,advance(ms){now+=ms},progress(){return {observedAt:new Date(now).toISOString(),runtimeAI:false,accounts:4930,queue:{pending:123},run:{id:42,status:'running',total:100,processed:20,success:18,failed:2}}},async pair(){const code='b'.repeat(64);assert.equal((await req({action:'grant',hash:hash(code)},{producer:true})).status,200);const r=await req({action:'pair',code});cookie=r.headers.get('Set-Cookie').split(';')[0];return {r,code};}};
}
test('public status, authenticated single-flight command, durable ack and completion',async t=>{const f=fixture(t);assert.equal((await f.req({action:'trigger',id:crypto.randomUUID()})).status,401);
 await f.req({action:'heartbeat',status:f.progress()},{producer:true});const {r}=await f.pair();assert.match(r.headers.get('Set-Cookie'),/HttpOnly; Secure; SameSite=Strict/);
 const a=crypto.randomUUID(),b=crypto.randomUUID();let x=await (await f.req({action:'trigger',id:a})).json();assert.equal(x.command.id,a);
 x=await (await f.req({action:'trigger',id:b})).json();assert.equal(x.command.id,a);assert.equal(x.reused,true);
 let receipt=await (await f.req({action:'heartbeat',status:f.progress()},{producer:true})).json();assert.equal(receipt.command.id,a);
 const jobId=crypto.randomUUID();await f.req({action:'heartbeat',status:f.progress(),ack:{id:a,jobId,runId:43,status:'running'}},{producer:true});
 await f.req({action:'heartbeat',status:f.progress(),ack:{id:a,jobId,runId:43,status:'completed'}},{producer:true});
 x=await (await f.req(null,{method:'GET',session:false})).json();assert.equal(x.canControl,false);assert.equal(x.online,true);assert.equal(x.command.status,'completed');assert.equal(x.command.receipt.runId,43);
 x=await (await f.req({action:'trigger',id:a})).json();assert.equal(x.command.status,'completed');assert.equal(x.reused,true);
});
test('single-use pairing, CSRF, invalid secret, offline and expiration',async t=>{const f=fixture(t);const {code}=await f.pair();assert.equal((await f.req({action:'pair',code})).status,403);assert.equal((await f.req({action:'trigger',id:crypto.randomUUID()},{same:false})).status,403);
 assert.equal((await f.req({action:'grant',hash:'c'.repeat(64)})).status,400);
 assert.equal((await f.req({action:'trigger',id:crypto.randomUUID()})).status,409);
 await f.req({action:'heartbeat',status:f.progress()},{producer:true});const id=crypto.randomUUID();await f.req({action:'trigger',id});f.advance(610000);
 const x=await (await f.req(null,{method:'GET'})).json();assert.equal(x.online,false);assert.equal(x.command.status,'expired');
 assert.equal((await f.req({action:'trigger',id:crypto.randomUUID()})).status,409);
 const exchange=await (await f.req({action:'heartbeat',status:f.progress()},{producer:true})).json();assert.equal(exchange.command,null);
 f.advance(31*86400000);assert.equal((await (await f.req(null,{method:'GET'})).json()).canControl,false);
});
test('status is bounded, strips secrets and disallows model-driven telemetry',()=>{
 const status=safeProgress({observedAt:new Date().toISOString(),runtimeAI:false,cookie:'secret',run:{total:3,processed:2,current:'x'.repeat(500),raw_json:{token:'secret'}}});
 assert.equal(status.run.current.length,120);assert.equal(JSON.stringify(status).includes('secret'),false);assert.throws(()=>safeProgress({runtimeAI:true}));
});
test('stale producer telemetry rejected and terminal receipts cannot regress',async t=>{const f=fixture(t),old=f.progress();f.advance(100000);assert.equal((await f.req({action:'heartbeat',status:old},{producer:true})).status,400);
 await f.pair();await f.req({action:'heartbeat',status:f.progress()},{producer:true});const id=crypto.randomUUID(),jobId=crypto.randomUUID();await f.req({action:'trigger',id});
 for(const status of ['completed','running'])await f.req({action:'heartbeat',status:f.progress(),ack:{id,jobId,status}},{producer:true});
 assert.equal((await (await f.req(null,{method:'GET'})).json()).command.status,'completed');
});

function largeIssues(progress){
 const since=new Date(Date.parse(progress.observedAt)-86400000).toISOString();
 return {...progress,rolling:{since,total:4096,profileTotal:4096,profiles:4080,topics:0,updated:4080,
  notUpdated:16,workIssues:4096,issues:{version:1,since,asOf:progress.observedAt,
   missingProfileTargetIds:Array.from({length:16},(_,i)=>i+1),missingTopicTargetIds:[],
   workIssueGroups:[{code:'blocked',targetIds:Array.from({length:4096},(_,i)=>i+1)}]}}};
}
test('authenticated heartbeat carries the full 4k issue list above the old 16KB limit',async t=>{
 const f=fixture(t),status=largeIssues(f.progress()),payload={action:'heartbeat',status};
 assert.ok(new TextEncoder().encode(JSON.stringify(payload)).length>16000);
 assert.equal((await f.req(payload,{producer:true})).status,200);
 const stored=await(await f.req(null,{method:'GET',session:false})).json();
 assert.deepEqual(stored.status.rolling.issues,status.rolling.issues);
 assert.equal(stored.status.rolling.workIssues,4096);
 assert.equal(stored.status.rolling.issues.workIssueGroups[0].targetIds.length,4096);
});
test('oversize or inconsistent issue heartbeats cannot replace the last accepted status',async t=>{
 const f=fixture(t),status=largeIssues(f.progress());
 assert.equal((await f.req({action:'heartbeat',status},{producer:true})).status,200);
 const before=await(await f.req(null,{method:'GET'})).json();
 const bad=structuredClone(status);bad.rolling.issues.workIssueGroups[0].targetIds.pop();
 assert.equal((await f.req({action:'heartbeat',status:bad},{producer:true})).status,400);
 assert.equal((await f.req({action:'heartbeat',status,padding:'PRIVATE_SENTINEL'.repeat(20_000)},{producer:true})).status,400);
 const after=await(await f.req(null,{method:'GET'})).json();
 assert.deepEqual(after.status,before.status);
 assert.equal(JSON.stringify(after).includes('PRIVATE_SENTINEL'),false);
});
test('larger reader never expands public/session commands or producer grant limits',async t=>{
 const f=fixture(t),padding='x'.repeat(16_001);
 assert.equal((await f.req({action:'grant',hash:'c'.repeat(64),padding},{producer:true})).status,400);
 assert.equal((await f.req({action:'heartbeat',status:largeIssues(f.progress())})).status,400);
 await f.pair();
 assert.equal((await f.req({action:'trigger',id:crypto.randomUUID(),padding})).status,400);
 assert.equal((await f.req({action:'logout',padding})).status,400);
 assert.equal((await(await f.req(null,{method:'GET'})).json()).canControl,true);
 const count=await f.db.prepare('SELECT COUNT(*) n FROM collection_commands').first();assert.equal(count.n,0);
});
test('same-origin intent is checked before public body reads or storage initialization',async()=>{
 let initialized=0,reads=0;
 const request={method:'POST',url:origin+'/api/collection',headers:new Headers(),body:{getReader(){reads++;throw Error('must not read');}}};
 const db={batch(){initialized++;throw Error('must not initialize');},prepare(){initialized++;throw Error('must not prepare');}};
 assert.equal((await handleCollection(request,{db,secret})).status,403);
 assert.equal(reads,0);assert.equal(initialized,0);
});
