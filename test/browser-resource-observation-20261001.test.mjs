import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBrowserDocumentTarget, createBrowserResourceObservation }
  from '../lib/browser-resource-observation.mjs';

const secUid = 'MS4wLjABAAAAIndependentResourceObservation12345';
const profile = `https://www.douyin.com/user/${secUid}`;
const SECRET = 'PRIVATE_SIGNED_URL_CREDENTIAL_DO_NOT_PERSIST';
function request(kind = 'script', url = `https://cdn.fixture.invalid/${SECRET}`, previous = null) {
  return {
    resourceType: () => kind, url: () => url, redirectedFrom: () => previous,
    isNavigationRequest: () => kind === 'document',
    failure() { throw new Error(`must not read failure ${SECRET}`); },
    headers() { throw new Error(`must not read headers ${SECRET}`); },
    frame() { throw new Error(`must not read frame ${SECRET}`); },
    body() { throw new Error(`must not read body ${SECRET}`); },
  };
}
const response = (boundRequest, status) => ({ request: () => boundRequest, status: () => status,
  body() { throw new Error(SECRET); }, headers() { throw new Error(SECRET); } });
const observer = options => createBrowserResourceObservation({ secUid, ...options });

test('document target uses bounded canonical origin/path, never query identity guesses', () => {
  const cases = [
    [profile, 'same-profile'], [`${profile}/?tracking=${SECRET}`, 'same-profile'],
    [`${profile}?modal_id=123#${SECRET}`, 'same-profile'],
    ['https://www.douyin.com/user/other', 'other-profile'],
    ['https://www.douyin.com/login', 'login'], ['https://passport.douyin.com/', 'login'],
    ['https://www.douyin.com/verify/', 'verification'],
    ['https://www.douyin.com/captcha/step', 'verification'],
    ['https://www.douyin.com/challenge', 'verification'],
    ['https://www.douyin.com/login-about', 'other-official'],
    ['https://www.douyin.com.evil.invalid/login', 'other-origin'],
    ['https://douyin.com.evil.invalid/verify', 'other-origin'],
    ['http://www.douyin.com/login', 'other-origin'],
    ['https://www.douyin.com:444/verify', 'other-origin'],
    [`https://${SECRET}@www.douyin.com/login`, 'invalid'],
    ['javascript:alert(1)', 'invalid'], [null, 'invalid'], [SECRET.repeat(200), 'invalid'],
  ];
  for (const [url, expected] of cases) assert.equal(classifyBrowserDocumentTarget(url, secUid), expected);
  assert.equal(classifyBrowserDocumentTarget(profile, 'guessed-id'), 'unknown');
});

test('true linked HTTP redirects differ from same-URL reload and same-document history', () => {
  const o = observer(), first = request('document', profile);
  const redirect = request('document', `${profile}/?tracking=${SECRET}`, first);
  o.request(first, { isMainFrame: true });
  assert.equal(o.snapshot().documents.lastRelation, 'initial');
  o.finished(first);
  o.request(redirect, { isMainFrame: true });
  assert.equal(o.snapshot().documents.lastRelation, 'linked-http-redirect');
  o.sameDocument(`${profile}/?tracking=normal`);
  assert.equal(o.snapshot().documents.lastRelation, 'same-document');
  o.request(request('document', profile), { isMainFrame: true });
  assert.equal(o.snapshot().documents.lastRelation, 'new-document');
  o.request(request('document', profile, request('document', profile)), { isMainFrame: true });
  assert.equal(o.snapshot().documents.lastRelation, 'unknown');
  assert.deepEqual(o.snapshot().documents.relations,
    { initial: 1, 'linked-http-redirect': 1, 'new-document': 1, 'same-document': 1, unknown: 1 });
});

test('resource completion and HTTP errors are separate, all statuses bounded and deduplicated', () => {
  const o = observer(), script = request(), document = request('document', profile);
  assert.equal(o.request(script), true); assert.equal(o.request(script), false);
  o.response(response(script, 503)); o.response(response(script, 503));
  assert.equal(o.snapshot().resources.script.pending, 1);
  o.failed(script, 'connection'); o.finished(script); o.failed(script, 'connection');
  o.request(document, { isMainFrame: true }); o.response(response(document, 500)); o.finished(document);
  const s = o.snapshot();
  assert.deepEqual(s.resources.script.statusCounts, [{ status: 503, count: 1 }]);
  assert.equal(s.resources.script.requested, 1); assert.equal(s.resources.script.failed, 1);
  assert.equal(s.resources.script.finished, 0); assert.equal(s.resources.script.pending, 0);
  assert.deepEqual(s.resources.document.statusCounts, [{ status: 500, count: 1 }]);
  assert.equal(s.documents.lastStatus, 500);
  assert.equal(s.failuresByPhase.beforeStop.kinds.connection, 1);
});

test('a late previous-document response cannot overwrite the latest document status', () => {
  const o = observer(), first = request('document', profile), later = request('document', profile);
  o.request(first, { isMainFrame: true }); o.request(later, { isMainFrame: true });
  o.response(response(later, 200)); o.response(response(first, 302));
  assert.equal(o.snapshot().documents.lastStatus, 200);
  assert.deepEqual(o.snapshot().resources.document.statusCounts,
    [{ status: 200, count: 1 }, { status: 302, count: 1 }]);
});

