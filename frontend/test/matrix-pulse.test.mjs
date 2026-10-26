import {test} from 'node:test';import assert from 'node:assert/strict';import {matrixPulse} from '../lib/matrix-pulse.mjs';
const row=(id,delta,enabled=true)=>({id,enabled,label:'A'+id,metrics:{followers:{delta},likes:{delta:null},posts:{delta:0}}});
test('net equals gains plus losses; missing is separate; duplicates and paused do not inflate totals',()=>{
 const rows=[row(1,100),row(2,-40),row(3,0),row(4,null),row(5,999,false)];const roster={rows:rows.map(a=>({accounts:[a]})).concat({accounts:[rows[0]]},{accounts:[]})};
 const p=matrixPulse(roster,rows.concat(rows[0]));assert.deepEqual([p.total,p.known,p.missing,p.net,p.positive,p.negative,p.growing,p.falling,p.flat],[4,3,1,60,100,-40,1,1,1]);assert.equal(p.topFiveShare,1);
 assert.equal(matrixPulse(roster,rows,'likes').net,null);assert.equal(matrixPulse(roster,rows,'posts').net,0);
});
test('top five denominator uses all positive gains; independent of net and loss',()=>{
 const rows=Array.from({length:6},(_,i)=>row(i+1,100)).concat(row(8,-900));const p=matrixPulse({rows:rows.map(a=>({accounts:[a]}))},rows);
 assert.equal(p.net,-300);assert.equal(p.topFiveShare,500/600);assert.equal(p.gains.length,5);assert.equal(p.losses[0].id,8);
});
