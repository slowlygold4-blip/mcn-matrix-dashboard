import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MonitorDatabase } from '../lib/database.mjs';
import { profileConsoleRead } from '../scripts/profile-console-read.mjs';

const INDEX = 'idx_runs_works_target_id';
const FINISH = '2026-09-28T03:00:00.000Z';
// Keep the production correlated predicate, without forcing an index.
const QUERY = `SELECT EXISTS(SELECT 1 FROM runs intervening
  WHERE intervening.trigger_type='works-only' AND intervening.target_id=?
    AND intervening.id>? AND intervening.id<? AND intervening.finished_at IS NOT NULL
    AND julianday(intervening.finished_at)<=julianday(?)) AS present`;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mcn-read-index-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'fixture.sqlite');
  let database = new MonitorDatabase(path);
  t.after(() => database?.close());
  const first = database.createTarget({ type: 'account', label: 'isolated A', locator: 'isolated-a', provider: 'manual' });
  const second = database.createTarget({ type: 'account', label: 'isolated B', locator: 'isolated-b', provider: 'manual' });
  const insert = (id, targetId, trigger = 'works-only', finish = FINISH) => database.db.prepare(`
    INSERT INTO runs(id,trigger_type,target_id,started_at,finished_at,status,target_count,processed_count)
    VALUES(?,?,?,'2026-09-28T02:00:00.000Z',?,?,1,1)`)
    .run(id, trigger, targetId, finish, finish ? 'partial' : 'running');
  return { path, first, second, insert, get database() { return database; },
    reopen() { database.close(); database = null; database = new MonitorDatabase(path); return database; } };
}

function sourceState(db) {
  return Object.fromEntries(['targets', 'runs', 'snapshots', 'posts', 'post_metrics', 'works_observations', 'audits']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}

test('works read index is partial and idempotent when an existing database is reopened', t => {
  const f = fixture(t);
  f.insert(10, f.first.id); f.insert(20, f.second.id);
  const original = sourceState(f.database.db);
  f.database.db.exec(`DROP INDEX ${INDEX}`); // Isolated fixture models the old schema.
  f.reopen();
  const definition = f.database.db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(INDEX)?.sql;
  assert.match(definition, /ON runs\(target_id,id\)/);
  assert.match(definition, /WHERE trigger_type='works-only' AND finished_at IS NOT NULL/);
  assert.deepEqual(sourceState(f.database.db), original, 'migration adds no business rows and rewrites no source');
  f.database.migrate();
  assert.deepEqual(sourceState(f.database.db), original);
  assert.equal(f.database.db.prepare('SELECT count(*) AS n FROM sqlite_master WHERE name=?').get(INDEX).n, 1);
});

test('indexed intervening-run predicate matches old query across author, status, time and strict ID boundaries', t => {
  const f = fixture(t), db = f.database.db;
  f.insert(10, f.first.id);
  f.insert(11, f.second.id); // Another author's completed work run is not intervening.
  f.insert(12, f.first.id, 'scheduled');
  f.insert(13, f.first.id, 'works-only', null);
  f.insert(14, f.first.id, 'works-only', '2026-09-28T05:00:00.000Z');
  f.insert(15, f.first.id);
  f.insert(16, f.first.id, 'works-only', 'invalid timestamp');
  f.insert(20, f.first.id);
  const windows = [[10, 15], [10, 16], [15, 20], [9, 10], [9, 11], [20, 21], [9, 21]];
  const read = () => windows.map(([lower, upper]) => db.prepare(QUERY).get(f.first.id, lower, upper, FINISH).present);
  const before = sourceState(db), indexed = read();
  assert.deepEqual(indexed, [0, 1, 0, 0, 1, 0, 1]);
  db.exec(`DROP INDEX ${INDEX}`);
  assert.deepEqual(read(), indexed);
  f.database.migrate();
  assert.deepEqual(read(), indexed);
  assert.deepEqual(sourceState(db), before);
});

test('SQLite chooses author/ID range search without an index hint or cross-author full trigger scan', t => {
  const f = fixture(t);
  for (let id = 1; id <= 100; id++) f.insert(id, id === 50 ? f.first.id : f.second.id);
  const details = f.database.db.prepare(`EXPLAIN QUERY PLAN ${QUERY}`)
    .all(f.first.id, 10, 90, FINISH).map(row => row.detail).join('\n');
  assert.match(details, /USING INDEX idx_runs_works_target_id \(target_id=\? AND id>\? AND id<\?\)/);
  assert.doesNotMatch(details, /idx_runs_trigger_started/);
  assert.equal(f.database.db.prepare(QUERY).get(f.first.id, 10, 90, FINISH).present, 1);
});

test('read profiler uses a read-only fixed file, does not expose payloads and produces stable result checksum', t => {
  const f = fixture(t);
  f.database.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const before = createHash('sha256').update(readFileSync(f.path)).digest('hex');
  const reader = db => ({ accounts: db.db.prepare('SELECT id FROM targets ORDER BY id').all(),
    count: db.db.prepare('SELECT count(*) AS n FROM targets').get().n });
  const first = profileConsoleRead(f.path, {}, reader);
  const second = profileConsoleRead(f.path, {}, reader);
  assert.equal(first.accounts, 2);
  assert.equal(first.responseChecksum, second.responseChecksum);
  const withoutTiming = result => result.statements.map(({ sqlMs, ...item }) => item)
    .sort((left, right) => left.query.localeCompare(right.query));
  assert.deepEqual(withoutTiming(first), withoutTiming(second));
  assert.equal(first.statements.length, 2);
  assert.match(first.responseChecksum, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(first), /isolated [AB]|isolated-[ab]/);
  assert.equal(createHash('sha256').update(readFileSync(f.path)).digest('hex'), before);
});

test('read profiler rejects writes and closes a failed read without modifying source rows', t => {
  const f = fixture(t), before = sourceState(f.database.db);
  assert.throws(() => profileConsoleRead(f.path, {}, db => {
    db.db.prepare("UPDATE targets SET label='accidental write'").run();
    return { accounts: [] };
  }), /readonly/i);
  const check = new DatabaseSync(f.path, { readOnly: true });
  try { assert.deepEqual(sourceState(check), before); } finally { check.close(); }
  assert.equal(profileConsoleRead(f.path, {}, db => ({ accounts: db.db.prepare('SELECT id FROM targets').all() })).accounts, 2);
});
