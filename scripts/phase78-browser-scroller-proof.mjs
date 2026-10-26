// Real Chrome + production owner, exclusively locally fulfilled fixture routes.
// No live platform request, saved session, user data or collector scheduler call.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { collectOne } from './douyin_browser_collector.mjs';

const sourceUrl = new URL('./douyin_browser_collector.mjs', import.meta.url);
const current = readFileSync(sourceUrl, 'utf8');
const block = current.match(/          const scrollGeneration = generation;[\s\S]*?          finally \{ scrollExpired = true; \}/g);
assert.equal(block?.length, 1);
const previous = readFileSync('/private/tmp/mcn-phase78-code-ybRE1D/douyin_browser_collector.mjs', 'utf8');
const oldBlock = previous.match(/          const scrollGeneration = generation;[\s\S]*?          \} catch \{ stopPaging\("scroll-failed", "collector_error"\); break; \}/g);
assert.equal(oldBlock?.length, 1);
let historic = current.replace(block[0], oldBlock[0]).replaceAll('import.meta.url', JSON.stringify(sourceUrl.href));
historic = historic.replace(/from "([^"]+)"/g, (match, specifier) => specifier.startsWith('node:') ? match
  : `from ${JSON.stringify(specifier.startsWith('.') ? new URL(specifier, sourceUrl).href : import.meta.resolve(specifier))}`);
const oldOwner = await import(`data:text/javascript;base64,${Buffer.from(historic).toString('base64')}`);
const secUid = 'MS4wLjABAAAAPhase78OfflineBrowserFixture';
const profile = `https://www.douyin.com/user/${secUid}`;
const makeBody = (cursor, author = secUid) => ({ status_code: 0, has_more: cursor === 0, max_cursor: cursor === 0 ? 100 : 200,
  aweme_list: [{ aweme_id: cursor === 0 ? '7200000000000000078' : '7200000000000000079',
    author: { sec_uid: author, uid: '1234567890' }, statistics: { digg_count: cursor === 0 ? 7 : 9 } }] });
const fixtureHtml = gate => `<!doctype html><meta charset="utf-8"><title>Offline owned-scroller fixture</title>
<style>body{margin:0;height:720px;overflow:hidden;background:#111;color:#fff}
[data-e2e="user-post-list"]{position:absolute;left:100px;top:100px;width:700px;height:500px;overflow-y:auto;background:#262626}
.space{height:1100px} .gate{position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:10}</style>
<div data-e2e="user-post-list"><div class="space">Synthetic works only; no actual Douyin data.</div></div>
${gate ? '<div role="dialog" class="gate">Fixture access gate</div>' : ''}
<script>
const endpoint = n => '/aweme/v1/web/aweme/post/?sec_user_id=${secUid}&max_cursor='+n;
fetch(endpoint(0));
let loaded=false;
document.querySelector('[data-e2e="user-post-list"]').addEventListener('scroll',function(){
 if(!loaded && this.scrollTop>0){loaded=true;fetch(endpoint(100));}
});
</script>`;
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const cases = [];
try {
  for (const spec of [{ name: 'historical-blind', owner: oldOwner.collectOne },
    { name: 'qualified-production', owner: collectOne }, { name: 'visible-gate', owner: collectOne, gate: true },
    { name: 'bound-403', owner: collectOne, nextStatus: 403 },
    { name: 'wrong-author', owner: collectOne, nextAuthor: 'MS4wLjABAAAAAnotherOfflineAuthorOnly' }]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
    let continuationRoutes = 0, allIntercepted = 0, unexpectedAborted = 0;
    try {
      await context.route('**/*', async route => {
        allIntercepted++;
        const address = new URL(route.request().url());
        if (route.request().method() === 'GET' && address.href === profile)
          return route.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml(spec.gate) });
        if (route.request().method() === 'GET' && address.origin === 'https://www.douyin.com'
          && address.pathname === '/aweme/v1/web/aweme/post/' && address.searchParams.get('sec_user_id') === secUid
          && ['0', '100'].includes(address.searchParams.get('max_cursor'))) {
          const cursor = Number(address.searchParams.get('max_cursor'));
          if (cursor) continuationRoutes++;
          return route.fulfill({ status: cursor ? spec.nextStatus ?? 200 : 200, contentType: 'application/json',
            body: JSON.stringify(makeBody(cursor, cursor ? spec.nextAuthor ?? secUid : secUid)) });
        }
        unexpectedAborted++; return route.abort();
      });
      const page = await context.newPage();
      const result = await spec.owner(page, { key: 'synthetic-browser-only', secUid, limit: 30 },
        { timeoutMs: 3500, pageWaitMs: 650, bodyTimeoutMs: 1000, failureGraceMs: 1 });
      const geometry = await page.evaluate(() => {
        const pane = document.querySelector('[data-e2e="user-post-list"]');
        const r = pane.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, scrollTop: pane.scrollTop };
      });
      if (spec.name === 'qualified-production') {
        assert.equal(result.posts.length, 2); assert.equal(result.worksCoverage, 'complete');
        assert.deepEqual(result.pagination.pages.map(p => p.requestCursor), [0, 100]);
        assert.equal(result.posts[1].statistics.digg_count, 9); assert.equal(continuationRoutes, 1);
        assert.ok(geometry.scrollTop > 0);
      } else {
        assert.equal(result.posts.length, 1); assert.equal(result.worksCoverage, 'latest-public-window');
        if (spec.name === 'historical-blind' || spec.gate) {
          assert.equal(continuationRoutes, 0); assert.equal(geometry.scrollTop, 0);
          assert.equal(result.pagination.stopReason, 'page-timeout');
        }
        if (spec.nextStatus) { assert.equal(result.errorCode, 'blocked'); assert.equal(result.pagination.stopReason, 'http-rejection'); }
        if (spec.nextAuthor) assert.notEqual(result.pagination.stopReason, 'end-of-list');
      }
      cases.push({ name: spec.name, locallyFulfilledRoutes: allIntercepted, unexpectedAborted, continuationRoutes,
        geometry, posts: result.posts.length, coverage: result.worksCoverage,
        cursors: result.pagination.pages.map(p => p.requestCursor), stopReason: result.pagination.stopReason,
        errorCode: result.errorCode ?? null });
    } finally { await context.close(); }
  }
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), actualBrowser: 'installed Chrome',
    currentCollectorSha256: createHash('sha256').update(current).digest('hex'),
    actualProductionOwner: true, syntheticDataOnly: true, allRoutesLocallyFulfilledOrAborted: true,
    livePlatformRequests: 0, sessionLoaded: false, databaseOpened: false, cases }, null, 2));
} finally { await browser.close(); }
