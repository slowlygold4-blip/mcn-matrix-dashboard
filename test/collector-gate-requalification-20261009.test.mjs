// Offline fixture: execute actual serialized gate and collector, no browser.
// A transient fixture is not proof that a particular production gate clears.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';

const ownerURL = new URL('../scripts/douyin_browser_collector.mjs', import.meta.url).href;
const fixture = (await readFile(new URL('./phase87-collector-peer.test.mjs', import.meta.url), 'utf8'))
  .split('\ntest(')[0]
  .replace("process.env.PHASE87_OWNER_URL || '../scripts/douyin_browser_collector.mjs'", JSON.stringify(ownerURL))
  .replace('args, URL, URLSearchParams, Date, AbortController,', 'args, URL, URLSearchParams, Date, AbortController, WeakMap,');
const { run, payload } = await import(`data:text/javascript;base64,${Buffer.from(fixture + '\nexport {run,payload};').toString('base64')}`);

const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
function install(p, state) {
  const nav = { getBoundingClientRect: () => box(0, 0, 1280, 80) };
  const unknown = { getBoundingClientRect: () => box(1120, 20, 80, 32),
    getAttribute: name => name === 'aria-label' ? '登录' : null,
    matches: selector => selector.split(',').some(s => s.trim() === 'button'),
    closest: selector => selector.includes('role="dialog"') ? null : state.ready ? nav : null,
    querySelectorAll: () => [], contains: node => node === unknown };
  const modal = { getBoundingClientRect: () => box(200, 120, 400, 300),
    matches: selector => state.kind === 'challenge' ? selector.includes('captcha')
      : state.kind === 'credential-form' ? selector.includes('input[type="password"]') : selector.includes('role="dialog"') };
  const previous = p.document.querySelectorAll;
  p.document.querySelectorAll = selector => selector.includes('role="dialog"')
    ? state.modal ? (state.unknownFirst ? [unknown, modal] : [modal, unknown]) : [unknown] : previous(selector);
  p.document.elementFromPoint = () => state.ready ? p.region : {};
  p.mouse.wheel = async () => { p.wheels++; assert.equal(state.ready, true); assert.equal(state.modal, false); p.deliver(10); };
}

test('transient unknown navigation/occlusion can requalify without renewing page deadline', async t => {
  const state = { ready: false, modal: false }; let installed = false;
  const { result, page } = await run(t, { regionMode: 'visible', beforeEvaluate: (p, fn) => {
    if (fn.name === 'observeFirstPageActivation' && p.reads === 1 && !installed) { installed = true; install(p, state); }
  } }, { events: { 1000: p => p.deliver(0), 1200: () => { state.ready = true; } } });
  assert.equal(installed, true); assert.equal(page.gets.length, 0);
  assert.equal(result.posts.length, 2, 'first denied projection must not permanently suppress later fully qualified visible region');
  assert.equal(page.wheels, 1); assert.equal(page.moves, 1);
  assert.equal(result.pagination.stopReason, 'end-of-list');
  assert.equal(result.failureDiagnostics.continuationActivation.gateRecheckCount, 1);
  assert.equal(result.failureDiagnostics.continuationActivation.renderRecheckCount, 0);
  assert.ok(result.failureDiagnostics.elapsedMs < 4020);
});

const installOnce = state => {
  let installed = false;
  return (p, fn) => {
    if (fn.name === 'observeFirstPageActivation' && p.reads === 1 && !installed) { installed = true; install(p, state); }
  };
};
const noActions = page => { assert.equal(page.gets.length, 0); assert.equal(page.moves, 0); assert.equal(page.wheels, 0); };

test('persistent uncertainty stops at eight total waiting probes inside original budget', async t => {
  const { result, page } = await run(t, { regionMode: 'visible', beforeEvaluate: installOnce({ ready: false, modal: false }) },
    { events: { 1000: p => p.deliver(0) } });
  noActions(page); assert.equal(result.posts.length, 1); assert.equal(result.pagination.stopReason, 'page-timeout');
  const d = result.failureDiagnostics.continuationActivation;
  assert.equal(d.probeCount, 8); assert.equal(d.gateRecheckCount, 7); assert.equal(d.renderRecheckCount, 0);
  assert.equal(d.lastBranch, 'gate-wait-exhausted'); assert.equal(d.structure.gates.decision, 'unknown');
  assert.ok(result.failureDiagnostics.elapsedMs < 4100);
});

for (const kind of ['modal', 'challenge', 'credential-form']) test(`unknown followed by ${kind} remains held when gate later disappears`, async t => {
  const state = { ready: false, modal: false, kind, unknownFirst: true };
  const { result, page } = await run(t, { regionMode: 'visible', beforeEvaluate: installOnce(state) },
    { events: { 1000: p => p.deliver(0), 1200: () => { state.modal = true; },
      1500: () => { state.ready = true; state.modal = false; } } });
  noActions(page); assert.equal(result.posts.length, 1);
  const d = result.failureDiagnostics.continuationActivation;
  assert.equal(d.probeCount, 2); assert.equal(d.gateRecheckCount, 1); assert.equal(d.lastBranch, 'blocked');
  assert.equal(d.structure.gates.decision, kind);
});

test('a natural second page after a hard gate does not re-enable third-page actions', async t => {
  const state = { ready: false, modal: true, unknownFirst: true };
  const { result, page } = await run(t, { regionMode: 'visible', beforeEvaluate: installOnce(state) },
    { events: { 1000: p => p.deliver(0), 1200: () => { state.ready = true; state.modal = false; },
      1400: p => p.deliver(10, { body: payload(10, true) }) } });
  noActions(page); assert.equal(result.posts.length, 2); assert.equal(result.pagination.stopReason, 'page-timeout');
  assert.equal(result.failureDiagnostics.continuationActivation.probeCount, 1);
  assert.equal(result.failureDiagnostics.continuationActivation.structure.gates.decision, 'modal');
});

