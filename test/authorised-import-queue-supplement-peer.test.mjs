import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { MonitorDatabase } from '../lib/database.mjs';
import { buildAuthorEvidenceRequests } from '../lib/author-resolution.mjs';
import { buildMasterRosterSnapshot, installMasterRoster, readMasterRoster } from '../lib/master-roster.mjs';
import { prepareMasterRosterSupplement, assertMasterRosterSupplementJob } from '../lib/master-roster-supplement.mjs';
import { prepareQueuedAuthorisedImport, runQueuedAuthorisedImport } from '../lib/authorised-import-queue.mjs';

const VIDEO = '7690702905876096104', HANDLE = 'supplement_peer', SEC = 'MS4wLjABAAAASupplementPeerAuthor0001';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fixture(t) {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const db = database.db;
  const entity = { key: 'submitted:douyin:supplement-peer', targetId: null, platform: 'douyin', names: ['原始作者'], ids: [HANDLE], locators: [],
    sources: [{ title: '原表', file: '原表.xlsx', rows: ['12'] }], boards: [{ name: '一条小团团切片矩阵', category: '切片' }],
    classification: { theme: { key: 'tuantuan', label: '团团' }, labels: [{ key: 'slice', label: '切片' }] } };
  const snapshot = buildMasterRosterSnapshot({ exportedAt: '2026-10-02T19:01:23.853Z', entities: [entity] }, { sha256: 'a'.repeat(64), fileName: '总表.xlsx' });
  installMasterRoster(db, snapshot);
  const prepared = await prepareMasterRosterSupplement(db, { workbookSha256: 'a'.repeat(64), entryKey: snapshot.items[0].key,
    evidence: `https://www.douyin.com/video/${VIDEO}` });
  const request = { fileName: prepared.fileName, sheetName: prepared.sheetName, rows: prepared.rows,
    masterRosterSupplement: prepared.masterRosterSupplement, boardCatalog: prepared.boardCatalog };
  const jobId = randomUUID(), evidence = buildAuthorEvidenceRequests(request.rows)[0];
  database.createAuthorResolutionJob({ id: jobId, fileName: request.fileName, sheetName: request.sheetName, request, actorName: '离线测试' });
  db.prepare('UPDATE author_resolution_jobs SET created_at=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(), jobId);
  database.enqueueAuthorResolutions([evidence], { fileName: request.fileName, sheetName: request.sheetName, sourceMetadata: { sourceType: 'author-spreadsheet' } });
  db.prepare("UPDATE author_resolution_jobs SET status='completed',finished_at=?,result_json=? WHERE id=?").run(new Date().toISOString(),
    JSON.stringify({ ok: true, created: [], skipped: [{ ...request.rows[0], status: 'unresolved', evidenceRequestKeys: [evidence.key] }],
      queue: { pendingEvidenceRequestKeys: [evidence.key] } }), jobId);
  const owner = 'supplement-peer-owner', claimed = database.claimDueAuthorResolutions(1, { owner, leaseMs: 60000 })[0];
  const job = database.getAuthorResolutionJob(jobId);
  const replaceWorkbook = () => installMasterRoster(db, buildMasterRosterSnapshot({ exportedAt: '2026-10-03T19:01:23.853Z', entities: [entity] },
    { sha256: 'b'.repeat(64), fileName: '下一版总表.xlsx' }));
  const createInput = (_job, row) => ({ type: 'account', provider: 'public-web', label: row.name, locator: row.locator,
    metadata: { platform: 'douyin', resolution: row.resolution }, boards: row.boards });
  const proof = input => {
    const at = new Date().toISOString(), response = { status_code: 0, aweme_detail: { aweme_id: VIDEO,
      author: { sec_uid: SEC, uid: '1234567890123456', unique_id: HANDLE } } };
    const responseSha256 = hash(response), responseSha256Scope = 'public-identity-projection-v1';
    return { status: 'ok', ...input, requestStartedAt: at, requestFinishedAt: at,
      candidate: { videoId: VIDEO, secUid: SEC, uid: '1234567890123456', uniqueId: HANDLE, shortId: '',
        provenance: 'authorised-browser-natural-detail', observedAt: at, responseSha256, responseSha256Scope },
      evidence: { version: 1, kind: 'natural-main-frame-detail-response', origin: 'https://www.douyin.com', path: '/aweme/v1/web/aweme/detail/',
        method: 'GET', httpStatus: 200, requestedVideoId: VIDEO, observedAt: at, responseSha256, responseSha256Scope, response },
      provenance: { mode: 'authorised-browser-natural-detail', authorisedSessionUsed: true, authenticated: null, authenticationStatus: 'not-verified',
        noChallengeBypass: true, runtimeAI: false, paidAPI: false } };
  };
  return { database, db, job, owner, claimed, createInput, proof, replaceWorkbook, snapshot };
}

test('supplement peer: changed workbook is rejected before any provider call', async t => {
  const f = await fixture(t);
  assert.equal(prepareQueuedAuthorisedImport(f.database, f.claimed, { owner: f.owner }).status, 'ready');
  f.replaceWorkbook();
  assert.throws(() => assertMasterRosterSupplementJob(f.db, f.job));
  const outcome = await runQueuedAuthorisedImport(f.database, f.claimed, { owner: f.owner, createInput: f.createInput,
    provider: { resolveAuthorisedDetail: () => assert.fail('obsolete supplement must not launch') } });
  assert.equal(outcome.status, 'skipped');
  assert.equal(f.db.prepare('SELECT count(*) n FROM targets').get().n, 0);
});

test('supplement peer: workbook changed during capture rolls back admission without editing original job', async t => {
  const f = await fixture(t), before = f.db.prepare('SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?').get(f.job.id);
  const outcome = await runQueuedAuthorisedImport(f.database, f.claimed, { owner: f.owner, createInput: f.createInput,
    provider: { resolveAuthorisedDetail: async ({ items: [input] }) => { const result = f.proof(input); f.replaceWorkbook(); return result; } } });
  assert.equal(outcome.status, 'unavailable'); assert.equal(outcome.monitoringChanged, false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM targets').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM author_resolution_success_receipts').get().n, 0);
  assert.deepEqual(f.db.prepare('SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?').get(f.job.id), before);
  assert.equal(f.db.isTransaction, false);
});

