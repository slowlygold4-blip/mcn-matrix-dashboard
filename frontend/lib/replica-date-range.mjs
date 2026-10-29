import {validDate} from './replica-model.mjs';
import {summaryPartValid,summaryPointValid} from './replica-summary.mjs';
import {compactSummaryBuilder,SUMMARY_RETAINED_BYTES} from './compact-summary-points.mjs';
const SHA=/^[a-f0-9]{64}$/;
const own=(x,ks)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===ks.length&&Object.keys(x).every(k=>ks.includes(k));
const nat=x=>Number.isSafeInteger(x)&&x>=0;
const demand=x=>{if(!x)throw Error('日期历史与来源不一致，未替换已读取数据');};
const hash=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join('');
export const isDatePart=f=>['summaryDateIndex','summaryDateShard'].includes(f.kind);
export function dateSourceManifest(manifest){return {...manifest,files:manifest.files.filter(f=>!isDatePart(f))};}
export function normalizeDateRequest({ranges=[],dates=[]}={}){
 demand(Array.isArray(ranges)&&Array.isArray(dates)&&(ranges.length||dates.length)&&ranges.length<=4&&dates.length<=8);
 demand(ranges.every(r=>own(r,['start','end'])&&validDate(r.start)&&validDate(r.end)&&r.start<=r.end)&&dates.every(validDate));
 const result={ranges:[...new Map(ranges.map(r=>[r.start+'/'+r.end,{start:r.start,end:r.end}])).values()].sort((a,b)=>a.start.localeCompare(b.start)||a.end.localeCompare(b.end)),dates:[...new Set(dates)].sort()};
 return {...result,key:JSON.stringify(result)};
}
const move=(date,n)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
export function trendRangeRequest({start,end,otherStart=null,otherEnd=null,offset=0,days=90}){
 demand(validDate(start)&&validDate(end)&&start<=end&&Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(days)&&days>0&&days<=90&&!!otherStart===!!otherEnd);
 if(otherStart)demand(validDate(otherStart)&&validDate(otherEnd)&&otherStart<=otherEnd);
 const windows=[{start,end},...(otherStart?[{start:otherStart,end:otherEnd}]:[])],dates=windows.flatMap(w=>[w.start,w.end]);
 const ranges=windows.map(w=>({start:move(w.start,offset),end:move(w.start,offset+days-1)<w.end?move(w.start,offset+days-1):w.end})).filter(w=>w.start<=w.end);
 return normalizeDateRequest({ranges,dates});
}
export function catalogDateWindow(accounts,asOf){
 const dates=accounts.filter(a=>a.enabled).flatMap(a=>['followers','likes','posts'].map(k=>a.latest?.[k]).filter(m=>m&&m.value!==null&&validDate(m.date)&&typeof m.observedAt==='string'&&m.observedAt<=asOf&&new Date(Date.parse(m.observedAt)+28800000).toISOString().slice(0,10)===m.date).map(m=>m.date)).filter(d=>d>='2026-09-12').sort();
 return {start:'2026-09-12',end:dates.at(-1)||new Date(Date.parse(asOf)+28800000).toISOString().slice(0,10)};
}
export async function dateDescriptors(index,manifest){
 const root=manifest.files.find(f=>f.path==='date-summary-index.json'),base=dateSourceManifest(manifest);
 const sourceDaily=base.files.filter(f=>f.kind==='daily').map(({kind,...f})=>f);
 demand(root&&own(root,['path','kind','count','bytes','sha256'])&&root.kind==='summaryDateIndex'&&root.count===manifest.counts.daily&&nat(root.bytes)&&root.bytes>0&&root.bytes<=1000000&&SHA.test(root.sha256));
 demand(own(index,['version','asOf','timeZone','format','sourceManifestSha256','sourceDaily','count','firstDate','lastDate','shards'])&&index.version===1&&index.asOf===manifest.asOf&&index.timeZone==='Asia/Shanghai'&&index.format==='date-shards-v1'&&index.sourceManifestSha256===await hash(JSON.stringify(base))&&JSON.stringify(index.sourceDaily)===JSON.stringify(sourceDaily)&&index.count===manifest.counts.daily&&Array.isArray(index.shards)&&index.shards.length<=4096);
 demand(sourceDaily.every(f=>own(f,['path','targetId','count','bytes','sha256'])&&f.path===`daily/${f.targetId}.json`&&Number.isSafeInteger(f.targetId)&&f.targetId>0&&f.targetId<=99999999&&nat(f.count)&&nat(f.bytes)&&f.bytes>0&&SHA.test(f.sha256))&&new Set(sourceDaily.map(f=>f.targetId)).size===sourceDaily.length&&sourceDaily.reduce((n,f)=>n+f.count,0)===index.count);
 const declared=manifest.files.filter(f=>f.kind==='summaryDateShard');
 demand(declared.length===index.shards.length&&manifest.files.filter(f=>f.path.startsWith('date-summary/')).length===declared.length&&manifest.files.filter(f=>f.kind==='summaryDateIndex').length===1);
 let count=0,previous=null;
 for(const [i,s] of index.shards.entries()){
  const f=declared.find(f=>f.path===s.path);
  demand(own(s,['path','count','bytes','sha256','firstDate','lastDate'])&&s.path===`date-summary/${String(i+1).padStart(6,'0')}.json`&&nat(s.count)&&s.count>0&&s.count<=2000&&nat(s.bytes)&&s.bytes>0&&s.bytes<=1000000&&SHA.test(s.sha256)&&validDate(s.firstDate)&&validDate(s.lastDate)&&s.firstDate<=s.lastDate&&(!previous||previous<=s.firstDate)&&f&&own(f,['path','kind','count','bytes','sha256'])&&f.count===s.count&&f.bytes===s.bytes&&f.sha256===s.sha256);
  previous=s.lastDate;count+=s.count;
 }
 demand(count===index.count&&index.firstDate===(index.shards[0]?.firstDate??null)&&index.lastDate===(index.shards.at(-1)?.lastDate??null));
 return index.shards;
}
export function validateDateShard(part,descriptor,manifest,previous=null){
 demand(summaryPartValid(part,manifest.asOf)&&part.items.length===descriptor.count&&part.items[0]?.date===descriptor.firstDate&&part.items.at(-1)?.date===descriptor.lastDate);
 const ids=new Set(manifest.files.filter(f=>f.kind==='daily').map(f=>f.targetId));
 for(const p of part.items){const key=p.date+'/'+String(p.targetId).padStart(8,'0');demand(ids.has(p.targetId)&&(!previous||previous<key));previous=key;}
 return previous;
}
/** readPart must authenticate raw bytes against the sealed manifest before returning parsed JSON. */
export async function loadSummaryRange({manifest,readPart,request,signal}){
 const wanted=normalizeDateRequest(request),matches=date=>wanted.dates.includes(date)||wanted.ranges.some(r=>r.start<=date&&date<=r.end);
 signal?.throwIfAborted();let points=[];const loadedParts=[];
 if(manifest.files.some(f=>f.kind==='summaryDateIndex')){
  const index=await readPart('date-summary-index.json');signal?.throwIfAborted();
  const all=await dateDescriptors(index,manifest),selected=all.filter(s=>wanted.dates.some(d=>s.firstDate<=d&&d<=s.lastDate)||wanted.ranges.some(r=>r.start<=s.lastDate&&s.firstDate<=r.end));
  const capacity=selected.reduce((n,s)=>n+s.count,0),bytes=selected.reduce((n,s)=>n+s.bytes,0);
  // Bound retained typed storage, not lifetime JSON transfer. The normal pair
  // of 90-day matrix windows fits without downloading the whole saved history.
  // Each authenticated shard is <=1MB and only one batch is retained at a time.
  if(capacity*64>SUMMARY_RETAINED_BYTES||bytes>320_000_000)throw Error('所选日期窗口超过读取预算，请翻页查看曲线或缩小比较范围；已保存历史未删除');
  const compact=capacity>16384?compactSummaryBuilder(capacity,manifest.asOf):null;
  let previous=null;
  for(let offset=0;offset<selected.length;offset+=10){
   signal?.throwIfAborted();const batch=selected.slice(offset,offset+10);
   const settled=await Promise.allSettled(batch.map(async s=>{signal?.throwIfAborted();const part=await readPart(s.path);signal?.throwIfAborted();return part;}));
   const failed=settled.find(result=>result.status==='rejected');if(failed)throw failed.reason??Error('日期分区读取失败');
   const parts=settled.map(result=>result.value);
   for(const [i,s] of batch.entries()){
    signal?.throwIfAborted();const part=parts[i];previous=validateDateShard(part,s,manifest,previous);
    for(const p of part.items)if(matches(p.date)){if(compact)compact.append(p);else points.push(p);}
    loadedParts.push(s.path);
   }
   // Let navigation/cancellation run between bounded parsing batches.
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  if(compact)points=compact.finish();
 }else{
  // Exact legacy sources, no fabricated shard date bounds or immutable generation rewrite.
  const fields=['targetId','date','capturedAt','followers','followersAt','likes','likesAt','posts','postsAt'];
  for(const meta of manifest.files.filter(f=>f.kind==='daily')){signal?.throwIfAborted();const part=await readPart(meta.path);signal?.throwIfAborted();demand(part?.asOf===manifest.asOf&&part.version===1&&part.timeZone==='Asia/Shanghai'&&Array.isArray(part.items)&&part.items.length===meta.count);const seen=new Set();for(const row of part.items){const p=Object.fromEntries(fields.map(k=>[k,row[k]]));demand(row.targetId===meta.targetId&&summaryPointValid(p,manifest.asOf)&&!seen.has(p.date));seen.add(p.date);if(matches(p.date))points.push(p);}demand(points.length<=200000);loadedParts.push(meta.path);}
 }
 signal?.throwIfAborted();return {points,receipt:{asOf:manifest.asOf,requestKey:wanted.key,request:{ranges:wanted.ranges,dates:wanted.dates},loadedParts,totalSavedCount:manifest.counts.daily,complete:true}};
}
