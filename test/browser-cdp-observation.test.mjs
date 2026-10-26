import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCdpObservation, sanitizeCdpObservation } from '../lib/browser-cdp-observation.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';
import { observePrivatePageCdp } from '../scripts/douyin_browser_collector.mjs';

const secUid = 'MS4wLjABAAAAabcdefghijklmnopqrstuv';
const profile = `https://www.douyin.com/user/${secUid}`;
const works = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${secUid}&max_cursor=0&count=20`;
const request = (requestId, type, loaderId = 'loader1', url = works) => ({ requestId, type, frameId: 'root', loaderId,
  request: { url, method: 'GET' } });
function document(observer, loader = 'loader1', responseFirst = true) {
  observer.request(request(`doc-${loader}`, 'Document', loader, profile));
  const response = () => observer.response({ requestId: `doc-${loader}`, type: 'Document', frameId: 'root', loaderId: loader,
    response: { status: 200, url: profile } });
  const commit = () => observer.commit({ frame: { id: 'root', loaderId: loader, url: profile } });
  if (responseFirst) { response(); commit(); } else { commit(); response(); }
}
test('CDP document requires both same-account 2xx and actual commit in either order', () => {
  for (const responseFirst of [true, false]) {
    const observer = createCdpObservation({ mainFrameId: 'root', secUid });
    document(observer, 'loader1', responseFirst);
    assert.equal(observer.snapshot().currentDocumentVerified, true);
    observer.request(request('work', 'Fetch'));
    observer.failed({ requestId: 'work', blockedReason: 'inspector', canceled: false });
    const output = observer.snapshot();
    assert.equal(output.failuresByPhase.beforeStop.scopes['current-document'], 1);
    assert.equal(output.failuresByPhase.beforeStop.authorPosts['current-document'], 1);
    assert.equal(output.failuresByPhase.beforeStop.blockedReasons.inspector, 1);
    assert.equal(output.failuresByPhase.beforeStop.canceled.no, 1);
  }
});
test('late prior-loader failure cannot become current-document evidence', () => {
  const observer = createCdpObservation({ mainFrameId: 'root', secUid });
  document(observer); observer.request(request('old', 'Fetch'));
  document(observer, 'loader2'); observer.failed({ requestId: 'old', blockedReason: 'csp' });
  const output = observer.snapshot();
  assert.equal(output.failuresByPhase.beforeStop.scopes['prior-document'], 1);
  assert.equal(output.failuresByPhase.beforeStop.scopes['current-document'], 0);
  assert.equal(output.failuresByPhase.beforeStop.canceled.unknown, 1);
});
test('CDP does not read sensitive metadata, unbound terminal fields or closed event getters', () => {
  const observer = createCdpObservation({ mainFrameId: 'root', secUid });
  document(observer); observer.request(request('work', 'Fetch'));
  const forbidden = () => { throw new Error('private_cookie=secret'); };
  observer.failed({ requestId: 'work', get errorText() { return forbidden(); },
    get headers() { return forbidden(); }, get blockedReason() { return forbidden(); }, get canceled() { return forbidden(); } });
  observer.failed({ requestId: 'unknown', get blockedReason() { return forbidden(); } });
  assert.equal(observer.snapshot().failuresByPhase.beforeStop.scopes['current-document'], 1);
  assert.equal(observer.snapshot().failuresByPhase.beforeStop.blockedReasons.unknown, 1);
  const final = observer.close('page-close-return');
  assert.equal(final.retainedIdentifiers, 0);
  assert.equal(observer.request({ get requestId() { return forbidden(); } }), false);
  assert.doesNotMatch(JSON.stringify(final), /secret|root|loader1|doc-loader|sec_user|https:/);
});
test('unknown inherited resource names only become other, and true works HTTP stays absent', () => {
  for (const type of ['constructor', '__proto__', 'toString']) {
    const observer = createCdpObservation({ mainFrameId: 'root', secUid }); document(observer);
    observer.request(request('x', type)); observer.failed({ requestId: 'x' });
    assert.equal(observer.snapshot().failuresByPhase.beforeStop.resources.other, 1);
    const diag = sanitizeBrowserWorksDiagnostics({ version: 1, cdpObservation: observer.snapshot(), httpStatuses: [],
      requests: { candidate: 0, matched: 0 } });
    assert.deepEqual(diag.httpStatuses, []); assert.equal(diag.requests.matched, 0);
    assert.equal(diag.cdpObservation.attribution, 'cdp-session-not-playwright-works-evidence');
  }
});
test('parent CDP projection excludes unknown fields and keeps old diagnostics byte shape', () => {
  const old = sanitizeBrowserWorksDiagnostics({ version: 1 });
  assert.equal(Object.hasOwn(old, 'cdpObservation'), false);
  const observer = createCdpObservation({ mainFrameId: 'root', secUid });
  const value = sanitizeCdpObservation({ ...observer.snapshot(), token: 'secret', requestId: 'secret' });
  assert.doesNotMatch(JSON.stringify(value), /secret|token|requestId/);
  assert.deepEqual(value, sanitizeCdpObservation(value));
});
test('private CDP adapter sends only three observation commands, removes six listeners on cleanup', async () => {
  const session = new EventEmitter(), commands = []; let detached = 0;
  session.send = async method => { commands.push(method); return method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'root' } } } : {}; };
  session.detach = async () => { detached++; };
  const page = {};
  const monitor = await observePrivatePageCdp({ newCDPSession: async actual => { assert.equal(actual, page); return session; } }, page, secUid);
  assert.ok(monitor); assert.deepEqual(commands, ['Page.enable', 'Network.enable', 'Page.getFrameTree']);
  assert.equal(session.eventNames().length, 6);
  monitor.markStop(); monitor.beginCleanup(); await monitor.close();
  assert.equal(session.eventNames().length, 0); assert.equal(detached, 1); assert.equal(monitor.snapshot().retainedIdentifiers, 0);
});
test('late session creation cannot enable observation after setup budget or retain listeners', async () => {
  let resolve; const opening = new Promise(yes => { resolve = yes; });
  const session = new EventEmitter(), commands = []; let detached = 0;
  session.send = async method => { commands.push(method); return {}; }; session.detach = async () => { detached++; };
  const result = await observePrivatePageCdp({ newCDPSession: () => opening }, {}, secUid, 5);
  assert.equal(result, null); resolve(session); await new Promise(yes => setImmediate(yes));
  assert.deepEqual(commands, []); assert.equal(session.eventNames().length, 0); assert.equal(detached, 1);
});
test('failed setup returns no monitor and releases its session without changing collection', async () => {
  const session = new EventEmitter(); let detached = 0;
  session.send = async () => { throw new Error('private-secret'); }; session.detach = async () => { detached++; };
  assert.equal(await observePrivatePageCdp({ newCDPSession: async () => session }, {}, secUid), null);
  await new Promise(yes => setImmediate(yes)); assert.equal(detached, 1); assert.equal(session.eventNames().length, 0);
});
