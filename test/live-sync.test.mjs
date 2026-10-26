import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveSync, monitoringFingerprint } from '../public/live-sync.js';

const status = (completedCount = 0) => ({ scheduler: { currentRun: { runId: 'run-1', completedCount, heartbeatAt: 'heartbeat' }, currentSlotKey: 'slot', lastScheduledRunFinishedAt: null }, sourcePoller: { updatedAt: 'source-1' } });
function fixture() {
  let time = 0, source = status(), readStatusImpl = async () => source, readDataImpl = async () => ({ version: source.scheduler.currentRun.completedCount });
  const context = { visible: true, online: true, busy: false, blocked: '', scopeKey: 'scope-A' }, events = [], applied = [], calls = { status: 0, data: 0 };
  const sync = createLiveSync({ now: () => time, context: () => context,
    readStatus: args => { calls.status++; return readStatusImpl(args); },
    readData: args => { calls.data++; return readDataImpl(args); },
    applyData: (data, options) => { applied.push({ data, options }); }, notify: value => events.push(value) });
  sync.markApplied(source);
  return { sync, context, events, applied, calls, advance(ms) { time += ms; }, source(value) { source = value; }, statusImpl(fn) { readStatusImpl = fn; }, dataImpl(fn) { readDataImpl = fn; } };
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test('heartbeat or response check timestamp alone never triggers the heavy snapshot read', async () => {
  const f = fixture(); const next = status(); next.scheduler.currentRun.heartbeatAt = 'later'; next.checkedAt = 'later';
  assert.equal(monitoringFingerprint(status()), monitoringFingerprint(next));
  f.source(next); await f.sync.tick(); assert.equal(f.calls.status, 1); assert.equal(f.calls.data, 0);
});

test('actual run progress reads once and updates only after successful data return', async () => {
  const f = fixture(); f.source(status(1)); await f.sync.tick(); await f.sync.tick();
  assert.equal(f.calls.status, 2); assert.equal(f.calls.data, 1); assert.equal(f.applied.length, 1);
});

test('five-minute fallback refreshes saved snapshots even when collector fingerprint is unchanged', async () => {
  const f = fixture(); f.advance(299_999); await f.sync.tick(); assert.equal(f.calls.data, 0);
  f.advance(1); await f.sync.tick(); assert.equal(f.calls.data, 1);
});

test('focus and timer signals join a single in-flight status/data cycle', async () => {
  const f = fixture(), gate = deferred(); f.statusImpl(() => gate.promise);
  const first = f.sync.tick(), second = f.sync.tick();
  assert.equal(first, second); assert.equal(f.calls.status, 1);
  gate.resolve(status(1)); await first; assert.equal(f.calls.data, 1);
});

test('hidden, offline and explicit manual loading states do not initiate reads', async () => {
  const f = fixture();
  for (const field of ['visible', 'online', 'busy']) {
    f.context[field] = field === 'busy'; await f.sync.tick({ force: true });
    f.context[field] = field !== 'busy';
  }
  assert.deepEqual(f.calls, { status: 0, data: 0 });
});

test('typing or opening a drawer while response is in flight stages data until safe', async () => {
  const f = fixture(), gate = deferred(); f.source(status(1)); f.dataImpl(() => gate.promise);
  const run = f.sync.tick(); await Promise.resolve();
  f.context.blocked = 'drawer'; gate.resolve({ version: 1 }); await run;
  assert.equal(f.applied.length, 0); assert.equal(f.sync.snapshot().pending, true);
  assert.equal(f.sync.flush(), false);
  f.context.blocked = ''; assert.equal(f.sync.flush(), true); assert.equal(f.applied.length, 1);
});

test('manual filter changes invalidate a late automatic response even when transport ignores abort', async () => {
  const f = fixture(), gate = deferred(); f.source(status(1)); f.dataImpl(() => gate.promise);
  const run = f.sync.tick(); await Promise.resolve();
  f.sync.invalidate(); f.context.scopeKey = 'scope-B'; gate.resolve({ wrongScope: true }); await run;
  assert.equal(f.applied.length, 0); assert.equal(f.sync.snapshot().pending, false);
});

test('a pending snapshot for a previous scope is discarded rather than applied', async () => {
  const f = fixture(); f.source(status(1)); f.context.blocked = 'draft'; await f.sync.tick();
  f.context.scopeKey = 'scope-B'; f.context.blocked = ''; f.sync.flush();
  assert.equal(f.applied.length, 0); assert.equal(f.sync.snapshot().pending, false);
  assert.equal(f.events.at(-1).kind, 'ready');
  assert.equal(f.events.at(-1).pending, false);
});

test('failed and forbidden automatic reads preserve prior data and retry before the fallback deadline', async () => {
  const f = fixture(); f.source(status(1)); let attempts = 0;
  f.dataImpl(async () => { attempts++; if (attempts === 1) throw Object.assign(new Error('forbidden'), { status: 403 }); return { version: 1 }; });
  await f.sync.tick(); assert.equal(f.applied.length, 0); assert.equal(f.events.at(-1).status, 403);
  await f.sync.tick(); assert.equal(f.calls.data, 2); assert.equal(f.applied.length, 1);
});

test('hiding while reading prevents application and resuming rechecks progress', async () => {
  const f = fixture(), gate = deferred(); f.source(status(1)); f.dataImpl(() => gate.promise);
  const run = f.sync.tick(); await Promise.resolve(); f.context.visible = false; f.sync.pause();
  gate.resolve({ version: 1 }); await run; assert.equal(f.applied.length, 0);
  f.context.visible = true; f.dataImpl(async () => ({ version: 2 })); await f.sync.tick(); assert.equal(f.applied.length, 1);
});

test('source refresh, completion and slot transitions are data fingerprints but presentation status is not', () => {
  const original = monitoringFingerprint(status());
  for (const change of [value => { value.sourcePoller.updatedAt = 'new'; }, value => { value.scheduler.currentSlotKey = 'next'; }, value => { value.scheduler.lastScheduledRunFinishedAt = 'done'; }, value => { value.scheduler.currentRun.runId = 'next'; }]) {
    const next = status(); change(next); assert.notEqual(monitoringFingerprint(next), original);
  }
});
