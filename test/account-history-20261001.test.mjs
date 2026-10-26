import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { checksum } from '../lib/utils.mjs';
import { getAccountHistory } from '../lib/account-history.mjs';

const SEC = 'MS4wLjABAAAAAccountHistorySynthetic20261001';
const OTHER = 'MS4wLjABAAAAAccountHistoryOtherAuthor20261001';
const UID = '123456789';
const AS_OF = '2026-09-30T12:00:00.000Z';
const at = (day, hour = 2) => `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const external = index => String(7200000000000000000n + BigInt(index));

function fixture(t) {
  const database = new MonitorDatabase(':memory:');
  t.after(() => database.close());
  const target = database.createTarget({ type: 'account', label: 'full-saved-history', locator: SEC,
    provider: 'public-web', metadata: { platform: 'douyin' } });
  const raw = (day, { hour = 2, followers = 100, likes = 200, posts = 20, works = [] } = {}) => ({
    capturedAt: at(day, hour), profile: { user: { sec_uid: SEC, uid: UID,
      follower_count: followers, total_favorited: likes, aweme_count: posts } },
    works: { aweme_list: works.map(work => ({ aweme_id: external(work.index),
      author: { sec_uid: SEC, uid: UID }, desc: work.caption ?? `旧日作品-${work.index}`,
      create_time: Date.parse(work.publishedAt ?? at(1, 1)) / 1000,
      share_url: work.url ?? `https://www.douyin.com/video/${external(work.index)}`,
      statistics: { digg_count: work.likes ?? 0, comment_count: work.comments ?? null,
        share_count: work.shares ?? null, collect_count: work.collects ?? null, play_count: work.plays ?? null } })) },
  });
  const sample = (day, options) => {
    const body = raw(day, options);
    database.saveCollection(target, null, normalizeCollection(target, body, { capturedAt: body.capturedAt }));
    return database.db.prepare('SELECT id FROM snapshots ORDER BY id DESC LIMIT 1').get().id;
  };
  const read = options => getAccountHistory(database, target.id, { asOf: AS_OF, ...options });
  return { database, target, raw, sample, read };
}

test('saved history: sorting uses the complete validated metadata set, stable tie IDs, null last', t => {
  const { sample, read } = fixture(t);
  sample(2, { works: Array.from({ length: 47 }, (_, index) => ({ index: index + 1, likes: index < 2 ? 100 : index,
    publishedAt: at(1, index % 12) })) });
  const first = read({ kind: 'works', sort: 'likes', pageSize: 20 });
  assert.equal(first.pagination.total, 47);
  assert.equal(first.pagination.totalPages, 3);
  assert.deepEqual(first.items.slice(0, 2).map(item => item.id), [1, 2]);
  assert.equal(first.items[0].caption, '旧日作品-1');
  const ids = [];
  for (let page = 1; page <= 3; page++) ids.push(...read({ kind: 'works', page, pageSize: 20,
    sort: 'likes', ...first.revision }).items.map(item => item.id));
  assert.equal(new Set(ids).size, 47);
  const oldest = read({ kind: 'works', sort: 'publishedAt', order: 'asc', pageSize: 100 });
  assert.ok(oldest.items.every(item => item.publishedAt !== null));
  assert.equal(oldest.items[0].publishedAt, at(1, 0));
});

test('saved history: page/date selection retains previous calendar-day baseline and does not bridge gaps', t => {
  const { sample, read } = fixture(t);
  for (let day = 1; day <= 29; day++) if (day !== 15) sample(day, { followers: day, likes: day * 2, posts: day });
  const second = read({ kind: 'daily', page: 2, pageSize: 10 });
  assert.equal(second.pagination.total, 28);
  assert.equal(second.items[0].followersDelta, 1);
  const selected = read({ kind: 'daily', startDate: '2026-09-20', endDate: '2026-09-20' });
  assert.equal(selected.items[0].followersDelta, 1);
  assert.equal(selected.items[0].followersBaselineAt, at(19));
  const gap = read({ kind: 'daily', startDate: '2026-09-16', endDate: '2026-09-16' });
  assert.equal(gap.items[0].followersDelta, null);
  assert.equal(gap.items[0].followersBaselineAt, null);
  assert.equal(read({ kind: 'daily', startDate: '2026-09-15', endDate: '2026-09-15' }).pagination.total, 0);
});

