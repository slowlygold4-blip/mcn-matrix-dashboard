import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { readWorksOnlyAnchor, recordWorksOnlyObservation } from '../lib/works-only-observation.mjs';
import { getProductInsights, getAccountInsight } from '../lib/product-insights.mjs';
import { rangeFor, projectRecordedWindow } from '../public/console-model.js';

const SEC = 'MS4wLjABAAAAWorksPeriodIndependent12345', UID = '123456789';
const ANCHOR = '2026-09-29T00:00:00.000Z', START = '2026-09-29T00:10:00.000Z';
const PAGE = '2026-09-29T00:10:01.000Z', FINISH = '2026-09-29T00:10:02.000Z';
const REFERENCE = new Date('2026-09-29T01:00:00.000Z');
const ranges = [
  { period: 'day' }, { period: 'week' }, { period: 'month' },
  { period: 'custom', startDate: '2026-09-12', endDate: '2026-09-29' },
  { period: 'custom', startDate: '2026-09-23', endDate: '2026-09-29' },
];
const post = (id, publishedAt, likes = 10) => ({
  aweme_id: String(7300000000000000000n + BigInt(id)), author: { sec_uid: SEC, uid: UID },
  create_time: publishedAt ? Date.parse(publishedAt) / 1000 : null,
  statistics: { digg_count: likes }, desc: `offline evidence ${id}`,
});

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-08-31T02:00:00.000Z') });
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const db = database.db;
  const target = database.createTarget({ type: 'account', provider: 'public-web', locator: SEC,
    label: 'offline period evidence', metadata: { platform: 'douyin' } });
  database.assignTargetsToBoard([target.id], '一条小团团切片矩阵');
  db.prepare("UPDATE target_boards SET category='切片' WHERE target_id=?").run(target.id);
  for (const [at, posts] of [['2026-08-31T02:00:00.000Z', 50], ['2026-09-11T02:00:00.000Z', 60],
    ['2026-09-22T02:00:00.000Z', 70], ['2026-09-27T02:00:00.000Z', 75], ['2026-09-28T02:00:00.000Z', 79], [ANCHOR, 80]]) {
    t.mock.timers.setTime(Date.parse(at));
    const raw = { capturedAt: at, accountStatus: 'validated', accountError: null,
      profile: { user: { sec_uid: SEC, uid: UID, follower_count: posts * 10, total_favorited: posts * 100, aweme_count: posts } },
      worksCoverage: 'unavailable', worksErrorCode: 'deferred',
      works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
      provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
        profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/', accountLocator: 'sec_uid',
        cookiePersisted: false, runtimeAI: false, paidAPI: false } };
    database.saveCollection(target, null, normalizeCollection(target, raw, { capturedAt: at }));
  }
  const read = options => getProductInsights(database, { reference: REFERENCE, timeZone: 'Asia/Shanghai', ...options });
  const detail = options => getAccountInsight(database, target.id, { reference: REFERENCE, timeZone: 'Asia/Shanghai', ...options });
  const append = posts => {
    t.mock.timers.setTime(Date.parse(START));
    const anchor = readWorksOnlyAnchor(db, target.id);
    const runId = database.beginRun('works-only', target.id, 1);
    t.mock.timers.setTime(Date.parse(FINISH));
    const saved = recordWorksOnlyObservation(db, { runId, targetId: target.id, anchorSnapshotId: anchor.snapshotId,
      anchorChecksum: anchor.sourceChecksum, requestStartedAt: START, requestFinishedAt: FINISH,
      result: { status: 'ok', posts, hasMore: false, maxCursor: 0,
        pagination: { version: 1, maxPages: 3, requestCount: 1, collectedCount: posts.length,
          stopReason: 'end-of-list', errorCode: null, pages: [{ requestCursor: 0,
            response: { max_cursor: 0, has_more: false }, rawCount: posts.length, acceptedCount: posts.length,
            duplicateCount: 0, filteredCount: 0, truncated: false, observedAt: PAGE }] } } }, { now: Date.now() });
    t.mock.timers.setTime(Date.parse(FINISH) + 1);
    database.finishRun(runId, { status: 'success', successCount: 1 });
    return saved;
  };
  return { database, db, target, read, detail, append };
}

