import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ConsoleReader } from '../lib/console-reader.mjs';

class FakeWorker extends EventEmitter {
  sent = [];
  terminated = 0;
  unref() {}
  postMessage(job) { this.sent.push(job); }
  terminate() { this.terminated++; return Promise.resolve(0); }
  answer(index, result) { this.emit('message', { id: this.sent[index].id, ok: true, result }); }
}
function fixture(t, options = {}) {
  const workers = [];
  const reader = new ConsoleReader({ databasePath: '/not-a-production-database.sqlite',
    workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; }, ...options });
  t.after(() => reader.close());
  return { reader, workers };
}

test('creator operating queries reuse one bounded reader lane but never stale dashboard caching',async t=>{
 const {reader,workers}=fixture(t,{maxQueue:2});
 const query={view:'authors',q:'fixture',asOf:'2026-10-30T18:35:00.000Z'};
 const first=reader.creatorOperatingView(query),second=reader.creatorOperatingView(query);
 assert.notStrictEqual(first,second);assert.equal(workers[0].sent.length,1);
 assert.equal(workers[0].sent[0].kind,'creator-operating');
 workers[0].answer(0,{version:1});workers[0].answer(1,{version:2});
 assert.deepEqual(await first,{version:1});assert.deepEqual(await second,{version:2});
 const fresh=reader.creatorOperatingView(query);assert.equal(workers[0].sent.length,3);
 workers[0].answer(2,{version:3});assert.deepEqual(await fresh,{version:3});
 assert.equal(reader.cache.size,0);assert.equal(workers.length,1);
});

test('one hundred concurrent identical reads share one job and one read-only result', async (t) => {
  const { reader, workers } = fixture(t, { maxQueue: 2 });
  const requests = Array.from({ length: 100 }, () => reader.overview({ period: 'day', theme: 'tuantuan' }));
  assert.equal(new Set(requests).size, 1);
  assert.equal(workers[0].sent.length, 1);
  workers[0].answer(0, { value: 123, actual: true });
  assert.ok((await Promise.all(requests)).every((value) => value.value === 123));
  assert.equal(reader.jobs.size, 0);
});

test('different queries are serialized with a bound, identical queued reads coalesce', async (t) => {
  const { reader, workers } = fixture(t, { maxQueue: 2 });
  const first = reader.overview({ period: 'day' });
  const second = reader.overview({ period: 'month' });
  assert.strictEqual(second, reader.overview({ period: 'month' }));
  assert.equal(workers[0].sent.length, 1, 'not dispatch every job into an unbounded worker inbox');
  await assert.rejects(reader.account(1), { code: 'CONSOLE_READER_BUSY', status: 503 });
  workers[0].answer(0, { period: 'day' });
  assert.equal(workers[0].sent.length, 2);
  workers[0].answer(1, { period: 'month' });
  assert.deepEqual(await Promise.all([first, second]), [{ period: 'day' }, { period: 'month' }]);
});

test('canonical option ordering shares a cache while account IDs remain isolated', async (t) => {
  const { reader, workers } = fixture(t);
  const one = reader.overview({ period: 'day', theme: 'all' });
  const same = reader.overview({ theme: 'all', period: 'day' });
  assert.strictEqual(one, same);
  workers[0].answer(0, { value: 1 });
  await one;
  assert.deepEqual(await reader.overview({ theme: 'all', period: 'day' }), { value: 1 });
  const a = reader.account(10); const b = reader.account(20);
  workers[0].answer(1, { id: 10 }); workers[0].answer(2, { id: 20 });
  assert.deepEqual(await Promise.all([a, b]), [{ id: 10 }, { id: 20 }]);
});

