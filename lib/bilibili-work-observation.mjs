// A collector-owned response clock, not a publication date or import time.
// Legacy payloads retain their existing clock; a declared receipt cannot fall
// back after a malformed time or an identity/normalized-value mismatch.
import {normalizeCollection} from './providers/normalize.mjs';
import {checksum} from './utils.mjs';
import {targetPlatform} from './target-platform.mjs';

const fail=()=>{throw Object.assign(new Error('B站逐作品观察时间或身份与采集证据不一致；本次未写入'),{code:'BILIBILI_WORK_OBSERVATION_INVALID'});};
const stamp=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  &&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function bilibiliWorkObservation(target,collection,{reference=Date.now()}={}){
 const raw=collection.raw,receipt=raw?.workObservationTimes;
 if(receipt===undefined)return null;
 const metadata=target.metadata??(()=>{try{return JSON.parse(target.metadata_json??'{}');}catch{return {};}})();
 const platform=targetPlatform({...target,metadata});
 let expectedMid=/^\d{2,20}$/.test(String(target.locator))?String(target.locator):null;
 if(!expectedMid)try{const url=new URL(target.locator);if(url.protocol==='https:'&&url.hostname==='space.bilibili.com'
   &&!url.port&&!url.username&&!url.password)expectedMid=/^\/(\d{2,20})\/?$/.exec(url.pathname)?.[1]??null;}catch{}
 const mid=raw?.profile?.user?.uid;
 if(target.type!=='account'||target.provider!=='public-web'||platform!=='bilibili'
   ||typeof mid!=='string'||!/^\d{2,20}$/.test(mid)||expectedMid!==mid
   ||receipt?.version!==1||receipt.transport!=='bilibili-official-http'
   ||raw.codexObservation?.source==='manual-import'
   ||raw.provenance?.mode!=='bilibili-public-card-relation-wbi-view'
   ||!stamp(receipt.startedAt)||!stamp(receipt.completedAt)||!stamp(raw.capturedAt)
   ||receipt.completedAt!==raw.capturedAt||collection.capturedAt!==raw.capturedAt
   ||!Number.isFinite(reference)||Date.parse(receipt.startedAt)>Date.parse(receipt.completedAt)
   ||Date.parse(receipt.completedAt)>reference
   ||collection.sourceChecksum!==checksum(raw)
   ||!Array.isArray(raw.works?.aweme_list)||!Array.isArray(receipt.observations)
   ||!raw.works.aweme_list.every(object)||!receipt.observations.every(object)
   ||receipt.observations.length!==raw.works.aweme_list.length
   ||receipt.observations.length>30
   ||checksum(collection.posts)!==checksum(normalizeCollection(target,raw,{capturedAt:raw.capturedAt}).posts))fail();
 const posts=new Map(raw.works.aweme_list.map(item=>[item.aweme_id,item]));
 if(posts.size!==receipt.observations.length||collection.posts.length!==posts.size)fail();
 const postTimes=new Map();let observedAt=null;
 for(const row of receipt.observations){
   const item=posts.get(row.contentId);
   if(typeof row.contentId!=='string'||!/^BV[0-9A-Za-z]{10}$/.test(row.contentId)
     ||postTimes.has(row.contentId)||!item||item.author?.uid!==mid
     ||!['view','list'].includes(row.source)||!stamp(row.observedAt)
     ||row.observedAt<receipt.startedAt||row.observedAt>receipt.completedAt
     ||(row.source==='list'&&item.statistics?.digg_count!=null))fail();
   postTimes.set(row.contentId,row.observedAt);
   if(observedAt===null||row.observedAt>observedAt)observedAt=row.observedAt;
 }
 return {postTimes,observedAt};
}
