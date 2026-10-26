import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { BrowserWorksPagination } from '../lib/browser-works-pagination.mjs';
import { normalizeBrowserWorks } from '../scripts/douyin_browser_collector.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';

const SEC = 'MS4wLjABAAAAWorksOnlyProviderFixture123456';
const UID = '123456789';
const START = '2026-09-29T00:00:00.000Z', END = '2026-09-29T00:00:10.000Z';
const target = () => ({ id: 7, enabled: true, type: 'account', provider: 'public-web', locator: SEC, metadata: {} });
const anchor = () => ({ snapshotId: 11, sourceChecksum: 'a'.repeat(64), capturedAt: '2026-09-28T23:59:00.000Z', secUid: SEC, uid: UID });
function item({ partial = false, empty = false } = {}) {
  const pager = new BrowserWorksPagination({ limit: 30 });
  const body = { status_code: 0, has_more: partial, max_cursor: partial ? 10 : 0,
    aweme_list: empty ? [] : [{ aweme_id: '7200000000000000001', author: { sec_uid: SEC, uid: UID }, statistics: { digg_count: 2 } }] };
  pager.accept({ requestCursor: 0, body, normalized: normalizeBrowserWorks(body, SEC), observedAt: END });
  if (partial) pager.stop('http-rejection', 'blocked');
  const result = pager.result(partial ? 2 : 1);
  return { key: '7', status: 'ok', ...result, worksCoverage: 'complete', errorCode: partial ? 'blocked' : null };
}
function fixture(options = {}) {
  let now = Date.parse(START), calls = 0;
  const provider = new PublicWebProvider({ publicPostsPerAccount: 30 }, {
    accountBrowserFallback: true, now: () => now, worksRequestPolicyOptions: { now: () => now },
    fetchImpl: () => { throw new Error('network prohibited'); },
    execFileImpl: () => { throw new Error('process prohibited'); }, ...options,
  });
  provider.collectAccount = provider.run = async () => { throw new Error('profile collection prohibited'); };
  provider.runBrowserWorks = async (request, runtime) => {
    calls++; assert.deepEqual(request, { key: '7', secUid: SEC, limit: 30 });
    assert.equal(runtime.timeoutMs, 45_000); assert.equal(runtime.signal, provider.signal);
    now = Date.parse(END); return { items: [item()] };
  };
  return { provider, calls: () => calls, setNow: value => { now = value; } };
}

test('works-only page occlusion is recorded but does not count as a transport failure', async () => {
  const f = fixture();
  const failureDiagnostics = sanitizeBrowserWorksDiagnostics({
    version: 1, stopReason: 'no-bound-request', finalPageKind: 'profile',
    navigation: { observed: true, committed: true, failed: false, timedOut: false },
    requests: { candidate: 0, matched: 0 }, responses: { matched: 0 },
    httpStatuses: [], businessStatusCodes: [],
    firstPageActivation: { state: 'blocked', structure: { reason: 'visible-gate', gates: {
      version: 1, candidateCount: 8, visibleCount: 7, excludedNavigationCount: 0,
      excludedDecorationCount: 0, decision: 'unknown',
      detail: { version: 1, reason: 'navigation-absent', worksRegion: 'occluded' },
    } } },
  });
  f.provider.runBrowserWorks = async () => {
    f.setNow(Date.parse(END));
    return { items: [{ key: '7', status: 'unavailable', posts: [], errorCode: 'collector_error', failureDiagnostics }] };
  };
  const response = await f.provider.collectWorksOnly(target(), anchor());
  assert.equal(response.result.status, 'unavailable');
  assert.equal(response.result.errorCode, 'collector_error');
  assert.deepEqual(response.result.failureDiagnostics, failureDiagnostics);
  assert.equal(response.requestPolicy.browser.errorCode, 'collector_error');
  assert.equal(f.provider.worksRequestPolicy.lane('authorised-browser').transientFailures.length, 0);
  assert.equal(f.provider.worksRequestPolicy.decision('authorised-browser').deferred, false);
});

test('works-only requests only bound browser works, preserves real times and never claims complete', async () => {
  const f = fixture(); const a = anchor(); const before = structuredClone(a);
  const result = await f.provider.collectWorksOnly(target(), a);
  assert.equal(f.calls(), 1); assert.deepEqual(a, before);
  assert.equal(result.attempted, true); assert.equal(result.deferred, false);
  assert.equal(result.requestStartedAt, START); assert.equal(result.requestFinishedAt, END);
  assert.equal(result.requestedLimit, 30); assert.equal(result.result.worksCoverage, 'limited');
  assert.equal(result.result.pagination.version, 1); assert.equal(result.result.pagination.pages[0].observedAt, END);
  assert.equal(result.requestPolicy.browser.attempted, true); assert.equal(result.requestPolicy.browser.errorCode, null);
  assert.equal('snapshot' in result, false); assert.equal('capturedAt' in result, false);
});

