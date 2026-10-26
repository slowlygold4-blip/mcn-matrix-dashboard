// Independent tests of actual collector and ownership modules. Fixtures use
// detached Node children as private process groups; no Chrome, saved session,
// platform request, server, database, or production configuration is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = resolve(process.env.PHASE84_TEST_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const ownershipUrl = pathToFileURL(resolve(root, 'lib/collector-ownership.mjs')).href;
const collectorUrl = pathToFileURL(resolve(root, 'scripts/douyin_browser_collector.mjs')).href;
const { createOwnedCollectorExecutor } = await import(ownershipUrl);
const live = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = [];

async function clientHandshake(deadlineValue, { replay = false, ackOk = true } = {}) {
  const script = `
    import { collectorOwnershipClient } from ${JSON.stringify(ownershipUrl)};
    const client = collectorOwnershipClient();
    let preHelloThrew = false;
    try { client.remainingExecutionMs(); } catch { preHelloThrew = true; }
    try {
      await client.send('hello');
      const before = client.remainingExecutionMs();
      let mutationRejected = false;
      try { client.remainingExecutionMs = () => 850000; } catch { mutationRejected = true; }
      await new Promise(r => setTimeout(r, 90));
      console.log(JSON.stringify({ accepted: true, before, after: client.remainingExecutionMs(),
        frozen: Object.isFrozen(client), preHelloThrew, mutationRejected }));
    } catch (error) { console.log(JSON.stringify({ accepted: false, code: error.code || null })); }
    finally { process.disconnect(); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH || '', MCN_BROWSER_OWNERSHIP_NONCE: 'phase84-offline-nonce' },
  });
  let stdout = '', stderr = '', replayTimer;
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.on('message', message => {
    const ack = { channel: message.channel, nonce: message.nonce, request: message.request, kind: 'ack', ok: ackOk };
    if (deadlineValue !== undefined) ack.executionDeadlineNs = deadlineValue;
    child.send(ack);
    if (replay) replayTimer = setTimeout(() => {
      if (child.connected) child.send({ ...ack, executionDeadlineNs: String(process.hrtime.bigint() + 800_000_000_000n) });
    }, 25);
  });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 4000);
  try {
    const [code, signal] = await once(child, 'close');
    assert.equal(code, 0); assert.equal(signal, null); assert.equal(stderr, ''); assert.equal(live(child.pid), false);
    const outcome = JSON.parse(stdout);
    evidence.push({ fixture: 'hello-ack', deadlineShape: deadlineValue === undefined ? 'missing' : typeof deadlineValue,
      replay, ackOk, ids: [child.pid], aliveAtCallback: [], childClosedBeforeCallback: true, outcome });
    return outcome;
  } finally {
    clearTimeout(watchdog); clearTimeout(replayTimer);
    if (live(child.pid)) child.kill('SIGKILL');
    for (let n = 0; n < 100 && live(child.pid); n++) await delay(20);
    assert.equal(live(child.pid), false);
  }
}

function fixture(config) {
  return `
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { collectorOwnershipClient } from ${JSON.stringify(ownershipUrl)};
import { collectBrowserWorks } from ${JSON.stringify(collectorUrl)};
const cfg = ${JSON.stringify(config)};
const pause = ms => new Promise(r => setTimeout(r, ms));
const never = () => new Promise(() => {});
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const ipc = collectorOwnershipClient();
if (cfg.helloDelay) await pause(cfg.helloDelay);
await ipc.send('hello');
const helloRemaining = ipc.remainingExecutionMs?.() ?? null;
const sec = 'MS4wLjABAAAAphase84IndependentFixture';
const other = 'MS4wLjABAAAAphase84IndependentOther';
const profile = 'https://www.douyin.com/user/' + sec;
const calls = [], handles = [], timers = new Set();
const schedule = (fn, ms) => { const handle = setTimeout(() => { timers.delete(handle); fn(); }, ms); timers.add(handle); };
let group;
const endGroup = async () => {
  calls.push('kill');
  if (cfg.unconfirmedKill) return;
  if (group.exitCode === null && group.signalCode === null) {
    const exited = once(group, 'exit'); group.kill('SIGKILL'); await exited;
  }
};
const close = async name => {
  calls.push(name);
  if (cfg.hangingCloses) return never();
  if (name === 'page') { for (const handle of timers) clearTimeout(handle); timers.clear(); }
  if (name === 'server') await endGroup();
};
class Page extends EventEmitter {
  address = 'about:blank';
  mainFrame() { return this; }
  url() { return this.address; }
  request(url, document = false, method = 'GET') {
    return { url: () => url, frame: () => this, method: () => method,
      isNavigationRequest: () => document, resourceType: () => document ? 'document' : 'fetch', redirectedFrom: () => null };
  }
  async goto(_url, options) {
    calls.push('goto');
    const nav = this.request(profile, true); this.emit('request', nav);
    this.emit('response', { request: () => nav, url: nav.url, status: () => 200 });
    this.address = profile; this.emit('framenavigated', this);
    if (cfg.noWorks) return;
    schedule(() => {
      const works = this.request('https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=' + sec + '&max_cursor=' + (cfg.cursor || 0), false, cfg.method || 'GET');
      this.emit('request', works);
      this.emit('response', { request: () => works, url: works.url, status: () => cfg.status || 200,
        json: async () => {
          calls.push('body');
          if (cfg.bodyDelay) await new Promise(r => schedule(r, cfg.bodyDelay));
          return { status_code: cfg.businessCode || 0, has_more: false, max_cursor: 0,
            aweme_list: [{ aweme_id: '7234567890123400084', author: { sec_uid: cfg.wrongAuthor ? other : sec, uid: '1234567890' }, statistics: { digg_count: 84 } }] };
        } });
    }, cfg.worksDelay || 15);
  }
  async close() { return close('page'); }
}
const page = new Page();
const ownedRuntime = Object.freeze({
  remainingExecutionMs: () => ipc.remainingExecutionMs(),
  send: async (kind, pid) => { await ipc.send(kind, pid); if (kind === cfg.delayAfterAck) await pause(3000); }
});
const runtime = {
  ownership: cfg.delayAfterAck ? ownedRuntime : ipc,
  readState: async () => { calls.push('state'); if (cfg.setupDelay) await pause(cfg.setupDelay); return { cookies: [], origins: [] }; },
  access: async () => { calls.push('access'); },
  launchServer: async () => {
    calls.push('launch');
    group = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { detached: true, stdio: 'ignore' });
    emit({ fixture: 'private-process', pid: group.pid });
    return { process: () => group, wsEndpoint: () => 'ws://fixture.invalid', close: () => close('server'), kill: endGroup };
  },
  connect: async () => { calls.push('connect'); return { newContext: async () => ({ newPage: async () => page, close: () => close('context') }), close: () => close('browser') }; }
};
const payload = { items: [{ key: 'phase84-independent', secUid: sec, limit: 30,
  executionDeadlineNs: '999999999999999999999', timeoutMs: 850000 }],
  executionDeadlineNs: '999999999999999999999', remainingExecutionMs: 850000,
  collectOptions: { batchTimeoutMs: 850000, timeoutMs: 850000 } };
