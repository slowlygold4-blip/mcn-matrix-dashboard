import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { buildAuthorEvidenceRequests, verifyQueuedAuthorEvidence } from '../lib/author-resolution.mjs';

const VIDEO = '7690702905876096104', SEC = 'MS4wLjABAAAANestedCommitFixture000001';
function fixture(t) {
  const database = new MonitorDatabase(':memory:'), db = database.db;
  t.after(() => { if (db.isTransaction) db.exec('ROLLBACK'); database.close(); });
  const row = { sourceRow: 682, platform: 'douyin', name: '嵌套提交作者', douyinId: 'nested_peer', videoId: VIDEO,
    status: 'resolvable', board: '外层原始归属' };
  const request = buildAuthorEvidenceRequests([row])[0];
  database.enqueueAuthorResolutions([request], { fileName: 'nested-original.xlsx', sheetName: '原表', sourceMetadata: { sourceType: 'author-spreadsheet' } });
  const claimed = database.claimDueAuthorResolutions(1, { owner: 'nested-peer-owner', leaseMs: 60_000 })[0];
  assert.ok(claimed);
  const verified = verifyQueuedAuthorEvidence(request, { key: request.key, candidates: [{ videoId: VIDEO, secUid: SEC,
    uniqueId: 'nested_peer', uid: '1234567890123456', provenance: 'authorised-browser-natural-detail' }], errors: [] });
  assert.equal(verified.status, 'ready');
  const input = { label: verified.row.name, locator: verified.row.locator, boards: verified.row.boards,
    metadata: { platform: 'douyin', resolution: verified.row.resolution } };
  const options = { owner: claimed.lease_owner, evidenceVersion: claimed.evidence_version, requireUnexpiredLease: true };
  db.exec('CREATE TABLE outer_sentinel(id INTEGER PRIMARY KEY, value TEXT)');
  const commit = overrides => database.commitAuthorResolutionTarget(claimed.id, input,
    { fileName: 'nested-original.xlsx', sheetName: '原表' }, { ...options, ...overrides });
  const current = () => db.prepare('SELECT * FROM author_resolution_queue WHERE id=?').get(claimed.id);
  const counts = () => ({ target: db.prepare('SELECT count(*) n FROM targets').get().n,
    receipt: db.prepare('SELECT count(*) n FROM author_resolution_success_receipts').get().n,
    boards: db.prepare('SELECT count(*) n FROM target_boards').get().n });
  const failLate = () => db.exec(`CREATE TEMP TRIGGER nested_receipt_failure BEFORE INSERT ON author_resolution_success_receipts
    BEGIN SELECT RAISE(ABORT, 'nested-fixture-receipt-failure'); END`);
  return { database, db, claimed, commit, current, counts, failLate };
}

test('nested commit requires a real outer transaction and never opens one implicitly', t => {
  const f = fixture(t), before = f.current(), changes = f.db.prepare('SELECT total_changes() n').get().n;
  assert.equal(f.db.isTransaction, false);
  assert.throws(() => f.commit({ withinTransaction: true }), /必须已有外层事务/);
  assert.equal(f.db.isTransaction, false); assert.deepEqual(f.current(), before);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
  assert.deepEqual(f.counts(), { target: 0, receipt: 0, boards: 0 });
});

test('successful nested target/receipt/board writes disappear with outer rollback', t => {
  const f = fixture(t), before = f.current();
  f.db.exec('BEGIN IMMEDIATE');
  f.db.prepare('INSERT INTO outer_sentinel VALUES(1,?)').run('outer-only');
  const result = f.commit({ withinTransaction: true });
  assert.equal(result.created, true); assert.equal(result.target.enabled, true);
  assert.equal(f.db.isTransaction, true); assert.equal(f.current().status, 'resolved');
  assert.deepEqual(f.counts(), { target: 1, receipt: 1, boards: 1 });
  assert.throws(() => f.db.exec('RELEASE author_target_commit'), /no such savepoint/);
  assert.equal(f.db.isTransaction, true);
  f.db.exec('ROLLBACK');
  assert.deepEqual(f.current(), before); assert.deepEqual(f.counts(), { target: 0, receipt: 0, boards: 0 });
  assert.equal(f.db.prepare('SELECT count(*) n FROM outer_sentinel').get().n, 0);
});

