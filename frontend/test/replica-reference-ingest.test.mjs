import test from'node:test';import assert from'node:assert/strict';import{createHash}from'node:crypto';import{fileURLToPath}from'node:url';import{build}from'esbuild';import{ingestFixture}from'./helpers/replica-ingest-fixture.mjs';import{foundationPublication}from'./helpers/foundation-publication.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),producer='synthetic-reference-producer-'.repeat(3),fixture=ingestFixture(producer);globalThis.__referenceFixture=fixture.env;
const bundle=await build({entryPoints:[root+'app/api/replica/route.ts'],bundle:true,write:false,format:'esm',platform:'node',alias:{'@':root},plugins:[{name:'reference-cloud',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cloud',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const env=globalThis.__referenceFixture;',loader:'js'}));}}]});
fixture.env.BUCKET.get=async key=>{const text=fixture.objects.get(key);return text===undefined?null:{size:Buffer.byteLength(text),text:async()=>text,body:new Response(text).body};};
const{POST,GET}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const A='2026-10-29T01:00:00.000Z',B='2026-10-29T02:00:00.000Z',C='2026-10-29T03:00:00.000Z';
const post=(body,auth=true,signal)=>POST(new Request('https://fixture.test/api/replica',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+producer}:{})},body:JSON.stringify(body),signal}));
const upload=(p,reuse=true,auth=true,signal)=>post({action:'upload',asOf:p.asOf,reuseUnchanged:reuse,files:p.files.map(({path,sha256,data})=>({path,sha256,data}))},auth,signal);
const compactUpload=(p,previous,edit=x=>x,auth=true,signal)=>post(edit({action:'upload',asOf:p.asOf,reuseUnchanged:true,referenceGeneration:previous.asOf,
 files:p.files.map(f=>{const before=previous.files.find(x=>x.path===f.path);if(before){const old=JSON.stringify({...JSON.parse(f.data),asOf:previous.asOf})+'\n';if(createHash('sha256').update(old).digest('hex')===before.sha256)return{path:f.path,sha256:f.sha256,bytes:Buffer.byteLength(f.data)};}return{path:f.path,sha256:f.sha256,data:f.data};})}),auth,signal);
