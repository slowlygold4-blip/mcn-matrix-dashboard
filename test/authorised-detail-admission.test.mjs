import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorDatabase } from '../lib/database.mjs';
import { buildAuthorEvidenceRequests } from '../lib/author-resolution.mjs';
import { prepareAuthorisedDetailAdmission } from '../lib/authorised-detail-admission.mjs';
import { AUTHORISED_DETAIL_PROVENANCE, AUTHORISED_DETAIL_HASH_SCOPE, AUTHORISED_DETAIL_FINAL_URL_SCOPE } from '../lib/douyin-authorised-detail.mjs';

const SEC = 'MS4wLjABAAAAfixtureAuthorisedAdmission12345';
const VIDEO = '7686424948055891786', OTHER = '7694337592909444442';
const ACCOUNT = '80336194274', UID = '3206642319507007';
const SHARE = 'https://v.douyin.com/ExactCaseToken/';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
function fixture({ share = false } = {}) {
  const time = Date.now() - 5000, iso = offset => new Date(time + offset).toISOString();
  const source = { sourceRow: 682, platform: 'douyin', name: '原表作者', douyinId: ACCOUNT,
    locator: '', videoId: share ? '' : VIDEO, videoLink: share ? SHARE : `https://www.douyin.com/video/${VIDEO}`,
    videoHyperlink: '', contentId: '', shareUrl: share ? SHARE : '', status: 'resolvable', identityConflict: '',
    boards: [{ name: '团团', sourceRow: 682 }] };
  const job = { id: 'original-completed-job', status: 'completed', fileName: '原表.xlsx', sheetName: '作者', request: { rows: [source] } };
  const request = buildAuthorEvidenceRequests([source])[0];
  const response = { status_code: 0, aweme_detail: { aweme_id: VIDEO,
    author: { sec_uid: SEC, uid: UID, unique_id: ACCOUNT, short_id: ACCOUNT } } };
  const responseSha256 = hash(response), observedAt = iso(1000);
  const candidate = { videoId: VIDEO, secUid: SEC, uid: UID, uniqueId: ACCOUNT, shortId: ACCOUNT,
    provenance: AUTHORISED_DETAIL_PROVENANCE, observedAt, responseSha256, responseSha256Scope: AUTHORISED_DETAIL_HASH_SCOPE };
  const result = { key: request.key, submittedId: ACCOUNT, status: 'ok', videoId: VIDEO,
    ...(share ? { shareUrl: SHARE } : {}), requestStartedAt: iso(100), requestFinishedAt: iso(2000), candidate,
    evidence: { version: 1, kind: 'natural-main-frame-detail-response', origin: 'https://www.douyin.com',
      path: '/aweme/v1/web/aweme/detail/', method: 'GET', httpStatus: 200, requestedVideoId: VIDEO,
      observedAt, responseSha256, responseSha256Scope: AUTHORISED_DETAIL_HASH_SCOPE, response,
      ...(share ? { requestedShareUrl: SHARE, finalVideoId: VIDEO, finalUrl: `https://www.douyin.com/video/${VIDEO}`,
        finalUrlSha256: createHash('sha256').update(`https://www.douyin.com/video/${VIDEO}?tracking=fixture`).digest('hex'),
        finalUrlScope: AUTHORISED_DETAIL_FINAL_URL_SCOPE } : {}) },
    provenance: { mode: AUTHORISED_DETAIL_PROVENANCE, authorisedSessionUsed: true, authenticated: null,
      authenticationStatus: 'not-verified', noChallengeBypass: true, runtimeAI: false, paidAPI: false } };
  const queueItem = { id: 1, identity_key: request.key, status: 'retry', douyin_id: ACCOUNT,
    evidence_version: 1, verification_policy_version: 2, lease_owner: 'fixture-owner', lease_until: iso(65000),
    resolved_target_id: null, suspended_target_enabled: null, account_locator: '',
    file_name: job.fileName, sheet_name: job.sheetName, video_ids_json: JSON.stringify(request.videoIds),
    share_urls_json: JSON.stringify(request.shareUrls), source_rows_json: '[681,682]' };
  return { job, sourceRow: 682, queueItem, result, startedAt: iso(0), finishedAt: iso(2100), reference: new Date(time + 3000), owner: 'fixture-owner' };
}