test('saved history: independent intraday observations retain per-metric time and explicit zero', t => {
  const { sample, read } = fixture(t);
  sample(1, { followers: 10, likes: 30, posts: 2 });
  sample(2, { followers: 0, likes: 20, posts: null });
  sample(2, { hour: 3, followers: null, likes: null, posts: 0 });
  const row = read({ kind: 'daily' }).items[0];
  assert.equal(row.capturedAt, at(2, 3));
  assert.equal(row.followersAt, at(2));
  assert.equal(row.postsAt, at(2, 3));
  assert.equal(row.followersDelta, -10);
  assert.equal(row.likesDelta, -10);
  assert.equal(row.postsDelta, -2);
  assert.equal(row.estimatedPlaysDelta, -1000);
  assert.equal(row.sampleCount, 2);
});

for (const [name, mutate] of [
  ['wrong identity even if rehashed', raw => { raw.profile.user.sec_uid = OTHER; }],
  ['changed original capture time even if rehashed', raw => { raw.capturedAt = at(3); }],
  ['snapshot vector no longer bound to source even if rehashed', raw => { raw.profile.user.follower_count = 999; }],
]) test(`saved history: daily rejects ${name}`, t => {
  const { database, sample, read } = fixture(t);
  const id = sample(2);
  const row = database.db.prepare('SELECT raw_json FROM snapshots WHERE id=?').get(id);
  const body = JSON.parse(row.raw_json); mutate(body);
  database.db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=? WHERE id=?').run(JSON.stringify(body), checksum(body), id);
  const result = read({ kind: 'daily' });
  assert.equal(result.pagination.total, 0);
  assert.equal(result.coverage.excludedCount, 1);
});

test('saved history: rejected/checksum-invalid snapshots do not create daily values or zeros', t => {
  const { database, sample, read } = fixture(t);
  const first = sample(1), second = sample(2);
  database.db.prepare("UPDATE snapshots SET quality_status='rejected' WHERE id=?").run(first);
  database.db.prepare("UPDATE snapshots SET source_checksum='not-the-original-source' WHERE id=?").run(second);
  const result = read({ kind: 'daily' });
  assert.deepEqual(result.items, []);
  assert.equal(result.coverage.excludedCount, 2);
});

test('saved history: firstSeen and UTC cutoff exclude future work/metric; the frozen source cap rejects late metadata', t => {
  const { database, sample, raw, target, read } = fixture(t);
  sample(2, { works: [{ index: 1, likes: 0, caption: '真实旧标题' }] });
  const original = read({ kind: 'works' });
  const body = raw(2, { works: [{ index: 1, likes: 0, caption: '后来补录的旧日伪替代标题' }] });
  body.capturedAt = body.capturedAt.replace('.000Z', 'Z');
  database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,quality_status,source_checksum,raw_json)
    VALUES(?,?,'validated',?,?)`).run(target.id, body.capturedAt, checksum(body), JSON.stringify(body));
  database.db.prepare('UPDATE posts SET caption=?,published_at=?,last_seen_at=? WHERE id=?')
    .run('未来可变标题', at(30, 13), at(30, 13), original.items[0].id);
  const frozen = read({ kind: 'works', ...original.revision });
  assert.deepEqual(frozen.items, original.items);
  assert.equal(frozen.items[0].likes, 0);
  sample(30, { hour: 13, works: [{ index: 1, likes: 500 }, { index: 2, likes: 999 }] });
  const old = read({ kind: 'works' });
  assert.equal(old.pagination.total, 1);
  assert.equal(old.items[0].likes, 0);
});

test('saved history: malformed observed calendar timestamps are rejected and proxy integer overflow is unknown', t => {
  const { database, sample, target, read } = fixture(t);
  sample(2, { likes: Number.MAX_SAFE_INTEGER });
  const point = read({ kind: 'daily' }).items[0];
  assert.equal(point.likes, Number.MAX_SAFE_INTEGER);
  assert.equal(point.estimatedPlays, null, 'an inexact Number must not be presented as an exact proxy');
  const bad = '2026-02-30T02:00:00.000Z';
  const body = { capturedAt: bad, profile: { user: { sec_uid: SEC, uid: UID,
    follower_count: 1, total_favorited: 2, aweme_count: 3 } } };
  database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,
    quality_status,source_checksum,raw_json) VALUES(?,?,?,?,?,'validated',?,?)`)
    .run(target.id, bad, 1, 2, 3, checksum(body), JSON.stringify(body));
  assert.equal(read({ kind: 'daily' }).pagination.total, 1);
});