const activate=p=>post({action:'activate',asOf:p.asOf,manifest:p.manifest});
async function publish(p,reuse=false){assert.equal((await upload(p,reuse)).status,200);const r=await activate(p);assert.equal(r.status,200,await r.text());}
async function exact(p){for(const f of p.files){const r=await GET(new Request('https://fixture.test/api/replica?'+new URLSearchParams({generation:p.asOf,part:f.path})));assert.equal(r.status,200,f.path);const text=await r.text();assert.equal(text,f.data);assert.equal(createHash('sha256').update(text).digest('hex'),f.sha256);assert.equal(r.headers.get('X-Data-SHA256'),f.sha256);}}
test.beforeEach(()=>fixture.reset());test.after(()=>fixture.close());
test('unchanged content reuses sealed storage, with exact old/new public bytes and no reference chains',async()=>{
 const a=foundationPublication(A),b=foundationPublication(B),c=foundationPublication(C);await publish(a);const before=fixture.metrics.puts;
 const response=await upload(b);assert.equal(response.status,200);assert.equal(Number(response.headers.get('X-Replica-Reused')),b.files.length-1);assert.equal(response.headers.get('X-Replica-Stored'),'1');assert.equal(fixture.metrics.puts-before,1,'only the generation-bound foundation index changes');assert.equal((await activate(b)).status,200);await exact(a);await exact(b);
 const beforeC=fixture.metrics.puts;await publish(c,true);assert.equal(fixture.metrics.puts-beforeC,1);assert.ok(fixture.sqlite.prepare('SELECT source_generation FROM replica_file_references WHERE generation=?').all(C).every(r=>r.source_generation===A));await exact(c);
});
test('compact uploads restore exact old/new bytes and verify source objects without redundant HEAD calls',async()=>{
 const a=foundationPublication(A),b=foundationPublication(B);await publish(a);const heads=fixture.metrics.heads,puts=fixture.metrics.puts;
 const response=await compactUpload(b,a);assert.equal(response.status,200,await response.text());
 assert.equal(fixture.metrics.heads,heads);assert.equal(fixture.metrics.puts-puts,1);
 assert.equal((await activate(b)).status,200);await exact(a);await exact(b);
 const c=foundationPublication(C,{authors:2});assert.equal((await compactUpload(c,b)).status,200);assert.equal((await activate(c)).status,200);await exact(c);
});
test('compact missing/corrupt sources cannot commit metadata; identical complete replay repairs without changing old data',async()=>{
 for(const corrupt of [false,true]){
  fixture.reset();const a=foundationPublication(A),b=foundationPublication(B);await publish(a);
  const f=a.files.find(x=>x.path==='summary.json'),key=A+'/'+f.sha256;
  if(corrupt)fixture.objects.set(key,'CORRUPT');else fixture.objects.delete(key);
  const response=await compactUpload(b,a);assert.equal(response.status,409);assert.equal((await response.json()).error,'引用来源不可用，需完整上传');
  assert.equal(fixture.sqlite.prepare('SELECT count(*) n FROM replica_files WHERE generation=?').get(B).n,0);
  assert.equal((await upload(b)).status,200);assert.equal((await activate(b)).status,200);await exact(a);await exact(b);
 }
});
test('compact future/unpublished sources, wrong hashes, mixed invalid input and anonymous writes fail before acknowledgement',async()=>{
 const a=foundationPublication(A),b=foundationPublication(B);await publish(a);
 assert.equal((await compactUpload(b,a,x=>({...x,referenceGeneration:C}))).status,400);
 assert.equal((await compactUpload(b,a,x=>({...x,referenceGeneration:'2026-10-29T00:00:00.000Z'}))).status,409);
 assert.equal((await compactUpload(b,a,x=>({...x,files:x.files.map((f,i)=>i===0?{...f,sha256:'0'.repeat(64)}:f)}))).status,409);
 const puts=fixture.metrics.puts;
 assert.equal((await compactUpload(b,a,x=>({...x,files:[...x.files,{path:'bad',sha256:'0'.repeat(64),bytes:1}]}))).status,400);
 assert.equal(fixture.metrics.puts,puts);
 assert.equal((await compactUpload(b,a,x=>x,false)).status,403);
 assert.equal(fixture.sqlite.prepare('SELECT count(*) n FROM replica_files WHERE generation=?').get(B).n,0);
});
test('compact source readers drain on failure and cancellation without partial metadata or writes',async()=>{
 for(const abort of [false,true]){
  fixture.reset();const a=foundationPublication(A),b=foundationPublication(B);await publish(a);
  const get=fixture.env.BUCKET.get,puts=fixture.metrics.puts,controller=new AbortController();let active=0,peak=0;
  fixture.env.BUCKET.get=async key=>{active++;peak=Math.max(peak,active);try{
   await new Promise(r=>setImmediate(r));
   if(abort)controller.abort();
   if(!abort&&key===A+'/'+a.files[0].sha256)return null;
   return get(key);
  }finally{active--;}};
  try{
   const body={action:'upload',asOf:B,reuseUnchanged:true,referenceGeneration:A,
    files:b.files.filter(f=>f.path!=='foundation/index.json').map(f=>({path:f.path,sha256:f.sha256,bytes:Buffer.byteLength(f.data)}))};
   const response=await POST(new Request('https://fixture.test/api/replica',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+producer},body:JSON.stringify(body),signal:controller.signal}));
   assert.equal(response.status,abort?503:409);assert.equal(active,0);assert.ok(peak<=6);assert.ok(peak>1);
   assert.equal(fixture.metrics.puts,puts);assert.equal(fixture.sqlite.prepare('SELECT count(*) n FROM replica_files WHERE generation=?').get(B).n,0);
  }finally{fixture.env.BUCKET.get=get;}
 }
});
test('compact and full uploads cancelled during hash validation do not enter storage or metadata writes',async()=>{
 for(const compact of [false,true]){
  fixture.reset();const a=foundationPublication(A),b=foundationPublication(B);await publish(a);
  const digest=crypto.subtle.digest,get=fixture.env.BUCKET.get,controller=new AbortController();
  const puts=fixture.metrics.puts,batches=fixture.metrics.batches;let hashes=0,reads=0;
  fixture.env.BUCKET.get=async key=>{reads++;return get(key);};
  crypto.subtle.digest=function(...args){hashes++;controller.abort(Error('SYNTHETIC_PRIVATE_FAILURE'));return digest.apply(this,args);};
  try{
   // Compact-only files ensure this abort happens after source restoration,
   // not while validating the changed full-body foundation index.
   const response=compact?await compactUpload(b,a,x=>({...x,files:x.files.filter(f=>f.data===undefined)}),true,controller.signal)
    :await upload(b,false,true,controller.signal);
   assert.equal(response.status,503);assert.equal(hashes,1);assert.equal(reads>0,compact);
   assert.deepEqual(await response.json(),{error:'同步请求已取消，已完成写入保留，可安全重试'});
   assert.equal(fixture.metrics.puts,puts);assert.equal(fixture.metrics.batches,batches);
   assert.equal(fixture.sqlite.prepare('SELECT count(*) n FROM replica_files WHERE generation=?').get(B).n,0);
   assert.equal(fixture.sqlite.prepare('SELECT count(*) n FROM replica_file_references WHERE generation=?').get(B).n,0);
  }finally{crypto.subtle.digest=digest;fixture.env.BUCKET.get=get;}
  await exact(a);
 }
});
test('cancellation during HEAD drains readers without starting repair writes or committing metadata',async()=>{
 const a=foundationPublication(A),b=foundationPublication(B);await publish(a);
 const head=fixture.env.BUCKET.head,controller=new AbortController(),puts=fixture.metrics.puts;
 let active=0,started=0;
 fixture.env.BUCKET.head=async()=>{active++;started++;try{
  await new Promise(r=>setImmediate(r));controller.abort();return null;
 }finally{active--;}};
 try{
  const response=await upload(b,true,true,controller.signal);
  assert.equal(response.status,503);assert.equal(active,0);assert.equal(started,6);
  assert.equal(fixture.metrics.puts,puts);
  assert.equal(fixture.sqlite.prepare('SELECT count(*) n FROM replica_files WHERE generation=?').get(B).n,0);
 }finally{fixture.env.BUCKET.head=head;}
 await exact(a);
});
test('cancellation drains dispatched PUTs, stops subsequent writes, and permits exact replay',async()=>{
 const a=foundationPublication(A),b=foundationPublication(B);await publish(a);
 const put=fixture.env.BUCKET.put,controller=new AbortController(),puts=fixture.metrics.puts;
 let active=0,started=0;
 fixture.env.BUCKET.put=async(...args)=>{active++;started++;try{
  await new Promise(r=>setImmediate(r));controller.abort();return await put(...args);
 }finally{active--;}};
 try{
  const response=await upload(b,false,true,controller.signal);
  assert.equal(response.status,503);assert.equal(active,0);assert.equal(started,2);
  assert.equal(fixture.metrics.puts-puts,2,'already dispatched immutable writes may finish');
  assert.equal(fixture.sqlite.prepare('SELECT count(*) n FROM replica_files WHERE generation=?').get(B).n,0);
 }finally{fixture.env.BUCKET.put=put;}
 await publish(b);await exact(a);await exact(b);
});
test('cancellation after D1 commits withholds acknowledgement without deleting replayable metadata',async()=>{
 const a=foundationPublication(A),b=foundationPublication(B);await publish(a);
 const batch=fixture.env.DB.batch,controller=new AbortController();
 fixture.env.DB.batch=async statements=>{const result=await batch(statements);controller.abort();return result;};
 try{
  const response=await compactUpload(b,a,x=>x,true,controller.signal);
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'同步请求已取消，已完成写入保留，可安全重试'});
  assert.equal(fixture.sqlite.prepare('SELECT count(*) n FROM replica_files WHERE generation=?').get(B).n,b.files.length);
  assert.equal(fixture.sqlite.prepare('SELECT count(*) n FROM replica_file_references WHERE generation=?').get(B).n,b.files.length-1);
  assert.equal(fixture.sqlite.prepare('SELECT count(*) n FROM replica_generations WHERE generation=?').get(B).n,0);
 }finally{fixture.env.DB.batch=batch;}
 assert.equal((await compactUpload(b,a)).status,200);assert.equal((await activate(b)).status,200);await exact(a);await exact(b);
});
test('loss after compact acknowledgement still prevents activation until exact full repair',async()=>{
 const a=foundationPublication(A),b=foundationPublication(B);await publish(a);assert.equal((await compactUpload(b,a)).status,200);
 const f=a.files.find(f=>f.path==='summary.json');fixture.objects.delete(A+'/'+f.sha256);
 assert.equal((await activate(b)).status,409);assert.equal(fixture.sqlite.prepare('SELECT count(*) n FROM replica_generations WHERE generation=?').get(B).n,0);
 assert.equal((await upload(b)).status,200);assert.equal((await activate(b)).status,200);await exact(a);await exact(b);
});
test('expanded compact byte budgets are checked before storage reads or writes',async()=>{
 const a=foundationPublication(A);await publish(a);const get=fixture.env.BUCKET.get,puts=fixture.metrics.puts;let gets=0;
 fixture.env.BUCKET.get=async key=>{gets++;return get(key);};
 try{
  const response=await post({action:'upload',asOf:B,reuseUnchanged:true,referenceGeneration:A,files:[1,2,3].map(id=>({path:'works/'+id+'.json',sha256:'1'.repeat(64),bytes:4_000_000}))});
  assert.equal(response.status,413);assert.equal(gets,0);assert.equal(fixture.metrics.puts,puts);
 }finally{fixture.env.BUCKET.get=get;}
});
test('changed data materializes instead of reusing an earlier author count',async()=>{
 const a=foundationPublication(A),b=foundationPublication(B,{authors:2});await publish(a);const response=await upload(b);assert.equal(response.status,200);
 const paths=fixture.sqlite.prepare('SELECT path FROM replica_file_references WHERE generation=? ORDER BY path').all(B).map(r=>r.path);assert.deepEqual(paths,['catalog.json','summary.json','topics.json']);assert.equal((await activate(b)).status,200);await exact(a);await exact(b);
});
test('missing or corrupted immutable objects are restored only from exact source-SHA proven bytes',async()=>{
 const a=foundationPublication(A),b=foundationPublication(B),c=foundationPublication(C);await publish(a);
 const f=a.files.find(f=>f.path==='summary.json'),key=A+'/'+f.sha256;fixture.objects.delete(key);await publish(b,true);assert.equal(fixture.objects.get(key),f.data);await exact(a);
 fixture.objects.set(key,'CORRUPT_SOURCE');await publish(c,true);assert.equal(fixture.objects.get(key),f.data);await exact(a);await exact(c);
});
test('storage loss after upload prevents activation and an identical replay repairs it',async()=>{
 const a=foundationPublication(A),b=foundationPublication(B);await publish(a);assert.equal((await upload(b)).status,200);
 const f=a.files.find(f=>f.path==='summary.json');fixture.objects.delete(A+'/'+f.sha256);const rejected=await activate(b);assert.equal(rejected.status,409);assert.equal((await rejected.json()).error,'存储分片缺失或损坏，未发布');assert.equal(fixture.sqlite.prepare('SELECT count(*) n FROM replica_generations WHERE generation=?').get(B).n,0);
 await publish(b,true);await exact(a);await exact(b);
});
test('conflicting metadata winner cannot receive a losing upload reference',async()=>{
 const a=foundationPublication(A),b=foundationPublication(B);await publish(a);fixture.control.beforeBatch=db=>db.prepare('INSERT INTO replica_files VALUES(?,?,?,?)').run(B,'catalog.json','0'.repeat(64),1);
 assert.equal((await upload(b)).status,409);assert.equal(fixture.sqlite.prepare("SELECT count(*) n FROM replica_file_references WHERE generation=? AND path='catalog.json'").get(B).n,0);await exact(a);
});
test('a failed head drains at most six storage operations and never commits partial metadata',async()=>{
 const a=foundationPublication(A),b=foundationPublication(B);await publish(a);const original=fixture.env.BUCKET.head;let active=0,peak=0;
 fixture.env.BUCKET.head=async key=>{active++;peak=Math.max(peak,active);try{await new Promise(r=>setImmediate(r));if(key===A+'/'+a.files[0].sha256)throw Error('SYNTHETIC_PRIVATE_STORAGE');return original(key);}finally{active--;}};
 try{const r=await upload(b);assert.equal(r.status,503);assert.equal((await r.text()).includes('SYNTHETIC_PRIVATE'),false);assert.equal(active,0);assert.ok(peak<=6);assert.equal(fixture.sqlite.prepare('SELECT count(*) n FROM replica_files WHERE generation=?').get(B).n,0);}finally{fixture.env.BUCKET.head=original;}
});
test('anonymous reuse is rejected before database and storage access',async()=>{
 assert.equal((await upload(foundationPublication(A),true,false)).status,403);assert.equal(fixture.metrics.reads,0);assert.equal(fixture.metrics.heads,0);assert.equal(fixture.metrics.puts,0);
});


