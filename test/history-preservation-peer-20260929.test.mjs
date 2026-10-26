import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';

const SEC = 'MS4wLjABAAAAHistoryPreservationCurrent123456';
const OLD = 'MS4wLjABAAAAHistoryPreservationPrevious12345';
const ID = '7200000000000000001';
const EARLY = '2026-09-27T02:00:00.000Z';
const LATE = '2026-09-28T02:00:00.000Z';

function fixture(t) {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const target = database.createTarget({ type: 'account', label: 'offline-history-preservation',
    locator: SEC, provider: 'public-web', metadata: { platform: 'douyin' } });
  const collection = (capturedAt, likes, caption = `observed-${likes}`, posts = true) => {
    const raw = { capturedAt, accountStatus: 'validated', worksCoverage: posts ? 'limited' : 'unavailable',
      profile: { user: { sec_uid: SEC, uid: '101010101010', follower_count: 10, total_favorited: 20, aweme_count: 1 } },
      works: { aweme_list: posts ? [{ aweme_id: ID, author: { sec_uid: SEC, uid: '101010101010' },
        desc: caption, create_time: 1789000000, statistics: { digg_count: likes, comment_count: 3 } }] : [] } };
    return normalizeCollection(target, raw, { capturedAt });
  };
  return { database, target, collection };
}

