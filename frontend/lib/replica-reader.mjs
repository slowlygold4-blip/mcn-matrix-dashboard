import {savedPublicationDateValid} from './publication-date-basis.mjs';
/** Every readable part is bound to the immutable publication manifest, never just a server header. */
import {withReplicaReadDeadline} from './replica-read-deadline.mjs';
const count=value=>Number.isSafeInteger(value)&&value>=0;
const instant=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)
 && Number.isFinite(Date.parse(value+'T00:00:00.000Z'))&&new Date(value+'T00:00:00.000Z').toISOString().slice(0,10)===value;

/** New source-enriched generations cannot split one external work into two rows. */
export function validateUnifiedWorksPart(items,generation){
 const seen=new Set(),enriched=items.some(item=>Object.hasOwn(item,'source'));
 for(const item of items){
  if(!savedPublicationDateValid(item,generation,{allowLegacy:true}))throw Error('作品日期依据或精度无效');
  if(!enriched)continue; // Older immutable generations retain their original contract.
  if(item.source!=null&&!['creator-source','platform-and-creator-source'].includes(item.source))throw Error('作品来源类型无效');
  const synthetic=typeof item.id==='string'&&item.id.startsWith('creator-source:');
  if(synthetic&&item.source!=='creator-source'||!synthetic&&item.source==='creator-source')throw Error('作品来源与记录身份冲突');
  if(item.source!=null&&!/^\d{15,25}$/.test(item.externalId??''))throw Error('来源表作品ID无效');
  if(item.source==null&&['sourceCumulativeLikes','sourceCumulativePlays'].some(field=>item[field]!=null))throw Error('来源表累计指标缺少严格关联');
  for(const field of ['sourceCumulativeLikes','sourceCumulativePlays'])
   if(item[field]!=null&&!count(item[field]))throw Error('来源表累计指标无效');
  if(item.sourceRefreshedAt!=null&&(!instant(item.sourceRefreshedAt)||Date.parse(item.sourceRefreshedAt)>Date.parse(generation)))throw Error('来源表刷新时间超出固定版本');
  if(item.sourcePublishedOn!=null&&!day(item.sourcePublishedOn))throw Error('来源表作品日期无效');
  if(item.externalId!=null){
   if(typeof item.externalId!=='string'||!item.externalId.trim()||seen.has(item.externalId))throw Error('账号作品ID重复或无效');
   seen.add(item.externalId);
  }
 }
 return items;
}
export async function readReplicaPart({generation,part,meta,signal,fetcher=fetch}){
 const controller=new AbortController(),cancel=()=>controller.abort(signal?.reason);
 if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
 try{return await withReplicaReadDeadline({controller,operation:async()=>{
 const target=/^(daily|works|work-metrics)\/([1-9]\d*)\.json$/.exec(part);
 if(!meta||meta.path!==part||!Number.isSafeInteger(meta.bytes)||meta.bytes<1||!/^[a-f0-9]{64}$/.test(meta.sha256)||(target&&meta.targetId!==Number(target[2])))throw Error('历史分区不在有效发布清单');
 if(target&&(meta.kind!==({daily:'daily',works:'works','work-metrics':'workMetrics'})[target[1]]||!Number.isSafeInteger(meta.count)||meta.count<0))throw Error('历史分区类型或条数无效');
 const response=await fetcher('/api/replica?'+new URLSearchParams({generation,part}),{signal:controller.signal});
 if(!response.ok)throw Error('数据读取暂时失败，请重试');
 const text=await response.text(),bytes=new TextEncoder().encode(text);
 const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
 if(bytes.length!==meta.bytes||sha!==meta.sha256||response.headers.get('X-Data-SHA256')!==meta.sha256)throw Error('保存数据校验不一致，已停止显示');
 const value=JSON.parse(text);
 if(value.version!==1||value.asOf!==generation||value.timeZone!=='Asia/Shanghai'||response.headers.get('X-Data-Cutoff')!==generation)throw Error('数据版本不一致，已停止替换');
 if(target&&(!Array.isArray(value.items)||value.items.length!==meta.count||value.items.some(item=>item.targetId!==Number(target[2]))))throw Error('账号历史归属或条数不一致，已停止显示');
 if(target){const ids=new Set(),dates=new Set();for(const item of value.items){const idValid=Number.isSafeInteger(item.id)&&item.id>0||target[1]==='works'&&typeof item.id==='string'&&/^creator-source:[1-9]\d*:[1-9]\d*$/.test(item.id);const idKey=String(item.id);if(!idValid||ids.has(idKey))throw Error('账号历史记录重复或无效');ids.add(idKey);if(target[1]==='daily'){if(typeof item.date!=='string'||dates.has(item.date))throw Error('账号历史观察日重复或无效');dates.add(item.date);}}}
 if(target?.[1]==='works')validateUnifiedWorksPart(value.items,generation);
 return value;
 }});}finally{signal?.removeEventListener('abort',cancel);}
}