try {
  const data = await collectBrowserWorks(payload, { runtime, collectOptions: { timeoutMs: cfg.accountTimeout || 45000 } });
  await ipc.send('complete');
  emit({ fixture: 'result', data, calls, helloRemaining, remaining: ipc.remainingExecutionMs?.() ?? null,
    liveAtOutput: group ? group.exitCode === null && group.signalCode === null : false });
} catch (error) {
  emit({ fixture: 'failure', code: error.code || null, calls, helloRemaining,
    liveAtOutput: group ? group.exitCode === null && group.signalCode === null : false });
  try { await ipc.send('complete'); } catch {}
  process.exitCode = 1;
} finally {
  for (const handle of timers) clearTimeout(handle);
  if (process.connected) process.disconnect();
}
`;
}

async function invoke(config = {}, parentOptions = {}) {
  const executor = createOwnedCollectorExecutor(), ids = [], events = [];
  const started = performance.now();
  let child, buffered = '', closeSeen = false;
  const result = new Promise(resolveResult => {
    child = executor.exec(process.execPath, ['--input-type=module', '-e', fixture(config)], {
      cwd: root, timeout: 10_000, cleanupTimeoutMs: 1000, terminationGraceMs: 50,
      maxBuffer: 65536,
      env: { PATH: process.env.PATH || '', MCN_BROWSER_EXECUTION_DEADLINE_NS: '999999999999999999999',
        MCN_BROWSER_DEADLINE: '999999999999999999999', DOUYIN_COLLECTOR_TIMEOUT_MS: '850000' },
      ...parentOptions,
    }, (error, stdout, stderr) => resolveResult({ error, stdout, stderr, at: performance.now(), closeSeen }));
    if (child?.pid) ids.push(child.pid);
    child?.once('close', () => { closeSeen = true; });
    child?.stdout.on('data', chunk => {
      buffered += String(chunk);
      let end;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        try { const event = JSON.parse(line); events.push(event); if (event.fixture === 'private-process') ids.push(event.pid); } catch {}
      }
    });
  });
  try {
    const out = await result;
    const aliveAtCallback = ids.filter(live);
    const record = { config, elapsedMs: Math.round(out.at - started), code: out.error?.code ?? null,
      childClosedBeforeCallback: out.closeSeen, ids: [...ids], aliveAtCallback, state: executor.state(),
      result: events.find(event => event.fixture === 'result') ?? null,
      failure: events.find(event => event.fixture === 'failure') ?? null };
    evidence.push({ ...record, result: record.result ? {
      status: record.result.data.items[0].status,
      errorCode: record.result.data.items[0].errorCode ?? null,
      elapsedMs: record.result.data.items[0].failureDiagnostics.elapsedMs,
      posts: record.result.data.items[0].posts.length,
      stopReason: record.result.data.items[0].failureDiagnostics.stopReason,
      calls: record.result.calls, helloRemaining: record.result.helloRemaining,
      remaining: record.result.remaining, liveAtOutput: record.result.liveAtOutput,
    } : null });
    assert.deepEqual(aliveAtCallback, [], 'every owned process must have ended at parent callback');
    assert.equal(out.closeSeen, true, 'callback must not certify an unclosed collector pipe');
    assert.equal(out.stderr, '');
    assert.ok(record.elapsedMs <= (parentOptions.timeout || 10_000) + 400, 'original parent budget is not extended');
    return { ...out, ...record, events };
  } finally {
    // Explicit fixture-owned identities only, including on assertion failures.
    for (const pid of ids) if (live(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    for (let n = 0; n < 100 && ids.some(live); n++) await delay(20);
    assert.deepEqual(ids.filter(live), [], 'fixture finally must confirm all its children ended');
  }
}

test('phase84 independent: real owner closes group before accepting collector output', { timeout: 15_000 }, async () => {
  const out = await invoke({ setupDelay: 300 });
  assert.equal(out.error, null);
  assert.equal(out.result.data.items[0].status, 'ok');
  assert.equal(out.result.data.items[0].posts[0].statistics.digg_count, 84);
  assert.equal(out.result.liveAtOutput, false);
  assert.equal(out.state.locked, false);
});

test('phase84 independent: delayed hello consumes parent budget and public deadline fields cannot replenish it', { timeout: 15_000 }, async () => {
  const out = await invoke({ helloDelay: 600, setupDelay: 400, bodyDelay: 4000 });
  assert.equal(out.error, null, 'owned child should return safe account diagnostics before forced parent shutdown');
  assert.equal(out.result.data.items[0].status, 'unavailable');
  assert.deepEqual(out.result.data.items[0].posts, []);
  assert.equal(out.result.liveAtOutput, false);
  assert.ok(out.result.helloRemaining <= 8500 && out.result.helloRemaining > 6000);
  assert.ok(out.result.data.items[0].failureDiagnostics.elapsedMs < 4000);
});

test('phase84 independent: original 45-second parent retains account diagnostics after real setup consumption', {
  timeout: 50_000, skip: process.env.PHASE84_REAL45 !== '1' ? 'explicit 45-second ownership audit only' : false,
}, async () => {
  const out = await invoke({ helloDelay: 500, setupDelay: 5500, worksDelay: 20_000, bodyDelay: 20_000 },
    { timeout: 45_000, cleanupTimeoutMs: 3000, terminationGraceMs: 350 });
  assert.equal(out.error, null, 'child must return unavailable before the original parent begins forced shutdown at 42 seconds');
  assert.equal(out.result.data.items[0].status, 'unavailable');
  assert.deepEqual(out.result.data.items[0].posts, []);
  assert.equal(out.result.liveAtOutput, false);
  assert.ok(out.elapsedMs < 42_000);
  assert.ok(out.result.data.items[0].failureDiagnostics.elapsedMs <= 30_000, 'six seconds of real import/handshake/setup time cannot be refunded');
});

test('phase84 independent: all ordinary closes hanging share one budget and a verified kill permits clean return', { timeout: 15_000 }, async () => {
  const out = await invoke({ hangingCloses: true });
  assert.equal(out.error, null, 'serial close ceilings must not consume the parent execution deadline');
  assert.equal(out.result.data.items[0].status, 'ok');
  assert.equal(out.result.liveAtOutput, false);
  assert.deepEqual(out.result.calls.filter(name => ['page', 'context', 'browser', 'server', 'kill'].includes(name)),
    ['page', 'context', 'browser', 'server', 'kill']);
  assert.ok(out.elapsedMs < 6000, 'one shared cleanup budget, not four reset 2-second budgets');
});

test('phase84 independent: resolved kill with a still-live process cannot become accepted success', { timeout: 15_000 }, async () => {
  const out = await invoke({ hangingCloses: true, unconfirmedKill: true });
  assert.ok(out.error, 'cleanup without process exit is an error');
  assert.equal(out.stdout, '', 'no successful data escapes owner rejection');
  assert.equal(out.result, null);
});

test('phase84 independent: private hello deadline cannot be omitted, coerced, or supplied as an unbounded integer', { timeout: 15_000 }, async () => {
  for (const value of [undefined, 850000, '0', '-1', '9'.repeat(100)]) {
    const out = await clientHandshake(value);
    assert.equal(out.accepted, false);
    assert.match(out.code, /^BROWSER_PROTOCOL_/);
  }
});

test('phase84 independent: accepted hello stores immutable monotonic deadline and ignores replay extension', { timeout: 5000 }, async () => {
  const out = await clientHandshake(String(process.hrtime.bigint() + 5_000_000_000n), { replay: true });
  assert.equal(out.accepted, true);
  assert.equal(out.preHelloThrew, true); assert.equal(out.frozen, true); assert.equal(out.mutationRejected, true);
  assert.ok(out.before > 0 && out.before <= 5000);
  assert.ok(out.after <= out.before - 60, 'replayed ACK must not restart or extend the closure-owned deadline');
});

test('phase84 independent: truthy non-boolean ACK cannot establish trusted deadline', { timeout: 5000 }, async () => {
  for (const ackOk of [1, 'true', {}, []]) {
    const out = await clientHandshake(String(process.hrtime.bigint() + 5_000_000_000n), { ackOk });
    assert.equal(out.accepted, false); assert.equal(out.code, 'BROWSER_PROTOCOL_REJECTED');
  }
});

for (const stage of ['launch', 'register']) test('phase84 independent: exhausted ' + stage + ' handshake cannot start a new resource', { timeout: 15_000 }, async () => {
  const out = await invoke({ delayAfterAck: stage });
  assert.ok(out.error); assert.equal(out.stdout, ''); assert.equal(out.result, null);
  assert.ok(out.failure);
  assert.equal(out.failure.calls.includes(stage === 'launch' ? 'launch' : 'connect'), false);
  assert.equal(out.failure.calls.includes('goto'), false);
  assert.equal(out.ids.length, stage === 'launch' ? 1 : 2);
});

test('phase84 independent: frozen wall clock cannot extend cleanup or certify a still-open inherited pipe', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const executor = createOwnedCollectorExecutor(), ids = [];
  const source = `
    import { spawn } from 'node:child_process'; import { once } from 'node:events';
    import { collectorOwnershipClient } from ${JSON.stringify(ownershipUrl)};
    const ipc = collectorOwnershipClient(); await ipc.send('hello'); await ipc.send('launch');
    const browser = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    await ipc.send('register', browser.pid);
    const ended = once(browser, 'exit'); browser.kill('SIGKILL'); await ended; await ipc.send('released', browser.pid);
    const keeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: ['ignore', 'inherit', 'ignore'] }); keeper.unref();
    console.log(JSON.stringify({ ids: [browser.pid, keeper.pid] }));
    await ipc.send('complete'); process.disconnect();
  `;
  const started = performance.now(); let child, text = '', watchdog;
  try {
    const out = await new Promise(resolveResult => {
      child = executor.exec(process.execPath, ['--input-type=module', '-e', source], {
        cwd: root, timeout: 2000, cleanupTimeoutMs: 300, terminationGraceMs: 20,
        env: { PATH: process.env.PATH || '' },
      }, (error, stdout) => resolveResult({ code: error?.code ?? null, stdout, elapsedMs: performance.now() - started }));
      ids.push(child.pid);
      child.stdout.on('data', chunk => {
        text += String(chunk);
        if (text.includes('\n') && ids.length === 1) ids.push(...JSON.parse(text.split('\n')[0]).ids);
      });
      watchdog = setTimeout(() => { for (const pid of ids) if (live(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} } }, 1600);
    });
    const aliveAtCallback = ids.filter(live);
    evidence.push({ fixture: 'frozen-wall-clock', ids: [...ids], aliveAtCallback,
      code: out.code, elapsedMs: Math.round(out.elapsedMs), expectedUncertainty: true, confirmedAfterCleanup: false });
    assert.equal(out.code, 'BROWSER_CLEANUP_UNCERTAIN'); assert.equal(out.stdout, '');
    assert.ok(out.elapsedMs < 1000, 'cleanup uses monotonic 300ms budget despite frozen Date');
    assert.equal(executor.state().locked, true);
    assert.equal(aliveAtCallback.length, 1, 'unregistered inherited pipe must be identified as uncertain, never guessed safe or killed by supervisor');
  } finally {
    clearTimeout(watchdog); t.mock.timers.reset();
    for (const pid of ids) if (live(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    for (let n = 0; n < 100 && ids.some(live); n++) await delay(20);
    assert.deepEqual(ids.filter(live), [], 'every explicitly fixture-owned child ended after uncertain-case cleanup');
    const record = evidence.findLast(x => x.fixture === 'frozen-wall-clock');
    if (record) record.confirmedAfterCleanup = true;
  }
});

for (const [label, config, expected] of [
  ['wrong author', { wrongAuthor: true }, 'upstream_changed'],
  ['nonzero initial cursor', { cursor: 123 }, null],
  ['POST', { method: 'POST' }, null],
  ['HTTP 503', { status: 503 }, 'network_error'],
  ['business 2483', { businessCode: 2483 }, 'login_required'],
]) test('phase84 independent: remaining budget keeps strict ' + label + ' gate', { timeout: 15_000 }, async () => {
  const out = await invoke(config);
  assert.equal(out.error, null);
  const item = out.result.data.items[0];
  assert.equal(item.status, 'unavailable'); assert.deepEqual(item.posts, []);
  if (expected) assert.equal(item.errorCode, expected);
  assert.equal(out.result.liveAtOutput, false);
  if (config.method === 'POST' || config.status === 503 || config.cursor) assert.equal(out.result.calls.includes('body'), false);
});

test.after(() => {
  process.stdout.write('# PHASE84_INDEPENDENT_EVIDENCE ' + JSON.stringify({ root, cases: evidence.length,
    allOwnedChildrenEnded: evidence.every(x => x.confirmedAfterCleanup === true || x.aliveAtCallback.length === 0), evidence }) + '\n');
});
