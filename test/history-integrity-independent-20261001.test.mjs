import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection, normalizePost } from '../lib/providers/normalize.mjs';
import { persistPosts } from '../lib/post-persistence.mjs';
import { checksum } from '../lib/utils.mjs';
import { getAccountInsight, getProductInsights } from '../lib/product-insights.mjs';
import { readWorksOnlyAnchor, recordWorksOnlyObservation } from '../lib/works-only-observation.mjs';
import { loadVerifiedWorksOnlyRows } from '../lib/works-observation.mjs';

const SEC = 'MS4wLjABAAAAIndependentHistoryIntegrity1234';
const OTHER = 'MS4wLjABAAAAIndependentOtherAuthor123456';
const UID = '123456789';
const ID = '7200000000000000001';
const CREATED = '2026-09-27T00:00:00.000Z';
const EARLY = '2026-09-28T03:00:00.000Z';
const LATE = '2026-09-29T03:00:00.000Z';
const options = { period: 'day', timeZone: 'Asia/Shanghai', startDate: '2026-09-28',
  endDate: '2026-09-28', reference: new Date('2026-09-30T12:00:00.000Z'), includeRecordedWindow: false };

function fixture(t) {
  const database = new MonitorDatabase(':memory:');
  t.after(() => database.close());
  const target = database.createTarget({ type: 'account', label: 'independent-history-review',
    provider: 'public-web', locator: SEC, metadata: { platform: 'douyin' } });
  database.db.prepare('UPDATE targets SET created_at=?,updated_at=? WHERE id=?').run(CREATED, CREATED, target.id);
  return { database, target };
}

