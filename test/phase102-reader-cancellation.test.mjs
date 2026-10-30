import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { getEventListeners } from 'node:events';
import { MonitorDatabase } from '../lib/database.mjs';
import { ConsoleReader } from '../lib/console-reader.mjs';

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phase102-reader-'));
  const database = new MonitorDatabase(join(dir, 'offline.sqlite'));
  const target = database.createTarget({ type:'account', provider:'manual', label:'仅离线取消', locator:'phase102-offline', enabled:false });
  const workers = [];
  const reader = new ConsoleReader({ databasePath:database.filePath, cacheTtlMs:0, timeoutMs:5000,
    workerFactory: () => { const worker = new Worker(new URL('../lib/console-reader-worker.mjs', import.meta.url), { workerData:{ databasePath:database.filePath } }); workers.push(worker); return worker; }, ...options });
  t.after(async () => { await reader.close(); database.close(); rmSync(dir, { recursive:true, force:true }); });
  return { reader, target, workers, database };
}
const opts = { period:'day', reference:'2026-10-02T05:29:05Z', timeZone:'Asia/Shanghai' };

for (const kind of ['overview','account','history']) test(`phase102 actual worker: ${kind} subscriber abort leaves same-key survivor`, async t => {
  const {reader,target,workers}=fixture(t);
  const a=new AbortController(), b=new AbortController();
  const read=signal=>kind==='overview'?reader.overview(opts,{signal}):reader[kind](target.id,kind==='history'?{}:opts,{signal});
  const first=read(a.signal), second=read(b.signal);
  const rejected=assert.rejects(first,{code:'CONSOLE_READER_ABORTED'});
  a.abort();
  await rejected;
  assert.ok(await second);
  assert.equal(workers.length,1);
  assert.equal(reader.jobs.size,0);
  assert.equal(getEventListeners(a.signal,'abort').length,0);
  assert.equal(getEventListeners(b.signal,'abort').length,0);
});

test('phase102 actual worker: uncancellable same-promise reader survives signal caller abort',async t=>{
  const {reader,workers}=fixture(t);const c=new AbortController();
  const first=reader.overview(opts);assert.equal(first,reader.overview(opts));
  const cancelled=reader.overview(opts,{signal:c.signal});const rejected=assert.rejects(cancelled,{code:'CONSOLE_READER_ABORTED'});
  c.abort();await rejected;assert.ok(await first);assert.equal(workers.length,1);
});

test('phase102 actual worker: final active cancellation preserves a different queued read and retires old worker',async t=>{
  const {reader,workers}=fixture(t);const c=new AbortController();
  const first=reader.overview(opts,{signal:c.signal});const rejected=assert.rejects(first,{code:'CONSOLE_READER_ABORTED'});
  const queued=reader.overview({...opts,period:'week'});
  c.abort();await rejected;assert.ok(await queued);
  assert.equal(workers.length,2);assert.equal(workers[0].threadId,-1);
  assert.equal(reader.jobs.size,0);assert.equal(reader.pending.size,0);assert.equal(reader.terminations.size,0);
});

test('phase102 actual worker: queued final cancellation is not posted and does not retire active reader',async t=>{
  const {reader,workers}=fixture(t);const c=new AbortController();
  const first=reader.overview(opts), queued=reader.overview({...opts,period:'month'},{signal:c.signal});
  const rejected=assert.rejects(queued,{code:'CONSOLE_READER_ABORTED'});c.abort();await rejected;assert.ok(await first);
  assert.equal(workers.length,1);assert.equal(reader.queue.length,0);
});

test('phase102 actual worker: cached values cannot bypass a pre-aborted caller',async t=>{
  const {reader}=fixture(t,{cacheTtlMs:30000});await reader.overview(opts);
  const c=new AbortController();c.abort();await assert.rejects(reader.overview(opts,{signal:c.signal}),{code:'CONSOLE_READER_ABORTED'});
});

test('phase102 actual worker: same-key subscriptions have a finite bound and release all listeners',async t=>{
  const {reader}=fixture(t), controllers=Array.from({length:128},()=>new AbortController());
  const pending=controllers.map(c=>assert.rejects(reader.overview(opts,{signal:c.signal}),{code:'CONSOLE_READER_ABORTED'}));
  await assert.rejects(reader.overview(opts,{signal:new AbortController().signal}),{code:'CONSOLE_READER_BUSY'});
  for(const c of controllers)c.abort();await Promise.all(pending);
  for(const c of controllers)assert.equal(getEventListeners(c.signal,'abort').length,0);
  assert.equal(reader.jobs.size,0);
});

test('phase102 actual worker: slow termination bounds replacement workers and close waits for release',async t=>{
  const {reader,workers}=fixture(t);
  const a=new AbortController();const cancelled=reader.overview(opts,{signal:a.signal});
  const old=workers[0],original=old.terminate.bind(old);
  let release;const hold=new Promise(resolve=>{release=resolve;});
  old.terminate=async()=>{await original();await hold;return 0;};
  const rejection=assert.rejects(cancelled,{code:'CONSOLE_READER_ABORTED'});a.abort();await rejection;
  for(let i=0;i<10;i++){const c=new AbortController(),p=reader.overview({...opts,board:String(i)},{signal:c.signal});const rejected=assert.rejects(p,{code:'CONSOLE_READER_ABORTED'});c.abort();await rejected;}
  assert.equal(workers.length,1);assert.equal(reader.terminations.size,1);
  let closed=false;const closing=reader.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);
  release();await closing;assert.equal(reader.terminations.size,0);assert.equal(reader.jobs.size,0);
});
