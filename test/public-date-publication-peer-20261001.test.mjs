// Opt-in producer integration. Synthetic HTTP/storage only; no network/DB/credential reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { preparePublicReplicaPublication, createPublicReplicaSync } from '../lib/public-replica-sync.mjs';
import { iteratePublicHistoryDateRange } from '../lib/public-history-range.mjs';
import { businessDateKey } from '../lib/utils.mjs';

const AS_OF = '2026-10-01T00:00:00.000Z', AT = '2026-09-30T02:00:00.000Z';
const common = { version: 1, asOf: AS_OF, timeZone: 'Asia/Shanghai' };
const hash = text => createHash('sha256').update(text).digest('hex');
const clone = x => structuredClone(x);
const isDate = f => ['summaryDateIndex', 'summaryDateShard'].includes(f.kind);
const metaOf = ({ content, ...meta }) => meta;
const day = n => new Date(Date.parse(AT) - n * 86_400_000).toISOString().slice(0, 10);

function fixture(accounts = 3, days = 8) {
  const files = []; const add = (path, kind, count, payload, targetId) => {
    const content = JSON.stringify({ ...common, ...payload }) + '\n';
    files.push({ path, kind, ...(targetId ? { targetId } : {}), count,
      bytes: Buffer.byteLength(content), sha256: hash(content), content });
  };
  const latest = { value: 10, observedAt: AT, sourceChecksum: 'a'.repeat(64), date: day(0) };
  add('catalog.json', 'catalog', accounts, { classificationRuleVersion: 'synthetic-date-integration', boards: [],
    accounts: Array.from({ length: accounts }, (_, i) => ({ id: i + 1, label: `Synthetic ${i + 1}`,
      platform: 'douyin', enabled: true, boardKeys: [], historyRevision: { snapshotMaxId: accounts * days, postMaxId: 0, postMetricMaxId: 0 },
      latest: { followers: latest, likes: latest, posts: latest },
      classification: { theme: { key: 'unknown', label: 'Unknown', confirmed: false, mode: 'test' },
        primaryKey: 'unknown', primaryLabel: 'Unknown', labels: [], needsReview: true, mode: 'test' } })) });
  add('topics.json', 'topics', 0, { topics: [], items: [] });
  for (let targetId = 1; targetId <= accounts; targetId++) {
    const items = [];
    for (let d = days - 1; d >= 0; d--) {
      const capturedAt = new Date(Date.parse(AT) - d * 86_400_000).toISOString();
      const row = { targetId, id: targetId * days + d + 1, date: capturedAt.slice(0, 10), capturedAt,
        sourceChecksum: 'a'.repeat(64), sampleCount: 1, followers: days - d, likes: d * 7, posts: 0,
        estimatedPlays: d * 700, estimatedPlaysDelta: null, estimatedPlaysProxy: 'likes-times-100' };
      for (const k of ['followers', 'likes', 'posts']) Object.assign(row, { [k + 'Delta']: null, [k + 'At']: capturedAt,
        [k + 'Checksum']: 'a'.repeat(64), [k + 'BaselineAt']: null, [k + 'BaselineChecksum']: null });
      items.push(row);
    }
    add(`daily/${targetId}.json`, 'daily', items.length, { items }, targetId);
  }
  const manifest = { ...common, counts: { accounts, enabledAccounts: accounts, boards: 0,
    daily: accounts * days, works: 0, workMetrics: 0, topics: 0, topicDaily: 0, excludedAccountSnapshots: 0 },
    policy: { readOnly: true, platformComplete: false, independentlyVerified: false, missingDatesFilled: false,
      accountDailyEvidence: 'checksum-and-normalized-vector-bound', worksMetricEvidence: 'saved-record-not-independently-verified',
      topicEvidence: 'per-snapshot-topic-identity-source-run-time-vector-bound', estimate: 'synthetic',
      note: 'synthetic', textRendering: 'textContent' }, files: files.map(metaOf) };
  return { manifest, files };
}

