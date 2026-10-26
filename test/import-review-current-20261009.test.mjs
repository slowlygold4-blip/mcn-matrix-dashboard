import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MonitorDatabase } from '../lib/database.mjs';
import { buildAuthorEvidenceRequests, verifyQueuedAuthorEvidence } from '../lib/author-resolution.mjs';
import { projectImportReview } from '../lib/import-review.mjs';
import { enrichImportReviewCurrent, CURRENT_RESOLUTION_SCOPE } from '../lib/import-review-current.mjs';

const SEC = 'MS4wLjABAAAAabcdefghijklmnopqrstuvwx', VIDEO = '7684617087687331118';
function fixture(t) {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close()); const db = database.db;
  const row = { sourceRow: 2, platform: 'douyin', name: '原作者', douyinId: 'original_handle', videoId: VIDEO, status: 'unresolved' };
  const request = buildAuthorEvidenceRequests([row])[0]; assert.ok(request);
  database.enqueueAuthorResolutions([request], { fileName: 'test.csv', sheetName: 'CSV', sourceMetadata: { sourceType: 'author-spreadsheet' } });
  const job = { id: 'fixture-job', fileName: 'test.csv', sheetName: 'CSV', request: { fileName: 'test.csv', sheetName: 'CSV', rows: [row] },
    finishedAt: new Date().toISOString(), result: { skipped: [{ ...row, evidenceRequestKeys: [request.key], reason: '旧回执' }] } };
  const read = (subject = job) => enrichImportReviewCurrent(db, subject, projectImportReview(subject));
  const commit = () => {
    const claimed = database.claimDueAuthorResolutions(1, { owner: 'fixture', reference: new Date(Date.now() + 100) })[0]; assert.ok(claimed);
    const verified = verifyQueuedAuthorEvidence(request, { candidates: [{ platform: 'douyin', secUid: SEC, nickname: row.name, uniqueId: row.douyinId, videoId: VIDEO }], errors: [] });
    assert.equal(verified.status, 'ready');
    const target = database.commitAuthorResolutionTarget(claimed.id, { label: row.name, locator: SEC, metadata: { platform: 'douyin', douyinId: row.douyinId, resolution: verified.row.resolution } }, {}, { owner: 'fixture', evidenceVersion: claimed.evidence_version });
    assert.ok(target); return target;
  };
  return { db, database, job, request, read, commit, current: () => read().items[0].currentResolution };
}

