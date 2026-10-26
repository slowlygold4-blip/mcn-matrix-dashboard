import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { MonitorDatabase } from '../lib/database.mjs';
import { buildAuthorEvidenceRequests } from '../lib/author-resolution.mjs';
import { buildMasterRosterSnapshot, installMasterRoster, readMasterRoster } from '../lib/master-roster.mjs';
import { prepareMasterRosterSupplement, assertMasterRosterSupplementJob,
  masterRosterSupplementRequestSha256 } from '../lib/master-roster-supplement.mjs';
import { runQueuedAuthorisedImport } from '../lib/authorised-import-queue.mjs';

const ORIGINAL = 'misspelled_peer', CORRECTED = 'corrected_peer', VIDEO = '7690702905876096104';
const SEC = 'MS4wLjABAAAAIdCorrectionPeerAuthor001', UID = '1234567890123456', BOOK = 'a'.repeat(64);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function base(t, overrides = {}) {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const db = database.db;
  const entity = { key: 'submitted:douyin:correction-peer', targetId: null, platform: 'douyin',
    names: ['保留原始作者名称'], ids: [ORIGINAL], locators: [],
    sources: [{ title: '不可改写原表', file: 'original.xlsx', rows: ['12'] }],
    boards: [{ name: '一条小团团切片矩阵', category: '切片' }],
    classification: { theme: { key: 'tuantuan', label: '团团' }, labels: [{ key: 'slice', label: '切片' }] }, ...overrides };
  const build = book => buildMasterRosterSnapshot({ exportedAt: '2026-10-02T19:01:23.853Z', entities: [entity] },
    { sha256: book, fileName: '总表.xlsx' });
  const snapshot = build(BOOK); installMasterRoster(db, snapshot);
  const frozen = () => db.prepare('SELECT * FROM master_roster_entries ORDER BY import_id,entry_key').all();
  const input = { workbookSha256: BOOK, entryKey: snapshot.items[0].key,
    evidence: `https://www.douyin.com/video/${VIDEO}`, correctedAccountId: CORRECTED };
  return { database, db, snapshot, input, frozen, replaceWorkbook: () => installMasterRoster(db, build('b'.repeat(64))) };
}
async function fixture(t) {
  const f = base(t), prepared = await prepareMasterRosterSupplement(f.db, f.input);
  assert.equal(prepared.masterRosterSupplement.version, 2);
  const request = { fileName: prepared.fileName, sheetName: prepared.sheetName, rows: prepared.rows,
    boardCatalog: prepared.boardCatalog, masterRosterSupplement: prepared.masterRosterSupplement };
  const jobId = randomUUID(), evidence = buildAuthorEvidenceRequests(request.rows)[0];
  f.database.createAuthorResolutionJob({ id: jobId, actorName: '独立离线测试', fileName: request.fileName, sheetName: request.sheetName, request });
  f.db.prepare('UPDATE author_resolution_jobs SET created_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), jobId);
  f.database.enqueueAuthorResolutions([evidence], { fileName: request.fileName, sheetName: request.sheetName,
    sourceMetadata: { sourceType: 'author-spreadsheet' } });
  const result = { ok: true, created: [], skipped: [{ ...request.rows[0], status: 'unresolved', evidenceRequestKeys: [evidence.key] }],
    queuedEvidenceRequestCount: 1, queue: { pendingEvidenceRequestKeys: [evidence.key] } };
  f.db.prepare("UPDATE author_resolution_jobs SET status='completed',finished_at=?,result_json=? WHERE id=?")
    .run(new Date().toISOString(), JSON.stringify(result), jobId);
  const job = f.database.getAuthorResolutionJob(jobId), owner = 'id-correction-peer-owner';
  const claimed = f.database.claimDueAuthorResolutions(1, { owner, leaseMs: 60000 })[0];
  assert.ok(claimed);
  const createInput = (_job, row) => ({ type: 'account', provider: 'public-web', label: row.name, locator: row.locator,
    metadata: { platform: 'douyin', resolution: row.resolution }, boards: row.boards });
  const proof = (input, handle = CORRECTED) => {
    const at = new Date().toISOString(), response = { status_code: 0, aweme_detail: { aweme_id: VIDEO,
      author: { sec_uid: SEC, uid: UID, unique_id: handle } } };
    const responseSha256 = hash(response), responseSha256Scope = 'public-identity-projection-v1';
    return { status: 'ok', ...input, requestStartedAt: at, requestFinishedAt: at,
      candidate: { videoId: VIDEO, secUid: SEC, uid: UID, uniqueId: handle, shortId: '',
        provenance: 'authorised-browser-natural-detail', observedAt: at, responseSha256, responseSha256Scope },
      evidence: { version: 1, kind: 'natural-main-frame-detail-response', origin: 'https://www.douyin.com',
        path: '/aweme/v1/web/aweme/detail/', method: 'GET', httpStatus: 200, requestedVideoId: VIDEO,
        observedAt: at, responseSha256, responseSha256Scope, response },
      provenance: { mode: 'authorised-browser-natural-detail', authorisedSessionUsed: true, authenticated: null,
        authenticationStatus: 'not-verified', noChallengeBypass: true, runtimeAI: false, paidAPI: false } };
  };
  const run = (provider, inputNormalizer = createInput) => runQueuedAuthorisedImport(f.database, claimed, { owner, createInput: inputNormalizer,
    provider: { resolveAuthorisedDetail: provider ?? (async ({ items: [input] }) => proof(input)) } });
  const item = () => readMasterRoster(f.db).items.find(row => row.key === f.snapshot.items[0].key);
  return { ...f, prepared, request, result, job, owner, claimed, proof, run, item };
}

test('ID correction peer: preview is explicit, single frozen Douyin ID only, and does not edit original rows', async t => {
  const f = base(t), before = f.frozen(), p = await prepareMasterRosterSupplement(f.db, f.input);
  assert.equal(p.masterRosterSupplement.version, 2);
  assert.deepEqual(p.masterRosterSupplement.correction, { originalAccountId: ORIGINAL, correctedAccountId: CORRECTED });
  assert.equal(p.preview.requiresCorrectionConfirmation, true);
  assert.deepEqual(p.preview.correction, p.masterRosterSupplement.correction);
  assert.equal(p.rows[0].douyinId, CORRECTED); assert.deepEqual(f.frozen(), before);
  for (const overrides of [{ ids: [] }, { ids: [ORIGINAL, 'second_id'] }, { locators: [SEC] },
    { platform: 'bilibili' }, { errors: ['作者身份冲突：多个不同作者'] }]) {
    const invalid = base(t, overrides);
    await assert.rejects(() => prepareMasterRosterSupplement(invalid.db, invalid.input));
  }
});

test('ID correction peer: context tampering and v1 downgrade cannot turn a corrected ID into unconfirmed original identity', async t => {
  const f = await fixture(t), before = f.frozen();
  for (const change of [
    job => { job.request.masterRosterSupplement.correction.originalAccountId = 'different_original'; },
    job => { job.request.masterRosterSupplement.correction.correctedAccountId = 'different_corrected'; },
    job => { job.request.masterRosterSupplement.correction.extra = true; },
    job => { job.request.masterRosterSupplement.extra = true; },
    job => { job.request.masterRosterSupplement.evidence = 'https://www.douyin.com/video/7690702905876096105'; },
    job => { job.request.masterRosterSupplement.evidence = 'https://foreign.example/private?token=[REDACTED]'; },
    job => { job.request.masterRosterSupplement.version = 1; },
    job => { job.request.masterRosterSupplement.version = 1; delete job.request.masterRosterSupplement.correction; },
    job => { job.request.rows[0].douyinId = 'different_corrected';
      job.request.masterRosterSupplement.requestSha256 = masterRosterSupplementRequestSha256(job.request); },
  ]) {
    const changed = structuredClone(f.job); change(changed);
    assert.throws(() => assertMasterRosterSupplementJob(f.db, changed));
  }
  assert.deepEqual(f.frozen(), before);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM targets').get().n, 0);
});

test('ID correction peer: a workbook change while the fresh proof is awaiting prevents admission atomically', async t => {
  const f = await fixture(t), originalJob = f.db.prepare('SELECT * FROM author_resolution_jobs WHERE id=?').get(f.job.id);
  const before = f.frozen();
  const result = await f.run(async ({ items: [input] }) => { const proof = f.proof(input); f.replaceWorkbook(); return proof; });
  assert.equal(result.status, 'unavailable'); assert.equal(result.monitoringChanged, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM targets').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM author_resolution_success_receipts').get().n, 0);
  assert.deepEqual(f.db.prepare('SELECT * FROM author_resolution_jobs WHERE id=?').get(f.job.id), originalJob);
  assert.deepEqual(f.frozen().slice(0, before.length), before); assert.equal(f.db.isTransaction, false);
});

