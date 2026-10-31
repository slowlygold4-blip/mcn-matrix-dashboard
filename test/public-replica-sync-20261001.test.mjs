import {setTimeout as waitWithSignal} from 'node:timers/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPublicReplicaSync, sealPublicReplicaSource, preparePublicReplicaPublication, PUBLIC_REPLICA_ORIGIN,
  PUBLIC_REPLICA_SUMMARY_FIELDS } from '../lib/public-replica-sync.mjs';
import { describeWorkPlays } from '../lib/work-play-semantics.mjs';
import { preparePublishedSnapshotBaseline } from '../lib/committed-target-publication.mjs';
import { shouldPreparePublicDateIndex } from '../scripts/public-replica-publisher.mjs';
import { PUBLIC_REPLICA_EXPORT_REVISION } from '../lib/public-replica-export.mjs';

const SECRET = 'c'.repeat(64);
const SENTINEL = 'PRIVATE_FAKE_SECRET_MUST_NOT_ESCAPE';
const AS_OF = '2026-09-20T12:00:00.000Z';
const AT = '2026-09-20T02:00:00.000Z';
const SHA = 'a'.repeat(64);
const hash = text => createHash('sha256').update(text).digest('hex');
const clone = value => structuredClone(value);
const common = { version: 1, asOf: AS_OF, timeZone: 'Asia/Shanghai' };

function fixture({ accounts = 1 } = {}) {
  const counts = { accounts, enabledAccounts: accounts, boards: 0, daily: accounts * 2,
    works: accounts, workMetrics: accounts, topics: 0, topicDaily: 0, excludedAccountSnapshots: 0 };
  const policy = { readOnly: true, platformComplete: false, independentlyVerified: false, missingDatesFilled: false,
    accountDailyEvidence: 'checksum-and-normalized-vector-bound', worksMetricEvidence: 'saved-record-not-independently-verified',
    topicEvidence: 'per-snapshot-topic-identity-source-run-time-vector-bound', estimate: 'test estimate', note: 'test note',
    textRendering: 'textContent' };
  const files = [];
  const add = (path, kind, count, payload, targetId) => {
    const content = `${JSON.stringify({ ...common, ...payload })}\n`;
    files.push({ path, kind, ...(targetId ? { targetId } : {}), count, bytes: Buffer.byteLength(content), sha256: hash(content), content });
  };
  const latest = { value: 0, observedAt: AT, sourceChecksum: SHA, date: '2026-09-20' };
  add('catalog.json', 'catalog', accounts, { classificationRuleVersion: 'test-v1', boards: [],
    accounts: Array.from({ length: accounts }, (_, index) => ({ id: index + 1, label: `公开账号${index + 1}`,
      platform: 'douyin', enabled: true, boardKeys: [], historyRevision: { snapshotMaxId: 2, postMaxId: 1, postMetricMaxId: 1 },
      latest: { followers: latest, likes: latest, posts: latest },
      classification: { theme: { key: 'unknown', label: '待确认', confirmed: false, mode: 'test' },
        primaryKey: 'unclassified', primaryLabel: '待分类', labels: [], needsReview: true, mode: 'unclassified' } })) });
  add('topics.json', 'topics', 0, { topics: [], items: [] });
  for (let id = 1; id <= accounts; id++) {
    const daily = (day, value, previous) => {
      const time = `2026-09-${day}T02:00:00.000Z`;
      const row = { targetId: id, id: Number(day), date: `2026-09-${day}`, capturedAt: time,
        sourceChecksum: SHA, sampleCount: 1, followers: value, likes: value, posts: null,
        estimatedPlays: value * 100, estimatedPlaysDelta: previous === null ? null : (value - previous) * 100,
        estimatedPlaysProxy: 'likes-times-100' };
      for (const name of ['followers', 'likes', 'posts']) Object.assign(row, {
        [`${name}Delta`]: name === 'posts' || previous === null ? null : value - previous,
        [`${name}At`]: name === 'posts' ? null : time, [`${name}Checksum`]: name === 'posts' ? null : SHA,
        [`${name}BaselineAt`]: name === 'posts' || previous === null ? null : '2026-09-19T02:00:00.000Z',
        [`${name}BaselineChecksum`]: name === 'posts' || previous === null ? null : SHA,
      });
      return row;
    };
    add(`daily/${id}.json`, 'daily', 2, { items: [daily('19', 5, null), daily('20', 0, 5)] }, id);
    add(`works/${id}.json`, 'works', 1, { items: [{ targetId: id, id, externalId: String(7200000000000000000n + BigInt(id)),
      caption: '公开标题', url: null, publishedAt: AT, publishedOn: null,
      publicationDateBasis: 'platform-timestamp', firstSeenAt: AT, lastObservedAt: AT,
      likes: 0, comments: null, shares: 0, collects: null, plays: 0, playsEvidence: describeWorkPlays(0, 'douyin') }] }, id);
    add(`work-metrics/${id}.json`, 'workMetrics', 1, { items: [{ targetId: id, id, workId: id,
      externalId: String(7200000000000000000n + BigInt(id)), capturedAt: AT,
      likes: 0, comments: null, shares: 0, collects: null, plays: 0, playsEvidence: describeWorkPlays(0, 'douyin') }] }, id);
  }
  return { manifest: { ...common, policy, counts, files: files.map(({ content, ...file }) => file) }, files };
}

function editPart(source, path, edit) {
  const file = source.files.find(item => item.path === path), value = JSON.parse(file.content);
  edit(value); file.content = `${JSON.stringify(value)}\n`; file.sha256 = hash(file.content); file.bytes = Buffer.byteLength(file.content);
  Object.assign(source.manifest.files.find(item => item.path === path), { sha256: file.sha256, bytes: file.bytes });
}

function creatorSourceCumulativeFixture() {
  const source = fixture();
  editPart(source, 'works/1.json', part => {
    const work = part.items[0];
    work.id = 'creator-source:fixture:1';
    work.publishedAt = null;
    work.publishedOn = '2026-09-19';
    work.publicationDateBasis = 'creator-source-date-only';
    work.lastObservedAt = null;
    work.likes = 120;
    work.plays = 12345;
    work.playsEvidence = { basis: 'creator-source-cumulative', actualCountVerified: false,
      mayBePlaceholder: null,
      note: '飞书来源表记录的累计播放；来源刷新时间不是逐作品平台采样时间，非发布日期当天新增，非点赞估算。' };
  });
  // A spreadsheet-only work has no platform metric snapshots.
  source.files = source.files.filter(file => file.path !== 'work-metrics/1.json');
  source.manifest.files = source.manifest.files.filter(file => file.path !== 'work-metrics/1.json');
  source.manifest.counts.workMetrics = 0;
  return source;
}

function largeDailyFixture(pointsPerAccount) {
  const source = fixture({ accounts: 20 });
  for (const file of source.files.filter(item => item.kind === 'daily')) {
    editPart(source, file.path, part => {
      const base = part.items[1];
      part.items = Array.from({ length: pointsPerAccount }, (_, index) => {
        const capturedAt = new Date(Date.parse(AT) - index * 86_400_000).toISOString();
        const row = { ...base, id: index + 1, date: capturedAt.slice(0, 10), capturedAt,
          followersAt: capturedAt, likesAt: capturedAt, estimatedPlaysDelta: null };
        for (const name of ['followers', 'likes', 'posts']) Object.assign(row, {
          [`${name}Delta`]: null, [`${name}BaselineAt`]: null, [`${name}BaselineChecksum`]: null,
        });
        return row;
      });
    });
    file.count = pointsPerAccount;
    source.manifest.files.find(item => item.path === file.path).count = pointsPerAccount;
  }
  source.manifest.counts.daily = 20 * pointsPerAccount;
  return source;
}

function legacyPublication(source) {
  const items = source.files.filter(file => file.kind === 'daily').flatMap(file => JSON.parse(file.content).items)
    .map(point => Object.fromEntries(PUBLIC_REPLICA_SUMMARY_FIELDS.map(key => [key, point[key] ?? null])));
  const content = `${JSON.stringify({ ...common, items })}\n`;
  const file = { path: 'summary.json', kind: 'summary', count: items.length,
    bytes: Buffer.byteLength(content), sha256: hash(content), content };
  source.files.push(file); const { content: _, ...meta } = file; source.manifest.files.push(meta);
  return source;
}

