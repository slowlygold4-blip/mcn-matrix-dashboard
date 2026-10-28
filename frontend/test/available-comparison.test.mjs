import test from 'node:test';
import assert from 'node:assert/strict';
import {availableComparison} from '../lib/available-comparison.mjs';
import {rowsFor} from '../lib/replica-model.mjs';
const account=(id,enabled=true)=>({id,enabled});
const point=(targetId,date,value=10)=>({targetId,date,capturedAt:date+'T03:00:00.000Z',followers:value,likes:value,posts:value});
test('missing business baseline offers a genuine shared pair without fabricating deltas',()=>{
 const a=[account(1),account(2),account(3)],p=[point(1,'2026-10-20'),point(1,'2026-10-24',12),point(2,'2026-10-20'),point(2,'2026-10-24',9),point(3,'2026-10-28')];
 const before=JSON.stringify(p),w=availableComparison(a,p,'2026-09-12','2026-10-28');
 assert.deepEqual(w,{start:'2026-10-20',end:'2026-10-24',count:2,total:3});
 assert.ok(rowsFor(a,p,'2026-09-12','2026-10-28').every(a=>a.metrics.followers.delta===null));
 assert.deepEqual(rowsFor(a,p,w.start,w.end).map(a=>a.metrics.followers.delta),[2,-1,null]);
 assert.equal(JSON.stringify(p),before);
});
test('ties favor latest end then earliest start; disabled and incomplete vectors excluded',()=>{
 const a=[account(1),account(2,false),account(3)],p=['2026-10-20','2026-10-21','2026-10-24'].flatMap(d=>[point(1,d),point(2,d),{...point(3,d),likes:null}]);
 assert.deepEqual(availableComparison(a,p,'2026-09-12','2026-10-28'),{start:'2026-10-20',end:'2026-10-24',count:1,total:2});
 assert.equal(availableComparison(a,p,'2026-10-20','2026-10-24'),null);
});
test('bitset boundary accounts, zero counters, sparse dates and invalid data',()=>{
 const a=Array.from({length:70},(_,i)=>account(i+1)),p=a.flatMap(a=>[point(a.id,'2026-10-20',0),point(a.id,'2026-10-22',1)]);
 assert.equal(availableComparison(a,p,'2026-09-12','2026-10-28').count,70);
 assert.equal(availableComparison(a,[point(1,'2026-10-20')],'2026-09-12','2026-10-28'),null);
 assert.throws(()=>availableComparison(a,[p[0],p[0]],'2026-09-12','2026-10-28'),/重复/);
 assert.equal(availableComparison(a,p,'invalid','2026-10-28'),null);
});
