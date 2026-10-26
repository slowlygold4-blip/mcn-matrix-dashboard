// Phase90 opt-in full-page preservation contract. No live requests or user state.
// limit remains the hard configured storage maximum. requestThreshold is a NEW
// explicit independent v2 contract; this test does not silently reinterpret 30.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ownerURL = process.env.PHASE90_OWNER_URL || new URL('../scripts/douyin_browser_collector.mjs', import.meta.url).href;
const fixture = (await readFile(new URL('./phase87-collector-peer.test.mjs', import.meta.url), 'utf8')).split('\ntest(')[0]
  .replace("process.env.PHASE87_OWNER_URL || '../scripts/douyin_browser_collector.mjs'", JSON.stringify(ownerURL))
  .replace('limit = 30, events = {}', 'limit = 30, requestThreshold, events = {}')
  .replace("key: 'phase87-local-only'", "key: '1'")
  .replace("secUid: SEC, limit },", "secUid: SEC, limit, requestThreshold },");
const { run, payload, SEC } = await import(`data:text/javascript;base64,${Buffer.from(fixture + '\nexport {run,payload,SEC};').toString('base64')}`);
const { normalizeBrowserCollectorInput } = await import(ownerURL);
const { validatedBrowserPagination } = await import(new URL('../lib/official-profile-evidence.mjs', ownerURL));
const { validateWorksOnlyEvidence } = await import(new URL('../lib/works-only-observation.mjs', ownerURL));
const { PublicWebProvider } = await import(new URL('../lib/providers/public-web.mjs', ownerURL));
const { isOfficialMixedProfileEnvelope, browserWorksObservation } = await import(new URL('../lib/official-profile-evidence.mjs', ownerURL));
const proof = process.env.PHASE90_V2_CANDIDATE_PROOF === '1' ? test : () => {};
const pageBody = (cursor, count, more) => ({ ...payload(cursor, more), aweme_list: Array.from({length: count}, (_,i) => ({
  ...payload(cursor).aweme_list[0], aweme_id: String(7234567890123400000n + BigInt(cursor * 100 + i)) })) });