test('authorization off and invalid/stale anchors fail before any browser attempt', async t => {
  const disabled = fixture({ accountBrowserFallback: false });
  await assert.rejects(disabled.provider.collectWorksOnly(target(), anchor()), { code: 'WORKS_ONLY_DISABLED' });
  assert.equal(disabled.calls(), 0);
  for (const [name, mutate] of [
    ['paused', (t) => { t.enabled = false; }], ['non-douyin', t => { t.metadata.platform = 'bilibili'; }],
    ['other provider', t => { t.provider = 'fixture'; }], ['invalid id', t => { t.id = -1; }],
    ['locator mismatch', t => { t.locator += 'Other'; }], ['missing UID', (_t, a) => { delete a.uid; }],
    ['invalid hash', (_t, a) => { a.sourceChecksum = 'fake'; }],
    ['stale', (_t, a) => { a.capturedAt = '2026-09-28T15:59:59.999Z'; }],
    ['future anchor', (_t, a) => { a.capturedAt = END; }],
  ]) await t.test(name, async () => {
    const f = fixture(), tr = target(), a = anchor(); mutate(tr, a);
    await assert.rejects(f.provider.collectWorksOnly(tr, a), { code: 'WORKS_ONLY_ANCHOR_INVALID' });
    assert.equal(f.calls(), 0);
  });
});

test('cooldown returns deferred without request, policy attempt, result or fabricated time', async () => {
  const f = fixture(); f.provider.worksRequestPolicy.record('authorised-browser', { targetKey: SEC, errorCode: 'login_required' });
  const before = structuredClone(f.provider.worksRequestPolicy.lane('authorised-browser'));
  const result = await f.provider.collectWorksOnly(target(), anchor());
  assert.equal(result.attempted, false); assert.equal(result.deferred, true); assert.equal(result.result, null);
  assert.equal(result.requestStartedAt, null); assert.equal(result.requestFinishedAt, null);
  assert.equal(result.requestPolicy.browser.attempted, false); assert.equal(f.calls(), 0);
  assert.deepEqual(f.provider.worksRequestPolicy.lane('authorised-browser'), before);
});

test('local browser lane busy is deferred without a source attempt or fabricated observation', async () => {
  const f = fixture();
  f.provider.runBrowserWorks = async () => {
    throw Object.assign(new Error('PRIVATE_SESSION'), { code: 'BROWSER_LANE_BUSY' });
  };
  const before = structuredClone(f.provider.worksRequestPolicy.lane('authorised-browser'));
  const result = await f.provider.collectWorksOnly(target(), anchor());
  assert.equal(result.attempted, false);
  assert.equal(result.deferred, true);
  assert.equal(result.deferredReason, 'browser-lane-busy');
  assert.equal(result.requestStartedAt, null);
  assert.equal(result.requestFinishedAt, null);
  assert.equal(result.requestPolicy, null);
  assert.equal(result.result, null);
  assert.deepEqual(f.provider.worksRequestPolicy.lane('authorised-browser'), before);
  assert.equal(JSON.stringify(result).includes('PRIVATE_SESSION'), false);
});

test('malformed identity, pagination, timing and metrics never become accepted evidence', async t => {
  for (const [name, mutate] of [
    ['wrong result key', v => { v.key = '8'; }], ['missing key', v => { delete v.key; }],
    ['wrong author', v => { v.posts[0].author.sec_uid += 'Other'; }],
    ['wrong UID', v => { v.posts[0].author.uid = '99888'; }], ['missing UID', v => { delete v.posts[0].author.uid; }],
    ['legacy pagination', v => { delete v.pagination; }], ['wrong cursor', v => { v.pagination.pages[0].requestCursor = 99; }],
    ['before request', v => { v.pagination.pages[0].observedAt = '2026-09-28T23:59:59.999Z'; }],
    ['future page', v => { v.pagination.pages[0].observedAt = '2026-09-29T00:00:10.001Z'; }],
    ['unsafe count', v => { v.posts[0].statistics.digg_count = Number.MAX_SAFE_INTEGER + 1; }],
    ['duplicate ID', v => { v.posts.push(structuredClone(v.posts[0])); }],
    ['erased partial failure', v => { v.pagination.errorCode = 'blocked'; }],
  ]) await t.test(name, async () => {
    const f = fixture(), value = item(); mutate(value);
    f.provider.runBrowserWorks = async () => { f.setNow(Date.parse(END)); return { items: [value] }; };
    const response = await f.provider.collectWorksOnly(target(), anchor());
    assert.deepEqual(response.result, { status: 'unavailable', posts: [], errorCode: 'upstream_changed', failureStage: 'provider-validation' });
    assert.equal(response.requestPolicy.browser.errorCode, 'upstream_changed');
  });
});

