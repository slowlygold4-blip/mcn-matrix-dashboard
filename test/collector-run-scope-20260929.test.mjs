import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { MonitorScheduler } from '../lib/scheduler.mjs';

const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const capture = promise => promise.then(value => ({ value }), error => ({ error }));
const payload = () => JSON.stringify({ ok: true, data: { capturedAt: new Date().toISOString(),
  profile: { user: { follower_count: 8, total_favorited: 100, aweme_count: 1 } },
  works: { aweme_list: [{ aweme_id: 'offline-scope-post', desc: 'fixture', statistics: { digg_count: 5 } }] } } });

function fixture(t, { empty = false, signal } = {}) {
  const database = new MonitorDatabase(':memory:');
  const targets = empty ? [] : ['A', 'B', 'C'].map(label => database.createTarget({
    type: 'account', provider: 'public-web', label, locator: `MS4wLjABscope${label}`,
  }));
  const calls = [], pending = [];
  let auto = false, failure = null;
  const scheduler = new MonitorScheduler(database, { scheduleIntervalHours: 8,
    providerOptions: { cooldownMs: 0, accountBrowserFallback: false, signal,
      fetchImpl: () => { throw new Error('External network forbidden in scope fixture'); },
      execFileImpl(_file, args, _options, callback) {
        calls.push({ operation: args[args.indexOf('--operation') + 1], locator: args[args.indexOf('--locator') + 1] });
        if (auto) callback(failure, failure ? '' : payload(), '');
        else pending.push(callback);
      } } });
  scheduler.prepareTopicBrowserBatch = async () => null;
  t.after(async () => { auto = true; for (const callback of pending.splice(0)) callback(new Error('fixture cleanup'), '', '');
    await scheduler.currentPromise?.catch(() => {}); scheduler.stop(); database.close(); });
  const release = (error = null) => { auto = true; failure = error;
    for (const callback of pending.splice(0)) callback(error, error ? '' : payload(), ''); };
  return { database, scheduler, targets, calls, release,
    count: table => database.db.prepare(`SELECT count(*) n FROM ${table}`).get().n };
}

test('same explicit target request joins one live collection and receives its actual receipt', async t => {
  const f = fixture(t), options = { targetId: f.targets[0].id };
  const a = f.scheduler.runAll(options); await settle();
  assert.equal(f.calls.length, 1);
  const b = f.scheduler.runAll({ ...options }); f.release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.runId, rb.runId); assert.equal(ra.status, 'success');
  assert.deepEqual(rb.details.map(x => x.targetId), [f.targets[0].id]);
  assert.equal(f.calls.length, 1); assert.equal(f.count('runs'), 1); assert.equal(f.count('snapshots'), 1);
});

const conflicts = [
  ['another target', f => ({ targetId: f.targets[0].id }), f => ({ targetId: f.targets[1].id })],
  ['topics versus account', f => ({ targetId: f.targets[0].id }), () => ({ triggerType: 'manual-topics', onlyType: 'hashtag' })],
  ['manual versus scheduled trigger', f => ({ targetId: f.targets[0].id }), f => ({ triggerType: 'scheduled', targetId: f.targets[0].id })],
  ['different type filter', () => ({ onlyType: 'account' }), () => ({ onlyType: 'hashtag' })],
  ['different excluded target set', f => ({ excludeTargetIds: [f.targets[2].id] }), f => ({ excludeTargetIds: [f.targets[1].id] })],
  ['subset versus full run', f => ({ targetId: f.targets[0].id }), () => ({})],
];
for (const [name, first, second] of conflicts) test(`different live request scope rejects ${name}, never aliases A's result`, async t => {
  const f = fixture(t);
  if (name.includes('type') || name.includes('topics')) f.database.createTarget({
    type: 'hashtag', provider: 'public-web', label: 'offline topic', locator: 'offline-topic',
  });
  const a = f.scheduler.runAll(first(f)); await settle();
  const b = capture(f.scheduler.runAll(second(f))); await settle();
  assert.equal(f.count('runs'), 1); assert.equal(f.calls.length, 1, 'no second concurrent provider');
  f.release(); await a; const rb = await b;
  assert.ok(rb.error, `different request received unrelated run ${rb.value?.runId}`);
  assert.equal(rb.error.statusCode ?? rb.error.status, 409);
  assert.equal(rb.error.code, 'COLLECTION_SCOPE_CONFLICT');
  assert.equal(f.count('runs'), 1);
});

