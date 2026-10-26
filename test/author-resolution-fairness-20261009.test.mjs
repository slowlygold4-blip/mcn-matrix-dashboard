import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorDatabase } from '../lib/database.mjs';

const NOW = new Date('2026-10-09T16:00:00.000Z');
const PAST = '2026-10-08T00:00:00.000Z';
const FUTURE = '2026-10-10T00:00:00.000Z';
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'mcn-author-fairness-'));
  const database = new MonitorDatabase(join(directory, 'fixture.sqlite'));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const insert = database.db.prepare(`INSERT INTO author_resolution_queue
    (identity_key,name,douyin_id,account_locator,status,attempts,next_attempt_at,created_at,updated_at,
      evidence_version,file_name,video_ids_json,source_metadata_json)
    VALUES(?,?,?,?,?,?,?,?,?,1,?,'["7684617087687331118"]',?)`);
  let sequence = 0;
  const add = (account, overrides = {}) => Number(insert.run(
    overrides.key ?? `douyin:${account}|fixture-${++sequence}`, overrides.name ?? '相同昵称不作身份',
    account, overrides.locator ?? '', overrides.status ?? 'pending', overrides.attempts ?? 0,
    overrides.due ?? PAST, overrides.created ?? PAST, overrides.updated ?? PAST,
    overrides.fileName ?? '作者名单.xlsx', JSON.stringify(overrides.metadata ?? { original: true }),
  ).lastInsertRowid);
  const claim = (limit = 36, options = {}) => database.claimDueAuthorResolutions(limit,
    { owner: 'fair-worker', reference: NOW, ...options });
  return { database, add, claim, path: join(directory, 'fixture.sqlite') };
}

test('a large oldest-author backlog cannot consume a 36-item batch ahead of other identities', t => {
  const f = fixture(t);
  f.database.db.exec('BEGIN');
  for (let i = 0; i < 2200; i++) f.add('existing-heavy-author');
  for (let i = 0; i < 227; i++) f.add(`new-author-${i}`, { created: '2026-10-09T00:00:00.000Z', due: '2026-10-09T00:00:00.000Z' });
  f.database.db.exec('COMMIT');
  const originalCount = f.database.db.prepare('SELECT count(*) n FROM author_resolution_queue').get().n;
  const preview = f.database.listDueAuthorResolutions(36, NOW);
  assert.equal(preview.length, 36);
  assert.equal(new Set(preview.map(row => row.douyin_id)).size, 36);
  const rows = f.claim();
  assert.deepEqual(rows.map(row => row.id), preview.map(row => row.id));
  assert.equal(new Set(rows.map(row => row.douyin_id)).size, 36);
  assert.equal(rows.filter(row => row.douyin_id === 'existing-heavy-author').length, 1);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM author_resolution_queue').get().n, originalCount);
  assert.ok(rows.every(row => row.sourceMetadata.original && row.evidence_version === 1));
});

test('cross-batch oldest-claim rotation serves every eligible identity without starving existing ones', t => {
  const f = fixture(t), seen = new Set();
  for (let identity = 0; identity < 80; identity++) for (let work = 0; work < 6; work++) f.add(`author-${identity}`);
  for (let batch = 0; batch < 3; batch++) {
    const rows = f.claim(36, { reference: new Date(NOW.getTime() + batch * 1000) });
    assert.equal(new Set(rows.map(row => row.douyin_id)).size, rows.length);
    for (const row of rows) {
      seen.add(row.douyin_id);
      assert.equal(f.database.markAuthorResolutionRejected(row.id, 'fixture exact evidence not usable',
        { owner: 'fair-worker', evidenceVersion: row.evidence_version }), true);
    }
  }
  assert.equal(seen.size, 80, '80 finite eligible identities all receive a turn within ceil(80/36) batches');
  const again = f.claim(1, { reference: new Date(NOW.getTime() + 4000) });
  assert.equal(again.length, 1, 'identities with additional evidence continue receiving turns');
});

