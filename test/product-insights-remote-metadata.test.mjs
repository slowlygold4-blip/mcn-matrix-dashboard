import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { recordRemoteWorkPage } from '../lib/remote-work-observation.mjs';
import { ensureRemoteWorkAttempts, reserveRemoteWorkAttempt } from '../lib/remote-work-evaluation.mjs';
import { readRemoteWorkCoverage, readVerifiedRemoteWorkPages } from '../lib/remote-work-coverage.mjs';
import { getAccountHistory } from '../lib/account-history.mjs';
import { exportPublicReplica } from '../lib/public-replica-export.mjs';
import { checksum } from '../lib/utils.mjs';

const SEC = 'MS4wLjABAAAARemoteMetadataFixture1234567', UID = '123456789';
const ID = '7300000000000000001', SECOND = '7300000000000000002';
const SOURCE = 'https://demo.douyin.wtf';
const ANCHOR = '2026-11-04T10:00:00.000Z', START = '2026-11-04T10:00:02.000Z';
const OBSERVED = '2026-11-04T10:00:03.000Z', END = '2026-11-04T10:00:04.000Z';
const PUBLISHED = '2026-09-21T14:13:22.000Z';
function fixture(t, { automatic = false, numericUid = false, missing = false } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(ANCHOR) });
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const db = database.db;
  const target = database.createTarget({ type: 'account', label: 'synthetic remote metadata', provider: 'public-web', locator: SEC });
  const raw = { capturedAt: ANCHOR, accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: SEC, uid: UID, follower_count: 12, total_favorited: 33, aweme_count: 3 } },
    worksCoverage: 'unavailable', worksErrorCode: 'deferred', works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
      profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/', accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  database.saveCollection(target, null, normalizeCollection(target, raw, { capturedAt: ANCHOR }));
  const anchorId = db.prepare('SELECT MAX(id) n FROM snapshots').get().n;
  let attempt = null;
  if (automatic) {
    ensureRemoteWorkAttempts(db);
    attempt = reserveRemoteWorkAttempt(db, { targetId: target.id, sourceOrigin: SOURCE,
      startsOn: '2026-11-04', endsOn: '2026-11-10', now: ANCHOR });
  }
  const receipt = { source: SOURCE, httpStatus: 200, requestStartedAt: START, requestFinishedAt: END,
    meta: { endpoint: 'douyin.author_posts', cached: false, request_id: 'metadata-first', guest_fallback: true },
    data: { has_more: false, cursor: null, items: [ID, SECOND].map((id, index) => ({
      content_id: id, platform: 'douyin', title: missing ? '' : `原证据标题${index + 1}`,
      created_at: missing ? null : PUBLISHED, fetched_at: index ? END : OBSERVED,
      author: { sec_uid: SEC, uid: numericUid ? UID : SEC, nickname: 'synthetic' },
      is_deleted: false, is_private: false,
      stats: { digg_count: index ? 0 : 1988, comment_count: null, share_count: 1, collect_count: 2, play_count: null },
    })) } };
  t.mock.timers.setTime(Date.parse(END));
  recordRemoteWorkPage(db, { targetId: target.id, receipt }, { now: Date.parse(END),
    ...(attempt ? { attemptId: attempt.id, requestCount: 4 } : {}) });
  const history = (options = {}) => getAccountHistory(db, target.id, { kind: 'works', asOf: END, pageSize: 100, ...options });
  return { db, database, target, anchorId, receipt, history, attempt };
}
function assertRestored(f, result = f.history()) {
  assert.equal(result.items.length, 2);
  for (const work of result.items) {
    assert.match(work.caption, /^原证据标题[12]$/);
    assert.equal(work.publishedAt, PUBLISHED);
    assert.equal(work.url, `https://www.douyin.com/video/${work.externalId}`);
    assert.equal(work.comments, null); assert.equal(work.plays, null);
    assert.equal(work.likes, work.externalId === ID ? 1988 : 0);
  }
}
function assertUnknown(f) {
  const items = f.history().items;
  assert.equal(items.length, 2);
  for (const item of items) assert.deepEqual([item.caption, item.publishedAt, item.url], [null, null, null]);
}
function mutateFacts(db, change) {
  const row = db.prepare("SELECT * FROM account_events WHERE event_type='remote-work-observation' ORDER BY id DESC LIMIT 1").get();
  const raw = JSON.parse(row.raw_json), event = JSON.parse(row.event_json); change(raw);
  db.prepare('UPDATE account_events SET raw_json=?,event_json=?,source_checksum=? WHERE id=?')
    .run(JSON.stringify(raw), JSON.stringify({ ...raw, anchorSnapshotId: event.anchorSnapshotId, anchorChecksum: event.anchorChecksum }), checksum(raw), row.id);
}

test('manual and automatic remote pages restore exact metadata for both proved UID representations without writes', async t => {
  for (const automatic of [false, true]) for (const numericUid of [false, true]) await t.test(`${automatic}:${numericUid}`, st => {
    const f = fixture(st, { automatic, numericUid });
    const eventsBefore = f.db.prepare('SELECT * FROM account_events ORDER BY id').all();
    const changes = f.db.prepare('SELECT total_changes() n').get().n;
    assertRestored(f);
    const replica = exportPublicReplica(f.db, { asOf: END });
    const works = replica.partitions.find(part => part.path === `works/${f.target.id}.json`).items;
    assertRestored(f, { items: works });
    assert.ok(works.every(work => work.publicationDateBasis === 'platform-timestamp'));
    assert.deepEqual(readRemoteWorkCoverage(f.db, { since: ANCHOR, now: END }), [{ targetId: f.target.id, observedAt: END, coverage: 'limited' }]);
    assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
    assert.deepEqual(f.db.prepare('SELECT * FROM account_events ORDER BY id').all(), eventsBefore);
  });
});

