import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';
import { shouldObserveReservedFirstScreen, observeReservedFirstScreenReadiness,
  isReservedFirstScreenReady } from '../lib/browser-readiness-observation.mjs';

const secUid = 'MS4wLjABAAAAphase69SyntheticReadiness';
const facts = overrides => ({ active: true, barrier: false, successful: false, aborted: false,
  navigationFailed: false, currentDocumentVerified: true, attempted: false,
  generation: 2, documentGeneration: 2, documentStatus: 200,
  firstScreenCount: 1, maxFirstScreenObservations: 2, worksRequestCount: 0, pendingReadCount: 0,
  firstScreen: { observation: 'observed', readyState: 'loading', bodyPresent: false },
  startedAt: 1_000, totalDeadline: 46_000, deadline: 29_000, now: 25_000, ...overrides });

function read(overrides = {}) {
  let reads = 0;
  const sandbox = { location: { origin: 'https://www.douyin.com', pathname: `/user/${secUid}` },
    document: { readyState: 'interactive', body: {}, querySelectorAll: () => { reads++; return []; } },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }), ...overrides };
  const output = vm.runInNewContext(`(${observeReservedFirstScreenReadiness.toString()})(${JSON.stringify({ secUid })})`, sandbox);
  return { output: output === null ? null : JSON.parse(JSON.stringify(output)), reads };
}
const gate = { getClientRects: () => [{ width: 1 }] };

test('late current document qualification preserves old loading/body-absent snapshot as historical only', () => {
  assert.equal(shouldObserveReservedFirstScreen(facts()), true);
  assert.equal(isReservedFirstScreenReady(read().output), true);
  for (const now of [24_000, 28_000]) assert.equal(shouldObserveReservedFirstScreen(facts({ now })), true);
});

for (const [name, overrides] of Object.entries({ inactive: { active: false }, barrier: { barrier: true },
  accepted: { successful: true }, aborted: { aborted: true }, error: { navigationFailed: true },
  unverified: { currentDocumentVerified: false }, repeated: { attempted: true }, generation: { generation: 0 },
  stale: { documentGeneration: 1 }, forbidden: { documentStatus: 403 }, unauthorized: { documentStatus: 401 },
  redirect: { documentStatus: 302 }, exhausted: { firstScreenCount: 2 }, unknownCount: { firstScreenCount: null },
  changedMax: { maxFirstScreenObservations: 3 }, boundRequest: { worksRequestCount: 1 }, pending: { pendingReadCount: 1 },
  alreadyReady: { firstScreen: { observation: 'observed', readyState: 'interactive' } },
  missingScreen: { firstScreen: undefined }, timeoutScreen: { firstScreen: { observation: 'timeout', readyState: 'loading' } },
  premature: { now: 23_999 }, tooLate: { now: 28_001 }, deadline: { now: 29_000 },
  shortBudget: { totalDeadline: 20_999, deadline: 20_999, now: 18_000 },
  exactLegacyBudget: { totalDeadline: 21_000, deadline: 21_000, now: 18_000 },
  beyondCeiling: { deadline: 46_001 }, reversedClock: { now: 999 }, invalidClock: { now: Number.NaN },
})) test(`owner predicate refuses ${name}`, () => assert.equal(shouldObserveReservedFirstScreen(facts(overrides)), false));

test('optional hostile getters cannot raise or coerce owner facts', () => {
  const bad = facts(); Object.defineProperty(bad, 'generation', { get() { throw Error('private marker'); } });
  assert.equal(shouldObserveReservedFirstScreen(bad), false);
  assert.equal(shouldObserveReservedFirstScreen(null), false);
  assert.equal(shouldObserveReservedFirstScreen([]), false);
});

