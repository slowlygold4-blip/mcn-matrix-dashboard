import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { ensureRemoteWorkAttempts, reserveRemoteWorkAttempt, finishRemoteWorkAttempt, REMOTE_WORK_EVALUATION_ORIGIN } from '../lib/remote-work-evaluation.mjs';

const NOW = '2026-11-04T15:59:00.000Z', KEY = 'a'.repeat(64);
function fixture(t, file = ':memory:') {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const database = new MonitorDatabase(file); t.after(() => database.close());
  const target = database.createTarget({ type: 'account', label: 'synthetic', provider: 'public-web', locator: 'MS4wLjABAAAARemoteEvaluation1234567' });
  const db = database.db;
  const fresh = (at = NOW) => {
    t.mock.timers.setTime(Date.parse(at));
    const raw = { capturedAt: at, accountStatus: 'validated', accountError: null,
      profile: { user: { sec_uid: target.locator, uid: '123456789', follower_count: 12, total_favorited: 33, aweme_count: 3 } },
      worksCoverage: 'unavailable', worksErrorCode: 'deferred', works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
      provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile', profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/', accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
    database.saveCollection(target, null, normalizeCollection(target, raw, { capturedAt: at }));
  };
  fresh(); ensureRemoteWorkAttempts(db);
  const input = { targetId: target.id, sourceOrigin: REMOTE_WORK_EVALUATION_ORIGIN, startsOn: '2026-11-04', endsOn: '2026-11-10', now: NOW };
  return { database, db, target, input, fresh, reserve: changes => reserveRemoteWorkAttempt(db, { ...input, ...changes }) };
}
const count = db => db.prepare('SELECT count(*) n FROM remote_work_attempts').get().n;
const protectedRows = db => JSON.stringify(['targets', 'snapshots', 'audits', 'posts', 'post_metrics', 'account_events'].map(name => db.prepare(`SELECT * FROM ${name} ORDER BY id`).all()));
const success = { status: 'success', postCount: 4, requestCount: 4, eventKey: KEY, now: '2026-11-04T15:59:05.000Z' };

test('reserve is durable before transport, exact-anchor bound and one per Beijing day without touching business rows', t => {
  const f = fixture(t), before = protectedRows(f.db); ensureRemoteWorkAttempts(f.db);
  const attempt = f.reserve();
  assert.equal(attempt.target_id, f.target.id); assert.equal(attempt.source, REMOTE_WORK_EVALUATION_ORIGIN);
  assert.equal(attempt.status, 'running'); assert.equal(attempt.day, '2026-11-04'); assert.equal(attempt.started_at, NOW);
  assert.equal(attempt.finished_at, null); assert.equal(attempt.request_count, 0); assert.equal(attempt.post_count, 0);
  assert.equal(attempt.anchor.secUid, f.target.locator); assert.ok(attempt.anchor.snapshotId > 0);
  assert.equal(f.reserve(), null); assert.equal(count(f.db), 1); assert.equal(protectedRows(f.db), before);
});

test('seven inclusive Beijing days are bounded; no work before/after window and midnight gets a distinct reservation', t => {
  const f = fixture(t);
  assert.equal(f.reserve({ startsOn: '2026-11-05', endsOn: '2026-11-11' }), null);
  assert.equal(f.reserve({ startsOn: '2026-10-29', endsOn: '2026-11-03' }), null);
  const first = f.reserve();
  assert.equal(f.reserve({ now: Date.parse('2026-11-04T16:00:00.000Z') }), null, 'an active pre-midnight request cannot overlap the next day');
  const second = f.reserve({ now: Date.parse('2026-11-04T16:01:00.000Z') });
  assert.equal(first.day, '2026-11-04'); assert.equal(second.day, '2026-11-05'); assert.notEqual(first.id, second.id);
  assert.equal(f.db.prepare('SELECT status FROM remote_work_attempts WHERE id=?').get(first.id).status, 'running');
  f.fresh('2026-11-10T12:00:00.000Z');
  assert.equal(f.reserve({ now: '2026-11-10T12:00:00.000Z' }).day, '2026-11-10');
  assert.equal(f.reserve({ now: '2026-11-10T16:00:00.000Z' }), null);
});

test('invalid configuration cannot extend evaluation or approve a lookalike source', async t => {
  const invalid = [
    { endsOn: '2026-11-11' }, { startsOn: '2026-11-05', endsOn: '2026-11-04' }, { startsOn: '2026-02-30' },
    { startsOn: '2026-11-4' }, { endsOn: null }, { targetId: 0 }, { targetId: '1' },
    { sourceOrigin: 'https://demo.douyin.wtf/' }, { sourceOrigin: 'https://demo.douyin.wtf.evil.invalid' },
    { sourceOrigin: 'http://demo.douyin.wtf' }, { sourceOrigin: 'https://user:pass@demo.douyin.wtf' },
    { sourceOrigin: 'https://demo.douyin.wtf:443' }, { now: NaN }, { now: '2026-11-04T15:59:00Z' }, { now: null },
  ];
  for (const patch of invalid) await t.test(JSON.stringify(patch), st => {
    const f = fixture(st); assert.throws(() => f.reserve(patch), { code: 'REMOTE_WORK_EVALUATION_INVALID' }); assert.equal(count(f.db), 0);
  });
});

test('paused, non-account, wrong-provider/platform, stale or broken identity anchors never reserve', async t => {
  const mutations = [
    db => db.exec('UPDATE targets SET enabled=0'),
    db => db.exec("UPDATE targets SET type='hashtag'"),
    db => db.exec("UPDATE targets SET provider='manual'"),
    db => db.exec(`UPDATE targets SET metadata_json='{"platform":"bilibili"}'`),
    db => db.exec("UPDATE targets SET locator='MS4wLjABAAAAOtherIdentity1234567'"),
    db => db.exec("UPDATE snapshots SET source_checksum='broken'"),
    db => db.exec("UPDATE audits SET status='rejected'"),
  ];
  for (const [i, mutate] of mutations.entries()) await t.test(String(i), st => {
    const f = fixture(st); mutate(f.db); assert.equal(f.reserve(), null); assert.equal(count(f.db), 0);
  });
  const f = fixture(t); assert.equal(f.reserve({ now: '2026-11-05T00:00:00.001Z' }), null);
  assert.equal(f.reserve({ targetId: 999999 }), null); assert.equal(count(f.db), 0);
});

test('cross-connection duplicate reservation remains blocked after restart and SQL uniqueness is enforced', t => {
  const dir = mkdtempSync(join(tmpdir(), 'mcn-evaluation-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'fixture.sqlite'), f = fixture(t, path), first = f.reserve();
  const secondDb = new DatabaseSync(path); t.after(() => secondDb.close());
  assert.equal(reserveRemoteWorkAttempt(secondDb, f.input), null);
  assert.throws(() => secondDb.prepare(`INSERT INTO remote_work_attempts(id,target_id,source,day,started_at,status) VALUES(?,?,?,?,?,'running')`)
    .run('another-id', first.target_id, first.source, first.day, first.started_at), /UNIQUE constraint failed/);
  assert.equal(count(secondDb), 1);
});

test('reserve refuses a caller transaction without committing or rolling it back', t => {
  const f = fixture(t); f.db.exec('BEGIN'); f.db.exec("UPDATE targets SET label='caller-owned'");
  assert.throws(() => f.reserve(), { code: 'REMOTE_WORK_EVALUATION_INVALID' }); assert.equal(f.db.isTransaction, true);
  assert.equal(f.db.prepare('SELECT label FROM targets').get().label, 'caller-owned'); f.db.exec('ROLLBACK'); assert.equal(count(f.db), 0);
});

test('finish success includes all HTTP requests, is idempotent and immutable, and cannot invent empty success', t => {
  const f = fixture(t), attempt = f.reserve(), before = protectedRows(f.db);
  const saved = finishRemoteWorkAttempt(f.db, attempt.id, success);
  assert.equal(saved.status, 'success'); assert.equal(saved.request_count, 4); assert.equal(saved.event_key, KEY);
  assert.equal(saved.finished_at, success.now);
  assert.deepEqual(finishRemoteWorkAttempt(f.db, attempt.id, { ...success, now: '2026-11-04T16:00:00.000Z' }), saved);
  assert.throws(() => finishRemoteWorkAttempt(f.db, attempt.id, { ...success, postCount: 3 }), { code: 'REMOTE_WORK_EVALUATION_INVALID' });
  assert.equal(protectedRows(f.db), before); assert.equal(f.reserve(), null);
  for (const patch of [{ postCount: 0 }, { requestCount: 0 }, { requestCount: 5 }, { eventKey: null }, { errorCode: 'blocked' }, { now: '2026-11-04T15:58:59.999Z' }])
    assert.throws(() => finishRemoteWorkAttempt(f.db, attempt.id, { ...success, ...patch }), { code: 'REMOTE_WORK_EVALUATION_INVALID' });
});

test('finish participates in the receipt transaction and a rollback preserves running reservation', t => {
  const f = fixture(t), attempt = f.reserve(); f.db.exec('BEGIN IMMEDIATE');
  finishRemoteWorkAttempt(f.db, attempt.id, success); assert.equal(f.db.isTransaction, true);
  assert.equal(f.db.prepare('SELECT status FROM remote_work_attempts').get().status, 'success');
  f.db.exec('ROLLBACK'); assert.equal(f.db.prepare('SELECT status FROM remote_work_attempts').get().status, 'running');
  assert.equal(f.reserve(), null); f.db.exec('BEGIN IMMEDIATE'); finishRemoteWorkAttempt(f.db, attempt.id, success); f.db.exec('COMMIT');
  assert.equal(f.db.prepare('SELECT status FROM remote_work_attempts').get().status, 'success');
});

test('denial, rate limit, login and circuit failures stop the approved source/target across changed windows', async t => {
  for (const errorCode of ['http_403', 'HTTP_429', 'HTTP403', '401', 'login_required', 'IDENTITY_LOGIN_REQUIRED', 'blocked', 'rate_limited', 'ENDPOINT_CIRCUIT_OPEN']) await t.test(errorCode, st => {
    const f = fixture(st), attempt = f.reserve();
    const saved = finishRemoteWorkAttempt(f.db, attempt.id, { status: 'failed', errorCode, requestCount: 3, now: success.now });
    assert.equal(saved.status, 'stopped'); assert.equal(saved.post_count, 0); assert.equal(saved.event_key, null);
    f.fresh('2026-11-05T10:00:00.000Z');
    assert.equal(f.reserve({ now: '2026-11-05T10:00:00.000Z', startsOn: '2026-11-05', endsOn: '2026-11-11' }), null);
    assert.equal(count(f.db), 1);
  });
});

test('transient failure uses this day budget but permits another day; invalid finish preserves running', t => {
  const f = fixture(t), attempt = f.reserve();
  for (const patch of [{ status: 'running' }, { errorCode: 'secret\ntext' }, { postCount: 1 }, { eventKey: KEY }, { requestCount: -1 }, { requestCount: 1.5 }])
    assert.throws(() => finishRemoteWorkAttempt(f.db, attempt.id, { status: 'failed', errorCode: 'network_error', requestCount: 1, now: success.now, ...patch }), { code: 'REMOTE_WORK_EVALUATION_INVALID' });
  assert.equal(f.db.prepare('SELECT status FROM remote_work_attempts').get().status, 'running');
  const saved = finishRemoteWorkAttempt(f.db, attempt.id, { status: 'failed', errorCode: 'network_error', requestCount: 1, now: success.now });
  assert.equal(saved.status, 'failed'); assert.equal(f.reserve(), null);
  f.fresh('2026-11-05T10:00:00.000Z'); assert.equal(f.reserve({ now: '2026-11-05T10:00:00.000Z' }).day, '2026-11-05');
});
