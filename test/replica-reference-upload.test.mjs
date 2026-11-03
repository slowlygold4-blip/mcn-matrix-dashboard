import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {compactReplicaUpload,createReplicaUploadCompactor} from '../lib/replica-reference-upload.mjs';
const A='2026-11-03T00:00:00.000Z',B='2026-11-03T01:00:00.000Z';
const hash=t=>createHash('sha256').update(t).digest('hex');
const file=(asOf,path='works/1.json',items=[{name:'中文😀',likes:0,observedAt:A}],suffix='\n')=>{
 const data=JSON.stringify({version:1,asOf,items})+suffix;return{path,data,sha256:hash(data),bytes:Buffer.byteLength(data)};
};
test('only an exact old public hash turns into a compact reference, with no mutation or observation-date change',()=>{
 const old=file(A),current=file(B),previous={asOf:A,files:[old]},before=JSON.stringify([previous,current]);
 const result=compactReplicaUpload([current],B,previous);
 assert.deepEqual(result,{files:[{path:current.path,sha256:current.sha256,bytes:current.bytes}],referenceGeneration:A,compacted:1});
 assert.equal(JSON.stringify([previous,current]),before);
 assert.equal(JSON.parse(current.data).items[0].observedAt,A);
});
test('changed values, bad bodies and metadata, unknown paths or later generations retain complete uploads',()=>{
 const old=file(A),current=file(B);
 for(const previous of [null,{asOf:B,files:[old]},{asOf:'invalid',files:[old]},{asOf:A,files:[null]},
  {asOf:A,files:[{...old,sha256:'0'.repeat(64)}]},{asOf:A,files:[{...old,bytes:1}]}])assert.deepEqual(compactReplicaUpload([current],B,previous),{files:[current]});
 for(const candidate of [file(B,'works/1.json',[{likes:1}]),file(B,'works/2.json'),{...current,data:' '+current.data},
  {...current,data:'broken'},{...current,sha256:'0'.repeat(64)}])assert.deepEqual(compactReplicaUpload([candidate],B,{asOf:A,files:[old]}),{files:[candidate]});
});
test('one immutable index supports mixed batches and preserves the exact unchanged file ordering',()=>{
 const previous={asOf:A,files:[file(A),file(A,'works/2.json')]},inputs=[file(B),file(B,'works/2.json',[{likes:null}])];
 const compact=createReplicaUploadCompactor(B,previous),a=compact(inputs);
 assert.equal(a.compacted,1);assert.deepEqual(a.files[1],inputs[1]);assert.equal(a.files[0].path,inputs[0].path);
 assert.deepEqual(compact(inputs),a);assert.ok(JSON.stringify(a.files).length<JSON.stringify(inputs).length);
});