test('invalidated in-flight results neither enter cache nor serve new requests', async (t) => {
  const { reader, workers } = fixture(t);
  const old = reader.overview({ period: 'day' });
  reader.invalidate();
  const fresh = reader.overview({ period: 'day' });
  assert.notStrictEqual(old, fresh);
  workers[0].answer(0, { version: 'before-write' });
  assert.equal(reader.cache.size, 0);
  workers[0].answer(1, { version: 'after-write' });
  assert.deepEqual(await fresh, { version: 'after-write' });
  assert.deepEqual(await old, { version: 'before-write' });
  assert.deepEqual(await reader.overview({ period: 'day' }), { version: 'after-write' });
});

test('unexpected worker error rejects all waiting reads and next read recovers without leaking errors', async (t) => {
  const { reader, workers } = fixture(t);
  const first = reader.overview(); const second = reader.account(2);
  const settled = Promise.allSettled([first, second]);
  workers[0].emit('error', new Error('Cookie=SECRET; private-path'));
  for (const result of await settled) {
    assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'CONSOLE_READER_FAILED');
    assert.doesNotMatch(result.reason.message, /SECRET|private-path/);
  }
  assert.equal(workers.length, 1, 'no automatic restart loop');
  const recovered = reader.overview();
  assert.equal(workers.length, 2);
  workers[0].answer(0, { stale: true });
  workers[1].answer(0, { recovered: true });
  assert.deepEqual(await recovered, { recovered: true });
});

test('unexpected clean worker exit is recoverable too', async (t) => {
  const { reader, workers } = fixture(t);
  const pending = reader.overview(); const check = assert.rejects(pending, { code: 'CONSOLE_READER_FAILED' });
  workers[0].emit('exit', 0); await check;
  const next = reader.overview(); workers[1].answer(0, {}); await next;
});

test('active timeout terminates stuck worker, clears the queue, then recovers on demand', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { reader, workers } = fixture(t, { timeoutMs: 50 });
  const first = reader.overview(); const queued = reader.account(9);
  const settled = Promise.allSettled([first, queued]);
  t.mock.timers.tick(50);
  assert.ok((await settled).every((r) => r.status === 'rejected' && r.reason.code === 'CONSOLE_READER_TIMEOUT'));
  assert.equal(workers[0].terminated, 1); assert.equal(reader.jobs.size, 0);
  const next = reader.overview(); workers[1].answer(0, { ok: true }); assert.deepEqual(await next, { ok: true });
});

test('queue waiting time is included in the request deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { reader, workers } = fixture(t, { timeoutMs: 50 });
  const first = reader.overview();
  t.mock.timers.tick(10);
  const queued = reader.account(9);
  t.mock.timers.tick(30); workers[0].answer(0, {}); await first;
  const check = assert.rejects(queued, { code: 'CONSOLE_READER_TIMEOUT' });
  t.mock.timers.tick(20); await check;
  assert.equal(workers[0].terminated, 1, 'timeout at 60ms, not 90ms');
});

test('Beijing midnight bypasses a still-live today cache', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-26T15:59:59Z') });
  const { reader, workers } = fixture(t);
  const first = reader.overview({ period: 'day', timeZone: 'Asia/Shanghai' }); workers[0].answer(0, { date: '26' }); await first;
  t.mock.timers.setTime(Date.parse('2026-09-26T16:00:01Z'));
  const next = reader.overview({ period: 'day', timeZone: 'Asia/Shanghai' });
  assert.equal(workers[0].sent.length, 2); workers[0].answer(1, { date: '27' });
  assert.deepEqual(await next, { date: '27' });
});

test('close rejects pending work, clears cache and is idempotent', async (t) => {
  const { reader, workers } = fixture(t);
  const pending = reader.overview(); const check = assert.rejects(pending, { code: 'CONSOLE_READER_CLOSED' });
  await reader.close(); await check; await reader.close();
  assert.equal(workers[0].terminated, 1);
  await assert.rejects(reader.overview(), { code: 'CONSOLE_READER_CLOSED' });
  assert.equal(reader.pending.size, 0); assert.equal(reader.queue.length, 0);
});
