import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { checksum } from '../lib/utils.mjs';
import { exportPublicReplica, serializePublicReplica } from '../lib/public-replica-export.mjs';
import { buildUpdateSla } from '../lib/update-sla.mjs';
import { describeWorksObservation } from '../lib/works-observation.mjs';
import { readReplicaPart } from '../../mcn-public-site/lib/replica-reader.mjs';
import { publicAccountCoverage } from '../lib/public-account-coverage.mjs';
import { accountCoverage, coverageTotals, validCoverage } from '../../mcn-public-site/lib/replica-coverage.mjs';
import { preparePublicReplicaPublication } from '../lib/public-replica-sync.mjs';

// Independent offline counterexamples. These are not real platform observations
// and do not claim that a public coverage panel is already implemented.
const AS_OF = '2026-10-01T03:19:57.560Z';
const SEC = 'MS4wLjABAAAAPublicCoveragePeerSynthetic20261001';
const FOREIGN = 'MS4wLjABAAAAPublicCoverageOtherSynthetic20261001';
const PRIVATE = 'SYNTHETIC_COOKIE_MUST_NEVER_ESCAPE';
const at = day => `2026-09-${String(day).padStart(2, '0')}T02:00:00.000Z`;

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(AS_OF) + 1 });
  const database = new MonitorDatabase(':memory:');
  t.after(() => database.close());
  const target = database.createTarget({ type: 'account', label: '独立合成账号', locator: SEC,
    provider: 'public-web', metadata: { platform: 'douyin', cookie: PRIVATE } });
  const sample = (capturedAt, followers = 10, likes = 20, posts = 3, changes = {}) => {
    const raw = { capturedAt, profile: { user: { sec_uid: SEC, uid: '123456789',
      follower_count: followers, total_favorited: likes, aweme_count: posts } },
      ...changes };
    database.saveCollection(target, null, normalizeCollection(target, raw, { capturedAt }));
  };
  return { database, target, sample, read: () => exportPublicReplica(database, { asOf: AS_OF }) };
}

function observation(id, capturedAt, changes = {}) {
  return { id, target_id: id, captured_at: capturedAt, followers: 0, total_likes: 0, total_posts: 0,
    quality_status: 'validated', account_status: 'available', works_coverage: 'unavailable',
    source_checksum: `synthetic-${id}`, collectionEvidence: { auditId: id, runId: 1,
      targetId: id, provider: 'public-web', status: 'validated', sourceChecksum: `synthetic-${id}`,
      runStartedAt: '2026-09-30T16:00:00.000Z', auditAt: capturedAt, runFinishedAt: capturedAt }, ...changes };
}
const account = (id, changes = {}) => ({ id, type: 'account', provider: 'public-web', enabled: 1, ...changes });

test('peer coverage: three independent denominators retain failed/manual accounts and paused history is not current scope', () => {
  const targets = [account(1), account(2, { provider: 'manual' }), account(3), account(4, { enabled: 0 }),
    account(5, { type: 'hashtag' }), account(6, { type: 'hashtag' })];
  const rows = [observation(1, '2026-10-01T02:00:00.000Z'),
    observation(5, '2026-10-01T02:00:00.000Z', { hashtag_participants: 0, hashtag_views: 0 }),
    observation(6, '2026-10-01T02:00:00.000Z', { hashtag_participants: 7, hashtag_views: null })];
  const sla = buildUpdateSla({ targets, snapshots: rows, now: AS_OF });
  assert.equal(sla.coreAccounts.daily.total, 3);
  assert.equal(sla.coreAccounts.daily.complete, 1);
  assert.equal(sla.works.daily.total, 3);
  assert.equal(sla.works.daily.complete, 0);
  assert.deepEqual(sla.works.daily.counts, { complete: 0, limited: 0, unavailable: 1, unknown: 0, missing: 2 });
  assert.equal(sla.topics.daily.total, 2);
  assert.equal(sla.topics.daily.complete, 1);
  assert.equal(sla.status, 'incomplete');
});

test('peer coverage: empty scope is unknown rather than an invented 100 percent success', () => {
  const sla = buildUpdateSla({ targets: [], snapshots: [], now: AS_OF });
  for (const item of [sla.coreAccounts.daily, sla.works.daily, sla.topics.daily]) {
    assert.equal(item.total, 0);
    assert.equal(item.ratioPercent, null);
    assert.equal(item.status, 'unknown');
  }
});

