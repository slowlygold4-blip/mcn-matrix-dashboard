import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorDatabase } from '../lib/database.mjs';
import { MonitorScheduler } from '../lib/scheduler.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { RefreshCollection } from '../lib/refresh-collection.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'refresh-collection-'));
  const database = new MonitorDatabase(join(directory, 'fixture.sqlite'));
  const scheduler = new MonitorScheduler(database, { scheduleIntervalHours: 8, worksOnlyEnabled: true,
    providerOptions: { cooldownMs: 0, topicResolverMode: 'public', execFileImpl() { throw new Error('NO_EXTERNAL_COLLECTION'); } } });
  t.after(async () => { await scheduler.stop(); database.close(); rmSync(directory, { recursive: true, force: true }); });
  const create = (label, options = {}) => database.createTarget({ type: 'account', provider: 'public-web',
    label, locator: `MS4wLjABrefresh${label}`, ...options });
  return { database, scheduler, create };
}
function collection(target, worksCoverage = 'unavailable') {
  const topic = target.type === 'hashtag';
  return { snapshot: topic ? { hashtagParticipants: 0, hashtagViews: 0 } : { followers: 9, totalLikes: 20, totalPosts: 1 },
    posts: [], raw: { source: 'isolated-refresh-fixture', targetId: target.id },
    qualityStatus: topic ? 'validated' : 'warning', warnings: topic ? [] : ['作品稍后分批补齐'],
    accountStatus: topic ? undefined : 'available', worksCoverage: topic ? undefined : worksCoverage };
}

test('refresh collects all enabled accounts and topics, deduplicates clicks and keeps warning coverage separate', async t => {
  const f = fixture(t);
  const a = f.create('A'); const b = f.create('B', { metadata: { board: 'other' } });
  const topic = f.create('topic', { type: 'hashtag', locator: '#refresh-topic' });
  f.create('paused', { enabled: false }); f.create('import-only', { provider: 'manual' });
  const entered = deferred(), release = deferred(), calls = [];
  t.mock.method(PublicWebProvider.prototype, 'collect', async (target, options) => {
    calls.push({ id: target.id, options }); entered.resolve(); await release.promise; return collection(target);
  });
  const manager = new RefreshCollection(f);
  const first = manager.request();
  assert.equal(first.job.status, 'queued'); assert.equal(first.job.progress.targetCount, 4);
  assert.equal(manager.request().job.id, first.job.id);
  await entered.promise;
  assert.equal(manager.get(first.job.id).status, 'running');
  assert.equal(manager.request().reused, true);
  release.resolve(); await manager.currentPromise;
  const done = manager.get(first.job.id);
  assert.equal(done.status, 'completed'); assert.equal(done.result.status, 'success');
  assert.equal(done.result.successCount, 3); assert.equal(done.result.warningCount, 2);
  assert.equal(done.result.skippedCount, 1); assert.equal(done.result.profileUsableCount, 2);
  assert.equal(done.result.topicMetricsUsableCount, 1); assert.equal(done.result.worksCompleteCount, 0);
  assert.equal(done.result.worksUnavailableCount, 2);
  assert.deepEqual(calls.map(call => call.id).sort(), [a.id, b.id, topic.id].sort());
  assert.ok(calls.every(call => call.options.deferBrowserWorks === true), 'refresh uses existing profile-first policy');
  const second = manager.request(); await manager.currentPromise;
  assert.notEqual(second.job.id, first.job.id);
  assert.equal(manager.get(first.job.id).runId, done.runId, 'a later click cannot replace the prior exact receipt');
  assert.equal(manager.get().id, second.job.id);
});

for (const triggerType of ['scheduled', 'manual', 'works-only']) {
  test(`refresh waits for ${triggerType} then starts its own global collection`, async t => {
    const f = fixture(t); const a = f.create('A'); f.create('B');
    const release = deferred(); let calls = 0;
    t.mock.method(PublicWebProvider.prototype, 'collect', async target => { calls++; return collection(target, 'complete'); });
    // Model an already admitted collector without invoking a browser/process.
    f.scheduler.running = true;
    const oldRunId = f.database.beginRun(triggerType, a.id, 1);
    f.scheduler.currentProgress = { runId: oldRunId, triggerType, targetCount: 1 };
    f.scheduler.currentPromise = release.promise.then(() => {
      f.database.finishRun(oldRunId, { status: 'error', errorCount: 1 });
      f.scheduler.running = false; f.scheduler.currentPromise = null; f.scheduler.currentProgress = null;
    });
    const manager = new RefreshCollection(f), request = manager.request();
    await Promise.resolve(); assert.equal(calls, 0);
    assert.equal(manager.get(request.job.id).status, 'queued'); assert.equal(manager.request().reused, true);
    release.resolve(); await manager.currentPromise;
    const job = manager.get(request.job.id);
    assert.equal(job.status, 'completed'); assert.notEqual(job.runId, oldRunId);
    assert.equal(job.progress.targetCount, 2); assert.equal(calls, 2);
    assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 2);
  });
}

