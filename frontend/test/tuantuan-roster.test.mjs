import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTuantuanRoster,filterTuantuanRoster,rosterModeCounts,sourceRosterMetric,tuantuanRosterExport} from '../lib/tuantuan-roster.mjs';
import {csv} from '../lib/replica-model.mjs';

const account=(id,theme='tuantuan',enabled=true)=>({id,label:`账号${id}`,platform:'douyin',enabled,classification:{theme:{key:theme},labels:[{key:'slice'}]}});
test('团团名册按持久化 targetId 去重，源作者不被误称为已监控',()=>{
 const source=[
  {name:'甲',douyinId:'douyin-a',targetIds:[1],slicePosts:2,creationPosts:0,aiPosts:0},
  {name:'乙',douyinId:'douyin-b',targetIds:[],slicePosts:0,creationPosts:1,aiPosts:0},
  {name:'主播',douyinId:'douyin-c',targetIds:[3],slicePosts:0,creationPosts:0,aiPosts:1},
 ];
 const result=buildTuantuanRoster(source,[account(1),account(2,'tuantuan',false),account(3,'douyin-streamers')]);
 assert.deepEqual(result.counts,{all:4,source:3,baseSource:3,supplementSource:0,pendingSource:0,reconciledAliases:0,monitored:2,monitoredEnabled:1,monitoredPaused:1,linkedSource:1,linkedTargets:1,platformOnly:1,sourceWithoutThemeLink:2});
 assert.equal(filterTuantuanRoster(result.rows,{mode:'monitored'}).length,1);
 assert.equal(filterTuantuanRoster(result.rows,{mode:'paused'}).length,1);
 assert.equal(filterTuantuanRoster(result.rows,{mode:'source-only'}).length,2);
 assert.equal(filterTuantuanRoster(result.rows,{classification:'original'}).length,1);
 assert.equal(filterTuantuanRoster(result.rows,{query:'DOUYIN-C'}).length,1);
});

test('启用、暂停、仅表格三个范围互斥且覆盖全部，按作者行而非目标数计数',()=>{
 const authors=[
  {name:'多目标作者',douyinId:'mixed',targetIds:[1,2],slicePosts:1},
  {name:'暂停作者',douyinId:'paused',targetIds:[3,4],slicePosts:0,creationPosts:2},
  {name:'仅表作者',douyinId:'source',targetIds:[],slicePosts:2},
 ];
 const original=account(3,'tuantuan',false);original.classification.labels=[{key:'original'}];
 const original2=account(4,'tuantuan',false);original2.classification.labels=[{key:'original'}];
 const roster=buildTuantuanRoster(authors,[account(1),account(2,'tuantuan',false),original,original2,account(5,'tuantuan',false)]);
 const before=JSON.stringify(roster.rows);
 const counts=rosterModeCounts(roster.rows);
 assert.deepEqual(counts,{all:4,monitored:1,paused:2,'source-only':1});
 const partitions=['monitored','paused','source-only'].map(mode=>filterTuantuanRoster(roster.rows,{mode}));
 const keys=partitions.flat().map(row=>row.key);
 assert.equal(new Set(keys).size,keys.length);
 assert.deepEqual([...keys].sort(),filterTuantuanRoster(roster.rows,{mode:'all'}).map(row=>row.key).sort());
 assert.deepEqual(rosterModeCounts(roster.rows,'slice'),{all:3,monitored:1,paused:1,'source-only':1});
 assert.deepEqual(rosterModeCounts(roster.rows,'original'),{all:1,monitored:0,paused:1,'source-only':0});
 assert.deepEqual(rosterModeCounts([]),{all:0,monitored:0,paused:0,'source-only':0});
 for(const classification of ['all','slice','original']){
  const expected=rosterModeCounts(roster.rows,classification);
  assert.equal(expected.all,expected.monitored+expected.paused+expected['source-only']);
  for(const mode of ['all','monitored','paused','source-only'])assert.equal(filterTuantuanRoster(roster.rows,{mode,classification}).length,expected[mode]);
 }
 assert.equal(JSON.stringify(roster.rows),before);
});

test('同昵称不自动关联，非团团持久化关联也不会变成团团监控',()=>{
 const sharedName='同名作者';
 const roster=buildTuantuanRoster([
  {name:sharedName,douyinId:'source-a',targetIds:[]},
  {name:sharedName,douyinId:'source-b',targetIds:[99]},
 ],[{...account(1),label:sharedName},{...account(99,'other-theme'),label:sharedName}]);
 assert.equal(roster.counts.all,3);
 assert.equal(roster.counts.linkedTargets,0);
 assert.deepEqual(rosterModeCounts(roster.rows),{all:3,monitored:1,paused:0,'source-only':2});
 const sourceRows=filterTuantuanRoster(roster.rows,{query:sharedName,mode:'source-only'});
 assert.equal(sourceRows.length,2);
 assert.ok(sourceRows.every(row=>row.accounts.length===0));
});

test('重复来源抖音号停止合并，不虚增名册',()=>{
 assert.throws(()=>buildTuantuanRoster([{douyinId:'same',targetIds:[]},{douyinId:'same',targetIds:[]}],[]),/重复/);
});

