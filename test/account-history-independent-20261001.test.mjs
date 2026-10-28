import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { getAccountHistory } from '../lib/account-history.mjs';
import { checksum } from '../lib/utils.mjs';

// Independent, synthetic, in-memory data only. No production/session/network I/O.
const AS_OF = '2026-09-01T12:00:00.000Z';
const FUTURE = '2026-09-02T12:00:00.000Z';
const SECRET = 'SYNTHETIC_ONLY_cookie_ACCESS_TOKEN_DO_NOT_PROJECT';
const day = (index) => new Date(Date.UTC(2026, 6, 1 + index)).toISOString().slice(0, 10);
const at = (index, hour = 2) => `${day(index)}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const externalId = index => `BV${index.toString(36).padStart(10, '0')}`;

function fixture(t) {
  const database = new MonitorDatabase(':memory:');
  t.after(() => database.close());
  const target = database.createTarget({ type: 'account', label: '独立历史反例', locator: '1809444890',
    provider: 'public-web', metadata: { platform: 'bilibili', cookie: SECRET, privateFile: SECRET } });
  const other = database.createTarget({ type: 'account', label: '其他作者', locator: '1809444891',
    provider: 'public-web', metadata: { platform: 'bilibili' } });
  function sample(index, followers, likes, posts, { quality = 'validated', hour = 2 } = {}) {
    const raw = { capturedAt: at(index, hour), profile: { user: { uid: target.locator,
      follower_count: followers, total_favorited: likes, aweme_count: posts } }, works: { aweme_list: [] },
      cookie: SECRET, headers: { authorization: SECRET }, rawFailure: SECRET };
    return Number(database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,
      quality_status,account_status,works_coverage,source_checksum,raw_json) VALUES(?,?,?,?,?,?,'available','complete',?,?)`)
      .run(target.id, at(index, hour), followers, likes, posts, quality, checksum(raw), JSON.stringify(raw)).lastInsertRowid);
  }
  function post(index, { owner = target, firstSeenAt = at(0), publishedAt = at(0), seenAt = at(1),
    caption = `公开作品-${index}`, url = `https://www.bilibili.com/video/${externalId(index)}`, metrics = true } = {}) {
    const id = Number(database.db.prepare(`INSERT INTO posts(target_id,external_id,author_id,caption,url,published_at,
      first_seen_at,last_seen_at,likes,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(owner.id, externalId(index), owner.locator, caption, url, publishedAt, firstSeenAt, seenAt, 999,
        JSON.stringify({ cookie: SECRET, token: SECRET, body: SECRET })).lastInsertRowid);
    if (metrics) metric(id, seenAt, [index, null, 0, null, null]);
    return id;
  }
  function metric(postId, capturedAt, values = [1, null, null, null, null]) {
    return Number(database.db.prepare(`INSERT INTO post_metrics(post_id,captured_at,likes,comments,shares,collects,plays)
      VALUES(?,?,?,?,?,?,?)`).run(postId, capturedAt, ...values).lastInsertRowid);
  }
  function bindPostObservation(capturedAt = at(1)) {
    const rows = database.db.prepare(`SELECT p.external_id,p.author_id,p.caption,p.url,p.published_at,
      m.likes,m.comments,m.shares,m.collects,m.plays FROM posts p JOIN post_metrics m ON m.post_id=p.id
      WHERE p.target_id=? AND m.captured_at=? ORDER BY p.id`).all(target.id, capturedAt);
    const raw = { capturedAt, profile: { user: { uid: target.locator, follower_count: null,
      total_favorited: null, aweme_count: null } }, works: { aweme_list: rows.map(row => ({
        aweme_id: row.external_id, author: { uid: row.author_id }, desc: row.caption, share_url: row.url,
        published_at: row.published_at, statistics: { digg_count: row.likes, comment_count: row.comments,
          share_count: row.shares, collect_count: row.collects, play_count: row.plays },
      })) }, cookie: SECRET, headers: { authorization: SECRET } };
    return Number(database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,quality_status,account_status,
      works_coverage,source_checksum,raw_json) VALUES(?,?,'warning','available','complete',?,?)`)
      .run(target.id, capturedAt, checksum(raw), JSON.stringify(raw)).lastInsertRowid);
  }
  const read = (options = {}) => getAccountHistory(database, target.id, { asOf: AS_OF, ...options });
  const changes = () => database.db.prepare('SELECT total_changes() AS n').get().n;
  return { database, target, other, sample, post, metric, bindPostObservation, read, changes };
}