for (const [name, mutation] of [
  ['a different profile and work author', raw => { raw.profile.user.sec_uid = OTHER; raw.works.aweme_list[0].author.sec_uid = OTHER; }],
  ['a raw capture time after the historical boundary', raw => { raw.capturedAt = LATE; }],
  ['a metric vector different from the selected post observation', raw => { raw.works.aweme_list[0].statistics.digg_count = 999; }],
]) test(`history integrity: recovery rejects ${name}`, t => {
  const { database, target } = fixture(t);
  const post = { externalId: ID, authorId: SEC, caption: 'known earlier title', publishedAt: '2026-09-28T02:00:00.000Z', likes: 10 };
  persistPosts(database.db, { target, posts: [post], capturedAt: EARLY });
  persistPosts(database.db, { target, posts: [{ ...post, caption: 'later mutable title', likes: 99 }], capturedAt: LATE });
  const raw = { capturedAt: EARLY, profile: { user: { sec_uid: SEC, uid: UID } }, works: { aweme_list: [{
    aweme_id: ID, author: { sec_uid: SEC, uid: UID }, desc: 'unbound historical title',
    create_time: Date.parse(post.publishedAt) / 1000, statistics: { digg_count: 10 },
  }] } };
  mutation(raw);
  database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,quality_status,source_checksum,raw_json)
    VALUES(?,?,'validated',?,?)`).run(target.id, EARLY, checksum(raw), JSON.stringify(raw));
  const work = getAccountInsight(database, target.id, options).recentWorks[0];
  assert.equal(work.likes, 10, 'selected historical metrics stay intact');
  assert.equal(work.caption, null, 'rehashing raw evidence does not prove identity, time or metric binding');
  assert.equal(work.publishedAt, null);
});

test('history integrity: metadata survives when its genuine works-only window is older than the latest two accepted windows', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-28T00:00:00.000Z') });
  const { database, target } = fixture(t);
  const anchorAt = '2026-09-28T00:00:00.000Z';
  const raw = { capturedAt: anchorAt, accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: SEC, uid: UID, follower_count: 12, total_favorited: 33, aweme_count: 3 } },
    worksCoverage: 'unavailable', worksErrorCode: 'deferred', works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
      profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/', accountLocator: 'sec_uid',
      cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  database.saveCollection(target, null, normalizeCollection(target, raw, { capturedAt: anchorAt }));
  const anchor = readWorksOnlyAnchor(database.db, target.id);
  const originals = [];
  for (let index = 1; index <= 3; index++) {
    const start = `2026-09-28T00:0${index}:00.000Z`;
    const page = `2026-09-28T00:0${index}:01.000Z`;
    const end = `2026-09-28T00:0${index}:02.000Z`;
    const post = { aweme_id: String(7200000000000000000n + BigInt(index)),
      author: { sec_uid: SEC, uid: UID }, desc: `original title ${index}`,
      create_time: Date.parse(anchorAt) / 1000, statistics: { digg_count: 10 } };
    originals.push(post);
    t.mock.timers.setTime(Date.parse(start));
    const runId = database.beginRun('works-only', target.id, 1);
    t.mock.timers.setTime(Date.parse(end));
    recordWorksOnlyObservation(database.db, { targetId: target.id, runId, anchorSnapshotId: anchor.snapshotId,
      anchorChecksum: anchor.sourceChecksum, requestStartedAt: start, requestFinishedAt: end,
      result: { status: 'ok', posts: [post], hasMore: false, maxCursor: 0,
        pagination: { version: 1, maxPages: 3, requestCount: 1, collectedCount: 1, stopReason: 'end-of-list', errorCode: null,
          pages: [{ requestCursor: 0, response: { max_cursor: 0, has_more: false }, rawCount: 1, acceptedCount: 1,
            duplicateCount: 0, filteredCount: 0, truncated: false, observedAt: page }] } } }, { now: Date.now() });
    t.mock.timers.setTime(Date.parse(end) + 1);
    database.finishRun(runId, { status: 'success', successCount: 1 });
  }
  assert.equal(loadVerifiedWorksOnlyRows(database.db, '2026-09-28T15:59:59.999Z', target.id).length, 2,
    'the freshness helper deliberately bounds its accepted windows');
  const before = getAccountInsight(database, target.id, options);
  assert.equal(before.account.publishedSamples.value, 3);
  const later = normalizePost({ ...originals[0], desc: 'later title', statistics: { digg_count: 99 } });
  persistPosts(database.db, { target, posts: [later], capturedAt: LATE });
  const after = getAccountInsight(database, target.id, options);
  assert.deepEqual(after.recentWorks, before.recentWorks, 'later updates cannot remove metadata already present at the as-of date');
  assert.equal(after.account.publishedSamples.value, 3);
  assert.equal(getProductInsights(database, options).summary.publishedSamples.value, 3);
});

for (const [platform, locator, uid, externalId, wrongUid] of [
  ['bilibili', '1258976362', '1258976362', 'BV1PjY269Ece', '9876543210'],
  ['xiaohongshu', 'https://www.xiaohongshu.com/user/profile/5d8f88dc0000000001005d3a', '5d8f88dc0000000001005d3a',
    '5d8f88dc0000000001005d3b', '5d8f88dc0000000001005d3c'],
]) {
  function platformFixture(t) {
    const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
    const target = database.createTarget({ type: 'account', label: `historical-${platform}`, provider: 'public-web', locator,
      metadata: { platform } });
    database.db.prepare('UPDATE targets SET created_at=?,updated_at=? WHERE id=?').run(CREATED, CREATED, target.id);
    const append = (capturedAt, caption, likes) => {
      const raw = { capturedAt, profile: { user: { uid, follower_count: 100, total_favorited: 200, aweme_count: 1 } },
        works: { aweme_list: [{ aweme_id: externalId, author: { uid }, desc: caption,
          create_time: Date.parse('2026-09-28T02:00:00.000Z') / 1000, statistics: { digg_count: likes } }] } };
      database.saveCollection(target, null, normalizeCollection(target, raw, { capturedAt }));
    };
    return { database, target, append };
  }
  test(`history integrity: ${platform} canonical identity retains historical title and publications`, t => {
    const { database, target, append } = platformFixture(t);
    append(EARLY, 'original platform title', 10);
    const before = getAccountInsight(database, target.id, options);
    append(LATE, 'later platform title', 99);
    const after = getAccountInsight(database, target.id, options);
    assert.deepEqual(after.recentWorks, before.recentWorks);
    assert.equal(after.recentWorks[0].caption, 'original platform title');
    assert.equal(after.account.publishedSamples.value, 1);
    assert.equal(getProductInsights(database, options).summary.publishedSamples.value, 1);
  });
  test(`history integrity: ${platform} mismatched author is still rejected with an otherwise matching vector`, t => {
    const { database, target, append } = platformFixture(t);
    append(EARLY, 'original platform title', 10); append(LATE, 'later platform title', 99);
    const snapshot = database.db.prepare('SELECT id,raw_json FROM snapshots WHERE captured_at=?').get(EARLY);
    const raw = JSON.parse(snapshot.raw_json); raw.works.aweme_list[0].author.uid = wrongUid;
    database.db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=? WHERE id=?')
      .run(JSON.stringify(raw), checksum(raw), snapshot.id);
    const work = getAccountInsight(database, target.id, options).recentWorks[0];
    assert.equal(work.caption, null); assert.equal(work.publishedAt, null); assert.equal(work.likes, 10);
  });
}