test('saved history: validation rejects partial/missing/above-max revisions but permits all-saved old dates', t => {
  const { read, database, target } = fixture(t);
  for (const options of [null, [], { snapshotMaxId: 0 }, { snapshotMaxId: 0, postMaxId: 0, postMetricMaxId: 1 },
    { kind: 'workMetrics' }, { asOf: '2099-01-01T00:00:00.000Z' }, { asOf: '2026-02-30T00:00:00.000Z' },
    { page: '2a' }, { pageSize: 101 }, { sort: 'raw_json' }, { startDate: '2026-09-30', endDate: '2026-09-29' }]) {
    assert.throws(() => options === null || Array.isArray(options) ? getAccountHistory(database, target.id, options) : read(options),
      error => error.status === 400);
  }
  const result = read({ kind: 'daily', startDate: '1900-01-01' });
  assert.equal(result.pagination.total, 0);
  assert.equal(result.range.startDate, '1900-01-01');
});

test('saved history: explicit timestamp and daily delta sorting aliases sort the complete observations', t => {
  const { sample, read } = fixture(t);
  sample(1, { followers: 10, likes: 10, posts: 10, works: [{ index: 1, likes: 1 }] });
  sample(2, { followers: 8, likes: 10, posts: 9, works: [{ index: 1, likes: 2 }] });
  sample(3, { followers: 13, likes: 15, posts: 12, works: [{ index: 1, likes: 3 }] });
  for (const sort of ['followersDelta', 'likesDelta', 'postsDelta', 'estimatedPlaysDelta']) {
    const result = read({ kind: 'daily', sort, order: 'desc' });
    assert.equal(result.items[0].date, '2026-09-03');
    assert.equal(result.items.at(-1).date, '2026-09-01', 'missing baseline remains null-last');
  }
  const work = read({ kind: 'works', sort: 'lastObservedAt' }).items[0];
  assert.equal(work.lastObservedAt, at(3));
  assert.equal(read({ kind: 'workMetrics', workId: work.id, sort: 'capturedAt' }).items[0].capturedAt, at(3));
});

test('saved history: only an identity-bound platform work path becomes a clean permalink', t => {
  const { sample, read } = fixture(t);
  sample(2, { works: [
    { index: 1, likes: 1, url: `https://www.douyin.com/video/${external(1)}?modal_id=SYNTHETIC_SECRET#SYNTHETIC_SECRET` },
    { index: 2, likes: 2, url: 'https://www.douyin.com/private/SYNTHETIC_SECRET' },
    { index: 3, likes: 3, url: `https://www.feishu.cn/video/${external(3)}` },
    { index: 4, likes: 4, url: `https://www.douyin.com/video/${external(1)}` },
  ] });
  const result = read({ kind: 'works', sort: 'likes', order: 'asc' });
  assert.equal(result.pagination.total, 4);
  assert.equal(result.items[0].url, `https://www.douyin.com/video/${external(1)}`);
  assert.deepEqual(result.items.slice(1).map(item => item.url), [null, null, null]);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_SECRET'), false);
  assert.equal(result.items[1].caption, '旧日作品-2');
  assert.equal(result.items[1].likes, 2, 'URL uncertainty never removes the valid saved observation');
});
