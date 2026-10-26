import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { buildUpdateSla, inspectUpdateSla, readUpdateSla } from '../lib/update-sla.mjs';

const asOf = new Date('2026-09-28T12:00:00.000Z');
const account = (id, extras = {}) => ({ id, type: 'account', provider: 'public-web', enabled: 1, ...extras });

function fixture(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,provider TEXT,enabled INTEGER);
    CREATE TABLE snapshots(id INTEGER PRIMARY KEY,target_id INTEGER,captured_at TEXT,followers INTEGER,total_likes INTEGER,total_posts INTEGER,
      hashtag_participants INTEGER,hashtag_views INTEGER,quality_status TEXT,account_status TEXT,works_coverage TEXT,source_checksum TEXT);
    CREATE TABLE audits(id INTEGER PRIMARY KEY,target_id INTEGER,created_at TEXT,status TEXT,provider TEXT,run_id INTEGER,source_checksum TEXT);
    CREATE TABLE runs(id INTEGER PRIMARY KEY,started_at TEXT,finished_at TEXT);
    INSERT INTO targets VALUES(1,'account','public-web',1),(2,'account','manual',1),(3,'account','public-web',0);
    INSERT INTO runs VALUES(1,'2026-09-28T09:59:59.000Z','2026-09-28T10:02:00.000Z');
    INSERT INTO snapshots VALUES(1,1,'2026-09-28T10:00:00.000Z',100,1000,20,NULL,NULL,'validated','available','complete','same-source');
    INSERT INTO audits VALUES(1,1,'2026-09-28T10:01:00.000Z','validated','public-web',1,'same-source');`);
  return db;
}
function inspect(db, now = asOf) { return inspectUpdateSla(db, { now, includeTargets: true }); }

test('independent SQL: same checksum cannot borrow another target, provider, run or rejected audit', () => {
  for (const mutation of [
    "UPDATE audits SET target_id=2",
    "UPDATE audits SET provider='manual'",
    "UPDATE audits SET run_id=99",
    "UPDATE audits SET status='rejected'",
    "UPDATE audits SET source_checksum='different-source'",
    "UPDATE snapshots SET source_checksum=''",
  ]) {
    const db = fixture();
    try {
      db.exec(mutation);
      const result = inspect(db);
      assert.equal(result.coreAccounts.daily.total, 2, mutation);
      assert.equal(result.coreAccounts.daily.complete, 0, mutation);
      assert.equal(result.works.daily.counts.complete, 0, mutation);
    } finally { db.close(); }
  }
});

test('independent SQL: observation belongs inside its real run and no future audit or finish is accepted', () => {
  for (const mutation of [
    "UPDATE runs SET started_at='2026-09-28T10:00:00.001Z'",
    "UPDATE runs SET finished_at='2026-09-28T10:00:59.999Z'",
    "UPDATE audits SET created_at='2026-09-28T09:59:59.999Z'",
    "UPDATE audits SET created_at='2026-09-28T12:00:00.001Z'",
    "UPDATE runs SET finished_at='2026-09-28T12:00:00.001Z'",
  ]) {
    const db = fixture();
    try {
      db.exec(mutation);
      assert.equal(inspect(db).coreAccounts.fresh8h.complete, 0, mutation);
    } finally { db.close(); }
  }
  const db = fixture();
  try {
    db.exec("UPDATE runs SET started_at='2026-09-28T10:00:00.000Z',finished_at='2026-09-28T10:01:00.000Z'");
    assert.equal(inspect(db).coreAccounts.fresh8h.complete, 1, 'exact valid run boundaries remain accepted');
  } finally { db.close(); }
});

test('independent SQL: a failed latest attempt is not a failed latest successful observation', () => {
  const db = fixture();
  try {
    db.exec(`INSERT INTO audits VALUES(2,1,'2026-09-28T11:00:00.000Z','error','public-web',NULL,NULL);
      INSERT INTO audits VALUES(3,1,'2099-09-28T11:00:00.000Z','validated','public-web',NULL,NULL);`);
    const result = inspect(db);
    assert.equal(result.coreAccounts.daily.complete, 1);
    const row = result.coreAccounts.targets.find(row => row.targetId === 1);
    assert.equal(row.snapshotId, 1);
    assert.equal(row.capturedAt, '2026-09-28T10:00:00.000Z');
    assert.equal(row.latestAttempt.auditId, 2);
    assert.equal(row.latestAttempt.status, 'error');
    assert.equal(row.latestAttemptAfterUsableSnapshot, true);
  } finally { db.close(); }
});

test('independent SQL: each of three counters must exist on one real snapshot, never combine rows or derive plays', () => {
  const db = fixture();
  try {
    db.exec(`UPDATE snapshots SET total_likes=NULL;
      INSERT INTO snapshots VALUES(2,1,'2026-09-28T10:00:01.000Z',NULL,1000,20,NULL,NULL,'validated','available','retry','same-source');`);
    const result = inspect(db);
    assert.equal(result.coreAccounts.daily.complete, 0);
    assert.deepEqual(result.coreAccounts.metrics, ['followers','total_likes','total_posts']);
    assert.equal(result.works.daily.complete, 0);
    assert.equal(result.works.daily.counts.unavailable, 1);
    assert.equal(result.status, 'incomplete');
    assert.equal('actualPlays' in result.coreAccounts, false);
  } finally { db.close(); }
});

test('independent SQL: read-only projection keeps all source rows and active unresolved manual account in denominator', () => {
  const db = fixture();
  try {
    const tables = ['targets','snapshots','audits','runs'];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    const changes = db.prepare('SELECT total_changes() value').get().value;
    db.exec('PRAGMA query_only=ON');
    const result = inspect(db);
    assert.equal(result.coreAccounts.daily.total, 2);
    assert.equal(result.enabledManualAccountCount, 1);
    assert.equal(result.disabledTargetCount, 1);
    assert.equal(result.coreAccounts.daily.ratioPercent, 50);
    assert.deepEqual(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()), before);
    assert.equal(db.prepare('SELECT total_changes() value').get().value, changes);
  } finally { db.close(); }
});

test('independent pure: zero, topic-only and unavailable inputs cannot imply an 80% account success', () => {
  for (const targets of [[], [account(1, { type: 'hashtag' })]]) {
    const result = buildUpdateSla({ targets, snapshots: [], now: asOf });
    assert.equal(result.status, 'unknown');
    assert.equal(result.coreAccounts.daily.requiredCount, null);
    assert.equal(result.coreAccounts.fresh8h.ratioPercent, null);
  }
  assert.equal(buildUpdateSla({ targets: [], snapshots: null, now: asOf }).status, 'unknown');
});

test('independent SQL: newer unbound import cannot hide an older real last-success timestamp', () => {
  const db = fixture();
  try {
    db.exec(`UPDATE runs SET started_at='2026-09-26T09:59:00.000Z',finished_at='2026-09-26T10:02:00.000Z';
      UPDATE snapshots SET captured_at='2026-09-26T10:00:00.000Z';
      UPDATE audits SET created_at='2026-09-26T10:01:00.000Z';
      INSERT INTO snapshots VALUES(2,1,'2026-09-28T10:00:00.000Z',101,1100,21,NULL,NULL,'validated','available','complete','manual-import');`);
    const result = inspect(db);
    assert.equal(result.coreAccounts.daily.complete, 0);
    assert.equal(result.coreAccounts.fresh8h.complete, 0);
    assert.equal(result.coreAccounts.targets.find(row => row.targetId === 1).capturedAt, '2026-09-26T10:00:00.000Z');
    assert.equal(result.coreAccounts.targets.find(row => row.targetId === 1).snapshotId, 1);
    assert.equal(result.works.daily.complete, 0);
  } finally { db.close(); }
});

test('independent worker: overlapping reads are single-flight and successful projection leaves rows unchanged', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcn-sla-readonly-test-'));
  const path = join(directory, 'fixture.sqlite');
  const db = fixture(path);
  try {
    const tables = ['targets','snapshots','audits','runs'];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    const first = readUpdateSla(path, { now: asOf });
    const second = readUpdateSla(path, { now: asOf });
    assert.equal(first, second, 'concurrent clients share the in-flight read');
    const [a,b] = await Promise.all([first, second]);
    assert.deepEqual(a,b);
    assert.equal(a.checkedAt, asOf.toISOString());
    assert.equal(a.coreAccounts.daily.complete, 1);
    assert.equal(a.coreAccounts.daily.total, 2);
    assert.deepEqual(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()), before);
    const afterSettlement = readUpdateSla(path, { now: asOf });
    assert.notEqual(first, afterSettlement, 'settled promise does not become an indefinite stale cache');
    await afterSettlement;
  } finally { db.close(); rmSync(directory, { recursive: true }); }
});

test('independent worker: a missing database returns unknown and never creates a file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcn-sla-missing-test-'));
  const path = join(directory, 'absent.sqlite');
  try {
    const result = await readUpdateSla(path, { now: asOf });
    assert.equal(result.status, 'unknown');
    assert.equal(result.coreAccounts, null);
    assert.match(result.reason, /^observation-read-(failed|incomplete)$/);
    assert.equal(existsSync(path), false);
  } finally { rmSync(directory, { recursive: true }); }
});

test('independent worker: timeout returns unknown but cannot spawn another worker before prior exit', async () => {
  const workers = [], timers = [];
  class ControlledWorker {
    constructor() { this.listeners = new Map(); this.terminateCalls = 0; workers.push(this); }
    once(name, callback) { this.listeners.set(name, callback); }
    emit(name, value) { this.listeners.get(name)?.(value); }
    terminate() { this.terminateCalls++; return Promise.resolve(1); }
  }
  // Execute the actual module text with only its worker/clock dependencies
  // controlled. This tests timeout bookkeeping, not operating-system cleanup.
  const source = readFileSync(new URL('../lib/update-sla.mjs', import.meta.url), 'utf8')
    .replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '')
    .replaceAll('import.meta.url', JSON.stringify(import.meta.url));
  const context = { Date, URL, Worker: ControlledWorker, isMainThread: true,
    isCalendarDate: () => true, businessDateKey: () => '2026-09-28',
    setTimeout(callback, milliseconds) { timers.push({ callback, milliseconds }); return timers.length; }, clearTimeout() {} };
  runInNewContext(`${source}\nthis.subject = readUpdateSla;`, context);
  const first = context.subject('/isolated-test.sqlite', { now: asOf });
  assert.equal(timers[0].milliseconds, 5000);
  timers[0].callback();
  const result = await first;
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'observation-read-timeout');
  assert.equal(workers[0].terminateCalls, 1);
  assert.equal(context.subject('/isolated-test.sqlite', { now: asOf }), first);
  assert.equal(workers.length, 1, 'a non-exited timed-out worker retains its single-flight slot');
  workers[0].emit('exit', 1);
  const next = context.subject('/isolated-test.sqlite', { now: asOf });
  assert.notEqual(next, first);
  assert.equal(workers.length, 2);
  workers[1].emit('message', { status: 'unknown', reason: 'test-completed' });
  workers[1].emit('exit', 0);
  assert.equal((await next).reason, 'test-completed');
});