test('ID correction peer: one fresh exact source-bound proof links the view, keeps originals and refuses a second different correction', async t => {
  const f = await fixture(t), frozen = f.frozen(), originalJob = f.db.prepare('SELECT * FROM author_resolution_jobs WHERE id=?').get(f.job.id);
  const result = await f.run();
  assert.equal(result.status, 'resolved'); assert.equal(f.item().targetId, result.admission.target.id);
  assert.equal(f.item().monitorStatus, 'enabled');
  assert.deepEqual(f.item().accountIds, [ORIGINAL]); assert.deepEqual(f.item().originalAccountIds, [ORIGINAL]);
  assert.deepEqual(f.item().identityCorrection, { originalAccountId: ORIGINAL, correctedAccountId: CORRECTED, status: 'verified' });
  assert.deepEqual(f.frozen(), frozen);
  assert.deepEqual(f.db.prepare('SELECT * FROM author_resolution_jobs WHERE id=?').get(f.job.id), originalJob);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM snapshots').get().n, 0);
  await assert.rejects(() => prepareMasterRosterSupplement(f.db, { ...f.input, correctedAccountId: 'another_id' }));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM targets').get().n, 1);
});

test('ID correction peer: exact author evidence cannot silently re-enable an existing manually paused target', async t => {
  const f = await fixture(t), at = new Date().toISOString();
  f.db.prepare(`INSERT INTO targets(type,label,locator,provider,enabled,metadata_json,created_at,updated_at)
    VALUES('account','手动暂停','${SEC}','public-web',0,?,?,?)`).run('{"platform":"douyin","note":"keep"}', at, at);
  const id = f.db.prepare('SELECT id FROM targets').get().id;
  f.db.prepare(`INSERT INTO activity_log(actor_name,action,resource_type,resource_id,created_at,details_json)
    VALUES('管理员','target.state','target',?,?,?)`).run(String(id), at, '{"enabled":false,"source":"manual"}');
  const result = await f.run();
  assert.equal(result.status, 'resolved'); assert.equal(result.admission.target.id, id);
  assert.equal(f.item().monitorStatus, 'paused'); assert.equal(f.item().targetId, id);
  assert.equal(f.db.prepare('SELECT enabled FROM targets WHERE id=?').get(id).enabled, 0);
  assert.equal(JSON.parse(f.db.prepare('SELECT metadata_json FROM targets WHERE id=?').get(id).metadata_json).note, 'keep');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action='target.state'").get().n, 1);
});

