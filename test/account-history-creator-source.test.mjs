import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { getAccountHistory } from '../lib/account-history.mjs';

const SEC = 'MS4wLjABAAAACreatorSourceAccountHistory20261022';
const AS_OF = '2026-09-30T12:00:00.000Z';
const SOURCE_AT = '2026-09-24T12:00:00.123Z';
const SOURCE_RAW_AT = '2026-09-24T12:00:00.123456+00:00';
const IMPORT_AT = '2026-09-25T12:00:00.000Z';
const external = index => String(7300000000000000000n + BigInt(index));

function fixture(t) {
  const database = new MonitorDatabase(':memory:');
  t.after(() => database.close());
  const target = database.createTarget({ type: 'account', label: '来源作者', locator: SEC,
    provider: 'public-web', metadata: { platform: 'douyin', douyinId: 'Handle_A',
      identityVerification: { accountId: SEC } } });
  const db = database.db;
  db.exec(`CREATE TABLE creator_source_imports(id INTEGER PRIMARY KEY,source_sha256 TEXT,source_url TEXT,
    source_revision TEXT,source_modified_at TEXT,imported_at TEXT,metadata_json TEXT,source_row_count INTEGER);
    CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);
    CREATE TABLE creator_source_account_links(import_id INTEGER,author_row INTEGER,target_id INTEGER,
      matched_id TEXT,matched_at TEXT);
    CREATE TABLE creator_source_work_links(import_id INTEGER,work_row INTEGER,target_id INTEGER);`);
  // The explicit column list below keeps the fixture independent of optional
  // audit metadata and uses only public source fields.
  const importRow = (id = 1, importedAt = IMPORT_AT, sourceAt = SOURCE_RAW_AT) => {
    db.prepare(`INSERT INTO creator_source_imports(id,source_sha256,source_url,source_revision,
      source_modified_at,imported_at,metadata_json,source_row_count) VALUES(?,?,?,?,?,?,?,?)`)
      .run(id, `hash-${id}`, 'https://my.feishu.cn/sheets/example?secret=do-not-expose', String(id),
        sourceAt, importedAt, JSON.stringify({ audit: { sourceRefreshedAt: sourceAt } }), 0);
    db.prepare('INSERT INTO creator_source_rows VALUES(?,?,?,?)')
      .run(id, '08', 2, JSON.stringify(['来源作者', 'handle_a']));
    db.prepare('INSERT INTO creator_source_account_links VALUES(?,?,?,?,?)')
      .run(id, 2, target.id, 'HANDLE_A', importedAt);
  };
  importRow();
  const work = (index, { importId = 1, row = index + 1, targetId = target.id, handle = 'handle_a',
    day = '2026-09-12', plays = 300, likes = 20, contentId = external(index), title = '来源标题' } = {}) => {
    const values = [contentId, '来源作者', handle, day, '视频', '切片激励', '切片激励', plays, likes,
      '', title, `https://www.douyin.com/video/${contentId}`, 1, `slice_topic:${row}`];
    db.prepare('INSERT INTO creator_source_rows VALUES(?,?,?,?)').run(importId, '09', row, JSON.stringify(values));
    if (targetId != null) db.prepare('INSERT INTO creator_source_work_links VALUES(?,?,?)').run(importId, row, targetId);
  };
  const sample = ({ index = 1, likes = 90, plays = 900, at = '2026-09-26T12:00:00.000Z' } = {}) => {
    const body = { capturedAt: at, profile: { user: { sec_uid: SEC, uid: '123456789', follower_count: 100,
      total_favorited: likes, aweme_count: 1 } }, works: { aweme_list: [{ aweme_id: external(index),
      author: { sec_uid: SEC, uid: '123456789' }, desc: '平台标题', create_time: Date.parse('2026-09-13T12:00:00.000Z') / 1000,
      share_url: `https://www.douyin.com/video/${external(index)}`,
      statistics: { digg_count: likes, play_count: plays, comment_count: 1, share_count: 2, collect_count: 3 } }] } };
    database.saveCollection(target, null, normalizeCollection(target, body, { capturedAt: at }));
  };
  const read = options => getAccountHistory(database, target.id, { asOf: AS_OF, kind: 'works', ...options });
  return { db, database, target, work, sample, read, importRow };
}

