// Candidate-only deterministic source/hash/date contracts. No network or DB writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { derivePublicHistoryDateIndex, verifyPublicHistoryDateIndex,
  iteratePublicHistoryDateRange, iterateLegacyPublicHistoryRange,
  auditPublicHistoryDatePublication } from '../lib/public-history-range.mjs';

const AS_OF = '2026-10-01T00:00:00.000Z';
const AT = '2026-09-30T02:00:00.000Z';
const hash = text => createHash('sha256').update(text).digest('hex');
const metaOf = ({ content, ...meta }) => meta;
const clone = x => structuredClone(x);
const date = d => new Date(Date.parse(AT) - d * 86_400_000).toISOString().slice(0, 10);

function sourceFixture(accounts = 2, days = 12, { gap = false } = {}) {
  const sources = new Map(), files = []; let count = 0;
  for (let targetId = 1; targetId <= accounts; targetId++) {
    const items = [];
    for (let d = days - 1; d >= 0; d--) {
      if (gap && targetId === 1 && d === 2) continue;
      const capturedAt = new Date(Date.parse(AT) - d * 86_400_000).toISOString();
      items.push({ id: targetId * days + d + 1, targetId, date: capturedAt.slice(0, 10), capturedAt,
        followers: d === 1 ? null : days - d, followersAt: d === 1 ? null : capturedAt,
        likes: d * 2, likesAt: capturedAt, posts: 0, postsAt: capturedAt });
    }
    const content = JSON.stringify({ version: 1, asOf: AS_OF, timeZone: 'Asia/Shanghai', items }) + '\n';
    const path = `daily/${targetId}.json`;
    sources.set(path, content); count += items.length;
    files.push({ path, kind: 'daily', targetId, count: items.length,
      bytes: Buffer.byteLength(content), sha256: hash(content) });
  }
  const manifest = { version: 1, asOf: AS_OF, timeZone: 'Asia/Shanghai', counts: { daily: count }, files };
  return { manifest, sources, readPart: async path => { assert.ok(sources.has(path)); return sources.get(path); } };
}

async function candidate(source) {
  return derivePublicHistoryDateIndex({ sourceManifest: source.manifest, readPart: source.readPart });
}
function readOptions(source, publication, requested = []) {
  const byPath = new Map(publication.files.map(f => [f.path, f.content]));
  return { sourceManifest: source.manifest, indexContent: publication.indexFile.content,
    indexMeta: metaOf(publication.indexFile), readPart: async path => {
      requested.push(path); assert.ok(byPath.has(path)); return byPath.get(path);
    } };
}
async function collect(iterator) { const items = [], batches = []; for await (const batch of iterator) { items.push(...batch.items); batches.push(batch); } return { items, batches }; }
function alterIndex(publication, edit) {
  const value = clone(publication), index = JSON.parse(value.indexFile.content); edit(index);
  const content = JSON.stringify(index) + '\n';
  value.index = index; Object.assign(value.indexFile, { content, bytes: Buffer.byteLength(content), sha256: hash(content), count: index.count });
  return value;
}

test('range candidate: deterministic sealed sidecar preserves every original source byte and exact point count', async () => {
  const source = sourceFixture(), originalManifest = JSON.stringify(source.manifest), originalSources = [...source.sources];
  const first = await candidate(source), second = await candidate(source);
  assert.deepEqual(first, second);
  assert.equal(first.candidateOnly, true);
  assert.equal(first.index.count, 24);
  assert.equal(first.index.sourceManifestSha256, hash(originalManifest));
  assert.deepEqual(first.index.sourceDaily.map(f => f.sha256), source.manifest.files.map(f => f.sha256));
  assert.equal(JSON.stringify(source.manifest), originalManifest);
  assert.deepEqual([...source.sources], originalSources);
  assert.deepEqual(verifyPublicHistoryDateIndex(readOptions(source, first)), first.index);
  const audit = await auditPublicHistoryDatePublication({ ...readOptions(source, first), readSourcePart: source.readPart });
  assert.equal(audit.fullySourceBound, true); assert.equal(audit.count, 24);
});

