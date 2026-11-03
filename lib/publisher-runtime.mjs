// Bounded, fixed-field diagnostics. No source records, credentials or model calls.
export const PUBLISHER_RUNTIME_REVISION='publisher-phase-memory-v1';
const phases=['preparation-started','baseline-validated','export-created','stage-written','source-sealed','sync-started','sync-finished','cycle-finished'];
const fields={rssBytes:'rss',heapUsedBytes:'heapUsed',heapTotalBytes:'heapTotal',externalBytes:'external',arrayBufferBytes:'arrayBuffers'};
const instant=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const count=v=>Number.isSafeInteger(v)&&v>=0;
const sampleValid=v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===7
 &&phases.includes(v.phase)&&instant(v.at)&&Object.keys(fields).every(key=>count(v[key]));

export function publisherRuntimeSnapshot(previous,phase,{asOf,at,validationContract,exportRevision,memory=process.memoryUsage()}={}){
 if(!phases.includes(phase)||!instant(asOf)||!instant(at)||Date.parse(asOf)>Date.parse(at)
  ||![validationContract,exportRevision].every(v=>typeof v==='string'&&/^[a-z0-9-]{1,100}$/.test(v))
  ||!Object.values(fields).every(key=>count(memory?.[key])))throw Error('invalid-publisher-runtime-sample');
 const sample={phase,at,...Object.fromEntries(Object.entries(fields).map(([key,source])=>[key,memory[source]]))};
 const reusable=previous?.revision===PUBLISHER_RUNTIME_REVISION&&previous.asOf===asOf
  &&previous.validationContract===validationContract&&previous.exportRevision===exportRevision
  &&Array.isArray(previous.samples)&&previous.samples.length<=phases.length&&previous.samples.every(sampleValid)
  &&new Set(previous.samples.map(s=>s.phase)).size===previous.samples.length
  &&previous.samples.every(s=>Date.parse(s.at)>=Date.parse(asOf)&&Date.parse(s.at)<=Date.parse(at));
 return {revision:PUBLISHER_RUNTIME_REVISION,validationContract,exportRevision,asOf,
  samples:[...(reusable?previous.samples.filter(s=>s.phase!==phase).map(s=>({...s})):[]),sample]};
}
