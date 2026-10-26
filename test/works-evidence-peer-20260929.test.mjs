import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { MonitorDatabase } from '../lib/database.mjs';
import { BrowserWorksPagination } from '../lib/browser-works-pagination.mjs';
import { normalizeBrowserWorks } from '../scripts/douyin_browser_collector.mjs';
import { isOfficialMixedProfileEnvelope } from '../lib/official-profile-evidence.mjs';
import { loadWorksObservations } from '../lib/works-observation.mjs';
import { accountCollectionCoverage } from '../lib/collection-coverage.mjs';

const SEC = 'MS4wLjABAAAAWorksEvidencePeerAccount123456';
const UID = '101115710974';
const PROFILE_AT = '2026-09-27T15:59:59.900Z';
const WORK_AT = '2026-09-27T16:00:01.000Z';
const PUBLISHED_AT = '2026-09-27T16:00:00.000Z';
const provenance = { mode: 'douyin-authorised-browser-post-response', sessionLoaded: true,
  authorisedSessionUsed: true, authenticated: null, authenticationStatus: 'not-verified', paidAPI: false, runtimeAI: false, noChallengeBypass: true };
const work = (uid = UID) => ({ aweme_id: '7000000000000000001', author: { sec_uid: SEC, uid },
  create_time: Date.parse(PUBLISHED_AT) / 1000, statistics: { digg_count: 8 } });
function upstream() {
  return { capturedAt: PROFILE_AT, accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: SEC, uid: UID, nickname: 'offline', follower_count: 12, total_favorited: 33, aweme_count: 2 } },
    worksCoverage: 'unavailable', worksErrorCode: 'deferred', works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
      profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/',
      accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
}
function browserItem(uid = UID) {
  const body = { status_code: 0, aweme_list: [work(uid)], has_more: false, max_cursor: 0 };
  const ledger = new BrowserWorksPagination({ limit: 30 });
  ledger.accept({ requestCursor: 0, body, normalized: normalizeBrowserWorks(body, SEC, 30), observedAt: WORK_AT });
  const result = ledger.result(1);
  return { key: '1', status: 'ok', posts: result.posts, hasMore: result.hasMore,
    maxCursor: result.maxCursor, worksCoverage: result.coverage, pagination: result.pagination };
}
async function collect(item = browserItem()) {
  const provider = new PublicWebProvider({ publicPostsPerAccount: 30 }, { accountBrowserFallback: true,
    now: () => Date.parse(WORK_AT),
    worksRequestPolicyOptions: { now: () => Date.parse(WORK_AT) },
    fetchImpl: () => { throw new Error('External requests forbidden'); },
    execFileImpl: () => { throw new Error('Subprocesses forbidden'); } });
  for (const targetKey of ['one', 'two', 'three']) provider.worksRequestPolicy.record('anonymous-http', { targetKey, errorCode: 'blocked' });
  provider.run = async operation => { assert.equal(operation, 'account'); return upstream(); };
  provider.runBrowserWorks = async () => ({ items: [item], provenance });
  const target = { id: 1, type: 'account', provider: 'public-web', label: '离线作品审查', locator: SEC, metadata: {} };
  return { collection: await provider.collect(target), target };
}
async function saved(t) {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.db.close());
  const { collection, target: input } = await collect();
  const target = database.createTarget(input);
  database.saveCollection(target, null, collection);
  return { database, target, collection };
}

test('works evidence baseline: valid page stays limited against a larger profile inventory with no platform access', async () => {
  const { collection } = await collect();
  assert.equal(collection.worksCoverage, 'limited');
  assert.equal(collection.posts.length, 1);
  assert.equal(collection.snapshot.followers, 12);
  assert.equal(collection.raw.works.pagination.pages[0].observedAt, WORK_AT);
  assert.equal(isOfficialMixedProfileEnvelope(collection.raw), true);
});

test('works evidence: browser work metrics must not be backdated to the earlier profile response', async t => {
  const { database } = await saved(t);
  assert.equal(database.db.prepare('SELECT captured_at FROM post_metrics').get().captured_at, WORK_AT);
});

test('works evidence: cross-midnight works coverage and latest publication use the actual work observation time', async t => {
  const { database, target } = await saved(t);
  const observation = loadWorksObservations(database, '2026-09-27T16:01:00.000Z', target.id).get(target.id);
  assert.equal(observation.observedAt, WORK_AT);
  assert.equal(observation.latestPublishedAt, PUBLISHED_AT, 'a real work published after the profile response is not a future/fabricated timestamp');
  assert.equal(accountCollectionCoverage({ worksObservation: observation }, '2026-09-28').worksState, 'limited');
  assert.equal(accountCollectionCoverage({ worksObservation: observation }, '2026-09-27').worksState, 'missing');
});

test('works evidence: a contradictory work UID cannot be admitted when the profile UID is known', async () => {
  const { collection } = await collect(browserItem('909090909090'));
  assert.equal(collection.posts.length, 0);
  assert.equal(collection.worksCoverage, 'unavailable');
  assert.equal(collection.snapshot.followers, 12, 'invalid work evidence must not discard the valid profile');
});

test('works evidence: new nullable column does not backfill or alter legacy snapshot evidence', async t => {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.db.close());
  const item = browserItem(); delete item.pagination;
  const { collection, target: input } = await collect(item);
  const target = database.createTarget(input);
  database.saveCollection(target, null, collection);
  const { works_observed_at, ...before } = database.db.prepare('SELECT * FROM snapshots').get();
  assert.equal(works_observed_at, null);
  database.db.exec('ALTER TABLE snapshots DROP COLUMN works_observed_at');
  database.migrate();
  const { works_observed_at: migratedTime, ...after } = database.db.prepare('SELECT * FROM snapshots').get();
  assert.equal(migratedTime, null); assert.deepEqual(after, before);
  assert.equal(loadWorksObservations(database, WORK_AT, target.id).get(target.id).observedAt, PROFILE_AT);
  assert.equal(database.db.prepare('SELECT captured_at FROM post_metrics').get().captured_at, PROFILE_AT);
});

test('works evidence: legacy response without a page ledger also rejects contradictory UID instead of inventing an empty valid window', async () => {
  const item = browserItem('909090909090'); delete item.pagination;
  const { collection } = await collect(item);
  assert.equal(collection.posts.length, 0); assert.equal(collection.worksCoverage, 'unavailable');
});
