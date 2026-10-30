import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectPostIngestionReviews} from '../lib/post-ingestion-review.mjs';
import {normalizePostIngestionSelection} from '../lib/post-ingestion-selection.mjs';

function ledger(t){
 const dir=mkdtempSync(join(tmpdir(),'review-selection-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 for(let runId=1;runId<=6;runId++)writeFileSync(join(dir,`run-${runId}.json`),JSON.stringify({version:1,eventId:`collection-run-${runId}`,runId,businessDate:'2026-10-31',reviewedAt:'2026-10-30T18:00:00.000Z',snapshotCount:1,deterministicReview:{status:'passed'},productReview:{status:'pending'},account:{profileUsable:1},topics:{usable:0},findings:[]}));
 for(const runId of [2,5])writeFileSync(join(dir,`reviewed-${runId}.json`),JSON.stringify({version:1,runId,status:'completed',completedAt:'2026-10-30T18:01:00.000Z',evidence:['fixture-evidence.md']}));
 return dir;
}

test('recent pending reviews are reachable without altering original events or global queue totals',async t=>{
 const ledgerDir=ledger(t),before=new Map(readdirSync(ledgerDir).map(name=>[name,readFileSync(join(ledgerDir,name))]));
 const result=await inspectPostIngestionReviews({ledgerDir,selection:{state:'pending',order:'newest',limit:2}});
 assert.deepEqual(result.reviews.map(r=>r.runId),[6,4]);assert.equal(result.totalPending,4);assert.equal(result.totalCompleted,2);
 for(const[name,bytes]of before)assert.ok(bytes.equals(readFileSync(join(ledgerDir,name))));
});

test('exclusive cursors page every matching event exactly once in either direction and retain both bounds',async t=>{
 const ledgerDir=ledger(t);
 for(const[selection,wanted]of [[{state:'pending',order:'oldest',limit:2},[1,3,4,6]],
  [{state:'completed',order:'newest',limit:1},[5,2]],
  [{state:'all',order:'newest',limit:2,afterRunId:2,beforeRunId:6},[5,4,3]]]){
  let next=selection,seen=[];for(let page=0;next&&page<10;page++){
   const result=await inspectPostIngestionReviews({ledgerDir,selection:next});seen.push(...result.reviews.map(r=>r.runId));
   assert.equal(result.pagination.returned,result.reviews.length);assert.equal(result.totalPending,4);assert.equal(result.totalCompleted,2);
   next=result.pagination.next?normalizePostIngestionSelection(new URLSearchParams(result.pagination.next)):null;
  }
  assert.equal(next,null);assert.deepEqual(seen,wanted);assert.equal(new Set(seen).size,seen.length);
 }
});

test('no-query legacy order and global recent completions remain unchanged; empty matches are explicit',async t=>{
 const ledgerDir=ledger(t),legacy=await inspectPostIngestionReviews({ledgerDir,limit:3});
 assert.deepEqual(legacy.reviews.map(r=>r.runId),[1,3,4]);assert.equal(Object.hasOwn(legacy,'pagination'),false);
 const empty=await inspectPostIngestionReviews({ledgerDir,selection:{state:'pending',afterRunId:99}});
 assert.equal(empty.totalPending,4);assert.deepEqual(empty.reviews,[]);assert.equal(empty.pagination.matched,0);assert.equal(empty.pagination.next,null);
 assert.deepEqual(empty.completedReviews.map(r=>r.runId),[5,2]);
 const absent=await inspectPostIngestionReviews({ledgerDir:join(ledgerDir,'absent'),selection:{limit:1}});
 assert.equal(absent.status,'empty');assert.equal(absent.pagination.matched,0);
});

test('bad selectors fail before touching storage, including duplicate parameters, unsafe integers and inverted bounds',async t=>{
 const ledgerDir=join(ledger(t),'not-a-directory');writeFileSync(ledgerDir,'fixture');
 for(const input of ['limit=0','limit=101','limit=1.5','limit=01','limit=', 'afterRunId=0','beforeRunId=9007199254740992',
  'afterRunId=10&beforeRunId=10','order=random','state=reviewed','limit=1&limit=2','unexpected=1']){
  assert.throws(()=>normalizePostIngestionSelection(new URLSearchParams(input)),error=>error.status===400,input);
 }
 for(const selection of [{limit:0},{limit:true},{afterRunId:-1},[],new Date()])
  await assert.rejects(inspectPostIngestionReviews({ledgerDir,selection}),error=>error.status===400);
});

test('unselected corrupt completion receipts cannot be counted as reviewed or hidden by paging',async t=>{
 const ledgerDir=ledger(t);writeFileSync(join(ledgerDir,'reviewed-2.json'),'{}');
 await assert.rejects(inspectPostIngestionReviews({ledgerDir,selection:{state:'pending',afterRunId:5,limit:1}}),/Invalid product-review/);
 assert.equal(readFileSync(join(ledgerDir,'reviewed-2.json'),'utf8'),'{}');
});
