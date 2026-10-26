import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createPublicReplicaSync, preparePublicReplicaPublication, PUBLIC_REPLICA_ORIGIN } from '../lib/public-replica-sync.mjs';
import { withPublisherRecoveryLock } from '../scripts/public-replica-publisher.mjs';

// Independent protocol tests: all requests are in-memory doubles. The empty
// valid publication keeps failure-state tests independent of account fixtures,
// production files, credentials, collector processes and cloud mutations.
const AS_OF = '2026-09-28T02:00:00.000Z';
const hash = text => createHash('sha256').update(text).digest('hex');
const PRIVATE_SENTINEL = 'NOT_A_REAL_SECRET_PRIVATE_RESPONSE';
const common = { version: 1, asOf: AS_OF, timeZone: 'Asia/Shanghai' };
const runChild = promisify(execFile);
const publisherModule = new URL('../scripts/public-replica-publisher.mjs', import.meta.url).href;

function childMessage(child, timeoutMs = 5000) {
  return new Promise((ok, no) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      child.off('message', message); child.off('exit', exited); child.off('error', failed);
      error ? no(error) : ok(value);
    };
    const message = value => finish(null, value);
    const exited = () => finish(Error('peer-owned-child-exited-before-message'));
    const failed = () => finish(Error('peer-owned-child-failed-before-message'));
    const timer = setTimeout(() => finish(Error('peer-owned-child-message-timeout')), timeoutMs);
    child.once('message', message); child.once('exit', exited); child.once('error', failed);
  });
}

function source() {
  const parts = [
    ['catalog.json', 'catalog', { accounts: [], boards: [], classificationRuleVersion: 'peer-test' }],
    ['topics.json', 'topics', { topics: [], items: [] }],
  ];
  const files = parts.map(([path, kind, value]) => {
    const content = JSON.stringify({ ...common, ...value }) + '\n';
    return { path, kind, count: 0, bytes: Buffer.byteLength(content), sha256: hash(content), content };
  });
  return { manifest: { ...common,
    policy: { readOnly: true, platformComplete: false, independentlyVerified: false,
      missingDatesFilled: false, accountDailyEvidence: 'peer-test', worksMetricEvidence: 'peer-test',
      topicEvidence: 'peer-test', estimate: 'likes delta × 100, not actual views',
      note: 'protocol fixture', textRendering: 'textContent' },
    counts: { accounts: 0, enabledAccounts: 0, boards: 0, daily: 0, works: 0,
      workMetrics: 0, topics: 0, topicDaily: 0, excludedAccountSnapshots: 0 },
    files: files.map(({ content: _, ...meta }) => meta) }, files };
}

function manifestReply(publication, overrides = {}) {
  return Response.json({ manifest: publication.manifest, publishedAt: AS_OF,
    readOnly: true, collectionRequiresLocalComputer: true, ...overrides });
}

test('peer: anonymous generation 403 cannot become success or cause credential access or POST', async () => {
  let credentialReads = 0, saves = 0;
  const calls = [];
  const sync = createPublicReplicaSync({ getCredential: async () => { credentialReads++; return 'f'.repeat(64); },
    saveCheckpoint: async () => { saves++; },
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method || 'GET', auth: init.headers?.Authorization });
      return new Response(`<html>${PRIVATE_SENTINEL}</html>`, { status: 403 });
    } });
  const result = await sync.sync(source());
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'readback-rejected');
  assert.equal(result.activationState, 'not-attempted');
  assert.equal(result.activated, false);
  assert.equal(credentialReads, 0); assert.equal(saves, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].auth, undefined);
  assert.equal(new URL(calls[0].url).origin, PUBLIC_REPLICA_ORIGIN);
  assert.equal(JSON.stringify(result).includes(PRIVATE_SENTINEL), false);
});

test('peer: already-published manifest needs fresh body hashes; local success checkpoint is not trusted', async () => {
  const publication = await preparePublicReplicaPublication(source());
  let credentialReads = 0, posts = 0, saves = 0;
  const requests = [];
  let checkpoint = { stale: 'not-resumable', status: 'success' };
  const sync = createPublicReplicaSync({ getCredential: async () => { credentialReads++; return 'f'.repeat(64); },
    loadCheckpoint: async () => checkpoint,
    saveCheckpoint: async value => { saves++; checkpoint = structuredClone(value); },
    fetchImpl: async (url, init) => {
      requests.push(url);
      if (init.method === 'POST') posts++;
      assert.equal(init.headers?.Authorization, undefined);
      const path = new URL(url).searchParams.get('part');
      if (!path) return manifestReply(publication);
      const file = publication.files.find(value => value.path === path);
      return new Response(file.content + (path === 'summary.json' ? ' ' : ''));
    } });
  const result = await sync.sync(source());
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'readback-hash-mismatch');
  assert.equal(result.activationState, 'confirmed');
  assert.equal(result.activated, true);
  assert.equal(credentialReads, 0); assert.equal(posts, 0);
  assert.ok(requests.some(url => new URL(url).searchParams.get('part') === 'summary.json'));
  // Failure must not bless or replace the pre-existing, invalid checkpoint.
  // Its stale text remains on disk; only the returned/current state is trusted.
  assert.equal(saves, 0);
  assert.deepEqual(checkpoint, { stale: 'not-resumable', status: 'success' });
  assert.equal(sync.snapshot().status, 'failed');
});

