import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { persistPosts } from '../lib/post-persistence.mjs';
import { getAccountInsight, getProductInsights } from '../lib/product-insights.mjs';

const SEC = 'MS4wLjABAAAAHistoryMetadataRegression12345';
const ID = '7200000000000000001';
const EARLY = '2026-09-27T03:00:00.000Z';
const LATE = '2026-09-29T03:00:00.000Z';
const oldOptions = { period: 'custom', timeZone: 'Asia/Shanghai', startDate: '2026-09-27',
  endDate: '2026-09-27', reference: new Date('2026-09-30T12:00:00.000Z') };

function fixture(t) {
  const database = new MonitorDatabase(':memory:');
  t.after(() => database.close());
  const target = database.createTarget({ type: 'account', label: '历史作品元数据', locator: SEC,
    provider: 'public-web', metadata: { platform: 'douyin' } });
  database.db.prepare('UPDATE targets SET created_at=? WHERE id=?').run('2026-09-01T00:00:00.000Z', target.id);
  const append = (capturedAt, caption, publishedAt, likes) => {
    const raw = { capturedAt, accountStatus: 'validated', worksCoverage: 'limited',
      profile: { user: { sec_uid: SEC, uid: '123456789', follower_count: 100, total_favorited: 200, aweme_count: 1 } },
      works: { aweme_list: [{ aweme_id: ID, author: { sec_uid: SEC, uid: '123456789' }, desc: caption,
        create_time: Date.parse(publishedAt) / 1000, statistics: { digg_count: likes } }] } };
    database.saveCollection(target, null, normalizeCollection(target, raw, { capturedAt }));
  };
  return { database, target, append };
}

test('historical work title and publication date come from the same dated evidence as its metrics', t => {
  const { database, target, append } = fixture(t);
  append(EARLY, '9月27日旧标题', '2026-09-27T02:00:00.000Z', 10);
  const before = getAccountInsight(database, target.id, oldOptions);
  append(LATE, '9月29日才更新的新标题', '2026-09-28T02:00:00.000Z', 99);
  const changes = database.db.prepare('SELECT total_changes() AS n').get().n;
  const after = getAccountInsight(database, target.id, oldOptions);
  assert.deepEqual(after.recentWorks, before.recentWorks);
  assert.equal(after.recentWorks[0].caption, '9月27日旧标题');
  assert.equal(after.recentWorks[0].publishedAt, '2026-09-27T02:00:00.000Z');
  assert.equal(after.recentWorks[0].lastObservedAt, EARLY);
  assert.equal(after.recentWorks[0].likes, 10);
  assert.equal(after.account.publishedSamples.value, 1);
  const overview = getProductInsights(database, oldOptions);
  assert.equal(overview.summary.publishedSamples.value, 1);
  assert.equal(overview.summary.trend.at(-1).publishedSamples, 1);
  const current = getAccountInsight(database, target.id, { ...oldOptions, endDate: '2026-09-29' });
  assert.equal(current.recentWorks[0].caption, '9月29日才更新的新标题');
  assert.equal(current.recentWorks[0].publishedAt, '2026-09-28T02:00:00.000Z');
  assert.equal(current.recentWorks[0].likes, 99);
  assert.equal(database.db.prepare('SELECT total_changes() AS n').get().n, changes, 'reads never rewrite history');
  assert.equal(database.db.prepare('SELECT count(*) AS n FROM post_metrics').get().n, 2);
});

test('caption-only updates cannot leak a future title into a closed historical day', t => {
  const { database, target, append } = fixture(t);
  append(EARLY, '当时标题', '2026-09-27T02:00:00.000Z', 10);
  append(LATE, '之后标题', '2026-09-27T02:00:00.000Z', 99);
  const work = getAccountInsight(database, target.id, oldOptions).recentWorks[0];
  assert.equal(work.caption, '当时标题');
  assert.equal(work.likes, 10);
});

test('unrecoverable or checksum-invalid old metadata stays unknown instead of borrowing current fields', t => {
  const { database, target } = fixture(t);
  const post = { externalId: ID, authorId: SEC, caption: '旧标题', publishedAt: '2026-09-27T02:00:00.000Z', likes: 10 };
  persistPosts(database.db, { target, posts: [post], capturedAt: EARLY });
  persistPosts(database.db, { target, posts: [{ ...post, caption: '未来标题', likes: 99 }], capturedAt: LATE });
  database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,quality_status,source_checksum,raw_json)
    VALUES(?,?,'validated','unbound',?)`).run(target.id, EARLY, JSON.stringify({ posts: [{ id: ID, caption: '伪旧标题' }] }));
  const work = getAccountInsight(database, target.id, oldOptions).recentWorks[0];
  assert.equal(work.caption, null);
  assert.equal(work.publishedAt, null);
  assert.equal(work.url, null);
  assert.equal(work.likes, 10);
  assert.equal(getProductInsights(database, oldOptions).summary.publishedSamples.value, 0);
});
