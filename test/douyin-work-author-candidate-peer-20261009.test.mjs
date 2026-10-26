import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { normalizeWorkAuthorCandidateInput, prepareImportWorkAuthorCandidate,
  validateWorkAuthorCandidateResult, collectDouyinWorkAuthorCandidate,
  WORK_AUTHOR_CANDIDATE_SCOPE, WORK_AUTHOR_CANDIDATE_HASH_SCOPE } from '../lib/douyin-work-author-candidate.mjs';
import { normalizeAuthorisedDetailInput, validateAuthorisedDetailResult,
  validateAuthorisedDetailResponse } from '../lib/douyin-authorised-detail.mjs';
import { prepareAuthorisedDetailAdmission } from '../lib/authorised-detail-admission.mjs';
import { buildAuthorEvidenceRequests } from '../lib/author-resolution.mjs';

const VIDEO = '7685023510935011434', SEC = 'MS4wLjABAAAAWorkAuthorCandidatePeer001';
const UID = '311853370062908', HANDLE = 'public_author_123';
const SHARE = 'https://v.douyin.com/ExactSourceShare/';
const START = '2026-10-09T19:00:00.000Z', END = '2026-10-09T19:00:01.000Z';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sourceJob(share = false) {
  return { id: '00000000-0000-4000-8000-000000000001', status: 'completed', fileName: '原表.xlsx', sheetName: '作者',
    request: { rows: [{ sourceRow: 294, platform: 'douyin', name: '不是身份证据的昵称', douyinId: '原表误填昵称',
      locator: '', videoId: share ? '' : VIDEO, shareUrl: share ? SHARE : '', contentId: '', videoLink: '', videoHyperlink: '',
      status: 'resolvable', identityConflict: '', rejectedLink: '', boards: [] }] } };
}
const response = () => ({ status_code: 0, aweme_detail: { aweme_id: VIDEO,
  author: { sec_uid: SEC, uid: UID, unique_id: HANDLE, short_id: '123456789' } } });
function candidateFixture(share = false) {
  const job = sourceJob(share), input = prepareImportWorkAuthorCandidate(job, { sourceRow: 294 }), raw = response();
  const digest = hash(raw), observedAt = END;
  const result = { status: 'candidate-only', scope: WORK_AUTHOR_CANDIDATE_SCOPE,
    submittedIdentityVerified: false, metricsSampled: false, monitoringEnabled: false, ...input,
    requestStartedAt: START, requestFinishedAt: END, ...(share ? { videoId: VIDEO } : {}),
    candidate: { videoId: VIDEO, secUid: SEC, uid: UID, uniqueId: HANDLE, shortId: '123456789',
      provenance: 'authorised-browser-natural-detail', observedAt, responseSha256: digest,
      responseSha256Scope: WORK_AUTHOR_CANDIDATE_HASH_SCOPE },
    evidence: { version: 1, kind: 'natural-main-frame-work-author-candidate-response', origin: 'https://www.douyin.com',
      path: '/aweme/v1/web/aweme/detail/', method: 'GET', httpStatus: 200, requestedVideoId: VIDEO, observedAt,
      responseSha256: digest, responseSha256Scope: WORK_AUTHOR_CANDIDATE_HASH_SCOPE, response: raw,
      ...(share ? { requestedShareUrl: SHARE, finalVideoId: VIDEO, finalUrl: `https://www.douyin.com/video/${VIDEO}`,
        finalUrlSha256: 'a'.repeat(64), finalUrlScope: 'observed-origin-path' } : {}) },
    provenance: { mode: 'authorised-browser-natural-detail', authorisedSessionUsed: true, authenticated: null,
      authenticationStatus: 'not-verified', noChallengeBypass: true, runtimeAI: false, paidAPI: false } };
  return { job, input, result, times: { startedAt: START, finishedAt: END } };
}

test('candidate peer: only an immutable invalid-ID source row qualifies; valid-ID mismatches and resolved identities stay excluded', () => {
  const job = sourceJob(), before = structuredClone(job), input = prepareImportWorkAuthorCandidate(job, { sourceRow: 294 });
  assert.deepEqual(job, before); assert.equal(input.source.sourceRowSha256, hash(job.request.rows[0]));
  assert.equal(Object.hasOwn(input, 'submittedId'), false);
  for (const change of [
    r => { r.douyinId = 'valid_id'; }, r => { r.douyinId = '@VaLiD_ID'; }, r => { r.douyinId = '58392516444'; },
    r => { r.platform = 'bilibili'; }, r => { r.locator = SEC; }, r => { r.targetId = 123; },
    r => { r.resolvedTargetId = 123; }, r => { r.status = 'existing'; }, r => { r.status = 'identity_conflict'; },
    r => { r.identityConflict = 'known conflict'; }, r => { r.videoId = Number(VIDEO); },
    r => { r.shareUrl = SHARE; }, r => { r.videoHyperlink = `https://foreign.example/video/${VIDEO}`; },
  ]) { const bad = sourceJob(); change(bad.request.rows[0]); assert.throws(() => prepareImportWorkAuthorCandidate(bad, { sourceRow: 294 })); }
  const duplicates = sourceJob(); duplicates.request.rows.push(structuredClone(duplicates.request.rows[0]));
  assert.throws(() => prepareImportWorkAuthorCandidate(duplicates, { sourceRow: 294 }));
  assert.throws(() => prepareImportWorkAuthorCandidate(job, { sourceRow: 294, submittedId: HANDLE }));
});

