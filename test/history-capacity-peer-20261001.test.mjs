// Capacity characterization, not an assertion that the current limits meet U45.
// Synthetic data only: no database, network, collector or production publisher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { preparePublicReplicaPublication } from '../lib/public-replica-sync.mjs';
import { loadSummary } from '../../mcn-public-site/lib/replica-summary.mjs';
import { loadReplicaView } from '../../mcn-public-site/lib/replica-view.mjs';
import { readReplicaPart } from '../../mcn-public-site/lib/replica-reader.mjs';

const AS_OF = '2026-10-01T00:00:00.000Z';
const AT = '2026-09-30T02:00:00.000Z';
const common = { version: 1, asOf: AS_OF, timeZone: 'Asia/Shanghai' };
const hash = text => createHash('sha256').update(text).digest('hex');
const summaryKeys = ['targetId', 'date', 'capturedAt', 'followers', 'followersAt', 'likes', 'likesAt', 'posts', 'postsAt'];

function summaryFixture(accounts, days) {
  const files = [], parts = new Map();
  let nextItems = [], total = 0, ordinal = 0;
  const add = (path, kind, count, value) => {
    const content = JSON.stringify(value) + '\n';
    const meta = { path, kind, count, bytes: Buffer.byteLength(content), sha256: hash(content) };
    parts.set(path, { content, value }); files.push(meta); return meta;
  };
  const flush = () => {
    if (!nextItems.length) return;
    const path = `summary/${String(++ordinal).padStart(6, '0')}.json`;
    add(path, 'summaryShard', nextItems.length, { ...common, items: nextItems });
    nextItems = [];
  };
  for (let targetId = 1; targetId <= accounts; targetId++) {
    for (let d = 0; d < days; d++) {
      const capturedAt = new Date(Date.parse(AT) - (days - 1 - d) * 86_400_000).toISOString();
      nextItems.push({ targetId, date: capturedAt.slice(0, 10), capturedAt,
        followers: d, followersAt: capturedAt, likes: d * 7, likesAt: capturedAt,
        posts: d, postsAt: capturedAt });
      total++;
      if (nextItems.length === 2000) flush();
    }
  }
  flush();
  const shards = files.map(({ kind, ...descriptor }) => descriptor);
  add('summary.json', 'summary', total,
    { ...common, format: 'daily-shards-v1', count: total, shards });
  return { manifest: { ...common, counts: { daily: total }, files }, parts };
}

function boundReader(fixture, requested) {
  let inFlight = 0, highWater = 0;
  const read = async path => {
    requested.push(path); inFlight++; highWater = Math.max(highWater, inFlight);
    try {
      // One microtask gives the real reader's four-way scheduler room to run.
      await Promise.resolve();
      const part = fixture.parts.get(path), meta = fixture.manifest.files.find(f => f.path === path);
      assert.ok(part && meta);
      assert.equal(Buffer.byteLength(part.content), meta.bytes);
      assert.equal(hash(part.content), meta.sha256);
      return part.value;
    } finally { inFlight--; }
  };
  return { read, highWater: () => highWater };
}

test('peer capacity: six months / 701 accounts read all 128283 compact rows, not a lazy window', async () => {
  const fixture = summaryFixture(701, 183), requested = [], reader = boundReader(fixture, requested);
  const items = await loadSummary(fixture.manifest, reader.read);
  assert.equal(items.length, 128_283);
  assert.deepEqual(Object.keys(items[0]), summaryKeys);
  assert.equal(items.at(-1).targetId, 701);
  assert.equal(items.at(-1).date, '2026-09-30');
  assert.equal(requested.length, Math.ceil(128_283 / 2000) + 1);
  assert.ok(reader.highWater() <= 4);
  assert.ok(fixture.manifest.files.reduce((sum, f) => sum + f.bytes, 0) < 64_000_000);
});

test('peer capacity: one year / 701 accounts currently rejects before even reading the index', async () => {
  const fixture = summaryFixture(701, 365), requested = [], reader = boundReader(fixture, requested);
  assert.equal(fixture.manifest.counts.daily, 255_865);
  await assert.rejects(loadSummary(fixture.manifest, reader.read), /历史超过单屏读取预算/);
  assert.deepEqual(requested, []);
});

test('peer capacity: the first 701-account daily row-limit failure is observation day 286', async () => {
  assert.equal(701 * 285, 199_785);
  assert.equal(701 * 286, 200_486);
  let reads = 0;
  await assert.rejects(loadSummary({ counts: { daily: 200_486 }, files: [] },
    async () => { reads++; throw new Error('must not fetch'); }), /历史超过单屏读取预算/);
  assert.equal(reads, 0);
});

test('peer capacity: a date hint cannot selectively read the existing v1 contract', async () => {
  const fixture = summaryFixture(3, 15), requested = [], reader = boundReader(fixture, requested);
  const items = await loadSummary(fixture.manifest, reader.read,
    { start: '2026-09-30', end: '2026-09-30' });
  assert.equal(items.length, 45);
  assert.equal(items.filter(p => p.date === '2026-09-30').length, 3);
  assert.deepEqual(requested, ['summary.json', 'summary/000001.json']);
});