function pages(read, options = {}) {
  const first = read({ ...options, page: 1, pageSize: 20 });
  const result = [...first.items];
  for (let page = 2; page <= first.pagination.totalPages; page++) {
    const next = read({ ...options, ...first.revision, asOf: first.asOf, page, pageSize: 20 });
    assert.equal(next.pagination.total, first.pagination.total);
    assert.equal(next.asOf, first.asOf);
    assert.deepEqual(next.revision, first.revision);
    result.push(...next.items);
  }
  assert.equal(result.length, first.pagination.total);
  return { first, items: result };
}

test('independent works: 47 saved works really paginate, deduplicate ties, retain null-metric works and do not write', (t) => {
  const { post, read, changes } = fixture(t);
  for (let i = 0; i < 47; i++) post(i, { metrics: i !== 46 });
  const before = changes();
  const { first, items } = pages(read, { kind: 'works', sort: 'publishedAt', order: 'desc' });
  assert.equal(first.pagination.total, 47);
  assert.equal(first.pagination.totalPages, 3);
  assert.equal(new Set(items.map(item => item.id)).size, 47);
  assert.equal(items.find(item => item.externalId === externalId(46)).likes, null,
    'mutable latest posts.likes is not a historical metric when post_metrics is absent');
  assert.equal(changes(), before, 'history reads must be read-only');
});

test('independent daily: all 45 saved days are reachable, descending page edge has previous-day baseline', (t) => {
  const { sample, read } = fixture(t);
  for (let i = 0; i < 45; i++) sample(i, 100 - i, i, 10);
  const { first, items } = pages(read, { kind: 'daily', sort: 'date', order: 'desc' });
  assert.equal(first.pagination.total, 45, 'default daily history must not silently cap at 30 days');
  assert.equal(new Set(items.map(item => item.date)).size, 45);
  assert.equal(items.at(-1).date, day(0));
  assert.equal(items[20].followersDelta, -1, 'first row of page 2 still compares the adjacent saved day');
  assert.equal(items[20].likesDelta, 1);
  assert.equal(items[20].estimatedPlaysDelta, 100);
});

test('independent daily: negative change, real zero, missing metric and calendar gap are distinct', (t) => {
  const { sample, read } = fixture(t);
  sample(0, 10, 10, 5); sample(1, 0, 5, null); sample(3, 2, 0, 0);
  const { items } = pages(read, { kind: 'daily', sort: 'date', order: 'asc' });
  const zero = items.find(item => item.date === day(1));
  assert.equal(zero.followers, 0); assert.equal(zero.followersDelta, -10);
  assert.equal(zero.likesDelta, -5); assert.equal(zero.estimatedPlaysDelta, -500);
  assert.equal(zero.posts, null); assert.equal(zero.postsDelta, null);
  const gap = items.find(item => item.date === day(2));
  if (gap) assert.equal(gap.followers, null);
  const afterGap = items.find(item => item.date === day(3));
  assert.equal(afterGap.likes, 0); assert.equal(afterGap.posts, 0);
  assert.equal(afterGap.followersDelta, null, 'must not bridge the missing adjacent calendar day');
  assert.equal(afterGap.likesDelta, null);
});

test('independent workMetrics: 43 observations paginate, future values are excluded, zero is retained', (t) => {
  const { post, metric, read } = fixture(t);
  const workId = post(1, { metrics: false });
  for (let i = 0; i < 43; i++) metric(workId, at(i), [i, i === 0 ? 0 : null, null, 0, null]);
  metric(workId, FUTURE, [999999, 999999, 999999, 999999, 999999]);
  const { first, items } = pages(read, { kind: 'workMetrics', workId, sort: 'date', order: 'asc' });
  assert.equal(first.pagination.total, 43);
  assert.equal(new Set(items.map(item => item.capturedAt)).size, 43);
  assert.equal(items[0].likes, 0); assert.equal(items[0].comments, 0); assert.equal(items[0].plays, null);
  assert.equal(JSON.stringify(items).includes('999999'), false);
});

