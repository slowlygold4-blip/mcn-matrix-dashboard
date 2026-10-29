// Server only: every sealed date shard and daily source is re-read before activation.
import {createHash} from 'node:crypto';
import {dateDescriptors,validateDateShard} from './replica-date-range.mjs';
import {summaryPointValid} from './replica-summary.mjs';
const fields=['targetId','date','capturedAt','followers','followersAt','likes','likesAt','posts','postsAt'];
const demand=(x,code='date-source-invalid')=>{if(!x)throw Object.assign(Error('date-source-audit-failed'),{code});};
// Six is the worker's bounded concurrent connection ceiling. The public
// replica now has >1,000 small daily parts; four readers exceeded the hosted
// request window while six still honor the 8 MB in-flight body budget.
const MAX_DAILY_READERS=6;
const MAX_DAILY_SOURCE_BYTES_IN_FLIGHT=8_000_000;
export async function auditDatePublication({manifest,readText,signal,onProgress=(_progress)=>{}}){
 const metas=new Map(manifest.files.map(f=>[f.path,f]));
 let verifiedDaily=0;const expectedDaily=manifest.files.filter(f=>f.kind==='daily').length;
 const progress=phase=>onProgress({phase,verifiedDaily,expectedDaily});progress('index');
 const read=async path=>{signal?.throwIfAborted();const meta=metas.get(path);demand(meta);let text;try{text=await readText(path);}catch{signal?.throwIfAborted();demand(false,'date-storage-read');}signal?.throwIfAborted();demand(typeof text==='string','date-source-missing');demand(Buffer.byteLength(text)===meta.bytes&&createHash('sha256').update(text).digest('hex')===meta.sha256,'date-source-checksum');try{return JSON.parse(text);}catch{demand(false,'date-source-json');}};
 const index=await read('date-summary-index.json'),descriptors=await dateDescriptors(index,manifest),digests=new Map();let previous=null;
 progress('shards');
 for(const s of descriptors){const part=await read(s.path);previous=validateDateShard(part,s,manifest,previous);for(const point of part.items){let state=digests.get(point.targetId);if(!state){state={hash:createHash('sha256'),count:0};digests.set(point.targetId,state);}state.hash.update(JSON.stringify(point)+'\n');state.count++;}}
 progress('daily');
 const daily=manifest.files.filter(f=>f.kind==='daily');
 const largest=daily.reduce((bytes,meta)=>Math.max(bytes,meta.bytes),0);
 const readers=Math.min(MAX_DAILY_READERS,daily.length,Math.max(1,Math.floor(MAX_DAILY_SOURCE_BYTES_IN_FLIGHT/(largest||1))));
 let cursor=0, stopped=false, failure;
 const worker=async()=>{while(!stopped){
  const i=cursor++;if(i>=daily.length)return;
  try{
   const meta=daily[i],part=await read(meta.path);
   demand(part.version===1&&part.asOf===manifest.asOf&&part.timeZone==='Asia/Shanghai'&&Array.isArray(part.items)&&part.items.length===meta.count);
   const hash=createHash('sha256'),seen=new Set();
   for(const row of [...part.items].sort((a,b)=>a.date.localeCompare(b.date))){const point=Object.fromEntries(fields.map(k=>[k,row[k]]));demand(row.targetId===meta.targetId&&summaryPointValid(point,manifest.asOf)&&!seen.has(point.date));seen.add(point.date);hash.update(JSON.stringify(point)+'\n');}
   const state=digests.get(meta.targetId);demand((state?.count??0)===meta.count&&hash.digest('hex')===(state?.hash??createHash('sha256')).digest('hex'),'date-source-digest');digests.delete(meta.targetId);verifiedDaily++;if(verifiedDaily%64===0||verifiedDaily===expectedDaily)progress('daily');
  }catch(error){if(!stopped){stopped=true;failure=error;}}
 }};
 // Workers settle their in-flight reads before a failure escapes. No background
 // source read can outlive a rejected activation attempt.
 await Promise.all(Array.from({length:readers},worker));
 if(stopped)throw failure;
 demand(digests.size===0,'date-source-extra-target');signal?.throwIfAborted();progress('done');return {fullySourceBound:true,count:index.count,shards:descriptors.length};
}
