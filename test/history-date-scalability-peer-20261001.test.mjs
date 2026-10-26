// Independent exact-byte streaming audit proofs. No real HTTP/DB/platform requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { derivePublicHistoryDateIndex, auditPublicHistoryDatePublication,
  iteratePublicHistoryDateRange } from '../lib/public-history-range.mjs';

const asOf = '2026-10-01T04:00:00.000Z', common = { version: 1, asOf, timeZone: 'Asia/Shanghai' };
const sha = s => createHash('sha256').update(s).digest('hex');
const metaOf = ({ content, ...meta }) => meta;
const day = n => new Date(Date.parse('2026-09-30T02:00:00.000Z') - n * 86400000).toISOString().slice(0, 10);

function source(accounts = 3, days = 5) {
  const files = [];
  for (let targetId = 1; targetId <= accounts; targetId++) {
    const items = [];
    for (let d = days - 1; d >= 0; d--) {
      const capturedAt = new Date(Date.parse('2026-09-30T02:00:00.000Z') - d * 86400000).toISOString();
      const row = { targetId, id: targetId * days + d + 1, date: day(d), capturedAt,
        sourceChecksum: 'a'.repeat(64), sampleCount: 1, followers: d === 1 ? null : d,
        likes: days - d, posts: 0, estimatedPlays: (days - d) * 100,
        estimatedPlaysDelta: null, estimatedPlaysProxy: 'likes-times-100' };
      for (const k of ['followers', 'likes', 'posts']) Object.assign(row, { [k + 'At']: row[k] === null ? null : capturedAt,
        [k + 'Delta']: null, [k + 'Checksum']: row[k] === null ? null : 'a'.repeat(64),
        [k + 'BaselineAt']: null, [k + 'BaselineChecksum']: null });
      items.push(row);
    }
    // Original row order is not a trusted precondition. Deliberately reverse half.
    if (targetId % 2 === 0) items.reverse();
    const content = JSON.stringify({ ...common, items }) + '\n';
    files.push({ path: `daily/${targetId}.json`, kind: 'daily', targetId, count: items.length,
      bytes: Buffer.byteLength(content), sha256: sha(content), content });
  }
  return { manifest: { ...common, counts: { daily: accounts * days }, files: files.map(metaOf) }, files };
}
async function fixture(accounts, days) {
  const original = source(accounts, days), texts = new Map(original.files.map(f => [f.path, f.content]));
  const publication = await derivePublicHistoryDateIndex({ sourceManifest: original.manifest, readPart: async p => texts.get(p) });
  return { original, texts, publication };
}
const audit = ({ original, texts, publication }, extra = {}) => auditPublicHistoryDatePublication({
  sourceManifest: original.manifest, indexContent: publication.indexFile.content, indexMeta: metaOf(publication.indexFile),
  readSourcePart: async p => texts.get(p), readPart: async p => publication.files.find(f => f.path === p)?.content, ...extra });
function resignIndex(publication, edit) {
  const body = JSON.parse(publication.indexFile.content); edit(body);
  const content = JSON.stringify(body) + '\n';
  Object.assign(publication.indexFile, { content, bytes: Buffer.byteLength(content), sha256: sha(content) });
}
function resignPart(publication, path, edit) {
  const file = publication.files.find(f => f.path === path), part = JSON.parse(file.content); edit(part);
  const content = JSON.stringify(part) + '\n';
  Object.assign(file, { content, count: part.items.length, bytes: Buffer.byteLength(content), sha256: sha(content) });
  resignIndex(publication, body => Object.assign(body.shards.find(s => s.path === path), {
    count: file.count, bytes: file.bytes, sha256: file.sha256,
    firstDate: part.items[0]?.date, lastDate: part.items.at(-1)?.date }));
}

test('stream audit: exact original projection for unsorted sources, null/zero and unchanged bytes', async () => {
  const f = await fixture(3, 5), before = JSON.stringify(f);
  const result = await audit(f);
  assert.deepEqual(result, { asOf, sourceManifestSha256: sha(JSON.stringify(f.original.manifest)), count: 15,
    shards: 1, fullySourceBound: true, candidateOnly: true });
  assert.equal(JSON.stringify(f), before);
});

test('stream audit: full-schema 701 x 365 retains every original point and only reads every source/shard once', async () => {
  const f = await fixture(701, 365), reads = [], sourceReads = [];
  const result = await audit(f, { readPart: async p => { reads.push(p); return f.publication.files.find(s => s.path === p)?.content; },
    readSourcePart: async p => { sourceReads.push(p); return f.texts.get(p); } });
  assert.equal(result.count, 255865); assert.equal(result.shards, 128);
  assert.equal(reads.length, 128); assert.equal(new Set(reads).size, 128);
  assert.equal(sourceReads.length, 701); assert.equal(new Set(sourceReads).size, 701);
  const selected = []; let count = 0;
  for await (const b of iteratePublicHistoryDateRange({ sourceManifest: f.original.manifest,
    indexContent: f.publication.indexFile.content, indexMeta: metaOf(f.publication.indexFile), dates: [day(364), day(0)],
    readPart: async p => { selected.push(p); return f.publication.files.find(s => s.path === p).content; } })) count += b.items.length;
  assert.equal(count, 1402); assert.ok(selected.length <= 3);
});

