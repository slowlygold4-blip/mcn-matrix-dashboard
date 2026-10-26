import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { inspectUpdateSla } from '../lib/update-sla.mjs';
import { BrowserWorksPagination } from '../lib/browser-works-pagination.mjs';

// All rows below are synthetic, in memory only. This verifies temporal read
// semantics, not the authenticity of a platform response or live coverage.
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,provider TEXT,enabled INTEGER);
    CREATE TABLE snapshots(id INTEGER PRIMARY KEY,target_id INTEGER,captured_at TEXT,
      followers INTEGER,total_likes INTEGER,total_posts INTEGER,hashtag_participants INTEGER,
      hashtag_views INTEGER,quality_status TEXT,account_status TEXT,works_coverage TEXT,
      source_checksum TEXT,works_observed_at TEXT);
    CREATE TABLE audits(id INTEGER PRIMARY KEY,target_id INTEGER,created_at TEXT,status TEXT,
      provider TEXT,run_id INTEGER,source_checksum TEXT);
    CREATE TABLE runs(id INTEGER PRIMARY KEY,started_at TEXT,finished_at TEXT);`);
  for (let id = 1; id <= 4; id++) {
    db.prepare('INSERT INTO targets VALUES(?,?,?,?)').run(id, 'account', 'public-web', 1);
  }
  return db;
}

function addRun(db, id, capturedAt, states) {
  const captured = Date.parse(capturedAt);
  const startedAt = new Date(captured - 1000).toISOString();
  const auditAt = new Date(captured + 1000).toISOString();
  const finishedAt = new Date(captured + 2000).toISOString();
  db.prepare('INSERT INTO runs VALUES(?,?,?)').run(id, startedAt, finishedAt);
  for (const [targetId, state] of states) {
    const rowId = id * 10 + targetId;
    const checksum = `synthetic-source-${id}-${targetId}`;
    db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?,NULL,NULL,?,?,?,?,?)')
      .run(rowId, targetId, capturedAt, 100 * id, 1000 * id, 18,
        'warning', 'available', state, checksum, capturedAt);
    db.prepare('INSERT INTO audits VALUES(?,?,?,?,?,?,?)')
      .run(rowId, targetId, auditAt, 'warning', 'public-web', id, checksum);
  }
}

const fourComplete = [1, 2, 3, 4].map(id => [id, 'complete']);
const inspect = (db, at) => inspectUpdateSla(db, { now: new Date(at), includeTargets: true });

test('same SQL reader replays old completeness after later failed works samples without deleting history', () => {
  const db = fixture();
  try {
    addRun(db, 1, '2026-09-28T18:00:00.000Z', fourComplete);
    const before = inspect(db, '2026-09-28T18:00:05.000Z');
    assert.equal(before.works.daily.complete, 4);
    addRun(db, 2, '2026-09-29T02:00:00.000Z', [[1, 'unavailable'], [2, 'retry'], [3, 'unavailable']]);
    db.exec('PRAGMA query_only=ON');
    const changesBefore = db.prepare('SELECT total_changes() n').get().n;
    const replay = inspect(db, '2026-09-28T18:00:05.000Z');
    assert.deepEqual(replay, before, 'future failures cannot rewrite the as-of result');
    const current = inspect(db, '2026-09-29T02:00:05.000Z');
    assert.deepEqual(current.works.daily.counts, { complete: 1, limited: 0, unavailable: 3, unknown: 0, missing: 0 });
    assert.equal(current.coreAccounts.daily.complete, 4, 'profile success is separate from works completeness');
    assert.equal(current.works.daily.targets.find(row => row.targetId === 4).snapshotId, 14);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM snapshots WHERE works_coverage='complete'").get().n, 4);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM snapshots').get().n, 7);
    assert.equal(db.prepare('SELECT total_changes() n').get().n, changesBefore, 'projection performs no data writes');
  } finally { db.close(); }
});

test('fresh complete evidence recovers coverage; a lower prior result is not a permanent reader regression', () => {
  const db = fixture();
  try {
    addRun(db, 1, '2026-09-28T18:00:00.000Z', fourComplete);
    addRun(db, 2, '2026-09-29T02:00:00.000Z', [[1, 'unavailable'], [2, 'unavailable'], [3, 'unavailable']]);
    assert.equal(inspect(db, '2026-09-29T02:00:05.000Z').works.daily.complete, 1);
    addRun(db, 3, '2026-09-29T06:00:00.000Z', [[1, 'complete'], [2, 'complete'], [3, 'complete']]);
    const recovered = inspect(db, '2026-09-29T06:00:05.000Z');
    assert.equal(recovered.works.daily.complete, 4);
    assert.equal(recovered.coreAccounts.daily.complete, 4);
    assert.equal(recovered.works.fresh8h.complete, 3, 'target 4 remains historical rather than invented fresh work');
    assert.equal(inspect(db, '2026-09-29T02:00:05.000Z').works.daily.complete, 1, 'later recovery does not backfill the earlier read');
  } finally { db.close(); }
});

test('a new Beijing day retains last profiles but never relabels yesterday complete works as today', () => {
  const db = fixture();
  try {
    addRun(db, 1, '2026-09-28T18:00:00.000Z', fourComplete);
    const result = inspect(db, '2026-09-29T16:00:01.000Z');
    assert.equal(result.businessDate, '2026-09-30');
    assert.equal(result.coreAccounts.daily.complete, 0);
    assert.equal(result.coreAccounts.targets[0].capturedAt, '2026-09-28T18:00:00.000Z');
    assert.deepEqual(result.works.daily.counts, { complete: 0, limited: 0, unavailable: 0, unknown: 0, missing: 4 });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM snapshots').get().n, 4);
  } finally { db.close(); }
});

function page(count, hasMore) {
  const posts = Array.from({ length: count }, (_, i) => ({ aweme_id: String(700000 + i) }));
  return { requestCursor: 0, body: { aweme_list: posts, has_more: hasMore },
    normalized: { posts, filteredCount: 0, duplicateCount: 0, locallyTruncated: false, maxCursor: 123 },
    observedAt: '2026-10-01T05:00:00.000Z' };
}

test('sub-limit inventories do not become complete by raising the limit: explicit end-of-list is required', () => {
  for (const limit of [30, 100]) {
    const finalPage = new BrowserWorksPagination({ limit });
    assert.equal(finalPage.accept(page(18, false)), true);
    assert.equal(finalPage.result(1).coverage, 'complete');
    assert.equal(finalPage.result(1).pagination.stopReason, 'end-of-list');

    const missingFlag = new BrowserWorksPagination({ limit });
    assert.equal(missingFlag.accept(page(18, undefined)), true);
    assert.equal(missingFlag.result(1).coverage, 'latest-public-window');
    assert.equal(missingFlag.result(1).pagination.stopReason, 'unknown-pagination');

    const unobserved = new BrowserWorksPagination({ limit });
    unobserved.stop('page-timeout', 'collector_error');
    assert.equal(unobserved.result(0).coverage, 'latest-public-window');
    assert.equal(unobserved.result(0).posts.length, 0);
    assert.equal(unobserved.result(0).pagination.requestCount, 0);
  }
});