test('range candidate: 701 accounts times 365 days seal 255865 rows and read only seven requested dates', async () => {
  const source = sourceFixture(701, 365), publication = await candidate(source), requested = [];
  assert.equal(publication.index.count, 255_865); assert.equal(publication.files.length, 128);
  const { items, batches } = await collect(iteratePublicHistoryDateRange({ ...readOptions(source, publication, requested),
    ranges: [{ start: date(6), end: date(0) }] }));
  assert.equal(items.length, 701 * 7);
  assert.ok(items.every(p => p.date >= date(6) && p.date <= date(0)));
  assert.ok(batches.every(b => b.items.length <= 2000 && b.totalSavedCount === 255_865 && b.asOf === AS_OF));
  assert.ok(requested.length <= 4 && requested.length < publication.files.length);
  assert.equal(new Set(items.map(p => `${p.targetId}/${p.date}`)).size, items.length);
});

test('range candidate: multi-year saved history is retained; a date union fetches each required part once', async () => {
  const source = sourceFixture(24, 1461), publication = await candidate(source), requested = [];
  const first = date(1460), last = date(0);
  assert.equal(publication.index.firstDate, first); assert.equal(publication.index.lastDate, last);
  assert.equal(publication.index.count, 24 * 1461);
  const result = await collect(iteratePublicHistoryDateRange({ ...readOptions(source, publication, requested),
    dates: [first, last, first], ranges: [{ start: date(5), end: last }, { start: date(3), end: last }] }));
  assert.equal(new Set(requested).size, requested.length);
  assert.equal(result.items.length, 24 * 7);
  assert.equal(result.items.filter(p => p.date === first).length, 24);
  assert.equal(result.items.filter(p => p.date === last).length, 24);
});

test('range candidate: 701-account three-year scale remains fully indexed while two endpoint dates load bounded batches', async () => {
  const source = sourceFixture(701, 1095), publication = await candidate(source), requested = [];
  assert.equal(publication.index.count, 767_595);
  assert.equal(publication.index.firstDate, date(1094));
  assert.equal(publication.index.lastDate, date(0));
  const result = await collect(iteratePublicHistoryDateRange({ ...readOptions(source, publication, requested),
    dates: [date(1094), date(0)] }));
  assert.equal(result.items.length, 1402);
  assert.ok(requested.length <= 3);
  assert.ok(result.batches.every(batch => batch.items.length <= 2000 && batch.totalSavedCount === 767_595));
});

test('range candidate: absent days/null/zero survive and no missing observation is fabricated', async () => {
  const source = sourceFixture(2, 6, { gap: true }), publication = await candidate(source);
  const result = await collect(iteratePublicHistoryDateRange({ ...readOptions(source, publication),
    ranges: [{ start: date(5), end: date(0) }] }));
  assert.equal(result.items.length, 11);
  assert.equal(result.items.some(p => p.targetId === 1 && p.date === date(2)), false);
  assert.equal(result.items.find(p => p.targetId === 1 && p.date === date(1)).followers, null);
  assert.ok(result.items.every(p => p.posts === 0));
});

test('range candidate: bad source bytes, count, identity, duplicate day and cross-generation are rejected', async () => {
  const attacks = [
    source => source.sources.set('daily/1.json', source.sources.get('daily/1.json') + ' '),
    source => source.manifest.counts.daily++,
    source => editSource(source, value => { value.items[0].targetId = 2; }),
    source => editSource(source, value => { value.items[1].date = value.items[0].date; }),
    source => editSource(source, value => { value.asOf = '2026-09-29T00:00:00.000Z'; }),
  ];
  for (const attack of attacks) { const source = sourceFixture(); attack(source); await assert.rejects(candidate(source), /invalid-history-range-contract/); }
});
function editSource(source, edit) {
  const path = 'daily/1.json', value = JSON.parse(source.sources.get(path)); edit(value);
  const content = JSON.stringify(value) + '\n'; source.sources.set(path, content);
  Object.assign(source.manifest.files.find(f => f.path === path), { bytes: Buffer.byteLength(content), sha256: hash(content) });
}

test('range candidate: manifest/index SHA, source set, count, path and date-bound pollution are rejected', async () => {
  const source = sourceFixture(), publication = await candidate(source);
  assert.throws(() => verifyPublicHistoryDateIndex({ ...readOptions(source, publication), indexContent: publication.indexFile.content + ' ' }), /invalid-history-range-contract/);
  const attacks = [
    index => { index.sourceManifestSha256 = '0'.repeat(64); },
    index => { index.sourceDaily.pop(); },
    index => { index.count++; },
    index => { index.shards[0].path = 'date-summary/../daily/1.json'; },
    index => { index.shards[0].firstDate = '2026-02-29'; },
    index => { index.shards[0].count++; },
    index => { index.shards[0].bytes++; },
  ];
  for (const attack of attacks) {
    const modified = alterIndex(publication, attack);
    if (modified.index.shards[0].bytes !== publication.index.shards[0].bytes) {
      // A descriptor byte count can be structurally valid, but real range bytes must still reject it.
      await assert.rejects(collect(iteratePublicHistoryDateRange({ ...readOptions(source, modified), dates: [date(0)] })), /invalid-history-range-contract/);
    } else assert.throws(() => verifyPublicHistoryDateIndex(readOptions(source, modified)), /invalid-history-range-contract/);
  }
});

