import test from 'node:test';
import assert from 'node:assert/strict';
import { syncWorkSourceBatch } from '../scripts/sync-work-source-workbooks.mjs';
const sources=[{title:'one',url:'https://fixture.feishu.cn/sheets/FixtureWorkbook0001'},
  {title:'two',url:'https://fixture.feishu.cn/sheets/FixtureWorkbook0002'}];
test('source read failures are isolated while independent sources continue',async()=>{
  const calls=[];
  const result=await syncWorkSourceBatch({sources,mode:'preview',sync:async({sourceUrl})=>{
    calls.push(sourceUrl);if(calls.length===1)throw new Error('work-source-authorized-read-failed');
    return {status:'would-import',factCount:2};
  }});
  assert.equal(result.failed,1);assert.equal(calls.length,2);assert.equal(result.results[1].status,'would-import');
});
test('a shared missing backup stops further expensive reads instead of repeating impossible commits',async()=>{
  let calls=0;
  const result=await syncWorkSourceBatch({sources,mode:'commit',sync:async()=>{
    calls++;throw new Error('work-source-backup-validation-failed');
  }});
  assert.equal(calls,1);assert.equal(result.failed,1);assert.equal(result.deferred,1);
});
test('arbitrary upstream messages are not printed as errors or credentials',async()=>{
  const result=await syncWorkSourceBatch({sources:sources.slice(0,1),sync:async()=>{throw new Error('Bearer secret-value');}});
  assert.equal(result.results[0].errorCode,'work-source-sync-failed');
  assert.ok(!JSON.stringify(result).includes('secret-value'));
});
