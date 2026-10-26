import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runAuthorisedQueueCycle } from '../lib/authorised-queue-cycle.mjs';

function fixture(t, { platform = 'douyin' } = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE author_resolution_queue(id INTEGER,identity_key TEXT,evidence_version INTEGER,lease_owner TEXT,status TEXT,
    next_attempt_at TEXT,last_error TEXT,lease_until TEXT,updated_at TEXT,resolved_target_id INTEGER,suspended_target_enabled INTEGER,
    attempts INTEGER,verification_policy_version INTEGER,video_ids_json TEXT,share_urls_json TEXT);`);
  db.prepare(`INSERT INTO author_resolution_queue VALUES(1,?,1,'worker','retry','','original error',?,'',NULL,NULL,2,2,?,?)`)
    .run(`${platform}:fixture-key`, new Date(Date.now()+60_000).toISOString(), '["7685308686524676594","7685308686524676595"]', '[]');
  const due = db.prepare('SELECT * FROM author_resolution_queue').all(), retries = [];
  const database = { db, markAuthorResolutionRetry: (...args) => retries.push(args) };
  const run = (code, mutation = '') => runAuthorisedQueueCycle(database, due, {
    owner: 'worker', retryAt: () => new Date(Date.now()+3600_000).toISOString(),
    run: async () => { if (mutation) db.exec(`UPDATE author_resolution_queue SET ${mutation} WHERE id=1`);
      return { status: 'skipped', code, attempted: false }; },
  });
  return { db, due, retries, run };
}

test('cycle peer: broad ineligible outcome is never an alternate Douyin resolution path', async t => {
  for (const mutation of ['', "status='rejected'", "status='resolved'", 'resolved_target_id=9',
    'suspended_target_enabled=0', 'suspended_target_enabled=1', 'verification_policy_version=1']) {
    const f = fixture(t);
    const outcome = await f.run('queue_not_eligible', mutation);
    assert.deepEqual(outcome.legacy, []);
    assert.equal(f.retries.length, 0);
  }
});

test('cycle peer: explicit non-Douyin may keep old resolver only under the unchanged live eligible lease', async t => {
  const f = fixture(t, { platform: 'bilibili' });
  assert.equal((await f.run('queue_not_eligible')).legacy.length, 1);
  for (const mutation of ["status='rejected'", "status='resolved'", 'resolved_target_id=9', 'suspended_target_enabled=0',
    "lease_owner='other'", 'evidence_version=2', "lease_until='invalid'", "lease_until='2000-01-01T00:00:00.000Z'", 'verification_policy_version=1']) {
    const changed = fixture(t, { platform: 'bilibili' });
    assert.deepEqual((await changed.run('queue_not_eligible', mutation)).legacy, [], mutation);
  }
});

test('cycle peer: multi-work legacy selection rechecks terminal/paused/lease state after asynchronous work', async t => {
  const f = fixture(t);
  assert.equal((await f.run('evidence_not_single')).legacy.length, 1);
  for (const mutation of ["status='rejected'", "status='resolved'", 'resolved_target_id=9', 'suspended_target_enabled=0',
    "lease_owner='other'", 'evidence_version=2', "lease_until='invalid'", "lease_until='2000-01-01T00:00:00.000Z'", 'verification_policy_version=1']) {
    const changed = fixture(t);
    assert.deepEqual((await changed.run('evidence_not_single', mutation)).legacy, [], mutation);
  }
});