const responses = (first, second, more = false) => ({0: {body:pageBody(0,first,true)}, 10: {body:pageBody(10,second,more)}, 20: {body:pageBody(20,1,false)}});
function canonical(result, requestedLimit) {
  const evidence = {version:1,kind:'works-only-observation',source:'authorised-browser',targetId:1,runId:2465,
    anchorSnapshotId:1,anchorChecksum:'a'.repeat(64),requestedLimit,identity:{secUid:SEC,uid:'1234567890'},
    requestStartedAt:new Date(0).toISOString(),requestFinishedAt:new Date(Date.now()).toISOString(),
    observedAt:result.pagination.pages.at(-1).observedAt,status:'accepted',coverage:'limited',errorCode:null,
    posts:result.posts.map(({aweme_id,author,statistics,desc,create_time})=>({aweme_id,
      author:{sec_uid:author.sec_uid,uid:author.uid},statistics,desc,create_time})),pagination:result.pagination};
  return validateWorksOnlyEvidence(evidence,{now:Date.now()});
}
test('phase90 actual owner baseline reproduces 2465 already-received terminal rows discarded by hard30', async t => {
  const {result,page} = await run(t,{responses:responses(29,9)});
  assert.deepEqual(result.pagination.pages.map(p=>[p.rawCount,p.acceptedCount,p.truncated]),[[29,29,false],[9,1,true]]);
  assert.equal(result.posts.length,30);assert.equal(result.pagination.version,1);
  assert.equal(result.pagination.stopReason,'filtered-rows');assert.equal(page.gets.length,2);
});
proof('phase90 actual owner v2 explicit hard100 threshold30 saves all terminal38 with no extra HTTP', async t => {
  const {result,page} = await run(t,{responses:responses(29,9)},{limit:100,requestThreshold:30});
  assert.equal(result.posts.length,38);assert.equal(result.pagination.version,2);
  assert.deepEqual(result.pagination.pages.map(p=>[p.rawCount,p.acceptedCount,p.truncated]),[[29,29,false],[9,9,false]]);
  assert.equal(result.pagination.stopReason,'end-of-list');assert.equal(page.gets.length,2);
  assert.equal(canonical(result,100).coverage,'limited');
});
proof('phase90 actual owner v2 2453 shape saves54 then stops at soft threshold without third GET', async t => {
  const {result,page} = await run(t,{responses:responses(25,29,true)},{limit:100,requestThreshold:30});
  assert.equal(result.posts.length,54);assert.deepEqual(page.gets.map(p=>p.cursor),[0,10]);
  assert.equal(result.pagination.stopReason,'item-limit');assert.equal(result.worksCoverage,'latest-public-window');
  assert.equal(canonical(result,100).posts.length,54);
});
proof('phase90 v2 hard100 remains a hard maximum and cannot claim complete when terminal page overflows', async t => {
  const {result,page} = await run(t,{responses:responses(29,80)},{limit:100,requestThreshold:30});
  assert.equal(result.posts.length,100);assert.equal(page.gets.length,2);
  assert.equal(result.pagination.pages.at(-1).truncated,true);
  assert.equal(result.pagination.stopReason,'filtered-rows');assert.equal(result.worksCoverage,'latest-public-window');
  assert.equal(canonical(result,100).coverage,'limited');
});
proof('phase90 v2 follows configured hard maximum20, not a magic100 override', async t => {
  const {result,page} = await run(t,{responses:responses(9,20)},{limit:20,requestThreshold:10});
  assert.equal(result.posts.length,20);assert.equal(page.gets.length,2);
  assert.equal(result.pagination.pages.at(-1).truncated,true);assert.equal(canonical(result,20).posts.length,20);
});
proof('phase90 v2 strict input preserves explicit contract and rejects impossible threshold', () => {
  const input={items:[{key:'local',secUid:SEC,limit:100,requestThreshold:30}]};
  assert.equal(normalizeBrowserCollectorInput(input)[0].requestThreshold,30);
  for(const requestThreshold of [0,-1,101,1.5,'30',null])
    assert.throws(()=>normalizeBrowserCollectorInput({items:[{...input.items[0],requestThreshold}]}));
  assert.throws(()=>normalizeBrowserCollectorInput({items:[{...input.items[0],limit:20}]}));
  assert.equal(Object.hasOwn(normalizeBrowserCollectorInput({items:[{key:'legacy',secUid:SEC,limit:30}]})[0],'requestThreshold'),false);
});
proof('phase90 v2 strict reader rejects altered threshold, hard bound and false end; legacy remains canonical', async t => {
  const {result}=await run(t,{responses:responses(25,29,true)},{limit:100,requestThreshold:30});
  const valid=value=>validatedBrowserPagination(value,{limit:100,posts:result.posts,hasMore:result.hasMore,maxCursor:result.maxCursor});
  assert.ok(valid(result.pagination));
  assert.equal(valid({...result.pagination,hardItemLimit:101}),null);
  assert.equal(valid({...result.pagination,requestThreshold:101}),null);
  assert.equal(valid({...result.pagination,requestThreshold:20}),null,'a second page after threshold already reached is forbidden');
  assert.equal(valid({...result.pagination,stopReason:'end-of-list'}),null);
  assert.equal(valid({...result.pagination,version:1}),null,'v2 surplus may not be silently downgraded to legacy');
});

const target={id:1,enabled:1,type:'account',provider:'public-web',locator:SEC,metadata:{platform:'douyin'}};
const anchor={snapshotId:1,sourceChecksum:'a'.repeat(64),secUid:SEC,uid:'1234567890',capturedAt:new Date(0).toISOString()};
const profileRaw=count=>({capturedAt:new Date(0).toISOString(),accountStatus:'validated',accountError:null,
  profile:{user:{sec_uid:SEC,uid:'1234567890',follower_count:12,total_favorited:33,aweme_count:count}},
  worksCoverage:'unavailable',worksErrorCode:'deferred',works:{stopReason:'request-deferred',pagination:{requestCount:0,pages:[]}},
  provenance:{mode:'guest-ttwid-unsigned-profile',profileMode:'guest-ttwid-unsigned-profile',
    profileEndpoint:'https://www.douyin.com/aweme/v1/web/user/profile/other/',accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false}});
