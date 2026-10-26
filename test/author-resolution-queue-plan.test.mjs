import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  assessAuthorQueueClock, planAuthorResolutionQueueWakeup,
} from '../lib/author-resolution-queue-plan.mjs';

const NOW = Date.parse('2026-10-23T10:00:00.000Z');
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE author_resolution_queue (
    id INTEGER PRIMARY KEY,status TEXT NOT NULL,next_attempt_at TEXT NOT NULL);
    CREATE INDEX idx_author_resolution_due ON author_resolution_queue(status,next_attempt_at);`);
  return db;
}

test('empty queue uses only the existing ticker with a bounded 30-second idle wake', t => {
  const db = fixture(t);
  const before = db.prepare('SELECT total_changes() n').get().n;
  const plan = planAuthorResolutionQueueWakeup(db, NOW);
  assert.deepEqual(plan, { delayMs: 30_000, hasDueCandidate: false,
    reason: 'idle', nextAttemptAt: null });
  assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
});

test('due candidate wakes the existing fair worker; future retry wakes near its deadline', t => {
  const db = fixture(t);
  db.prepare('INSERT INTO author_resolution_queue VALUES(1,?,?)').run('retry', new Date(NOW + 8_000).toISOString());
  db.prepare('INSERT INTO author_resolution_queue VALUES(2,?,?)').run('resolved', new Date(NOW - 8_000).toISOString());
  const upcoming = planAuthorResolutionQueueWakeup(db, NOW);
  assert.equal(upcoming.hasDueCandidate, false);
  assert.equal(upcoming.delayMs, 8_000);
  assert.equal(upcoming.reason, 'future-retry');
  const due = planAuthorResolutionQueueWakeup(db, NOW + 8_000);
  assert.equal(due.hasDueCandidate, true);
  assert.equal(due.delayMs, 60_000);
  assert.equal(due.reason, 'due-candidate');
});

test('far-future and invalid clock cannot produce huge or spinning timers', t => {
  const db = fixture(t);
  db.prepare('INSERT INTO author_resolution_queue VALUES(1,?,?)').run('pending', new Date(NOW + 86_400_000).toISOString());
  assert.equal(planAuthorResolutionQueueWakeup(db, NOW).delayMs, 30_000);
  assert.deepEqual(planAuthorResolutionQueueWakeup(db, NaN), { delayMs: 30_000,
    hasDueCandidate: false, reason: 'invalid-clock', nextAttemptAt: null });
});

test('offset timestamps are checked as instants and malformed dates are never due', t => {
  const db = fixture(t);
  db.prepare('INSERT INTO author_resolution_queue VALUES(1,?,?)').run('retry', '2026-10-23T09:00:00-08:00');
  db.prepare('INSERT INTO author_resolution_queue VALUES(2,?,?)').run('pending', 'not-a-date');
  assert.equal(planAuthorResolutionQueueWakeup(db, NOW).hasDueCandidate, false);
  db.prepare('INSERT INTO author_resolution_queue VALUES(3,?,?)').run('retry', '2026-10-23T18:00:00+08:00');
  assert.equal(planAuthorResolutionQueueWakeup(db, NOW).hasDueCandidate, true);
});

test('monotonic comparison pauses one turn on a wall-clock jump', () => {
  const previous = { wallNowMs: NOW, monotonicNowMs: 1000 };
  assert.deepEqual(assessAuthorQueueClock(previous, NOW + 30_000, 31_000),
    { healthy: true, reason: null });
  assert.deepEqual(assessAuthorQueueClock(previous, NOW - 600_000, 31_000),
    { healthy: false, reason: 'clock-jump' });
  assert.deepEqual(assessAuthorQueueClock(previous, NOW + 600_000, 31_000),
    { healthy: false, reason: 'clock-jump' });
  assert.deepEqual(assessAuthorQueueClock(previous, NOW + 1000, 0),
    { healthy: false, reason: 'invalid-clock-sequence' });
});