test('strictly linked source work appears in account history without fabricated publication time or missing zeros', t => {
  const { work, read, db } = fixture(t);
  work(1, { plays: null, likes: 0 });
  const result = read({ startDate: '2026-09-12', endDate: '2026-09-12' });
  assert.equal(result.pagination.total, 1);
  const item = result.items[0];
  assert.equal(item.externalId, external(1));
  assert.match(item.id, /^creator-source:/);
  assert.equal(item.publishedAt, null);
  assert.equal(item.publishedOn, '2026-09-12');
  assert.equal(item.dateSource, 'source_inferred_publication_date');
  assert.equal(item.sourceObservedAt, SOURCE_AT);
  assert.equal(item.lastObservedAt, null, 'work has no platform observation just because its spreadsheet refreshed');
  assert.equal(item.sourceRefreshedAt, SOURCE_AT);
  assert.equal(item.sourceTimeBasis, 'source_refresh_not_platform_observation');
  assert.equal(item.provenance.observedAt, null);
  assert.equal(item.firstSeenAt, IMPORT_AT);
  assert.equal(item.likes, 0);
  assert.equal(item.plays, null);
  assert.equal(item.comments, null);
  assert.equal(item.provenance.url, 'https://my.feishu.cn/sheets/example');
  assert.equal(result.coverage.platformComplete, false);
  assert.equal(result.coverage.sourceOnlyCount, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM post_metrics').get().n, 0);
});

test('same content ID merges provenance while platform numbers/title/time remain authoritative', t => {
  const { work, sample, read } = fixture(t);
  work(1, { plays: 999999, likes: 888888 });
  sample({ likes: 90, plays: 900 });
  const result = read();
  assert.equal(result.pagination.total, 1);
  const item = result.items[0];
  assert.equal(item.source, 'platform-and-creator-source');
  assert.equal(typeof item.id, 'number');
  assert.equal(item.caption, '平台标题');
  assert.equal(item.likes, 90);
  assert.equal(item.plays, 900);
  assert.equal(item.lastObservedAt, '2026-09-26T12:00:00.000Z');
  assert.equal(item.publishedAt, '2026-09-13T12:00:00.000Z');
  assert.equal(item.sourceCumulativeLikes, 888888);
  assert.equal(item.sourceCumulativePlays, 999999);
  assert.equal(result.coverage.sourceOnlyCount, 0);
  assert.equal(result.coverage.sourceLinkedCount, 1);
});

test('current strict author identity heals stale per-work links but excludes other authors and invalid video IDs', t => {
  const { work, read, target, db } = fixture(t);
  work(1, { targetId: target.id + 1 });
  work(2, { targetId: null });
  work(3, { handle: 'other_handle' });
  work(4, { contentId: 'not-a-video-id' });
  work(5, { handle: 'HANDLE_A' });
  const result = read();
  assert.deepEqual(result.items.map(item => item.externalId), [external(1), external(2), external(5)]);
  assert.equal(result.coverage.sourceExcludedCount, 1);
  db.prepare('UPDATE targets SET metadata_json=? WHERE id=?').run(JSON.stringify({ platform: 'douyin',
    douyinId: 'changed_handle', identityVerification: { accountId: SEC } }), target.id);
  assert.equal(read().pagination.total, 0, 'a changed public handle invalidates all source bindings');
});

test('an explicit audited author-row alias remains linked when the source primary ID differs from its current public handle', t => {
  const { db, target, work, read } = fixture(t);
  db.prepare("UPDATE creator_source_rows SET values_json=? WHERE import_id=1 AND sheet_id='08' AND row_number=2")
    .run(JSON.stringify(['来源作者', '2669213776360155']));
  db.prepare('INSERT INTO creator_source_rows VALUES(?,?,?,?)')
    .run(1, '16', 2, JSON.stringify(['2669213776360155', 'HANDLE_A']));
  work(1, { handle: '2669213776360155' });
  assert.equal(read().pagination.total, 1, 'recorded exact alias chain is usable without nickname matching');
  db.prepare('UPDATE creator_source_account_links SET matched_id=?').run('no-longer-this-target');
  assert.equal(read().pagination.total, 0, 'a stale public binding cannot silently authorize source works');
});

test('historical cutoff freezes source import version and excludes future source observations', t => {
  const { work, read, importRow } = fixture(t);
  work(1);
  assert.equal(read({ asOf: '2026-09-24T23:00:00.000Z' }).pagination.total, 0, 'source was not imported yet');
  const frozen = read();
  importRow(2, '2026-10-01T12:00:00.000Z', '2026-10-01T10:00:00.000Z');
  work(2, { importId: 2, likes: 999 });
  assert.deepEqual(read({ ...frozen.revision }).items, frozen.items, 'new import does not change old paginated read');
  assert.equal(read({ asOf: '2026-10-02T12:00:00.000Z' }).items[0].externalId, external(2));
  importRow(3, '2026-10-03T10:00:00.000Z', '2026-10-04T10:00:00.000Z');
  work(3, { importId: 3 });
  assert.equal(read({ asOf: '2026-10-03T12:00:00.000Z' }).pagination.total, 0, 'future observation not projected into past');
});

test('publication-day sorting/pagination includes source-only works; daily snapshots and work metrics stay unchanged', t => {
  const { work, sample, read } = fixture(t);
  work(1, { day: '2026-09-10' });
  work(2, { day: '2026-09-12' });
  work(3, { day: '2026-09-14' });
  sample({ index: 4 });
  const ordered = read({ sort: 'publishedAt', order: 'asc', pageSize: 2 });
  assert.deepEqual(ordered.items.map(item => item.externalId), [external(1), external(2)]);
  const next = read({ sort: 'publishedAt', order: 'asc', pageSize: 2, page: 2, ...ordered.revision });
  assert.deepEqual(next.items.map(item => item.externalId), [external(4), external(3)]);
  const daily = read({ kind: 'daily' });
  assert.equal(daily.pagination.total, 1);
  assert.equal(daily.items[0].date, '2026-09-26');
  assert.equal(daily.items[0].followers, 100);
  assert.equal(daily.items[0].followersDelta, null);
  assert.equal(read({ kind: 'workMetrics', workId: next.items[0].id }).pagination.total, 1);
});
