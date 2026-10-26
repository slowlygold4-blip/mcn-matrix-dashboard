import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {normalizePublicIdSearchInput,extractSearchIdentity,validatePublicIdSearchResult} from '../lib/douyin-public-id-search.mjs';
const user={sec_uid:'MS4wLjABAAAASearchFixture123456789',uid:'1234567890123',unique_id:'Right_ID',short_id:'0',nickname:'同名用户'};
test('search matches public ID, never nickname or the first result',()=>{
 assert.equal(extractSearchIdentity({status_code:0,user_list:[{user_info:{...user,unique_id:'other'}}]},'right_id'),null);
 assert.equal(extractSearchIdentity({status_code:0,user_list:[{user_info:{...user,unique_id:'other'}},{user_info:user}]},'right_id').secUid,user.sec_uid);
 assert.throws(()=>extractSearchIdentity({status_code:0,user_list:[user,{...user,sec_uid:'MS4wLjABAAAAOtherSearchFixture1234'}]},'right_id'),/identity_mismatch/);
 assert.throws(()=>extractSearchIdentity({status_code:7,user_list:[user]},'right_id'),/business_error/);
});
test('search rejects malformed IDs and non-fresh or changed proof',()=>{
 assert.throws(()=>normalizePublicIdSearchInput({items:[{key:'a',submittedId:'../wrong'}]}),/invalid_input/);
 const input=normalizePublicIdSearchInput({items:[{key:'a',submittedId:'@Right_ID'}]});assert.equal(input.submittedId,'right_id');
 const identity=extractSearchIdentity({status_code:0,user_list:[user]},input.submittedId),at='2026-10-26T12:00:00.000Z';
 const result={...input,status:'ok',identity,observedAt:at,responseSha256:createHash('sha256').update(JSON.stringify(identity)).digest('hex'),provenance:'authorised-natural-search-and-profile',runtimeAI:false};
 assert.deepEqual(validatePublicIdSearchResult(input,result,{startedAt:at,finishedAt:at}),result);
 assert.throws(()=>validatePublicIdSearchResult(input,{...result,observedAt:'2026-10-25T12:00:00.000Z'},{startedAt:at,finishedAt:at}),/invalid_evidence/);
 assert.throws(()=>validatePublicIdSearchResult(input,{...result,identity:{...identity,secUid:'MS4wLjABAAAAChangedSearchFixture1234'}},{startedAt:at,finishedAt:at}),/invalid_evidence/);
});
