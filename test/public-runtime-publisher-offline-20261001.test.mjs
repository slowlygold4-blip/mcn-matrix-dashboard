import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquirePublisherLock, completedSourceMarker, validatedReceipt } from '../scripts/public-replica-publisher.mjs';

// All lock writes and process lifetimes are confined to a fresh OS temporary
// directory. Importing the publisher does not execute its production entrypoint.
const runChild = promisify(execFile);
const publisher = new URL('../scripts/public-replica-publisher.mjs', import.meta.url).href;
const holderCode = `
  const { acquirePublisherLock } = await import(process.argv[1]);
  try {
    const owner = await acquirePublisherLock(process.argv[2]);
    process.send({ ready: true, pid: owner.pid });
    process.on('message', () => process.exit(0));
  } catch (error) {
    process.send({ ready: false, code: error.code });
    process.exit(1);
  }
`;
const contenderCode = `
  const { acquirePublisherLock } = await import(process.argv[1]);
  try { await acquirePublisherLock(process.argv[2]); console.log('acquired'); }
  catch (error) { console.log(error.code || 'denied'); }
`;

async function holder(path) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', holderCode, publisher, path],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const [ready] = await once(child, 'message');
  assert.equal(ready.ready, true);
  return child;
}
async function stop(child) {
  const exited = once(child, 'exit');
  child.send('finish');
  await exited;
}

test('one real child process keeps six independent publisher contenders out', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcn-runtime-lock-'));
  let owner;
  try {
    const path = join(directory, 'lock.json');
    owner = await holder(path);
    const before = await readFile(path, 'utf8');
    const attempts = await Promise.all(Array.from({ length: 6 }, () =>
      runChild(process.execPath, ['--input-type=module', '-e', contenderCode, publisher, path])));
    assert.ok(attempts.every(({ stdout }) => stdout.trim() === 'publisher-already-running'));
    assert.equal(await readFile(path, 'utf8'), before);
    assert.equal(JSON.parse(before).pid, owner.pid);
  } finally {
    if (owner) await stop(owner);
    await rm(directory, { recursive: true, force: true });
  }
});

test('only a proven exited process permits takeover of the same temporary lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcn-runtime-stale-'));
  try {
    const path = join(directory, 'lock.json');
    const former = await holder(path);
    const previous = JSON.parse(await readFile(path, 'utf8'));
    await stop(former);
    const next = await acquirePublisherLock(path);
    assert.equal(next.pid, process.pid);
    assert.notEqual(next.instance, previous.instance);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), next);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an orphan recovery guard denies takeover rather than admitting two writers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcn-runtime-recovery-'));
  try {
    const path = join(directory, 'lock.json');
    const former = await holder(path);
    await stop(former);
    await mkdir(path + '.recovery', { mode: 0o700 });
    await assert.rejects(acquirePublisherLock(path), { code: 'EEXIST' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('publisher only accepts finished exact receipts and completed source clocks', () => {
  const now = Date.parse('2026-10-01T03:00:00.000Z');
  const run = { id: 2155, trigger_type: 'scheduled', started_at: '2026-10-01T02:00:16.775Z',
    finished_at: '2026-10-01T02:43:00.000Z', status: 'success' };
  const receipt = { version: 1, runId: 2155, eventId: 'collection-run-2155', triggerType: 'scheduled',
    startedAt: run.started_at, finishedAt: run.finished_at, runStatus: 'success',
    reviewedAt: '2026-10-01T02:43:00.001Z' };
  assert.equal(validatedReceipt(run, receipt, now), true);
  assert.equal(validatedReceipt({ ...run, status: 'running', finished_at: null }, receipt, now), false);
  assert.equal(validatedReceipt(run, { ...receipt, reviewedAt: '2026-10-01T02:42:59.999Z' }, now), false);
  const source = { lastFinishedAt: '2026-09-30T17:10:04.623Z',
    lastPendingCheckedAt: '2026-09-30T17:15:11.440Z', sources: { a: { lastStatus: 'unchanged' } } };
  const marker = completedSourceMarker(source, now);
  assert.match(marker, /^[a-f0-9]{64}$/);
  assert.equal(completedSourceMarker({ ...source, sources: { a: { lastStatus: 'running' } } }, now), null);
  assert.equal(completedSourceMarker({ ...source, lastPendingCheckedAt: '2026-10-01T03:01:00.000Z' }, now), null);
  assert.equal(completedSourceMarker({ ...source, lastPendingCheckedAt: '2026-10-01T02:59:00.000Z' }, now) === marker, false);
});
