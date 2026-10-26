import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseBrowserRetryAfter, parseBrowserRetryAfterValues, browserRetryAfterPolicyInput } from '../lib/browser-retry-after.mjs';
import { WorksRequestPolicy } from '../lib/works-request-policy.mjs';

const SEC = 'MS4wLjABAAAABrowserWaitOfflineFixture1234';
const UID = '123456789';
const START = '2026-10-05T00:00:00.000Z', END = '2026-10-05T00:00:01.000Z';
const target = () => ({ id: 7, enabled: true, type: 'account', provider: 'public-web', locator: SEC, metadata: {} });
const anchor = () => ({ snapshotId: 11, sourceChecksum: 'a'.repeat(64), capturedAt: START, secUid: SEC, uid: UID });
const code = status => status === 429 ? 'rate_limited' : 'network_error';
const diagnostics = status => ({ version: 1, navigation: { observed: true, committed: true, failed: false, timedOut: false },
  requests: { candidate: 1, matched: 1, rejected: {} }, responses: { matched: 1, invalidBodies: 0, bodyTimeouts: 0 },
  httpStatuses: [status], businessStatusCodes: [], stopReason: 'http-rejection', finalPageKind: 'profile', elapsedMs: 1 });

function mockPage({ status = 429, headers = ['7200'], relation = 'bound', readHeaders, prefix = false, replaceDocument = false } = {}) {
  const handlers = new Map(); let frameUrl = 'about:blank', bodyReads = 0, headerReads = 0;
  const frame = { url: () => frameUrl }, emit = (event, value) => handlers.get(event)?.(value);
  const profile = `https://www.douyin.com/user/${SEC}`;
  return {
    on: (event, fn) => handlers.set(event, fn), off: event => handlers.delete(event), mainFrame: () => frame,
    url: () => profile, bodyReads: () => bodyReads, headerReads: () => headerReads,
    goto: async () => {
      const nav = { url: () => profile, frame: () => frame, isNavigationRequest: () => true, method: () => 'GET' };
      emit('request', nav); frameUrl = profile; emit('framenavigated', frame);
      if (prefix) {
        const head = { url: () => `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0`,
          frame: () => frame, isNavigationRequest: () => false, method: () => 'GET' };
        emit('request', head);
        emit('response', { request: () => head, url: head.url, status: () => 200,
          json: async () => { bodyReads++; return { status_code: 0, has_more: true, max_cursor: 123,
            aweme_list: [{ aweme_id: '7200000000000000001', author: { sec_uid: SEC, uid: UID }, statistics: { digg_count: 2 } }] }; } });
        await new Promise(resolve => setImmediate(resolve));
      }
      const request = relation === 'document' ? nav : {
        url: () => `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${relation === 'foreign' ? SEC + 'Other' : SEC}&max_cursor=${prefix ? 123 : 0}`,
        frame: () => frame, isNavigationRequest: () => false, method: () => 'GET' };
      if (relation !== 'unmatched' && relation !== 'document') emit('request', request);
      emit('response', { request: () => request, url: request.url, status: () => status,
        headerValues: async name => { assert.equal(name, 'retry-after'); headerReads++; return readHeaders ? readHeaders() : headers; },
        headers: () => { throw new Error('all headers prohibited'); }, allHeaders: () => { throw new Error('all headers prohibited'); },
        json: async () => { bodyReads++; throw new Error('rejected body prohibited'); } });
      if (replaceDocument) { const changed = { ...nav, url: () => `https://www.douyin.com/user/${SEC}Other` };
        emit('request', changed); frameUrl = changed.url(); emit('framenavigated', frame); }
    },
  };
}

