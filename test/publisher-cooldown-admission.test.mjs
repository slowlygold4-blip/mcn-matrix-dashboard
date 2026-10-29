import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PUBLIC_REPLICA_EXPORT_REVISION } from '../lib/public-replica-export.mjs';
import { canPreparePublicReplica } from '../scripts/public-replica-publisher.mjs';

test('cheap admission preserves first publication, schema upgrades, old-generation catch-up and clock guards', () => {
  const now = Date.parse('2026-10-30T00:00:00.000Z');
  const state = { active: null, lastConfirmedPublishedAt: new Date(now).toISOString(),
    publishedAsOf: new Date(now - 60_000).toISOString(), exportRevision: PUBLIC_REPLICA_EXPORT_REVISION };
  assert.equal(canPreparePublicReplica({}, now), true);
  assert.equal(canPreparePublicReplica(state, now), false);
  assert.equal(canPreparePublicReplica(state, now + 1_740_000), true);
  assert.equal(canPreparePublicReplica({ ...state, exportRevision: 'catalog-date-range-v8-live-table-foundation' }, now), true);
  assert.equal(canPreparePublicReplica({ ...state, active: { asOf: state.publishedAsOf } }, now + 3_600_000), false);
  assert.equal(canPreparePublicReplica({ ...state, lastConfirmedPublishedAt: 'invalid' }, now), false);
  assert.equal(canPreparePublicReplica(state, now - 1), false);
  assert.equal(canPreparePublicReplica(state, NaN), false);
});

test('a fresh published generation does not open a database or require credentials during cooldown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcn-publisher-cooldown-'));
  let child;
  try {
    const home = join(dir, 'public-replica-publisher');
    await mkdir(home, { mode: 0o700 });
    const now = new Date().toISOString();
    const state = { version: 1, active: null, status: 'success', publishedAsOf: now,
      lastConfirmedPublishedAt: now, exportRevision: PUBLIC_REPLICA_EXPORT_REVISION };
    await writeFile(join(home, 'state.json'), JSON.stringify(state), { mode: 0o600 });
    child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/public-replica-publisher.mjs', import.meta.url))], {
      env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { await access(join(home, 'lock.json')); ready = true; break; } catch {}
      if (child.exitCode != null) break;
      await delay(10);
    }
    assert.equal(ready, true, 'the owned test daemon acquired its lock');
    await delay(500);
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    const [code, signal] = await closed;
    clearTimeout(timer);
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.deepEqual(JSON.parse(await readFile(join(home, 'state.json'), 'utf8')), state);
    await assert.rejects(access(join(dir, 'douyin-monitor.sqlite')));
    await assert.rejects(access(join(home, 'credential')));
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});
