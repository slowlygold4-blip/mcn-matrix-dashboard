// Independent synthetic/temporary-only review. No original database, credentials,
// production service, network requests or browser interaction is used here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtemp, writeFile, readFile, mkdir, lstat, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { acquirePublisherLock, withPublisherRecoveryLock } from '../scripts/public-replica-publisher.mjs';

const publisher = new URL('../scripts/public-replica-publisher.mjs', import.meta.url).href;
const SITE = new URL('../../mcn-public-site/', import.meta.url);
const clock = '2026-09-20T12:00:00.000Z';
const hash = text => createHash('sha256').update(text).digest('hex');

async function temporary(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'mcn-offline-peer-'));
  try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function holder(path) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { acquirePublisherLock } = await import(process.argv[1]);
    const owner = await acquirePublisherLock(process.argv[2]);
    process.send(owner);
    process.on('message', () => process.exit(0));
  `, publisher, path], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const ready = once(child, 'message');
  const exited = once(child, 'exit');
  const result = await Promise.race([ready, exited.then(() => { throw Error('temporary holder exited early'); })]);
  assert.equal(result[0].pid, child.pid);
  return { child, owner: result[0], exited };
}

async function stop(h) { h.child.send('finish'); await h.exited; }

test('peer: a live real process is excluded even if a recovery directory is already present', async () => {
  await temporary(async directory => {
    const path = join(directory, 'lock.json'), h = await holder(path);
    try {
      const before = await readFile(path, 'utf8');
      await mkdir(path + '.recovery', { mode: 0o700 });
      await assert.rejects(acquirePublisherLock(path), /publisher-already-running/);
      assert.equal(await readFile(path, 'utf8'), before);
      assert.equal((await lstat(path + '.recovery')).isDirectory(), true);
    } finally { await stop(h); }
  });
});

test('peer: legacy recovery without ownership proof stays fail closed and preserves the exited lock', async () => {
  await temporary(async directory => {
    const path = join(directory, 'lock.json'), h = await holder(path);
    await stop(h);
    const before = await readFile(path, 'utf8');
    await mkdir(path + '.recovery', { mode: 0o700 });
    await assert.rejects(acquirePublisherLock(path));
    assert.equal(await readFile(path, 'utf8'), before);
    assert.equal((await lstat(path + '.recovery')).isDirectory(), true);
  });
});

test('peer: current PID lock cannot be taken over by the same process', async () => {
  await temporary(async directory => {
    const path = join(directory, 'lock.json');
    const owner = await acquirePublisherLock(path), before = await readFile(path, 'utf8');
    assert.equal(owner.pid, process.pid);
    await assert.rejects(acquirePublisherLock(path), /publisher-already-running/);
    assert.equal(await readFile(path, 'utf8'), before);
  });
});

test('peer: an exited valid publisher is recoverable without deleting its prior ownership evidence', async () => {
  await temporary(async directory => {
    const path = join(directory, 'lock.json'), h = await holder(path);
    const old = h.owner;
    await stop(h);
    const owner = await acquirePublisherLock(path);
    assert.equal(owner.pid, process.pid);
    assert.notEqual(owner.instance, old.instance);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), owner);
  });
});

test('peer: broad-readable, missing identity and symlink locks never overwrite the referenced file', async () => {
  await temporary(async directory => {
    const path = join(directory, 'lock.json');
    const body = JSON.stringify({ pid: process.pid, instance: 'peer-instance', startedAt: clock });
    await writeFile(path, body, { mode: 0o600 });
    await chmod(path, 0o644);
    await assert.rejects(acquirePublisherLock(path));
    assert.equal(await readFile(path, 'utf8'), body);
    await chmod(path, 0o600);
    const link = join(directory, 'symlink-lock.json');
    await symlink(path, link);
    await assert.rejects(acquirePublisherLock(link));
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(await readFile(path, 'utf8'), body);
    const malformed = join(directory, 'malformed-lock.json');
    await writeFile(malformed, JSON.stringify({ instance: 'no-pid' }), { mode: 0o600 });
    await assert.rejects(acquirePublisherLock(malformed));
    assert.equal(await readFile(malformed, 'utf8'), JSON.stringify({ instance: 'no-pid' }));
  });
});

test('peer: recovery symlink is not traversed or removed while taking over a proved exited PID', async () => {
  await temporary(async directory => {
    const path = join(directory, 'lock.json'), h = await holder(path);
    await stop(h);
    const before = await readFile(path, 'utf8'), outside = join(directory, 'unrelated');
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, 'keep'), 'preserved', { mode: 0o600 });
    await symlink(outside, path + '.recovery');
    await assert.rejects(acquirePublisherLock(path));
    assert.equal(await readFile(path, 'utf8'), before);
    assert.equal((await lstat(path + '.recovery')).isSymbolicLink(), true);
    assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'preserved');
  });
});

test('peer: ten real contenders take over a stale publisher exactly once', async () => {
  await temporary(async directory => {
    const path = join(directory, 'lock.json'), former = await holder(path);
    await stop(former);
    const children = Array.from({ length: 10 }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        const { acquirePublisherLock } = await import(process.argv[1]);
        try {
          const owner = await acquirePublisherLock(process.argv[2]);
          process.send({ acquired: true, owner });
          process.on('message', () => process.exit(0));
        } catch (error) {
          process.send({ acquired: false, code: error.code });
          process.exit(0);
        }
      `, publisher, path], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      return { child, ready: once(child, 'message'), exited: once(child, 'exit') };
    });
    let results;
    try {
      results = await Promise.all(children.map(c => c.ready.then(([value]) => value)));
      const winners = results.filter(result => result.acquired);
      assert.equal(winners.length, 1);
      assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, winners[0].owner.pid);
      const denied = results.filter(result => !result.acquired).map(result => result.code);
      assert.ok(denied.every(code => ['publisher-already-running', 'publisher-recovery-busy'].includes(code)),
        JSON.stringify(denied));
    } finally {
      for (let i = 0; i < children.length; i++) {
        if (results?.[i]?.acquired && children[i].child.connected) children[i].child.send('finish');
        else if (children[i].child.exitCode === null && !results) children[i].child.kill('SIGTERM');
      }
      await Promise.all(children.map(c => c.exited));
    }
  });
});