test('range candidate: plausible false first/last dates cannot pass the full original-source activation audit', async () => {
  const source = sourceFixture(), publication = await candidate(source);
  const falseBoundary = alterIndex(publication, index => { index.shards[0].firstDate = date(10); index.firstDate = date(10); });
  // Structure alone cannot prove source completeness. Activation must independently rebuild/audit.
  assert.ok(verifyPublicHistoryDateIndex(readOptions(source, falseBoundary)));
  await assert.rejects(auditPublicHistoryDatePublication({ ...readOptions(source, falseBoundary), readSourcePart: source.readPart }), /invalid-history-range-contract/);
});

test('range candidate: malformed request cannot fetch data; cross-generation or corrupted shard cannot yield data', async () => {
  const source = sourceFixture(), publication = await candidate(source), requested = [];
  for (const ranges of [[{ start: '2026-02-29', end: date(0) }], [{ start: date(0), end: date(1) }]]) {
    await assert.rejects(collect(iteratePublicHistoryDateRange({ ...readOptions(source, publication, requested), ranges })), /invalid-history-range-contract/);
  }
  assert.deepEqual(requested, []);
  const options = readOptions(source, publication);
  await assert.rejects(collect(iteratePublicHistoryDateRange({ ...options, dates: [date(0)],
    readPart: async path => (await options.readPart(path)) + ' ' })), /invalid-history-range-contract/);
});

test('range candidate: cancelled final fetch is not yielded; next batch after cancellation is rejected', async () => {
  const source = sourceFixture(24, 1461), publication = await candidate(source);
  const controller = new AbortController(), options = readOptions(source, publication);
  await assert.rejects(collect(iteratePublicHistoryDateRange({ ...options, dates: [date(0)], signal: controller.signal,
    readPart: async path => { const body = await options.readPart(path); controller.abort(); return body; } })), { name: 'AbortError' });
  const again = new AbortController();
  const iterator = iteratePublicHistoryDateRange({ ...readOptions(source, publication), signal: again.signal,
    ranges: [{ start: date(1460), end: date(0) }] });
  assert.equal((await iterator.next()).done, false); again.abort();
  await assert.rejects(iterator.next(), { name: 'AbortError' });
});

test('range candidate: legacy v1 reads original immutable daily sources without rewriting or unsafe date guesses', async () => {
  const source = sourceFixture(3, 12), before = JSON.stringify(source.manifest), original = [...source.sources], requested = [];
  const result = await collect(iterateLegacyPublicHistoryRange({ sourceManifest: source.manifest,
    readPart: async path => { requested.push(path); return source.readPart(path); }, dates: [date(11), date(0)] }));
  assert.equal(result.items.length, 6);
  assert.deepEqual(requested, ['daily/1.json', 'daily/2.json', 'daily/3.json']);
  assert.equal(JSON.stringify(source.manifest), before); assert.deepEqual([...source.sources], original);
  assert.ok(result.batches.every(b => b.items.length <= 2000 && b.loadedPartSha256));
});

test('range candidate: Beijing midnight and different metric observation times are validated without host-timezone drift', async () => {
  const source = sourceFixture(1, 2);
  editSource(source, value => {
    const point = value.items.at(-1);
    point.capturedAt = '2026-09-29T16:00:00.000Z';
    point.followersAt = '2026-09-29T16:00:00.000Z';
    point.likesAt = '2026-09-29T16:00:00.000Z';
    point.postsAt = '2026-09-29T16:00:00.000Z';
  });
  const publication = await candidate(source);
  const result = await collect(iteratePublicHistoryDateRange({ ...readOptions(source, publication), dates: ['2026-09-30'] }));
  assert.equal(result.items.length, 1);
  const mismatch = sourceFixture(1, 2);
  editSource(mismatch, value => { value.items.at(-1).likesAt = '2026-09-29T15:59:59.999Z'; });
  await assert.rejects(candidate(mismatch), /invalid-history-range-contract/);
});