test('单作品通过原 all-evidence verifier，保留真实时间、原任务行和完整自然身份回执', () => {
  const input = fixture(), before = clone(input), output = prepareAuthorisedDetailAdmission(input);
  assert.equal(output.verifiedRow.status, 'ready');
  assert.equal(output.verifiedRow.sourceRow, 682);
  assert.equal(output.verifiedRow.locator, SEC);
  assert.equal(output.verifiedRow.resolution.resolvedAt, input.result.evidence.observedAt);
  assert.equal(output.verifiedRow.resolution.verificationPolicy, 'all-submitted-evidence-v2');
  assert.equal(output.verifiedRow.resolution.verifiedEvidenceCount, 1);
  assert.equal(output.verifiedRow.resolution.verifiedEvidence[0].sourceRow, 682, '不能将合并队列较早的681行伪称本次来源');
  assert.deepEqual(output.receipt.queue.sourceRows, [681, 682]);
  assert.equal(output.receipt.source.sourceRowSha256, hash(input.job.request.rows[0]));
  assert.deepEqual(output.verifiedRow.resolution.authorisedDetailReceipt, output.receipt);
  assert.deepEqual(output.expected, { queueId: 1, owner: input.owner, evidenceVersion: 1 });
  assert.equal(output.receipt.identityOnly, true);
  assert.equal(output.receipt.metricsSampled, false);
  assert.equal(output.receipt.allAccountWorksCollected, false);
  assert.deepEqual(input, before);
});

test('任何多作品/额外share/证据不一致必须拒绝，不能一项成功覆盖多项队列', () => {
  for (const mutation of [
    q => { q.video_ids_json = JSON.stringify([VIDEO, OTHER]); },
    q => { q.video_ids_json = JSON.stringify([OTHER]); },
    q => { q.video_ids_json = '[]'; },
    q => { q.share_urls_json = JSON.stringify([SHARE]); },
    q => { q.videoIds = [OTHER]; },
    q => { q.shareUrls = [SHARE]; },
    q => { q.sourceRows = [681]; },
    q => { q.source_rows_json = '[681]'; },
    q => { q.source_rows_json = '["682"]'; },
  ]) { const input = fixture(); mutation(input.queueItem); assert.throws(() => prepareAuthorisedDetailAdmission(input)); }
});

test('拒绝终结/暂停/人工暂停关联/无效owner/失效租约，内容版本1可合法使用策略2', () => {
  for (const mutation of [
    q => { q.status = 'rejected'; }, q => { q.status = 'resolved'; },
    q => { q.suspended_target_enabled = 0; }, q => { q.suspended_target_enabled = 1; },
    q => { q.resolved_target_id = 123; }, q => { q.lease_owner = 'other'; },
    q => { q.lease_until = 'bad-date'; }, q => { q.lease_until = '2000-01-01T00:00:00.000Z'; },
    q => { q.evidence_version = 0; }, q => { q.evidence_version = 1.5; }, q => { q.verification_policy_version = 1; },
  ]) { const input = fixture(); mutation(input.queueItem); assert.throws(() => prepareAuthorisedDetailAdmission(input)); }
  const exact = fixture(); exact.queueItem.lease_until = exact.reference.toISOString();
  assert.throws(() => prepareAuthorisedDetailAdmission(exact));
  assert.equal(prepareAuthorisedDetailAdmission(fixture()).expected.evidenceVersion, 1);
});

