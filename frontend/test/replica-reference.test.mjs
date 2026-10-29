import test from'node:test';import assert from'node:assert/strict';import{createHash}from'node:crypto';import{referenceCandidate,referenceHeadMatches,readReplicaText}from'../lib/replica-reference.mjs';
const A='2026-10-29T01:00:00.000Z',B='2026-10-29T02:00:00.000Z',C='2026-10-29T03:00:00.000Z',hash=t=>createHash('sha256').update(t).digest('hex');
function file(asOf,{value='中文🎉',suffix='\n'}={}){const data=JSON.stringify({version:1,asOf,items:[{value,observedAt:A}]})+suffix;return{data,sha256:hash(data),checksum:hash(data),bytes:Buffer.byteLength(data)};}
test('asOf rebasing reconstructs exact UTF8 bytes while keeping observation dates unchanged',async()=>{
 const a=file(A),b=file(B),ref=referenceCandidate(b,a,A,B);assert.ok(ref);assert.equal(ref.data,a.data);assert.equal(ref.source_checksum,a.sha256);assert.equal(ref.source_bytes,a.bytes);
 assert.equal(referenceHeadMatches({size:a.bytes,etag:createHash('md5').update(a.data).digest('hex')},ref),true);
 const bucket={get:async key=>{assert.equal(key,A+'/'+a.sha256);return{size:a.bytes,text:async()=>a.data};}};
 assert.equal(await readReplicaText(bucket,B,b,ref),b.data);assert.equal(JSON.parse(b.data).items[0].observedAt,A);
});
test('three generations flatten their storage reference to the original immutable bytes',async()=>{
 const a=file(A,{suffix:''}),b=file(B,{suffix:''}),c=file(C,{suffix:''});const first=referenceCandidate(b,a,A,B),next=referenceCandidate(c,{...b,...first,checksum:b.sha256,bytes:b.bytes},B,C);
 assert.ok(next);assert.equal(next.source_generation,A);assert.equal(next.source_checksum,a.sha256);assert.equal(next.data,a.data);
});
test('changes, noncanonical whitespace, bad metadata and unsafe clocks force materialization',()=>{
 const a=file(A),b=file(B);for(const [f,p,t]of [[file(B,{value:'changed'}),a,A],[{...b,data:' '+b.data},a,A],[b,{...a,checksum:'0'.repeat(64)},A],[b,a,B],[b,a,'invalid'],[b,{...a,source_generation:C,source_checksum:a.sha256,source_bytes:a.bytes},A]])assert.equal(referenceCandidate(f,p,t,B),null);
 assert.equal(referenceHeadMatches(null,{}),false);assert.equal(referenceHeadMatches({size:1,etag:'bad'},{source_bytes:1,etag:'good'}),false);
});
test('missing, tampered, misdated and mismatched stored references never become public data',async()=>{
 const a=file(A),b=file(B),ref=referenceCandidate(b,a,A,B);
 assert.equal(await readReplicaText({get:async()=>null},B,b,ref),undefined);
 for(const [text,r,m]of [[a.data+'x',ref,b],[a.data,{...ref,source_generation:C},b],[a.data,ref,{...b,sha256:'0'.repeat(64)}],[a.data,{...ref,trailing_newline:0},b]])await assert.rejects(readReplicaText({get:async()=>({text:async()=>text})},B,m,r),e=>e.code==='replica-storage-repair');
});
