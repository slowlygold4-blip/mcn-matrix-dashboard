// Bounded GitHub-hosted capability test, never a local/production collector.
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {normalizePost} from '../../lib/providers/normalize.mjs';
import {parseDouyinShareMetadata} from '../../lib/douyin-share-metadata-probe.mjs';

export const PUBLIC_SAMPLE_ID='7660369906369629476';
const SEC=/^MS4wLj[\w-]{12,220}$/;
const problem=code=>Object.assign(new Error(code),{code});
export function requireHostedRunner(env=process.env,platform=process.platform){
 if(platform!=='linux'||env.GITHUB_ACTIONS!=='true'||env.RUNNER_ENVIRONMENT!=='github-hosted'
  ||env.GITHUB_REPOSITORY!=='slowlygold4-blip/mcn-matrix-dashboard')throw problem('hosted-runner-required');
}
function successful(body){
 return body&&body.status_code===0&&!['need_login','login_required','captcha_required','verify_required']
  .some(key=>body[key]!==undefined&&body[key]!==null&&body[key]!==false&&body[key]!==0&&body[key]!=='');
}
function project(item,observedAt){
 if(typeof item?.aweme_id!=='string'||!/^\d{15,25}$/.test(item.aweme_id)||!SEC.test(item.author?.sec_uid??''))return null;
 if(item.status?.is_delete===true||item.status?.is_delete===1
  ||(item.status?.private_status!==undefined&&item.status.private_status!==0))return null;
 const p=normalizePost(item);
 if(p.likes===null||!p.publishedAt||Date.parse(p.publishedAt)>Date.parse(observedAt))return null;
 return {contentId:p.externalId,secUid:item.author.sec_uid,likes:p.likes,publishedAt:p.publishedAt,observedAt,plays:null};
}
export function readPublicResponse(body,{kind,contentId,secUid,observedAt}){
 if(typeof observedAt!=='string'||!Number.isFinite(Date.parse(observedAt))
  ||new Date(observedAt).toISOString()!==observedAt)throw problem('invalid-observation-clock');
 if(!successful(body))throw problem('platform-unavailable');
 if(kind==='detail'){
  const items=body.aweme_detail?[body.aweme_detail]:body.item_list;
  const selected=Array.isArray(items)?items.filter(x=>x?.aweme_id===contentId):[];
  if(selected.length!==1)return null;
  return project(selected[0],observedAt);
 }
 if(!Array.isArray(body.aweme_list)||body.aweme_list.length>100||![0,1,false,true].includes(body.has_more))throw problem('list-contract-changed');
 const items=body.aweme_list.map(x=>project(x,observedAt));
 if(!items.length||items.some(x=>!x||x.secUid!==secUid))throw problem('list-identity-or-metrics-invalid');
 const unique=new Map();
 for(const item of items){
  if(unique.has(item.contentId)&&JSON.stringify(unique.get(item.contentId))!==JSON.stringify(item))throw problem('conflicting-work');
  unique.set(item.contentId,item);
 }
 return {items:[...unique.values()],hasMore:body.has_more===1||body.has_more===true,completeAuthor:false};
}

