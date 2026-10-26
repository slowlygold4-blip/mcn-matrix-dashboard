import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MonitorDatabase } from '../lib/database.mjs';
import { buildAuthorEvidenceRequests, verifyQueuedAuthorEvidence } from '../lib/author-resolution.mjs';
import { buildMasterRosterSnapshot, installMasterRoster, readMasterRoster } from '../lib/master-roster.mjs';
import { prepareMasterRosterSupplement } from '../lib/master-roster-supplement.mjs';

const SEC = 'MS4wLjABAAAAabcdefghijklmnopqrstuvwx';
const OTHER = 'MS4wLjABBBBBzyxwvutsrqponmlkjihgfedcba';
const VIDEO = '7684617087687331118';
const LINK = `https://www.douyin.com/video/${VIDEO}`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Real in-memory queue commits produce the immutable proof. A second source
// retries the same public work after a temporary foreground-network failure.
// No platform call, production DB or fabricated success receipt is involved.
async function reuseFixture(t, { hasId = true, hasLocator = true, oldName = '原始昵称', newName = '更新昵称' } = {}) {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const db = database.db;
  const prepare = async (name, workbookSha256) => {
    const snapshot = buildMasterRosterSnapshot({ exportedAt: '2026-10-02T19:01:23.853Z', entities: [{
      key: 'submitted:douyin:source-row', targetId: null, platform: 'douyin', names: [name],
      ids: hasId ? ['original_handle'] : [], locators: hasLocator ? [SEC] : [],
      boards: [{ name: '团团切片矩阵', category: '切片' }], sources: [{ file: '原始名单.xlsx', rows: ['12'] }],
    }] }, { fileName: '总表.xlsx', sha256: workbookSha256 });
    installMasterRoster(db, snapshot);
    return prepareMasterRosterSupplement(db, { workbookSha256, entryKey: snapshot.items[0].key, evidence: LINK });
  };
  const first = await prepare(oldName, 'a'.repeat(64));
  const firstRequest = buildAuthorEvidenceRequests(first.rows)[0];
  const source = prepared => ({ fileName: prepared.fileName, sheetName: prepared.sheetName, sourceMetadata: { sourceType: 'author-spreadsheet' } });
  database.enqueueAuthorResolutions([firstRequest], source(first));
  const claimed = database.claimDueAuthorResolutions(1, { owner: 'roster-name-fixture', reference: new Date(Date.now() + 100) })[0];
  const candidate = { platform: 'douyin', secUid: SEC, nickname: oldName, uniqueId: 'original_handle', videoId: VIDEO, sourceEvidenceUrl: LINK };
  const verified = verifyQueuedAuthorEvidence(firstRequest, { candidates: [candidate], errors: [] });
  assert.equal(verified.status, 'ready');
  const row = verified.row;
  const committed = database.commitAuthorResolutionTarget(claimed.id, {
    label: row.name, locator: row.locator, boards: row.boards, metadata: { platform: 'douyin', douyinId: row.douyinId,
      resolution: row.resolution, importSource: { type: 'author-spreadsheet', fileName: first.fileName, sheetName: first.sheetName, sourceRow: 2 } },
  }, source(first), { owner: 'roster-name-fixture', evidenceVersion: claimed.evidence_version });
  assert.ok(committed);
  // Preserve an existing user's paused setting when the new roster reconnects.
  db.prepare('UPDATE targets SET enabled=0 WHERE id=?').run(committed.target.id);
  const proofBefore = db.prepare('SELECT * FROM author_resolution_success_receipts').get();
  const firstSourceBefore = db.prepare('SELECT * FROM author_resolution_import_sources ORDER BY id LIMIT 1').get();
  const next = await prepare(newName, 'b'.repeat(64));
  const nextRequest = buildAuthorEvidenceRequests(next.rows)[0];
  const job = { id: 'new-source-job', request: { rows: next.rows, fileName: next.fileName, sheetName: next.sheetName,
    boardCatalog: next.boardCatalog, masterRosterSupplement: next.masterRosterSupplement }, createdAt: new Date().toISOString() };
  database.createAuthorResolutionJob({ ...job, fileName: next.fileName, sheetName: next.sheetName, actorName: 'fixture' });
  const queue = database.enqueueAuthorResolutions([nextRequest], source(next));
  const result = { ok: true, queuedEvidenceRequestCount: queue.pendingEvidenceRequestKeys.length, queue, created: [],
    skipped: [{ ...next.rows[0], status: 'unresolved', evidenceRequestKeys: [nextRequest.key] }] };
  db.prepare("UPDATE author_resolution_jobs SET status='completed',result_json=?,finished_at=? WHERE id=?")
    .run(JSON.stringify(result), new Date().toISOString(), job.id);
  const rosterBefore = db.prepare('SELECT * FROM master_roster_entries ORDER BY import_id').all();
  return { database, db, firstRequest, nextRequest, candidate, next, job, targetId: committed.target.id,
    read: () => readMasterRoster(db).items[0], proofBefore, firstSourceBefore, rosterBefore };
}