test('partial verified pages remain limited and preserve transport failure instead of resetting policy', async () => {
  const f = fixture();
  f.provider.runBrowserWorks = async () => { f.setNow(Date.parse(END)); return { items: [item({ partial: true })] }; };
  const response = await f.provider.collectWorksOnly(target(), anchor());
  assert.equal(response.result.posts.length, 1); assert.equal(response.result.errorCode, 'blocked');
  assert.equal(response.result.worksCoverage, 'limited'); assert.equal(response.requestPolicy.browser.errorCode, 'blocked');
});

test('zero returned works never claim full inventory coverage', async () => {
  const f = fixture(); f.provider.runBrowserWorks = async () => ({ items: [item({ empty: true })] }); f.setNow(Date.parse(END));
  const response = await f.provider.collectWorksOnly(target(), anchor());
  assert.equal(response.result.posts.length, 0); assert.equal(response.result.worksCoverage, 'limited');
});

test('fixed error projection strips exception text and all untrusted envelope extras', async () => {
  for (const code of ['blocked', 'rate_limited', 'login_required', 'network_error', 'collector_error', 'upstream_changed', 'SECRET_UNKNOWN']) {
    const f = fixture();
    f.provider.runBrowserWorks = async () => ({ items: [{ key: '7', status: 'unavailable', posts: [], errorCode: code, error: 'SECRET' }], cookie: 'SECRET' });
    const result = await f.provider.collectWorksOnly(target(), anchor());
    assert.equal(result.result.errorCode, code === 'SECRET_UNKNOWN' ? 'collector_error' : code);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
  }
  const f = fixture(); f.provider.runBrowserWorks = async () => { throw new Error('SECRET'); };
  assert.equal((await f.provider.collectWorksOnly(target(), anchor())).result.errorCode, 'collector_error');
});

test('cancellation before and after execution never produces a successful observation', async () => {
  const controller = new AbortController(); const f = fixture({ signal: controller.signal }); controller.abort();
  await assert.rejects(f.provider.collectWorksOnly(target(), anchor()), { name: 'AbortError' }); assert.equal(f.calls(), 0);
  const second = new AbortController(), g = fixture({ signal: second.signal });
  g.provider.runBrowserWorks = async () => { second.abort(); return { items: [item()] }; };
  await assert.rejects(g.provider.collectWorksOnly(target(), anchor()), { name: 'AbortError' });
});

test('elapsed request beyond 45 seconds cannot be relabelled as usable evidence', async () => {
  const f = fixture(); f.provider.runBrowserWorks = async () => { f.setNow(Date.parse(START) + 45_001); return { items: [item()] }; };
  await assert.rejects(f.provider.collectWorksOnly(target(), anchor()), { code: 'WORKS_ONLY_TIME_INVALID', attempted: true });
});

test('browser wrapper receives works-only deadline and signal while legacy default stays 150 seconds', async () => {
  const signal = new AbortController().signal; const seen = [];
  const provider = new PublicWebProvider({}, { signal, execFileImpl: (_file, _args, options, done) => {
    seen.push({ timeout: options.timeout, signal: options.signal }); done(null, '{"ok":true,"data":{"items":[]}}', '');
  } });
  await provider.runBrowserWorks({ key: '7', secUid: SEC, limit: 30 }, { timeoutMs: 45_000, signal });
  await provider.runBrowserWorks({ key: '7', secUid: SEC, limit: 30 });
  assert.deepEqual(seen, [{ timeout: 45_000, signal }, { timeout: 150_000, signal }]);
});

