import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createPublicReplicaSync, PUBLIC_REPLICA_ORIGIN } from '../lib/public-replica-sync.mjs';

// All fixtures, credentials, transport and checkpoints are synthetic/in memory.
// The production module is imported directly, with no source rewriting and no
// network or production filesystem operation anywhere in this test.
const AS_OF = '2026-10-01T20:00:00.000Z';
const fakeCredential = 'b'.repeat(64);
const privateSentinel = 'phase86-synthetic-private-response';
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);

function fixture(accounts = 760) {
  const common = { version: 1, asOf: AS_OF, timeZone: 'Asia/Shanghai' };
  const files = [];
  const add = (path, kind, count, payload, targetId) => {
    const content = JSON.stringify({ ...common, ...payload }) + '\n';
    files.push({ path, kind, ...(targetId ? { targetId } : {}), count,
      bytes: Buffer.byteLength(content), sha256: hash(content), content });
  };
  const latest = { value: null, observedAt: null, sourceChecksum: null, date: null };
  add('catalog.json', 'catalog', accounts, { classificationRuleVersion: 'phase86-synthetic', boards: [],
    accounts: Array.from({ length: accounts }, (_, index) => ({
      id: index + 1, label: `Synthetic account ${index + 1}`, platform: 'douyin', enabled: true,
      boardKeys: [], historyRevision: { snapshotMaxId: 0, postMaxId: 0, postMetricMaxId: 0 },
      latest: { followers: latest, likes: latest, posts: latest },
      classification: { theme: { key: 'unknown', label: 'Unknown', confirmed: false, mode: 'synthetic' },
        primaryKey: 'unclassified', primaryLabel: 'Unclassified', labels: [], needsReview: true, mode: 'unclassified' },
    })) });
  add('topics.json', 'topics', 0, { topics: [], items: [] });
  for (let id = 1; id <= accounts; id++) {
    add(`daily/${id}.json`, 'daily', 0, { items: [] }, id);
    add(`works/${id}.json`, 'works', 0, { items: [] }, id);
    add(`work-metrics/${id}.json`, 'workMetrics', 0, { items: [] }, id);
  }
  return { manifest: { ...common,
    counts: { accounts, enabledAccounts: accounts, boards: 0, daily: 0, works: 0,
      workMetrics: 0, topics: 0, topicDaily: 0, excludedAccountSnapshots: 0 },
    policy: { readOnly: true, platformComplete: false, independentlyVerified: false,
      missingDatesFilled: false, accountDailyEvidence: 'synthetic-no-observations',
      worksMetricEvidence: 'synthetic-no-observations', topicEvidence: 'synthetic-no-observations',
      estimate: 'none', note: 'Synthetic transport test only', textRendering: 'textContent' },
    files: files.map(({ content, ...metadata }) => metadata) }, files };
}

function controlledCloud() {
  const staged = new Map(), attempts = [], acknowledgedFirstPaths = new Set();
  let published = null, activeRequests = 0, maxRequests = 0;
  let totalUploadCalls = 0, activationCalls = 0, abortedUploads = 0;
  const cloud = { rejectAfterEight: false, ambiguousActivation503: false,
    stats: () => ({ activeRequests, maxRequests, totalUploadCalls, activationCalls, abortedUploads,
      acknowledgedBatches: acknowledgedFirstPaths.size, attempts: [...attempts] }),
    fetch: async (url, init = {}) => {
      const requested = new URL(url);
      assert.equal(requested.origin, PUBLIC_REPLICA_ORIGIN);
      assert.equal(init.redirect, 'error');
      if (init.method !== 'POST') {
        assert.equal(init.headers, undefined);
        if (!published) return Response.json({ error: privateSentinel }, { status: 404 });
        const path = requested.searchParams.get('part');
        return path ? new Response(staged.get(path)?.data) : Response.json({ manifest: published,
          publishedAt: AS_OF, readOnly: true, collectionRequiresLocalComputer: true });
      }
      assert.equal(init.headers?.Authorization === `Bearer ${fakeCredential}`, true);
      const body = JSON.parse(init.body);
      if (body.action === 'activate') {
        activationCalls++;
        assert.equal(staged.size, body.manifest.files.length);
        assert.ok(body.manifest.files.every(meta => staged.get(meta.path)?.sha256 === meta.sha256));
        published = clone(body.manifest);
        if (cloud.ambiguousActivation503) {
          cloud.ambiguousActivation503 = false;
          return Response.json({ error: privateSentinel }, { status: 503 });
        }
        return Response.json({ published: true, asOf: AS_OF, parts: staged.size });
      }
      assert.equal(body.action, 'upload');
      const call = totalUploadCalls++;
      attempts.push(body.files[0].path);
      activeRequests++;
      maxRequests = Math.max(maxRequests, activeRequests);
      try {
        if (cloud.rejectAfterEight && call >= 8) {
          // Refuse both the original upload and its bounded smaller fallback.
          // Sibling requests remain slow enough to exercise abort-and-drain.
          if (call === 8) {
            await delay(20, undefined, { signal: init.signal });
            return Response.json({ error: privateSentinel }, { status: 503 });
          }
          if (body.files.length <= 8) return Response.json({ error: privateSentinel }, { status: 503 });
          await delay(100, undefined, { signal: init.signal });
          return Response.json({ error: privateSentinel }, { status: 503 });
        } else {
          await delay(1, undefined, { signal: init.signal });
        }
        for (const part of body.files) {
          assert.equal(hash(part.data), part.sha256);
          const previous = staged.get(part.path);
          if (previous) assert.equal(previous.data, part.data);
          staged.set(part.path, part);
        }
        acknowledgedFirstPaths.add(body.files[0].path);
        return Response.json({ accepted: body.files.length, asOf: AS_OF });
      } catch (error) {
        if (init.signal.aborted) abortedUploads++;
        throw error;
      } finally {
        activeRequests--;
      }
    },
  };
  return cloud;
}

