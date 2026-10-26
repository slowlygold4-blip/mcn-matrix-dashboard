import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SystemAuditReader } from '../lib/system-audit-reader.mjs';

class FakeWorker extends EventEmitter {
  messages = [];
  terminated = false;
  postMessage(message) { this.messages.push(message); }
  unref() {}
  terminate() { this.terminated = true; return Promise.resolve(0); }
  succeed(message = this.messages.at(-1)) {
    this.emit('message', { id: message.id, ok: true, result: {
      database: { status: 'ok' }, backup: { status: 'missing' },
      checkStartedAt: '2026-09-29T00:00:00.000Z', checkFinishedAt: '2026-09-29T00:00:01.000Z',
    } });
  }
}

test('deduplicates only pending same-mode work and serializes shallow/deep without success cache', async () => {
  const worker = new FakeWorker();
  const reader = new SystemAuditReader({ databasePath: '/fixture', backupDir: '/backups', workerFactory: () => worker });
  const shallow = reader.read();
  assert.equal(reader.read(), shallow);
  const deep = reader.read({ deep: true });
  assert.equal(reader.read({ deep: true }), deep);
  assert.equal(worker.messages.length, 1);
  assert.equal(worker.messages[0].deep, false);
  worker.succeed(); await shallow;
  assert.equal(worker.messages.length, 2);
  assert.equal(worker.messages[1].deep, true);
  worker.succeed(); await deep;
  const fresh = reader.read();
  assert.notEqual(fresh, shallow);
  assert.equal(worker.messages.length, 3);
  worker.succeed(); await fresh;
  await reader.close();
});

test('timeout rejects both modes, ignores old messages, and next read recovers', async () => {
  const workers = [];
  const reader = new SystemAuditReader({ databasePath: '/fixture', backupDir: '/backups', timeoutMs: 20,
    workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
  const failed = await Promise.allSettled([reader.read(), reader.read({ deep: true })]);
  assert.ok(failed.every((item) => item.reason.code === 'SYSTEM_AUDIT_TIMEOUT'));
  assert.equal(workers[0].terminated, true);
  const next = reader.read();
  workers[0].succeed();
  workers[1].succeed();
  assert.equal((await next).database.status, 'ok');
  await reader.close();
});

test('close rejects pending and future reads, including queued work', async () => {
  const worker = new FakeWorker();
  const reader = new SystemAuditReader({ databasePath: '/fixture', backupDir: '/backups', workerFactory: () => worker });
  const pending = Promise.allSettled([reader.read(), reader.read({ deep: true })]);
  await reader.close(); await reader.close();
  assert.ok((await pending).every((item) => item.reason.code === 'SYSTEM_AUDIT_CLOSED'));
  await assert.rejects(reader.read(), { code: 'SYSTEM_AUDIT_CLOSED' });
  assert.equal(worker.terminated, true);
});
