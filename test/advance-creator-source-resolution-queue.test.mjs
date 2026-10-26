import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  advanceCreatorSourceResolutionQueue, evaluateQueueHealth, parseAdvanceArguments,
  readQueueHealth, resumeAuthorRow,
} from '../scripts/advance-creator-source-resolution-queue.mjs';
import { candidateBatchKey } from '../scripts/enqueue-creator-source-resolution-candidates.mjs';

const sha = 'a'.repeat(64);
const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE creator_source_imports(id INTEGER PRIMARY KEY,source_sha256 TEXT);
    CREATE TABLE author_resolution_queue(
      id INTEGER PRIMARY KEY,identity_key TEXT,status TEXT,attempts INTEGER,last_error TEXT);
    CREATE TABLE author_resolution_import_sources(
      queue_id INTEGER,queue_identity_key TEXT,receipt_sha256 TEXT,payload_json TEXT);`);
  db.prepare('INSERT INTO creator_source_imports VALUES(1,?)').run(sha);
  return db;
}

function receipt(db, { id, batchKey, batchSize = 1, authorRow = 2, lastAuthorRow = 2,
  status = 'pending', attempts = 0, lastError = null, sourceSha = sha }) {
  const key = `douyin:${id}`;
  db.prepare('INSERT INTO author_resolution_queue VALUES(?,?,?,?,?)')
    .run(id, key, status, attempts, lastError);
  const payload = JSON.stringify({ sourceMetadata: {
    sourceSha256: sourceSha, identityStatus: 'unverified-candidate', batchKey,
    batchSize, authorRow, lastAuthorRow,
  } });
  db.prepare('INSERT INTO author_resolution_import_sources VALUES(?,?,?,?)')
    .run(id, key, hash(payload), payload);
}

test('requires a pinned SHA, explicit write gates, and refuses batches above 20', () => {
  assert.throws(() => parseAdvanceArguments([]), /source-sha/);
  assert.throws(() => parseAdvanceArguments(['--source-sha', sha, '--limit', '21']), /最多 20/);
  assert.throws(() => parseAdvanceArguments(['--source-sha', sha, '--after-author-row', '40']), /不可手动跳过/);
  assert.throws(() => parseAdvanceArguments(['--apply', '--source-sha', sha, '--limit', '20']), /必须明确/);
  const options = parseAdvanceArguments(['--source-sha', sha, '--limit', '20']);
  assert.equal(options.apply, false);
  assert.equal(options.limit, 20);
});

test('receipt cursor advances only through complete hashed same-limit batches', t => {
  const db = fixture(t), firstKey = candidateBatchKey({ sourceSha: sha, afterAuthorRow: 0, limit: 1 });
  assert.deepEqual(resumeAuthorRow(db, sha, 1), { afterAuthorRow: 0, completedBatches: 0,
    nextBatchKey: firstKey });
  receipt(db, { id: 1, batchKey: firstKey, lastAuthorRow: 4, authorRow: 4 });
  const secondKey = candidateBatchKey({ sourceSha: sha, afterAuthorRow: 4, limit: 1 });
  assert.deepEqual(resumeAuthorRow(db, sha, 1), { afterAuthorRow: 4, completedBatches: 1,
    nextBatchKey: secondKey });
  receipt(db, { id: 2, batchKey: secondKey, lastAuthorRow: 8, authorRow: 8 });
  assert.equal(resumeAuthorRow(db, sha, 1).afterAuthorRow, 8);
  db.prepare('UPDATE author_resolution_import_sources SET receipt_sha256=? WHERE queue_id=2')
    .run('0'.repeat(64));
  assert.throws(() => resumeAuthorRow(db, sha, 1), /收据不完整/);
});

test('queue gate pauses on backlog, attempted success rate, or 403 while dry-run changes nothing', t => {
  const db = fixture(t);
  for (let i = 1; i <= 20; i++) receipt(db, {
    id: i, batchKey: `batch-${i}`, authorRow: i + 1,
    status: 'pending',
  });
  const before = db.prepare('SELECT total_changes() n').get().n;
  const health = readQueueHealth(db, sha);
  assert.equal(health.globalActive, 20);
  assert.equal(health.sourceActive, 20);
  assert.match(evaluateQueueHealth(health, undefined, 20).reasons.join(' '), /本来源待处理/);
  const result = advanceCreatorSourceResolutionQueue(db, { sourceSha: sha, limit: 20, apply: false });
  assert.equal(result.status, 'paused');
  assert.equal(result.applied, false);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);

  for (let i = 1; i <= 10; i++) db.prepare('UPDATE author_resolution_queue SET status=?,attempts=1,last_error=? WHERE id=?')
    .run(i <= 2 ? 'resolved' : 'rejected', i <= 2 ? null : 'HTTP 403', i);
  const updated = readQueueHealth(db, sha);
  assert.equal(updated.evaluated, 10);
  assert.equal(updated.successRatio, 0.2);
  assert.equal(updated.failure403Ratio, 0.8);
  const reasons = evaluateQueueHealth(updated).reasons.join(' ');
  assert.match(reasons, /成功率/);
  assert.match(reasons, /403 比例/);
});

test('a retry with HTTP 403 counts toward failure gate before final rejection', t => {
  const db = fixture(t);
  for (let i = 1; i <= 10; i++) receipt(db, { id: i, batchKey: `batch-${i}`,
    status: i === 1 ? 'resolved' : 'retry', attempts: 1,
    lastError: i === 1 ? null : 'upstream HTTP 403' });
  const health = readQueueHealth(db, sha);
  assert.equal(health.evaluated, 10);
  assert.equal(health.successRatio, 0.1);
  assert.equal(health.failure403Ratio, 0.9);
  assert.equal(evaluateQueueHealth(health).paused, true);
});

test('pressure gate reserves capacity for the incoming batch instead of only checking current count', () => {
  const health = { globalActive: 4999, sourceActive: 19, evaluated: 0 };
  const gate = evaluateQueueHealth(health, undefined, 2);
  assert.equal(gate.paused, true);
  assert.match(gate.reasons.join(' '), /全局待处理/);
  assert.match(gate.reasons.join(' '), /本来源待处理/);
});

test('recent 403 failures cannot be hidden by older successful candidates', t => {
  const db = fixture(t);
  for (let i = 1; i <= 50; i++) receipt(db, { id: i, batchKey: `batch-${i}`,
    status: 'resolved', attempts: 1 });
  for (let i = 51; i <= 60; i++) receipt(db, { id: i, batchKey: `batch-${i}`,
    status: 'rejected', attempts: 1, lastError: 'HTTP 403' });
  const health = readQueueHealth(db, sha);
  assert.equal(health.evaluated, 50);
  assert.equal(health.failures403, 10);
  assert.equal(health.failure403Ratio, 0.2);
  assert.equal(health.successRatio, 0.8);
  for (let i = 61; i <= 80; i++) receipt(db, { id: i, batchKey: `batch-${i}`,
    status: 'rejected', attempts: 1, lastError: 'HTTP 403' });
  const recent = readQueueHealth(db, sha);
  assert.equal(recent.evaluated, 50);
  assert.equal(recent.failures403, 30);
  assert.equal(recent.failure403Ratio, 0.6);
  assert.equal(evaluateQueueHealth(recent).paused, true);
});