test('ID correction peer: forged legacy job success receipt cannot stand in for a strict new corrected-ID proof', async t => {
  const f = await fixture(t), at = new Date().toISOString();
  f.db.prepare(`INSERT INTO targets(type,label,locator,provider,enabled,metadata_json,created_at,updated_at)
    VALUES('account','unverified','${SEC}','public-web',1,?,?,?)`).run('{"platform":"douyin"}', at, at);
  const targetId = f.db.prepare('SELECT id FROM targets').get().id, c = f.request.masterRosterSupplement;
  const forged = { version: 1, jobId: f.job.id, workbookSha256: c.workbookSha256, entryKey: c.entryKey,
    entryPayloadSha256: c.entryPayloadSha256, requestSha256: c.requestSha256, targetId, platform: 'douyin',
    locator: SEC, proofType: 'strict-public-work-evidence', verifiedAt: at };
  f.db.prepare('UPDATE author_resolution_jobs SET result_json=? WHERE id=?')
    .run(JSON.stringify({ ...f.result, created: [{ id: targetId, locator: SEC }], masterRosterSupplementReceipt: forged }), f.job.id);
  assert.equal(f.item().targetId, null);
  assert.notEqual(f.item().identityCorrection?.status, 'verified');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM author_resolution_success_receipts').get().n, 0);
});