test('equivalent exclusion sets share one run regardless of order and duplicates', async t => {
  const f = fixture(t), [a, b, c] = f.targets;
  const first = f.scheduler.runAll({ excludeTargetIds: [b.id, c.id] }); await settle();
  const second = f.scheduler.runAll({ excludeTargetIds: [c.id, b.id, b.id] }); f.release();
  const [x, y] = await Promise.all([first, second]);
  assert.equal(x.runId, y.runId); assert.deepEqual(y.details.map(d => d.targetId), [a.id]);
  assert.equal(f.calls.length, 1);
});

test('automatic tick while manual collection runs is quiet and does not join as a different request', async t => {
  const f = fixture(t), a = f.scheduler.runAll({ targetId: f.targets[0].id }); await settle();
  await f.scheduler.tick(); await f.scheduler.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.count('runs'), 1); assert.equal(f.scheduler.lastError, null);
  f.release(); await a;
});

test('nonexistent and disabled targets reject even while an unrelated target is running', async t => {
  const f = fixture(t); f.database.updateTarget(f.targets[1].id, { enabled: false });
  const a = f.scheduler.runAll({ targetId: f.targets[0].id }); await settle();
  await assert.rejects(f.scheduler.runAll({ targetId: 999999 }), /不存在/);
  await assert.rejects(f.scheduler.runAll({ targetId: f.targets[1].id }), /暂停/);
  f.release(); await a; assert.equal(f.count('runs'), 1); assert.equal(f.calls.length, 1);
});

test('no eligible targets never creates a successful collection receipt', async t => {
  const f = fixture(t, { empty: true }), result = await capture(f.scheduler.runAll());
  assert.ok(result.error || result.value?.status !== 'success', 'an empty request must not claim collection success');
  assert.equal(f.calls.length, 0); assert.equal(f.count('snapshots'), 0);
});

test('failed same-scope joins share the actual failure and the next target starts a fresh run', async t => {
  const f = fixture(t), options = { targetId: f.targets[0].id };
  const a = f.scheduler.runAll(options); await settle(); const b = f.scheduler.runAll(options);
  f.release(new Error('offline provider failure')); const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 'error'); assert.equal(rb.status, 'error'); assert.equal(ra.runId, rb.runId);
  assert.equal(f.scheduler.running, false); assert.equal(f.scheduler.currentPromise, null);
  f.release(); const next = await f.scheduler.runAll({ targetId: f.targets[1].id });
  assert.notEqual(next.runId, ra.runId); assert.equal(next.status, 'success');
  assert.deepEqual(next.details.map(x => x.targetId), [f.targets[1].id]);
});

test('shutdown cancellation gives joined callers interrupted receipts, not successful A data', async t => {
  const controller = new AbortController(), f = fixture(t, { signal: controller.signal });
  const options = { targetId: f.targets[0].id }, a = f.scheduler.runAll(options); await settle();
  const b = f.scheduler.runAll(options); f.scheduler.stop(); controller.abort();
  f.release(Object.assign(new Error('offline aborted'), { name: 'AbortError' }));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 'interrupted'); assert.equal(rb.status, 'interrupted'); assert.equal(ra.runId, rb.runId);
  assert.equal(f.count('snapshots'), 0); assert.equal(f.scheduler.currentPromise, null);
});

