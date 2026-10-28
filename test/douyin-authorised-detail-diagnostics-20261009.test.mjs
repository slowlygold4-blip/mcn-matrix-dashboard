import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectAuthorisedDetail, normalizeAuthorisedDetailInput, validateAuthorisedDetailResponse,
  validateAuthorisedDetailResult } from '../lib/douyin-authorised-detail.mjs';

const VIDEO='7690702905876096104', SEC='MS4wLjABAAAAuthorisedDetailFixture12345', UID='1234567890123456789';
const payload={items:[{key:`douyin:exact_user|video:${VIDEO}`,videoId:VIDEO,submittedId:'exact_user'}]};
const input=normalizeAuthorisedDetailInput(payload);
const detailUrl=`https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${VIDEO}&a_bogus=PRIVATE_QUERY`;
const response=()=>({status_code:0,aweme_detail:{aweme_id:VIDEO,author:{sec_uid:SEC,uid:UID,unique_id:'exact_user'}}});
function fixture({body,status=200}={}) {
  const page=new EventEmitter();let current='about:blank';const frame={url:()=>current};let gotos=0;
  page.url=()=>current;page.mainFrame=()=>frame;page.close=async()=>{};
  page.goto=async value=>{gotos++;current=value;page.emit('framenavigated',frame);
    const request={url:()=>detailUrl,frame:()=>frame,method:()=>'GET',isNavigationRequest:()=>false,redirectedFrom:()=>null};
    page.emit('request',request);page.emit('response',{request:()=>request,url:()=>detailUrl,status:()=>status,text:async()=>body});};
  const process={pid:12345,exitCode:null,signalCode:null};
  const server={process:()=>process,wsEndpoint:()=> 'ws://127.0.0.1/PRIVATE_ENDPOINT',close:async()=>{process.exitCode=0;},kill:async()=>{process.signalCode='SIGKILL';}};
  const context={newPage:async()=>page,close:async()=>{}};
  const browser={newContext:async()=>context,close:async()=>{}};
  const runtime={readState:async()=>({cookies:[{name:'PRIVATE_NAME',value:'PRIVATE_COOKIE'}]}),access:async()=>{},
    ownership:{remainingExecutionMs:()=>45_000,send:async()=>{}},chromium:{launchServer:async()=>server,connect:async()=>browser}};
  return {page,collect:async()=>{const result=await collectAuthorisedDetail(payload,{enabled:true,runtime});
    assert.equal(gotos,1);for(const name of ['request','response','framenavigated'])assert.equal(page.listenerCount(name),0);
    return result;}};
}
const options=result=>({startedAt:result.requestStartedAt,finishedAt:result.requestFinishedAt});
const diagnostic=(stage,reason)=>({version:1,stage,reason});

test('non-JSON natural HTTP200 yields body_not_json without copying body, headers or secrets',async()=>{
  const r=await fixture({body:'<html>PRIVATE_COOKIE PRIVATE_BODY</html>'}).collect();
  assert.equal(r.status,'unavailable');assert.equal(r.errorCode,'invalid_evidence');
  assert.deepEqual(r.diagnostic,diagnostic('body','body_not_json'));
  assert.equal(r.candidate,undefined);assert.equal(r.evidence,undefined);
  assert.equal(JSON.stringify(r).includes('PRIVATE'),false);
  assert.deepEqual(validateAuthorisedDetailResult(input,r,options(r)),r);
});

test('missing UID and numeric UID remain rejected and are distinguishable without numeric conversion',async()=>{
  for(const [value,reason]of[[undefined,'uid_missing'],[null,'uid_missing'],['','uid_missing'],
    [123456,'uid_invalid_type'],[Number(UID),'uid_invalid_type'],[{},'uid_invalid_type'],['not-a-uid','uid_invalid_format']]) {
    const data=response();data.aweme_detail.author.uid=value;const before=JSON.stringify(data);
    const r=await fixture({body:JSON.stringify(data)}).collect();
    assert.equal(r.status,'unavailable');assert.equal(r.errorCode,'invalid_evidence');
    assert.deepEqual(r.diagnostic,diagnostic('detail_fields',reason));
    assert.equal(JSON.stringify(data),before);assert.equal(r.candidate,undefined);
    assert.deepEqual(validateAuthorisedDetailResult(input,r,options(r)),r);
  }
});

test('missing or invalid public handles are distinct from a valid but different submitted handle',async()=>{
  for(const [values,reason]of[[{},'public_id_absent'],[{unique_id:'',short_id:null},'public_id_absent'],
    [{unique_id:{cookie:'PRIVATE_COOKIE'},short_id:123},'public_id_invalid'],
    [{unique_id:'different_author'},'submitted_id_mismatch']]) {
    const data=response();delete data.aweme_detail.author.unique_id;Object.assign(data.aweme_detail.author,values);
    const r=await fixture({body:JSON.stringify(data)}).collect();
    assert.equal(r.status,'unavailable');assert.equal(r.errorCode,'identity_mismatch');
    assert.deepEqual(r.diagnostic,diagnostic('public_identity',reason));
    assert.equal(JSON.stringify(r).includes('PRIVATE'),false);
  }
});

