// Exact-source date contract; producer sync opts in explicitly. Legacy generations are never rewritten.
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { isCalendarDate } from './utils.mjs';

const FIELDS = ['targetId', 'date', 'capturedAt', 'followers', 'followersAt', 'likes', 'likesAt', 'posts', 'postsAt'];
const SHA = /^[a-f0-9]{64}$/;
const COMMON_KEYS = ['version', 'asOf', 'timeZone'];
const MAX_ROWS = 2000, MAX_BYTES = 1_000_000, MAX_SHARDS = 4096;
const own = (x, keys) => x && typeof x === 'object' && !Array.isArray(x)
  && Object.keys(x).length === keys.length && Object.keys(x).every(k => keys.includes(k));
const nat = x => Number.isSafeInteger(x) && x >= 0;
const id = x => Number.isSafeInteger(x) && x > 0 && x <= 99_999_999;
const calendarDate = x => typeof x === 'string' && isCalendarDate(x);
const time = x => typeof x === 'string' && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const hash = x => createHash('sha256').update(x).digest('hex');
const demand = condition => { if (!condition) throw new Error('invalid-history-range-contract'); };
const common = asOf => ({ version: 1, asOf, timeZone: 'Asia/Shanghai' });
const pair = p => `${p.date}/${String(p.targetId).padStart(8, '0')}`;
const sourceShape = ['path', 'targetId', 'count', 'bytes', 'sha256'];
const descriptorShape = ['path', 'count', 'bytes', 'sha256', 'firstDate', 'lastDate'];
// Reuse a formatter; constructing Intl.DateTimeFormat for every metric is a severe hot-path allocation.
const beijingFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});
function beijingDay(value) {
  const parts = beijingFormatter.formatToParts(new Date(value));
  const field = type => parts.find(p => p.type === type)?.value;
  return `${field('year')}-${field('month')}-${field('day')}`;
}

function sourceMetas(manifest) {
  demand(manifest?.version === 1 && time(manifest.asOf) && manifest.timeZone === 'Asia/Shanghai'
    && nat(manifest.counts?.daily) && Array.isArray(manifest.files));
  const sources = manifest.files.filter(f => f.kind === 'daily').map(f => {
    demand(own(f, [...sourceShape, 'kind']) && f.kind === 'daily'
      && f.path === `daily/${f.targetId}.json` && id(f.targetId) && nat(f.count)
      && nat(f.bytes) && f.bytes > 0 && SHA.test(f.sha256));
    const { kind, ...source } = f; return source;
  });
  demand(new Set(sources.map(f => f.path)).size === sources.length
    && sources.reduce((sum, f) => sum + f.count, 0) === manifest.counts.daily);
  return sources;
}

function pointValid(p, asOf) {
  return own(p, FIELDS) && id(p.targetId) && calendarDate(p.date) && time(p.capturedAt)
    && p.capturedAt <= asOf && beijingDay(p.capturedAt) === p.date
    && ['followers', 'likes', 'posts'].every(k => (p[k] === null || nat(p[k]))
      && (p[k + 'At'] === null || (time(p[k + 'At']) && p[k + 'At'] <= p.capturedAt))
      && (p[k] === null || (time(p[k + 'At'])
        && (p[k + 'At'] === p.capturedAt || beijingDay(p[k + 'At']) === p.date))));
}

function sourcePoints(content, meta, asOf) {
  demand(typeof content === 'string' && content.length <= 4_000_000
    && Buffer.byteLength(content) === meta.bytes && hash(content) === meta.sha256);
  let value; try { value = JSON.parse(content); } catch { demand(false); }
  demand(own(value, [...COMMON_KEYS, 'items']) && value.version === 1 && value.asOf === asOf
    && value.timeZone === 'Asia/Shanghai' && Array.isArray(value.items) && value.items.length === meta.count);
  const dates = new Set(), ids = new Set();
  return value.items.map(row => {
    demand(row && row.targetId === meta.targetId && Number.isSafeInteger(row.id) && row.id > 0 && !ids.has(row.id)
      && !dates.has(row.date)); ids.add(row.id); dates.add(row.date);
    const point = Object.fromEntries(FIELDS.map(k => [k, row[k]]));
    demand(pointValid(point, asOf)); return point;
  });
}