test('independent asOf: future first discovery cannot enter works, latest metric cannot leak into old cutoff', (t) => {
  const { post, metric, read } = fixture(t);
  const saved = post(1); metric(saved, FUTURE, [999999, 999999, 999999, 999999, 999999]);
  post(2, { firstSeenAt: FUTURE, seenAt: FUTURE, publishedAt: at(0) });
  const result = read({ kind: 'works' });
  assert.equal(result.pagination.total, 1);
  assert.equal(result.items[0].id, saved); assert.equal(result.items[0].likes, 1);
});

test('independent revision: late backdated inserts and future inserts cannot enter an already opened page/CSV', (t) => {
  const { post, sample, metric, read } = fixture(t);
  const ids = Array.from({ length: 47 }, (_, i) => post(i));
  for (let i = 0; i < 45; i++) sample(i, i, i, i);
  const originalWorks = pages(read, { kind: 'works', sort: 'publishedAt', order: 'desc' });
  const originalDaily = pages(read, { kind: 'daily', sort: 'date', order: 'desc' });
  const originalMetrics = pages(read, { kind: 'workMetrics', workId: ids[0], sort: 'date', order: 'desc' });
  post(1000, { firstSeenAt: at(0), publishedAt: at(0) });
  post(1001, { firstSeenAt: FUTURE, publishedAt: at(0), seenAt: FUTURE });
  sample(0, 999999, 999999, 999999, { hour: 3 });
  metric(ids[0], at(2), [999999, 999999, 999999, 999999, 999999]);
  for (const [kind, original, extra] of [['works', originalWorks, {}], ['daily', originalDaily, {}],
    ['workMetrics', originalMetrics, { workId: ids[0] }]]) {
    const frozen = pages(read, { kind, sort: kind === 'works' ? 'publishedAt' : 'date', order: 'desc',
      ...extra, ...original.first.revision });
    assert.equal(frozen.first.pagination.total, original.first.pagination.total);
    assert.deepEqual(frozen.items, original.items, `${kind} repeated all-page export must retain its original revision`);
  }
  assert.equal(read({ kind: 'works' }).pagination.total, 48, 'explicit new revision sees the late saved work, never the future one');
  assert.equal(read({ kind: 'workMetrics', workId: ids[0] }).pagination.total, 2);
});

test('independent private projection: raw, cookie, credentials, hostile URLs never escape any kind', (t) => {
  const { sample, post, bindPostObservation, read } = fixture(t);
  sample(0, 0, 0, 0);
  const workId = post(1, { url: `https://user:${SECRET}@www.bilibili.com/video/${externalId(1)}?access_token=${SECRET}` });
  post(2, { url: `https://www.bilibili.com/video/${externalId(2)}?access_token=${SECRET}#${SECRET}` });
  bindPostObservation();
  for (const kind of ['works', 'daily', 'workMetrics']) {
    const result = read({ kind, ...(kind === 'workMetrics' ? { workId } : {}) });
    const encoded = JSON.stringify(result);
    assert.equal(encoded.includes(SECRET), false);
    for (const forbidden of ['raw_json', 'metadata_json', 'warnings_json', 'headers', 'rawFailure', 'cookie']) {
      assert.equal(encoded.includes(`"${forbidden}"`), false);
    }
  }
});

test('independent mutable metadata: historical caption binds old source, neither latest row nor late raw can rewrite frozen revision', (t) => {
  const { database, post, metric, bindPostObservation, read } = fixture(t);
  const workId = post(1, { caption: '历史来源标题' });
  bindPostObservation();
  const original = read({ kind: 'works' });
  assert.equal(original.items[0].caption, '历史来源标题');
  database.db.prepare('UPDATE posts SET caption=?,published_at=?,last_seen_at=? WHERE id=?')
    .run('未来标题不得混入', FUTURE, FUTURE, workId);
  metric(workId, FUTURE, [999999, 999999, 999999, 999999, 999999]);
  const frozen = read({ kind: 'works', ...original.revision });
  assert.equal(frozen.items[0].caption, '历史来源标题');
  assert.equal(frozen.items[0].likes, 1); assert.equal(frozen.pagination.total, 1);
  assert.equal(JSON.stringify(frozen).includes('未来标题不得混入'), false);
  assert.deepEqual(frozen.items, original.items);
});