function summaryRows(publication) {
  const summary = JSON.parse(publication.files.find(file => file.path === 'summary.json').content);
  return summary.format === 'daily-shards-v1'
    ? summary.shards.flatMap(shard => JSON.parse(publication.files.find(file => file.path === shard.path).content).items)
    : summary.items;
}

function fakeCloud() {
  const calls = [], staged = new Map(), published = new Map();
  const api = { calls, staged, published, failUploadAt: null, uploads: 0, onUpload: null,
    failActivationResponse: false, corruptPart: null, rejectActivationOnce: false };
  api.fetch = async (url, init = {}) => {
    assert.equal(new URL(url).origin, PUBLIC_REPLICA_ORIGIN); assert.equal(init.redirect, 'error');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method ?? 'GET', body, headers: init.headers });
    if (init.method !== 'POST') {
      assert.equal(init.headers?.Authorization, undefined);
      const params = new URL(url).searchParams, generation = params.get('generation');
      const manifest = published.get(generation);
      if (!manifest) return Response.json({ error: SENTINEL }, { status: 404 });
      const path = params.get('part');
      if (!path) return Response.json({ manifest, publishedAt: AS_OF, readOnly: true, collectionRequiresLocalComputer: true });
      const value = staged.get(generation)?.get(path);
      return new Response(api.corruptPart === path ? `${value.data} ` : value.data);
    }
    assert.equal(init.headers.Authorization, `Bearer ${SECRET}`);
    if (body.action === 'upload') {
      api.uploads++;
      if (api.uploads === api.failUploadAt) throw Error(`network ${SECRET} ${SENTINEL}`);
      const parts = staged.get(body.asOf) ?? new Map(); staged.set(body.asOf, parts);
      for (const file of body.files) {
        assert.equal(hash(file.data), file.sha256);
        const previous = parts.get(file.path); if (previous) assert.equal(previous.sha256, file.sha256);
        parts.set(file.path, file);
      }
      await api.onUpload?.(body);
      return Response.json({ accepted: body.files.length, asOf: body.asOf });
    }
    const parts = staged.get(body.asOf) ?? new Map();
    if (api.rejectActivationOnce) { api.rejectActivationOnce = false; staged.delete(body.asOf); return Response.json({ error: SENTINEL }, { status: 409 }); }
    if (parts.size !== body.manifest.files.length || body.manifest.files.some(file => parts.get(file.path)?.sha256 !== file.sha256)) {
      return Response.json({ error: SENTINEL }, { status: 409 });
    }
    published.set(body.asOf, clone(body.manifest));
    if (api.failActivationResponse) { api.failActivationResponse = false; throw Error(SENTINEL); }
    return Response.json({ published: true, asOf: body.asOf, parts: parts.size });
  };
  return api;
}

function producer(cloud, options = {}) {
  let checkpoint = null;
  const sync = createPublicReplicaSync({ fetchImpl: cloud.fetch, getCredential: async () => SECRET,
    loadCheckpoint: async () => clone(checkpoint), saveCheckpoint: async value => { checkpoint = clone(value); }, ...options });
  return { ...sync, checkpoint: () => clone(checkpoint) };
}

test('sync prepare preserves real 0/null/negative history and new summary shards have exactly nine source-bound fields', async () => {
  const source = fixture(), publication = await preparePublicReplicaPublication(source);
  const daily = JSON.parse(publication.files.find(file => file.kind === 'daily').content);
  const summary = JSON.parse(publication.files.find(file => file.kind === 'summary').content), items = summaryRows(publication);
  assert.equal(summary.format, 'daily-shards-v1'); assert.equal(summary.count, 2);
  assert.equal(daily.items[1].followersDelta, -5); assert.equal(daily.items[1].estimatedPlaysDelta, -500);
  assert.equal(items[1].followers, 0); assert.equal(items[1].posts, null);
  for (const item of items) assert.deepEqual(Object.keys(item), PUBLIC_REPLICA_SUMMARY_FIELDS);
  assert.deepEqual(items, daily.items.map(row => Object.fromEntries(PUBLIC_REPLICA_SUMMARY_FIELDS.map(key => [key, row[key] ?? null]))));
  assert.deepEqual(source, fixture());
});

test('spreadsheet-only cumulative plays remain explicitly unverified and publish without becoming daily reach', async () => {
  const source = creatorSourceCumulativeFixture();
  const prepared = await preparePublicReplicaPublication(source, { dateIndex: true });
  const work = JSON.parse(prepared.files.find(file => file.path === 'works/1.json').content).items[0];
  assert.equal(work.plays, 12345);
  assert.equal(work.playsEvidence.basis, 'creator-source-cumulative');
  assert.equal(work.playsEvidence.actualCountVerified, false);
  assert.equal(work.playsEvidence.mayBePlaceholder, null);
  assert.match(work.playsEvidence.note, /累计播放/);
  assert.match(work.playsEvidence.note, /非发布日期当天新增/);
  assert.equal(prepared.manifest.counts.daily, 2);
  assert.equal(prepared.manifest.counts.workMetrics, 0);
  const cloud = fakeCloud(), result = await producer(cloud).sync(source, { dateIndex: true });
  assert.equal(result.status, 'success');
  assert.equal(cloud.published.has(AS_OF), true);
});

test('source-cumulative zero keeps a possible-placeholder flag without claiming verified actual reach', async () => {
  const source = creatorSourceCumulativeFixture();
  editPart(source, 'works/1.json', part => {
    part.items[0].plays = 0;
    part.items[0].playsEvidence.mayBePlaceholder = true;
  });
  const prepared = await preparePublicReplicaPublication(source);
  const work = JSON.parse(prepared.files.find(file => file.path === 'works/1.json').content).items[0];
  assert.equal(work.plays, 0);
  assert.equal(work.playsEvidence.actualCountVerified, false);
  assert.equal(work.playsEvidence.mayBePlaceholder, true);
});

test('works publication date precision is sealed without inventing a platform timestamp', async () => {
  const source = creatorSourceCumulativeFixture();
  const prepared = await preparePublicReplicaPublication(source);
  const work = JSON.parse(prepared.files.find(file => file.path === 'works/1.json').content).items[0];
  assert.equal(work.publishedAt, null);
  assert.equal(work.publishedOn, '2026-09-19');
  assert.equal(work.publicationDateBasis, 'creator-source-date-only');
  for (const change of [
    item => { item.publishedOn = '2026-02-31'; },
    item => { item.publicationDateBasis = 'platform-timestamp'; },
    item => { item.publicationDateBasis = 'missing'; },
    item => { item.publishedAt = AT; },
  ]) {
    const invalid = creatorSourceCumulativeFixture();
    editPart(invalid, 'works/1.json', part => change(part.items[0]));
    const cloud = fakeCloud(), result = await producer(cloud).sync(invalid);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'invalid-source');
    assert.equal(cloud.calls.length, 0, 'invalid precision must fail before upload');
  }
});

test('current exporter revision can become the next publication baseline without relaxing its seal', async () => {
  const source = creatorSourceCumulativeFixture();
  const sealed = await preparePublicReplicaPublication(source, { dateIndex: true });
  const options = { asOf: AS_OF, manifestSha256: hash(JSON.stringify(sealed.manifest)),
    exportRevision: PUBLIC_REPLICA_EXPORT_REVISION };
  assert.equal((await preparePublishedSnapshotBaseline(source, options)).asOf, AS_OF);
  await assert.rejects(preparePublishedSnapshotBaseline(source, {...options, manifestSha256: '0'.repeat(64)}));
  const tampered = clone(source);
  editPart(tampered, 'works/1.json', part => { part.items[0].likes = 999999; });
  await assert.rejects(preparePublishedSnapshotBaseline(tampered, options));
});