test('a newer title never leaks into an older cutoff; iterator retains all proved instants', t => {
  const f = fixture(t), first = f.history();
  const receipt = structuredClone(f.receipt);
  receipt.meta.request_id = 'metadata-second';
  receipt.requestStartedAt = '2026-11-04T10:01:02.000Z'; receipt.requestFinishedAt = '2026-11-04T10:01:04.000Z';
  for (const item of receipt.data.items) { item.fetched_at = receipt.requestFinishedAt; item.title = '未来新标题'; item.created_at = '2026-10-01T01:00:00.000Z'; item.stats.digg_count += 1; }
  t.mock.timers.setTime(Date.parse(receipt.requestFinishedAt));
  recordRemoteWorkPage(f.db, { targetId: f.target.id, receipt }, { now: Date.parse(receipt.requestFinishedAt) });
  assert.deepEqual(f.history().items, first.items);
  assert.ok(f.history({ asOf: receipt.requestFinishedAt }).items.every(item => item.caption === '未来新标题'));
  const pages = [...readVerifiedRemoteWorkPages(f.db, { since: ANCHOR, now: receipt.requestFinishedAt, targetIds: [f.target.id], anchorSnapshotMaxId: f.anchorId })];
  assert.equal(pages.length, 2);
  assert.deepEqual(readRemoteWorkCoverage(f.db, { since: ANCHOR, now: receipt.requestFinishedAt }), [{ targetId: f.target.id, observedAt: receipt.requestFinishedAt, coverage: 'limited' }]);
});

test('metadata recovery refuses invalid checksum, identity, observation, vector, anchor or future commit', async t => {
  const cases = [
    ['raw digest', f => f.db.exec("UPDATE account_events SET source_checksum='invalid'")],
    ['event facts digest', f => f.db.exec("UPDATE account_events SET event_json='{}'")],
    ['author identity', f => mutateFacts(f.db, raw => { raw.posts[0].author.uid = '999999999'; })],
    ['work identity', f => mutateFacts(f.db, raw => { raw.posts[0].content_id = '7300000000000000099'; })],
    ['observation time', f => mutateFacts(f.db, raw => { raw.posts[0].sourceObservation.fetchedAt = START; })],
    ['counter vector', f => f.db.exec('UPDATE post_metrics SET comments=99')],
    ['anchor checksum', f => f.db.exec("UPDATE snapshots SET source_checksum='invalid'")],
    ['anchor raw', f => f.db.exec("UPDATE snapshots SET raw_json='{}'")],
    ['anchor audit', f => f.db.exec("UPDATE audits SET status='rejected'")],
    ['future evidence commit', f => f.db.exec("UPDATE account_events SET created_at='2026-11-04T10:00:05.000Z'")],
  ];
  for (const [name, mutate] of cases) await t.test(name, st => { const f = fixture(st); mutate(f); assertUnknown(f); });
});

test('automatic metadata requires the same successful bound attempt as coverage', async t => {
  for (const sql of ["UPDATE remote_work_attempts SET status='failed',error_code='network_error',post_count=0,event_key=NULL", "UPDATE remote_work_attempts SET event_key='wrong'", "UPDATE remote_work_attempts SET finished_at='2026-11-04T10:00:05.000Z'"]) await t.test(sql, st => {
    const f = fixture(st, { automatic: true }); f.db.exec(sql); assertUnknown(f);
  });
});

test('snapshot cap, target filtering and future observation remain enforced in the shared reader', t => {
  const f = fixture(t), revision = f.history().revision;
  assertUnknown({ history: () => f.history({ ...revision, snapshotMaxId: f.anchorId - 1 }) });
  assert.equal([...readVerifiedRemoteWorkPages(f.db, { since: ANCHOR, now: END, targetIds: [], anchorSnapshotMaxId: f.anchorId })].length, 0);
  assert.equal([...readVerifiedRemoteWorkPages(f.db, { since: ANCHOR, now: END, targetIds: [999], anchorSnapshotMaxId: f.anchorId })].length, 0);
  assert.equal([...readVerifiedRemoteWorkPages(f.db, { since: ANCHOR, now: OBSERVED, targetIds: [f.target.id] })].length, 0);
  assert.throws(() => [...readVerifiedRemoteWorkPages(f.db, { since: ANCHOR, now: END, targetIds: [f.target.id, f.target.id] })]);
  assert.throws(() => [...readVerifiedRemoteWorkPages(f.db, { since: ANCHOR, now: END, anchorSnapshotMaxId: -1 })]);
});

test('disabled historical target retains metadata while rolling coverage still excludes it', t => {
  const f = fixture(t); f.db.exec('UPDATE targets SET enabled=0');
  assertRestored(f); assert.deepEqual(readRemoteWorkCoverage(f.db, { since: ANCHOR, now: END }), []);
});

test('missing source metadata stays missing and a future publication is never projected', t => {
  const f = fixture(t, { missing: true });
  assert.ok(f.history().items.every(item => item.caption === null && item.publishedAt === null && item.plays === null));
  mutateFacts(f.db, raw => { for (const item of raw.posts) item.created_at = '2026-12-01T00:00:00.000Z'; });
  assertUnknown(f);
});