function publicationFixture(metricRows = 2) {
  const files = [];
  const add = (path, kind, items, targetId, other = {}) => {
    const content = JSON.stringify({ ...common, ...other, ...(items ? { items } : {}) }) + '\n';
    files.push({ path, kind, ...(targetId ? { targetId } : {}), count: items?.length ?? 1,
      bytes: Buffer.byteLength(content), sha256: hash(content), content });
  };
  const latest = { value: 10, observedAt: AT, sourceChecksum: 'a'.repeat(64), date: '2026-09-30' };
  const account = { id: 1, label: 'Synthetic capacity account', platform: 'douyin', enabled: true,
    boardKeys: [], classification: { theme: { key: 'unknown', label: 'Unknown', confirmed: false, mode: 'test' },
      primaryKey: 'unknown', primaryLabel: 'Unknown', labels: [], needsReview: true, mode: 'test' },
    historyRevision: { snapshotMaxId: 1, postMaxId: 1, postMetricMaxId: metricRows },
    latest: { followers: latest, likes: latest, posts: latest } };
  add('catalog.json', 'catalog', null, null,
    { accounts: [account], boards: [], classificationRuleVersion: 'synthetic-capacity' });
  add('topics.json', 'topics', [], null, { topics: [] });
  const row = { targetId: 1, id: 1, date: '2026-09-30', capturedAt: AT,
    sourceChecksum: 'a'.repeat(64), sampleCount: 1, followers: 10, likes: 10, posts: 10,
    estimatedPlays: 1000, estimatedPlaysDelta: null, estimatedPlaysProxy: 'likes-times-100' };
  for (const k of ['followers', 'likes', 'posts']) Object.assign(row, {
    [k + 'Delta']: null, [k + 'At']: AT, [k + 'Checksum']: 'a'.repeat(64),
    [k + 'BaselineAt']: null, [k + 'BaselineChecksum']: null });
  add('daily/1.json', 'daily', [row], 1);
  const playsEvidence = { basis: 'missing', actualCountVerified: false, mayBePlaceholder: null,
    note: 'Synthetic missing play count; never a real production observation.' };
  add('works/1.json', 'works', [{ targetId: 1, id: 1, externalId: 'synthetic-1', caption: 'Synthetic',
    url: null, publishedAt: AT, firstSeenAt: AT, lastObservedAt: AT,
    likes: 10, comments: 1, shares: 1, collects: 1, plays: null, playsEvidence }], 1);
  add('work-metrics/1.json', 'workMetrics', Array.from({ length: metricRows }, (_, i) => ({ targetId: 1,
    id: i + 1, workId: 1, externalId: 'synthetic-1', capturedAt: AT,
    likes: i, comments: 1, shares: 1, collects: 1, plays: null, playsEvidence })), 1);
  const manifest = { ...common, counts: { accounts: 1, enabledAccounts: 1, boards: 0,
    daily: 1, works: 1, workMetrics: metricRows, topics: 0, topicDaily: 0, excludedAccountSnapshots: 0 },
    policy: { readOnly: true, platformComplete: false, independentlyVerified: false, missingDatesFilled: false,
      accountDailyEvidence: 'checksum-and-normalized-vector-bound', worksMetricEvidence: 'saved-record-not-independently-verified',
      topicEvidence: 'per-snapshot-topic-identity-source-run-time-vector-bound', estimate: 'synthetic',
      note: 'synthetic', textRendering: 'textContent' }, files: files.map(({ content, ...f }) => f) };
  return { manifest, files };
}

test('peer capacity: all-history work metrics are a single file and the producer rejects its growth beyond 4M characters', async () => {
  await preparePublicReplicaPublication(publicationFixture(2));
  const source = publicationFixture(20_000), metricFile = source.files.find(f => f.kind === 'workMetrics');
  assert.ok(metricFile.content.length > 4_000_000);
  assert.equal(metricFile.sha256, hash(metricFile.content));
  assert.equal(metricFile.bytes, Buffer.byteLength(metricFile.content));
  await assert.rejects(preparePublicReplicaPublication(source), { code: 'invalid-source' });
});

function viewFixture() {
  const fixture = summaryFixture(3, 2);
  const add = (path, kind, value, count) => {
    const content = JSON.stringify({ ...common, ...value }) + '\n';
    fixture.parts.set(path, { value: JSON.parse(content), content });
    fixture.manifest.files.push({ path, kind, count, bytes: Buffer.byteLength(content), sha256: hash(content) });
  };
  add('catalog.json', 'catalog', { accounts: [{ id: 1 }, { id: 2 }, { id: 3 }], boards: [] }, 3);
  add('topics.json', 'topics', { topics: [{ id: 41, label: '#synthetic' }], items: [] }, 0);
  return fixture;
}