test('a sealed v2 work partition is accepted only as the explicitly versioned prior baseline', async () => {
  const old = fixture();
  editPart(old, 'works/1.json', part => {
    delete part.items[0].publishedOn;
    delete part.items[0].publicationDateBasis;
  });
  const oldWorkBytes = old.files.find(file => file.path === 'works/1.json').content;
  await assert.rejects(preparePublicReplicaPublication(old), /invalid-source/,
    'new publications cannot silently use the old work schema');
  const sealed = await preparePublicReplicaPublication(old, { dateIndex: true, workSchemaVersion: 'v2' });
  const options = { asOf: AS_OF, manifestSha256: hash(JSON.stringify(sealed.manifest)),
    exportRevision: 'catalog-date-range-v2-roster-classification' };
  const baseline = await preparePublishedSnapshotBaseline(old, options);
  assert.equal(baseline.asOf, AS_OF);
  assert.equal(sealed.files.find(file => file.path === 'works/1.json').content, oldWorkBytes,
    'old sealed works bytes are not rewritten or furnished with invented dates');
  await assert.rejects(preparePublishedSnapshotBaseline(old, {
    ...options, exportRevision: 'catalog-date-range-v3-work-publication-date',
  }), /invalid-source/);
  await assert.rejects(preparePublishedSnapshotBaseline(old, {
    ...options, exportRevision: 'unknown-revision',
  }), /invalid-committed-target-publication/);
});

test('v2 compatibility cannot launder malformed dates or weakened v3 works into publication', async () => {
  const old = fixture();
  editPart(old, 'works/1.json', part => {
    delete part.items[0].publishedOn;
    delete part.items[0].publicationDateBasis;
    part.items[0].publishedAt = '2026-09-21T02:00:00.000Z';
  });
  await assert.rejects(preparePublicReplicaPublication(old, { workSchemaVersion: 'v2' }), /invalid-source/,
    'even a legacy baseline cannot contain a post-publication timestamp');
  const malformed = fixture();
  editPart(malformed, 'works/1.json', part => { delete part.items[0].publicationDateBasis; });
  await assert.rejects(preparePublicReplicaPublication(malformed), /invalid-source/);
  await assert.rejects(preparePublicReplicaPublication(malformed, { workSchemaVersion: 'v2' }), /invalid-source/,
    'a partially downgraded v3 row matches neither exact versioned work shape');
  const cloud = fakeCloud(), result = await producer(cloud).sync(malformed);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'invalid-source');
  assert.equal(cloud.calls.length, 0, 'invalid v3 source is rejected before any upload');
});

test('cumulative-play evidence rejects verified or placeholder claims and notes missing temporal limits before network', async () => {
  const changes = [
    evidence => { evidence.actualCountVerified = true; },
    evidence => { evidence.mayBePlaceholder = true; },
    evidence => { evidence.note = '飞书来源表记录的播放；非发布日期当天新增。'; },
    evidence => { evidence.note = '飞书来源表记录的累计播放。'; },
    evidence => { evidence.note = '来源播放字段。'; },
    evidence => { evidence.note += ' 已核验为平台实际播放。'; },
  ];
  for (const change of changes) {
    const source = creatorSourceCumulativeFixture();
    editPart(source, 'works/1.json', part => change(part.items[0].playsEvidence));
    const cloud = fakeCloud(), result = await producer(cloud).sync(source);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'invalid-source');
    assert.equal(cloud.calls.length, 0);
  }
  for (const plays of [null, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const source = creatorSourceCumulativeFixture();
    editPart(source, 'works/1.json', part => { part.items[0].plays = plays; });
    const cloud = fakeCloud(), result = await producer(cloud).sync(source);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'invalid-source');
    assert.equal(cloud.calls.length, 0);
  }
  const source = creatorSourceCumulativeFixture();
  editPart(source, 'works/1.json', part => { part.items[0].plays = 0; });
  const cloud = fakeCloud(), result = await producer(cloud).sync(source);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'invalid-source');
  assert.equal(cloud.calls.length, 0);
});

test('sync prepare rejects undeclared, extra, private nested fields, cross-target and stale metric date before network', async () => {
  const changes = [
    source => { source.files.push({ ...source.files[0], path: 'publication-receipt.json' }); },
    source => editPart(source, 'catalog.json', part => { part.accounts[0].source_url = SENTINEL; }),
    source => editPart(source, 'catalog.json', part => { part.accounts[0].classification.primaryLabel = { source_url: SENTINEL }; }),
    source => editPart(source, 'daily/1.json', part => { part.items[0].source_url = SENTINEL; }),
    source => editPart(source, 'daily/1.json', part => { part.items[0].targetId = 2; }),
    source => editPart(source, 'daily/1.json', part => { part.items[1].followersAt = '2026-09-19T02:00:00.000Z'; }),
    source => editPart(source, 'works/1.json', part => { part.items[0].caption = { cookieJar: SENTINEL }; }),
    source => editPart(source, 'topics.json', part => { part.asOf = '2026-09-19T12:00:00.000Z'; }),
    source => { source.manifest.files[0].bytes++; },
    source => { source.files[0].content += ' '; },
  ];
  for (const change of changes) {
    const source = fixture(); change(source); const cloud = fakeCloud(), sync = producer(cloud);
    const result = await sync.sync(source); assert.equal(result.status, 'failed'); assert.equal(result.code, 'invalid-source');
    assert.equal(cloud.calls.length, 0); assert.equal(JSON.stringify(result).includes(SENTINEL), false);
  }
});

test('sync publishes complete batches then atomically activates and anonymously verifies core bodies and the only summary shard', async () => {
  const cloud = fakeCloud(), sync = producer(cloud), result = await sync.sync(fixture({ accounts: 40 }));
  assert.equal(result.status, 'success'); assert.equal(result.parts, 124); assert.equal(result.sourceFilesValidated, 122);
  assert.equal(result.readbackFiles.length, 7); assert.equal(result.summaryFormat, 'daily-shards-v1');
  const posts = cloud.calls.filter(call => call.method === 'POST');
  assert.equal(posts.at(-1).body.action, 'activate');
  assert.equal(posts.slice(0, -1).every(call => call.body.action === 'upload' && call.body.files.length <= 35), true);
  assert.equal(cloud.published.get(AS_OF).files.length, 124);
  assert.equal(sync.checkpoint().readbackFiles.length, 7);
});

test('sync upload failure does not activate and restart resumes acknowledged immutable batches', async () => {
  const cloud = fakeCloud(); cloud.failUploadAt = 2; let checkpoint = null;
  const options = { loadCheckpoint: async () => checkpoint, saveCheckpoint: async value => { checkpoint = value; } };
  const first = producer(cloud, options), failed = await first.sync(fixture({ accounts: 40 }));
  assert.equal(failed.status, 'failed'); assert.equal(failed.activated, false);
  assert.equal(cloud.calls.some(call => call.body?.action === 'activate'), false);
  assert.equal(checkpoint.completedBatches.includes(0), true);
  assert.equal(checkpoint.completedBatches.includes(1), false); cloud.failUploadAt = null;
  const second = producer(cloud, options), resumed = await second.sync(fixture({ accounts: 40 }));
  assert.equal(resumed.status, 'success');
  const uploads = cloud.calls.filter(call => call.body?.action === 'upload');
  assert.equal(uploads.filter(call => call.body.files[0].path === 'catalog.json').length, 1);
  assert.equal(JSON.stringify(failed).includes(SECRET), false); assert.equal(JSON.stringify(failed).includes(SENTINEL), false);
});