test('structure, work identity, canonical ID and deletion checks retain fail-closed error codes',()=>{
  const cases=[
    [null,'payload_not_object'],[{status_code:0},'detail_invalid_shape'],
    [{status_code:0,aweme_detail:{aweme_id:VIDEO}},'author_invalid_shape'],
  ];
  for(const [data,reason]of cases) assert.throws(()=>validateAuthorisedDetailResponse(data,input),e=>e.code==='invalid_evidence'&&e.diagnostic.reason===reason);
  for(const [mutate,reason]of[
    [x=>delete x.aweme_detail.aweme_id,'work_id_missing'],[x=>x.aweme_detail.aweme_id=Number(VIDEO),'work_id_invalid_type'],
    [x=>x.aweme_detail.aweme_id='7690702905876096105','work_id_mismatch'],
    [x=>delete x.aweme_detail.author.sec_uid,'sec_uid_missing'],[x=>x.aweme_detail.author.sec_uid=1,'sec_uid_invalid_type'],
    [x=>x.aweme_detail.author.sec_uid='bad','sec_uid_invalid_format'],[x=>x.aweme_detail.author.user_deleted=true,'author_deleted'],
  ]){const data=response();mutate(data);assert.throws(()=>validateAuthorisedDetailResponse(data,input),e=>e.code==='invalid_evidence'&&e.diagnostic.reason===reason);}
  for(const [expected,reason]of[[{expectedSecUid:SEC+'other'},'expected_sec_uid_mismatch'],[{expectedUid:'1111111'},'expected_uid_mismatch']]) {
    assert.throws(()=>validateAuthorisedDetailResponse(response(),{...input,...expected}),e=>e.code==='identity_mismatch'&&e.diagnostic.reason===reason);
  }
});

test('parent diagnostics projection drops all unknown values and incompatible or malicious enums',async()=>{
  const r=await fixture({body:'not JSON'}).collect();
  const safe=validateAuthorisedDetailResult(input,{...r,diagnostic:{...r.diagnostic,rawBody:'PRIVATE_BODY',
    headers:{Cookie:'PRIVATE_COOKIE'},url:'https://evil.test/?token=PRIVATE'}},options(r));
  assert.deepEqual(safe.diagnostic,r.diagnostic);assert.equal(JSON.stringify(safe).includes('PRIVATE'),false);
  for(const value of [null,[],{},'PRIVATE',{version:2,stage:'body',reason:'body_not_json'},
    {version:1,stage:'body',reason:'PRIVATE_COOKIE'},{version:1,stage:'body\nPRIVATE',reason:'body_not_json'},
    {version:1,stage:'__proto__',reason:'toString'},diagnostic('public_identity','submitted_id_mismatch')]) {
    assert.equal(validateAuthorisedDetailResult(input,{...r,diagnostic:value},options(r)).diagnostic,undefined);
  }
  const legacy={...r};delete legacy.diagnostic;
  assert.deepEqual(validateAuthorisedDetailResult(input,legacy,options(legacy)),legacy);
  assert.throws(()=>validateAuthorisedDetailResult(input,{...r,candidate:{}},options(r)),{code:'invalid_evidence'});
});

test('body-size/type, barriers and valid success remain separate; diagnosis never authorizes admission',async()=>{
  for(const [body,reason]of[[null,'body_type_invalid'],['x'.repeat(2*1024*1024+1),'body_too_large']]) {
    const r=await fixture({body}).collect();assert.equal(r.status,'unavailable');
    assert.equal(r.errorCode,'invalid_evidence');assert.deepEqual(r.diagnostic,diagnostic('body',reason));
  }
  const barrier=await fixture({body:JSON.stringify({...response(),need_login:true})}).collect();
  assert.equal(barrier.errorCode,'login_required');assert.equal(barrier.diagnostic,undefined);
  const blocked=await fixture({body:'PRIVATE_BODY',status:403}).collect();
  assert.equal(blocked.errorCode,'blocked');assert.equal(blocked.diagnostic,undefined);
  const ok=await fixture({body:JSON.stringify(response())}).collect();
  assert.equal(ok.status,'ok');assert.equal(ok.diagnostic,undefined);
  assert.equal(validateAuthorisedDetailResult(input,{...ok,diagnostic:diagnostic('body','body_not_json')},options(ok)).diagnostic,undefined);
});
