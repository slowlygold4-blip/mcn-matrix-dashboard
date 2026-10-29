import test from'node:test';import assert from'node:assert/strict';import{createHash}from'node:crypto';import{fileURLToPath}from'node:url';import{build}from'esbuild';import{ingestFixture}from'./helpers/replica-ingest-fixture.mjs';import{foundationPublication}from'./helpers/foundation-publication.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),producer='synthetic-reference-producer-'.repeat(3),fixture=ingestFixture(producer);globalThis.__referenceFixture=fixture.env;
const bundle=await build({entryPoints:[root+'app/api/replica/route.ts'],bundle:true,write:false,format:'esm',platform:'node',alias:{'@':root},plugins:[{name:'reference-cloud',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cloud',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const env=globalThis.__referenceFixture;',loader:'js'}));}}]});
fixture.env.BUCKET.get=async key=>{const text=fixture.objects.get(key);return text===undefined?null:{size:Buffer.byteLength(text),text:async()=>text,body:new Response(text).body};};
const{POST,GET}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const A='2026-10-29T01:00:00.000Z',B='2026-10-29T02:00:00.000Z',C='2026-10-29T03:00:00.000Z';
const post=(body,auth=true)=>POST(new Request('https://fixture.test/api/replica',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+producer}:{})},body:JSON.stringify(body)}));
const upload=(p,reuse=true,auth=true)=>post({action:'upload',asOf:p.asOf,reuseUnchanged:reuse,files:p.files.map(({path,sha256,data})=>({path,sha256,data}))},auth);
const activate=p=>post({action:'activate',asOf:p.asOf,manifest:p.manifest});
async function publish(p,reuse=false){assert.equal((await upload(p,reuse)).status,200);const r=await activate(p);assert.equal(r.status,200,await r.text());}
async function exact(p){for(const f of p.files){const r=await GET(new Request('https://fixture.test/api/replica?'+new URLSearchParams({generation:p.asOf,part:f.path})));assert.equal(r.status,200,f.path);const text=await r.text();assert.equal(text,f.data);assert.equal(createHash('sha256').update(text).digest('hex'),f.sha256);assert.equal(r.headers.get('X-Data-SHA256'),f.sha256);}}
test.beforeEach(()=>fixture.reset());test.after(()=>fixture.close());
test('unchanged content reuses sealed storage, with exact old/new public bytes and no reference chains',async()=>{
 const a=foundationPublication(A),b=foundationPublication(B),c=foundationPublication(C);await publish(a);const before=fixture.metrics.puts;
 const response=await upload(b);assert.equal(response.status,200);assert.equal(Number(response.headers.get('X-Replica-Reused')),b.files.length-1);assert.equal(response.headers.get('X-Replica-Stored'),'1');assert.equal(fixture.metrics.puts-before,1,'only the generation-bound foundation index changes');assert.equal((await activate(b)).status,200);await exact(a);await exact(b);
 const beforeC=fixture.metrics.puts;await publish(c,true);assert.equal(fixture.metrics.puts-beforeC,1);assert.ok(fixture.sqlite.prepare('SELECT source_generation FROM replica_file_references WHERE generation=?').all(C).every(r=>r.source_generation===A));await exact(c);
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
