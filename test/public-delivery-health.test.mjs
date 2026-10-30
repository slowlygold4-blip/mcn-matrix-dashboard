import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectPublicDelivery, publicDeliveryFromSyncFailure } from '../lib/public-delivery-health.mjs';
const asOf = '2026-10-30T00:00:00.000Z', checkedAt = '2026-10-30T00:10:00.000Z';
const manifest = { version: 1, asOf, files: [{ path: 'catalog.json', sha256: 'a'.repeat(64) }] };
const expected = { asOf, manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') };
const html = () => new Response('<html><head><title>MCN 矩阵数据台</title></head><body>应用</body></html>', { headers: { 'content-type': 'text/html; charset=UTF-8' } });
const current = (extra = {}) => Response.json({ manifest, publishedAt: asOf, readOnly: true, collectionRequiresLocalComputer: true, ...extra });
const run = (fetchImpl, options = {}) => inspectPublicDelivery(expected, { fetchImpl, clock: () => checkedAt, ...options });
test('anonymous homepage and current pointer are separate from a successful generation readback', async () => {
  const paths = [];
  const r = await run(async (url, init) => {
    paths.push(url.pathname);
    assert.equal(url.origin, 'https://mcn-matrix-observatory.slowlygold4.chatgpt.site');
    assert.equal(url.search, ''); assert.equal(init.method, 'GET');
    assert.equal(init.headers, undefined); assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store');
    return url.pathname === '/' ? html() : current();
  });
  assert.deepEqual(paths, ['/', '/api/replica']);
  assert.equal(r.status, 'verified'); assert.equal(r.networkRequests, 2);
  assert.equal(r.scope, 'single-configured-runtime-network');
  assert.equal(r.guaranteesAllNetworks, false); assert.equal(r.browserVerified, false); assert.equal(r.dataPartitionsVerified, false);
  assert.equal(r.checks[0].applicationTitleVerified, true);
  assert.equal(r.checks[1].currentGenerationVerified, true);
});
for (const [status, code, expectedStatus] of [[401,'anonymous-access-denied','blocked'],[403,'anonymous-access-denied','blocked'],[429,'rate-limited','unavailable'],[503,'http-error','unavailable'],[302,'redirected','unavailable']]) {
  test(`homepage ${status} stops immediately, no cookie/token/identity/retry or later request`, async () => {
    let calls = 0;
    const r = await run(async () => { calls++; return new Response('private text MUST_NOT_RETURN', { status, headers: { location: 'https://private.invalid/secret' } }); });
    assert.equal(calls, 1); assert.equal(r.status, expectedStatus); assert.equal(r.code, code);
    assert.ok(!JSON.stringify(r).includes('MUST_NOT_RETURN')); assert.ok(!JSON.stringify(r).includes('private.invalid'));
  });
}
test('403 retains only whitelisted edge code and well-formed request identifier', async () => {
  const r = await run(async () => new Response('error code: 1010\nSECRET_DO_NOT_KEEP', { status: 403, headers: { 'cf-ray': 'aabbccddeeff0011-LAX', 'set-cookie': 'secret' } }));
  assert.equal(r.checks[0].edgeErrorCode, 1010); assert.equal(r.checks[0].cloudflareRayId, 'aabbccddeeff0011-LAX');
  assert.ok(!JSON.stringify(r).includes('SECRET')); assert.ok(!JSON.stringify(r).includes('set-cookie'));
  const hostile = await run(async () => new Response('custom error: secret', { status: 403, headers: { 'cf-ray': 'https://private.invalid/a' } }));
  assert.equal(hostile.checks[0].cloudflareRayId, undefined); assert.equal(hostile.checks[0].edgeErrorCode, undefined);
});
for (const response of [() => new Response('login',{headers:{'content-type':'text/plain'}}),
  () => new Response('<html><title>Sign in</title></html>',{headers:{'content-type':'text/html'}}),
  () => new Response('<html><title>Just a moment</title></html>',{headers:{'content-type':'text/html'}})]) {
  test('a successful login/challenge/foreign response is not the application', async () => {
    const r = await run(response); assert.equal(r.status,'mismatch'); assert.equal(r.networkRequests,1);
  });
}
for (const body of [{ manifest: { ...manifest, asOf: '2026-10-29T00:00:00.000Z' } },
  { manifest: { ...manifest, files: [] } }, { readOnly: false }, { collectionRequiresLocalComputer: false }, { publishedAt: 'invalid' }]) {
  test('a reachable current pointer must match the immutable confirmed generation', async () => {
    const r = await run(async url => url.pathname === '/' ? html() : current(body));
    assert.equal(r.status,'mismatch'); assert.equal(r.code,'current-generation-mismatch'); assert.equal(r.networkRequests,2);
  });
}
test('manifest status refusal cannot be masked by valid homepage or prior upload success', async () => {
  const r = await run(async url => url.pathname === '/' ? html() : new Response('denied',{status:403}));
  assert.equal(r.status,'blocked'); assert.equal(r.checks[0].applicationTitleVerified,true); assert.equal(r.checks[1].httpStatus,403);
});
test('malformed, foreign-type and oversized bodies stay bounded and cannot pass', async () => {
  const variants = [new Response('x'.repeat(256*1024+1),{headers:{'content-type':'text/html'}}),
    new Response('<html><title>MCN 矩阵数据台</title></html>',{headers:{'content-type':'text/plain'}})];
  for (const response of variants) assert.notEqual((await run(async()=>response)).status,'verified');
  for (const response of [new Response('{',{headers:{'content-type':'application/json'}}),html(),
    new Response('x'.repeat(8_000_001),{headers:{'content-type':'application/json'}})]) {
    assert.notEqual((await run(async url=>url.pathname==='/'?html():response)).status,'verified');
  }
});
test('bad inputs, clocks and pre-cancellation make zero requests', async () => {
  let calls=0;const fetchImpl=async()=>{calls++;throw Error('unexpected');};
  for (const input of [{}, { ...expected, asOf:'invalid' }, { ...expected, manifestSha256:'wrong' }]) {
    assert.equal((await inspectPublicDelivery(input,{fetchImpl,clock:()=>checkedAt})).code,'invalid-input');
  }
  for (const clock of [()=>null,()=>'wrong',()=>{throw Error('SECRET_CLOCK');}]) assert.equal((await run(fetchImpl,{clock})).code,'invalid-input');
  const controller=new AbortController();controller.abort();
  assert.equal((await run(fetchImpl,{signal:controller.signal})).code,'aborted'); assert.equal(calls,0);
});
test('transport exceptions and streaming failures expose no private messages', async () => {
  const secret='DO_NOT_REPORT_transport_secret';
  for (const fetchImpl of [async()=>{throw Error(secret);},async()=>new Response(new ReadableStream({start(c){c.error(Error(secret));}}),{headers:{'content-type':'text/html'}})]) {
    const r=await run(fetchImpl);assert.equal(r.status,'unavailable');assert.ok(!JSON.stringify(r).includes(secret));
  }
});

test('failed anonymous generation reads report visitor failure without another request or a fake global diagnosis', () => {
  const value={status:'failed',activated:true,asOf,transportFailure:{kind:'http',method:'GET',httpStatus:403,phase:'readback'}};
  const r=publicDeliveryFromSyncFailure(value,checkedAt);
  assert.equal(r.status,'blocked');assert.equal(r.networkRequests,0);assert.equal(r.asOf,asOf);
  assert.equal(r.evidence,'existing-anonymous-generation-readback');assert.equal(r.guaranteesAllNetworks,false);
  for(const patch of [{status:'success'}, {asOf:'invalid'}, {activated:false},
    {transportFailure:{...value.transportFailure,phase:'resume'}}, {transportFailure:{...value.transportFailure,method:'POST'}},
    {transportFailure:{kind:'network',method:'GET',httpStatus:null}}]) assert.equal(publicDeliveryFromSyncFailure({...value,...patch},checkedAt),null);
});

test('the current manifest supports the same bounded 8MB contract as replica synchronization, beyond 2MB',async()=>{
 const large={...manifest,files:Array.from({length:14000},(_,i)=>({path:['daily','works','work-metrics'][i%3]+'/'+(Math.floor(i/3)+1)+'.json',kind:'fixture',targetId:Math.floor(i/3)+1,sha256:'a'.repeat(64),bytes:100,count:1}))};
 assert.ok(Buffer.byteLength(JSON.stringify(large))>2*1024*1024);
 const result=await inspectPublicDelivery({asOf,manifestSha256:createHash('sha256').update(JSON.stringify(large)).digest('hex')},
  {clock:()=>checkedAt,fetchImpl:async url=>url.pathname==='/'?html():current({manifest:large})});
 assert.equal(result.status,'verified');
});
