import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { initializeWorksOnlyObservations, readWorksOnlyAnchor, recordWorksOnlyObservation, validateWorksOnlyEvidence } from '../lib/works-only-observation.mjs';

const SEC = 'MS4wLjABAAAAWorksStorageFixture1234567', UID = '123456789';
const ANCHOR = '2026-09-28T23:59:00.000Z', START = '2026-09-29T00:00:00.000Z';
const FIRST = '2026-09-29T00:00:01.000Z', LAST = '2026-09-29T00:00:02.000Z', FINISH = '2026-09-29T00:00:03.000Z';
const post = (id, likes = id) => ({ aweme_id: String(7200000000000000000n + BigInt(id)), author: { sec_uid: SEC, uid: UID }, statistics: { digg_count: likes } });

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(ANCHOR) });
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const db = database.db;
  const target = database.createTarget({ type: 'account', label: 'offline', provider: 'public-web', locator: SEC });
  const raw = { capturedAt: ANCHOR, accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: SEC, uid: UID, follower_count: 12, total_favorited: 33, aweme_count: 2 } },
    worksCoverage: 'unavailable', worksErrorCode: 'deferred', works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
      profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/', accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  database.saveCollection(target, null, normalizeCollection(target, raw, { capturedAt: ANCHOR }));
  t.mock.timers.setTime(Date.parse(START));
  const anchor = readWorksOnlyAnchor(db, target.id);
  const input = { targetId: target.id, runId: database.beginRun('works-only', target.id, 1), anchorSnapshotId: anchor.snapshotId,
    anchorChecksum: anchor.sourceChecksum, requestStartedAt: START, requestFinishedAt: FINISH, requestedLimit: 30,
    result: { status: 'ok', posts: [post(1), post(2)], hasMore: false, maxCursor: 0,
      pagination: { version: 1, maxPages: 3, requestCount: 2, collectedCount: 2, errorCode: null, stopReason: 'end-of-list',
        pages: [
          { requestCursor: 0, response: { max_cursor: 10, has_more: true }, rawCount: 1, acceptedCount: 1, duplicateCount: 0, filteredCount: 0, truncated: false, observedAt: FIRST },
          { requestCursor: 10, response: { max_cursor: 0, has_more: false }, rawCount: 1, acceptedCount: 1, duplicateCount: 0, filteredCount: 0, truncated: false, observedAt: LAST },
        ] } } };
  const save = () => recordWorksOnlyObservation(db, input, { now: Date.parse(FINISH) });
  return { database, db, target, anchor, input, save };
}
const protectedRows = db => JSON.stringify(Object.fromEntries(['targets', 'snapshots', 'audits'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])));

test('works storage: two actual page times reach metrics atomically, without fresh profile/target/audit', t => {
  const f = fixture(t); const before = protectedRows(f.db);
  assert.deepEqual(Object.keys(f.anchor).sort(), ['capturedAt', 'secUid', 'snapshotId', 'sourceChecksum', 'uid']);
  assert.equal(f.save().coverage, 'limited');
  assert.equal(protectedRows(f.db), before);
  const metrics = f.db.prepare('SELECT p.external_id,pm.captured_at,pm.likes FROM post_metrics pm JOIN posts p ON p.id=pm.post_id ORDER BY p.external_id').all();
  assert.deepEqual(metrics.map(x => [x.external_id, x.captured_at, x.likes]), [[post(1).aweme_id, FIRST, 1], [post(2).aweme_id, LAST, 2]]);
  assert.equal(f.save().duplicate, true);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM post_metrics').get().n, 2);
  const row = f.db.prepare('SELECT * FROM works_observations').get();
  assert.equal(row.run_id, f.input.runId);
  assert.equal(validateWorksOnlyEvidence(JSON.parse(row.raw_json), { now: Date.parse(FINISH) }).runId, f.input.runId);
});

