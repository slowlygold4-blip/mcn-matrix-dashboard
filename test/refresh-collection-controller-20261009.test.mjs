import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollectionRefresh } from '../public/refresh-collection.js';

const endpoint = '/api/refresh-collection';
const job = (status = 'queued', id = 'refresh-1') => ({ id, status });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(setImmediate);
function fixture(t, handler, complete = async () => {}) {
  const calls = [], changes = [], completed = [], timers = new Map();
  let timerSequence = 0;
  const controller = createCollectionRefresh({
    api: (path, options = {}) => { calls.push({ path, options }); return handler(path, options, calls.length); },
    onChange: state => changes.push({ ...state }),
    onComplete: async value => { completed.push(value); await complete(value); },
    setTimer: (callback, delay) => { const id = ++timerSequence; timers.set(id, { callback, delay }); return id; },
    clearTimer: id => timers.delete(id),
  });
  t.after(() => controller.dispose());
  return { controller, calls, changes, completed, timers,
    async tick() {
      assert.equal(timers.size, 1, 'only one collection status timer should exist');
      const [id, timer] = timers.entries().next().value;
      assert.equal(timer.delay, 5000);
      timers.delete(id); timer.callback(); await settle();
    },
  };
}

test('manual collection starts only on request and overlapping clicks submit one empty global request', async t => {
  const gate = deferred();
  const f = fixture(t, () => gate.promise);
  assert.deepEqual(f.controller.getState(), { job: null, submitting: false, checking: false, error: '' });
  assert.equal(f.calls.length, 0);
  const first = f.controller.request(), second = f.controller.request();
  assert.equal(first, second);
  assert.equal(f.controller.getState().submitting, true);
  assert.deepEqual(f.calls, [{ path: endpoint, options: { method: 'POST', body: '{}' } }]);
  assert.equal(f.completed.length, 0);
  gate.resolve({ job: job(), reused: false }); await first;
  assert.equal(f.controller.getState().submitting, false);
  assert.equal(f.controller.getState().job.status, 'queued');
  assert.equal(f.timers.size, 1);
});

test('queued and running jobs poll their exact identity and refresh saved data once after completion', async t => {
  const id = 'refresh/job ?1', replies = ['queued', 'running', 'completed'];
  const f = fixture(t, async () => ({ job: job(replies.shift(), id) }));
  await f.controller.request();
  await f.tick();
  assert.equal(f.controller.getState().job.status, 'running');
  assert.equal(f.completed.length, 0);
  await f.tick();
  assert.deepEqual(f.calls.slice(1).map(call => call.path), [1, 2].map(() => `${endpoint}?jobId=${encodeURIComponent(id)}`));
  assert.ok(f.calls.slice(1).every(call => !call.options.method || call.options.method === 'GET'));
  assert.equal(f.completed.length, 1);
  assert.equal(f.completed[0].status, 'completed');
  assert.equal(f.timers.size, 0);
});

test('manual clicks during an active collection recheck that job and share the pending read', async t => {
  const read = deferred();
  const f = fixture(t, async (_path, options) => options.method === 'POST' ? { job: job('running'), reused: true } : read.promise);
  await f.controller.request();
  const first = f.controller.request(), second = f.controller.request();
  assert.equal(first, second);
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(f.calls[1].path, `${endpoint}?jobId=refresh-1`);
  await f.tick();
  assert.equal(f.calls.length, 2, 'timer joins the pending GET instead of starting another read');
  read.resolve({ job: job('running') }); await first;
  assert.equal(f.timers.size, 1);
});

for (const status of ['completed', 'failed', 'interrupted']) {
  test(`restoring a historical ${status} job displays its state without starting collection or refreshing data`, async t => {
    const f = fixture(t, async () => ({ job: job(status) }));
    await f.controller.restore();
    assert.deepEqual(f.calls, [{ path: endpoint, options: {} }]);
    assert.equal(f.controller.getState().job.status, status);
    assert.equal(f.completed.length, 0);
    assert.equal(f.timers.size, 0);
  });
}

for (const status of ['completed', 'failed', 'interrupted']) {
  test(`restored active collection refreshes saved data once when it becomes ${status}`, async t => {
    const f = fixture(t, async (_path, _options, count) => ({ job: job(count === 1 ? 'running' : status) }));
    await f.controller.restore();
    assert.equal(f.completed.length, 0);
    await f.tick();
    assert.equal(f.completed.length, 1);
    assert.equal(f.completed[0].status, status);
    assert.equal(f.calls[1].path, `${endpoint}?jobId=refresh-1`);
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0);
    assert.equal(f.timers.size, 0);
  });
}