const provenance={mode:'douyin-authorised-browser-post-response',authenticated:null,sessionLoaded:true,
  authorisedSessionUsed:true,authenticationStatus:'not-verified',paidAPI:false,runtimeAI:false,noChallengeBypass:true};
proof('phase90 v2 works-only provider retains all38 only for explicitly matching policy', async t=>{
  const {result}=await run(t,{responses:responses(29,9)},{limit:100,requestThreshold:30});
  for(const threshold of [30,undefined,20]){
    let calls=0;
    const provider=new PublicWebProvider({publicPostsPerAccount:100},{accountBrowserFallback:'browser',
      browserRequestThreshold:threshold,now:()=>calls++===0?0:Date.now()});
    provider.runBrowserWorks=async(item,opts)=>{
      assert.equal(item.limit,100);assert.equal(item.requestThreshold,threshold);assert.equal(opts.timeoutMs,45_000);
      return {items:[result],provenance};
    };
    const collected=await provider.collectWorksOnly(target,anchor);
    assert.equal(collected.requestedLimit,100);
    assert.equal(collected.result.status,threshold===30?'ok':'unavailable');
    if(threshold===30){assert.equal(collected.result.posts.length,38);assert.equal(collected.result.worksCoverage,'limited');}
  }
});
proof('phase90 v2 ordinary profile merge preserves all38 and requires exact fresh inventory to complete', async t=>{
  const {result}=await run(t,{responses:responses(29,9)},{limit:100,requestThreshold:30});
  for(const count of [38,701]){
    let calls=0;
    const provider=new PublicWebProvider({publicPostsPerAccount:100},{accountBrowserFallback:'browser',browserRequestThreshold:30,
      now:()=>calls++===0?0:Date.now()});
    provider.worksRequestPolicy.record('anonymous-http',{targetKey:SEC,errorCode:'rate_limited'});
    provider.run=async()=>profileRaw(count);
    provider.runBrowserWorks=async item=>{
      assert.deepEqual(item,{key:'1',secUid:SEC,limit:100,requestThreshold:30});return {items:[result],provenance};
    };
    const collected=await provider.collectAccount(target);
    assert.equal(collected.raw.works.aweme_list.length,38);
    assert.equal(collected.raw.works.pagination.version,2);
    assert.equal(collected.raw.worksCoverage,count===38?'complete':'latest-public-window');
    assert.equal(isOfficialMixedProfileEnvelope(collected.raw),true);
    assert.equal(browserWorksObservation(collected.raw).postTimes.size,38);
  }
});