test('strict parser matches the independent Python parser across seconds, dates, invalid calendars and century boundaries', () => {
  const now = Date.parse('2026-09-26T07:00:00.000Z');
  const values = ['120', '0', '000120', '253402300799', '999999999999999999999', '9'.repeat(512), '9'.repeat(513),
    null, 120, '', ' 120', '120 ', '-1', '+120', '1.5', '1e3', '120, 240', '120\r\nCookie: PRIVATE_SECRET',
    'Sat, 26 Sep 2026 09:00:00 GMT', 'Saturday, 26-Sep-26 09:00:00 GMT', 'Sat Sep 26 09:00:00 2026',
    'Fri, 25 Sep 2026 09:00:00 GMT', 'Sun, 26 Sep 2026 09:00:00 GMT', 'Sat, 31 Feb 2026 09:00:00 GMT',
    'Sat, 26 Sep 2026 24:00:00 GMT', 'Sat, 26 Sep 2026 09:60:00 GMT', 'Sat, 26 Sep 2026 09:00:60 GMT',
    'Sat, 26 Sep 2026 09:00:00 UTC', '2026-09-26T09:00:00Z', 'Thu Feb 29 09:00:00 2024',
    'Fri Feb 29 09:00:00 2026', 'Sat Sep  6 09:00:00 2026'];
  const cases = values.map(value => ({ value, now: now / 1000 }));
  for (const year of [1977, 2076, 2077]) {
    const date = new Date(Date.UTC(year, 8, 26, 9));
    const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][date.getUTCDay()];
    cases.push({ value: `${day}, 26-Sep-${String(year % 100).padStart(2, '0')} 09:00:00 GMT`, now: now / 1000 });
  }
  cases.push({ value: 'Fri, 31 Dec 9999 23:59:59 GMT', now: now / 1000 + 0.5 });
  const program = 'import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location("collector",sys.argv[1])\nc=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)\nrows=json.loads(sys.argv[2])\nprint(json.dumps([c.parse_retry_after(r["value"],r["now"]) for r in rows]))';
  const child = spawnSync('/usr/bin/python3', ['-B', '-c', program,
    fileURLToPath(new URL('../scripts/douyin_public_collector.py', import.meta.url)), JSON.stringify(cases)], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  const expected = JSON.parse(child.stdout), actual = cases.map(row => parseBrowserRetryAfter(row.value, row.now * 1000));
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual.slice(18, 21).map(row => row.retryAfterSeconds), [7200, 7200, 7200]);
  assert.ok(actual[values.length + 1].retryAfterSeconds > 0, 'exact 50-year boundary remains in the future');
  assert.equal(actual[values.length].retryAfterSeconds, 0, 'over 50-year obsolete date resolves to prior century');
  assert.equal(actual[values.length + 2].retryAfterStatus, 'invalid', 'weekday must match the resolved century');
  assert.equal(actual.at(-1).retryAfterStatus, 'too-long');
  assert.doesNotMatch(JSON.stringify(actual), /PRIVATE_SECRET|Cookie/);
});

test('single-header values reject duplicates, folding, CRLF and malformed lists', () => {
  const now = Date.parse(START);
  assert.equal(parseBrowserRetryAfterValues([], now).retryAfterStatus, 'absent');
  assert.equal(parseBrowserRetryAfterValues(['7200'], now).retryAfterSeconds, 7200);
  for (const values of [null, '7200', ['120', '240'], ['120\n folded'], ['120\r\nCookie: PRIVATE_SECRET'], ['120, 240'], [null]])
    assert.equal(parseBrowserRetryAfterValues(values, now).retryAfterStatus, 'invalid');
});

for (const relation of ['foreign', 'document', 'unmatched', 'redirect']) {
  test(`${relation} response never reads Retry-After`, async () => {
    const page = mockPage({ relation, status: relation === 'redirect' ? 302 : 429 });
    const result = await collectOne(page, { key: '7', secUid: SEC, limit: 30 }, { timeoutMs: 60, failureGraceMs: 1 });
    assert.equal(page.headerReads(), 0); assert.equal(page.bodyReads(), 0); assert.equal(result.retryAfter, undefined);
  });
}

test('absent, duplicate and hostile header hints never expose raw values or turn failure into success', async () => {
  for (const [headers, status] of [[[], 'absent'], [['120', '240'], 'invalid'], [['120\r\nCookie: PRIVATE_SECRET'], 'invalid'], [['9'.repeat(200)], 'too-long']]) {
    const page = mockPage({ headers });
    const result = await collectOne(page, { key: '7', secUid: SEC, limit: 30 }, { timeoutMs: 100, failureGraceMs: 1 });
    assert.equal(result.retryAfter.retryAfterStatus, status); assert.equal(result.errorCode, 'rate_limited');
    assert.equal(result.status, 'unavailable'); assert.equal(page.bodyReads(), 0);
    assert.deepEqual(Object.keys(result.retryAfter).sort(), ['httpStatus', 'observedAt', 'retryAfterSeconds', 'retryAfterStatus']);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET|Cookie|999999/);
  }
});

test('header failure or timeout keeps original failure and existing absolute deadline', async () => {
  for (const readHeaders of [() => { throw new Error('PRIVATE_SECRET'); }, () => new Promise(() => {})]) {
    const page = mockPage({ readHeaders }), started = Date.now();
    const result = await collectOne(page, { key: '7', secUid: SEC, limit: 30 }, { timeoutMs: 60, failureGraceMs: 1 });
    assert.equal(result.errorCode, 'rate_limited'); assert.equal(result.retryAfter, undefined); assert.equal(page.bodyReads(), 0);
    assert.ok(Date.now() - started < 1000); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET/);
  }
});

