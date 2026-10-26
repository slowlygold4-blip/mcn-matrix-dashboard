import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadReplicaView} from '../lib/replica-view.mjs';

const asOf='2026-10-24T03:54:30.305Z';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const base={asOf,timeZone:'Asia/Shanghai',counts:{daily:0},files:[]};
const index={version:1,asOf,timeZone:'Asia/Shanghai',format:'date-shards-v1',sourceManifestSha256:digest(base),sourceDaily:[],count:0,firstDate:null,lastDate:null,shards:[]};
const manifest={...base,files:[{path:'date-summary-index.json',kind:'summaryDateIndex',count:0,bytes:Buffer.byteLength(JSON.stringify(index)),sha256:digest(index)}]};

test('date index begins beside catalog and topics, is read once, and keeps a complete receipt',async()=>{
 let releaseCatalog;const calls=[];
 const readPart=path=>{calls.push(path);if(path==='catalog.json')return new Promise(resolve=>{releaseCatalog=resolve;});if(path==='topics.json')return Promise.resolve({topics:[],items:[]});if(path==='date-summary-index.json')return Promise.resolve(index);throw Error('unexpected part '+path);};
 const pending=loadReplicaView({manifest,readPart});
 assert.deepEqual(calls,['date-summary-index.json','catalog.json','topics.json'],'index should not wait behind catalog');
 releaseCatalog({accounts:[],boards:[]});
 const result=await pending;
 assert.equal(result.summaryLoaded,true);
 assert.equal(result.dateIndexed,true);
 assert.equal(result.receipt.complete,true);
 assert.deepEqual(result.points,[]);
 assert.equal(calls.filter(path=>path==='date-summary-index.json').length,1);
});

test('a failed prefetched index leaves catalog and topics independently readable',async()=>{
 const readPart=path=>path==='date-summary-index.json'?Promise.reject(Error('synthetic index outage')):Promise.resolve(path==='catalog.json'?{accounts:[],boards:[]}:{topics:[],items:[]});
 const result=await loadReplicaView({manifest,readPart});
 assert.equal(result.summaryLoaded,false);
 assert.match(result.summaryError,/synthetic index outage/);
 assert.deepEqual(result.accounts,[]);
 assert.deepEqual(result.topics,{topics:[],items:[]});
});

test('a synchronously rejected index also leaves the directory readable',async()=>{
 const readPart=path=>{if(path==='date-summary-index.json')throw Error('missing index descriptor');return Promise.resolve(path==='catalog.json'?{accounts:[],boards:[]}:{topics:[],items:[]});};
 const result=await loadReplicaView({manifest,readPart});
 assert.equal(result.summaryLoaded,false);
 assert.match(result.summaryError,/missing index descriptor/);
 assert.deepEqual(result.accounts,[]);
});

test('since 9/12 is a rolling window even when an old shared URL contains an end date',async()=>{
 const account={id:1,enabled:true,boardKeys:[],latest:{followers:{value:10,date:'2026-10-24',observedAt:'2026-10-24T02:00:00.000Z'}}};
 const readPart=path=>Promise.resolve(path==='catalog.json'?{accounts:[account],boards:[]}:path==='topics.json'?{topics:[],items:[]}:index);
 const result=await loadReplicaView({manifest,readPart,workspace:{board:'all',theme:'all',tag:'all',period:'since',start:'2026-09-12',end:'2026-10-12'}});
 assert.equal(result.dateWindow?.end,'2026-10-24');assert.equal(result.dateWindow?.start,'2026-09-12');
 const fixed=await loadReplicaView({manifest,readPart,workspace:{board:'all',theme:'all',tag:'all',period:'custom',start:'2026-09-12',end:'2026-10-12'}});
 assert.equal(fixed.dateWindow?.end,'2026-10-12');
});
