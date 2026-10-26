import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';

const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const secUid = 'MS4wLjABAAAACausalOfflineBrowser123';
const profile = `https://www.douyin.com/user/${secUid}`;
const works = `/aweme/v1/web/aweme/post/?sec_user_id=${secUid}&max_cursor=0`;
const html = `<!doctype html><html><head><script>
history.replaceState({},'',location.pathname+'?normal=history');
</script><script src="/offline-parser-blocker.js"></script></head><body>
<div data-e2e="user-post-list" style="position:absolute;left:100px;top:100px;width:800px;height:400px;overflow-y:scroll"><div style="height:1600px">synthetic offline region</div></div>
<script>document.addEventListener('wheel',()=>fetch(${JSON.stringify(works)}),{once:true});</script>
</body></html>`;

async function scenario({ redirect = false, releaseParserOnObservation = true, timeoutMs = 2200 } = {}) {
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 10_000,
    proxy: { server: 'http://127.0.0.1:9' }, args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'] });
  let closing = false, releaseParser;
  const parserRelease = new Promise(resolve => { releaseParser = resolve; });
  const pendingInterceptions = new Set();
  try {
    // Every request, including each real HTTP redirect hop, is intercepted
    // before transport. Playwright route() only handles the first redirect
    // URL, so use Chromium Fetch interception while keeping offline isolation.
    const context = await browser.newContext({ offline: true, serviceWorkers: 'block' });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    // A second CDP session must carry the same offline transport and page
    // state; otherwise its fulfilled navigation can reset navigator.onLine.
    const offlineNetwork = { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
    await cdp.send('Network.emulateNetworkConditions', offlineNetwork);
    await cdp.send('Network.overrideNetworkState', offlineNetwork);
    const interceptedUrls = [], unexpectedRequests = [], interceptionErrors = [];
    let redirected = false, routes = 0;
    const fulfill = (requestId, { status = 200, contentType, headers = {}, body = '' }) => cdp.send('Fetch.fulfillRequest', {
      requestId, responseCode: status,
      responseHeaders: Object.entries({ ...(contentType ? { 'content-type': contentType } : {}), ...headers })
        .map(([name, value]) => ({ name, value })),
      body: Buffer.from(body).toString('base64'),
    });
    const intercept = async event => {
      routes++;
      interceptedUrls.push(event.request.url);
      const url = new URL(event.request.url), path = url.pathname;
      if (url.origin !== new URL(profile).origin) {
        unexpectedRequests.push(event.request.url);
        return cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
      }
      if (path === '/offline-parser-blocker.js') {
        // Keep the real parser blocked until its first loading snapshot is
        // observed, so scheduling cannot release it before the observation.
        await parserRelease;
        if (!closing) await fulfill(event.requestId, { contentType: 'text/javascript', body: '/* offline parser release */' });
        return;
      }
      if (path === '/aweme/v1/web/aweme/post/') {
        return fulfill(event.requestId, { contentType: 'application/json', body: JSON.stringify({ status_code: 0, has_more: false, max_cursor: 0,
          aweme_list: [{ aweme_id: '7300000000000000001', author: { sec_uid: secUid, uid: '1234567890' }, statistics: { digg_count: 7 } }] }) });
      }
      if (path === `/user/${secUid}`) {
        if (redirect && !redirected) { redirected = true; return fulfill(event.requestId, { status: 302, headers: { location: `${profile}?redirected=1` } }); }
        return fulfill(event.requestId, { contentType: 'text/html', body: html });
      }
      return fulfill(event.requestId, { status: 404 });
    };
    cdp.on('Fetch.requestPaused', event => {
      const pending = intercept(event).catch(error => { if (!closing) interceptionErrors.push(error.message); })
        .finally(() => pendingInterceptions.delete(pending));
      pendingInterceptions.add(pending);
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    const events = [], snapshots = [], documentRequests = [], documentResponses = [], failedRequests = [];
    page.on('request', request => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        events.push('document-request');
        documentRequests.push({ url: request.url(), redirectedFrom: request.redirectedFrom()?.url() ?? null });
      }
    });
    page.on('response', response => {
      const request = response.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentResponses.push(response.status());
    });
    page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) events.push('main-frame'); });
    page.on('domcontentloaded', () => events.push('dom-ready'));
    const evaluate = page.evaluate.bind(page);
    page.evaluate = async (fn, arg) => {
      const result = await evaluate(fn, arg);
      if (fn.name === 'observeBrowserFirstScreen') {
        snapshots.push(result?.readyState);
        if (releaseParserOnObservation && snapshots.length === 1) releaseParser();
      }
      return result;
    };
    const result = await collectOne(page, { key: 'offline-causal', secUid, limit: 30 }, { timeoutMs });
    const finalReady = await evaluate(() => document.readyState).catch(() => 'context-unavailable');
    const offline = await evaluate(() => navigator.onLine === false).catch(() => false);
    console.log(JSON.stringify({ redirect, releaseParserOnObservation, routes, documentRequests, documentResponses,
      failedRequests, events, snapshots, finalReady, offline, status: result.status, diagnostics: result.failureDiagnostics }));
    return { result, events, snapshots, finalReady, offline, routes, interceptedUrls, documentRequests, documentResponses,
      failedRequests, unexpectedRequests, interceptionErrors };
  } finally {
    closing = true;
    try { await browser.close(); }
    finally { releaseParser(); await Promise.allSettled([...pendingInterceptions]); }
  }
}

