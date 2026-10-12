import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readServiceTransitionGate } from '../lib/service-transition-gate.mjs';

const NOW = new Date('2026-10-12T15:00:00.000Z');
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE runs(id INTEGER PRIMARY KEY,trigger_type TEXT,status TEXT);
    CREATE TABLE author_resolution_jobs(id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE author_resolution_queue(id INTEGER PRIMARY KEY,status TEXT,lease_owner TEXT,lease_until TEXT)`);
  return db;
}

test('installer gate checks works-only runs, not just the main scheduler', t => {
  const db = fixture(t);
  assert.equal(readServiceTransitionGate(db, NOW).safe, true);
  db.prepare("INSERT INTO runs VALUES(1,'works-only','running')").run();
  assert.deepEqual(readServiceTransitionGate(db, NOW).runningRuns, 1);
  assert.equal(readServiceTransitionGate(db, NOW).safe, false);
  db.prepare("UPDATE runs SET status='interrupted' WHERE id=1").run();
  assert.equal(readServiceTransitionGate(db, NOW).safe, true);
});

test('installer gate rejects active imports and live leases, but not expired leases', t => {
  const db = fixture(t);
  db.prepare("INSERT INTO author_resolution_jobs VALUES('job','running')").run();
  assert.equal(readServiceTransitionGate(db, NOW).runningAuthorJobs, 1);
  db.prepare("UPDATE author_resolution_jobs SET status='completed'").run();
  db.prepare("INSERT INTO author_resolution_queue VALUES(1,'pending','worker','2026-10-12T15:01:00.000Z')").run();
  assert.equal(readServiceTransitionGate(db, NOW).activeAuthorLeases, 1);
  assert.equal(readServiceTransitionGate(db, NOW).safe, false);
  db.prepare("UPDATE author_resolution_queue SET lease_until='2026-10-12T14:59:00.000Z'").run();
  assert.equal(readServiceTransitionGate(db, NOW).safe, true);
});

test('missing run schema fails closed', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  assert.throws(() => readServiceTransitionGate(db, NOW), /缺少 runs 表/);
});
