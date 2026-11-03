import test from 'node:test';import assert from 'node:assert/strict';
import {publisherRuntimeSnapshot,PUBLISHER_RUNTIME_REVISION} from '../lib/publisher-runtime.mjs';
const asOf='2026-11-03T12:00:00.000Z';
const options={asOf,at:asOf,validationContract:'stored-work-metric-binding-v1',exportRevision:'catalog-date-range-v20-author-search-identifiers',
 memory:{rss:100,heapUsed:50,heapTotal:70,external:20,arrayBuffers:10,untrustedSecret:'DO_NOT_COPY'}};
test('phase samples identify loaded contracts and whitelist numeric memory without mutating existing state',()=>{
 const first=publisherRuntimeSnapshot(null,'preparation-started',options),before=JSON.stringify(first);
 const second=publisherRuntimeSnapshot(first,'baseline-validated',{...options,at:'2026-11-03T12:00:01.000Z'});
 assert.equal(JSON.stringify(first),before);assert.equal(second.revision,PUBLISHER_RUNTIME_REVISION);
 assert.equal(second.validationContract,options.validationContract);assert.equal(second.samples[0].rssBytes,100);
 assert.equal(JSON.stringify(second).includes('DO_NOT_COPY'),false);assert.equal(second.samples.length,2);
});
test('retries replace their phase and never grow beyond eight fixed samples',()=>{
 let value;const phases=['preparation-started','baseline-validated','export-created','stage-written','source-sealed','sync-started','sync-finished','cycle-finished'];
 for(const phase of phases)value=publisherRuntimeSnapshot(value,phase,options);
 for(let i=0;i<100;i++)value=publisherRuntimeSnapshot(value,'sync-started',options);
 assert.equal(value.samples.length,8);assert.equal(new Set(value.samples.map(s=>s.phase)).size,8);
});
test('a new generation or loaded validation/export code cannot inherit old phase evidence',()=>{
 const first=publisherRuntimeSnapshot(null,'preparation-started',options);
 for(const change of [{asOf:'2026-11-03T12:01:00.000Z',at:'2026-11-03T12:01:00.000Z'},{validationContract:'stored-work-metric-binding-v2'},{exportRevision:'catalog-date-range-v21'}]){
  const next=publisherRuntimeSnapshot(first,'sync-started',{...options,...change});assert.equal(next.samples.length,1);assert.equal(next.samples[0].phase,'sync-started');
 }
});
test('malformed, duplicate or private old phase evidence is discarded instead of copied',()=>{
 const first=publisherRuntimeSnapshot(null,'preparation-started',options);
 for(const samples of [[{...first.samples[0],secret:'DO_NOT_COPY'}],[first.samples[0],first.samples[0]],Array.from({length:20},()=>first.samples[0])]){
  const next=publisherRuntimeSnapshot({...first,samples},'sync-started',options);assert.equal(next.samples.length,1);assert.equal(JSON.stringify(next).includes('DO_NOT_COPY'),false);
 }
});
test('invalid current samples fail with a fixed message and no private values',()=>{
 for(const extra of [{at:'bad-clock'},{at:'2026-11-03T11:59:59.999Z'},{memory:{...options.memory,rss:'DO_NOT_COPY'}},{validationContract:'PRIVATE SECRET'}]){
  assert.throws(()=>publisherRuntimeSnapshot(null,'sync-started',{...options,...extra}),{message:'invalid-publisher-runtime-sample'});
 }
 assert.throws(()=>publisherRuntimeSnapshot(null,'DO_NOT_COPY',options),{message:'invalid-publisher-runtime-sample'});
});
