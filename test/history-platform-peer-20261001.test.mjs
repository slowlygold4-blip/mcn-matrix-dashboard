import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { getAccountInsight, getProductInsights } from '../lib/product-insights.mjs';
import { canonicalAccountLocator } from '../lib/author-spreadsheet.mjs';
import { checksum } from '../lib/utils.mjs';
import { readWorksOnlyAnchor, recordWorksOnlyObservation } from '../lib/works-only-observation.mjs';
import { loadVerifiedWorksOnlyRows } from '../lib/works-observation.mjs';

const EARLY = '2026-09-28T03:00:00.000Z', LATE = '2026-09-29T03:00:00.000Z';
const options = { period: 'day', timeZone: 'Asia/Shanghai', startDate: '2026-09-28', endDate: '2026-09-28',
  reference: new Date('2026-09-30T12:00:00.000Z'), includeRecordedWindow: false };
const platforms = [
  { platform: 'bilibili', locator: '1809444890', uid: '1809444890', workId: 'BV1fi416bEpi', otherUid: '1809444891',
    url: 'https://www.bilibili.com/video/BV1fi416bEpi' },
  { platform: 'xiaohongshu', locator: 'https://www.xiaohongshu.com/user/profile/5caff00400000000180157d6',
    uid: '5caff00400000000180157d6', otherUid: '5caff00400000000180157d7', workId: '66f7a573000000001c025ce0',
    url: 'https://www.xiaohongshu.com/explore/66f7a573000000001c025ce0' },
];

function fixture(t, source) {
  const database = new MonitorDatabase(':memory:');
  t.after(() => database.close());
  const target = database.createTarget({ type: 'account', label: `independent-platform-history-${source.platform}`,
    provider: 'public-web', locator: source.locator, metadata: { platform: source.platform } });
  // Use the existing canonical locator parser, including the official profile
  // URL rule for Xiaohongshu; a numeric/String coercion is not identity proof.
  assert.equal(canonicalAccountLocator(target.locator, source.platform), canonicalAccountLocator(source.uid, source.platform));
  const append = (capturedAt, caption, likes) => {
    // These are the provider's normal UID-only shapes. Neither platform emits
    // Douyin sec_uid, and Xiaohongshu UID is not a decimal number.
    const raw = { capturedAt, profile: { user: { uid: source.uid, follower_count: 100, total_favorited: 200, aweme_count: 1 } },
      works: { aweme_list: [{ aweme_id: source.workId, author: { uid: source.uid }, desc: caption,
        create_time: Date.parse('2026-09-28T02:00:00.000Z') / 1000,
        statistics: { digg_count: likes, share_count: 0 }, share_url: source.url }] } };
    database.saveCollection(target, null, normalizeCollection(target, raw, { capturedAt }));
  };
  return { database, target, append };
}

for (const source of platforms) {
  test(`independent history: ${source.platform} later update preserves bound historical metadata and null/zero metrics`, t => {
    const { database, target, append } = fixture(t, source);
    append(EARLY, 'original platform caption', 10);
    const before = getAccountInsight(database, target.id, options);
    assert.equal(before.account.publishedSamples.value, 1);
    append(LATE, 'future platform caption', 99);
    const changes = database.db.prepare('SELECT total_changes() n').get().n;
    const after = getAccountInsight(database, target.id, options);
    assert.deepEqual(after.recentWorks, before.recentWorks);
    assert.equal(after.recentWorks[0].caption, 'original platform caption');
    assert.equal(after.recentWorks[0].likes, 10);
    assert.equal(after.recentWorks[0].plays, null);
    assert.equal(after.recentWorks[0].comments, null);
    assert.equal(after.recentWorks[0].shares, 0);
    assert.equal(after.account.publishedSamples.value, 1);
    assert.equal(getProductInsights(database, options).summary.publishedSamples.value, 1);
    assert.equal(database.db.prepare('SELECT total_changes() n').get().n, changes);
  });

  test(`independent history: ${source.platform} rehashed foreign UID source cannot restore metadata`, t => {
    const { database, target, append } = fixture(t, source);
    append(EARLY, 'original platform caption', 10);
    append(LATE, 'future platform caption', 99);
    const row = database.db.prepare('SELECT id,raw_json FROM snapshots WHERE captured_at=?').get(EARLY);
    const raw = JSON.parse(row.raw_json);
    raw.profile.user.uid = source.otherUid;
    raw.works.aweme_list[0].author.uid = source.otherUid;
    database.db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=? WHERE id=?').run(JSON.stringify(raw), checksum(raw), row.id);
    const work = getAccountInsight(database, target.id, options).recentWorks[0];
    assert.equal(work.caption, null);
    assert.equal(work.publishedAt, null);
    assert.equal(work.url, null);
    assert.equal(work.likes, 10);
    assert.equal(work.plays, null);
    assert.equal(work.shares, 0);
  });
}