test('nested failure rolls back its partial writes but preserves a usable outer transaction', t => {
  const f = fixture(t), before = f.current(); f.failLate();
  f.db.exec('BEGIN IMMEDIATE'); f.db.prepare('INSERT INTO outer_sentinel VALUES(1,?)').run('keep-before');
  assert.throws(() => f.commit({ withinTransaction: true }), /nested-fixture-receipt-failure/);
  assert.equal(f.db.isTransaction, true); assert.deepEqual(f.current(), before);
  assert.deepEqual(f.counts(), { target: 0, receipt: 0, boards: 0 });
  assert.throws(() => f.db.exec('RELEASE author_target_commit'), /no such savepoint/);
  f.db.prepare('INSERT INTO outer_sentinel VALUES(2,?)').run('keep-after');
  f.db.exec('COMMIT');
  assert.deepEqual(f.db.prepare('SELECT value FROM outer_sentinel ORDER BY id').all().map(row => row.value), ['keep-before', 'keep-after']);
  f.db.exec('DROP TRIGGER nested_receipt_failure; BEGIN IMMEDIATE');
  assert.equal(f.commit({ withinTransaction: true }).created, true, 'the fixed savepoint can be reused after failure');
  f.db.exec('COMMIT'); assert.equal(f.current().status, 'resolved');
});

test('missing or stale nested claim releases only the savepoint without committing its caller', t => {
  const f = fixture(t), before = f.current();
  f.db.exec('BEGIN IMMEDIATE'); f.db.prepare('INSERT INTO outer_sentinel VALUES(1,?)').run('not-committed');
  assert.equal(f.commit({ withinTransaction: true, evidenceVersion: f.claimed.evidence_version + 1 }), null);
  assert.equal(f.db.isTransaction, true); assert.deepEqual(f.current(), before);
  assert.throws(() => f.db.exec('RELEASE author_target_commit'), /no such savepoint/);
  f.db.exec('ROLLBACK'); assert.equal(f.db.prepare('SELECT count(*) n FROM outer_sentinel').get().n, 0);
});

test('nested unexpired-lease requirement fails closed and preserves outer edits', t => {
  const f = fixture(t);
  f.db.prepare('UPDATE author_resolution_queue SET lease_until=? WHERE id=?').run('2000-01-01T00:00:00.000Z', f.claimed.id);
  const before = f.current();
  f.db.exec('BEGIN IMMEDIATE'); f.db.prepare('INSERT INTO outer_sentinel VALUES(1,?)').run('outer-survives');
  assert.equal(f.commit({ withinTransaction: true }), null);
  assert.equal(f.db.isTransaction, true); assert.deepEqual(f.current(), before);
  assert.deepEqual(f.counts(), { target: 0, receipt: 0, boards: 0 });
  f.db.exec('COMMIT'); assert.equal(f.db.prepare('SELECT count(*) n FROM outer_sentinel').get().n, 1);
});

test('nested readback failure is also rolled back before releasing the child savepoint', t => {
  const f = fixture(t), before = f.current();
  f.db.exec('BEGIN IMMEDIATE'); f.db.prepare('INSERT INTO outer_sentinel VALUES(1,?)').run('keep');
  const original = f.database.getTarget;
  f.database.getTarget = () => { throw new Error('nested-fixture-readback-failure'); };
  try { assert.throws(() => f.commit({ withinTransaction: true }), /nested-fixture-readback-failure/); }
  finally { f.database.getTarget = original; }
  assert.equal(f.db.isTransaction, true); assert.deepEqual(f.current(), before);
  assert.deepEqual(f.counts(), { target: 0, receipt: 0, boards: 0 });
  f.db.exec('COMMIT'); assert.equal(f.db.prepare('SELECT count(*) n FROM outer_sentinel').get().n, 1);
});

test('default independent transaction still commits and repeated missing claim stays a no-op', t => {
  const f = fixture(t), result = f.commit();
  assert.equal(result.created, true); assert.equal(f.db.isTransaction, false);
  assert.deepEqual(f.counts(), { target: 1, receipt: 1, boards: 1 });
  assert.equal(f.commit(), null); assert.equal(f.db.isTransaction, false);
  assert.deepEqual(f.counts(), { target: 1, receipt: 1, boards: 1 });
});

test('default independent transaction retains complete rollback on receipt failure', t => {
  const f = fixture(t), before = f.current(); f.failLate();
  assert.throws(() => f.commit(), /nested-fixture-receipt-failure/);
  assert.equal(f.db.isTransaction, false); assert.deepEqual(f.current(), before);
  assert.deepEqual(f.counts(), { target: 0, receipt: 0, boards: 0 });
});

test('default lease-expiry option semantics remain opt-in', t => {
  const f = fixture(t);
  f.db.prepare('UPDATE author_resolution_queue SET lease_until=? WHERE id=?').run('2000-01-01T00:00:00.000Z', f.claimed.id);
  assert.equal(f.commit(), null); assert.equal(f.db.isTransaction, false);
  assert.equal(f.commit({ requireUnexpiredLease: false }).created, true);
  assert.equal(f.db.isTransaction, false);
});