test('a status read failure keeps the last active job and retries GET without submitting another collection', async t => {
  const f = fixture(t, async (_path, _options, count) => {
    if (count === 2) throw new Error('temporary network failure');
    return { job: job(count < 3 ? 'running' : 'completed') };
  });
  await f.controller.request(); const original = f.controller.getState().job;
  await f.tick();
  assert.equal(f.controller.getState().job, original);
  assert.match(f.controller.getState().error, /temporary network failure/);
  assert.equal(f.completed.length, 0);
  await f.tick();
  assert.equal(f.controller.getState().error, '');
  assert.equal(f.completed.length, 1);
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
});

for (const invalid of [null, job('completed', 'different-job'), job('invented')]) {
  test(`an invalid exact-job read ${JSON.stringify(invalid)} cannot erase or complete the active job`, async t => {
    const f = fixture(t, async (_path, _options, count) => ({ job: count === 2 ? invalid : job('running') }));
    await f.controller.request(); const original = f.controller.getState().job;
    await f.tick();
    assert.equal(f.controller.getState().job, original);
    assert.ok(f.controller.getState().error);
    assert.equal(f.completed.length, 0);
    assert.equal(f.timers.size, 1);
    await f.tick();
    assert.equal(f.controller.getState().error, '');
    assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
  });
}

test('an unconfirmed POST never retries automatically; an explicit retry may reuse the server job', async t => {
  const f = fixture(t, async (_path, _options, count) => {
    if (count === 1) throw new Error('response lost');
    return { job: job('running'), reused: true };
  });
  await f.controller.request(); await settle();
  assert.equal(f.controller.getState().submitting, false);
  assert.match(f.controller.getState().error, /response lost/);
  assert.equal(f.controller.getState().job, null);
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.length, 1);
  await f.controller.request();
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.options.method === 'POST'));
  assert.equal(f.controller.getState().error, '');
  assert.equal(f.controller.getState().job.status, 'running');
});

test('a POST without a valid task receipt remains unconfirmed and does not start polling or completion', async t => {
  const f = fixture(t, async () => ({ job: null }));
  await f.controller.request();
  assert.ok(f.controller.getState().error);
  assert.equal(f.controller.getState().submitting, false);
  assert.equal(f.controller.getState().job, null);
  assert.equal(f.timers.size, 0);
  assert.equal(f.completed.length, 0);
});

test('a terminal job returned by POST completes once even while completion work is asynchronous', async t => {
  const done = deferred();
  const f = fixture(t, async () => ({ job: job('completed') }), () => done.promise);
  const first = f.controller.request(); await settle();
  assert.equal(f.completed.length, 1);
  assert.equal(f.controller.request(), first);
  const restored = f.controller.restore();
  assert.equal(f.completed.length, 1);
  done.resolve(); await first; await restored;
  await f.controller.restore();
  assert.equal(f.completed.length, 1);
  assert.equal(f.timers.size, 0);
});

test('dispose cancels scheduled polling and future requests and restore calls remain inert', async t => {
  const f = fixture(t, async () => ({ job: job('running') }));
  await f.controller.request();
  assert.equal(f.timers.size, 1);
  const changeCount = f.changes.length;
  f.controller.dispose();
  assert.equal(f.timers.size, 0);
  await f.controller.request(); await f.controller.restore(); await settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.changes.length, changeCount);
  assert.equal(f.completed.length, 0);
});

for (const operation of ['request', 'restore']) {
  test(`dispose suppresses all callbacks from a late ${operation} response`, async t => {
    const gate = deferred();
    const f = fixture(t, () => gate.promise);
    const pending = f.controller[operation]();
    f.controller.dispose(); const changeCount = f.changes.length;
    gate.resolve({ job: job('completed') }); await pending;
    assert.equal(f.changes.length, changeCount);
    assert.equal(f.completed.length, 0);
    assert.equal(f.timers.size, 0);
  });
}

test('restoring while POST is pending joins it instead of replacing the newly accepted job with history', async t => {
  const submitted = deferred(), restored = deferred();
  const f = fixture(t, (_path, options) => options.method === 'POST' ? submitted.promise : restored.promise);
  const request = f.controller.request(), restore = f.controller.restore();
  assert.equal(request, restore);
  assert.equal(f.calls.length, 1);
  submitted.resolve({ job: job('running', 'new-task') }); await request;
  restored.resolve({ job: job('completed', 'historical-task') }); await restore;
  assert.equal(f.controller.getState().job.id, 'new-task');
  assert.equal(f.controller.getState().job.status, 'running');
  assert.equal(f.completed.length, 0);
  assert.equal(f.timers.size, 1);
});