test('peer coverage: Beijing midnight changes the daily numerator without deleting fresh or historical data', () => {
  const sampled = '2026-09-30T15:59:59.999Z';
  const before = buildUpdateSla({ targets: [account(1)], snapshots: [observation(1, sampled, {
    collectionEvidence: { ...observation(1, sampled).collectionEvidence, runStartedAt: '2026-09-30T14:00:00.000Z' },
  })], now: '2026-09-30T16:00:00.000Z' });
  assert.equal(before.businessDate, '2026-10-01');
  assert.equal(before.coreAccounts.daily.complete, 0);
  assert.equal(before.coreAccounts.fresh8h.complete, 1);
  assert.equal(before.coreAccounts.targets[0].capturedAt, sampled);
});

test('peer coverage: old complete works become unavailable after a newer failed attempt while the old sample remains explicitly carried', () => {
  const latest = { id: 2, captured_at: '2026-10-01T02:05:00.000Z', works_coverage: 'unavailable',
    list_type: null, list_count: null, entries_json: '[]', stop_reason: 'request-failed' };
  const old = { id: 1, captured_at: '2026-10-01T02:00:00.000Z', works_coverage: 'complete',
    list_type: 'array', list_count: 1, total_posts: 1, source_checksum: 'a'.repeat(64),
    entries_json: JSON.stringify([{ id: '7200000000000000000', publishedAt: '2026-09-30T02:00:00.000Z' }]) };
  const result = describeWorksObservation([latest, old], AS_OF);
  assert.equal(result.coverage, 'unavailable');
  assert.equal(result.carriedForward, true);
  assert.equal(result.observedAt, old.captured_at);
  assert.equal(result.lastAttemptAt, latest.captured_at);
  assert.equal(result.sampleCount, 1);
  assert.equal(result.sourceChecksum, old.source_checksum);
});

test('peer coverage: stored complete label is downgraded when returned work count contradicts same-observation inventory', () => {
  const value = describeWorksObservation([{ id: 1, captured_at: '2026-10-01T02:00:00.000Z',
    works_coverage: 'complete', list_type: 'array', list_count: 1, total_posts: 500,
    source_checksum: 'a'.repeat(64), entries_json: JSON.stringify([{ id: '7200000000000000000' }]),
  }], AS_OF);
  assert.equal(value.coverage, 'limited');
  assert.equal(value.integrity.key, 'partial-inventory');
  assert.equal(value.sampleCount, 1);
  assert.equal(value.integrity.inventory, 500);
});

test('peer public history: disjoint partial counters retain their own source times and cannot masquerade as one simultaneous profile observation', t => {
  const { sample, read } = fixture(t);
  sample(at(28), 0, 7, null);
  sample('2026-09-28T03:00:00.000Z', null, null, 0);
  const account = read().catalog.accounts[0];
  assert.equal(account.latest.followers.value, 0);
  assert.equal(account.latest.followers.observedAt, at(28));
  assert.equal(account.latest.posts.value, 0);
  assert.equal(account.latest.posts.observedAt, '2026-09-28T03:00:00.000Z');
  assert.notEqual(account.latest.followers.sourceChecksum, account.latest.posts.sourceChecksum);
  assert.ok(Date.parse(account.latest.followers.observedAt) < Date.parse(AS_OF) - 8 * 3600_000);
});

