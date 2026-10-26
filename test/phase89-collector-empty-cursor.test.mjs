// Independent tests execute the ACTUAL production/staged collector and ledger.
// Reuse only Phase87's local browser event/DOM fixture, not its assertions.
// No live network, user state, source replay, production write, or timer change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ownerURL = process.env.PHASE89_OWNER_URL || new URL('../scripts/douyin_browser_collector.mjs', import.meta.url).href;
const fixture = (await readFile(new URL('./phase87-collector-peer.test.mjs', import.meta.url), 'utf8'))
  .split('\ntest(')[0]
  .replace("process.env.PHASE87_OWNER_URL || '../scripts/douyin_browser_collector.mjs'", JSON.stringify(ownerURL));
const { run, payload, SEC } = await import(`data:text/javascript;base64,${Buffer.from(fixture + '\nexport {run,payload,SEC};').toString('base64')}`);
const { collectOne, normalizeBrowserWorks } = await import(ownerURL);
const { BrowserWorksPagination } = await import(new URL('../lib/browser-works-pagination.mjs', ownerURL));
const { validatedBrowserPagination } = await import(new URL('../lib/official-profile-evidence.mjs', ownerURL));
const { validateWorksOnlyEvidence } = await import(new URL('../lib/works-only-observation.mjs', ownerURL));
const empty = (cursor, more = true) => ({ ...payload(cursor, more), aweme_list: [] });
const middleEmpty = { 0: { body: payload(0, true) }, 10: { body: empty(10) }, 20: { body: payload(20) } };

test('phase89 actual owner: progressing empty middle page preserves third-page opportunity', async t => {
  const { result, page } = await run(t, { responses: middleEmpty });
  assert.deepEqual(result.pagination.pages.map(p => p.requestCursor), [0, 10, 20]);
  assert.deepEqual(result.pagination.pages.map(p => p.rawCount), [1, 0, 1]);
  assert.deepEqual(page.gets.map(p => p.cursor), [0, 10, 20]);
  assert.equal(result.posts.length, 2); assert.equal(page.reads, 3);
  assert.equal(result.pagination.stopReason, 'end-of-list');
  assert.equal(result.worksCoverage, 'complete');
  assert.ok(validatedBrowserPagination(result.pagination, { limit: 30, posts: result.posts,
    hasMore: result.hasMore, maxCursor: result.maxCursor,
    notBefore: new Date(0).toISOString(), notAfter: Date.now() }));
  const persisted = { version: 1, kind: 'works-only-observation', source: 'authorised-browser', targetId: 1, runId: 2440,
    anchorSnapshotId: 1, anchorChecksum: 'a'.repeat(64), requestedLimit: 30,
    identity: { secUid: SEC, uid: '1234567890' }, requestStartedAt: new Date(0).toISOString(),
    requestFinishedAt: new Date(Date.now()).toISOString(), observedAt: result.pagination.pages.at(-1).observedAt,
    status: 'accepted', coverage: 'limited', errorCode: null,
    posts: result.posts.map(({ aweme_id, author, statistics, desc, create_time }) => ({
      aweme_id, author: { sec_uid: author.sec_uid, uid: author.uid }, statistics, desc, create_time,
    })), pagination: result.pagination };
  assert.equal(validateWorksOnlyEvidence(persisted, { now: Date.now() }).coverage, 'limited',
    'actual works-only canonical boundary must retain limited coverage');
  assert.ok(page.gets[0].at >= 25_000, 'full original natural response opportunity');
  assert.ok(page.gets[2].at < page.gets[1].at + 3_020, 'original three-second page request window');
  assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
});

test('phase89 actual owner: initial empty page with valid next cursor is not a terminal empty archive', async t => {
  const { result, page } = await run(t, { responses: { 0: { body: empty(0) }, 10: { body: payload(10) } } });
  assert.deepEqual(page.gets.map(p => p.cursor), [0, 10]);
  assert.equal(result.posts.length, 1); assert.equal(result.pagination.stopReason, 'end-of-list');
});

test('phase89 actual owner: three advancing empty pages exhaust page ceiling without false completeness', async t => {
  const { result, page } = await run(t, { responses: {
    0: { body: empty(0) }, 10: { body: empty(10) }, 20: { body: empty(20) },
  } });
  assert.deepEqual(page.gets.map(p => p.cursor), [0, 10, 20]);
  assert.equal(result.pagination.pages.length, 3); assert.equal(result.posts.length, 0);
  assert.equal(result.pagination.stopReason, 'page-limit');
  assert.equal(result.worksCoverage, 'latest-public-window');
});

