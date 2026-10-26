import {test} from 'node:test';import assert from 'node:assert/strict';import {startCollectionRelay} from '../lib/collection-relay.mjs';
const id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',job='bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
test('relay dispatches once, persists receipt, acknowledges and reuses local session',async()=>{
 let state={},calls=[],step=0,release;const first=new Promise(r=>release=r);
 const relay=startCollectionRelay({getCredential:async()=>'s'.repeat(64),loadState:async()=>state,saveState:async x=>state=x,fetchImpl:async(url,options)=>{
  calls.push({url,options});if(url.endsWith('/api/auth/session'))return Response.json({csrfToken:'local-csrf'},{headers:{'Set-Cookie':'session=local; Path=/'}});if(url.endsWith('/api/collection-progress'))return Response.json({runtimeAI:false},{headers:{'Set-Cookie':'session=local; Path=/'}});
  if(url.includes('/api/refresh-collection?'))return Response.json({job:{id:job,status:'running',runId:99}});
  if(url.endsWith('/api/refresh-collection')){assert.equal(options.headers['X-CSRF-Token'],'local-csrf');assert.equal(JSON.parse(options.body).requestId,id);release();return Response.json({job:{id:job}});}
  const body=JSON.parse(options.body);assert.equal(options.headers.Cookie,undefined);assert.equal(options.headers['X-CSRF-Token'],undefined);if(step++)assert.deepEqual(body.ack,{id,jobId:job,status:'running',runId:99});return Response.json({command:{id}});
 }});
 await first;await new Promise(r=>setTimeout(r,10));await relay.tick();relay.stop();
 assert.equal(state.jobId,job);assert.equal(calls.filter(c=>c.url.endsWith('/api/refresh-collection')).length,1);
 assert.equal(calls.find(c=>c.url.endsWith('/api/refresh-collection')).options.headers.Cookie,'session=local');
});
