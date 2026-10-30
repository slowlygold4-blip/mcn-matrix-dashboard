/** Public creator corpus contract shared by producer and hosted reader. */
import {buildCreatorIntelligence} from './creator-intelligence.mjs';
const keys=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===k.length&&k.every(x=>Object.hasOwn(v,x));
const n=v=>Number.isSafeInteger(v)&&v>=0;
const nullable=v=>v===null||n(v);
const text=(v,max=300)=>typeof v==='string'&&v.length<=max&&!/[<>\u0000-\u001f]/.test(v);
const day=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const time=(v,asOf)=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&Date.parse(v)<=Date.parse(asOf);
const SHA=/^[a-f0-9]{64}$/;
const common=['version','asOf','timeZone'];
const AUTHOR=['row','name','douyinId','posts','slicePosts','creationPosts','aiPosts','cupPosts','plays','likes','followers','targetIds'];
const registeredCategories=a=>Array.isArray(a.registeredClassifications)&&a.registeredClassifications.length<=3
 &&a.registeredClassifications.every(k=>['slice','original','ai-remix'].includes(k))
 &&new Set(a.registeredClassifications).size===a.registeredClassifications.length;
const WORK=['row','contentId','author','douyinId','publishDate','type','track','tracks','plays','likes','title','url'];
const STATS=['authors','rawAuthorRows','reciprocalDuplicates','works','datedWorks','undatedWorks','linkedAuthors','worksWithPlays','worksWithLikes','cumulativePlays','cumulativeLikes'];
const name=path=>path?.replace(/^creator\//,'');
export const creatorEditionIdentityPayload=(index,authors,works)=>JSON.stringify([index.revision,index.linkFingerprint,index.sourceModifiedAt,index.importedAt,authors,works]);
export const creatorFile=f=>/^creator\/(index|authors|insights|works-\d{3})\.json$/.test(f?.path??'');
export const creatorKind=path=>({'index.json':'creatorIndex','authors.json':'creatorAuthors','insights.json':'creatorInsights'}[name(path)]||(/^works-\d{3}\.json$/.test(name(path)??'')?'creatorWorks':null));

export function creatorPartValid(part,meta,asOf){
 if(!creatorFile(meta)||creatorKind(meta.path)!==meta.kind||part?.version!==1||part.asOf!==asOf||part.timeZone!=='Asia/Shanghai'||!text(part.revision,120))return false;
 if(meta.kind==='creatorIndex')return keys(part,[...common,'revision','sourceModifiedAt','importedAt','sourceRows','linkMode','linkFingerprint','editionFingerprint','stats','tracks','files','semantics'])
  &&time(part.sourceModifiedAt,asOf)&&time(part.importedAt,asOf)&&n(part.sourceRows)&&part.linkMode==='current-strict'
  &&SHA.test(part.linkFingerprint)&&SHA.test(part.editionFingerprint)&&keys(part.stats,STATS)
  &&STATS.every(k=>k.startsWith('cumulative')?nullable(part.stats[k]):n(part.stats[k]))&&part.stats.works===meta.count
  &&part.stats.rawAuthorRows-part.stats.reciprocalDuplicates===part.stats.authors
  &&part.stats.datedWorks+part.stats.undatedWorks===part.stats.works
  &&Array.isArray(part.tracks)&&part.tracks.every(t=>keys(t,['name','works','cumulativePlays','cumulativeLikes','authors'])&&text(t.name,100)&&n(t.works)&&n(t.authors)&&nullable(t.cumulativePlays)&&nullable(t.cumulativeLikes))
  &&keys(part.semantics,['plays','likes','missing','privacy'])&&Object.values(part.semantics).every(v=>text(v,300))
  &&Array.isArray(part.files)&&part.files.every(f=>keys(f,['path','count','bytes','sha256','generation'])&&/^((authors|insights)|works-\d{3})\.json$/.test(f.path)&&n(f.count)&&n(f.bytes)&&f.bytes>0&&SHA.test(f.sha256)&&f.generation===asOf);
 if(!keys(part,[...common,'revision','items'])||!Array.isArray(part.items)||part.items.length!==meta.count)return false;
 if(meta.kind==='creatorAuthors')return part.items.every(a=>(keys(a,AUTHOR)||keys(a,[...AUTHOR,'registeredClassifications'])&&registeredCategories(a))&&n(a.row)&&a.row>0&&text(a.name,160)&&text(a.douyinId,120)
  &&AUTHOR.slice(3,11).every(k=>nullable(a[k]))&&Array.isArray(a.targetIds)&&a.targetIds.every(id=>n(id)&&id>0)&&new Set(a.targetIds).size===a.targetIds.length);
 if(meta.kind==='creatorWorks')return part.items.length<=1000&&part.items.every(w=>keys(w,WORK)&&n(w.row)&&w.row>0&&/^\d{16,22}$/.test(w.contentId)
  &&text(w.author,160)&&text(w.douyinId,120)&&(w.publishDate===''||day(w.publishDate))&&text(w.type,80)&&text(w.track,100)&&text(w.tracks,180)
  &&nullable(w.plays)&&nullable(w.likes)&&text(w.title,300)&&(w.url===null||w.url===`https://www.douyin.com/video/${w.contentId}`));
 return meta.kind==='creatorInsights'&&part.items.length===1&&part.items[0]&&typeof part.items[0]==='object';
}

export async function auditCreatorPublication({manifest,readPart}){
 const metas=manifest.files.filter(creatorFile);if(!metas.length)return;
 const root=metas.find(m=>m.path==='creator/index.json');if(!root)throw Error('creator-index-missing');
 const index=await readPart(root.path);if(!creatorPartValid(index,root,manifest.asOf))throw Error('creator-index-invalid');
 const seen=new Set(),authors=[],works=[];let insight;
 for(const descriptor of index.files){
  if(seen.has(descriptor.path))throw Error('creator-duplicate-part');seen.add(descriptor.path);
  const meta=metas.find(m=>m.path==='creator/'+descriptor.path);
  if(!meta||['count','bytes','sha256'].some(k=>meta[k]!==descriptor[k]))throw Error('creator-part-descriptor-conflict');
  const part=await readPart(meta.path);
  if(!creatorPartValid(part,meta,manifest.asOf)||part.revision!==index.revision)throw Error('creator-part-invalid');
  if(meta.kind==='creatorAuthors')authors.push(...part.items);else if(meta.kind==='creatorWorks')works.push(...part.items);else if(meta.kind==='creatorInsights')insight=part.items[0];
 }
 if(seen.size!==metas.length-1||!seen.has('authors.json')||!seen.has('insights.json')||authors.length!==index.stats.authors||works.length!==index.stats.works
  ||new Set(authors.map(a=>a.row)).size!==authors.length||new Set(works.map(w=>w.row)).size!==works.length)throw Error('creator-total-conflict');
 const computed=buildCreatorIntelligence(authors,works);
 if(manifest.files.some(f=>f.path==='catalog.json')){
  const catalog=await readPart('catalog.json'),ids=new Set((catalog.accounts??[]).map(a=>a.id)),link=catalog.creatorSourceLinks;
  if(authors.some(a=>a.targetIds.some(id=>!ids.has(id))))throw Error('creator-account-link-conflict');
  if(link&&(String(link.revision)!==index.revision||link.modifiedAt!==index.sourceModifiedAt||link.rowCount!==index.sourceRows))throw Error('creator-catalog-edition-conflict');
 }
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(creatorEditionIdentityPayload(index,authors,works)));
 if([...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('')!==index.editionFingerprint)throw Error('creator-edition-fingerprint-conflict');
 if(JSON.stringify(computed)!==JSON.stringify(insight))throw Error('creator-insights-conflict');
 for(const [key,value]of Object.entries({datedWorks:computed.counts.datedWorks,undatedWorks:computed.counts.undatedWorks,
  worksWithPlays:computed.counts.playsKnown,worksWithLikes:computed.counts.likesKnown,cumulativePlays:computed.counts.cumulativePlays,
  cumulativeLikes:computed.counts.cumulativeLikes,linkedAuthors:authors.filter(a=>a.targetIds.length).length}))
  if(index.stats[key]!==value)throw Error('creator-summary-conflict');
 const tracks=computed.tracks.map(t=>({name:t.track,works:t.works,cumulativePlays:t.cumulativePlays,cumulativeLikes:t.cumulativeLikes,authors:t.authors}));
 if(JSON.stringify(tracks)!==JSON.stringify(index.tracks))throw Error('creator-track-conflict');
 return {authors:authors.length,works:works.length,editionFingerprint:index.editionFingerprint};
}
