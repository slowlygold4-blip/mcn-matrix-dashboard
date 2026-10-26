import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { EventEmitter, getEventListeners } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { checksum } from '../lib/utils.mjs';
import { createCdpObservation } from '../lib/browser-cdp-observation.mjs';
import { readTerminalStructure, sanitizeTerminalObservation, createTerminalStructureObservation } from '../lib/douyin-terminal-structure.mjs';

const SEC = 'MS4wLjABAAAAPhase62TerminalStructure';
const PROFILE = `https://www.douyin.com/user/${SEC}`;
const drain = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const structure = { readyState: 'complete', bodyPresent: true, bodyChildCount: 4, scriptCount: 12 };
function setup(t, { evaluate = async () => structure, overrides = {} } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 24_800 });
  const signal = new AbortController().signal;
  const state = { active: true, barrier: null, successful: null, navigationFailed: false,
    navigationCommitted: true, targetNavigationObserved: true, generation: 2,
    documentRequest: {}, documentRequestGeneration: 2, documentStatus: 200,
    worksRequests: 0, pendingReads: 0, startedAt: 0, deadline: 25_000, totalDeadline: 45_000,
    signal, ...overrides };
  let reads = 0;
  const page = { url: () => PROFILE, evaluate: fn => { reads++; assert.equal(fn, readTerminalStructure); return evaluate(); } };
  const observer = createTerminalStructureObservation({ page, secUid: SEC, getState: () => state });
  return { state, page, signal, observer, reads: () => reads };
}

test('phase62: browser projection reads only four structural properties, never private text or JSON', () => {
  for (const readyState of ['loading', 'interactive', 'complete']) {
    let privateReads = 0;
    const body = { childElementCount: 4 }, document = { body, readyState, scripts: { length: 12 } };
    for (const key of ['textContent', 'innerHTML', 'outerHTML']) Object.defineProperty(body, key,
      { get() { privateReads++; throw new Error('PRIVATE'); } });
    for (const key of ['cookie', 'URL', 'querySelector', 'querySelectorAll', 'getElementById']) Object.defineProperty(document, key,
      { get() { privateReads++; throw new Error('PRIVATE'); } });
    const value = runInNewContext(`(${readTerminalStructure.toString()})()`, { document });
    assert.deepEqual(JSON.parse(JSON.stringify(value)), { ...structure, readyState });
    assert.equal(privateReads, 0);
  }
});

test('phase62: concurrent callers share one read and immutable receipt; owner state is untouched', async t => {
  let release; const f = setup(t, { evaluate: () => new Promise(resolve => { release = resolve; }) });
  const before = { ...f.state }, p = f.observer.observe(), q = f.observer.observe();
  assert.equal(p, q); await drain(); assert.equal(f.reads(), 1);
  release(structure); const result = await p;
  assert.equal(result.observation, 'observed'); assert.equal(result.startedElapsedMs, 24_800);
  assert.equal(result.finishedElapsedMs, 24_800); assert.deepEqual(f.state, before);
  assert.throws(() => { result.structure.readyState = 'loading'; }, TypeError);
  assert.equal(getEventListeners(f.signal, 'abort').length, 0);
  f.observer.close(); assert.equal(await f.observer.observe(), result); assert.equal(f.reads(), 1);
});

test('phase62: hung read waits only the remaining original budget and ignores late secret results', async t => {
  let release; const f = setup(t, { evaluate: () => new Promise(resolve => { release = resolve; }) });
  let settled = false; const p = f.observer.observe().then(value => { settled = true; return value; });
  await drain(); t.mock.timers.tick(199); await drain(); assert.equal(settled, false);
  t.mock.timers.tick(1); await drain(); const result = await p;
  assert.equal(result.observation, 'timeout'); assert.equal(result.finishedElapsedMs, 25_000);
  assert.equal(getEventListeners(f.signal, 'abort').length, 0);
  const previous = JSON.stringify(result); release({ ...structure, cookie: 'PRIVATE' }); await drain();
  assert.equal(JSON.stringify(f.observer.snapshot()), previous);
});

