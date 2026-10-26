import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { buildAuthorEvidenceRequests, verifyQueuedAuthorEvidence } from '../lib/author-resolution.mjs';
import { projectImportReview } from '../lib/import-review.mjs';
import { enrichImportReviewCurrent } from '../lib/import-review-current.mjs';

const SEC = 'MS4wLjABAAAAabcdefghijklmnopqrstuvwx';
const VIDEO = '7684617087687331118', NEW_VIDEO = '7684617087687331119';
function scenario(t, original, corrected, { reuseOriginalKey = false, historicalDisplayName = original.name } = {}) {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const beforeRequest = buildAuthorEvidenceRequests([original])[0];
  const afterRequest = buildAuthorEvidenceRequests([corrected])[0];
  assert.ok(beforeRequest); assert.ok(afterRequest);
  // The queue schema deliberately supports changing evidence/version under a
  // retained key. Older or damaged same-key entries must still be checked
  // against the original job's exact submitted work, not just the queue key.
  if (reuseOriginalKey) afterRequest.key = beforeRequest.key;
  assert.equal(beforeRequest.key, afterRequest.key);
  const source = { sheetName: 'CSV', sourceMetadata: { sourceType: 'author-spreadsheet' } };
  database.enqueueAuthorResolutions([beforeRequest], { ...source, fileName: 'original-source.csv' });
  const job = { id: 'historical-owner-job', request: { fileName: 'original-source.csv', sheetName: 'CSV', rows: [original] },
    finishedAt: new Date().toISOString(), result: { skipped: [{ ...original, name: historicalDisplayName, evidenceRequestKeys: [beforeRequest.key], reason: '导入时仍未确认所填账号' }] } };
  // An independent import changes the current queue but must not rewrite the
  // source receipt or the original immutable historical row.
  database.enqueueAuthorResolutions([afterRequest], { ...source, fileName: 'later-other-source.csv' });
  const claim = database.claimDueAuthorResolutions(1, { owner: 'peer-fixture', reference: new Date(Date.now() + 100) })[0];
  assert.ok(claim);
  const verified = verifyQueuedAuthorEvidence(afterRequest, { candidates: [{ platform: 'douyin', secUid: SEC,
    nickname: corrected.name || '公开作品作者', uniqueId: corrected.douyinId, videoId: corrected.videoId }], errors: [] });
  assert.equal(verified.status, 'ready');
  const committed = database.commitAuthorResolutionTarget(claim.id, { label: corrected.name, locator: SEC,
    metadata: { platform: 'douyin', douyinId: corrected.douyinId, resolution: verified.row.resolution } }, {},
  { owner: 'peer-fixture', evidenceVersion: claim.evidence_version });
  assert.ok(committed);
  const snapshot = JSON.stringify(job);
  const read = enrichImportReviewCurrent(database.db, job, projectImportReview(job));
  assert.equal(JSON.stringify(job), snapshot);
  assert.equal(read.items[0].name, historicalDisplayName);
  assert.equal(read.items[0].reason, '导入时仍未确认所填账号');
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM author_resolution_success_receipts').get().n, 1);
  return { current: read.items[0].currentResolution, database, job };
}
const base = { sourceRow: 2, platform: 'douyin', name: '原先错填甲', douyinId: '', videoId: VIDEO, status: 'unresolved' };

test('same work resolved for a later name-only import does not certify the original different submitted name', t => {
  const f = scenario(t, { ...base }, { ...base, name: '公开作品实际作者乙' });
  assert.ok(['conflict', 'unknown'].includes(f.current.status), `unverified original name must not inherit ${f.current.status}`);
  assert.equal(f.current.counts.resolved, 0);
});

test('an unchanged strong submitted account ID may retain proof when only the display nickname changes', t => {
  const original = { ...base, name: '作者旧昵称', douyinId: 'stable_account_123' };
  const f = scenario(t, original, { ...original, name: '作者新昵称' });
  assert.equal(f.current.status, 'resolved');
  assert.equal(f.current.counts.resolved, 1);
  assert.equal(f.current.counts.linked, 1);
});

test('a current successful replacement work under a retained key cannot certify the original job work', t => {
  const original = { ...base, name: '同一账号', douyinId: 'stable_account_123' };
  const f = scenario(t, original, { ...original, videoId: NEW_VIDEO }, { reuseOriginalKey: true });
  assert.ok(['conflict', 'unknown', 'unlinked'].includes(f.current.status), `original work must not inherit ${f.current.status}`);
  assert.equal(f.current.counts.resolved, 0);
});

test('public work-only proof does not gain a fabricated nickname constraint from the historical display label', t => {
  const original = { ...base, name: '', douyinId: '' };
  const f = scenario(t, original, { ...original }, { historicalDisplayName: '抖音作者 · 2' });
  assert.equal(f.current.status, 'resolved');
  assert.equal(f.current.counts.resolved, 1);
});

test('nickname-only constraints preserve a leading at-sign just like strict ownership verification', t => {
  const f = scenario(t, { ...base, name: '@甲' }, { ...base, name: '甲' });
  assert.ok(['conflict', 'unknown'].includes(f.current.status));
  assert.equal(f.current.counts.resolved, 0);
});

test('nickname whitespace normalization remains aligned with strict ownership verification', t => {
  const f = scenario(t, { ...base, name: '作者  甲' }, { ...base, name: '作者 甲' });
  assert.equal(f.current.status, 'resolved');
  assert.equal(f.current.counts.resolved, 1);
});