test('v1 pending date-index publication resumes its exact checkpoint under v2 publisher code', async () => {
  const cloud = fakeCloud(), source = fixture({ accounts: 40 });
  cloud.failUploadAt = 2;
  let checkpoint = null;
  const options = { loadCheckpoint: async () => checkpoint,
    saveCheckpoint: async value => { checkpoint = clone(value); } };
  const v1 = producer(cloud, options);
  const failed = await v1.sync(source, { dateIndex: shouldPreparePublicDateIndex({ exportRevision: 'catalog-date-range-v1' }) });
  assert.equal(failed.status, 'failed');
  assert.equal(checkpoint.completedBatches.includes(0), true);
  const before = clone(checkpoint);
  cloud.failUploadAt = null;
  const v2 = producer(cloud, options);
  const resumed = await v2.sync(source, { dateIndex: shouldPreparePublicDateIndex({ exportRevision: 'catalog-date-range-v1' }) });
  assert.equal(resumed.status, 'success');
  assert.equal(checkpoint.manifestSha256, before.manifestSha256);
  assert.deepEqual(checkpoint.batchSha256, before.batchSha256);
  assert.equal(cloud.calls.filter(call => call.body?.action === 'upload'
    && call.body.files[0].path === 'catalog.json').length, 1);
  assert.deepEqual(checkpoint.completedBatches,
    Array.from({ length: resumed.batchesTotal }, (_, index) => index));
  assert.equal(cloud.published.get(AS_OF).files.some(file => file.path === 'date-summary-index.json'), true);
});

test('sync retries HTTP503 oversized uploads as bounded immutable parts without changing checkpoint hashes', async () => {
  const cloud = fakeCloud(), originalFetch = cloud.fetch, oversized = [];
  cloud.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (body?.action === 'upload' && body.files.length > 8) {
      oversized.push(body.files.length);
      // Simulate a server that wrote an entire first batch before its 503.
      // The smaller replay must remain idempotent and byte-identical.
      if (oversized.length === 1) await originalFetch(url, init);
      return Response.json({ error: SENTINEL }, { status: 503 });
    }
    return originalFetch(url, init);
  };
  const sync = producer(cloud), result = await sync.sync(fixture({ accounts: 80 }));
  assert.equal(result.status, 'success');
  assert.equal(oversized.length >= 1, true);
  assert.equal(result.batchesTotal > 4, true);
  assert.equal(oversized.length <= 4, true);
  assert.equal(cloud.calls.filter(call => call.body?.action === 'upload' && call.body.files.length <= 8).length > 0, true);
  assert.deepEqual(sync.checkpoint().completedBatches,
    Array.from({ length: result.batchesTotal }, (_, index) => index));
  assert.equal(cloud.staged.get(AS_OF).size, result.parts);
  assert.equal(cloud.calls.filter(call => call.body?.action === 'activate').length, 1);
  assert.equal(cloud.published.get(AS_OF).files.length, result.parts);
});

test('sync retries HTTP502 uploads as bounded immutable parts without changing checkpoint hashes', async () => {
  const cloud = fakeCloud(), originalFetch = cloud.fetch, oversized = [];
  cloud.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (body?.action === 'upload' && body.files.length > 8) {
      oversized.push(body.files.length);
      return Response.json({ error: SENTINEL }, { status: 502 });
    }
    return originalFetch(url, init);
  };
  const sync = producer(cloud), result = await sync.sync(fixture({ accounts: 80 }));
  assert.equal(result.status, 'success');
  assert.equal(oversized.length >= 1, true);
  assert.equal(cloud.calls.filter(call => call.body?.action === 'upload' && call.body.files.length <= 8).length > 0, true);
  assert.deepEqual(sync.checkpoint().completedBatches,
    Array.from({ length: result.batchesTotal }, (_, index) => index));
  assert.equal(sync.checkpoint().activated, true);
  assert.equal(cloud.published.get(AS_OF).files.length, result.parts);
});

test('sync persistent HTTP502 on reduced uploads leaves the generation inactive', async () => {
  const cloud = fakeCloud(), originalFetch = cloud.fetch, attempts = [];
  cloud.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (body?.action === 'upload') {
      attempts.push(body.files.length);
      return Response.json({ error: SENTINEL }, { status: 502 });
    }
    return originalFetch(url, init);
  };
  const sync = producer(cloud), result = await sync.sync(fixture({ accounts: 40 }));
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'sync-rejected');
  assert.deepEqual(result.transportFailure, { kind: 'http', method: 'POST', phase: 'upload',
    httpStatus: 502, category: 'server' });
  assert.equal(attempts.some(length => length > 8), true);
  assert.equal(attempts.some(length => length <= 8), true);
  assert.deepEqual(sync.checkpoint().completedBatches, []);
  assert.equal(sync.checkpoint().activated, false);
  assert.equal(cloud.calls.some(call => call.body?.action === 'activate'), false);
});

test('sync persistent HTTP503 even on small fallback does not checkpoint or activate incomplete batches', async () => {
  const cloud = fakeCloud(), originalFetch = cloud.fetch, attempts = [];
  cloud.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (body?.action === 'upload') {
      attempts.push(body.files.length);
      return Response.json({ error: SENTINEL }, { status: 503 });
    }
    return originalFetch(url, init);
  };
  const sync = producer(cloud), result = await sync.sync(fixture({ accounts: 40 }));
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'sync-rejected');
  assert.deepEqual(result.transportFailure, { kind: 'http', method: 'POST', phase: 'upload',
    httpStatus: 503, category: 'server' });
  assert.equal(attempts.some(length => length > 8), true);
  assert.equal(attempts.some(length => length <= 8), true);
  assert.deepEqual(sync.checkpoint().completedBatches, []);
  assert.equal(sync.checkpoint().activated, false);
  assert.equal(cloud.calls.some(call => call.body?.action === 'activate'), false);
  assert.equal(JSON.stringify(result).includes(SENTINEL), false);
});

test('sync keeps a partly accepted reduced batch uncommitted until a later exact replay finishes', async () => {
  const cloud = fakeCloud(), originalFetch = cloud.fetch;
  let refuseLarge = true, firstBatchPaths = null, acceptedFirstChunk = false, refusedSecondChunk = false;
  cloud.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (body?.action === 'upload' && refuseLarge && body.files.length > 8) {
      firstBatchPaths ??= new Set(body.files.map(file => file.path));
      return Response.json({ error: SENTINEL }, { status: 503 });
    }
    if (body?.action === 'upload' && refuseLarge && body.files.length <= 8) {
      if (firstBatchPaths?.has(body.files[0].path)) {
        if (acceptedFirstChunk && !refusedSecondChunk) {
          refusedSecondChunk = true;
          return Response.json({ error: SENTINEL }, { status: 503 });
        }
        acceptedFirstChunk = true;
      }
    }
    return originalFetch(url, init);
  };
  const sync = producer(cloud), source = fixture({ accounts: 40 });
  const failed = await sync.sync(source);
  assert.equal(failed.code, 'sync-rejected');
  assert.equal(acceptedFirstChunk, true);
  assert.equal(refusedSecondChunk, true);
  assert.equal(cloud.staged.get(AS_OF).size > 0, true);
  assert.equal(sync.checkpoint().completedBatches.includes(0), false);
  assert.equal(sync.checkpoint().completedBatches.length < failed.batchesTotal, true);
  assert.equal(cloud.calls.some(call => call.body?.action === 'activate'), false);
  refuseLarge = false;
  const resumed = await sync.sync(source);
  assert.equal(resumed.status, 'success');
  assert.equal(cloud.staged.get(AS_OF).size, resumed.parts);
  assert.equal(cloud.calls.filter(call => call.body?.action === 'activate').length, 1);
});

test('sync replay and unknown activation outcome probe published generation and never send duplicate POST', async () => {
  const cloud = fakeCloud(), sync = producer(cloud); cloud.failActivationResponse = true;
  assert.equal((await sync.sync(fixture())).status, 'failed');
  const before = cloud.calls.filter(call => call.method === 'POST').length;
  const replay = await sync.sync(fixture()); assert.equal(replay.status, 'success'); assert.equal(replay.alreadyPublished, true);
  assert.equal(cloud.calls.filter(call => call.method === 'POST').length, before);
});