test('accepted projection removes headers, raw errors, signed URLs and unrecognized fields', async () => {
  const f = fixture(), value = item();
  value.error = 'SECRET'; value.headers = { cookie: 'SECRET' }; value.posts[0].signedUrl = 'SECRET';
  value.posts[0].author.token = 'SECRET'; value.posts[0].statistics.session = 'SECRET';
  value.pagination.pages[0].headers = { Authorization: 'SECRET' };
  f.provider.runBrowserWorks = async () => { f.setNow(Date.parse(END)); return { items: [value], cookie: 'SECRET' }; };
  const result = await f.provider.collectWorksOnly(target(), anchor());
  assert.equal(result.result.status, 'ok'); assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('response identity remains bound to the actual request even if caller objects change in flight', async () => {
  const f = fixture(), tr = target(), a = anchor();
  f.provider.runBrowserWorks = async () => {
    f.setNow(Date.parse(END)); tr.id = 8; a.secUid += 'Other'; a.uid = '99999';
    const wrong = item(); wrong.key = '8'; wrong.posts[0].author = { sec_uid: a.secUid, uid: a.uid };
    return { items: [wrong] };
  };
  assert.equal((await f.provider.collectWorksOnly(tr, a)).result.errorCode, 'upstream_changed');
});

test('new instances restore only bounded persisted works-only waits without requiring the new ledger', async t => {
  for (const source of ['run', 'ledger']) await t.test(source, () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE targets(id INTEGER,type TEXT,provider TEXT);
        CREATE TABLE snapshots(id INTEGER,target_id INTEGER,raw_json TEXT,captured_at TEXT);
        CREATE TABLE runs(id INTEGER PRIMARY KEY,trigger_type TEXT,details_json TEXT);`);
      const f = fixture(); const browser = f.provider.worksRequestPolicy.record('authorised-browser', { targetKey: SEC, errorCode: 'login_required' });
      const policy = { version: 1, endpoint: 'douyin.author_posts', scope: 'endpoint-transport', browser };
      if (source === 'run') db.prepare('INSERT INTO runs VALUES(?,?,?)').run(1, 'works-only', JSON.stringify([{ requestPolicy: policy }]));
      else {
        db.exec('CREATE TABLE works_observations(id INTEGER PRIMARY KEY,raw_json TEXT)');
        db.prepare('INSERT INTO works_observations VALUES(?,?)').run(1, JSON.stringify({ worksRequestPolicy: policy }));
      }
      const restored = new PublicWebProvider({}, { database: { db }, worksRequestPolicyOptions: { now: () => Date.parse(START) } });
      assert.equal(restored.worksRequestPolicy.decision('authorised-browser').deferred, true);
      assert.equal(restored.worksRequestPolicy.decision('authorised-browser').errorCode, 'login_required');
      assert.equal(restored.worksRequestPolicy.decision('anonymous-http').deferred, false);
      const expired = new PublicWebProvider({}, { database: { db }, worksRequestPolicyOptions: { now: () => Date.parse(START) + 900_001 } });
      assert.equal(expired.worksRequestPolicy.decision('authorised-browser').deferred, false);
      if (source === 'run') {
        const insert = db.prepare('INSERT INTO runs VALUES(?,?,?)');
        for (let id = 2; id <= 1001; id++) insert.run(id, 'works-only', '[]');
      } else {
        const insert = db.prepare('INSERT INTO works_observations VALUES(?,?)');
        for (let id = 2; id <= 1001; id++) insert.run(id, '{}');
      }
      const bounded = new PublicWebProvider({}, { database: { db }, worksRequestPolicyOptions: { now: () => Date.parse(START) } });
      assert.equal(bounded.worksRequestPolicy.decision('authorised-browser').deferred, false);
    } finally { db.close(); }
  });
});

test('an existing provider merges newly persisted profile cooldown without erasing in-memory failures', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE targets(id INTEGER,type TEXT,provider TEXT);
      CREATE TABLE snapshots(id INTEGER,target_id INTEGER,raw_json TEXT,captured_at TEXT);
      CREATE TABLE runs(id INTEGER PRIMARY KEY,trigger_type TEXT,details_json TEXT);`);
    const provider = new PublicWebProvider({}, { database: { db }, worksRequestPolicyOptions: { now: () => Date.parse(START) } });
    provider.worksRequestPolicy.record('authorised-browser', { targetKey: 'earlier', errorCode: 'blocked' });
    const failures = structuredClone(provider.worksRequestPolicy.lane('authorised-browser').failures);
    const f = fixture(); const browser = f.provider.worksRequestPolicy.record('authorised-browser', { targetKey: SEC, errorCode: 'rate_limited' });
    const policy = { version: 1, endpoint: 'douyin.author_posts', scope: 'endpoint-transport', browser };
    db.prepare('INSERT INTO targets VALUES(?,?,?)').run(7, 'account', 'public-web');
    db.prepare('INSERT INTO snapshots VALUES(?,?,?,?)').run(1, 7, JSON.stringify({ worksRequestPolicy: policy }), START);
    assert.equal(provider.worksRequestPolicy.decision('authorised-browser').deferred, false);
    provider.restoreWorksRequestPolicy();
    assert.equal(provider.worksRequestPolicy.decision('authorised-browser').deferred, true);
    assert.equal(provider.worksRequestPolicy.decision('authorised-browser').nextEligibleAt, browser.nextEligibleAt);
    assert.deepEqual(provider.worksRequestPolicy.lane('authorised-browser').failures, failures);
  } finally { db.close(); }
});
