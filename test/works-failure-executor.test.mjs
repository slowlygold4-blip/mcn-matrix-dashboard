import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnedCollectorExecutor } from '../lib/collector-ownership.mjs';

const ownershipURL = new URL('../lib/collector-ownership.mjs', import.meta.url).href;
const collectorURL = new URL('../scripts/douyin_browser_collector.mjs', import.meta.url).href;
// A real child and a real registered private process group, but no browser,
// network, saved state, cookie read, platform request or production database.
function fixture({ collectorTimeoutMs = null, stuck = false } = {}) {
  return `
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { collectorOwnershipClient } from ${JSON.stringify(ownershipURL)};
import { collectBrowserWorks } from ${JSON.stringify(collectorURL)};
const ownership = collectorOwnershipClient(); await ownership.send('hello');
${stuck ? `// Deliberately noncooperative process tests the unchanged parent failsafe.
await ownership.send('launch');
const hungOwner = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
await ownership.send('register', hungOwner.pid);
await new Promise(() => {});` : ''}
const secUid = 'MS4wLjABAAAAexecutorOfflineFixture';
const url = 'https://www.douyin.com/user/' + secUid;
const page = new EventEmitter();
const frame = { url: () => url };
page.mainFrame = () => frame; page.url = () => url; page.close = async () => {};
page.evaluate = async () => ({ observation: 'observed', readyState: 'interactive', render: { state: 'absent' } });
page.goto = async () => {
  const request = { isNavigationRequest: () => true, frame: () => frame, url: () => url, method: () => 'GET' };
  page.emit('request', request);
  page.emit('response', { request: () => request, url: () => url, status: () => 200 });
  page.emit('framenavigated', frame); page.emit('domcontentloaded');
  ${stuck ? 'await new Promise(() => {});' : ''}
};
let processHandle;
const close = async () => {
  if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
    const exited = once(processHandle, 'exit'); processHandle.kill('SIGKILL'); await exited;
  }
};
const data = await collectBrowserWorks({ items: [{ key: 'offline', secUid, limit: 30 }] }, {
  runtime: {
    ownership, readState: () => ({ cookies: [], origins: [] }), access: async () => {},
    launchServer: async () => {
      processHandle = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
      return { process: () => processHandle, wsEndpoint: () => 'offline-not-a-network-endpoint', close, kill: close };
    },
    connect: async () => ({ close: async () => {}, newContext: async () => ({ newPage: async () => page, close: async () => {} }) })
  }, collectOptions: ${JSON.stringify(collectorTimeoutMs === null ? {} : { timeoutMs: collectorTimeoutMs })}
});
await ownership.send('complete'); process.stdout.write(JSON.stringify({ ok: true, data })); process.disconnect();
`;
}

function run(source, timeout = 45_000) {
  const executor = createOwnedCollectorExecutor();
  const started = Date.now();
  return new Promise(resolve => executor.exec(process.execPath, ['--input-type=module', '-e', source],
    { timeout, cleanupTimeoutMs: timeout > 10_000 ? 3000 : 300, terminationGraceMs: 25, maxBuffer: 64 * 1024 },
    (error, stdout, stderr) => resolve({ error, stdout, stderr, elapsedMs: Date.now() - started, state: executor.state() })));
}

test('real executor: normal no-request observation ends at the existing 25s window, not the 42s parent timeout', { timeout: 35_000 }, async () => {
  const result = await run(fixture());
  assert.equal(result.error, null);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.state, { busy: false, locked: false, reason: null });
  const item = JSON.parse(result.stdout).data.items[0];
  assert.equal(item.status, 'unavailable');
  assert.equal(item.errorCode, 'collector_error');
  assert.equal(item.failureDiagnostics.stopReason, 'no-bound-request');
  assert.equal(item.failureDiagnostics.requests.matched, 0);
  assert.equal(item.failureDiagnostics.navigation.committed, true);
  assert.equal(item.failureDiagnostics.navigation.failed, false);
  assert.deepEqual(item.posts, []);
  assert.ok(item.failureDiagnostics.elapsedMs >= 24_900);
  assert.ok(result.elapsedMs < 32_000);
});

test('real executor: actual parent deadline is separately reported and safely releases the lane', { timeout: 4000 }, async () => {
  const result = await run(fixture({ stuck: true }), 1200);
  assert.equal(result.error?.code, 'BROWSER_COLLECTOR_TIMEOUT');
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.deepEqual(result.state, { busy: false, locked: false, reason: null });
  assert.ok(result.elapsedMs < 2000);
});

test('real executor: shorter collector budget is an observation result, never mislabeled process timeout', { timeout: 4000 }, async () => {
  // A 2.5s total parent could not fund the 6.5s cleanup contract. Test the
  // genuinely shorter account observation inside the real 45s parent budget.
  const result = await run(fixture({ collectorTimeoutMs: 120 }));
  assert.equal(result.error, null);
  const item = JSON.parse(result.stdout).data.items[0];
  assert.equal(item.errorCode, 'collector_error');
  assert.equal(item.failureDiagnostics.stopReason, 'no-bound-request');
  assert.equal(result.state.locked, false);
});