test('peer public history: exactly hashed foreign author profile cannot authorize this catalog identity', t => {
  const { database, target, read } = fixture(t);
  const raw = { capturedAt: at(29), profile: { user: { sec_uid: FOREIGN, uid: '123456789',
    follower_count: 1, total_favorited: 2, aweme_count: 3 } } };
  database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,
    quality_status,account_status,works_coverage,source_checksum,raw_json)
    VALUES(?,?,1,2,3,'validated','available','unavailable',?,?)`).run(target.id, at(29), checksum(raw), JSON.stringify(raw));
  const result = read();
  assert.equal(result.counts.daily, 0);
  assert.equal(result.counts.excludedAccountSnapshots, 1);
  assert.equal(result.catalog.accounts[0].latest.followers.value, null);
});

test('peer public history: honest source hash alone cannot authorize a tampered saved metric vector', t => {
  const { database, target, sample, read } = fixture(t);
  sample(at(28), 1, 2, 3);
  database.db.prepare('UPDATE snapshots SET total_likes=999999 WHERE target_id=?').run(target.id);
  const result = read();
  assert.equal(result.counts.daily, 0);
  assert.equal(result.catalog.accounts[0].latest.likes.value, null);
  assert.equal(result.counts.excludedAccountSnapshots, 1);
});

test('peer public history: old and paused data remain complete saved history with gaps, real zero and negative deltas', t => {
  const { database, target, sample, read } = fixture(t);
  sample(at(1), 5, 20, 3);
  sample(at(2), 0, 15, 2);
  sample(at(8), 0, 0, 0);
  sample('2026-10-02T02:00:00.000Z', 9999, 9999, 9999);
  database.db.prepare('UPDATE targets SET enabled=0 WHERE id=?').run(target.id);
  const result = read(), daily = result.partitions.find(x => x.kind === 'daily').items;
  assert.equal(result.counts.enabledAccounts, 0);
  assert.equal(result.counts.accounts, 1);
  assert.deepEqual(daily.map(x => x.date), ['2026-09-01', '2026-09-02', '2026-09-08']);
  assert.equal(daily[1].followersDelta, -5);
  assert.equal(daily[1].likesDelta, -5);
  assert.equal(daily[1].estimatedPlaysDelta, -500);
  assert.equal(daily[2].followers, 0);
  assert.equal(daily[2].followersDelta, null);
  assert.equal(result.catalog.accounts[0].latest.followers.observedAt, at(8));
  assert.equal(result.policy.missingDatesFilled, false);
});

test('peer public history: exported read receipt is immutable, deterministic and does not expose raw/private source fields', t => {
  const { database, sample, read } = fixture(t);
  sample(at(29), 0, 0, 0, { cookie: PRIVATE, access_token: PRIVATE });
  const before = database.db.prepare('SELECT total_changes() n').get().n;
  const result = read(), serialized = serializePublicReplica(result);
  assert.equal(database.db.prepare('SELECT total_changes() n').get().n, before);
  assert.ok(Object.isFrozen(result.catalog.accounts[0]));
  assert.deepEqual(serializePublicReplica(result), serialized);
  const encoded = JSON.stringify(serialized);
  for (const token of [PRIVATE, SEC, 'raw_json', 'access_token', '"locator"']) assert.equal(encoded.includes(token), false);
});

test('peer public reader: matching bytes and response hash still cannot authorize a different account in a sealed history partition', async () => {
  const oldCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  try {
    const payload = JSON.stringify({ version: 1, asOf: AS_OF, timeZone: 'Asia/Shanghai', items: [{ id: 1, targetId: 2, date: '2026-09-29' }] });
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const fetcher = async () => new Response(payload, { headers: { 'X-Data-SHA256': sha256, 'X-Data-Cutoff': AS_OF } });
    await assert.rejects(readReplicaPart({ generation: AS_OF, part: 'daily/1.json',
      meta: { path: 'daily/1.json', kind: 'daily', targetId: 1, count: 1, bytes: Buffer.byteLength(payload), sha256 }, fetcher }), /归属/);
  } finally { Object.defineProperty(globalThis, 'crypto', { value: oldCrypto, configurable: true }); }
});

function trackedSample(t, fixture, capturedAt, { followers = 1, likes = 2, posts = 3, works = null } = {}) {
  const { database, target } = fixture;
  const raw = { capturedAt, profile: { user: { sec_uid: SEC, uid: '123456789',
    follower_count: followers, total_favorited: likes, aweme_count: posts } } };
  if (works) Object.assign(raw, works);
  t.mock.timers.setTime(Date.parse(capturedAt) - 1000);
  const runId = database.beginRun('scheduled', target.id, 1);
  t.mock.timers.setTime(Date.parse(capturedAt) + 4000);
  database.saveCollection(target, runId, normalizeCollection(target, raw, { capturedAt }));
  t.mock.timers.setTime(Date.parse(capturedAt) + 5000);
  database.finishRun(runId, { status: 'success', successCount: 1 });
  t.mock.timers.setTime(Date.parse(AS_OF) + 1);
  return raw;
}
function coverage(fixture) {
  const replica = fixture.read();
  return publicAccountCoverage(fixture.database.db, fixture.target, { asOf: AS_OF,
    verifiedDaily: replica.partitions.find(x => x.kind === 'daily')?.items ?? [],
    verifiedWorks: replica.partitions.find(x => x.kind === 'works')?.items ?? [] });
}
function browserWorks(capturedAt, listLength, inventory = listLength) {
  const observedAt = new Date(Date.parse(capturedAt) + 2000).toISOString();
  const list = Array.from({ length: listLength }, (_, i) => ({ aweme_id: String(7200000000000000000n + BigInt(i)),
    author: { sec_uid: SEC, uid: '123456789' }, create_time: Date.parse(at(1)) / 1000,
    statistics: { digg_count: 0 } }));
  return { worksCoverage: 'complete', profile: { user: { sec_uid: SEC, uid: '123456789',
    follower_count: 1, total_favorited: 2, aweme_count: inventory } },
    provenance: { worksFallback: { mode: 'douyin-authorised-browser-post-response', runtimeAI: false,
      paidAPI: false, noChallengeBypass: true } },
    works: { observationVersion: 1, observedAt, sourceRequestStartedAt: new Date(Date.parse(capturedAt) + 1000).toISOString(),
      sourceRequestFinishedAt: new Date(Date.parse(capturedAt) + 3000).toISOString(),
      aweme_list: list, has_more: false, max_cursor: 0,
      pagination: { version: 1, maxPages: 1, requestedLimit: 30, requestCount: 1, collectedCount: list.length,
        stopReason: 'end-of-list', errorCode: null, evidenceScope: 'browser-response-sanitized',
        pages: [{ endpoint: 'https://www.douyin.com/aweme/v1/web/aweme/post/', requestCursor: 0,
          response: { source: 'authorised-browser', has_more: false, max_cursor: 0 }, rawCount: list.length,
          acceptedCount: list.length, duplicateCount: 0, filteredCount: 0, truncated: false, observedAt }] } } };
}

test('peer coverage helper: a same-vector same-source finished profile run produces its actual timestamp, never export time', t => {
  const f = fixture(t); trackedSample(t, f, at(29), { followers: 0, likes: 0, posts: 0 });
  const result = coverage(f);
  assert.equal(result.profileObservedAt, at(29));
  assert.notEqual(result.profileObservedAt, AS_OF);
  assert.equal(result.works.status, 'unavailable');
  assert.deepEqual(Object.keys(result), ['version', 'profileObservedAt', 'works']);
  assert.deepEqual(Object.keys(result.works), ['status', 'attemptedAt', 'observedAt']);
  for (const secret of [SEC, PRIVATE, 'raw_json', 'locator']) assert.equal(JSON.stringify(result).includes(secret), false);
});

test('peer coverage helper: imported/null-run or manually supplied complete flag is not automatic observation proof', t => {
  const f = fixture(t); f.sample(at(29), 1, 2, 3);
  assert.deepEqual(coverage(f), { version: 1, profileObservedAt: null,
    works: { status: 'missing', attemptedAt: null, observedAt: null } });
  const marked = { ...f.target, provider: 'manual' };
  assert.equal(publicAccountCoverage(f.database.db, marked, { asOf: AS_OF }).profileObservedAt, null);
});

test('peer coverage helper: partial profile fields cannot be stitched into a synthetic simultaneous three-metric sample', t => {
  const f = fixture(t);
  trackedSample(t, f, at(29), { followers: 1, likes: 2, posts: null });
  trackedSample(t, f, '2026-09-29T03:00:00.000Z', { followers: null, likes: null, posts: 3 });
  assert.equal(f.read().catalog.accounts[0].latest.posts.value, 3);
  assert.equal(coverage(f).profileObservedAt, null);
});

test('peer coverage helper: browser end-of-list plus exactly matched inventory supports current complete, with real later works time', t => {
  const f = fixture(t); trackedSample(t, f, at(29), { posts: 2, works: browserWorks(at(29), 2) });
  const result = coverage(f);
  assert.equal(result.works.status, 'complete');
  assert.equal(result.works.observedAt, '2026-09-29T02:00:02.000Z');
  assert.equal(result.works.attemptedAt, '2026-09-29T02:00:03.000Z');
  assert.equal(result.profileObservedAt, at(29));
});

test('peer coverage helper: contradictory inventory, raw metric tampering, or foreign work author cannot advertise complete', t => {
  const f = fixture(t); trackedSample(t, f, at(29), { posts: 99, works: browserWorks(at(29), 1, 99) });
  assert.equal(coverage(f).works.status, 'limited');
  f.database.db.prepare('UPDATE snapshots SET followers=999999 WHERE target_id=?').run(f.target.id);
  assert.equal(coverage(f).profileObservedAt, null);
  assert.equal(coverage(f).works.status, 'missing');
});

test('peer coverage helper: newer valid profile with unavailable works never carries old complete forward', t => {
  const f = fixture(t); trackedSample(t, f, at(28), { posts: 1, works: browserWorks(at(28), 1) });
  trackedSample(t, f, at(29), { posts: 1 });
  const result = coverage(f);
  assert.equal(result.profileObservedAt, at(29));
  assert.equal(result.works.status, 'unavailable');
  assert.equal(result.works.attemptedAt, at(29));
  assert.equal(result.works.observedAt, '2026-09-28T02:00:02.000Z');
});

test('peer coverage helper: witnessed Bilibili BV samples stay limited rather than being discarded or mislabeled complete', t => {
  const f = fixture(t);
  f.database.db.prepare('UPDATE targets SET locator=?,metadata_json=? WHERE id=?')
    .run('123456789', JSON.stringify({ platform: 'bilibili' }), f.target.id);
  f.target = f.database.db.prepare('SELECT * FROM targets WHERE id=?').get(f.target.id);
  const capturedAt = at(29), raw = { capturedAt, profile: { user: { uid: '123456789',
    follower_count: 1, total_favorited: 2, aweme_count: 20 } }, worksCoverage: 'limited',
    works: { aweme_list: [{ aweme_id: 'BV1AbCdEfG12', author: { uid: '123456789' },
      statistics: { digg_count: 0 }, create_time: Date.parse(at(1)) / 1000 }] } };
  t.mock.timers.setTime(Date.parse(capturedAt) - 1000);
  const run = f.database.beginRun('scheduled', f.target.id, 1);
  t.mock.timers.setTime(Date.parse(capturedAt) + 1000);
  f.database.saveCollection(f.target, run, normalizeCollection(f.target, raw, { capturedAt }));
  t.mock.timers.setTime(Date.parse(capturedAt) + 2000);
  f.database.finishRun(run, { status: 'success', successCount: 1 });
  t.mock.timers.setTime(Date.parse(AS_OF) + 1);
  const result = coverage(f);
  assert.equal(result.profileObservedAt, capturedAt);
  assert.equal(result.works.status, 'limited');
  assert.equal(result.works.observedAt, capturedAt);
});

test('peer coverage helper: a correctly rehashed foreign work author never authorizes complete pagination', t => {
  const f = fixture(t); trackedSample(t, f, at(29), { posts: 1, works: browserWorks(at(29), 1) });
  const row = f.database.db.prepare('SELECT id,raw_json FROM snapshots WHERE target_id=?').get(f.target.id);
  const raw = JSON.parse(row.raw_json); raw.works.aweme_list[0].author.sec_uid = FOREIGN;
  const sourceHash = checksum(raw);
  f.database.db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=? WHERE id=?').run(JSON.stringify(raw), sourceHash, row.id);
  f.database.db.prepare('UPDATE audits SET source_checksum=? WHERE target_id=?').run(sourceHash, f.target.id);
  const result = coverage(f);
  assert.equal(result.profileObservedAt, at(29));
  assert.equal(result.works.status, 'unavailable');
  assert.equal(result.works.observedAt, null);
});

test('peer Site coverage: the same sealed generation ages out after eight hours, without modifying publication-time facts', () => {
  const c = { version: 1, profileObservedAt: '2026-10-01T02:00:00.000Z',
    works: { status: 'complete', attemptedAt: '2026-10-01T02:00:01.000Z', observedAt: '2026-10-01T02:00:00.000Z' } };
  const item = { id: 1, enabled: true, coverage: c };
  const published = accountCoverage(item, AS_OF, Date.parse(AS_OF));
  const later = accountCoverage(item, AS_OF, Date.parse('2026-10-01T10:00:00.001Z'));
  assert.equal(published.profileFresh, true); assert.equal(published.worksComplete, true);
  assert.equal(later.profileFresh, false); assert.equal(later.worksComplete, false);
  assert.equal(later.works.status, 'complete');
  assert.equal(later.profileObservedAt, c.profileObservedAt);
});

test('peer Site coverage: an old catalog lacking work evidence stays unknown, never inferred complete from profile success', () => {
  const vector = { value: 0, observedAt: '2026-10-01T02:00:00.000Z', sourceChecksum: 'a'.repeat(64) };
  const item = { id: 1, enabled: true, latest: { followers: vector, likes: vector, posts: vector } };
  const value = accountCoverage(item, AS_OF, Date.parse(AS_OF));
  assert.equal(value.profileFresh, true); assert.equal(value.works.status, 'unknown');
  assert.equal(value.worksComplete, false);
});

test('peer Site coverage: partial or wrong-identity topic counter pairs cannot advertise topic success', () => {
  const topics = { topics: [{ id: 2, enabled: true }, { id: 3, enabled: true }], items: [
    { targetId: 2, capturedAt: '2026-10-01T02:00:00.000Z', participants: 0, views: null,
      sourceChecksum: 'a'.repeat(64), metricsEvidence: 'topic-identity-source-run-time-vector-bound', qualityStatus: 'validated' },
    { targetId: 3, capturedAt: '2026-10-01T02:00:00.000Z', participants: 0, views: 0,
      sourceChecksum: 'b'.repeat(64), metricsEvidence: 'saved-unverified-closing-observation', qualityStatus: 'unverified' },
  ] };
  const totals = coverageTotals([], topics, AS_OF, Date.parse(AS_OF));
  assert.equal(totals.topicDenominator, 2); assert.equal(totals.topicsFresh, 0);
  assert.equal(totals.worksComplete, 0);
});

test('peer Site coverage: future times and extra secret-bearing keys fail closed', () => {
  const good = { version: 1, profileObservedAt: null,
    works: { status: 'missing', attemptedAt: null, observedAt: null } };
  assert.equal(validCoverage(good, AS_OF), true);
  for (const invalid of [{ ...good, cookie: PRIVATE }, { ...good, profileObservedAt: '2026-10-02T00:00:00.000Z' },
    { ...good, works: { ...good.works, locator: SEC } }, { ...good, works: { status: 'complete', attemptedAt: null, observedAt: null } }]) {
    assert.equal(validCoverage(invalid, AS_OF), false);
    assert.throws(() => accountCoverage({ coverage: invalid }, AS_OF), /覆盖证据/);
  }
});

test('peer sync: a correctly hashed optional coverage containing private extra fields is rejected by real prepare before networking', async t => {
  const f = fixture(t); trackedSample(t, f, at(29));
  const serialized = serializePublicReplica(f.read());
  const catalog = serialized.files.find(x => x.path === 'catalog.json');
  const parsed = JSON.parse(catalog.content);
  parsed.accounts[0].coverage = { version: 1, profileObservedAt: null,
    works: { status: 'missing', attemptedAt: null, observedAt: null }, cookie: PRIVATE };
  catalog.content = JSON.stringify(parsed) + '\n';
  catalog.bytes = Buffer.byteLength(catalog.content);
  catalog.sha256 = createHash('sha256').update(catalog.content).digest('hex');
  Object.assign(serialized.manifest.files.find(x => x.path === catalog.path), { bytes: catalog.bytes, sha256: catalog.sha256 });
  let calls = 0; const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('network must not run'); };
  try { await assert.rejects(preparePublicReplicaPublication(serialized)); assert.equal(calls, 0); }
  finally { globalThis.fetch = oldFetch; }
});

test('peer sync: non-secret extra coverage fields, unknown status and future observation also fail before networking', async t => {
  const f = fixture(t); trackedSample(t, f, at(29));
  const good = { version: 1, profileObservedAt: null,
    works: { status: 'missing', attemptedAt: null, observedAt: null } };
  const variants = [{ ...good, misleadingSuccess: true },
    { ...good, profileObservedAt: '2026-10-02T00:00:00.000Z' },
    { ...good, works: { ...good.works, status: 'fully-verified' } },
    { ...good, works: { ...good.works, secretFreeButUndeclared: 1 } }];
  let calls = 0; const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('network must not run'); };
  try {
    for (const invalid of variants) {
      const serialized = serializePublicReplica(f.read()), catalog = serialized.files.find(x => x.path === 'catalog.json');
      const parsed = JSON.parse(catalog.content); parsed.accounts[0].coverage = invalid;
      catalog.content = JSON.stringify(parsed) + '\n'; catalog.bytes = Buffer.byteLength(catalog.content);
      catalog.sha256 = createHash('sha256').update(catalog.content).digest('hex');
      Object.assign(serialized.manifest.files.find(x => x.path === catalog.path), { bytes: catalog.bytes, sha256: catalog.sha256 });
      await assert.rejects(preparePublicReplicaPublication(serialized));
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = oldFetch; }
});