test('works storage: unknown, wrong, finished or out-of-window runs cannot write any table', async t => {
  for (const [name, change] of [
    ['missing', f => { delete f.input.runId; }], ['unknown', f => { f.input.runId = 9000; }],
    ['wrong trigger', f => f.db.exec("UPDATE runs SET trigger_type='manual'")],
    ['wrong target', f => f.db.exec('UPDATE runs SET target_id=NULL')],
    ['batch run', f => f.db.exec('UPDATE runs SET target_count=2')],
    ['finished', f => f.db.prepare("UPDATE runs SET status='success',finished_at=?").run(FINISH)],
    ['late start', f => f.db.prepare('UPDATE runs SET started_at=?').run(LAST)],
  ]) await t.test(name, st => {
    const f = fixture(st); change(f); const before = protectedRows(f.db);
    assert.throws(f.save, { code: 'WORKS_OBSERVATION_INVALID' });
    assert.equal(protectedRows(f.db), before);
    for (const table of ['posts', 'post_metrics', 'works_observations']) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  });
});

test('works storage: same-time conflicting metric rolls back new posts and the new ledger', t => {
  const f = fixture(t); f.save();
  const before = JSON.stringify(['posts', 'post_metrics', 'works_observations'].map(table => f.db.prepare(`SELECT * FROM ${table}`).all()));
  f.input.runId = f.database.beginRun('works-only', f.target.id, 1);
  f.input.requestFinishedAt = '2026-09-29T00:00:04.000Z';
  f.input.result.posts = [post(3), post(2, 999)];
  assert.throws(() => recordWorksOnlyObservation(f.db, f.input, { now: Date.parse(f.input.requestFinishedAt) }));
  assert.equal(JSON.stringify(['posts', 'post_metrics', 'works_observations'].map(table => f.db.prepare(`SELECT * FROM ${table}`).all())), before);
});

test('works storage: retained other-author history is never deleted or cascaded', t => {
  const f = fixture(t);
  const old = f.db.prepare('INSERT INTO posts(target_id,external_id,author_id,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)')
    .run(f.target.id, post(9).aweme_id, 'MS4wLjABAAAAOtherAuthor123456789', ANCHOR, ANCHOR);
  f.db.prepare('INSERT INTO post_metrics(post_id,captured_at,likes) VALUES(?,?,9)').run(Number(old.lastInsertRowid), ANCHOR);
  const before = JSON.stringify(['posts', 'post_metrics'].map(table => f.db.prepare(`SELECT * FROM ${table}`).all()));
  assert.throws(f.save);
  assert.equal(JSON.stringify(['posts', 'post_metrics'].map(table => f.db.prepare(`SELECT * FROM ${table}`).all())), before);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM works_observations').get().n, 0);
});

test('works storage: late older page preserves newest fields and first_seen while adding historical metrics', t => {
  const f = fixture(t); f.save();
  const original = f.db.prepare('SELECT * FROM posts ORDER BY id').all();
  f.input.runId = f.database.beginRun('works-only', f.target.id, 1);
  f.input.requestFinishedAt = '2026-09-29T00:00:00.900Z';
  f.input.result.pagination.pages[0].observedAt = '2026-09-29T00:00:00.100Z';
  f.input.result.pagination.pages[1].observedAt = '2026-09-29T00:00:00.200Z';
  f.input.result.posts[0].statistics.digg_count = 50;
  recordWorksOnlyObservation(f.db, f.input, { now: Date.parse(FINISH) });
  assert.deepEqual(f.db.prepare('SELECT * FROM posts ORDER BY id').all(), original);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM post_metrics').get().n, 4);
});

test('works storage: unavailable append does not write or erase works, profile or audit', t => {
  const f = fixture(t); const before = protectedRows(f.db);
  f.input.result = { status: 'unavailable', posts: [], errorCode: 'blocked' };
  const result = f.save();
  assert.equal(result.observedAt, null);
  assert.equal(protectedRows(f.db), before);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM posts').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM post_metrics').get().n, 0);
});

