import test from 'node:test';
import assert from 'node:assert/strict';
import {historyExport} from '../lib/replica-export.mjs';

const asOf='2026-10-23T08:00:00.000Z';
const observed='2026-10-23T07:50:00.000Z';
const refreshed='2026-10-12T09:00:00.000Z';
const account={id:7,platform:'douyin',label:'作者甲'};
const id='7695811343009594289';
const platform={targetId:7,id:90,externalId:id,caption:'作品甲',
 url:`https://www.douyin.com/video/${id}`,publishedAt:'2026-10-11T18:30:00.000Z',
 publishedOn:null,publicationDateBasis:'platform-timestamp',firstSeenAt:'2026-10-12T01:00:00.000Z',
 lastObservedAt:observed,likes:42,comments:null,shares:null,collects:null,plays:4200,
 playsEvidence:{mayBePlaceholder:false,note:'来源字段未经独立核验实际播放'}};
const source={...platform,id:'creator-source:2:9',source:'creator-source',
 externalId:'7695811343009594290',publishedAt:null,publishedOn:'2026-10-12',
 publicationDateBasis:'creator-source-date-only',lastObservedAt:null,likes:0,plays:3000,
 sourceCumulativeLikes:0,sourceCumulativePlays:3000,sourceRefreshedAt:refreshed};
const merged={...platform,source:'platform-and-creator-source',sourceCumulativeLikes:30,
 sourceCumulativePlays:3000,sourceRefreshedAt:refreshed,
 provenance:{url:'https://private.example/secret?token=[REDACTED]',references:['internal-row']}};
function exportRows(rows){
 const manifest={asOf,timeZone:'Asia/Shanghai',files:[{path:'works/7.json',kind:'works',targetId:7,
  sha256:'a'.repeat(64),count:rows.length}]};
 const csv=historyExport({rows,kind:'works',account,manifest});
 return {csv,values:csv.slice(1).map(row=>Object.fromEntries(csv[0].map((field,index)=>[field,row[index]])))};
}

test('work CSV exports one merged row with platform adopted value and independent table evidence',()=>{
 const {csv,values:[row]}=exportRows([merged]);
 assert.equal(csv.length,2);
 assert.deepEqual([row.likes,row.likesOrigin,row.likesPlatformValue,row.sourceCumulativeLikes],
  [42,'platform',42,30]);
 assert.deepEqual([row.plays,row.playsOrigin,row.playsPlatformValue,row.sourceCumulativePlays],
  [4200,'platform',4200,3000]);
 assert.equal(row.likesPlatformObservedAt,observed);
 assert.equal(row.sourceRefreshedAt,refreshed);
 assert.match(row.sourceRefreshTimeBasis,/不是这项指标的采样时间/);
 assert.match(row.provenanceNote,/二者不相加/);
 assert.doesNotMatch(JSON.stringify(csv),/private\.example|never-export|internal-row/);
});

test('source-only, platform-only and null/placeholder fallback retain truthful origin',()=>{
 const platformOnly={...platform,id:91,externalId:'7695811343009594291',source:null,likes:null,plays:null};
 const fallback={...merged,id:92,externalId:'7695811343009594292',likes:null,plays:0,
  playsEvidence:{mayBePlaceholder:true,note:'占位'}};
 const {values}=exportRows([source,platformOnly,fallback]);
 assert.deepEqual([values[0].likes,values[0].likesOrigin,values[0].sourceCumulativeLikes],[0,'source',0]);
 assert.deepEqual([values[0].plays,values[0].playsOrigin],[3000,'source']);
 assert.deepEqual([values[1].likes,values[1].plays],[null,null]);
 assert.deepEqual([values[1].likesOrigin,values[1].playsOrigin],['unavailable','unavailable']);
 assert.deepEqual([values[2].likes,values[2].likesOrigin,values[2].plays,values[2].playsOrigin],
  [30,'source',3000,'source']);
 assert.equal(values[2].playsPlatformValue,0);
 assert.match(values[2].playsBasis,/可能是占位/);
});

test('work CSV refuses a new-generation duplicate content ID instead of exporting two rows',()=>{
 assert.throws(()=>exportRows([merged,{...platform,id:91,source:null}]),/重复/);
});