test('candidate peer: the source capability binds job, exact row hash and exactly one work without a fake submitted ID', () => {
  const { input } = candidateFixture(true);
  for (const mutation of [
    x => { x.source.jobId = '00000000-0000-4000-8000-000000000002'; },
    x => { x.source.sourceRow = 295; }, x => { x.source.sourceRowSha256 = 'b'.repeat(64); },
    x => { x.source.extra = true; }, x => { x.key = 'unbound-key'; }, x => { x.submittedId = 'placeholder'; },
    x => { x.expectedSecUid = SEC; }, x => { x.videoId = VIDEO; },
    x => { x.shareUrl = 'https://v.douyin.com:443/ExactSourceShare/'; },
  ]) { const bad = structuredClone(input); mutation(bad); assert.throws(() => normalizeWorkAuthorCandidateInput({ items: [bad] })); }
  assert.throws(() => normalizeWorkAuthorCandidateInput({ items: [input, input] }));
  assert.throws(() => normalizeAuthorisedDetailInput({ items: [input] }), { code: 'invalid_input' });
});

test('candidate peer: parent revalidation keeps observation-only flags and drops arbitrary values and credentials', () => {
  const f = candidateFixture(true), value = structuredClone(f.result);
  value.raw = 'PRIVATE_BODY'; value.candidate.cookie = 'PRIVATE_COOKIE';
  value.evidence.headers = { Cookie: 'PRIVATE_COOKIE' }; value.evidence.response.aweme_detail.author.nickname = 'PRIVATE_NICK';
  value.provenance.token = 'PRIVATE_TOKEN';
  const checked = validateWorkAuthorCandidateResult(f.input, value, f.times);
  assert.equal(checked.status, 'candidate-only'); assert.equal(checked.submittedIdentityVerified, false);
  assert.equal(checked.monitoringEnabled, false); assert.equal(checked.metricsSampled, false);
  assert.doesNotMatch(JSON.stringify(checked), /PRIVATE|cookie|nickname/);
  assert.equal(checked.candidate.uniqueId, HANDLE);
  for (const mutate of [
    r => { r.source.sourceRow = 1; }, r => { r.submittedIdentityVerified = true; }, r => { r.monitoringEnabled = true; },
    r => { r.metricsSampled = true; }, r => { r.submittedId = HANDLE; }, r => { r.admission = {}; },
    r => { r.candidate.uid = Number(UID); }, r => { r.candidate.responseSha256 = '0'.repeat(64); },
    r => { r.evidence.finalUrl = `https://foreign.example/video/${VIDEO}`; },
    r => { r.evidence.finalUrl = `https://www.douyin.com/video/${VIDEO}?modal_id=7690702905876096105`; },
    r => { r.evidence.requestedShareUrl = 'https://v.douyin.com/OtherSource/'; },
    r => { r.evidence.observedAt = '2026-10-09T19:00:01.001Z'; },
  ]) { const bad = structuredClone(f.result); mutate(bad); assert.throws(() => validateWorkAuthorCandidateResult(f.input, bad, f.times)); }
});

test('candidate peer: status relabelling or adding a submitted ID never upgrades a candidate to strict admission evidence', () => {
  const f = candidateFixture(), job = sourceJob(); job.request.rows[0].douyinId = HANDLE;
  const request = buildAuthorEvidenceRequests(job.request.rows)[0];
  const strict = normalizeAuthorisedDetailInput({ items: [{ key: request.key, videoId: VIDEO, submittedId: HANDLE }] });
  for (const change of [r => r, r => ({ ...r, status: 'ok' }),
    r => ({ ...r, status: 'ok', submittedId: HANDLE, key: strict.key }),
    r => ({ ...r, status: 'ok', submittedId: HANDLE, key: strict.key,
      evidence: { ...r.evidence, kind: 'natural-main-frame-detail-response' } }),
  ]) {
    const result = change(structuredClone(f.result));
    assert.throws(() => validateAuthorisedDetailResult(strict, result, f.times));
    assert.throws(() => prepareAuthorisedDetailAdmission({ job, sourceRow: 294, result, ...f.times,
      reference: new Date(END), owner: 'peer-owner', queueItem: {} }));
  }
  assert.throws(() => validateAuthorisedDetailResponse(response(), { ...strict, submittedId: 'different_id' }), { code: 'identity_mismatch' });
});