test('文件/表/任务/源行/key/提交ID/canonical必须一致，不采用nickname或数值uid兜底', () => {
  for (const mutation of [
    q => { q.file_name = '其他.xlsx'; }, q => { q.sheet_name = '其他'; },
    q => { q.identity_key = 'another-key'; }, q => { q.douyin_id = 'other-account'; },
    q => { q.account_locator = SEC; },
  ]) { const input = fixture(); mutation(input.queueItem); assert.throws(() => prepareAuthorisedDetailAdmission(input)); }
  const conflicting = fixture(); conflicting.job.file_name = '不同文件.xlsx'; assert.throws(() => prepareAuthorisedDetailAdmission(conflicting));
  const noJob = fixture(); delete noJob.job.id; assert.throws(() => prepareAuthorisedDetailAdmission(noJob));
  const numericOnly = fixture();
  const author = numericOnly.result.evidence.response.aweme_detail.author;
  author.unique_id = 'someone-else'; author.short_id = '1234'; author.uid = ACCOUNT;
  numericOnly.result.candidate = { ...numericOnly.result.candidate, uniqueId: author.unique_id, shortId: author.short_id, uid: author.uid,
    responseSha256: hash(numericOnly.result.evidence.response) };
  numericOnly.result.evidence.responseSha256 = numericOnly.result.candidate.responseSha256;
  assert.throws(() => prepareAuthorisedDetailAdmission(numericOnly));
});

test('证明hash、work回显、canonical、捕获区间与30分钟新鲜度逐一校验', () => {
  for (const mutate of [
    f => { f.result.candidate.responseSha256 = 'a'.repeat(64); },
    f => { f.result.evidence.response.aweme_detail.aweme_id = OTHER; },
    f => { f.result.candidate.secUid = 'MS4wLjABAAAAotherCanonicalIdentity0000'; },
    f => { f.result.evidence.observedAt = new Date(f.reference.getTime() + 10000).toISOString(); },
    f => { f.reference = new Date(f.reference.getTime() - 60000); },
    f => { f.reference = new Date(f.reference.getTime() + 31 * 60000); f.queueItem.lease_until = new Date(f.reference.getTime() + 60000).toISOString(); },
    f => { f.result = { ...f.result, status: 'unavailable', errorCode: 'blocked', candidate: undefined, evidence: undefined }; },
  ]) { const input = fixture(); mutate(input); assert.throws(() => prepareAuthorisedDetailAdmission(input)); }
});

test('仅保留validator的公开投影，不保留结果里的额外追踪URL/秘密', () => {
  const input = fixture();
  input.result.extra = 'PRIVATE_TEST'; input.result.candidate.cookie = 'PRIVATE_TEST';
  input.result.evidence.headers = { cookie: 'PRIVATE_TEST' }; input.result.provenance.secret = 'PRIVATE_TEST';
  assert.doesNotMatch(JSON.stringify(prepareAuthorisedDetailAdmission(input)), /PRIVATE_TEST|cookie/);
});

test('合法空工作表名称可以精确对应来源，但缺失名称或冲突别名不能猜', () => {
  const input = fixture(); input.job.sheetName = ''; input.queueItem.sheet_name = '';
  assert.equal(prepareAuthorisedDetailAdmission(input).receipt.source.sheetName, '');
  input.job.sheet_name = '另一个表'; assert.throws(() => prepareAuthorisedDetailAdmission(input));
  delete input.job.sheet_name; delete input.job.sheetName;
  assert.throws(() => prepareAuthorisedDetailAdmission(input));
});

test('纯分享证据保留原短链和final投影，不伪造一个用户提交videoId', () => {
  const input = fixture({ share: true }), output = prepareAuthorisedDetailAdmission(input);
  assert.equal(output.verifiedRow.videoId, '');
  assert.equal(output.verifiedRow.shareUrl, SHARE);
  assert.equal(output.verifiedRow.resolution.sourceEvidenceUrl, SHARE);
  assert.equal(output.verifiedRow.resolution.evidenceVideoId, VIDEO);
  assert.deepEqual(output.receipt.queue.videoIds, []);
  assert.deepEqual(output.receipt.queue.shareUrls, [SHARE]);
  assert.equal(output.receipt.evidence.finalVideoId, VIDEO);
  assert.equal(output.receipt.evidence.finalUrl, `https://www.douyin.com/video/${VIDEO}`);
  assert.equal(output.receipt.evidence.requestedShareUrl, SHARE);
  assert.equal(output.verifiedRow.resolution.verifiedEvidence[0].sourceEvidenceUrl, SHARE);
});

