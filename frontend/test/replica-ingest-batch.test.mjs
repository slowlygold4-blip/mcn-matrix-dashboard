import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {ingestFixture} from './helpers/replica-ingest-fixture.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const bundle=await build({entryPoints:[root+'app/api/replica/route.ts'],bundle:true,write:false,format:'esm',platform:'node',alias:{'@':root},plugins:[{name:'synthetic-cloud',setup(builder){
 builder.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cloud',namespace:'fixture'}));
 builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const env=globalThis.__mcnBatchFixture;',loader:'js'}));
}}]});
const producer='synthetic-batch-only-producer-'.repeat(3),fixture=ingestFixture(producer);
globalThis.__mcnBatchFixture=fixture.env;
const {POST}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
test.beforeEach(()=>fixture.reset());test.after(()=>fixture.close());
const asOf='2026-10-28T03:00:00.000Z';
const part=(id=1)=>{const data=JSON.stringify({asOf,items:[],fixtureId:id});return{path:`daily/${id}.json`,data,sha256:createHash('sha256').update(data).digest('hex')};};
const request=(files,auth=true)=>POST(new Request('https://example.test/api/replica',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+producer}:{})},body:JSON.stringify({action:'upload',asOf,files})}));
const rows=()=>fixture.sqlite.prepare('SELECT * FROM replica_files ORDER BY path').all();

test('50 immutable files use bounded R2 workers and four D1 round trips, not per-file reads/writes',async()=>{
 fixture.control.putDelay=2;const files=Array.from({length:50},(_,i)=>part(i+1));
 const response=await request(files);assert.equal(response.status,200);assert.deepEqual(await response.json(),{accepted:50,asOf});
 assert.equal(fixture.metrics.reads,3);assert.equal(fixture.metrics.batches,1);assert.equal(fixture.metrics.individualWrites,0);
 assert.equal(fixture.metrics.peakPuts,2);assert.equal(fixture.metrics.activePuts,0);assert.equal(rows().length,50);
 for(const file of files)assert.equal(fixture.objects.get(asOf+'/'+file.sha256),file.data);
});

test('invalid final file is rejected before any object or metadata write',async()=>{
 const files=[part(1),{...part(2),sha256:'0'.repeat(64)}];assert.equal((await request(files)).status,400);
 assert.equal(fixture.metrics.puts,0);assert.equal(fixture.metrics.batches,0);assert.equal(rows().length,0);
});

test('duplicate paths and existing hash conflicts are rejected before storage',async()=>{
 assert.equal((await request([part(1),part(1)])).status,400);assert.equal(fixture.metrics.puts,0);
 fixture.sqlite.prepare('INSERT INTO replica_files VALUES(?,?,?,?)').run(asOf,'daily/1.json','0'.repeat(64),0);
 assert.equal((await request([part(1)])).status,409);assert.equal(fixture.metrics.puts,0);
});

test('R2 failure drains sibling operations and does not commit metadata or an acknowledgement',async()=>{
 fixture.control.putDelay=10;fixture.control.failPut=0;
 const response=await request(Array.from({length:8},(_,i)=>part(i+1)));
 assert.equal(response.status,503);assert.equal(fixture.metrics.activePuts,0);assert.equal(fixture.metrics.puts,2);
 assert.equal(fixture.metrics.batches,0);assert.equal(rows().length,0);
 assert.doesNotMatch(await response.text(),/SYNTHETIC_PRIVATE/);
 fixture.control.failPut=null;assert.equal((await request(Array.from({length:8},(_,i)=>part(i+1)))).status,200);
});

test('metadata failure has no partial index and retry safely reuses immutable objects',async()=>{
 fixture.control.failBatch=true;assert.equal((await request([part(1),part(2)])).status,503);assert.equal(rows().length,0);
 fixture.control.failBatch=false;assert.equal((await request([part(1),part(2)])).status,200);assert.equal(rows().length,2);
});

test('racing incompatible metadata cannot produce a false accepted receipt or overwrite its predecessor',async()=>{
 fixture.control.beforeBatch=sqlite=>sqlite.prepare('INSERT INTO replica_files VALUES(?,?,?,?)').run(asOf,'daily/1.json','0'.repeat(64),0);
 assert.equal((await request([part(1)])).status,409);assert.equal(rows()[0].checksum,'0'.repeat(64));
});

test('sealed generations admit exact retries and forbid changed files or newly inserted paths',async()=>{
 const file=part(1);fixture.sqlite.prepare('INSERT INTO replica_generations VALUES(?,?,?)').run(asOf,JSON.stringify({files:[{path:file.path,sha256:file.sha256}]}),asOf);
 assert.equal((await request([file])).status,200);assert.equal((await request([part(2)])).status,409);
 assert.equal(rows().length,1);
});

test('anonymous uploads never reach a database or object operation',async()=>{
 assert.equal((await request([part(1)],false)).status,403);assert.equal(fixture.metrics.reads,0);assert.equal(fixture.metrics.puts,0);
});