proof('phase90 v2 actual immutable DB writer and public reader retain38 page times without profile mutation',async t=>{
  const {result}=await run(t,{responses:responses(29,9)},{limit:100,requestThreshold:30});
  const finished=Date.now();t.mock.timers.setTime(0);
  const {MonitorDatabase}=await import(new URL('../lib/database.mjs',ownerURL));
  const {normalizeCollection}=await import(new URL('../lib/providers/normalize.mjs',ownerURL));
  const {readWorksOnlyAnchor,recordWorksOnlyObservation}=await import(new URL('../lib/works-only-observation.mjs',ownerURL));
  const {loadVerifiedWorksOnlyRows}=await import(new URL('../lib/works-observation.mjs',ownerURL));
  const database=new MonitorDatabase(':memory:');
  try{
    const storedTarget=database.createTarget({type:'account',provider:'public-web',label:'offline-only',locator:SEC});
    const raw=profileRaw(701);database.saveCollection(storedTarget,null,normalizeCollection(storedTarget,raw,{capturedAt:raw.capturedAt}));
    const anchor=readWorksOnlyAnchor(database.db,storedTarget.id);
    const runId=database.beginRun('works-only',storedTarget.id,1);
    const protectedRows=()=>JSON.stringify(['targets','snapshots','audits'].map(table=>database.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()));
    const before=protectedRows();t.mock.timers.setTime(finished);
    const written=recordWorksOnlyObservation(database.db,{targetId:storedTarget.id,runId,anchorSnapshotId:anchor.snapshotId,
      anchorChecksum:anchor.sourceChecksum,requestStartedAt:new Date(0).toISOString(),requestFinishedAt:new Date(finished).toISOString(),requestedLimit:100,result},{now:finished});
    assert.equal(written.coverage,'limited');assert.equal(protectedRows(),before);
    assert.equal(database.db.prepare('SELECT COUNT(*) n FROM post_metrics').get().n,38);
    const times=database.db.prepare('SELECT captured_at,COUNT(*) n FROM post_metrics GROUP BY captured_at ORDER BY captured_at').all();
    assert.deepEqual(times.map(p=>p.n),[29,9]);
    assert.deepEqual(times.map(p=>p.captured_at),result.pagination.pages.map(p=>p.observedAt));
    database.finishRun(runId,{status:'partial',processedCount:1,successCount:1});
    const read=loadVerifiedWorksOnlyRows(database.db,new Date(finished).toISOString(),storedTarget.id,{runId});
    assert.equal(read.length,1);assert.equal(read[0].list_count,38);assert.equal(read[0].coverage,'limited');
    const saved=database.db.prepare('SELECT raw_json FROM works_observations').get().raw_json;
    assert.equal(JSON.parse(saved).pagination.version,2);
    assert.throws(()=>database.db.exec('UPDATE works_observations SET coverage=\'limited\''));
    assert.equal(database.db.prepare('SELECT raw_json FROM works_observations').get().raw_json,saved);
  }finally{database.close();}
});

if(process.env.PHASE90_CHROME_PROOF==='1') proof('phase90 actual Chrome full-page38 and hard100, all traffic fulfilled locally',async()=>{
  const {collectOne}=await import(ownerURL);
  const {chromium}=await import('playwright-core');
  const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,timeout:10_000});
  try{await Promise.all([['terminal38',29,9,false,38,'end-of-list'],['more54',25,29,true,54,'item-limit'],['hard100',29,80,false,100,'filtered-rows']].map(async([kind,first,second,more,total,stop])=>{
    const context=await browser.newContext({serviceWorkers:'block',locale:'zh-CN'});
    const traffic={cursors:[],counts:[],documents:0,external:0};
    try{
      await context.route('**/*',async route=>{
        const req=route.request(),url=new URL(req.url());
        if(req.isNavigationRequest()&&url.href===`https://www.douyin.com/user/${SEC}`){traffic.documents++;return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><head><title>Local Phase90</title></head><body><main>Local fixture</main></body></html>'});}
        if(url.origin==='https://www.douyin.com'&&url.pathname==='/aweme/v1/web/aweme/post/'){
          assert.equal(url.searchParams.get('sec_user_id'),SEC);const cursor=Number(url.searchParams.get('max_cursor'));traffic.cursors.push(cursor);traffic.counts.push(Number(url.searchParams.get('count')));
          return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(responses(first,second,more)[cursor]?.body??pageBody(cursor,1,false))});
        }
        traffic.external++;return route.abort();
      });
      const result=await collectOne(await context.newPage(),{key:kind,secUid:SEC,limit:100,requestThreshold:30});
      assert.equal(result.posts.length,total);assert.equal(result.pagination.stopReason,stop);
      assert.deepEqual(traffic.cursors,[0,10]);assert.deepEqual(traffic.counts,[30,30]);assert.equal(traffic.documents,1);assert.equal(traffic.external,0);
      assert.ok(result.failureDiagnostics.elapsedMs<=45_000);
      console.log(JSON.stringify({kind,posts:result.posts.length,stop,elapsedMs:result.failureDiagnostics.elapsedMs,...traffic,allTrafficLocallyFulfilled:true}));
    }finally{await context.close();}
  }));}finally{await browser.close();}
});