test('history peer: observing the current author must not delete retained different-author history or cascade metrics', t => {
  const { database, target, collection } = fixture(t);
  const inserted = database.db.prepare(`INSERT INTO posts(target_id,external_id,author_id,caption,first_seen_at,last_seen_at,raw_json)
    VALUES(?,? ,?,'retained source evidence',?,?,'{"source":"offline-prior-binding"}')`)
    .run(target.id, '7200000000000000099', OLD, EARLY, EARLY);
  database.db.prepare('INSERT INTO post_metrics(post_id,captured_at,likes) VALUES(?,?,12)').run(Number(inserted.lastInsertRowid), EARLY);
  const beforePost = database.db.prepare('SELECT * FROM posts WHERE id=?').get(Number(inserted.lastInsertRowid));
  const beforeMetric = database.db.prepare('SELECT * FROM post_metrics WHERE post_id=?').get(Number(inserted.lastInsertRowid));
  // Even a profile-only response currently enters the destructive branch.
  const incoming = collection(LATE, 20, 'current', false);
  incoming.targetUpdate = { label: 'must-not-apply' };
  assert.throws(() => database.saveCollection(target, null, incoming), error => error.code === 'COLLECTION_HISTORY_AUTHOR_CONFLICT');
  assert.deepEqual(database.db.prepare('SELECT * FROM posts WHERE id=?').get(Number(inserted.lastInsertRowid)), beforePost);
  assert.deepEqual(database.db.prepare('SELECT * FROM post_metrics WHERE post_id=?').get(Number(inserted.lastInsertRowid)), beforeMetric);
  assert.equal(database.getTarget(target.id).label, target.label);
  for (const table of ['snapshots', 'audits']) assert.equal(database.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
});

test('history peer: a later-arriving old sample cannot regress last_seen or replace latest post fields', t => {
  const { database, target, collection } = fixture(t);
  database.saveCollection(target, null, collection(LATE, 30, 'newer caption'));
  database.saveCollection(target, null, collection(EARLY, 10, 'older caption'));
  const post = database.db.prepare('SELECT first_seen_at,last_seen_at,likes,caption FROM posts').get();
  assert.equal(post.last_seen_at, LATE);
  assert.equal(post.likes, 30);
  assert.equal(post.caption, 'newer caption');
  assert.equal(post.first_seen_at, LATE, 'first_seen remains the first actual insertion, not inferred publication/history');
  assert.equal(database.db.prepare('SELECT count(*) n FROM post_metrics').get().n, 2, 'older metric remains historical evidence');
});

test('history peer: same-time partial replay cannot erase a known metric even before snapshot uniqueness checks', t => {
  const { database, target, collection } = fixture(t);
  database.saveCollection(target, null, collection(LATE, 30));
  const original = database.db.prepare('SELECT * FROM post_metrics').get();
  assert.throws(() => database.saveCollection(target, null, collection(LATE, null)), error => error.code === 'COLLECTION_HISTORY_METRIC_CONFLICT');
  const after = database.db.prepare('SELECT * FROM post_metrics').get();
  assert.equal(after.likes, 30);
  assert.equal(after.id, original.id, 'idempotent replay must not replace/delete the original evidence row');
});

test('history peer: same external work ID cannot silently change its known author without profile evidence', t => {
  const { database, target, collection } = fixture(t);
  database.saveCollection(target, null, collection(EARLY, 10));
  const original = database.db.prepare('SELECT * FROM posts').get();
  const raw = collection(LATE, 20).raw;
  delete raw.profile.user.sec_uid;
  raw.works.aweme_list[0].author.sec_uid = OLD;
  const incoming = normalizeCollection(target, raw, { capturedAt: LATE });
  assert.throws(() => database.saveCollection(target, null, incoming), error => error.code === 'COLLECTION_HISTORY_AUTHOR_CONFLICT');
  assert.deepEqual(database.db.prepare('SELECT * FROM posts').get(), original);
  for (const table of ['snapshots', 'post_metrics', 'audits']) assert.equal(database.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 1);
});

test('history peer: a newer valid observation still updates current fields and retains both metric rows', t => {
  const { database, target, collection } = fixture(t);
  database.saveCollection(target, null, collection(EARLY, 10, 'old'));
  database.saveCollection(target, null, collection(LATE, 30, 'new'));
  const post = database.db.prepare('SELECT first_seen_at,last_seen_at,likes,caption FROM posts').get();
  assert.deepEqual({ ...post }, { first_seen_at: EARLY, last_seen_at: LATE, likes: 30, caption: 'new' });
  assert.equal(database.db.prepare('SELECT count(*) n FROM post_metrics').get().n, 2);
});

function timedCollection(target, capturedAt, likes) {
  const raw = { capturedAt, accountStatus: 'validated', worksCoverage: 'complete',
    profile: { user: { sec_uid: SEC, uid: '101010101010', follower_count: 10, total_favorited: 20, aweme_count: 1 } },
    provenance: { worksFallback: { mode: 'douyin-authorised-browser-post-response' } },
    works: { observationVersion: 1, observedAt: LATE,
      sourceRequestStartedAt: '2026-09-28T01:59:58.000Z', sourceRequestFinishedAt: '2026-09-28T02:00:01.000Z',
      aweme_list: [{ aweme_id: ID, author: { sec_uid: SEC, uid: '101010101010' }, create_time: 1789000000,
        statistics: { digg_count: likes, comment_count: 3 } }], has_more: false, max_cursor: 0,
      pagination: { version: 1, maxPages: 3, requestedLimit: 30, requestCount: 1, collectedCount: 1,
        evidenceScope: 'browser-response-sanitized', stopReason: 'end-of-list', errorCode: null,
        pages: [{ requestCursor: 0, observedAt: LATE, rawCount: 1, acceptedCount: 1, duplicateCount: 0,
          filteredCount: 0, truncated: false, endpoint: 'https://www.douyin.com/aweme/v1/web/aweme/post/',
          response: { max_cursor: 0, has_more: false, source: 'authorised-browser' } }] } } };
  return normalizeCollection(target, raw, { capturedAt });
}

test('history peer: different profile snapshots cannot overwrite conflicting metrics at the same valid page time', t => {
  const { database, target } = fixture(t);
  database.saveCollection(target, null, timedCollection(target, EARLY, 30));
  const before = database.db.prepare('SELECT * FROM post_metrics').get();
  assert.throws(() => database.saveCollection(target, null, timedCollection(target, '2026-09-27T03:00:00.000Z', 31)),
    error => error.code === 'COLLECTION_HISTORY_METRIC_CONFLICT');
  assert.deepEqual(database.db.prepare('SELECT * FROM post_metrics').get(), before);
  assert.equal(database.db.prepare('SELECT count(*) n FROM snapshots').get().n, 1);
  assert.equal(database.db.prepare('SELECT likes FROM posts').get().likes, 30);
});

test('history peer: an identical same-page-time replay retains the metric row ID while allowing a distinct profile snapshot', t => {
  const { database, target } = fixture(t);
  database.saveCollection(target, null, timedCollection(target, EARLY, 30));
  const before = database.db.prepare('SELECT * FROM post_metrics').get();
  database.saveCollection(target, null, timedCollection(target, '2026-09-27T03:00:00.000Z', 30));
  assert.deepEqual(database.db.prepare('SELECT * FROM post_metrics').get(), before);
  assert.equal(database.db.prepare('SELECT count(*) n FROM snapshots').get().n, 2);
});
