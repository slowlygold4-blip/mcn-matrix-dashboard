// Immutable publication ledger: one ID, one publication day, one adopted value.
import { summarizeAdoptedWorks } from './work-metric-adoption.mjs';
import {PUBLICATION_DATE_MODE,publicationDateBasisValid,publicationDateCounts,publicationDateCountsValid} from './publication-date-basis.mjs';
export const publicationIdentity = row => `${row.platform??'douyin'}:${row.contentId}`;
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
const stringSet=value=>Array.isArray(value)&&value.length<=100&&value.every(v=>clean(v)&&v.length>0)&&new Set(value).size===value.length;
const scopeValid=s=>keys(s,['theme','boardKeys','labels'])&&clean(s.theme)&&!!s.theme&&stringSet(s.boardKeys)&&stringSet(s.labels);
function trackCounts(rows){const result={};for(const r of rows)for(const key of r.classifications.length?r.classifications:['unclassified'])result[key]=(result[key]??0)+1;return result;}
export function publicationScopeGroups(rows){
 const dated=rows.some(row=>Object.hasOwn(row,'dateBasis'));
 const groups=new Map();for(const row of rows){const list=groups.get(row.scopeId)??[];list.push(row);groups.set(row.scopeId,list);}
 return [...groups].sort(([a],[b])=>a-b).map(([scopeId,items])=>{
  const tracks=trackCounts(items),full=publicationMetricSummary(items),metrics={all:full.all};
  for(const [track,count]of Object.entries(tracks))metrics[track]=count===items.length?'all':full[track];
  return {scopeId,works:items.length,tracks,metrics,...(dated?{dateCounts:publicationDateCounts(items)}:{})};
 });
}
const emptyMetrics=()=>publicationMetricSummary([]);
export function expandPublicationScopeMetrics(group){
 const metrics=emptyMetrics();metrics.all=group.metrics.all;
 for(const track of Object.keys(group.tracks))metrics[track]=group.metrics[track]==='all'?group.metrics.all:group.metrics[track];
 return metrics;
}
function scopeMetricsValid(group){
 if(!keys(group.metrics,['all',...Object.keys(group.tracks)])||!summaryValid(group.metrics.all,group.works))return false;
 return Object.entries(group.tracks).every(([track,n])=>group.metrics[track]==='all'?n===group.works:summaryValid(group.metrics[track],n));
}

