// Independent normalized-manifest/source proof regression; synthetic bytes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { preparePublicReplicaPublication } from '../lib/public-replica-sync.mjs';
import { verifyPublicHistoryDateIndex } from '../lib/public-history-range.mjs';

const asOf = '2026-10-01T05:08:10.925Z', timeZone = 'Asia/Shanghai';
const common = { version: 1, asOf, timeZone }, sha = s => createHash('sha256').update(s).digest('hex');
const metaOf = ({ content, ...meta }) => meta;
const isDate = f => ['summaryDateIndex', 'summaryDateShard'].includes(f.kind);

function fixture() {
  const files = [], add = (path, kind, count, body, targetId) => {
    const content = JSON.stringify({ ...common, ...body }) + '\n';
    files.push({ path, kind, ...(targetId ? { targetId } : {}), count,
      bytes: Buffer.byteLength(content), sha256: sha(content), content });
  };
  const capturedAt = '2026-09-30T02:00:00.000Z';
  const latest = { value: 10, observedAt: capturedAt, sourceChecksum: 'a'.repeat(64), date: '2026-09-30' };
  add('catalog.json', 'catalog', 1, { classificationRuleVersion: 'synthetic-hash-peer', boards: [], accounts: [{
    id: 1, label: 'Synthetic Account', platform: 'douyin', enabled: true, boardKeys: [],
    historyRevision: { snapshotMaxId: 2, postMaxId: 0, postMetricMaxId: 0 },
    classification: { theme: { key: 'unknown', label: 'Unknown', confirmed: false, mode: 'test' },
      primaryKey: 'unknown', primaryLabel: 'Unknown', labels: [], needsReview: true, mode: 'test' },
    latest: { followers: latest, likes: latest, posts: latest },
  }] });
  add('topics.json', 'topics', 0, { topics: [], items: [] });
  const items = ['2026-09-29', '2026-09-30'].map((date, i) => {
    const at = `${date}T02:00:00.000Z`, row = { targetId: 1, id: i + 1, date, capturedAt: at,
      sourceChecksum: 'a'.repeat(64), sampleCount: 1, followers: i, likes: i * 10, posts: i,
      estimatedPlays: i * 1000, estimatedPlaysDelta: null, estimatedPlaysProxy: 'likes-times-100' };
    for (const k of ['followers', 'likes', 'posts']) Object.assign(row, { [k + 'Delta']: null,
      [k + 'At']: at, [k + 'Checksum']: 'a'.repeat(64), [k + 'BaselineAt']: null, [k + 'BaselineChecksum']: null });
    return row;
  });
  add('daily/1.json', 'daily', 2, { items }, 1);
  return { manifest: { ...common,
    policy: { readOnly: true, platformComplete: false, independentlyVerified: false, missingDatesFilled: false,
      accountDailyEvidence: 'checksum-and-normalized-vector-bound', worksMetricEvidence: 'saved-record-not-independently-verified',
      topicEvidence: 'per-snapshot-topic-identity-source-run-time-vector-bound', estimate: 'synthetic', note: 'synthetic', textRendering: 'textContent' },
    counts: { accounts: 1, enabledAccounts: 1, boards: 0, daily: 2, works: 0, workMetrics: 0,
      topics: 0, topicDaily: 0, excludedAccountSnapshots: 0 }, files: files.map(metaOf) }, files };
}
function resignIndex(publication, sourceManifestSha256) {
  const f = publication.files.find(f => f.kind === 'summaryDateIndex'), body = JSON.parse(f.content);
  body.sourceManifestSha256 = sourceManifestSha256;
  f.content = JSON.stringify(body) + '\n'; f.bytes = Buffer.byteLength(f.content); f.sha256 = sha(f.content);
  Object.assign(publication.manifest.files.find(m => m.path === f.path), metaOf(f));
}

test('normalized date source: raw disk, raw normalized, prepared source and full publication hashes are distinct contracts', async () => {
  const raw = fixture(), before = JSON.stringify(raw), diskBytes = JSON.stringify(raw.manifest) + '\n';
  const normal = await preparePublicReplicaPublication(raw), publication = await preparePublicReplicaPublication(raw, { dateIndex: true });
  const file = publication.files.find(f => f.kind === 'summaryDateIndex'), index = JSON.parse(file.content);
  const expected = sha(JSON.stringify(normal.manifest));
  assert.notEqual(expected, sha(diskBytes));
  assert.notEqual(expected, sha(JSON.stringify(raw.manifest)));
  assert.notEqual(expected, sha(JSON.stringify(publication.manifest)));
  assert.equal(index.sourceManifestSha256, expected);
  assert.equal(JSON.stringify(raw), before);
});

test('normalized date source: removing only appended date metadata reconstructs the exact prepared source and sealed replay', async () => {
  const raw = fixture(), normal = await preparePublicReplicaPublication(raw), publication = await preparePublicReplicaPublication(raw, { dateIndex: true });
  const base = { ...publication.manifest, files: publication.manifest.files.filter(f => !isDate(f)) };
  assert.deepEqual(base, normal.manifest);
  const file = publication.files.find(f => f.kind === 'summaryDateIndex');
  assert.equal(verifyPublicHistoryDateIndex({ sourceManifest: base, indexContent: file.content,
    indexMeta: metaOf(file) }).sourceManifestSha256, sha(JSON.stringify(normal.manifest)));
  assert.deepEqual(await preparePublicReplicaPublication(publication), publication);
});

for (const mode of ['raw-disk', 'raw-normalized', 'full-publication']) {
  test(`normalized date source: re-signing the index with ${mode} hash cannot authorize source proof`, async () => {
    const raw = fixture(), publication = await preparePublicReplicaPublication(raw, { dateIndex: true });
    const incorrect = mode === 'raw-disk' ? sha(JSON.stringify(raw.manifest) + '\n')
      : mode === 'raw-normalized' ? sha(JSON.stringify(raw.manifest)) : sha(JSON.stringify(publication.manifest));
    resignIndex(publication, incorrect);
    await assert.rejects(preparePublicReplicaPublication(publication), error => ['invalid-source', 'invalid-summary'].includes(error.code));
  });
}