test('works-only historical additions cannot change homepage day/week/month/since metrics or daily deltas', t => {
  const f = fixture(t);
  const before = ranges.map(options => f.read(options));
  const protectedRows = Object.fromEntries(['snapshots', 'audits', 'targets'].map(table =>
    [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  const receipt = f.append([post(1, '2025-12-17T17:59:02.000Z'), post(2, '2025-12-19T19:07:17.000Z'), post(3, '2025-12-23T14:16:16.000Z')]);
  assert.equal(receipt.coverage, 'limited');
  for (const [index, options] of ranges.entries()) {
    const after = f.read(options);
    assert.deepEqual(after.summary.metrics, before[index].summary.metrics);
    assert.deepEqual(after.summary.trend, before[index].summary.trend);
    assert.deepEqual(after.accounts[0].metrics, before[index].accounts[0].metrics);
    assert.equal(after.summary.publishedSamples.value, 0, 'discovery today is not publication today or in September');
    assert.equal(after.summary.worksObservation.completeCount, 0);
    assert.equal(after.summary.worksObservation.limitedCount, 1);
    assert.equal(after.summary.metrics.posts.delta, [1, 5, 30, 20, 10][index]);
    assert.equal(f.detail(options).recentWorks.length, 3, 'actual historical detail remains available');
  }
  for (const [table, rows] of Object.entries(protectedRows)) assert.deepEqual(f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(), rows);
});

test('26 new per-work metric observations do not replace exact profile totals or infer real plays', t => {
  const f = fixture(t); const before = f.read({ period: 'day' }).summary.metrics;
  f.append(Array.from({ length: 26 }, (_, index) => post(index + 1, '2025-12-17T17:59:02.000Z', 99999)));
  assert.equal(f.db.prepare('SELECT count(*) n FROM post_metrics').get().n, 26);
  assert.deepEqual(f.read({ period: 'day' }).summary.metrics, before);
  assert.equal(f.detail({ period: 'day' }).account.metrics.posts.value, 80);
  assert.equal(f.detail({ period: 'day' }).account.metrics.posts.delta, 1);
  assert.ok(f.detail({ period: 'day' }).recentWorks.every(work => work.plays === null));
});

test('published samples use actual publication and first-seen cutoffs, not collection count or missing dates', t => {
  const f = fixture(t);
  f.append([post(1, '2026-09-29T00:05:00.000Z'), post(2, '2026-09-15T01:00:00.000Z'), post(3, null)]);
  assert.equal(f.read({ period: 'day' }).summary.publishedSamples.value, 1);
  assert.equal(f.read({ period: 'month' }).summary.publishedSamples.value, 2);
  const oldRange = { period: 'custom', startDate: '2026-09-12', endDate: '2026-09-20' };
  assert.equal(f.read(oldRange).summary.publishedSamples.value, 0, 'September 15 work first found September 29 cannot enter a closed September 20 report');
  assert.equal(f.detail(oldRange).recentWorks.length, 0);
  const beforePage = f.read({ period: 'day', reference: new Date('2026-09-29T00:09:59.000Z') });
  assert.equal(beforePage.summary.publishedSamples.value, 0);
});

test('September 12 preset remains strict with its actual previous-day baseline after works-only ingestion', t => {
  const f = fixture(t); f.append([post(1, '2025-12-17T17:59:02.000Z')]);
  const range = rangeFor('since', '2026-09-29');
  assert.deepEqual(rangeFor('week', '2026-09-29'), { start: '2026-09-23', end: '2026-09-29' });
  assert.deepEqual(range, { start: '2026-09-12', end: '2026-09-29' });
  const raw = f.read({ period: 'custom', startDate: range.start, endDate: range.end, theme: 'tuantuan', classification: 'slice' });
  assert.equal(raw.range.start, '2026-09-11T16:00:00.000Z');
  assert.equal(raw.range.days, 18);
  assert.equal(raw.accounts.length, 1);
  assert.equal(raw.accounts[0].metrics.posts.baselineAt, '2026-09-11T02:00:00.000Z');
  assert.equal(raw.summary.metrics.posts.delta, 20);
  assert.equal(projectRecordedWindow(raw, { period: 'since' }), raw);
});

test('account theme/classification and works-only writes cannot alter independent topic metrics', t => {
  const f = fixture(t);
  const topic = f.database.createTarget({ type: 'hashtag', provider: 'manual', label: '#offline topic', locator: '#offline topic' });
  const insert = f.db.prepare(`INSERT INTO snapshots(target_id,captured_at,hashtag_participants,hashtag_views,quality_status,account_status,works_coverage,source_checksum,raw_json)
    VALUES(?,?,?,?, 'validated','unknown','not-applicable','offline-topic-evidence','{}')`);
  insert.run(topic.id, '2026-09-28T02:00:00.000Z', 100, 1000);
  insert.run(topic.id, ANCHOR, 102, 1500);
  const options = { startDate: '2026-09-12', endDate: '2026-09-29' };
  const before = f.database.listTopicHistory(options).topics;
  f.append([post(1, '2025-12-17T17:59:02.000Z')]);
  assert.equal(f.read({ period: 'day', theme: 'not-this-theme', classification: 'slice' }).accounts.length, 0);
  assert.deepEqual(f.database.listTopicHistory({ ...options, theme: 'not-this-theme', classification: 'slice' }).topics, before);
  const last = before[0].points.at(-1);
  assert.equal(last.participantsDelta, 2); assert.equal(last.viewsDelta, 500);
});
