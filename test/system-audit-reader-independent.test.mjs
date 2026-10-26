import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MonitorDatabase } from '../lib/database.mjs';
import { SQLiteBackupManager } from '../lib/backup-manager.mjs';
import { SystemAuditReader } from '../lib/system-audit-reader.mjs';

const fixtureUrl = new URL('./fixtures/audit-worker-independent.mjs', import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');

async function smallDatabase(t) {
  const dir = await mkdtemp(join(tmpdir(), 'audit-peer-'));
  const databasePath = join(dir, 'source.sqlite'); const backupDir = join(dir, 'backups');
  const database = new MonitorDatabase(databasePath);
  const target = database.createTarget({ type: 'account', label: 'offline audit peer', locator: 'offline-audit-peer', provider: 'manual', metadata: {}, boards: ['offline audit board'] });
  const backup = await new SQLiteBackupManager({ databasePath, backupDir }).createBackup('independent-test');
  const reader = new SystemAuditReader({ databasePath, backupDir });
  t.after(async () => { await reader.close(); database.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, database, databasePath, backupDir, backup, target, reader };
}

test('independent audit: actual worker reads small DB and deep backup without changing evidence files or rows', async t => {
  const f = await smallDatabase(t);
  const paths = [f.databasePath, f.backup.path, `${f.backup.path}.manifest.json`];
  const before = await Promise.all(paths.map(sha));
  const auditCount = f.database.db.prepare('SELECT COUNT(*) AS n FROM audits').get().n;
  const result = await f.reader.read({ deep: true });
  assert.equal(result.database.status, 'ok'); assert.equal(result.backup.status, 'ok');
  assert.equal(result.backup.verification, 'sha256+sqlite'); assert.equal(result.backup.sha256Matched, true);
  assert.equal(result.database.counts.targets, 1);
  assert.ok(Number.isFinite(Date.parse(result.checkStartedAt))); assert.ok(Date.parse(result.checkFinishedAt) >= Date.parse(result.checkStartedAt));
  assert.deepEqual(await Promise.all(paths.map(sha)), before);
  assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM audits').get().n, auditCount);
});

test('independent audit: no result cache can hide newer backup hash, count, or durable failure evidence', async t => {
  const f = await smallDatabase(t);
  assert.equal((await f.reader.read({ deep: true })).backup.status, 'ok');
  const manifestPath = `${f.backup.path}.manifest.json`; const original = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(original); manifest.sha256 = '0'.repeat(64);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const shallow = await f.reader.read(); assert.equal(shallow.backup.status, 'ok');
  assert.equal(shallow.backup.verification, 'manifest');
  const deep = await f.reader.read({ deep: true }); assert.equal(deep.backup.status, 'error'); assert.match(deep.backup.error, /SHA-256/);
  await writeFile(manifestPath, original);
  const wrongCount = JSON.parse(original); wrongCount.validation.counts.targets++;
  await writeFile(manifestPath, JSON.stringify(wrongCount));
  const counts = await f.reader.read({ deep: true }); assert.equal(counts.backup.status, 'error'); assert.match(counts.backup.error, /行数/);
  await writeFile(manifestPath, original);
  assert.equal((await f.reader.read({ deep: true })).backup.status, 'ok');
  const originalBytes = await readFile(f.backup.path); const corruptedBytes = Buffer.from(originalBytes);
  corruptedBytes[corruptedBytes.length - 1] ^= 1;
  await writeFile(f.backup.path, corruptedBytes);
  const corrupted = await f.reader.read({ deep: true }); assert.equal(corrupted.backup.status, 'error'); assert.match(corrupted.backup.error, /SHA-256/);
  await writeFile(f.backup.path, originalBytes);
  assert.equal((await f.reader.read({ deep: true })).backup.status, 'ok');
  await writeFile(join(f.backupDir, '.last-backup-error.json'), JSON.stringify({ failedAt: new Date().toISOString(), error: 'offline backup failed' }));
  const failed = await f.reader.read({ deep: true }); assert.equal(failed.backup.status, 'error'); assert.match(failed.backup.error, /offline backup failed/);
});

test('independent audit: a later real SQLite quality violation replaces former healthy audit', async t => {
  const f = await smallDatabase(t);
  assert.equal((await f.reader.read()).database.status, 'ok');
  f.database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,quality_status,account_status,works_coverage,warnings_json,source_checksum,raw_json)
    VALUES(?,?,?,?,?,?,?,?)`).run(f.target.id, new Date().toISOString(), 'validated', 'available', 'complete', '[]', 'offline-invalid', '{}');
  const bad = await f.reader.read();
  assert.equal(bad.database.status, 'error'); assert.equal(bad.database.dataQuality.checks.snapshotMetricContract.count, 1);
  assert.equal(bad.backup.status, 'ok', 'historical backup and current DB are separate evidence');
});

function realFixture(t, modes, { timeoutMs = 1500 } = {}) {
  const workers = []; const sends = [];
  const reader = new SystemAuditReader({ databasePath: '/offline-not-opened.sqlite', backupDir: '/offline-not-opened-backups', timeoutMs,
    workerFactory: () => {
      const index = workers.length;
      const worker = new Worker(fixtureUrl, { workerData: { mode: modes[index] || modes.at(-1), marker: `generation-${index}` }, execArgv: [] });
      const original = worker.postMessage.bind(worker);
      worker.postMessage = value => { sends.push({ worker: index, value }); return original(value); };
      workers.push(worker); return worker;
    } });
  t.after(() => reader.close());
  return { reader, workers, sends };
}

test('independent audit: real-worker CPU work leaves main timer responsive; same-mode concurrency coalesces but next read is fresh', async t => {
  const { reader, sends } = realFixture(t, ['cpu']);
  let timerRan = false; const timer = setTimeout(() => { timerRan = true; }, 10);
  const reads = Array.from({ length: 12 }, () => reader.read({ deep: true }));
  const values = await Promise.all(reads); clearTimeout(timer);
  assert.equal(timerRan, true); assert.equal(sends.length, 1); assert.equal(values.length, 12);
  await reader.read({ deep: true }); assert.equal(sends.length, 2, 'completed values are not cached');
});

test('independent audit: shallow and deep work are serialized separately, with only identical in-flight requests deduplicated', async t => {
  const { reader, sends } = realFixture(t, ['cpu']);
  const shallow = reader.read(); const deep = reader.read({ deep: true }); const duplicate = reader.read({ deep: true });
  assert.equal(sends.length, 1);
  await Promise.all([shallow, deep, duplicate]);
  assert.equal(sends.length, 2); assert.equal(sends[0].value.deep, false); assert.equal(sends[1].value.deep, true);
});

for (const mode of ['throw', 'exit', 'error-message', 'hang']) test(`independent audit: real worker ${mode} never leaks private errors or retains old success and can recover on demand`, async t => {
  const { reader, workers } = realFixture(t, [mode, 'ok'], { timeoutMs: mode === 'hang' ? 100 : 1500 });
  const first = reader.read({ deep: true }); const queued = reader.read();
  const outcomes = await Promise.allSettled([first, queued]);
  assert.ok(outcomes.every(outcome => outcome.status === 'rejected'));
  for (const outcome of outcomes) {
    assert.equal(outcome.reason.code, mode === 'hang' ? 'SYSTEM_AUDIT_TIMEOUT' : 'SYSTEM_AUDIT_UNAVAILABLE');
    assert.doesNotMatch(outcome.reason.message, /PRIVATE_SENTINEL|offline-not-opened/);
  }
  assert.equal(workers.length, 1, 'no autonomous restart loop');
  const recovered = await reader.read(); assert.equal(recovered.database.marker, 'generation-1');
  assert.equal(workers.length, 2);
  await reader.close(); assert.ok(workers.every(worker => worker.threadId === -1));
});

test('independent audit: close rejects active and queued real-worker work, is idempotent and leaves no live worker', async t => {
  const { reader, workers } = realFixture(t, ['hang']);
  const pending = Promise.allSettled([reader.read(), reader.read({ deep: true })]);
  await reader.close(); await reader.close();
  for (const outcome of await pending) { assert.equal(outcome.status, 'rejected'); assert.equal(outcome.reason.code, 'SYSTEM_AUDIT_CLOSED'); }
  assert.ok(workers.every(worker => worker.threadId === -1));
  await assert.rejects(reader.read(), { code: 'SYSTEM_AUDIT_CLOSED' });
});

test('independent audit: missing database is rejected without creating a database or leaking its path', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-peer-missing-')); const databasePath = join(dir, 'missing.sqlite');
  const reader = new SystemAuditReader({ databasePath, backupDir: join(dir, 'backups') });
  t.after(async () => { await reader.close(); await rm(dir, { recursive: true, force: true }); });
  await assert.rejects(reader.read({ deep: true }), error => error.code === 'SYSTEM_AUDIT_UNAVAILABLE' && !error.message.includes(dir));
  await assert.rejects(access(databasePath), { code: 'ENOENT' });
});

class LateWorker extends EventEmitter {
  sent = []; terminated = 0;
  unref() {}
  postMessage(job) { this.sent.push(job); }
  terminate() { this.terminated++; return Promise.resolve(0); }
  answer(index, marker) { this.emit('message', { id: this.sent[index].id, ok: true, result: { database: { status: 'ok', marker }, backup: { status: 'ok' }, checkStartedAt: new Date().toISOString(), checkFinishedAt: new Date().toISOString() } }); }
}
test('independent audit: retired worker late success cannot settle a fresh generation or replace a new error', async t => {
  const workers = [];
  const reader = new SystemAuditReader({ databasePath: '/offline', backupDir: '/offline', workerFactory: () => { const worker = new LateWorker(); workers.push(worker); return worker; } });
  t.after(() => reader.close());
  const failed = assert.rejects(reader.read(), { code: 'SYSTEM_AUDIT_UNAVAILABLE' }); workers[0].emit('exit', 0); await failed;
  let settled = false; const fresh = reader.read().finally(() => { settled = true; });
  workers[0].answer(0, 'stale-healthy'); await pause(1); assert.equal(settled, false);
  workers[1].answer(0, 'fresh'); assert.equal((await fresh).database.marker, 'fresh');
  const next = assert.rejects(reader.read(), { code: 'SYSTEM_AUDIT_UNAVAILABLE' });
  workers[1].emit('error', new Error('PRIVATE_SENTINEL')); await next;
  workers[0].answer(0, 'older-healthy'); workers[1].answer(0, 'old-healthy');
  await reader.close(); assert.equal(workers.length, 2);
});

for (const kind of ['factory', 'postMessage']) test(`independent audit: synchronous ${kind} failure rejects cleanly and is demand-recoverable`, async t => {
  let attempts = 0; const workers = [];
  const reader = new SystemAuditReader({ databasePath: '/offline', backupDir: '/offline', workerFactory: () => {
    attempts++;
    if (kind === 'factory' && attempts === 1) throw Error('PRIVATE_SENTINEL');
    const worker = new LateWorker(); workers.push(worker);
    if (kind === 'postMessage' && attempts === 1) worker.postMessage = () => { throw Error('PRIVATE_SENTINEL'); };
    return worker;
  } });
  t.after(() => reader.close());
  await assert.rejects(reader.read(), error => error.code === 'SYSTEM_AUDIT_UNAVAILABLE' && !error.message.includes('PRIVATE_SENTINEL'));
  assert.equal(attempts, 1);
  const recovery = reader.read(); workers.at(-1).answer(0, 'recovered');
  assert.equal((await recovery).database.marker, 'recovered'); assert.equal(attempts, 2);
});

test('independent audit: malformed success envelope fails closed instead of presenting an audit as healthy', async t => {
  const worker = new LateWorker(); const reader = new SystemAuditReader({ databasePath: '/offline', backupDir: '/offline', workerFactory: () => worker });
  t.after(() => reader.close());
  const failed = assert.rejects(reader.read(), { code: 'SYSTEM_AUDIT_UNAVAILABLE' });
  worker.emit('message', { id: worker.sent[0].id, ok: true, result: { database: { status: 'ok' }, backup: { status: 'ok' } } });
  await failed; assert.equal(reader.jobs.size, 0);
});

test('independent audit: real idle worker does not keep a separate process alive after completed read', async t => {
  const f = await smallDatabase(t);
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./fixtures/audit-worker-idle-parent.mjs', import.meta.url)), f.databasePath, f.backupDir], { timeout: 3000, encoding: 'utf8' });
  assert.equal(stdout, ''); assert.doesNotMatch(stderr, /PRIVATE_SENTINEL|Unhandled|Error:/);
});