test('phase89 negative: duplicate-only page keeps no-progress stop', async t => {
  const duplicate = { ...payload(10, true), aweme_list: payload(0).aweme_list };
  const { result, page } = await run(t, { responses: { ...middleEmpty, 10: { body: duplicate } } });
  assert.deepEqual(page.gets.map(p => p.cursor), [0, 10]);
  assert.equal(result.posts.length, 1); assert.equal(result.pagination.stopReason, 'no-progress');
  assert.equal(result.worksCoverage, 'latest-public-window');
});

test('phase89 negative: empty page with repeated cursor remains terminal', async t => {
  const { result, page } = await run(t, { responses: {
    ...middleEmpty, 10: { body: { ...empty(10), max_cursor: 10 } },
  } });
  assert.deepEqual(page.gets.map(p => p.cursor), [0, 10]);
  assert.equal(result.pagination.stopReason, 'cursor-not-progressing');
  assert.equal(result.worksCoverage, 'latest-public-window');
});

test('phase89 negative: empty page without explicit pagination cannot become successful evidence', async t => {
  const { result, page } = await run(t, { responses: {
    ...middleEmpty, 10: { body: { ...empty(10), has_more: undefined } },
  } });
  assert.deepEqual(page.gets.map(p => p.cursor), [0, 10]);
  assert.equal(result.status, 'unavailable'); assert.equal(result.posts.length, 0);
  assert.equal(result.pagination.stopReason, 'unknown-pagination');
});

test('phase89 negative: final explicit empty page still ends immediately', async t => {
  const { result, page } = await run(t, { responses: { ...middleEmpty, 10: { body: empty(10, false) } } });
  assert.deepEqual(page.gets.map(p => p.cursor), [0, 10]);
  assert.equal(result.pagination.stopReason, 'end-of-list'); assert.equal(result.posts.length, 1);
});

test('phase89 actual owner: third-page HTTP403 after empty page is a terminal refusal', async t => {
  const { result, page } = await run(t, { responses: { ...middleEmpty, 20: { status: 403 } } });
  assert.deepEqual(page.gets.map(p => p.cursor), [0, 10, 20]);
  assert.equal(result.pagination.stopReason, 'http-rejection'); assert.equal(result.posts.length, 1);
  assert.equal(page.reads, 2, '403 body must not be read');
  assert.equal(result.worksCoverage, 'latest-public-window');
});

test('phase89 actual owner: third-page business2483 after empty page is a terminal refusal', async t => {
  const { result, page } = await run(t, { responses: { ...middleEmpty, 20: { body: { status_code: 2483 } } } });
  assert.deepEqual(page.gets.map(p => p.cursor), [0, 10, 20]);
  assert.equal(result.pagination.stopReason, 'login-required'); assert.equal(result.posts.length, 1);
  assert.equal(result.worksCoverage, 'latest-public-window');
});

test('phase89 negative: empty-page continuation cannot exceed supplied parent work deadline', async t => {
  const { result, page } = await run(t, { responses: {
    ...middleEmpty, 10: { body: empty(10), bodyDelay: 15_000 },
  } }, { options: { timeoutMs: 35_500 } });
  assert.deepEqual(page.gets.map(p => p.cursor), [0, 10]);
  assert.equal(result.posts.length, 1); assert.equal(result.pagination.pages.length, 1);
  assert.ok(result.failureDiagnostics.elapsedMs <= 35_500);
});

test('phase89 actual owner: cancellation after empty page forbids third-page dispatch', async t => {
  const controller = new AbortController(); let reachedThird = false;
  const { result, page } = await run(t, { responses: middleEmpty, beforeHandleReturn: p => {
    if (p.reads === 2) { reachedThird = true; controller.abort(); }
  } }, { options: { signal: controller.signal } });
  assert.equal(reachedThird, true, 'must exercise third-page permission boundary');
  assert.deepEqual(page.gets.map(p => p.cursor), [0, 10]);
  assert.equal(result.posts.length, 1); assert.equal(result.pagination.stopReason, 'cancelled');
});

test('phase89 actual owner: newly visible gate after empty page forbids third-page dispatch', async t => {
  let reachedThird = false;
  const { result, page } = await run(t, { responses: middleEmpty, beforeEvaluate: (p, fn, args) => {
    if (fn.name === 'requestBrowserFirstPage' && args?.continuationCursor === 20) {
      reachedThird = true; p.config.gate = true;
    }
  } });
  assert.equal(reachedThird, true, 'must exercise real serialized helper gate');
  assert.deepEqual(page.gets.map(p => p.cursor), [0, 10]);
  assert.equal(result.posts.length, 1); assert.equal(result.pagination.stopReason, 'verification-required');
});

