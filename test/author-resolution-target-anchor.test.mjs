import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { buildAuthorEvidenceRequests, verifyQueuedAuthorEvidence } from '../lib/author-resolution.mjs';

const VIDEO = '7690702905876096104';
const ACCOUNT = 'MS4wLjABAAAAExistingAnchorFixture0001';
const OTHER = 'MS4wLjABAAAAOtherAnchorFixture0000002';

function fixture(t, anchor) {
  const database = new MonitorDatabase(':memory:');
  const db = database.db;
  t.after(() => { if (db.isTransaction) db.exec('ROLLBACK'); database.close(); });
  const target = database.createTarget({ type: 'account', provider: 'public-web', label: '用户命名', locator: ACCOUNT,
    metadata: { platform: 'douyin', douyinId: 'anchor_peer', note: '用户原始资料',
      identityVerification: { accountId: anchor, verifiedAt: '2026-10-01T00:00:00.000Z' } } });
  const request = buildAuthorEvidenceRequests([{ name: '来源作者', douyinId: 'anchor_peer', videoId: VIDEO,
    sourceRow: 2, boards: ['团团'] }])[0];
  database.enqueueAuthorResolutions([request], { fileName: '原始来源.xlsx', sheetName: '08' });
  const claim = database.claimDueAuthorResolutions(1, { owner: 'anchor-guard-test', leaseMs: 60_000 })[0];
  assert.ok(claim);
  const verified = verifyQueuedAuthorEvidence(request, { key: request.key,
    candidates: [{ videoId: VIDEO, secUid: ACCOUNT, uniqueId: 'anchor_peer', uid: '1234567890123456',
      provenance: 'authorised-browser-natural-detail' }], errors: [] });
  assert.equal(verified.status, 'ready');
  const input = { label: verified.row.name, locator: verified.row.locator, boards: verified.row.boards,
    metadata: { platform: 'douyin', douyinId: 'anchor_peer', resolution: verified.row.resolution } };
  const options = { owner: claim.lease_owner, evidenceVersion: claim.evidence_version, requireUnexpiredLease: true };
  const readQueue = () => db.prepare('SELECT * FROM author_resolution_queue WHERE id=?').get(claim.id);
  const readTarget = () => db.prepare('SELECT * FROM targets WHERE id=?').get(target.id);
  const receiptCount = () => db.prepare('SELECT count(*) n FROM author_resolution_success_receipts WHERE queue_id=?').get(claim.id).n;
  const commit = extra => database.commitAuthorResolutionTarget(claim.id, input,
    { fileName: '原始来源.xlsx', sheetName: '08' }, { ...options, ...extra });
  return { db, claim, readQueue, readTarget, receiptCount, commit };
}

test('existing conflicting homepage identity anchor rejects source-only resolution without changing the target', t => {
  const f = fixture(t, OTHER);
  const beforeTarget = f.readTarget(), beforeQueue = f.readQueue();
  assert.equal(f.commit(), null);
  assert.deepEqual(f.readTarget(), beforeTarget);
  const rejected = f.readQueue();
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.attempts, beforeQueue.attempts + 1);
  assert.equal(rejected.resolved_target_id, null);
  assert.equal(rejected.lease_owner, null);
  assert.match(rejected.last_error, /主页身份锚点.*不一致.*人工核查/);
  assert.equal(f.receiptCount(), 0);
  const audit = f.db.prepare('SELECT target_id,status,message FROM audits ORDER BY id DESC LIMIT 1').get();
  assert.equal(audit.target_id, beforeTarget.id);
  assert.equal(audit.status, 'warning');
  assert.match(audit.message, /身份冲突/);
});

test('nested conflicting anchor persists rejected queue and warning only when caller commits', t => {
  const f = fixture(t, OTHER), beforeTarget = f.readTarget();
  f.db.exec('BEGIN IMMEDIATE');
  const result = f.commit({ withinTransaction: true });
  assert.deepEqual(result, { status: 'identity_conflict', queueId: f.claim.id });
  assert.deepEqual(f.readTarget(), beforeTarget);
  assert.equal(f.readQueue().status, 'rejected');
  assert.equal(f.receiptCount(), 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM audits WHERE status='warning'").get().n, 1);
  f.db.exec('COMMIT');
  assert.equal(f.readQueue().status, 'rejected');
  assert.equal(f.db.prepare("SELECT count(*) n FROM audits WHERE status='warning'").get().n, 1);
});

test('a matching existing homepage identity anchor still permits strict resolution', t => {
  const f = fixture(t, ACCOUNT), beforeTarget = f.readTarget();
  const committed = f.commit();
  assert.equal(committed.target.id, beforeTarget.id);
  assert.equal(f.readQueue().status, 'resolved');
  assert.equal(f.receiptCount(), 1);
  assert.equal(committed.target.label, '用户命名');
  assert.equal(committed.target.metadata.note, '用户原始资料');
  assert.equal(committed.target.metadata.identityVerification.accountId, ACCOUNT);
});
