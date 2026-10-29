import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { miniAppVideoReadiness, probeOfficialMiniAppVideos } from '../lib/douyin-open-api-probe.mjs';
const input = { accessToken: 'act.fixture-not-real', openId: 'fixture-open-id', scopes: ['ma.video.bind'], accountKey: 'fixture:account', itemIds: ['@opaque+/='] };
const clock = () => '2026-10-30T01:00:00.000Z';
const video = (id = input.itemIds[0], stats = {}) => ({ item_id: id, title: 'fixture', create_time: 1793260800, statistics: stats });
const envelope = list => ({ err_no: 0, data: { extra: { error_code: 0, sub_error_code: 0 }, data: { list } } });
const run = (list, opts = {}, params = {}) => probeOfficialMiniAppVideos({ ...input, ...params }, { clock, fetchImpl: async () => new Response(JSON.stringify(envelope(list))), ...opts });

test('current mini-app permission is separate from legacy video.list, all prerequisites fail before transport', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw Error('unexpected'); };
  for (const params of [{ accessToken: '' }, { openId: 'bad\nheader' }])
    await assert.rejects(run([], { fetchImpl }, params), { code: 'authorization_required' });
  await assert.rejects(run([], { fetchImpl }, { scopes: ['video.list'] }), { code: 'scope_required' });
  for (const itemIds of [[], ['a','a'], [1], ['bad\nID'], Array.from({length:6},(_,i)=>'@'+i)])
    await assert.rejects(run([], { fetchImpl }, { itemIds }), { code: 'invalid_input' });
  assert.equal(calls, 0);
});

test('one bounded POST to the documented official path, opaque item IDs stay in JSON and token only in header', async () => {
  let calls = 0;
  const result = await run([video()], { fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url.origin, 'https://open.douyin.com');
    assert.equal(url.pathname, '/api/apps/v1/video/query/');
    assert.equal(url.searchParams.get('open_id'), input.openId);
    assert.equal(url.searchParams.has('access_token'), false);
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers['access-token'], input.accessToken);
    assert.deepEqual(JSON.parse(options.body), { item_ids: input.itemIds });
    return new Response(JSON.stringify(envelope([video()])));
  } });
  assert.equal(calls, 1);
  assert.equal(result.videos[0].officialItemId, '@opaque+/=');
  assert.equal(result.videos[0].publicContentId, null);
  assert.equal(result.videos[0].observedAt, clock());
  assert.equal(result.identityBindingVerified, false);
  assert.equal(result.productionAdmitted, false);
  assert.equal(result.allAuthorWorksCollected, false);
  assert.equal(result.databaseWrites, 0); assert.equal(result.modelCalls, 0);
  assert.ok(!JSON.stringify(result).includes(input.accessToken));
});

test('zero is actual zero, missing/negative/unsafe plays remain unavailable; likes never generate plays', async () => {
  for (const [stats, plays, source] of [[{play_count:0,digg_count:999},0,'api'], [{digg_count:999},null,'unavailable'],
    [{play_count:-1},null,'unavailable'], [{play_count:Number.MAX_SAFE_INTEGER+1},null,'unavailable']]) {
    const result = await run([video(undefined, stats)]);
    assert.equal(result.videos[0].plays, plays); assert.equal(result.videos[0].plays_source, source);
  }
});

test('private-video create_time=0 placeholder never exposes counts as observations', async () => {
  const result = await run([{...video(undefined, {play_count:100,digg_count:0}), create_time:0}]);
  assert.equal(result.videos[0].publishedAt, null);
  assert.equal(result.videos[0].likes, null); assert.equal(result.videos[0].plays, null);
  assert.equal(result.videos[0].availability, 'not_public_or_unavailable');
});

test('unreturned requested IDs are explicit gaps rather than zero-count videos', async () => {
  const result = await run([], {}, { itemIds:['@one','@two'] });
  assert.deepEqual(result.missingOfficialItemIds, ['@one','@two']);
  assert.deepEqual(result.videos, []); assert.equal(result.returnedCount,0);
  assert.equal(result.allAuthorWorksCollected,false);
});

