import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { browserRuntimeErrorKind, sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';

// Reuse the collector peer's offline event harness, not its assertions. Import
// only its event fixture so this file adds independent error boundaries
// without registering, running, or changing the peer's tests or production.
const harnessUrl = new URL('./phase55-collector-navigation-rejection.test.mjs', import.meta.url);
const source = readFileSync(harnessUrl, 'utf8');
const start = source.indexOf('const SEC = ');
const cut = source.indexOf('\ntest(', start);
assert.ok(start > 0 && cut > start, 'the shared offline event fixture boundary must remain explicit');
const harness = `import assert from 'node:assert/strict';\nimport { EventEmitter } from 'node:events';\n`
  + source.slice(start, cut) + '\nexport { run, Page };\n';
const { run, Page } = await import(`data:text/javascript;base64,${Buffer.from(harness).toString('base64')}`);

for (const name of ['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'CustomNavigationError']) {
  test(`phase55 independent: a ready replacement never suppresses ${name}`, async t => {
    const page = new Page();
    const result = await run(t, collectOne, page, { errorName: name });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.failureDiagnostics.navigation.failed, true);
    assert.equal(page.wheels, 0);
    assert.equal(result.posts.length, 0);
  });
}

test('phase55 independent: fixed Error name does not prove a navigation interruption', () => {
  const transport = new Error('net::ERR_ABORTED');
  const programming = new Error('an application invariant failed');
  assert.equal(browserRuntimeErrorKind(transport), 'error');
  assert.equal(browserRuntimeErrorKind(programming), 'error');
  assert.equal(browserRuntimeErrorKind({ get name() { throw new Error('private'); } }), 'unknown');
});

test('phase55 independent: generic command Error still requires a newer fully verified document', async t => {
  const page = new Page();
  const result = await run(t, collectOne, page, { replacement: false });
  assert.equal(result.status, 'unavailable');
  assert.equal(page.wheels, 0);
  assert.equal(result.failureDiagnostics.navigation.failed, true);
});

test('phase55 independent: production isolates an old generic Error only after a verified newer document', async t => {
  const page = new Page();
  const result = await run(t, collectOne, page);
  assert.equal(result.status, 'ok');
  assert.equal(result.failureDiagnostics.navigation.failed, false);
  assert.equal(page.wheels, 1);
  assert.equal(result.posts.length, 1);
  assert.equal(result.pagination.stopReason, 'end-of-list');
  assert.deepEqual(result.failureDiagnostics.runtime.supersededNavigationError, {
    version: 1, commandedGeneration: 1, generation: 2, errorKind: 'error',
    attribution: 'goto-command-not-current-document',
  });
});

for (const status of [null, 403, 404, 500]) {
  test(`phase55 independent: document status ${status} never grants old-command isolation`, async t => {
    const page = new Page();
    const result = await run(t, collectOne, page, { status });
    assert.equal(result.status, 'unavailable');
    assert.equal(page.wheels, 0);
    assert.equal(result.posts.length, 0);
  });
}

test('phase55 independent: cancellation after ready document but before command rejection still stops', async t => {
  const page = new Page(); const controller = new AbortController();
  const goto = page.goto.bind(page);
  page.goto = () => {
    const promise = goto(); const reject = page.rejectGoto;
    page.rejectGoto = error => { controller.abort(); reject(error); };
    return promise;
  };
  const result = await run(t, collectOne, page, { signal: controller.signal });
  assert.equal(result.status, 'unavailable');
  assert.equal(page.wheels, 0);
  assert.equal(result.posts.length, 0);
});

test('phase55 independent: newer document cannot bless a foreign account works body', async t => {
  const page = new Page(); const emit = page.emit.bind(page);
  page.emit = (event, ...args) => {
    if (event === 'response' && typeof args[0]?.json === 'function') {
      const json = args[0].json;
      args[0].json = async () => {
        const body = await json(); body.aweme_list[0].author.sec_uid = 'MS4wLjABAAAADifferentAccount'; return body;
      };
    }
    return emit(event, ...args);
  };
  const result = await run(t, collectOne, page);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.posts.length, 0);
});

test('phase55 independent: superseded command diagnostics survive repeated sanitization without private text', () => {
  const raw = { version: 1, runtime: { supersededNavigationError: {
    version: 1, commandedGeneration: 1, generation: 2, errorKind: 'error',
    attribution: 'untrusted arbitrary text', message: 'fixture private',
    url: 'https://private.invalid/', Cookie: 'fixture private',
  } } };
  const clean = sanitizeBrowserWorksDiagnostics(raw);
  assert.deepEqual(clean.runtime.supersededNavigationError, {
    version: 1, commandedGeneration: 1, generation: 2, errorKind: 'error',
    attribution: 'goto-command-not-current-document',
  });
  assert.deepEqual(sanitizeBrowserWorksDiagnostics(clean), clean);
  assert.doesNotMatch(JSON.stringify(clean), /fixture private|private\.invalid|Cookie|untrusted arbitrary/);
});
