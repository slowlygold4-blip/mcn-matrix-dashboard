import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { BrowserWorksPagination } from '../lib/browser-works-pagination.mjs';
import { normalizeBrowserWorks } from '../scripts/douyin_browser_collector.mjs';
import { MonitorDatabase } from '../lib/database.mjs';
import { loadWorksObservations } from '../lib/works-observation.mjs';
import { accountCollectionCoverage } from '../lib/collection-coverage.mjs';
import { checksum } from '../lib/utils.mjs';

const SEC = 'MS4wLjABAAAAIndependentTimeFixture123456';
const UID = '100100100100';
const PROFILE = '2026-09-27T15:59:57.000Z';
const REQUEST = '2026-09-27T15:59:58.000Z';
const FIRST = '2026-09-27T15:59:59.000Z';
const LAST = '2026-09-27T16:00:02.000Z';
const FINISH = '2026-09-27T16:00:03.000Z';
const profile = () => ({ capturedAt: PROFILE, accountStatus: 'validated', accountError: null,
  profile: { user: { sec_uid: SEC, uid: UID, nickname: 'offline-independent', follower_count: 11,
    total_favorited: 22, aweme_count: 2 } }, worksCoverage: 'unavailable', worksErrorCode: 'deferred',
  works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
  provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
    profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/',
    accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } });

function browserItem({ firstAt = FIRST, lastAt = LAST, uid = UID, legacy = false } = {}) {
  const ledger = new BrowserWorksPagination({ limit: 30 });
  for (let n = 0; n < 2; n++) {
    const body = { status_code: 0, has_more: n === 0, max_cursor: n === 0 ? 100 : 0,
      aweme_list: [{ aweme_id: String(7100000000000000001n + BigInt(n)),
        author: { sec_uid: SEC, uid }, create_time: Date.parse(n ? '2026-09-27T16:00:00.000Z' : PROFILE) / 1000,
        statistics: { digg_count: n + 1 } }] };
    ledger.accept({ requestCursor: n ? 100 : 0, body, normalized: normalizeBrowserWorks(body, SEC, 30),
      observedAt: n ? lastAt : firstAt });
  }
  const r = ledger.result(2);
  return { status: 'ok', posts: r.posts, hasMore: r.hasMore, maxCursor: r.maxCursor,
    worksCoverage: r.coverage, ...(legacy ? {} : { pagination: r.pagination }) };
}

async function collect(options = {}) {
  let now = Date.parse(PROFILE);
  const provider = new PublicWebProvider({ publicPostsPerAccount: 30 }, { accountBrowserFallback: true,
    now: () => now,
    worksRequestPolicyOptions: { now: () => now },
    fetchImpl: () => { throw new Error('External requests prohibited'); },
    execFileImpl: () => { throw new Error('Subprocesses prohibited'); } });
  for (const targetKey of ['a', 'b', 'c']) provider.worksRequestPolicy.record('anonymous-http', { targetKey, errorCode: 'blocked' });
  provider.run = async operation => { assert.equal(operation, 'account'); now = Date.parse(REQUEST); return profile(); };
  provider.runBrowserWorks = async () => {
    now = Date.parse(FINISH);
    return { items: [browserItem(options)], provenance: { mode: 'douyin-authorised-browser-post-response',
      sessionLoaded: true, authorisedSessionUsed: true, authenticated: null, authenticationStatus: 'not-verified',
      paidAPI: false, runtimeAI: false, noChallengeBypass: true } };
  };
  const target = { id: 1, type: 'account', label: 'offline-time', locator: SEC, provider: 'public-web', metadata: {} };
  return { target, collection: await provider.collect(target) };
}

async function saved(t, options) {
  const database = new MonitorDatabase(':memory:');
  t.after(() => database.close());
  const { target: input, collection } = await collect(options);
  const target = database.createTarget(input);
  database.saveCollection(target, null, collection);
  return { database, target, collection };
}

test('independent: two accepted page times reach post metrics while profile time stays original', async t => {
  const { database, collection } = await saved(t);
  assert.equal(collection.capturedAt, PROFILE);
  assert.equal(database.db.prepare('SELECT captured_at FROM snapshots').get().captured_at, PROFILE);
  assert.deepEqual(database.db.prepare('SELECT captured_at FROM post_metrics ORDER BY id').all().map(x => x.captured_at), [FIRST, LAST]);
  assert.deepEqual(database.db.prepare('SELECT first_seen_at,last_seen_at FROM posts ORDER BY id').all().map(x => [x.first_seen_at, x.last_seen_at]), [[FIRST, FIRST], [LAST, LAST]]);
});