function networkReader(fixture, requested, { corrupt = null, abortPart = null } = {}) {
  return path => readReplicaPart({ generation: fixture.manifest.asOf, part: path,
    meta: fixture.manifest.files.find(f => f.path === path),
    fetcher: async url => {
      const parameters = new URL(url, 'https://synthetic.invalid').searchParams;
      assert.equal(parameters.get('generation'), AS_OF);
      const part = parameters.get('part'); requested.push(part);
      if (part === abortPart) {
        await Promise.resolve();
        throw Object.assign(new Error('synthetic cancelled response'), { name: 'AbortError' });
      }
      const stored = fixture.parts.get(part), meta = fixture.manifest.files.find(f => f.path === part);
      assert.ok(stored && meta, `unexpected part ${part}`);
      return new Response(stored.content + (part === corrupt ? ' ' : ''), { headers: {
        'X-Data-SHA256': meta.sha256, 'X-Data-Cutoff': AS_OF,
        'Content-Type': 'application/json',
      } });
    } });
}

test('peer failure isolation: a personal page does not request global summary and retains its catalog/topic metadata', async () => {
  const fixture = viewFixture(), requested = [];
  fixture.manifest.counts.daily = 255_865;
  const result = await loadReplicaView({ manifest: fixture.manifest,
    readPart: networkReader(fixture, requested), personal: true });
  assert.deepEqual(requested.sort(), ['catalog.json', 'topics.json']);
  assert.equal(result.accounts.length, 3);
  assert.equal(result.topics.topics[0].id, 41);
  assert.equal(result.summaryLoaded, false);
  assert.equal(result.summaryError, '');
  assert.deepEqual(result.points, []); // unloaded marker, never a successfully measured zero
});

test('peer failure isolation: topics-only bypasses summary even when global history exceeds the budget', async () => {
  const fixture = viewFixture(), requested = [];
  fixture.manifest.counts.daily = 255_865;
  const result = await loadReplicaView({ manifest: fixture.manifest,
    readPart: networkReader(fixture, requested), topicsOnly: true });
  assert.deepEqual(requested.sort(), ['catalog.json', 'topics.json']);
  assert.equal(result.topics.topics[0].label, '#synthetic');
  assert.equal(result.summaryLoaded, false);
  assert.equal(result.summaryError, '');
});

test('peer failure isolation: a global capacity failure retains verified metadata but not a successful empty summary', async () => {
  const fixture = viewFixture(), requested = [];
  fixture.manifest.counts.daily = 255_865;
  const result = await loadReplicaView({ manifest: fixture.manifest,
    readPart: networkReader(fixture, requested) });
  assert.equal(result.accounts.length, 3);
  assert.equal(result.topics.topics[0].id, 41);
  assert.equal(result.summaryLoaded, false);
  assert.match(result.summaryError, /矩阵日历史暂不可读/);
  assert.deepEqual(result.points, []);
  assert.deepEqual(requested.sort(), ['catalog.json', 'topics.json']);
});

test('peer failure isolation: corrupt catalog or topic bytes cannot become accepted metadata', async () => {
  for (const corrupt of ['catalog.json', 'topics.json']) {
    for (const options of [{ personal: true }, { topicsOnly: true }, {}]) {
      const fixture = viewFixture(), requested = [];
      await assert.rejects(loadReplicaView({ manifest: fixture.manifest,
        readPart: networkReader(fixture, requested, { corrupt }), ...options }), /校验不一致/);
      assert.ok(!requested.some(path => path.startsWith('summary')));
    }
  }
});

test('peer failure isolation: normal global loading still exposes all verified points with a success marker', async () => {
  const fixture = viewFixture(), requested = [];
  const result = await loadReplicaView({ manifest: fixture.manifest,
    readPart: networkReader(fixture, requested) });
  assert.equal(result.summaryLoaded, true);
  assert.equal(result.summaryError, '');
  assert.equal(result.points.length, 6);
  assert.ok(requested.includes('summary.json'));
  assert.ok(requested.includes('summary/000001.json'));
  assert.equal(result.points.at(-1).targetId, 3);
});

test('peer failure isolation: a late aborted summary response is cancellation, not a displayable degraded result', async () => {
  const fixture = viewFixture(), requested = [];
  await assert.rejects(loadReplicaView({ manifest: fixture.manifest,
    readPart: networkReader(fixture, requested, { abortPart: 'summary/000001.json' }) }),
  { name: 'AbortError' });
  assert.ok(requested.includes('catalog.json') && requested.includes('topics.json'));
  assert.ok(requested.includes('summary/000001.json'));
});

test('peer failure isolation: abort after the final successful shard still forbids a committed success', async () => {
  const fixture = viewFixture(), requested = [], controller = new AbortController();
  const verified = networkReader(fixture, requested);
  const readPart = async path => {
    const value = await verified(path);
    if (path === 'summary/000001.json') controller.abort(new DOMException('synthetic late cancellation', 'AbortError'));
    return value;
  };
  await assert.rejects(loadReplicaView({ manifest: fixture.manifest, readPart, signal: controller.signal }),
    { name: 'AbortError' });
});
