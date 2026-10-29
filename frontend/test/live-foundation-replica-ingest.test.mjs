import test from 'node:test';import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';import {build} from 'esbuild';
import {ingestFixture} from './helpers/replica-ingest-fixture.mjs';
import {foundationPublication} from './helpers/foundation-publication.mjs';
import {readSourceIndex,readSourcePart} from '../lib/source-part-reader.mjs';
import {foundationEditionIdentity,loadTableFoundationEdition} from '../lib/source-edition-loader.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const compiled=await build({entryPoints:[root+'app/api/replica/route.ts'],bundle:true,write:false,format:'esm',platform:'node',alias:{'@':root},plugins:[{name:'synthetic-foundation',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cloud',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const env=globalThis.__foundationFixture;',loader:'js'}));}}]});
const producer='synthetic-foundation-only-producer-'.repeat(3),fixture=ingestFixture(producer);globalThis.__foundationFixture=fixture.env;
fixture.env.BUCKET.get=async key=>fixture.objects.has(key)?{text:async()=>fixture.objects.get(key),body:new Response(fixture.objects.get(key)).body}:null;
const prepare=fixture.env.DB.prepare;fixture.env.DB.prepare=sql=>{const statement=prepare(sql);return {...statement,first:()=>statement.bind().first()};};
const {POST,GET}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
test.beforeEach(()=>fixture.reset());test.after(()=>fixture.close());
const post=body=>POST(new Request('https://fixture.test/api/replica',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+producer},body:JSON.stringify(body)}));
async function publish(p){const upload=await post({action:'upload',asOf:p.asOf,files:p.files.map(({path,sha256,data})=>({path,sha256,data}))});assert.equal(upload.status,200,await upload.text());return post({action:'activate',asOf:p.asOf,manifest:p.manifest});}
test('new supplementary authors reach the same immutable public pipeline without a frontend build',async()=>{
 const first=foundationPublication('2026-10-29T01:00:00.000Z');assert.equal((await publish(first)).status,200);
 const fetcher=url=>GET(new Request(new URL(url,'https://fixture.test'))),old=await readSourceIndex('/table-foundation/index.json',{preferReplica:true,fetcher});
 const second=foundationPublication('2026-10-29T02:00:00.000Z',{authors:2});assert.equal((await publish(second)).status,200);
 const current=await readSourceIndex('/table-foundation/index.json',{preferReplica:true,fetcher});
 const load=index=>loadTableFoundationEdition(index,(file,revision)=>readSourcePart(file,revision,null,'/table-foundation/',{fetcher}));
 assert.equal((await load(old)).authors.length,1);assert.equal((await load(current)).authors.length,2);
 assert.notEqual(foundationEditionIdentity(old),foundationEditionIdentity(current));
 const unchanged=foundationPublication('2026-10-29T03:00:00.000Z',{authors:2});assert.equal(foundationEditionIdentity(current),foundationEditionIdentity(JSON.parse(unchanged.files.find(f=>f.path==='foundation/index.json').data)));
});
test('invalid supplementary totals cannot replace the last readable generation',async()=>{
 const first=foundationPublication('2026-10-29T01:00:00.000Z');assert.equal((await publish(first)).status,200);
 const bad=foundationPublication('2026-10-29T02:00:00.000Z',{authors:2,corrupt:true}),response=await publish(bad);assert.equal(response.status,409);assert.match(await response.text(),/补充来源.*核验失败/);
 assert.equal((await (await GET(new Request('https://fixture.test/api/replica'))).json()).manifest.asOf,first.asOf);
});
test('a foundation hash failure stays visible and does not fall back to old static files',async()=>{
 const p=foundationPublication('2026-10-29T01:00:00.000Z'),manifest={...p.manifest,files:p.manifest.files.map(f=>f.path==='foundation/index.json'?{...f,sha256:'0'.repeat(64)}:f)},calls=[];
 await assert.rejects(readSourceIndex('/table-foundation/index.json',{preferReplica:true,manifest,fetcher:async url=>{calls.push(url);return new Response(p.files.find(f=>f.path==='foundation/index.json').data);}}),/补充来源索引校验/);
 assert.equal(calls.some(url=>url.startsWith('/table-foundation/')),false);
});
test('only an explicitly older manifest without foundation partitions permits static fallback',async()=>{
 const p=foundationPublication('2026-10-29T01:00:00.000Z'),calls=[];
 await readSourceIndex('/table-foundation/index.json',{preferReplica:true,manifest:{asOf:p.asOf,files:[]},fetcher:async url=>{calls.push(url);return Response.json(p.index);}});
 assert.deepEqual(calls,['/table-foundation/index.json']);
});
