import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { completedSourceMarker, validatedReceipt } from '../scripts/public-replica-publisher.mjs';
import { readReplicaPart } from '../../mcn-public-site/lib/replica-reader.mjs';

// Offline, read-only evidence. This suite never instantiates a production DB,
// starts the publisher, fetches a platform, changes a clock or reads credentials.
const root = new URL('../', import.meta.url);
const frozen = new URL('data/public-replica-staging/publisher-2026-10-01T02-43-24-280Z/', root);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const asOf = '2026-10-01T02:43:24.280Z';

test('original run 2155 event is byte-preserved and the independent review does not replace it', async () => {
  const bytes = await readFile(new URL('data/ingestion-reviews/run-2155.json', root));
  assert.equal(hash(bytes), 'c0246aa8f3be11d0e1c6fbe8d98d9161a4bbe14599c452c3c786e416d9c8d0fb');
  const event = JSON.parse(bytes);
  assert.equal(event.runId, 2155);
  assert.equal(event.snapshotCount, 701);
  assert.equal(event.finishedAt, '2026-10-01T02:43:23.833Z');
  const review = await json(new URL('data/ingestion-reviews/reviewed-2155.json', root));
  assert.equal(review.runId, event.runId);
  assert.equal(review.status, 'completed');
  assert.ok(Array.isArray(review.evidence) && review.evidence.length > 0);
  for (const path of review.evidence) await readFile(new URL(path, root));
});

test('a correct finished receipt cannot be reused for another account run or shifted generation time', () => {
  const now = Date.parse('2026-10-01T03:03:00.000Z');
  const run = { id: 2155, trigger_type: 'scheduled', started_at: '2026-10-01T02:00:16.775Z',
    finished_at: '2026-10-01T02:43:23.833Z', status: 'success' };
  const receipt = { version: 1, runId: 2155, eventId: 'collection-run-2155', triggerType: 'scheduled',
    startedAt: run.started_at, finishedAt: run.finished_at, runStatus: 'success',
    reviewedAt: '2026-10-01T02:43:23.835Z' };
  assert.equal(validatedReceipt(run, receipt, now), true);
  for (const changed of [
    { ...receipt, runId: 2157 }, { ...receipt, eventId: 'collection-run-2157' },
    { ...receipt, triggerType: 'works-only' },
    { ...receipt, finishedAt: '2026-10-01T02:43:23.834Z' },
    { ...receipt, reviewedAt: '2026-10-01T03:04:00.000Z' },
  ]) assert.equal(validatedReceipt(run, changed, now), false);
  assert.equal(validatedReceipt({ ...run, status: 'running', finished_at: null }, receipt, now), false);
});

test('intermediate pending/source metadata changes do not create another completed source publication marker', () => {
  const now = Date.parse('2026-10-01T03:03:00.000Z');
  const source = { lastFinishedAt: '2026-09-30T17:10:04.623Z',
    lastPendingCheckedAt: '2026-09-30T17:15:11.440Z',
    sources: { one: { lastStatus: 'submitted', sourceJobSummary: { businessStatus: 'pending' } } } };
  const marker = completedSourceMarker(source, now);
  assert.match(marker, /^[a-f0-9]{64}$/);
  assert.equal(completedSourceMarker({ ...source, updatedAt: '2026-10-01T03:00:00.000Z',
    sources: { one: { lastStatus: 'submitted', sourceJobSummary: { businessStatus: 'pending', reviewRequiredItemCount: 9000 } } } }, now), marker);
  assert.equal(completedSourceMarker({ ...source, sources: { one: { lastStatus: 'running' } } }, now), null);
  assert.equal(completedSourceMarker({ ...source, lastPendingCheckedAt: '2026-10-01T03:04:00.000Z' }, now), null);
});

