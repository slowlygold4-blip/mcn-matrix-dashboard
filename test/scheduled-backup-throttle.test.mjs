import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createScheduledBackupThrottle } from '../lib/scheduled-backup-throttle.mjs';

const AT = Date.parse('2026-10-09T16:50:00.000Z');
const TABLES = ['targets', 'board_catalog', 'target_boards', 'posts', 'post_metrics', 'snapshots', 'runs', 'audits',
  'source_probes', 'author_resolution_queue', 'author_resolution_jobs'];
async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'mcn-backup-throttle-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const manager = { databasePath: join(folder, 'source.sqlite'), backupDir: join(folder, 'backups'), runningPromise: null,
    calls: [], async createBackup(reason) { this.calls.push(reason); return { status: 'created', path: 'stub-only-no-real-backup' }; } };
  await mkdir(manager.backupDir);
  return manager;
}
async function manifest(manager, { published = AT - 30_000, created = published - 2000, changes = {}, failure = false } = {}) {
  const fileName = 'douyin-monitor-auto-fixture-scheduled-success-12345678.sqlite';
  const path = join(manager.backupDir, fileName), contents = 'tiny test placeholder, not a database';
  await writeFile(path, contents);
  await writeFile(path + '.manifest.json', JSON.stringify({ format: 'sqlite-online-backup-v1', fileName,
    source: manager.databasePath, createdAt: new Date(created).toISOString(), reason: 'scheduled-success',
    bytes: Buffer.byteLength(contents), sha256: 'a'.repeat(64), validation: { quickCheck: 'ok', integrityCheck: 'ok',
      foreignKeyViolations: 0, counts: Object.fromEntries(TABLES.map(name => [name, 0])) }, ...changes }));
  await utimes(path, new Date(published), new Date(published));
  await utimes(path + '.manifest.json', new Date(published), new Date(published));
  if (failure) await writeFile(join(manager.backupDir, '.last-backup-error.json'), JSON.stringify({ failedAt: new Date(AT).toISOString(), error: 'fixture' }));
}

test('first automatic backup succeeds; same process throttles successes for exactly ten minutes', async t => {
  const manager = await fixture(t); let now = AT;
  const run = createScheduledBackupThrottle(manager, { now: () => now });
  assert.equal((await run('scheduled-success')).status, 'succeeded');
  now += 599_999;
  const skipped = await run('scheduled-error');
  assert.equal(skipped.status, 'throttled'); assert.equal(skipped.nextEligibleAt, new Date(AT + 600_000).toISOString());
  assert.equal(manager.calls.length, 1);
  now++;
  assert.equal((await run('scheduled-success')).status, 'succeeded'); assert.equal(manager.calls.length, 2);
});

test('restart uses existing successful published manifest without opening or hashing the fake SQLite bytes', async t => {
  const manager = await fixture(t); await manifest(manager);
  const result = await createScheduledBackupThrottle(manager, { now: () => AT })('scheduled-success');
  assert.equal(result.status, 'throttled'); assert.equal(manager.calls.length, 0);
  assert.equal(result.lastSuccessfulAt, new Date(AT - 30_000).toISOString());
});

test('recent startup or manual full backup also protects the automatic interval but direct calls remain unaffected', async t => {
  const manager = await fixture(t); await manifest(manager, { changes: { reason: 'startup' } });
  const run = createScheduledBackupThrottle(manager, { now: () => AT });
  assert.equal((await run('scheduled-success')).status, 'throttled');
  assert.equal((await run('manual')).reason, 'not-scheduled');
  assert.equal((await run('startup')).reason, 'not-scheduled');
  await manager.createBackup('manual'); await manager.createBackup('before-release');
  assert.deepEqual(manager.calls, ['manual', 'before-release']);
});

test('failed or locked backup never consumes a success window and retries on the next request', async t => {
  const manager = await fixture(t); let attempts = 0;
  manager.createBackup = async () => { if (++attempts === 1) throw new Error('fixture failure');
    if (attempts === 2) return { status: 'skipped', reason: 'backup-locked' }; return { status: 'created' }; };
  const run = createScheduledBackupThrottle(manager, { now: () => AT });
  await assert.rejects(run('scheduled-success'), /fixture failure/);
  assert.equal((await run('scheduled-success')).reason, 'backup-locked');
  assert.equal((await run('scheduled-success')).status, 'succeeded');
  assert.equal((await run('scheduled-success')).status, 'throttled'); assert.equal(attempts, 3);
});

test('overlapping automatic requests and alternate wrappers share an in-flight guard', async t => {
  const manager = await fixture(t); let release;
  manager.createBackup = async reason => { manager.calls.push(reason); return new Promise(resolve => { release = resolve; }); };
  const first = createScheduledBackupThrottle(manager, { now: () => AT });
  const second = createScheduledBackupThrottle(manager, { now: () => AT });
  const pending = first('scheduled-success');
  assert.equal((await first('scheduled-success')).reason, 'backup-in-progress');
  assert.equal((await second('scheduled-error')).reason, 'backup-in-progress');
  release({ status: 'created' }); assert.equal((await pending).status, 'succeeded'); assert.equal(manager.calls.length, 1);
});

test('a manual backup already running is neither duplicated nor falsely declared successful', async t => {
  const manager = await fixture(t); manager.runningPromise = Promise.resolve({ status: 'created' });
  const result = await createScheduledBackupThrottle(manager, { now: () => AT })('scheduled-success');
  assert.deepEqual(result, { status: 'skipped', reason: 'backup-in-progress' }); assert.equal(manager.calls.length, 0);
});

test('missing/corrupt/foreign/future/failed metadata never suppresses a required backup', async t => {
  for (const options of [{ changes: { bytes: 999 } }, { changes: { source: '/not-this-database.sqlite' } },
    { changes: { format: 'unknown' } }, { changes: { sha256: 'x' } }, { published: AT + 1000 },
    { created: AT + 1000 }, { failure: true }, { changes: { fileName: '../wrong.sqlite' } },
    { changes: { validation: { quickCheck: 'ok', integrityCheck: 'failed', foreignKeyViolations: 0, counts: {} } } }]) {
    const manager = await fixture(t); await manifest(manager, options);
    assert.equal((await createScheduledBackupThrottle(manager, { now: () => AT })('scheduled-success')).status, 'succeeded');
    assert.equal(manager.calls.length, 1);
  }
});

test('expired prior success does not throttle; completion time controls the next interval', async t => {
  const manager = await fixture(t); await manifest(manager, { published: AT - 600_001 });
  let now = AT;
  manager.createBackup = async reason => { manager.calls.push(reason); now += 20_000; return { status: 'created' }; };
  const run = createScheduledBackupThrottle(manager, { now: () => now });
  const result = await run('scheduled-success');
  assert.equal(result.nextEligibleAt, new Date(AT + 620_000).toISOString());
  now = AT + 610_000; assert.equal((await run('scheduled-success')).status, 'throttled');
});

test('invalid API inputs fail before scheduling any backup', async t => {
  const manager = await fixture(t);
  for (const value of [0, -1, NaN, Infinity, 1.2, '600000']) assert.throws(() => createScheduledBackupThrottle(manager, { minIntervalMs: value }));
  const run = createScheduledBackupThrottle(manager, { now: () => AT });
  for (const reason of [null, undefined, '', 'scheduled', 'scheduled-success/../../', 'scheduled-success\nmanual']) {
    assert.equal((await run(reason)).status, 'skipped');
  }
  await assert.rejects(createScheduledBackupThrottle(manager, { now: () => NaN })('scheduled-success'));
  assert.equal(manager.calls.length, 0);
});
