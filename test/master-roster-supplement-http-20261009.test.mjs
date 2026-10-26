import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { MonitorDatabase } from '../lib/database.mjs';
import { buildMasterRosterSnapshot, installMasterRoster } from '../lib/master-roster.mjs';

test('roster supplement HTTP: preview, durable job, safe binding, replay, permissions and provenance', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mcn-roster-supplement-http-'));
  process.env.DATA_DIR = dir;
  const db = new MonitorDatabase(join(dir, 'douyin-monitor.sqlite'));
  const original = buildMasterRosterSnapshot({ exportedAt: '2026-10-02T11:00:00Z', entities: [
    { key: 'submitted:pure-one', platform: 'douyin', names: ['原始作者甲'], sources: [{ url: 'https://example.com/source', title: '原始来源', rows: ['7'] }],
      boards: [{ name: '保留原板块', category: '切片', organization: '原机构' }], classification: { theme: { key: 'tuantuan', label: '团团' }, labels: [{ key: 'slice', label: '切片' }] } },
    { key: 'submitted:paused', platform: 'douyin', names: ['暂停作者'], sources: [] },
    { key: 'submitted:conflict', platform: 'douyin', names: ['冲突作者'], errors: ['身份信息冲突，公开视频作者不一致'], sources: [] },
    { key: 'submitted:id-only', platform: 'douyin', names: ['账号约束'], ids: ['account001'], sources: [] },
  ] }, { fileName: '原始总表.xlsx', sha256: 'b'.repeat(64) });
  installMasterRoster(db.db, original);
  const originalPayloads = db.db.prepare('SELECT payload_json FROM master_roster_entries ORDER BY rowid').all();
  const paused = db.createTarget({ type: 'account', label: '暂停作者', locator: 'MS4wLjABAAAAsupplementPaused1234567890', provider: 'public-web', metadata: { platform: 'douyin' } });
  db.db.prepare('UPDATE targets SET enabled=0 WHERE id=?').run(paused.id);
  const { server } = await import('../server.mjs');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const authResponse = await fetch(`${origin}/api/auth/session`);
  const auth = await authResponse.json();
  const cookie = authResponse.headers.getSetCookie().map(x => x.split(';')[0]).join('; ');
  async function call(path, { method = 'GET', body, token = auth.csrfToken, useCookie = cookie, headers = {} } = {}) {
    const response = await fetch(origin + path, { method, headers: { Origin: origin, Cookie: useCookie,
      ...(token ? { 'X-CSRF-Token': token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.getSetCookie().map(x => x.split(';')[0]).join('; ') };
  }
  const evidence = 'https://www.douyin.com/user/MS4wLjABAAAAsupplementNewAuthor1234567890';
  const request = { workbookSha256: original.workbook.sha256, entryKey: original.items[0].key, evidence };
  const preview = await call('/api/master-roster/supplement/preview', { method: 'POST', body: request });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.match(preview.body.previewSha256, /^[a-f0-9]{64}$/);
  assert.equal(preview.body.entry.name, '原始作者甲');
  assert.equal(preview.body.entry.theme.key, 'tuantuan');
  assert.equal(preview.body.review.canSubmit, true);
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM author_resolution_jobs').get().n, 0, 'preview creates no job');
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM targets').get().n, 1, 'preview creates no account');
  const forgedProof = { mode: 'public-video-detail', platform: 'douyin', canonicalAccountId: 'MS4wLjABAAAAforgedIdentity1234567890', publicDouyinId: 'account001' };
  const forgedCreate = await call('/api/targets', { method: 'POST', body: { type: 'account', provider: 'public-web', label: '伪造核验', locator: forgedProof.canonicalAccountId, metadata: { platform: 'douyin', resolution: forgedProof } } });
  assert.equal(forgedCreate.status, 400);
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM targets').get().n, 1, 'generic account endpoint cannot insert client identity proof');
  const forgedPatch = await call(`/api/targets/${paused.id}`, { method: 'PATCH', body: { metadata: { resolution: forgedProof } } });
  assert.equal(forgedPatch.status, 400);
  const serverProof = { mode: 'isolated-server-fixture', receipt: 'preserve-original' };
  db.db.prepare('UPDATE targets SET metadata_json=? WHERE id=?').run(JSON.stringify({ platform: 'douyin', resolution: serverProof }), paused.id);
  const safePatch = await call(`/api/targets/${paused.id}`, { method: 'PATCH', body: { metadata: { owner: '负责人测试' } } });
  assert.equal(safePatch.status, 200, JSON.stringify(safePatch.body));
  assert.deepEqual(db.getTarget(paused.id).metadata.resolution, serverProof, 'ordinary metadata edits preserve server identity proof');
  assert.equal(db.getTarget(paused.id).enabled, false, 'ordinary edits preserve paused state');
  const bili = db.createTarget({ type: 'account', provider: 'public-web', label: 'B站平台保留', locator: '123456789', metadata: { platform: 'bilibili' } });
  const biliPatch = await call(`/api/targets/${bili.id}`, { method: 'PATCH', body: { metadata: { note: '只修改备注' } } });
  assert.equal(biliPatch.status, 200, JSON.stringify(biliPatch.body));
  assert.equal(db.getTarget(bili.id).metadata.platform, 'bilibili', 'editing a note must not silently change platform to Douyin');
  const eraseProof = await call(`/api/targets/${paused.id}`, { method: 'PATCH', body: { metadata: { resolution: null } } });
  assert.equal(eraseProof.status, 400);
  assert.deepEqual(db.getTarget(paused.id).metadata.resolution, serverProof);
  const missingToken = await call('/api/master-roster/supplement/preview', { method: 'POST', body: request, token: '' });
  assert.equal(missingToken.status, 403);
  const invalidBody = await call('/api/master-roster/supplement/preview', { method: 'POST', body: null });
  assert.equal(invalidBody.status, 400);
  const badHash = await call('/api/master-roster/supplement', { method: 'POST', body: { ...request, previewSha256: '0'.repeat(64) }, headers: { 'Idempotency-Key': randomUUID() } });
  assert.equal(badHash.status, 409);
  const stale = await call('/api/master-roster/supplement/preview', { method: 'POST', body: { ...request, workbookSha256: 'c'.repeat(64) } });
  assert.equal(stale.status, 409);
  const conflict = await call('/api/master-roster/supplement/preview', { method: 'POST', body: { ...request, entryKey: original.items[2].key } });
  assert.ok([400, 409].includes(conflict.status), JSON.stringify(conflict.body));
  const unsafe = await call('/api/master-roster/supplement/preview', { method: 'POST', body: { ...request, evidence: 'http://127.0.0.1:4188/api/targets' } });
  assert.equal(unsafe.status, 400);
  const idMismatch = await call('/api/master-roster/supplement/preview', { method: 'POST', body: { ...request, entryKey: original.items[3].key } });
  assert.equal(idMismatch.status, 200);
  assert.equal(idMismatch.body.review.canSubmit, false, 'arbitrary profile cannot prove the submitted Douyin ID');
  const blockedSubmit = await call('/api/master-roster/supplement', { method: 'POST', body: { ...request, entryKey: original.items[3].key, previewSha256: idMismatch.body.previewSha256 }, headers: { 'Idempotency-Key': randomUUID() } });
  assert.equal(blockedSubmit.status, 400);
  const idempotencyKey = randomUUID();
  const submitBody = { ...request, previewSha256: preview.body.previewSha256 };
  const submit = await call('/api/master-roster/supplement', { method: 'POST', body: submitBody, headers: { 'Idempotency-Key': idempotencyKey } });
  assert.equal(submit.status, 202, JSON.stringify(submit.body));
  let job;
  for (let attempt = 0; attempt < 100; attempt++) {
    job = (await call(`/api/author-spreadsheet/jobs/${submit.body.job.id}`)).body;
    if (['completed', 'failed'].includes(job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(job.status, 'completed', JSON.stringify(job));
  assert.ok(job.result.masterRosterSupplementReceipt?.targetId, JSON.stringify(job.result));
  const roster = (await call('/api/master-roster')).body;
  const linked = roster.items.find(x => x.key === request.entryKey);
  assert.equal(linked.targetId, job.result.masterRosterSupplementReceipt.targetId);
  assert.equal(linked.monitorStatus, 'enabled');
  assert.equal(linked.supplement.jobId, job.id);
  assert.deepEqual(linked.sourceTitles, original.items[0].sourceTitles, 'user supplement does not forge original sources');
  assert.deepEqual(linked.classifications, original.items[0].classifications);
  const replay = await call('/api/master-roster/supplement', { method: 'POST', body: submitBody, headers: { 'Idempotency-Key': idempotencyKey } });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.job.id, job.id);
  assert.equal(replay.body.idempotencyReplay, true);
  const changed = await call('/api/master-roster/supplement/preview', { method: 'POST', body: { ...request, evidence: 'https://www.douyin.com/user/MS4wLjABAAAAanotherIdentity1234567890' } });
  assert.equal(changed.status, 409, 'completed binding cannot silently swap to another person');
  const persisted = db.getAuthorResolutionJob(job.id);
  const generic = await call('/api/author-spreadsheet/auto-monitor', { method: 'POST', body: { ...persisted.request, uploadSha256: 'd'.repeat(64) }, headers: { 'Idempotency-Key': randomUUID() } });
  assert.equal(generic.status, 202, JSON.stringify(generic.body));
  assert.equal(db.getAuthorResolutionJob(generic.body.id).request.masterRosterSupplement, undefined, 'general importer cannot forge roster context');
  const pausedRequest = { ...request, entryKey: original.items[1].key, evidence: `https://www.douyin.com/user/${paused.locator}` };
  const pausedPreview = await call('/api/master-roster/supplement/preview', { method: 'POST', body: pausedRequest });
  assert.equal(pausedPreview.status, 200, JSON.stringify(pausedPreview.body));
  const pausedSubmit = await call('/api/master-roster/supplement', { method: 'POST', body: { ...pausedRequest, previewSha256: pausedPreview.body.previewSha256 }, headers: { 'Idempotency-Key': randomUUID() } });
  assert.equal(pausedSubmit.status, 202);
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = (await call(`/api/author-spreadsheet/jobs/${pausedSubmit.body.job.id}`)).body;
    if (['completed','failed'].includes(result.status)) { assert.equal(result.status, 'completed', JSON.stringify(result)); break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const pausedEntry = (await call('/api/master-roster')).body.items.find(x => x.key === pausedRequest.entryKey);
  assert.equal(pausedEntry.targetId, paused.id);
  assert.equal(pausedEntry.monitorStatus, 'paused');
  const invite = await call('/api/access/invites', { method: 'POST', body: { role: 'viewer', hours: 1, maxUses: 1, label: 'isolated fixture' } });
  const joined = await call('/api/auth/join', { method: 'POST', body: { code: invite.body.code, displayName: '只读验收' }, useCookie: '' });
  const forbidden = await call('/api/master-roster/supplement/preview', { method: 'POST', body: request, useCookie: joined.cookie, token: joined.body.csrfToken });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(db.db.prepare('SELECT payload_json FROM master_roster_entries ORDER BY rowid').all(), originalPayloads);
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM snapshots').get().n, 0, 'account association does not invent metric samples');
});