test('phase62: smaller total deadline beats response deadline and early calls do not consume opportunity', async t => {
  const f = setup(t, { evaluate: () => new Promise(() => {}), overrides: { deadline: 30_000, totalDeadline: 25_100 } });
  assert.equal(await f.observer.observe(), null); assert.equal(f.observer.attempted(), false);
  t.mock.timers.tick(100); const p = f.observer.observe(); await drain();
  t.mock.timers.tick(200); const result = await p;
  assert.equal(result.observation, 'timeout'); assert.equal(result.finishedElapsedMs, 25_100);
  assert.equal(f.state.deadline, 30_000); assert.equal(f.state.totalDeadline, 25_100);
});

test('phase62: minimum elapsed eligibility preserves short attempts without consuming the later opportunity', async t => {
  const f = setup(t, { overrides: { startedAt: 23_801 } });
  assert.equal(await f.observer.observe(), null); assert.equal(f.reads(), 0); assert.equal(f.observer.attempted(), false);
  t.mock.timers.tick(1);
  assert.equal((await f.observer.observe()).observation, 'observed'); assert.equal(f.reads(), 1);
  assert.equal(f.state.deadline, 25_000); assert.equal(f.state.totalDeadline, 45_000);
});

for (const budget of [2_700, 10_000, 19_999, 20_000]) test(`phase62: original ${budget}ms budget eligibility boundary is independent of the late window`, async t => {
  const f = setup(t, { overrides: { startedAt: 25_000 - budget, deadline: 25_000, totalDeadline: 25_000 } });
  const result = await f.observer.observe();
  assert.equal(f.reads(), budget < 20_000 ? 0 : 1);
  assert.equal(result?.observation ?? null, budget < 20_000 ? null : 'observed');
  assert.equal(f.state.deadline, 25_000); assert.equal(f.state.totalDeadline, 25_000);
});

test('phase62: close settles pending observer, clears listener and never reads again', async t => {
  const f = setup(t, { evaluate: () => new Promise(() => {}) }); const p = f.observer.observe();
  await drain(); assert.equal(getEventListeners(f.signal, 'abort').length, 1);
  f.observer.close(); f.observer.close(); assert.equal((await p).observation, 'cancelled');
  assert.equal(getEventListeners(f.signal, 'abort').length, 0);
  t.mock.timers.tick(400); await drain(); await f.observer.observe(); assert.equal(f.reads(), 1);
});

for (const [label, overrides] of [
  ['document 401', { documentStatus: 401 }], ['document 403', { documentStatus: 403 }],
  ['document 429', { documentStatus: 429 }], ['document 500', { documentStatus: 500 }],
  ['no verified status', { documentStatus: null }], ['not committed', { navigationCommitted: false }],
  ['failed navigation', { navigationFailed: true }], ['unknown navigation state', { navigationFailed: null }],
  ['prior document Request', { documentRequestGeneration: 1 }], ['missing Request', { documentRequest: null }],
  ['already bound works', { worksRequests: 1 }], ['pending body', { pendingReads: 1 }],
  ['stop barrier', { barrier: {} }], ['accepted works', { successful: {} }], ['inactive', { active: false }],
  ['expired', { deadline: 24_800 }], ['malformed clock bound', { totalDeadline: NaN }],
]) test(`phase62: ${label} performs zero additional reads`, async t => {
  const f = setup(t, { overrides }); assert.equal(await f.observer.observe(), null); assert.equal(f.reads(), 0);
});

for (const address of ['https://www.douyin.com/passport/login', 'https://www.douyin.com/verify/',
  'https://www.douyin.com/user/MS4wLjABAAAADifferentAccount0000', 'https://www.douyin.com.evil.invalid/user/x']) {
  test(`phase62: non-target origin/path refuses structure read: ${new URL(address).pathname}`, async t => {
    const f = setup(t); f.page.url = () => address;
    assert.equal(await f.observer.observe(), null); assert.equal(f.reads(), 0);
  });
}

