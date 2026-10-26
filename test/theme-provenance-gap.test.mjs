import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { validatedSuccessProof } from '../lib/master-roster-supplement.mjs';
import { applyAuthorEvidence, buildAuthorEvidenceRequests } from '../lib/author-resolution.mjs';
import { classifyAuthorTheme } from '../lib/author-classification.mjs';

// Execute only this side-effect-free production helper, never import server.mjs
// (which owns workers/network). Synthetic identities; no production DB needed.
const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function hydratePreviouslyVerifiedAuthors(');
const end = source.indexOf('\nfunction publicAuthorResolveJob(', start);
assert.ok(start >= 0 && end > start, 'production hydration helper boundary exists');
const hydrate = vm.runInNewContext(`(${source.slice(start, end).trim()})`, { validatedSuccessProof });
const SEC = 'MS4wLjABAAAAprovenance_fixture_account_0123456789';
const OTHER = 'MS4wLjABAAAAprovenance_other_account_9876543210';
const SHARE = 'https://v.douyin.com/fixtureA/';
const existing = { id: 341, type: 'account', provider: 'public-web', locator: SEC,
  label: '已有账号', metadata: { douyinId: 'submitted-fixture',
    importSource: { fileName: '参与内容数据.xlsx', sheetName: '数据明细' },
    resolution: { mode: 'public-video-detail', evidenceVideoId: '7000000000000000001' } } };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function receipt(target = existing) {
  const verifiedAt = new Date().toISOString();
  const verifiedEvidence = [{ videoId: '7000000000000000001', canonicalAccountId: target.locator }];
  const proof = { format: 'mcn-author-resolution-success-v1', queueId: target.id, evidenceVersion: 1, identityKey: `fixture:${target.id}`,
    targetId: target.id, platform: 'douyin', canonicalAccountId: target.locator, verifiedAt, committedAt: verifiedAt, verificationPolicyVersion: 2,
    evidence: { videoIds: ['7000000000000000001'], shareUrls: [] },
    resolution: { mode: 'public-video-detail', platform: 'douyin', canonicalAccountId: target.locator, publicDouyinId: 'submitted-fixture',
      verificationPolicy: 'all-submitted-evidence-v2', resolvedAt: verifiedAt, verifiedEvidence, verifiedEvidenceCount: 1, verifiedEvidenceSha256: hash(verifiedEvidence) } };
  return { payload_json: JSON.stringify(proof), receipt_sha256: hash(proof), queue_id: proof.queueId, evidence_version: 1, identity_key: proof.identityKey,
    target_id: target.id, platform: 'douyin', canonical_account_id: target.locator, verified_at: verifiedAt };
}
function fixture() {
  const row = { sourceRow: 495, platform: 'douyin', douyinId: 'submitted-fixture',
    name: '表格作者', locator: '', status: 'resolvable', shareUrl: SHARE,
    boards: [{ name: '一条小团团切片矩阵' }] };
  const hydrated = hydrate([row], [existing], [receipt()]);
  return { row, hydrated, request: buildAuthorEvidenceRequests(hydrated)[0] };
}
function apply(candidate, extra = {}) {
  const f = fixture();
  return applyAuthorEvidence(f.hydrated, { items: [{ key: f.request.key,
    candidates: candidate ? [candidate] : [], errors: [], ...extra }] });
}
function candidate(extra = {}) {
  return { secUid: SEC, uid: '123456789', uniqueId: 'submitted-fixture',
    nickname: '已核验作者', sourceEvidenceUrl: SHARE, videoId: '7000000000000000002', ...extra };
}

test('theme provenance: hydration derives a locator without rewriting original submitted evidence', () => {
  const { row, hydrated, request } = fixture();
  assert.equal(row.locator, '');
  assert.equal(buildAuthorEvidenceRequests([row])[0].accountLocator, '');
  assert.equal(hydrated[0].locator, SEC);
  assert.equal(request.accountLocator, SEC);
  assert.ok(request.key.startsWith(`douyin:account:${SEC}|`));
  assert.deepEqual(request.shareUrls, [SHARE]);
  assert.equal(classifyAuthorTheme(existing).key, 'unassigned');
});

test('editable metadata alone and broken independent proofs never hydrate an author', () => {
  const { row } = fixture();
  assert.equal(hydrate([row], [existing])[0].locator, '');
  const damaged = receipt(); damaged.receipt_sha256 = 'f'.repeat(64);
  assert.equal(hydrate([row], [existing], [damaged])[0].locator, '');
  assert.equal(hydrate([row], [{ ...existing, locator: OTHER }], [receipt()])[0].locator, '');
});
test('cross-platform, conflict and duplicate rows cannot be promoted by a matching receipt', () => {
  const { row } = fixture();
  for (const override of [{ platform: 'bilibili' }, { status: 'identity_conflict' }, { identityConflict: 'conflict' }, { status: 'duplicate' }, { status: 'skipped' }]) {
    const input = { ...row, ...override };
    assert.equal(hydrate([input], [existing], [receipt()])[0], input);
  }
});
test('corrupt persisted metadata cannot acquire the legacy Douyin default through hydration', () => {
  const { row } = fixture();
  for (const current_metadata_json of ['{', '[]', 'null', '"douyin"', null]) {
    assert.equal(hydrate([row], [existing], [{ ...receipt(), current_metadata_json }])[0].locator, '');
  }
  assert.equal(hydrate([row], [existing], [{ ...receipt(), current_metadata_json: '{}' }])[0].locator, SEC);
});
test('multiple canonical targets claiming one submitted handle fail closed regardless of receipt order', () => {
  const { row } = fixture(), other = { ...existing, id: 342, locator: OTHER };
  for (const proofs of [[receipt(), receipt(other), receipt()], [receipt(other), receipt(), receipt(other)]]) {
    assert.equal(hydrate([row], [existing, other], proofs)[0].locator, '');
  }
});

test('theme provenance: deferred evidence never upgrades a hydrated existing row to ready', () => {
  const result = apply(null, { status: 'deferred', networkAttempted: false });
  assert.equal(result.rows[0].status, 'unresolved');
  assert.equal(result.summary.resolvedAuthors, 0);
});

test('theme provenance: denied short-link request does not reuse an old unrelated account proof', () => {
  const result = apply(null, { errors: ['HTTP 403'] });
  assert.equal(result.rows[0].status, 'unresolved');
  assert.equal(result.summary.resolvedAuthors, 0);
  assert.equal(classifyAuthorTheme(existing).key, 'unassigned');
});

test('theme provenance: matching derived secUID with another source link is insufficient', () => {
  const result = apply(candidate({ sourceEvidenceUrl: 'https://v.douyin.com/fixtureB/' }));
  assert.notEqual(result.rows[0].status, 'ready');
  assert.equal(result.summary.resolvedAuthors, 0);
});

test('theme provenance: matching source link with conflicting author cannot attach a theme', () => {
  const result = apply(candidate({ secUid: OTHER }));
  assert.notEqual(result.rows[0].status, 'ready');
  assert.equal(result.summary.resolvedAuthors, 0);
});

test('theme provenance: exact new source evidence can resolve the row without rewriting prior target', () => {
  const before = JSON.stringify(existing);
  const result = apply(candidate());
  assert.equal(result.rows[0].status, 'ready');
  assert.equal(result.summary.resolvedAuthors, 1);
  assert.equal(classifyAuthorTheme(result.rows[0]).key, 'tuantuan');
  assert.equal(JSON.stringify(existing), before);
  assert.equal(classifyAuthorTheme(existing).key, 'unassigned');
});