function editPart(publication, path, edit) {
  const file = publication.files.find(f => f.path === path), body = JSON.parse(file.content); edit(body);
  file.content = JSON.stringify(body) + '\n'; file.bytes = Buffer.byteLength(file.content); file.sha256 = hash(file.content);
  Object.assign(publication.manifest.files.find(f => f.path === path), { bytes: file.bytes, sha256: file.sha256 });
}
function editDatePart(publication, path, edit) {
  editPart(publication, path, edit);
  const file = publication.files.find(f => f.path === path);
  editPart(publication, 'date-summary-index.json', index => Object.assign(index.shards.find(f => f.path === path),
    { bytes: file.bytes, sha256: file.sha256 }));
}

test('date producer: default/explicit false remain exact stable v1 bytes; opt-in adds sidecars after original preparation', async () => {
  const source = fixture(), before = clone(source);
  const normal = await preparePublicReplicaPublication(source), disabled = await preparePublicReplicaPublication(source, { dateIndex: false });
  assert.deepEqual(source, before); assert.deepEqual(normal, disabled);
  assert.ok(!normal.files.some(isDate));
  const enabled = await preparePublicReplicaPublication(source, { dateIndex: true });
  assert.deepEqual(enabled.files.filter(f => !isDate(f)), normal.files);
  assert.deepEqual(enabled.manifest.files.filter(f => !isDate(f)), normal.manifest.files);
  const index = JSON.parse(enabled.files.find(f => f.kind === 'summaryDateIndex').content);
  assert.equal(index.sourceManifestSha256, hash(JSON.stringify(normal.manifest)));
  assert.equal(index.count, source.manifest.counts.daily);
  assert.deepEqual(await preparePublicReplicaPublication(enabled), enabled);
  assert.deepEqual(await preparePublicReplicaPublication(enabled, { dateIndex: true }), enabled);
});

test('date producer: already sealed legacy summary/checkpoint source bytes are not changed by default validation', async () => {
  const normal = await preparePublicReplicaPublication(fixture());
  const items = normal.files.filter(f => f.kind === 'summaryShard').flatMap(f => JSON.parse(f.content).items);
  const legacy = clone(normal);
  legacy.files = legacy.files.filter(f => f.kind !== 'summaryShard');
  legacy.manifest.files = legacy.manifest.files.filter(f => f.kind !== 'summaryShard');
  editPart(legacy, 'summary.json', body => { for (const k of Object.keys(body)) delete body[k]; Object.assign(body, common, { items }); });
  const before = JSON.stringify(legacy), manifestHash = hash(JSON.stringify(legacy.manifest));
  assert.deepEqual(await preparePublicReplicaPublication(legacy), legacy);
  assert.equal(JSON.stringify(legacy), before);
  assert.equal(hash(JSON.stringify((await preparePublicReplicaPublication(legacy)).manifest)), manifestHash);
});

test('date producer: actual full-schema 701-account yearly fixture passes prepare and selective range retains all 255865 points', async () => {
  const source = fixture(701, 365), publication = await preparePublicReplicaPublication(source, { dateIndex: true });
  const indexFile = publication.files.find(f => f.kind === 'summaryDateIndex'), index = JSON.parse(indexFile.content);
  assert.equal(index.count, 255_865); assert.equal(index.shards.length, 128);
  const sourceManifest = { ...publication.manifest, files: publication.manifest.files.filter(f => !isDate(f)) };
  const byPath = new Map(publication.files.map(f => [f.path, f.content])), requested = []; let count = 0;
  for await (const batch of iteratePublicHistoryDateRange({ sourceManifest, indexContent: indexFile.content,
    indexMeta: metaOf(indexFile), ranges: [{ start: day(6), end: day(0) }],
    readPart: async path => { requested.push(path); return byPath.get(path); } })) {
    assert.ok(batch.items.length <= 2000); count += batch.items.length;
  }
  assert.equal(count, 4907); assert.ok(requested.length <= 4);
});

test('date producer: full-schema four-year fixture preserves earliest/latest observations', async () => {
  const source = fixture(24, 1461), publication = await preparePublicReplicaPublication(source, { dateIndex: true });
  const index = JSON.parse(publication.files.find(f => f.kind === 'summaryDateIndex').content);
  assert.equal(index.count, 35_064); assert.equal(index.firstDate, day(1460)); assert.equal(index.lastDate, day(0));
});