for (const status of [429, 503]) {
  test(`profile fallback HTTP${status} also preserves the wait and fresh profile without business upgrade`, async () => {
    const provider = fixture(status);
    const profile = { sec_uid: SEC, uid: UID, nickname: 'offline', follower_count: 12, total_favorited: 34, aweme_count: 5 };
    provider.run = async () => ({ profile: { user: profile }, capturedAt: START,
      worksCoverage: 'unavailable', worksErrorCode: 'network_error', works: { aweme_list: [] }, warnings: [] });
    const result = await provider.collectAccount(target());
    assert.deepEqual(result.raw.profile.user, profile); assert.equal(result.worksCoverage, 'unavailable'); assert.equal(result.posts.length, 0);
    assert.equal(result.raw.worksRequestPolicy.browser.errorCode, code(status));
    assert.ok(Date.parse(result.raw.worksRequestPolicy.browser.nextEligibleAt) >= Date.parse(END) + 7200_000);
    const before = result.raw.worksRequestPolicy.browser.nextEligibleAt;
    provider.worksRequestPolicy.record('authorised-browser', { errorCode: null });
    assert.equal(provider.worksRequestPolicy.decision('authorised-browser').nextEligibleAt, before);
    const restored = new WorksRequestPolicy({ now: () => Date.parse(END) }); restored.restore(result.raw.worksRequestPolicy);
    assert.equal(restored.decision('authorised-browser').nextEligibleAt, before);
  });
}

test('untrusted key, HTTP/diagnostic bindings or hint times cannot grant a provider wait', async () => {
  const baseline = await fixture(429, value => { delete value.retryAfter; return value; }).collectWorksOnly(target(), anchor());
  const mutations = [
    value => { value.key = 'foreign'; }, value => { delete value.key; }, value => { value.retryAfter.httpStatus = 302; },
    value => { value.retryAfter.httpStatus = 503; }, value => { value.failureDiagnostics.requests.matched = 0; },
    value => { value.failureDiagnostics.responses.matched = 0; }, value => { value.failureDiagnostics.httpStatuses = [403]; },
    value => { value.failureDiagnostics.navigation.committed = false; }, value => { value.failureDiagnostics.stopReason = 'deadline'; },
    value => { value.retryAfter.observedAt = '2026-10-05T00:00:01.001Z'; },
    value => { value.retryAfter.observedAt = '2026-10-04T23:59:59.999Z'; },
    value => { value.retryAfter.observedAt = '2026-10-05T00:00:01Z'; },
    value => { value.retryAfter.retryAfterStatus = 'invalid'; }, value => { value.retryAfter.retryAfterSeconds = -1; },
    value => { value.retryAfter.retryAfterSeconds = Infinity; }, value => { value.retryAfter.retryAfterStatus = 'too-long'; },
  ];
  for (const mutate of mutations) {
    const provider = fixture(429, value => { mutate(value); return value; });
    const result = await provider.collectWorksOnly(target(), anchor());
    assert.equal(result.requestPolicy.browser.retryAfterStatus, null);
    assert.ok(result.requestPolicy.browser.nextEligibleAt === null
      || Date.parse(result.requestPolicy.browser.nextEligibleAt) < Date.parse(END) + 7200_000);
    if (result.result.errorCode === 'rate_limited') assert.deepEqual(result.result.posts, baseline.result.posts);
  }
});

test('unrepresentable waits hold across success and restore without retaining their source hint', async () => {
  for (const hint of [{ retryAfterStatus: 'too-long', retryAfterSeconds: null },
    { retryAfterStatus: 'valid', retryAfterSeconds: 253402300799 - Date.parse(END) / 1000 + 1 }]) {
    const provider = fixture(503, value => { Object.assign(value.retryAfter, hint); return value; });
    const result = await provider.collectWorksOnly(target(), anchor());
    assert.equal(result.requestPolicy.browser.retryAfterStatus, 'too-long'); assert.equal(result.requestPolicy.browser.nextEligibleAt, null);
    provider.worksRequestPolicy.record('authorised-browser', { errorCode: null });
    assert.equal(provider.worksRequestPolicy.decision('authorised-browser').reason, 'upstream-wait-exceeds-policy');
    const restored = new WorksRequestPolicy({ now: () => Date.parse(END) }); restored.restore(result.requestPolicy);
    assert.equal(restored.decision('authorised-browser').deferred, true); assert.equal(restored.decision('authorised-browser').retryAfterStatus, 'too-long');
    assert.equal(result.result.status, 'unavailable'); assert.equal(result.result.retryAfter, undefined);
  }
});

test('safe projection exports policy fields only, never arbitrary hint or error strings', () => {
  const item = { key: '7', status: 'unavailable', errorCode: 'rate_limited', failureDiagnostics: diagnostics(429),
    retryAfter: { httpStatus: 429, observedAt: END, retryAfterStatus: 'valid', retryAfterSeconds: 7200, headers: 'PRIVATE_SECRET' }, cookie: 'PRIVATE_SECRET' };
  assert.deepEqual(browserRetryAfterPolicyInput(item, { key: '7', startedAt: START, finishedAt: END, errorCode: 'rate_limited' }),
    { retryAfterStatus: 'valid', retryAfterSeconds: 7200 });
});

