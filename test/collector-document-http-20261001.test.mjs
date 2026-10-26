import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WorksRequestPolicy } from '../lib/works-request-policy.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';

const { collectOne } = await import(process.env.COLLECTOR_DOCUMENT_TEST_MODULE
  || '../scripts/douyin_browser_collector.mjs');
const secUid = 'MS4wLjABAAAAOfflineDocumentStatus0123456789';
const profile = `https://www.douyin.com/user/${secUid}`;
class Page extends EventEmitter {
  constructor({ status = 200, redirect = false, unrelated = false } = {}) {
    super(); Object.assign(this, { status, redirect, unrelated, address: 'about:blank', probes: 0, bodyReads: 0 });
    this.frame = { url: () => this.address };
  }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  request(url = profile, previous = null) { return { url: () => url, frame: () => this.frame,
    isNavigationRequest: () => true, method: () => 'GET', redirectedFrom: () => previous }; }
  response(request, status) { return { request: () => request, url: request.url, status: () => status,
    json: () => { this.bodyReads++; throw Error('PRIVATE_COOKIE signed URL must never be read'); } }; }
  async goto() {
    const first = this.request(); this.emit('request', first);
    if (this.redirect) {
      this.emit('response', this.response(first, 302));
      const final = this.request(`${profile}?ordinary=redirect`, first); this.emit('request', final);
      this.emit('response', this.response(final, this.status)); this.address = final.url();
    } else {
      this.emit('response', this.response(this.unrelated ? this.request('https://unrelated.invalid/private') : first, this.status));
      this.address = profile;
    }
    this.emit('framenavigated', this.frame);
  }
  async evaluate() { this.probes++; return { observation: 'observed', readyState: 'complete', bodyPresent: true }; }
}
const run = page => collectOne(page, { key: 'offline-status', secUid, limit: 30 }, { timeoutMs: 80, failureGraceMs: 1 });

for (const [status, errorCode] of [[400, 'network_error'], [401, 'login_required'], [403, 'blocked'],
  [404, 'network_error'], [410, 'network_error'], [429, 'rate_limited'], [500, 'network_error'], [503, 'network_error'], [599, 'network_error']]) {
  test(`bound profile HTTP ${status}: records exact status, stops safely and never reads error body`, async () => {
    const page = new Page({ status }), result = await run(page);
    assert.equal(result.errorCode, errorCode);
    assert.equal(result.status, 'unavailable'); assert.equal(result.worksCoverage, 'unavailable');
    assert.deepEqual(result.posts, []); assert.equal(page.bodyReads, 0);
    assert.equal(result.failureDiagnostics.stopReason, 'http-rejection');
    assert.deepEqual(result.failureDiagnostics.httpStatuses, [status]);
    assert.equal(result.failureDiagnostics.requests.matched, 0);
    assert.match(result.error, new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_COOKIE|https:|ordinary|secUid/);
    assert.deepEqual(sanitizeBrowserWorksDiagnostics(result.failureDiagnostics), result.failureDiagnostics);
    for (const event of ['request', 'response', 'framenavigated', 'requestfailed', 'domcontentloaded']) {
      assert.equal(page.listenerCount(event), 0);
    }
  });
}
test('ordinary profile HTTP redirect retains no-bound classification rather than false refusal', async () => {
  const page = new Page({ redirect: true }), result = await run(page);
  assert.equal(result.errorCode, 'collector_error');
  assert.equal(result.failureDiagnostics.stopReason, 'no-bound-request');
  assert.deepEqual(result.failureDiagnostics.httpStatuses, []);
  assert.equal(result.failureDiagnostics.navigation.committed, true); assert.ok(page.probes > 0);
});
test('unbound third-party 500 cannot stop or label the target profile as a server failure', async () => {
  const result = await run(new Page({ status: 500, unrelated: true }));
  assert.equal(result.errorCode, 'collector_error');
  assert.equal(result.failureDiagnostics.stopReason, 'no-bound-request');
  assert.deepEqual(result.failureDiagnostics.httpStatuses, []);
});
test('server failures use the existing short transport backpressure, not login/blocked gate', async () => {
  const policy = new WorksRequestPolicy({ now: () => 1000 });
  for (const targetKey of ['one', 'two', 'three']) {
    const result = await run(new Page({ status: 503 }));
    policy.record('authorised-browser', { targetKey, errorCode: result.errorCode });
    const decision = policy.decision('authorised-browser');
    assert.equal(decision.deferred, targetKey === 'three');
  }
  assert.equal(policy.decision('authorised-browser').nextEligibleAt, '1970-01-01T00:01:01.000Z');
  assert.equal(policy.decision('anonymous-http').deferred, false);
});