async function observe(page,input){
 let found=null,failure=null;const pending=new Set(),httpStatuses=[];
 const htmlMarkers={router:false,render:false,ssr:false};
 const handler=response=>{
  let u;try{u=new URL(response.url());}catch{return;}
  if(!['www.douyin.com','www.iesdouyin.com'].includes(u.hostname))return;
  const bound=input.kind==='detail'
   ? /\/(?:aweme\/v1\/web\/aweme\/detail|web\/api\/v2\/aweme\/iteminfo)\/$/.test(u.pathname)
      &&[u.searchParams.get('aweme_id'),u.searchParams.get('item_ids')].includes(input.contentId)
   :u.pathname==='/aweme/v1/web/aweme/post/'&&u.searchParams.get('sec_user_id')===input.secUid;
  if(!bound||found||failure)return;
  const task=(async()=>{
   const status=response.status();httpStatuses.push(status);
   if(status!==200){failure=`http-${status}`;void page.close().catch(()=>{});return;}
   if(Number(response.headers()['content-length']||0)>2*1024*1024){failure='response-too-large';return;}
   let timer;
   try{
    const raw=await Promise.race([response.body(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(problem('response-timeout')),3000);})]);
    if(raw.byteLength>2*1024*1024)throw problem('response-too-large');
    found=readPublicResponse(JSON.parse(raw.toString('utf8')),{...input,observedAt:new Date().toISOString()});
   }catch(e){failure=['platform-unavailable','list-contract-changed','list-identity-or-metrics-invalid','conflicting-work','response-too-large','response-timeout'].includes(e.code)?e.code:'unreadable-response';}
   finally{clearTimeout(timer);if(failure)void page.close().catch(()=>{});}
  })().catch(()=>{failure??='response-unavailable';});pending.add(task);void task.then(()=>pending.delete(task));
 };
 page.on('response',handler);
 try{
  const url=input.kind==='detail'?`https://www.douyin.com/video/${input.contentId}`:`https://www.douyin.com/user/${input.secUid}`;
  const document=await page.goto(url,{waitUntil:'domcontentloaded',timeout:25000});
  if(document&&document.status()>=400)failure=`document-http-${document.status()}`;
  const deadline=Date.now()+25000;
  while(!found&&!failure&&Date.now()<deadline){
   const current=new URL(page.url());
   if(/login|passport|captcha|verify/i.test(current.pathname)){failure='visible-access-gate';break;}
   const gate=page.locator('[class*="captcha"], [id*="captcha"], [class*="verify-container"]').first();
   if(await gate.isVisible().catch(()=>false)){failure='visible-access-gate';break;}
   if(input.kind==='detail'){
    try{
     const html=await page.content();
     htmlMarkers.router||=html.includes('_ROUTER_DATA');htmlMarkers.render||=html.includes('RENDER_DATA');htmlMarkers.ssr||=html.includes('_SSR_DATA');
     const parsed=parseDouyinShareMetadata(html,{contentId:input.contentId,observedAt:new Date().toISOString()});
     if(parsed.likes!==null&&parsed.publishedAt&&parsed.secUid)found={contentId:parsed.contentId,secUid:parsed.secUid,likes:parsed.likes,publishedAt:parsed.publishedAt,observedAt:parsed.observedAt,plays:null};
    }catch{ /* No arbitrary JavaScript evaluation or alternate endpoint. */ }
   }
   if(!found)await page.waitForTimeout(500);
  }
 }catch{failure??='navigation-unavailable';}
 finally{page.off('response',handler);await Promise.allSettled([...pending]);}
 return {status:found&&!failure?'observed':'unavailable',reason:failure??(found?null:'no-public-work-data'),httpStatuses,htmlMarkers,data:found};
}

async function main(){
 requireHostedRunner();
 const report={version:1,startedAt:new Date().toISOString(),sampleId:PUBLIC_SAMPLE_ID,
  execution:'github-hosted-only',localBrowser:false,privateDatasetRead:false,databaseWrites:0,modelCalls:0,
  productionCollectionEnabled:false,completeAuthor:false};
 let browser;
 try{
  const require=createRequire(join(process.env.MCN_SMOKE_RUNTIME,'package.json'));
  const {chromium}=require('playwright');browser=await chromium.launch({headless:false});
  const context=await browser.newContext();
  await context.route('**/*',route=>{
   const r=route.request();let u;try{u=new URL(r.url());}catch{return route.abort();}
   if(['media','image','font'].includes(r.resourceType()))return route.abort();
   if(u.protocol!=='https:'||/^(?:localhost|127\.|10\.|169\.254\.|192\.168\.|\[::1\])/.test(u.hostname))return route.abort();
   if(r.isNavigationRequest()&&r.frame()===r.frame().page().mainFrame()
    &&!['douyin.com','www.douyin.com','iesdouyin.com','www.iesdouyin.com'].includes(u.hostname))return route.abort();
   return route.continue();
  });
  const page=await context.newPage();page.setDefaultTimeout(3000);
  report.detail=await observe(page,{kind:'detail',contentId:PUBLIC_SAMPLE_ID});
  if(report.detail.status==='observed')report.list=await observe(page,{kind:'list',secUid:report.detail.data.secUid});
  report.status=report.list?.status==='observed'?'verified-public-list':'unavailable';
 }catch{report.status='unavailable';report.reason='runner-or-browser-error';}
 finally{
  await browser?.close().catch(()=>{});report.finishedAt=new Date().toISOString();
  await writeFile(join(process.env.RUNNER_TEMP,'mcn-public-smoke.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({status:report.status,detail:report.detail?.status,list:report.list?.status,modelCalls:0,privateDatasetRead:false}));
 }
 if(report.status!=='verified-public-list')process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main().catch(e=>{console.error(JSON.stringify({status:'not-started',code:e.code==='hosted-runner-required'?e.code:'runner-error'}));process.exitCode=2;});
}
