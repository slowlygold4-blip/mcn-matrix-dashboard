// Immutable publication ledger: one ID, one publication day, one adopted value.
import { summarizeAdoptedWorks } from './work-metric-adoption.mjs';
const keys = (v, names) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === names.length && names.every(name => Object.hasOwn(v, name));
const count = v => Number.isSafeInteger(v) && v >= 0;
const day = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const clean = v => typeof v === 'string' && v.length <= 300 && !/[<>]/.test(v);
const categories = ['slice', 'original', 'ai-remix', 'contest', 'unclassified'];
const origins = ['source', 'source-record', 'source-observation', 'platform', 'conflict', 'unavailable'];
const baseWorkFields = ['contentId', 'date', 'author', 'title', 'targetId', 'classifications', 'origin'];
const rootFields = ['version', 'asOf', 'timeZone', 'scope', 'complete', 'count', 'days'];
const groupFields = ['date', 'works', 'tracks', 'parts'];
const selectedRows = (rows, track) => track === 'all' ? rows : rows.filter(r => track === 'unclassified'
  ? !r.classifications.length : r.classifications.includes(track));
const validMetric = v => keys(v, ['value', 'origin']) && origins.includes(v.origin)
  && (v.value === null || count(v.value)) && (['conflict', 'unavailable'].includes(v.origin) ? v.value === null : v.value !== null);
const validWorkMetrics = v => keys(v, ['likes', 'plays']) && validMetric(v.likes) && validMetric(v.plays);
export const publishingFile = f => f.path === 'publishing.json' || f.path?.startsWith('publishing/');