test('works storage: public caption and actual publication time survive without inventing missing dates', t => {
  const f = fixture(t);
  f.input.result.posts[0].desc = '标题'.repeat(1500);
  f.input.result.posts[0].create_time = Math.floor(Date.parse(ANCHOR) / 1000);
  f.input.result.posts[1].create_time = null;
  f.save();
  const rows = f.db.prepare('SELECT caption,published_at FROM posts ORDER BY external_id').all();
  assert.equal(rows[0].caption.length, 2000); assert.equal(rows[0].published_at, ANCHOR);
  assert.equal(rows[1].published_at, null);
  const raw = JSON.parse(f.db.prepare('SELECT raw_json FROM works_observations').get().raw_json);
  assert.equal(validateWorksOnlyEvidence(raw, { now: Date.parse(FINISH) }).posts[0].desc.length, 2000);
});

test('works storage: publication must predate its own page, not merely the final page', t => {
  const f = fixture(t); f.input.result.posts[0].create_time = Date.parse(LAST) / 1000;
  assert.throws(f.save, { code: 'WORKS_OBSERVATION_INVALID' });
  for (const table of ['posts', 'post_metrics', 'works_observations']) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
});

test('works storage: one real run cannot append multiple attempts', t => {
  const f = fixture(t); f.save();
  f.input.requestFinishedAt = '2026-09-29T00:00:04.000Z';
  assert.throws(() => recordWorksOnlyObservation(f.db, f.input, { now: Date.parse(f.input.requestFinishedAt) }), { code: 'WORKS_OBSERVATION_INVALID' });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM works_observations').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM post_metrics').get().n, 2);
});

test('works storage: projected attempted lane persists bounded cooldown evidence without credentials', t => {
  const f = fixture(t);
  f.input.worksRequestPolicy = { version: 1, endpoint: 'douyin.author_posts', scope: 'endpoint-transport',
    cookie: 'SECRET', browser: { transport: 'authorised-browser', attempted: true, deferred: false, errorCode: null,
      nextEligibleAt: null, headers: { Authorization: 'SECRET' } } };
  f.save();
  const raw = f.db.prepare('SELECT raw_json FROM works_observations').get().raw_json;
  assert.equal(raw.includes('SECRET'), false);
  const evidence = validateWorksOnlyEvidence(JSON.parse(raw), { now: Date.parse(FINISH) });
  assert.equal(evidence.worksRequestPolicy.browser.attempted, true);
});

test('works storage: deferred policy cannot pretend a real works-only request was attempted', t => {
  const f = fixture(t);
  f.input.worksRequestPolicy = { version: 1, endpoint: 'douyin.author_posts', scope: 'endpoint-transport',
    browser: { transport: 'authorised-browser', attempted: false, deferred: true, errorCode: 'blocked' } };
  assert.throws(f.save, { code: 'WORKS_OBSERVATION_INVALID' });
});

test('works storage: upgrading an experimental no-run ledger preserves rows without fabricating run evidence', t => {
  const f = fixture(t); f.save();
  const row = { ...f.db.prepare('SELECT * FROM works_observations').get() };
  const legacySql = f.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='works_observations'").get().sql
    .replace('run_id INTEGER NOT NULL REFERENCES runs(id),', '');
  delete row.run_id;
  f.db.exec('DROP TABLE works_observations');
  f.db.exec(legacySql);
  const columns = Object.keys(row);
  f.db.prepare(`INSERT INTO works_observations(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(key => row[key]));
  initializeWorksOnlyObservations(f.db);
  const restored = f.db.prepare('SELECT * FROM works_observations').get();
  assert.equal(restored.run_id, null, 'migration must not infer a run from coincident timestamps');
  assert.deepEqual(Object.fromEntries(columns.map(key => [key, restored[key]])), row);
  assert.throws(() => f.db.exec('DELETE FROM works_observations'), /immutable/);
});