function file(path, kind, count, value) {
  const content = JSON.stringify(value) + '\n';
  demand(Buffer.byteLength(content) <= MAX_BYTES);
  return { path, kind, count, bytes: Buffer.byteLength(content), sha256: hash(content), content };
}

/** Derive a new sidecar from every exact original daily source. Old bytes are untouched. */
export async function derivePublicHistoryDateIndex({ sourceManifest, readPart, signal }) {
  const sources = sourceMetas(sourceManifest), byDate = new Map();
  let count = 0;
  for (let i = 0; i < sources.length; i++) {
    signal?.throwIfAborted();
    const points = sourcePoints(await readPart(sources[i].path), sources[i], sourceManifest.asOf);
    signal?.throwIfAborted();
    for (const point of points) {
      const list = byDate.get(point.date) ?? []; list.push(point); byDate.set(point.date, list); count++;
    }
    if (i % 12 === 11) await setImmediate(undefined, { signal });
  }
  demand(count === sourceManifest.counts.daily);
  const files = [], shards = []; let items = [];
  const flush = () => {
    if (!items.length) return;
    demand(files.length < MAX_SHARDS);
    const path = `date-summary/${String(files.length + 1).padStart(6, '0')}.json`;
    const part = file(path, 'summaryDateShard', items.length, { ...common(sourceManifest.asOf), items });
    const descriptor = { path, count: part.count, bytes: part.bytes, sha256: part.sha256,
      firstDate: items[0].date, lastDate: items.at(-1).date };
    files.push(part); shards.push(descriptor); items = [];
  };
  for (const date of [...byDate.keys()].sort()) {
    const points = byDate.get(date).sort((a, b) => a.targetId - b.targetId);
    for (const point of points) { items.push(point); if (items.length === MAX_ROWS) flush(); }
    byDate.delete(date); signal?.throwIfAborted();
  }
  flush(); signal?.throwIfAborted();
  const index = { ...common(sourceManifest.asOf), format: 'date-shards-v1',
    sourceManifestSha256: hash(JSON.stringify(sourceManifest)), sourceDaily: sources, count,
    firstDate: shards[0]?.firstDate ?? null, lastDate: shards.at(-1)?.lastDate ?? null, shards };
  const indexFile = file('date-summary-index.json', 'summaryDateIndex', count, index);
  return { index, indexFile, files, candidateOnly: true };
}

/** Caller must supply the exact index metadata from an already sealed manifest. */
export function verifyPublicHistoryDateIndex({ sourceManifest, indexContent, indexMeta }) {
  demand(own(indexMeta, ['path', 'kind', 'count', 'bytes', 'sha256'])
    && indexMeta.path === 'date-summary-index.json' && indexMeta.kind === 'summaryDateIndex'
    && nat(indexMeta.bytes) && indexMeta.bytes > 0 && indexMeta.bytes <= MAX_BYTES
    && typeof indexContent === 'string' && Buffer.byteLength(indexContent) === indexMeta.bytes
    && hash(indexContent) === indexMeta.sha256);
  let index; try { index = JSON.parse(indexContent); } catch { demand(false); }
  const sources = sourceMetas(sourceManifest);
  demand(own(index, [...COMMON_KEYS, 'format', 'sourceManifestSha256', 'sourceDaily', 'count', 'firstDate', 'lastDate', 'shards'])
    && index.version === 1 && index.asOf === sourceManifest.asOf && index.timeZone === 'Asia/Shanghai'
    && index.format === 'date-shards-v1' && index.sourceManifestSha256 === hash(JSON.stringify(sourceManifest))
    && JSON.stringify(index.sourceDaily) === JSON.stringify(sources) && index.count === indexMeta.count
    && index.count === sourceManifest.counts.daily && Array.isArray(index.shards) && index.shards.length <= MAX_SHARDS);
  let count = 0, previous = null;
  index.shards.forEach((s, i) => {
    demand(own(s, descriptorShape) && s.path === `date-summary/${String(i + 1).padStart(6, '0')}.json`
      && nat(s.count) && s.count > 0 && s.count <= MAX_ROWS && nat(s.bytes) && s.bytes > 0 && s.bytes <= MAX_BYTES
      && SHA.test(s.sha256) && calendarDate(s.firstDate) && calendarDate(s.lastDate)
      && s.firstDate <= s.lastDate && (!previous || previous <= s.firstDate));
    previous = s.lastDate; count += s.count;
  });
  demand(count === index.count && index.firstDate === (index.shards[0]?.firstDate ?? null)
    && index.lastDate === (index.shards.at(-1)?.lastDate ?? null));
  return index;
}

