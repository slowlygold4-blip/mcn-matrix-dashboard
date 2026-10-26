// Independent, synthetic projection audit. No DB, browser, network, service,
// environment-file, or real process execution is used by this suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitizeTerminalObservation } from '../lib/douyin-terminal-structure.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';
import { projectWorksOnlyFailure } from '../lib/works-only-failure.mjs';
import { validateWorksOnlyEvidence } from '../lib/works-only-observation.mjs';
import { classifyBrowserWorksFailure } from '../lib/douyin-browser-failure.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';

const ATTRIBUTION = 'terminal-structure-not-works-evidence';
const OBSERVATIONS = ['observed', 'timeout', 'unavailable', 'stale-document', 'superseded', 'cancelled'];
const BASE_KEYS = ['version', 'attribution', 'observation', 'generation', 'startedElapsedMs', 'finishedElapsedMs'];
const STRUCTURE_KEYS = ['readyState', 'bodyPresent', 'bodyChildCount', 'scriptCount'];
const SECRET = 'PHASE67_SYNTHETIC_PRIVATE_MARKER';
const SEC = 'MS4wLjABAAAAPhase67SyntheticAccountOnly';
const AT = '2026-10-01T14:57:36.000Z';
const NOW = Date.parse(AT);
const fixture = (overrides = {}) => ({
  version: 1, attribution: ATTRIBUTION, observation: 'observed', generation: 2,
  startedElapsedMs: 24750, finishedElapsedMs: 24765,
  structure: { readyState: 'complete', bodyPresent: true, bodyChildCount: 150, scriptCount: 189 },
  ...overrides,
});
const diagnostic = terminal => ({
  version: 1, navigation: { observed: true, committed: true, failed: false, timedOut: false },
  requests: { candidate: 0, matched: 0 }, responses: { matched: 0 },
  finalPageKind: 'profile', elapsedMs: 25000, stopReason: 'no-bound-request',
  ...(terminal === undefined ? {} : { terminalStructure: terminal }),
});
const own = (value, key) => Object.hasOwn(value, key);

test('phase67 peer: terminal envelope and nested structure retain only enumerated primitives', () => {
  let privateReads = 0;
  const input = fixture();
  for (const target of [input, input.structure]) {
    for (const key of ['cookie', 'headers', 'url', 'textContent', 'raw_json', 'toJSON', '__proto__']) {
      Object.defineProperty(target, key, { enumerable: true, get() { privateReads++; throw Error(SECRET); } });
    }
  }
  const result = sanitizeTerminalObservation(input);
  assert.deepEqual(Object.keys(result), [...BASE_KEYS, 'structure']);
  assert.deepEqual(Object.keys(result.structure), STRUCTURE_KEYS);
  assert.deepEqual(result, fixture());
  assert.equal(privateReads, 0);
  assert.doesNotMatch(JSON.stringify(result), /PHASE67_SYNTHETIC_PRIVATE_MARKER/);
});

for (const [field, maximum, nested] of [
  ['generation', 1000000, false], ['startedElapsedMs', 900000, false],
  ['finishedElapsedMs', 900000, false], ['bodyChildCount', 1000000, true], ['scriptCount', 1000000, true],
]) {
  test(`phase67 peer: ${field} has inclusive finite integer bounds without coercion`, () => {
    const cases = [undefined, null, false, true, '', '1', -1, -0.5, 0, 1, maximum - 1,
      maximum, maximum + 1, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity, {}, [], [1], 1n];
    for (const candidate of cases) {
      const input = fixture();
      (nested ? input.structure : input)[field] = candidate;
      const result = sanitizeTerminalObservation(input);
      const expected = Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= maximum ? candidate : null;
      assert.equal((nested ? result.structure : result)[field], expected);
    }
  });
}