test('sync distrusts same-asOf metadata drift, checkpoint pollution and corrupted anonymous body', async () => {
  const cloud = fakeCloud(), source = fixture(), publication = await preparePublicReplicaPublication(source);
  cloud.published.set(AS_OF, { ...publication.manifest, policy: { ...publication.manifest.policy, note: 'drift' } });
  const conflict = await producer(cloud).sync(source); assert.equal(conflict.code, 'generation-conflict');
  assert.equal(cloud.calls.some(call => call.method === 'POST'), false);
  const fresh = fakeCloud(), sync = producer(fresh, { loadCheckpoint: async () => ({ secret: SENTINEL, completedBatches: [9999] }) });
  fresh.corruptPart = 'summary.json'; const result = await sync.sync(source);
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'readback-hash-mismatch'); assert.equal(result.activated, true);
  assert.equal(JSON.stringify(result).includes(SENTINEL), false);
});

test('sync lost cloud staging resets local completion and succeeds on replay without overwriting published data', async () => {
  const cloud = fakeCloud(), sync = producer(cloud); cloud.rejectActivationOnce = true;
  const first = await sync.sync(fixture()); assert.equal(first.code, 'sync-rejected');
  assert.deepEqual(sync.checkpoint().completedBatches, []);
  assert.equal((await sync.sync(fixture())).status, 'success');
});

test('semantic activation refusal keeps verified uploads and exposes only a fixed diagnostic enum',async()=>{
 for(const [message,reason] of [['日期历史未通过全量来源核对，未发布','date-proof-rejected'],['每日发片索引核验失败','publishing-proof-rejected'],
  ['作者作品与经营统计核验失败，未发布','creator-proof-rejected'],['补充来源与统一名册核验失败，未发布','foundation-proof-rejected']]){
  const cloud=fakeCloud(),original=cloud.fetch;let reject=true;
  cloud.fetch=async(url,init={})=>{
   if(reject&&init.method==='POST'&&JSON.parse(init.body).action==='activate')return Response.json({error:message,private:SENTINEL},{status:409});
   return original(url,init);
  };
  const sync=producer(cloud),first=await sync.sync(fixture());
  assert.equal(first.transportFailure.activationReason,reason);
  assert.equal(sync.checkpoint().completedBatches.length,first.batchesTotal);
  assert.equal(JSON.stringify(first).includes(SENTINEL),false);
  const uploaded=cloud.uploads;reject=false;
  assert.equal((await sync.sync(fixture())).status,'success');
  assert.equal(cloud.uploads,uploaded,'correcting the validator must not resend every valid partition');
 }
});

test('sync persistence and credential failures cannot expose thrown body/secrets or activate', async () => {
  for (const options of [
    { saveCheckpoint: async () => { throw Error(`${SECRET} ${SENTINEL}`); } },
    { getCredential: async () => { throw Error(`${SECRET} ${SENTINEL}`); } },
  ]) {
    const cloud = fakeCloud(), sync = producer(cloud, options), result = await sync.sync(fixture());
    assert.equal(result.status, 'failed'); assert.equal(cloud.calls.some(call => call.method === 'POST'), false);
    assert.equal(JSON.stringify(result).includes(SECRET), false); assert.equal(JSON.stringify(sync.snapshot()).includes(SENTINEL), false);
  }
});

test('sync is single-flight across instances, releases its lock, and abort never activates incomplete upload', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const cloud = fakeCloud(), nativeFake = cloud.fetch;
  cloud.fetch = async (...args) => { await gate; return nativeFake(...args); };
  const first = producer(cloud), second = producer(cloud);
  const pending = first.sync(fixture()); assert.equal((await second.sync(fixture())).status, 'busy');
  release(); assert.equal((await pending).status, 'success');
  const abortCloud = fakeCloud(), abortProducer = producer(abortCloud);
  abortCloud.onUpload = async () => abortProducer.abort();
  const aborted = await abortProducer.sync(fixture()); assert.equal(aborted.code, 'aborted');
  assert.equal(abortCloud.calls.some(call => call.body?.action === 'activate'), false);
  abortCloud.onUpload = null; assert.equal((await abortProducer.sync(fixture())).status, 'success');
});

test('sync operation window aborts uncompleted request and redacts timeout exception', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const sync = createPublicReplicaSync({ operationTimeoutMs: 5, getCredential: async () => SECRET,
      fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Error(`${SECRET} ${SENTINEL}`)), { once: true });
      }) });
    const result = await sync.sync(fixture()); assert.equal(result.code, 'aborted');
    assert.equal(JSON.stringify(result).includes(SECRET), false); assert.equal(JSON.stringify(result).includes(SENTINEL), false);
  } finally { clearTimeout(keepAlive); }
});

test('sync runs at most four uploads, serializes checkpoint writes and drains siblings before failure returns', async () => {
  const cloud = fakeCloud(), fetch = cloud.fetch; let inFlight = 0, maximum = 0, pendingSaves = 0, maxSaves = 0;
  cloud.fetch = async (url, init = {}) => {
    if (init.method !== 'POST' || JSON.parse(init.body).action !== 'upload') return fetch(url, init);
    inFlight++; maximum = Math.max(maximum, inFlight);
    try {
      await new Promise((resolve, reject) => {
        const handle = setTimeout(resolve, 8);
        init.signal.addEventListener('abort', () => { clearTimeout(handle); reject(Error(SENTINEL)); }, { once: true });
      });
      return await fetch(url, init);
    } finally { inFlight--; }
  };
  let saved = null;
  const sync = producer(cloud, { loadCheckpoint: async () => saved, saveCheckpoint: async value => {
    pendingSaves++; maxSaves = Math.max(maxSaves, pendingSaves);
    await new Promise(resolve => setTimeout(resolve, 2)); saved = value; pendingSaves--;
  } });
  assert.equal((await sync.sync(fixture({ accounts: 40 }))).status, 'success');
  assert.equal(maximum, 4); assert.equal(maxSaves, 1); assert.equal(inFlight, 0);
  const failing = fakeCloud(); failing.failUploadAt = 1;
  const failingFetch = failing.fetch; let siblings = 0;
  failing.fetch = async (url, init = {}) => {
    if (init.method !== 'POST' || JSON.parse(init.body).action !== 'upload') return failingFetch(url, init);
    siblings++;
    try {
      await new Promise((resolve, reject) => {
        const handle = setTimeout(resolve, 8);
        init.signal.addEventListener('abort', () => { clearTimeout(handle); reject(Error(SENTINEL)); }, { once: true });
      });
      return await failingFetch(url, init);
    } finally { siblings--; }
  };
  assert.equal((await producer(failing).sync(fixture({ accounts: 40 }))).status, 'failed');
  assert.equal(siblings, 0); assert.equal(failing.calls.some(call => call.body?.action === 'activate'), false);
});

test('sync accepts only strict producer receipts, never response bodies with additional private keys', async () => {
  const cloud = fakeCloud(), fetch = cloud.fetch;
  cloud.fetch = async (url, init = {}) => {
    if (init.method === 'POST' && JSON.parse(init.body).action === 'upload') {
      return Response.json({ accepted: JSON.parse(init.body).files.length, asOf: AS_OF, secret: SENTINEL });
    }
    return fetch(url, init);
  };
  const result = await producer(cloud).sync(fixture());
  assert.equal(result.code, 'invalid-upload-receipt'); assert.equal(JSON.stringify(result).includes(SENTINEL), false);
  assert.equal(cloud.calls.some(call => call.body?.action === 'activate'), false);
});

test('sync preserves existing 4M–6M legacy summary bytes, manifest and upload checkpoint semantics', async () => {
  const source = legacyPublication(largeDailyFixture(1000)), publication = await preparePublicReplicaPublication(source);
  const summary = publication.files.find(file => file.kind === 'summary');
  assert.equal(summary.content.length > 4_000_000, true); assert.equal(summary.content.length <= 6_000_000, true);
  assert.deepEqual(publication, source);
  assert.deepEqual(await preparePublicReplicaPublication(publication), publication);
  const cloud = fakeCloud(), legacy = legacyPublication(fixture({ accounts: 40 })), sync = producer(cloud);
  cloud.failUploadAt = 2; const failed = await sync.sync(legacy); assert.equal(failed.status, 'failed');
  const checkpoint = sync.checkpoint(); assert.equal(checkpoint.manifestSha256, hash(JSON.stringify(legacy.manifest)));
  cloud.failUploadAt = null; assert.equal((await sync.sync(legacy)).status, 'success');
  assert.equal(cloud.calls.filter(call => call.body?.action === 'upload' && call.body.files[0].path === 'catalog.json').length, 1);
  assert.deepEqual(cloud.published.get(AS_OF), legacy.manifest);
  const previousPosts = cloud.calls.filter(call => call.method === 'POST').length;
  const replay = await sync.sync(legacy); assert.equal(replay.summaryFormat, 'legacy-items-v1');
  assert.equal(replay.readbackFiles.length, 6); assert.equal(cloud.calls.filter(call => call.method === 'POST').length, previousPosts);
});