test('同一已发布目标与同名的总表和补充表别名合并，保留两个抖音号和补充证据',()=>{
 const base={row:518,name:'東甜同学',douyinId:'1522174908439198',targetIds:[15078],posts:8,plays:120,likes:9};
 const supplement={name:'東甜同学',douyinId:'dongtiantx',targetIds:[15078],posts:null,plays:null,likes:null,followers:null,sourceTitles:['切片登记表']};
 const merged=buildTuantuanRoster([base],[account(15078)], [supplement]);
 assert.equal(merged.counts.all,1);
 assert.equal(merged.counts.source,1);
 assert.equal(merged.counts.reconciledAliases,1);
 assert.equal(merged.counts.linkedSource,1);
 assert.equal(merged.counts.linkedTargets,1);
 assert.deepEqual(merged.rows[0].source.douyinIds,['1522174908439198','dongtiantx']);
 assert.equal(filterTuantuanRoster(merged.rows,{query:'dongtiantx'}).length,1);
 assert.match(tuantuanRosterExport(merged.rows)[1][1],/dongtiantx/);
 assert.deepEqual(merged.rows[0].source.sourceTitles,['切片登记表']);
 const conflict=buildTuantuanRoster([base],[account(15078)], [{...supplement,name:'另一个作者'}]);
 assert.equal(conflict.counts.all,2);
 assert.equal(conflict.counts.reconciledAliases,0);
});

test('团团统一名册导出当前筛选全部行，并保持表格累计值与缺测口径',()=>{
 const source=[
  {name:'甲',douyinId:'id-a',targetIds:[1],posts:2,plays:100,likes:10},
  {name:'=恶意公式',douyinId:'id-b',targetIds:[],posts:0,plays:0,likes:0,sourceTitles:['新增登记表']},
 ];
 const roster=buildTuantuanRoster(source,[account(1)]);
 const rows=filterTuantuanRoster(roster.rows,{mode:'all'});
 const exportRows=tuantuanRosterExport(rows);
 assert.equal(exportRows.length,3);
 assert.deepEqual(exportRows[1].slice(2,7),['启用主页监控','1',2,100,10]);
 assert.deepEqual(exportRows[2].slice(4,7),[0,null,null]);
 assert.equal(sourceRosterMetric(source[1],'plays'),null);
 assert.equal(sourceRosterMetric({posts:0,plays:7},'plays'),7);
 assert.match(csv(exportRows),/"'=恶意公式"/);
 assert.equal(tuantuanRosterExport(filterTuantuanRoster(roster.rows,{mode:'monitored'})).length,2);
});

test('旧来源作者只补身份和来源，不冒充主页监控或表格累计指标',()=>{
 const liveKey=`live-source:douyin:${'a'.repeat(64)}`;
 const submittedKey=`submitted:douyin:${'b'.repeat(64)}`;
 const pending=[
  {rowKey:liveKey,name:'原始来源作者',douyinId:null,submittedAccountId:'错误:123',identifierStatus:'unusable',targetIds:[],sourceRows:[{sourceKey:'evidence',title:'旧表',sheetName:'Sheet1',rows:['12']}],sourceTitles:['旧表'],sourceOnly:true,posts:null,plays:null,likes:null},
  {rowKey:submittedKey,name:'有号未核验',douyinId:'valid-id',submittedAccountId:'valid-id',identifierStatus:'format-valid',targetIds:[],sourceRows:[{sourceKey:'evidence2',title:'补录',sheetName:'Sheet2',rows:['2']}],sourceTitles:['补录'],sourceOnly:true,posts:null,plays:null,likes:null},
 ];
 const roster=buildTuantuanRoster([],[],[],pending);
 assert.equal(roster.counts.all,2);
 assert.equal(roster.counts.pendingSource,2);
 assert.equal(roster.counts.monitored,0);
 assert.deepEqual(rosterModeCounts(roster.rows),{all:2,monitored:0,paused:0,'source-only':2});
 assert.equal(filterTuantuanRoster(roster.rows,{query:'错误:123'}).length,1);
 assert.equal(sourceRosterMetric(roster.rows[0].source,'plays'),null);
 const exported=tuantuanRosterExport(roster.rows);
 assert.match(exported[1][1],/待核验原号/);
 assert.equal(exported[1][4],null);
 assert.throws(()=>buildTuantuanRoster([],[],[],[pending[0],pending[0]]),/重复/);
});

test('公开账号目录中的仅来源记录不计作暂停主页监控目标',()=>{
 const source=[{name:'已有来源',douyinId:'known-id',targetIds:[],posts:null}];
 const rows=buildTuantuanRoster(source,[
  {...account(1),sourceOnly:true,publicId:'known-id',enabled:false},
  {...account('roster:2'),sourceOnly:true,enabled:false},
  account(3),account(4,'tuantuan',false),account(5,'other-theme'),
 ]);
 assert.equal(rows.counts.source,1);
 assert.equal(rows.counts.monitored,2);
 assert.equal(rows.counts.monitoredEnabled,1);
 assert.equal(rows.counts.monitoredPaused,1);
 assert.equal(rows.counts.all,3);
 assert.deepEqual(rosterModeCounts(rows.rows),{all:3,monitored:1,paused:1,'source-only':1});
});