test('independent query growth: single-account paging does not grow a query per work or read unrelated targets', (t) => {
  const { database, target, post } = fixture(t);
  const statements = [];
  const db = new Proxy(database.db, { get(native, key) {
    if (key !== 'prepare') { const value = Reflect.get(native, key, native); return typeof value === 'function' ? value.bind(native) : value; }
    return sql => { statements.push(sql); return native.prepare(sql); };
  } });
  const run = () => { statements.length = 0;
    const result = getAccountHistory({ db }, target.id, { kind: 'works', asOf: AS_OF, pageSize: 20 });
    return { total: result.pagination.total, queries: [...statements] };
  };
  for (let i = 0; i < 25; i++) post(i);
  const small = run();
  for (let i = 25; i < 225; i++) post(i);
  const large = run();
  assert.equal(small.total, 25); assert.equal(large.total, 225);
  assert.ok(large.queries.length <= small.queries.length + 2, `query count grew ${small.queries.length} -> ${large.queries.length}`);
  assert.ok(large.queries.length <= 25, 'fixed, bounded query count');
  assert.equal(large.queries.some(sql => /SELECT\s+\*\s+FROM\s+targets\s*(?:;|$)/i.test(sql)), false,
    'single account read must not enumerate all targets');
});

test('independent author boundary: another author workId is unavailable, unknown account is null', (t) => {
  const { database, other, post, read } = fixture(t);
  const workId = post(1, { owner: other });
  assert.equal(read({ kind: 'workMetrics', workId }), null,
    'foreign and missing works share the same unavailable projection; HTTP boundary translates it to 404');
  assert.equal(getAccountHistory(database, 999999, { asOf: AS_OF }), null);
});

test('independent invalid parameters: strict numbers/enums/calendar/asOf and impossible revision caps fail closed', (t) => {
  const { read } = fixture(t);
  const invalid = [
    { page: '1x' }, { page: 0 }, { page: 1.5 }, { page: Number.MAX_SAFE_INTEGER },
    { pageSize: 101 }, { pageSize: 0 }, { pageSize: '20x' }, { kind: 'raw' },
    { sort: 'captured_at;DROP TABLE posts' }, { order: 'DESC; SELECT' },
    { asOf: 'not-a-date' }, { asOf: '2099-01-01T00:00:00Z' }, { asOf: '2026-02-30T00:00:00Z' },
    { startDate: '2026-02-30', endDate: '2026-03-02' }, { startDate: '2026-08-02', endDate: '2026-08-01' },
    { endDate: '2099-01-01' },
    { snapshotMaxId: '1x' }, { postMaxId: -1 }, { postMetricMaxId: Number.MAX_SAFE_INTEGER },
    { kind: 'workMetrics', workId: '1 OR 1=1' },
  ];
  for (const options of invalid) assert.throws(() => read(options), error => error.status === 400, JSON.stringify(options));
});

test('independent very wide valid date range filters saved rows without fabricating calendar rows or limiting to 30 days', (t) => {
  const { sample, read } = fixture(t);
  for (let i = 0; i < 45; i++) sample(i, i, i, i);
  const ordinary = pages(read, { kind: 'daily', sort: 'date', order: 'asc' });
  const wide = pages(read, { kind: 'daily', sort: 'date', order: 'asc', startDate: '1900-01-01', endDate: '2026-09-01' });
  assert.equal(wide.first.pagination.total, 45);
  assert.deepEqual(wide.items, ordinary.items, 'valid long date filters do not invent tens of thousands of missing dates');
});