test('sync counts complete escaped UTF-8 request bytes and rejects a single partition over 7.5M', async () => {
  const source = fixture(); editPart(source, 'works/1.json', part => { part.items[0].caption = '\\'.repeat(1_900_000); });
  assert.equal(source.files.find(file => file.kind === 'works').content.length < 4_000_000, true);
  const cloud = fakeCloud(), result = await producer(cloud).sync(source);
  assert.equal(result.code, 'partition-too-large'); assert.equal(cloud.calls.length, 0);
});

test('sync shards fresh source beyond the old 6M total, preserves complete order and verifies index plus first/last shard', async () => {
  const source = largeDailyFixture(1500), legacy = legacyPublication(clone(source));
  assert.equal(legacy.files.find(file => file.kind === 'summary').content.length > 6_000_000, true);
  const publication = await preparePublicReplicaPublication(source), index = JSON.parse(publication.files.find(file => file.kind === 'summary').content);
  assert.deepEqual(Object.keys(index), ['version', 'asOf', 'timeZone', 'format', 'count', 'shards']);
  assert.equal(index.count, 30_000); assert.equal(index.shards.length, 15);
  assert.equal(publication.files.find(file => file.kind === 'summary').content.length < 1_000_000, true);
  for (const [number, descriptor] of index.shards.entries()) {
    assert.equal(descriptor.path, `summary/${String(number + 1).padStart(6, '0')}.json`);
    const file = publication.files.find(item => item.path === descriptor.path), part = JSON.parse(file.content);
    assert.equal(file.kind, 'summaryShard'); assert.equal('targetId' in file, false);
    assert.equal(file.count <= 2000, true); assert.equal(file.content.length <= 1_000_000, true);
    assert.equal(descriptor.bytes, Buffer.byteLength(file.content)); assert.equal(descriptor.sha256, hash(file.content));
    for (const row of part.items) assert.deepEqual(Object.keys(row), PUBLIC_REPLICA_SUMMARY_FIELDS);
  }
  assert.deepEqual(summaryRows(publication), summaryRows(legacy));
  assert.deepEqual(await preparePublicReplicaPublication(publication), publication);
  const cloud = fakeCloud(), sync = producer(cloud), result = await sync.sync(publication);
  assert.equal(result.status, 'success'); assert.equal(result.sourceFilesValidated, 62);
  assert.equal(result.summaryShards, 15); assert.equal(result.readbackFiles.length, 8);
  assert.equal(result.readbackFiles.includes('summary/000001.json'), true);
  assert.equal(result.readbackFiles.includes('summary/000015.json'), true);
  assert.equal(cloud.calls.filter(call => call.method === 'POST').every(call => Buffer.byteLength(JSON.stringify(call.body)) <= 7_500_000), true);
});

test('sync rejects bad shard index, missing/extra shard, mixed generation, source drift and shard limit without any network', async () => {
  const valid = await preparePublicReplicaPublication(largeDailyFixture(210));
  assert.equal(JSON.parse(valid.files.find(file => file.path === 'summary.json').content).shards.length, 3);
  const changes = [
    source => { source.manifest.counts.daily = 4096 * 2000 + 1; },
    source => editPart(source, 'summary.json', part => { part.count++; }),
    source => editPart(source, 'summary.json', part => { part.source_url = SENTINEL; }),
    source => editPart(source, 'summary.json', part => { part.shards[0].bytes++; }),
    source => editPart(source, 'summary.json', part => { part.shards[0].sha256 = SHA; }),
    source => editPart(source, 'summary.json', part => { part.shards.reverse(); }),
    source => editPart(source, 'summary.json', part => { part.shards[0].path = 'summary/000000.json'; }),
    source => editPart(source, 'summary.json', part => { part.shards = Array.from({ length: 4097 }, (_, i) => ({ ...part.shards[0], path: `summary/${String(i + 1).padStart(6, '0')}.json` })); }),
    source => { source.files = source.files.filter(file => file.path !== 'summary/000002.json'); source.manifest.files = source.manifest.files.filter(file => file.path !== 'summary/000002.json'); },
    source => { source.files = source.files.filter(file => file.path !== 'summary.json'); source.manifest.files = source.manifest.files.filter(file => file.path !== 'summary.json'); },
    source => editPart(source, 'summary/000002.json', part => { part.asOf = '2026-09-19T12:00:00.000Z'; }),
    source => editPart(source, 'summary/000002.json', part => { part.items.reverse(); }),
    source => editPart(source, 'summary/000002.json', part => { part.items[0].targetId = 9999; }),
    source => editPart(source, 'summary/000002.json', part => { part.items[0].raw_json = SENTINEL; }),
    source => { const file = clone(source.files.find(file => file.kind === 'summaryShard')); file.path = 'summary/000004.json'; source.files.push(file); const { content, ...meta } = file; source.manifest.files.push(meta); },
    source => { const file = source.files.find(file => file.kind === 'summaryShard'); file.targetId = 1; source.manifest.files.find(item => item.path === file.path).targetId = 1; },
    source => {
      const file = source.files.find(file => file.kind === 'summaryShard'); file.content += ' '.repeat(1_000_000);
      file.sha256 = hash(file.content); file.bytes = Buffer.byteLength(file.content);
      Object.assign(source.manifest.files.find(item => item.path === file.path), { sha256: file.sha256, bytes: file.bytes });
    },
  ];
  for (const change of changes) {
    const source = clone(valid); change(source); const cloud = fakeCloud(), result = await producer(cloud).sync(source);
    assert.equal(result.status, 'failed'); assert.equal(['invalid-source', 'invalid-summary'].includes(result.code), true);
    assert.equal(cloud.calls.length, 0); assert.equal(JSON.stringify(result).includes(SENTINEL), false);
  }
});

test('sync cannot mix legacy summary with derived shards or rewrite an already published legacy generation', async () => {
  const legacy = legacyPublication(fixture()), sharded = await preparePublicReplicaPublication(fixture());
  const mixed = clone(legacy), file = clone(sharded.files.find(item => item.kind === 'summaryShard'));
  mixed.files.push(file); const { content: _, ...meta } = file; mixed.manifest.files.push(meta);
  const cloud = fakeCloud(), mixedResult = await producer(cloud).sync(mixed);
  assert.equal(mixedResult.code, 'invalid-summary'); assert.equal(cloud.calls.length, 0);
  const sync = producer(cloud); assert.equal((await sync.sync(legacy)).status, 'success');
  const count = cloud.calls.filter(call => call.method === 'POST').length;
  assert.equal((await sync.sync(fixture())).code, 'generation-conflict');
  assert.equal(cloud.calls.filter(call => call.method === 'POST').length, count);
});

test('sync shard checkpoint resumes exact batches and unknown activation outcomes, readback detects corrupted last shard', async () => {
  const source = await preparePublicReplicaPublication(largeDailyFixture(210)), cloud = fakeCloud(), sync = producer(cloud);
  cloud.failActivationResponse = true;
  const unknown = await sync.sync(source); assert.equal(unknown.activationState, 'unknown');
  const posts = cloud.calls.filter(call => call.method === 'POST').length;
  cloud.corruptPart = 'summary/000003.json';
  const corrupt = await sync.sync(source); assert.equal(corrupt.code, 'readback-hash-mismatch'); assert.equal(corrupt.activated, true);
  assert.equal(cloud.calls.filter(call => call.method === 'POST').length, posts);
  cloud.corruptPart = null; const done = await sync.sync(source);
  assert.equal(done.status, 'success'); assert.equal(done.readbackFiles.length, 8);
  assert.equal(sync.checkpoint().manifestSha256, hash(JSON.stringify(source.manifest)));
});