test('a refused later page keeps the verified prefix limited while carrying the wait end to end', async () => {
  const page = mockPage({ prefix: true }), sourceItems = [];
  const provider = new PublicWebProvider({ publicPostsPerAccount: 30 }, { accountBrowserFallback: true,
    fetchImpl: () => { throw new Error('network prohibited'); }, execFileImpl: () => { throw new Error('process prohibited'); } });
  provider.runBrowserWorks = async item => { const value = await collectOne(page, item, { timeoutMs: 150, failureGraceMs: 1 });
    sourceItems.push(value); return { items: [value] }; };
  const a = { ...anchor(), capturedAt: new Date().toISOString() };
  const result = await provider.collectWorksOnly(target(), a);
  assert.equal(page.bodyReads(), 1, 'only the successful first page body is read');
  assert.equal(result.result.status, 'ok'); assert.equal(result.result.worksCoverage, 'limited'); assert.equal(result.result.posts.length, 1);
  assert.equal(result.result.errorCode, 'rate_limited'); assert.equal(result.result.pagination.stopReason, 'http-rejection');
  assert.ok(Date.parse(result.requestPolicy.browser.nextEligibleAt) >= Date.parse(sourceItems[0].retryAfter.observedAt) + 7200_000);
});

test('profile fallback ignores a correct-looking hint in an ambiguous multi-item child envelope', async () => {
  const provider = fixture(429), original = provider.runBrowserWorks;
  provider.runBrowserWorks = async (...args) => { const output = await original(...args); output.items.push({ ...output.items[0], key: 'foreign' }); return output; };
  provider.run = async () => ({ profile: { user: { sec_uid: SEC, uid: UID, follower_count: 1, total_favorited: 2, aweme_count: 3 } },
    capturedAt: START, worksCoverage: 'unavailable', worksErrorCode: 'network_error', works: { aweme_list: [] }, warnings: [] });
  const result = await provider.collectAccount(target());
  assert.equal(result.raw.worksRequestPolicy.browser.retryAfterStatus, null);
  assert.equal(Date.parse(result.raw.worksRequestPolicy.browser.nextEligibleAt), Date.parse(END) + 15 * 60_000);
});

test('document replacement before asynchronous header completion invalidates its hint', async () => {
  const page = mockPage({ replaceDocument: true, readHeaders: () => new Promise(resolve => setTimeout(() => resolve(['7200']), 5)) });
  const result = await collectOne(page, { key: '7', secUid: SEC, limit: 30 }, { timeoutMs: 60, failureGraceMs: 1 });
  assert.equal(result.retryAfter, undefined); assert.equal(page.bodyReads(), 0);
});

function fixture(status, change = value => value) {
  let now = Date.parse(START);
  const provider = new PublicWebProvider({ publicPostsPerAccount: 30 }, { accountBrowserFallback: true,
    now: () => now, worksRequestPolicyOptions: { now: () => now },
    fetchImpl: () => { throw new Error('network prohibited'); }, execFileImpl: () => { throw new Error('process prohibited'); } });
  provider.runBrowserWorks = async () => { now = Date.parse(END); return { items: [change({ key: '7', status: 'unavailable', posts: [],
    errorCode: code(status), failureDiagnostics: diagnostics(status),
    retryAfter: { httpStatus: status, observedAt: END, retryAfterStatus: 'valid', retryAfterSeconds: 7200 } })] }; };
  return provider;
}

for (const status of [429, 503]) {
  test(`bound HTTP${status} projects a 2h wait without reading body or all headers`, async () => {
    const page = mockPage({ status });
    const result = await collectOne(page, { key: '7', secUid: SEC, limit: 30 }, { timeoutMs: 100, failureGraceMs: 1 });
    assert.equal(page.bodyReads(), 0); assert.equal(result.errorCode, code(status));
    assert.equal(result.retryAfter?.retryAfterSeconds, 7200);
    assert.equal(result.retryAfter?.httpStatus, status); assert.equal(page.headerReads(), 1);
    assert.equal(result.status, 'unavailable'); assert.equal(result.posts.length, 0);
  });
  test(`works-only HTTP${status} preserves >=2h policy without improving failed coverage`, async () => {
    const result = await fixture(status).collectWorksOnly(target(), anchor());
    assert.equal(result.result.errorCode, code(status)); assert.equal(result.result.status, 'unavailable');
    assert.ok(Date.parse(result.requestPolicy.browser.nextEligibleAt) >= Date.parse(END) + 7200_000);
    assert.equal(result.requestPolicy.browser.retryAfterStatus, 'valid');
  });
}
