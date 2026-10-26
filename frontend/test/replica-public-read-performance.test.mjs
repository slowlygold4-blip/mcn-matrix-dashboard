import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const site=fileURLToPath(new URL('../',import.meta.url));
const output=await build({
 entryPoints:[site+'app/api/replica/route.ts'],absWorkingDir:site,bundle:true,
 write:false,format:'esm',platform:'node',target:'es2022',
 plugins:[{name:'mock-cloudflare-env',setup(bundle){
  bundle.onResolve({filter:/^cloudflare:workers$/},()=>({path:'workers',namespace:'cloudflare-test'}));
  bundle.onLoad({filter:/.*/,namespace:'cloudflare-test'},()=>({contents:'export const env=new Proxy({}, {get:(_,key)=>globalThis.__replicaTestEnv?.[key]});',loader:'js'}));
 }}],
});
const {GET}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
const generation='2026-10-24T03:54:30.305Z';
const sha='a'.repeat(64);
const record={generation,manifest:JSON.stringify({asOf:generation,files:[{path:'catalog.json',sha256:sha,bytes:8}]}),published_at:'2026-10-24T04:00:00.000Z'};

function fakeRuntime({published=record,object={body:'{"ok":1}'}}={}){
 const queries=[],reads=[];
 const db={prepare(sql){const params=[];queries.push({sql,params});return {
  bind(...items){params.push(...items);return this;},
  async first(){
   if(sql.includes('ORDER BY generation DESC'))return published;
   if(sql.includes('WHERE generation=?'))return params[0]===generation?published:null;
   throw Error('Unexpected SQL read: '+sql);
  },
 };}};
 const bucket={async get(key){reads.push(key);return object;}};
 globalThis.__replicaTestEnv={DB:db,BUCKET:bucket};
 return {queries,reads};
}

test('explicit immutable part performs one publication lookup and no redundant file/latest queries',async()=>{
 const state=fakeRuntime();
 const response=await GET(new Request('https://example.test/api/replica?'+new URLSearchParams({generation,part:'catalog.json'})));
 assert.equal(response.status,200);
 assert.equal(response.headers.get('X-Data-SHA256'),sha);
 assert.equal(response.headers.get('X-Data-Cutoff'),generation);
 assert.deepEqual(await response.json(),{ok:1});
 assert.equal(state.queries.length,1);
 assert.match(state.queries[0].sql,/WHERE generation=\?/);
 assert.deepEqual(state.queries[0].params,[generation]);
 assert.deepEqual(state.reads,[`${generation}/${sha}`]);
});

test('latest manifest performs one latest lookup and no bucket read',async()=>{
 const state=fakeRuntime();
 const response=await GET(new Request('https://example.test/api/replica'));
 assert.equal(response.status,200);
 const body=await response.json();
 assert.equal(body.manifest.asOf,generation);
 assert.equal(state.queries.length,1);
 assert.match(state.queries[0].sql,/ORDER BY generation DESC/);
 assert.deepEqual(state.reads,[]);
});

test('unpublished, invalid and absent parts are never served from the bucket',async()=>{
 const state=fakeRuntime();
 const invalid=await GET(new Request('https://example.test/api/replica?generation=not-a-date&part=catalog.json'));
 assert.equal(invalid.status,400);
 assert.equal(state.queries.length,0);
 const missing=await GET(new Request('https://example.test/api/replica?generation=2026-10-23T00%3A00%3A00.000Z&part=catalog.json'));
 assert.equal(missing.status,404);
 const unknown=await GET(new Request('https://example.test/api/replica?'+new URLSearchParams({generation,part:'topics.json'})));
 assert.equal(unknown.status,404);
 assert.deepEqual(state.reads,[]);
});

test('missing object does not become zero or fabricated content',async()=>{
 const state=fakeRuntime({object:null});
 const response=await GET(new Request('https://example.test/api/replica?'+new URLSearchParams({generation,part:'catalog.json'})));
 assert.equal(response.status,503);
 assert.deepEqual(state.reads,[`${generation}/${sha}`]);
});