test('current projection is source-bound, read-only and keeps historical totals/status intact', t => {
  const f = fixture(t), before = JSON.stringify(f.job), queueBefore = f.db.prepare('SELECT * FROM author_resolution_queue').all();
  const result = f.read(); assert.equal(result.currentResolutionScope, CURRENT_RESOLUTION_SCOPE); assert.ok(Date.parse(result.checkedAt));
  assert.equal(result.items[0].status, 'unresolved'); assert.equal(result.items[0].reason, '旧回执');
  assert.equal(result.items[0].currentResolution.status, 'pending'); assert.equal(result.items[0].currentResolution.counts.linked, 1);
  assert.equal(JSON.stringify(f.job), before); assert.deepEqual(f.db.prepare('SELECT * FROM author_resolution_queue').all(), queueBefore);
});
test('live lease, retry and terminal rejection have distinct states; provider secrets are not echoed', t => {
  const f = fixture(t);
  f.db.prepare('UPDATE author_resolution_queue SET lease_owner=?,lease_until=?').run('private-owner', new Date(Date.now() + 60000).toISOString());
  assert.equal(f.current().status, 'processing');
  f.db.prepare("UPDATE author_resolution_queue SET status='retry',lease_owner=NULL,lease_until=NULL,next_attempt_at=?,last_error=?").run(new Date(Date.now() + 60000).toISOString(), 'HTTP 403 Cookie: sensitive-token');
  assert.equal(f.current().status, 'retry'); assert.ok(f.current().nextRetryAt); assert.match(f.current().reason, /403/);
  assert.doesNotMatch(JSON.stringify(f.read()), /sensitive-token|private-owner/);
  f.db.prepare("UPDATE author_resolution_queue SET status='rejected'").run(); assert.equal(f.current().status, 'rejected'); assert.equal(f.current().nextRetryAt, null);
});
test('resolved requires immutable current-version proof, current target and unchanged evidence, not legacy status', t => {
  const f = fixture(t); f.commit(); assert.equal(f.current().status, 'resolved');
  const saved = f.db.prepare('SELECT * FROM author_resolution_queue').get();
  f.db.prepare('UPDATE author_resolution_queue SET evidence_version=evidence_version+1').run(); assert.equal(f.current().status, 'unknown');
  f.db.prepare('UPDATE author_resolution_queue SET evidence_version=?').run(saved.evidence_version);
  f.db.prepare('UPDATE targets SET metadata_json=?').run(JSON.stringify({ platform: 'bilibili' })); assert.equal(f.current().status, 'unknown');
  f.db.prepare('UPDATE targets SET metadata_json=?').run('{}'); assert.equal(f.current().status, 'resolved');
  for (const invalid of ['123', 'true', '"corrupt"', '[]', 'null']) {
    f.db.prepare('UPDATE targets SET metadata_json=?').run(invalid); assert.equal(f.current().status, 'unknown');
  }
  f.db.prepare('UPDATE targets SET metadata_json=?').run('{}');
  f.db.prepare('UPDATE author_resolution_queue SET video_ids_json=?').run('["1234567890123456789"]'); assert.equal(f.current().status, 'conflict');
  f.db.prepare('UPDATE author_resolution_queue SET video_ids_json=?').run(saved.video_ids_json);
  f.db.prepare('DELETE FROM author_resolution_success_receipts').run(); assert.equal(f.current().status, 'unknown');
});
test('same name/key cannot cross a source filename, sheet, row, revision or source record', t => {
  const f = fixture(t);
  for (const change of [j => j.request.fileName = 'another.csv', j => j.request.sheetName = 'other', j => j.result.skipped[0].sourceRow = 3,
    j => j.request.sourceRevision = 88, j => j.result.skipped[0].sourceRecordId = 'rec-other']) {
    const job = structuredClone(f.job); change(job); assert.equal(f.read(job).items[0].currentResolution.status, 'unlinked');
  }
});
test('tampered or later source receipt cannot bind an old import', t => {
  const f = fixture(t), saved = f.db.prepare('SELECT * FROM author_resolution_import_sources').get();
  f.db.prepare('UPDATE author_resolution_import_sources SET receipt_sha256=?').run('0'.repeat(64)); assert.equal(f.current().status, 'unlinked');
  f.db.prepare('UPDATE author_resolution_import_sources SET receipt_sha256=?,observed_at=?').run(saved.receipt_sha256, new Date(Date.parse(f.job.finishedAt) + 60000).toISOString());
  assert.equal(f.current().status, 'unlinked');
});
test('conflicts, absent keys and invalid multiplicity do not borrow queue status', t => {
  const f = fixture(t);
  for (const [patch, expected] of [[{ status: 'identity_conflict' }, 'conflict'], [{ evidenceRequestKeys: [] }, 'unlinked'], [{ evidenceRequestKeys: Array(21).fill(f.request.key) }, 'unknown']]) {
    const job = structuredClone(f.job); Object.assign(job.result.skipped[0], patch); assert.equal(f.read(job).items[0].currentResolution.status, expected);
  }
});
test('mixed evidence is not presented as full resolution; only requested page is joined', t => {
  const f = fixture(t), job = structuredClone(f.job);
  job.result.skipped[0].evidenceRequestKeys.push('douyin:missing');
  const current = f.read(job).items[0].currentResolution;
  assert.equal(current.status, 'mixed'); assert.equal(current.counts.total, 2); assert.equal(current.counts.linked, 1); assert.equal(current.counts.unknown, 1);
  job.result.skipped.push({ name: 'page2', sourceRow: 99 });
  const result = enrichImportReviewCurrent(f.db, job, projectImportReview(job, { limit: 1, offset: 1 }));
  assert.equal(result.items.length, 1); assert.equal(result.items[0].name, 'page2'); assert.equal(result.total, 2);
});
test('missing schema preserves historical response and marks current data unavailable', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const job = { id: 'x', result: { skipped: [{ name: '历史作者' }] } };
  const read = enrichImportReviewCurrent(db, job, projectImportReview(job));
  assert.equal(read.items[0].name, '历史作者'); assert.equal(read.items[0].currentResolution.status, 'unavailable');
});
test('more than 50 matching source receipts is explicitly unknown instead of partial association', t => {
  const f = fixture(t), saved = f.db.prepare('SELECT * FROM author_resolution_import_sources').get();
  for (let i = 0; i < 51; i++) {
    const payload = { ...JSON.parse(saved.payload_json), note: i };
    f.db.prepare('INSERT INTO author_resolution_import_sources(queue_id,queue_identity_key,receipt_sha256,observed_at,payload_json) VALUES(?,?,?,?,?)')
      .run(saved.queue_id, saved.queue_identity_key, createHash('sha256').update(JSON.stringify(payload)).digest('hex'), saved.observed_at, JSON.stringify(payload));
  }
  assert.equal(f.current().status, 'unknown');
});

test('500 repeats in a page validate one immutable proof instead of hashing it 500 times', t => {
  const f = fixture(t); f.commit();
  const job = structuredClone(f.job); job.result.skipped = Array.from({ length: 500 }, () => ({ ...job.result.skipped[0] }));
  let proofReads = 0;
  const wrapped = { exec: sql => f.db.exec(sql), prepare(sql) { if (sql.includes('FROM author_resolution_success_receipts')) proofReads++; return f.db.prepare(sql); } };
  const result = enrichImportReviewCurrent(wrapped, job, projectImportReview(job, { limit: 500 }));
  assert.equal(result.items.length, 500); assert.ok(result.items.every(row => row.currentResolution.status === 'resolved')); assert.equal(proofReads, 1);
});
