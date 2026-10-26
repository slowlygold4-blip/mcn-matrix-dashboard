import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectBrowserWorks, collectOne } from '../scripts/douyin_browser_collector.mjs';

const SEC = 'MS4wLjABAAAAContextIndependent123456789';
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const WORKS = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0`;
const EVENTS = ['request', 'response', 'framenavigated', 'requestfailed', 'pageerror', 'domcontentloaded'];

class Page extends EventEmitter {
  constructor(events, scenario = () => {}) {
    super(); this.events = events; this.scenario = scenario; this.address = 'about:blank';
    this.frame = { url: () => this.address }; this.bodyReads = 0;
  }
  mainFrame() { return this.frame; }
  url() { return this.address; }
  request(url = WORKS, navigation = false) {
    return { url: () => url, method: () => 'GET', frame: () => this.frame, isNavigationRequest: () => navigation };
  }
  document() {
    const request = this.request(PROFILE, true); this.emit('request', request);
    this.emit('response', { request: () => request, url: request.url, status: () => 200 });
    this.address = PROFILE; this.emit('framenavigated', this.frame);
  }
  async goto(url, options) {
    this.events.push('goto'); assert.equal(url, PROFILE); assert.equal(options.waitUntil, 'commit');
    for (const event of EVENTS) assert.equal(this.listenerCount(event), 1, `${event} listener must precede initial navigation`);
    this.document(); await this.scenario(this);
  }
  async close() { this.events.push('close-page'); }
  works() {
    const request = this.request(); this.emit('request', request);
    this.emit('response', { request: () => request, url: request.url, status: () => 200, json: async () => {
      this.bodyReads++;
      return { status_code: 0, has_more: false, max_cursor: 0,
        aweme_list: [{ aweme_id: '7300000000000000001', author: { sec_uid: SEC, uid: '123456789' }, statistics: { digg_count: 2 } }] };
    } });
  }
}

test('context peer: supplied state reaches newContext before fresh-page listeners/navigation, without claiming authentication', async () => {
  const events = [];
  // Synthetic state only. No filesystem, installed browser or external transport is used.
  const state = Object.freeze({ cookies: Object.freeze([{ name: 'offline', value: 'synthetic-not-a-credential' }]),
    origins: Object.freeze([{ origin: 'https://www.douyin.com', localStorage: [{ name: 'offline', value: 'fixture' }] }]) });
  const before = JSON.stringify(state), page = new Page(events, p => p.works());
  const context = { newPage: async () => { events.push('new-page'); return page; }, close: async () => { events.push('close-context'); } };
  const browser = { newContext: async options => {
    events.push('new-context'); assert.equal(options.storageState, state);
    assert.equal(options.locale, 'zh-CN'); return context;
  }, close: async () => { events.push('close-browser'); } };
  const processHandle = { pid: 12345, exitCode: null, signalCode: null };
  const server = { process: () => processHandle, wsEndpoint: () => 'ws://127.0.0.1:1/offline-only',
    close: async () => { events.push('close-server'); processHandle.exitCode = 0; },
    kill: async () => { assert.fail('gracefully closed synthetic server must not be killed'); } };
  const result = await collectBrowserWorks({ items: [{ key: 'offline-context', secUid: SEC }] }, {
    executablePath: '/offline/never-executed', collectOptions: { timeoutMs: 100, batchTimeoutMs: 1000 },
    runtime: {
      readState: async () => { events.push('read-state'); return state; },
      access: async path => { events.push('access'); assert.equal(path, '/offline/never-executed'); },
      launchServer: async () => { events.push('launch-server'); return server; },
      connect: async endpoint => { events.push('connect'); assert.equal(endpoint, 'ws://127.0.0.1:1/offline-only'); return browser; },
      ownership: { send: async event => { events.push(`ownership-${event}`); } },
    },
  });
  assert.equal(result.items[0].status, 'ok'); assert.equal(page.bodyReads, 1);
  assert.equal(result.provenance.sessionLoaded, true);
  assert.equal(result.provenance.authenticated, null);
  assert.equal(result.provenance.authenticationStatus, 'not-verified');
  assert.equal(JSON.stringify(state), before, 'collector must not update or replace supplied state');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-not-a-credential|localStorage|ws:\/\//);
  assert.deepEqual(events, ['read-state', 'access', 'ownership-launch', 'launch-server', 'ownership-register', 'connect',
    'new-context', 'new-page', 'goto', 'close-page', 'close-context', 'close-browser', 'close-server', 'ownership-released']);
  for (const event of EVENTS) assert.equal(page.listenerCount(event), 0);
});

test('context peer: final zero-request diagnostics do not prove absence of requests in a retired document', async () => {
  let actualWorksRequests = 0;
  const page = new Page([], async p => {
    const retired = p.request(); actualWorksRequests++; p.emit('request', retired);
    p.document(); // A replacement of the same URL starts a fresh evidence generation.
  });
  const result = await collectOne(page, { key: 'offline-retired', secUid: SEC, limit: 30 }, { timeoutMs: 50 });
  assert.equal(actualWorksRequests, 1);
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.posts, []);
  assert.equal(result.failureDiagnostics.navigation.committed, true);
  assert.equal(result.failureDiagnostics.requests.candidate, 0);
  assert.equal(result.failureDiagnostics.requests.matched, 0);
  assert.equal(result.failureDiagnostics.runtime.pageErrorCount, null);
  assert.equal(result.failureDiagnostics.stopReason, 'no-bound-request');
  assert.equal(page.bodyReads, 0);
  for (const event of EVENTS) assert.equal(page.listenerCount(event), 0);
});