for (const [label, mutate, outcome] of [
  ['new Request', s => { s.documentRequest = {}; }, 'stale-document'],
  ['new generation', s => { s.generation++; s.documentRequestGeneration++; }, 'stale-document'],
  ['works arrival', s => { s.worksRequests = 1; }, 'superseded'],
  ['accepted result', s => { s.successful = {}; }, 'superseded'],
  ['shortened budget', s => { s.deadline = 24_800; }, 'timeout'],
  ['malformed budget', s => { s.deadline = undefined; }, 'superseded'],
]) test(`phase62: ${label} while awaiting invalidates the structural result`, async t => {
  let release; const f = setup(t, { evaluate: () => new Promise(resolve => { release = resolve; }) });
  const p = f.observer.observe(); await drain(); mutate(f.state); release(structure);
  const result = await p; assert.equal(result.observation, outcome); assert.equal(Object.hasOwn(result, 'structure'), false);
});

test('phase62: a replacement after a completed read cannot be projected as final document structure', async t => {
  const f = setup(t); const first = await f.observer.observe(); assert.equal(first.observation, 'observed');
  f.state.documentRequest = {}; f.state.generation++;
  assert.equal(f.observer.snapshot().observation, 'stale-document');
  assert.equal(Object.hasOwn(f.observer.snapshot(), 'structure'), false); assert.equal(first.observation, 'observed');
});

test('phase62: abort and adapter exceptions are contained and reveal no raw message', async t => {
  const controller = new AbortController();
  const f = setup(t, { evaluate: () => new Promise(() => {}), overrides: { signal: controller.signal } });
  const p = f.observer.observe(); await drain(); controller.abort('PRIVATE');
  assert.equal((await p).observation, 'cancelled'); assert.doesNotMatch(JSON.stringify(f.observer.snapshot()), /PRIVATE/);
  const bad = createTerminalStructureObservation({ page: f.page, secUid: SEC, getState() { throw new Error('PRIVATE'); } });
  assert.equal(await bad.observe(), null); bad.close();
  const badPage = { url: () => PROFILE, get evaluate() { throw new Error('PRIVATE'); } };
  const noRead = createTerminalStructureObservation({ page: badPage, secUid: SEC, getState: () => ({ ...f.state, signal: undefined }) });
  assert.equal(await noRead.observe(), null); noRead.close();
});

test('phase62: stop before the evaluation microtask prevents any additional browser command', async t => {
  const f = setup(t); const p = f.observer.observe(); f.state.barrier = {};
  assert.equal((await p).observation, 'superseded'); assert.equal(f.reads(), 0);
  assert.equal(getEventListeners(f.signal, 'abort').length, 0);
});

test('phase62: a clock rollback cannot produce observed structure with backwards time', async t => {
  const f = setup(t); let release, at = 24_800;
  const observer = createTerminalStructureObservation({ page: { url: () => PROFILE, evaluate: () => new Promise(resolve => { release = resolve; }) },
    secUid: SEC, getState: () => f.state, now: () => at });
  const p = observer.observe(); await drain(); at = 24_700; release(structure);
  const result = await p; assert.equal(result.observation, 'unavailable'); assert.equal(result.finishedElapsedMs, null);
  assert.equal(Object.hasOwn(result, 'structure'), false);
});

test('phase62: strict projection is bounded, idempotent, and does not create historical defaults', () => {
  assert.equal(sanitizeTerminalObservation(undefined), null);
  assert.equal(sanitizeTerminalObservation({ version: 2 }), null);
  const clean = sanitizeTerminalObservation({ version: 1, attribution: 'terminal-structure-not-works-evidence', observation: 'observed',
    generation: 2, startedElapsedMs: 24_800, finishedElapsedMs: 24_801, cookie: 'PRIVATE',
    structure: { ...structure, bodyChildCount: -1, scriptCount: '12', innerHTML: 'PRIVATE' } });
  assert.equal(clean.structure.bodyChildCount, null); assert.equal(clean.structure.scriptCount, null);
  assert.doesNotMatch(JSON.stringify(clean), /PRIVATE/); assert.ok(Buffer.byteLength(JSON.stringify(clean)) < 350);
  assert.deepEqual(sanitizeTerminalObservation(JSON.parse(JSON.stringify(clean))), clean);
  for (const observation of ['timeout', 'unavailable', 'stale-document', 'superseded', 'cancelled']) {
    assert.equal(Object.hasOwn(sanitizeTerminalObservation({ ...clean, observation }), 'structure'), false);
  }
});