test('independent: a post-midnight full window cannot appear in a pre-midnight as-of query', async t => {
  const { database, target } = await saved(t);
  const before = loadWorksObservations(database, '2026-09-27T15:59:59.500Z', target.id).get(target.id);
  assert.ok(!before?.observedAt || before.observedAt <= '2026-09-27T15:59:59.500Z');
  assert.notEqual(before?.coverage, 'complete', 'the two-page complete window was not observed yet');
  const after = loadWorksObservations(database, FINISH, target.id).get(target.id);
  assert.equal(after.observedAt, LAST);
  assert.equal(after.latestPublishedAt, '2026-09-27T16:00:00.000Z');
  assert.equal(accountCollectionCoverage({ worksObservation: after }, '2026-09-28').worksState, 'complete');
  assert.equal(accountCollectionCoverage({ worksObservation: after }, '2026-09-27').worksState, 'missing');
});

for (const [label, options] of [
  ['future relative to collection finish', { lastAt: '2026-09-27T16:00:04.000Z' }],
  ['before profile observation', { firstAt: '2026-09-27T15:59:56.000Z' }],
  ['after profile but before browser request', { firstAt: '2026-09-27T15:59:57.500Z' }],
  ['contradictory stable UID despite matching sec_uid', { uid: '999999999999' }],
]) test(`independent: reject ${label} without losing valid profile metrics`, async () => {
  const { collection } = await collect(options);
  assert.equal(collection.worksCoverage, 'unavailable');
  assert.equal(collection.posts.length, 0);
  assert.equal(collection.snapshot.followers, 11);
});

test('independent: legacy envelopes without page observation times retain compatibility without invented provenance', async t => {
  const { database, collection } = await saved(t, { legacy: true });
  assert.equal(collection.posts.length, 2);
  assert.ok(!collection.raw.works.observationVersion);
  assert.deepEqual(database.db.prepare('SELECT DISTINCT captured_at FROM post_metrics').all().map(x => x.captured_at), [PROFILE]);
});

test('independent: database refuses future observed evidence even with a recomputed raw checksum', async t => {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const { target: input, collection } = await collect();
  const target = database.createTarget(input);
  const future = new Date(Date.now() + 60_000).toISOString();
  collection.raw.works.observationVersion = 1;
  collection.raw.works.observedAt = future;
  collection.raw.works.pagination.pages.at(-1).observedAt = future;
  collection.sourceChecksum = checksum(collection.raw);
  assert.throws(() => database.saveCollection(target, null, collection));
  for (const table of ['snapshots', 'posts', 'post_metrics']) {
    assert.equal(database.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  }
});

test('independent: partial removal of new time fields cannot downgrade a bounded response to legacy', async t => {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const { target: input, collection } = await collect();
  const target = database.createTarget(input);
  assert.ok(collection.raw.works.sourceRequestStartedAt);
  delete collection.raw.works.observationVersion;
  delete collection.raw.works.observedAt;
  collection.sourceChecksum = checksum(collection.raw);
  assert.throws(() => database.saveCollection(target, null, collection));
  assert.equal(database.db.prepare('SELECT count(*) n FROM snapshots').get().n, 0);
});

test('independent: reordering normalized posts cannot move their metrics onto another page timestamp', async t => {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const { target: input, collection } = await collect();
  const target = database.createTarget(input);
  collection.posts.reverse();
  assert.throws(() => database.saveCollection(target, null, collection));
  assert.equal(database.db.prepare('SELECT count(*) n FROM post_metrics').get().n, 0);
});

test('independent: version-one browser pages cannot lose every new marker and become legacy on save', async t => {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const { target: input, collection } = await collect();
  const target = database.createTarget(input);
  assert.equal(collection.raw.works.pagination.version, 1);
  for (const key of ['observationVersion', 'observedAt', 'sourceRequestStartedAt', 'sourceRequestFinishedAt']) delete collection.raw.works[key];
  collection.sourceChecksum = checksum(collection.raw);
  assert.throws(() => database.saveCollection(target, null, collection));
  assert.equal(database.db.prepare('SELECT count(*) n FROM snapshots').get().n, 0);
});

test('independent: normalised profile timestamp cannot diverge from the raw profile under a new works contract', async t => {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const { target: input, collection } = await collect();
  const target = database.createTarget(input);
  collection.capturedAt = LAST;
  assert.throws(() => database.saveCollection(target, null, collection));
  for (const table of ['snapshots', 'posts', 'post_metrics']) assert.equal(database.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
});
