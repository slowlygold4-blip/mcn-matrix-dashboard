// Offline fake DOM/network events only. These execute the actual collector
// and serialized geometry helper, not a fabricated eligible projection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';

const ownerURL = new URL('../scripts/douyin_browser_collector.mjs', import.meta.url).href;
const fixture = (await readFile(new URL('./phase87-collector-peer.test.mjs', import.meta.url), 'utf8'))
  .split('\ntest(')[0]
  .replace("process.env.PHASE87_OWNER_URL || '../scripts/douyin_browser_collector.mjs'", JSON.stringify(ownerURL))
  // Page evaluation shares one realm in a real browser. Keep WeakMap identity
  // stable across this fixture's fresh VM contexts for the same DOM document.
  .replace('args, URL, URLSearchParams, Date, AbortController,', 'args, URL, URLSearchParams, Date, AbortController, WeakMap,');
const { run } = await import(`data:text/javascript;base64,${Buffer.from(fixture + '\nexport {run};').toString('base64')}`);

test('continuation: transient not-scrollable region is requalified within the original deadline', async t => {
  let probesAfterSuccess = 0, restoredAt = null;
  const { result, page } = await run(t, {
    regionMode: 'visible',
    beforeEvaluate: (p, fn) => {
      if (fn.name !== 'observeFirstPageActivation' || p.reads !== 1) return;
      probesAfterSuccess++;
      if (probesAfterSuccess === 1) p.region.scrollHeight = p.region.clientHeight;
    },
  }, { events: {
    1000: p => p.deliver(0),
    1200: p => {
      restoredAt = Date.now();
      p.region.scrollHeight = 3000;
      p.mouse.wheel = async () => { p.wheels++; p.deliver(10); };
    },
  } });
  assert.equal(restoredAt, 1200);
  assert.ok(probesAfterSuccess >= 3 && probesAfterSuccess <= 5);
  assert.equal(page.wheels, 1);
  assert.equal(page.gets.length, 0);
  assert.equal(result.posts.length, 2);
  assert.equal(result.pagination.stopReason, 'end-of-list');
  assert.equal(result.errorCode, undefined);
  assert.equal(result.failureDiagnostics.stopReason, 'success');
  assert.equal(result.failureDiagnostics.continuationActivation.renderRecheckCount, 1);
  assert.deepEqual(result.failureDiagnostics.httpStatuses, [200]);
  assert.equal(result.failureDiagnostics.firstPageActivation.state, 'not-eligible');
  assert.ok(result.failureDiagnostics.elapsedMs < 4500);
});

test('continuation: a visible gate remains held and keeps its distinct diagnostic', async t => {
  let gated = false;
  const { result, page } = await run(t, {
    regionMode: 'visible',
    beforeEvaluate: (p, fn) => {
      if (fn.name === 'observeFirstPageActivation' && p.reads === 1) {
        gated = true; p.config.gate = true;
      }
    },
  }, { events: { 1000: p => p.deliver(0) } });
  assert.equal(gated, true);
  assert.equal(page.gets.length, 0);
  assert.equal(page.wheels, 0);
  assert.equal(result.posts.length, 1);
  assert.equal(result.pagination.stopReason, 'page-timeout');
  assert.equal(result.errorCode, 'collector_error');
  assert.equal(result.failureDiagnostics.continuationActivation.lastBranch, 'blocked');
  assert.equal(result.failureDiagnostics.continuationActivation.structure.reason, 'visible-gate');
  assert.equal(result.failureDiagnostics.continuationActivation.probeCount, 1);
  assert.equal(result.failureDiagnostics.stopReason, 'deadline');
  assert.equal(result.failureDiagnostics.firstPageActivation.state, 'not-eligible');
});

test('diagnosis control: a natural bound second response can still finish while scroll is held', async t => {
  const { result, page } = await run(t, {
    regionMode: 'visible',
    beforeEvaluate: (p, fn) => {
      if (fn.name === 'observeFirstPageActivation' && p.reads === 1)
        p.region.scrollHeight = p.region.clientHeight;
    },
  }, { events: { 1000: p => p.deliver(0), 1200: p => p.deliver(10) } });
  assert.equal(page.gets.length, 0);
  assert.equal(page.wheels, 0);
  assert.equal(result.posts.length, 2);
  assert.equal(result.pagination.stopReason, 'end-of-list');
  assert.equal(result.errorCode, undefined);
});

const notScrollable = (p, fn) => {
  if (fn.name === 'observeFirstPageActivation' && p.reads === 1)
    p.region.scrollHeight = p.region.clientHeight;
};

test('continuation: permanent non-scrollability is bounded to eight projections and no actions', async t => {
  const { result, page } = await run(t, { regionMode: 'visible', beforeEvaluate: notScrollable },
    { events: { 1000: p => p.deliver(0) } });
  assert.equal(page.wheels, 0); assert.equal(page.moves, 0); assert.equal(page.gets.length, 0);
  assert.equal(result.posts.length, 1);
  assert.equal(result.pagination.stopReason, 'page-timeout');
  const diagnostics = result.failureDiagnostics.continuationActivation;
  assert.equal(diagnostics.probeCount, 8); assert.equal(diagnostics.renderRecheckCount, 7);
  assert.equal(diagnostics.lastBranch, 'render-wait-exhausted');
  assert.ok(result.failureDiagnostics.elapsedMs < 4100, 'the existing three-second page budget is not renewed');
});

