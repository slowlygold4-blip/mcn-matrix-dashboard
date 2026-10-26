import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { MonitorDatabase } from '../lib/database.mjs';
import { buildMasterRosterSnapshot, installMasterRoster } from '../lib/master-roster.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, detail) {
  for (let n = 0; n < 500; n++) { const result = await check(); if (result) return result; await pause(10); }
  assert.fail(detail());
}

test('HTTP correction requires explicit confirmation, fresh same-job evidence, preserves original and shows corrected import association', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mcn-correction-http-'));
  process.env.DATA_DIR = dir;
  const database = new MonitorDatabase(join(dir, 'douyin-monitor.sqlite')), db = database.db;
  const originalId = 'source_typo', correctedAccountId = 'verified_correct_id', videoId = '7690702905876096104';
  const snapshot = buildMasterRosterSnapshot({ exportedAt: '2026-10-02T11:00:00Z', entities: [
    { key: 'source-typo', platform: 'douyin', names: ['原表作者'], ids: [originalId],
      sources: [{ title: '原始表', file: 'original.xlsx', rows: ['12'] }],
      boards: [{ name: '一条小团团切片矩阵', category: '原创(手书、漫画、3d等)' },
        { name: '一条小团团切片矩阵', category: '' }] },
  ] }, { fileName: 'frozen.xlsx', sha256: 'a'.repeat(64) });
  installMasterRoster(db, snapshot);
  const sourceJob = database.createAuthorResolutionJob({ id: randomUUID(), fileName: 'original.xlsx', sheetName: '原始名单',
    request: { fileName: 'original.xlsx', sheetName: '原始名单', uploadSha256: 'b'.repeat(64),
      rows: [{ sourceRow: 12, platform: 'douyin', name: '原表作者', douyinId: originalId, videoId }] } });
  db.prepare("UPDATE author_resolution_jobs SET status='completed',finished_at=?,result_json='{}' WHERE id=?").run(new Date().toISOString(), sourceJob.id);
  const frozen = db.prepare('SELECT * FROM master_roster_entries').all();
  const sourceBefore = db.prepare('SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?').get(sourceJob.id);
  let started = null, release;
  const held = new Promise(resolve => { release = resolve; });
  const oldDetail = PublicWebProvider.prototype.resolveAuthorisedDetail;
  PublicWebProvider.prototype.resolveAuthorisedDetail = async ({ items: [input] }) => {
    started = input; const requestStartedAt = new Date().toISOString(); await held;
    const observedAt = new Date().toISOString(), secUid = 'MS4wLjABAAAACorrectedHttpFixture0001', uid = '1234567890123456';
    const response = { status_code: 0, aweme_detail: { aweme_id: videoId,
      author: { sec_uid: secUid, uid, unique_id: correctedAccountId } } };
    const responseSha256 = createHash('sha256').update(JSON.stringify(response)).digest('hex');
    const responseSha256Scope = 'public-identity-projection-v1';
    return { status: 'ok', ...input, requestStartedAt, requestFinishedAt: observedAt,
      candidate: { videoId, secUid, uid, uniqueId: correctedAccountId, shortId: '', provenance: 'authorised-browser-natural-detail', observedAt, responseSha256, responseSha256Scope },
      evidence: { version: 1, kind: 'natural-main-frame-detail-response', origin: 'https://www.douyin.com', path: '/aweme/v1/web/aweme/detail/',
        method: 'GET', httpStatus: 200, requestedVideoId: videoId, observedAt, responseSha256, responseSha256Scope, response },
      provenance: { mode: 'authorised-browser-natural-detail', authorisedSessionUsed: true, authenticated: null, authenticationStatus: 'not-verified',
        noChallengeBypass: true, runtimeAI: false, paidAPI: false } };
  };
  const { server } = await import('../server.mjs');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { release(); PublicWebProvider.prototype.resolveAuthorisedDetail = oldDetail;
    await new Promise(resolve => server.close(resolve)); database.close(); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const authResponse = await fetch(origin + '/api/auth/session'), auth = await authResponse.json();
  const cookie = authResponse.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  async function call(path, body, key, token = auth.csrfToken) {
    const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, Cookie: cookie, ...(token ? { 'X-CSRF-Token': token } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  const input = { workbookSha256: snapshot.workbook.sha256, entryKey: snapshot.items[0].key,
    evidence: `https://www.douyin.com/video/${videoId}`, correctedAccountId };
  const preview = await call('/api/master-roster/supplement/preview', input);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.deepEqual(preview.data.correction, { originalAccountId: originalId, correctedAccountId });
  assert.equal(preview.data.requiresCorrectionConfirmation, true); assert.equal(preview.data.review.canSubmit, true);
  assert.equal(db.prepare('SELECT count(*) n FROM author_resolution_jobs').get().n, 1, 'preview writes no job');
  const submission = { ...input, previewSha256: preview.data.previewSha256 }, key = randomUUID();
  for (const correctionConfirmed of [undefined, false, 'true', 1]) {
    const denied = await call('/api/master-roster/supplement', { ...submission, correctionConfirmed }, key);
    assert.equal(denied.status, 400, 'literal explicit confirmation is required');
  }
  assert.equal((await call('/api/master-roster/supplement', { ...submission, correctionConfirmed: true }, key, '')).status, 403);
  assert.equal((await call('/api/master-roster/supplement', { ...submission, correctedAccountId: 'changed_after_preview', correctionConfirmed: true }, key)).status, 409);
  const accepted = await call('/api/master-roster/supplement', { ...submission, correctionConfirmed: true }, key);
  assert.equal(accepted.status, 202, JSON.stringify(accepted.data));
  const jobId = accepted.data.job.id;
  await until(() => started, () => JSON.stringify(database.getAuthorResolutionJob(jobId)));
  const storedCorrection = database.getAuthorResolutionJob(jobId);
  assert.equal(storedCorrection.request.rows[0].boards.length, 1);
  assert.equal(storedCorrection.request.rows[0].boards[0].category, '原创(手书、漫画、3d等)');
  assert.equal(started.submittedId, correctedAccountId);
  assert.equal(db.prepare('SELECT count(*) n FROM targets').get().n, 0, 'confirmation is not identity proof');
  const pending = await call(`/api/author-spreadsheet/jobs/${sourceJob.id}/monitoring`);
  assert.equal(pending.status, 200, JSON.stringify(pending.data)); assert.equal(pending.data.counts.pending, 1);
  assert.equal(pending.data.items[0].submittedId, originalId);
  assert.equal(pending.data.items[0].identityCorrection.status, 'pending');
  release();
  await until(() => db.prepare('SELECT count(*) n FROM author_resolution_success_receipts').get().n === 1,
    () => JSON.stringify(db.prepare('SELECT status,last_error FROM author_resolution_queue').all()));
  const current = await call(`/api/author-spreadsheet/jobs/${sourceJob.id}/monitoring`);
  assert.equal(current.status, 200, JSON.stringify(current.data)); assert.equal(current.data.counts.enabled, 1);
  assert.equal(current.data.counts.missingProfiles, 1, 'identity proof does not invent metrics');
  assert.equal(current.data.items[0].submittedId, originalId);
  assert.equal(current.data.items[0].identityCorrection.correctedAccountId, correctedAccountId);
  assert.equal(current.data.items[0].identityCorrection.status, 'verified');
  const replay = await call('/api/master-roster/supplement', { ...submission, correctionConfirmed: true }, key);
  assert.equal(replay.status, 200, JSON.stringify(replay.data)); assert.equal(replay.data.job.id, jobId);
  assert.equal((await call('/api/master-roster/supplement/preview', { ...input, correctedAccountId: 'another_person' })).status, 409);
  assert.deepEqual(db.prepare('SELECT * FROM master_roster_entries').all(), frozen);
  assert.deepEqual(db.prepare('SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?').get(sourceJob.id), sourceBefore);
  const audit = db.prepare("SELECT details_json FROM activity_log WHERE action='authors.auto-monitor.start'").all().map(value => JSON.parse(value.details_json));
  assert.equal(audit.filter(value => value.identityCorrection?.jobId === jobId && value.identityCorrection.explicitlyConfirmed === true).length, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM snapshots').get().n, 0);
});