test('unexpected or duplicated returned IDs fail rather than pollute the source mapping', async () => {
  await assert.rejects(run([video('@different')]), { code:'item_identity_mismatch' });
  await assert.rejects(run([video('@one'),video('@one')], {}, { itemIds:['@one','@two'] }), {code:'item_identity_mismatch'});
});

test('HTTP denial, rate limits and transport failure stop after one request and do not expose secrets', async () => {
  for (const [status,code] of [[401,'authorization_required'],[403,'permission_denied'],[429,'rate_limited'],[500,'upstream_http_error']]) {
    let calls=0;
    await assert.rejects(run([], {fetchImpl:async()=>{calls++;return new Response(input.accessToken,{status});}}), {code,message:code});
    assert.equal(calls,1);
  }
  await assert.rejects(run([], {fetchImpl:async()=>{throw Error(input.accessToken);}}), {code:'network_error',message:'network_error'});
});

test('all official envelope error levels and missing success codes fail closed', async () => {
  await assert.rejects(run([], {fetchImpl:async()=>new Response(JSON.stringify({err_no:28001008,err_msg:input.accessToken}))}),
    {code:'platform_error',message:'platform_error',officialErrorCode:28001008});
  for (const body of [
    {...envelope([]),err_no:28001008},
    {err_no:0,data:{extra:{error_code:1},data:{list:[]}}},
    {err_no:0,data:{extra:{error_code:0,sub_error_code:1},data:{list:[]}}},
  ]) await assert.rejects(run([], {fetchImpl:async()=>new Response(JSON.stringify(body))}), {code:'platform_error'});
  for (const body of [{data:{extra:{error_code:0},data:{list:[]}}}, {err_no:0,data:{extra:{},data:{list:[]}}}, {err_no:0,data:{extra:{error_code:0},data:{list:null}}}])
    await assert.rejects(run([], {fetchImpl:async()=>new Response(JSON.stringify(body))}), {code:'invalid_response'});
});

test('oversized/HTML responses and invalid clock cannot become successful snapshots', async () => {
  for (const [body,code] of [['<html>login</html>','invalid_response'], [' '.repeat(2*1024*1024+1),'response_too_large']])
    await assert.rejects(run([], {fetchImpl:async()=>new Response(body)}), {code});
  await assert.rejects(run([], {clock:()=> 'invalid'}), {code:'invalid_clock'});
});

test('pre-cancelled requests never start transport', async () => {
  const c = new AbortController(); c.abort(); let calls=0;
  await assert.rejects(run([], {signal:c.signal,fetchImpl:async()=>{calls++;throw Error('unexpected');}}), {code:'cancelled'});
  assert.equal(calls,0);
});

test('readiness CLI contains no IDs or credentials and makes zero network/model/database calls', () => {
  const child=spawnSync(process.execPath,['scripts/probe-douyin-open-api.mjs','--miniapp'], {
    cwd:new URL('../',import.meta.url),encoding:'utf8',env:{...process.env,DOUYIN_OPEN_ACCESS_TOKEN:input.accessToken,
      DOUYIN_OPEN_ID:input.openId,DOUYIN_OPEN_SCOPES:'ma.video.bind',DOUYIN_OPEN_ITEM_IDS:JSON.stringify(input.itemIds)}
  });
  assert.equal(child.status,0,child.stderr);const r=JSON.parse(child.stdout);
  assert.equal(r.api,'miniapp-query');assert.equal(r.miniAppVideoScopeDeclared,true);assert.equal(r.officialItemIdsValid,true);
  assert.equal(r.networkRequests,0);assert.equal(r.databaseWrites,0);assert.equal(r.modelCalls,0);
  assert.ok(!child.stdout.includes(input.accessToken));assert.ok(!child.stdout.includes(input.openId));assert.ok(!child.stdout.includes(input.itemIds[0]));
});

test('readiness checks declare presence, never platform grants or author ownership',()=>{
  const r=miniAppVideoReadiness(input);
  assert.equal(r.platformPermissionVerified,false);assert.equal(r.identityBindingVerified,false);
});
