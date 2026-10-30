import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {frontendRuntime} from '../scripts/frontend-runtime.mjs';
import {forwardReadOnlyFrontend} from '../lib/standalone-readonly.mjs';
import {verifyPublishedDirectory} from '../scripts/verify-published-data.mjs';
import {publishedFixture} from './helpers/published-fixture.mjs';
import {createHash} from 'node:crypto';

test('runtime selection refuses incomplete hosting rather than silently changing a deployment',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mcn-runtime-'));
 try{
  assert.equal(frontendRuntime(root,'auto'),'standalone');assert.throws(()=>frontendRuntime(root,'other'));assert.throws(()=>frontendRuntime(root,'sites'));
  await mkdir(join(root,'.openai'));await writeFile(join(root,'.openai/hosting.json'),'{}');assert.throws(()=>frontendRuntime(root,'auto'),/incomplete/);
  assert.equal(frontendRuntime(root,'standalone'),'standalone');
  await mkdir(join(root,'build'));for(const file of ['sites-vite-plugin.ts','sites-worker.ts','connector-preview-plugin.mjs','connector-preview-worker.mjs'])await writeFile(join(root,'build',file),'');
  assert.equal(frontendRuntime(root,'auto'),'sites');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('readonly bridge makes one GET and preserves sealed headers without forwarding credentials',async()=>{
 let calls=0;const request=new Request('http://localhost/api/replica?generation=x&part=catalog.json',{headers:{Cookie:'PRIVATE_COOKIE',Authorization:'Bearer PRIVATE_TOKEN'}});
 const result=await forwardReadOnlyFrontend(request,{origin:'https://example.test',fetcher:async(url,options)=>{
  calls++;assert.equal(url.href,'https://example.test/api/replica?generation=x&part=catalog.json');assert.deepEqual(options.headers,{Accept:'application/json'});assert.equal(options.redirect,'manual');return Response.json({ok:true},{headers:{'X-Data-SHA256':'a'.repeat(64),'X-Data-Cutoff':'2026-10-23T00:00:00.000Z','Set-Cookie':'PRIVATE_RESPONSE'}});
 }});
 assert.equal(calls,1);assert.equal(result.status,200);assert.equal(result.headers.get('X-Data-SHA256'),'a'.repeat(64));assert.equal(result.headers.get('Set-Cookie'),null);assert.deepEqual(await result.json(),{ok:true});
});
test('writes, arbitrary destinations, redirects, oversized and unavailable data never become a successful preview',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return Response.json({});};
 for(const method of ['POST','PUT','DELETE'])assert.equal((await forwardReadOnlyFrontend(new Request('http://localhost/api/collection',{method}),{origin:'https://example.test',fetcher})).status,405);
 for(const origin of ['', 'https://user:pass@example.test','https://example.test/path','http://remote.example'])assert.equal((await forwardReadOnlyFrontend(new Request('http://localhost/api/replica'),{origin,fetcher})).status,503);
 assert.equal(calls,0);
 for(const response of [new Response(null,{status:302,headers:{Location:'https://elsewhere.test'}}),new Response('<html>login</html>'),Response.json({large:'abcdef'})])assert.equal((await forwardReadOnlyFrontend(new Request('http://localhost/api/replica'),{origin:'https://example.test',maxBytes:2,fetcher:async()=>response})).status,502);
});
test('published verification is explicit, verifies seals and counts and never modifies sample files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mcn-published-')),sample=publishedFixture();
 try{
  for(const section of ['creator-source','table-foundation']){
   await mkdir(join(root,section));const index=sample.read(section,'index.json');await writeFile(join(root,section,'index.json'),sample.bytes(section,'index.json'));
   for(const file of index.files)await writeFile(join(root,section,file.path),sample.bytes(section,file.path));
  }
  const file=join(root,'creator-source/authors.json'),before=await readFile(file);
  const result=await verifyPublishedDirectory(root,{expectedRevision:'synthetic-fixture'});assert.equal(result.authors,5);assert.equal(result.works,3);assert.equal(result.readOnly,true);assert.deepEqual(await readFile(file),before);
  await assert.rejects(verifyPublishedDirectory(root,{expectedRevision:'other'}),/revision/);
  await writeFile(file,before.toString().replace('fixture_a','fixture_z'));await assert.rejects(verifyPublishedDirectory(root),/seal/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('legacy sealed parts without version remain valid but an explicit unknown version is rejected',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mcn-legacy-published-')),sample=publishedFixture();
 try{
  for(const section of ['creator-source','table-foundation']){
   await mkdir(join(root,section));const index=sample.read(section,'index.json');
   for(const file of index.files){const body=sample.read(section,file.path);delete body.version;const bytes=Buffer.from(JSON.stringify(body)+'\n');file.bytes=bytes.length;file.sha256=createHash('sha256').update(bytes).digest('hex');await writeFile(join(root,section,file.path),bytes);}
   await writeFile(join(root,section,'index.json'),JSON.stringify(index));
  }
  assert.equal((await verifyPublishedDirectory(root)).works,3);
  const path=join(root,'creator-source/authors.json'),body=JSON.parse(await readFile(path));body.version=2;const bytes=Buffer.from(JSON.stringify(body)+'\n');await writeFile(path,bytes);
  const indexPath=join(root,'creator-source/index.json'),index=JSON.parse(await readFile(indexPath)),file=index.files.find(f=>f.path==='authors.json');file.bytes=bytes.length;file.sha256=createHash('sha256').update(bytes).digest('hex');await writeFile(indexPath,JSON.stringify(index));
  await assert.rejects(verifyPublishedDirectory(root),/part-contract/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('readonly bridge has a whole-request deadline even when the upstream never settles',async()=>{
 const result=await forwardReadOnlyFrontend(new Request('http://localhost/api/replica'),{origin:'https://example.test',timeoutMs:10,fetcher:()=>new Promise(()=>{})});assert.equal(result.status,502);
 const controller=new AbortController();controller.abort();let calls=0;
 assert.equal((await forwardReadOnlyFrontend(new Request('http://localhost/api/replica',{signal:controller.signal}),{origin:'https://example.test',fetcher:async()=>{calls++;return Response.json({});}})).status,502);assert.equal(calls,0);
});