for (const [kind, path, expectedCount] of [
  ['daily', 'daily/2333.json', 16], ['works', 'works/2333.json', 5],
  ['workMetrics', 'work-metrics/2333.json', 20],
]) test(`real sealed ${kind} evidence binds body bytes, account identity and count`, async () => {
  const manifest = await json(new URL('manifest.json', frozen));
  assert.equal(manifest.asOf, asOf);
  const meta = manifest.files.filter(file => file.path === path);
  assert.equal(meta.length, 1);
  assert.equal(meta[0].kind, kind);
  assert.equal(meta[0].targetId, 2333);
  assert.equal(meta[0].count, expectedCount);
  const bytes = await readFile(new URL(path, frozen));
  assert.equal(bytes.length, meta[0].bytes);
  assert.equal(hash(bytes), meta[0].sha256);
  const body = JSON.parse(bytes);
  assert.deepEqual(Object.keys(body).sort(), ['version', 'asOf', 'timeZone', 'items'].sort());
  assert.equal(body.version, 1);
  assert.equal(body.asOf, asOf);
  assert.equal(body.timeZone, 'Asia/Shanghai');
  assert.equal(body.items.length, meta[0].count);
  assert.ok(body.items.every(item => item.targetId === 2333));
  assert.equal(new Set(body.items.map(item => item.id)).size, body.items.length);
});

const fixture = ({ items = [{ id: 8, targetId: 2333, date: '2026-10-01', capturedAt: '2026-10-01T02:00:00.000Z', followers: 0, likes: 0, posts: 0 }], part = 'daily/2333.json', kind = 'daily', version = 1, generation = asOf, timeZone = 'Asia/Shanghai' } = {}) => {
  const value = { version, asOf: generation, timeZone, items };
  const text = JSON.stringify(value) + '\n';
  const meta = { path: part, kind, targetId: 2333, count: items.length, bytes: Buffer.byteLength(text), sha256: hash(text) };
  return { value, text, meta, part, generation };
};
function request(f, { text = f.text, meta = f.meta, headers = {}, status = 200, signal, capture } = {}) {
  return readReplicaPart({ generation: f.generation, part: f.part, meta, signal,
    fetcher: async (url, options) => {
      capture?.(url, options);
      if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return new Response(text, { status, headers: { 'X-Data-SHA256': f.meta.sha256, 'X-Data-Cutoff': f.generation, ...headers } });
    } });
}

test('candidate reader accepts explicit zero without replacing it with missing', async () => {
  const f = fixture();
  const result = await request(f);
  assert.deepEqual(result, f.value);
  assert.equal(result.items[0].followers, 0);
});

test('candidate reader accepts a declared empty sealed history, not an undeclared partition', async () => {
  const f = fixture({ items: [], part: 'works/2333.json', kind: 'works' });
  assert.deepEqual((await request(f)).items, []);
  await assert.rejects(request(f, { meta: null }));
});

test('candidate reader binds all three real public history bodies to their sealed metadata', async () => {
  const manifest = await json(new URL('manifest.json', frozen));
  for (const part of ['daily/2333.json', 'works/2333.json', 'work-metrics/2333.json']) {
    const text = await readFile(new URL(part, frozen), 'utf8');
    const f = { text, part, generation: asOf, meta: manifest.files.find(file => file.path === part) };
    assert.deepEqual(await request(f), JSON.parse(text));
  }
});

test('candidate reader accepts every current local sealed history partition, not just one showcased account', async () => {
  const manifest = await json(new URL('manifest.json', frozen));
  const files = manifest.files.filter(file => /^(daily|works|work-metrics)\//.test(file.path));
  const failures = [];
  let cursor = 0, rows = 0, passed = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < files.length) {
      const meta = files[cursor++];
      try {
        const text = await readFile(new URL(meta.path, frozen), 'utf8');
        const f = { text, part: meta.path, generation: asOf, meta };
        const value = await request(f);
        rows += value.items.length;
        passed++;
      } catch (error) {
        failures.push({ path: meta.path, error: error.message });
      }
    }
  }));
  assert.deepEqual(failures, []);
  assert.equal(passed, files.length);
  assert.equal(files.length, 2259);
  assert.equal(rows, manifest.counts.daily + manifest.counts.works + manifest.counts.workMetrics);
  assert.equal(rows, 136234);
  // The injected Response replays stored approved bytes. It does not prove
  // that all remote bodies were downloaded or that platform works are complete.
});

test('candidate reader rejects replaced same-author same-version content even if forged server header agrees', async () => {
  const f = fixture();
  const text = f.text.replace('"followers":0', '"followers":9');
  assert.equal(text.length, f.text.length);
  await assert.rejects(request(f, { text, headers: { 'X-Data-SHA256': hash(text) } }));
});

