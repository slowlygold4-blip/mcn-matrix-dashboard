import {createHash} from 'node:crypto';
import {collectWorkObservation} from './douyin-authorised-detail.mjs';
const ORIGIN='https://www.douyin.com',SEARCH='/aweme/v1/web/discover/search/',PROFILE='/aweme/v1/web/user/profile/other/';
const sec=/^MS4wLj[\w-]{12,220}$/,handle=/^[A-Za-z0-9_.-]{1,100}$/;
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=code=>Object.assign(Error(code),{code});
export function normalizePublicIdSearchInput(payload){
 if(!payload||!Array.isArray(payload.items)||payload.items.length!==1)throw fail('invalid_input');
 const i=payload.items[0],submittedId=typeof i?.submittedId==='string'?i.submittedId.normalize('NFKC').trim().replace(/^@/,'').toLowerCase():'';
 if(!handle.test(submittedId)||submittedId==='0'||typeof i.key!=='string'||!i.key||i.key.length>300||/[\u0000-\u001f\u007f]/.test(i.key))throw fail('invalid_input');
 return {key:i.key,submittedId};
}
export function searchUserIdentity(user,submittedId){
 if(!user||typeof user!=='object'||!sec.test(user.sec_uid??'')||typeof user.uid!=='string'||!/^\d{2,24}$/.test(user.uid))return null;
 const publicIds=[user.unique_id,user.short_id].filter(x=>typeof x==='string'&&handle.test(x)).map(x=>x.toLowerCase());
 if(!publicIds.includes(submittedId.toLowerCase()))return null;
 return {secUid:user.sec_uid,uid:user.uid,uniqueId:typeof user.unique_id==='string'?user.unique_id:'',shortId:typeof user.short_id==='string'?user.short_id:'',nickname:String(user.nickname??'').slice(0,200)};
}
export function extractSearchIdentity(body,submittedId){
 if(body?.status_code!==0)throw fail('business_error');
 const users=[...(Array.isArray(body.user_list)?body.user_list:[]),...(Array.isArray(body.data)?body.data.flatMap(x=>x.user_list??(x.user_info?[x.user_info]:[])):[])];
 const matched=new Map(users.map(x=>searchUserIdentity(x?.user_info??x,submittedId)).filter(Boolean).map(x=>[x.secUid,x]));
 if(matched.size>1)throw fail('identity_mismatch');
 return [...matched.values()][0]??null;
}
async function observePublicId(page,input,remaining,signal){
 let mode='search',candidate=null,profile=null,error=null;const requests=new WeakMap(),tasks=new Set(),searchPaths=new Set();let received=0;
 const onRequest=request=>{try{if(request.frame()!==page.mainFrame()||request.method()!=='GET')return;const u=new URL(request.url());if(u.origin!==ORIGIN)return;
  if(mode==='search'&&u.pathname===SEARCH&&u.searchParams.get('keyword')?.toLowerCase()===input.submittedId)requests.set(request,mode);
  if(mode==='profile'&&u.pathname===PROFILE&&u.searchParams.get('sec_user_id')===candidate?.secUid)requests.set(request,mode);
 }catch{}};
 const onResponse=response=>{try{const u=new URL(response.url());if(u.origin===ORIGIN&&/^\/aweme\/v1\/web\/.*search/.test(u.pathname)&&searchPaths.size<8)searchPaths.add(u.pathname);}catch{}
 if(requests.get(response.request())!==mode)return;received++;const phase=mode;const task=(async()=>{
  if([401,403].includes(response.status()))throw fail('blocked');if(response.status()===429)throw fail('rate_limited');if(response.status()!==200)throw fail('navigation_error');
  const raw=await response.text();if(Buffer.byteLength(raw)>2*1024*1024)throw fail('invalid_evidence');let body;try{body=JSON.parse(raw)}catch{throw fail('invalid_evidence')}
  if(phase!==mode)return;
  if(phase==='search'){const found=extractSearchIdentity(body,input.submittedId);if(found){if(candidate&&candidate.secUid!==found.secUid)throw fail('identity_mismatch');candidate=found;}}
  else{if(body?.status_code!==0)throw fail('business_error');const identity=searchUserIdentity(body.user??body.user_info,input.submittedId);if(!identity||identity.secUid!==candidate.secUid)throw fail('identity_mismatch');profile={identity,observedAt:new Date().toISOString()};}
 })().catch(e=>{error=e.code??'collector_error'}).finally(()=>tasks.delete(task));tasks.add(task);};
 const wait=async predicate=>{while(!predicate()){
   // Server-rendered search cards need not emit a search XHR. A labelled
   // public ID gives a navigation candidate only; the profile response must
   // still independently prove exact ID + canonical account ownership.
   if(mode==='search'&&!candidate&&new URL(page.url()).origin===ORIGIN){
    const cards=await page.locator('a[href*="/user/"]').evaluateAll(nodes=>nodes.slice(0,60).flatMap(a=>{
     if(!a.getClientRects().length)return [];
     let p=a;for(let depth=0;p&&depth<5;depth++,p=p.parentElement){const text=p.innerText??'';
      if(text.length>1200)break;const m=/抖音号\s*[:：]?\s*@?([A-Za-z0-9_.-]+)/.exec(text);
      if(m)return [{href:a.href,publicId:m[1]}];}return [];
    })).catch(()=>[]);
    const found=new Set(cards.filter(x=>x.publicId.toLowerCase()===input.submittedId).map(x=>{try{const u=new URL(x.href);return u.origin===ORIGIN&&/^\/user\/(MS4wLj[\w-]{12,220})\/?$/.exec(u.pathname)?.[1]}catch{return null}}).filter(Boolean));
    if(found.size>1)throw fail('identity_mismatch');if(found.size===1){candidate={secUid:[...found][0]};break;}
   }
   if(error)throw fail(error);if(signal?.aborted)throw fail('cancelled');
   const text=await page.locator('body').innerText({timeout:Math.min(1000,remaining())}).catch(()=> '');
   if(/安全验证|完成验证|拖动滑块|验证码登录|扫码登录后/.test(text))throw fail('challenge_required');
   if(/登录后搜索|登录后查看搜索|登录即可搜索/.test(text))throw fail('login_required');
   await new Promise(r=>setTimeout(r,Math.min(200,remaining())));
 }};
 page.on('request',onRequest);page.on('response',onResponse);
 try{
  await page.goto(`${ORIGIN}/search/${encodeURIComponent(input.submittedId)}?type=user`,{waitUntil:'domcontentloaded',timeout:Math.min(15000,remaining())});
  await wait(()=>candidate);await Promise.allSettled([...tasks]);if(error)throw fail(error);
  mode='profile';await page.goto(`${ORIGIN}/user/${candidate.secUid}`,{waitUntil:'domcontentloaded',timeout:Math.min(15000,remaining())});
  await wait(()=>profile);await Promise.allSettled([...tasks]);if(error)throw fail(error);
  return {profile};
 }catch(e){return {searchFailure:{code:e.code??'navigation_error',stage:mode,responses:received,searchPaths:[...searchPaths]}};}finally{page.off('request',onRequest);page.off('response',onResponse);}
}
export function validatePublicIdSearchResult(input,result,{startedAt,finishedAt}={}){
 if(result?.key!==input.key||result.submittedId!==input.submittedId)throw fail('invalid_evidence');
 if(result.status==='unavailable')return {status:'unavailable',key:input.key,submittedId:input.submittedId,errorCode:result.errorCode??'collector_error',...(result.diagnostic?{diagnostic:result.diagnostic}:{})};
 const identity=result.identity,at=Date.parse(result.observedAt),start=Date.parse(startedAt),finish=Date.parse(finishedAt);
 if(!Number.isFinite(start)||!Number.isFinite(finish)||finish<start||finish-start>45000)throw fail('invalid_evidence');
 if(result.status!=='ok'||!identity||!searchUserIdentity({sec_uid:identity.secUid,uid:identity.uid,unique_id:identity.uniqueId,short_id:identity.shortId},input.submittedId)
  ||!Number.isFinite(at)||at<Date.parse(startedAt)||at>Date.parse(finishedAt)||result.responseSha256!==hash(identity)
  ||result.provenance!=='authorised-natural-search-and-profile'||result.runtimeAI!==false)throw fail('invalid_evidence');
 return result;
}
export async function collectPublicIdSearch(payload,options={}){
 const input=normalizePublicIdSearchInput(payload);
 const {outcome,startedAt,finishedAt}=await collectWorkObservation(input,options,null,observePublicId);
 const base={key:input.key,submittedId:input.submittedId};
 if(!outcome?.profile)return {...base,status:'unavailable',errorCode:outcome?.errorCode??outcome?.searchFailure?.code??'collector_error',...(outcome?.searchFailure?{diagnostic:{stage:outcome.searchFailure.stage,responses:outcome.searchFailure.responses,searchPaths:outcome.searchFailure.searchPaths}}:{})};
 const {identity,observedAt}=outcome.profile;
 return validatePublicIdSearchResult(input,{...base,status:'ok',identity,observedAt,responseSha256:hash(identity),provenance:'authorised-natural-search-and-profile',runtimeAI:false},{startedAt,finishedAt});
}
