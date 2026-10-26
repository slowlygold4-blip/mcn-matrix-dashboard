import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { runReadOnlyProbe } from '../scripts/probes/douyin-profile-render-probe.mjs';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';

const input = { secUid: 'MS4wLjABAAAAIndependentNativeBrowser12345', uid: '1234567890' };
const profile = `https://www.douyin.com/user/${input.secUid}`;

function probeFixture({ redirect = null, history = null, reload = false, status = 200 } = {}) {
  const calls = [], processHandle = { pid: 12345, exitCode: null, signalCode: null };
  let currentUrl = profile;
  const page = new EventEmitter(), frame = { url: () => currentUrl };
  page.mainFrame = () => frame;
  page.url = () => currentUrl;
  page.close = async () => { calls.push('page-close'); };
  const request = (url, previous = null) => ({ url: () => url, frame: () => frame,
    method: () => 'GET', isNavigationRequest: () => true, redirectedFrom: () => previous });
  page.goto = async () => {
    const first = request(profile);
    page.emit('request', first);
    page.emit('response', { request: () => first, status: () => redirect ? 302 : status });
    if (redirect) {
      currentUrl = redirect;
      const next = request(redirect, first);
      page.emit('request', next);
      page.emit('response', { request: () => next, status: () => status });
    }
    page.emit('framenavigated', frame);
    if (history) { currentUrl = history; page.emit('framenavigated', frame); }
    if (reload) page.emit('request', request(currentUrl));
  };
  page.evaluate = async () => { calls.push('evaluate'); return { gate: 'none', schema: 'unknown',
    renderPresent: false, renderValid: false, candidateNodes: 0, postCount: null,
    profileIdentityMatches: null, postIdentityMatches: null, postIdentityConflicts: null, worksRegionPresent: false }; };
  const context = { newPage: async () => page, close: async () => calls.push('context-close') };
  const browser = { newContext: async () => context, close: async () => calls.push('browser-close') };
  const server = { process: () => processHandle, wsEndpoint: () => 'ws://127.0.0.1/offline-only',
    close: async () => { calls.push('server-close'); processHandle.exitCode = 0; },
    kill: async () => { calls.push('server-kill'); processHandle.signalCode = 'SIGKILL'; } };
  return { calls, runtime: { readState: async () => ({ cookies: [] }), launchServer: async () => server,
    connect: async () => browser, ownership: { send: async (...args) => calls.push(args) } } };
}

for (const destination of [`${profile}/`, `${profile}?normal=redirect`]) {
  test('native probe: same-author HTTP redirect chain retains a usable DOM observation', async () => {
    const fixture = probeFixture({ redirect: destination });
    const result = await runReadOnlyProbe(input, fixture.runtime);
    assert.equal(result.ok, true);
    assert.equal(result.documentStatus, 200);
    assert.deepEqual(result.httpStatuses, [302, 200]);
    assert.equal(fixture.calls.filter(call => call === 'evaluate').length, 1);
    assert.ok(fixture.calls.includes('server-close'));
  });
}

test('native probe: ordinary same-document head history query preserves the observation', async () => {
  const fixture = probeFixture({ history: `${profile}?normal=history` });
  const result = await runReadOnlyProbe(input, fixture.runtime);
  assert.equal(result.ok, true);
  assert.equal(result.documentStatus, 200);
  assert.equal(fixture.calls.filter(call => call === 'evaluate').length, 1);
});

test('native probe: unrelated reload is a new document generation even at the same profile URL', async () => {
  const fixture = probeFixture({ reload: true });
  const result = await runReadOnlyProbe(input, fixture.runtime);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'navigation-changed');
  assert.equal(fixture.calls.includes('evaluate'), false);
});

test('native probe: redirect chain never authorizes an outside origin, another author, login or verification page', async () => {
  for (const redirect of ['https://fixture.invalid/user/other', 'https://www.douyin.com/user/OTHER',
    'https://www.douyin.com/login', 'https://www.douyin.com/captcha/',
    `http://www.douyin.com/user/${input.secUid}`, `https://www.douyin.com:444/user/${input.secUid}`,
    `https://secret@www.douyin.com/user/${input.secUid}`]) {
    const fixture = probeFixture({ redirect });
    const result = await runReadOnlyProbe(input, fixture.runtime);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'navigation-changed');
    assert.equal(fixture.calls.includes('evaluate'), false);
    assert.ok(fixture.calls.includes('server-close'));
  }
});

test('native probe: content-selecting query or fragment cannot turn the profile probe into a video/modal read', async () => {
  for (const suffix of ['?modal_id=123', '?aweme_id=123', '?video_id=123', '?normal=tracking&modal_id=123',
    '#modal_id=123', '#?aweme_id=123', '#/route?video_id=123', '?%6dodal_id=123', '?MODAL_ID=123']) {
    for (const mode of ['redirect', 'history']) {
      const fixture = probeFixture({ [mode]: `${profile}${suffix}` });
      const result = await runReadOnlyProbe(input, fixture.runtime);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'navigation-changed');
      assert.equal(fixture.calls.includes('evaluate'), false);
    }
  }
});

const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const bootstrap = 'https://cdn.fixture.invalid/offline-bootstrap.js';
const parserHtml = `<!doctype html><html><head>${'<script>/* offline head stub */</script>'.repeat(9)}
<script src="${bootstrap}"></script></head><body><p>offline synthetic body</p></body></html>`;