test('peer: same-generation manifest policy mismatch fails before credential access', async () => {
  const publication = await preparePublicReplicaPublication(source());
  let credentialReads = 0;
  const sync = createPublicReplicaSync({ getCredential: async () => { credentialReads++; return 'f'.repeat(64); },
    fetchImpl: async () => manifestReply(publication, { collectionRequiresLocalComputer: false }) });
  const result = await sync.sync(source());
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'generation-conflict');
  assert.equal(result.activationState, 'not-attempted');
  assert.equal(credentialReads, 0);
});

test('peer: lost activation reply retries by fresh anonymous confirmation, not duplicate write or fabricated success', async () => {
  const publication = await preparePublicReplicaPublication(source());
  let published = false, uploads = 0, activations = 0, credentialReads = 0;
  let checkpoint = null;
  const parts = new Map();
  const sync = createPublicReplicaSync({ getCredential: async () => { credentialReads++; return 'f'.repeat(64); },
    loadCheckpoint: async () => checkpoint,
    saveCheckpoint: async value => { checkpoint = structuredClone(value); },
    fetchImpl: async (url, init) => {
      assert.equal(init.redirect, 'error');
      if (init.method === 'POST') {
        assert.equal(init.headers.Authorization, `Bearer ${'f'.repeat(64)}`);
        const body = JSON.parse(init.body);
        if (body.action === 'upload') {
          uploads++;
          for (const file of body.files) parts.set(file.path, file.data);
          return Response.json({ accepted: body.files.length, asOf: AS_OF });
        }
        assert.equal(body.action, 'activate'); activations++; published = true;
        throw Error(PRIVATE_SENTINEL);
      }
      assert.equal(init.headers?.Authorization, undefined);
      if (!published) return new Response('', { status: 404 });
      const path = new URL(url).searchParams.get('part');
      if (!path) return manifestReply(publication);
      return new Response(parts.get(path));
    } });
  const first = await sync.sync(source());
  assert.equal(first.status, 'failed'); assert.equal(first.code, 'network-failed');
  assert.equal(first.activationState, 'unknown'); assert.equal(first.activated, false);
  assert.equal(JSON.stringify(first).includes(PRIVATE_SENTINEL), false);
  const second = await sync.sync(source());
  assert.equal(second.status, 'success'); assert.equal(second.phase, 'complete');
  assert.equal(second.alreadyPublished, true);
  assert.equal(uploads, 1); assert.equal(activations, 1); assert.equal(credentialReads, 1);
  assert.equal(checkpoint.activated, true);
  assert.deepEqual(checkpoint.readbackFiles, ['catalog.json', 'topics.json', 'summary.json']);
  assert.equal(checkpoint.manifestSha256, hash(JSON.stringify(publication.manifest)));
});

test('peer: real OS recovery mutex survives helper exit until its Node owner releases the inherited descriptor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcn-publisher-peer-mutex-'));
  const path = join(directory, 'lock.json');
  const code = `
    import { execFile } from 'node:child_process';
    import { promisify } from 'node:util';
    const { withPublisherRecoveryLock } = await import(process.argv[1]);
    await withPublisherRecoveryLock(process.argv[2], async () => {
      process.send({ready:true});
      await new Promise((ok,no) => process.on('message', async message => {
        if (message === 'release') return ok();
        if (message !== 'stop-helper') return;
        try {
          const {stdout} = await promisify(execFile)('/usr/bin/pgrep',['-P',String(process.pid)]);
          const children=stdout.trim().split(/\\s+/).map(Number);
          if (children.length !== 1 || !Number.isSafeInteger(children[0]) || children[0] <= 0) throw Error('unexpected-owned-child-count');
          process.kill(children[0],'SIGKILL');
          setTimeout(()=>process.send({helperStopped:true}),100);
        } catch(error) {no(error);}
      }));
    });
    process.exit(0);
  `;
  const contender = `
    const {withPublisherRecoveryLock}=await import(process.argv[1]);
    try {await withPublisherRecoveryLock(process.argv[2],async()=>{});console.log('acquired');}
    catch(error){console.log(error.code||'unavailable');}
  `;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', code, publisherModule, path],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    const ready = await childMessage(owner); assert.equal(ready.ready, true);
    const before = await lstat(path + '.recovery-lock');
    const first = await runChild(process.execPath, ['--input-type=module', '-e', contender, publisherModule, path]);
    assert.equal(first.stdout.trim(), 'publisher-recovery-busy');
    const stopped = childMessage(owner); owner.send('stop-helper');
    assert.equal((await stopped).helperStopped, true);
    const second = await runChild(process.execPath, ['--input-type=module', '-e', contender, publisherModule, path]);
    assert.equal(second.stdout.trim(), 'publisher-recovery-busy');
    const exited = once(owner, 'exit'); owner.send('release'); await exited;
    await withPublisherRecoveryLock(path, async () => {});
    const after = await lstat(path + '.recovery-lock');
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, 0); assert.equal(after.mode & 0o777, 0o600);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('peer: a callback failure leaves a reusable recovery inode rather than an orphan guard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcn-publisher-peer-release-'));
  try {
    const path = join(directory, 'lock.json');
    await assert.rejects(withPublisherRecoveryLock(path, async () => { throw Error('peer-callback-failed'); }), /peer-callback-failed/);
    const before = await lstat(path + '.recovery-lock');
    let acquired = false;
    await withPublisherRecoveryLock(path, async () => { acquired = true; });
    assert.equal(acquired, true);
    assert.equal((await lstat(path + '.recovery-lock')).ino, before.ino);
    await assert.rejects(lstat(path + '.recovery'), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