export function publicationMetricSummary(rows) {
  if (rows.some(r => !validWorkMetrics(r.metrics))) throw Error('publication-metrics-missing');
  return Object.fromEntries(['all', ...categories].map(track => [track, summarizeAdoptedWorks(selectedRows(rows, track).map(r => ({
    contentId: publicationIdentity(r), adoptedLikes: r.metrics.likes.value, adoptedPlays: r.metrics.plays.value,
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
    const measured = Object.hasOwn(part, 'metrics'),scoped=Object.hasOwn(part,'scopes'),dated=Object.hasOwn(part,'dateMode');
    const fields=[...rootFields,...(measured?['metrics']:[]),...(scoped?['scopes']:[]),...(dated?['dateMode','dateCounts']:[])];
    if (!keys(part, fields) || part.scope !== (scoped?'matrix':'tuantuan')
      || scoped&&(!measured||!Array.isArray(part.scopes)||part.scopes.length>2000||!part.scopes.every(scopeValid)||new Set(part.scopes.map(s=>JSON.stringify(s))).size!==part.scopes.length)
      ||dated&&part.dateMode!==PUBLICATION_DATE_MODE
      || part.complete !== false || !count(part.count) || part.count !== meta.count || !Array.isArray(part.days)) return false;
    const tracks = {};
    for (const d of part.days) {
      if (!keys(d, [...groupFields,...(measured?['metrics']:[]),...(scoped?['scopeGroups']:[]),...(dated?['dateCounts']:[])]) || !(d.date === '' || day(d.date)) || !count(d.works)
        || !Array.isArray(d.parts) || !d.parts.every(p => /^publishing\/[0-9]{6}\.json$/.test(p))
        || !d.tracks || typeof d.tracks !== 'object' || Array.isArray(d.tracks)
        || !Object.entries(d.tracks).every(([k, v]) => categories.includes(k) && count(v))
        || measured && !metricsValid(d.metrics, d.works, d.tracks)
        || dated&&!publicationDateCountsValid(d.dateCounts,d.works,d.tracks)
        || scoped&&(!Array.isArray(d.scopeGroups)||new Set(d.scopeGroups.map(g=>g.scopeId)).size!==d.scopeGroups.length
          || !d.scopeGroups.every(g=>keys(g,['scopeId','works','tracks','metrics',...(dated?['dateCounts']:[])])&&count(g.scopeId)&&g.scopeId<part.scopes.length
            &&count(g.works)&&g.tracks&&typeof g.tracks==='object'&&!Array.isArray(g.tracks)&&Object.entries(g.tracks).every(([k,v])=>categories.includes(k)&&count(v))&&scopeMetricsValid(g)
            &&(!dated||publicationDateCountsValid(g.dateCounts,g.works,g.tracks)))
          || d.scopeGroups.reduce((sum,g)=>sum+g.works,0)!==d.works)) return false;
      for (const [k, v] of Object.entries(d.tracks)) tracks[k] = (tracks[k] ?? 0) + v;
    }
    return (!measured || metricsValid(part.metrics, part.count, tracks))&&(!dated||publicationDateCountsValid(part.dateCounts,part.count,tracks));
  }
  return meta.kind === 'publishingShard' && keys(part, ['version', 'asOf', 'timeZone', 'items'])
    && Array.isArray(part.items) && part.items.length === meta.count && part.items.length > 0 && part.items.length <= 500
    && part.items.every(r => keys(r, [...baseWorkFields,...(Object.hasOwn(r??{},'metrics')?['metrics']:[]),...(Object.hasOwn(r??{},'scopeId')?['scopeId','platform']:[]),...(Object.hasOwn(r??{},'dateBasis')?['dateBasis']:[])])
      && typeof r.contentId === 'string' && (r.platform==='bilibili'?/^BV[0-9A-Za-z]{10}$/:/^\d{1,25}$/).test(r.contentId) && (r.date === '' || day(r.date))
      && (!Object.hasOwn(r,'scopeId')||count(r.scopeId)&&['douyin','bilibili'].includes(r.platform)&&validWorkMetrics(r.metrics))
      && clean(r.author) && clean(r.title) && (r.targetId === null || Number.isSafeInteger(r.targetId) && r.targetId > 0)
      && ['source', 'platform'].includes(r.origin) && Array.isArray(r.classifications)
      && new Set(r.classifications).size === r.classifications.length && r.classifications.every(k => categories.slice(0, -1).includes(k))
      && (!Object.hasOwn(r,'dateBasis')||publicationDateBasisValid(r.dateBasis,r.date))
      && (!Object.hasOwn(r, 'metrics') || validWorkMetrics(r.metrics)));
}
export function publishingPartitions(rows, { withMetrics = false, scopes,withDates=false } = {}) {
  const scoped=scopes!==undefined;
  if(scoped&&(!withMetrics||!Array.isArray(scopes)||!scopes.every(scopeValid)))throw Error('publication-scope-mode-conflict');
  const seen = new Set(), groups = new Map();
  for (const r of rows) {
    const id=publicationIdentity(r);
    if (seen.has(id)) throw Error('duplicate-publishing-work');
    if (withMetrics && !validWorkMetrics(r.metrics) || !withMetrics && Object.hasOwn(r, 'metrics')) throw Error('publication-metric-mode-conflict');
    if(withDates?!publicationDateBasisValid(r.dateBasis,r.date):Object.hasOwn(r,'dateBasis'))throw Error('publication-date-mode-conflict');
    if(scoped?(!count(r.scopeId)||r.scopeId>=scopes.length):Object.hasOwn(r,'scopeId'))throw Error('publication-scope-mode-conflict');
    seen.add(id); const list = groups.get(r.date) || []; list.push(r); groups.set(r.date, list);
  }
  const shards = [], days = []; let seq = 0;
  for (const [date, items] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...items].sort((a, b) => publicationIdentity(a).localeCompare(publicationIdentity(b))), parts = [], tracks = {};
    for (const r of sorted) for (const k of r.classifications.length ? r.classifications : ['unclassified']) tracks[k] = (tracks[k] || 0) + 1;
    for (let offset = 0; offset < sorted.length; offset += 500) {
      const path = `publishing/${String(++seq).padStart(6, '0')}.json`; parts.push(path);
      shards.push({ path, kind: 'publishingShard', items: sorted.slice(offset, offset + 500) });
    }
    days.push({ date, works: sorted.length, tracks, parts, ...(withMetrics ? { metrics: publicationMetricSummary(sorted) } : {}),
      ...(withDates?{dateCounts:publicationDateCounts(sorted)}:{}),
      ...(scoped?{scopeGroups:publicationScopeGroups(sorted)}:{}) });
  }
  return [{ path: 'publishing.json', kind: 'publishing', count: rows.length, scope: scoped?'matrix':'tuantuan', complete: false, days,
    ...(withDates?{dateMode:PUBLICATION_DATE_MODE,dateCounts:publicationDateCounts(rows)}:{}),
    ...(scoped?{scopes}:{}),
    ...(withMetrics ? { metrics: publicationMetricSummary(rows) } : {}) }, ...shards];
}
export async function auditPublishing({ manifest, readPart }) {
  const metas = manifest.files.filter(publishingFile); if (!metas.length) return;
  const root = metas.find(m => m.path === 'publishing.json'); if (!root) throw Error('publishing-index-missing');
  const index = await readPart(root.path); if (!publishingPartValid(index, root, manifest.asOf)) throw Error('publishing-index-invalid');
  const paths = new Set(), ids = new Set(), dates = new Set(), allRows = []; let total = 0;
  const measured = Object.hasOwn(index, 'metrics'),scoped=Object.hasOwn(index,'scopes'),dated=Object.hasOwn(index,'dateMode');
  for (const d of index.days) {
    if (dates.has(d.date)) throw Error('duplicate-publication-day'); dates.add(d.date);
    const rows = [], tracks = {};
    for (const path of d.parts) {
      if (paths.has(path)) throw Error('duplicate-publication-shard'); paths.add(path);
      const meta = metas.find(m => m.path === path), p = await readPart(path);
      if (!meta || !publishingPartValid(p, meta, manifest.asOf)) throw Error('publishing-shard-invalid');
      for (const r of p.items) {
        const id=publicationIdentity(r);
        if (ids.has(id) || r.date !== d.date) throw Error('publication-identity-or-date-conflict');
        if (Object.hasOwn(r, 'metrics') !== measured) throw Error('publication-metric-mode-conflict');
        if(Object.hasOwn(r,'dateBasis')!==dated)throw Error('publication-date-mode-conflict');
        if(Object.hasOwn(r,'scopeId')!==scoped||scoped&&r.scopeId>=index.scopes.length)throw Error('publication-scope-mode-conflict');
        ids.add(id); rows.push(r);
        for (const k of r.classifications.length ? r.classifications : ['unclassified']) tracks[k] = (tracks[k] || 0) + 1;
      }
    }
    if (rows.length !== d.works || Object.keys(tracks).length !== Object.keys(d.tracks).length
      || Object.keys(tracks).some(k => tracks[k] !== d.tracks[k])) throw Error('publication-count-conflict');
    if (measured && JSON.stringify(publicationMetricSummary(rows)) !== JSON.stringify(d.metrics)) throw Error('publication-daily-metrics-conflict');
    if(dated&&JSON.stringify(publicationDateCounts(rows))!==JSON.stringify(d.dateCounts))throw Error('publication-daily-date-count-conflict');
    if(scoped&&JSON.stringify(publicationScopeGroups(rows))!==JSON.stringify(d.scopeGroups))throw Error('publication-daily-scope-conflict');
    total += rows.length; allRows.push(...rows);
  }
  if (total !== index.count || paths.size !== metas.length - 1) throw Error('publication-total-conflict');
  if (measured && JSON.stringify(publicationMetricSummary(allRows)) !== JSON.stringify(index.metrics)) throw Error('publication-total-metrics-conflict');
  if(dated&&JSON.stringify(publicationDateCounts(allRows))!==JSON.stringify(index.dateCounts))throw Error('publication-total-date-count-conflict');
}