test('phase62: event-time CDP scope remains ambiguous even when terminal structure is separately known', () => {
  function trace(failingGeneration) {
    const observer = createCdpObservation({ mainFrameId: 'main', secUid: SEC });
    for (const generation of [1, 2]) {
      const requestId = `doc-${generation}`, loaderId = `loader-${generation}`;
      observer.request({ requestId, loaderId, frameId: 'main', type: 'Document', request: { method: 'GET', url: PROFILE } });
      observer.response({ requestId, loaderId, frameId: 'main', type: 'Document', response: { status: 200, url: PROFILE } });
      observer.commit({ frame: { id: 'main', loaderId, url: PROFILE } }); observer.finished({ requestId });
      if (generation === failingGeneration) for (let i = 0; i < 13; i++) {
        const requestId = `fetch-${i}`;
        observer.request({ requestId, loaderId, frameId: 'main', type: 'Fetch', request: { method: 'GET', url: 'https://static.example.test/passive' } });
        observer.failed({ requestId, blockedReason: 'other', canceled: false });
      }
    }
    const result = observer.snapshot('attempt-return'); observer.close(); return result;
  }
  const oldDocumentFailures = trace(1), finalDocumentFailures = trace(2);
  assert.deepEqual(oldDocumentFailures, finalDocumentFailures);
  assert.equal(oldDocumentFailures.failuresByPhase.beforeStop.scopes['current-document'], 13);
  assert.equal(oldDocumentFailures.failuresByPhase.beforeStop.scopes['prior-document'], 0);
  const terminal = sanitizeTerminalObservation({ version: 1, attribution: 'terminal-structure-not-works-evidence',
    observation: 'observed', generation: 2, startedElapsedMs: 24_800, finishedElapsedMs: 24_801, structure });
  const first = { cdpObservation: oldDocumentFailures, terminalStructure: terminal };
  const second = { cdpObservation: finalDocumentFailures, terminalStructure: terminal };
  assert.deepEqual(first, second, 'terminal readiness cannot retroactively identify the document which had prior failures');
});