test('a new import touching updated_at does not pretend that a never-claimed identity was serviced', t => {
  const f = fixture(t), a = f.add('first'), b = f.add('second');
  const first = f.claim(1)[0]; assert.equal(first.id, a);
  assert.equal(f.database.markAuthorResolutionRejected(first.id, 'fixture', { owner: 'fair-worker', evidenceVersion: 1 }), true);
  f.add('first');
  f.database.db.prepare('UPDATE author_resolution_queue SET updated_at=? WHERE id=?').run(FUTURE, b);
  assert.equal(f.claim(1, { reference: new Date(NOW.getTime() + 1000) })[0].id, b);
});

test('single-item batches rotate even when several claims share the exact same clock millisecond', t => {
  const f = fixture(t), order = [];
  for (const id of ['a', 'b', 'c']) for (let work = 0; work < 4; work++) f.add(id);
  for (let turn = 0; turn < 6; turn++) {
    const row = f.claim(1)[0];
    order.push(row.douyin_id);
    assert.equal(f.database.markAuthorResolutionRejected(row.id, 'fixture terminal evidence',
      { owner: 'fair-worker', evidenceVersion: row.evidence_version }), true);
  }
  assert.deepEqual(order, ['a', 'b', 'c', 'a', 'b', 'c']);
});

test('same normalized identity leases block siblings across files and workers until expiry', t => {
  const f = fixture(t), a = f.add('  ＠ＡｕｔｈｏｒＡ  ', { fileName: '甲.xlsx' });
  f.add('authora', { fileName: '乙.xlsx' });
  const second = new MonitorDatabase(f.path); t.after(() => second.close());
  assert.equal(f.claim(1, { fileName: '甲.xlsx', leaseMs: 60_000 })[0].id, a);
  assert.deepEqual(second.claimDueAuthorResolutions(36, { owner: 'second-worker', reference: NOW, fileName: '乙.xlsx' }), []);
  const later = second.claimDueAuthorResolutions(36, { owner: 'second-worker', reference: new Date(NOW.getTime() + 61_000), fileName: '乙.xlsx' });
  assert.equal(later.length, 1);
  assert.equal(later[0].douyin_id, 'authora');
});

test('future retry backoff blocks pending siblings and exact-file force cannot bypass another file cooldown', t => {
  const f = fixture(t);
  f.add('cooling', { status: 'retry', attempts: 1, due: FUTURE, fileName: '甲.xlsx' });
  f.add('cooling', { fileName: '乙.xlsx' });
  const unrelated = f.add('not-cooling');
  assert.deepEqual(f.database.listDueAuthorResolutions(36, NOW).map(row => row.id), [unrelated]);
  assert.deepEqual(f.claim(36, { fileName: '乙.xlsx', includeNotDueRetries: true }), []);
  const forced = f.claim(36, { fileName: '甲.xlsx', includeNotDueRetries: true });
  assert.equal(forced.length, 1); assert.equal(forced[0].status, 'retry');
  assert.equal(forced[0].next_attempt_at, FUTURE, 'forced scope is a one-off eligibility override, not a backoff rewrite');
});

test('terminal statuses, excluded rows, manual suspension flags and original evidence remain unchanged', t => {
  const f = fixture(t);
  const rejected = f.add('rejected', { status: 'rejected' });
  const resolved = f.add('resolved', { status: 'resolved' });
  const excluded = f.add('excluded');
  const paused = f.add('paused');
  f.database.db.prepare('UPDATE author_resolution_queue SET suspended_target_enabled=0 WHERE id=?').run(paused);
  const before = f.database.db.prepare('SELECT * FROM author_resolution_queue ORDER BY id').all();
  const rows = f.claim(36, { excludeIds: [excluded] });
  assert.ok(rows.every(row => ![rejected, resolved, excluded].includes(row.id)));
  for (const row of before) {
    const after = f.database.db.prepare('SELECT * FROM author_resolution_queue WHERE id=?').get(row.id);
    for (const field of ['identity_key','name','douyin_id','account_locator','video_ids_json','source_metadata_json',
      'status','attempts','next_attempt_at','evidence_version','suspended_target_enabled']) assert.deepEqual(after[field], row[field]);
  }
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM targets').get().n, 0);
});