const invalidScopes = [
  ['zero target', () => ({ targetId: 0 })],
  ['negative target', () => ({ targetId: -1 })],
  ['fractional target', () => ({ targetId: 1.5 })],
  ['NaN target', () => ({ targetId: NaN })],
  ['unsafe target integer', () => ({ targetId: Number.MAX_SAFE_INTEGER + 1 })],
  ['empty target string', () => ({ targetId: '' })],
  ['boolean target', () => ({ targetId: true })],
  ['object target', () => ({ targetId: { valueOf: () => 1 } })],
  ['array target', () => ({ targetId: [1] })],
  ['null options', () => null],
  ['boolean options', () => false],
  ['array options', () => []],
  ['null exclusion filter', () => ({ excludeTargetIds: null })],
  ['boolean excluded id', () => ({ excludeTargetIds: [true] })],
  ['object excluded id', () => ({ excludeTargetIds: [{}] })],
  ['empty type', () => ({ onlyType: '' })],
  ['boolean type', () => ({ onlyType: true })],
  ['object type', () => ({ onlyType: {} })],
  ['empty trigger', () => ({ triggerType: '' })],
  ['boolean trigger', () => ({ triggerType: true })],
  ['unknown target type', () => ({ onlyType: 'video' })],
  ['nonarray exclusion filter', () => ({ excludeTargetIds: '1' })],
  ['invalid excluded id', () => ({ excludeTargetIds: [NaN] })],
  ['contradictory target and type', f => ({ targetId: f.targets[0].id, onlyType: 'hashtag' })],
  ['contradictory target and exclusion', f => ({ targetId: f.targets[0].id, excludeTargetIds: [f.targets[0].id] })],
  ['unsupported board filter', () => ({ board: 'tuantuan' })],
  ['unsupported theme filter', () => ({ theme: 'tuantuan' })],
  ['unsupported classification filter', () => ({ classification: 'slice' })],
];
for (const [name, options] of invalidScopes) test(`invalid scope rejects ${name} before any run or provider side effect`, async t => {
  const f = fixture(t), pending = capture(f.scheduler.runAll(options(f))); await settle(); f.release();
  const result = await pending;
  assert.ok(result.error, `${name} must never be silently broadened to a collection`);
  assert.equal(result.error.statusCode ?? result.error.status, 400);
  assert.equal(f.count('runs'), 0); assert.equal(f.calls.length, 0); assert.equal(f.count('snapshots'), 0);
});

test('identical filter with changed selected roster must not join the older narrower batch', async t => {
  const f = fixture(t), a = f.scheduler.runAll({ onlyType: 'account' }); await settle();
  f.database.createTarget({ type: 'account', provider: 'public-web', label: 'D', locator: 'MS4wLjABscopeD' });
  const b = capture(f.scheduler.runAll({ onlyType: 'account' })); await settle(); f.release();
  const ra = await a, rb = await b;
  assert.ok(rb.error, 'new roster request incorrectly received old roster success');
  assert.equal(rb.error.code, 'COLLECTION_SCOPE_CONFLICT'); assert.equal(f.count('runs'), 1);
  assert.equal(ra.targetCount, 3); assert.equal(f.calls.length, 3);
});

const assertIdle = scheduler => {
  assert.equal(scheduler.running, false);
  assert.equal(scheduler.currentPromise, null);
  assert.equal(scheduler.currentScope, null);
  assert.equal(scheduler.currentProgress, null);
};

for (const method of ['getSettings', 'updateRunProgress']) {
  test(`${method} setup failure leaves no live scope or orphan running receipt and allows the next request`, async t => {
    const f = fixture(t), original = f.database[method].bind(f.database);
    let first = true;
    f.database[method] = (...args) => {
      if (first) { first = false; throw new Error(`offline ${method} setup failure`); }
      return original(...args);
    };
    await assert.rejects(f.scheduler.runAll({ targetId: f.targets[0].id }), /setup failure/);
    assertIdle(f.scheduler);
    assert.equal(f.calls.length, 0); assert.equal(f.count('snapshots'), 0);
    assert.equal(f.database.db.prepare("SELECT count(*) n FROM runs WHERE status='running'").get().n, 0);
    f.release();
    const next = await f.scheduler.runAll({ targetId: f.targets[1].id });
    assert.equal(next.status, 'success');
    assert.deepEqual(next.details.map(x => x.targetId), [f.targets[1].id]);
    assertIdle(f.scheduler);
  });
}

test('fatal progress failure during execution clears scope, finalizes the receipt, and does not alias the next run', async t => {
  const f = fixture(t), original = f.database.updateRunProgress.bind(f.database);
  let calls = 0;
  f.database.updateRunProgress = (...args) => {
    if (++calls === 2) throw new Error('offline progress execution failure');
    return original(...args);
  };
  await assert.rejects(f.scheduler.runAll({ targetId: f.targets[0].id }), /execution failure/);
  assertIdle(f.scheduler);
  assert.equal(f.database.db.prepare("SELECT count(*) n FROM runs WHERE status='running'").get().n, 0);
  assert.equal(f.calls.length, 0);
  f.release();
  assert.equal((await f.scheduler.runAll({ targetId: f.targets[1].id })).status, 'success');
  assertIdle(f.scheduler);
});