function producer(cloud, { afterSave, requestTimeoutMs = 1000, operationTimeoutMs = 10000 } = {}) {
  let saved = null, pendingSaves = 0, maxPendingSaves = 0;
  const options = {
    fetchImpl: cloud.fetch, getCredential: async () => fakeCredential,
    requestTimeoutMs, operationTimeoutMs,
    loadCheckpoint: async () => clone(saved),
    saveCheckpoint: async checkpoint => {
      pendingSaves++;
      maxPendingSaves = Math.max(maxPendingSaves, pendingSaves);
      try { await delay(1); saved = clone(checkpoint); await afterSave?.(checkpoint); }
      finally { pendingSaves--; }
    },
  };
  return { sync: createPublicReplicaSync(options), restart: () => createPublicReplicaSync(options),
    checkpoint: () => clone(saved), saves: () => ({ pendingSaves, maxPendingSaves }) };
}

test('Phase86 actual sync preserves 8 of 66 batches on HTTP503 and fresh instance resumes exactly 58', async t => {
  const source = fixture(), cloud = controlledCloud(), owner = producer(cloud);
  cloud.rejectAfterEight = true;
  const before = performance.now();
  const failed = await owner.sync.sync(source, { dateIndex: true });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.code, 'sync-rejected');
  assert.deepEqual(failed.transportFailure, { kind: 'http', method: 'POST', phase: 'upload',
    httpStatus: 503, category: 'server' });
  assert.equal(failed.batchesTotal, 66);
  assert.deepEqual(owner.checkpoint().completedBatches, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(owner.checkpoint().activated, false);
  assert.equal(cloud.stats().activationCalls, 0);
  assert.equal(cloud.stats().activeRequests, 0);
  assert.equal(cloud.stats().maxRequests, 4);
  assert.equal(cloud.stats().abortedUploads, 3);
  const acknowledgedPaths = cloud.stats().attempts.slice(0, 8);
  const attemptedAtFailure = cloud.stats().totalUploadCalls;
  cloud.rejectAfterEight = false;
  const resumed = await owner.restart().sync(source, { dateIndex: true });
  assert.equal(resumed.status, 'success');
  assert.equal(resumed.batchesCompleted, 66);
  assert.equal(owner.checkpoint().activated, true);
  assert.equal(cloud.stats().totalUploadCalls - attemptedAtFailure, 58);
  assert.equal(cloud.stats().attempts.slice(attemptedAtFailure).some(path => acknowledgedPaths.includes(path)), false);
  assert.equal(cloud.stats().activationCalls, 1);
  assert.equal(cloud.stats().activeRequests, 0);
  assert.deepEqual(owner.saves(), { pendingSaves: 0, maxPendingSaves: 1 });
  assert.equal(JSON.stringify(failed).includes(privateSentinel), false);
  assert.equal(JSON.stringify(failed).includes(fakeCredential), false);
  t.diagnostic(JSON.stringify({ scenario: '503-at-8-of-66', recoveredBatches: 66, resumedUploads: 58,
    abortedSiblings: 3, wallMs: Math.round(performance.now() - before) }));
});

test('Phase86 parent cancellation at saved batch 8 drains uploads and restart retains accepted progress', async () => {
  const cloud = controlledCloud(), controller = new AbortController();
  const owner = producer(cloud, { afterSave: checkpoint => {
    if (checkpoint.completedBatches.length === 8) controller.abort();
  } });
  const source = fixture(), failed = await owner.sync.sync(source, { signal: controller.signal, dateIndex: true });
  assert.equal(failed.code, 'aborted');
  assert.equal(cloud.stats().activationCalls, 0);
  assert.equal(cloud.stats().activeRequests, 0);
  const accepted = owner.checkpoint().completedBatches.length;
  assert.ok(accepted >= 8 && accepted <= 11);
  assert.equal(owner.saves().pendingSaves, 0);
  assert.equal((await owner.restart().sync(source, { dateIndex: true })).status, 'success');
  assert.equal(cloud.stats().activationCalls, 1);
  assert.equal(cloud.stats().activeRequests, 0);
});

