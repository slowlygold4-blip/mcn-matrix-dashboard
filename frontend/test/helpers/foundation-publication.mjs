import {createHash} from 'node:crypto';
import {FOUNDATION_GROUPS,foundationKind,foundationRevisionPayload} from '../../lib/replica-foundation.mjs';
const hash=text=>createHash('sha256').update(text).digest('hex');
export function foundationPublication(asOf,{authors=1,corrupt=false}={}){
 const values={authors:Array.from({length:authors},(_,i)=>({douyinId:`extra_${i+1}`,name:`补充作者${i+1}`,posts:null,slicePosts:null,creationPosts:null,aiPosts:null,cupPosts:null,plays:null,likes:null,followers:null,targetIds:[],evidenceRows:1,sourceTitles:['合成资料']})),
  works:[],sources:[{title:'合成资料',revision:1,importedAt:'2026-10-28T00:00:00.000Z',rows:authors,tuantuanRows:authors,otherRows:0,unkeyedRows:0}],observations:[],otherAuthors:[],otherWorks:[],pendingAuthors:[]};
 const stats=Object.fromEntries(['sourceDocuments','sourceRows','tuantuanRows','acceptedRows','unkeyedRows','ambiguousRows','invalidIdentityRows','baseAuthorEvidence','baseWorkEvidence','additionalAuthors','additionalWorks','otherAuthors','otherWorks','sourceMetricObservations','sourceMetricWorkIds','baseAuthorRows','reciprocalDuplicates','baseAuthors','baseWorks','sheets','pendingAuthors'].map(k=>[k,0]));
 Object.assign(stats,{sourceDocuments:1,sourceRows:authors,tuantuanRows:authors,acceptedRows:authors,additionalAuthors:authors});
 const common={version:1,asOf,timeZone:'Asia/Shanghai'},root={generatedAt:asOf,linkMode:'current-strict',linkFingerprint:'a'.repeat(64),stats,sheetCoverage:[]};
 const revision=hash(foundationRevisionPayload(root,values)),files=[],descriptors=[];
 const fields={authors:'authors',works:'works',sources:'sources',observations:'observations','other-authors':'otherAuthors','other-works':'otherWorks','pending-authors':'pendingAuthors'};
 const add=(path,kind,count,payload)=>{const data=JSON.stringify({...common,...payload})+'\n';const file={path,kind,count,bytes:Buffer.byteLength(data),sha256:hash(data),data};files.push(file);return file;};
 add('catalog.json','catalog',0,{accounts:[],boards:[],classificationRuleVersion:'fixture'});add('topics.json','topics',0,{topics:[],items:[]});add('summary.json','summary',0,{items:[]});
 for(const name of FOUNDATION_GROUPS){const items=values[fields[name]],file=add('foundation/'+name+'.json',foundationKind('foundation/'+name+'.json'),items.length,{revision,items});descriptors.push({path:name+'.json',count:file.count,bytes:file.bytes,sha256:file.sha256,generation:asOf});}
 if(corrupt)root.stats.sourceRows++;
 const index={...root,revision,files:descriptors,semantics:{authors:'身份去重',pendingAuthors:'不补零',works:'作品ID去重',metrics:'保留测量时间',privacy:'不公开凭据'}};
 add('foundation/index.json','foundationIndex',descriptors.reduce((sum,f)=>sum+f.count,0),index);
 return {asOf,index,files,manifest:{...common,counts:{daily:0},files:files.map(({data,...meta})=>meta)}};
}