test('纯分享回执拒绝缺失/错误跳转来源，不能套给第二短链或掺入直链work', () => {
  for (const mutate of [
    f => { f.result.evidence.requestedShareUrl = 'https://v.douyin.com/OtherToken/'; },
    f => { f.result.evidence.finalVideoId = OTHER; },
    f => { delete f.result.evidence.finalUrlSha256; },
    f => { f.queueItem.video_ids_json = JSON.stringify([VIDEO]); },
    f => { f.queueItem.share_urls_json = JSON.stringify([SHARE, 'https://v.douyin.com/OtherToken/']); },
  ]) { const input = fixture({ share: true }); mutate(input); assert.throws(() => prepareAuthorisedDetailAdmission(input)); }
});

function databaseFixture(t, { paused = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'authorised-admission-'));
  const db = new MonitorDatabase(join(directory, 'fixture.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const input = fixture();
  if (paused) { const target = db.createTarget({ type: 'account', label: '手动暂停', locator: SEC, provider: 'public-web', metadata: { platform: 'douyin' } }); db.db.prepare('UPDATE targets SET enabled=0 WHERE id=?').run(target.id); }
  db.enqueueAuthorResolutions(buildAuthorEvidenceRequests(input.job.request.rows), { fileName: input.job.fileName, sheetName: input.job.sheetName });
  input.queueItem = db.claimDueAuthorResolutions(1, { owner: input.owner })[0];
  input.reference = new Date();
  const admission = prepareAuthorisedDetailAdmission(input);
  const commit = () => db.commitAuthorResolutionTarget(admission.expected.queueId, { label: admission.verifiedRow.name,
    locator: admission.verifiedRow.locator, boards: admission.verifiedRow.boards,
    metadata: { platform: 'douyin', douyinId: ACCOUNT, resolution: admission.verifiedRow.resolution } },
  { fileName: input.job.fileName, sheetName: input.job.sheetName }, { owner: input.owner, evidenceVersion: admission.expected.evidenceVersion, requireUnexpiredLease: true });
  return { db, input, admission, commit };
}

test('临时SQLite沿用真实queue claim和commit原子落不可变成功回执，第二次不重复', t => {
  const f = databaseFixture(t), before = clone(f.input.job), result = f.commit();
  assert.equal(result.created, true); assert.equal(result.target.enabled, true);
  const saved = f.db.db.prepare('SELECT payload_json,receipt_sha256 FROM author_resolution_success_receipts').get();
  const proof = JSON.parse(saved.payload_json);
  assert.equal(hash(proof), saved.receipt_sha256);
  assert.deepEqual(proof.resolution.authorisedDetailReceipt, f.admission.receipt);
  assert.equal(proof.verifiedAt, f.input.result.evidence.observedAt);
  assert.equal(f.db.db.prepare('SELECT count(*) n FROM snapshots').get().n, 0);
  assert.equal(f.commit(), null);
  assert.equal(f.db.db.prepare('SELECT count(*) n FROM author_resolution_success_receipts').get().n, 1);
  assert.deepEqual(f.input.job, before);
});

test('临时SQLite既有手动暂停target保持暂停，过时证据版本CAS不能新建target', t => {
  const paused = databaseFixture(t, { paused: true });
  const result = paused.commit(); assert.equal(result.created, false); assert.equal(result.target.enabled, false);
  const stale = databaseFixture(t);
  stale.db.db.prepare('UPDATE author_resolution_queue SET evidence_version=evidence_version+1 WHERE id=?').run(stale.input.queueItem.id);
  assert.equal(stale.commit(), null);
  assert.equal(stale.db.db.prepare('SELECT count(*) n FROM targets').get().n, 0);
});