async function recoveryHolder(path) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { execFileSync } from 'node:child_process';
    const { withPublisherRecoveryLock } = await import(process.argv[1]);
    try {
      await withPublisherRecoveryLock(process.argv[2], async () => {
        const entries = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' });
        const helpers = entries.split('\\n').map(line => /^(\\s*\\d+)\\s+(\\d+)\\s+(.*)$/.exec(line))
          .filter(row => row && Number(row[2]) === process.pid && /python/i.test(row[3]));
        process.send({ ready: true, pid: process.pid, helperPid: Number(helpers[0]?.[1]) });
        await new Promise(resolve => process.once('message', resolve));
      });
      process.exit(0);
    } catch (error) { process.send({ ready: false, code: error.code }); process.exit(1); }
  `, publisher, path], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const ready = once(child, 'message'), exited = once(child, 'exit');
  const [value] = await Promise.race([ready, exited.then(() => { throw Error('temporary recovery holder exited early'); })]);
  assert.equal(value.ready, true);
  assert.equal(Number.isSafeInteger(value.helperPid) && value.helperPid > 0, true);
  return { child, exited, ...value };
}

test('peer: killing the Python helper cannot release the retained parent FD while its callback still runs', async () => {
  await temporary(async directory => {
    const path = join(directory, 'lock.json'), h = await recoveryHolder(path);
    let stopped = false;
    try {
      const before = await lstat(path + '.recovery-lock');
      process.kill(h.helperPid, 'SIGKILL');
      let entered = false;
      await assert.rejects(withPublisherRecoveryLock(path, () => { entered = true; }),
        { code: 'publisher-recovery-busy' });
      assert.equal(entered, false);
      assert.equal((await lstat(path + '.recovery-lock')).ino, before.ino);
      h.child.send('finish'); await h.exited; stopped = true;
      assert.equal(await withPublisherRecoveryLock(path, () => 'released'), 'released');
    } finally {
      if (!stopped) { h.child.kill('SIGKILL'); await h.exited; }
    }
  });
});

test('peer: a killed Node parent does not leave a permanent mutex or require deleting its inode', async () => {
  await temporary(async directory => {
    const path = join(directory, 'lock.json'), h = await recoveryHolder(path);
    const before = await lstat(path + '.recovery-lock');
    h.child.kill('SIGKILL'); await h.exited;
    let acquired = false;
    for (let attempt = 0; attempt < 20 && !acquired; attempt++) {
      try { acquired = await withPublisherRecoveryLock(path, () => true); }
      catch (error) {
        assert.equal(error.code, 'publisher-recovery-busy');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    assert.equal(acquired, true);
    const after = await lstat(path + '.recovery-lock');
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, 0);
    assert.equal(after.mode & 0o777, 0o600);
  });
});

test('peer: recovery helper cannot run or grant ownership when its executable is unavailable', async () => {
  await temporary(async directory => {
    let entered = false;
    await assert.rejects(withPublisherRecoveryLock(join(directory, 'lock.json'), () => { entered = true; },
      { pythonPath: join(directory, 'not-installed') }), { code: 'publisher-recovery-unavailable' });
    assert.equal(entered, false);
    assert.equal(await withPublisherRecoveryLock(join(directory, 'lock.json'), () => 'normal'), 'normal');
  });
});

test('peer: recovery mutex rejects a readable file, nonempty file, hardlink and symlink without callback access', async () => {
  const { link } = await import('node:fs/promises');
  await temporary(async directory => {
    const path = join(directory, 'lock.json'), file = path + '.recovery-lock';
    await writeFile(file, '', { mode: 0o600 });
    let entered = 0;
    await chmod(file, 0o644);
    await assert.rejects(withPublisherRecoveryLock(path, () => entered++), { code: 'unsafe-publisher-recovery' });
    await chmod(file, 0o600);
    await writeFile(file, 'unexpected');
    await assert.rejects(withPublisherRecoveryLock(path, () => entered++), { code: 'unsafe-publisher-recovery' });
    await writeFile(file, '');
    await link(file, join(directory, 'linked-mutex'));
    await assert.rejects(withPublisherRecoveryLock(path, () => entered++), { code: 'unsafe-publisher-recovery' });
    const target = join(directory, 'symlink.json');
    await symlink(file, target + '.recovery-lock');
    await assert.rejects(withPublisherRecoveryLock(target, () => entered++));
    assert.equal(entered, 0);
    assert.equal((await lstat(target + '.recovery-lock')).isSymbolicLink(), true);
  });
});

async function readerHarness() {
  const route = await readFile(new URL('app/api/replica/route.ts', SITE), 'utf8');
  const require = createRequire(new URL('package.json', SITE)), ts = require('typescript');
  const body = JSON.stringify({ version: 1, asOf: clock, timeZone: 'Asia/Shanghai', topics: [], items: [] });
  const checksum = hash(body), manifest = { asOf: clock, files: [{ path: 'topics.json', sha256: checksum }] };
  const published = { generation: clock, manifest: JSON.stringify(manifest), published_at: clock };
  let stored = true;
  const environment = { DB: { prepare(sql) { let values = []; return {
    bind(...args) { values = args; return this; },
    async first() {
      if (sql.includes('ORDER BY generation')) return published;
      if (sql.includes('FROM replica_generations')) return values[0] === clock ? published : null;
      if (sql.includes('FROM replica_files')) return values[0] === clock && values[1] === 'topics.json' ? { checksum } : null;
      throw Error('unexpected synthetic query');
    },
  }; } }, BUCKET: { async get(key) { return stored && key === `${clock}/${checksum}` ? { body } : null; } } };
  const code = ts.transpileModule(route.replace('import { env } from "cloudflare:workers";', 'const env = globalThis.__environment;'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { exports: {}, Request, Response, URL, TextEncoder, crypto: webcrypto,
    __environment: environment,
    fetch() { throw Error('offline reader must not fetch local or platform data'); },
    require: specifier => ['@/lib/replica-summary.mjs', '@/lib/replica-date-audit.mjs'].includes(specifier)
      ? require(new URL(specifier.slice(2), SITE).pathname) : require(specifier),
  };
  vm.runInNewContext(code, context, { filename: 'offline-peer-reader.cjs' });
  return { context, published, body, checksum, setStored(value) { stored = value; },
    get(query = '') { return context.exports.GET(new Request('https://synthetic.invalid/api/replica' + query)); } };
}

test('peer: anonymous published data remains independently readable without collector network or credentials', async () => {
  const h = await readerHarness();
  const meta = await h.get();
  assert.equal(meta.status, 200);
  const decoded = await meta.json();
  assert.equal(decoded.readOnly, true);
  assert.equal(decoded.collectionRequiresLocalComputer, true);
  assert.equal(decoded.manifest.asOf, clock);
  const part = await h.get('?' + new URLSearchParams({ generation: clock, part: 'topics.json' }));
  assert.equal(part.status, 200);
  assert.equal(await part.text(), h.body);
  assert.equal(part.headers.get('X-Data-SHA256'), h.checksum);
  assert.equal(part.headers.get('X-Data-Cutoff'), clock);
  assert.equal((await h.get('?' + new URLSearchParams({ generation: '2026-09-21T12:00:00.000Z' }))).status, 404);
});

test('peer: missing cloud body reports unavailable, preserves the published pointer and never returns fake zero data', async () => {
  const h = await readerHarness(), before = structuredClone(h.published);
  h.setStored(false);
  const response = await h.get('?' + new URLSearchParams({ generation: clock, part: 'topics.json' }));
  assert.equal(response.status, 503);
  const error = await response.json();
  assert.equal(typeof error.error, 'string');
  assert.equal('items' in error, false);
  assert.deepEqual(h.published, before);
  assert.equal((await h.get()).status, 200);
});
