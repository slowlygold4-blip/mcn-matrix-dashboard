import test from 'node:test';
import assert from 'node:assert/strict';
import { publicSourceWorkFields, publicSourceWorkFieldsValid } from '../lib/public-replica-source-work.mjs';

const at='2026-10-24T06:00:00.000Z';
test('merged work exports source fallback counters and date without duplicating a platform row',()=>{
 const work={source:'platform-and-creator-source',sourceCumulativeLikes:0,sourceCumulativePlays:450,
  sourceRefreshedAt:'2026-10-22T02:00:00Z',sourcePublishedOn:'2026-10-12',
  provenance:{importId:1,revision:'1697',row:35,raw:{cookie:'NEVER_PUBLIC'},url:'https://private.invalid/?token=[REDACTED]',references:['NEVER_PUBLIC']}};
 const result=publicSourceWorkFields(work,at);
 assert.equal(result.sourceCumulativeLikes,0);
 assert.equal(result.sourceCumulativePlays,450);
 assert.equal(result.sourceRefreshedAt,'2026-10-22T02:00:00.000Z');
 assert.equal(result.sourceRow,35);
 assert.equal(JSON.stringify(result).includes('NEVER_PUBLIC'),false);
 assert.equal('provenance' in result,false);
 assert.equal(publicSourceWorkFieldsValid({id:1,externalId:'7300000000000000001',...result},at),true);
 assert.equal(publicSourceWorkFieldsValid({id:1,externalId:'7300000000000000001',...result,sourceRefreshedAt:'2027-01-01T00:00:00.000Z'},at),false);
 assert.equal(publicSourceWorkFieldsValid({id:1,externalId:'7300000000000000001',...result,sourceCumulativeLikes:-1},at),false);
 assert.equal(publicSourceWorkFieldsValid({id:'creator-source:1:35',externalId:'7300000000000000001',...result},at),false);
});
test('source-only, missing values and future refresh timestamps never become fabricated platform samples',()=>{
 const result=publicSourceWorkFields({source:'creator-source',sourceCumulativeLikes:null,sourceCumulativePlays:NaN,
  sourceRefreshedAt:'2026-10-25T00:00:00Z',provenance:{revision:'https://private.invalid/?secret=x'}},at);
 assert.equal(result.source,'creator-source');
 assert.equal(result.sourceCumulativeLikes,null);
 assert.equal(result.sourceCumulativePlays,null);
 assert.equal(result.sourceRefreshedAt,null);
 assert.equal(result.sourceRevision,null);
 assert.deepEqual(publicSourceWorkFields({source:'untrusted',sourceCumulativePlays:100},at),{});
 assert.deepEqual(publicSourceWorkFields({likes:5},at),{});
});