test('independent source attacks: rehashed foreign profile, mismatched stored vector and future raw observation do not produce daily values', (t) => {
  const { database, sample, read } = fixture(t);
  sample(0, 10, 20, 3);
  const foreign = sample(1, 1000, 2000, 3000);
  const mismatch = sample(2, 4000, 5000, 6000);
  const future = sample(3, 7000, 8000, 9000);
  const edit = (id, change) => {
    const row = database.db.prepare('SELECT raw_json FROM snapshots WHERE id=?').get(id);
    const raw = JSON.parse(row.raw_json); change(raw);
    database.db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=? WHERE id=?')
      .run(JSON.stringify(raw), checksum(raw), id);
  };
  edit(foreign, raw => { raw.profile.user.uid = '1809444891'; });
  edit(mismatch, raw => { raw.profile.user.follower_count = 4001; });
  edit(future, raw => { raw.capturedAt = FUTURE; });
  const result = read({ kind: 'daily' });
  assert.equal(result.pagination.total, 1);
  assert.equal(result.items[0].followers, 10);
  assert.equal(result.coverage.excludedCount, 3);
});

test('independent stored-metric boundary: absent exact source witness cannot upgrade the saved value into historical metadata', (t) => {
  const { database, post, bindPostObservation, read } = fixture(t);
  const workId = post(1, { caption: '只能由匹配来源恢复的标题' });
  bindPostObservation();
  database.db.prepare('UPDATE post_metrics SET likes=999999 WHERE post_id=?').run(workId);
  const metrics = read({ kind: 'workMetrics', workId });
  assert.equal(metrics.items[0].likes, 999999, 'this endpoint is saved-row history, not a promise of per-row independent source verification');
  assert.equal(metrics.items[0].playsEvidence.actualCountVerified, false);
  const works = read({ kind: 'works' });
  assert.equal(works.pagination.total, 1, 'missing source witness must not erase a saved work');
  assert.equal(works.items[0].caption, null);
  assert.equal(works.items[0].publishedAt, null);
  assert.equal(works.items[0].url, null);
  assert.equal(works.coverage.metadataUnknownCount, 1);
});

test('independent work URL boundary: generic allowed query keys cannot transport credentials through historical permalink', (t) => {
  const { post, bindPostObservation, read } = fixture(t);
  post(1, { url: `https://www.bilibili.com/video/${externalId(1)}?modal_id=${SECRET}&aweme_id=${SECRET}&item_id=${SECRET}&sheet=${SECRET}#${SECRET}` });
  bindPostObservation();
  const result = read({ kind: 'works' });
  assert.equal(result.pagination.total, 1);
  assert.equal(result.items[0].caption, '公开作品-1', 'source is otherwise valid, not rejected wholesale to hide the leak');
  assert.equal(result.items[0].likes, 1);
  assert.equal(JSON.stringify(result).includes(SECRET), false, 'work permalink must not carry any arbitrary query credential values');
  if (result.items[0].url) {
    const url = new URL(result.items[0].url);
    assert.equal(url.search, ''); assert.equal(url.hash, '');
    assert.equal(url.pathname.replace(/\/$/, ''), `/video/${externalId(1)}`);
  }
});

test('independent zero snapshot cap: newly inserted backdated metadata cannot rewrite the old all-page view', (t) => {
  const { post, bindPostObservation, read } = fixture(t);
  post(1, { caption: '后来补录的合法来源标题' });
  const original = read({ kind: 'works' });
  assert.equal(original.revision.snapshotMaxId, 0);
  assert.equal(original.items[0].caption, null);
  bindPostObservation();
  const frozen = read({ kind: 'works', ...original.revision });
  assert.deepEqual(frozen.items, original.items);
  assert.deepEqual(frozen.revision, original.revision);
  const latest = read({ kind: 'works' });
  assert.equal(latest.items[0].caption, '后来补录的合法来源标题');
  assert.equal(latest.coverage.metadataUnknownCount, 0);
});

test('independent canonical permalink: credential paths, wrong platform and another work path cannot become this work link', (t) => {
  const { post, bindPostObservation, read } = fixture(t);
  post(1, { url: `https://www.bilibili.com/private/${SECRET}/${externalId(1)}` });
  post(2, { url: `https://bytedance.larkoffice.com/sheets/${SECRET}` });
  post(3, { url: `https://www.bilibili.com/video/${externalId(999)}` });
  bindPostObservation();
  const result = read({ kind: 'works' });
  assert.equal(result.pagination.total, 3);
  assert.equal(result.coverage.metadataUnknownCount, 0, 'valid author/date/caption source remains usable');
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  for (const item of result.items) assert.equal(item.url, null, 'unknown or foreign work path must not be presented as this saved work permalink');
});