test('sync accepts the unchanged v1 checkpoint hashes of an already uploaded legacy batch', async () => {
  const legacy = legacyPublication(fixture()), cloud = fakeCloud();
  const batch = legacy.files.map(({ path, sha256, content }) => ({ path, sha256, data: content }));
  cloud.staged.set(AS_OF, new Map(batch.map(file => [file.path, file])));
  const oldCheckpoint = { version: 1, origin: PUBLIC_REPLICA_ORIGIN, asOf: AS_OF,
    manifestSha256: hash(JSON.stringify(legacy.manifest)), batchSha256: [hash(JSON.stringify(batch))],
    completedBatches: [0], activated: false, readbackFiles: [] };
  const sync = producer(cloud, { loadCheckpoint: async () => oldCheckpoint });
  const result = await sync.sync(legacy); assert.equal(result.status, 'success');
  assert.equal(cloud.calls.filter(call => call.body?.action === 'upload').length, 0);
  assert.equal(cloud.calls.filter(call => call.body?.action === 'activate').length, 1);
  assert.equal(sync.snapshot().manifestSha256, oldCheckpoint.manifestSha256);
  assert.equal(result.summaryFormat, 'legacy-items-v1');
});


test('live source projection accepts only unique rows and existing account targets', async()=>{
 const valid={revision:'1697',modifiedAt:'2026-09-18T12:00:00.000Z',rowCount:34150,links:[{authorRow:23,targetId:1}]};
 const source=fixture();editPart(source,'catalog.json',part=>{part.creatorSourceLinks=valid;});
 const published=await preparePublicReplicaPublication(source);
 assert.deepEqual(JSON.parse(published.files.find(f=>f.path==='catalog.json').content).creatorSourceLinks,valid);
 for(const bad of [{...valid,links:[{authorRow:23,targetId:999}]},
  {...valid,links:[...valid.links,...valid.links]}, {...valid,sourceUrl:'https://private.invalid'},
  {...valid,modifiedAt:'2029-01-01T00:00:00.000Z'}]){
  const invalid=fixture();editPart(invalid,'catalog.json',part=>{part.creatorSourceLinks=bad;});
  await assert.rejects(()=>preparePublicReplicaPublication(invalid));
 }
});

test('a growing account directory above 4 MB publishes without widening work-partition limits',async()=>{
 const source=fixture();
 editPart(source,'catalog.json',part=>{
  const base=part.accounts[0];
  const count=Math.ceil(4_100_000/Buffer.byteLength(JSON.stringify(base)))+20;
  part.accounts=Array.from({length:count},(_,i)=>({...structuredClone(base),id:i+1}));
 });
 const catalog=source.files.find(f=>f.path==='catalog.json');
 const accounts=JSON.parse(catalog.content).accounts;
 catalog.count=accounts.length;source.manifest.files.find(f=>f.path==='catalog.json').count=accounts.length;
 source.manifest.counts.accounts=accounts.length;
 source.manifest.counts.enabledAccounts=accounts.filter(a=>a.enabled).length;
 assert.ok(catalog.bytes>4_000_000&&catalog.bytes<8_000_000);
 const cloud=fakeCloud();const result=await producer(cloud).sync(source);
 assert.equal(result.status,'success',JSON.stringify(result));
 assert.equal(cloud.published.get(AS_OF).counts.accounts,accounts.length);
});


test('sealed retries reuse only an immutable validated plan and keep remote readback fresh', async () => {
  const raw=fixture(), sealed=sealPublicReplicaSource(raw), cloud=fakeCloud();
  raw.manifest.asOf='corrupted';raw.files[0].content='corrupted';
  assert.equal(sealed.manifest.asOf,AS_OF);
  assert.throws(()=>{sealed.manifest.counts.accounts=999;},TypeError);
  assert.throws(()=>{sealed.files[0].content='changed';},TypeError);
  cloud.failActivationResponse=true;const sync=producer(cloud);
  const first=await sync.sync(sealed);assert.equal(first.status,'failed');assert.equal(first.sourceValidation,'full');
  const uploads=cloud.uploads,second=await sync.sync(sealed);
  assert.equal(second.status,'success');assert.equal(second.sourceValidation,'reused-immutable');assert.equal(cloud.uploads,uploads);
  cloud.corruptPart='catalog.json';const corrupt=await sync.sync(sealed);
  assert.equal(corrupt.status,'failed');assert.equal(corrupt.code,'readback-hash-mismatch');
  assert.equal(corrupt.sourceValidation,'reused-immutable');
});

test('mutable or newly sealed input cannot reuse validation capabilities',async()=>{
  const cloud=fakeCloud(),sync=producer(cloud),raw=fixture();
  assert.equal((await sync.sync(raw)).status,'success');const uploads=cloud.uploads;
  raw.files[0].content='{}';const changed=await sync.sync(raw);
  assert.equal(changed.status,'failed');assert.equal(changed.sourceValidation,'full');assert.equal(cloud.uploads,uploads);
  const sealed=sealPublicReplicaSource(fixture());
  assert.equal((await sync.sync(sealed)).sourceValidation,'full');
  assert.equal((await sync.sync(sealPublicReplicaSource(fixture()))).sourceValidation,'full');
  assert.equal((await producer(cloud).sync(sealed)).sourceValidation,'full');
  const bad=fixture();bad.files[0].content='{}';const calls=cloud.calls.length;
  const invalid=await sync.sync(sealPublicReplicaSource(bad));assert.equal(invalid.status,'failed');
  assert.equal(cloud.calls.length,calls);
});

test('sealed mode changes and aborted retries cannot bypass fresh validation or cancellation',async()=>{
  const sealed=sealPublicReplicaSource(fixture()),cloud=fakeCloud();
  const sync=producer(cloud,{getCredential:async()=>{throw Error('unavailable');}});
  const first=await sync.sync(sealed);assert.equal(first.sourceValidation,'full');
  assert.equal((await sync.sync(sealed)).sourceValidation,'reused-immutable');
  assert.equal((await sync.sync(sealed,{dateIndex:true})).sourceValidation,'full');
  assert.equal((await sync.sync(sealed,{dateIndex:true})).sourceValidation,'reused-immutable');
  const calls=cloud.calls.length;const controller=new AbortController();controller.abort();
  assert.equal((await sync.sync(sealed,{signal:controller.signal})).code,'aborted');assert.equal(cloud.calls.length,calls);
});

test('lost checkpoint replays required batches instead of sharing mutable cached receipts',async()=>{
  let checkpoint=null;const cloud=fakeCloud(),sealed=sealPublicReplicaSource(fixture());
  const sync=producer(cloud,{loadCheckpoint:async()=>clone(checkpoint),saveCheckpoint:async x=>{checkpoint=clone(x);}});
  cloud.rejectActivationOnce=true;const first=await sync.sync(sealed);assert.equal(first.status,'failed');
  const uploads=cloud.uploads;checkpoint=null;
  const second=await sync.sync(sealed);assert.equal(second.status,'success');
  assert.equal(second.sourceValidation,'reused-immutable');assert.ok(cloud.uploads>uploads);
});


test('synthetic retry timing excludes real HTTP and models',async()=>{
  const raw=fixture({accounts:1000}),sealed=sealPublicReplicaSource(raw),cloud=fakeCloud();
  const sync=producer(cloud,{getCredential:async()=>{throw Error('unavailable');}});
  const before=performance.now();const cold=await sync.sync(sealed);const coldMs=performance.now()-before;
  const after=performance.now();const warm=await sync.sync(sealed);const warmMs=performance.now()-after;
  assert.equal(cold.sourceValidation,'full');assert.equal(warm.sourceValidation,'reused-immutable');
  assert.equal(cloud.calls.length,2);assert.equal(cloud.uploads,0);assert.equal(warm.code,'credential-unavailable');
  console.log(JSON.stringify({syntheticRetryBenchmark:true,accounts:1000,coldMs,warmMs,mockManifestReads:2,realHttpCalls:0,modelCalls:0}));
});