test('continuation: a later visible gate terminates requalification even if it disappears afterwards', async t => {
  const { result, page } = await run(t, { regionMode: 'visible', beforeEvaluate: notScrollable },
    { events: { 1000: p => p.deliver(0), 1200: p => { p.config.gate = true; },
      1500: p => { p.config.gate = false; p.region.scrollHeight = 3000; } } });
  assert.equal(page.wheels, 0); assert.equal(page.moves, 0); assert.equal(page.gets.length, 0);
  assert.equal(result.posts.length, 1);
  assert.equal(result.failureDiagnostics.continuationActivation.probeCount, 2);
  assert.equal(result.failureDiagnostics.continuationActivation.lastBranch, 'blocked');
  assert.equal(result.failureDiagnostics.continuationActivation.structure.reason, 'visible-gate');
});

test('continuation: cancellation during render wait cannot trigger another qualification or wheel', async t => {
  const controller = new AbortController();
  const { result, page } = await run(t, { regionMode: 'visible', beforeEvaluate: notScrollable },
    { options: { signal: controller.signal }, events: { 1000: p => p.deliver(0), 1200: () => controller.abort() } });
  assert.equal(result.pagination.stopReason, 'cancelled');
  assert.equal(result.failureDiagnostics.continuationActivation.probeCount, 1);
  assert.equal(page.wheels, 0); assert.equal(page.moves, 0); assert.equal(page.gets.length, 0);
});

test('continuation: a gate appearing after a wheel is recorded and prevents any further action', async t => {
  const { result, page } = await run(t, { regionMode: 'visible' },
    { events: { 1000: p => {
      p.mouse.wheel = async () => { p.wheels++; p.config.gate = true; };
      p.deliver(0);
    } } });
  assert.equal(page.gets.length, 0); assert.equal(page.wheels, 1); assert.equal(page.moves, 1);
  assert.equal(result.posts.length, 1);
  assert.equal(result.failureDiagnostics.continuationActivation.lastBranch, 'blocked');
  assert.equal(result.failureDiagnostics.continuationActivation.structure.reason, 'visible-gate');
});

test('continuation: pending natural next response retains its own body deadline without extra requests', async t => {
  const { result, page } = await run(t, { regionMode: 'visible', beforeEvaluate: notScrollable },
    { options: { timeoutMs: 6000 }, events: {
      1000: p => p.deliver(0), 1200: p => p.deliver(10, { bodyDelay: 3500 }),
    } });
  assert.equal(page.wheels, 0); assert.equal(page.moves, 0); assert.equal(page.gets.length, 0);
  assert.equal(result.posts.length, 2); assert.equal(result.pagination.stopReason, 'end-of-list');
  assert.equal(result.failureDiagnostics.continuationActivation.probeCount, 1);
});

test('continuation: short absolute deadline wins over scheduled render requalification', async t => {
  const { result, page } = await run(t, { regionMode: 'visible', beforeEvaluate: notScrollable },
    { options: { timeoutMs: 1100 }, events: { 1000: p => p.deliver(0) } });
  assert.equal(page.gets.length, 0); assert.equal(page.wheels, 0);
  assert.equal(result.failureDiagnostics.continuationActivation.probeCount, 1);
  assert.equal(result.pagination.stopReason, 'deadline');
  assert.ok(result.failureDiagnostics.elapsedMs <= 1100);
});

test('continuation: another document during render wait cannot reuse old list evidence', async t => {
  const { result, page } = await run(t, { regionMode: 'visible', beforeEvaluate: notScrollable },
    { events: { 1000: p => p.deliver(0), 1200: p => p.commit('MS4wLjABAAAAAnotherOfflineAccount') } });
  assert.equal(page.gets.length, 0); assert.equal(page.wheels, 0); assert.equal(page.moves, 0);
  assert.equal(result.posts.length, 1); assert.equal(result.pagination.stopReason, 'navigation-changed');
});

test('continuation diagnostics: optional whitelist is idempotent and preserves legacy absence', () => {
  const legacy = sanitizeBrowserWorksDiagnostics({ version: 1 });
  assert.equal(Object.hasOwn(legacy, 'continuationActivation'), false);
  assert.deepEqual(sanitizeBrowserWorksDiagnostics(legacy), legacy);
  const projected = sanitizeBrowserWorksDiagnostics({ version: 1, continuationActivation: {
    version: 1, probeCount: 8, renderRecheckCount: 7, actionCount: 0, lastBranch: 'render-wait-exhausted',
    url: 'PRIVATE_SECRET', cookie: 'PRIVATE_SECRET', cursor: 123, x: 456,
    structure: { reason: 'not-scrollable', regionCount: 1, visibleRegionCount: 1, leafRegionCount: 1,
      ancestorCount: 12, private: 'PRIVATE_SECRET' },
  } });
  assert.deepEqual(sanitizeBrowserWorksDiagnostics(projected), projected);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_SECRET|cookie|cursor|"x"/);
  const unknown = sanitizeBrowserWorksDiagnostics({ version: 1, continuationActivation: {
    version: 1, probeCount: Infinity, renderRecheckCount: 99, actionCount: -1, lastBranch: 'PRIVATE_SECRET',
  } }).continuationActivation;
  assert.equal(unknown.lastBranch, 'projection-held'); assert.equal(unknown.probeCount, null);
  assert.equal(unknown.renderRecheckCount, null); assert.equal(unknown.actionCount, null);
});
