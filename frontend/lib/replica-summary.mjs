const SHA=/^[a-f0-9]{64}$/;
import {validDate} from './replica-model.mjs';
const FIELDS=['targetId','date','capturedAt','followers','followersAt','likes','likesAt','posts','postsAt'];
const keys=(x,names)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===names.length&&Object.keys(x).every(k=>names.includes(k));
const nat=x=>Number.isSafeInteger(x)&&x>=0;
const invalid=()=>{throw new Error('历史索引不一致，保留上次数据');};
const time=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const bj=x=>new Date(Date.parse(x)+28800000).toISOString().slice(0,10);
export function summaryPointValid(p,asOf){return keys(p,FIELDS)&&Number.isSafeInteger(p.targetId)&&p.targetId>0&&p.targetId<=99_999_999&&validDate(p.date)&&time(p.capturedAt)&&time(asOf)&&p.capturedAt<=asOf&&bj(p.capturedAt)===p.date&&['followers','likes','posts'].every(k=>(p[k]===null||nat(p[k]))&&(p[k+'At']===null||(time(p[k+'At'])&&p[k+'At']<=p.capturedAt))&&(p[k]===null||(time(p[k+'At'])&&bj(p[k+'At'])===p.date)));}
export function summaryPartValid(p,asOf,maxItems=2000){return keys(p,['version','asOf','timeZone','items'])&&p.version===1&&p.asOf===asOf&&p.timeZone==='Asia/Shanghai'&&Array.isArray(p.items)&&p.items.length<=maxItems&&p.items.every(x=>summaryPointValid(x,asOf));}
/** Old immutable generations remain readable. New indexes must match the sealed manifest exactly. */
export function summaryDescriptors(index,manifest){
 if(index?.version!==1||index.asOf!==manifest.asOf||index.timeZone!=='Asia/Shanghai')invalid();
 const declared=manifest.files.filter(f=>f.kind==='summaryShard');
 if(manifest.files.filter(f=>typeof f.path==='string'&&f.path.startsWith('summary/')).length!==declared.length)invalid();
 const root=manifest.files.find(f=>f.path==='summary.json');if(!root||!keys(root,['path','kind','count','bytes','sha256'])||root.kind!=='summary'||root.count!==manifest.counts.daily)invalid();
 if(Array.isArray(index.items)){
  if(!summaryPartValid(index,manifest.asOf,200_000)||declared.length||index.items.length!==manifest.counts.daily)invalid();
  return null;
 }
 if(!keys(index,['version','asOf','timeZone','format','count','shards'])||index.format!=='daily-shards-v1'||index.count!==manifest.counts.daily||!nat(index.count)||!Array.isArray(index.shards)||index.shards.length>4096||declared.length!==index.shards.length)invalid();
 const byPath=new Map(declared.map(f=>[f.path,f]));let count=0;
 index.shards.forEach((s,i)=>{const f=byPath.get(s?.path);if(!keys(s,['path','count','bytes','sha256'])||s.path!==`summary/${String(i+1).padStart(6,'0')}.json`||!nat(s.count)||s.count<1||s.count>2000||!nat(s.bytes)||s.bytes<1||!SHA.test(s.sha256)||!f||!keys(f,['path','kind','count','bytes','sha256'])||f.kind!=='summaryShard'||f.count!==s.count||f.bytes!==s.bytes||f.sha256!==s.sha256)invalid();count+=s.count;});
 if(count!==index.count)invalid();return index.shards;
}
export async function loadSummary(manifest,readPart){
 if(manifest?.counts?.daily>200_000||manifest.files.filter(f=>f.kind==='summary'||f.kind==='summaryShard').reduce((n,f)=>n+f.bytes,0)>64_000_000)throw Error('历史超过单屏读取预算，请使用本机历史导出；公开端日期按需读取待接续');
 const index=await readPart('summary.json'),shards=summaryDescriptors(index,manifest);
 if(shards===null)return index.items;
 const parts=new Array(shards.length);let next=0;
 let stopped=false;await Promise.all(Array.from({length:Math.min(4,shards.length)},async()=>{try{while(!stopped&&next<shards.length){const i=next++,s=shards[i],p=await readPart(s.path);if(!summaryPartValid(p,manifest.asOf)||p.items.length!==s.count)invalid();parts[i]=p.items;}}catch(e){stopped=true;throw e;}}));
 return parts.flat();
}