test('date producer: existing sidecars reject every missing/extra/source/identity/date/privacy/size mutation', async () => {
  const valid = await preparePublicReplicaPublication(fixture(), { dateIndex: true });
  const attacks = [
    p => { p.files = p.files.filter(f => f.kind !== 'summaryDateShard'); p.manifest.files = p.manifest.files.filter(f => f.kind !== 'summaryDateShard'); },
    p => { const meta = clone(p.manifest.files.find(f => f.kind === 'summaryDateShard')); meta.path = 'date-summary/000002.json'; p.manifest.files.push(meta); p.files.push({ ...meta, content: p.files.find(f => f.kind === 'summaryDateShard').content }); },
    p => editPart(p, 'date-summary-index.json', index => { index.sourceManifestSha256 = '0'.repeat(64); }),
    p => editPart(p, 'date-summary-index.json', index => { index.sourceDaily.pop(); }),
    p => editPart(p, 'date-summary-index.json', index => { index.sourceUrl = 'synthetic-private-source'; }),
    p => editPart(p, 'date-summary-index.json', index => { index.firstDate = day(6); index.shards[0].firstDate = day(6); }),
    p => editDatePart(p, 'date-summary/000001.json', body => { body.items[0].targetId = 2; }),
    p => editDatePart(p, 'date-summary/000001.json', body => { body.items[0].likes++; }),
    p => editDatePart(p, 'date-summary/000001.json', body => { body.items[0].capturedAt = AT; }),
    p => editDatePart(p, 'date-summary/000001.json', body => { body.items[0].authorization = 'synthetic-private'; }),
    p => editDatePart(p, 'date-summary/000001.json', body => { body.asOf = '2026-09-29T00:00:00.000Z'; }),
    p => { const f = p.files.find(f => f.kind === 'summaryDateIndex'); f.content += ' '.repeat(1_000_001); f.bytes = Buffer.byteLength(f.content); f.sha256 = hash(f.content); Object.assign(p.manifest.files.find(m => m.path === f.path), metaOf(f)); },
    p => { const f = p.manifest.files.find(f => f.kind === 'summaryDateShard'); f.count = 2001; p.files.find(s => s.path === f.path).count = 2001; },
  ];
  for (const attack of attacks) {
    const publication = clone(valid); attack(publication);
    await assert.rejects(preparePublicReplicaPublication(publication), error => ['invalid-source', 'invalid-summary'].includes(error.code)
      && !error.message.includes('synthetic-private'));
  }
});

function mockCloud() {
  const objects = new Map(); let manifest = null, posts = 0, credentials = 0, checkpoint = null;
  return { objects, get posts() { return posts; }, get credentials() { return credentials; }, get checkpoint() { return checkpoint; },
    sync: createPublicReplicaSync({ getCredential: async () => { credentials++; return '0'.repeat(64); },
      loadCheckpoint: async () => checkpoint, saveCheckpoint: async value => { checkpoint = clone(value); },
      fetchImpl: async (url, init = {}) => {
        const u = new URL(url);
        if (init.method === 'POST') {
          posts++; const body = JSON.parse(init.body);
          if (body.action === 'upload') { for (const f of body.files) objects.set(f.path, f.data); return Response.json({ accepted: body.files.length, asOf: body.asOf }); }
          manifest = body.manifest; assert.equal(objects.size, manifest.files.length);
          return Response.json({ published: true, asOf: body.asOf, parts: manifest.files.length });
        }
        if (!manifest) return Response.json({ error: 'synthetic missing' }, { status: 503 });
        const part = u.searchParams.get('part');
        return part ? new Response(objects.get(part)) : Response.json({ manifest, publishedAt: AS_OF,
          readOnly: true, collectionRequiresLocalComputer: true });
      } }) };
}

test('date producer: trusted opt-in publication reaches existing sync and checkpoint, then replays sealed bytes without writing', async () => {
  const source = fixture(3, 1000), cloud = mockCloud();
  const expected = await preparePublicReplicaPublication(source, { dateIndex: true });
  const result = await cloud.sync.sync(source, { dateIndex: true });
  assert.equal(result.status, 'success'); assert.equal(result.dateIndexFormat, 'date-shards-v1');
  assert.ok(result.readbackFiles.includes('date-summary-index.json'));
  assert.ok(result.readbackFiles.includes('date-summary/000001.json'));
  assert.ok(result.readbackFiles.includes('date-summary/000002.json'));
  assert.equal(cloud.checkpoint.manifestSha256, hash(JSON.stringify(expected.manifest)));
  const posts = cloud.posts, credentials = cloud.credentials, checkpointHash = cloud.checkpoint.manifestSha256;
  const replay = await cloud.sync.sync(expected);
  assert.equal(replay.status, 'success'); assert.equal(replay.alreadyPublished, true);
  assert.equal(cloud.posts, posts); assert.equal(cloud.credentials, credentials);
  assert.equal(cloud.checkpoint.manifestSha256, checkpointHash);
});