test('known-clear navigation progresses immediately without a gate wait', async t => {
  const { result, page } = await run(t, { regionMode: 'visible', beforeEvaluate: installOnce({ ready: true, modal: false }) },
    { events: { 1000: p => p.deliver(0) } });
  assert.equal(page.gets.length, 0); assert.equal(page.wheels, 1); assert.equal(result.posts.length, 2);
  assert.equal(Object.hasOwn(result.failureDiagnostics.continuationActivation, 'gateRecheckCount'), false);
  assert.ok(result.failureDiagnostics.elapsedMs < 1250);
});

test('cancellation during unknown wait prevents requalification and actions', async t => {
  const controller = new AbortController(), state = { ready: false, modal: false };
  const { result, page } = await run(t, { regionMode: 'visible', beforeEvaluate: installOnce(state) },
    { options: { signal: controller.signal }, events: { 1000: p => p.deliver(0),
      1200: () => { state.ready = true; controller.abort(); } } });
  noActions(page); assert.equal(result.pagination.stopReason, 'cancelled');
  assert.equal(result.failureDiagnostics.continuationActivation.probeCount, 1);
});

test('original absolute deadline ends unknown waiting without another probe', async t => {
  const { result, page } = await run(t, { regionMode: 'visible', beforeEvaluate: installOnce({ ready: false, modal: false }) },
    { options: { timeoutMs: 1100 }, events: { 1000: p => p.deliver(0) } });
  noActions(page); assert.equal(result.pagination.stopReason, 'deadline');
  assert.equal(result.failureDiagnostics.continuationActivation.probeCount, 1);
  assert.ok(result.failureDiagnostics.elapsedMs <= 1100);
});

test('replacement document retires unknown waiting without a wheel or request', async t => {
  const { result, page } = await run(t, { regionMode: 'visible', beforeEvaluate: installOnce({ ready: false, modal: false }) },
    { events: { 1000: p => p.deliver(0), 1200: p => p.commit('MS4wLjABAAAAOfflineOtherDocument') } });
  noActions(page); assert.equal(result.pagination.stopReason, 'navigation-changed');
  assert.equal(result.failureDiagnostics.continuationActivation.probeCount, 1);
});

test('unknown wait followed by not-scrollable render wait shares the same eight-probe ceiling', async t => {
  const state = { ready: false, modal: false };
  const { result, page } = await run(t, { regionMode: 'visible', beforeEvaluate: installOnce(state) },
    { events: { 1000: p => p.deliver(0), 1200: p => { state.ready = true; p.region.scrollHeight = p.region.clientHeight; } } });
  noActions(page); const d = result.failureDiagnostics.continuationActivation;
  assert.equal(d.probeCount, 8); assert.equal(d.gateRecheckCount, 1); assert.equal(d.renderRecheckCount, 6);
  assert.equal(d.lastBranch, 'render-wait-exhausted'); assert.ok(result.failureDiagnostics.elapsedMs < 4100);
});

test('optional gate-wait diagnostics preserve legacy absence and strip arbitrary values', () => {
  const legacy = sanitizeBrowserWorksDiagnostics({ version: 1, continuationActivation: { version: 1,
    probeCount: 1, renderRecheckCount: 0, actionCount: 0, lastBranch: 'blocked' } });
  assert.equal(Object.hasOwn(legacy.continuationActivation, 'gateRecheckCount'), false);
  assert.deepEqual(sanitizeBrowserWorksDiagnostics(legacy), legacy);
  const next = sanitizeBrowserWorksDiagnostics({ ...legacy, continuationActivation: { ...legacy.continuationActivation,
    gateRecheckCount: 7, lastBranch: 'gate-wait-exhausted', url: 'PRIVATE_SENTINEL', text: 'PRIVATE_SENTINEL' } });
  assert.equal(next.continuationActivation.gateRecheckCount, 7);
  assert.equal(next.continuationActivation.lastBranch, 'gate-wait-exhausted');
  assert.deepEqual(sanitizeBrowserWorksDiagnostics(next), next); assert.doesNotMatch(JSON.stringify(next), /PRIVATE_SENTINEL/);
  assert.equal(sanitizeBrowserWorksDiagnostics({ ...next, continuationActivation: { ...next.continuationActivation,
    gateRecheckCount: 25 } }).continuationActivation.gateRecheckCount, null);
});

for (const unknownFirst of [false, true]) test(`real modal is terminal even if removed later; unknown first=${unknownFirst}`, async t => {
  const state = { ready: false, modal: true, unknownFirst }; let installed = false;
  const { result, page } = await run(t, { regionMode: 'visible', beforeEvaluate: (p, fn) => {
    if (fn.name === 'observeFirstPageActivation' && p.reads === 1 && !installed) { installed = true; install(p, state); }
  } }, { events: { 1000: p => p.deliver(0), 1200: () => { state.ready = true; state.modal = false; } } });
  assert.equal(page.gets.length, 0); assert.equal(page.wheels, 0); assert.equal(page.moves, 0);
  assert.equal(result.posts.length, 1); assert.equal(result.pagination.stopReason, 'page-timeout');
  assert.equal(result.failureDiagnostics.continuationActivation.structure.gates.decision, 'modal', 'hard gate must not be masked by earlier unknown');
});