function requestFilter({ ranges = [], dates = [] }) {
  demand(Array.isArray(ranges) && Array.isArray(dates) && (ranges.length || dates.length));
  const selectedDates = new Set(dates);
  demand(dates.every(calendarDate) && ranges.every(r => own(r, ['start', 'end'])
    && calendarDate(r.start) && calendarDate(r.end) && r.start <= r.end));
  return { matches: date => selectedDates.has(date) || ranges.some(r => r.start <= date && date <= r.end),
    overlaps: s => [...selectedDates].some(d => s.firstDate <= d && d <= s.lastDate)
      || ranges.some(r => r.start <= s.lastDate && s.firstDate <= r.end) };
}

/** Iterate bounded verified batches; collecting/flattening all batches defeats this contract. */
export async function* iteratePublicHistoryDateRange(options) {
  const { sourceManifest, indexContent, indexMeta, readPart, signal } = options;
  const index = verifyPublicHistoryDateIndex({ sourceManifest, indexContent, indexMeta });
  const filter = requestFilter(options), sources = new Set(index.sourceDaily.map(f => f.targetId));
  let previousPair = null;
  for (const descriptor of index.shards.filter(filter.overlaps)) {
    signal?.throwIfAborted();
    const content = await readPart(descriptor.path); signal?.throwIfAborted();
    demand(typeof content === 'string' && Buffer.byteLength(content) === descriptor.bytes && hash(content) === descriptor.sha256);
    let part; try { part = JSON.parse(content); } catch { demand(false); }
    demand(own(part, [...COMMON_KEYS, 'items']) && part.version === 1 && part.asOf === index.asOf
      && part.timeZone === 'Asia/Shanghai' && Array.isArray(part.items) && part.items.length === descriptor.count
      && part.items[0]?.date === descriptor.firstDate && part.items.at(-1)?.date === descriptor.lastDate);
    for (const point of part.items) {
      demand(pointValid(point, index.asOf) && sources.has(point.targetId)
        && (!previousPair || previousPair < pair(point)));
      previousPair = pair(point);
    }
    signal?.throwIfAborted();
    yield { asOf: index.asOf, sourceManifestSha256: index.sourceManifestSha256,
      totalSavedCount: index.count, loadedPart: descriptor.path, loadedPartSha256: descriptor.sha256,
      items: part.items.filter(p => filter.matches(p.date)) };
  }
}

/** Legacy compatibility: exact immutable daily sources, not an unsafe guessed shard date range. */
export async function* iterateLegacyPublicHistoryRange({ sourceManifest, readPart, signal, ...request }) {
  const sources = sourceMetas(sourceManifest), filter = requestFilter(request);
  for (const meta of sources) {
    signal?.throwIfAborted();
    const points = sourcePoints(await readPart(meta.path), meta, sourceManifest.asOf);
    signal?.throwIfAborted();
    const items = points.filter(p => filter.matches(p.date)).sort((a, b) => a.date.localeCompare(b.date));
    for (let offset = 0; offset < items.length; offset += MAX_ROWS) {
      signal?.throwIfAborted();
      yield { asOf: sourceManifest.asOf, sourceManifestSha256: hash(JSON.stringify(sourceManifest)),
        totalSavedCount: sourceManifest.counts.daily, loadedPart: meta.path, loadedPartSha256: meta.sha256,
        items: items.slice(offset, offset + MAX_ROWS) };
    }
  }
}