test('date producer: invalid sidecar and non-boolean opt-in reject before credentials, HTTP or trust', async () => {
  const source = fixture(), valid = await preparePublicReplicaPublication(source, { dateIndex: true }), cloud = mockCloud();
  editPart(valid, 'date-summary-index.json', index => { index.sourceManifestSha256 = '0'.repeat(64); });
  const result = await cloud.sync.sync(valid);
  assert.equal(result.status, 'failed'); assert.equal(cloud.posts, 0); assert.equal(cloud.credentials, 0);
  await assert.rejects(preparePublicReplicaPublication(source, { dateIndex: 'true' }), { code: 'invalid-source' });
});

test('date producer: cancellation never brands/returns a successful publication', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(preparePublicReplicaPublication(fixture(), { dateIndex: true, signal: controller.signal }), { code: 'aborted' });
  const late = new AbortController(); setImmediate(() => late.abort());
  await assert.rejects(preparePublicReplicaPublication(fixture(24, 30), { dateIndex: true, signal: late.signal }), { code: 'aborted' });
});

test('date producer: abort during date derivation/source audit or after its final verified read cannot brand trust', async () => {
  const valid = await preparePublicReplicaPublication(fixture(), { dateIndex: true });
  // A real native signal with an instrumented checkpoint aborts deterministically,
  // avoiding timing-dependent tests that only cancel the earlier legacy preparation.
  for (const [source, dateIndex, checkpoint] of [[fixture(), true, 1], [fixture(), true, 16],
    [fixture(), true, 32], [valid, false, 17]]) {
    const controller = new AbortController(); let checks = 0;
    Object.defineProperty(controller.signal, 'throwIfAborted', { value() {
      if (++checks === checkpoint) controller.abort();
      return AbortSignal.prototype.throwIfAborted.call(this);
    } });
    await assert.rejects(preparePublicReplicaPublication(source,
      { dateIndex, signal: controller.signal }), { code: 'aborted' });
    assert.equal(controller.signal.aborted, true);
    assert.equal(checks, checkpoint);
  }
});

test('date producer: genuinely empty saved history stays empty without invented bounds or observations', async () => {
  const source = fixture(3, 0), publication = await preparePublicReplicaPublication(source, { dateIndex: true });
  const index = JSON.parse(publication.files.find(f => f.kind === 'summaryDateIndex').content);
  assert.equal(index.count, 0); assert.equal(index.firstDate, null); assert.equal(index.lastDate, null);
  assert.deepEqual(index.shards, []); assert.equal(publication.files.filter(f => f.kind === 'summaryDateShard').length, 0);
  assert.deepEqual(await preparePublicReplicaPublication(publication), publication);
});

test('date producer: reused Beijing formatter retains original midnight/leap-day and historical timezone rules', async () => {
  for (const capturedAt of ['2026-09-29T15:59:59.999Z', '2026-09-29T16:00:00.000Z',
    '2024-02-28T16:00:00.000Z', '1991-07-01T14:59:59.999Z', '1991-07-01T15:00:00.000Z']) {
    const source = fixture(1, 1), date = businessDateKey(capturedAt);
    editPart(source, 'daily/1.json', body => {
      const row = body.items[0]; row.capturedAt = capturedAt; row.date = date;
      for (const field of ['followers', 'likes', 'posts']) row[field + 'At'] = capturedAt;
    });
    const publication = await preparePublicReplicaPublication(source, { dateIndex: true });
    const point = JSON.parse(publication.files.find(f => f.kind === 'summaryDateShard').content).items[0];
    assert.equal(point.date, date); assert.equal(point.capturedAt, capturedAt);
  }
});
