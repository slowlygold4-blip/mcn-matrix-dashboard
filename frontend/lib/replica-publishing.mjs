// Public, paged publication ledger shared by producer, server and client.
const keys=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===k.length&&k.every(x=>Object.hasOwn(v,x));
const count=v=>Number.isSafeInteger(v)&&v>=0;
const day=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const clean=v=>typeof v==='string'&&v.length<=300&&!/[<>]/.test(v);
export const publishingFile=f=>f.path==='publishing.json'||f.path?.startsWith('publishing/');
export function publishingPartValid(part,meta,asOf){
 if(part?.version!==1||part.asOf!==asOf||part.timeZone!=='Asia/Shanghai')return false;
 if(meta.kind==='publishing')return keys(part,['version','asOf','timeZone','scope','complete','count','days'])&&part.scope==='tuantuan'&&part.complete===false&&count(part.count)&&part.count===meta.count&&Array.isArray(part.days)&&part.days.every(d=>keys(d,['date','works','tracks','parts'])&&(d.date===''||day(d.date))&&count(d.works)&&Array.isArray(d.parts)&&d.parts.every(p=>/^publishing\/[0-9]{6}\.json$/.test(p))&&d.tracks&&typeof d.tracks==='object'&&Object.entries(d.tracks).every(([k,v])=>['slice','original','ai-remix','contest','unclassified'].includes(k)&&count(v)));
 return meta.kind==='publishingShard'&&keys(part,['version','asOf','timeZone','items'])&&Array.isArray(part.items)&&part.items.length===meta.count&&part.items.length>0&&part.items.length<=500&&part.items.every(r=>keys(r,['contentId','date','author','title','targetId','classifications','origin'])&&typeof r.contentId==='string'&&/^\d{1,25}$/.test(r.contentId)&&(r.date===''||day(r.date))&&clean(r.author)&&clean(r.title)&&(r.targetId===null||Number.isSafeInteger(r.targetId)&&r.targetId>0)&&['source','platform'].includes(r.origin)&&Array.isArray(r.classifications)&&new Set(r.classifications).size===r.classifications.length&&r.classifications.every(k=>['slice','original','ai-remix','contest'].includes(k)));
}
export function publishingPartitions(rows){
 const seen=new Set(),groups=new Map();
 for(const r of rows){if(seen.has(r.contentId))throw Error('duplicate-publishing-work');seen.add(r.contentId);const list=groups.get(r.date)||[];list.push(r);groups.set(r.date,list);}
 const shards=[],days=[];let seq=0;
 for(const [date,items] of [...groups].sort(([a],[b])=>a.localeCompare(b))){
  items.sort((a,b)=>a.contentId.localeCompare(b.contentId));const parts=[],tracks={};
  for(const r of items)for(const k of r.classifications.length?r.classifications:['unclassified'])tracks[k]=(tracks[k]||0)+1;
  for(let offset=0;offset<items.length;offset+=500){const path=`publishing/${String(++seq).padStart(6,'0')}.json`;parts.push(path);shards.push({path,kind:'publishingShard',items:items.slice(offset,offset+500)});}
  days.push({date,works:items.length,tracks,parts});
 }
 return [{path:'publishing.json',kind:'publishing',count:rows.length,scope:'tuantuan',complete:false,days},...shards];
}
export async function auditPublishing({manifest,readPart}){
 const metas=manifest.files.filter(publishingFile);if(!metas.length)return;
 const root=metas.find(m=>m.path==='publishing.json');if(!root)throw Error('publishing-index-missing');
 const index=await readPart(root.path);if(!publishingPartValid(index,root,manifest.asOf))throw Error('publishing-index-invalid');
 const paths=new Set(),ids=new Set(),dates=new Set();let total=0;
 for(const d of index.days){if(dates.has(d.date))throw Error('duplicate-publication-day');dates.add(d.date);let works=0;const tracks={};
  for(const path of d.parts){if(paths.has(path))throw Error('duplicate-publication-shard');paths.add(path);const meta=metas.find(m=>m.path===path),p=await readPart(path);
   if(!meta||!publishingPartValid(p,meta,manifest.asOf))throw Error('publishing-shard-invalid');
   for(const r of p.items){if(ids.has(r.contentId)||r.date!==d.date)throw Error('publication-identity-or-date-conflict');ids.add(r.contentId);works++;for(const k of r.classifications.length?r.classifications:['unclassified'])tracks[k]=(tracks[k]||0)+1;}
  }
  if(works!==d.works||Object.keys(tracks).length!==Object.keys(d.tracks).length||Object.keys(tracks).some(k=>tracks[k]!==d.tracks[k]))throw Error('publication-count-conflict');total+=works;
 }
 if(total!==index.count||paths.size!==metas.length-1)throw Error('publication-total-conflict');
}