for (const hasLocator of [true, false]) test(`same submitted ID and work retain a renamed source binding (canonical anchor ${hasLocator})`, async t => {
  const f = await reuseFixture(t, { hasLocator });
  assert.equal(f.firstRequest.key, f.nextRequest.key);
  // The underlying strict resolver explicitly uses ID, not nickname, here.
  assert.equal(verifyQueuedAuthorEvidence(f.nextRequest, { candidates: [f.candidate], errors: [] }).status, 'ready');
  const read = f.read();
  assert.equal(read.targetId, f.targetId);
  assert.equal(read.supplement.status, 'linked');
  assert.equal(read.supplement.proofType, 'strict-queue-work-evidence');
  assert.equal(read.monitorStatus, 'paused');
  assert.deepEqual(f.db.prepare('SELECT * FROM author_resolution_success_receipts').get(), f.proofBefore);
  assert.deepEqual(f.db.prepare('SELECT * FROM author_resolution_import_sources ORDER BY id LIMIT 1').get(), f.firstSourceBefore);
  assert.deepEqual(f.db.prepare('SELECT * FROM master_roster_entries ORDER BY import_id').all(), f.rosterBefore);
});

test('without submitted ID, a changed nickname cannot reuse same-work proof', async t => {
  const f = await reuseFixture(t, { hasId: false, hasLocator: false });
  assert.equal(f.firstRequest.key, f.nextRequest.key, 'isolate nickname constraint from queue-key checks');
  assert.notEqual(verifyQueuedAuthorEvidence(f.nextRequest, { candidates: [f.candidate], errors: [] }).status, 'ready');
  assert.equal(f.read().targetId, null);
  assert.equal(f.read().supplement.status, 'review-required');
});

test('unchanged nickname-only identity keeps its existing strict binding', async t => {
  const f = await reuseFixture(t, { hasId: false, hasLocator: false, newName: '原始昵称' });
  assert.equal(f.read().targetId, f.targetId);
  assert.equal(f.read().monitorStatus, 'paused');
});

for (const variant of ['missing-public-id', 'wrong-public-id', 'wrong-submitted-id', 'missing-submitted-id', 'wrong-work', 'bad-proof-hash']) {
  test(`renamed source still rejects ${variant}`, async t => {
    const f = await reuseFixture(t);
    const payload = JSON.parse(f.proofBefore.payload_json);
    if (variant === 'missing-public-id') payload.resolution.publicDouyinId = '';
    if (variant === 'wrong-public-id') payload.resolution.publicDouyinId = 'someone_else';
    if (variant === 'wrong-submitted-id') payload.evidence.douyinId = 'someone_else';
    if (variant === 'missing-submitted-id') payload.evidence.douyinId = '';
    if (variant === 'wrong-work') payload.evidence.videoIds = ['7684617087687331119'];
    f.db.prepare('UPDATE author_resolution_success_receipts SET payload_json=?,receipt_sha256=? WHERE id=?')
      .run(JSON.stringify(payload), variant === 'bad-proof-hash' ? '0'.repeat(64) : hash(payload), f.proofBefore.id);
    assert.equal(f.read().targetId, null);
  });
}

for (const variant of ['missing-source', 'source-hash-invalid', 'changed-target', 'missing-success']) {
  test(`renamed source does not bypass ${variant}`, async t => {
    const f = await reuseFixture(t);
    if (variant === 'missing-source') f.db.prepare('DELETE FROM author_resolution_import_sources WHERE id<>?').run(f.firstSourceBefore.id);
    if (variant === 'source-hash-invalid') f.db.prepare('UPDATE author_resolution_import_sources SET receipt_sha256=? WHERE id<>?').run('0'.repeat(64), f.firstSourceBefore.id);
    if (variant === 'changed-target') f.db.prepare('UPDATE targets SET locator=? WHERE id=?').run(OTHER, f.targetId);
    if (variant === 'missing-success') f.db.prepare('DELETE FROM author_resolution_success_receipts').run();
    assert.equal(f.read().targetId, null);
  });
}