/** Activate-time audit: proves every byte/row/range came from all original source files. */
export async function auditPublicHistoryDatePublication({ sourceManifest, indexContent, indexMeta, readSourcePart, readPart, signal }) {
  signal?.throwIfAborted();
  const index = verifyPublicHistoryDateIndex({ sourceManifest, indexContent, indexMeta });
  const sources = sourceMetas(sourceManifest), sourceIds = new Set(sources.map(f => f.targetId));
  const digests = new Map(); let previousPair = null, count = 0;
  // Reconstruct canonical index bytes as well as its hash. Plausible but false
  // bounds, arbitrary re-chunking, whitespace and reordered fields must not
  // become newly valid merely because an attacker re-signs their own output.
  const canonicalIndex = { ...common(sourceManifest.asOf), format: 'date-shards-v1',
    sourceManifestSha256: hash(JSON.stringify(sourceManifest)), sourceDaily: sources,
    count: index.count, firstDate: index.firstDate, lastDate: index.lastDate,
    shards: index.shards.map(s => Object.fromEntries(descriptorShape.map(k => [k, s[k]]))) };
  demand(indexContent === JSON.stringify(canonicalIndex) + '\n');
  demand(index.shards.length === Math.ceil(index.count / MAX_ROWS));
  for (const [i, descriptor] of index.shards.entries()) {
    signal?.throwIfAborted(); const content = await readPart(descriptor.path); signal?.throwIfAborted();
    demand(typeof content === 'string' && Buffer.byteLength(content) === descriptor.bytes
      && hash(content) === descriptor.sha256 && descriptor.count === Math.min(MAX_ROWS, index.count - i * MAX_ROWS));
    let part; try { part = JSON.parse(content); } catch { demand(false); }
    demand(own(part, [...COMMON_KEYS, 'items']) && part.version === 1 && part.asOf === index.asOf
      && part.timeZone === 'Asia/Shanghai' && Array.isArray(part.items) && part.items.length === descriptor.count
      && part.items[0]?.date === descriptor.firstDate && part.items.at(-1)?.date === descriptor.lastDate);
    const canonicalItems = [];
    for (const point of part.items) {
      signal?.throwIfAborted();
      demand(pointValid(point, index.asOf) && sourceIds.has(point.targetId)
        && (!previousPair || previousPair < pair(point)));
      previousPair = pair(point);
      const canonical = Object.fromEntries(FIELDS.map(k => [k, point[k]])); canonicalItems.push(canonical);
      let state = digests.get(point.targetId);
      if (!state) { state = { hash: createHash('sha256'), count: 0 }; digests.set(point.targetId, state); }
      state.hash.update(JSON.stringify(canonical) + '\n'); state.count++; count++;
    }
    demand(content === JSON.stringify({ ...common(index.asOf), items: canonicalItems }) + '\n');
    if (i % 12 === 11) await setImmediate(undefined, { signal });
  }
  demand(count === index.count);
  // One original source and one bounded date shard are parsed at a time;
  // no second global byDate map / projected publication is retained here.
  for (const [i, meta] of sources.entries()) {
    signal?.throwIfAborted(); const content = await readSourcePart(meta.path); signal?.throwIfAborted();
    const points = sourcePoints(content, meta, sourceManifest.asOf).sort((a, b) => a.date.localeCompare(b.date));
    const digest = createHash('sha256');
    for (const point of points) { signal?.throwIfAborted(); digest.update(JSON.stringify(point) + '\n'); }
    const state = digests.get(meta.targetId);
    demand((state?.count ?? 0) === meta.count && digest.digest('hex')
      === (state?.hash ?? createHash('sha256')).digest('hex'));
    digests.delete(meta.targetId);
    if (i % 12 === 11) await setImmediate(undefined, { signal });
  }
  demand(digests.size === 0); signal?.throwIfAborted();
  return { asOf: sourceManifest.asOf, sourceManifestSha256: index.sourceManifestSha256,
    count: index.count, shards: index.shards.length, fullySourceBound: true, candidateOnly: true };
}
