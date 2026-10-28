import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {ingestFixture} from './helpers/replica-ingest-fixture.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const result=await build({entryPoints:[root+'app/api/replica/route.ts'],bundle:true,write:false,format:'esm',platform:'node',alias:{'@':root},plugins:[{name:'test-cloud',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cloud',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const env=globalThis.__mcnIngestFixture;',loader:'js'}));}}]});
const producer='synthetic-producer-secret-'.repeat(3),fixture=ingestFixture(producer);
globalThis.__mcnIngestFixture=fixture.env;
test.after(()=>fixture.close());
const {POST}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const asOf='2026-10-28T01:00:00.000Z';
function part(path,n){const data=JSON.stringify({asOf,items:[],label:'x'.repeat(n)});return {path,data,sha256:createHash('sha256').update(data).digest('hex')};}
const request=(files,auth=true)=>POST(new Request('https://example.test/api/replica',{method:'POST',headers:{...(auth?{Authorization:'Bearer '+producer}:{}),'Content-Type':'application/json'},body:JSON.stringify({action:'upload',asOf,files})}));
test('anonymous uploads remain denied regardless of directory size',async()=>assert.equal((await request([part('catalog.json',4100000)],false)).status,403));
test('growing catalog above 4 MB is accepted and written intact',async()=>{const f=part('catalog.json',4100000);assert.equal((await request([f])).status,200);assert.equal(Buffer.byteLength(fixture.objects.get(asOf+'/'+f.sha256)),Buffer.byteLength(f.data));});
test('work partitions retain 4 MB limit and ordinary multi-file batches retain 7.5 MB',async()=>{assert.equal((await request([part('works/1.json',4100000)])).status,400);assert.equal((await request([part('works/1.json',3900000),part('works/2.json',3900000)])).status,413);});
test('catalog is still bounded',async()=>assert.equal((await request([part('catalog.json',8100000)])).status,400));

test('upload limit counts UTF-8 bytes instead of JavaScript character count',async()=>{const f=part('catalog.json',0);f.data=JSON.stringify({asOf,label:'汉'.repeat(4000000)});f.sha256=createHash('sha256').update(f.data).digest('hex');assert.equal((await request([f])).status,413);});
