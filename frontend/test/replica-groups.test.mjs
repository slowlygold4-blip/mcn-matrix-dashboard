import test from 'node:test';
import assert from 'node:assert/strict';
import {groupEndpointRows,orderEndpointGroups} from '../lib/replica-groups.mjs';
const row=(id,theme,labels,delta,enabled=true)=>({id,enabled,classification:{theme:{key:theme,label:theme},labels:labels.map(key=>({key,label:key}))},metrics:Object.fromEntries(['followers','likes','posts'].map(k=>[k,{value:delta===null?null:100,delta}]))});
test('themes partition exact enabled endpoints; paused records excluded, negative/zero/missing preserved',()=>{
 const input=[row(1,'团团',['slice','AI'],5),row(2,'团团',['slice'],-3),row(3,'杨齐家',[],0),row(4,'杨齐家',['AI'],null),row(5,'团团',[],500,false)];
 const saved=JSON.stringify(input),g=groupEndpointRows(input);assert.equal(g.length,2);assert.equal(g.reduce((n,x)=>n+x.count,0),4);
 assert.deepEqual(g[0].metrics.followers,{value:200,delta:2,knownCount:2,comparableCount:2});assert.equal(g[1].metrics.likes.delta,0);assert.equal(g[1].metrics.posts.comparableCount,1);assert.equal(JSON.stringify(input),saved);
});
test('content labels may overlap without duplicate member contributions within the same tag',()=>{
 const g=groupEndpointRows([row(1,'团团',['slice','AI','slice'],5),row(2,'团团',['slice'],-3),row(3,'团团',[],null)],'content');
 assert.equal(g.find(x=>x.key==='slice').count,2);assert.equal(g.find(x=>x.key==='slice').metrics.likes.delta,2);assert.equal(g.find(x=>x.key==='AI').metrics.likes.delta,5);
});
test('group missing stays last in either direction and ties retain stable source key',()=>{
 const g=groupEndpointRows([row(1,'a',[],null),row(2,'b',[],-5),row(3,'c',[],0),row(4,'d',[],10)]);
 assert.deepEqual(orderEndpointGroups(g).map(x=>x.key),['d','c','b','a']);assert.deepEqual(orderEndpointGroups(g,'likes.delta','asc').map(x=>x.key),['b','c','d','a']);assert.deepEqual(orderEndpointGroups(g,'posts.value','desc').map(x=>x.key),['b','c','d','a']);
});
test('duplicate author identities and conflicting source labels cannot inflate groups',()=>{
 assert.throws(()=>groupEndpointRows([row(1,'a',[],1),row(1,'a',[],2)]));const r=row(2,'a',[],1);r.classification.theme.label='other';assert.throws(()=>groupEndpointRows([row(1,'a',[],1),r]));assert.throws(()=>orderEndpointGroups([],'fake','desc'));assert.deepEqual(groupEndpointRows([]),[]);
});
