import test from 'node:test';import assert from 'node:assert/strict';
import {matchesMatrixScope,isIndependentStreamer} from '../lib/matrix-scope.mjs';
import {buildTuantuanRoster,includeOtherMatrixAccounts} from '../lib/tuantuan-roster.mjs';
import {matrixPulse} from '../lib/matrix-pulse.mjs';
const a=(id,boards,theme='tuantuan')=>({id,boardKeys:boards,platform:'douyin',enabled:true,label:String(id),classification:{theme:{key:theme},labels:[]},metrics:{followers:{delta:id===1?100:999999}}});
test('independent streamer membership excludes even the main IP from matrix totals, preserving explicit streamer access',()=>{
 const matrix=a(1,['一条小团团切片矩阵']),host=a(2,['抖音主播板块']),other=a(3,['抖音主播板块'],'douyin-streamers');
 assert.equal(isIndependentStreamer(host),true);assert.equal(matchesMatrixScope(host),false);assert.equal(matchesMatrixScope(other),false);
 assert.equal(matchesMatrixScope(host,{board:'抖音主播板块'}),true);assert.equal(matchesMatrixScope(other,{theme:'douyin-streamers'}),true);
 const roster=includeOtherMatrixAccounts(buildTuantuanRoster([], [matrix,host,other]),[matrix,host,other]);
 assert.equal(roster.counts.all,1);assert.equal(matrixPulse(roster,[matrix,host,other]).net,100);
 assert.equal(matchesMatrixScope(a(4,['抖音主播板块','老飞宇切片矩阵'])),true);
 assert.equal(matchesMatrixScope(a(5,['老飞宇切片矩阵']),{board:'一条小团团切片矩阵'}),false);
});
