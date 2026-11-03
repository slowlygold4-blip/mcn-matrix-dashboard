import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceFollowsLatest,workspacePeriodWindow} from '../lib/replica-periods.mjs';
import {workspaceSelection,workspaceSelectionPath,workspacePath} from '../lib/replica-navigation.mjs';
const selected={board:'all',theme:'all',tag:'all',period:'week',start:'2026-10-24',end:'2026-10-31'};
const account=date=>({id:1,enabled:true,latest:{followers:{value:0,date,observedAt:date+'T01:00:00.000Z'}}});
test('explicit live week advances with actual new observations and not a computer clock',()=>{
 const s={...selected,followLatest:true};
 const a=workspacePeriodWindow(s,[account('2026-10-31')],[],'2026-10-31T02:00:00.000Z',{dateIndexed:true});
 const b=workspacePeriodWindow(s,[account('2026-11-01')],[],'2026-11-01T02:00:00.000Z',{dateIndexed:true});
 assert.deepEqual([a.start,a.end],['2026-10-24','2026-10-31']);
 assert.deepEqual([b.start,b.end],['2026-10-25','2026-11-01']);assert.match(b.note,/随最新已保存观察推进/);
 assert.equal(workspacePeriodWindow(s,[account('2026-10-31')],[],'2026-11-03T02:00:00.000Z',{dateIndexed:true}).end,'2026-10-31');
});
test('a following month crosses a calendar boundary without borrowing old totals or manufacturing samples',()=>{
 const s={...selected,period:'month',followLatest:true};
 const w=workspacePeriodWindow(s,[account('2026-11-01')],[],'2026-11-01T02:00:00.000Z',{dateIndexed:true});
 assert.deepEqual([w.start,w.end],['2026-10-31','2026-11-01']);
 const empty=workspacePeriodWindow(s,[account('2026-10-31')],[],'2026-11-01T02:00:00.000Z',{dateIndexed:true});
 assert.match(empty.note,/本月尚无样本/);assert.equal(empty.end,'2026-11-01');
});
test('legacy dated relative links, explicit freeze, custom and observed windows remain fixed',()=>{
 for(const s of [selected,{...selected,followLatest:false},{...selected,period:'custom'},{...selected,period:'observed'},{...selected,period:'since',followLatest:false}]){
  const w=workspacePeriodWindow(s,[account('2026-11-01')],[],'2026-11-01T02:00:00.000Z',{dateIndexed:true});
  assert.deepEqual([w.start,w.end,w.followLatest],[selected.start,selected.end,false]);
 }
 assert.equal(workspaceFollowsLatest({...selected,period:'since'}),true);
 assert.equal(workspaceFollowsLatest({...selected,start:null,end:null}),true);
 assert.equal(workspaceFollowsLatest(null),true);
});
test('follow choice survives address, task navigation and comparison without changing fixed account links',()=>{
 for(const followLatest of [true,false]){
  const selection={...selected,followLatest},path=workspaceSelectionPath('/','overview',selection,undefined,{compare:true,otherStart:'2026-09-20',otherEnd:'2026-09-27'});
  assert.deepEqual(workspaceSelection('?'+path.split('?')[1].split('#')[0]),selection);
  const next=workspacePath('/','topics','?'+path.split('?')[1].split('#')[0]);
  assert.equal(new URL(next,'https://synthetic.invalid').searchParams.get('followLatest'),followLatest?'1':'0');
 }
 assert.equal(workspaceSelection('?account=1&followLatest=1'),null);
});
test('ambiguous or incompatible follow flags are rejected, while no observation remains missing',()=>{
 for(const search of ['?period=week&followLatest=yes','?period=week&followLatest=1&followLatest=0','?period=custom&start=2026-10-01&end=2026-10-02&followLatest=1','?period=observed&followLatest=1'])assert.throws(()=>workspaceSelection(search));
 const w=workspacePeriodWindow({...selected,followLatest:true},[],[],'2026-11-01T02:00:00.000Z',{dateIndexed:true});
 assert.equal(w.start,null);assert.equal(w.end,null);
});