test('phase67 peer: invalid outer containers, versions, attribution and observations produce no terminal field', () => {
  for (const candidate of [undefined, null, false, 1, '', [], {}, fixture({ version: '1' }),
    fixture({ version: 2 }), fixture({ attribution: SECRET }), fixture({ observation: SECRET })]) {
    assert.equal(sanitizeTerminalObservation(candidate), null);
    assert.equal(own(sanitizeBrowserWorksDiagnostics(diagnostic(candidate)), 'terminalStructure'), false);
  }
});

test('phase67 peer: observed structure validates enums and booleans, never coerces payload strings', () => {
  for (const state of ['loading', 'interactive', 'complete', 'unknown', SECRET, 1, null]) {
    for (const present of [true, false, 'true', 1, null, {}, []]) {
      const output = sanitizeTerminalObservation(fixture({ structure: { readyState: state, bodyPresent: present } }));
      assert.equal(output.structure.readyState, ['loading', 'interactive', 'complete'].includes(state) ? state : 'unknown');
      assert.equal(output.structure.bodyPresent, typeof present === 'boolean' ? present : null);
      assert.equal(output.structure.bodyChildCount, null);
      assert.equal(output.structure.scriptCount, null);
    }
  }
});

for (const observation of OBSERVATIONS.slice(1)) {
  test(`phase67 peer: ${observation} omits structure without reading it`, () => {
    const input = fixture({ observation });
    Object.defineProperty(input, 'structure', { get() { throw Error(SECRET); } });
    const output = sanitizeTerminalObservation(input);
    assert.deepEqual(Object.keys(output), BASE_KEYS);
    assert.equal(own(output, 'structure'), false);
  });
}

test('phase67 peer: detached copies and JSON round trips remain bounded and idempotent', () => {
  for (const observation of OBSERVATIONS) {
    const input = fixture({ observation, generation: 1000000, startedElapsedMs: 900000, finishedElapsedMs: 900000,
      structure: { readyState: 'interactive', bodyPresent: false, bodyChildCount: 1000000, scriptCount: 1000000 },
      raw: SECRET.repeat(2000), children: [{ headers: SECRET }] });
    const output = sanitizeTerminalObservation(input);
    const before = JSON.stringify(output);
    input.generation = 0; input.structure.readyState = 'loading';
    assert.equal(JSON.stringify(output), before);
    assert.ok(Buffer.byteLength(before) <= 300);
    assert.deepEqual(sanitizeTerminalObservation(JSON.parse(before)), output);
    const projected = projectWorksOnlyFailure({ failureStage: 'browser-page', failureDiagnostics: diagnostic(output), stderr: SECRET });
    assert.deepEqual(projectWorksOnlyFailure(JSON.parse(JSON.stringify(projected))), projected);
    assert.doesNotMatch(JSON.stringify(projected), /PHASE67_SYNTHETIC_PRIVATE_MARKER/);
  }
});

