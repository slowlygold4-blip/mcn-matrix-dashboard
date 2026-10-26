import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';
import { projectWorksOnlyFailure } from '../lib/works-only-failure.mjs';
import { BrowserWorksPagination } from '../lib/browser-works-pagination.mjs';
import { normalizeBrowserWorks } from '../scripts/douyin_browser_collector.mjs';

const SEC = 'MS4wLjABAAAADiagnosticsProviderFixture1234';
const AT = '2026-09-29T00:40:00.000Z';
const target = { id: 42, type: 'account', enabled: true, provider: 'public-web', locator: SEC, metadata: {} };
const anchor = { snapshotId: 4, sourceChecksum: 'a'.repeat(64), capturedAt: AT, secUid: SEC, uid: '12345678' };
const diagnostics = { version: 1, stopReason: 'no-bound-request', navigation: { committed: true, failed: false, timedOut: false },
  requests: { candidate: 0, matched: 0 }, elapsedMs: 25000, cookie: 'SECRET', url: 'https://invalid/?token=[REDACTED]' };
const provider = execFileImpl => new PublicWebProvider({}, { accountBrowserFallback: true, now: () => Date.parse(AT),
  worksRequestPolicyOptions: { now: () => Date.parse(AT) }, execFileImpl,
  fetchImpl: () => { throw new Error('NO_NETWORK'); } });

test('successful limited page keeps sanitized diagnostics without a failure stage', async () => {
  const p = provider(() => {}), aweme = { aweme_id: '7200000000000000001', author: { sec_uid: SEC, uid: '12345678' }, statistics: { digg_count: 3 } };
  const body = { status_code: 0, has_more: false, max_cursor: 0, aweme_list: [aweme] };
  const pager = new BrowserWorksPagination({ limit: 30 });
  pager.accept({ requestCursor: 0, body, normalized: normalizeBrowserWorks(body, SEC), observedAt: AT });
  p.runBrowserWorks = async () => ({ items: [{ key: '42', status: 'ok', ...pager.result(1), errorCode: null,
    failureDiagnostics: { ...diagnostics, stopReason: 'success' } }] });
  const result = (await p.collectWorksOnly(target, anchor)).result;
  assert.equal(result.status, 'ok'); assert.equal(result.worksCoverage, 'limited');
  assert.equal(Object.hasOwn(result, 'failureStage'), false);
  assert.deepEqual(result.failureDiagnostics, sanitizeBrowserWorksDiagnostics({ ...diagnostics, stopReason: 'success' }));
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('normal child envelope retains sanitized no-bound-request evidence, not a guessed process error', async () => {
  const p = provider((_f, _a, _o, done) => done(null, JSON.stringify({ ok: true, data: { items: [{ key: '42',
    status: 'unavailable', posts: [], errorCode: 'collector_error', failureDiagnostics: diagnostics, error: 'SECRET' }] } }), 'SECRET'));
  const result = (await p.collectWorksOnly(target, anchor)).result;
  assert.equal(result.failureStage, 'browser-page');
  assert.deepEqual(result.failureDiagnostics, sanitizeBrowserWorksDiagnostics(diagnostics));
  assert.equal(result.errorCode, 'collector_error'); assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('outer structured error preserves fixed error code and diagnostics without stdout/stderr', async () => {
  const p = provider((_f, _a, _o, done) => done(new Error('SECRET'), JSON.stringify({ ok: false,
    errorCode: 'login_required', error: 'SECRET', failureDiagnostics: { version: 1, stopReason: 'collector-exception' } }), 'SECRET'));
  const result = (await p.collectWorksOnly(target, anchor)).result;
  assert.equal(result.errorCode, 'login_required'); assert.equal(result.failureStage, 'collector-envelope');
  assert.equal(result.failureDiagnostics.stopReason, 'collector-exception');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('owned executor failure retains only its safe code, never invents login or page evidence', async () => {
  const p = provider((_f, _a, _o, done) => done(Object.assign(new Error('SECRET'), { code: 'BROWSER_COLLECTOR_EXIT' }), '', 'SECRET'));
  const result = (await p.collectWorksOnly(target, anchor)).result;
  assert.equal(result.errorCode, 'collector_error'); assert.equal(result.failureStage, 'collector-process');
  assert.equal(result.failureCode, 'BROWSER_COLLECTOR_EXIT'); assert.equal(result.failureDiagnostics, undefined);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('wrong key is provider validation, missing/malformed envelope is protocol, and unknown thrown text stays private', async () => {
  for (const [stage, output, error] of [
    ['provider-validation', { ok: true, data: { items: [{ key: 'other', status: 'unavailable', posts: [], failureDiagnostics: diagnostics }] } }, null],
    ['collector-protocol', { ok: true }, null], ['collector-protocol', 'INVALID_SECRET', null],
    ['collector-process', null, new Error('SECRET')],
  ]) {
    const p = provider((_f, _a, _o, done) => done(error, typeof output === 'string' ? output : JSON.stringify(output), 'SECRET'));
    const result = (await p.collectWorksOnly(target, anchor)).result;
    assert.equal(result.failureStage, stage); assert.equal(result.failureDiagnostics, undefined);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
  }
});

test('shared projection preserves old canonical shape and excludes non-enumerated failure fields', () => {
  assert.deepEqual(projectWorksOnlyFailure({ status: 'unavailable', errorCode: 'collector_error' }), {});
  assert.deepEqual(projectWorksOnlyFailure({ failureStage: 'SECRET', failureCode: 'SECRET', failureDiagnostics: { version: 2 } }), {});
  const clean = projectWorksOnlyFailure({ failureStage: 'browser-page', failureCode: 'BROWSER_COLLECTOR_EXIT',
    failureDiagnostics: diagnostics, error: 'SECRET', stderr: 'SECRET' });
  assert.deepEqual(projectWorksOnlyFailure(clean), clean);
  assert.equal(JSON.stringify(clean).includes('SECRET'), false);
});

test('safe executor code stays recognizable by existing account fallback lifecycle guards', async () => {
  const p = provider((_f, _a, _o, done) => done(Object.assign(new Error('SECRET'), { code: 'BROWSER_CLEANUP_UNCERTAIN' }), '', 'SECRET'));
  await assert.rejects(p.runBrowserWorks({ key: '42', secUid: SEC, limit: 30 }), error => {
    assert.equal(error.code, 'BROWSER_CLEANUP_UNCERTAIN');
    assert.equal(error.failureCode, 'BROWSER_CLEANUP_UNCERTAIN');
    assert.equal(error.failureStage, 'collector-ownership');
    assert.equal(error.message.includes('SECRET'), false); return true;
  });
});