// In-memory root-owned integration: exercise exact current Main functions
// without writing scripts, provider, sanitizer, ledger, runtime or production DB.
const collectorUrl = new URL('../scripts/douyin_browser_collector.mjs', import.meta.url);
const diagnosticsUrl = new URL('../lib/douyin-browser-diagnostics.mjs', import.meta.url);
const failureUrl = new URL('../lib/works-only-failure.mjs', import.meta.url);
const evidenceUrl = new URL('../lib/works-only-observation.mjs', import.meta.url);
const providerUrl = new URL('../lib/providers/public-web.mjs', import.meta.url);
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, `current Main integration anchor drifted: ${before.slice(0, 65)}`);
  return source.replace(before, after);
}
function memoryModule(source, url, overrides = new Map()) {
  const resolved = source.replace(/^#![^\n]*\n/, '').replaceAll('import.meta.url', JSON.stringify(url.href))
    .replace(/\bfrom\s+(["'])([^"']+)\1/g, (_, quote, specifier) => {
      const absolute = specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier);
      return `from ${JSON.stringify(overrides.get(absolute) ?? absolute)}`;
    });
  return `data:text/javascript;base64,${Buffer.from(`${resolved}\n//# sourceURL=${url.href}?phase62-memory`).toString('base64')}`;
}
let diagnosticsSource = readFileSync(diagnosticsUrl, 'utf8');
if (!diagnosticsSource.includes('sanitizeTerminalObservation')) {
  diagnosticsSource = `import { sanitizeTerminalObservation } from './douyin-terminal-structure.mjs';\n${diagnosticsSource}`;
  diagnosticsSource = replaceOnce(diagnosticsSource, '  const cdpObservation = sanitizeCdpObservation(value.cdpObservation);',
    '  const cdpObservation = sanitizeCdpObservation(value.cdpObservation);\n  const terminalStructure = sanitizeTerminalObservation(value.terminalStructure);');
  diagnosticsSource = replaceOnce(diagnosticsSource, '    ...(cdpObservation ? { cdpObservation } : {}),',
    '    ...(cdpObservation ? { cdpObservation } : {}),\n    ...(terminalStructure ? { terminalStructure } : {}),');
}
const diagnosticsModule = memoryModule(diagnosticsSource, diagnosticsUrl);
const failureModule = memoryModule(readFileSync(failureUrl, 'utf8'), failureUrl, new Map([[diagnosticsUrl.href, diagnosticsModule]]));
const evidenceModule = memoryModule(readFileSync(evidenceUrl, 'utf8'), evidenceUrl, new Map([[failureUrl.href, failureModule]]));
const providerModule = memoryModule(readFileSync(providerUrl, 'utf8'), providerUrl,
  new Map([[diagnosticsUrl.href, diagnosticsModule], [failureUrl.href, failureModule]]));
const { sanitizeBrowserWorksDiagnostics: integratedSanitize } = await import(diagnosticsModule);
const { validateWorksOnlyEvidence: integratedValidate } = await import(evidenceModule);
const { PublicWebProvider: IntegratedProvider } = await import(providerModule);
let collectorSource = readFileSync(collectorUrl, 'utf8');
if (!collectorSource.includes('createTerminalStructureObservation')) {
  collectorSource = `import { createTerminalStructureObservation } from '../lib/douyin-terminal-structure.mjs';\n${collectorSource.replace(/^#![^\n]*\n/, '')}`;
  collectorSource = replaceOnce(collectorSource, '  resetDiagnostics();\n  const diagnostics = (stopReason) => {',
    `  resetDiagnostics();
  const terminalStructure = createTerminalStructureObservation({ page, secUid: item.secUid, getState: () => ({
    active, barrier, successful, navigationFailed, navigationCommitted, targetNavigationObserved,
    generation, documentRequest, documentRequestGeneration, documentStatus,
    worksRequests: requests.size, pendingReads: pending.size, startedAt, deadline, totalDeadline, signal: bodyController.signal,
  }) });
  const diagnostics = (stopReason) => {`);
  collectorSource = replaceOnce(collectorSource, '    firstScreen, firstPageActivation, httpStatuses, businessStatusCodes,',
    '    firstScreen, terminalStructure: terminalStructure.snapshot(), firstPageActivation, httpStatuses, businessStatusCodes,');
  collectorSource = replaceOnce(collectorSource, '      await sleep(Math.min(20, Math.max(1, deadline - Date.now())));',
    '      if (deadline - Date.now() <= 250) void terminalStructure.observe();\n      await sleep(Math.min(20, Math.max(1, deadline - Date.now())));');
  collectorSource = replaceOnce(collectorSource, '    resourceMonitor.markStop();\n    active = false;',
    '    resourceMonitor.markStop();\n    terminalStructure.close();\n    active = false;');
}
const collectorOverrides = new Map([[diagnosticsUrl.href, diagnosticsModule]]);
const { collectOne: integratedCollect } = await import(memoryModule(collectorSource, collectorUrl, collectorOverrides));
// Keep this historical falsifier's original short request/body coupling.
// Phase83 promotes strictly bound2xx bodies to the absolute deadline, so the
// old counterexample is no longer a claim about the current production owner.
const legacyRequestWindowSource = collectorSource.includes('// Strictly bound 2xx headers')
  ? replaceOnce(collectorSource, '    deadline = totalDeadline;\n    // Event emitters do not await async listeners.', '    // Event emitters do not await async listeners.')
  : collectorSource;
const awaitedSource = replaceOnce(legacyRequestWindowSource, 'void terminalStructure.observe()', 'await terminalStructure.observe()');
const { collectOne: incorrectlyAwaitedCollect } = await import(memoryModule(awaitedSource, collectorUrl, collectorOverrides));

class PageFixture extends EventEmitter {
  constructor({ hang = false, documentStatus = 200 } = {}) {
    super(); this.address = 'about:blank'; this.frame = { url: () => this.address };
    this.terminalReads = 0; this.evaluateReads = 0; this.bodyReads = 0; this.navigations = 0; this.moves = 0; this.wheels = 0;
    this.hang = hang; this.documentStatus = documentStatus;
    this.mouse = { move: async () => { this.moves++; }, wheel: async () => { this.wheels++; } };
  }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  request(url, navigation = false) {
    return { url: () => url, frame: () => this.frame, method: () => 'GET', isNavigationRequest: () => navigation,
      resourceType: () => navigation ? 'document' : 'xhr', redirectedFrom: () => null };
  }
  async goto() {
    this.navigations++; const request = this.request(PROFILE, true);
    this.emit('request', request); this.emit('response', { request: () => request, url: request.url, status: () => this.documentStatus });
    this.address = PROFILE; this.emit('framenavigated', this.frame); this.emit('requestfinished', request);
  }
  evaluate(fn) {
    this.evaluateReads++;
    if (fn === readTerminalStructure) { this.terminalReads++; return this.hang ? new Promise(() => {}) : Promise.resolve(structure); }
    return Promise.resolve({ observation: 'observed', readyState: 'loading', bodyPresent: false, bodyChildCount: 0, scriptCount: 10 });
  }
  respond({ cursor = 0, more = false, status = 200, code = 0 } = {}) {
    const request = this.request(`https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=${cursor}`);
    this.emit('request', request);
    this.emit('response', { request: () => request, url: request.url, status: () => status, json: async () => {
      this.bodyReads++; return { status_code: code, has_more: more, max_cursor: more ? 10 : 0,
        aweme_list: [{ aweme_id: String(7300000000000062000n + BigInt(cursor)), author: { sec_uid: SEC, uid: '12345678' }, statistics: { digg_count: 9 } }] };
    } });
    this.emit('requestfinished', request);
  }
}
async function runCollector(t, { collect = integratedCollect, hang = false, documentStatus = 200, events = {}, timeoutMs = 45_000 } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const page = new PageFixture({ hang, documentStatus }); let done = false;
  const pending = collect(page, { key: 'phase62-offline', secUid: SEC, limit: 30 }, { timeoutMs });
  void pending.then(() => { done = true; }); await drain();
  for (let at = 0; !done && at <= timeoutMs;) {
    const step = Math.min(20, Math.max(1, timeoutMs - at)); at += step;
    t.mock.timers.tick(step); events[at]?.(page); await drain();
  }
  assert.equal(done, true); const result = await pending;
  assert.ok(result.failureDiagnostics.elapsedMs <= timeoutMs);
  for (const event of ['request', 'response', 'framenavigated', 'requestfailed', 'requestfinished', 'load', 'domcontentloaded']) assert.equal(page.listenerCount(event), 0);
  return { page, result };
}

test('phase62: exact proposed Main integration adds late structure, never readiness or an action', async t => {
  const { page, result } = await runCollector(t);
  assert.equal(result.status, 'unavailable'); assert.equal(result.errorCode, 'collector_error'); assert.deepEqual(result.posts, []);
  assert.equal(result.failureDiagnostics.firstScreen.readyState, 'loading');
  assert.equal(result.failureDiagnostics.terminalStructure.structure.readyState, 'complete');
  assert.equal(result.failureDiagnostics.stopReason, 'no-bound-request');
  assert.equal(result.failureDiagnostics.elapsedMs, 25_000); assert.equal(page.terminalReads, 1);
  assert.equal(page.navigations, 1); assert.equal(page.moves, 0); assert.equal(page.wheels, 0); assert.equal(page.bodyReads, 0);
});

test('phase62: hanging diagnostic does not consume a real late first page continuation opportunity', async t => {
  const { page, result } = await runCollector(t, { hang: true,
    events: { 24_800: p => p.respond({ more: true }), 25_100: p => p.respond({ cursor: 10 }) } });
  assert.equal(page.terminalReads, 1); assert.equal(result.status, 'ok');
  assert.equal(result.posts.length, 2); assert.equal(result.worksCoverage, 'complete');
  assert.equal(page.bodyReads, 2); assert.ok(result.failureDiagnostics.elapsedMs >= 25_100);
  assert.equal(Object.hasOwn(result.failureDiagnostics.terminalStructure, 'structure'), false);
});

test('phase62 historical short-window falsifier: awaiting the diagnostic truncates the late works continuation', async t => {
  const { result, page } = await runCollector(t, { collect: incorrectlyAwaitedCollect, hang: true,
    events: { 24_800: p => p.respond({ more: true }), 25_100: p => p.respond({ cursor: 10 }) } });
  assert.equal(result.status, 'ok'); assert.equal(result.posts.length, 1);
  assert.notEqual(result.worksCoverage, 'complete'); assert.equal(page.bodyReads, 1);
  assert.equal(result.failureDiagnostics.elapsedMs, 25_020, 'the incorrect await even pushes the next loop tick past the response deadline');
});

for (const [label, response, expected] of [
  ['works HTTP403', { status: 403 }, 'blocked'], ['works HTTP429', { status: 429 }, 'rate_limited'],
  ['bound login code2483', { code: 2483 }, 'login_required'],
]) test(`phase62: pending diagnostic cannot reclassify ${label}`, async t => {
  const { page, result } = await runCollector(t, { hang: true, events: { 24_800: p => p.respond(response) } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.errorCode, expected); assert.deepEqual(result.posts, []);
  assert.equal(page.terminalReads, 1); assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
  assert.equal(Object.hasOwn(result.failureDiagnostics.terminalStructure, 'structure'), false);
});

test('phase62: document403 hard-stops before terminal evaluation', async t => {
  const { page, result } = await runCollector(t, { documentStatus: 403 });
  assert.equal(result.errorCode, 'blocked'); assert.equal(page.terminalReads, 0); assert.equal(page.bodyReads, 0);
  assert.equal(Object.hasOwn(result.failureDiagnostics, 'terminalStructure'), false);
});

test('phase62: integrated diagnostic cannot extend a smaller caller absolute deadline', async t => {
  const { page, result } = await runCollector(t, { timeoutMs: 24_000, hang: true });
  assert.equal(result.failureDiagnostics.elapsedMs, 24_000); assert.equal(page.terminalReads, 1);
  assert.equal(result.failureDiagnostics.terminalStructure.observation, 'timeout');
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.posts, []);
});

for (const timeoutMs of [40, 100, 1_000, 2_700, 10_000, 19_999]) test(`phase62: actual short caller ${timeoutMs}ms keeps its original single structural evaluation`, async t => {
  const { page, result } = await runCollector(t, { timeoutMs });
  assert.equal(result.failureDiagnostics.elapsedMs, timeoutMs); assert.equal(page.evaluateReads, 1);
  assert.equal(page.terminalReads, 0); assert.equal(Object.hasOwn(result.failureDiagnostics, 'terminalStructure'), false);
  assert.equal(result.status, 'unavailable'); assert.equal(page.navigations, 1); assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
});

test('phase62: actual20000ms original budget permits one late diagnostic without a later deadline', async t => {
  const { page, result } = await runCollector(t, { timeoutMs: 20_000 });
  assert.equal(result.failureDiagnostics.elapsedMs, 20_000); assert.equal(page.terminalReads, 1); assert.equal(page.evaluateReads, 2);
  assert.equal(result.failureDiagnostics.terminalStructure.structure.readyState, 'complete');
  assert.equal(result.status, 'unavailable'); assert.equal(page.wheels, 0); assert.deepEqual(result.posts, []);
});

test('phase62: child JSON, actual provider and failure projection preserve only fixed terminal metadata', async () => {
  const at = '2026-10-01T08:55:00.000Z';
  const terminalStructure = sanitizeTerminalObservation({ version: 1, attribution: 'terminal-structure-not-works-evidence',
    observation: 'observed', generation: 2, startedElapsedMs: 24_800, finishedElapsedMs: 24_801, structure });
  const diagnostics = { version: 1, stopReason: 'no-bound-request', terminalStructure: { ...terminalStructure, secret: 'PRIVATE' } };
  const provider = new IntegratedProvider({}, { accountBrowserFallback: true, now: () => Date.parse(at),
    worksRequestPolicyOptions: { now: () => Date.parse(at) }, fetchImpl: () => { throw new Error('NO_NETWORK'); },
    execFileImpl: (_f, _a, _o, done) => done(null, JSON.stringify({ ok: true, data: { items: [{ key: '42',
      status: 'unavailable', posts: [], errorCode: 'collector_error', failureDiagnostics: diagnostics }] } }), '') });
  const value = await provider.collectWorksOnly({ id: 42, type: 'account', enabled: true, provider: 'public-web', locator: SEC, metadata: {} },
    { snapshotId: 4, sourceChecksum: 'a'.repeat(64), capturedAt: at, secUid: SEC, uid: '12345678' });
  assert.equal(value.result.status, 'unavailable'); assert.equal(value.result.errorCode, 'collector_error');
  assert.deepEqual(value.result.failureDiagnostics.terminalStructure, terminalStructure);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE/);
  assert.deepEqual(integratedSanitize(JSON.parse(JSON.stringify(integratedSanitize(diagnostics)))), integratedSanitize(diagnostics));
});

