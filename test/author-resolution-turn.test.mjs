import test from 'node:test';import assert from 'node:assert/strict';
import {MonitorDatabase} from '../lib/database.mjs';import {buildAuthorEvidenceRequests} from '../lib/author-resolution.mjs';import {claimAuthorResolutionTurn} from '../lib/author-resolution-turn.mjs';
test('full roster gets a turn alongside older retries without duplicating one identity',t=>{
 const d=new MonitorDatabase(':memory:');t.after(()=>d.close());
 const add=(handle,file)=>d.enqueueAuthorResolutions(buildAuthorEvidenceRequests([{name:handle,douyinId:handle,videoId:'7690702905876096104'}]),{fileName:file});
 add('older1','older.xlsx');add('older2','older.xlsx');add('newsource','一条小团团切片作品登记表-来源数据集');
 const first=claimAuthorResolutionTurn(d,{owner:'fair-turn',leaseMs:60000});
 assert.equal(first.length,2);assert.equal(first[0].douyin_id,'newsource');assert.equal(first[1].douyin_id,'older1');
 const next=claimAuthorResolutionTurn(d,{owner:'second-turn',leaseMs:60000});assert.equal(next.length,1);assert.equal(next[0].douyin_id,'older2');
 assert.equal(d.db.prepare('select count(*) n from snapshots').get().n,0);
});
