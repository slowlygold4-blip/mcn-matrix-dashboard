import test from 'node:test';
import assert from 'node:assert/strict';
import {pendingSourceAuthors} from '../lib/table-foundation.mjs';

const account=(overrides={})=>({platform:'douyin',sourceOnly:true,
 classification:{theme:{key:'tuantuan'}},rosterKey:'submitted:douyin:row-1',
 rosterKeys:['submitted:douyin:row-1'],label:'旧表作者',submittedAccountId:'id_one',
 sourceProvenance:[{url:'https://example.com/sheet?token=[REDACTED]',title:'旧总表',sheetName:'名单',rows:['2','2','3']}],
 ...overrides});

test('older source-only authors retain stable provenance, including missing IDs, without invented metrics',()=>{
 const rows=pendingSourceAuthors({rosterAccounts:[
  account(),
  account({rosterKey:'live-source:douyin:row-2',rosterKeys:['live-source:douyin:row-2'],
   label:'无号但有来源',submittedAccountId:null}),
  account({rosterKey:'submitted:douyin:row-3',rosterKeys:['submitted:douyin:row-3'],
   label:'同名不合并',submittedAccountId:'id_three'}),
  account({rosterKey:'submitted:douyin:row-4',rosterKeys:['submitted:douyin:row-4'],
   label:'原号格式不可用',submittedAccountId:':12345'}),
 ],baseAuthors:[],supplementAuthors:[]});
 assert.equal(rows.length,4);
 assert.equal(new Set(rows.map(row=>row.rowKey)).size,4);
 const blank=rows.find(row=>row.identifierStatus==='missing');
 assert.equal(blank.rowKey,'live-source:douyin:row-2');
 assert.deepEqual(blank.targetIds,[]);
 const unusable=rows.find(row=>row.identifierStatus==='unusable');
 assert.equal(unusable.douyinId,null);
 assert.equal(unusable.submittedAccountId,':12345');
 for(const row of rows){
  assert.equal(row.sourceOnly,true);assert.equal(row.sourceSupplement,true);
  assert.equal(row.posts,null);assert.equal(row.plays,null);
  assert.equal(row.likes,null);assert.equal(row.followers,null);
  assert.deepEqual(row.sourceTitles,['旧总表']);
  assert.deepEqual(row.sourceRows[0].rows,['2','3']);
  assert.match(row.sourceRows[0].sourceKey,/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(row).includes('token=secret'));
 }
});

test('represented IDs and reciprocal creator aliases are skipped, while historical ID conflicts stay separate',()=>{
 const rows=pendingSourceAuthors({rosterAccounts:[
  account({submittedAccountId:'BASE'}),
  account({rosterKey:'creator-source:row-2',rosterKeys:['creator-source:row-2'],submittedAccountId:'flipped'}),
  account({rosterKey:'submitted:douyin:row-3',rosterKeys:['submitted:douyin:row-3'],submittedAccountId:'other'}),
  account({rosterKey:'submitted:douyin:row-4',rosterKeys:['submitted:douyin:row-4'],submittedAccountId:'other'}),
  account({rosterKey:'submitted:douyin:row-5',rosterKeys:['submitted:douyin:row-5'],submittedAccountId:'x'}),
  account({rosterKey:'submitted:douyin:row-6',rosterKeys:['submitted:douyin:row-6'],submittedAccountId:'y',sourceOnly:false}),
 ],baseAuthors:[{douyinId:'base'}],supplementAuthors:[{douyinId:'x'}]});
 assert.deepEqual(rows.map(row=>row.rowKey),['submitted:douyin:row-3','submitted:douyin:row-4']);
});