test('phase89 actual ledger: advancing empty pages obey supplied one-page and two-page ceilings', () => {
  for (const maxPages of [1, 2]) {
    const ledger = new BrowserWorksPagination({ limit: 30, maxPages });
    for (let n = 0; n < maxPages; n++) {
      const body = empty(n * 10);
      assert.equal(ledger.accept({ requestCursor: n * 10, body,
        normalized: normalizeBrowserWorks(body, SEC, 30), observedAt: new Date(1000 + n).toISOString() }), true);
    }
    const result = ledger.result(maxPages), extra = empty(maxPages * 10);
    assert.equal(result.pagination.pages.length, maxPages); assert.equal(result.pagination.stopReason, 'page-limit');
    assert.equal(result.coverage, 'latest-public-window');
    assert.equal(ledger.accept({ requestCursor: maxPages * 10, body: extra,
      normalized: normalizeBrowserWorks(extra, SEC, 30), observedAt: new Date(2000).toISOString() }), false);
  }
});

test('phase89 actual ledger: raw nonempty filtered page still stops before remaining page opportunity', () => {
  const ledger = new BrowserWorksPagination({ limit: 30, maxPages: 3 });
  const body = payload(0, true);
  body.aweme_list.push(...payload(10, true, 'MS4wLjABAAAAphase89WrongAuthor').aweme_list);
  const normalized = normalizeBrowserWorks(body, SEC, 30);
  assert.equal(normalized.filteredCount, 1);
  assert.equal(ledger.accept({ requestCursor: 0, body, normalized, observedAt: new Date(1000).toISOString() }), true);
  const result = ledger.result(1);
  assert.equal(result.pagination.pages[0].rawCount, 2); assert.equal(result.posts.length, 1);
  assert.equal(result.pagination.stopReason, 'filtered-rows'); assert.equal(result.coverage, 'latest-public-window');
  const next = payload(10);
  assert.equal(ledger.accept({ requestCursor: 10, body: next,
    normalized: normalizeBrowserWorks(next, SEC, 30), observedAt: new Date(2000).toISOString() }), false);
});

// Register this integration test only on explicit independent execution.
// Fresh local contexts; all platform traffic is fulfilled locally or aborted.
if (process.env.PHASE89_CHROME_PROOF === '1') test('phase89 actual isolated Chrome: empty page progress, page ceiling and refusal', async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, timeout: 10_000 });
  try {
    await Promise.all(['empty-middle', 'empty-chain', 'third403'].map(async kind => {
      const context = await browser.newContext({ serviceWorkers: 'block', locale: 'zh-CN' });
      const traffic = { documents: 0, cursors: [], external: 0 };
      try {
        await context.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url());
          if (request.isNavigationRequest() && url.href === `https://www.douyin.com/user/${SEC}`) {
            traffic.documents++;
            return route.fulfill({ status: 200, contentType: 'text/html',
              body: '<!doctype html><html><head><title>Local Phase89</title></head><body><main>Local fixture</main></body></html>' });
          }
          if (url.origin === 'https://www.douyin.com' && url.pathname === '/aweme/v1/web/aweme/post/') {
            const cursor = Number(url.searchParams.get('max_cursor'));
            assert.equal(url.searchParams.get('sec_user_id'), SEC); traffic.cursors.push(cursor);
            const refusal = kind === 'third403' && cursor === 20;
            const body = kind === 'empty-chain' ? empty(cursor) : cursor === 10 ? empty(cursor) : payload(cursor, cursor === 0);
            return route.fulfill({ status: refusal ? 403 : 200, contentType: 'application/json', body: JSON.stringify(body) });
          }
          traffic.external++; return route.abort();
        });
        const page = await context.newPage();
        const result = await collectOne(page, { key: `phase89-native-${kind}`, secUid: SEC, limit: 30 });
        console.log(JSON.stringify({ kind, elapsedMs: result.failureDiagnostics.elapsedMs,
          pages: result.pagination.pages.length, posts: result.posts.length, stop: result.pagination.stopReason,
          requests: traffic.cursors.length, documents: traffic.documents, external: traffic.external,
          allPlatformTrafficLocallyFulfilled: true }));
        assert.deepEqual(traffic.cursors, [0, 10, 20]);
        assert.equal(traffic.documents, 1); assert.equal(traffic.external, 0);
        assert.equal(result.pagination.pages.length, kind === 'third403' ? 2 : 3);
        assert.equal(result.posts.length, kind === 'third403' ? 1 : kind === 'empty-chain' ? 0 : 2);
        assert.equal(result.pagination.stopReason, kind === 'third403' ? 'http-rejection' : kind === 'empty-chain' ? 'page-limit' : 'end-of-list');
        assert.equal(result.worksCoverage, kind === 'empty-middle' ? 'complete' : 'latest-public-window');
        assert.ok(result.failureDiagnostics.elapsedMs <= 45_000);
      } finally { await context.close(); }
    }));
  } finally { await browser.close(); }
});
