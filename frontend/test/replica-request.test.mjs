import test from'node:test';import assert from'node:assert/strict';import{gzipSync}from'node:zlib';import{readReplicaRequest}from'../lib/replica-request.mjs';
const request=(body,encoding)=>new Request('https://fixture.test',{method:'POST',headers:encoding?{'Content-Encoding':encoding}:{},body});
test('plain and gzip preserve exact UTF8 bytes, including Chinese and trailing whitespace',async()=>{
 const text=JSON.stringify({caption:'团团切片🎉',value:0})+'\n';
 assert.equal(await readReplicaRequest(request(text)),text);assert.equal(await readReplicaRequest(request(gzipSync(text),'gzip')),text);
});
test('wire and expanded size limits both reject before parsing or writing',async()=>{
 const text='x'.repeat(5000),compressed=gzipSync(text);
 await assert.rejects(readReplicaRequest(request(text),{maxBytes:4999}),e=>e.code==='too-large');
 await assert.rejects(readReplicaRequest(request(compressed,'gzip'),{maxBytes:4999}),e=>e.code==='too-large');
 await assert.rejects(readReplicaRequest(request(compressed,'gzip'),{maxBytes:10}),e=>e.code==='too-large');
 assert.equal(await readReplicaRequest(request(text),{maxBytes:5000}),text);
});
test('unsupported codecs, invalid gzip and invalid UTF8 have fixed errors',async()=>{
 for(const [body,encoding,code]of [['secret','br','unsupported-encoding'],['not-gzip','gzip','invalid-body'],[new Uint8Array([0xff]),null,'invalid-body']])await assert.rejects(readReplicaRequest(request(body,encoding)),e=>e.code===code&&!e.message.includes('secret'));
});

test('streamed UTF8 survives byte boundaries; invalid limits and oversized streams stop consumption',async()=>{
 const text='团团🎉';let at=0,canceled=false;const bytes=new TextEncoder().encode(text);
 const stream=new ReadableStream({pull(c){if(at===bytes.length)c.close();else c.enqueue(bytes.slice(at,++at));}});
 assert.equal(await readReplicaRequest(new Request('https://fixture.test',{method:'POST',body:stream,duplex:'half'})),text);
 for(const maxBytes of [0,-1,NaN,Infinity,11_500_001])await assert.rejects(readReplicaRequest(request(''),{maxBytes}),e=>e.code==='invalid-limit');
 const large=new ReadableStream({pull(c){c.enqueue(new Uint8Array(8));},cancel(){canceled=true;}});
 await assert.rejects(readReplicaRequest(new Request('https://fixture.test',{method:'POST',body:large,duplex:'half'}),{maxBytes:7}),e=>e.code==='too-large');
 await new Promise(r=>setImmediate(r));assert.equal(canceled,true);
});