function assertOfflineNavigation(out, redirect) {
  const urls = redirect ? [profile, `${profile}?redirected=1`] : [profile];
  assert.deepEqual(out.documentRequests, urls.map((url, index) => ({ url, redirectedFrom: index ? profile : null })));
  assert.deepEqual(out.documentResponses, redirect ? [302, 200] : [200]);
  assert.deepEqual(out.interceptedUrls.filter(url => new URL(url).pathname === `/user/${secUid}`), urls);
  assert.deepEqual(out.failedRequests, []);
  assert.deepEqual(out.unexpectedRequests, []);
  assert.deepEqual(out.interceptionErrors, []);
  assert.equal(out.offline, true);
}

for (const redirect of [false, true]) test(`real offline Chromium: ${redirect ? 'HTTP redirect plus' : 'ordinary'} head history does not consume DOM-ready observation`,
  { timeout: 15_000, skip: !existsSync(executablePath) }, async () => {
    const out = await scenario({ redirect });
    assertOfflineNavigation(out, redirect);
    assert.ok(out.events.indexOf('main-frame') < out.events.indexOf('dom-ready'));
    assert.equal(out.snapshots.length, 2);
    assert.equal(out.snapshots[0], 'loading');
    assert.ok(['interactive', 'complete'].includes(out.snapshots[1]));
    assert.equal(out.result.failureDiagnostics.firstPageActivation.actionCount, 1);
    assert.equal(out.result.posts.length, 1);
    assert.equal(out.result.posts[0].statistics.digg_count, 7);
    assert.equal(out.result.status, 'ok');
  });

test('real offline Chromium: parser-blocked document naturally reproduces loading/no-bound without a lost DOM-ready event',
  { timeout: 10_000, skip: !existsSync(executablePath) }, async () => {
    const out = await scenario({ redirect: true, releaseParserOnObservation: false, timeoutMs: 500 });
    assertOfflineNavigation(out, true);
    assert.equal(out.events.includes('dom-ready'), false);
    assert.equal(out.snapshots.length, 1);
    assert.equal(out.finalReady, 'loading');
    assert.equal(out.result.failureDiagnostics.firstScreen.readyState, 'loading');
    assert.equal(out.result.failureDiagnostics.firstPageActivation.attemptCount, 0);
    assert.equal(out.result.failureDiagnostics.requests.candidate, 0);
    assert.equal(out.result.failureDiagnostics.stopReason, 'no-bound-request');
    assert.equal(out.result.worksCoverage, 'unavailable');
    assert.deepEqual(out.result.posts, []);
  });