test('ID correction peer: wrong original-ID response cannot satisfy corrected-ID admission', async t => {
  const f = await fixture(t), result = await f.run(async ({ items: [input] }) => f.proof(input, ORIGINAL));
  assert.equal(result.status, 'unavailable'); assert.equal(result.monitoringChanged, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM targets').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM author_resolution_success_receipts').get().n, 0);
});

test('ID correction peer: rehashed success receipts with absent or different-job natural evidence never bind frozen source', async t => {
  for (const mutate of [
    proof => { delete proof.resolution.authorisedDetailReceipt; },
    proof => { proof.resolution.authorisedDetailReceipt.source.jobId = 'unrelated-original-job'; },
    proof => { proof.resolution.authorisedDetailReceipt.source.sourceRow = 999; },
    proof => { proof.resolution.authorisedDetailReceipt.source.sourceRowSha256 = '0'.repeat(64); },
    proof => { proof.resolution.authorisedDetailReceipt.source.evidenceRequestKey = 'unrelated-key'; },
    proof => { proof.resolution.authorisedDetailReceipt.observedAt = '2020-01-01T00:00:00.000Z'; },
  ]) {
    const f = await fixture(t); assert.equal((await f.run()).status, 'resolved');
    const saved = f.db.prepare('SELECT * FROM author_resolution_success_receipts').get();
    const proof = JSON.parse(saved.payload_json); mutate(proof);
    f.db.prepare('UPDATE author_resolution_success_receipts SET payload_json=?,receipt_sha256=? WHERE id=?')
      .run(JSON.stringify(proof), hash(proof), saved.id);
    assert.equal(f.item().targetId, null, 'a self-consistent outer checksum does not prove the corrected source');
    assert.notEqual(f.item().identityCorrection?.status, 'verified');
  }
});

test('ID correction peer: coherent historical evidence predating the new source job cannot be replayed as a fresh correction', async t => {
  const f = await fixture(t); assert.equal((await f.run()).status, 'resolved');
  const saved = f.db.prepare('SELECT * FROM author_resolution_success_receipts').get();
  const proof = JSON.parse(saved.payload_json), natural = proof.resolution.authorisedDetailReceipt;
  const old = new Date(Date.parse(f.job.createdAt) - 60_000).toISOString();
  proof.verifiedAt = old; proof.resolution.resolvedAt = old;
  natural.observedAt = old; natural.requestStartedAt = old; natural.requestFinishedAt = old;
  natural.evidence.observedAt = old;
  f.db.prepare('UPDATE author_resolution_success_receipts SET payload_json=?,receipt_sha256=?,verified_at=? WHERE id=?')
    .run(JSON.stringify(proof), hash(proof), old, saved.id);
  assert.equal(f.item().targetId, null);
  assert.notEqual(f.item().identityCorrection?.status, 'verified');
});

test('ID correction peer: an exact completed preview can replay idempotently but a new job cannot replace the admitted binding', async t => {
  const f = await fixture(t); assert.equal((await f.run()).status, 'resolved');
  const frozen = f.frozen();
  const replay = await prepareMasterRosterSupplement(f.db, f.input);
  assert.deepEqual(replay.masterRosterSupplement, f.prepared.masterRosterSupplement);
  assert.doesNotThrow(() => assertMasterRosterSupplementJob(f.db, f.job));
  assert.throws(() => assertMasterRosterSupplementJob(f.db, { ...f.job, id: randomUUID() }));
  assert.deepEqual(f.frozen(), frozen);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM targets').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM author_resolution_success_receipts').get().n, 1);
});

