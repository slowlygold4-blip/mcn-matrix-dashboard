import test from 'node:test';import assert from 'node:assert/strict';
import {creatorPartValid} from '../lib/replica-creator.mjs';
import {buildTuantuanRoster,filterTuantuanRoster,tuantuanRosterExport} from '../lib/tuantuan-roster.mjs';
const asOf='2026-10-31T00:00:00.000Z',old='7462321330400166937';
const account=id=>({id,label:'已确认作者',platform:'douyin',enabled:true,classification:{theme:{key:'tuantuan'},labels:[]}});
const author=()=>({row:2,name:'已确认作者',douyinId:'current-id',posts:2,slicePosts:2,creationPosts:0,aiPosts:0,cupPosts:0,plays:null,likes:8,followers:null,targetIds:[1]});
const valid=row=>creatorPartValid({version:1,asOf,timeZone:'Asia/Shanghai',revision:'fixture',items:[row]},
 {path:'creator/authors.json',kind:'creatorAuthors',count:1},asOf);

test('optional original identifiers retain the primary ID and reject malformed or ambiguous arrays without breaking legacy authors',()=>{
 assert.ok(valid(author()));assert.ok(valid({...author(),douyinIds:['current-id',old]}));
 assert.equal(valid(null),false);
 assert.ok(valid({...author(),registeredClassifications:['slice'],douyinIds:['current-id',old]}));
 for(const ids of [[],['current-id'],[old],['current-id','CURRENT-ID'],['current-id','ｃｕｒｒｅｎｔ－ｉｄ'],['current-id',1],['current-id',''],['current-id','<script>'],['current-id','x'.repeat(121)]])
  assert.equal(valid({...author(),douyinIds:ids}),false,JSON.stringify(ids));
 assert.equal(valid({...author(),douyinIds:['current-id',old],rawIdentity:{uid:old}}),false);
});

test('original IDs remain searchable and exportable after an additional source alias merges into the same account',()=>{
 const base={...author(),douyinIds:['current-id',old]},supplement={name:base.name,douyinId:'upload-id',douyinIds:['upload-id','older-upload-id','CURRENT-ID'],targetIds:[1],posts:null,plays:null,likes:null,followers:null};
 const original=JSON.stringify([base,supplement]),model=buildTuantuanRoster([base],[account(1)],[supplement]);
 assert.equal(model.counts.all,1);assert.equal(model.counts.monitored,1);
 assert.deepEqual(model.rows[0].source.douyinIds,['current-id',old,'upload-id','older-upload-id']);
 for(const id of model.rows[0].source.douyinIds)assert.equal(filterTuantuanRoster(model.rows,{query:id}).length,1,id);
 assert.ok(tuantuanRosterExport(model.rows)[1][1].includes(old));assert.equal(JSON.stringify([base,supplement]),original);
});

test('search aliases never grant target linkage or merge unrelated source authors',()=>{
 const model=buildTuantuanRoster([{...author(),douyinIds:['current-id',old]},
  {...author(),row:3,douyinId:'other-id',douyinIds:['other-id',old],targetIds:[]}],[account(1)]);
 assert.equal(model.counts.all,2);assert.equal(model.counts.linkedSource,1);
 const found=filterTuantuanRoster(model.rows,{query:old});assert.equal(found.length,2);
 assert.equal(found.filter(row=>row.accounts.length===0).length,1);
});