test('serialized helper emits only exact fixed structures, never URL/author/storage/text', () => {
  assert.deepEqual(Object.keys(read().output), ['version', 'attribution', 'observation', 'readyState', 'bodyPresent', 'accessState']);
  assert.equal(JSON.stringify(read().output).includes(secUid), false);
  assert.equal(read().reads, 1);
});
for (const state of ['loading', 'unknown', 'unrecognized']) test(`current ${state} does not grant readiness`, () => {
  const out = read({ document: { readyState: state, body: {}, querySelectorAll() { throw Error('must not query'); } } });
  assert.equal(isReservedFirstScreenReady(out.output), false);
});
test('CURRENT body absent never grants readiness or queries controls', () => {
  const out = read({ document: { readyState: 'complete', body: null, querySelectorAll() { throw Error('must not query'); } } });
  assert.equal(out.output.bodyPresent, false); assert.equal(isReservedFirstScreenReady(out.output), false);
});
for (const kind of ['captcha', 'login']) test(`visible ${kind} is a stop, not an action`, () => {
  const out = read({ document: { readyState: 'complete', body: {}, querySelectorAll: selector =>
    selector.includes(kind === 'captcha' ? 'captcha' : 'type="tel"') ? [gate] : [] } });
  assert.equal(out.output.accessState, 'gated'); assert.equal(isReservedFirstScreenReady(out.output), false);
});
test('visible generic dialog or verification wrapper is never excluded from gate vocabulary', () => {
  for (const token of ['dialog', 'aria-modal', 'class*="verify"', 'id*="login"', 'type="password"']) {
    const out = read({ document: { readyState: 'interactive', body: {}, querySelectorAll: selector => selector.includes(token) ? [gate] : [] } });
    assert.equal(out.output.accessState, 'gated'); assert.equal(isReservedFirstScreenReady(out.output), false);
  }
});
test('too many potential gates remain fail-closed even if nominally hidden', () => {
  const out = read({ document: { readyState: 'interactive', body: {}, querySelectorAll: () => Array(101).fill(gate) },
    getComputedStyle: () => ({ visibility: 'hidden', display: 'none' }) });
  assert.equal(out.output.accessState, 'gated'); assert.equal(isReservedFirstScreenReady(out.output), false);
});
test('hidden gate is not a visible access control, unknown style fails closed', () => {
  const out = read({ document: { readyState: 'interactive', body: {}, querySelectorAll: () => [gate] },
    getComputedStyle: () => ({ visibility: 'hidden', display: 'none' }) });
  assert.equal(isReservedFirstScreenReady(out.output), true);
  const failed = read({ getComputedStyle: () => { throw Error('private marker'); },
    document: { readyState: 'interactive', body: {}, querySelectorAll: () => [gate] } });
  assert.equal(failed.output, null);
});
for (const [name, location] of Object.entries({ otherOrigin: { origin: 'https://evil.test', pathname: `/user/${secUid}` },
  otherAuthor: { origin: 'https://www.douyin.com', pathname: '/user/MS4wLjABAAAAotherSyntheticAuthor' },
  login: { origin: 'https://www.douyin.com', pathname: '/login' },
  verification: { origin: 'https://www.douyin.com', pathname: '/verify' } })) test(`serialized ${name} document omitted`, () => {
  assert.equal(read({ location }).output, null);
});
test('projection rejects terminal/stale/timeout or unproven access structures', () => {
  const good = read().output;
  for (const override of [{ observation: 'stale-document' }, { observation: 'timeout' }, { accessState: 'unknown' },
    { attribution: 'terminal-structure-not-works-evidence' }, { version: 2 }, { bodyPresent: 1 }, { readyState: 'loading' }])
    assert.equal(isReservedFirstScreenReady({ ...good, ...override }), false);
  assert.equal(isReservedFirstScreenReady({ readyState: 'interactive', bodyPresent: true }), false);
  const bad = { ...good }; Object.defineProperty(bad, 'accessState', { get() { throw Error('private marker'); } });
  assert.equal(isReservedFirstScreenReady(bad), false);
});
test('source is a no-action/no-network/no-timer/no-private-data observer', () => {
  const source = readFileSync(new URL('../lib/browser-readiness-observation.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|setTimeout|setInterval|addEventListener|localStorage|sessionStorage|textContent|innerHTML)\s*[.(]/);
  assert.doesNotMatch(source, /\.(?:click|wheel|move|goto|reload|evaluate|send|route)\s*\(/);
});

// Exercise ACTUAL production owner integration with inert EventEmitter facts.
// Mock time only: no real browser, networking, credentials, DB or sampling.
const profile = `https://www.douyin.com/user/${secUid}`;
const works = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${secUid}&max_cursor=0`;
const drain = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
class OwnerPage extends EventEmitter {
  constructor() {
    super(); this.address = 'about:blank'; this.frame = { url: () => this.address };
    this.documents = 0; this.screens = []; this.qualifications = []; this.moves = 0; this.wheels = 0;
    this.readyAt = 19_000; this.container = true;
    this.evaluateReads = 0; this.terminalReads = 0;
    this.mouse = { move: async () => { this.moves++; }, wheel: async () => { this.wheels++; this.onWheel?.(); } };
  }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  request(url = works, navigation = false, method = 'GET') {
    const request = { url: () => url, frame: () => this.frame, method: () => method, isNavigationRequest: () => navigation };
    this.emit('request', request); return request;
  }
  commit(status = 200, method = 'GET') {
    this.documents++; this.address = profile;
    const request = this.request(profile, true, method); this.currentDocument = request;
    this.emit('response', { request: () => request, url: request.url, status: () => status });
    this.emit('framenavigated', this.frame);
  }
  history(address) { this.address = address; this.emit('framenavigated', this.frame); }
  respond() {
    const request = this.request(); this.emit('response', { request: () => request, url: request.url, status: () => 200,
      json: async () => ({ status_code: 0, has_more: false, max_cursor: 0,
        aweme_list: [{ aweme_id: '7300000000000069069', author: { sec_uid: secUid }, statistics: { digg_count: 69 } }] }) });
  }
  async goto() { this.commit(this.documentStatus ?? 200, this.documentMethod ?? 'GET'); }
  async evaluate(fn) {
    this.evaluateReads++;
    if (fn.name === 'readTerminalStructure') {
      this.terminalReads++;
      return { readyState: 'interactive', bodyPresent: true, bodyChildCount: 10, scriptCount: 20 };
    }
    if (fn.name === 'observeBrowserFirstScreen') {
      const readyState = Date.now() >= this.readyAt ? 'interactive' : 'loading';
      this.screens.push({ at: Date.now(), document: this.currentDocument, readyState });
      return { observation: 'observed', readyState, bodyPresent: readyState !== 'loading', scriptCount: 20 };
    }
    if (fn.name === 'observeReservedFirstScreenReadiness') {
      this.qualifications.push({ at: Date.now(), document: this.currentDocument });
      if (this.onQualification) return this.onQualification();
      return { version: 1, attribution: 'readiness-qualification-not-works-evidence', observation: 'observed',
        readyState: Date.now() >= this.readyAt ? 'interactive' : 'loading', bodyPresent: true, accessState: this.gated ? 'gated' : 'clear' };
    }
    if (fn.name === 'observeFirstPageActivation') return this.container
      ? { eligible: true, x: 640, y: 500, deltaY: 540 }
      : { eligible: false, reason: 'no-container', structure: { reason: 'region-absent', regionCount: 0,
        visibleRegionCount: 0, leafRegionCount: 0, ancestorCount: null } };
    return { readyState: 'interactive', bodyPresent: true, bodyChildCount: 10, scriptCount: 20 };
  }
}
async function executeOwner(t, page, { timeoutMs = 45_000, signal, events = {} } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let finished = false;
  const pending = collectOne(page, { key: 'phase69-synthetic-owner', secUid, limit: 30 }, { timeoutMs, signal });
  void pending.then(() => { finished = true; }); await drain();
  for (let at = 100; !finished && at <= timeoutMs + 1_000; at += 100) {
    t.mock.timers.tick(100); events[at]?.(); await drain();
  }
  assert.equal(finished, true, 'existing absolute ceiling ends fixture');
  const result = await pending;
  assert.ok(result.failureDiagnostics.elapsedMs <= timeoutMs);
  for (const event of ['request', 'response', 'framenavigated', 'pageerror', 'requestfailed', 'requestfinished', 'domcontentloaded', 'load'])
    assert.equal(page.listenerCount(event), 0, `${event} cleaned`);
  return result;
}
const readyProjection = () => ({ version: 1, attribution: 'readiness-qualification-not-works-evidence', observation: 'observed',
  readyState: 'interactive', bodyPresent: true, accessState: 'clear' });

test('actual owner: missing DOM-ready event gets only reserved second screen; strict author-bound response supplies success', async t => {
  const page = new OwnerPage(); page.onWheel = () => page.respond();
  const result = await executeOwner(t, page);
  assert.equal(page.qualifications.length, 1); assert.equal(page.screens.length, 2);
  assert.equal(page.wheels, 1); assert.equal(result.status, 'ok'); assert.equal(result.posts.length, 1);
  assert.equal(result.failureDiagnostics.lifecycle.lastAcceptedFirstScreenSource, 'readiness-recheck');
  assert.equal(result.failureDiagnostics.requests.matched, 1); assert.equal(result.worksCoverage, 'complete');
});
test('actual owner: ready state without author response remains unavailable, never invented empty account', async t => {
  const page = new OwnerPage(); const result = await executeOwner(t, page);
  assert.equal(page.qualifications.length, 1); assert.equal(page.screens.length, 2); assert.equal(page.wheels, 1);
  assert.deepEqual(result.posts, []); assert.equal(result.worksCoverage, 'unavailable');
  assert.equal(result.failureDiagnostics.elapsedMs, 25_000);
});
test('actual owner: DOM-ready race consumes screen 2 itself, never a third observation', async t => {
  const page = new OwnerPage(); page.onQualification = () => { page.emit('domcontentloaded'); return readyProjection(); };
  const result = await executeOwner(t, page);
  assert.equal(page.screens.length, 2); assert.equal(page.qualifications.length, 1);
  assert.equal(result.failureDiagnostics.lifecycle.lastAcceptedFirstScreenSource, 'domcontentloaded');
  assert.equal(result.failureDiagnostics.lifecycle.firstScreenAttemptCount, 2);
});
test('actual owner: current gate does not spend second screen or act', async t => {
  const page = new OwnerPage(); page.gated = true;
  const result = await executeOwner(t, page);
  assert.equal(page.qualifications.length, 1); assert.equal(page.screens.length, 1);
  assert.equal(page.moves, 0); assert.equal(page.wheels, 0); assert.deepEqual(result.posts, []);
});
test('actual owner: lack of qualified existing works container never acts', async t => {
  const page = new OwnerPage(); page.container = false;
  const result = await executeOwner(t, page);
  assert.equal(page.qualifications.length, 1); assert.equal(page.screens.length, 2);
  assert.equal(page.moves, 0); assert.equal(page.wheels, 0); assert.deepEqual(result.posts, []);
});
test('actual owner: bound request appearing during qualification prevents second screen/actions', async t => {
  const page = new OwnerPage(); page.onQualification = () => { page.request(); return readyProjection(); };
  const result = await executeOwner(t, page);
  assert.equal(page.screens.length, 1); assert.equal(page.wheels, 0);
  assert.equal(result.failureDiagnostics.requests.matched, 1); assert.deepEqual(result.posts, []);
});
test('actual owner: abort during qualification prevents late screen/actions and cleans listeners', async t => {
  const controller = new AbortController(); const page = new OwnerPage();
  page.onQualification = () => { controller.abort(); return readyProjection(); };
  const result = await executeOwner(t, page, { signal: controller.signal });
  assert.equal(page.screens.length, 1); assert.equal(page.wheels, 0); assert.deepEqual(result.posts, []);
});
test('actual owner: different document during qualification cannot accept old readiness', async t => {
  const page = new OwnerPage(); page.onQualification = () => { page.readyAt = 100_000; page.commit(403); return readyProjection(); };
  const result = await executeOwner(t, page);
  assert.equal(page.documents, 2); assert.equal(page.screens.length, 1); assert.equal(page.wheels, 0);
  assert.equal(result.errorCode, 'blocked'); assert.deepEqual(result.posts, []);
});
test('actual owner: stale history qualification is rejected while existing new-generation commit probe remains independent', async t => {
  const page = new OwnerPage(); page.onQualification = () => {
    page.history('https://www.douyin.com/discover'); page.history(profile); return readyProjection();
  };
  const result = await executeOwner(t, page);
  // History itself already owns a commit-source first screen after generation
  // reset. Do not misattribute that old path to this rejected optional read.
  assert.equal(page.screens.length, 2); assert.equal(page.qualifications.length, 1);
  assert.equal(result.failureDiagnostics.lifecycle.lastAcceptedFirstScreenSource, 'commit');
  assert.equal(result.failureDiagnostics.lifecycle.firstScreenAttemptCount, 1);
  assert.deepEqual(result.posts, []); assert.equal(result.worksCoverage, 'unavailable');
});
test('actual owner: new 2xx document rejects old qualification and cannot extend absolute45s ceiling', async t => {
  const page = new OwnerPage();
  page.onQualification = () => {
    if (page.qualifications.length === 1) { page.readyAt = 100_000; page.commit(); return readyProjection(); }
    return { ...readyProjection(), readyState: 'loading' };
  };
  const result = await executeOwner(t, page);
  assert.equal(page.documents, 2); assert.equal(page.screens.length, 2); assert.equal(page.qualifications.length, 2);
  assert.equal(page.wheels, 0); assert.equal(result.failureDiagnostics.lifecycle.lastAcceptedFirstScreenSource, 'commit');
  assert.equal(result.failureDiagnostics.elapsedMs, 45_000); assert.deepEqual(result.posts, []);
});
test('actual owner: delayed or malformed qualification never grants late screen/actions', async t => {
  const page = new OwnerPage(); let release;
  page.onQualification = () => new Promise(resolve => { release = resolve; });
  const result = await executeOwner(t, page, { events: { 22_000: () => release(readyProjection()) } });
  assert.equal(page.screens.length, 1); assert.equal(page.wheels, 0); assert.deepEqual(result.posts, []);
});
test('actual owner: arbitrary adapter readiness object is not fixed-schema evidence', async t => {
  const page = new OwnerPage(); page.onQualification = () => ({ readyState: 'interactive', bodyPresent: true });
  const result = await executeOwner(t, page);
  assert.equal(page.screens.length, 1); assert.equal(page.wheels, 0); assert.deepEqual(result.posts, []);
});
test('actual owner: already-bound request prevents qualification before any extra DOM read', async t => {
  const page = new OwnerPage();
  const result = await executeOwner(t, page, { events: { 19_000: () => page.request() } });
  assert.equal(page.qualifications.length, 0); assert.equal(page.screens.length, 1); assert.equal(page.wheels, 0);
  assert.deepEqual(result.posts, []);
});
test('actual owner: original small caller budget retains its one-screen/no-qualification contract', async t => {
  const page = new OwnerPage(); const result = await executeOwner(t, page, { timeoutMs: 2_500 });
  assert.equal(page.qualifications.length, 0); assert.equal(page.screens.length, 1); assert.equal(page.wheels, 0);
  assert.equal(result.failureDiagnostics.elapsedMs, 2_500);
});
test('actual owner: non-GET document does not obtain new readiness permission', async t => {
  const page = new OwnerPage(); page.documentMethod = 'POST'; const result = await executeOwner(t, page);
  assert.equal(page.qualifications.length, 0); assert.equal(page.screens.length, 1); assert.equal(page.wheels, 0);
  assert.deepEqual(result.posts, []);
});
test('actual owner: qualification never extends original absolute caller ceiling', async t => {
  const page = new OwnerPage(); const result = await executeOwner(t, page, { timeoutMs: 21_000 });
  assert.equal(page.qualifications.length, 1); assert.equal(page.screens.length, 1); assert.equal(page.wheels, 0);
  assert.equal(result.failureDiagnostics.elapsedMs, 21_000); assert.deepEqual(result.posts, []);
});
test('actual owner: exact 20000ms preserves loading first screen plus readonly terminal, never readiness permission', async t => {
  const page = new OwnerPage(); page.readyAt = 100_000;
  const result = await executeOwner(t, page, { timeoutMs: 20_000 });
  assert.equal(page.currentDocument.method(), 'GET');
  assert.equal(page.qualifications.length, 0); assert.equal(page.screens.length, 1);
  assert.equal(page.terminalReads, 1); assert.equal(page.evaluateReads, 2);
  assert.equal(page.moves, 0); assert.equal(page.wheels, 0);
  assert.equal(result.failureDiagnostics.elapsedMs, 20_000);
  assert.deepEqual(result.posts, []);
});