export function publicationMetricSummary(rows) {
  if (rows.some(r => !validWorkMetrics(r.metrics))) throw Error('publication-metrics-missing');
  return Object.fromEntries(['all', ...categories].map(track => [track, summarizeAdoptedWorks(selectedRows(rows, track).map(r => ({
    contentId: r.contentId, adoptedLikes: r.metrics.likes.value, adoptedPlays: r.metrics.plays.value,
    likesOrigin: r.metrics.likes.origin, playsOrigin: r.metrics.plays.origin,
  })))]));
}
function summaryValid(summary, works) {
  return keys(summary, ['works', 'likes', 'plays']) && summary.works === works && count(works)
    && ['likes', 'plays'].every(metric => {
      const s = summary[metric];
      return keys(s, ['value', 'known', 'missing', 'conflicts', 'overflow']) && count(s.known) && count(s.missing)
        && s.known + s.missing === works && count(s.conflicts) && s.conflicts <= s.missing && typeof s.overflow === 'boolean'
        && (s.value === null || count(s.value)) && (s.known === 0 || s.overflow ? s.value === null : s.value !== null)
        && (!s.overflow || s.known > 0);
    });
}
function metricsValid(metrics, works, tracks) {
  return keys(metrics, ['all', ...categories]) && summaryValid(metrics.all, works)
    && categories.every(track => summaryValid(metrics[track], tracks[track] ?? 0));
}
export function publishingPartValid(part, meta, asOf) {
  if (part?.version !== 1 || part.asOf !== asOf || part.timeZone !== 'Asia/Shanghai') return false;
  if (meta.kind === 'publishing') {
    const measured = Object.hasOwn(part, 'metrics');
    if (!keys(part, measured ? [...rootFields, 'metrics'] : rootFields) || part.scope !== 'tuantuan'
      || part.complete !== false || !count(part.count) || part.count !== meta.count || !Array.isArray(part.days)) return false;
    const tracks = {};
    for (const d of part.days) {
      if (!keys(d, measured ? [...groupFields, 'metrics'] : groupFields) || !(d.date === '' || day(d.date)) || !count(d.works)
        || !Array.isArray(d.parts) || !d.parts.every(p => /^publishing\/[0-9]{6}\.json$/.test(p))
        || !d.tracks || typeof d.tracks !== 'object' || Array.isArray(d.tracks)
        || !Object.entries(d.tracks).every(([k, v]) => categories.includes(k) && count(v))
        || measured && !metricsValid(d.metrics, d.works, d.tracks)) return false;
      for (const [k, v] of Object.entries(d.tracks)) tracks[k] = (tracks[k] ?? 0) + v;
    }
    return !measured || metricsValid(part.metrics, part.count, tracks);
  }
  return meta.kind === 'publishingShard' && keys(part, ['version', 'asOf', 'timeZone', 'items'])
    && Array.isArray(part.items) && part.items.length === meta.count && part.items.length > 0 && part.items.length <= 500
    && part.items.every(r => keys(r, Object.hasOwn(r ?? {}, 'metrics') ? [...baseWorkFields, 'metrics'] : baseWorkFields)
      && typeof r.contentId === 'string' && /^\d{1,25}$/.test(r.contentId) && (r.date === '' || day(r.date))
      && clean(r.author) && clean(r.title) && (r.targetId === null || Number.isSafeInteger(r.targetId) && r.targetId > 0)
      && ['source', 'platform'].includes(r.origin) && Array.isArray(r.classifications)
      && new Set(r.classifications).size === r.classifications.length && r.classifications.every(k => categories.slice(0, -1).includes(k))
      && (!Object.hasOwn(r, 'metrics') || validWorkMetrics(r.metrics)));
}
export function publishingPartitions(rows, { withMetrics = false } = {}) {
  const seen = new Set(), groups = new Map();
  for (const r of rows) {
    if (seen.has(r.contentId)) throw Error('duplicate-publishing-work');
    if (withMetrics && !validWorkMetrics(r.metrics) || !withMetrics && Object.hasOwn(r, 'metrics')) throw Error('publication-metric-mode-conflict');
    seen.add(r.contentId); const list = groups.get(r.date) || []; list.push(r); groups.set(r.date, list);
  }
  const shards = [], days = []; let seq = 0;
  for (const [date, items] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...items].sort((a, b) => a.contentId.localeCompare(b.contentId)), parts = [], tracks = {};
    for (const r of sorted) for (const k of r.classifications.length ? r.classifications : ['unclassified']) tracks[k] = (tracks[k] || 0) + 1;
    for (let offset = 0; offset < sorted.length; offset += 500) {
      const path = `publishing/${String(++seq).padStart(6, '0')}.json`; parts.push(path);
      shards.push({ path, kind: 'publishingShard', items: sorted.slice(offset, offset + 500) });
    }
    days.push({ date, works: sorted.length, tracks, parts, ...(withMetrics ? { metrics: publicationMetricSummary(sorted) } : {}) });
  }
  return [{ path: 'publishing.json', kind: 'publishing', count: rows.length, scope: 'tuantuan', complete: false, days,
    ...(withMetrics ? { metrics: publicationMetricSummary(rows) } : {}) }, ...shards];
}
export async function auditPublishing({ manifest, readPart }) {
  const metas = manifest.files.filter(publishingFile); if (!metas.length) return;
  const root = metas.find(m => m.path === 'publishing.json'); if (!root) throw Error('publishing-index-missing');
  const index = await readPart(root.path); if (!publishingPartValid(index, root, manifest.asOf)) throw Error('publishing-index-invalid');
  const paths = new Set(), ids = new Set(), dates = new Set(), allRows = []; let total = 0;
  const measured = Object.hasOwn(index, 'metrics');
  for (const d of index.days) {
    if (dates.has(d.date)) throw Error('duplicate-publication-day'); dates.add(d.date);
    const rows = [], tracks = {};
    for (const path of d.parts) {
      if (paths.has(path)) throw Error('duplicate-publication-shard'); paths.add(path);
      const meta = metas.find(m => m.path === path), p = await readPart(path);
      if (!meta || !publishingPartValid(p, meta, manifest.asOf)) throw Error('publishing-shard-invalid');
      for (const r of p.items) {
        if (ids.has(r.contentId) || r.date !== d.date) throw Error('publication-identity-or-date-conflict');
        if (Object.hasOwn(r, 'metrics') !== measured) throw Error('publication-metric-mode-conflict');
        ids.add(r.contentId); rows.push(r);
        for (const k of r.classifications.length ? r.classifications : ['unclassified']) tracks[k] = (tracks[k] || 0) + 1;
      }
    }
    if (rows.length !== d.works || Object.keys(tracks).length !== Object.keys(d.tracks).length
      || Object.keys(tracks).some(k => tracks[k] !== d.tracks[k])) throw Error('publication-count-conflict');
    if (measured && JSON.stringify(publicationMetricSummary(rows)) !== JSON.stringify(d.metrics)) throw Error('publication-daily-metrics-conflict');
    total += rows.length; allRows.push(...rows);
  }
  if (total !== index.count || paths.size !== metas.length - 1) throw Error('publication-total-conflict');
  if (measured && JSON.stringify(publicationMetricSummary(allRows)) !== JSON.stringify(index.metrics)) throw Error('publication-total-metrics-conflict');
}