test('legacy exact retry can materialize an aliased generation without changing public bytes',async()=>{
 const a=foundationPublication(A),b=foundationPublication(B);await publish(a);await publish(b,true);assert.ok(fixture.sqlite.prepare('SELECT count(*) n FROM replica_file_references WHERE generation=?').get(B).n>0);
 assert.equal((await upload(b,false)).status,200);assert.equal(fixture.sqlite.prepare('SELECT count(*) n FROM replica_file_references WHERE generation=?').get(B).n,0);await exact(a);await exact(b);
});

function withDaily(asOf){
 const p=foundationPublication(asOf),points=[1,2].map(targetId=>({targetId,date:'2026-10-28',capturedAt:'2026-10-28T00:00:00.000Z',followers:targetId,followersAt:'2026-10-28T00:00:00.000Z',likes:targetId*2,likesAt:'2026-10-28T00:00:00.000Z',posts:0,postsAt:'2026-10-28T00:00:00.000Z'})),hash=s=>createHash('sha256').update(s).digest('hex');
 const put=(path,kind,count,value,extra={})=>{const data=JSON.stringify(value)+'\n',f={path,kind,count,bytes:Buffer.byteLength(data),sha256:hash(data),...extra,data};const at=p.files.findIndex(f=>f.path===path);if(at<0)p.files.push(f);else p.files[at]=f;return f;},common={version:1,asOf,timeZone:'Asia/Shanghai'};
 put('summary.json','summary',2,{...common,items:points});for(const point of points)put('daily/'+point.targetId+'.json','daily',1,{...common,items:[point]},{targetId:point.targetId});
 const base={...p.manifest,counts:{daily:2},files:p.files.map(({data,...m})=>m)},shard=put('date-summary/000001.json','summaryDateShard',2,{...common,items:points});
 const{data,kind,...descriptor}=shard;
 put('date-summary-index.json','summaryDateIndex',2,{...common,format:'date-shards-v1',sourceManifestSha256:hash(JSON.stringify(base)),sourceDaily:base.files.filter(f=>f.kind==='daily').map(({kind,...m})=>m),count:2,firstDate:'2026-10-28',lastDate:'2026-10-28',shards:[{...descriptor,firstDate:'2026-10-28',lastDate:'2026-10-28'}]});
 p.manifest={...base,files:p.files.map(({data,...m})=>m)};return p;
}
test('referenced daily observations still pass the full date-source audit, including repair after loss',async()=>{
 const a=withDaily(A),b=withDaily(B);await publish(a);assert.equal((await upload(b)).status,200);
 assert.equal(fixture.sqlite.prepare("SELECT count(*) n FROM replica_file_references WHERE generation=? AND path LIKE 'daily/%'").get(B).n,2);
 const f=a.files.find(f=>f.path==='daily/2.json');fixture.objects.delete(A+'/'+f.sha256);const rejected=await activate(b);assert.equal(rejected.status,409);assert.equal((await rejected.json()).error,'存储分片缺失或损坏，未发布');
 await publish(b,true);await exact(a);await exact(b);
});
