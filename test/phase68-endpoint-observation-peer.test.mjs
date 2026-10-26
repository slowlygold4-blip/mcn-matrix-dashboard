import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isCdpAuthorPostsEndpointUrl, sanitizeCdpEndpointCounts } from '../lib/browser-cdp-endpoint-observation.mjs';
import { isExpectedDouyinWorksResponseUrl } from '../lib/douyin-browser-response-identity.mjs';
import { classifyBrowserWorksFailure } from '../lib/douyin-browser-failure.mjs';

// No browser, DB, network, process, credentials, timer, or production file write.
// Exercise the actual reducer with exactly these proposed additive hunks in memory.
// If root integrates these hunks, exercise that source and reconstruct the old
// shape by reversing only these same hunks. Fail closed on an unexpected source.
const reducerFile = new URL('../lib/browser-cdp-observation.mjs', import.meta.url);
const helperImport = "import { isCdpAuthorPostsEndpointUrl, sanitizeCdpEndpointCounts } from './browser-cdp-endpoint-observation.mjs';\n";
const HUNKS = [
  ["import { browserWorksCursor } from './browser-works-pagination.mjs';\n",
    "import { browserWorksCursor } from './browser-works-pagination.mjs';\n" + helperImport],
  ["        authorPosts: counts(value.failuresByPhase?.[phase]?.authorPosts, SCOPES),\n",
    "        authorPosts: counts(value.failuresByPhase?.[phase]?.authorPosts, SCOPES),\n" +
    "        ...(() => { try { const endpoint = sanitizeCdpEndpointCounts(value.failuresByPhase?.[phase]?.authorPostsEndpoint);\n" +
    "          return endpoint ? { authorPostsEndpoint: endpoint } : {}; } catch { return {}; } })(),\n"],
  ["    blockedReasons: record(BLOCKS), canceled: record(['yes', 'no', 'unknown']), authorPosts: record(SCOPES),\n",
    "    blockedReasons: record(BLOCKS), canceled: record(['yes', 'no', 'unknown']), authorPosts: record(SCOPES),\n" +
    "    authorPostsEndpoint: record(SCOPES),\n"],
  ["if (event.redirectResponse) { old.doc = null; old.authorPosts = false; old.redirected = true;",
    "if (event.redirectResponse) { old.doc = null; old.authorPosts = false; old.authorPostsEndpoint = false; old.redirected = true;"],
  ["const entry = { kind: resource, doc: null, authorPosts: false, redirected: false };",
    "const entry = { kind: resource, doc: null, authorPosts: false, authorPostsEndpoint: false, redirected: false };"],
  ["      pending.set(requestId, entry); bump(values, 'requested'); return true;",
    "      // Origin/path-only diagnostic; does not change strict authorPosts or request admission.\n" +
    "      try { entry.authorPostsEndpoint = resource !== 'document' && !event.redirectResponse\n" +
    "        && isCdpAuthorPostsEndpointUrl(event.request?.url); } catch { /* Optional URL metadata only. */ }\n" +
    "      pending.set(requestId, entry); bump(values, 'requested'); return true;"],
  ["        if (entry.authorPosts) {\n",
    "        if (entry.authorPostsEndpoint) bump(bucket.authorPostsEndpoint, relation);\n" +
    "        if (entry.authorPosts) {\n"],
];
const replaceOnce = (source, before, after) => {
  assert.equal(source.split(before).length - 1, 1, 'one exact integration anchor');
  return source.replace(before, after);
};
let candidateSource = readFileSync(reducerFile, 'utf8');
for (const [before, after] of HUNKS) {
  if (!candidateSource.includes(after)) candidateSource = replaceOnce(candidateSource, before, after);
}
let oldSource = candidateSource;
for (const [before, after] of [...HUNKS].reverse()) oldSource = replaceOnce(oldSource, after, before);
const dataSource = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const absoluteImports = (source, file, substitutions = new Map()) => source.replace(
  /from (["'])(\.\.?\/[^"'\n]+)\1/g,
  (_, _quote, relative) => `from ${JSON.stringify(substitutions.get(relative) ?? new URL(relative, file).href)}`);
const candidateUrl = dataSource(absoluteImports(candidateSource, reducerFile));
const importSource = source => import(dataSource(absoluteImports(source, reducerFile)));
const candidate = await importSource(candidateSource);
const old = await importSource(oldSource);

const SEC = 'MS4wLjABAAAAPhase68IndependentFixture';
const OTHER = 'MS4wLjABAAAAPhase68OtherAuthorFixture';
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const ENDPOINT = 'https://www.douyin.com/aweme/v1/web/aweme/post/';
const WORKS = `${ENDPOINT}?sec_user_id=${SEC}&max_cursor=0&signature=PHASE68_PRIVATE`;
const observer = (extra = {}, module = candidate) => module.createCdpObservation({ mainFrameId: 'root68', secUid: SEC, ...extra });
const req = (requestId, extra = {}) => ({ requestId, frameId: 'root68', loaderId: 'loader68', type: 'Fetch',
  request: { method: 'GET', url: WORKS }, ...extra });
const doc = (o, loaderId = 'loader68') => {
  const requestId = `document-${loaderId}`;
  o.request(req(requestId, { loaderId, type: 'Document', request: { method: 'GET', url: PROFILE } }));
  o.response({ requestId, frameId: 'root68', loaderId, type: 'Document', response: { status: 200, url: PROFILE } });
  o.commit({ frame: { id: 'root68', loaderId, url: PROFILE } });
};
const fail = (o, requestId) => o.failed({ requestId, blockedReason: 'other', canceled: false });
const bucket = (o, phase = 'beforeStop') => o.snapshot().failuresByPhase[phase];
const counts = (o, phase = 'beforeStop') => bucket(o, phase).authorPostsEndpoint;
const zero = () => ({ 'current-document': 0, 'prior-document': 0, unbound: 0 });
const strip = value => {
  const copy = structuredClone(value);
  for (const phase of ['beforeStop', 'afterStop', 'cleanup']) delete copy.failuresByPhase[phase].authorPostsEndpoint;
  return copy;
};
const noPrivate = value => {
  const serialized = JSON.stringify(value);
  for (const secret of [SEC, OTHER, PROFILE, 'root68', 'loader68', 'PHASE68_PRIVATE', 'https:', 'requestId', 'signature=', 'headers']) {
    assert.equal(serialized.includes(secret), false, `no ${secret}`);
  }
};

test('phase68: exact endpoint classification ignores query author/cursor/method, never proves ownership', () => {
  for (const value of [ENDPOINT, WORKS, ENDPOINT + '?arbitrary=PHASE68_PRIVATE',
    WORKS.replace(SEC, OTHER), WORKS.replace('max_cursor=0', 'max_cursor=bad'),
    WORKS.replace('.com/', '.com:443/'), WORKS.replace('https://www.', 'HTTPS://WWW.')]) {
    assert.equal(isCdpAuthorPostsEndpointUrl(value), true);
  }
  assert.equal(isCdpAuthorPostsEndpointUrl(WORKS.replace(SEC, OTHER)), true);
  assert.equal(isExpectedDouyinWorksResponseUrl(WORKS.replace(SEC, OTHER), SEC), false);
});

test('phase68: near paths, origins, userinfo, fragments, controls and overlength inputs fail closed', () => {
  const values = [null, undefined, 1, true, {}, [], new String(WORKS),
    WORKS.replace('www.douyin.com', 'douyin.com'), WORKS.replace('www.douyin.com', 'www.douyin.com.evil.test'),
    WORKS.replace('https:', 'http:'), WORKS.replace('.com/', '.com:444/'),
    WORKS.replace('https://', 'https://user:secret@'), WORKS.replace('https://', 'https://@'),
    WORKS.replace('post/', 'post'), WORKS.replace('post/', 'post/extra'), WORKS.replace('/post/', '/%70ost/'),
    WORKS.replace('aweme/post', 'locate/post'), WORKS + '#fragment', ' ' + WORKS, WORKS + '\n',
    WORKS.replace('https://', 'https:\\\\'), WORKS + 'x'.repeat(4096), 'not a url'];
  for (const value of values) assert.equal(isCdpAuthorPostsEndpointUrl(value), false);
  let coercions = 0;
  assert.equal(isCdpAuthorPostsEndpointUrl({ toString() { coercions++; throw Error('PHASE68_PRIVATE'); } }), false);
  assert.equal(coercions, 0);
});

test('phase68: fixed scope projection bounds, nulls, no coercion and no unknown getter reads', () => {
  let reads = 0;
  const value = { 'current-document': 0, 'prior-document': 1_000_000, unbound: 2,
    get url() { reads++; throw Error('PHASE68_PRIVATE'); },
    get headers() { reads++; throw Error('PHASE68_PRIVATE'); },
    get toJSON() { reads++; throw Error('PHASE68_PRIVATE'); } };
  assert.deepEqual(sanitizeCdpEndpointCounts(value), { 'current-document': 0, 'prior-document': 1_000_000, unbound: 2 });
  assert.equal(reads, 0);
  for (const field of Object.keys(zero())) for (const invalid of [-1, 1_000_001, 0.5, '1', true, null, undefined, NaN, Infinity, {}, [], 1n]) {
    assert.equal(sanitizeCdpEndpointCounts({ ...zero(), [field]: invalid })[field], null);
  }
  assert.deepEqual(sanitizeCdpEndpointCounts({ get 'current-document'() { throw Error('PHASE68_PRIVATE'); } }),
    { 'current-document': null, 'prior-document': null, unbound: null });
  for (const invalid of [undefined, null, 1, true, [], 'private']) assert.equal(sanitizeCdpEndpointCounts(invalid), null);
});

test('phase68: new zero counts explicit, old optional absence preserves exact JSON bytes', () => {
  const current = observer().snapshot(), prior = observer({}, old).snapshot();
  for (const phase of ['beforeStop', 'afterStop', 'cleanup']) assert.deepEqual(current.failuresByPhase[phase].authorPostsEndpoint, zero());
  assert.equal(JSON.stringify(candidate.sanitizeCdpObservation(prior)), JSON.stringify(prior));
  assert.deepEqual(strip(current), prior);
  assert.deepEqual(candidate.sanitizeCdpObservation(current), current);
  assert.deepEqual(candidate.sanitizeCdpObservation(JSON.parse(JSON.stringify(current))), current);
});

for (const [name, change] of [
  ['exact', {}], ['different author', { request: { method: 'GET', url: WORKS.replace(SEC, OTHER) } }],
  ['missing author', { request: { method: 'GET', url: ENDPOINT + '?max_cursor=0' } }],
  ['invalid cursor', { request: { method: 'GET', url: WORKS.replace('max_cursor=0', 'max_cursor=bad') } }],
  ['POST', { request: { method: 'POST', url: WORKS } }],
]) test(`phase68: endpoint vs strict authorPosts (${name})`, () => {
  const o = observer(), baseline = observer({}, old); doc(o); doc(baseline);
  o.request(req('works', change)); baseline.request(req('works', change)); fail(o, 'works'); fail(baseline, 'works');
  assert.equal(counts(o)['current-document'], 1);
  assert.equal(bucket(o).authorPosts['current-document'], name === 'exact' ? 1 : 0);
  assert.deepEqual(strip(o.snapshot()), baseline.snapshot()); noPrivate(o.snapshot());
});

test('phase68: different/near endpoint failures do not increase path-only counts', () => {
  const o = observer(); doc(o);
  for (const [i, url] of [WORKS.replace('www.douyin.com', 'example.test'), WORKS.replace('post/', 'post/extra'), PROFILE].entries()) {
    o.request(req(`other-${i}`, { request: { method: 'GET', url } })); fail(o, `other-${i}`);
  }
  assert.deepEqual(counts(o), zero()); assert.equal(bucket(o).scopes['current-document'], 3);
});

test('phase68: endpoint classification can be unbound without inventing document/author ownership', () => {
  for (const extra of [{ frameId: 'iframe' }, { frameId: undefined }, { loaderId: undefined }, { loaderId: 'unknown' }]) {
    const o = observer(); doc(o); o.request(req('unbound', extra)); fail(o, 'unbound');
    assert.equal(counts(o).unbound, 1); assert.equal(counts(o)['current-document'], 0);
    assert.deepEqual(bucket(o).authorPosts, zero());
  }
});

test('phase68: failure phase and document scope are determined at event time, never reprojected later', () => {
  const o = observer(); doc(o); o.request(req('old-before')); fail(o, 'old-before');
  o.request(req('old-late')); o.markStop(); doc(o, 'loader-new'); fail(o, 'old-late');
  o.request(req('new-cleanup', { loaderId: 'loader-new' })); o.beginCleanup(); fail(o, 'new-cleanup');
  assert.deepEqual(counts(o), { ...zero(), 'current-document': 1 });
  assert.deepEqual(counts(o, 'afterStop'), { ...zero(), 'prior-document': 1 });
  assert.deepEqual(counts(o, 'cleanup'), { ...zero(), 'current-document': 1 });
  const saved = o.snapshot().failuresByPhase; o.close();
  assert.deepEqual(o.snapshot().failuresByPhase, saved); noPrivate(o.snapshot());
});

test('phase68: pending duplicate and tombstoned duplicate do not read transient URL getters', () => {
  const o = observer(); doc(o); o.request(req('once'));
  let reads = 0;
  const duplicate = { requestId: 'once', get request() { reads++; throw Error('PHASE68_PRIVATE'); } };
  assert.equal(o.request(duplicate), false); fail(o, 'once'); assert.equal(o.request(duplicate), false);
  assert.equal(reads, 0); assert.equal(counts(o)['current-document'], 1);
});

test('phase68: redirects retire prior endpoint bit without reading new hop URL or inventing classification', () => {
  const o = observer(); doc(o); o.request(req('redirected'));
  let reads = 0;
  o.request({ requestId: 'redirected', redirectResponse: { status: 302 }, get request() { reads++; throw Error('PHASE68_PRIVATE'); } });
  fail(o, 'redirected'); assert.equal(reads, 0); assert.deepEqual(counts(o), zero());
  assert.equal(bucket(o).scopes.unbound, 1); assert.deepEqual(bucket(o).authorPosts, zero());
});

test('phase68: capacity guard precedes new URL reads and keeps existing cap unchanged', () => {
  const o = observer({ maxIdentifiers: 3 }); doc(o); o.request(req('fill'));
  let reads = 0;
  assert.equal(o.request({ requestId: 'overflow', get request() { reads++; throw Error('PHASE68_PRIVATE'); },
    get type() { reads++; throw Error('PHASE68_PRIVATE'); } }), false);
  assert.equal(reads, 0); assert.equal(o.snapshot().capacity, 1); assert.equal(o.snapshot().state, 'capacity-stopped');
  assert.equal(o.snapshot().retainedIdentifiers, 0); fail(o, 'fill'); assert.deepEqual(counts(o), zero());
  assert.equal(o.request({ get requestId() { reads++; throw Error('PHASE68_PRIVATE'); } }), false); assert.equal(reads, 0);
});

test('phase68: unavailable and old closed windows never read events and cannot contaminate new session', () => {
  let reads = 0;
  const hostile = { get requestId() { reads++; throw Error('PHASE68_PRIVATE'); }, get request() { reads++; throw Error('PHASE68_PRIVATE'); } };
  for (const o of [observer({ mainFrameId: null }), (() => { const x = observer(); doc(x); x.close(); return x; })()]) {
    const before = o.snapshot();
    for (const method of ['request', 'response', 'failed', 'finished']) assert.equal(o[method](hostile), false);
    assert.deepEqual(o.snapshot(), before);
  }
  const fresh = observer(); doc(fresh); fresh.request(req('fresh')); fail(fresh, 'fresh');
  assert.equal(counts(fresh)['current-document'], 1); assert.equal(reads, 0);
});

test('phase68: unknown and duplicate terminal events never read extra fields or double count', () => {
  const o = observer(); doc(o); o.request(req('once')); fail(o, 'once'); let reads = 0;
  for (const requestId of ['once', 'unknown']) o.failed({ requestId,
    get blockedReason() { reads++; throw Error('PHASE68_PRIVATE'); }, get url() { reads++; throw Error('PHASE68_PRIVATE'); } });
  assert.equal(reads, 0); assert.equal(counts(o)['current-document'], 1);
});

test('phase68: unknown request metadata is never read; optional URL failure does not change admission', () => {
  const o = observer(); doc(o); let reads = 0;
  o.request(req('private', { request: { method: 'POST', url: WORKS,
    get headers() { reads++; throw Error('PHASE68_PRIVATE'); }, get postData() { reads++; throw Error('PHASE68_PRIVATE'); } } }));
  fail(o, 'private'); assert.equal(reads, 0); assert.equal(counts(o)['current-document'], 1);
  const request = { method: 'POST', get url() { throw Error('PHASE68_PRIVATE'); } };
  assert.equal(o.request(req('throwing', { request })), true); fail(o, 'throwing');
  assert.equal(o.snapshot().invalid, 0); assert.equal(counts(o)['current-document'], 1); noPrivate(o.snapshot());
});

test('phase68: finished requests and documents are never endpoint failures', () => {
  const o = observer(); doc(o); o.request(req('finished')); o.finished({ requestId: 'finished' });
  o.request(req('doc-endpoint', { type: 'Document', request: { method: 'GET', url: WORKS } })); fail(o, 'doc-endpoint');
  assert.deepEqual(counts(o), zero());
});

test('phase68: bounded projection is detached, fixed-size, idempotent and leaves access denial unchanged', () => {
  const o = observer(); doc(o); o.request(req('once')); fail(o, 'once');
  const result = o.snapshot(), projected = candidate.sanitizeCdpObservation(result);
  result.failuresByPhase.beforeStop.authorPostsEndpoint['current-document'] = 99;
  assert.equal(projected.failuresByPhase.beforeStop.authorPostsEndpoint['current-document'], 1);
  assert.deepEqual(candidate.sanitizeCdpObservation(projected), projected);
  const largest = sanitizeCdpEndpointCounts(Object.fromEntries(Object.keys(zero()).map(key => [key, 1_000_000])));
  assert.ok(JSON.stringify(largest).length < 90);
  const diagnostics = { version: 1, cdpObservation: projected, stopReason: 'no-bound-request', requests: { candidate: 0, matched: 0 },
    navigation: { failed: false, timedOut: false } };
  for (const [status, expected] of [[401, 'login_required'], [403, 'blocked'], [429, 'rate_limited']]) {
    assert.equal(classifyBrowserWorksFailure({ httpStatuses: [status], failureDiagnostics: diagnostics }).errorCode, expected);
  }
  assert.deepEqual(classifyBrowserWorksFailure({ failureDiagnostics: diagnostics }),
    classifyBrowserWorksFailure({ failureDiagnostics: { ...diagnostics, cdpObservation: strip(projected) } }));
  assert.equal(classifyBrowserWorksFailure({ failureDiagnostics: diagnostics }).errorCode, 'collector_error');
  assert.equal(diagnostics.requests.matched, 0); noPrivate(projected);
});

test('phase68: throwing new optional envelope/count getters cannot erase existing CDP evidence', () => {
  const original = observer({}, old).snapshot(); let unknownReads = 0, knownReads = 0;
  for (const phase of ['beforeStop', 'afterStop', 'cleanup']) {
    Object.defineProperty(original.failuresByPhase[phase], 'authorPostsEndpoint', { enumerable: true,
      get() { knownReads++; throw Error('PHASE68_PRIVATE'); } });
    Object.defineProperty(original.failuresByPhase[phase], 'headers', { enumerable: true,
      get() { unknownReads++; throw Error('PHASE68_PRIVATE'); } });
  }
  const projected = candidate.sanitizeCdpObservation(original);
  assert.ok(projected); assert.equal(knownReads, 3); assert.equal(unknownReads, 0);
  assert.deepEqual(projected, observer({}, old).snapshot()); noPrivate(projected);
});

test('phase68: native URL objects and hostile URL getters never coerce or escape', () => {
  assert.equal(isCdpAuthorPostsEndpointUrl(new URL(WORKS)), false);
  const o = observer(); doc(o); let reads = 0, coercions = 0;
  for (const [i, url] of [{ toString() { coercions++; throw Error('PHASE68_PRIVATE'); } }, new URL(WORKS)].entries()) {
    o.request(req(`object-${i}`, { request: { method: 'POST', url } })); fail(o, `object-${i}`);
  }
  o.request(req('getter', { request: { method: 'POST', get url() { reads++; throw Error('PHASE68_PRIVATE'); } } })); fail(o, 'getter');
  assert.equal(reads, 1); assert.equal(coercions, 0); assert.deepEqual(counts(o), zero());
  assert.equal(o.snapshot().invalid, 0); noPrivate(o.snapshot());
});

test('phase68: actual reducer counter saturates at the unchanged one-million bound', async () => {
  const seeded = await importSource(replaceOnce(candidateSource, '    authorPostsEndpoint: record(SCOPES),',
    "    authorPostsEndpoint: Object.fromEntries(SCOPES.map(scope => [scope, 1_000_000])),"));
  const o = observer({}, seeded); doc(o); o.request(req('over')); fail(o, 'over');
  assert.equal(counts(o)['current-document'], 1_000_000);
});

test('phase68: wrong-author endpoint counter survives actual parent failure chain but never becomes accepted', async () => {
  const sanitizerFile = new URL('../lib/douyin-browser-diagnostics.mjs', import.meta.url);
  const sanitizerUrl = dataSource(absoluteImports(readFileSync(sanitizerFile, 'utf8'), sanitizerFile,
    new Map([['./browser-cdp-observation.mjs', candidateUrl]])));
  const failureFile = new URL('../lib/works-only-failure.mjs', import.meta.url);
  const failureUrl = dataSource(absoluteImports(readFileSync(failureFile, 'utf8'), failureFile,
    new Map([['./douyin-browser-diagnostics.mjs', sanitizerUrl]])));
  const providerFile = new URL('../lib/providers/public-web.mjs', import.meta.url);
  const providerSource = readFileSync(providerFile, 'utf8').replaceAll('import.meta.url', JSON.stringify(providerFile.href));
  const { PublicWebProvider } = await import(dataSource(absoluteImports(providerSource, providerFile,
    new Map([['../douyin-browser-diagnostics.mjs', sanitizerUrl], ['../works-only-failure.mjs', failureUrl]]))));
  const o = observer(); doc(o); o.request(req('wrong', { request: { method: 'GET', url: WORKS.replace(SEC, OTHER) } })); fail(o, 'wrong');
  const AT = '2026-10-01T15:25:48.000Z', now = Date.parse(AT); let calls = 0;
  const p = new PublicWebProvider({}, { accountBrowserFallback: true, now: () => now,
    worksRequestPolicyOptions: { now: () => now }, fetchImpl: () => { throw Error('NO_NETWORK'); },
    execFileImpl: (_file, _args, _options, done) => { calls++; done(null, JSON.stringify({ ok: true, data: { items: [
      { key: '42', status: 'unavailable', posts: [], errorCode: 'collector_error', failureDiagnostics: {
        version: 1, cdpObservation: o.snapshot(), stopReason: 'no-bound-request',
        navigation: { observed: true, committed: true, failed: false, timedOut: false },
        requests: { candidate: 0, matched: 0 }, responses: { matched: 0 }, httpStatuses: [],
      } },
    ] } }), 'PHASE68_PRIVATE'); } });
  const output = await p.collectWorksOnly(
    { id: 42, type: 'account', enabled: true, provider: 'public-web', locator: SEC, metadata: {} },
    { snapshotId: 4, sourceChecksum: 'a'.repeat(64), capturedAt: AT, secUid: SEC, uid: '12345678' });
  assert.equal(calls, 1); assert.equal(output.result.status, 'unavailable'); assert.deepEqual(output.result.posts, []);
  assert.equal(output.result.errorCode, 'collector_error');
  assert.equal(output.result.failureDiagnostics.cdpObservation.failuresByPhase.beforeStop.authorPostsEndpoint['current-document'], 1);
  assert.equal(output.result.failureDiagnostics.cdpObservation.failuresByPhase.beforeStop.authorPosts['current-document'], 0);
  assert.equal(output.result.failureDiagnostics.requests.matched, 0); assert.equal(output.result.failureDiagnostics.responses.matched, 0);
  assert.deepEqual(output.result.failureDiagnostics.httpStatuses, []);
  assert.doesNotMatch(JSON.stringify(output), /PHASE68_PRIVATE/);
});