test('platforms and canonical fallbacks stay distinct and nickname never groups unrelated rows', t => {
  const f = fixture(t);
  f.add('same', { key: 'douyin:same|1' });
  f.add('same', { key: 'bilibili:same|1' });
  f.add('same', { key: 'xiaohongshu:same|1' });
  const canonical = 'MS4wLjABAAAAFairnessCanonicalFixture';
  f.add('', { key: 'douyin:unknown-one', locator: canonical });
  f.add('', { key: 'douyin:unknown-two', locator: canonical });
  f.add('', { key: 'douyin:share:opaque-A' });
  f.add('', { key: 'douyin:share:opaque-B' });
  const rows = f.claim();
  assert.equal(rows.length, 6);
  assert.equal(rows.filter(row => row.account_locator === canonical).length, 1);
});

test('dangling or malformed sibling leases fail closed and ordinary expired leases may resume', t => {
  const f = fixture(t), dangling = f.add('dangling'), malformed = f.add('malformed'), expired = f.add('expired');
  f.add('dangling'); f.add('malformed'); f.add('expired');
  f.database.db.prepare('UPDATE author_resolution_queue SET lease_owner=?,lease_until=? WHERE id=?').run('other', null, dangling);
  f.database.db.prepare('UPDATE author_resolution_queue SET lease_owner=?,lease_until=? WHERE id=?').run('other', 'not-a-date', malformed);
  f.database.db.prepare('UPDATE author_resolution_queue SET lease_owner=?,lease_until=? WHERE id=?').run('other', PAST, expired);
  assert.deepEqual(f.claim().map(row => row.douyin_id), ['expired']);
});

test('timezone-offset leases and retry dates are compared as instants, not lexicographic strings', t => {
  const f = fixture(t);
  const futureLease = f.add('offset-leased'); f.add('offset-leased');
  f.database.db.prepare('UPDATE author_resolution_queue SET lease_owner=?,lease_until=? WHERE id=?')
    .run('other', '2026-10-09T15:30:00-07:00', futureLease);
  f.add('offset-cooling', { status: 'retry', due: '2026-10-09T15:30:00-07:00' }); f.add('offset-cooling');
  const expiredLease = f.add('offset-expired');
  f.database.db.prepare('UPDATE author_resolution_queue SET lease_owner=?,lease_until=? WHERE id=?')
    .run('old', '2026-10-09T17:30:00+08:00', expiredLease);
  const elapsedRetry = f.add('offset-due', { status: 'retry', due: '2026-10-09T17:30:00+08:00' });
  const rows = f.claim();
  assert.deepEqual(new Set(rows.map(row => row.id)), new Set([expiredLease, elapsedRetry]));
  assert.ok(rows.every(row => !['offset-leased', 'offset-cooling'].includes(row.douyin_id)));
});

test('invalid due timestamps are never turned into due evidence by exact-file forced retries', t => {
  const f = fixture(t);
  f.add('broken-time', { status: 'retry', due: 'not-a-date' });
  assert.deepEqual(f.claim(), []);
  assert.deepEqual(f.claim(36, { includeNotDueRetries: true, fileName: '作者名单.xlsx' }), []);
});

test('a claim audit failure rolls back every lease instead of committing an untracked scheduling turn', t => {
  const f = fixture(t); f.add('rollback-a'); f.add('rollback-b');
  f.database.db.exec("CREATE TRIGGER stop_claim_audit BEFORE INSERT ON activity_log WHEN NEW.action='author-resolution.claimed' BEGIN SELECT RAISE(ABORT,'claim audit fixture failure'); END");
  assert.throws(() => f.claim(), /claim audit fixture failure/);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM author_resolution_queue WHERE lease_owner IS NOT NULL').get().n, 0);
});