test('stream audit: four-year whole history keeps earliest day, not just a 90-day suffix', async () => {
  const f = await fixture(24, 1461), result = await audit(f);
  assert.equal(result.count, 35064); assert.equal(f.publication.index.firstDate, day(1460));
  assert.equal(f.publication.index.lastDate, day(0));
});

test('stream audit: re-signed own-consistent source/vector/identity/time/bounds/byte pollution cannot pass', async () => {
  const good = await fixture(3, 5);
  const attacks = [
    f => resignPart(f.publication, 'date-summary/000001.json', body => body.items[0].likes++),
    f => resignPart(f.publication, 'date-summary/000001.json', body => body.items[0].targetId = 2),
    f => resignPart(f.publication, 'date-summary/000001.json', body => body.items[0].capturedAt = new Date(Date.parse(body.items[0].capturedAt) + 3600000).toISOString()),
    f => resignPart(f.publication, 'date-summary/000001.json', body => body.items[0].sourceUrl = 'private-synthetic'),
    f => resignPart(f.publication, 'date-summary/000001.json', body => body.items.reverse()),
    f => resignPart(f.publication, 'date-summary/000001.json', body => body.items[0] = Object.fromEntries(Object.entries(body.items[0]).reverse())),
    f => resignIndex(f.publication, body => body.firstDate = body.shards[0].firstDate = day(3)),
    f => resignIndex(f.publication, body => body.shards[0] = Object.fromEntries(Object.entries(body.shards[0]).reverse())),
    f => { const file = f.publication.files[0]; file.content = file.content.trim() + ' \n'; file.bytes = Buffer.byteLength(file.content); file.sha256 = sha(file.content);
      resignIndex(f.publication, body => Object.assign(body.shards[0], { bytes: file.bytes, sha256: file.sha256 })); },
    f => { f.publication.indexFile.content += ' '; f.publication.indexFile.bytes++; f.publication.indexFile.sha256 = sha(f.publication.indexFile.content); },
    f => { const m = f.original.manifest.files[0], body = JSON.parse(f.texts.get(m.path)); body.items[0].likes++;
      const content = JSON.stringify(body) + '\n'; m.bytes = Buffer.byteLength(content); m.sha256 = sha(content); f.texts.set(m.path, content);
      resignIndex(f.publication, index => { index.sourceManifestSha256 = sha(JSON.stringify(f.original.manifest)); index.sourceDaily[0].bytes = m.bytes; index.sourceDaily[0].sha256 = m.sha256; }); },
  ];
  for (const attack of attacks) { const f = structuredClone(good); attack(f); await assert.rejects(audit(f)); }
});

test('stream audit: same complete source rows cannot be re-chunked into a different signed publication', async () => {
  const f = await fixture(2, 1001), first = JSON.parse(f.publication.files[0].content).items;
  const moved = first.pop();
  resignPart(f.publication, f.publication.files[0].path, body => { body.items = first; });
  resignPart(f.publication, f.publication.files[1].path, body => { body.items.unshift(moved); });
  await assert.rejects(audit(f));
});

test('stream audit: abort after final original source read never returns successful source proof', async () => {
  const f = await fixture(3, 5), controller = new AbortController(); let sources = 0;
  await assert.rejects(audit(f, { signal: controller.signal, readSourcePart: async p => {
    if (++sources === 3) controller.abort(); return f.texts.get(p);
  } }), { name: 'AbortError' });
  assert.equal(sources, 3);
});

test('stream audit: zero history canonical bounds and all zero-row source files are still verified', async () => {
  const f = await fixture(3, 0), reads = [];
  const result = await audit(f, { readSourcePart: async p => { reads.push(p); return f.texts.get(p); } });
  assert.equal(result.count, 0); assert.equal(result.shards, 0); assert.equal(reads.length, 3);
  assert.equal(f.publication.index.firstDate, null); assert.equal(f.publication.index.lastDate, null);
});

test('capacity review: whole-source activation request demand grows with all history, not a 90-day view', () => {
  // Actual published source count is 759 (701 enabled plus retained saved/paused
  // histories); these are operation counts, not a claimed deployed plan limit.
  const requests = points => 759 + 2 + 2 * Math.ceil(points / 2000) + 4;
  assert.equal(requests(16327), 783);
  assert.equal(requests(701 * 365), 1021);
  assert.equal(requests(701 * 1095), 1533);
  assert.ok(requests(701 * 365) > 1000);
  assert.ok(requests(701 * 1095) < 10000);
});