test('ID correction peer: an existing exact account keeps its current label and all user metadata while renewing only the strict resolution', async t => {
  const f = await fixture(t), at = new Date().toISOString();
  const metadata = { platform: 'douyin', name: '用户确认名字', source: '保留原来源', sample: { followers: 1234, sampledAt: at },
    notes: ['用户备注', { pinned: true }], note: '单独备注', importSource: { fileName: '旧来源.xlsx', sheetName: '旧表', sourceRow: 9 },
    category: '用户分类', classification: { theme: 'tuantuan', labels: ['original'] }, custom: { nested: ['keep'] },
    resolution: { mode: 'old-proof', preservedInHistory: true } };
  f.db.prepare(`INSERT INTO targets(type,label,locator,provider,enabled,metadata_json,created_at,updated_at)
    VALUES('account','欣欣向荣1',?,'public-web',1,?,?,?)`).run(SEC, JSON.stringify(metadata), at, at);
  const id = f.db.prepare('SELECT id FROM targets').get().id;
  const result = await f.run(undefined, (_job, row) => ({ type: 'account', provider: 'public-web', label: '51058454595', locator: row.locator,
    boards: row.boards, metadata: { platform: 'douyin', name: '替换名字', source: '新来源不能覆盖', sample: { followers: 0 },
      notes: [], note: '', importSource: { fileName: '新更正.csv' }, category: '新分类', classification: {}, custom: null,
      resolution: row.resolution } }));
  assert.equal(result.status, 'resolved'); assert.equal(result.admission.created, false);
  assert.equal(result.admission.target.id, id); assert.equal(f.item().targetId, id);
  const saved = f.db.prepare('SELECT * FROM targets WHERE id=?').get(id), actual = JSON.parse(saved.metadata_json);
  assert.equal(saved.label, '欣欣向荣1'); assert.equal(saved.enabled, 1);
  const { resolution: beforeResolution, ...beforeUserValues } = metadata;
  const { resolution: freshResolution, ...afterUserValues } = actual;
  assert.deepEqual(afterUserValues, beforeUserValues); assert.notDeepEqual(freshResolution, beforeResolution);
  assert.equal(freshResolution.canonicalAccountId, SEC); assert.equal(freshResolution.publicDouyinId, CORRECTED);
  assert.equal(freshResolution.authorisedDetailReceipt.source.jobId, f.job.id);
  assert.equal(freshResolution.authorisedDetailReceipt.source.sourceRow, 2);
  const proof = JSON.parse(f.db.prepare('SELECT payload_json FROM author_resolution_success_receipts').get().payload_json);
  assert.deepEqual(proof.resolution, freshResolution);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM targets').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM snapshots').get().n, 0);
  assert.equal(f.item().identityCorrection.status, 'verified');
});

test('ID correction peer: same-canonical corrupt metadata or a different platform is rejected without mutation', async t => {
  for (const metadata of ['not-json', 'null', '[]', JSON.stringify({ platform: 'bilibili', note: 'keep' })]) {
    const f = await fixture(t), at = new Date().toISOString();
    f.db.prepare(`INSERT INTO targets(type,label,locator,provider,enabled,metadata_json,created_at,updated_at)
      VALUES('account','keep',?,'public-web',0,?,?,?)`).run(SEC, metadata, at, at);
    const before = f.db.prepare('SELECT * FROM targets').get();
    const result = await f.run();
    assert.equal(result.status, 'unavailable'); assert.equal(result.monitoringChanged, false);
    assert.deepEqual(f.db.prepare('SELECT * FROM targets').get(), before);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM author_resolution_success_receipts').get().n, 0);
    assert.equal(f.db.isTransaction, false);
  }
});