test('Phase86 activation HTTP503 after remote commit is reconciled anonymously without duplicate POST', async () => {
  const source = fixture(12), cloud = controlledCloud(), owner = producer(cloud);
  cloud.ambiguousActivation503 = true;
  const failed = await owner.sync.sync(source, { dateIndex: true });
  assert.equal(failed.code, 'sync-rejected');
  assert.equal(failed.activationState, 'unknown');
  assert.equal(failed.transportFailure.httpStatus, 503);
  assert.equal(failed.transportFailure.phase, 'activate');
  const previousUploads = cloud.stats().totalUploadCalls;
  const recovered = await owner.restart().sync(source, { dateIndex: true });
  assert.equal(recovered.status, 'success');
  assert.equal(recovered.alreadyPublished, true);
  assert.equal(cloud.stats().totalUploadCalls, previousUploads);
  assert.equal(cloud.stats().activationCalls, 1);
});

test('Phase86 pre-aborted operation performs zero transport and zero checkpoint mutation', async () => {
  const cloud = controlledCloud(), owner = producer(cloud), controller = new AbortController();
  controller.abort();
  const failed = await owner.sync.sync(fixture(1), { signal: controller.signal });
  assert.equal(failed.code, 'aborted');
  assert.equal(cloud.stats().totalUploadCalls, 0);
  assert.equal(cloud.stats().activationCalls, 0);
  assert.equal(owner.checkpoint(), null);
});

// Red regression executes the actual publisher entry point with an
// isolated synthetic DATA_DIR and replaced fetch. It never touches the live
// publisher or network. The same assertion is red before, green after the fix.
test('Phase86 failed upload log identifies active generation rather than prior published generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phase86-publisher-log-'));
  let child;
  try {
    const home = join(directory, 'public-replica-publisher');
    const staging = join(directory, 'public-replica-staging', 'phase86-synthetic');
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const source = fixture(1);
    for (const file of source.files) {
      const path = join(staging, file.path);
      await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
      await writeFile(path, file.content, { mode: 0o600 });
    }
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(source.manifest), { mode: 0o600 });
    await writeFile(join(home, 'credential'), fakeCredential, { mode: 0o600 });
    const priorPublished = '2026-10-01T19:00:00.000Z';
    await writeFile(join(home, 'state.json'), JSON.stringify({ version: 1,
      active: { directory: staging, asOf: AS_OF, manifestHash: hash(JSON.stringify(source.manifest)),
        marker: null, source: null }, publishedAsOf: priorPublished,
      coveredMarker: null, coveredSource: null, status: 'staged' }), { mode: 0o600 });
    const db = new DatabaseSync(join(directory, 'douyin-monitor.sqlite'));
    db.exec('CREATE TABLE runs(id INTEGER PRIMARY KEY, trigger_type TEXT, started_at TEXT, finished_at TEXT, status TEXT)');
    db.close();
    const stub = 'globalThis.fetch = async (_url, init = {}) => Response.json({}, {status: init.method === "POST" ? 503 : 404});';
    const script = fileURLToPath(new URL('../scripts/public-replica-publisher.mjs', import.meta.url));
    child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(stub), script], {
      env: { ...process.env, DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const completion = new Promise(resolve => child.once('exit', resolve));
    const diagnostic = await new Promise((resolve, reject) => {
      let buffer = '';
      const deadline = setTimeout(() => { child.kill('SIGTERM'); reject(Error('synthetic-publisher-timeout')); }, 5000);
      child.on('error', () => { clearTimeout(deadline); reject(Error('synthetic-publisher-start-failed')); });
      child.stdout.on('data', chunk => {
        buffer += chunk.toString();
        if (!buffer.includes('\n')) return;
        const line = buffer.slice(0, buffer.indexOf('\n'));
        try { const parsed = JSON.parse(line); clearTimeout(deadline); resolve(parsed); }
        catch { clearTimeout(deadline); reject(Error('synthetic-publisher-invalid-log')); }
      });
    });
    child.kill('SIGTERM');
    await completion;
    assert.equal(diagnostic.status, 'failed');
    assert.equal(diagnostic.code, 'sync-rejected');
    assert.equal(diagnostic.asOf, AS_OF, 'Failure must identify the immutable generation actually attempted');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve));
      child.kill('SIGKILL');
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
