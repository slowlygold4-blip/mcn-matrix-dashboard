import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { MonitorDatabase } from '../lib/database.mjs';
import { buildAuthorEvidenceRequests } from '../lib/author-resolution.mjs';
import { commitAuthorisedImportDetail } from '../lib/authorised-import-service.mjs';
import { validatedSuccessProof } from '../lib/master-roster-supplement.mjs';

const VIDEO = '7690702905876096104', SEC = 'MS4wLjABAAAAPeerAdmissionAuthor000001';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rawHash = value => createHash('sha256').update(value).digest('hex');
const SECRET = 'SENSITIVE_PEER_TOKEN=offline-fixture-only';
const exhaustedErrors = [
  ['exhausted_http_403', `达到公开核验重试上限；公开接口返回 HTTP 403；${SECRET}`],
  ['exhausted_blocked', '达到公开核验重试上限；公开视频详情请求未完成（blocked）；未记录错误原文'],
];
function fixture(t, { sheetName = '原始登记' } = {}) {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const db = database.db, row = { sourceRow: 682, platform: 'douyin', name: '原始作者', douyinId: 'peer_handle',
    videoId: VIDEO, status: 'resolvable' }, fileName = 'authorised-peer.xlsx';
  const request = { fileName, sheetName, rows: [row] }, evidence = buildAuthorEvidenceRequests([row])[0];
  database.enqueueAuthorResolutions([evidence], { fileName, sheetName, sourceMetadata: { sourceType: 'author-spreadsheet' } });
  const job = { id: randomUUID(), status: 'completed', fileName, sheetName, request };
  database.createAuthorResolutionJob({ id: job.id, fileName, sheetName, request, actorName: '离线测试', totalAuthors: 1 });
  db.prepare("UPDATE author_resolution_jobs SET status='completed',result_json=?,finished_at=? WHERE id=?")
    .run(JSON.stringify({ skipped: [{ ...row, status: 'queued', evidenceRequestKeys: [evidence.key] }] }), new Date().toISOString(), job.id);
  const current = () => db.prepare('SELECT * FROM author_resolution_queue WHERE identity_key=?').get(evidence.key);
  const capture = () => ({ jobs: db.prepare('SELECT request_json,result_json FROM author_resolution_jobs ORDER BY id').all(),
    sources: db.prepare('SELECT * FROM author_resolution_import_sources ORDER BY id').all() });
  // Compare persisted bytes, not total_changes(): SQLite intentionally counts
  // rolled-back writes in total_changes(), including our same-connection faults.
  const captureAll = () => JSON.stringify(Object.fromEntries([
    'author_resolution_queue', 'author_resolution_jobs', 'author_resolution_import_sources',
    'author_resolution_success_receipts', 'targets', 'board_catalog', 'target_boards', 'activity_log', 'audits', 'snapshots',
  ].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  const rejectNetwork = (error = exhaustedErrors[0][1]) => {
    db.prepare(`UPDATE author_resolution_queue SET status='rejected',attempts=7,last_error=?,
      next_attempt_at='2099-01-01T00:00:00.000Z',updated_at='2001-01-01T00:00:00.000Z' WHERE id=?`)
      .run(error, current().id);
    return current();
  };
  const input = verified => ({ label: verified.name, locator: verified.locator,
    provider: 'public-web', type: 'account', metadata: { platform: 'douyin', resolution: verified.resolution }, boards: verified.boards });
  function proof() {
    const time = Date.now(), startedAt = new Date(time - 20).toISOString(), finishedAt = new Date(time - 1).toISOString();
    const response = { status_code: 0, aweme_detail: { aweme_id: VIDEO,
      author: { sec_uid: SEC, uid: '1234567890123456', unique_id: row.douyinId } } };
    const responseSha256 = hash(response), responseSha256Scope = 'public-identity-projection-v1';
    return { startedAt, finishedAt, result: {
      status: 'ok', key: evidence.key, videoId: VIDEO, submittedId: row.douyinId,
      requestStartedAt: startedAt, requestFinishedAt: finishedAt,
      candidate: { videoId: VIDEO, secUid: SEC, uid: '1234567890123456', uniqueId: row.douyinId, shortId: '',
        provenance: 'authorised-browser-natural-detail', observedAt: finishedAt, responseSha256, responseSha256Scope },
      evidence: { version: 1, kind: 'natural-main-frame-detail-response', origin: 'https://www.douyin.com',
        path: '/aweme/v1/web/aweme/detail/', method: 'GET', httpStatus: 200, requestedVideoId: VIDEO,
        observedAt: finishedAt, responseSha256, responseSha256Scope, response },
      provenance: { mode: 'authorised-browser-natural-detail', authorisedSessionUsed: true, authenticated: null,
        authenticationStatus: 'not-verified', noChallengeBypass: true, runtimeAI: false, paidAPI: false },
    } };
  }
  function run({ createInput = input, useJob = job, result } = {}) {
    const p = proof(); return commitAuthorisedImportDetail(database, useJob, { sourceRow: 682 }, result ?? p.result,
      { startedAt: p.startedAt, finishedAt: p.finishedAt, createInput });
  }
  const sibling = (overrides = {}) => {
    const next = { ...row, videoId: '7690702905876096105', sourceRow: 683, ...overrides };
    const e = buildAuthorEvidenceRequests([next])[0];
    database.enqueueAuthorResolutions([e], { fileName: '其他来源.xlsx', sheetName, sourceMetadata: { sourceType: 'author-spreadsheet' } });
    return db.prepare('SELECT * FROM author_resolution_queue WHERE identity_key=?').get(e.key);
  };
  return { database, db, row, job, evidence, current, capture, captureAll, rejectNetwork, input, proof, run, sibling };
}

test('service peer: commits only one exact evidence row and retains old sources/jobs/other work', t => {
  const f = fixture(t), sibling = f.sibling(), before = f.capture(), old = f.current();
  const result = f.run();
  assert.equal(result.status, 'committed'); assert.equal(result.created, true);
  assert.equal(f.current().status, 'resolved'); assert.equal(f.current().attempts, old.attempts);
  assert.equal(f.current().evidence_version, old.evidence_version);
  assert.equal(f.current().lease_owner, null);
  assert.deepEqual(f.db.prepare('SELECT * FROM author_resolution_queue WHERE id=?').get(sibling.id), sibling);
  assert.deepEqual(f.capture(), before);
  assert.equal(f.db.prepare('SELECT count(*) n FROM snapshots').get().n, 0);
  const receipt = f.db.prepare('SELECT * FROM author_resolution_success_receipts').get();
  assert.ok(validatedSuccessProof(receipt));
  assert.equal(JSON.parse(receipt.payload_json).resolution.verifiedEvidenceCount, 1);
  const event = f.db.prepare("SELECT resource_id FROM activity_log WHERE action='author-resolution.claimed'").get();
  assert.equal(event.resource_id, hash(['douyin', 'submitted-id', f.row.douyinId]));
  assert.throws(() => f.run(), { code: 'AUTHORISED_ADMISSION_NOT_ELIGIBLE' });
  assert.equal(f.db.prepare('SELECT count(*) n FROM author_resolution_success_receipts').get().n, 1);
});

test('service peer: rejected and suspended queue rows cannot become eligible or lose old failure evidence', t => {
  for (const state of ['rejected', 'suspended']) {
    const f = fixture(t);
    if (state === 'rejected') f.db.prepare("UPDATE author_resolution_queue SET status='rejected',attempts=5,last_error='PRIVATE_OLD_FAILURE' WHERE id=?").run(f.current().id);
    else f.db.prepare('UPDATE author_resolution_queue SET suspended_target_enabled=0 WHERE id=?').run(f.current().id);
    const before = f.current(), sources = f.capture(), changes = f.db.prepare('SELECT total_changes() n').get().n;
    assert.throws(() => f.run(), { code: 'AUTHORISED_ADMISSION_NOT_ELIGIBLE' });
    assert.deepEqual(f.current(), before); assert.deepEqual(f.capture(), sources);
    assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
    assert.equal(f.db.prepare('SELECT count(*) n FROM targets').get().n, 0);
  }
});

test('service peer: same submitted identity with active, dangling or invalid sibling lease fails closed', t => {
  for (const expiry of [null, 'invalid-date', new Date(Date.now() + 60_000).toISOString()]) {
    const f = fixture(t), sibling = f.sibling();
    f.db.prepare('UPDATE author_resolution_queue SET lease_owner=?,lease_until=? WHERE id=?').run('other-worker', expiry, sibling.id);
    const before = f.current();
    assert.throws(() => f.run(), { code: 'AUTHORISED_ADMISSION_BUSY' });
    assert.deepEqual(f.current(), before);
    assert.equal(f.db.prepare('SELECT count(*) n FROM targets').get().n, 0);
  }
});

test('service peer: stale job bytes and absent/tampered source receipts cannot be used for admission', t => {
  for (const failure of ['job', 'missing', 'hash']) {
    const f = fixture(t);
    if (failure === 'job') f.db.prepare('UPDATE author_resolution_jobs SET request_json=? WHERE id=?').run('{}', f.job.id);
    if (failure === 'missing') f.db.prepare('DELETE FROM author_resolution_import_sources').run();
    if (failure === 'hash') f.db.prepare("UPDATE author_resolution_import_sources SET receipt_sha256=?").run('0'.repeat(64));
    const before = f.current();
    assert.throws(() => f.run()); assert.deepEqual(f.current(), before);
    assert.equal(f.db.prepare('SELECT count(*) n FROM targets').get().n, 0);
  }
});

test('service peer: current existing paused target stays paused after exact evidence admission', t => {
  const f = fixture(t), at = new Date().toISOString();
  f.db.prepare("INSERT INTO targets(type,label,locator,provider,enabled,metadata_json,created_at,updated_at) VALUES('account','手动暂停',?,'public-web',0,?,?,?)")
    .run(SEC, JSON.stringify({ platform: 'douyin', retained: true }), at, at);
  const result = f.run(); assert.equal(result.created, false);
  assert.equal(f.db.prepare('SELECT enabled FROM targets WHERE locator=?').get(SEC).enabled, 0);
  assert.equal(result.target.enabled, false);
});

test('service peer: strict public-ID conflict commits a reviewable rejection without changing the existing target', t => {
  const f = fixture(t), at = new Date().toISOString();
  f.db.prepare("INSERT INTO targets(type,label,locator,provider,enabled,metadata_json,created_at,updated_at) VALUES('account','用户维护名称',?,'public-web',0,?,?,?)")
    .run(SEC, JSON.stringify({ platform: 'douyin', douyinId: 'old_handle', owner: '用户负责人' }), at, at);
  const targetBefore = f.db.prepare('SELECT * FROM targets WHERE locator=?').get(SEC);
  const sourcesBefore = f.capture(), queueBefore = f.current();
  const result = f.run();
  assert.deepEqual(result, { monitoringChanged: false, status: 'rejected', code: 'AUTHOR_TARGET_PUBLIC_ID_CONFLICT', queueId: queueBefore.id });
  assert.equal(f.db.isTransaction, false);
  assert.deepEqual(f.db.prepare('SELECT * FROM targets WHERE locator=?').get(SEC), targetBefore);
  assert.deepEqual(f.capture(), sourcesBefore);
  const rejected = f.current();
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.attempts, queueBefore.attempts + 1);
  assert.match(rejected.last_error, /公开抖音号.*不一致.*人工核查/);
  assert.equal(rejected.resolved_target_id, null);
  assert.equal(rejected.lease_owner, null);
  assert.equal(f.db.prepare('SELECT count(*) n FROM author_resolution_success_receipts').get().n, 0);
  const audit = f.db.prepare("SELECT target_id,status,message FROM audits WHERE status='warning'").get();
  assert.equal(audit.target_id, targetBefore.id);
  assert.match(audit.message, /人工核查/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM snapshots').get().n, 0);
  const after = f.captureAll();
  assert.throws(() => f.run(), { code: 'AUTHORISED_ADMISSION_NOT_ELIGIBLE' });
  assert.equal(f.captureAll(), after, '原始冲突不得无新证据时反复入库或覆写拒绝记录');
});

test('service peer: failed warning audit rolls back strict-ID rejection and keeps the old target intact', t => {
  const f = fixture(t), at = new Date().toISOString();
  f.db.prepare("INSERT INTO targets(type,label,locator,provider,enabled,metadata_json,created_at,updated_at) VALUES('account','用户维护名称',?,'public-web',1,?,?,?)")
    .run(SEC, JSON.stringify({ platform: 'douyin', douyinId: 'old_handle' }), at, at);
  f.db.exec("CREATE TEMP TRIGGER reject_conflict_audit BEFORE INSERT ON audits BEGIN SELECT RAISE(ABORT,'conflict-audit-failure'); END");
  const before = f.captureAll();
  assert.throws(() => f.run(), /conflict-audit-failure/);
  assert.equal(f.db.isTransaction, false);
  assert.equal(f.captureAll(), before, '队列拒绝、审查、既有账号、来源与历史必须整体回滚');
});

test('service peer: same-transaction expiry/version/owner faults restore every original persisted field', t => {
  for (const change of ['expiry', 'version', 'owner']) {
    const f = fixture(t), before = f.captureAll();
    assert.throws(() => f.run({ createInput: row => {
      if (change === 'expiry') f.db.prepare('UPDATE author_resolution_queue SET lease_until=? WHERE id=?').run('2000-01-01T00:00:00.000Z', f.current().id);
      if (change === 'version') f.db.prepare('UPDATE author_resolution_queue SET evidence_version=evidence_version+1 WHERE id=?').run(f.current().id);
      if (change === 'owner') f.db.prepare('UPDATE author_resolution_queue SET lease_owner=? WHERE id=?').run('new-worker', f.current().id);
      return f.input(row);
    } }), { code: 'AUTHORISED_ADMISSION_STALE' });
    assert.equal(f.db.prepare('SELECT count(*) n FROM targets').get().n, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM author_resolution_success_receipts').get().n, 0);
    assert.equal(f.captureAll(), before, `${change}: the simulated mutation belongs to the rolled-back outer transaction`);
    assert.equal(f.db.isTransaction, false);
  }
});

test('service peer: unavailable observation does not claim, mutate or create a target', t => {
  const f = fixture(t), before = f.current(), changes = f.db.prepare('SELECT total_changes() n').get().n;
  assert.deepEqual(f.run({ result: { status: 'unavailable' } }), { monitoringChanged: false, status: 'unavailable' });
  assert.deepEqual(f.current(), before); assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
});

test('service peer: fresh exact proof reconsiders only the selected exhausted transport row and preserves original evidence', t => {
  for (const [code, error] of exhaustedErrors) {
    const f = fixture(t), sibling = f.sibling(), old = f.rejectNetwork(error), sources = f.capture();
    const result = f.run();
    assert.equal(result.status, 'committed'); assert.equal(result.monitoringChanged, true);
    assert.equal(f.db.isTransaction, false);
    const current = f.current();
    assert.equal(current.status, 'resolved'); assert.equal(current.last_error, null);
    assert.equal(current.attempts, old.attempts); assert.equal(current.evidence_version, old.evidence_version);
    assert.equal(current.next_attempt_at, old.next_attempt_at, 'admission is not a reset of the automatic retry budget');
    assert.equal(current.lease_owner, null); assert.equal(current.lease_until, null);
    assert.deepEqual(f.capture(), sources);
    assert.deepEqual(f.db.prepare('SELECT * FROM author_resolution_queue WHERE id=?').get(sibling.id), sibling);
    const receipt = f.db.prepare('SELECT * FROM author_resolution_success_receipts WHERE queue_id=?').get(old.id);
    assert.ok(validatedSuccessProof(receipt));
    const prior = JSON.parse(receipt.payload_json).resolution.authorisedDetailReceipt.previousTransportOutcome;
    assert.deepEqual(prior, { status: 'rejected', attempts: old.attempts, errorCode: code, errorSha256: rawHash(error) });
    assert.doesNotMatch(JSON.stringify(result), /SENSITIVE_PEER_TOKEN|达到公开核验重试上限/);
    assert.doesNotMatch(receipt.payload_json, /SENSITIVE_PEER_TOKEN|达到公开核验重试上限/);
    const activity = f.db.prepare("SELECT * FROM activity_log WHERE action='author-resolution.authorised-reconsideration'").all();
    assert.equal(activity.length, 1);
    assert.deepEqual(JSON.parse(activity[0].details_json).previous, { status: old.status, attempts: old.attempts,
      lastError: old.last_error, nextAttemptAt: old.next_attempt_at, evidenceVersion: old.evidence_version });
    assert.equal(f.db.prepare('SELECT count(*) n FROM snapshots').get().n, 0);
    const committedState = f.captureAll();
    assert.throws(() => f.run(), { code: 'AUTHORISED_ADMISSION_NOT_ELIGIBLE' });
    assert.equal(f.captureAll(), committedState, 'repeat admission neither appends nor replaces the immutable success proof');
  }
});

test('service peer: old transport rejection is fully restored after each early and late atomic failure', t => {
  for (const failure of ['normalizer', 'locator', 'expiry', 'version', 'owner', 'receipt', 'audit', 'readback']) {
    const f = fixture(t); f.sibling(); f.rejectNetwork();
    if (failure === 'receipt' || failure === 'audit') {
      const table = failure === 'receipt' ? 'author_resolution_success_receipts' : 'audits';
      f.db.exec(`CREATE TEMP TRIGGER peer_late_failure BEFORE INSERT ON ${table}
        BEGIN SELECT RAISE(ABORT, 'peer-late-atomic-failure'); END`);
    }
    const before = f.captureAll(), originalReadback = f.database.getTarget;
    if (failure === 'readback') f.database.getTarget = () => { throw new Error('peer-readback-failure'); };
    try {
      assert.throws(() => f.run({ createInput: row => {
        assert.equal(f.current().status, 'retry', 'temporary reconsideration exists only inside the write transaction');
        assert.equal(f.db.isTransaction, true);
        if (failure === 'normalizer') throw new Error('peer-normalizer-failure');
        if (failure === 'expiry') f.db.prepare('UPDATE author_resolution_queue SET lease_until=? WHERE id=?').run('2000-01-01T00:00:00.000Z', f.current().id);
        if (failure === 'version') f.db.prepare('UPDATE author_resolution_queue SET evidence_version=evidence_version+1 WHERE id=?').run(f.current().id);
        if (failure === 'owner') f.db.prepare('UPDATE author_resolution_queue SET lease_owner=? WHERE id=?').run('new-worker', f.current().id);
        return { ...f.input(row), ...(failure === 'locator' ? { locator: 'MS4wLjABAAAADifferentAuthor0000001' } : {}), boards: ['peer-rollback-board'] };
      } }), failure === 'locator' ? { code: 'AUTHORISED_ADMISSION_INVALID' }
        : ['expiry', 'version', 'owner'].includes(failure) ? { code: 'AUTHORISED_ADMISSION_STALE' }
          : /peer-(?:normalizer|late-atomic|readback)-failure/);
    } finally { f.database.getTarget = originalReadback; }
    assert.equal(f.db.isTransaction, false, failure);
    assert.equal(f.captureAll(), before, `${failure}: queue, original errors, retry time, source, target, boards, receipt and both ledgers must roll back`);
  }
});

test('service peer: unavailable or invalid fresh proof never clears an exhausted original rejection', t => {
  for (const failure of ['unavailable', 'wrong-author', 'stale']) {
    const f = fixture(t); f.rejectNetwork(); const before = f.captureAll(), p = f.proof();
    if (failure === 'unavailable') assert.deepEqual(f.run({ result: { status: 'unavailable' } }), { status: 'unavailable', monitoringChanged: false });
    else {
      if (failure === 'wrong-author') p.result.candidate.uniqueId = 'other_handle';
      if (failure === 'stale') p.result.evidence.observedAt = '2000-01-01T00:00:00.000Z';
      assert.throws(() => commitAuthorisedImportDetail(f.database, f.job, { sourceRow: 682 }, p.result,
        { startedAt: p.startedAt, finishedAt: p.finishedAt, createInput: f.input }));
    }
    assert.equal(f.captureAll(), before); assert.equal(f.db.isTransaction, false);
  }
});

test('service peer: transport marker never overrides identity, lifecycle or manual-pause rejection', t => {
  for (const reason of ['identity_mismatch', 'multiple_owners', 'status_deleted', 'author_secret', '人工暂停', 'access_gate']) {
    const f = fixture(t);
    f.rejectNetwork(`达到公开核验重试上限；${reason === 'access_gate' ? '' : 'HTTP 403；'}${reason}`);
    const before = f.captureAll();
    assert.throws(() => f.run(), { code: 'AUTHORISED_ADMISSION_NOT_ELIGIBLE' });
    assert.equal(f.captureAll(), before); assert.equal(f.db.isTransaction, false);
  }
});

test('service peer: a previous success receipt forbids reconsideration even when later row fields look transport-rejected', t => {
  const f = fixture(t); f.run();
  f.db.prepare('UPDATE author_resolution_queue SET resolved_target_id=NULL WHERE id=?').run(f.current().id);
  f.rejectNetwork(); const before = f.captureAll();
  assert.throws(() => f.run(), { code: 'AUTHORISED_ADMISSION_NOT_ELIGIBLE' });
  assert.equal(f.captureAll(), before); assert.equal(f.db.isTransaction, false);
});

test('service peer: access overview does not export the restricted original transport error in either activity representation', t => {
  const f = fixture(t); f.rejectNetwork(); f.run();
  // listAccess is the data boundary used by the administrator GET /api/access.
  const overview = f.database.listAccess();
  const activity = overview.activity.find(row => row.action === 'author-resolution.authorised-reconsideration');
  assert.ok(activity, 'a sanitized activity remains available to administrators');
  assert.doesNotMatch(JSON.stringify(overview), /SENSITIVE_PEER_TOKEN|达到公开核验重试上限/);
  assert.equal(activity.details.errorCode, 'exhausted_http_403');
});
