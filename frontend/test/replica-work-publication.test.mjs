import test from 'node:test';
import assert from 'node:assert/strict';
import { compareWorkPublication, workPublicationDay, workPublicationDisplay } from '../lib/replica-work-publication.mjs';
import { historyExport } from '../lib/replica-export.mjs';

const asOf = '2026-10-24T10:00:00.000Z';
const account = { id: 234, platform: 'douyin', label: '作者甲' };
const manifest = { asOf, timeZone: 'Asia/Shanghai', files: [
  { path: 'works/234.json', kind: 'works', targetId: 234, sha256: 'a'.repeat(64), count: 1 },
] };
const sourceWork = {
  id: 'creator-source:24:170', targetId: 234, externalId: '7300000000000000000',
  caption: '来源表作品', url: null, publishedAt: null, publishedOn: '2026-10-12',
  publicationDateBasis: 'creator-source-date-only', firstSeenAt: '2026-10-20T09:00:00.000Z',
  lastObservedAt: null, likes: 123, comments: null, shares: null, collects: null,
  plays: 456, playsEvidence: { note: '表格累计播放，非逐作品平台采样' },
};

test('source-only work shows day precision and never turns source refresh into publication/playback time', () => {
  assert.deepEqual(workPublicationDisplay(sourceWork), {
    value: '2026-10-12', note: '日期依据待核验',
  });
  assert.equal(workPublicationDay(sourceWork), '2026-10-12');
  assert.equal(workPublicationDisplay({ ...sourceWork, publicationDateBasis: 'missing' }).value, '—');
  assert.equal(workPublicationDisplay({ ...sourceWork, publishedOn: '2026-02-30' }).value, '—');
  assert.equal(workPublicationDisplay({ ...sourceWork, publishedOn: null }).value, '—');
});

test('precise saved timestamp sorts by Beijing publication day alongside source-table day, without fake midnight', () => {
  const platformWork = { id: 10, publishedAt: '2026-10-11T18:30:00.000Z', publishedOn: null, publicationDateBasis: 'platform-timestamp' };
  const prior = { id: 9, publishedAt: '2026-10-10T12:00:00.000Z', publishedOn: null };
  const missing = { id: 11, publishedAt: null, publishedOn: null };
  assert.equal(workPublicationDay(platformWork), '2026-10-12');
  assert.equal(workPublicationDisplay(platformWork).note, '已保存发布时间');
  assert.equal(workPublicationDay({ ...platformWork, publicationDateBasis: undefined }), '2026-10-12');
  assert.deepEqual([missing, prior, sourceWork, platformWork].sort((a, b) => compareWorkPublication(a, b, 'desc')).map(row => row.id),
    [10, sourceWork.id, 9, 11]);
  assert.deepEqual([missing, prior, sourceWork, platformWork].sort((a, b) => compareWorkPublication(a, b, 'asc')).map(row => row.id),
    [9, 10, sourceWork.id, 11]);
});

test('work CSV preserves source day and basis separately from precise timestamp, and accepts stable source ID', () => {
  const rows = historyExport({ rows: [sourceWork], kind: 'works', account, manifest });
  const mapped = Object.fromEntries(rows[0].map((key, index) => [key, rows[1][index]]));
  assert.equal(mapped.id, sourceWork.id);
  assert.equal(mapped.publishedAt, null);
  assert.equal(mapped.publishedOn, '2026-10-12');
  assert.equal(mapped.publicationDateBasis, 'creator-source-date-only');
  assert.match(mapped.provenanceNote, /明确填报日期、推算或待核验日期/);
  assert.match(mapped.provenanceNote, /不是平台精确发布时间或播放观察日/);
  assert.equal(mapped.plays, 456);
  assert.throws(() => historyExport({ rows: [{ ...sourceWork, publishedOn: '2026-02-30' }], kind: 'works', account, manifest }), /日期依据或精度无效/);
  assert.throws(() => historyExport({ rows: [{ ...sourceWork, publicationDateBasis: 'unknown' }], kind: 'works', account, manifest }), /日期依据或精度无效/);
  assert.throws(() => historyExport({ rows: [{ ...sourceWork, publicationDateBasis: null }], kind: 'works', account, manifest }), /日期依据或精度无效/);
  assert.throws(() => historyExport({ rows: [{ ...sourceWork, publishedAt: '2026-10-12T00:00:00.000Z' }], kind: 'works', account, manifest }), /日期依据或精度无效/);
});