test('phase62: real existing2211/2215/2216 hashes stay identical; synthetic appended diagnostic is not success', t => {
  const path = new URL('../data/douyin-monitor.sqlite', import.meta.url);
  if (!existsSync(path)) return t.skip('production archive absent; no fixture history is fabricated');
  const db = new DatabaseSync(path.pathname, { readOnly: true }); db.exec('PRAGMA query_only=ON;BEGIN');
  try {
    const rows = db.prepare('SELECT run_id,raw_json,source_checksum FROM works_observations WHERE run_id IN (2211,2215,2216) ORDER BY run_id').all();
    assert.equal(rows.length, 3);
    const expected = { 2211: 'e2884db8fb040dac80aa83fd4cdb88db90537a04e20d05d211d71cdc401862b5',
      2215: '999cf27c52037417c6a1b10b88de551fc484f36218a9607469c20189acc4fc04',
      2216: '87ce641d1e8240dce3e8f0eaa89d4adb6a376089115241a8896ddc29805cfef6' };
    for (const row of rows) {
      const evidence = JSON.parse(row.raw_json), canonical = integratedValidate(evidence);
      assert.equal(checksum(canonical), row.source_checksum); assert.equal(row.source_checksum, expected[row.run_id]);
      assert.equal(Object.hasOwn(canonical.failureDiagnostics, 'terminalStructure'), false);
      assert.equal(evidence.status, 'unavailable'); assert.equal(evidence.observedAt, null); assert.deepEqual(evidence.posts, []);
      assert.deepEqual(evidence.failureDiagnostics.httpStatuses, row.run_id === 2211 ? [403] : []);
      assert.equal(evidence.failureDiagnostics.requests.matched, row.run_id === 2211 ? 1 : 0);
      const simulated = structuredClone(evidence);
      simulated.failureDiagnostics = integratedSanitize({ ...simulated.failureDiagnostics, terminalStructure: sanitizeTerminalObservation({ version: 1,
        attribution: 'terminal-structure-not-works-evidence', observation: 'observed', generation: 2,
        startedElapsedMs: evidence.failureDiagnostics.elapsedMs - 200,
        finishedElapsedMs: evidence.failureDiagnostics.elapsedMs - 100, structure }) });
      const projected = integratedValidate(simulated);
      assert.equal(projected.errorCode, evidence.errorCode); assert.equal(projected.status, 'unavailable');
      assert.deepEqual(projected.posts, []); assert.equal(projected.observedAt, null);
      simulated.status = 'accepted'; assert.throws(() => integratedValidate(simulated), { code: 'WORKS_OBSERVATION_INVALID' });
    }
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, 0);
  } finally { db.exec('ROLLBACK'); db.close(); }
});