// Reconstruct only the pre-terminal projection delta in memory. This is a
// falsifier for the old-module mechanism, NOT a capture of a live PID's heap.
function replaceOnce(source, expected, replacement) {
  assert.equal(source.split(expected).length, 2, `source anchor must occur exactly once: ${expected}`);
  return source.replace(expected, replacement);
}
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
function absoluteImports(source, file, substitutions = new Map()) {
  return source.replace(/from (["'])(\.\.?\/[^"'\n]+)\1/g,
    (_all, _quote, relative) => `from ${JSON.stringify(substitutions.get(relative) ?? new URL(relative, file).href)}`);
}
const sanitizerFile = new URL('../lib/douyin-browser-diagnostics.mjs', import.meta.url);
let oldShapeSource = readFileSync(sanitizerFile, 'utf8');
for (const delta of [
  'import { sanitizeTerminalObservation } from "./douyin-terminal-structure.mjs";\n',
  '  const terminalStructure = sanitizeTerminalObservation(value.terminalStructure);\n',
  '    ...(terminalStructure ? { terminalStructure } : {}),\n',
]) oldShapeSource = replaceOnce(oldShapeSource, delta, '');
const oldSanitizerURL = dataModule(absoluteImports(oldShapeSource, sanitizerFile));
const oldSanitizerModule = await import(oldSanitizerURL);
const failureFile = new URL('../lib/works-only-failure.mjs', import.meta.url);
const oldFailureURL = dataModule(absoluteImports(readFileSync(failureFile, 'utf8'), failureFile,
  new Map([['./douyin-browser-diagnostics.mjs', oldSanitizerURL]])));
const providerFile = new URL('../lib/providers/public-web.mjs', import.meta.url);
// Preserve file-relative helper/cwd resolution when the fixture module is
// evaluated from a data URL. Those paths are inspected but never executed.
const oldProviderSource = readFileSync(providerFile, 'utf8').replaceAll('import.meta.url', JSON.stringify(providerFile.href));
const oldProviderURL = dataModule(absoluteImports(oldProviderSource, providerFile,
  new Map([['../douyin-browser-diagnostics.mjs', oldSanitizerURL], ['../works-only-failure.mjs', oldFailureURL]])));
const { PublicWebProvider: OldProjectionProvider } = await import(oldProviderURL);

async function providerResult(Provider, terminal, { errorCode = 'collector_error', httpStatuses = [] } = {}) {
  let childCalls = 0, networkCalls = 0;
  const p = new Provider({}, { accountBrowserFallback: true, now: () => NOW,
    worksRequestPolicyOptions: { now: () => NOW },
    fetchImpl: () => { networkCalls++; throw Error('NETWORK_FORBIDDEN'); },
    execFileImpl: (_file, _args, _options, done) => {
      childCalls++;
      done(null, JSON.stringify({ ok: true, data: { items: [{ key: '42', status: 'unavailable', posts: [],
        errorCode, failureDiagnostics: { ...diagnostic(terminal), httpStatuses }, stderr: SECRET }] } }), SECRET);
    } });
  const output = await p.collectWorksOnly(
    { id: 42, type: 'account', enabled: true, provider: 'public-web', locator: SEC, metadata: {} },
    { snapshotId: 4, sourceChecksum: 'a'.repeat(64), capturedAt: AT, secUid: SEC, uid: '12345678' });
  assert.equal(childCalls, 1); assert.equal(networkCalls, 0);
  assert.equal(output.result.status, 'unavailable'); assert.deepEqual(output.result.posts, []);
  assert.equal(output.result.errorCode, errorCode);
  assert.doesNotMatch(JSON.stringify(output), /PHASE67_SYNTHETIC_PRIVATE_MARKER/);
  return output.result;
}

test('phase67 peer: repeated new Provider objects on an old module still discard child terminal metadata', async () => {
  assert.equal(await import(oldSanitizerURL), oldSanitizerModule);
  for (let i = 0; i < 3; i++) {
    const old = await providerResult(OldProjectionProvider, fixture());
    assert.equal(own(old.failureDiagnostics, 'terminalStructure'), false);
    const fresh = await providerResult(PublicWebProvider, fixture());
    assert.deepEqual(fresh.failureDiagnostics.terminalStructure, fixture());
    const { terminalStructure, ...otherwiseFresh } = fresh.failureDiagnostics;
    assert.deepEqual(old.failureDiagnostics, otherwiseFresh);
    assert.deepEqual(sanitizeBrowserWorksDiagnostics(old.failureDiagnostics), old.failureDiagnostics);
  }
});

test('phase67 peer: no-terminal child is observationally identical to old-parent-dropped terminal', async () => {
  const absentChild = await providerResult(PublicWebProvider, undefined);
  const droppedByOldParent = await providerResult(OldProjectionProvider, fixture());
  assert.deepEqual(absentChild, droppedByOldParent);
  // Therefore absence in DB cannot establish what historical child stdout had.
});

test('phase67 peer: every fixed terminal outcome survives fresh provider but never grants works success', async () => {
  for (const observation of OBSERVATIONS) {
    const expected = sanitizeTerminalObservation(fixture({ observation }));
    const output = await providerResult(PublicWebProvider, fixture({ observation, cookie: SECRET }));
    assert.deepEqual(output.failureDiagnostics.terminalStructure, expected);
    assert.equal(output.failureStage, 'browser-page');
  }
});

test('phase67 peer: ready terminal structure does not override HTTP denial or login classification', async () => {
  for (const [httpStatus, errorCode] of [[401, 'login_required'], [403, 'blocked'], [429, 'rate_limited']]) {
    const output = await providerResult(PublicWebProvider, fixture(), { httpStatuses: [httpStatus], errorCode });
    assert.equal(classifyBrowserWorksFailure({ httpStatuses: [httpStatus], failureDiagnostics: output.failureDiagnostics }).errorCode, errorCode);
  }
  const output = await providerResult(PublicWebProvider, fixture());
  assert.equal(classifyBrowserWorksFailure({ failureDiagnostics: output.failureDiagnostics }).errorCode, 'collector_error');
});

function unavailableEvidence(result) {
  return { version: 1, kind: 'works-only-observation', source: 'authorised-browser', targetId: 42, runId: 67001,
    anchorSnapshotId: 4, anchorChecksum: 'a'.repeat(64), requestedLimit: 30,
    identity: { secUid: SEC, uid: '12345678' }, requestStartedAt: AT, requestFinishedAt: AT,
    observedAt: null, status: 'unavailable', coverage: 'unavailable', errorCode: result.errorCode, posts: [], pagination: null,
    ...projectWorksOnlyFailure(result) };
}

test('phase67 peer: pure ledger validation retains safe terminal but cannot restore old missing fields or authorize accepted', async () => {
  const fresh = unavailableEvidence(await providerResult(PublicWebProvider, fixture()));
  assert.deepEqual(validateWorksOnlyEvidence(fresh, { now: NOW }), fresh);
  assert.ok(own(fresh.failureDiagnostics, 'terminalStructure'));
  assert.throws(() => validateWorksOnlyEvidence({ ...fresh, status: 'accepted' }, { now: NOW }), { code: 'WORKS_OBSERVATION_INVALID' });
  const old = unavailableEvidence(await providerResult(OldProjectionProvider, fixture()));
  assert.deepEqual(validateWorksOnlyEvidence(old, { now: NOW }), old);
  assert.equal(own(old.failureDiagnostics, 'terminalStructure'), false);
});

test('phase67 peer: captured2340 terminal structure coexists with loading first-screen and zero DCL without upgrading either', () => {
  // Fixed safe structure/timing fields read from the already-finished natural
  // run2340. No live DB or platform read is part of this regression test.
  const capturedTerminal = fixture({ startedElapsedMs: 27520, finishedElapsedMs: 27522,
    structure: { readyState: 'interactive', bodyPresent: true, bodyChildCount: 149, scriptCount: 215 } });
  const before = sanitizeBrowserWorksDiagnostics({ ...diagnostic(undefined),
    firstScreen: { observation: 'observed', readyState: 'loading', bodyPresent: false, bodyChildCount: 0, scriptCount: 4 },
    lifecycle: { version: 1, generation: 2, domContentLoadedCount: 0, loadCount: 0,
      firstScreenAttemptCount: 1, lastAcceptedFirstScreenAttempt: 1, lastAcceptedFirstScreenSource: 'commit' },
    firstPageActivation: { state: 'not-eligible', attemptCount: 0, probeCount: 0, actionCount: 0 } });
  const after = sanitizeBrowserWorksDiagnostics({ ...before, terminalStructure: capturedTerminal });
  const { terminalStructure, ...withoutTerminal } = after;
  assert.deepEqual(terminalStructure, capturedTerminal);
  assert.deepEqual(withoutTerminal, before);
  assert.equal(after.firstScreen.readyState, 'loading');
  assert.equal(after.lifecycle.domContentLoadedCount, 0);
  assert.equal(after.firstPageActivation.actionCount, 0);
  assert.equal(classifyBrowserWorksFailure({ failureDiagnostics: after }).errorCode, 'collector_error');
});