test('failures are attributed by observation boundary, not by request start phase', () => {
  const o = observer(), a = request(), b = request(), c = request();
  for (const r of [a, b, c]) o.request(r);
  o.failed(a, 'dns'); assert.equal(o.markStop(), true); assert.equal(o.markStop(), false);
  o.failed(b, 'aborted'); assert.equal(o.beginCleanup(), true);
  assert.equal(o.beginCleanup(), false); o.failed(c, 'aborted');
  const s = o.close();
  assert.equal(s.phase, 'closed'); assert.equal(s.stopInitiated, true);
  assert.equal(s.failuresByPhase.beforeStop.kinds.dns, 1);
  assert.equal(s.failuresByPhase.afterStop.kinds.aborted, 1);
  assert.equal(s.failuresByPhase.cleanup.kinds.aborted, 1);
  assert.equal(s.resources.script.failed, 3);
  assert.deepEqual(o.close(), s);
});

test('capacity has no eviction/reattribution, strong requests release on terminal or close', () => {
  const o = observer({ maxRequests: 2 }), a = request(), b = request(), dropped = request();
  o.request(a); o.request(b); assert.equal(o.request(dropped), false);
  assert.equal(o.snapshot().trackedRequests, 2); assert.equal(o.snapshot().discarded.capacity, 1);
  o.failed(dropped, 'connection'); o.response(response(dropped, 503));
  assert.equal(o.snapshot().resources.script.failed, 0);
  o.finished(a); assert.equal(o.request(dropped), false);
  const admitted = request(); assert.equal(o.request(admitted), true);
  o.beginCleanup(); const closed = o.close();
  assert.equal(closed.trackedRequests, 0); assert.equal(closed.resources.script.pending, 0);
  assert.equal(closed.resources.script.unresolvedAtClose, 2);
  assert.equal(o.request(request()), false); assert.equal(o.failed(b, 'aborted'), false);
  assert.deepEqual(o.snapshot(), closed);
});

test('every persisted field is a fresh whitelist projection, no raw payload/getter is used', () => {
  const o = observer(), d = request('document', `${profile}?signed=${SECRET}#${SECRET}`);
  o.request(d, { isMainFrame: true }); o.response(response(d, 200));
  const r = request(SECRET); o.request(r); o.failed(r, `net::ERR_FAILED ${SECRET}`);
  const s = o.snapshot(), encoded = JSON.stringify(s);
  for (const forbidden of [SECRET, secUid, profile, 'https:', 'errorText', 'headers', 'body']) {
    assert.equal(encoded.includes(forbidden), false, forbidden);
  }
  assert.equal(s.resources.other.failed, 1); assert.equal(s.failuresByPhase.beforeStop.kinds.unknown, 1);
  assert.deepEqual(Object.keys(s), ['version', 'phase', 'stopInitiated', 'limits', 'trackedRequests',
    'discarded', 'documents', 'resources', 'failuresByPhase']);
  s.documents.targets['same-profile'] = 999; s.resources.document.statusCounts[0].count = 999;
  s.failuresByPhase.beforeStop.kinds.unknown = 999;
  const fresh = o.snapshot();
  assert.equal(fresh.documents.targets['same-profile'], 1);
  assert.equal(fresh.resources.document.statusCounts[0].count, 1);
  assert.equal(fresh.failuresByPhase.beforeStop.kinds.unknown, 1);
});

test('unknown/malformed requests never throw or promote arbitrary keys', () => {
  const o = observer();
  assert.equal(o.request(null), false);
  assert.equal(o.request({ resourceType() { throw new Error(SECRET); } }), false);
  const r = request('__proto__'); o.request(r, null); o.response(response(r, SECRET));
  assert.equal(o.snapshot().resources.other.invalidStatus, 1);
  assert.equal(o.response({ request() { throw new Error(SECRET); } }), false);
  o.request(request('document', 'broken'), { isMainFrame: true });
  assert.equal(o.snapshot().documents.lastTarget, 'invalid');
  assert.equal(JSON.stringify(o.snapshot()).includes(SECRET), false);
  assert.equal({}.polluted, undefined);
});

test('numeric counters and status cardinality saturate at explicit configured bounds', () => {
  const o = observer({ countLimit: 2, maxStatusCodes: 2 });
  for (const status of [200, 200, 200, 401, 403, 500]) {
    const r = request(); o.request(r); o.response(response(r, status)); o.failed(r, 'aborted');
  }
  const s = o.snapshot();
  assert.equal(s.resources.script.requested, 2); assert.equal(s.resources.script.failed, 2);
  assert.equal(s.failuresByPhase.beforeStop.total, 2);
  assert.deepEqual(s.resources.script.statusCounts, [{ status: 200, count: 2 }, { status: 401, count: 1 }]);
  assert.equal(s.resources.script.statusOverflow, 2);
  const capped = observer({ maxRequests: 999_999, countLimit: 999_999_999, maxStatusCodes: 999 });
  assert.deepEqual(capped.snapshot().limits, { maxRequests: 1_024, countLimit: 1_000_000, maxStatusCodes: 32 });
});

test('all resource kinds count independently; service-worker/subframe document is not main navigation', () => {
  const o = observer();
  for (const kind of ['document', 'script', 'stylesheet', 'xhr', 'fetch', 'image', 'font', 'websocket']) {
    const r = request(kind); o.request(r); o.finished(r);
  }
  const s = o.snapshot();
  for (const kind of Object.keys(s.resources)) {
    assert.equal(s.resources[kind].requested, 1); assert.equal(s.resources[kind].finished, 1);
  }
  assert.equal(s.documents.relations.initial, 0);
});
