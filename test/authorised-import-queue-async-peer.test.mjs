import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { MonitorDatabase } from '../lib/database.mjs';
import { buildAuthorEvidenceRequests } from '../lib/author-resolution.mjs';
import { runQueuedAuthorisedImport } from '../lib/authorised-import-queue.mjs';

const VIDEO = '7690702905876096104', HANDLE = '000123', SEC = 'MS4wLjABAAAAQueuePeerFixture0001', UID = '1234567890123456';
const PRIVATE = 'SENSITIVE_ASYNC_PEER_TOKEN';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(t) {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close()); const db = database.db, jobId = randomUUID();
  const source = { sourceRow: 2, platform: 'douyin', name: '独立异步测试', douyinId: HANDLE, videoId: VIDEO, status: 'resolvable' };
  const request = { fileName: 'async-peer.xlsx', sheetName: '原名单', rows: [source] };
  database.createAuthorResolutionJob({ id: jobId, actorName: '离线测试', fileName: request.fileName, sheetName: request.sheetName, request });
  db.prepare('UPDATE author_resolution_jobs SET created_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), jobId);
  const evidence = buildAuthorEvidenceRequests([source])[0];
  database.enqueueAuthorResolutions([evidence], { fileName: request.fileName, sheetName: request.sheetName, sourceMetadata: { sourceType: 'author-spreadsheet' } });
  db.prepare("UPDATE author_resolution_jobs SET status='completed',finished_at=? WHERE id=?").run(new Date().toISOString(), jobId);
  const owner = 'async-peer-owner', claimed = database.claimDueAuthorResolutions(1, { owner, leaseMs: 60_000 })[0];
  assert.ok(claimed);
  const capture = () => JSON.stringify(Object.fromEntries(['targets', 'snapshots', 'author_resolution_queue', 'author_resolution_jobs',
    'author_resolution_import_sources', 'author_resolution_success_receipts', 'activity_log'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  const proof = input => {
    const at = new Date().toISOString(), response = { status_code: 0, aweme_detail: { aweme_id: VIDEO,
      author: { sec_uid: SEC, uid: UID, unique_id: HANDLE } } }, responseSha256 = hash(response), responseSha256Scope = 'public-identity-projection-v1';
    return { status: 'ok', key: input.key, submittedId: HANDLE, videoId: VIDEO, requestStartedAt: at, requestFinishedAt: at,
      candidate: { videoId: VIDEO, secUid: SEC, uid: UID, uniqueId: HANDLE, shortId: '', provenance: 'authorised-browser-natural-detail', observedAt: at, responseSha256, responseSha256Scope },
      evidence: { version: 1, kind: 'natural-main-frame-detail-response', origin: 'https://www.douyin.com', path: '/aweme/v1/web/aweme/detail/', method: 'GET',
        httpStatus: 200, requestedVideoId: VIDEO, observedAt: at, responseSha256, responseSha256Scope, response },
      provenance: { mode: 'authorised-browser-natural-detail', authorisedSessionUsed: true, authenticated: null, authenticationStatus: 'not-verified', noChallengeBypass: true, runtimeAI: false, paidAPI: false } };
  };
  const unavailable = (input, errorCode = 'blocked') => { const at = new Date().toISOString(); return { status: 'unavailable', key: input.key, submittedId: HANDLE, videoId: VIDEO,
    requestStartedAt: at, requestFinishedAt: at, errorCode, message: PRIVATE, headers: { authorization: PRIVATE } }; };
  let mapped = 0;
  const createInput = (job, row) => { mapped++; assert.equal(job.id, jobId); return { type: 'account', provider: 'public-web', label: row.name,
    locator: row.locator, boards: row.boards, metadata: { platform: 'douyin', resolution: row.resolution } }; };
  function launch({ signal, mapper = createInput } = {}) {
    const wait = deferred(); let input, calls = 0;
    const promise = runQueuedAuthorisedImport(database, claimed, { owner, signal, createInput: mapper, provider: {
      resolveAuthors() { assert.fail('anonymous fallback is forbidden'); },
      resolveAuthorisedDetail(payload) { calls++; assert.equal(payload.items.length, 1); input = payload.items[0]; return wait.promise; },
    } });
    return { ...wait, promise, get input() { return input; }, get calls() { return calls; } };
  }
  return { database, db, jobId, owner, claimed, capture, proof, unavailable, launch, get mapped() { return mapped; } };
}

test('cancellation during actual await discards late proof, late gate and late exception without any DB change', async t => {
  for (const kind of ['proof', 'gate', 'error']) {
    const f = fixture(t), controller = new AbortController(), before = f.capture(), run = f.launch({ signal: controller.signal });
    assert.equal(run.calls, 1); controller.abort(new Error(PRIVATE));
    if (kind === 'error') run.reject(Object.assign(new Error(PRIVATE), { code: PRIVATE }));
    else run.resolve(kind === 'proof' ? f.proof(run.input) : f.unavailable(run.input));
    const outcome = await run.promise;
    assert.equal(outcome.status, 'unavailable'); assert.equal(outcome.code, 'cancelled'); assert.equal(outcome.monitoringChanged, false);
    assert.equal(outcome.result, undefined); assert.equal(f.mapped, 0); assert.equal(f.capture(), before);
    assert.doesNotMatch(JSON.stringify(outcome), new RegExp(PRIVATE)); assert.equal(run.calls, 1);
  }
});

test('ownership, expiry, evidence, manual suspension and source changes during await fail final CAS with byte-identical post-change state', async t => {
  for (const sql of [
    "UPDATE author_resolution_queue SET lease_owner='different-owner'",
    "UPDATE author_resolution_queue SET lease_until='2000-01-01T00:00:00Z'",
    "UPDATE author_resolution_queue SET lease_until='invalid-date'",
    'UPDATE author_resolution_queue SET evidence_version=evidence_version+1',
    'UPDATE author_resolution_queue SET suspended_target_enabled=0',
    "UPDATE author_resolution_queue SET status='rejected',last_error='manual rejection'",
    "UPDATE author_resolution_import_sources SET receipt_sha256='invalid'",
    "UPDATE author_resolution_jobs SET request_json='{}'",
  ]) {
    const f = fixture(t), run = f.launch(); assert.equal(run.calls, 1); f.db.exec(sql); const before = f.capture();
    run.resolve(f.proof(run.input)); const outcome = await run.promise;
    assert.equal(outcome.status, 'unavailable', sql); assert.equal(outcome.monitoringChanged, false);
    assert.equal(f.capture(), before, sql); assert.equal(f.db.isTransaction, false); assert.equal(f.mapped, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM targets').get().n, 0);
  }
});

test('malformed or mismatched late proofs never reach target normalization or persistence', async t => {
  const mutate = [
    value => { value.key = 'other-evidence'; },
    value => { value.videoId = '7690702905876096105'; },
    value => { value.submittedId = 123; },
    value => { value.evidence.httpStatus = 403; },
    value => { value.evidence.origin = 'https://example.invalid'; },
    value => { value.candidate.responseSha256 = '0'.repeat(64); },
    value => { value.evidence.response.aweme_detail.author.unique_id = 123; },
    value => { value.evidence.response.aweme_detail.author.unique_id = UID; },
    value => { value.evidence.response.aweme_detail.author.unique_id = ''; },
    value => { value.requestFinishedAt = '2999-01-01T00:00:00Z'; },
    value => { value.evidence.response = { error: PRIVATE }; },
    value => { value.provenance.noChallengeBypass = false; },
  ];
  for (const change of mutate) {
    const f = fixture(t), before = f.capture(), run = f.launch(), result = f.proof(run.input); change(result); result.secret = PRIVATE; run.resolve(result);
    const outcome = await run.promise;
    assert.equal(outcome.status, 'unavailable'); assert.equal(outcome.code, 'AUTHORISED_DETAIL_UNVERIFIED'); assert.equal(outcome.monitoringChanged, false);
    assert.equal(outcome.result, undefined); assert.equal(f.mapped, 0); assert.equal(f.capture(), before); assert.equal(f.db.isTransaction, false);
    assert.doesNotMatch(JSON.stringify(outcome), new RegExp(PRIVATE));
  }
});

test('known busy and unknown upstream errors expose only fixed codes and neither reclaim nor fall back', async t => {
  for (const code of ['BROWSER_LANE_BUSY', 'BROWSER_LANE_LOCKED', PRIVATE, undefined]) {
    const f = fixture(t), before = f.capture(), run = f.launch(); run.reject(Object.assign(new Error(`Cookie=${PRIVATE}; https://secret.invalid/`), { code }));
    const outcome = await run.promise;
    assert.equal(outcome.code, code?.startsWith('BROWSER_LANE_') ? code : 'AUTHORISED_DETAIL_UNVERIFIED');
    assert.equal(outcome.monitoringChanged, false); assert.equal(f.mapped, 0); assert.equal(f.capture(), before); assert.equal(run.calls, 1);
    assert.doesNotMatch(JSON.stringify(outcome), /SENSITIVE_ASYNC_PEER_TOKEN|secret\.invalid|Cookie=/);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action='author-resolution.claimed'").get().n, 1);
  }
});

test('gate payloads strip extra fields and retain the caller lease without target writes', async t => {
  for (const code of ['blocked', 'login_required', 'challenge_required', 'rate_limited', 'cleanup_uncertain', 'timeout']) {
    const f = fixture(t), before = f.capture(), run = f.launch(); run.resolve(f.unavailable(run.input, code)); const outcome = await run.promise;
    assert.equal(outcome.status, 'unavailable'); assert.equal(outcome.code, code); assert.equal(outcome.attempted, true); assert.equal(outcome.monitoringChanged, false);
    assert.equal(outcome.result.message, undefined); assert.equal(f.capture(), before); assert.equal(f.mapped, 0); assert.doesNotMatch(JSON.stringify(outcome), new RegExp(PRIVATE));
  }
});

test('normalizer exception rolls back admission completely and exposes no raw exception', async t => {
  const f = fixture(t), before = f.capture(), run = f.launch({ mapper() { throw new Error(PRIVATE); } });
  run.resolve(f.proof(run.input)); const outcome = await run.promise;
  assert.equal(outcome.status, 'unavailable'); assert.equal(outcome.code, 'AUTHORISED_DETAIL_UNVERIFIED'); assert.equal(outcome.monitoringChanged, false);
  assert.equal(f.capture(), before); assert.equal(f.db.isTransaction, false); assert.doesNotMatch(JSON.stringify(outcome), new RegExp(PRIVATE));
});

test('successful admission sanitizes extra response fields and commits once through the existing claimed identity', async t => {
  const f = fixture(t), run = f.launch(), result = f.proof(run.input); result.secret = PRIVATE;
  result.evidence.response.headers = { cookie: PRIVATE }; result.evidence.response.aweme_detail.author.private_token = PRIVATE;
  run.resolve(result); const outcome = await run.promise;
  assert.equal(outcome.status, 'resolved'); assert.equal(outcome.monitoringChanged, true); assert.equal(run.calls, 1); assert.equal(f.mapped, 1);
  assert.doesNotMatch(JSON.stringify(outcome), new RegExp(PRIVATE)); assert.doesNotMatch(f.capture(), new RegExp(PRIVATE));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM targets').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM author_resolution_success_receipts').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM snapshots').get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action='author-resolution.claimed'").get().n, 1);
});