function mockRuntime({ status = 200, frameMismatch = false, badRedirect = false, body = response(), abortOnClose = false, signalController } = {}) {
  const calls = [], page = new EventEmitter(); let url = 'about:blank'; const frame = { url: () => url };
  page.url = () => url; page.mainFrame = () => frame;
  page.close = async () => { calls.push('page.close'); if (abortOnClose) signalController.abort(); };
  page.goto = async value => {
    calls.push('goto'); url = value; page.emit('framenavigated', frame);
    if (badRedirect) {
      const previous = { url: () => 'https://foreign.example/redirect?token=[REDACTED]', redirectedFrom: () => null,
        isNavigationRequest: () => true, frame: () => frame };
      const next = { url: () => value, redirectedFrom: () => previous, isNavigationRequest: () => true, frame: () => frame };
      page.emit('request', next);
    }
    const detail = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${VIDEO}&secret=PRIVATE`;
    const request = { url: () => detail, redirectedFrom: () => null, isNavigationRequest: () => false,
      frame: () => frameMismatch ? {} : frame, method: () => 'GET' };
    page.emit('request', request); page.emit('response', { request: () => request, url: () => detail, status: () => status,
      text: async () => { calls.push('body'); return JSON.stringify(body); } });
  };
  const process = { pid: 56789, exitCode: null, signalCode: null };
  const server = { process: () => process, wsEndpoint: () => 'ws://127.0.0.1/PRIVATE',
    close: async () => { calls.push('server.close'); process.exitCode = 0; }, kill: async () => { process.signalCode = 'SIGKILL'; } };
  const runtime = { readState: async () => { calls.push('state'); return { cookies: [{ name: 'PRIVATE', value: 'PRIVATE' }] }; }, access: async () => {},
    ownership: { remainingExecutionMs: () => 45_000, send: async name => { calls.push(name); } },
    chromium: { launchServer: async () => server, connect: async () => ({ close: async () => {},
      newContext: async () => ({ close: async () => {}, newPage: async () => page }) }) } };
  return { runtime, calls, page };
}

test('candidate peer: default-off, ownership and pre-abort guards run before any session/browser access', async () => {
  const f = candidateFixture(); const m = mockRuntime();
  await assert.rejects(() => collectDouyinWorkAuthorCandidate({ items: [f.input] }, { runtime: m.runtime }), { code: 'disabled' });
  assert.deepEqual(m.calls, []);
  const noOwner = mockRuntime(); delete noOwner.runtime.ownership;
  await assert.rejects(() => collectDouyinWorkAuthorCandidate({ items: [f.input] }, { enabled: true, runtime: noOwner.runtime }), { code: 'ownership_required' });
  assert.deepEqual(noOwner.calls, []);
  const controller = new AbortController(); controller.abort();
  const result = await collectDouyinWorkAuthorCandidate({ items: [f.input] }, { enabled: true, runtime: m.runtime, signal: controller.signal });
  assert.equal(result.status, 'unavailable'); assert.equal(result.errorCode, 'cancelled'); assert.deepEqual(m.calls, []);
});

test('candidate peer: natural observation stays bounded by gate, official redirect chain, main-frame attribution and cleanup cancellation', async () => {
  const f = candidateFixture();
  for (const [configuration, expected] of [[{ status: 403 }, 'blocked'], [{ body: { ...response(), need_login: true } }, 'login_required'],
    [{ body: { ...response(), verify_required: true } }, 'challenge_required'], [{ badRedirect: true }, 'navigation_error'],
    [{ frameMismatch: true }, 'no_bound_response']]) {
    const m = mockRuntime(configuration);
    const result = await collectDouyinWorkAuthorCandidate({ items: [f.input] }, { enabled: true, runtime: m.runtime, timeoutMs: 50 });
    assert.equal(result.status, 'unavailable', expected); assert.equal(result.errorCode, expected);
    assert.equal(result.candidate, undefined); assert.equal(result.evidence, undefined);
    assert.equal(m.calls.filter(x => x === 'goto').length, 1); assert.ok(m.calls.includes('released'));
    for (const name of ['request', 'response', 'framenavigated']) assert.equal(m.page.listenerCount(name), 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
  const controller = new AbortController(), m = mockRuntime({ abortOnClose: true, signalController: controller });
  const result = await collectDouyinWorkAuthorCandidate({ items: [f.input] }, { enabled: true, runtime: m.runtime, signal: controller.signal });
  assert.equal(result.errorCode, 'cancelled'); assert.equal(result.candidate, undefined);
});