test('supplement peer: unchanged context admits one exact account and re-reads frozen pending entry without mutation', async t => {
  const f = await fixture(t), frozen = f.db.prepare('SELECT * FROM master_roster_entries').all();
  const before = f.db.prepare('SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?').get(f.job.id);
  const outcome = await runQueuedAuthorisedImport(f.database, f.claimed, { owner: f.owner, createInput: f.createInput,
    provider: { resolveAuthorisedDetail: async ({ items: [input] }) => f.proof(input) } });
  assert.equal(outcome.status, 'resolved'); assert.equal(outcome.monitoringChanged, true);
  const item = readMasterRoster(f.db).items.find(value => value.key === f.snapshot.items[0].key);
  assert.equal(item.targetId, outcome.admission.target.id); assert.equal(item.monitorStatus, 'enabled');
  assert.equal(item.supplement.status, 'linked');
  assert.deepEqual(f.db.prepare('SELECT * FROM master_roster_entries').all(), frozen);
  assert.deepEqual(f.db.prepare('SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?').get(f.job.id), before);
  assert.equal(f.db.prepare('SELECT count(*) n FROM snapshots').get().n, 0);
});

test('supplement peer: an existing manually paused canonical target stays paused after exact new work admission', async t => {
  const f = await fixture(t), at = new Date().toISOString();
  f.db.prepare(`INSERT INTO targets(type,label,locator,provider,enabled,metadata_json,created_at,updated_at)
    VALUES('account','人工暂停的原账号',?,'public-web',0,?,?,?)`).run(SEC, JSON.stringify({ platform: 'douyin', userNote: 'preserve' }), at, at);
  const targetId = f.db.prepare('SELECT id FROM targets WHERE locator=?').get(SEC).id;
  f.db.prepare(`INSERT INTO activity_log(actor_name,action,resource_type,resource_id,created_at,details_json)
    VALUES('管理员','target.state','target',?,?,?)`).run(String(targetId), at, JSON.stringify({ enabled: false, source: 'manual' }));
  const outcome = await runQueuedAuthorisedImport(f.database, f.claimed, { owner: f.owner, createInput: f.createInput,
    provider: { resolveAuthorisedDetail: async ({ items: [input] }) => f.proof(input) } });
  assert.equal(outcome.status, 'resolved'); assert.equal(outcome.admission.created, false);
  assert.equal(outcome.admission.target.id, targetId); assert.equal(outcome.admission.target.enabled, false);
  const target = f.db.prepare('SELECT enabled,metadata_json FROM targets WHERE id=?').get(targetId);
  assert.equal(target.enabled, 0); assert.equal(JSON.parse(target.metadata_json).userNote, 'preserve');
  const item = readMasterRoster(f.db).items.find(value => value.key === f.snapshot.items[0].key);
  assert.equal(item.targetId, targetId); assert.equal(item.monitorStatus, 'paused');
  assert.equal(f.db.prepare("SELECT count(*) n FROM activity_log WHERE action='target.state'").get().n, 1);
});