test('candidate reader rejects omitted metadata and a same hash bound to another partition', async () => {
  const f = fixture();
  await assert.rejects(request(f, { meta: null }));
  await assert.rejects(request(f, { meta: { ...f.meta, path: 'daily/234.json' } }));
});

for (const [name, patch] of [
  ['wrong hash header', { headers: { 'X-Data-SHA256': 'f'.repeat(64) } }],
  ['wrong cutoff header', { headers: { 'X-Data-Cutoff': '2026-10-01T02:43:24.281Z' } }],
  ['truncated declared byte count', { metadata: { bytes: 1 } }],
  ['unsafe integer bytes', { metadata: { bytes: Number.MAX_SAFE_INTEGER + 1 } }],
  ['wrong declared count', { metadata: { count: 2 } }],
  ['wrong metadata account', { metadata: { targetId: 234 } }],
  ['wrong metadata kind', { metadata: { kind: 'works' } }],
  ['nonlowercase hex hash', { metadata: { sha256: 'F'.repeat(64) } }],
]) test(`candidate reader rejects ${name}`, async () => {
  const f = fixture();
  await assert.rejects(request(f, { ...patch, ...(patch.metadata ? { meta: { ...f.meta, ...patch.metadata } } : {}) }));
});

for (const [name, f] of [
  ['cross-account item', fixture({ items: [{ id: 8, targetId: 234 }] })],
  ['wrong payload version', fixture({ version: 2 })],
  ['wrong timezone', fixture({ timeZone: 'UTC' })],
  ['duplicate daily ids', fixture({ items: [{ ...fixture().value.items[0], date: '2026-09-30', capturedAt: '2026-09-30T02:00:00.000Z' }, fixture().value.items[0]] })],
  ['duplicate daily dates', fixture({ items: [fixture().value.items[0], { ...fixture().value.items[0], id: 9 }] })],
]) test(`candidate reader rejects sealed but inconsistent ${name}`, async () => {
  await assert.rejects(request(f));
});

test('candidate reader rejects cross-generation payload even when its body hash is otherwise valid', async () => {
  const f = fixture();
  const changed = fixture({ generation: '2026-10-01T02:43:24.281Z' });
  const forged = { ...changed, generation: f.generation };
  await assert.rejects(request(forged));
});

test('candidate reader uses immutable identity URL and bridges exact parent cancellation into an independently timed child', async () => {
  const f = fixture();
  const controller = new AbortController();
  let observed;
  await request(f, { signal: controller.signal, capture: (url, options) => { observed = { url, options }; } });
  const url = new URL(observed.url, 'https://example.invalid');
  assert.equal(url.pathname, '/api/replica');
  assert.equal(url.searchParams.get('generation'), asOf);
  assert.equal(url.searchParams.get('part'), f.part);
  // Each part owns its deadline: forwarding the parent's signal by identity
  // disconnects that deadline from fetch, while aborting the parent would
  // incorrectly cancel sibling parts. Preserve cancellation by behavior.
  assert.notEqual(observed.options.signal, controller.signal);
  assert.equal(observed.options.signal.aborted, false);
  let activeSignal, requests = 0, started;
  const bodyStarted = new Promise(resolve => { started = resolve; });
  const active = readReplicaPart({ generation: f.generation, part: f.part, meta: f.meta, signal: controller.signal,
    fetcher: async (_url, options) => {
      requests++; activeSignal = options.signal;
      return { ok: true, text() { started(); return new Promise(() => {}); } };
    } });
  const reason = Object.assign(new Error('navigation-cancelled'), { name: 'AbortError' });
  const rejected = assert.rejects(active, error => error === reason);
  await bodyStarted;
  controller.abort(reason);
  await rejected;
  assert.equal(requests, 1);
  assert.equal(activeSignal.aborted, true);
  assert.equal(activeSignal.reason, reason);
  assert.equal(observed.options.signal.aborted, false, 'a finished part has detached its parent cancellation listener');
  await assert.rejects(request(f, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(request(f, { status: 503 }));
});
