import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectAuthorisedDetail } from '../lib/douyin-authorised-detail.mjs';

const VIDEO = '7690702905876096104';
const payload = { items: [{ key: 'peer:single', videoId: VIDEO, submittedId: 'peer_handle' }] };
const detailUrl = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${VIDEO}`;
const responseBody = { status_code: 0, aweme_detail: { aweme_id: VIDEO, author: {
  sec_uid: 'MS4wLjABAAAAPeerFixtureAuthor000001', uid: '1234567890123456', unique_id: 'peer_handle',
} } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture({ onCleanup = () => {}, onNavigate } = {}) {
  const calls = [], page = new EventEmitter(), proc = { pid: 12345, exitCode: null, signalCode: null };
  let currentUrl = 'about:blank';
  const frame = { url: () => currentUrl };
  page.mainFrame = () => frame;
  page.url = () => currentUrl;
  page.goto = async url => {
    currentUrl = url; page.emit('framenavigated', frame);
    if (onNavigate) return onNavigate(page);
    const request = { frame: () => frame, method: () => 'GET', isNavigationRequest: () => false,
      redirectedFrom: () => null, url: () => detailUrl };
    page.emit('request', request);
    page.emit('response', { request: () => request, status: () => 200, url: () => detailUrl,
      text: async () => JSON.stringify(responseBody) });
  };
  page.close = async () => { calls.push('page.close'); await onCleanup(); };
  const server = { process: () => proc, wsEndpoint: () => 'ws://127.0.0.1:12345/peer',
    close: async () => { calls.push('server.close'); proc.exitCode = 0; }, kill: async () => { proc.signalCode = 'SIGKILL'; } };
  const context = { newPage: async () => page, close: async () => { calls.push('context.close'); } };
  const browser = { newContext: async () => context, close: async () => { calls.push('browser.close'); } };
  const runtime = {
    readState: async () => { calls.push('state.read'); return { cookies: [{ name: 'test', value: 'PRIVATE_FIXTURE', domain: '.douyin.com' }], origins: [] }; },
    access: async () => {},
    ownership: { remainingExecutionMs: () => 45_000, send: async kind => { calls.push(kind); } },
    chromium: { launchServer: async () => { calls.push('launchServer'); return server; }, connect: async () => browser },
  };
  return { calls, runtime, page, collect: options => collectAuthorisedDetail(payload, { enabled: true, runtime, ...options }) };
}

test('peer: cancellation during successful resource cleanup cannot escape as ok', async () => {
  const controller = new AbortController();
  const f = fixture({ onCleanup: () => controller.abort() });
  const result = await f.collect({ signal: controller.signal });
  assert.ok(f.calls.includes('released'), 'owned resources should still release after cancellation');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.errorCode, 'cancelled');
  assert.equal(result.candidate, undefined);
});

test('peer: already-aborted operation does not schedule an authorised state read', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture();
  const result = await f.collect({ signal: controller.signal });
  await Promise.resolve();
  assert.equal(result.errorCode, 'cancelled');
  assert.deepEqual(f.calls, []);
});

test('peer: no identity result is observable before owned resources finish closing', async () => {
  const closing = deferred(), f = fixture({ onCleanup: () => closing.promise });
  let settled = false;
  const pending = f.collect().then(value => { settled = true; return value; });
  while (!f.calls.includes('page.close')) await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(f.calls.includes('released'), false);
  closing.resolve();
  const result = await pending;
  assert.equal(result.status, 'ok');
  assert.ok(f.calls.indexOf('server.close') < f.calls.indexOf('released'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FIXTURE|ws:\/\//);
});