test('partial and failed collection preserve counters without publishing provider exception contents', async t => {
  const f = fixture(t); const a = f.create('A'); f.create('B'); let allFail = false;
  t.mock.method(PublicWebProvider.prototype, 'collect', async target => {
    if (allFail || target.id !== a.id) throw new Error('private token=DO_NOT_EXPOSE');
    return collection(target);
  });
  const manager = new RefreshCollection(f), partial = manager.request(); await manager.currentPromise;
  const first = manager.get(partial.job.id);
  assert.equal(first.status, 'completed'); assert.equal(first.result.status, 'partial');
  assert.equal(first.result.successCount, 1); assert.equal(first.result.errorCount, 1);
  assert.doesNotMatch(JSON.stringify(first), /DO_NOT_EXPOSE/);
  allFail = true; const failed = manager.request(); await manager.currentPromise;
  const second = manager.get(failed.job.id);
  assert.equal(second.status, 'failed'); assert.equal(second.result.status, 'error'); assert.equal(second.result.errorCount, 2);
  assert.doesNotMatch(JSON.stringify(second), /DO_NOT_EXPOSE/);
});

test('restart recovers completed receipts and interrupts stale queued/running jobs without replay', t => {
  const f = fixture(t); f.create('A'); const manager = new RefreshCollection(f);
  for (const [id, runStatus] of [['never-started', null], ['crashed-running', 'running'], ['committed-before-job-write', 'partial']]) {
    const afterRunId = f.database.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM runs').get().id;
    manager.save({ id, requestedAt: new Date().toISOString(), status: 'queued', afterRunId, targetCount: 1, runId: null });
    if (runStatus) {
      const run = f.database.beginRun('manual-refresh', null, 1);
      if (runStatus !== 'running') f.database.finishRun(run, { status: runStatus, successCount: 1, errorCount: 1 });
    }
    const recovered = new RefreshCollection(f).get(id);
    assert.equal(recovered.status, runStatus === 'partial' ? 'completed' : 'interrupted');
    if (runStatus === 'partial') assert.equal(recovered.result.status, 'partial');
    assert.equal(f.scheduler.running, false); assert.equal(f.scheduler.currentPromise, null);
  }
});

test('shutdown cancels a queued refresh without starting an additional collection', async t => {
  const f = fixture(t); f.create('A'); const release = deferred();
  f.scheduler.running = true;
  f.scheduler.currentPromise = release.promise.then(() => { f.scheduler.running = false; f.scheduler.currentPromise = null; });
  const manager = new RefreshCollection(f), request = manager.request();
  await Promise.resolve(); manager.stop();
  assert.equal(manager.get(request.job.id).status, 'interrupted');
  release.resolve(); await manager.currentPromise;
  assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 0);
  assert.throws(() => manager.request(), error => error.code === 'SCHEDULER_STOPPED');
});

test('an interrupted running refresh persists its own incomplete receipt before shutdown', async t => {
  const f = fixture(t); f.create('A'); const controller = new AbortController(), entered = deferred();
  f.scheduler.providerOptions.signal = controller.signal;
  t.mock.method(PublicWebProvider.prototype, 'collect', () => new Promise((resolve, reject) => {
    entered.resolve(); controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  }));
  const manager = new RefreshCollection(f), request = manager.request(); await entered.promise;
  manager.stop(); controller.abort(new Error('isolated shutdown'));
  await manager.currentPromise;
  const job = manager.get(request.job.id);
  assert.equal(job.status, 'interrupted'); assert.equal(job.result.status, 'interrupted');
  assert.equal(job.result.processedCount, 0); assert.equal(job.result.errorCount, 0);
  assert.equal(new RefreshCollection(f).get(request.job.id).status, 'interrupted');
});

test('remote request ids replay the same receipt even after a reused local job finishes',async t=>{
 const f=fixture(t);f.create('Remote');const entered=deferred(),release=deferred();
 t.mock.method(PublicWebProvider.prototype,'collect',async target=>{entered.resolve();await release.promise;return collection(target);});
 const manager=new RefreshCollection(f),first=manager.request();await entered.promise;
 const requestId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';const reused=manager.request({requestId});assert.equal(reused.job.id,first.job.id);
 release.resolve();await manager.currentPromise;assert.equal(manager.request({requestId}).job.id,first.job.id);assert.equal(manager.currentPromise,null);
 assert.throws(()=>manager.request({requestId:'bad'}),/无效请求/);
});
