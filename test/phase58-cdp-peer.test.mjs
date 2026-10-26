import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCdpObservation, sanitizeCdpObservation } from '../lib/browser-cdp-observation.mjs';
import { collectBrowserWorks, observePrivatePageCdp } from '../scripts/douyin_browser_collector.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';

// Actual production reducer, independent fixtures: no browser, platform HTTP,
// state file, credentials, DB, timer or private Playwright API is involved.
const SEC = 'MS4wLjABAAAAPhase58IndependentPeerOnly';
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const WORKS = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0&secret=PHASE58_PRIVATE`;
const FRAME = 'private-frame-phase58';
const observer = extra => createCdpObservation({ mainFrameId: FRAME, secUid: SEC, ...extra });
const request = (requestId, loaderId = 'loader-1', extra = {}) => ({ requestId, frameId: FRAME, loaderId,
  type: 'Fetch', request: { method: 'GET', url: WORKS }, ...extra });
const doc = (o, loaderId = 'loader-1', { order = 'response-first', status = 200, url = PROFILE } = {}) => {
  o.request(request(`document-${loaderId}`, loaderId, { type: 'Document', request: { method: 'GET', url } }));
  const response = () => o.response({ requestId: `document-${loaderId}`, frameId: FRAME, loaderId,
    type: 'Document', response: { status, url } });
  const commit = () => o.commit({ frame: { id: FRAME, loaderId, url } });
  if (order === 'commit-first') { commit(); response(); } else { response(); commit(); }
};
const failed = (o, requestId, extra = {}) => o.failed({ requestId, type: 'Fetch',
  blockedReason: 'subresource-filter', ...extra });
const bucket = (o, phase = 'beforeStop') => o.snapshot().failuresByPhase[phase];
const noPrivate = value => {
  const text = JSON.stringify(value);
  for (const privateValue of [SEC, FRAME, 'loader-1', 'PHASE58_PRIVATE', PROFILE, 'https://', 'errorText', 'requestId', 'Cookie']) {
    assert.equal(text.includes(privateValue), false, `no persisted ${privateValue}`);
  }
};

for (const order of ['response-first', 'commit-first']) {
  test(`phase58 peer: real document facts bind in either order (${order})`, () => {
    const o = observer(); doc(o, 'loader-1', { order });
    assert.equal(o.snapshot().currentDocumentVerified, true);
    o.request(request('works')); failed(o, 'works', { canceled: false });
    assert.equal(bucket(o).scopes['current-document'], 1);
    assert.equal(bucket(o).authorPosts['current-document'], 1);
    assert.equal(bucket(o).blockedReasons['subresource-filter'], 1);
    assert.equal(bucket(o).canceled.no, 1); noPrivate(o.snapshot());
  });
}

for (const missing of ['request', 'response', 'commit']) {
  test(`phase58 peer: missing ${missing} never verifies current document`, () => {
    const o = observer();
    if (missing !== 'request') o.request(request('document', 'loader-1', { type: 'Document', request: { method: 'GET', url: PROFILE } }));
    if (missing !== 'response') o.response({ requestId: 'document', frameId: FRAME, loaderId: 'loader-1', type: 'Document', response: { status: 200, url: PROFILE } });
    if (missing !== 'commit') o.commit({ frame: { id: FRAME, loaderId: 'loader-1', url: PROFILE } });
    o.request(request('works')); failed(o, 'works');
    assert.equal(o.snapshot().currentDocumentVerified, false);
    assert.equal(bucket(o).scopes.unbound, 1);
    assert.equal(bucket(o).authorPosts['current-document'], 0);
  });
}

for (const status of [0, 199, 301, 403, 500, '200', NaN]) {
  test(`phase58 peer: document status ${String(status)} cannot establish 2xx evidence`, () => {
    const o = observer(); doc(o, 'loader-1', { status });
    o.request(request('works')); failed(o, 'works');
    assert.equal(o.snapshot().currentDocumentVerified, false);
    assert.equal(bucket(o).scopes.unbound, 1);
    assert.equal(bucket(o).authorPosts['current-document'], 0);
  });
}

test('phase58 peer: old loader failure after new current commit is prior, never current', () => {
  const o = observer(); doc(o); o.request(request('old-works'));
  doc(o, 'loader-2'); o.request(request('new-works', 'loader-2'));
  failed(o, 'old-works'); failed(o, 'new-works');
  assert.equal(bucket(o).scopes['prior-document'], 1);
  assert.equal(bucket(o).scopes['current-document'], 1);
  assert.equal(bucket(o).authorPosts['prior-document'], 1);
});

test('phase58 peer: new main document request immediately retires current before response or commit', () => {
  const o = observer(); doc(o); o.request(request('old-pending'));
  o.request(request('new-doc', 'loader-2', { type: 'Document', request: { method: 'GET', url: PROFILE } }));
  failed(o, 'old-pending');
  assert.equal(o.snapshot().currentDocumentVerified, false);
  assert.equal(bucket(o).scopes['prior-document'], 1);
  assert.equal(bucket(o).scopes['current-document'], 0);
});

test('phase58 peer: POST main document never establishes profile identity', () => {
  const o = observer();
  o.request(request('post-document', 'loader-1', { type: 'Document', request: { method: 'POST', url: PROFILE } }));
  o.response({ requestId: 'post-document', frameId: FRAME, loaderId: 'loader-1', type: 'Document', response: { status: 200, url: PROFILE } });
  o.commit({ frame: { id: FRAME, loaderId: 'loader-1', url: PROFILE } });
  assert.equal(o.snapshot().currentDocumentVerified, false);
  o.request(request('post-document-works')); failed(o, 'post-document-works');
  assert.equal(bucket(o).scopes['current-document'], 0);
});

test('phase58 peer: same-document event keeps profile loader but cannot itself prove document', () => {
  const o = observer(); o.sameDocument({ frameId: FRAME, url: PROFILE });
  assert.equal(o.snapshot().currentDocumentVerified, false);
  doc(o); o.sameDocument({ frameId: FRAME, url: PROFILE });
  assert.equal(o.snapshot().currentDocumentVerified, true);
  o.sameDocument({ frameId: FRAME, url: 'https://www.douyin.com/passport/login' });
  assert.equal(o.snapshot().currentDocumentVerified, false);
  o.request(request('after-login')); failed(o, 'after-login');
  assert.equal(bucket(o).scopes['current-document'], 0);
});

test('phase58 peer: late old commit fails closed and cannot rebind new document', () => {
  const o = observer(); doc(o); doc(o, 'loader-2');
  o.commit({ frame: { id: FRAME, loaderId: 'loader-1', url: PROFILE } });
  o.request(request('new-after-old', 'loader-2')); failed(o, 'new-after-old');
  assert.equal(o.snapshot().currentDocumentVerified, false);
  assert.equal(bucket(o).scopes['current-document'], 0);
});

test('phase58 peer: HTTP redirect reused ID erases hop binding rather than guessing', () => {
  const o = observer(); doc(o); o.request(request('redirected'));
  o.request(request('redirected', 'loader-1', { redirectResponse: { status: 302 }, request: { method: 'GET', url: 'https://example.test/?token=[REDACTED]' } }));
  failed(o, 'redirected');
  assert.equal(bucket(o).scopes.unbound, 1);
  assert.equal(bucket(o).authorPosts['current-document'], 0);
  assert.equal(bucket(o).authorPosts.unbound, 0);
  noPrivate(o.snapshot());
});

test('phase58 peer: new document redirect invalidates current instead of reusing prior 200', () => {
  const o = observer(); doc(o);
  o.request(request('document-loader-1', 'loader-1', { type: 'Document', redirectResponse: { status: 302 } }));
  assert.equal(o.snapshot().currentDocumentVerified, false);
  o.request(request('after-doc-redirect')); failed(o, 'after-doc-redirect');
  assert.equal(bucket(o).scopes['current-document'], 0);
});

for (const extra of [{ frameId: 'iframe' }, { frameId: undefined }, { loaderId: '' }, { loaderId: undefined }, { loaderId: 'other-loader' }]) {
  test(`phase58 peer: worker, iframe or missing loader stays unbound ${JSON.stringify(extra)}`, () => {
    const o = observer(); doc(o); o.request(request('unbound', 'loader-1', extra)); failed(o, 'unbound');
    assert.equal(bucket(o).scopes.unbound, 1);
    assert.equal(bucket(o).authorPosts['current-document'], 0);
  });
}

test('phase58 peer: same protocol ID in independent session cannot inherit document identity', () => {
  const a = observer(), b = observer(); doc(a);
  a.request(request('identical')); b.request(request('identical'));
  failed(a, 'identical'); failed(b, 'identical');
  assert.equal(bucket(a).scopes['current-document'], 1); assert.equal(bucket(b).scopes.unbound, 1);
});

test('phase58 peer: terminal duplicate and unknown event never inspect extra getters', () => {
  const o = observer(); doc(o); o.request(request('once')); failed(o, 'once');
  let reads = 0;
  const dangerous = requestId => ({ requestId, get blockedReason() { reads++; throw new Error('PHASE58_PRIVATE'); },
    get canceled() { reads++; throw new Error('PHASE58_PRIVATE'); }, get errorText() { reads++; throw new Error('PHASE58_PRIVATE'); } });
  o.failed(dangerous('once')); o.failed(dangerous('not-seen'));
  assert.equal(reads, 0); assert.equal(o.snapshot().failed, 1); assert.equal(bucket(o).scopes['current-document'], 1);
  assert.equal(o.snapshot().duplicates, 1); assert.equal(o.snapshot().untracked, 1); noPrivate(o.snapshot());
});

test('phase58 peer: missing canceled differs from explicit false and true', () => {
  const o = observer(); doc(o);
  for (const [key, canceled] of [['missing', undefined], ['false', false], ['true', true]]) {
    o.request(request(key)); failed(o, key, { canceled });
  }
  assert.deepEqual(bucket(o).canceled, { yes: 1, no: 1, unknown: 1 });
});

test('phase58 peer: errorText, headers and signature getters never read', () => {
  const o = observer(); doc(o); let reads = 0;
  o.request(request('private', 'loader-1', { request: { method: 'GET', url: WORKS,
    get headers() { reads++; throw new Error('PHASE58_PRIVATE'); }, get postData() { reads++; throw new Error('PHASE58_PRIVATE'); } } }));
  o.failed({ requestId: 'private', type: 'Fetch', blockedReason: 'subresource-filter',
    get errorText() { reads++; throw new Error('PHASE58_PRIVATE'); } });
  assert.equal(reads, 0); noPrivate(o.snapshot());
});

test('phase58 peer: arbitrary and sensitive blocked reason values map to unknown', () => {
  const o = observer(); doc(o);
  for (const [n, blockedReason] of [null, false, 403, 'csp ', 'CSP', 'csp https://private.test/PHASE58_PRIVATE', {}, '__proto__'].entries()) {
    o.request(request(`reason-${n}`)); failed(o, `reason-${n}`, { blockedReason });
  }
  assert.equal(bucket(o).blockedReasons.unknown, 8); noPrivate(o.snapshot());
});

test('phase58 peer: blocked reason accessor is read once, preventing whitelist TOCTOU', () => {
  const o = observer(); doc(o); o.request(request('changing'));
  let reads = 0;
  o.failed({ requestId: 'changing', type: 'Fetch', get blockedReason() {
    reads++; return reads === 1 ? 'csp' : 'PHASE58_PRIVATE';
  }, canceled: false });
  assert.equal(reads, 1);
  assert.equal(bucket(o).blockedReasons.csp, 1);
  noPrivate(o.snapshot());
});

test('phase58 peer: throwing optional failure metadata still records honest unknown counters', () => {
  const o = observer(); doc(o); o.request(request('throwing'));
  assert.doesNotThrow(() => o.failed({ requestId: 'throwing', type: 'Fetch',
    get blockedReason() { throw new Error('PHASE58_PRIVATE'); },
    get canceled() { throw new Error('PHASE58_PRIVATE'); } }));
  assert.equal(o.snapshot().failed, 1);
  assert.equal(bucket(o).blockedReasons.unknown, 1);
  assert.equal(bucket(o).canceled.unknown, 1);
  noPrivate(o.snapshot());
});

test('phase58 peer: prototype type names must project to fixed other enum', () => {
  const o = observer(); doc(o);
  for (const [n, type] of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'].entries()) {
    o.request(request(`type-${n}`, 'loader-1', { type })); failed(o, `type-${n}`);
  }
  assert.equal(bucket(o).resources.other, 5);
  assert.equal(bucket(o).scopes['current-document'], 5); noPrivate(o.snapshot());
});

test('phase58 peer: beforeStop/afterStop/cleanup are distinct and closed events inert', () => {
  const o = observer(); doc(o);
  o.request(request('before')); failed(o, 'before'); o.markStop();
  o.request(request('after')); failed(o, 'after'); o.beginCleanup();
  o.request(request('cleanup')); failed(o, 'cleanup');
  for (const phase of ['beforeStop', 'afterStop', 'cleanup']) assert.equal(bucket(o, phase).scopes['current-document'], 1);
  o.close('page-close-return'); const before = JSON.stringify(o.snapshot()); let reads = 0;
  const e = { get requestId() { reads++; throw new Error('PHASE58_PRIVATE'); } };
  for (const method of ['request', 'response', 'commit', 'sameDocument', 'finished', 'failed']) assert.equal(o[method](e), false);
  assert.equal(reads, 0); assert.equal(JSON.stringify(o.snapshot()), before); assert.equal(o.snapshot().retainedIdentifiers, 0);
});

test('phase58 peer: cap overflow stops diagnostics before reading URL/metadata, never guesses', () => {
  const o = observer({ maxIdentifiers: 3 }); doc(o); o.request(request('fill'));
  let reads = 0;
  const overflow = { requestId: 'overflow', get type() { reads++; throw new Error('PHASE58_PRIVATE'); },
    get request() { reads++; throw new Error('PHASE58_PRIVATE'); } };
  assert.equal(o.request(overflow), false); assert.equal(reads, 0);
  assert.equal(o.snapshot().state, 'capacity-stopped'); assert.equal(o.snapshot().retainedIdentifiers, 0);
  failed(o, 'fill'); assert.equal(o.snapshot().failed, 0); noPrivate(o.snapshot());
});

test('phase58 peer: missing/hostile main frame never reads events or creates identity', () => {
  for (const mainFrameId of [null, undefined, false, {}, 'a'.repeat(161), '../private']) {
    const o = observer({ mainFrameId }); let reads = 0;
    assert.equal(o.request({ get requestId() { reads++; throw new Error('PHASE58_PRIVATE'); } }), false);
    assert.equal(reads, 0); assert.equal(o.snapshot().state, 'unavailable'); assert.equal(o.snapshot().currentDocumentVerified, false);
  }
});

test('phase58 peer: sanitizer whitelist drops private unknown fields and tolerates throwing getters', () => {
  const o = observer(); doc(o); o.request(request('once')); failed(o, 'once');
  const result = sanitizeCdpObservation({ ...o.snapshot(), requestId: 'private', headers: { Cookie: 'PHASE58_PRIVATE' },
    url: WORKS, errorText: 'PHASE58_PRIVATE', failuresByPhase: { ...o.snapshot().failuresByPhase, private: WORKS } });
  noPrivate(result);
  assert.equal(sanitizeCdpObservation({ get version() { throw new Error('PHASE58_PRIVATE'); } }), null);
});

const CDP_EVENTS = ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished',
  'Network.loadingFailed', 'Page.frameNavigated', 'Page.navigatedWithinDocument'];
const drain = async () => { for (let i = 0; i < 180; i++) await Promise.resolve(); };
class Session extends EventEmitter {
  constructor({ failCommand, hangCommand, parentId, rootId = FRAME } = {}) {
    super(); this.commands = []; this.detaches = 0; this.failCommand = failCommand; this.hangCommand = hangCommand;
    this.parentId = parentId; this.rootId = rootId;
  }
  async send(name, ...args) {
    this.commands.push({ name, args });
    if (name === this.failCommand) throw new Error('PHASE58_PRIVATE');
    if (name === this.hangCommand) return new Promise(() => {});
    if (name === 'Page.getFrameTree') return { frameTree: { frame: { id: this.rootId, parentId: this.parentId } } };
    return {};
  }
  async detach() { this.detaches++; }
}
const context = session => ({ pageSeen: null, creations: 0, async newCDPSession(page) {
  this.pageSeen = page; this.creations++; return session;
} });
const emitDoc = (session, loaderId = 'loader-1') => {
  session.emit('Network.requestWillBeSent', request(`document-${loaderId}`, loaderId,
    { type: 'Document', request: { method: 'GET', url: PROFILE } }));
  session.emit('Network.responseReceived', { requestId: `document-${loaderId}`, frameId: FRAME, loaderId,
    type: 'Document', response: { status: 200, url: PROFILE } });
  session.emit('Page.frameNavigated', { frame: { id: FRAME, loaderId, url: PROFILE } });
};

test('phase58 peer: actual adapter only three observation commands, fixed page and no HTTP/action', async () => {
  const session = new Session(), c = context(session);
  const page = { goto() { assert.fail('extra navigation'); }, evaluate() { assert.fail('extra DOM read'); },
    mouse: { move() { assert.fail('extra move'); }, wheel() { assert.fail('extra wheel'); } } };
  const monitor = await observePrivatePageCdp(c, page, SEC, 250);
  assert.ok(monitor); assert.equal(c.pageSeen, page); assert.equal(c.creations, 1);
  assert.deepEqual(session.commands, ['Page.enable', 'Network.enable', 'Page.getFrameTree'].map(name => ({ name, args: [] })));
  for (const name of CDP_EVENTS) assert.equal(session.listenerCount(name), 1);
  emitDoc(session); session.emit('Network.requestWillBeSent', request('works'));
  session.emit('Network.loadingFailed', { requestId: 'works', type: 'Fetch', blockedReason: 'subresource-filter' });
  assert.equal(monitor.snapshot().failuresByPhase.beforeStop.authorPosts['current-document'], 1);
  noPrivate(monitor.snapshot()); await monitor.close();
  assert.equal(session.detaches, 1); assert.equal(monitor.snapshot().retainedIdentifiers, 0);
  for (const name of CDP_EVENTS) assert.equal(session.listenerCount(name), 0);
});

for (const failCommand of ['Page.enable', 'Network.enable', 'Page.getFrameTree']) {
  test(`phase58 peer: actual adapter ${failCommand} rejection releases without secret error output`, async () => {
    const session = new Session({ failCommand }); const result = await observePrivatePageCdp(context(session), {}, SEC);
    await drain(); assert.equal(result, null); assert.equal(session.detaches, 1);
    for (const name of CDP_EVENTS) assert.equal(session.listenerCount(name), 0);
  });
}

for (const hangCommand of ['Page.enable', 'Network.enable', 'Page.getFrameTree']) {
  test(`phase58 peer: actual adapter hanging ${hangCommand} returns within original setup cap`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    const session = new Session({ hangCommand }); let settled = false;
    const promise = observePrivatePageCdp(context(session), {}, SEC, 15).then(v => { settled = true; return v; });
    await drain(); t.mock.timers.tick(14); await drain(); assert.equal(settled, false);
    t.mock.timers.tick(1); await drain(); assert.equal(settled, true); assert.equal(await promise, null);
    assert.equal(session.detaches, 1); for (const name of CDP_EVENTS) assert.equal(session.listenerCount(name), 0);
    t.mock.timers.tick(1000); await drain(); assert.equal(session.detaches, 1);
  });
}

test('phase58 peer: actual adapter late session creation closes itself, never enables network', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const session = new Session(); let resolve;
  const c = { newCDPSession() { return new Promise(r => { resolve = r; }); } };
  const promise = observePrivatePageCdp(c, {}, SEC, 10);
  await drain(); t.mock.timers.tick(10); await drain(); assert.equal(await promise, null);
  resolve(session); await drain(); assert.equal(session.detaches, 1); assert.deepEqual(session.commands, []);
  for (const name of CDP_EVENTS) assert.equal(session.listenerCount(name), 0);
});

test('phase58 peer: root frame cannot secretly be an iframe', async () => {
  const session = new Session({ parentId: 'private-parent' });
  assert.equal(await observePrivatePageCdp(context(session), {}, SEC), null);
  assert.equal(session.detaches, 1); for (const name of CDP_EVENTS) assert.equal(session.listenerCount(name), 0);
});

test('phase58 peer: throwing frame tree getters drop observation without throwing to collector', async () => {
  const session = new Session(); const send = session.send.bind(session);
  session.send = async name => name === 'Page.getFrameTree' ? { get frameTree() { throw new Error('PHASE58_PRIVATE'); } } : send(name);
  assert.equal(await observePrivatePageCdp(context(session), {}, SEC), null);
  await drain(); assert.equal(session.detaches, 1); for (const name of CDP_EVENTS) assert.equal(session.listenerCount(name), 0);
});

test('phase58 peer: retained callback after close does not read hostile event properties', async () => {
  const session = new Session(); const monitor = await observePrivatePageCdp(context(session), {}, SEC);
  const callback = session.listeners('Network.loadingFailed')[0]; await monitor.close(); let reads = 0;
  const before = JSON.stringify(monitor.snapshot());
  callback({ get requestId() { reads++; throw new Error('PHASE58_PRIVATE'); } });
  assert.equal(reads, 0); assert.equal(JSON.stringify(monitor.snapshot()), before);
});

test('phase58 peer: parent sanitizer preserves old optional absence and strips new private fields', () => {
  const old = { version: 1, stopReason: 'no-bound-request' };
  const oldProjected = sanitizeBrowserWorksDiagnostics(old);
  assert.equal(Object.hasOwn(oldProjected, 'cdpObservation'), false);
  assert.deepEqual(sanitizeBrowserWorksDiagnostics({ ...old, cdpObservation: undefined }), oldProjected);
  const o = observer(); doc(o); o.request(request('works')); failed(o, 'works');
  const projected = sanitizeBrowserWorksDiagnostics({ ...old, cdpObservation: { ...o.snapshot(), raw: WORKS, Cookie: 'PHASE58_PRIVATE' } });
  assert.equal(projected.cdpObservation.failuresByPhase.beforeStop.authorPosts['current-document'], 1);
  assert.deepEqual(projected.httpStatuses, []); assert.equal(projected.requests.matched, null);
  assert.equal(projected.stopReason, 'no-bound-request'); noPrivate(projected);
});

for (const blockedReason of ['other', 'csp', 'mixed-content', 'origin', 'inspector', 'integrity', 'subresource-filter',
  'content-type', 'coep-frame-resource-needs-coep-header', 'coop-sandboxed-iframe-cannot-navigate-to-coop-page',
  'corp-not-same-origin', 'corp-not-same-origin-after-defaulted-to-same-origin-by-coep',
  'corp-not-same-origin-after-defaulted-to-same-origin-by-dip',
  'corp-not-same-origin-after-defaulted-to-same-origin-by-coep-and-dip', 'corp-not-same-site', 'sri-message-signature-mismatch']) {
  test(`phase58 peer: exact official blocked reason ${blockedReason} stays fixed metadata`, () => {
    const o = observer(); doc(o); o.request(request('reason')); failed(o, 'reason', { blockedReason });
    assert.equal(bucket(o).blockedReasons[blockedReason], 1); noPrivate(o.snapshot());
  });
}

class BatchPage extends EventEmitter {
  constructor(session, { hangClose = false } = {}) {
    super(); this.session = session; this.hangClose = hangClose; this.address = 'about:blank';
    this.frame = { url: () => this.address }; this.gotoTimes = []; this.reads = 0; this.moves = 0; this.wheels = 0;
    this.mouse = { move: async () => { this.moves++; }, wheel: async () => { this.wheels++; } };
  }
  mainFrame() { return this.frame; }
  url() { return this.address; }
  async goto(url) {
    this.gotoTimes.push(Date.now()); assert.equal(url, PROFILE);
    const req = { resourceType: () => 'document', isNavigationRequest: () => true,
      frame: () => this.frame, redirectedFrom: () => null, method: () => 'GET', url: () => PROFILE };
    this.emit('request', req); this.emit('response', { request: () => req, status: () => 200, url: req.url });
    this.emit('requestfinished', req); this.address = PROFILE; this.emit('framenavigated', this.frame);
    emitDoc(this.session);
  }
  async evaluate() { this.reads++; return { observation: 'observed', readyState: 'loading', bodyPresent: false, scriptCount: 1 }; }
  close() { this.closeAt = Date.now(); return this.hangClose ? new Promise(() => {}) : Promise.resolve(); }
}
async function runBatch(t, { registered = true, setupDelay = 120, hangClose = false } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const session = new Session(); const send = session.send.bind(session);
  session.send = async (name, ...args) => {
    if (name === 'Network.enable' && setupDelay) await new Promise(resolve => setTimeout(resolve, setupDelay));
    return send(name, ...args);
  };
  const page = new BatchPage(session, { hangClose }); let cdpCreations = 0, cdpCreatedAt = null;
  const c = { newPage: async () => page, newCDPSession: async actual => {
    assert.equal(actual, page); cdpCreations++; cdpCreatedAt = Date.now(); return session;
  }, close: async () => {} };
  const browser = { newContext: async () => c, close: async () => {} };
  const processHandle = { pid: 58_123, exitCode: null, signalCode: null };
  const server = { process: () => processHandle, wsEndpoint: () => 'ws://offline.invalid/peer',
    close: async () => { processHandle.exitCode = 0; }, kill: async () => { assert.fail('no real process kill'); } };
  const ownershipEvents = [];
  const runtime = { readState: async () => ({ cookies: [{ name: 'offline', value: 'synthetic' }] }), access: async () => {},
    ownership: { send: async (name, pid) => { ownershipEvents.push([name, pid]); } },
    ...(registered ? { launchServer: async () => server, connect: async () => browser } : { launch: async () => browser }) };
  let finished = false;
  const promise = collectBrowserWorks({ items: [{ key: 'phase58-offline', secUid: SEC, limit: 30 }] },
    { runtime, collectOptions: { timeoutMs: 2600 } });
  void promise.then(() => { finished = true; }, () => { finished = true; });
  await drain();
  for (let n = 0; !finished && n < 310; n++) { t.mock.timers.tick(20); await drain(); }
  assert.equal(finished, true); const output = await promise;
  assert.equal(output.items.length, 1); assert.equal(page.gotoTimes.length, 1);
  assert.equal(page.moves, 0); assert.equal(page.wheels, 0); assert.equal(page.reads, 1);
  const accountStartedAt = registered ? cdpCreatedAt : page.gotoTimes[0];
  assert.equal(page.closeAt, accountStartedAt + 2600);
  assert.ok(Date.now() <= accountStartedAt + (hangClose ? 4600 : 2600));
  return { output, session, page, cdpCreations, cdpCreatedAt, ownershipEvents };
}

test('phase58 peer: actual registered private batch deducts CDP delay from original account budget', async t => {
  const result = await runBatch(t); const d = result.output.items[0].failureDiagnostics;
  assert.equal(result.page.gotoTimes[0] - result.cdpCreatedAt, 120); assert.equal(result.cdpCreations, 1);
  assert.deepEqual(result.ownershipEvents, [['launch', undefined], ['register', 58123], ['released', 58123]]);
  assert.ok(d.elapsedMs <= 2480); assert.equal(d.stopReason, 'no-bound-request'); assert.deepEqual(d.httpStatuses, []);
  assert.equal(d.requests.matched, 0); assert.equal(d.cdpObservation.phase, 'closed');
  assert.equal(d.cdpObservation.captureBoundary, 'page-close-return'); assert.equal(d.cdpObservation.retainedIdentifiers, 0);
  assert.equal(result.session.detaches, 1); noPrivate(d);
});

test('phase58 peer: actual injected runtime without registered PID cannot open CDP observer', async t => {
  const result = await runBatch(t, { registered: false }); const d = result.output.items[0].failureDiagnostics;
  assert.equal(result.cdpCreations, 0); assert.equal(result.page.gotoTimes[0], 0);
  assert.deepEqual(result.session.commands, []); assert.equal(Object.hasOwn(d, 'cdpObservation'), false);
  assert.equal(result.session.detaches, 0); assert.deepEqual(result.ownershipEvents, []);
});

test('phase58 peer: actual hanging page close stops sidecar within existing 2s cleanup boundary', async t => {
  const result = await runBatch(t, { hangClose: true }); const d = result.output.items[0].failureDiagnostics;
  assert.equal(d.cdpObservation.phase, 'closed'); assert.equal(d.cdpObservation.captureBoundary, 'page-close-timeout');
  assert.equal(d.cdpObservation.retainedIdentifiers, 0); assert.equal(result.session.detaches, 1);
  for (const name of CDP_EVENTS) assert.equal(result.session.listenerCount(name), 0);
  noPrivate(d);
});

test('phase58 peer: mixed prior ordinary/current authorPosts reasons require true joint binding', () => {
  const scenario = reversed => {
    const o = observer(); doc(o, 'loader-1');
    o.request(request('prior-ordinary', 'loader-1', { request: { method: 'GET', url: 'https://example.test/resource' } }));
    doc(o, 'loader-2'); o.request(request('current-works', 'loader-2'));
    failed(o, 'prior-ordinary', { blockedReason: reversed ? 'other' : 'csp' });
    failed(o, 'current-works', { blockedReason: reversed ? 'csp' : 'other' });
    return o.snapshot();
  };
  const a = scenario(false), b = scenario(true);
  assert.deepEqual(a.failuresByPhase.beforeStop.scopes, b.failuresByPhase.beforeStop.scopes);
  assert.deepEqual(a.failuresByPhase.beforeStop.blockedReasons, b.failuresByPhase.beforeStop.blockedReasons);
  assert.deepEqual(a.failuresByPhase.beforeStop.authorPosts, b.failuresByPhase.beforeStop.authorPosts);
  const ma = a.failuresByPhase.beforeStop.authorPostsBlockedReasons;
  const mb = b.failuresByPhase.beforeStop.authorPostsBlockedReasons;
  assert.ok(ma); assert.ok(mb);
  assert.equal(ma['current-document'].other, 1); assert.equal(ma['current-document'].csp, 0);
  assert.equal(mb['current-document'].other, 0); assert.equal(mb['current-document'].csp, 1);
  assert.equal(ma['prior-document'].csp, 0); assert.equal(mb['prior-document'].other, 0);
  assert.notDeepEqual(ma, mb); noPrivate(a); noPrivate(b);
});

test('phase58 peer: prior authorPosts and current ordinary failure never exchange joint reasons', () => {
  const o = observer(); doc(o); o.request(request('old-works'));
  doc(o, 'loader-2'); o.request(request('new-ordinary', 'loader-2', { request: { method: 'GET', url: 'https://example.test/resource' } }));
  failed(o, 'old-works', { blockedReason: 'csp' }); failed(o, 'new-ordinary', { blockedReason: 'other' });
  const matrix = bucket(o).authorPostsBlockedReasons;
  assert.equal(matrix['prior-document'].csp, 1); assert.equal(matrix['current-document'].other, 0);
  assert.equal(matrix['current-document'].csp, 0); noPrivate(o.snapshot());
});

test('phase58 peer: optional joint matrix keeps old no-field snapshot byte shape', () => {
  const o = observer(); doc(o); o.request(request('works')); failed(o, 'works');
  const old = structuredClone(o.snapshot());
  for (const phase of ['beforeStop', 'afterStop', 'cleanup']) delete old.failuresByPhase[phase].authorPostsBlockedReasons;
  const oldBytes = JSON.stringify(old); const projected = sanitizeCdpObservation(old);
  assert.equal(JSON.stringify(projected), oldBytes);
  for (const phase of ['beforeStop', 'afterStop', 'cleanup']) {
    assert.equal(Object.hasOwn(projected.failuresByPhase[phase], 'authorPostsBlockedReasons'), false);
  }
});

test('phase58 peer: optional joint matrix strips secret scope and reason fields', () => {
  const o = observer(); doc(o); o.request(request('works')); failed(o, 'works');
  const value = structuredClone(o.snapshot());
  value.failuresByPhase.beforeStop.authorPostsBlockedReasons.private = { Cookie: 'PHASE58_PRIVATE' };
  value.failuresByPhase.beforeStop.authorPostsBlockedReasons['current-document'].private = WORKS;
  const projected = sanitizeCdpObservation(value);
  assert.equal(projected.failuresByPhase.beforeStop.authorPostsBlockedReasons['current-document']['subresource-filter'], 1);
  noPrivate(projected);
});

test('phase58 peer: no authorPosts failure omits all three optional zero joint matrices', () => {
  const o = observer(); doc(o);
  for (const [n, phase] of ['beforeStop', 'afterStop', 'cleanup'].entries()) {
    if (phase === 'afterStop') o.markStop();
    if (phase === 'cleanup') o.beginCleanup();
    o.request(request(`ordinary-${n}`, 'loader-1', { request: { method: 'GET', url: 'https://example.test/resource' } }));
    failed(o, `ordinary-${n}`, { blockedReason: 'csp' });
  }
  o.close(); const output = o.snapshot();
  for (const phase of ['beforeStop', 'afterStop', 'cleanup']) {
    assert.equal(Object.hasOwn(output.failuresByPhase[phase], 'authorPostsBlockedReasons'), false);
    assert.equal(output.failuresByPhase[phase].scopes['current-document'], 1);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(output)) < 4000);
  noPrivate(output);
});

test('phase58 peer: only phase with real authorPosts failure emits joint matrix', () => {
  const o = observer(); doc(o); o.request(request('works')); failed(o, 'works', { blockedReason: 'csp' });
  o.markStop(); o.request(request('ordinary', 'loader-1', { request: { method: 'GET', url: 'https://example.test/resource' } }));
  failed(o, 'ordinary', { blockedReason: 'other' }); o.beginCleanup(); o.close();
  const output = o.snapshot();
  assert.equal(output.failuresByPhase.beforeStop.authorPostsBlockedReasons['current-document'].csp, 1);
  assert.equal(Object.hasOwn(output.failuresByPhase.afterStop, 'authorPostsBlockedReasons'), false);
  assert.equal(Object.hasOwn(output.failuresByPhase.cleanup, 'authorPostsBlockedReasons'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(output)) < 6000); noPrivate(output);
});

test('phase58 peer: actual normal batch output stays inside unchanged 8192-byte IPC fixture budget', async t => {
  const result = await runBatch(t); const output = { ok: true, data: result.output };
  const bytes = Buffer.byteLength(JSON.stringify(output));
  assert.ok(bytes <= 8192, `actual mock batch output ${bytes} exceeds unchanged 8192`);
  for (const phase of ['beforeStop', 'afterStop', 'cleanup']) {
    assert.equal(Object.hasOwn(output.data.items[0].failureDiagnostics.cdpObservation.failuresByPhase[phase], 'authorPostsBlockedReasons'), false);
  }
});