async function resourceScenario(browser, mode) {
  const context = await browser.newContext({ offline: true, serviceWorkers: 'block' });
  const page = await context.newPage(), cdp = await context.newCDPSession(page);
  const offlineNetwork = { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  await cdp.send('Network.emulateNetworkConditions', offlineNetwork);
  await cdp.send('Network.overrideNetworkState', offlineNetwork);
  let closing = false, releaseParser;
  const parserRelease = new Promise(resolve => { releaseParser = resolve; });
  const pendingHandlers = new Set(), pendingScripts = new Set(), rejectedScripts = new Set();
  const observed = { failedScripts: 0, failedScriptsAfterHttpError: 0, scriptHttpErrors: 0, documentStatus: null, domReady: false };
  const errors = [];
  const fulfill = (requestId, status, type, body) => cdp.send('Fetch.fulfillRequest', {
    requestId, responseCode: status, responseHeaders: [{ name: 'content-type', value: type }], body: Buffer.from(body).toString('base64'),
  });
  const intercept = async event => {
    if (event.request.url === profile) return fulfill(event.requestId, mode === 'document-500' ? 500 : 200, 'text/html',
      mode === 'document-500' ? '<!doctype html><html><body>synthetic server error</body></html>' : parserHtml);
    if (event.request.url === bootstrap) {
      if (mode === 'parser-held') { await parserRelease; return; }
      if (mode === 'script-transport-failed') return cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'ConnectionFailed' });
      return fulfill(event.requestId, 503, 'text/javascript', '/* synthetic unavailable resource */');
    }
    return cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
  };
  cdp.on('Fetch.requestPaused', event => {
    const handling = intercept(event).catch(error => { if (!closing) errors.push(error.message); })
      .finally(() => pendingHandlers.delete(handling));
    pendingHandlers.add(handling);
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  page.on('request', request => { if (request.resourceType() === 'script') pendingScripts.add(request); });
  page.on('requestfinished', request => pendingScripts.delete(request));
  page.on('requestfailed', request => {
    if (request.resourceType() === 'script') {
      observed.failedScripts++;
      if (rejectedScripts.has(request)) observed.failedScriptsAfterHttpError++;
      pendingScripts.delete(request);
    }
  });
  page.on('response', response => {
    const request = response.request();
    if (request.resourceType() === 'script' && response.status() >= 400) {
      observed.scriptHttpErrors++;
      rejectedScripts.add(request);
    }
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) observed.documentStatus = response.status();
  });
  page.on('domcontentloaded', () => { observed.domReady = true; });
  try {
    const result = await collectOne(page, { key: 'independent-native-resources', secUid: input.secUid, limit: 30 }, { timeoutMs: 650 });
    const final = await page.evaluate(() => ({ readyState: document.readyState, bodyPresent: Boolean(document.body),
      scriptCount: document.querySelectorAll('script').length, offline: navigator.onLine === false }));
    assert.deepEqual(errors, []);
    return { result, observed: { ...observed, pendingScripts: pendingScripts.size }, final };
  } finally {
    closing = true;
    try { await context.close(); }
    finally { releaseParser(); await Promise.allSettled([...pendingHandlers]); }
  }
}

test('native collector: resource lifecycle evidence distinguishes four otherwise no-bound outcomes',
  { skip: !existsSync(executablePath), timeout: 20_000 }, async t => {
    const browser = await chromium.launch({ executablePath, headless: true, timeout: 10_000,
      proxy: { server: 'http://127.0.0.1:9' }, args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'] });
    try {
      for (const mode of ['parser-held', 'script-transport-failed', 'script-http-503', 'document-500']) {
        await t.test(mode, async () => {
          const out = await resourceScenario(browser, mode), diagnostics = out.result.failureDiagnostics;
          assert.equal(out.final.offline, true);
          assert.equal(out.result.status, 'unavailable');
          assert.deepEqual(out.result.posts, []);
          assert.equal(diagnostics.navigation.failed, false);
          assert.equal(diagnostics.navigation.committed, true);
          assert.equal(diagnostics.stopReason, mode === 'document-500' ? 'http-rejection' : 'no-bound-request');
          assert.equal(diagnostics.requests.candidate, 0);
          assert.equal(diagnostics.runtime.boundRequestFailedCount, 0);
          assert.equal(diagnostics.runtime.pageErrorCount, 0);
          if (mode === 'parser-held') {
            assert.equal(out.observed.domReady, false);
            assert.equal(out.observed.pendingScripts, 1);
            assert.equal(out.final.readyState, 'loading');
            assert.equal(out.final.bodyPresent, false);
            assert.equal(out.final.scriptCount, 10);
            assert.equal(diagnostics.firstScreen.readyState, 'loading');
            assert.equal(diagnostics.firstScreen.bodyPresent, false);
            assert.equal(diagnostics.firstScreen.scriptCount, 10);
          } else {
            assert.equal(out.observed.domReady, true);
            assert.equal(out.observed.pendingScripts, 0);
            assert.ok(['interactive', 'complete'].includes(out.final.readyState));
            assert.equal(out.final.bodyPresent, true);
          }
          assert.equal(out.observed.failedScripts, ['script-transport-failed', 'script-http-503'].includes(mode) ? 1 : 0);
          assert.equal(out.observed.failedScriptsAfterHttpError, mode === 'script-http-503' ? 1 : 0);
          assert.equal(out.observed.scriptHttpErrors, mode === 'script-http-503' ? 1 : 0);
          assert.equal(out.observed.documentStatus, mode === 'document-500' ? 500 : 200);
          if (mode === 'document-500') {
            assert.deepEqual(diagnostics.httpStatuses, [500]);
            assert.equal(out.result.errorCode, 'network_error');
            assert.match(out.result.error, /HTTP 500/);
          }
        });
      }
    } finally { await browser.close(); }
  });