test('activation has its own bounded audit budget; uploads keep the short request budget',async()=>{
 for(const scenario of ['legacy','activation-budget','upload-timeout']){
  const cloud=fakeCloud(),original=cloud.fetch;
  cloud.fetch=async(url,init={})=>{
   const action=init.method==='POST'?JSON.parse(init.body).action:null;
   if(action===(scenario==='upload-timeout'?'upload':'activate'))await waitWithSignal(150,undefined,{signal:init.signal});
   return original(url,init);
  };
  const sync=producer(cloud,{requestTimeoutMs:100,...(scenario==='legacy'?{}:{activationTimeoutMs:400})});
  const r=await sync.sync(fixture({accounts:1}));
  if(scenario==='activation-budget')assert.equal(r.status,'success');
  else {assert.equal(r.code,'network-failed');assert.equal(r.transportFailure.kind,'request-timeout');assert.equal(r.transportFailure.phase,scenario==='legacy'?'activate':'upload');assert.equal(r.activated,false);}
 }
});

test('activation override cannot remove the enclosing operation deadline or accept an unbounded budget',async()=>{
 for(const activationTimeoutMs of [0,-1,300001,Infinity,NaN,'300000'])assert.throws(()=>createPublicReplicaSync({getCredential:async()=>SECRET,activationTimeoutMs}),/invalid-configuration/);
 const cloud=fakeCloud(),original=cloud.fetch;cloud.fetch=async(url,init={})=>{
  if(init.method==='POST'&&JSON.parse(init.body).action==='activate')await waitWithSignal(300,undefined,{signal:init.signal});
  return original(url,init);
 };
 const r=await producer(cloud,{requestTimeoutMs:100,activationTimeoutMs:400,operationTimeoutMs:200}).sync(fixture({accounts:1}));
 assert.equal(r.code,'aborted');assert.equal(r.activated,false);
});


test('gzip is opt-in and keeps raw checksums, checkpoints and authenticated receipts unchanged',async()=>{
 const{gunzipSync}=await import('node:zlib');const cloud=fakeCloud(),original=cloud.fetch;let requests=0,plainBytes=0,wireBytes=0;
 cloud.fetch=async(url,init={})=>{
  if(init.method==='POST'){
   assert.equal(init.headers['Content-Encoding'],'gzip');assert.equal(init.headers.Authorization,'Bearer '+SECRET);
   const text=gunzipSync(init.body).toString('utf8');plainBytes+=Buffer.byteLength(text);wireBytes+=init.body.byteLength;requests++;
   return original(url,{...init,body:text});
  }return original(url,init);
 };
 const source=fixture({accounts:40}),r=await producer(cloud,{compressRequests:true}).sync(source);
 assert.equal(r.status,'success');assert.ok(requests>1);assert.ok(wireBytes<plainBytes/2);assert.equal(r.requestEncoding,'gzip');
 assert.throws(()=>createPublicReplicaSync({getCredential:async()=>SECRET,compressRequests:'gzip'}),/invalid-configuration/);
});


test('reference reuse is optional; only bounded confirmed storage receipt counters enter status',async()=>{
 const cloud=fakeCloud(),original=cloud.fetch;
 cloud.fetch=async(url,init={})=>{
  if(init.method==='POST'&&JSON.parse(init.body).action==='upload'){
   const body=JSON.parse(init.body);assert.equal(body.reuseUnchanged,true);const r=await original(url,init);r.headers.set('X-Replica-Reused',String(body.files.length));r.headers.set('X-Replica-Stored','0');return r;
  }return original(url,init);
 };
 const r=await producer(cloud,{reuseUnchanged:true}).sync(fixture());assert.equal(r.status,'success');assert.equal(r.storageReceipts.files,r.parts);assert.equal(r.storageReceipts.reused,r.parts);assert.equal(r.storageReceipts.stored,0);
 assert.throws(()=>createPublicReplicaSync({getCredential:async()=>SECRET,reuseUnchanged:'true'}),/invalid-configuration/);
 const bad=fakeCloud(),fetch=bad.fetch;bad.fetch=async(...args)=>{const r=await fetch(...args);r.headers.set('X-Replica-Reused',SENTINEL);r.headers.set('X-Replica-Stored','-1');return r;};const result=await producer(bad,{reuseUnchanged:true}).sync(fixture());assert.equal(result.status,'success');assert.equal(result.storageReceipts,undefined);assert.equal(JSON.stringify(result).includes(SENTINEL),false);
});

test('repairable immutable-storage refusal replays acknowledged uploads without exposing raw errors',async()=>{
 const cloud=fakeCloud(),original=cloud.fetch;let reject=true;
 cloud.fetch=async(url,init={})=>reject&&init.method==='POST'&&JSON.parse(init.body).action==='activate'?Response.json({error:'存储分片缺失或损坏，未发布',private:SENTINEL},{status:409}):original(url,init);
 const owner=producer(cloud,{reuseUnchanged:true}),first=await owner.sync(fixture());assert.equal(first.transportFailure.activationReason,'missing-upload');assert.deepEqual(owner.checkpoint().completedBatches,[]);assert.equal(JSON.stringify(first).includes(SENTINEL),false);reject=false;assert.equal((await owner.sync(fixture())).status,'success');
});

test('bounded source audit precedes activation and a failed chunk resumes without reuploading complete data',async()=>{
 const cloud=fakeCloud(),original=cloud.fetch;let failSecond=true,uploads=0,activations=0;const chunks=[];
 cloud.fetch=async(url,init={})=>{
  const body=init.body?JSON.parse(init.body):null;
  if(body?.action==='audit-date'){
   chunks.push(body.chunkIndex);assert.equal(activations,0);
   if(failSecond&&body.chunkIndex===1)throw Error(SENTINEL);
   const n=body.manifest.files.filter(f=>f.kind==='daily').length;
   return Response.json({audited:true,asOf:body.asOf,chunkIndex:body.chunkIndex,chunkCount:Math.ceil(n/256),verifiedDaily:Math.min(256,n-body.chunkIndex*256)});
  }
  if(body?.action==='upload')uploads++;
  if(body?.action==='activate'){activations++;assert.equal(body.dateAudit,'date-source-chunks-v1');}
  return original(url,init);
 };
 const owner=producer(cloud,{chunkedDateAudit:true}),source=fixture({accounts:257});
 const first=await owner.sync(source,{dateIndex:true});assert.equal(first.status,'failed');assert.equal(first.phase,'source-audit');assert.equal(activations,0);assert.equal(JSON.stringify(first).includes(SENTINEL),false);
 const priorUploads=uploads;failSecond=false;const second=await owner.sync(source,{dateIndex:true});
 assert.equal(second.status,'success');assert.equal(uploads,priorUploads);assert.equal(activations,1);assert.deepEqual(chunks,[0,1,0,1]);assert.equal(second.sourceAuditChunksCompleted,2);
});

test('untrusted audit acknowledgement cannot enable activation or contaminate fixed diagnostics',async()=>{
 for(const extra of [{chunkIndex:1},{verifiedDaily:0},{audited:false},{private:SENTINEL}]){
  const cloud=fakeCloud(),original=cloud.fetch;let activation=false;
  cloud.fetch=async(url,init={})=>{const body=init.body?JSON.parse(init.body):null;
   if(body?.action==='audit-date')return Response.json({audited:true,asOf:body.asOf,chunkIndex:0,chunkCount:1,verifiedDaily:1,...extra});
   if(body?.action==='activate')activation=true;return original(url,init);
  };
  const result=await producer(cloud,{chunkedDateAudit:true}).sync(fixture(),{dateIndex:true});assert.equal(result.status,'failed');assert.equal(result.code,'invalid-date-audit-receipt');assert.equal(activation,false);assert.equal(JSON.stringify(result).includes(SENTINEL),false);
 }
 assert.throws(()=>createPublicReplicaSync({getCredential:async()=>SECRET,chunkedDateAudit:'yes'}),/invalid-configuration/);
});