test('independent history: explicit runIds reads old accepted runs without changing the default latest-attempt/two-window helper', t => {
  const anchorAt = '2026-09-28T00:00:00.000Z', asOf = '2026-09-28T15:59:59.999Z';
  const secUid = 'MS4wLjABAAAAIndependentRunIdsScope12345', uid = '123456789';
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(anchorAt) });
  const database = new MonitorDatabase(':memory:');
  t.after(() => database.close());
  const target = database.createTarget({ type: 'account', label: 'independent-runIds', provider: 'public-web',
    locator: secUid, metadata: { platform: 'douyin' } });
  const raw = { capturedAt: anchorAt, accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: secUid, uid, follower_count: 12, total_favorited: 33, aweme_count: 3 } },
    worksCoverage: 'unavailable', worksErrorCode: 'deferred',
    works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
      profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/', accountLocator: 'sec_uid',
      cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  database.saveCollection(target, null, normalizeCollection(target, raw, { capturedAt: anchorAt }));
  const anchor = readWorksOnlyAnchor(database.db, target.id), runIds = [];
  for (let index = 1; index <= 4; index++) {
    const start = `2026-09-28T00:0${index}:00.000Z`, page = `2026-09-28T00:0${index}:01.000Z`;
    const end = `2026-09-28T00:0${index}:02.000Z`, failed = index === 4;
    t.mock.timers.setTime(Date.parse(start));
    const runId = database.beginRun('works-only', target.id, 1);
    runIds.push(runId);
    t.mock.timers.setTime(Date.parse(end));
    const result = failed ? { status: 'unavailable', posts: [], errorCode: 'blocked' } : {
      status: 'ok', posts: [{ aweme_id: String(7200000000000000000n + BigInt(index)),
        author: { sec_uid: secUid, uid }, statistics: { digg_count: 10 } }], hasMore: false, maxCursor: 0,
      pagination: { version: 1, maxPages: 3, requestCount: 1, collectedCount: 1, stopReason: 'end-of-list', errorCode: null,
        pages: [{ requestCursor: 0, response: { max_cursor: 0, has_more: false }, rawCount: 1, acceptedCount: 1,
          duplicateCount: 0, filteredCount: 0, truncated: false, observedAt: page }] } };
    recordWorksOnlyObservation(database.db, { targetId: target.id, runId, anchorSnapshotId: anchor.snapshotId,
      anchorChecksum: anchor.sourceChecksum, requestStartedAt: start, requestFinishedAt: end, result }, { now: Date.now() });
    t.mock.timers.setTime(Date.parse(end) + 1);
    database.finishRun(runId, { status: failed ? 'error' : 'success', successCount: failed ? 0 : 1, errorCount: failed ? 1 : 0 });
  }
  const read = options => loadVerifiedWorksOnlyRows(database.db, asOf, target.id, options);
  const before = read();
  assert.deepEqual(before.map(row => row.run_id), [runIds[3], runIds[2], runIds[1]]);
  assert.equal(before[0].status, 'unavailable');
  const changes = database.db.prepare('SELECT total_changes() n').get().n;
  database.db.exec('PRAGMA query_only=ON');
  assert.deepEqual(read({ runIds: [runIds[0], runIds[0]] }).map(row => row.run_id), [runIds[0]]);
  assert.equal(read({ runIds: runIds.slice(0, 3) }).filter(row => row.status === 'accepted').length, 3);
  assert.deepEqual(read({ runIds: [] }), []);
  assert.deepEqual(read({ runIds: [runIds[0] + 1000] }), []);
  assert.throws(() => read({ runIds: [0] }), /历史采集编号无效/);
  assert.throws(() => read({ runId: runIds[0], runIds: [runIds[0]] }), /历史采集编号无效/);
  assert.deepEqual(read(), before);
  assert.equal(database.db.prepare('SELECT total_changes() n').get().n, changes);
});
