import test from 'node:test';
import assert from 'node:assert/strict';
import {applyLiveAuthorLinks} from '../lib/live-author-links.mjs';
import {buildTuantuanRoster} from '../lib/tuantuan-roster.mjs';
const index={revision:'1697',sourceModifiedAt:'2026-10-22T13:09:53.000Z',sourceRows:34150};
const projection={revision:'1697',modifiedAt:index.sourceModifiedAt,rowCount:34150,links:[{authorRow:10,targetId:99}]};
const authors=[{row:10,douyinId:'submitted_id',name:'作者',targetIds:[],posts:2,plays:333}];
const accounts=[{id:99,platform:'douyin',enabled:true,classification:{theme:{key:'tuantuan'}}}];
test('fresh receipt links existing author without creating duplicate, preserves source metrics and input',()=>{
 const output=applyLiveAuthorLinks(authors,projection,index),roster=buildTuantuanRoster(output,accounts);
 assert.equal(roster.counts.all,1);assert.equal(roster.counts.monitoredEnabled,1);
 assert.equal(roster.counts.platformOnly,0);assert.equal(output[0].plays,333);assert.deepEqual(authors[0].targetIds,[]);
});
test('authoritative projection revokes obsolete static link without nickname matching',()=>{
 assert.deepEqual(applyLiveAuthorLinks([{...authors[0],targetIds:[2]}],{...projection,links:[]},index)[0].targetIds,[]);
});
test('old generations retain frozen bindings; conflicting versions and duplicate identity links fail closed',()=>{
 assert.equal(applyLiveAuthorLinks(authors,undefined,index),authors);
 assert.throws(()=>applyLiveAuthorLinks(authors,{...projection,revision:'new'},index),/版本/);
 assert.throws(()=>applyLiveAuthorLinks(authors,{...projection,links:[...projection.links,{authorRow:11,targetId:99}]},index),/重复/);
 assert.throws(()=>applyLiveAuthorLinks(authors,{...projection,links:[...projection.links,{authorRow:10,targetId:88}]},index),/重复/);
});
